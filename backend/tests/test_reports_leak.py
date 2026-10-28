from datetime import timedelta
from decimal import Decimal

from django.utils import timezone

from apps.finance import invoicing
from apps.projects.models import Milestone
from apps.reports import leak


def _types(membership_user, world):
    data = world.api(membership_user).get("/api/revenue-leak/").json()
    return {a["type"]: a for a in data["alerts"]}, data


def test_unbilled_time_alert_lifecycle(agency, world):
    entry = world.entry(agency.project, agency.dev, "4", "approved", days_ago=40)
    alerts, data = _types(agency.owner, world)
    alert = alerts["unbilled_time"]
    assert alert["severity"] == "high"  # older than 30 days
    assert alert["amount"] == [{"currency": "USD", "amount": "600.00"}]
    assert alert["records"][0]["id"] == entry.pk
    assert alert["action"]["kind"] == "generate_invoice" and alert["action"]["params"]["projects"] == [agency.project.pk]
    assert data["summary"]["unbilled_value"] == [{"currency": "USD", "amount": "600.00"}]
    invoicing.generate_from_work(organization=agency.org, client=agency.client, project_ids=[agency.project.pk],
                                 actor=agency.owner)
    alerts, _ = _types(agency.owner, world)
    assert "unbilled_time" not in alerts


def test_time_stuck_in_approval_lists_its_entries(agency, world):
    from apps.timetracking.models import TimeEntry

    stuck = world.entry(agency.project, agency.dev, "3", "submitted", days_ago=8)
    fresh = world.entry(agency.project, agency.dev, "2", "submitted", days_ago=1)
    TimeEntry.objects.filter(pk=stuck.pk).update(submitted_at=timezone.now() - timedelta(days=7))
    TimeEntry.objects.filter(pk=fresh.pk).update(submitted_at=timezone.now() - timedelta(days=1))
    alert = _types(agency.owner, world)[0]["pending_approval"]
    assert alert["record_count"] == 1 and [r["id"] for r in alert["records"]] == [stuck.pk]
    assert alert["title"].startswith("3.00h of billable time awaiting approval")
    assert alert["action"]["url"] == f"/timesheets?tab=approvals&project={agency.project.pk}"


def test_done_task_without_time_is_flagged_only_with_evidence(agency, world):
    agency.task.status = "done"
    agency.task.save()  # billable, estimated 10h, no time
    world.task(agency.project, "Done without estimate", status="done")  # no estimate -> no evidence
    alerts, _ = _types(agency.owner, world)
    alert = alerts["done_without_time"]
    assert alert["record_count"] == 1 and alert["records"][0]["id"] == agency.task.pk
    world.entry(agency.project, agency.dev, "3", "draft", task=agency.task)
    alerts, _ = _types(agency.owner, world)
    assert "done_without_time" not in alerts


def test_milestone_budget_overdue_and_retainer_alerts(agency, world):
    Milestone.objects.create(organization=agency.org, project=agency.project, name="Phase 1", status="completed",
                             amount=Decimal("5000"))
    agency.project.budget_amount = Decimal("1000")
    agency.project.save()
    world.entry(agency.project, agency.dev, "7", "approved", days_ago=2)  # 1050 -> 105%
    retainer = world.project(agency.org, agency.client, agency.pm, members=[agency.dev], code="RET-1",
                             project_type="retainer", retainer_hours=Decimal("10"))
    world.entry(retainer, agency.dev, "9", "draft", days_ago=0)
    other_client = world.client_record(agency.org)
    other = world.project(agency.org, other_client, agency.pm, code="OTH-1")
    world.entry(other, agency.pm, "2", "approved")
    inv = invoicing.generate_from_work(organization=agency.org, client=other_client, project_ids=[other.pk],
                                       actor=agency.owner)
    invoicing.send_invoice(inv, agency.owner, send_email=False)
    from apps.finance.models import Invoice
    Invoice.objects.filter(pk=inv.pk).update(due_date=timezone.localdate() - timedelta(days=45))

    alerts, data = _types(agency.owner, world)
    assert alerts["uninvoiced_milestone"]["amount"] == [{"currency": "USD", "amount": "5000.00"}]
    assert alerts["budget"]["severity"] == "high" and "105.0%" in alerts["budget"]["title"]
    assert "retainer" in alerts["retainer_limit"]["title"]
    assert alerts["overdue_invoice"]["severity"] == "high"
    # Every alert explains itself and names its records.
    assert all(a["explanation"] and "record_count" in a for a in data["alerts"])


def test_leak_radar_scoping(agency, world):
    from apps.accounts.models import Role

    other_pm = world.member(agency.org, Role.PROJECT_MANAGER, "Other PM")
    other_project = world.project(agency.org, agency.client, other_pm, code="ACME-OTH")
    world.entry(other_project, other_pm, "3", "approved")
    world.entry(agency.project, agency.dev, "2", "approved")
    pm_view = world.api(agency.pm).get("/api/revenue-leak/").json()
    projects = {a["project"]["code"] for a in pm_view["alerts"] if a["project"]}
    assert projects == {"ACME-001"}
    assert all(a["action"]["kind"] == "link" for a in pm_view["alerts"])  # no billing access -> no invoice action


def test_dashboard_by_role(agency, world):
    world.entry(agency.project, agency.dev, "3", "submitted", days_ago=0)
    owner = world.api(agency.owner).get("/api/dashboard/").json()
    assert {"finance", "chart", "team", "approvals", "clients", "my_work", "projects"} <= set(owner)
    assert owner["approvals"]["time_entries"] == 1
    pm = world.api(agency.pm).get("/api/dashboard/").json()
    assert "approvals" in pm and "finance" not in pm
    member = world.api(agency.dev).get("/api/dashboard/").json()
    assert "approvals" not in member and "finance" not in member
    assert member["my_work"]["open_tasks"] == 1


def test_dashboard_metrics_come_from_records(agency, world):
    world.entry(agency.project, agency.dev, "10", "approved", days_ago=0)
    inv = invoicing.generate_from_work(organization=agency.org, client=agency.client, project_ids=[agency.project.pk],
                                       actor=agency.owner)
    invoicing.send_invoice(inv, agency.owner, send_email=False)
    invoicing.record_payment(inv, amount=Decimal("400.00"), method="bank_transfer", actor=agency.owner)
    data = world.api(agency.owner).get("/api/dashboard/").json()
    assert data["finance"]["invoiced_this_month"] == [{"currency": "USD", "amount": "1500.00"}]
    assert data["finance"]["collected_this_month"] == [{"currency": "USD", "amount": "400.00"}]
    assert data["finance"]["outstanding"] == [{"currency": "USD", "amount": "1100.00"}]
    assert data["time"]["billable_hours_this_month"] == "10.00"


def test_reports_overview_and_currency_separation(agency, world):
    eur_client = world.client_record(agency.org, "Globex", currency="EUR")
    eur_project = world.project(agency.org, eur_client, agency.pm, code="GLOB-1", currency="EUR",
                                hourly_rate=Decimal("100"))
    world.entry(agency.project, agency.dev, "2", "approved")
    world.entry(eur_project, agency.pm, "3", "approved")
    world.entry(agency.project, agency.dev, "1", "approved", billable=False)
    report = world.api(agency.owner).get("/api/reports/overview/").json()
    assert report["hours"] == {"total": "6.00", "billable": "5.00", "non_billable": "1.00"}
    assert sorted(report["billable_value"], key=lambda r: r["currency"]) == [
        {"currency": "EUR", "amount": "300.00"}, {"currency": "USD", "amount": "300.00"}]
    assert "estimated_margin" in report["definitions"]
    filtered = world.api(agency.owner).get(f"/api/reports/overview/?project={eur_project.pk}").json()
    assert filtered["billable_value"] == [{"currency": "EUR", "amount": "300.00"}]


def test_csv_export_neutralises_formulas(agency, world):
    entry = world.entry(agency.project, agency.dev, "1", "approved")
    entry.description = "=HYPERLINK(\"http://evil\")"
    entry.save()
    r = world.api(agency.owner).get("/api/reports/export/time/")
    assert r.status_code == 200 and r["Content-Type"].startswith("text/csv")
    body = r.content.decode()
    assert "'=HYPERLINK" in body and "\n=HYPERLINK" not in body
    assert world.api(agency.dev).get("/api/reports/export/time/").status_code == 403
    # Every text column is escaped, including values users control (their name, task titles).
    agency.dev.full_name = "=cmd|' /C calc'!A0"
    agency.dev.save()
    agency.task.title = "+SUM(1,1)"
    agency.task.save()
    world.entry(agency.project, agency.dev, "1", "approved", task=agency.task)
    body = world.api(agency.owner).get("/api/reports/export/time/").content.decode()
    assert ",=cmd" not in body and "'=cmd" in body
    assert ",+SUM" not in body and "'+SUM" in body
    team = world.api(agency.owner).get("/api/reports/export/team/").content.decode()
    assert "'=cmd" in team and "\n=cmd" not in team


def test_csv_escaping_keeps_plain_numbers():
    from apps.reports.views import _safe

    assert _safe("-125.50") == "-125.50" and _safe("42") == "42"
    assert _safe("-2+3+cmd") == "'-2+3+cmd" and _safe("\t=1") == "'\t=1" and _safe("@SUM(A1)") == "'@SUM(A1)"
    assert _safe(None) is None and _safe(3) == 3


def test_calendar_and_search(agency, world):
    agency.task.due_date = timezone.localdate()
    agency.task.save()
    today = timezone.localdate()
    events = world.api(agency.dev).get(f"/api/calendar/?start={today - timedelta(days=3)}&end={today + timedelta(days=3)}").json()
    assert any(e["type"] == "task" and e["title"] == "Build checkout" for e in events)
    results = world.api(agency.dev).get("/api/search/?q=checkout").json()["results"]
    assert [r["type"] for r in results] == ["task"]
    results = world.api(agency.dev).get("/api/search/?q=ACME-001-1").json()["results"]
    assert results and results[0]["title"] == "Build checkout"
