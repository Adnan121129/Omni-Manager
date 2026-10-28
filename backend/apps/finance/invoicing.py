"""
Invoice calculations and lifecycle. All arithmetic uses Decimal with half-up rounding to cents.

Totals:  subtotal = sum(line.amount), line.amount = round(quantity x unit_price)
         discount = round(subtotal x pct) or min(fixed, subtotal)
         tax      = round((subtotal - discount) x tax_rate)
         total    = subtotal - discount + tax
         due      = max(total - paid - credited, 0)
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.accounts.models import ADMIN_ROLES, Membership, Organization
from apps.core.activity import log_activity
from apps.core.exceptions import BusinessRuleError, ConflictError
from apps.core.money import ZERO, hours_from_seconds, q2
from apps.core.notify import notify
from apps.projects.models import Milestone, Project
from apps.timetracking.models import TimeEntry

from .models import CreditNote, Expense, Invoice, InvoiceLine, Payment


@dataclass
class Totals:
    subtotal: Decimal
    discount: Decimal
    tax: Decimal
    total: Decimal


def compute_totals(line_amounts, discount_type: str, discount_value: Decimal, tax_rate: Decimal) -> Totals:
    subtotal = q2(sum((q2(a) for a in line_amounts), ZERO))
    if discount_type == Invoice.DiscountType.PERCENT:
        pct = min(max(Decimal(discount_value), ZERO), Decimal(100))
        discount = q2(subtotal * pct / 100)
    elif discount_type == Invoice.DiscountType.AMOUNT:
        discount = q2(min(max(Decimal(discount_value), ZERO), subtotal))
    else:
        discount = ZERO
    taxable = subtotal - discount
    tax = q2(taxable * Decimal(tax_rate) / 100)
    return Totals(subtotal=subtotal, discount=discount, tax=tax, total=q2(taxable + tax))


def line_amount(quantity, unit_price) -> Decimal:
    return q2(Decimal(quantity) * Decimal(unit_price))


def recalculate(invoice: Invoice, save: bool = True) -> Invoice:
    """Recomputes totals, balances and the derived payment status from persisted lines/payments."""
    amounts = list(invoice.lines.values_list("amount", flat=True))
    totals = compute_totals(amounts, invoice.discount_type, invoice.discount_value, invoice.tax_rate)
    invoice.subtotal, invoice.discount_amount, invoice.tax_amount, invoice.total = (
        totals.subtotal, totals.discount, totals.tax, totals.total)
    invoice.amount_paid = q2(sum(invoice.payments.filter(status=Payment.Status.SUCCEEDED)
                                 .values_list("amount", flat=True), ZERO))
    invoice.amount_credited = q2(sum(invoice.credit_notes.values_list("amount", flat=True), ZERO))
    invoice.amount_due = max(ZERO, q2(invoice.total - invoice.amount_paid - invoice.amount_credited))
    if invoice.status not in (Invoice.Status.DRAFT, Invoice.Status.VOID):
        if invoice.amount_due == 0 and invoice.total > 0:
            invoice.status = Invoice.Status.PAID if invoice.amount_paid > 0 else Invoice.Status.CREDITED
            invoice.paid_at = invoice.paid_at or timezone.now()
        elif invoice.amount_paid > 0 or invoice.amount_credited > 0:
            invoice.status = Invoice.Status.PARTIALLY_PAID
            invoice.paid_at = None
        else:
            invoice.status = Invoice.Status.SENT
            invoice.paid_at = None
    if save:
        invoice.save()
    return invoice


def allocate_number(organization: Organization) -> str:
    org = Organization.objects.select_for_update(of=("self",)).get(pk=organization.pk)
    while True:
        number = f"{org.invoice_prefix}{org.next_invoice_number:04d}"
        org.next_invoice_number += 1
        if not Invoice.objects.filter(organization=org, number=number).exists():
            break
    org.save(update_fields=["next_invoice_number"])
    return number


def allocate_credit_note_number(organization: Organization) -> str:
    org = Organization.objects.select_for_update(of=("self",)).get(pk=organization.pk)
    number = f"CN-{org.next_credit_note_number:04d}"
    org.next_credit_note_number += 1
    org.save(update_fields=["next_credit_note_number"])
    return number


def billing_users(organization):
    return [m.user for m in Membership.objects.filter(organization=organization, role__in=ADMIN_ROLES,
                                                      status=Membership.Status.ACTIVE).select_related("user")
            if m.has_billing_access]


def _new_invoice(*, organization, client, currency, actor, issue_date=None, due_date=None, notes="",
                 idempotency_key=None, payment_terms=None, recurring_schedule=None) -> Invoice:
    issue_date = issue_date or timezone.localdate()
    terms_days = client.payment_terms_days if client.payment_terms_days is not None else organization.default_payment_terms_days
    return Invoice.objects.create(
        organization=organization, client=client, number=allocate_number(organization), currency=currency,
        issue_date=issue_date, due_date=due_date or issue_date + timedelta(days=terms_days),
        payment_terms=payment_terms if payment_terms is not None else (f"Net {terms_days}" if terms_days else "Due on receipt"),
        notes=notes, tax_rate=organization.default_tax_rate, tax_label=organization.tax_label,
        created_by=actor, idempotency_key=idempotency_key, recurring_schedule=recurring_schedule,
    )


@transaction.atomic
def create_manual_invoice(*, organization, client, currency, actor, lines: list[dict], **fields) -> Invoice:
    invoice = _new_invoice(organization=organization, client=client, currency=currency, actor=actor,
                           issue_date=fields.get("issue_date"), due_date=fields.get("due_date"),
                           notes=fields.get("notes", ""), idempotency_key=fields.get("idempotency_key"))
    for attr in ("discount_type", "discount_value", "tax_rate", "payment_terms"):
        if fields.get(attr) is not None:
            setattr(invoice, attr, fields[attr])
    for position, line in enumerate(lines):
        project = line.get("project")
        if project is not None and project.client_id != client.pk:
            raise BusinessRuleError("Line items can only reference projects for this client.")
        InvoiceLine.objects.create(invoice=invoice, kind=InvoiceLine.Kind.SERVICE, project=project,
                                   description=line["description"], quantity=line["quantity"],
                                   unit=line.get("unit", ""), unit_price=line["unit_price"],
                                   amount=line_amount(line["quantity"], line["unit_price"]), position=position)
    recalculate(invoice)
    log_activity(organization=organization, actor=actor, verb="created_invoice", target=invoice, client=client,
                 total=invoice.total, currency=currency)
    return invoice


def eligible_work(*, organization, client, projects, date_from: date | None = None, date_to: date | None = None):
    """Approved, billable, not-yet-invoiced time and expenses plus completed, uninvoiced milestones."""
    entries = TimeEntry.objects.filter(organization=organization, project__in=projects, project__client=client,
                                       status=TimeEntry.Status.APPROVED, billable=True, invoice_line__isnull=True,
                                       timer_state=TimeEntry.TimerState.STOPPED)
    expenses = Expense.objects.filter(organization=organization, project__in=projects, project__client=client,
                                      status=Expense.Status.APPROVED, billable=True, invoice_line__isnull=True)
    if date_from:
        entries = entries.filter(date__gte=date_from)
        expenses = expenses.filter(date__gte=date_from)
    if date_to:
        entries = entries.filter(date__lte=date_to)
        expenses = expenses.filter(date__lte=date_to)
    milestones = Milestone.objects.filter(organization=organization, project__in=projects, project__client=client,
                                          status=Milestone.Status.COMPLETED, invoice_line__isnull=True, amount__gt=0)
    return entries, expenses, milestones


def _period_label(dates) -> str:
    if not dates:
        return ""
    lo, hi = min(dates), max(dates)
    if lo == hi:
        return lo.strftime("%b %d, %Y")
    return f"{lo.strftime('%b %d')} – {hi.strftime('%b %d, %Y')}"


@transaction.atomic
def generate_from_work(*, organization, client, project_ids: list[int], actor, include_time: bool = True,
                       include_expenses: bool = True, milestone_ids: list[int] | None = None,
                       date_from: date | None = None, date_to: date | None = None, grouping: str = "task",
                       idempotency_key: str | None = None, due_date: date | None = None, notes: str = "") -> Invoice:
    """
    Builds a draft invoice from approved billable work. Idempotent per `idempotency_key`, and every
    source record is locked and linked to exactly one invoice line, so work can never be billed twice.
    """
    if idempotency_key:
        existing = Invoice.objects.filter(organization=organization, idempotency_key=idempotency_key).first()
        if existing is not None:
            return existing
    projects = list(Project.objects.filter(organization=organization, client=client, pk__in=project_ids))
    if not projects or len(projects) != len(set(project_ids)):
        raise BusinessRuleError("Select one or more projects that belong to this client.", code="invalid_projects")
    currencies = {p.currency for p in projects}
    if len(currencies) > 1:
        raise BusinessRuleError("The selected projects use different currencies. Create one invoice per currency.",
                                code="mixed_currency")
    currency = currencies.pop()
    entries_qs, expenses_qs, milestones_qs = eligible_work(organization=organization, client=client, projects=projects,
                                                           date_from=date_from, date_to=date_to)
    entries = list(entries_qs.select_for_update(of=("self",)).select_related("project", "task", "user")
                   .order_by("project_id", "date", "id")) if include_time else []
    expenses = list(expenses_qs.select_for_update(of=("self",)).select_related("project", "category")
                    .order_by("date", "id")) if include_expenses else []
    milestones = list(milestones_qs.filter(pk__in=milestone_ids or []).select_for_update(of=("self",))
                      .select_related("project"))
    wrong_currency = [e for e in expenses if e.currency != currency]
    if wrong_currency:
        raise BusinessRuleError(f"{len(wrong_currency)} expense(s) are not in {currency} and cannot be added.",
                                code="mixed_currency")
    if not (entries or expenses or milestones):
        raise BusinessRuleError("There is no approved, uninvoiced billable work for this selection.", code="nothing_to_invoice")

    try:
        with transaction.atomic():
            invoice = _new_invoice(organization=organization, client=client, currency=currency, actor=actor,
                                   due_date=due_date, notes=notes, idempotency_key=idempotency_key)
    except IntegrityError:
        # A concurrent request with the same idempotency key won the race.
        return Invoice.objects.get(organization=organization, idempotency_key=idempotency_key)

    position = 0
    groups: dict[tuple, list[TimeEntry]] = defaultdict(list)
    for e in entries:
        if grouping == "entry":
            key = (e.pk,)
        elif grouping == "person":
            key = (e.project_id, e.user_id, e.bill_rate)
        elif grouping == "project":
            key = (e.project_id, e.bill_rate)
        else:
            key = (e.project_id, e.task_id, e.bill_rate)
        groups[key].append(e)
    for key, group in groups.items():
        first = group[0]
        seconds = sum(e.duration_seconds for e in group)
        quantity = hours_from_seconds(seconds)
        if grouping == "entry":
            label = f"{first.date.strftime('%b %d')} · {first.task.title if first.task else first.project.name}"
            if first.description:
                label += f" — {first.description}"
        elif grouping == "person":
            label = f"{first.project.code} · {first.user.full_name}"
        elif grouping == "project":
            label = f"{first.project.code} · {first.project.name}"
        else:
            label = f"{first.project.code} · {first.task.title if first.task else 'General work'}"
        if grouping != "entry":
            label += f" ({_period_label([e.date for e in group])})"
        line = InvoiceLine.objects.create(invoice=invoice, kind=InvoiceLine.Kind.TIME, project=first.project,
                                          description=label[:500], quantity=quantity, unit="hrs",
                                          unit_price=first.bill_rate, amount=line_amount(quantity, first.bill_rate),
                                          position=position)
        position += 1
        linked = TimeEntry.objects.filter(pk__in=[e.pk for e in group], invoice_line__isnull=True).update(invoice_line=line)
        if linked != len(group):
            raise ConflictError("Some time entries were invoiced by another request. Please retry.", code="already_invoiced")

    for expense in expenses:
        label = f"Expense · {expense.description}"
        if expense.category_id:
            label += f" ({expense.category.name})"
        line = InvoiceLine.objects.create(invoice=invoice, kind=InvoiceLine.Kind.EXPENSE, project=expense.project,
                                          description=label[:500], quantity=Decimal("1"), unit="",
                                          unit_price=expense.billable_amount, amount=q2(expense.billable_amount),
                                          position=position)
        position += 1
        if Expense.objects.filter(pk=expense.pk, invoice_line__isnull=True).update(invoice_line=line) != 1:
            raise ConflictError("An expense was invoiced by another request. Please retry.", code="already_invoiced")

    for milestone in milestones:
        line = InvoiceLine.objects.create(invoice=invoice, kind=InvoiceLine.Kind.MILESTONE, project=milestone.project,
                                          description=f"{milestone.project.code} · Milestone: {milestone.name}"[:500],
                                          quantity=Decimal("1"), unit="", unit_price=milestone.amount,
                                          amount=q2(milestone.amount), position=position)
        position += 1
        if Milestone.objects.filter(pk=milestone.pk, invoice_line__isnull=True).update(invoice_line=line) != 1:
            raise ConflictError("A milestone was invoiced by another request. Please retry.", code="already_invoiced")

    recalculate(invoice)
    log_activity(organization=organization, actor=actor, verb="generated_invoice", target=invoice, client=client,
                 time_entries=len(entries), expenses=len(expenses), milestones=len(milestones), total=invoice.total)
    return invoice


def assert_draft(invoice: Invoice) -> None:
    if invoice.status != Invoice.Status.DRAFT:
        raise BusinessRuleError("Only draft invoices can be edited. Void it or issue a credit note instead.",
                                code="invoice_locked")


def release_sources(invoice: Invoice) -> dict:
    lines = invoice.lines.all()
    released = {
        "time_entries": TimeEntry.objects.filter(invoice_line__in=lines).update(invoice_line=None),
        "expenses": Expense.objects.filter(invoice_line__in=lines).update(invoice_line=None),
        "milestones": Milestone.objects.filter(invoice_line__in=lines).update(invoice_line=None),
    }
    return released


@transaction.atomic
def delete_draft(invoice: Invoice, actor) -> None:
    invoice = Invoice.objects.select_for_update(of=("self",)).get(pk=invoice.pk)
    assert_draft(invoice)
    released = release_sources(invoice)
    log_activity(organization=invoice.organization, actor=actor, verb="deleted_invoice", target=invoice,
                 client=invoice.client, **released)
    invoice.delete()


@transaction.atomic
def delete_line(line: InvoiceLine, actor) -> Invoice:
    invoice = Invoice.objects.select_for_update(of=("self",)).get(pk=line.invoice_id)
    assert_draft(invoice)
    TimeEntry.objects.filter(invoice_line=line).update(invoice_line=None)
    Expense.objects.filter(invoice_line=line).update(invoice_line=None)
    Milestone.objects.filter(invoice_line=line).update(invoice_line=None)
    line.delete()
    return recalculate(invoice)


@transaction.atomic
def send_invoice(invoice: Invoice, actor, *, send_email: bool = True, message: str = "", recipients=None) -> Invoice:
    from apps.core.email import send_templated_email
    from apps.crm.services import portal_users

    from .pdf import render_invoice_pdf

    invoice = Invoice.objects.select_for_update(of=("self",)).select_related("client", "organization").get(pk=invoice.pk)
    if invoice.status != Invoice.Status.DRAFT:
        if invoice.status in Invoice.OPEN_STATUSES and send_email:
            pass  # re-sending an open invoice just emails it again
        else:
            raise BusinessRuleError("Only draft or open invoices can be sent.")
    else:
        recalculate(invoice, save=False)
        if not invoice.lines.exists() or invoice.total <= 0:
            raise BusinessRuleError("Add at least one line with a positive total before sending.", code="empty_invoice")
        invoice.status = Invoice.Status.SENT
        invoice.sent_at = timezone.now()
        recalculate(invoice)
    client = invoice.client
    to = recipients or [client.billing_email or client.email]
    to = [r for r in to if r]
    if send_email and to:
        pdf = render_invoice_pdf(invoice)
        send_templated_email(to=to, subject=f"Invoice {invoice.number} from {invoice.organization.name}",
                             template="invoice", context={"invoice": invoice, "client": client,
                                                          "organization": invoice.organization, "message": message},
                             attachments=[(f"{invoice.number}.pdf", pdf, "application/pdf")])
    notify(organization=invoice.organization, recipients=portal_users(client), kind="invoice_sent",
           title=f"New invoice {invoice.number}: {invoice.currency} {invoice.total}",
           body=f"Due {invoice.due_date.isoformat()}", link=f"/portal/invoices/{invoice.pk}",
           dedupe_key=f"invoice_sent:{invoice.pk}")
    log_activity(organization=invoice.organization, actor=actor, verb="sent_invoice", target=invoice, client=client,
                 client_visible=True, emailed_to=to if send_email else [])
    return invoice


@transaction.atomic
def void_invoice(invoice: Invoice, actor, reason: str) -> Invoice:
    reason = (reason or "").strip()
    if not reason:
        raise BusinessRuleError("A reason is required to void an invoice.", code="reason_required")
    invoice = Invoice.objects.select_for_update(of=("self",)).get(pk=invoice.pk)
    if invoice.status not in Invoice.OPEN_STATUSES:
        raise BusinessRuleError("Only sent invoices without payments can be voided. Delete drafts instead.")
    if invoice.payments.filter(status=Payment.Status.SUCCEEDED).exists():
        raise BusinessRuleError("This invoice has payments. Reverse them or issue a credit note instead.",
                                code="has_payments")
    if invoice.credit_notes.exists():
        raise BusinessRuleError("This invoice has credit notes and cannot be voided.", code="has_credits")
    released = release_sources(invoice)
    invoice.status = Invoice.Status.VOID
    invoice.voided_at = timezone.now()
    invoice.void_reason = reason
    invoice.amount_due = ZERO
    invoice.save()
    invoice.checkouts.filter(status="open").update(status="canceled")
    log_activity(organization=invoice.organization, actor=actor, verb="voided_invoice", target=invoice,
                 client=invoice.client, reason=reason, **released)
    return invoice


@transaction.atomic
def record_payment(invoice: Invoice, *, amount: Decimal, method: str, actor=None, received_at=None, note: str = "",
                   reference: str = "", provider: str = "", checkout=None, allow_overpayment: bool = False) -> Payment:
    invoice = Invoice.objects.select_for_update(of=("self",)).select_related("client", "organization").get(pk=invoice.pk)
    amount = q2(amount)
    if invoice.status not in Invoice.OPEN_STATUSES:
        raise BusinessRuleError(f"Payments can only be recorded on open invoices (this one is {invoice.status}).",
                                code="invoice_not_open")
    if amount <= 0:
        raise BusinessRuleError("Payment amount must be greater than zero.", code="invalid_amount")
    if amount > invoice.amount_due and not allow_overpayment:
        raise BusinessRuleError(f"Payment exceeds the balance due ({invoice.currency} {invoice.amount_due}).",
                                code="overpayment")
    payment = Payment.objects.create(organization=invoice.organization, invoice=invoice, amount=amount,
                                     currency=invoice.currency, method=method, provider=provider,
                                     provider_reference=reference, received_at=received_at or timezone.now(),
                                     recorded_by=actor, checkout=checkout, note=note[:255])
    recalculate(invoice)
    log_activity(organization=invoice.organization, actor=actor, verb="recorded_payment", target=invoice,
                 client=invoice.client, client_visible=True, amount=amount, method=method, provider=provider,
                 reference=reference, balance=invoice.amount_due)
    from apps.crm.services import portal_users
    title = f"Payment of {invoice.currency} {amount} received for {invoice.number}"
    notify(organization=invoice.organization, recipients=billing_users(invoice.organization) + [invoice.created_by],
           kind="payment_received", title=title,
           body=f"Balance due: {invoice.currency} {invoice.amount_due}", link=f"/invoices/{invoice.pk}",
           dedupe_key=f"payment:{payment.pk}", exclude=actor)
    notify(organization=invoice.organization, recipients=portal_users(invoice.client), kind="payment_received",
           title=title, link=f"/portal/invoices/{invoice.pk}", dedupe_key=f"payment:{payment.pk}")
    return payment


@transaction.atomic
def reverse_payment(payment: Payment, actor, reason: str) -> Payment:
    reason = (reason or "").strip()
    if not reason:
        raise BusinessRuleError("A reason is required to reverse a payment.", code="reason_required")
    payment = Payment.objects.select_for_update(of=("self",)).get(pk=payment.pk)
    if payment.status != Payment.Status.SUCCEEDED:
        raise BusinessRuleError("This payment has already been reversed.")
    invoice = Invoice.objects.select_for_update(of=("self",)).get(pk=payment.invoice_id)
    payment.status = Payment.Status.REVERSED
    payment.reversed_at = timezone.now()
    payment.reversed_by = actor
    payment.reversal_reason = reason
    payment.save()
    recalculate(invoice)
    log_activity(organization=invoice.organization, actor=actor, verb="reversed_payment", target=invoice,
                 client=invoice.client, amount=payment.amount, reason=reason, payment_id=payment.pk)
    return payment


@transaction.atomic
def issue_credit_note(invoice: Invoice, actor, *, amount: Decimal, reason: str) -> CreditNote:
    reason = (reason or "").strip()
    if not reason:
        raise BusinessRuleError("A reason is required for a credit note.", code="reason_required")
    invoice = Invoice.objects.select_for_update(of=("self",)).get(pk=invoice.pk)
    amount = q2(amount)
    if invoice.status not in Invoice.OPEN_STATUSES:
        raise BusinessRuleError("Credit notes can only be issued against open invoices.", code="invoice_not_open")
    if amount <= 0 or amount > invoice.amount_due:
        raise BusinessRuleError(f"Credit must be between 0.01 and the balance due ({invoice.amount_due}).",
                                code="invalid_amount")
    note = CreditNote.objects.create(organization=invoice.organization, invoice=invoice,
                                     number=allocate_credit_note_number(invoice.organization), amount=amount,
                                     reason=reason, created_by=actor)
    recalculate(invoice)
    log_activity(organization=invoice.organization, actor=actor, verb="issued_credit_note", target=invoice,
                 client=invoice.client, client_visible=True, amount=amount, credit_note=note.number, reason=reason)
    return note
