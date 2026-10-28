"""
Workspace resolution. The active workspace is kept in the session; it is re-validated
against an *active* membership on every request so a deactivated user loses access
immediately.
"""

from apps.accounts.models import Membership

SESSION_KEY = "active_org_id"


def resolve_membership(request) -> Membership | None:
    if hasattr(request, "_om_membership"):
        return request._om_membership

    membership = None
    user = getattr(request, "user", None)
    if user is not None and user.is_authenticated and user.is_active:
        qs = Membership.objects.select_related("organization", "client", "user").filter(
            user=user, status=Membership.Status.ACTIVE
        )
        org_id = request.session.get(SESSION_KEY)
        if org_id:
            membership = qs.filter(organization_id=org_id).first()
        if membership is None and user.last_organization_id:
            membership = qs.filter(organization_id=user.last_organization_id).first()
        if membership is None:
            membership = qs.order_by("joined_at").first()
        if membership is not None and request.session.get(SESSION_KEY) != membership.organization_id:
            request.session[SESSION_KEY] = membership.organization_id

    request._om_membership = membership
    return membership


def activate_membership(request, membership: Membership) -> None:
    request.session[SESSION_KEY] = membership.organization_id
    request._om_membership = membership
    user = membership.user
    if user.last_organization_id != membership.organization_id:
        user.last_organization_id = membership.organization_id
        user.save(update_fields=["last_organization"])
