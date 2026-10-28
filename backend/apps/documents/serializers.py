from rest_framework import serializers

from apps.core.exceptions import BusinessRuleError
from apps.core.money import SUPPORTED_CURRENCIES
from apps.core.serializers import OrgPKField
from apps.crm.models import Client
from apps.projects.models import Project

from .models import ContractTemplate, Document, DocumentEvent, DocumentVersion, SignatureRecord
from .services import validate_pricing_items


class ContractTemplateSerializer(serializers.ModelSerializer):
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)
    usage_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = ContractTemplate
        fields = ["id", "name", "kind", "description", "body", "default_payment_terms", "is_archived",
                  "created_by_name", "usage_count", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class SignatureSerializer(serializers.ModelSerializer):
    version_number = serializers.IntegerField(source="version.version", read_only=True)

    class Meta:
        model = SignatureRecord
        fields = ["id", "version_number", "content_hash", "signer_name", "signer_email", "signer_title", "method",
                  "signature_image", "consent_text", "ip_address", "user_agent", "signed_at"]


class EventSerializer(serializers.ModelSerializer):
    class Meta:
        model = DocumentEvent
        fields = ["sequence", "event", "actor_label", "version", "details", "ip_address", "created_at",
                  "previous_hash", "hash"]


class VersionSerializer(serializers.ModelSerializer):
    class Meta:
        model = DocumentVersion
        fields = ["version", "content_hash", "created_at"]


class DocumentSerializer(serializers.ModelSerializer):
    client = OrgPKField(queryset=Client.objects.all())
    project = OrgPKField(queryset=Project.objects.all(), required=False, allow_null=True)
    template = OrgPKField(queryset=ContractTemplate.objects.all(), required=False, allow_null=True)
    client_name = serializers.CharField(source="client.name", read_only=True)
    project_code = serializers.CharField(source="project.code", read_only=True, default=None)
    signer_name = serializers.CharField(source="signer.full_name", read_only=True, default=None)
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)
    body = serializers.CharField(required=False, allow_blank=True)

    class Meta:
        model = Document
        fields = ["id", "kind", "title", "client", "client_name", "project", "project_code", "template", "body",
                  "scope", "pricing_items", "total_amount", "currency", "payment_terms", "milestones_summary",
                  "expires_at", "status", "current_version", "signer", "signer_name", "sent_at", "viewed_at",
                  "signed_at", "declined_at", "decline_reason", "created_by_name", "esign_provider", "created_at",
                  "updated_at"]
        read_only_fields = ["id", "total_amount", "status", "current_version", "signer", "sent_at", "viewed_at",
                            "signed_at", "declined_at", "decline_reason", "esign_provider", "created_at", "updated_at"]

    def validate_pricing_items(self, value):
        try:
            return validate_pricing_items(value)
        except BusinessRuleError as exc:
            raise serializers.ValidationError(str(exc.detail))

    def validate_currency(self, value):
        value = value.upper()
        if value not in SUPPORTED_CURRENCIES:
            raise serializers.ValidationError("Unsupported currency.")
        return value

    def validate(self, attrs):
        client = attrs.get("client", getattr(self.instance, "client", None))
        project = attrs.get("project", getattr(self.instance, "project", None))
        if project is not None and project.client_id != client.pk:
            raise serializers.ValidationError({"project": ["The project must belong to the selected client."]})
        template = attrs.get("template")
        if self.instance is None:
            if not attrs.get("body") and template is None:
                raise serializers.ValidationError({"body": ["Choose a template or write the document body."]})
        return attrs
