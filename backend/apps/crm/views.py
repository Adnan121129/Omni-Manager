from django.db.models import Count, DecimalField, OuterRef, Q, Subquery, Sum
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from apps.accounts.models import Membership, Role
from apps.core.activity import log_activity, serialize_activity, visible_activity
from apps.core.exceptions import BusinessRuleError
from apps.core.filters import apply_ordering, apply_search
from apps.core.models import ActivityLog
from apps.core.money import money_map, sum_by_currency
from apps.core.permissions import IsManager
from apps.core.views import OrgScopedViewSet

from . import services
from .models import Client, Interaction, Lead
from .serializers import ClientSerializer, InteractionSerializer, LeadSerializer


class ClientViewSet(OrgScopedViewSet):
    queryset = Client.objects.select_related("owner")
    serializer_class = ClientSerializer
    permission_classes = [IsManager]

    def get_queryset(self):
        from apps.finance.models import Invoice

        qs = super().get_queryset().annotate(
            active_projects=Count("projects", filter=Q(projects__status__in=["planning", "active", "on_hold"]), distinct=True),
            portal_users=Count("portal_memberships", filter=Q(portal_memberships__status="active"), distinct=True),
        )
        if self.action == "list":
            # Subquery (not a join) so the sum is not multiplied by the project/membership joins above.
            outstanding = (Invoice.objects.filter(client=OuterRef("pk"), status__in=Invoice.OPEN_STATUSES,
                                                  currency=OuterRef("currency"))
                           .values("client").annotate(total=Sum("amount_due")).values("total"))
            qs = qs.annotate(outstanding=Subquery(outstanding, output_field=DecimalField(max_digits=14, decimal_places=2)))
        if self.action != "list":
            return qs  # detail routes (restore, delete) must reach archived clients too
        status_filter = self.request.query_params.get("status")
        if status_filter == "all":
            pass
        elif status_filter:
            qs = qs.filter(status=status_filter)
        else:
            qs = qs.exclude(status=Client.Status.ARCHIVED)
        qs = apply_search(qs, self.request, ["name", "contact_name", "email", "city", "industry"])
        return apply_ordering(qs, self.request, {"name": "name", "created": "created_at", "status": "status",
                                                 "projects": "active_projects"}, default="name")

    def perform_create(self, serializer):
        client = serializer.save(organization=self.request.org, owner=serializer.validated_data.get("owner") or self.request.user)
        log_activity(organization=self.request.org, actor=self.request.user, verb="created", target=client)

    def perform_update(self, serializer):
        client = serializer.save()
        log_activity(organization=self.request.org, actor=self.request.user, verb="updated", target=client,
                     fields=sorted(serializer.validated_data.keys()))

    def destroy(self, request, *args, **kwargs):
        client = self.get_object()
        if client.projects.exists() or client.invoices.exists() or client.documents.exists():
            raise BusinessRuleError("Clients with projects, invoices or documents cannot be deleted. Archive them instead.",
                                    code="has_dependencies")
        log_activity(organization=request.org, actor=request.user, verb="deleted", target=client)
        client.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"])
    def archive(self, request, pk=None):
        client = self.get_object()
        client.status = Client.Status.ARCHIVED
        client.archived_at = timezone.now()
        client.save(update_fields=["status", "archived_at", "updated_at"])
        Membership.objects.filter(organization=request.org, client=client).update(
            status=Membership.Status.DEACTIVATED, deactivated_at=timezone.now())
        log_activity(organization=request.org, actor=request.user, verb="archived", target=client)
        return Response(self.get_serializer(client).data)

    @action(detail=True, methods=["post"])
    def restore(self, request, pk=None):
        client = self.get_object()
        client.status = Client.Status.ACTIVE
        client.archived_at = None
        client.save(update_fields=["status", "archived_at", "updated_at"])
        log_activity(organization=request.org, actor=request.user, verb="restored", target=client)
        return Response(self.get_serializer(client).data)

    @action(detail=True, methods=["get"])
    def overview(self, request, pk=None):
        from apps.finance.models import Invoice, Payment
        from apps.projects.access import visible_documents, visible_projects

        client = self.get_object()
        membership = request.membership
        projects = visible_projects(membership).filter(client=client).select_related("manager")
        data = {
            "client": self.get_serializer(client).data,
            "projects": [
                {"id": p.id, "code": p.code, "name": p.name, "status": p.status, "deadline": p.deadline,
                 "manager": p.manager.full_name if p.manager else None, "project_type": p.project_type}
                for p in projects
            ],
            "documents": [
                {"id": d.id, "title": d.title, "kind": d.kind, "status": d.status, "sent_at": d.sent_at,
                 "signed_at": d.signed_at}
                for d in visible_documents(membership).filter(client=client).order_by("-created_at")[:50]
            ],
            "portal_users": [
                {"id": m.id, "user_id": m.user_id, "name": m.user.full_name, "email": m.user.email, "status": m.status}
                for m in Membership.objects.filter(organization=request.org, client=client, role=Role.CLIENT).select_related("user")
            ],
            "leads": [
                {"id": lead.id, "title": lead.title, "stage": lead.stage, "value": str(lead.value), "currency": lead.currency}
                for lead in client.leads.all()
            ],
        }
        if membership.has_billing_access:
            invoices = Invoice.objects.filter(organization=request.org, client=client).order_by("-issue_date")
            open_invoices = [i for i in invoices if i.status in Invoice.OPEN_STATUSES]
            payments = Payment.objects.filter(organization=request.org, invoice__client=client,
                                              status=Payment.Status.SUCCEEDED).select_related("invoice")
            data["invoices"] = [
                {"id": i.id, "number": i.number, "status": i.display_status, "issue_date": i.issue_date,
                 "due_date": i.due_date, "total": str(i.total), "amount_due": str(i.amount_due), "currency": i.currency}
                for i in invoices[:50]
            ]
            data["payments"] = [
                {"id": p.id, "invoice_id": p.invoice_id, "invoice_number": p.invoice.number, "amount": str(p.amount),
                 "currency": p.currency, "method": p.method, "received_at": p.received_at}
                for p in payments[:50]
            ]
            data["outstanding"] = money_map(sum_by_currency(open_invoices, "amount_due"))
            data["overdue"] = money_map(sum_by_currency([i for i in open_invoices if i.is_overdue], "amount_due"))
            data["lifetime_paid"] = money_map(sum_by_currency(payments, "amount"))
        return Response(data)

    @action(detail=True, methods=["get"])
    def timeline(self, request, pk=None):
        client = self.get_object()
        interactions = Interaction.objects.filter(organization=request.org).filter(
            Q(client=client) | Q(lead__converted_client=client)).select_related("author")
        from apps.projects.access import visible_project_ids

        activity = visible_activity(request.membership, ActivityLog.objects.filter(organization=request.org, client=client))
        if not request.membership.is_admin:
            activity = activity.filter(Q(project__isnull=True) | Q(project_id__in=visible_project_ids(request.membership)))
        activity = list(activity.select_related("actor")[:100])
        items = [
            {"type": "interaction", "id": f"i{i.id}", "at": i.occurred_at, "data": InteractionSerializer(i).data}
            for i in interactions
        ] + [
            {"type": "activity", "id": f"a{a.id}", "at": a.created_at, "data": row}
            for a, row in zip(activity, serialize_activity(request.membership, activity))
        ]
        items.sort(key=lambda item: item["at"], reverse=True)
        return Response(items[:150])


class LeadViewSet(OrgScopedViewSet):
    queryset = Lead.objects.select_related("owner", "converted_client")
    serializer_class = LeadSerializer
    permission_classes = [IsManager]
    pagination_class = None

    def get_queryset(self):
        qs = super().get_queryset()
        stage = self.request.query_params.get("stage")
        if stage == "open":
            qs = qs.filter(stage__in=Lead.OPEN_STAGES)
        elif stage:
            qs = qs.filter(stage=stage)
        if self.request.query_params.get("owner"):
            qs = qs.filter(owner_id=self.request.query_params["owner"])
        if self.request.query_params.get("source"):
            qs = qs.filter(source__iexact=self.request.query_params["source"])
        qs = apply_search(qs, self.request, ["title", "company", "contact_name", "email"])
        return apply_ordering(qs, self.request, {"value": "value", "created": "created_at", "company": "company",
                                                 "follow_up": "next_follow_up"}, default=None)

    def perform_create(self, serializer):
        lead = serializer.save(organization=self.request.org, owner=serializer.validated_data.get("owner") or self.request.user)
        log_activity(organization=self.request.org, actor=self.request.user, verb="created", target=lead)

    def perform_update(self, serializer):
        previous_stage = serializer.instance.stage
        lead = serializer.save()
        if previous_stage != lead.stage:
            log_activity(organization=self.request.org, actor=self.request.user, verb="moved_lead", target=lead,
                         from_stage=previous_stage, to_stage=lead.stage)

    @action(detail=True, methods=["post"])
    def convert(self, request, pk=None):
        lead = self.get_object()
        existing = None
        if request.data.get("client"):
            existing = Client.objects.filter(organization=request.org, pk=request.data["client"]).first()
            if existing is None:
                raise ValidationError({"client": ["Client not found."]})
        client = services.convert_lead(lead=lead, actor=request.user, existing_client=existing)
        return Response({"lead": self.get_serializer(Lead.objects.get(pk=lead.pk)).data,
                         "client": ClientSerializer(client, context=self.get_serializer_context()).data})

    @action(detail=True, methods=["get"], url_path="duplicate-check")
    def duplicate_check(self, request, pk=None):
        match = services.find_duplicate_client(self.get_object())
        return Response({"match": {"id": match.id, "name": match.name, "email": match.email} if match else None})

    @action(detail=False, methods=["get"])
    def pipeline(self, request):
        rows = (Lead.objects.filter(organization=request.org).values("stage", "currency")
                .annotate(count=Count("id"), value=Sum("value")))
        stages = {}
        for stage, label in Lead.Stage.choices:
            stages[stage] = {"stage": stage, "label": label, "count": 0, "value": []}
        for row in rows:
            entry = stages[row["stage"]]
            entry["count"] += row["count"]
            entry["value"].append({"currency": row["currency"], "amount": str(row["value"] or 0)})
        return Response(list(stages.values()))


class InteractionViewSet(OrgScopedViewSet):
    queryset = Interaction.objects.select_related("author", "client", "lead")
    serializer_class = InteractionSerializer
    permission_classes = [IsManager]

    def get_queryset(self):
        qs = super().get_queryset()
        params = self.request.query_params
        if params.get("client"):
            qs = qs.filter(Q(client_id=params["client"]) | Q(lead__converted_client_id=params["client"]))
        if params.get("lead"):
            qs = qs.filter(lead_id=params["lead"])
        if params.get("follow_up") == "open":
            qs = qs.filter(follow_up_date__isnull=False, follow_up_done=False).order_by("follow_up_date")
        return qs

    def perform_create(self, serializer):
        interaction = serializer.save(organization=self.request.org, author=self.request.user)
        log_activity(organization=self.request.org, actor=self.request.user, verb=f"logged_{interaction.kind}",
                     target=interaction.client or interaction.lead, client=interaction.client)
