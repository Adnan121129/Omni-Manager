from decimal import Decimal

from django.conf import settings
from django.db import models

from apps.core.models import OrgScopedModel


class Client(OrgScopedModel):
    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        INACTIVE = "inactive", "Inactive"
        ARCHIVED = "archived", "Archived"

    name = models.CharField(max_length=200, help_text="Company or client name")
    contact_name = models.CharField(max_length=150, blank=True)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=40, blank=True)
    website = models.CharField(max_length=200, blank=True)
    industry = models.CharField(max_length=80, blank=True)
    billing_email = models.EmailField(blank=True)
    tax_id = models.CharField(max_length=60, blank=True)
    address_line1 = models.CharField(max_length=200, blank=True)
    address_line2 = models.CharField(max_length=200, blank=True)
    city = models.CharField(max_length=100, blank=True)
    state = models.CharField(max_length=100, blank=True)
    postal_code = models.CharField(max_length=20, blank=True)
    country = models.CharField(max_length=100, blank=True)
    currency = models.CharField(max_length=3, default="USD")
    payment_terms_days = models.PositiveSmallIntegerField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.ACTIVE)
    notes = models.TextField(blank=True, help_text="Internal notes - never shown to the client")
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    archived_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["name"]
        indexes = [models.Index(fields=["organization", "status"]), models.Index(fields=["organization", "name"])]

    def __str__(self):
        return self.name

    @property
    def billing_address(self) -> str:
        city_line = " ".join(p for p in [self.city, self.state, self.postal_code] if p)
        return "\n".join(p for p in [self.address_line1, self.address_line2, city_line, self.country] if p)


class Lead(OrgScopedModel):
    class Stage(models.TextChoices):
        NEW = "new", "New inquiry"
        CONTACTED = "contacted", "Contacted"
        QUALIFIED = "qualified", "Qualified"
        PROPOSAL = "proposal", "Proposal sent"
        WON = "won", "Won"
        LOST = "lost", "Lost"

    OPEN_STAGES = [Stage.NEW, Stage.CONTACTED, Stage.QUALIFIED, Stage.PROPOSAL]

    title = models.CharField(max_length=200, help_text="Opportunity, e.g. 'Website redesign'")
    company = models.CharField(max_length=200)
    contact_name = models.CharField(max_length=150, blank=True)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=40, blank=True)
    source = models.CharField(max_length=60, blank=True)
    stage = models.CharField(max_length=20, choices=Stage.choices, default=Stage.NEW)
    value = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0"))
    currency = models.CharField(max_length=3, default="USD")
    expected_close_date = models.DateField(null=True, blank=True)
    next_follow_up = models.DateField(null=True, blank=True)
    notes = models.TextField(blank=True)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    position = models.PositiveIntegerField(default=0)
    converted_client = models.ForeignKey(Client, null=True, blank=True, on_delete=models.SET_NULL, related_name="leads")
    converted_at = models.DateTimeField(null=True, blank=True)
    lost_reason = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["position", "-created_at"]
        indexes = [models.Index(fields=["organization", "stage"])]

    def __str__(self):
        return f"{self.title} ({self.company})"


class Interaction(OrgScopedModel):
    class Kind(models.TextChoices):
        NOTE = "note", "Note"
        CALL = "call", "Call"
        EMAIL = "email", "Email"
        MEETING = "meeting", "Meeting"

    client = models.ForeignKey(Client, null=True, blank=True, on_delete=models.CASCADE, related_name="interactions")
    lead = models.ForeignKey(Lead, null=True, blank=True, on_delete=models.CASCADE, related_name="interactions")
    kind = models.CharField(max_length=20, choices=Kind.choices, default=Kind.NOTE)
    summary = models.TextField()
    occurred_at = models.DateTimeField()
    follow_up_date = models.DateField(null=True, blank=True)
    follow_up_done = models.BooleanField(default=False)
    author = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        ordering = ["-occurred_at", "-id"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(client__isnull=False) | models.Q(lead__isnull=False),
                name="interaction_has_subject",
            )
        ]

    def __str__(self):
        return self.summary[:80]
