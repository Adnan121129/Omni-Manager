import os
import uuid
from decimal import Decimal

from django.conf import settings
from django.db import models
from django.db.models import Q
from django.utils import timezone

from apps.core.models import OrgScopedModel

ZERO = Decimal("0.00")


class ExpenseCategory(OrgScopedModel):
    name = models.CharField(max_length=60)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        verbose_name_plural = "expense categories"
        constraints = [models.UniqueConstraint(fields=["organization", "name"], name="uniq_expense_category")]

    def __str__(self):
        return self.name


def receipt_upload_to(instance, filename):
    ext = os.path.splitext(filename)[1].lower()[:10]
    return f"org_{instance.organization_id}/receipts/{uuid.uuid4().hex}{ext}"


class Expense(OrgScopedModel):
    """
    `amount` is what the expense cost the company (internal cost). `billable_amount` is what
    may be charged to the client (e.g. cost plus markup) when `billable` is true.
    """

    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        SUBMITTED = "submitted", "Submitted"
        APPROVED = "approved", "Approved"
        REJECTED = "rejected", "Rejected"

    EDITABLE_STATUSES = [Status.DRAFT, Status.REJECTED]

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="expenses")
    project = models.ForeignKey("projects.Project", null=True, blank=True, on_delete=models.PROTECT, related_name="expenses")
    client = models.ForeignKey("crm.Client", null=True, blank=True, on_delete=models.PROTECT, related_name="expenses")
    category = models.ForeignKey(ExpenseCategory, null=True, blank=True, on_delete=models.SET_NULL, related_name="expenses")
    vendor = models.CharField(max_length=150, blank=True)
    description = models.CharField(max_length=500)
    date = models.DateField()
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    currency = models.CharField(max_length=3, default="USD")
    billable = models.BooleanField(default=False)
    billable_amount = models.DecimalField(max_digits=12, decimal_places=2, default=ZERO)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT)
    submitted_at = models.DateTimeField(null=True, blank=True)
    approved_at = models.DateTimeField(null=True, blank=True)
    approved_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    rejected_at = models.DateTimeField(null=True, blank=True)
    rejection_reason = models.TextField(blank=True)
    receipt = models.FileField(upload_to=receipt_upload_to, null=True, blank=True, max_length=255)
    receipt_name = models.CharField(max_length=255, blank=True)
    invoice_line = models.ForeignKey("finance.InvoiceLine", null=True, blank=True, on_delete=models.SET_NULL, related_name="expenses")

    class Meta:
        ordering = ["-date", "-id"]
        constraints = [
            models.CheckConstraint(condition=Q(amount__gt=0), name="expense_amount_positive"),
            models.CheckConstraint(condition=Q(billable_amount__gte=0), name="expense_billable_amount_non_negative"),
            models.CheckConstraint(
                condition=Q(invoice_line__isnull=True) | Q(status="approved", billable=True),
                name="expense_invoiced_only_if_approved_billable",
            ),
        ]
        indexes = [models.Index(fields=["organization", "status"]), models.Index(fields=["organization", "project"])]

    def __str__(self):
        return self.description or self.vendor or f"Expense {self.pk}"


class Invoice(OrgScopedModel):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        SENT = "sent", "Sent"
        PARTIALLY_PAID = "partially_paid", "Partially paid"
        PAID = "paid", "Paid"
        CREDITED = "credited", "Credited"
        VOID = "void", "Void"

    class DiscountType(models.TextChoices):
        NONE = "none", "No discount"
        PERCENT = "percent", "Percentage"
        AMOUNT = "amount", "Fixed amount"

    OPEN_STATUSES = [Status.SENT, Status.PARTIALLY_PAID]

    client = models.ForeignKey("crm.Client", on_delete=models.PROTECT, related_name="invoices")
    number = models.CharField(max_length=40)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    currency = models.CharField(max_length=3)
    issue_date = models.DateField(default=timezone.localdate)
    due_date = models.DateField()
    payment_terms = models.CharField(max_length=200, blank=True)
    notes = models.TextField(blank=True, help_text="Shown on the invoice")
    discount_type = models.CharField(max_length=10, choices=DiscountType.choices, default=DiscountType.NONE)
    discount_value = models.DecimalField(max_digits=12, decimal_places=2, default=ZERO)
    tax_rate = models.DecimalField(max_digits=5, decimal_places=2, default=ZERO)
    tax_label = models.CharField(max_length=30, default="Tax")

    subtotal = models.DecimalField(max_digits=14, decimal_places=2, default=ZERO)
    discount_amount = models.DecimalField(max_digits=14, decimal_places=2, default=ZERO)
    tax_amount = models.DecimalField(max_digits=14, decimal_places=2, default=ZERO)
    total = models.DecimalField(max_digits=14, decimal_places=2, default=ZERO)
    amount_paid = models.DecimalField(max_digits=14, decimal_places=2, default=ZERO)
    amount_credited = models.DecimalField(max_digits=14, decimal_places=2, default=ZERO)
    amount_due = models.DecimalField(max_digits=14, decimal_places=2, default=ZERO)

    allow_online_payment = models.BooleanField(default=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    viewed_at = models.DateTimeField(null=True, blank=True)
    paid_at = models.DateTimeField(null=True, blank=True)
    voided_at = models.DateTimeField(null=True, blank=True)
    void_reason = models.TextField(blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    idempotency_key = models.CharField(max_length=80, null=True, blank=True)
    recurring_schedule = models.ForeignKey("finance.RecurringInvoiceSchedule", null=True, blank=True,
                                           on_delete=models.SET_NULL, related_name="invoices")
    last_reminder_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-issue_date", "-id"]
        constraints = [
            models.UniqueConstraint(fields=["organization", "number"], name="uniq_invoice_number"),
            models.UniqueConstraint(fields=["organization", "idempotency_key"], condition=Q(idempotency_key__isnull=False),
                                    name="uniq_invoice_idempotency_key"),
            models.CheckConstraint(condition=Q(amount_paid__gte=0) & Q(amount_credited__gte=0), name="invoice_amounts_non_negative"),
            models.CheckConstraint(condition=Q(amount_due__gte=0), name="invoice_amount_due_non_negative"),
        ]
        indexes = [models.Index(fields=["organization", "status"]), models.Index(fields=["organization", "client"]),
                   models.Index(fields=["organization", "due_date"])]

    def __str__(self):
        return self.number

    @property
    def is_overdue(self) -> bool:
        return self.status in self.OPEN_STATUSES and self.due_date < timezone.localdate() and self.amount_due > 0

    @property
    def display_status(self) -> str:
        return "overdue" if self.is_overdue else self.status


class InvoiceLine(models.Model):
    class Kind(models.TextChoices):
        TIME = "time", "Time"
        EXPENSE = "expense", "Expense"
        MILESTONE = "milestone", "Milestone"
        SERVICE = "service", "Service"

    invoice = models.ForeignKey(Invoice, on_delete=models.CASCADE, related_name="lines")
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.SERVICE)
    project = models.ForeignKey("projects.Project", null=True, blank=True, on_delete=models.SET_NULL, related_name="invoice_lines")
    description = models.CharField(max_length=500)
    quantity = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("1"))
    unit = models.CharField(max_length=20, blank=True)
    unit_price = models.DecimalField(max_digits=12, decimal_places=2, default=ZERO)
    amount = models.DecimalField(max_digits=14, decimal_places=2, default=ZERO)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position", "id"]


class Payment(OrgScopedModel):
    class Method(models.TextChoices):
        BANK_TRANSFER = "bank_transfer", "Bank transfer"
        CARD = "card", "Card (online)"
        CASH = "cash", "Cash"
        CHECK = "check", "Check"
        OTHER = "other", "Other"

    class Status(models.TextChoices):
        SUCCEEDED = "succeeded", "Succeeded"
        REVERSED = "reversed", "Reversed"

    invoice = models.ForeignKey(Invoice, on_delete=models.PROTECT, related_name="payments")
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    currency = models.CharField(max_length=3)
    method = models.CharField(max_length=20, choices=Method.choices, default=Method.BANK_TRANSFER)
    provider = models.CharField(max_length=20, blank=True, help_text="Empty for manually recorded payments")
    provider_reference = models.CharField(max_length=120, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.SUCCEEDED)
    received_at = models.DateTimeField(default=timezone.now)
    recorded_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    checkout = models.ForeignKey("finance.CheckoutSession", null=True, blank=True, on_delete=models.SET_NULL, related_name="payments")
    note = models.CharField(max_length=255, blank=True)
    reversed_at = models.DateTimeField(null=True, blank=True)
    reversed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    reversal_reason = models.TextField(blank=True)

    class Meta:
        ordering = ["-received_at", "-id"]
        constraints = [
            models.CheckConstraint(condition=Q(amount__gt=0), name="payment_amount_positive"),
            models.UniqueConstraint(fields=["provider", "provider_reference"], condition=~Q(provider_reference=""),
                                    name="uniq_payment_provider_reference"),
        ]

    def __str__(self):
        return f"{self.amount} {self.currency} payment"


class CheckoutSession(OrgScopedModel):
    class Status(models.TextChoices):
        OPEN = "open", "Open"
        PENDING = "pending", "Processing"
        SUCCEEDED = "succeeded", "Succeeded"
        FAILED = "failed", "Failed"
        CANCELED = "canceled", "Canceled"
        EXPIRED = "expired", "Expired"

    FINAL_STATUSES = [Status.SUCCEEDED, Status.FAILED, Status.CANCELED, Status.EXPIRED]

    invoice = models.ForeignKey(Invoice, on_delete=models.CASCADE, related_name="checkouts")
    provider = models.CharField(max_length=20)
    provider_session_id = models.CharField(max_length=200)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    currency = models.CharField(max_length=3)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.OPEN)
    checkout_url = models.URLField(max_length=1000, blank=True)
    initiated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    failure_reason = models.CharField(max_length=255, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["provider", "provider_session_id"], name="uniq_checkout_provider_session"),
            models.CheckConstraint(condition=Q(amount__gt=0), name="checkout_amount_positive"),
        ]


class WebhookEvent(models.Model):
    """Every verified provider event is stored once; replays are acknowledged and ignored."""

    provider = models.CharField(max_length=20)
    event_id = models.CharField(max_length=200)
    event_type = models.CharField(max_length=100)
    payload = models.JSONField()
    status = models.CharField(max_length=20, default="received")
    error = models.TextField(blank=True)
    received_at = models.DateTimeField(auto_now_add=True)
    processed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["provider", "event_id"], name="uniq_webhook_event")]


class CreditNote(OrgScopedModel):
    invoice = models.ForeignKey(Invoice, on_delete=models.PROTECT, related_name="credit_notes")
    number = models.CharField(max_length=40)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    reason = models.TextField()
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["organization", "number"], name="uniq_credit_note_number"),
            models.CheckConstraint(condition=Q(amount__gt=0), name="credit_note_amount_positive"),
        ]

    def __str__(self):
        return self.number


class RecurringInvoiceSchedule(OrgScopedModel):
    class Frequency(models.TextChoices):
        WEEKLY = "weekly", "Weekly"
        MONTHLY = "monthly", "Monthly"
        QUARTERLY = "quarterly", "Quarterly"
        YEARLY = "yearly", "Yearly"

    client = models.ForeignKey("crm.Client", on_delete=models.PROTECT, related_name="recurring_schedules")
    project = models.ForeignKey("projects.Project", null=True, blank=True, on_delete=models.SET_NULL, related_name="recurring_schedules")
    name = models.CharField(max_length=150)
    frequency = models.CharField(max_length=10, choices=Frequency.choices, default=Frequency.MONTHLY)
    start_date = models.DateField()
    next_run_date = models.DateField()
    end_date = models.DateField(null=True, blank=True)
    is_active = models.BooleanField(default=True)
    currency = models.CharField(max_length=3)
    line_items = models.JSONField(default=list, help_text="[{description, quantity, unit_price}]")
    tax_rate = models.DecimalField(max_digits=5, decimal_places=2, default=ZERO)
    discount_type = models.CharField(max_length=10, choices=Invoice.DiscountType.choices, default=Invoice.DiscountType.NONE)
    discount_value = models.DecimalField(max_digits=12, decimal_places=2, default=ZERO)
    payment_terms_days = models.PositiveSmallIntegerField(default=14)
    notes = models.TextField(blank=True)
    auto_send = models.BooleanField(default=False)
    last_generated_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        ordering = ["next_run_date", "id"]

    def __str__(self):
        return self.name


class RecurringInvoiceRun(models.Model):
    """One row per generated period - the unique constraint makes generation idempotent."""

    schedule = models.ForeignKey(RecurringInvoiceSchedule, on_delete=models.CASCADE, related_name="runs")
    period_start = models.DateField()
    invoice = models.OneToOneField(Invoice, null=True, on_delete=models.SET_NULL, related_name="recurring_run")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-period_start"]
        constraints = [models.UniqueConstraint(fields=["schedule", "period_start"], name="uniq_recurring_run_period")]


class SandboxCharge(models.Model):
    """
    Provider-side ledger for the local sandbox payment simulator. It stands in for the records
    a real provider keeps, so server-side verification reads provider state rather than trusting
    the browser. Never used with a real provider.
    """

    session_id = models.CharField(max_length=200, unique=True)
    amount_minor = models.BigIntegerField()
    currency = models.CharField(max_length=3)
    status = models.CharField(max_length=20, default="open")
    payment_reference = models.CharField(max_length=120, blank=True)
    failure_reason = models.CharField(max_length=255, blank=True)
    card_last4 = models.CharField(max_length=4, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
