from datetime import timedelta
from decimal import Decimal

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.accounts.models import Role
from apps.timetracking.models import TimeEntry


def _rewind(entry, seconds):
    """Simulates elapsed wall-clock time by moving the running segment's start into the past."""
    TimeEntry.objects.filter(pk=entry["id"]).update(segment_started_at=timezone.now() - timedelta(seconds=seconds))


def test_timer_lifecycle_uses_server_time(agency, world):
    api = world.api(agency.dev)
    r = api.post("/api/timer/start/", {"project": agency.project.pk, "task": agency.task.pk, "description": "Checkout"},
                 format="json")
    assert r.status_code == 201
    entry = r.json()["entry"]
    assert entry["timer_state"] == "running" and entry["billable"] is True
    assert "server_now" in r.json()

    _rewind(entry, 600)
    paused = api.post("/api/timer/pause/").json()["entry"]
    assert paused["timer_state"] == "paused"
    assert 599 <= paused["accumulated_seconds"] <= 605

    # Time spent paused does not count.
    TimeEntry.objects.filter(pk=entry["id"]).update(updated_at=timezone.now() - timedelta(hours=1))
    resumed = api.post("/api/timer/resume/").json()["entry"]
    assert resumed["timer_state"] == "running"
    _rewind(entry, 300)
    stopped = api.post("/api/timer/stop/").json()["entry"]
    assert stopped["timer_state"] == "stopped"
    assert 899 <= stopped["duration_seconds"] <= 910
    assert api.get("/api/timer/").json()["entry"] is None
    # Starting a timer moves the task into progress.
    agency.task.refresh_from_db()
    assert agency.task.status == "in_progress"


def test_only_one_active_timer_per_user(agency, world):
    api = world.api(agency.dev)
    assert api.post("/api/timer/start/", {"project": agency.project.pk}, format="json").status_code == 201
    r = api.post("/api/timer/start/", {"project": agency.project.pk, "task": agency.task.pk}, format="json")
    assert r.status_code == 409 and r.json()["error"]["code"] == "timer_running"
    # Explicit switch stops the current timer and starts the new one.
    r = api.post("/api/timer/start/", {"project": agency.project.pk, "task": agency.task.pk, "switch": True}, format="json")
    assert r.status_code == 201
    assert TimeEntry.objects.filter(user=agency.dev, timer_state__in=["running", "paused"]).count() == 1


def test_database_enforces_single_active_timer(agency):
    common = dict(organization=agency.org, user=agency.dev, project=agency.project, date=timezone.localdate(),
                  timer_state="running", segment_started_at=timezone.now())
    TimeEntry.objects.create(**common)
    with pytest.raises(IntegrityError), transaction.atomic():
        TimeEntry.objects.create(**common)


def test_duplicate_start_requests_are_idempotent(agency, world):
    api = world.api(agency.dev)
    payload = {"project": agency.project.pk, "request_id": "req-123"}
    first = api.post("/api/timer/start/", payload, format="json").json()["entry"]["id"]
    second = api.post("/api/timer/start/", payload, format="json")
    assert second.status_code == 201 and second.json()["entry"]["id"] == first


def test_repeated_stop_returns_same_entry(agency, world):
    api = world.api(agency.dev)
    entry = api.post("/api/timer/start/", {"project": agency.project.pk}, format="json").json()["entry"]
    _rewind(entry, 120)
    stopped = api.post("/api/timer/stop/", {"entry_id": entry["id"]}, format="json").json()
    again = api.post("/api/timer/stop/", {"entry_id": entry["id"]}, format="json")
    assert again.status_code == 200 and again.json()["entry"]["id"] == stopped["entry"]["id"]
    assert again.json()["entry"]["duration_seconds"] == stopped["entry"]["duration_seconds"]


def test_cannot_track_time_on_projects_user_is_not_member_of(agency, world):
    outsider = world.member(agency.org, Role.MEMBER, "Outsider")
    r = world.api(outsider).post("/api/timer/start/", {"project": agency.project.pk}, format="json")
    assert r.status_code == 400  # project is not visible to them, so the id does not resolve


def test_cannot_track_on_closed_project(agency, world):
    agency.project.status = "completed"
    agency.project.save()
    r = world.api(agency.dev).post("/api/timer/start/", {"project": agency.project.pk}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "project_closed"


def test_manual_entry_validation_and_rates(agency, world):
    api = world.api(agency.dev)
    base = {"project": agency.project.pk, "task": agency.task.pk, "date": str(timezone.localdate())}
    r = api.post("/api/time-entries/", {**base, "duration_seconds": 5400}, format="json")
    assert r.status_code == 201
    entry = TimeEntry.objects.get(pk=r.json()["id"])
    assert entry.bill_rate == Decimal("150.00") and entry.billable_amount == Decimal("225.00")
    assert api.post("/api/time-entries/", {**base, "duration_seconds": 0}, format="json").status_code == 400
    assert api.post("/api/time-entries/", {**base, "duration_seconds": 25 * 3600}, format="json").status_code == 400
    future = str(timezone.localdate() + timedelta(days=5))
    r = api.post("/api/time-entries/", {**base, "date": future, "duration_seconds": 600}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "future_date"
    start = timezone.now().replace(microsecond=0) - timedelta(hours=3)
    r = api.post("/api/time-entries/", {**base, "started_at": start.isoformat(),
                                        "ended_at": (start + timedelta(minutes=90)).isoformat()}, format="json")
    assert r.status_code == 201 and r.json()["duration_seconds"] == 5400


def test_rate_precedence(agency, world):
    from apps.projects.models import ProjectMember
    from apps.projects.services import resolve_rates

    assert resolve_rates(organization=agency.org, project=agency.project, task=None, user=agency.dev)[0] == Decimal("150.00")
    ProjectMember.objects.filter(project=agency.project, user=agency.dev).update(bill_rate=Decimal("170.00"))
    assert resolve_rates(organization=agency.org, project=agency.project, task=None, user=agency.dev)[0] == Decimal("170.00")
    agency.task.rate_override = Decimal("200.00")
    agency.task.save()
    rate, cost = resolve_rates(organization=agency.org, project=agency.project, task=agency.task, user=agency.dev)
    assert rate == Decimal("200.00") and cost == Decimal("40.00")


def test_submit_approve_workflow(agency, world):
    e1 = world.entry(agency.project, agency.dev, "2")
    e2 = world.entry(agency.project, agency.dev, "3", days_ago=2)
    dev = world.api(agency.dev)
    r = dev.post("/api/time-entries/submit/", {"ids": [e1.pk, e2.pk]}, format="json")
    assert r.status_code == 200 and r.json()["submitted"] == 2
    # Submitted entries are locked for their owner.
    r = dev.patch(f"/api/time-entries/{e1.pk}/", {"description": "edit"}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "entry_locked"

    pm = world.api(agency.pm)
    queue = pm.get("/api/approvals/time/").json()
    assert queue["count"] == 2
    assert queue["summary"]["person"][0]["hours"] == "5.00"
    assert queue["summary"]["person"][0]["value"] == [{"currency": "USD", "amount": "750.00"}]
    assert pm.post("/api/approvals/time/approve/", {"ids": [e1.pk, e2.pk]}, format="json").status_code == 200
    e1.refresh_from_db()
    assert e1.status == "approved" and e1.approved_by == agency.pm
    # Approved entries cannot be silently edited or deleted.
    assert dev.patch(f"/api/time-entries/{e1.pk}/", {"description": "x"}, format="json").status_code == 400
    assert dev.delete(f"/api/time-entries/{e1.pk}/").status_code == 400


def test_reject_requires_reason_and_returns_to_owner(agency, world):
    entry = world.entry(agency.project, agency.dev, "2", "submitted")
    pm = world.api(agency.pm)
    r = pm.post("/api/approvals/time/reject/", {"ids": [entry.pk]}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "reason_required"
    assert pm.post("/api/approvals/time/reject/", {"ids": [entry.pk], "reason": "Split by task"},
                   format="json").status_code == 200
    entry.refresh_from_db()
    assert entry.status == "rejected" and entry.rejection_reason == "Split by task"
    # Owner corrects the entry: it returns to draft and can be resubmitted.
    dev = world.api(agency.dev)
    r = dev.patch(f"/api/time-entries/{entry.pk}/", {"duration_seconds": 3600, "task": agency.task.pk}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "draft"
    assert dev.post("/api/time-entries/submit/", {"ids": [entry.pk]}, format="json").status_code == 200


def test_approval_permissions(agency, world):
    other_pm = world.member(agency.org, Role.PROJECT_MANAGER, "Other PM")
    entry = world.entry(agency.project, agency.dev, "1", "submitted")
    # PM of a different project cannot approve.
    r = world.api(other_pm).post("/api/approvals/time/approve/", {"ids": [entry.pk]}, format="json")
    assert r.status_code == 403
    # Team members cannot approve at all.
    assert world.api(agency.dev).post("/api/approvals/time/approve/", {"ids": [entry.pk]}, format="json").status_code == 403
    # Managers cannot approve their own time.
    own = world.entry(agency.project, agency.pm, "1", "submitted")
    r = world.api(agency.pm).post("/api/approvals/time/approve/", {"ids": [own.pk]}, format="json")
    assert r.status_code == 403 and r.json()["error"]["code"] == "self_approval"
    # Draft entries cannot be approved.
    draft = world.entry(agency.project, agency.dev, "1", "draft")
    r = world.api(agency.pm).post("/api/approvals/time/approve/", {"ids": [draft.pk]}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_status"


def test_reopen_approved_entry_is_audited(agency, world):
    from apps.core.models import ActivityLog

    entry = world.entry(agency.project, agency.dev, "2", "approved")
    pm = world.api(agency.pm)
    assert pm.post(f"/api/time-entries/{entry.pk}/reopen/", {}, format="json").status_code == 400
    r = pm.post(f"/api/time-entries/{entry.pk}/reopen/", {"reason": "Wrong task"}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "draft"
    log = ActivityLog.objects.get(verb="reopened_time")
    assert log.metadata["reason"] == "Wrong task" and log.actor == agency.pm


def test_week_timesheet_grid(agency, world):
    today = timezone.localdate()
    monday = today - timedelta(days=today.weekday())
    entry = world.entry(agency.project, agency.dev, "2.5", task=agency.task, days_ago=(today - monday).days)
    data = world.api(agency.dev).get(f"/api/timesheets/week/?start={monday}").json()
    assert data["start"] == str(monday) and len(data["days"]) == 7
    assert data["total_seconds"] == 9000
    assert data["rows"][0]["days"][str(entry.date)] == 9000
    # Members cannot view other people's timesheets; managers can for their projects.
    assert world.api(agency.dev).get(f"/api/timesheets/week/?user={agency.pm.pk}").status_code == 403
    assert world.api(agency.pm).get(f"/api/timesheets/week/?start={monday}&user={agency.dev.pk}").json()["total_seconds"] == 9000


def test_timer_switch_project_updates_rates(agency, world):
    other = world.project(agency.org, agency.client, agency.pm, members=[agency.dev], code="ACME-003",
                          hourly_rate=Decimal("90.00"))
    api = world.api(agency.dev)
    api.post("/api/timer/start/", {"project": agency.project.pk}, format="json")
    r = api.patch("/api/timer/current/", {"project": other.pk, "description": "moved"}, format="json")
    assert r.status_code == 200
    entry = TimeEntry.objects.get(user=agency.dev, timer_state="running")
    assert entry.project == other and entry.bill_rate == Decimal("90.00") and entry.description == "moved"
