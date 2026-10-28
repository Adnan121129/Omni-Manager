from rest_framework import serializers

from apps.core.money import SUPPORTED_CURRENCIES
from apps.core.serializers import OrgPKField, StaffUserField, UserSummarySerializer
from apps.crm.models import Client

from .access import can_manage_project, visible_projects
from .models import ChangeRequest, Deliverable, Label, Milestone, Project, ProjectMember, Task

PROJECT_FINANCIAL_FIELDS = ["budget_amount", "estimated_expenses", "hourly_rate", "retainer_amount", "billing_notes"]


class ProjectFinancialsMixin:
    """Drops `financial_fields` from the output unless the viewer can manage the record's project."""

    financial_fields: tuple[str, ...] = ()

    def _can_manage(self, project) -> bool:
        membership = getattr(self.context.get("request"), "membership", None)
        if membership is None:
            return False
        cache = self.context.setdefault("_can_manage_project", {})
        if project.pk not in cache:
            cache[project.pk] = can_manage_project(membership, project)
        return cache[project.pk]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if not self._can_manage(instance.project):
            for field in self.financial_fields:
                data.pop(field, None)
        return data


class ProjectMemberSerializer(serializers.ModelSerializer):
    user = UserSummarySerializer(read_only=True)

    class Meta:
        model = ProjectMember
        fields = ["id", "user", "role", "bill_rate", "added_at"]


class ProjectSerializer(serializers.ModelSerializer):
    client = OrgPKField(queryset=Client.objects.all())
    manager = StaffUserField(required=False, allow_null=True)
    client_name = serializers.CharField(source="client.name", read_only=True)
    manager_detail = UserSummarySerializer(source="manager", read_only=True)
    code = serializers.CharField(max_length=20, required=False, allow_blank=True)
    can_manage = serializers.SerializerMethodField()

    class Meta:
        model = Project
        fields = ["id", "code", "name", "description", "client", "client_name", "manager", "manager_detail", "status",
                  "priority", "start_date", "deadline", "completed_at", "project_type", "currency", "budget_amount",
                  "budget_hours", "estimated_expenses", "hourly_rate", "retainer_amount", "retainer_hours",
                  "billing_notes", "client_visible", "color", "created_at", "updated_at", "can_manage"]
        read_only_fields = ["id", "completed_at", "created_at", "updated_at"]

    def get_can_manage(self, obj):
        membership = getattr(self.context.get("request"), "membership", None)
        return bool(membership and can_manage_project(membership, obj))

    def validate_code(self, value):
        value = (value or "").strip().upper()
        if not value:
            return value
        import re
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9-]{1,19}", value):
            raise serializers.ValidationError("Use 2-20 letters, digits or dashes.")
        qs = Project.objects.filter(organization=self.context["request"].org, code=value)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("This project code is already in use.")
        return value

    def validate_currency(self, value):
        if value not in SUPPORTED_CURRENCIES:
            raise serializers.ValidationError("Unsupported currency.")
        if self.instance and value != self.instance.currency and self.instance.invoice_lines.exists():
            raise serializers.ValidationError("Currency cannot change after the project has been invoiced.")
        return value

    def validate_status(self, value):
        if value == Project.Status.COMPLETED and (self.instance is None or self.instance.status != Project.Status.COMPLETED):
            raise serializers.ValidationError("Use the 'Mark complete' action to confirm project completion.")
        return value

    def validate(self, attrs):
        if self.instance is not None and "client" in attrs and attrs["client"].pk != self.instance.client_id:
            # Portal comments, files and activity belong to the original client; moving them would expose them.
            raise serializers.ValidationError({"client": ["A project's client cannot be changed. Create a new project instead."]})
        start = attrs.get("start_date", getattr(self.instance, "start_date", None))
        deadline = attrs.get("deadline", getattr(self.instance, "deadline", None))
        if start and deadline and deadline < start:
            raise serializers.ValidationError({"deadline": ["Deadline must be on or after the start date."]})
        for field in ("budget_amount", "budget_hours", "estimated_expenses", "retainer_amount", "retainer_hours", "hourly_rate"):
            value = attrs.get(field)
            if value is not None and value < 0:
                raise serializers.ValidationError({field: ["Must be zero or more."]})
        membership = self.context["request"].membership
        if self.instance is not None and not can_manage_project(membership, self.instance):
            for field in PROJECT_FINANCIAL_FIELDS:
                attrs.pop(field, None)
        return attrs

    def to_representation(self, instance):
        data = super().to_representation(instance)
        membership = getattr(self.context.get("request"), "membership", None)
        if membership is None or not can_manage_project(membership, instance):
            for field in PROJECT_FINANCIAL_FIELDS:
                data.pop(field, None)
        metrics_map = self.context.get("metrics")
        if metrics_map is not None and instance.pk in metrics_map:
            from . import metrics
            computed = metrics.full(instance, metrics_map[instance.pk])
            data["progress"] = computed["progress"]
            data["health"] = computed["health"] if data["can_manage"] else metrics.redact_health(computed["health"])
            if data["can_manage"]:
                data["budget"] = dict(computed["budget"])
                if not membership.has_billing_access:
                    data["budget"].pop("collected", None)
            else:
                b = computed["budget"]
                data["budget"] = {k: b[k] for k in ("hours_tracked", "hours_budget", "hours_percent", "hours_billable")}
        return data


class LabelSerializer(serializers.ModelSerializer):
    class Meta:
        model = Label
        fields = ["id", "name", "color"]

    def validate_name(self, value):
        qs = Label.objects.filter(organization=self.context["request"].org, name__iexact=value.strip())
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("A label with this name exists.")
        return value.strip()


class VisibleProjectField(serializers.PrimaryKeyRelatedField):
    def get_queryset(self):
        request = self.context.get("request")
        membership = getattr(request, "membership", None)
        if membership is None:
            return Project.objects.none()
        return visible_projects(membership)


class TaskSerializer(serializers.ModelSerializer):
    project = VisibleProjectField()
    parent = OrgPKField(queryset=Task.objects.all(), required=False, allow_null=True)
    milestone = OrgPKField(queryset=Milestone.objects.all(), required=False, allow_null=True)
    assignee = StaffUserField(required=False, allow_null=True)
    labels = OrgPKField(queryset=Label.objects.all(), many=True, required=False)
    assignee_detail = UserSummarySerializer(source="assignee", read_only=True)
    created_by_detail = UserSummarySerializer(source="created_by", read_only=True)
    label_details = LabelSerializer(source="labels", many=True, read_only=True)
    project_code = serializers.CharField(source="project.code", read_only=True)
    project_name = serializers.CharField(source="project.name", read_only=True)
    client_name = serializers.CharField(source="project.client.name", read_only=True)
    key = serializers.SerializerMethodField()
    tracked_seconds = serializers.IntegerField(read_only=True, default=0)
    subtask_count = serializers.IntegerField(read_only=True, default=0)
    subtask_done = serializers.IntegerField(read_only=True, default=0)
    blocked_by = serializers.SerializerMethodField()
    is_blocked = serializers.SerializerMethodField()

    class Meta:
        model = Task
        fields = ["id", "key", "number", "project", "project_code", "project_name", "client_name", "parent",
                  "milestone", "title", "description", "status", "priority", "assignee", "assignee_detail",
                  "created_by_detail", "start_date", "due_date", "estimated_hours", "billable", "rate_override",
                  "labels", "label_details", "reference_url", "position", "completed_at", "created_at", "updated_at",
                  "tracked_seconds", "subtask_count", "subtask_done", "blocked_by", "is_blocked"]
        read_only_fields = ["id", "number", "completed_at", "created_at", "updated_at"]

    def get_key(self, obj):
        return f"{obj.project.code}-{obj.number}"

    def _blockers(self, obj):
        cache = self.context.setdefault("_blockers", {})
        if obj.pk not in cache:
            cache[obj.pk] = [
                {"id": link.blocked_by_id, "title": link.blocked_by.title, "status": link.blocked_by.status}
                for link in obj.blocked_by_links.all()
            ]
        return cache[obj.pk]

    def get_blocked_by(self, obj):
        return self._blockers(obj)

    def get_is_blocked(self, obj):
        return any(b["status"] not in Task.CLOSED_STATUSES for b in self._blockers(obj))

    def validate(self, attrs):
        project = attrs.get("project", getattr(self.instance, "project", None))
        parent = attrs.get("parent", getattr(self.instance, "parent", None))
        milestone = attrs.get("milestone", getattr(self.instance, "milestone", None))
        if self.instance is not None and "project" in attrs and attrs["project"].pk != self.instance.project_id:
            if self.instance.time_entries.exists():
                raise serializers.ValidationError({"project": ["Tasks with tracked time cannot move to another project."]})
        if parent is not None:
            if parent.project_id != project.pk:
                raise serializers.ValidationError({"parent": ["The parent task must be in the same project."]})
            if self.instance is not None and parent.pk == self.instance.pk:
                raise serializers.ValidationError({"parent": ["A task cannot be its own parent."]})
            if parent.parent_id is not None:
                raise serializers.ValidationError({"parent": ["Subtasks can only be one level deep."]})
        if milestone is not None and milestone.project_id != project.pk:
            raise serializers.ValidationError({"milestone": ["The milestone must belong to the same project."]})
        start, due = attrs.get("start_date", getattr(self.instance, "start_date", None)), attrs.get("due_date", getattr(self.instance, "due_date", None))
        if start and due and due < start:
            raise serializers.ValidationError({"due_date": ["Due date must be on or after the start date."]})
        membership = self.context["request"].membership
        if "rate_override" in attrs and not can_manage_project(membership, project):
            attrs.pop("rate_override")
        if attrs.get("estimated_hours") is not None and attrs["estimated_hours"] < 0:
            raise serializers.ValidationError({"estimated_hours": ["Must be zero or more."]})
        return attrs

    def to_representation(self, instance):
        data = super().to_representation(instance)
        membership = getattr(self.context.get("request"), "membership", None)
        if membership is None or not can_manage_project(membership, instance.project):
            data.pop("rate_override", None)
        return data


class MilestoneSerializer(ProjectFinancialsMixin, serializers.ModelSerializer):
    financial_fields = ("amount",)

    project = VisibleProjectField()
    task_count = serializers.IntegerField(read_only=True, default=0)
    task_done = serializers.IntegerField(read_only=True, default=0)
    is_invoiced = serializers.SerializerMethodField()

    class Meta:
        model = Milestone
        fields = ["id", "project", "name", "description", "due_date", "status", "completed_at", "amount",
                  "client_visible", "position", "task_count", "task_done", "is_invoiced", "created_at"]
        read_only_fields = ["id", "completed_at", "created_at"]

    def get_is_invoiced(self, obj):
        return obj.invoice_line_id is not None

    def validate_amount(self, value):
        if value < 0:
            raise serializers.ValidationError("Must be zero or more.")
        if self.instance and self.instance.invoice_line_id and value != self.instance.amount:
            raise serializers.ValidationError("The amount of an invoiced milestone cannot change.")
        return value


class DeliverableSerializer(serializers.ModelSerializer):
    project = VisibleProjectField()
    milestone = OrgPKField(queryset=Milestone.objects.all(), required=False, allow_null=True)
    submitted_by_detail = UserSummarySerializer(source="submitted_by", read_only=True)
    decided_by_detail = UserSummarySerializer(source="decided_by", read_only=True)
    milestone_name = serializers.CharField(source="milestone.name", read_only=True, default=None)

    class Meta:
        model = Deliverable
        fields = ["id", "project", "milestone", "milestone_name", "title", "description", "status", "due_date",
                  "revision", "submitted_at", "submitted_by_detail", "decided_at", "decided_by_detail",
                  "decision_comment", "created_at", "updated_at"]
        read_only_fields = ["id", "status", "revision", "submitted_at", "decided_at", "decision_comment", "created_at",
                            "updated_at"]

    def validate(self, attrs):
        project = attrs.get("project", getattr(self.instance, "project", None))
        milestone = attrs.get("milestone")
        if milestone is not None and milestone.project_id != project.pk:
            raise serializers.ValidationError({"milestone": ["The milestone must belong to the same project."]})
        return attrs


class ChangeRequestSerializer(ProjectFinancialsMixin, serializers.ModelSerializer):
    # Non-managers keep the hours/deadline part of the applied snapshot, without money (see to_representation).

    project = VisibleProjectField()
    requested_by_detail = UserSummarySerializer(source="requested_by", read_only=True)
    decided_by_detail = UserSummarySerializer(source="decided_by", read_only=True)
    applied_by_detail = UserSummarySerializer(source="applied_by", read_only=True)
    project_code = serializers.CharField(source="project.code", read_only=True)
    currency = serializers.CharField(source="project.currency", read_only=True)

    class Meta:
        model = ChangeRequest
        fields = ["id", "project", "project_code", "currency", "title", "description", "estimated_hours",
                  "estimated_cost", "revised_deadline", "status", "requested_by_detail", "sent_at", "decided_at",
                  "decided_by_detail", "decision_comment", "applied_at", "applied_by_detail", "applied_snapshot",
                  "created_at"]
        read_only_fields = ["id", "status", "sent_at", "decided_at", "decision_comment", "applied_at",
                            "applied_snapshot", "created_at"]

    def validate(self, attrs):
        for field in ("estimated_hours", "estimated_cost"):
            if attrs.get(field) is not None and attrs[field] < 0:
                raise serializers.ValidationError({field: ["Must be zero or more."]})
        return attrs

    def to_representation(self, instance):
        from apps.core.activity import _strip_money

        data = super().to_representation(instance)
        if data.get("applied_snapshot") and not self._can_manage(instance.project):
            data["applied_snapshot"] = _strip_money(data["applied_snapshot"])
        return data

