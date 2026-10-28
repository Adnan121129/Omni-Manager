"""
Time tracking business rules.

Timer policy: one active (running or paused) timer per user. All timer operations lock the
user's row so concurrent requests (double clicks, two tabs, retries) are serialised, and a
partial unique index enforces the policy at the database level as a last line of defence.
All timestamps come from the server clock; the browser only renders elapsed time.
"""

import zoneinfo
from collections import defaultdict
from datetime import date, timedelta

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.accounts.models import ADMIN_ROLES, Membership, Role, User
from apps.core.activity import log_activity
from apps.core.exceptions import BusinessRuleError, ConflictError
from apps.core.money import hours_from_seconds
from apps.core.notify import notify
from apps.projects.access import can_manage_project, can_view_project, managed_projects
from apps.projects.models import Project, Task
from apps.projects.services import check_budget_thresholds, resolve_rates

from .models import TimeEntry

MAX_ENTRY_SECONDS = 24 * 3600
ACTIVE_STATES = [TimeEntry.TimerState.RUNNING, TimeEntry.TimerState.PAUSED]


def user_today(user) -> date:
    try:
        tz = zoneinfo.ZoneInfo(user.timezone or "UTC")
    except zoneinfo.ZoneInfoNotFoundError:
        tz = zoneinfo.ZoneInfo("UTC")
    return timezone.now().astimezone(tz).date()


def local_date(moment, user) -> date:
    try:
        tz = zoneinfo.ZoneInfo(user.timezone or "UTC")
    except zoneinfo.ZoneInfoNotFoundError:
        tz = zoneinfo.ZoneInfo("UTC")
    return moment.astimezone(tz).date()


def elapsed_seconds(entry: TimeEntry, now=None) -> int:
    now = now or timezone.now()
    seconds = entry.accumulated_seconds
    if entry.timer_state == TimeEntry.TimerState.RUNNING and entry.segment_started_at:
        seconds += max(0, int((now - entry.segment_started_at).total_seconds()))
    return seconds


def _lock_user(user) -> None:
    User.objects.select_for_update(of=("self",)).filter(pk=user.pk).first()


def _active_timer(user, lock=True):
    qs = TimeEntry.objects.filter(user=user, timer_state__in=ACTIVE_STATES)
    if lock:
        qs = qs.select_for_update(of=("self",))
    return qs.select_related("project", "task").first()


def get_active_timer(user):
    return TimeEntry.objects.filter(user=user, timer_state__in=ACTIVE_STATES).select_related(
        "project", "project__client", "task").first()


def _validate_target(membership: Membership, project: Project, task: Task | None):
    if project.organization_id != membership.organization_id or not can_view_project(membership, project):
        raise BusinessRuleError("You can only track time on projects you are a member of.", code="not_project_member")
    if project.status in (Project.Status.COMPLETED, Project.Status.CANCELLED):
        raise BusinessRuleError("Time cannot be tracked on a completed or cancelled project.", code="project_closed")
    if task is not None and task.project_id != project.pk:
        raise BusinessRuleError("The task does not belong to the selected project.", code="task_project_mismatch")


@transaction.atomic
def start_timer(*, membership: Membership, project: Project, task: Task | None = None, description: str = "",
                billable: bool | None = None, request_id: str | None = None, switch: bool = False) -> TimeEntry:
    user = membership.user
    _lock_user(user)
    if request_id:
        existing = TimeEntry.objects.filter(user=user, client_request_id=request_id).first()
        if existing is not None:
            return existing  # duplicate submit of the same start request
    active = _active_timer(user)
    if active is not None:
        if not switch:
            raise ConflictError("You already have a timer running. Stop it or switch to the new task.",
                                code="timer_running", extra={"active_entry_id": active.pk,
                                                             "project": active.project.code,
                                                             "task": active.task.title if active.task else None})
        _stop(active)
    _validate_target(membership, project, task)
    now = timezone.now()
    bill_rate, cost_rate = resolve_rates(organization=membership.organization, project=project, task=task, user=user)
    if billable is None:
        billable = task.billable if task is not None else True
    try:
        with transaction.atomic():
            entry = TimeEntry.objects.create(
                organization=membership.organization, user=user, project=project, task=task,
                description=description[:500], date=local_date(now, user), started_at=now, segment_started_at=now,
                source=TimeEntry.Source.TIMER, timer_state=TimeEntry.TimerState.RUNNING, billable=billable,
                bill_rate=bill_rate, cost_rate=cost_rate, client_request_id=request_id or None,
            )
    except IntegrityError:
        raise ConflictError("Another timer was started at the same moment.", code="timer_running")
    if task is not None and task.status == Task.Status.TODO:
        task.status = Task.Status.IN_PROGRESS
        task.save(update_fields=["status", "updated_at"])
        log_activity(organization=membership.organization, actor=user, verb="changed_status", target=task,
                     from_status="todo", to_status="in_progress", via="timer")
    return entry


def _stop(entry: TimeEntry) -> TimeEntry:
    now = timezone.now()
    entry.accumulated_seconds = elapsed_seconds(entry, now)
    entry.duration_seconds = min(entry.accumulated_seconds, MAX_ENTRY_SECONDS)
    entry.timer_state = TimeEntry.TimerState.STOPPED
    entry.segment_started_at = None
    entry.ended_at = now
    entry.save()
    return entry


@transaction.atomic
def pause_timer(user) -> TimeEntry:
    _lock_user(user)
    entry = _active_timer(user)
    if entry is None:
        raise BusinessRuleError("No timer is running.", code="no_timer", status_code=404)
    if entry.timer_state == TimeEntry.TimerState.RUNNING:
        entry.accumulated_seconds = elapsed_seconds(entry)
        entry.segment_started_at = None
        entry.timer_state = TimeEntry.TimerState.PAUSED
        entry.save(update_fields=["accumulated_seconds", "segment_started_at", "timer_state", "updated_at"])
    return entry


@transaction.atomic
def resume_timer(user) -> TimeEntry:
    _lock_user(user)
    entry = _active_timer(user)
    if entry is None:
        raise BusinessRuleError("No paused timer to resume.", code="no_timer", status_code=404)
    if entry.timer_state == TimeEntry.TimerState.PAUSED:
        entry.segment_started_at = timezone.now()
        entry.timer_state = TimeEntry.TimerState.RUNNING
        entry.save(update_fields=["segment_started_at", "timer_state", "updated_at"])
    return entry


@transaction.atomic
def stop_timer(user, entry_id: int | None = None) -> TimeEntry:
    _lock_user(user)
    entry = _active_timer(user)
    if entry is None:
        # Idempotent: a repeated stop returns the entry that was already stopped.
        if entry_id:
            stopped = TimeEntry.objects.filter(user=user, pk=entry_id).first()
            if stopped is not None:
                return stopped
        raise BusinessRuleError("No timer is running.", code="no_timer", status_code=404)
    entry = _stop(entry)
    if entry.duration_seconds == 0:
        # Started and stopped within the same second: nothing worth keeping.
        entry.delete()
        entry.discarded = True
        return entry
    transaction.on_commit(lambda: check_budget_thresholds(entry.project))
    return entry


@transaction.atomic
def discard_timer(user) -> None:
    _lock_user(user)
    entry = _active_timer(user)
    if entry is not None:
        entry.delete()


@transaction.atomic
def update_timer(membership: Membership, *, data: dict) -> TimeEntry:
    user = membership.user
    _lock_user(user)
    entry = _active_timer(user)
    if entry is None:
        raise BusinessRuleError("No timer is running.", code="no_timer", status_code=404)
    project = data.get("project", entry.project)
    task = data.get("task", entry.task if "project" not in data else None)
    _validate_target(membership, project, task)
    if project.pk != entry.project_id or (task and task.pk) != entry.task_id:
        entry.bill_rate, entry.cost_rate = resolve_rates(organization=membership.organization, project=project,
                                                         task=task, user=user)
    entry.project, entry.task = project, task
    if "description" in data:
        entry.description = data["description"][:500]
    if "billable" in data:
        entry.billable = data["billable"]
    entry.save()
    return entry


def _apply_duration(data: dict, user) -> tuple[int, object, object]:
    started_at = data.get("started_at")
    ended_at = data.get("ended_at")
    if started_at and ended_at:
        if ended_at <= started_at:
            raise BusinessRuleError("End time must be after the start time.", code="invalid_range")
        seconds = int((ended_at - started_at).total_seconds())
    else:
        seconds = int(data.get("duration_seconds") or 0)
        started_at = ended_at = None
    if seconds <= 0:
        raise BusinessRuleError("Duration must be greater than zero.", code="invalid_duration")
    if seconds > MAX_ENTRY_SECONDS:
        raise BusinessRuleError("A single entry cannot exceed 24 hours.", code="invalid_duration")
    return seconds, started_at, ended_at


@transaction.atomic
def create_manual_entry(membership: Membership, data: dict) -> TimeEntry:
    user = membership.user
    request_id = data.get("client_request_id")
    if request_id:
        existing = TimeEntry.objects.filter(user=user, client_request_id=request_id).first()
        if existing is not None:
            return existing
    project, task = data["project"], data.get("task")
    _validate_target(membership, project, task)
    work_date = data["date"]
    if work_date > user_today(user) + timedelta(days=1):
        raise BusinessRuleError("Time cannot be logged for future dates.", code="future_date")
    seconds, started_at, ended_at = _apply_duration(data, user)
    bill_rate, cost_rate = resolve_rates(organization=membership.organization, project=project, task=task, user=user)
    billable = data.get("billable")
    if billable is None:
        billable = task.billable if task is not None else True
    try:
        with transaction.atomic():
            entry = TimeEntry.objects.create(
                organization=membership.organization, user=user, project=project, task=task,
                description=(data.get("description") or "")[:500], date=work_date, started_at=started_at,
                ended_at=ended_at, duration_seconds=seconds, accumulated_seconds=seconds,
                source=TimeEntry.Source.MANUAL, timer_state=TimeEntry.TimerState.STOPPED, billable=billable,
                bill_rate=bill_rate, cost_rate=cost_rate, client_request_id=request_id or None,
            )
    except IntegrityError:
        return TimeEntry.objects.get(user=user, client_request_id=request_id)
    transaction.on_commit(lambda: check_budget_thresholds(project))
    return entry


def assert_editable(entry: TimeEntry, user) -> None:
    if entry.user_id != user.pk:
        raise BusinessRuleError("You can only edit your own time entries.", code="not_owner", status_code=403)
    if entry.is_active_timer:
        raise BusinessRuleError("Stop the timer before editing this entry.", code="timer_active")
    if entry.status not in TimeEntry.EDITABLE_STATUSES:
        raise BusinessRuleError(
            f"{entry.get_status_display()} entries are locked. Ask an approver to reopen it for correction.",
            code="entry_locked")


@transaction.atomic
def update_entry(membership: Membership, entry: TimeEntry, data: dict) -> TimeEntry:
    entry = TimeEntry.objects.select_for_update(of=("self",)).get(pk=entry.pk)
    assert_editable(entry, membership.user)
    project = data.get("project", entry.project)
    task = data["task"] if "task" in data else (entry.task if project.pk == entry.project_id else None)
    _validate_target(membership, project, task)
    if any(k in data for k in ("duration_seconds", "started_at", "ended_at")):
        merged = {"duration_seconds": data.get("duration_seconds", entry.duration_seconds),
                  "started_at": data.get("started_at"), "ended_at": data.get("ended_at")}
        entry.duration_seconds, entry.started_at, entry.ended_at = _apply_duration(merged, membership.user)
        entry.accumulated_seconds = entry.duration_seconds
    if project.pk != entry.project_id or (task.pk if task else None) != entry.task_id:
        entry.bill_rate, entry.cost_rate = resolve_rates(organization=membership.organization, project=project,
                                                         task=task, user=membership.user)
    entry.project, entry.task = project, task
    for field in ("description", "date", "billable"):
        if field in data:
            setattr(entry, field, data[field])
    if entry.status == TimeEntry.Status.REJECTED:
        entry.status = TimeEntry.Status.DRAFT  # corrected entries go back to draft for resubmission
    entry.save()
    transaction.on_commit(lambda: check_budget_thresholds(project))
    return entry


@transaction.atomic
def delete_entry(membership: Membership, entry: TimeEntry) -> None:
    entry = TimeEntry.objects.select_for_update(of=("self",)).get(pk=entry.pk)
    assert_editable(entry, membership.user)
    entry.delete()


def approvers_for(project: Project):
    admins = [m.user for m in Membership.objects.filter(organization_id=project.organization_id, role__in=ADMIN_ROLES,
                                                        status=Membership.Status.ACTIVE).select_related("user")]
    return [project.manager] if project.manager_id else admins


@transaction.atomic
def submit_entries(membership: Membership, *, ids: list[int] | None = None, start: date | None = None,
                   end: date | None = None) -> list[TimeEntry]:
    qs = TimeEntry.objects.select_for_update(of=("self",)).filter(
        organization=membership.organization, user=membership.user, status__in=TimeEntry.EDITABLE_STATUSES,
        timer_state=TimeEntry.TimerState.STOPPED)
    if ids:
        qs = qs.filter(pk__in=ids)
    elif start and end:
        qs = qs.filter(date__gte=start, date__lte=end)
    else:
        raise BusinessRuleError("Choose entries or a date range to submit.")
    entries = list(qs.select_related("project", "project__manager"))
    if not entries:
        raise BusinessRuleError("There are no draft entries to submit.", code="nothing_to_submit")
    now = timezone.now()
    for entry in entries:
        entry.status = TimeEntry.Status.SUBMITTED
        entry.submitted_at = now
        entry.rejection_reason = ""
    TimeEntry.objects.bulk_update(entries, ["status", "submitted_at", "rejection_reason", "updated_at"])
    by_project = defaultdict(list)
    for entry in entries:
        by_project[entry.project].append(entry)
    for project, project_entries in by_project.items():
        hours = hours_from_seconds(sum(e.duration_seconds for e in project_entries))
        log_activity(organization=membership.organization, actor=membership.user, verb="submitted_time",
                     target=project, entries=len(project_entries), hours=hours)
        notify(organization=membership.organization, recipients=approvers_for(project), kind="timesheet_submitted",
               title=f"{membership.user.full_name} submitted {hours}h on {project.code}",
               link="/timesheets?tab=approvals", exclude=membership.user)
    return entries


def approvable_entries(membership: Membership):
    qs = TimeEntry.objects.filter(organization=membership.organization)
    if membership.is_admin:
        return qs
    if membership.role == Role.PROJECT_MANAGER:
        return qs.filter(project__in=managed_projects(membership))
    return qs.none()


def _load_for_decision(membership: Membership, ids: list[int]) -> list[TimeEntry]:
    if not ids:
        raise BusinessRuleError("Select at least one entry.")
    entries = list(approvable_entries(membership).select_for_update(of=("self",)).filter(pk__in=ids)
                   .select_related("project", "user"))
    if len(entries) != len(set(ids)):
        raise BusinessRuleError("Some entries were not found or you cannot approve them.", code="not_approvable",
                                status_code=403)
    for entry in entries:
        if entry.status != TimeEntry.Status.SUBMITTED:
            raise BusinessRuleError(f"Only submitted entries can be reviewed (entry #{entry.pk} is {entry.status}).",
                                    code="invalid_status")
        if entry.user_id == membership.user_id and membership.role != Role.OWNER:
            raise BusinessRuleError("You cannot approve or reject your own time.", code="self_approval", status_code=403)
    return entries


def _notify_by_user(membership, entries, kind, verb, extra=""):
    by_user = defaultdict(list)
    for e in entries:
        by_user[e.user].append(e)
    for user, user_entries in by_user.items():
        hours = hours_from_seconds(sum(e.duration_seconds for e in user_entries))
        notify(organization=membership.organization, recipients=[user], kind=kind,
               title=f"{membership.user.full_name} {verb} {hours}h of your time", body=extra,
               link="/time?view=week", exclude=membership.user)


@transaction.atomic
def approve_entries(membership: Membership, ids: list[int]) -> list[TimeEntry]:
    entries = _load_for_decision(membership, ids)
    now = timezone.now()
    for entry in entries:
        entry.status = TimeEntry.Status.APPROVED
        entry.approved_at = now
        entry.approved_by = membership.user
        entry.rejection_reason = ""
    TimeEntry.objects.bulk_update(entries, ["status", "approved_at", "approved_by", "rejection_reason", "updated_at"])
    projects = {e.project for e in entries}
    for project in projects:
        project_entries = [e for e in entries if e.project_id == project.pk]
        log_activity(organization=membership.organization, actor=membership.user, verb="approved_time", target=project,
                     entry_ids=[e.pk for e in project_entries],
                     hours=hours_from_seconds(sum(e.duration_seconds for e in project_entries)))
    _notify_by_user(membership, entries, "timesheet_approved", "approved")
    transaction.on_commit(lambda: [check_budget_thresholds(p) for p in projects])
    return entries


@transaction.atomic
def reject_entries(membership: Membership, ids: list[int], reason: str) -> list[TimeEntry]:
    reason = (reason or "").strip()
    if not reason:
        raise BusinessRuleError("A rejection reason is required so the person knows what to correct.",
                                code="reason_required")
    entries = _load_for_decision(membership, ids)
    now = timezone.now()
    for entry in entries:
        entry.status = TimeEntry.Status.REJECTED
        entry.rejected_at = now
        entry.rejected_by = membership.user
        entry.rejection_reason = reason
    TimeEntry.objects.bulk_update(entries, ["status", "rejected_at", "rejected_by", "rejection_reason", "updated_at"])
    for project in {e.project for e in entries}:
        log_activity(organization=membership.organization, actor=membership.user, verb="rejected_time", target=project,
                     entry_ids=[e.pk for e in entries if e.project_id == project.pk], reason=reason)
    _notify_by_user(membership, entries, "timesheet_rejected", "rejected", extra=f"Reason: {reason}")
    return entries


@transaction.atomic
def reopen_entry(membership: Membership, entry: TimeEntry, reason: str) -> TimeEntry:
    """Audited correction path for approved time: returns it to draft so its owner can fix it."""
    reason = (reason or "").strip()
    if not reason:
        raise BusinessRuleError("Explain why this approved entry needs correction.", code="reason_required")
    entry = approvable_entries(membership).select_for_update(of=("self",)).filter(pk=entry.pk).select_related("project").first()
    if entry is None:
        raise BusinessRuleError("You cannot reopen this entry.", code="not_approvable", status_code=403)
    if entry.status != TimeEntry.Status.APPROVED:
        raise BusinessRuleError("Only approved entries can be reopened.", code="invalid_status")
    if entry.invoice_line_id:
        raise BusinessRuleError("This time has been invoiced. Void the invoice or issue a credit note first.",
                                code="already_invoiced")
    previous = {"approved_by": entry.approved_by_id, "approved_at": entry.approved_at}
    entry.status = TimeEntry.Status.DRAFT
    entry.approved_at = None
    entry.approved_by = None
    entry.rejection_reason = f"Reopened for correction: {reason}"
    entry.save()
    log_activity(organization=membership.organization, actor=membership.user, verb="reopened_time", target=entry.project,
                 entry_id=entry.pk, reason=reason, previous=previous)
    notify(organization=membership.organization, recipients=[entry.user], kind="timesheet_rejected",
           title=f"{membership.user.full_name} reopened one of your approved entries", body=reason,
           link="/time?view=week", exclude=membership.user)
    return entry


def can_view_entry(membership: Membership, entry: TimeEntry) -> bool:
    if entry.organization_id != membership.organization_id:
        return False
    return entry.user_id == membership.user_id or membership.is_admin or can_manage_project(membership, entry.project)
