from django.utils import timezone
from rest_framework import status, viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import Membership, Role

from .activity import log_activity, serialize_activity, visible_activity
from .files import file_download_response, guess_content_type, validate_upload
from .models import ActivityLog, Attachment, Comment, Notification
from .notify import notify
from .permissions import InWorkspace, IsStaff
from .serializers import AttachmentSerializer, CommentSerializer, NotificationSerializer, content_type_for
from .targets import CLIENT_SHAREABLE, can_manage_files, can_share_with_client, project_of, resolve_target


def _truthy(value) -> bool:
    """Booleans from JSON or form data: the string "false" must not count as true."""
    return str(value).strip().lower() in ("1", "true", "yes", "on")


class EnforceCsrfMixin:
    """DRF skips CSRF checks for anonymous requests; auth endpoints opt back in."""

    def initial(self, request, *args, **kwargs):
        SessionAuthentication().enforce_csrf(request)
        return super().initial(request, *args, **kwargs)


class OrgScopedViewSet(viewsets.ModelViewSet):
    """ModelViewSet whose queryset is always restricted to the requesting workspace."""

    permission_classes = [IsStaff]

    def get_queryset(self):
        return super().get_queryset().filter(organization=self.request.org)

    def perform_create(self, serializer):
        serializer.save(organization=self.request.org)


def _parse_target(request):
    raw = request.query_params.get("target") or request.data.get("target")
    if raw and ":" in str(raw):
        target_type, target_id = str(raw).split(":", 1)
    else:
        target_type = request.data.get("target_type") or request.query_params.get("target_type")
        target_id = request.data.get("target_id") or request.query_params.get("target_id")
    if not target_type or not target_id:
        raise ValidationError({"target": ["Specify target as 'type:id'."]})
    return str(target_type).lower(), target_id


def client_user_ids(org) -> set[int]:
    return set(Membership.objects.filter(organization=org, role=Role.CLIENT).values_list("user_id", flat=True))


class CommentListView(APIView):
    permission_classes = [IsStaff]

    def get(self, request):
        target_type, target_id = _parse_target(request)
        obj = resolve_target(request.membership, target_type, target_id)
        comments = Comment.objects.filter(organization=request.org, content_type=content_type_for(obj.__class__),
                                          object_id=obj.pk).select_related("author")
        context = {"client_user_ids": client_user_ids(request.org)}
        return Response(CommentSerializer(comments, many=True, context=context).data)

    def post(self, request):
        target_type, target_id = _parse_target(request)
        obj = resolve_target(request.membership, target_type, target_id, write=True)
        serializer = CommentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        client_visible = bool(serializer.validated_data.get("client_visible")) and target_type in CLIENT_SHAREABLE
        if client_visible and not can_share_with_client(request.membership, obj):
            raise PermissionDenied("Only the project's manager can share comments with the client.")
        comment = Comment.objects.create(organization=request.org, content_type=content_type_for(obj.__class__),
                                         object_id=obj.pk, author=request.user, body=serializer.validated_data["body"],
                                         client_visible=client_visible)
        project = project_of(obj) if target_type not in ("client", "lead", "document", "expense") else None
        log_activity(organization=request.org, actor=request.user, verb="commented", target=obj,
                     project=project, client_visible=client_visible, comment_id=comment.pk)
        recipients = []
        if target_type == "task":
            recipients = [obj.assignee, obj.created_by]
        elif project is not None:
            recipients = [project.manager]
        notify(organization=request.org, recipients=recipients, kind="comment_added",
               title=f"{request.user.full_name} commented on {str(obj)[:80]}", body=comment.body[:300],
               link=_link_for(obj), exclude=request.user)
        return Response(CommentSerializer(comment, context={"client_user_ids": set()}).data, status=status.HTTP_201_CREATED)


class CommentDetailView(APIView):
    permission_classes = [IsStaff]

    def delete(self, request, pk):
        comment = Comment.objects.filter(organization=request.org, pk=pk).first()
        if comment is None:
            raise NotFound()
        if comment.author_id != request.user.id and not request.membership.is_admin:
            raise PermissionDenied("You can only delete your own comments.")
        comment.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


def _link_for(obj) -> str:
    model = obj._meta.model_name
    if model == "project":
        return f"/projects/{obj.pk}"
    if model == "task":
        return f"/tasks?task={obj.pk}"
    if model in ("deliverable", "changerequest", "milestone"):
        return f"/projects/{obj.project_id}"
    if model == "client":
        return f"/clients/{obj.pk}"
    if model == "document":
        return f"/documents/{obj.pk}"
    return ""


class AttachmentListView(APIView):
    permission_classes = [IsStaff]

    def get(self, request):
        target_type, target_id = _parse_target(request)
        obj = resolve_target(request.membership, target_type, target_id)
        files = Attachment.objects.filter(organization=request.org, content_type=content_type_for(obj.__class__),
                                          object_id=obj.pk).select_related("uploaded_by")
        return Response(AttachmentSerializer(files, many=True).data)

    def post(self, request):
        target_type, target_id = _parse_target(request)
        obj = resolve_target(request.membership, target_type, target_id, write=True)
        upload = request.FILES.get("file")
        name = validate_upload(upload)
        client_visible = _truthy(request.data.get("client_visible")) and target_type in CLIENT_SHAREABLE
        if client_visible and not can_share_with_client(request.membership, obj):
            raise PermissionDenied("Only the project's manager can share files with the client.")
        attachment = Attachment(organization=request.org, content_type=content_type_for(obj.__class__),
                                object_id=obj.pk, original_name=name, size=upload.size,
                                content_type_header=guess_content_type(name), uploaded_by=request.user,
                                client_visible=client_visible)
        attachment.file.save(name, upload, save=False)
        attachment.save()
        project = project_of(obj) if target_type not in ("client", "lead", "document", "expense") else None
        log_activity(organization=request.org, actor=request.user, verb="uploaded_file", target=obj, project=project,
                     client_visible=client_visible, file=name)
        return Response(AttachmentSerializer(attachment).data, status=status.HTTP_201_CREATED)


class AttachmentDetailView(APIView):
    permission_classes = [IsStaff]

    def _get(self, request, pk):
        attachment = Attachment.objects.filter(organization=request.org, pk=pk).first()
        if attachment is None:
            raise NotFound()
        # Re-check access to the record the file is attached to.
        resolve_target(request.membership, attachment.content_type.model, attachment.object_id)
        return attachment

    def patch(self, request, pk):
        attachment = self._get(request, pk)
        if not can_share_with_client(request.membership, attachment.target):
            raise PermissionDenied("Only the project's manager can change what the client sees.")
        if "client_visible" in request.data:
            attachment.client_visible = _truthy(request.data["client_visible"]) and \
                attachment.content_type.model in CLIENT_SHAREABLE
            attachment.save(update_fields=["client_visible"])
        return Response(AttachmentSerializer(attachment).data)

    def delete(self, request, pk):
        attachment = self._get(request, pk)
        if attachment.uploaded_by_id != request.user.id and not can_manage_files(request.membership, attachment.target):
            raise PermissionDenied("You can only delete files you uploaded.")
        attachment.file.delete(save=False)
        attachment.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class AttachmentDownloadView(AttachmentDetailView):
    http_method_names = ["get", "head", "options"]

    def get(self, request, pk):
        attachment = self._get(request, pk)
        return file_download_response(attachment.file, attachment.original_name,
                                      inline=request.query_params.get("inline") == "1")


class NotificationViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = NotificationSerializer
    permission_classes = [InWorkspace]

    def get_queryset(self):
        qs = Notification.objects.filter(recipient=self.request.user, organization=self.request.org)
        if self.request.query_params.get("unread") in ("1", "true"):
            qs = qs.filter(read_at__isnull=True)
        return qs

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        response.data["unread_count"] = Notification.objects.filter(
            recipient=request.user, organization=request.org, read_at__isnull=True).count()
        return response

    @action(detail=True, methods=["post"])
    def read(self, request, pk=None):
        notification = self.get_object()
        if notification.read_at is None:
            notification.read_at = timezone.now()
            notification.save(update_fields=["read_at"])
        return Response(self.get_serializer(notification).data)

    @action(detail=False, methods=["post"], url_path="read-all")
    def read_all(self, request):
        updated = self.get_queryset().filter(read_at__isnull=True).update(read_at=timezone.now())
        return Response({"updated": updated})


class ActivityFeedView(APIView):
    permission_classes = [IsStaff]

    def get(self, request):
        from apps.projects.access import visible_project_ids

        membership = request.membership
        qs = visible_activity(membership, ActivityLog.objects.filter(organization=request.org).select_related("actor"))
        if not membership.is_admin:
            qs = qs.filter(project_id__in=visible_project_ids(membership))
        for param in ("project", "client"):
            if request.query_params.get(param):
                qs = qs.filter(**{f"{param}_id": request.query_params[param]})
        if request.query_params.get("target_type") and request.query_params.get("target_id"):
            qs = qs.filter(target_type=request.query_params["target_type"], target_id=request.query_params["target_id"])
        try:
            limit = max(1, min(int(request.query_params.get("limit", 30)), 100))
        except (TypeError, ValueError):
            raise ValidationError({"limit": ["Enter a whole number."]})
        return Response(serialize_activity(membership, qs[:limit]))
