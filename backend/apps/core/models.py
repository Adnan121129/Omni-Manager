import os
import uuid

from django.conf import settings
from django.contrib.contenttypes.fields import GenericForeignKey
from django.contrib.contenttypes.models import ContentType
from django.db import models


class OrgScopedModel(models.Model):
    """Base for every tenant-owned record. Every API query filters on `organization`."""

    organization = models.ForeignKey("accounts.Organization", on_delete=models.CASCADE, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class ActivityLog(models.Model):
    """Append-only audit trail of important actions."""

    organization = models.ForeignKey("accounts.Organization", on_delete=models.CASCADE, related_name="+")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL)
    verb = models.CharField(max_length=60)
    target_type = models.CharField(max_length=40)
    target_id = models.BigIntegerField(null=True, blank=True)
    target_label = models.CharField(max_length=255, blank=True)
    project = models.ForeignKey("projects.Project", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    client = models.ForeignKey("crm.Client", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    client_visible = models.BooleanField(default=False)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["organization", "-created_at"]),
            models.Index(fields=["organization", "target_type", "target_id"]),
        ]


class Notification(models.Model):
    organization = models.ForeignKey("accounts.Organization", on_delete=models.CASCADE, related_name="+")
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications")
    kind = models.CharField(max_length=40)
    title = models.CharField(max_length=200)
    body = models.TextField(blank=True)
    link = models.CharField(max_length=300, blank=True)
    dedupe_key = models.CharField(max_length=120, null=True, blank=True)
    read_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["recipient", "organization", "dedupe_key"],
                condition=models.Q(dedupe_key__isnull=False),
                name="uniq_notification_dedupe",
            )
        ]
        indexes = [models.Index(fields=["recipient", "organization", "read_at"])]


class Comment(models.Model):
    organization = models.ForeignKey("accounts.Organization", on_delete=models.CASCADE, related_name="+")
    content_type = models.ForeignKey(ContentType, on_delete=models.CASCADE)
    object_id = models.PositiveBigIntegerField()
    target = GenericForeignKey("content_type", "object_id")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    body = models.TextField()
    client_visible = models.BooleanField(default=False, help_text="Shown in the client portal")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at", "id"]
        indexes = [models.Index(fields=["organization", "content_type", "object_id"])]

    def __str__(self):
        return self.body[:80]


def attachment_upload_to(instance, filename):
    ext = os.path.splitext(filename)[1].lower()[:10]
    return f"org_{instance.organization_id}/attachments/{uuid.uuid4().hex}{ext}"


class Attachment(models.Model):
    organization = models.ForeignKey("accounts.Organization", on_delete=models.CASCADE, related_name="+")
    content_type = models.ForeignKey(ContentType, on_delete=models.CASCADE)
    object_id = models.PositiveBigIntegerField()
    target = GenericForeignKey("content_type", "object_id")
    file = models.FileField(upload_to=attachment_upload_to, max_length=255)
    original_name = models.CharField(max_length=255)
    content_type_header = models.CharField(max_length=120, blank=True)
    size = models.PositiveBigIntegerField(default=0)
    uploaded_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    client_visible = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["organization", "content_type", "object_id"])]

    def __str__(self):
        return self.original_name
