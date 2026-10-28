from datetime import date, timedelta
from decimal import Decimal

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

from apps.core.models import Notification
from apps.finance import recurring
from apps.finance.models import Expense, Invoice, RecurringInvoiceSchedule
from apps.projects import metrics
from apps.projects.services import check_budget_thresholds


def test_expense_workflow_and_receipt(agency, world):
    dev = world.api(agency.dev)
    receipt = SimpleUploadedFile("receipt.png", b"\x89PNG\r\n\x1a\n" + b"0" * 64, content_type="image/png")
    r = dev.post("/api/expenses/", {"project": agency.project.pk, "description": "Train ticket", "date": "2026-10-02",
                                    "amount": "80.00", "billable": "true", "currency": "USD", "receipt": receipt},
                 format="multipart")
    assert r.status_code == 201, r.content
    x = r.json()
    assert x["billable_amount"] == "80.00" and x["has_receipt"] is True  # chargeable defaults to cost
    assert dev.get(f"/api/expenses/{x['id']}/receipt/").status_code == 200
    assert dev.post(f"/api/expenses/{x['id']}/approve/").status_code == 403  # members cannot approve
    dev.post(f"/api/expenses/{x['id']}/submit/")
    assert dev.patch(f"/api/expenses/{x['id']}/", {"amount": "90"}, format="json").status_code == 400  # locked
    pm = world.api(agency.pm)
    assert pm.post(f"/api/expenses/{x['id']}/reject/", {}, format="json").status_code == 400  # reason required
    pm.post(f"/api/expenses/{x['id']}/reject/", {"reason": "Missing VAT receipt"}, format="json")
    r = dev.patch(f"/api/expenses/{x['id']}/", {"amount": "85.00"}, format="json")
    assert r.json()["status"] == "draft" and r.json()["billable_amount"] == "85.00"
    dev.post(f"/api/expenses/{x['id']}/submit/")
    assert pm.post(f"/api/expenses/{x['id']}/approve/").json()["status"] == "approved"


def test_expense_validation_rules(agency, world):
    dev = world.api(agency.dev)
    r = dev.post("/api/expenses/", {"description": "Lunch", "date": "2026-10-02", "amount": "20", "billable": True},
                 format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "billable_requires_project"
    r = dev.post("/api/expenses/", {"project": agency.project.pk, "description": "x", "date": "2026-10-02",
                                    "amount": "20", "currency": "EUR"}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "currency_mismatch"
    r = dev.post("/api/expenses/", {"project": agency.project.pk, "description": "x", "date": "2026-10-02",
                                    "amount": "-5"}, format="json")
    assert r.status_code == 400
    bad = SimpleUploadedFile("receipt.pdf", b"not a pdf", content_type="application/pdf")
    r = dev.post("/api/expenses/", {"project": agency.project.pk, "description": "x", "date": "2026-10-02",
                                    "amount": "5", "receipt": bad}, format="multipart")
    assert r.status_code == 400


def test_internal_cost_vs_chargeable_amount(agency, world):
    Expense.objects.create(organization=agency.org, user=agency.dev, project=agency.project, client=agency.client,
                           description="Licence", date=timezone.localdate(), amount=Decimal("100"),
                           billable=True, billable_amount=Decimal("120"), status="approved", currency="USD")
    b = metrics.for_project(agency.project)["budget"]
    assert b["expense_cost"] == "100.00" and b["billable_expenses"] == "120.00"


def test_budget_calculations(agency, world):
    p = agency.project
    p.budget_amount, p.budget_hours, p.estimated_expenses = Decimal("3000"), Decimal("20"), Decimal("500")
    p.save()
    world.entry(p, agency.dev, "8", "approved")                    # 8h x 150 = 1200
    world.entry(p, agency.dev, "2", "approved", billable=False)    # hours only
    world.entry(p, agency.dev, "5", "rejected")                    # ignored
    world.entry(p, agency.dev, "4", "submitted")                   # 600, pending approval
    b = metrics.for_project(p)["budget"]
    assert b["hours_tracked"] == "14.00" and b["hours_billable"] == "12.00" and b["hours_pending_approval"] == "4.00"
    assert b["fees_used"] == "1800.00" and b["fees_percent"] == "60.0" and b["hours_percent"] == "70.0"
    assert b["fees_remaining"] == "1200.00"
    assert b["labor_cost"] == "560.00"  # 14h x 40 cost rate
    assert b["alert_level"] == 0


def test_budget_threshold_notifications_fire_once(agency, world):
    p = agency.project
    p.budget_amount, p.budget_hours = Decimal("1000"), Decimal("0")
    p.save()
    world.entry(p, agency.dev, "5.2", "approved")  # 780 -> 78%
    assert check_budget_thresholds(p) == 75
    assert check_budget_thresholds(p) == 75
    assert Notification.objects.filter(kind="budget_threshold", recipient=agency.pm).count() == 1
    world.entry(p, agency.dev, "1.5", "approved")  # 1005 -> 100.5%
    assert check_budget_thresholds(p) == 100
    titles = list(Notification.objects.filter(kind="budget_threshold", recipient=agency.pm).values_list("title", flat=True))
    assert len(titles) == 2 and any("exceeded 100%" in t for t in titles)
    # Increasing the budget re-arms lower thresholds.
    p.budget_amount = Decimal("5000")
    p.save()
    assert check_budget_thresholds(p) == 0
    p.refresh_from_db()
    assert p.budget_alert_level == 0


def test_retainer_budget_is_monthly(agency, world):
    p = world.project(agency.org, agency.client, agency.pm, members=[agency.dev], code="RET-1", project_type="retainer",
                      retainer_hours=Decimal("10"), retainer_amount=Decimal("1500"))
    world.entry(p, agency.dev, "4", "approved", days_ago=0)
    world.entry(p, agency.dev, "20", "approved", days_ago=40)  # previous month, not counted
    b = metrics.for_project(p)["budget"]
    assert b["budget_period"] == "month" and b["hours_used"] == "4.00" and b["hours_percent"] == "40.0"
    assert metrics.retainer_usage(p)["hours_used"] == "4.00"


def test_month_arithmetic_handles_short_months():
    assert recurring.advance(date(2026, 1, 31), "monthly") == date(2026, 2, 28)
    assert recurring.advance(date(2026, 11, 30), "quarterly") == date(2027, 2, 28)
    assert recurring.advance(date(2028, 2, 29), "yearly") == date(2029, 2, 28)
    assert recurring.advance(date(2026, 3, 1), "weekly") == date(2026, 3, 8)


def _schedule(agency, **fields):
    defaults = dict(organization=agency.org, client=agency.client, project=agency.project, name="Retainer",
                    frequency="monthly", start_date=date(2026, 7, 1), next_run_date=date(2026, 7, 1), currency="USD",
                    line_items=[{"description": "Monthly retainer", "quantity": "1", "unit_price": "2500.00"}],
                    tax_rate=Decimal("10"), payment_terms_days=14, created_by=agency.owner)
    defaults.update(fields)
    return RecurringInvoiceSchedule.objects.create(**defaults)


def test_recurring_preview_and_catch_up_is_idempotent(agency):
    schedule = _schedule(agency)
    preview = recurring.preview(schedule, today=date(2026, 6, 20))
    assert preview["total"] == "2750.00" and preview["due_date"] == "2026-07-15"
    created = recurring.run_schedule(schedule, today=date(2026, 9, 15))
    assert len(created) == 3  # July, August, September
    assert all(inv.total == Decimal("2750.00") and inv.status == "draft" for inv in created)
    # Late (catch-up) periods are issued on the run date and payment terms start from that date.
    assert all(inv.issue_date == date(2026, 9, 15) and inv.due_date == date(2026, 9, 29) for inv in created)
    assert recurring.run_schedule(schedule, today=date(2026, 9, 15)) == []
    schedule.refresh_from_db()
    assert schedule.next_run_date == date(2026, 10, 1)
    # Generating an already-generated period directly is refused.
    assert recurring.generate_period(schedule, date(2026, 8, 1)) is None
    assert Invoice.objects.filter(recurring_schedule=schedule).count() == 3


def test_recurring_end_date_and_auto_send(agency):
    schedule = _schedule(agency, end_date=date(2026, 8, 15), auto_send=True)
    created = recurring.run_schedule(schedule, today=date(2026, 12, 1))
    assert len(created) == 2
    schedule.refresh_from_db()
    assert schedule.is_active is False
    assert all(Invoice.objects.get(pk=i.pk).status == "sent" for i in created)


def test_recurring_api(agency, world):
    api = world.api(agency.owner)
    r = api.post("/api/recurring-invoices/", {
        "client": agency.client.pk, "name": "Support plan", "frequency": "monthly", "start_date": "2026-10-01",
        "currency": "USD", "line_items": [{"description": "Support", "quantity": "1", "unit_price": "900"}],
    }, format="json")
    assert r.status_code == 201
    sid = r.json()["id"]
    assert api.get(f"/api/recurring-invoices/{sid}/preview/").json()["total"] == "900.00"
    r = api.post(f"/api/recurring-invoices/{sid}/generate-next/")
    assert r.status_code == 201
    assert api.get(f"/api/recurring-invoices/{sid}/history/").json()[0]["number"] == r.json()["number"]
    bad = api.post("/api/recurring-invoices/", {"client": agency.client.pk, "name": "x", "frequency": "monthly",
                                                "start_date": "2026-10-01", "currency": "USD", "line_items": []},
                   format="json")
    assert bad.status_code == 400
    assert world.api(agency.pm).get("/api/recurring-invoices/").status_code == 403
