from rest_framework import serializers

from apps.core.serializers import OrgPKField, UserSummarySerializer
from apps.projects.access import can_manage_project
from apps.projects.models import Task
from apps.projects.serializers import VisibleProjectField

from .models import TimeEntry
from .services import elapsed_seconds


class TimeEntrySerializer(serializers.ModelSerializer):
    user = UserSummarySerializer(read_only=True)
    project_detail = serializers.SerializerMethodField()
    task_detail = serializers.SerializerMethodField()
    approved_by_name = serializers.CharField(source="approved_by.full_name", read_only=True, default=None)
    rejected_by_name = serializers.CharField(source="rejected_by.full_name", read_only=True, default=None)
    elapsed_seconds = serializers.SerializerMethodField()
    is_invoiced = serializers.BooleanField(read_only=True)
    billing_status = serializers.SerializerMethodField()
    amount = serializers.SerializerMethodField()
    can_edit = serializers.SerializerMethodField()

    class Meta:
        model = TimeEntry
        fields = ["id", "user", "project", "project_detail", "task", "task_detail", "description", "date",
                  "started_at", "ended_at", "duration_seconds", "elapsed_seconds", "source", "timer_state",
                  "accumulated_seconds", "segment_started_at", "billable", "bill_rate", "amount", "status",
                  "submitted_at", "approved_at", "approved_by_name", "rejected_by_name", "rejection_reason",
                  "is_invoiced", "billing_status", "can_edit", "created_at", "updated_at"]

    def get_project_detail(self, obj):
        p = obj.project
        return {"id": p.id, "code": p.code, "name": p.name, "client_id": p.client_id,
                "client_name": p.client.name if hasattr(p, "client") else None, "color": p.color,
                "currency": p.currency}

    def get_task_detail(self, obj):
        if obj.task_id is None:
            return None
        return {"id": obj.task_id, "title": obj.task.title, "key": f"{obj.project.code}-{obj.task.number}"}

    def get_elapsed_seconds(self, obj):
        return elapsed_seconds(obj) if obj.is_active_timer else obj.duration_seconds

    def get_billing_status(self, obj):
        if not obj.billable:
            return "non_billable"
        return "invoiced" if obj.invoice_line_id else "unbilled"

    def _can_see_money(self, obj):
        request = self.context.get("request")
        membership = getattr(request, "membership", None)
        if membership is None:
            return False
        cache = self.context.setdefault("_money_projects", {})
        if obj.project_id not in cache:
            cache[obj.project_id] = membership.has_billing_access or can_manage_project(membership, obj.project)
        return cache[obj.project_id]

    def get_amount(self, obj):
        return str(obj.billable_amount) if self._can_see_money(obj) else None

    def get_can_edit(self, obj):
        request = self.context.get("request")
        return bool(request and obj.user_id == request.user.id and obj.status in TimeEntry.EDITABLE_STATUSES
                    and not obj.is_active_timer)

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if not self._can_see_money(instance):
            data.pop("bill_rate", None)
        return data


class TimeEntryWriteSerializer(serializers.Serializer):
    project = VisibleProjectField()
    task = OrgPKField(queryset=Task.objects.all(), required=False, allow_null=True)
    description = serializers.CharField(max_length=500, required=False, allow_blank=True)
    date = serializers.DateField()
    duration_seconds = serializers.IntegerField(required=False, min_value=1, max_value=24 * 3600)
    started_at = serializers.DateTimeField(required=False, allow_null=True)
    ended_at = serializers.DateTimeField(required=False, allow_null=True)
    billable = serializers.BooleanField(required=False, allow_null=True, default=None)
    client_request_id = serializers.CharField(max_length=64, required=False, allow_blank=True)

    def validate(self, attrs):
        if self.partial:
            return attrs
        if not attrs.get("duration_seconds") and not (attrs.get("started_at") and attrs.get("ended_at")):
            raise serializers.ValidationError({"duration_seconds": ["Enter a duration or a start and end time."]})
        return attrs


class TimerStartSerializer(serializers.Serializer):
    project = VisibleProjectField()
    task = OrgPKField(queryset=Task.objects.all(), required=False, allow_null=True)
    description = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")
    billable = serializers.BooleanField(required=False, allow_null=True, default=None)
    request_id = serializers.CharField(max_length=64, required=False, allow_blank=True)
    switch = serializers.BooleanField(required=False, default=False)


class TimerUpdateSerializer(serializers.Serializer):
    project = VisibleProjectField(required=False)
    task = OrgPKField(queryset=Task.objects.all(), required=False, allow_null=True)
    description = serializers.CharField(max_length=500, required=False, allow_blank=True)
    billable = serializers.BooleanField(required=False)
