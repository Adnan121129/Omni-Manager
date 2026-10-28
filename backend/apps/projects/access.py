"""
Project-level visibility rules shared by every module:

* Owners and administrators see every project in the workspace.
* Project managers see projects they manage or are members of, and manage the ones they lead.
* Team members see projects they are members of.
* Client accounts never use these internal querysets (see apps.portal).

Documents follow the same idea: admins see all of them, project managers see the documents they
created and those on projects they manage, and other roles have no document access.
"""

from django.db.models import Q, QuerySet
from rest_framework.exceptions import PermissionDenied

from apps.accounts.models import Membership, Role

from .models import Project


def visible_projects(membership: Membership) -> QuerySet:
    qs = Project.objects.filter(organization=membership.organization)
    if membership.is_admin:
        return qs
    if membership.role == Role.PROJECT_MANAGER:
        return qs.filter(Q(manager=membership.user) | Q(members__user=membership.user)).distinct()
    if membership.role == Role.MEMBER:
        return qs.filter(members__user=membership.user).distinct()
    return qs.none()


def managed_projects(membership: Membership) -> QuerySet:
    qs = Project.objects.filter(organization=membership.organization)
    if membership.is_admin:
        return qs
    if membership.role == Role.PROJECT_MANAGER:
        return qs.filter(manager=membership.user)
    return qs.none()


def visible_project_ids(membership: Membership) -> list[int]:
    return list(visible_projects(membership).values_list("id", flat=True))


def can_manage_project(membership: Membership, project: Project) -> bool:
    if project.organization_id != membership.organization_id:
        return False
    if membership.is_admin:
        return True
    return membership.role == Role.PROJECT_MANAGER and project.manager_id == membership.user_id


def can_view_project(membership: Membership, project: Project) -> bool:
    if project.organization_id != membership.organization_id:
        return False
    if membership.is_admin or project.manager_id == membership.user_id:
        return True
    return membership.is_staff_member and project.members.filter(user_id=membership.user_id).exists()


def can_view_project_financials(membership: Membership, project: Project) -> bool:
    return can_manage_project(membership, project)


def assert_can_manage(membership: Membership, project: Project) -> None:
    if not can_manage_project(membership, project):
        raise PermissionDenied("Only the project's manager or a workspace administrator can do this.")


def assert_can_view(membership: Membership, project: Project) -> None:
    if not can_view_project(membership, project):
        raise PermissionDenied("You are not a member of this project.")


def visible_documents(membership: Membership, qs: QuerySet | None = None) -> QuerySet:
    from apps.documents.models import Document

    qs = Document.objects.filter(organization=membership.organization) if qs is None else qs
    if membership.is_admin:
        return qs
    if membership.role == Role.PROJECT_MANAGER:
        return qs.filter(Q(created_by=membership.user) | Q(project__manager=membership.user))
    return qs.none()


def can_view_document(membership: Membership, document) -> bool:
    if document.organization_id != membership.organization_id:
        return False
    if membership.is_admin:
        return True
    if membership.role != Role.PROJECT_MANAGER:
        return False
    return document.created_by_id == membership.user_id or (
        document.project_id is not None and document.project.manager_id == membership.user_id)
