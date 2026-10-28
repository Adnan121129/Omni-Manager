"""In-app notifications with per-member preferences and optional email delivery."""

from django.db import IntegrityError, transaction

from apps.accounts.models import Membership

from .email import send_templated_email
from .models import Notification

# kind -> (label, email enabled by default)
NOTIFICATION_KINDS = {
    "task_assigned": ("Task assigned to you", True),
    "task_due_soon": ("Task deadline approaching", False),
    "timesheet_submitted": ("Time submitted for approval", False),
    "timesheet_approved": ("Time approved", False),
    "timesheet_rejected": ("Time rejected", True),
    "expense_submitted": ("Expense submitted for approval", False),
    "expense_decided": ("Expense approved or rejected", False),
    "document_awaiting_signature": ("Document awaiting your signature", True),
    "document_responded": ("Client signed or declined a document", True),
    "deliverable_submitted": ("Deliverable ready for review", True),
    "deliverable_decided": ("Client approved or requested revisions", True),
    "change_request_sent": ("Change request awaiting approval", True),
    "change_request_decided": ("Client decided on a change request", True),
    "invoice_sent": ("New invoice", True),
    "invoice_due_soon": ("Invoice due soon", True),
    "invoice_overdue": ("Invoice overdue", True),
    "payment_received": ("Payment received", True),
    "payment_failed": ("Payment failed", True),
    "budget_threshold": ("Project budget threshold reached", True),
    "comment_added": ("New comment", False),
}


def preference_for(membership: Membership | None, kind: str) -> dict:
    default_email = NOTIFICATION_KINDS.get(kind, ("", False))[1]
    prefs = (membership.notification_prefs or {}).get(kind, {}) if membership else {}
    return {"in_app": prefs.get("in_app", True), "email": prefs.get("email", default_email)}


def notify(*, organization, recipients, kind: str, title: str, body: str = "", link: str = "",
           dedupe_key: str | None = None, exclude=None) -> int:
    """Creates notifications for each distinct recipient. Returns how many were created."""
    seen = set()
    created = 0
    memberships = {
        m.user_id: m
        for m in Membership.objects.filter(
            organization=organization, user__in=[r for r in recipients if r is not None],
            status=Membership.Status.ACTIVE,
        ).select_related("user")
    }
    for user in recipients:
        if user is None or user.pk in seen or (exclude is not None and user.pk == exclude.pk):
            continue
        seen.add(user.pk)
        membership = memberships.get(user.pk)
        if membership is None:
            continue  # never notify people outside the workspace or deactivated members
        pref = preference_for(membership, kind)
        if pref["in_app"]:
            try:
                with transaction.atomic():
                    Notification.objects.create(
                        organization=organization, recipient=user, kind=kind, title=title[:200],
                        body=body, link=link, dedupe_key=dedupe_key,
                    )
                created += 1
            except IntegrityError:
                continue  # duplicate (same dedupe_key) - already notified, skip email too
        if pref["email"] and user.email:
            send_templated_email(
                to=user.email,
                subject=f"[{organization.name}] {title}",
                template="notification",
                context={"user": user, "organization": organization, "title": title, "body": body, "link": link},
            )
    return created
