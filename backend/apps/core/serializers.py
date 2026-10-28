from django.contrib.contenttypes.models import ContentType
from rest_framework import serializers

from apps.accounts.models import STAFF_ROLES, Membership, User

from .models import ActivityLog, Attachment, Comment, Notification


class OrgPKField(serializers.PrimaryKeyRelatedField):
    """
    Primary-key field restricted to the requesting workspace. Supplying an id that
    belongs to another organization fails validation exactly like a non-existent id.
    """

    def get_queryset(self):
        qs = super().get_queryset()
        request = self.context.get("request")
        org = getattr(request, "org", None)
        if org is None:
            return qs.none()
        return qs.filter(organization=org)


class StaffUserField(serializers.PrimaryKeyRelatedField):
    """A user who is an active internal member of the requesting workspace."""

    def get_queryset(self):
        request = self.context.get("request")
        org = getattr(request, "org", None)
        if org is None:
            return User.objects.none()
        return User.objects.filter(
            memberships__organization=org,
            memberships__status=Membership.Status.ACTIVE,
            memberships__role__in=STAFF_ROLES,
        ).distinct()


class UserSummarySerializer(serializers.ModelSerializer):
    initials = serializers.CharField(read_only=True)

    class Meta:
        model = User
        fields = ["id", "full_name", "email", "initials"]


class ActivitySerializer(serializers.ModelSerializer):
    actor = UserSummarySerializer(read_only=True)

    class Meta:
        model = ActivityLog
        fields = ["id", "actor", "verb", "target_type", "target_id", "target_label", "project", "client",
                  "metadata", "created_at"]


class NotificationSerializer(serializers.ModelSerializer):
    is_read = serializers.SerializerMethodField()

    class Meta:
        model = Notification
        fields = ["id", "kind", "title", "body", "link", "is_read", "read_at", "created_at"]

    def get_is_read(self, obj):
        return obj.read_at is not None


class CommentSerializer(serializers.ModelSerializer):
    author = UserSummarySerializer(read_only=True)
    author_is_client = serializers.SerializerMethodField()

    class Meta:
        model = Comment
        fields = ["id", "author", "author_is_client", "body", "client_visible", "created_at", "updated_at"]
        read_only_fields = ["id", "author", "created_at", "updated_at"]

    def get_author_is_client(self, obj):
        clients = self.context.get("client_user_ids")
        return bool(clients and obj.author_id in clients)


class AttachmentSerializer(serializers.ModelSerializer):
    uploaded_by = UserSummarySerializer(read_only=True)
    download_url = serializers.SerializerMethodField()

    class Meta:
        model = Attachment
        fields = ["id", "original_name", "content_type_header", "size", "client_visible", "uploaded_by",
                  "created_at", "download_url"]

    def get_download_url(self, obj):
        prefix = self.context.get("download_prefix", "/api/files")
        return f"{prefix}/{obj.pk}/download/"


def content_type_for(model) -> ContentType:
    return ContentType.objects.get_for_model(model)
