"""
Recurring invoice schedules. Each generated period is recorded in RecurringInvoiceRun with a
unique (schedule, period_start) constraint, so running the job twice never duplicates invoices.
Run `python manage.py run_jobs` daily (cron) or trigger a schedule manually from the UI.
"""

import calendar
import logging
from datetime import date, timedelta
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.core.activity import log_activity
from apps.core.exceptions import BusinessRuleError

from .invoicing import _new_invoice, compute_totals, line_amount, recalculate, send_invoice
from .models import Invoice, InvoiceLine, RecurringInvoiceRun, RecurringInvoiceSchedule

logger = logging.getLogger(__name__)
MAX_CATCH_UP = 12


def _add_months(d: date, months: int) -> date:
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def advance(d: date, frequency: str) -> date:
    if frequency == RecurringInvoiceSchedule.Frequency.WEEKLY:
        return d + timedelta(days=7)
    if frequency == RecurringInvoiceSchedule.Frequency.QUARTERLY:
        return _add_months(d, 3)
    if frequency == RecurringInvoiceSchedule.Frequency.YEARLY:
        return _add_months(d, 12)
    return _add_months(d, 1)


def period_label(start: date, frequency: str) -> str:
    end = advance(start, frequency) - timedelta(days=1)
    return f"{start.strftime('%b %d, %Y')} – {end.strftime('%b %d, %Y')}"


def preview(schedule: RecurringInvoiceSchedule, period_start: date | None = None, today: date | None = None) -> dict:
    period_start = period_start or schedule.next_run_date
    # A period generated late (catch-up) is issued on the day it is generated, and payment terms
    # run from that issue date - never from the past period start.
    issue_date = max(period_start, today or timezone.localdate())
    lines = []
    for item in schedule.line_items:
        quantity = Decimal(str(item.get("quantity", "1")))
        unit_price = Decimal(str(item.get("unit_price", "0")))
        lines.append({"description": f"{item.get('description', '')} ({period_label(period_start, schedule.frequency)})",
                      "quantity": str(quantity), "unit_price": str(unit_price),
                      "amount": str(line_amount(quantity, unit_price))})
    totals = compute_totals([Decimal(line["amount"]) for line in lines], schedule.discount_type,
                            schedule.discount_value, schedule.tax_rate)
    return {
        "period_start": period_start.isoformat(),
        "period_label": period_label(period_start, schedule.frequency),
        "issue_date": issue_date.isoformat(),
        "due_date": (issue_date + timedelta(days=schedule.payment_terms_days)).isoformat(),
        "currency": schedule.currency,
        "lines": lines,
        "subtotal": str(totals.subtotal), "discount": str(totals.discount), "tax": str(totals.tax),
        "total": str(totals.total),
        "will_auto_send": schedule.auto_send,
    }


def validate_line_items(items) -> list[dict]:
    if not isinstance(items, list) or not items:
        raise BusinessRuleError("Add at least one line item.", code="invalid_lines")
    clean = []
    for item in items:
        try:
            quantity = Decimal(str(item["quantity"]))
            unit_price = Decimal(str(item["unit_price"]))
            description = str(item["description"]).strip()
        except (KeyError, ArithmeticError, ValueError, TypeError):
            raise BusinessRuleError("Each line needs a description, quantity and unit price.", code="invalid_lines")
        if not description or quantity <= 0 or unit_price < 0:
            raise BusinessRuleError("Line quantities must be positive and prices zero or more.", code="invalid_lines")
        clean.append({"description": description[:400], "quantity": str(quantity), "unit_price": str(unit_price)})
    return clean


def generate_period(schedule: RecurringInvoiceSchedule, period_start: date, actor=None, today: date | None = None) -> Invoice | None:
    """Creates the invoice for one period. Returns None if that period was already generated."""
    with transaction.atomic():
        locked = RecurringInvoiceSchedule.objects.select_for_update(of=("self",)).get(pk=schedule.pk)
        try:
            with transaction.atomic():
                run = RecurringInvoiceRun.objects.create(schedule=locked, period_start=period_start)
        except IntegrityError:
            return None
        data = preview(locked, period_start, today=today)
        invoice = _new_invoice(organization=locked.organization, client=locked.client, currency=locked.currency,
                               actor=actor or locked.created_by, issue_date=date.fromisoformat(data["issue_date"]),
                               due_date=date.fromisoformat(data["due_date"]), notes=locked.notes,
                               payment_terms=f"Net {locked.payment_terms_days}", recurring_schedule=locked)
        invoice.tax_rate = locked.tax_rate
        invoice.discount_type = locked.discount_type
        invoice.discount_value = locked.discount_value
        invoice.save()
        for position, line in enumerate(data["lines"]):
            InvoiceLine.objects.create(invoice=invoice, kind=InvoiceLine.Kind.SERVICE, project=locked.project,
                                       description=line["description"][:500], quantity=Decimal(line["quantity"]),
                                       unit_price=Decimal(line["unit_price"]), amount=Decimal(line["amount"]),
                                       position=position)
        recalculate(invoice)
        run.invoice = invoice
        run.save(update_fields=["invoice"])
        if advance(period_start, locked.frequency) > locked.next_run_date:
            locked.next_run_date = advance(period_start, locked.frequency)
        locked.last_generated_at = timezone.now()
        if locked.end_date and locked.next_run_date > locked.end_date:
            locked.is_active = False
        locked.save(update_fields=["next_run_date", "last_generated_at", "is_active", "updated_at"])
        log_activity(organization=locked.organization, actor=actor, verb="generated_recurring_invoice", target=invoice,
                     client=locked.client, schedule=locked.name, period=data["period_label"])
    if locked.auto_send:
        try:
            send_invoice(invoice, actor)
        except BusinessRuleError:
            logger.exception("Auto-send failed for recurring invoice %s", invoice.pk)
    return invoice


def run_schedule(schedule: RecurringInvoiceSchedule, *, today: date | None = None, actor=None) -> list[Invoice]:
    """Generates every period that is due (catching up at most MAX_CATCH_UP periods)."""
    today = today or timezone.localdate()
    created = []
    for _ in range(MAX_CATCH_UP):
        schedule.refresh_from_db()
        if not schedule.is_active or schedule.next_run_date > today:
            break
        if schedule.end_date and schedule.next_run_date > schedule.end_date:
            break
        invoice = generate_period(schedule, schedule.next_run_date, actor, today=today)
        if invoice is None:
            # Period already generated (e.g. concurrent run) - move the pointer forward.
            RecurringInvoiceSchedule.objects.filter(pk=schedule.pk, next_run_date=schedule.next_run_date).update(
                next_run_date=advance(schedule.next_run_date, schedule.frequency))
            continue
        created.append(invoice)
    return created


def run_due_schedules(today: date | None = None) -> int:
    today = today or timezone.localdate()
    count = 0
    for schedule in RecurringInvoiceSchedule.objects.filter(is_active=True, next_run_date__lte=today):
        try:
            count += len(run_schedule(schedule, today=today))
        except Exception:
            logger.exception("Recurring schedule %s failed", schedule.pk)
    return count
