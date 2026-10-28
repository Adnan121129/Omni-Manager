import re
from decimal import Decimal

from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from apps.accounts.models import ADMIN_ROLES, Membership
from apps.core.activity import log_activity
from apps.core.exceptions import BusinessRuleError, ConflictError
from apps.core.notify import notify

from . import metrics
from .models import ChangeRequest, Deliverable, Milestone, Project, ProjectMember, Task, TaskDependency


def next_project_code(organization, client) -> str:
    letters = re.sub(r"[^A-Za-z0-9]", "", client.name).upper()[:4] or "PRJ"
    existing = set(Project.objects.filter(organization=organization, code__startswith=f"{letters}-")
                   .values_list("code", flat=True))
    n = len(existing) + 1
    while f"{letters}-{n:03d}" in existing:
        n += 1
    return f"{letters}-{n:03d}"


def next_task_number(project: Project) -> int:
    Project.objects.select_for_update(of=("self",)).filter(pk=project.pk).first()
    current = Task.objects.filter(project=project).aggregate(m=Max("number"))["m"] or 0
    return current + 1


def ensure_member(project: Project, user, actor=None) -> None:
    if user is None:
        return
    _, created = ProjectMember.objects.get_or_create(project=project, user=user)
    if created:
        log_activity(organization=project.organization, actor=actor, verb="added_member", target=project,
                     member=user.full_name)


def resolve_rates(*, organization, project: Project, task: Task | None, user) -> tuple[Decimal, Decimal]:
    """Billing rate precedence: task override > project member rate > project rate > member default > workspace default."""
    membership = Membership.objects.filter(organization=organization, user=user).first()
    cost_rate = membership.cost_rate if membership else Decimal("0")
    if task is not None and task.rate_override is not None:
        return task.rate_override, cost_rate
    member = ProjectMember.objects.filter(project=project, user=user).first()
    if member is not None and member.bill_rate is not None:
        return member.bill_rate, cost_rate
    if project.hourly_rate is not None:
        return project.hourly_rate, cost_rate
    if membership is not None and membership.default_bill_rate is not None:
        return membership.default_bill_rate, cost_rate
    return organization.default_bill_rate, cost_rate


def project_finance_recipients(project: Project):
    admins = [m.user for m in Membership.objects.filter(organization=project.organization, role__in=ADMIN_ROLES,
                                                        status=Membership.Status.ACTIVE).select_related("user")]
    return [project.manager, *admins]


def check_budget_thresholds(project: Project, actor=None) -> int:
    """Notifies once per crossed threshold (75/90/100%). Returns the current alert level."""
    project = Project.objects.select_related("organization", "manager").get(pk=project.pk)
    data = metrics.for_project(project)
    level = data["budget"]["alert_level"]
    if level > project.budget_alert_level:
        Project.objects.filter(pk=project.pk).update(budget_alert_level=level)
        used = data["budget"]["used_percent"]
        verb = "exceeded" if level >= 100 else "reached"
        notify(organization=project.organization, recipients=project_finance_recipients(project), kind="budget_threshold",
               title=f"{project.code} has {verb} {level}% of its budget",
               body=f"{project.name} is at {used}% of budget (fees {data['budget']['fees_percent'] or '-'}%, "
                    f"hours {data['budget']['hours_percent'] or '-'}%).",
               link=f"/projects/{project.pk}?tab=budget", dedupe_key=f"budget:{project.pk}:{level}:{project.budget_amount}:{project.budget_hours}")
        log_activity(organization=project.organization, actor=None, verb="budget_threshold", target=project,
                     level=level, used_percent=used)
    elif level < project.budget_alert_level:
        # Budget was increased (e.g. an applied change request): re-arm lower thresholds.
        Project.objects.filter(pk=project.pk).update(budget_alert_level=level)
    return level


def completion_blockers(project: Project) -> dict:
    open_tasks = Task.objects.filter(project=project).exclude(status__in=Task.CLOSED_STATUSES)
    open_milestones = Milestone.objects.filter(project=project).exclude(status=Milestone.Status.COMPLETED)
    pending_deliverables = Deliverable.objects.filter(project=project, status=Deliverable.Status.PENDING_APPROVAL)
    return {
        "open_tasks": [{"id": t.id, "title": t.title} for t in open_tasks[:20]],
        "open_tasks_count": open_tasks.count(),
        "open_milestones": [{"id": m.id, "name": m.name} for m in open_milestones],
        "pending_deliverables": [{"id": d.id, "title": d.title} for d in pending_deliverables],
    }


@transaction.atomic
def complete_project(*, project: Project, actor, force: bool = False, reason: str = "") -> Project:
    project = Project.objects.select_for_update(of=("self",)).get(pk=project.pk)
    if project.status in (Project.Status.COMPLETED, Project.Status.CANCELLED):
        raise BusinessRuleError(f"Project is already {project.get_status_display().lower()}.")
    blockers = completion_blockers(project)
    has_blockers = blockers["open_tasks_count"] or blockers["open_milestones"] or blockers["pending_deliverables"]
    if has_blockers and not force:
        raise ConflictError("The project still has open work. Review it or confirm completion with a reason.",
                            code="open_work", extra=blockers)
    if has_blockers and not reason.strip():
        raise BusinessRuleError("A reason is required to complete a project with open work.", code="reason_required")
    project.status = Project.Status.COMPLETED
    project.completed_at = timezone.now()
    project.save(update_fields=["status", "completed_at", "updated_at"])
    log_activity(organization=project.organization, actor=actor, verb="completed_project", target=project,
                 client_visible=True, forced=bool(has_blockers), reason=reason, open_tasks=blockers["open_tasks_count"])
    return project


def assert_no_cycle(task: Task, blocked_by: Task) -> None:
    if task.pk == blocked_by.pk:
        raise BusinessRuleError("A task cannot block itself.")
    if task.project_id != blocked_by.project_id:
        raise BusinessRuleError("Dependencies must be between tasks in the same project.")
    # Walk everything `blocked_by` depends on; if we reach `task`, adding the edge creates a cycle.
    frontier = [blocked_by.pk]
    seen = set()
    while frontier:
        current = frontier.pop()
        if current == task.pk:
            raise BusinessRuleError("This dependency would create a circular chain.", code="dependency_cycle")
        if current in seen:
            continue
        seen.add(current)
        frontier.extend(TaskDependency.objects.filter(task_id=current).values_list("blocked_by_id", flat=True))


def open_blockers(task: Task):
    return Task.objects.filter(blocking_links__task=task).exclude(status__in=Task.CLOSED_STATUSES)


def validate_status_change(task: Task, new_status: str) -> None:
    if new_status == Task.Status.DONE:
        blockers = list(open_blockers(task)[:5])
        if blockers:
            names = ", ".join(f"'{b.title}'" for b in blockers)
            raise BusinessRuleError(f"This task is blocked by {names}. Complete those first.", code="task_blocked")
        open_subtasks = task.subtasks.exclude(status__in=Task.CLOSED_STATUSES).count()
        if open_subtasks:
            raise BusinessRuleError(f"Complete or cancel the {open_subtasks} open subtask(s) first.", code="open_subtasks")


@transaction.atomic
def apply_change_request(*, change_request: ChangeRequest, actor) -> ChangeRequest:
    cr = ChangeRequest.objects.select_for_update(of=("self",)).select_related("project").get(pk=change_request.pk)
    if cr.status != ChangeRequest.Status.APPROVED:
        raise BusinessRuleError("Only client-approved change requests can be applied.", code="invalid_status")
    project = Project.objects.select_for_update(of=("self",)).get(pk=cr.project_id)
    before = {"budget_hours": str(project.budget_hours), "budget_amount": str(project.budget_amount),
              "deadline": project.deadline.isoformat() if project.deadline else None}
    project.budget_hours += cr.estimated_hours
    project.budget_amount += cr.estimated_cost
    if cr.revised_deadline:
        project.deadline = cr.revised_deadline
    project.save(update_fields=["budget_hours", "budget_amount", "deadline", "updated_at"])
    after = {"budget_hours": str(project.budget_hours), "budget_amount": str(project.budget_amount),
             "deadline": project.deadline.isoformat() if project.deadline else None}
    cr.status = ChangeRequest.Status.APPLIED
    cr.applied_at = timezone.now()
    cr.applied_by = actor
    cr.applied_snapshot = {"before": before, "after": after}
    cr.save(update_fields=["status", "applied_at", "applied_by", "applied_snapshot", "updated_at"])
    log_activity(organization=project.organization, actor=actor, verb="applied_change_request", target=cr,
                 project=project, client_visible=True, before=before, after=after)
    transaction.on_commit(lambda: check_budget_thresholds(project))
    return cr
