"""
Resolves `type:id` references used by the generic comment and attachment endpoints and
applies the same access rules as the owning module.
"""

from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError


def _registry():
    from apps.crm.models import Client, Lead
    from apps.documents.models import Document
    from apps.finance.models import Expense
    from apps.projects.models import ChangeRequest, Deliverable, Milestone, Project, Task

    return {
        "project": Project,
        "task": Task,
        "milestone": Milestone,
        "deliverable": Deliverable,
        "changerequest": ChangeRequest,
        "client": Client,
        "lead": Lead,
        "document": Document,
        "expense": Expense,
    }


# Target types whose comments/files may be shared with the client portal.
CLIENT_SHAREABLE = {"project", "deliverable", "changerequest", "document"}


def project_of(obj):
    if obj._meta.model_name == "project":
        return obj
    return getattr(obj, "project", None)


def resolve_target(membership, target_type: str, target_id, *, write: bool = False):
    from apps.projects.access import can_manage_project, can_view_project

    model = _registry().get(target_type)
    if model is None:
        raise ValidationError({"target_type": ["Unsupported target type."]})
    try:
        obj = model.objects.get(pk=int(target_id), organization=membership.organization)
    except (model.DoesNotExist, TypeError, ValueError):
        raise NotFound("Record not found.")

    if target_type in ("client", "lead"):
        if not membership.is_manager:
            raise PermissionDenied()
        return obj
    if target_type == "document":
        from apps.projects.access import can_view_document

        if not can_view_document(membership, obj):
            raise PermissionDenied()
        return obj
    if target_type == "expense":
        project = obj.project
        if obj.user_id == membership.user_id or membership.is_admin or (project and can_manage_project(membership, project)):
            return obj
        raise PermissionDenied()
    project = project_of(obj)
    if project is None or not can_view_project(membership, project):
        raise PermissionDenied()
    return obj


def can_share_with_client(membership, obj) -> bool:
    """Publishing a comment or file to the client portal is a decision for the record's project manager."""
    from apps.projects.access import can_manage_project, can_view_document

    if obj._meta.model_name == "document":
        return can_view_document(membership, obj)
    project = project_of(obj)
    return project is not None and can_manage_project(membership, project)


def can_manage_files(membership, obj) -> bool:
    """Deleting other people's files on a record: its project's manager, or whoever owns the record type."""
    from apps.projects.access import can_manage_project, can_view_document

    model = obj._meta.model_name
    if model == "document":
        return can_view_document(membership, obj)
    if model in ("client", "lead"):
        return membership.is_manager
    if membership.is_admin:
        return True
    project = project_of(obj)
    return project is not None and can_manage_project(membership, project)


def client_can_access(membership, obj) -> bool:
    """Whether a client portal user may see comments/files on this record."""
    model = obj._meta.model_name
    client_id = membership.client_id
    if model == "project":
        return obj.client_id == client_id and obj.client_visible
    if model in ("deliverable", "changerequest"):
        if not (obj.project.client_id == client_id and obj.project.client_visible):
            return False
        if model == "deliverable":
            return obj.status != "draft"
        return obj.status != "draft"
    if model == "document":
        return obj.client_id == client_id and obj.status != "draft"
    return False
