from decimal import Decimal

import pytest

from apps.core.exceptions import BusinessRuleError
from apps.finance import invoicing
from apps.finance.invoicing import compute_totals
from apps.finance.models import Expense, Invoice
from apps.projects.models import Milestone
from apps.timetracking.models import TimeEntry


def test_compute_totals_decimal_rounding():
    t = compute_totals([Decimal("100.005"), Decimal("33.33")], "percent", Decimal("5"), Decimal("8.25"))
    # 100.01 + 33.33 = 133.34; discount 6.67; taxable 126.67; tax 10.45 (10.450275 -> 10.45)
    assert (t.subtotal, t.discount, t.tax, t.total) == (Decimal("133.34"), Decimal("6.67"), Decimal("10.45"), Decimal("137.12"))
    t = compute_totals([Decimal("50.00")], "amount", Decimal("80"), Decimal("10"))
    assert t.discount == Decimal("50.00") and t.total == Decimal("0.00")  # fixed discount capped at subtotal
    t = compute_totals([Decimal("0.10")] * 3, "none", Decimal("0"), Decimal("0"))
    assert t.total == Decimal("0.30")  # no float drift


def test_generate_invoice_only_from_approved_billable_work(agency, world):
    approved = world.entry(agency.project, agency.dev, "2", "approved", task=agency.task)
    world.entry(agency.project, agency.dev, "1", "approved", task=agency.task, days_ago=3)
    world.entry(agency.project, agency.dev, "5", "submitted")
    world.entry(agency.project, agency.dev, "5", "draft")
    world.entry(agency.project, agency.dev, "5", "rejected")
    world.entry(agency.project, agency.dev, "4", "approved", billable=False)
    api = world.api(agency.owner)
    unbilled = api.get(f"/api/invoices/unbilled/?client={agency.client.pk}").json()["projects"][0]
    assert unbilled["time_hours"] == "3.00" and unbilled["time_value"] == "450.00" and unbilled["pending_time_hours"] == "5.00"

    r = api.post("/api/invoices/generate/", {"client": agency.client.pk, "projects": [agency.project.pk]}, format="json")
    assert r.status_code == 201
    invoice = Invoice.objects.get(pk=r.json()["id"])
    assert invoice.status == "draft" and invoice.number == "INV-0001"
    lines = list(invoice.lines.all())
    assert len(lines) == 1 and lines[0].quantity == Decimal("3.00") and lines[0].unit_price == Decimal("150.00")
    assert invoice.total == Decimal("450.00")
    approved.refresh_from_db()
    assert approved.invoice_line == lines[0]
    assert TimeEntry.objects.filter(invoice_line__isnull=False).count() == 2


def test_same_work_is_never_invoiced_twice(agency, world):
    world.entry(agency.project, agency.dev, "2", "approved")
    api = world.api(agency.owner)
    payload = {"client": agency.client.pk, "projects": [agency.project.pk], "idempotency_key": "wizard-1"}
    first = api.post("/api/invoices/generate/", payload, format="json")
    retry = api.post("/api/invoices/generate/", payload, format="json")
    assert first.json()["id"] == retry.json()["id"]  # duplicate submit returns the same invoice
    second = api.post("/api/invoices/generate/", {**payload, "idempotency_key": "wizard-2"}, format="json")
    assert second.status_code == 400 and second.json()["error"]["code"] == "nothing_to_invoice"
    assert Invoice.objects.count() == 1


def test_database_prevents_invoicing_unapproved_time(agency, world):
    from django.db import IntegrityError, transaction

    entry = world.entry(agency.project, agency.dev, "1", "approved")
    invoice = invoicing.generate_from_work(organization=agency.org, client=agency.client,
                                           project_ids=[agency.project.pk], actor=agency.owner)
    entry.refresh_from_db()
    with pytest.raises(IntegrityError), transaction.atomic():
        TimeEntry.objects.filter(pk=entry.pk).update(status="draft")
    assert invoice.lines.count() == 1


def test_invoiced_time_cannot_be_reopened(agency, world):
    entry = world.entry(agency.project, agency.dev, "1", "approved")
    invoicing.generate_from_work(organization=agency.org, client=agency.client, project_ids=[agency.project.pk],
                                 actor=agency.owner)
    r = world.api(agency.pm).post(f"/api/time-entries/{entry.pk}/reopen/", {"reason": "fix"}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "already_invoiced"


def test_expenses_and_milestones_on_invoice(agency, world):
    pm = world.api(agency.pm)
    dev = world.api(agency.dev)
    x = dev.post("/api/expenses/", {"project": agency.project.pk, "description": "Fonts", "date": "2026-10-01",
                                    "amount": "100.00", "billable": True, "billable_amount": "115.00", "currency": "USD"},
                 format="json").json()
    dev.post(f"/api/expenses/{x['id']}/submit/")
    pm.post(f"/api/expenses/{x['id']}/approve/")
    ms = Milestone.objects.create(organization=agency.org, project=agency.project, name="Phase 1", status="completed",
                                  amount=Decimal("2000.00"))
    api = world.api(agency.owner)
    r = api.post("/api/invoices/generate/", {"client": agency.client.pk, "projects": [agency.project.pk],
                                             "milestones": [ms.pk]}, format="json")
    assert r.status_code == 201
    invoice = Invoice.objects.get(pk=r.json()["id"])
    kinds = sorted(line.kind for line in invoice.lines.all())
    assert kinds == ["expense", "milestone"]
    assert invoice.total == Decimal("2115.00")  # chargeable amount, not internal cost
    assert Expense.objects.get(pk=x["id"]).invoice_line is not None
    ms.refresh_from_db()
    assert ms.invoice_line is not None


def test_mixed_currency_projects_are_rejected(agency, world):
    eur = world.project(agency.org, agency.client, agency.pm, code="ACME-EUR", currency="EUR")
    world.entry(agency.project, agency.dev, "1", "approved")
    world.entry(eur, agency.pm, "1", "approved")
    with pytest.raises(BusinessRuleError) as exc:
        invoicing.generate_from_work(organization=agency.org, client=agency.client,
                                     project_ids=[agency.project.pk, eur.pk], actor=agency.owner)
    assert exc.value.get_codes() == "mixed_currency"


def test_draft_editing_send_and_lock(agency, world, django_capture_on_commit_callbacks):
    from django.core import mail

    world.entry(agency.project, agency.dev, "2", "approved")
    api = world.api(agency.owner)
    inv = api.post("/api/invoices/generate/", {"client": agency.client.pk, "projects": [agency.project.pk]},
                   format="json").json()
    r = api.post(f"/api/invoices/{inv['id']}/lines/", {"description": "Hosting setup", "quantity": "1",
                                                       "unit_price": "200.00"}, format="json")
    assert r.json()["total"] == "500.00"
    time_line = next(line for line in r.json()["lines"] if line["kind"] == "time")
    r = api.patch(f"/api/invoices/{inv['id']}/lines/{time_line['id']}/", {"quantity": "5"}, format="json")
    assert r.status_code == 400  # time quantities come from approved entries
    r = api.patch(f"/api/invoices/{inv['id']}/", {"discount_type": "percent", "discount_value": "10", "tax_rate": "20"},
                  format="json")
    assert r.json()["total"] == "540.00"  # (500 - 50) * 1.2
    with django_capture_on_commit_callbacks(execute=True):
        r = api.post(f"/api/invoices/{inv['id']}/send/", {"send_email": True}, format="json")
    assert r.json()["status"] == "sent"
    invoice_mail = next(m for m in mail.outbox if m.attachments)
    assert invoice_mail.attachments[0][0] == f"{inv['number']}.pdf" and invoice_mail.to == [agency.client.email]
    assert api.patch(f"/api/invoices/{inv['id']}/", {"notes": "x"}, format="json").status_code == 400
    assert api.delete(f"/api/invoices/{inv['id']}/").status_code == 400


def test_partial_payments_balances_and_status(agency, world):
    world.entry(agency.project, agency.dev, "10", "approved")  # 1500.00
    invoice = invoicing.generate_from_work(organization=agency.org, client=agency.client,
                                           project_ids=[agency.project.pk], actor=agency.owner)
    api = world.api(agency.owner)
    assert api.post(f"/api/invoices/{invoice.pk}/payments/", {"amount": "100"}, format="json").status_code == 400  # draft
    invoicing.send_invoice(invoice, agency.owner, send_email=False)
    r = api.post(f"/api/invoices/{invoice.pk}/payments/", {"amount": "600.00", "method": "bank_transfer"}, format="json")
    assert (r.json()["status"], r.json()["amount_paid"], r.json()["amount_due"]) == ("partially_paid", "600.00", "900.00")
    r = api.post(f"/api/invoices/{invoice.pk}/payments/", {"amount": "900.01"}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "overpayment"
    r = api.post(f"/api/invoices/{invoice.pk}/credit-notes/", {"amount": "100.00", "reason": "Goodwill"}, format="json")
    assert r.json()["amount_due"] == "800.00" and r.json()["credit_notes"][0]["number"] == "CN-0001"
    r = api.post(f"/api/invoices/{invoice.pk}/payments/", {"amount": "800.00"}, format="json")
    assert (r.json()["status"], r.json()["amount_due"]) == ("paid", "0.00")
    # Reversal reopens the balance through an audited workflow.
    payment_id = r.json()["payments"][0]["id"]
    assert api.post(f"/api/payments/{payment_id}/reverse/", {}, format="json").status_code == 400
    r = api.post(f"/api/payments/{payment_id}/reverse/", {"reason": "Bounced transfer"}, format="json")
    assert r.status_code == 200
    invoice.refresh_from_db()
    assert invoice.status == "partially_paid" and invoice.amount_due > 0


def test_void_releases_work_for_reinvoicing(agency, world):
    entry = world.entry(agency.project, agency.dev, "2", "approved")
    invoice = invoicing.generate_from_work(organization=agency.org, client=agency.client,
                                           project_ids=[agency.project.pk], actor=agency.owner)
    invoicing.send_invoice(invoice, agency.owner, send_email=False)
    api = world.api(agency.owner)
    assert api.post(f"/api/invoices/{invoice.pk}/void/", {}, format="json").status_code == 400  # reason required
    r = api.post(f"/api/invoices/{invoice.pk}/void/", {"reason": "Wrong client"}, format="json")
    assert r.json()["status"] == "void"
    entry.refresh_from_db()
    assert entry.invoice_line is None
    again = invoicing.generate_from_work(organization=agency.org, client=agency.client,
                                         project_ids=[agency.project.pk], actor=agency.owner)
    assert again.total == Decimal("300.00")


def test_cannot_void_paid_invoice(agency, world):
    world.entry(agency.project, agency.dev, "1", "approved")
    invoice = invoicing.generate_from_work(organization=agency.org, client=agency.client,
                                           project_ids=[agency.project.pk], actor=agency.owner)
    invoicing.send_invoice(invoice, agency.owner, send_email=False)
    invoicing.record_payment(invoice, amount=Decimal("50"), method="cash", actor=agency.owner)
    with pytest.raises(BusinessRuleError):
        invoicing.void_invoice(invoice, agency.owner, "x")


def test_deleting_draft_releases_entries(agency, world):
    entry = world.entry(agency.project, agency.dev, "1", "approved")
    invoice = invoicing.generate_from_work(organization=agency.org, client=agency.client,
                                           project_ids=[agency.project.pk], actor=agency.owner)
    assert world.api(agency.owner).delete(f"/api/invoices/{invoice.pk}/").status_code == 204
    entry.refresh_from_db()
    assert entry.invoice_line is None


def test_invoice_numbers_are_sequential_per_workspace(agency, world):
    other_org, other_owner = world.workspace("Other")
    other_client = world.client_record(other_org)
    a = invoicing.create_manual_invoice(organization=agency.org, client=agency.client, currency="USD", actor=agency.owner,
                                        lines=[{"description": "A", "quantity": Decimal(1), "unit_price": Decimal(10)}])
    b = invoicing.create_manual_invoice(organization=agency.org, client=agency.client, currency="USD", actor=agency.owner,
                                        lines=[{"description": "B", "quantity": Decimal(1), "unit_price": Decimal(10)}])
    c = invoicing.create_manual_invoice(organization=other_org, client=other_client, currency="USD", actor=other_owner,
                                        lines=[{"description": "C", "quantity": Decimal(1), "unit_price": Decimal(10)}])
    assert (a.number, b.number, c.number) == ("INV-0001", "INV-0002", "INV-0001")


def test_invoice_pdf_renders(agency, world):
    world.entry(agency.project, agency.dev, "1", "approved")
    invoice = invoicing.generate_from_work(organization=agency.org, client=agency.client,
                                           project_ids=[agency.project.pk], actor=agency.owner)
    r = world.api(agency.owner).get(f"/api/invoices/{invoice.pk}/pdf/")
    assert r.status_code == 200 and r["Content-Type"] == "application/pdf" and r.content.startswith(b"%PDF")
