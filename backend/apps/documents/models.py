from decimal import Decimal

from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.models import OrgScopedModel


class DocumentKind(models.TextChoices):
    CONTRACT = "contract", "Contract"
    PROPOSAL = "proposal", "Proposal"


class ContractTemplate(OrgScopedModel):
    name = models.CharField(max_length=150)
    kind = models.CharField(max_length=10, choices=DocumentKind.choices, default=DocumentKind.CONTRACT)
    description = models.CharField(max_length=255, blank=True)
    body = models.TextField(help_text="Markdown with {{placeholders}}")
    default_payment_terms = models.TextField(blank=True)
    is_archived = models.BooleanField(default=False)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class Document(OrgScopedModel):
    """
    A client-facing contract or proposal. Content is frozen into a DocumentVersion (with a
    SHA-256 hash) each time it is sent; signatures reference the exact version they accepted.
    """

    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        SENT = "sent", "Sent"
        VIEWED = "viewed", "Viewed"
        SIGNED = "signed", "Signed"
        DECLINED = "declined", "Declined"
        EXPIRED = "expired", "Expired"

    AWAITING_STATUSES = [Status.SENT, Status.VIEWED]

    kind = models.CharField(max_length=10, choices=DocumentKind.choices, default=DocumentKind.CONTRACT)
    title = models.CharField(max_length=200)
    client = models.ForeignKey("crm.Client", on_delete=models.PROTECT, related_name="documents")
    project = models.ForeignKey("projects.Project", null=True, blank=True, on_delete=models.SET_NULL, related_name="documents")
    template = models.ForeignKey(ContractTemplate, null=True, blank=True, on_delete=models.SET_NULL, related_name="documents")
    body = models.TextField(help_text="Markdown; placeholders are resolved when the document is created")
    scope = models.TextField(blank=True)
    pricing_items = models.JSONField(default=list, blank=True, help_text="[{description, quantity, unit_price}]")
    total_amount = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    currency = models.CharField(max_length=3, default="USD")
    payment_terms = models.TextField(blank=True)
    milestones_summary = models.TextField(blank=True)
    expires_at = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT)
    current_version = models.PositiveIntegerField(default=0)
    signer = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+",
                               help_text="Client portal user expected to sign")
    sent_at = models.DateTimeField(null=True, blank=True)
    viewed_at = models.DateTimeField(null=True, blank=True)
    signed_at = models.DateTimeField(null=True, blank=True)
    declined_at = models.DateTimeField(null=True, blank=True)
    decline_reason = models.TextField(blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    esign_provider = models.CharField(max_length=30, default="builtin")

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["organization", "status"]), models.Index(fields=["organization", "client"])]

    def __str__(self):
        return self.title


class DocumentVersion(models.Model):
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="versions")
    version = models.PositiveIntegerField()
    rendered_html = models.TextField()
    content_hash = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        ordering = ["-version"]
        constraints = [models.UniqueConstraint(fields=["document", "version"], name="uniq_document_version")]


class SignatureRecord(models.Model):
    class Method(models.TextChoices):
        DRAWN = "drawn", "Drawn signature"
        TYPED = "typed", "Typed signature"

    document = models.ForeignKey(Document, on_delete=models.PROTECT, related_name="signatures")
    version = models.ForeignKey(DocumentVersion, on_delete=models.PROTECT, related_name="signatures")
    content_hash = models.CharField(max_length=64)
    signer = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    signer_name = models.CharField(max_length=150)
    signer_email = models.EmailField()
    signer_title = models.CharField(max_length=100, blank=True)
    method = models.CharField(max_length=10, choices=Method.choices)
    signature_image = models.TextField(blank=True, help_text="PNG data URL for drawn signatures")
    consent_text = models.TextField()
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=400, blank=True)
    signed_at = models.DateTimeField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["document", "version"], name="uniq_signature_per_version")]


class DocumentEvent(models.Model):
    """Hash-chained audit trail: each event's hash covers its payload and the previous hash."""

    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="events")
    sequence = models.PositiveIntegerField()
    event = models.CharField(max_length=30)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    actor_label = models.CharField(max_length=200, blank=True)
    version = models.PositiveIntegerField(default=0)
    details = models.JSONField(default=dict, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField()
    previous_hash = models.CharField(max_length=64, blank=True)
    hash = models.CharField(max_length=64)

    class Meta:
        ordering = ["sequence"]
        constraints = [
            models.UniqueConstraint(fields=["document", "sequence"], name="uniq_document_event_sequence"),
            models.CheckConstraint(condition=~Q(hash=""), name="document_event_hash_present"),
        ]
