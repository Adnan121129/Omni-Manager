from django.db import transaction
from django.db.models import Count
from django.http import HttpResponse
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from apps.accounts.models import Membership, Role
from apps.core.activity import log_activity
from apps.core.exceptions import BusinessRuleError
from apps.core.filters import apply_ordering, apply_search
from apps.core.permissions import IsManager
from apps.core.views import OrgScopedViewSet
from apps.projects.access import can_manage_project, visible_documents

from . import services
from .esign import get_esign_provider
from .models import ContractTemplate, Document
from .serializers import (
    ContractTemplateSerializer,
    DocumentSerializer,
    EventSerializer,
    SignatureSerializer,
    VersionSerializer,
)


def client_ip(request) -> str | None:
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded:
        return forwarded.split(",")[0].strip()[:45] or None
    return request.META.get("REMOTE_ADDR")


class ContractTemplateViewSet(OrgScopedViewSet):
    queryset = ContractTemplate.objects.select_related("created_by")
    serializer_class = ContractTemplateSerializer
    permission_classes = [IsManager]
    pagination_class = None

    def get_queryset(self):
        qs = super().get_queryset().annotate(usage_count=Count("documents"))
        if self.request.query_params.get("archived") != "1":
            qs = qs.filter(is_archived=False)
        return qs

    def perform_create(self, serializer):
        template = serializer.save(organization=self.request.org, created_by=self.request.user)
        log_activity(organization=self.request.org, actor=self.request.user, verb="created_template", target=template)

    def perform_destroy(self, instance):
        if instance.documents.exists():
            instance.is_archived = True
            instance.save(update_fields=["is_archived"])
        else:
            instance.delete()


class DocumentViewSet(OrgScopedViewSet):
    queryset = Document.objects.select_related("client", "project", "signer", "created_by", "template")
    serializer_class = DocumentSerializer
    permission_classes = [IsManager]

    def get_queryset(self):
        qs = super().get_queryset()
        membership = self.request.membership
        qs = visible_documents(membership, qs)
        params = self.request.query_params
        if params.get("status"):
            qs = qs.filter(status__in=params["status"].split(","))
        if params.get("client"):
            qs = qs.filter(client_id=params["client"])
        if params.get("project"):
            qs = qs.filter(project_id=params["project"])
        if params.get("kind"):
            qs = qs.filter(kind=params["kind"])
        qs = apply_search(qs, self.request, ["title", "client__name"])
        return apply_ordering(qs, self.request, {"created": "created_at", "title": "title", "status": "status",
                                                 "sent": "sent_at"}, default="-created")

    def perform_create(self, serializer):
        data = serializer.validated_data
        template = data.get("template")
        project = data.get("project")
        if project is not None and self.request.membership.role == Role.PROJECT_MANAGER \
                and not can_manage_project(self.request.membership, project):
            raise PermissionDenied("You can only create documents for projects you manage.")
        extra = {}
        if template is not None:
            if not data.get("body"):
                extra["body"] = template.body
            if not data.get("payment_terms"):
                extra["payment_terms"] = template.default_payment_terms
            extra.setdefault("kind", data.get("kind") or template.kind)
        if not data.get("currency"):
            extra["currency"] = project.currency if project else data["client"].currency
        with transaction.atomic():
            document = serializer.save(organization=self.request.org, created_by=self.request.user,
                                       esign_provider=get_esign_provider().name, **extra)
            document.total_amount = services.pricing_total(document.pricing_items)
            document.save(update_fields=["total_amount"])
            services.append_event(document, "created", actor=self.request.user,
                                  details={"template": template.name if template else None})
            log_activity(organization=self.request.org, actor=self.request.user, verb="created_document",
                         target=document, client=document.client)

    def perform_update(self, serializer):
        if serializer.instance.status != Document.Status.DRAFT:
            raise BusinessRuleError("Only drafts can be edited. Use 'Revise' to start a new version.", code="document_locked")
        project = serializer.validated_data.get("project")
        if project is not None and project.pk != serializer.instance.project_id \
                and self.request.membership.role == Role.PROJECT_MANAGER \
                and not can_manage_project(self.request.membership, project):
            raise PermissionDenied("You can only attach documents to projects you manage.")
        document = serializer.save()
        document.total_amount = services.pricing_total(document.pricing_items)
        document.save(update_fields=["total_amount"])

    def perform_destroy(self, instance):
        if instance.status != Document.Status.DRAFT or instance.current_version > 0:
            raise BusinessRuleError("Only never-sent drafts can be deleted.")
        instance.delete()

    def retrieve(self, request, *args, **kwargs):
        document = services.expire_if_needed(self.get_object())
        data = self.get_serializer(document).data
        data["versions"] = VersionSerializer(document.versions.all(), many=True).data
        data["signatures"] = SignatureSerializer(document.signatures.select_related("version"), many=True).data
        data["events"] = EventSerializer(document.events.order_by("sequence"), many=True).data
        data["audit"] = services.verify_chain(document)
        data["esign"] = get_esign_provider().describe()
        data["portal_contacts"] = [
            {"id": m.user_id, "name": m.user.full_name, "email": m.user.email}
            for m in Membership.objects.filter(organization=request.org, client=document.client, role=Role.CLIENT,
                                               status=Membership.Status.ACTIVE).select_related("user")
        ]
        return Response(data)

    @action(detail=True, methods=["get"])
    def preview(self, request, pk=None):
        document = self.get_object()
        version = document.versions.order_by("-version").first()
        if document.status != Document.Status.DRAFT and version is not None:
            return Response({"html": version.rendered_html, "content_hash": version.content_hash, "version": version.version})
        rendered = services.render_html(document)
        return Response({"html": rendered, "content_hash": services.content_hash(rendered), "version": None})

    @action(detail=True, methods=["post"])
    def send(self, request, pk=None):
        document = self.get_object()
        signer = None
        if request.data.get("signer"):
            signer = Membership.objects.filter(organization=request.org, user_id=request.data["signer"], role=Role.CLIENT,
                                               client=document.client, status=Membership.Status.ACTIVE).first()
            if signer is None:
                raise BusinessRuleError("Choose an active portal contact for this client as signer.")
            signer = signer.user
        services.send_document(document, request.user, signer=signer, ip=client_ip(request))
        return self.retrieve(request, pk=pk)

    @action(detail=True, methods=["post"])
    def revise(self, request, pk=None):
        services.revise_document(self.get_object(), request.user)
        return self.retrieve(request, pk=pk)

    @action(detail=True, methods=["get"])
    def pdf(self, request, pk=None):
        document = self.get_object()
        response = HttpResponse(services.render_document_pdf(document), content_type="application/pdf")
        safe_title = "".join(ch for ch in document.title if ch.isalnum() or ch in " -_")[:60] or "document"
        response["Content-Disposition"] = f'attachment; filename="{safe_title}.pdf"'
        return response
