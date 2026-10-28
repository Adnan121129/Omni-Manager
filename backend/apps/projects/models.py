from decimal import Decimal

from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.models import OrgScopedModel


class Project(OrgScopedModel):
    class Status(models.TextChoices):
        PLANNING = "planning", "Planning"
        ACTIVE = "active", "Active"
        ON_HOLD = "on_hold", "On hold"
        COMPLETED = "completed", "Completed"
        CANCELLED = "cancelled", "Cancelled"

    class Priority(models.TextChoices):
        LOW = "low", "Low"
        MEDIUM = "medium", "Medium"
        HIGH = "high", "High"
        URGENT = "urgent", "Urgent"

    class Type(models.TextChoices):
        FIXED = "fixed", "Fixed price"
        HOURLY = "hourly", "Time & materials"
        RETAINER = "retainer", "Retainer"

    OPEN_STATUSES = [Status.PLANNING, Status.ACTIVE, Status.ON_HOLD]

    code = models.CharField(max_length=20, help_text="Unique project identifier, e.g. ACME-001")
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    client = models.ForeignKey("crm.Client", on_delete=models.PROTECT, related_name="projects")
    manager = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="managed_projects")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PLANNING)
    priority = models.CharField(max_length=10, choices=Priority.choices, default=Priority.MEDIUM)
    start_date = models.DateField(null=True, blank=True)
    deadline = models.DateField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    project_type = models.CharField(max_length=10, choices=Type.choices, default=Type.HOURLY)
    currency = models.CharField(max_length=3, default="USD")
    budget_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0"),
                                        help_text="Fixed fee or T&M budget cap")
    budget_hours = models.DecimalField(max_digits=8, decimal_places=2, default=Decimal("0"))
    estimated_expenses = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0"))
    hourly_rate = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True,
                                      help_text="Default billing rate for this project")
    retainer_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0"))
    retainer_hours = models.DecimalField(max_digits=8, decimal_places=2, default=Decimal("0"),
                                         help_text="Hours included per month")
    billing_notes = models.TextField(blank=True)
    client_visible = models.BooleanField(default=True, help_text="Visible in the client portal")
    budget_alert_level = models.PositiveSmallIntegerField(default=0, help_text="Highest budget threshold already notified")
    color = models.CharField(max_length=7, default="#4F46E5")

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["organization", "code"], name="uniq_project_code_per_org"),
            models.CheckConstraint(condition=Q(budget_amount__gte=0) & Q(budget_hours__gte=0), name="project_budget_non_negative"),
        ]
        indexes = [models.Index(fields=["organization", "status"]), models.Index(fields=["organization", "client"])]

    def __str__(self):
        return f"{self.code} · {self.name}"


class ProjectMember(models.Model):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="members")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="project_memberships")
    role = models.CharField(max_length=80, blank=True, help_text="Role on this project, e.g. 'Lead designer'")
    bill_rate = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    added_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["project", "user"], name="uniq_project_member")]


class Milestone(OrgScopedModel):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        IN_PROGRESS = "in_progress", "In progress"
        COMPLETED = "completed", "Completed"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="milestones")
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    due_date = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    completed_at = models.DateTimeField(null=True, blank=True)
    amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0"),
                                 help_text="Billable amount for fixed-price milestone billing")
    invoice_line = models.ForeignKey("finance.InvoiceLine", null=True, blank=True, on_delete=models.SET_NULL, related_name="milestones")
    client_visible = models.BooleanField(default=True)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position", "due_date", "id"]

    def __str__(self):
        return self.name


class Deliverable(OrgScopedModel):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        PENDING_APPROVAL = "pending_approval", "Awaiting client approval"
        APPROVED = "approved", "Approved"
        CHANGES_REQUESTED = "changes_requested", "Revisions requested"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="deliverables")
    milestone = models.ForeignKey(Milestone, null=True, blank=True, on_delete=models.SET_NULL, related_name="deliverables")
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    due_date = models.DateField(null=True, blank=True)
    revision = models.PositiveIntegerField(default=1)
    submitted_at = models.DateTimeField(null=True, blank=True)
    submitted_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    decided_at = models.DateTimeField(null=True, blank=True)
    decided_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    decision_comment = models.TextField(blank=True)

    class Meta:
        ordering = ["due_date", "id"]

    def __str__(self):
        return self.title


class Label(OrgScopedModel):
    name = models.CharField(max_length=40)
    color = models.CharField(max_length=7, default="#64748B")

    class Meta:
        ordering = ["name"]
        constraints = [models.UniqueConstraint(fields=["organization", "name"], name="uniq_label_name")]

    def __str__(self):
        return self.name


class Task(OrgScopedModel):
    class Status(models.TextChoices):
        TODO = "todo", "To do"
        IN_PROGRESS = "in_progress", "In progress"
        IN_REVIEW = "in_review", "In review"
        DONE = "done", "Done"
        CANCELLED = "cancelled", "Cancelled"

    class Priority(models.TextChoices):
        LOW = "low", "Low"
        MEDIUM = "medium", "Medium"
        HIGH = "high", "High"
        URGENT = "urgent", "Urgent"

    CLOSED_STATUSES = [Status.DONE, Status.CANCELLED]

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="tasks")
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.CASCADE, related_name="subtasks")
    milestone = models.ForeignKey(Milestone, null=True, blank=True, on_delete=models.SET_NULL, related_name="tasks")
    number = models.PositiveIntegerField(default=0, help_text="Per-project sequence, shown as CODE-n")
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.TODO)
    priority = models.CharField(max_length=10, choices=Priority.choices, default=Priority.MEDIUM)
    assignee = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="assigned_tasks")
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    start_date = models.DateField(null=True, blank=True)
    due_date = models.DateField(null=True, blank=True)
    estimated_hours = models.DecimalField(max_digits=7, decimal_places=2, null=True, blank=True)
    billable = models.BooleanField(default=True)
    rate_override = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    labels = models.ManyToManyField(Label, blank=True, related_name="tasks")
    reference_url = models.URLField(blank=True)
    position = models.FloatField(default=0)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["position", "id"]
        indexes = [
            models.Index(fields=["organization", "status"]),
            models.Index(fields=["organization", "assignee"]),
            models.Index(fields=["project", "status"]),
        ]
        constraints = [
            models.CheckConstraint(condition=Q(estimated_hours__isnull=True) | Q(estimated_hours__gte=0), name="task_estimate_non_negative"),
        ]

    def __str__(self):
        return self.title

    @property
    def is_closed(self) -> bool:
        return self.status in self.CLOSED_STATUSES


class TaskDependency(models.Model):
    """`task` is blocked by `blocked_by` until that task is done or cancelled."""

    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="blocked_by_links")
    blocked_by = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="blocking_links")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["task", "blocked_by"], name="uniq_task_dependency"),
            models.CheckConstraint(condition=~Q(task=models.F("blocked_by")), name="task_dependency_not_self"),
        ]


class ChangeRequest(OrgScopedModel):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        PENDING_CLIENT = "pending_client", "Awaiting client"
        APPROVED = "approved", "Approved by client"
        REJECTED = "rejected", "Rejected"
        APPLIED = "applied", "Applied to project"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="change_requests")
    title = models.CharField(max_length=200)
    description = models.TextField()
    estimated_hours = models.DecimalField(max_digits=8, decimal_places=2, default=Decimal("0"))
    estimated_cost = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0"))
    revised_deadline = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    requested_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    sent_at = models.DateTimeField(null=True, blank=True)
    decided_at = models.DateTimeField(null=True, blank=True)
    decided_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    decision_comment = models.TextField(blank=True)
    applied_at = models.DateTimeField(null=True, blank=True)
    applied_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    applied_snapshot = models.JSONField(default=dict, blank=True, help_text="Project values before/after applying")

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.title
