import hashlib
import secrets
from datetime import timedelta
from decimal import Decimal

from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.db.models import Q
from django.utils import timezone as dj_timezone


class UserManager(BaseUserManager):
    use_in_migrations = True

    def _create_user(self, email, password, **extra):
        if not email:
            raise ValueError("An email address is required.")
        email = self.normalize_email(email).lower()
        user = self.model(email=email, **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email, password=None, **extra):
        extra.setdefault("is_staff", False)
        extra.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra)

    def create_superuser(self, email, password=None, **extra):
        extra["is_staff"] = True
        extra["is_superuser"] = True
        return self._create_user(email, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    email = models.EmailField(unique=True)
    full_name = models.CharField(max_length=150)
    timezone = models.CharField(max_length=64, default="UTC")
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    date_joined = models.DateTimeField(default=dj_timezone.now)
    last_organization = models.ForeignKey(
        "accounts.Organization", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    objects = UserManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["full_name"]

    def __str__(self):
        return self.full_name or self.email

    @property
    def initials(self) -> str:
        parts = [p for p in (self.full_name or self.email).split() if p]
        return "".join(p[0] for p in parts[:2]).upper() or self.email[:2].upper()


class Organization(models.Model):
    name = models.CharField(max_length=150)
    slug = models.SlugField(max_length=80, unique=True)
    default_currency = models.CharField(max_length=3, default="USD")
    timezone = models.CharField(max_length=64, default="UTC")
    week_start = models.PositiveSmallIntegerField(default=0, help_text="0 = Monday")

    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=40, blank=True)
    website = models.CharField(max_length=200, blank=True)
    address = models.TextField(blank=True)
    tax_id = models.CharField(max_length=60, blank=True)
    brand_color = models.CharField(max_length=7, default="#4F46E5")
    logo = models.FileField(upload_to="logos/", null=True, blank=True)

    invoice_prefix = models.CharField(max_length=12, default="INV-")
    next_invoice_number = models.PositiveIntegerField(default=1)
    next_credit_note_number = models.PositiveIntegerField(default=1)
    default_payment_terms_days = models.PositiveSmallIntegerField(default=14)
    default_tax_rate = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal("0"))
    tax_label = models.CharField(max_length=30, default="Tax")
    invoice_footer = models.TextField(blank=True)
    allow_partial_payments = models.BooleanField(default=True)
    default_bill_rate = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal("0"))

    is_demo = models.BooleanField(default=False, help_text="Created by the demo seed command.")
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name


class Role(models.TextChoices):
    OWNER = "owner", "Workspace Owner"
    ADMIN = "admin", "Administrator"
    PROJECT_MANAGER = "project_manager", "Project Manager"
    MEMBER = "member", "Team Member"
    CLIENT = "client", "Client"


STAFF_ROLES = {Role.OWNER, Role.ADMIN, Role.PROJECT_MANAGER, Role.MEMBER}
MANAGER_ROLES = {Role.OWNER, Role.ADMIN, Role.PROJECT_MANAGER}
ADMIN_ROLES = {Role.OWNER, Role.ADMIN}


class Membership(models.Model):
    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        DEACTIVATED = "deactivated", "Deactivated"

    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="memberships")
    role = models.CharField(max_length=20, choices=Role.choices)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.ACTIVE)
    client = models.ForeignKey(
        "crm.Client", null=True, blank=True, on_delete=models.CASCADE, related_name="portal_memberships"
    )
    title = models.CharField(max_length=100, blank=True)
    weekly_capacity_hours = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal("40"))
    working_days = models.JSONField(default=list, blank=True, help_text="Weekday numbers, 0 = Monday")
    default_bill_rate = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    cost_rate = models.DecimalField(
        max_digits=10, decimal_places=2, default=Decimal("0"), help_text="Internal hourly cost"
    )
    can_manage_billing = models.BooleanField(
        default=True, help_text="Administrators only: access to invoices, payments and financial reports."
    )
    notification_prefs = models.JSONField(default=dict, blank=True)
    joined_at = models.DateTimeField(default=dj_timezone.now)
    deactivated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "user"], name="uniq_membership_org_user"),
            models.CheckConstraint(
                condition=Q(role="client", client__isnull=False) | (~Q(role="client") & Q(client__isnull=True)),
                name="membership_client_role_consistent",
            ),
        ]
        indexes = [models.Index(fields=["organization", "role", "status"])]

    def __str__(self):
        return f"{self.user} @ {self.organization} ({self.role})"

    @property
    def is_active(self) -> bool:
        return self.status == self.Status.ACTIVE

    @property
    def is_admin(self) -> bool:
        return self.role in ADMIN_ROLES

    @property
    def is_manager(self) -> bool:
        return self.role in MANAGER_ROLES

    @property
    def is_staff_member(self) -> bool:
        return self.role in STAFF_ROLES

    @property
    def is_client(self) -> bool:
        return self.role == Role.CLIENT

    @property
    def has_billing_access(self) -> bool:
        return self.role == Role.OWNER or (self.role == Role.ADMIN and self.can_manage_billing)

    def get_working_days(self) -> list[int]:
        return self.working_days if self.working_days else [0, 1, 2, 3, 4]


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


class InvitationQuerySet(models.QuerySet):
    def pending(self):
        return self.filter(accepted_at__isnull=True, revoked_at__isnull=True, expires_at__gt=dj_timezone.now())


class Invitation(models.Model):
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name="invitations")
    email = models.EmailField()
    role = models.CharField(max_length=20, choices=Role.choices)
    client = models.ForeignKey("crm.Client", null=True, blank=True, on_delete=models.CASCADE)
    token_hash = models.CharField(max_length=64, unique=True)
    invited_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    objects = InvitationQuerySet.as_manager()

    class Meta:
        indexes = [models.Index(fields=["organization", "email"])]

    @classmethod
    def issue(cls, *, organization, email, role, invited_by, client=None, days_valid=7):
        """Creates an invitation and returns (invitation, raw_token). Only the hash is stored."""
        raw = secrets.token_urlsafe(32)
        invitation = cls.objects.create(
            organization=organization,
            email=email.lower(),
            role=role,
            client=client,
            invited_by=invited_by,
            token_hash=_hash_token(raw),
            expires_at=dj_timezone.now() + timedelta(days=days_valid),
        )
        return invitation, raw

    @classmethod
    def find_valid(cls, raw_token: str):
        return cls.objects.pending().select_related("organization", "client").filter(
            token_hash=_hash_token(raw_token)
        ).first()

    @property
    def status(self) -> str:
        if self.accepted_at:
            return "accepted"
        if self.revoked_at:
            return "revoked"
        if self.expires_at <= dj_timezone.now():
            return "expired"
        return "pending"
