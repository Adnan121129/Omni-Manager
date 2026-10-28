from django.contrib.auth.tokens import default_token_generator
from django.db import transaction
from django.utils import timezone
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from django.utils.text import slugify
from django.conf import settings

from apps.core.activity import log_activity
from apps.core.email import send_templated_email
from apps.core.exceptions import BusinessRuleError

from .models import Invitation, Membership, Organization, Role, User

DEFAULT_EXPENSE_CATEGORIES = ["Software & subscriptions", "Travel", "Hardware", "Subcontractors", "Meals",
                              "Stock assets", "Hosting & infrastructure", "Other"]
DEFAULT_LABELS = [("Design", "#8B5CF6"), ("Frontend", "#0EA5E9"), ("Backend", "#10B981"), ("Bug", "#EF4444"),
                  ("Content", "#F59E0B"), ("QA", "#64748B")]

DEFAULT_CONTRACT_BODY = """# Services Agreement

This Services Agreement ("Agreement") is entered into on {{today}} between **{{organization.name}}** ("Provider") and **{{client.name}}** ("Client").

## 1. Services
Provider will perform the services described in the Scope of Work for the project **{{project.name}}**.

## 2. Scope of Work
{{scope}}

## 3. Fees
The fees for the services are set out in the pricing table below. Total: **{{total}}**.

## 4. Milestones
{{milestones}}

## 5. Payment Terms
{{payment_terms}}

## 6. Intellectual Property
Upon receipt of full payment, Client will own the final deliverables. Provider retains ownership of pre-existing tools and know-how.

## 7. Confidentiality
Each party will keep the other party's confidential information private and use it only to perform this Agreement.

## 8. Term & Termination
Either party may terminate this Agreement with 14 days' written notice. Client will pay for work performed up to the termination date.
"""

DEFAULT_PROPOSAL_BODY = """# Project Proposal: {{project.name}}

Prepared for **{{client.name}}** by **{{organization.name}}** on {{today}}.

## Understanding of your goals
{{scope}}

## Investment
Total investment: **{{total}}**

## Timeline & milestones
{{milestones}}

## Terms
{{payment_terms}}

This proposal is valid until {{expires_at}}.
"""


def unique_slug(name: str) -> str:
    base = slugify(name)[:60] or "workspace"
    slug = base
    counter = 2
    while Organization.objects.filter(slug=slug).exists():
        slug = f"{base}-{counter}"
        counter += 1
    return slug


@transaction.atomic
def create_workspace(*, owner: User, name: str, currency: str = "USD", tz: str = "UTC", is_demo: bool = False) -> Organization:
    from apps.documents.models import ContractTemplate, DocumentKind
    from apps.finance.models import ExpenseCategory
    from apps.projects.models import Label

    org = Organization.objects.create(name=name, slug=unique_slug(name), default_currency=currency, timezone=tz,
                                      is_demo=is_demo, email=owner.email)
    Membership.objects.create(organization=org, user=owner, role=Role.OWNER, title="Founder")
    ExpenseCategory.objects.bulk_create([ExpenseCategory(organization=org, name=n) for n in DEFAULT_EXPENSE_CATEGORIES])
    Label.objects.bulk_create([Label(organization=org, name=n, color=c) for n, c in DEFAULT_LABELS])
    ContractTemplate.objects.create(
        organization=org, name="Standard services agreement", kind=DocumentKind.CONTRACT, created_by=owner,
        description="General-purpose agreement for project work", body=DEFAULT_CONTRACT_BODY,
        default_payment_terms="50% upfront, 50% on delivery. Invoices are due within 14 days.",
    )
    ContractTemplate.objects.create(
        organization=org, name="Project proposal", kind=DocumentKind.PROPOSAL, created_by=owner,
        description="Scope, investment and timeline", body=DEFAULT_PROPOSAL_BODY,
        default_payment_terms="Invoiced monthly based on approved time. Net 14.",
    )
    if owner.last_organization_id is None:
        owner.last_organization = org
        owner.save(update_fields=["last_organization"])
    log_activity(organization=org, actor=owner, verb="created_workspace", target=org)
    return org


def send_password_reset(user: User) -> None:
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = default_token_generator.make_token(user)
    link = f"{settings.FRONTEND_URL}/reset-password?uid={uid}&token={token}"
    send_templated_email(to=user.email, subject="Reset your OmniManager password", template="password_reset",
                         context={"user": user, "link": link}, defer=False)


def invite_member(*, organization: Organization, email: str, role: str, invited_by: User, client=None) -> tuple[Invitation, str]:
    email = email.strip().lower()
    if role == Role.OWNER:
        raise BusinessRuleError("Owners cannot be invited directly; invite as administrator and transfer ownership.")
    if role == Role.CLIENT and client is None:
        raise BusinessRuleError("Client portal invitations must be linked to a client.")
    if Membership.objects.filter(organization=organization, user__email__iexact=email, status=Membership.Status.ACTIVE).exists():
        raise BusinessRuleError("This person is already an active member of the workspace.", code="already_member")
    Invitation.objects.pending().filter(organization=organization, email=email).update(revoked_at=timezone.now())
    invitation, raw = Invitation.issue(organization=organization, email=email, role=role, invited_by=invited_by,
                                       client=client)
    link = f"{settings.FRONTEND_URL}/accept-invite?token={raw}"
    send_templated_email(
        to=email, subject=f"You're invited to {organization.name} on OmniManager", template="invitation",
        context={"organization": organization, "inviter": invited_by, "role": invitation.get_role_display(),
                 "link": link, "client": client},
    )
    log_activity(organization=organization, actor=invited_by, verb="invited_member", target_type="invitation",
                 target_id=invitation.pk, target_label=email, client=client, role=role)
    return invitation, raw


@transaction.atomic
def accept_invitation(*, invitation: Invitation, user: User) -> Membership:
    if user.email.lower() != invitation.email.lower():
        raise BusinessRuleError("This invitation was issued to a different email address.")
    membership, created = Membership.objects.get_or_create(
        organization=invitation.organization, user=user,
        defaults={"role": invitation.role, "client": invitation.client},
    )
    if not created:
        membership.role = invitation.role
        membership.client = invitation.client
        membership.status = Membership.Status.ACTIVE
        membership.deactivated_at = None
    if invitation.role == Role.ADMIN:
        # An admin invited by someone without billing access does not get billing access either.
        inviter = Membership.objects.filter(organization=invitation.organization, user=invitation.invited_by,
                                            status=Membership.Status.ACTIVE).first()
        membership.can_manage_billing = bool(inviter and inviter.has_billing_access)
    membership.save()
    invitation.accepted_at = timezone.now()
    invitation.save(update_fields=["accepted_at"])
    log_activity(organization=invitation.organization, actor=user, verb="joined_workspace", target_type="membership",
                 target_id=membership.pk, target_label=user.full_name, client=invitation.client, role=invitation.role)
    return membership


def assert_not_last_owner(membership: Membership) -> None:
    if membership.role != Role.OWNER:
        return
    others = Membership.objects.filter(organization=membership.organization, role=Role.OWNER,
                                       status=Membership.Status.ACTIVE).exclude(pk=membership.pk)
    if not others.exists():
        raise BusinessRuleError("A workspace must keep at least one active owner.", code="last_owner")
