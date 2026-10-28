from decimal import ROUND_HALF_UP, Decimal

from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.models import OrgScopedModel


class TimeEntry(OrgScopedModel):
    """
    A block of work. Timer entries carry server-side timestamps: elapsed time is always
    `accumulated_seconds + (now - segment_started_at)` while running, so nothing depends
    on a browser tab staying open.

    Approval workflow: draft -> submitted -> approved | rejected (rejected -> draft/submitted).
    """

    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        SUBMITTED = "submitted", "Submitted"
        APPROVED = "approved", "Approved"
        REJECTED = "rejected", "Rejected"

    class TimerState(models.TextChoices):
        RUNNING = "running", "Running"
        PAUSED = "paused", "Paused"
        STOPPED = "stopped", "Stopped"

    class Source(models.TextChoices):
        TIMER = "timer", "Timer"
        MANUAL = "manual", "Manual"

    EDITABLE_STATUSES = [Status.DRAFT, Status.REJECTED]

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="time_entries")
    project = models.ForeignKey("projects.Project", on_delete=models.PROTECT, related_name="time_entries")
    task = models.ForeignKey("projects.Task", null=True, blank=True, on_delete=models.SET_NULL, related_name="time_entries")
    description = models.CharField(max_length=500, blank=True)
    date = models.DateField(help_text="Work date in the user's timezone")
    started_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    duration_seconds = models.PositiveIntegerField(default=0)

    source = models.CharField(max_length=10, choices=Source.choices, default=Source.MANUAL)
    timer_state = models.CharField(max_length=10, choices=TimerState.choices, default=TimerState.STOPPED)
    accumulated_seconds = models.PositiveIntegerField(default=0)
    segment_started_at = models.DateTimeField(null=True, blank=True)

    billable = models.BooleanField(default=True)
    bill_rate = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal("0"))
    cost_rate = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal("0"))

    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT)
    submitted_at = models.DateTimeField(null=True, blank=True)
    approved_at = models.DateTimeField(null=True, blank=True)
    approved_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    rejected_at = models.DateTimeField(null=True, blank=True)
    rejected_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    rejection_reason = models.TextField(blank=True)

    invoice_line = models.ForeignKey("finance.InvoiceLine", null=True, blank=True, on_delete=models.SET_NULL, related_name="time_entries")
    client_request_id = models.CharField(max_length=64, null=True, blank=True,
                                         help_text="Idempotency key supplied by the client to absorb duplicate submits")

    class Meta:
        ordering = ["-date", "-started_at", "-id"]
        verbose_name_plural = "time entries"
        constraints = [
            # Single-active-timer policy: at most one running or paused timer per user.
            models.UniqueConstraint(
                fields=["user"],
                condition=Q(timer_state__in=["running", "paused"]),
                name="one_active_timer_per_user",
            ),
            models.UniqueConstraint(
                fields=["user", "client_request_id"],
                condition=Q(client_request_id__isnull=False),
                name="uniq_time_entry_request_id",
            ),
            models.CheckConstraint(
                condition=Q(invoice_line__isnull=True) | Q(status="approved", billable=True),
                name="time_entry_invoiced_only_if_approved_billable",
            ),
        ]
        indexes = [
            models.Index(fields=["organization", "user", "date"]),
            models.Index(fields=["organization", "project", "status"]),
            models.Index(fields=["organization", "status", "billable"]),
        ]

    @property
    def hours(self) -> Decimal:
        return (Decimal(self.duration_seconds) / Decimal(3600)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    @property
    def billable_amount(self) -> Decimal:
        if not self.billable:
            return Decimal("0.00")
        return (Decimal(self.duration_seconds) / Decimal(3600) * self.bill_rate).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    @property
    def is_active_timer(self) -> bool:
        return self.timer_state in (self.TimerState.RUNNING, self.TimerState.PAUSED)

    @property
    def is_invoiced(self) -> bool:
        return self.invoice_line_id is not None

    def __str__(self):
        return self.description or f"Time entry {self.pk}"
