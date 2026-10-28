from rest_framework import serializers

from apps.core.money import SUPPORTED_CURRENCIES
from apps.core.serializers import OrgPKField, StaffUserField, UserSummarySerializer

from .models import Client, Interaction, Lead


class ClientSerializer(serializers.ModelSerializer):
    owner = StaffUserField(required=False, allow_null=True)
    owner_detail = UserSummarySerializer(source="owner", read_only=True)
    active_projects = serializers.IntegerField(read_only=True, default=0)
    outstanding = serializers.DecimalField(max_digits=14, decimal_places=2, read_only=True, default=None)
    portal_users = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Client
        fields = ["id", "name", "contact_name", "email", "phone", "website", "industry", "billing_email", "tax_id",
                  "address_line1", "address_line2", "city", "state", "postal_code", "country", "currency",
                  "payment_terms_days", "status", "notes", "owner", "owner_detail", "archived_at", "created_at",
                  "updated_at", "active_projects", "outstanding", "portal_users"]
        read_only_fields = ["id", "archived_at", "created_at", "updated_at"]

    def validate_currency(self, value):
        if value not in SUPPORTED_CURRENCIES:
            raise serializers.ValidationError("Unsupported currency.")
        return value

    def validate_name(self, value):
        value = value.strip()
        request = self.context["request"]
        qs = Client.objects.filter(organization=request.org, name__iexact=value).exclude(status=Client.Status.ARCHIVED)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("A client with this name already exists.")
        return value

    def to_representation(self, instance):
        data = super().to_representation(instance)
        membership = getattr(self.context.get("request"), "membership", None)
        if membership is None or not membership.has_billing_access:
            data.pop("outstanding", None)
        return data


class LeadSerializer(serializers.ModelSerializer):
    owner = StaffUserField(required=False, allow_null=True)
    owner_detail = UserSummarySerializer(source="owner", read_only=True)
    converted_client_name = serializers.CharField(source="converted_client.name", read_only=True, default=None)

    class Meta:
        model = Lead
        fields = ["id", "title", "company", "contact_name", "email", "phone", "source", "stage", "value", "currency",
                  "expected_close_date", "next_follow_up", "notes", "owner", "owner_detail", "position",
                  "converted_client", "converted_client_name", "converted_at", "lost_reason", "created_at", "updated_at"]
        read_only_fields = ["id", "converted_client", "converted_at", "created_at", "updated_at"]

    def validate_value(self, value):
        if value < 0:
            raise serializers.ValidationError("Deal value cannot be negative.")
        return value

    def validate_currency(self, value):
        if value not in SUPPORTED_CURRENCIES:
            raise serializers.ValidationError("Unsupported currency.")
        return value

    def validate_stage(self, value):
        if value == Lead.Stage.WON and (self.instance is None or self.instance.converted_client_id is None):
            raise serializers.ValidationError("Use 'Convert to client' to mark a lead as won.")
        return value


class InteractionSerializer(serializers.ModelSerializer):
    client = OrgPKField(queryset=Client.objects.all(), required=False, allow_null=True)
    lead = OrgPKField(queryset=Lead.objects.all(), required=False, allow_null=True)
    author = UserSummarySerializer(read_only=True)

    class Meta:
        model = Interaction
        fields = ["id", "client", "lead", "kind", "summary", "occurred_at", "follow_up_date", "follow_up_done",
                  "author", "created_at"]
        read_only_fields = ["id", "author", "created_at"]

    def validate(self, attrs):
        client = attrs.get("client", getattr(self.instance, "client", None))
        lead = attrs.get("lead", getattr(self.instance, "lead", None))
        if client is None and lead is None:
            raise serializers.ValidationError("An interaction must belong to a client or a lead.")
        return attrs
