from django.db import transaction
from django.db.models import Count, IntegerField, OuterRef, Prefetch, Q, Subquery, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response

from apps.accounts.models import Membership, Role
from apps.core.activity import log_activity
from apps.core.exceptions import BusinessRuleError
from apps.core.filters import apply_ordering, apply_search, csv_ints, parse_date
from apps.core.notify import notify
from apps.core.permissions import IsManager, IsStaff, StaffReadManagerWrite
from apps.core.views import OrgScopedViewSet
from apps.crm.services import portal_users

from . import metrics, services
from .access import assert_can_manage, assert_can_view, can_manage_project, visible_projects
from .models import ChangeRequest, Deliverable, Label, Milestone, Project, ProjectMember, Task, TaskDependency
from .serializers import (
    ChangeRequestSerializer,
    DeliverableSerializer,
    LabelSerializer,
    MilestoneSerializer,
    ProjectMemberSerializer,
    ProjectSerializer,
    TaskSerializer,
)


class ProjectViewSet(OrgScopedViewSet):
    serializer_class = ProjectSerializer

    def get_permissions(self):
        if self.action in ("create",):
            return [IsManager()]
        if self.action == "destroy":
            from apps.core.permissions import IsWorkspaceAdmin
            return [IsWorkspaceAdmin()]
        return [IsStaff()]

    def get_queryset(self):
        qs = visible_projects(self.request.membership).select_related("client", "manager")
        params = self.request.query_params
        status_param = params.get("status")
        if status_param == "open":
            qs = qs.filter(status__in=Project.OPEN_STATUSES)
        elif status_param:
            qs = qs.filter(status__in=status_param.split(","))
        if params.get("client"):
            qs = qs.filter(client_id__in=csv_ints(params["client"]))
        if params.get("manager"):
            qs = qs.filter(manager_id=params["manager"])
        if params.get("priority"):
            qs = qs.filter(priority__in=params["priority"].split(","))
        if params.get("type"):
            qs = qs.filter(project_type=params["type"])
        if params.get("deadline_before"):
            qs = qs.filter(deadline__lte=parse_date(params["deadline_before"], "deadline_before"))
        if params.get("deadline_after"):
            qs = qs.filter(deadline__gte=parse_date(params["deadline_after"], "deadline_after"))
        if params.get("mine") in ("1", "true"):
            user = self.request.user
            qs = qs.filter(Q(manager=user) | Q(members__user=user)).distinct()
        qs = apply_search(qs, self.request, ["name", "code", "client__name"])
        return apply_ordering(qs, self.request, {"name": "name", "deadline": "deadline", "created": "created_at",
                                                 "client": "client__name", "status": "status", "priority": "priority",
                                                 "code": "code"}, default="-created")

    def list(self, request, *args, **kwargs):
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        items = page if page is not None else list(queryset)
        context = {**self.get_serializer_context(), "metrics": metrics.collect([p.pk for p in items])}
        data = ProjectSerializer(items, many=True, context=context).data
        return self.get_paginated_response(data) if page is not None else Response(data)

    def retrieve(self, request, *args, **kwargs):
        project = self.get_object()
        context = {**self.get_serializer_context(), "metrics": metrics.collect([project.pk])}
        data = ProjectSerializer(project, context=context).data
        data["members"] = ProjectMemberSerializer(project.members.select_related("user"), many=True).data
        if not data["can_manage"]:
            for member in data["members"]:
                member.pop("bill_rate", None)
        if data["can_manage"]:
            data["retainer"] = metrics.retainer_usage(project)
        data["completion_blockers"] = services.completion_blockers(project) if project.status not in ("completed", "cancelled") else None
        return Response(data)

    @transaction.atomic
    def perform_create(self, serializer):
        org = self.request.org
        data = serializer.validated_data
        client = data["client"]
        manager = data.get("manager")
        if self.request.membership.role == "project_manager":
            manager = self.request.user  # project managers create projects they lead
        code = data.get("code") or services.next_project_code(org, client)
        project = serializer.save(organization=org, code=code, manager=manager or self.request.user,
                                  currency=data.get("currency") or client.currency)
        services.ensure_member(project, project.manager, self.request.user)
        log_activity(organization=org, actor=self.request.user, verb="created", target=project,
                     client_visible=project.client_visible)

    def perform_update(self, serializer):
        assert_can_manage(self.request.membership, serializer.instance)
        before = {f: getattr(serializer.instance, f) for f in ("status", "budget_amount", "budget_hours", "deadline", "manager_id")}
        project = serializer.save()
        changes = {f: [str(v), str(getattr(project, f))] for f, v in before.items() if getattr(project, f) != v}
        if project.manager_id:
            services.ensure_member(project, project.manager, self.request.user)
        log_activity(organization=project.organization, actor=self.request.user, verb="updated", target=project,
                     changes=changes)
        if "budget_amount" in changes or "budget_hours" in changes:
            services.check_budget_thresholds(project, self.request.user)

    def perform_destroy(self, instance):
        if instance.time_entries.exists() or instance.invoice_lines.exists() or instance.expenses.exists():
            raise BusinessRuleError("Projects with time, expenses or invoices cannot be deleted. Cancel or complete it instead.")
        log_activity(organization=instance.organization, actor=self.request.user, verb="deleted", target=instance)
        instance.delete()

    @action(detail=True, methods=["post"])
    def complete(self, request, pk=None):
        project = self.get_object()
        assert_can_manage(request.membership, project)
        project = services.complete_project(project=project, actor=request.user,
                                            force=bool(request.data.get("force")), reason=str(request.data.get("reason", "")))
        return Response(ProjectSerializer(project, context=self.get_serializer_context()).data)

    @action(detail=True, methods=["post"])
    def reopen(self, request, pk=None):
        project = self.get_object()
        assert_can_manage(request.membership, project)
        if project.status not in (Project.Status.COMPLETED, Project.Status.CANCELLED):
            raise BusinessRuleError("Only completed or cancelled projects can be reopened.")
        project.status = Project.Status.ACTIVE
        project.completed_at = None
        project.save(update_fields=["status", "completed_at", "updated_at"])
        log_activity(organization=project.organization, actor=request.user, verb="reopened_project", target=project)
        return Response(ProjectSerializer(project, context=self.get_serializer_context()).data)

    @action(detail=True, methods=["get", "post"])
    def members(self, request, pk=None):
        project = self.get_object()
        if request.method == "GET":
            data = ProjectMemberSerializer(project.members.select_related("user"), many=True).data
            if not can_manage_project(request.membership, project):
                for member in data:
                    member.pop("bill_rate", None)
            return Response(data)
        assert_can_manage(request.membership, project)
        from apps.core.serializers import StaffUserField
        field = StaffUserField()
        field.bind("user", None)
        field._context = {"request": request}
        try:
            user = field.to_internal_value(request.data.get("user"))
        except Exception:
            raise ValidationError({"user": ["Choose an active team member."]})
        member, _ = ProjectMember.objects.get_or_create(project=project, user=user)
        member.role = str(request.data.get("role", member.role))[:80]
        if "bill_rate" in request.data:
            rate = request.data.get("bill_rate")
            member.bill_rate = None if rate in (None, "") else rate
        member.save()
        log_activity(organization=project.organization, actor=request.user, verb="added_member", target=project,
                     member=user.full_name)
        return Response(ProjectMemberSerializer(member).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["delete"], url_path=r"members/(?P<user_id>\d+)")
    def remove_member(self, request, pk=None, user_id=None):
        project = self.get_object()
        assert_can_manage(request.membership, project)
        if int(user_id) == project.manager_id:
            raise BusinessRuleError("The project manager cannot be removed. Assign a different manager first.")
        deleted, _ = ProjectMember.objects.filter(project=project, user_id=user_id).delete()
        if not deleted:
            raise NotFound()
        log_activity(organization=project.organization, actor=request.user, verb="removed_member", target=project,
                     user_id=int(user_id))
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get"])
    def health(self, request, pk=None):
        project = self.get_object()
        data = metrics.for_project(project)
        if not can_manage_project(request.membership, project):
            data.pop("budget")
            data["health"] = metrics.redact_health(data["health"])
        elif not request.membership.has_billing_access:
            data["budget"].pop("collected", None)
        return Response(data)


def _check_assignee(membership, project, assignee) -> None:
    """Assigning a task must not be a back door onto the project: only its manager may assign someone new."""
    if assignee is None or assignee.pk == project.manager_id or project.members.filter(user=assignee).exists():
        return
    if Membership.objects.filter(organization=project.organization, user=assignee, status=Membership.Status.ACTIVE,
                                 role__in=(Role.OWNER, Role.ADMIN)).exists():
        return  # owners and admins already see every project
    if not can_manage_project(membership, project):
        raise ValidationError({"assignee": ["Only project members can be assigned. Ask the project manager to add them first."]})


def _task_queryset(membership):
    from apps.timetracking.models import TimeEntry

    tracked = (TimeEntry.objects.filter(task=OuterRef("pk")).exclude(status="rejected")
               .values("task").annotate(s=Sum("duration_seconds")).values("s"))
    subtasks = Task.objects.filter(parent=OuterRef("pk")).exclude(status="cancelled").values("parent").annotate(c=Count("id")).values("c")
    subtasks_done = Task.objects.filter(parent=OuterRef("pk"), status="done").values("parent").annotate(c=Count("id")).values("c")
    return (Task.objects.filter(project__in=visible_projects(membership))
            .select_related("project", "project__client", "assignee", "created_by")
            .prefetch_related("labels", Prefetch("blocked_by_links", queryset=TaskDependency.objects.select_related("blocked_by")))
            .annotate(tracked_seconds=Coalesce(Subquery(tracked, output_field=IntegerField()), Value(0)),
                      subtask_count=Coalesce(Subquery(subtasks, output_field=IntegerField()), Value(0)),
                      subtask_done=Coalesce(Subquery(subtasks_done, output_field=IntegerField()), Value(0))))


class TaskViewSet(OrgScopedViewSet):
    serializer_class = TaskSerializer

    def get_queryset(self):
        qs = _task_queryset(self.request.membership)
        params = self.request.query_params
        today = timezone.localdate()
        if params.get("project"):
            qs = qs.filter(project_id__in=csv_ints(params["project"]))
        if params.get("client"):
            qs = qs.filter(project__client_id=params["client"])
        if params.get("assignee") == "me":
            qs = qs.filter(assignee=self.request.user)
        elif params.get("assignee") == "none":
            qs = qs.filter(assignee__isnull=True)
        elif params.get("assignee"):
            qs = qs.filter(assignee_id__in=csv_ints(params["assignee"]))
        if params.get("status") == "open":
            qs = qs.exclude(status__in=Task.CLOSED_STATUSES)
        elif params.get("status"):
            qs = qs.filter(status__in=params["status"].split(","))
        if params.get("priority"):
            qs = qs.filter(priority__in=params["priority"].split(","))
        if params.get("label"):
            qs = qs.filter(labels__id=params["label"])
        if params.get("milestone"):
            qs = qs.filter(milestone_id=params["milestone"])
        if params.get("parent") == "none":
            qs = qs.filter(parent__isnull=True)
        elif params.get("parent"):
            qs = qs.filter(parent_id=params["parent"])
        if params.get("billable") in ("true", "false"):
            qs = qs.filter(billable=params["billable"] == "true")
        due = params.get("due")
        if due == "overdue":
            qs = qs.filter(due_date__lt=today).exclude(status__in=Task.CLOSED_STATUSES)
        elif due == "today":
            qs = qs.filter(due_date=today)
        elif due == "week":
            qs = qs.filter(due_date__gte=today, due_date__lte=today + timezone.timedelta(days=7))
        qs = apply_search(qs, self.request, ["title", "description", "project__code"])
        return apply_ordering(qs, self.request, {"due": "due_date", "priority": "priority", "created": "created_at",
                                                 "title": "title", "status": "status", "position": "position",
                                                 "updated": "updated_at"}, default="position")

    def paginate_queryset(self, queryset):
        if self.request.query_params.get("all") in ("1", "true"):
            self._all = True
            return None
        return super().paginate_queryset(queryset)

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        if getattr(self, "_all", False):
            response.data = response.data[:1000]
        return response

    @transaction.atomic
    def perform_create(self, serializer):
        project = serializer.validated_data["project"]
        if project.status in (Project.Status.COMPLETED, Project.Status.CANCELLED):
            raise BusinessRuleError("Reopen the project before adding tasks.")
        _check_assignee(self.request.membership, project, serializer.validated_data.get("assignee"))
        number = services.next_task_number(project)
        max_position = Task.objects.filter(project=project, status=serializer.validated_data.get("status", "todo")) \
            .order_by("-position").values_list("position", flat=True).first() or 0
        task = serializer.save(organization=self.request.org, created_by=self.request.user, number=number,
                               position=serializer.validated_data.get("position") or max_position + 1000)
        if task.status == Task.Status.DONE:
            task.completed_at = timezone.now()
            task.save(update_fields=["completed_at"])
        services.ensure_member(project, task.assignee, self.request.user)
        log_activity(organization=self.request.org, actor=self.request.user, verb="created", target=task)
        if task.assignee_id and task.assignee_id != self.request.user.id:
            notify(organization=self.request.org, recipients=[task.assignee], kind="task_assigned",
                   title=f"{self.request.user.full_name} assigned you {project.code}-{task.number}: {task.title}",
                   body=f"Project: {project.name}" + (f" · Due {task.due_date.isoformat()}" if task.due_date else ""),
                   link=f"/tasks?task={task.pk}")

    @transaction.atomic
    def perform_update(self, serializer):
        task = serializer.instance
        membership = self.request.membership
        assert_can_view(membership, task.project)
        new_status = serializer.validated_data.get("status", task.status)
        if new_status != task.status:
            services.validate_status_change(task, new_status)
        destination = serializer.validated_data.get("project", task.project)
        assignee = serializer.validated_data.get("assignee", task.assignee)
        if destination != task.project or assignee != task.assignee:
            # Checked against the project the task ends up in, which is where ensure_member adds the assignee.
            _check_assignee(membership, destination, assignee)
        before = {"status": task.status, "assignee_id": task.assignee_id, "due_date": task.due_date,
                  "priority": task.priority}
        task = serializer.save()
        if before["status"] != task.status:
            task.completed_at = timezone.now() if task.status == Task.Status.DONE else None
            task.save(update_fields=["completed_at"])
            log_activity(organization=task.organization, actor=self.request.user, verb="changed_status", target=task,
                         from_status=before["status"], to_status=task.status)
        if before["assignee_id"] != task.assignee_id:
            services.ensure_member(task.project, task.assignee, self.request.user)
            log_activity(organization=task.organization, actor=self.request.user, verb="reassigned", target=task,
                         assignee=task.assignee.full_name if task.assignee else None)
            if task.assignee_id and task.assignee_id != self.request.user.id:
                notify(organization=task.organization, recipients=[task.assignee], kind="task_assigned",
                       title=f"{self.request.user.full_name} assigned you {task.project.code}-{task.number}: {task.title}",
                       link=f"/tasks?task={task.pk}")
        other_changes = {k for k in serializer.validated_data if k not in ("status", "assignee", "position")}
        if other_changes:
            log_activity(organization=task.organization, actor=self.request.user, verb="updated", target=task,
                         fields=sorted(other_changes))

    def perform_destroy(self, instance):
        membership = self.request.membership
        if not (can_manage_project(membership, instance.project) or instance.created_by_id == self.request.user.id):
            raise PermissionDenied("Only the project manager or the task's creator can delete it.")
        if instance.time_entries.exists() or instance.subtasks.filter(time_entries__isnull=False).exists():
            raise BusinessRuleError("Tasks with tracked time cannot be deleted. Cancel the task instead.")
        log_activity(organization=instance.organization, actor=self.request.user, verb="deleted", target=instance)
        instance.delete()

    def retrieve(self, request, *args, **kwargs):
        task = self.get_object()
        data = self.get_serializer(task).data
        data["subtasks"] = TaskSerializer(self.get_queryset().filter(parent=task).order_by("position", "id"),
                                          many=True, context=self.get_serializer_context()).data
        data["blocking"] = [{"id": link.task_id, "title": link.task.title, "status": link.task.status}
                            for link in task.blocking_links.select_related("task")]
        return Response(data)

    @action(detail=True, methods=["post"])
    def dependencies(self, request, pk=None):
        task = self.get_object()
        blocked_by = Task.objects.filter(organization=request.org, pk=request.data.get("blocked_by")).first()
        if blocked_by is None:
            raise ValidationError({"blocked_by": ["Task not found."]})
        services.assert_no_cycle(task, blocked_by)
        TaskDependency.objects.get_or_create(task=task, blocked_by=blocked_by)
        log_activity(organization=request.org, actor=request.user, verb="added_dependency", target=task,
                     blocked_by=blocked_by.title)
        return Response(self.get_serializer(self.get_queryset().get(pk=task.pk)).data)

    @action(detail=True, methods=["delete"], url_path=r"dependencies/(?P<blocked_by_id>\d+)")
    def remove_dependency(self, request, pk=None, blocked_by_id=None):
        task = self.get_object()
        TaskDependency.objects.filter(task=task, blocked_by_id=blocked_by_id).delete()
        return Response(self.get_serializer(self.get_queryset().get(pk=task.pk)).data)


class LabelViewSet(OrgScopedViewSet):
    queryset = Label.objects.all()
    serializer_class = LabelSerializer
    permission_classes = [StaffReadManagerWrite]
    pagination_class = None


class ProjectChildViewSet(OrgScopedViewSet):
    """Shared behaviour for records that belong to a project (milestones, deliverables, change requests)."""

    def get_queryset(self):
        qs = super().get_queryset().filter(project__in=visible_projects(self.request.membership))
        if self.request.query_params.get("project"):
            qs = qs.filter(project_id=self.request.query_params["project"])
        return qs

    def _require_manage(self, project):
        assert_can_manage(self.request.membership, project)

    def perform_create(self, serializer):
        self._require_manage(serializer.validated_data["project"])
        obj = serializer.save(organization=self.request.org, **self.extra_create_fields())
        log_activity(organization=self.request.org, actor=self.request.user, verb="created", target=obj)

    def extra_create_fields(self):
        return {}

    def perform_update(self, serializer):
        self._require_manage(serializer.instance.project)
        if "project" in serializer.validated_data and serializer.validated_data["project"].pk != serializer.instance.project_id:
            raise ValidationError({"project": ["Records cannot move between projects."]})
        obj = serializer.save()
        log_activity(organization=self.request.org, actor=self.request.user, verb="updated", target=obj,
                     fields=sorted(serializer.validated_data.keys()))

    def perform_destroy(self, instance):
        self._require_manage(instance.project)
        log_activity(organization=self.request.org, actor=self.request.user, verb="deleted", target=instance)
        instance.delete()


class MilestoneViewSet(ProjectChildViewSet):
    queryset = Milestone.objects.select_related("project")
    serializer_class = MilestoneSerializer
    pagination_class = None

    def get_queryset(self):
        return super().get_queryset().annotate(
            task_count=Count("tasks", filter=~Q(tasks__status="cancelled"), distinct=True),
            task_done=Count("tasks", filter=Q(tasks__status="done"), distinct=True),
        )

    def perform_destroy(self, instance):
        if instance.invoice_line_id:
            raise BusinessRuleError("Invoiced milestones cannot be deleted.")
        super().perform_destroy(instance)

    @action(detail=True, methods=["post"])
    def complete(self, request, pk=None):
        milestone = self.get_object()
        self._require_manage(milestone.project)
        open_tasks = milestone.tasks.exclude(status__in=Task.CLOSED_STATUSES).count()
        if open_tasks and not request.data.get("force"):
            raise BusinessRuleError(f"{open_tasks} task(s) in this milestone are still open.", code="open_tasks",
                                    status_code=409)
        milestone.status = Milestone.Status.COMPLETED
        milestone.completed_at = timezone.now()
        milestone.save(update_fields=["status", "completed_at", "updated_at"])
        log_activity(organization=request.org, actor=request.user, verb="completed_milestone", target=milestone,
                     client_visible=milestone.client_visible, forced=bool(open_tasks))
        return Response(self.get_serializer(self.get_queryset().get(pk=milestone.pk)).data)

    @action(detail=True, methods=["post"])
    def reopen(self, request, pk=None):
        milestone = self.get_object()
        self._require_manage(milestone.project)
        if milestone.invoice_line_id:
            raise BusinessRuleError("This milestone has been invoiced and cannot be reopened.")
        milestone.status = Milestone.Status.IN_PROGRESS
        milestone.completed_at = None
        milestone.save(update_fields=["status", "completed_at", "updated_at"])
        log_activity(organization=request.org, actor=request.user, verb="reopened_milestone", target=milestone)
        return Response(self.get_serializer(self.get_queryset().get(pk=milestone.pk)).data)


class DeliverableViewSet(ProjectChildViewSet):
    queryset = Deliverable.objects.select_related("project", "milestone", "submitted_by", "decided_by")
    serializer_class = DeliverableSerializer
    pagination_class = None

    def _require_manage(self, project):
        # Any project member may prepare deliverables; approval is the client's decision.
        assert_can_view(self.request.membership, project)

    def perform_update(self, serializer):
        if serializer.instance.status == Deliverable.Status.APPROVED:
            raise BusinessRuleError("Approved deliverables cannot be edited.")
        super().perform_update(serializer)

    @action(detail=True, methods=["post"], url_path="submit")
    def submit_for_approval(self, request, pk=None):
        deliverable = self.get_object()
        assert_can_view(request.membership, deliverable.project)
        if deliverable.status not in (Deliverable.Status.DRAFT, Deliverable.Status.CHANGES_REQUESTED):
            raise BusinessRuleError("Only draft or revision-requested deliverables can be submitted.")
        project = deliverable.project
        if not project.client_visible:
            raise BusinessRuleError("Share the project with the client portal before requesting approval.")
        if deliverable.status == Deliverable.Status.CHANGES_REQUESTED:
            deliverable.revision += 1
        deliverable.status = Deliverable.Status.PENDING_APPROVAL
        deliverable.submitted_at = timezone.now()
        deliverable.submitted_by = request.user
        deliverable.decided_at = None
        deliverable.decision_comment = ""
        deliverable.save()
        log_activity(organization=request.org, actor=request.user, verb="submitted_deliverable", target=deliverable,
                     client_visible=True, revision=deliverable.revision)
        notify(organization=request.org, recipients=portal_users(project.client), kind="deliverable_submitted",
               title=f"Please review: {deliverable.title}",
               body=f"{project.name} · revision {deliverable.revision}", link=f"/portal/approvals")
        return Response(self.get_serializer(deliverable).data)

    @action(detail=True, methods=["post"])
    def withdraw(self, request, pk=None):
        deliverable = self.get_object()
        assert_can_view(request.membership, deliverable.project)
        if deliverable.status != Deliverable.Status.PENDING_APPROVAL:
            raise BusinessRuleError("Only deliverables awaiting approval can be withdrawn.")
        deliverable.status = Deliverable.Status.DRAFT
        deliverable.save(update_fields=["status", "updated_at"])
        log_activity(organization=request.org, actor=request.user, verb="withdrew_deliverable", target=deliverable)
        return Response(self.get_serializer(deliverable).data)


class ChangeRequestViewSet(ProjectChildViewSet):
    queryset = ChangeRequest.objects.select_related("project", "requested_by", "decided_by", "applied_by")
    serializer_class = ChangeRequestSerializer

    def _require_manage(self, project):
        assert_can_view(self.request.membership, project)

    def extra_create_fields(self):
        return {"requested_by": self.request.user}

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("status"):
            qs = qs.filter(status__in=self.request.query_params["status"].split(","))
        return qs

    def perform_update(self, serializer):
        if serializer.instance.status != ChangeRequest.Status.DRAFT:
            raise BusinessRuleError("Only draft change requests can be edited.")
        super().perform_update(serializer)

    def perform_destroy(self, instance):
        if instance.status not in (ChangeRequest.Status.DRAFT,):
            raise BusinessRuleError("Only draft change requests can be deleted.")
        super().perform_destroy(instance)

    @action(detail=True, methods=["post"])
    def send(self, request, pk=None):
        cr = self.get_object()
        assert_can_manage(request.membership, cr.project)
        if cr.status != ChangeRequest.Status.DRAFT:
            raise BusinessRuleError("Only draft change requests can be sent.")
        if not cr.project.client_visible:
            raise BusinessRuleError("Share the project with the client portal before sending change requests.")
        cr.status = ChangeRequest.Status.PENDING_CLIENT
        cr.sent_at = timezone.now()
        cr.save(update_fields=["status", "sent_at", "updated_at"])
        log_activity(organization=request.org, actor=request.user, verb="sent_change_request", target=cr, client_visible=True)
        notify(organization=request.org, recipients=portal_users(cr.project.client), kind="change_request_sent",
               title=f"Change request awaiting approval: {cr.title}",
               body=f"+{cr.estimated_hours}h · {cr.project.currency} {cr.estimated_cost}", link="/portal/approvals")
        return Response(self.get_serializer(cr).data)

    @action(detail=True, methods=["post"])
    def withdraw(self, request, pk=None):
        cr = self.get_object()
        assert_can_manage(request.membership, cr.project)
        if cr.status != ChangeRequest.Status.PENDING_CLIENT:
            raise BusinessRuleError("Only change requests awaiting the client can be withdrawn.")
        cr.status = ChangeRequest.Status.DRAFT
        cr.save(update_fields=["status", "updated_at"])
        log_activity(organization=request.org, actor=request.user, verb="withdrew_change_request", target=cr)
        return Response(self.get_serializer(cr).data)

    @action(detail=True, methods=["post"], url_path="record-decision")
    def record_decision(self, request, pk=None):
        """Records a decision the client communicated outside the portal (e.g. by email)."""
        cr = self.get_object()
        assert_can_manage(request.membership, cr.project)
        decision = request.data.get("decision")
        comment = str(request.data.get("comment", "")).strip()
        if decision not in ("approved", "rejected"):
            raise ValidationError({"decision": ["Choose approved or rejected."]})
        if not comment:
            raise ValidationError({"comment": ["Describe how the client communicated this decision."]})
        if cr.status not in (ChangeRequest.Status.DRAFT, ChangeRequest.Status.PENDING_CLIENT):
            raise BusinessRuleError("This change request has already been decided.")
        cr.status = decision
        cr.decided_at = timezone.now()
        cr.decided_by = request.user
        cr.decision_comment = f"Recorded on behalf of the client: {comment}"
        cr.save()
        log_activity(organization=request.org, actor=request.user, verb=f"recorded_change_request_{decision}",
                     target=cr, comment=comment)
        return Response(self.get_serializer(cr).data)

    @action(detail=True, methods=["post"])
    def apply(self, request, pk=None):
        cr = self.get_object()
        assert_can_manage(request.membership, cr.project)
        cr = services.apply_change_request(change_request=cr, actor=request.user)
        return Response(self.get_serializer(cr).data)
