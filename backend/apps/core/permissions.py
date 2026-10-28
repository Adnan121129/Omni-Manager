"""
Role-based access control. These classes are the server-side source of truth; the
frontend only mirrors them to decide which controls to show.
"""

from rest_framework.permissions import SAFE_METHODS, BasePermission

from apps.accounts.models import ADMIN_ROLES, MANAGER_ROLES, STAFF_ROLES, Role

from .tenancy import resolve_membership


class InWorkspace(BasePermission):
    """Authenticated user with an active membership; exposes request.membership / request.org."""

    message = "You do not have access to an active workspace."

    def has_permission(self, request, view):
        membership = resolve_membership(request)
        if membership is None:
            return False
        request.membership = membership
        request.org = membership.organization
        return True


class _RoleIn(InWorkspace):
    roles: set = set()
    message = "Your role does not allow this action."

    def has_permission(self, request, view):
        return super().has_permission(request, view) and request.membership.role in self.roles


class IsStaff(_RoleIn):
    """Any internal workspace user (excludes client portal accounts)."""

    roles = STAFF_ROLES


class IsManager(_RoleIn):
    roles = MANAGER_ROLES


class IsWorkspaceAdmin(_RoleIn):
    roles = ADMIN_ROLES


class IsOwner(_RoleIn):
    roles = {Role.OWNER}


class IsClientUser(_RoleIn):
    roles = {Role.CLIENT}
    message = "This area is only available to client portal accounts."


class HasBillingAccess(InWorkspace):
    message = "Billing access is required."

    def has_permission(self, request, view):
        return super().has_permission(request, view) and request.membership.has_billing_access


class StaffReadManagerWrite(InWorkspace):
    """Staff may read; only owners, admins and project managers may write."""

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        if request.method in SAFE_METHODS:
            return request.membership.role in STAFF_ROLES
        return request.membership.role in MANAGER_ROLES


class AdminReadWrite(InWorkspace):
    """Staff may read; owners/admins may write."""

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        if request.method in SAFE_METHODS:
            return request.membership.role in STAFF_ROLES
        return request.membership.role in ADMIN_ROLES
