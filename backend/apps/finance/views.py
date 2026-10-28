from collections import defaultdict
from decimal import Decimal

from django.conf import settings
from django.db import transaction
from django.db.models import Count, Prefetch, Q, Sum
from django.http import HttpResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.activity import log_activity
from apps.core.exceptions import BusinessRuleError, ConflictError
from apps.core.files import RECEIPT_EXTENSIONS, file_download_response, validate_upload
from apps.core.filters import apply_ordering, apply_search, csv_ints, parse_date
from apps.core.money import ZERO, hours_from_seconds, money_map, q2, sum_by_currency
from apps.core.models import ActivityLog
from apps.core.permissions import AdminReadWrite, HasBillingAccess, IsManager, IsStaff
from apps.core.serializers import ActivitySerializer
from apps.core.views import OrgScopedViewSet
from apps.crm.models import Client
from apps.projects.access import can_view_project, managed_projects
from apps.projects.models import Milestone, Project
from apps.timetracking.models import TimeEntry

from . import expenses as expense_service
from . import invoicing, payments, recurring
from .models import (
    CreditNote,
    Expense,
    ExpenseCategory,
    Invoice,
    InvoiceLine,
    Payment,
    RecurringInvoiceSchedule,
)
from .pdf import render_invoice_pdf
from .serializers import (
    CheckoutSerializer,
    CreditNoteSerializer,
    ExpenseCategorySerializer,
    ExpenseSerializer,
    GenerateInvoiceSerializer,
    InvoiceLineSerializer,
    InvoiceSerializer,
    ManualLineSerializer,
    PaymentSerializer,
    RecurringScheduleSerializer,
)


class ExpenseCategoryViewSet(OrgScopedViewSet):
    queryset = ExpenseCategory.objects.all()
    serializer_class = ExpenseCategorySerializer
    permission_classes = [AdminReadWrite]
    pagination_class = None

    def perform_destroy(self, instance):
        if instance.expenses.exists():
            instance.is_active = False
            instance.save(update_fields=["is_active"])
        else:
            instance.delete()


class ExpenseViewSet(OrgScopedViewSet):
    queryset = Expense.objects.select_related("user", "project", "client", "category", "approved_by")
    serializer_class = ExpenseSerializer
    parser_classes = [JSONParser, MultiPartParser, FormParser]

    def get_queryset(self):
        membership = self.request.membership
        qs = super().get_queryset()
        scope = self.request.query_params.get("scope", "mine")
        if self.action == "list":
            if scope == "team":
                if membership.is_admin:
                    pass
                elif membership.is_manager:
                    qs = qs.filter(project__in=managed_projects(membership))
                else:
                    raise PermissionDenied("Only managers can view team expenses.")
            else:
                qs = qs.filter(user=self.request.user)
        else:
            visible = Q(user=self.request.user)
            if membership.is_admin:
                visible = Q()
            elif membership.is_manager:
                visible |= Q(project__in=managed_projects(membership))
            qs = qs.filter(visible)
        params = self.request.query_params
        if params.get("status"):
            qs = qs.filter(status__in=params["status"].split(","))
        if params.get("project"):
            qs = qs.filter(project_id__in=csv_ints(params["project"]))
        if params.get("client"):
            qs = qs.filter(client_id=params["client"])
        if params.get("category"):
            qs = qs.filter(category_id=params["category"])
        if params.get("user"):
            qs = qs.filter(user_id=params["user"])
        if params.get("billable") in ("true", "false"):
            qs = qs.filter(billable=params["billable"] == "true")
        if params.get("billing") == "unbilled":
            qs = qs.filter(billable=True, invoice_line__isnull=True)
        if params.get("from"):
            qs = qs.filter(date__gte=parse_date(params["from"], "from"))
        if params.get("to"):
            qs = qs.filter(date__lte=parse_date(params["to"], "to"))
        qs = apply_search(qs, self.request, ["description", "vendor"])
        return apply_ordering(qs, self.request, {"date": "date", "amount": "amount", "status": "status"}, default="-date")

    def list(self, request, *args, **kwargs):
        qs = self.get_queryset()
        response = super().list(request, *args, **kwargs)
        rows = qs.values("currency").annotate(total=Sum("amount"), billable=Sum("billable_amount", filter=Q(billable=True)))
        response.data["totals"] = [{"currency": r["currency"], "amount": str(r["total"] or ZERO),
                                    "billable": str(r["billable"] or ZERO)} for r in rows]
        return response

    def _save(self, serializer, instance=None):
        membership = self.request.membership
        data = expense_service.validate_expense_data(membership, dict(serializer.validated_data), instance)
        upload = self.request.FILES.get("receipt")
        if instance is None:
            expense = Expense(organization=self.request.org, user=self.request.user)
        else:
            expense = instance
        for key, value in data.items():
            setattr(expense, key, value)
        if upload is not None:
            name = validate_upload(upload, allowed=RECEIPT_EXTENSIONS, field="receipt")
            if expense.receipt:
                expense.receipt.delete(save=False)
            expense.receipt.save(name, upload, save=False)
            expense.receipt_name = name
        if expense.status == Expense.Status.REJECTED and instance is not None:
            expense.status = Expense.Status.DRAFT
        expense.save()
        return expense

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            expense = self._save(serializer)
            log_activity(organization=request.org, actor=request.user, verb="created", target=expense,
                         amount=expense.amount)
        return Response(self.get_serializer(expense).data, status=status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        expense = self.get_object()
        expense_service.assert_editable(expense, request.user)
        serializer = self.get_serializer(expense, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            expense = self._save(serializer, expense)
        return Response(self.get_serializer(expense).data)

    def perform_destroy(self, instance):
        expense_service.assert_editable(instance, self.request.user)
        if instance.receipt:
            instance.receipt.delete(save=False)
        log_activity(organization=self.request.org, actor=self.request.user, verb="deleted", target=instance)
        instance.delete()

    @action(detail=True, methods=["post"])
    def submit(self, request, pk=None):
        return Response(self.get_serializer(expense_service.submit(request.membership, self.get_object())).data)

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        expense = expense_service.decide(request.membership, self.get_object(), approve=True)
        return Response(self.get_serializer(expense).data)

    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        expense = expense_service.decide(request.membership, self.get_object(), approve=False,
                                         reason=request.data.get("reason", ""))
        return Response(self.get_serializer(expense).data)

    @action(detail=True, methods=["post"])
    def reopen(self, request, pk=None):
        expense = expense_service.reopen(request.membership, self.get_object(), request.data.get("reason", ""))
        return Response(self.get_serializer(expense).data)

    @action(detail=True, methods=["get"])
    def receipt(self, request, pk=None):
        expense = self.get_object()
        if not expense.receipt:
            raise NotFound("No receipt uploaded.")
        return file_download_response(expense.receipt, expense.receipt_name or "receipt",
                                      inline=request.query_params.get("inline") == "1")


class InvoiceViewSet(OrgScopedViewSet):
    serializer_class = InvoiceSerializer
    permission_classes = [HasBillingAccess]
    queryset = Invoice.objects.select_related("client", "created_by")

    def get_queryset(self):
        qs = super().get_queryset().prefetch_related(Prefetch("lines", queryset=InvoiceLine.objects.select_related("project")))
        params = self.request.query_params
        today = timezone.localdate()
        status_param = params.get("status")
        if status_param == "overdue":
            qs = qs.filter(status__in=Invoice.OPEN_STATUSES, due_date__lt=today, amount_due__gt=0)
        elif status_param == "open":
            qs = qs.filter(status__in=Invoice.OPEN_STATUSES)
        elif status_param:
            qs = qs.filter(status__in=status_param.split(","))
        if params.get("client"):
            qs = qs.filter(client_id__in=csv_ints(params["client"]))
        if params.get("project"):
            qs = qs.filter(lines__project_id=params["project"]).distinct()
        if params.get("from"):
            qs = qs.filter(issue_date__gte=parse_date(params["from"], "from"))
        if params.get("to"):
            qs = qs.filter(issue_date__lte=parse_date(params["to"], "to"))
        qs = apply_search(qs, self.request, ["number", "client__name"])
        return apply_ordering(qs, self.request, {"number": "number", "issue_date": "issue_date", "due_date": "due_date",
                                                 "total": "total", "amount_due": "amount_due", "client": "client__name"},
                              default="-issue_date")

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        base = Invoice.objects.filter(organization=request.org)
        today = timezone.localdate()
        open_rows = base.filter(status__in=Invoice.OPEN_STATUSES).values("currency").annotate(due=Sum("amount_due"))
        overdue_rows = base.filter(status__in=Invoice.OPEN_STATUSES, due_date__lt=today).values("currency").annotate(due=Sum("amount_due"))
        draft_rows = base.filter(status=Invoice.Status.DRAFT).values("currency").annotate(total=Sum("total"))
        month_start = today.replace(day=1)
        paid_rows = Payment.objects.filter(organization=request.org, status=Payment.Status.SUCCEEDED,
                                           received_at__date__gte=month_start).values("currency").annotate(t=Sum("amount"))
        response.data["summary"] = {
            "outstanding": [{"currency": r["currency"], "amount": str(r["due"])} for r in open_rows],
            "overdue": [{"currency": r["currency"], "amount": str(r["due"])} for r in overdue_rows],
            "draft": [{"currency": r["currency"], "amount": str(r["total"])} for r in draft_rows],
            "collected_this_month": [{"currency": r["currency"], "amount": str(r["t"])} for r in paid_rows],
        }
        return response

    def retrieve(self, request, *args, **kwargs):
        invoice = self.get_object()
        data = self.get_serializer(invoice).data
        data["lines"] = InvoiceLineSerializer(invoice.lines.select_related("project").prefetch_related(
            "time_entries", "expenses", "milestones"), many=True).data
        data["payments"] = PaymentSerializer(invoice.payments.select_related("recorded_by", "invoice__client"), many=True).data
        data["credit_notes"] = CreditNoteSerializer(invoice.credit_notes.select_related("created_by"), many=True).data
        data["checkouts"] = CheckoutSerializer(invoice.checkouts.all()[:20], many=True).data
        data["client_detail"] = {"id": invoice.client_id, "name": invoice.client.name,
                                 "email": invoice.client.billing_email or invoice.client.email,
                                 "address": invoice.client.billing_address}
        data["activity"] = ActivitySerializer(ActivityLog.objects.filter(
            organization=request.org, target_type="invoice", target_id=invoice.pk).select_related("actor")[:50], many=True).data
        return Response(data)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        lines = ManualLineSerializer(data=request.data.get("lines", []), many=True, context=self.get_serializer_context())
        lines.is_valid(raise_exception=True)
        data = serializer.validated_data
        client = data["client"]
        invoice = invoicing.create_manual_invoice(
            organization=request.org, client=client, currency=data.get("currency") or client.currency, actor=request.user,
            lines=lines.validated_data, issue_date=data.get("issue_date"), due_date=data.get("due_date"),
            notes=data.get("notes", ""), discount_type=data.get("discount_type"), discount_value=data.get("discount_value"),
            tax_rate=data.get("tax_rate"), payment_terms=data.get("payment_terms"),
            idempotency_key=request.headers.get("Idempotency-Key") or None,
        )
        return Response(self.get_serializer(invoice).data, status=status.HTTP_201_CREATED)

    def perform_update(self, serializer):
        invoicing.assert_draft(serializer.instance)
        with transaction.atomic():
            invoice = serializer.save()
            invoicing.recalculate(invoice)
        log_activity(organization=self.request.org, actor=self.request.user, verb="updated_invoice", target=invoice,
                     fields=sorted(serializer.validated_data.keys()))

    def destroy(self, request, *args, **kwargs):
        invoicing.delete_draft(self.get_object(), request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=["post"])
    def generate(self, request):
        serializer = GenerateInvoiceSerializer(data=request.data, context=self.get_serializer_context())
        serializer.is_valid(raise_exception=True)
        d = serializer.validated_data
        invoice = invoicing.generate_from_work(
            organization=request.org, client=d["client"], project_ids=d["projects"], actor=request.user,
            include_time=d["include_time"], include_expenses=d["include_expenses"], milestone_ids=d["milestones"],
            date_from=d.get("date_from"), date_to=d.get("date_to"), grouping=d["grouping"],
            idempotency_key=d.get("idempotency_key") or request.headers.get("Idempotency-Key") or None,
            due_date=d.get("due_date"), notes=d.get("notes", ""))
        return Response(self.get_serializer(invoice).data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=["get"], url_path="unbilled")
    def unbilled(self, request):
        """Per-project summary of approved, uninvoiced billable work for a client (invoice wizard)."""
        client_id = request.query_params.get("client")
        client = Client.objects.filter(organization=request.org, pk=client_id).first()
        if client is None:
            raise ValidationError({"client": ["Choose a client."]})
        projects = Project.objects.filter(organization=request.org, client=client)
        date_from = parse_date(request.query_params.get("from"), "from")
        date_to = parse_date(request.query_params.get("to"), "to")
        entries, expenses, milestones = invoicing.eligible_work(organization=request.org, client=client,
                                                                projects=projects, date_from=date_from, date_to=date_to)
        result = {p.pk: {"project": {"id": p.pk, "code": p.code, "name": p.name, "currency": p.currency,
                                     "project_type": p.project_type},
                         "time_seconds": 0, "time_entries": 0, "time_value": ZERO, "expenses": 0, "expense_value": ZERO,
                         "milestones": [], "pending_time_seconds": 0}
                  for p in projects}
        for e in entries.only("project_id", "duration_seconds", "bill_rate"):
            r = result[e.project_id]
            r["time_seconds"] += e.duration_seconds
            r["time_entries"] += 1
            r["time_value"] += e.billable_amount
        for x in expenses.only("project_id", "billable_amount"):
            r = result[x.project_id]
            r["expenses"] += 1
            r["expense_value"] += x.billable_amount
        for m in milestones:
            result[m.project_id]["milestones"].append({"id": m.pk, "name": m.name, "amount": str(m.amount)})
        pending = TimeEntry.objects.filter(organization=request.org, project__in=projects, billable=True,
                                           status=TimeEntry.Status.SUBMITTED).values("project_id").annotate(s=Sum("duration_seconds"))
        for row in pending:
            result[row["project_id"]]["pending_time_seconds"] = row["s"] or 0
        out = []
        for r in result.values():
            r["time_hours"] = str(hours_from_seconds(r["time_seconds"]))
            r["time_value"] = str(q2(r["time_value"]))
            r["expense_value"] = str(q2(r["expense_value"]))
            r["pending_time_hours"] = str(hours_from_seconds(r["pending_time_seconds"]))
            out.append(r)
        out.sort(key=lambda r: r["project"]["code"])
        return Response({"client": {"id": client.pk, "name": client.name, "currency": client.currency}, "projects": out})

    @action(detail=True, methods=["post"], url_path="lines")
    def add_line(self, request, pk=None):
        invoice = self.get_object()
        invoicing.assert_draft(invoice)
        serializer = ManualLineSerializer(data=request.data, context=self.get_serializer_context())
        serializer.is_valid(raise_exception=True)
        d = serializer.validated_data
        if d.get("project") is not None and d["project"].client_id != invoice.client_id:
            raise ValidationError({"project": ["Project must belong to the invoice's client."]})
        with transaction.atomic():
            position = (invoice.lines.order_by("-position").values_list("position", flat=True).first() or 0) + 1
            InvoiceLine.objects.create(invoice=invoice, kind=InvoiceLine.Kind.SERVICE, project=d.get("project"),
                                       description=d["description"], quantity=d["quantity"], unit=d.get("unit", ""),
                                       unit_price=d["unit_price"], amount=invoicing.line_amount(d["quantity"], d["unit_price"]),
                                       position=position)
            invoicing.recalculate(invoice)
        return self.retrieve(request, pk=pk)

    @action(detail=True, methods=["patch", "delete"], url_path=r"lines/(?P<line_id>\d+)")
    def line(self, request, pk=None, line_id=None):
        invoice = self.get_object()
        line = invoice.lines.filter(pk=line_id).first()
        if line is None:
            raise NotFound()
        if request.method == "DELETE":
            invoicing.delete_line(line, request.user)
            return self.retrieve(request, pk=pk)
        invoicing.assert_draft(invoice)
        serializer = InvoiceLineSerializer(line, data=request.data, partial=True, context=self.get_serializer_context())
        serializer.is_valid(raise_exception=True)
        if line.kind != InvoiceLine.Kind.SERVICE and {"quantity", "unit_price"} & set(serializer.validated_data):
            raise BusinessRuleError("Quantities and rates of time, expense and milestone lines come from the underlying "
                                    "records. Edit the description, or remove the line and correct the source record.")
        with transaction.atomic():
            line = serializer.save()
            line.amount = invoicing.line_amount(line.quantity, line.unit_price)
            line.save(update_fields=["amount"])
            invoicing.recalculate(invoice)
        return self.retrieve(request, pk=pk)

    @action(detail=True, methods=["post"])
    def send(self, request, pk=None):
        recipients = request.data.get("recipients")
        if recipients is not None and not isinstance(recipients, list):
            raise ValidationError({"recipients": ["Provide a list of email addresses."]})
        invoicing.send_invoice(self.get_object(), request.user, send_email=bool(request.data.get("send_email", True)),
                               message=str(request.data.get("message", ""))[:2000], recipients=recipients)
        return self.retrieve(request, pk=pk)

    @action(detail=True, methods=["post"])
    def void(self, request, pk=None):
        invoicing.void_invoice(self.get_object(), request.user, request.data.get("reason", ""))
        return self.retrieve(request, pk=pk)

    @action(detail=True, methods=["post"])
    def payments(self, request, pk=None):
        invoice = self.get_object()
        try:
            amount = Decimal(str(request.data.get("amount")))
        except Exception:
            raise ValidationError({"amount": ["Enter a valid amount."]})
        method = request.data.get("method") or Payment.Method.BANK_TRANSFER
        if method not in Payment.Method.values or method == Payment.Method.CARD:
            raise ValidationError({"method": ["Choose bank transfer, cash, check or other."]})
        received = parse_date(request.data.get("received_on"), "received_on")
        received_at = timezone.make_aware(timezone.datetime.combine(received, timezone.datetime.min.time())) if received else None
        invoicing.record_payment(invoice, amount=amount, method=method, actor=request.user, received_at=received_at,
                                 note=str(request.data.get("note", "")), reference=str(request.data.get("reference", ""))[:120])
        return self.retrieve(request, pk=pk)

    @action(detail=True, methods=["post"], url_path="credit-notes")
    def credit_notes(self, request, pk=None):
        try:
            amount = Decimal(str(request.data.get("amount")))
        except Exception:
            raise ValidationError({"amount": ["Enter a valid amount."]})
        invoicing.issue_credit_note(self.get_object(), request.user, amount=amount, reason=request.data.get("reason", ""))
        return self.retrieve(request, pk=pk)

    @action(detail=True, methods=["get"])
    def pdf(self, request, pk=None):
        invoice = self.get_object()
        response = HttpResponse(render_invoice_pdf(invoice), content_type="application/pdf")
        disposition = "inline" if request.query_params.get("inline") == "1" else "attachment"
        response["Content-Disposition"] = f'{disposition}; filename="{invoice.number}.pdf"'
        response["X-Content-Type-Options"] = "nosniff"
        return response


class PaymentViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    serializer_class = PaymentSerializer
    permission_classes = [HasBillingAccess]

    def get_queryset(self):
        qs = Payment.objects.filter(organization=self.request.org).select_related("invoice", "invoice__client", "recorded_by")
        if self.request.query_params.get("client"):
            qs = qs.filter(invoice__client_id=self.request.query_params["client"])
        if self.request.query_params.get("invoice"):
            qs = qs.filter(invoice_id=self.request.query_params["invoice"])
        return qs

    @action(detail=True, methods=["post"])
    def reverse(self, request, pk=None):
        payment = self.get_queryset().filter(pk=pk).first()
        if payment is None:
            raise NotFound()
        payment = invoicing.reverse_payment(payment, request.user, request.data.get("reason", ""))
        return Response(self.get_serializer(payment).data)


class RecurringScheduleViewSet(OrgScopedViewSet):
    serializer_class = RecurringScheduleSerializer
    permission_classes = [HasBillingAccess]
    queryset = RecurringInvoiceSchedule.objects.select_related("client", "project")

    def get_queryset(self):
        return super().get_queryset().annotate(invoice_count=Count("invoices"))

    def perform_create(self, serializer):
        start = serializer.validated_data["start_date"]
        schedule = serializer.save(organization=self.request.org, next_run_date=start, created_by=self.request.user)
        log_activity(organization=self.request.org, actor=self.request.user, verb="created_recurring_schedule",
                     target=schedule, client=schedule.client)

    def perform_update(self, serializer):
        schedule = serializer.save()
        if "start_date" in serializer.validated_data and not schedule.runs.exists():
            schedule.next_run_date = schedule.start_date
            schedule.save(update_fields=["next_run_date"])
        log_activity(organization=self.request.org, actor=self.request.user, verb="updated_recurring_schedule",
                     target=schedule, client=schedule.client)

    @action(detail=True, methods=["get"])
    def preview(self, request, pk=None):
        return Response(recurring.preview(self.get_object()))

    @action(detail=True, methods=["post"], url_path="generate-next")
    def generate_next(self, request, pk=None):
        schedule = self.get_object()
        if not schedule.is_active:
            raise BusinessRuleError("Activate the schedule before generating invoices.")
        invoice = recurring.generate_period(schedule, schedule.next_run_date, request.user)
        if invoice is None:
            raise ConflictError("The invoice for this period was already generated.", code="already_generated")
        return Response({"invoice_id": invoice.pk, "number": invoice.number}, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["get"])
    def history(self, request, pk=None):
        schedule = self.get_object()
        runs = schedule.runs.select_related("invoice")
        return Response([{"period_start": r.period_start, "invoice_id": r.invoice_id,
                          "number": r.invoice.number if r.invoice else None,
                          "status": r.invoice.display_status if r.invoice else None,
                          "total": str(r.invoice.total) if r.invoice else None} for r in runs])


class PaymentProviderStatusView(APIView):
    permission_classes = [IsStaff]

    def get(self, request):
        return Response(payments.provider_status())


@method_decorator(csrf_exempt, name="dispatch")
class WebhookView(APIView):
    """Provider webhooks: authenticated by signature, not by session."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_scope = "webhooks"

    def post(self, request, provider):
        if provider not in payments.PROVIDERS:
            raise NotFound()
        try:
            outcome = payments.process_webhook(provider, request.body, request.META)
        except payments.WebhookVerificationError:
            return Response({"error": {"code": "invalid_signature", "message": "Signature verification failed.", "fields": {}}},
                            status=status.HTTP_400_BAD_REQUEST)
        except payments.ProviderNotConfigured as exc:
            return Response({"error": {"code": "provider_not_configured", "message": str(exc), "fields": {}}},
                            status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response({"received": True, "outcome": outcome})


class SandboxCheckoutView(APIView):
    """
    Hosted checkout page backend for the local sandbox provider. The unguessable session id plays
    the role of a provider-hosted checkout URL, so no workspace session is required.
    """

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_scope = "payments"

    def _get(self, session_id):
        from .models import CheckoutSession, SandboxCharge

        if settings.PAYMENT_PROVIDER != "sandbox":
            raise NotFound()
        charge = SandboxCharge.objects.filter(session_id=session_id).first()
        checkout = CheckoutSession.objects.select_related("invoice", "invoice__organization").filter(
            provider="sandbox", provider_session_id=session_id).first()
        if charge is None or checkout is None:
            raise NotFound("Checkout session not found.")
        return charge, checkout

    def get(self, request, session_id):
        charge, checkout = self._get(session_id)
        invoice = checkout.invoice
        return Response({
            "session_id": session_id, "status": charge.status, "amount": str(checkout.amount),
            "currency": checkout.currency, "invoice_number": invoice.number,
            "merchant": invoice.organization.name, "brand_color": invoice.organization.brand_color,
            "return_url": f"{settings.FRONTEND_URL}/portal/invoices/{invoice.pk}?checkout={checkout.pk}",
            "cancel_url": f"{settings.FRONTEND_URL}/portal/invoices/{invoice.pk}?checkout={checkout.pk}&canceled=1",
            "test_cards": [{"number": "4242 4242 4242 4242", "outcome": "Succeeds"},
                           {"number": "4000 0000 0000 0002", "outcome": "Declined"},
                           {"number": "4000 0000 0000 9995", "outcome": "Insufficient funds"}],
        })

    def post(self, request, session_id):
        from .payments.sandbox import simulate_payment

        charge, checkout = self._get(session_id)
        if request.data.get("action") == "cancel":
            with transaction.atomic():
                if charge.status == "open":
                    charge.status = "canceled"
                    charge.save(update_fields=["status", "updated_at"])
                    checkout.status = "canceled"
                    checkout.save(update_fields=["status", "updated_at"])
            return Response({"status": "canceled"})
        card = str(request.data.get("card_number", ""))
        with transaction.atomic():
            body, signature = simulate_payment(session_id, card)
        # Deliver the signed event through the same verification + processing path as an HTTP webhook.
        outcome = payments.process_webhook("sandbox", body, {"HTTP_X_SANDBOX_SIGNATURE": signature})
        charge.refresh_from_db()
        return Response({"status": charge.status, "failure_reason": charge.failure_reason, "outcome": outcome})
