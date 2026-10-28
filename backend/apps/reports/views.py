import csv
import re
from datetime import timedelta

from django.http import HttpResponse
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import Membership
from apps.core.filters import parse_date
from apps.core.permissions import IsManager, IsStaff
from apps.projects.access import managed_projects

from . import leak, services


def _validate_filters(request):
    for name in ("client", "project", "user"):
        value = request.query_params.get(name)
        if value and not value.isdigit():
            raise ValidationError({name: ["Enter a valid id."]})


def _period(request):
    _validate_filters(request)
    today = timezone.localdate()
    start = parse_date(request.query_params.get("from"), "from") or today.replace(day=1) - timedelta(days=150)
    start = start.replace(day=1) if not request.query_params.get("from") else start
    end = parse_date(request.query_params.get("to"), "to") or today
    if end < start:
        raise ValidationError({"to": ["End date must be after the start date."]})
    if (end - start).days > 3 * 366:
        raise ValidationError({"from": ["Choose a period of three years or less."]})
    return start, end


class DashboardView(APIView):
    permission_classes = [IsStaff]

    def get(self, request):
        return Response(services.dashboard(request.membership))


class ReportOverviewView(APIView):
    permission_classes = [IsManager]

    def get(self, request):
        start, end = _period(request)
        return Response(services.report_overview(request.membership, request.query_params, start, end))


class RevenueLeakView(APIView):
    permission_classes = [IsManager]

    def get(self, request):
        return Response(leak.radar(request.membership))


class WorkloadView(APIView):
    permission_classes = [IsManager]

    def get(self, request):
        today = timezone.localdate()
        start = parse_date(request.query_params.get("start"), "start") or today
        start, end = services.week_bounds(start, request.org.week_start)
        member_ids = None
        if not request.membership.is_admin:
            # Project managers plan the people on the projects they lead.
            member_ids = list(Membership.objects.filter(
                organization=request.org, user__project_memberships__project__in=managed_projects(request.membership))
                .values_list("user_id", flat=True).distinct())
        return Response({"start": start.isoformat(), "end": end.isoformat(),
                         "members": services.workload(request.org, start, end, member_ids)})


class CalendarView(APIView):
    permission_classes = [IsStaff]

    def get(self, request):
        start = parse_date(request.query_params.get("start"), "start")
        end = parse_date(request.query_params.get("end"), "end")
        if not start or not end or end < start or (end - start).days > 62:
            raise ValidationError({"start": ["Provide a start and end date at most 62 days apart."]})
        return Response(services.calendar_events(request.membership, start, end))


class SearchView(APIView):
    permission_classes = [IsStaff]

    def get(self, request):
        return Response(services.search(request.membership, request.query_params.get("q", "")))


class ReportExportView(APIView):
    """CSV exports of the report tables, using the same filters as the overview."""

    permission_classes = [IsManager]
    REPORTS = ("projects", "clients", "team", "expenses", "time", "aging")

    def get(self, request, name):
        if name not in self.REPORTS:
            raise ValidationError({"report": [f"Choose one of: {', '.join(self.REPORTS)}"]})
        if name == "aging" and not request.membership.has_billing_access:
            raise PermissionDenied("Billing access is required for receivables.")
        start, end = _period(request)
        response = HttpResponse(content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="omnimanager-{name}-{start}-{end}.csv"'
        writer = csv.writer(response)
        if name == "time":
            from apps.timetracking.models import TimeEntry
            from apps.reports.services import _report_scope

            projects = _report_scope(request.membership, request.query_params)
            qs = (TimeEntry.objects.filter(organization=request.org, project__in=projects, date__gte=start, date__lte=end,
                                           timer_state="stopped").select_related("user", "project", "project__client", "task")
                  .order_by("date"))
            if request.query_params.get("user"):
                qs = qs.filter(user_id=request.query_params["user"])
            writer.writerow(["Date", "Person", "Client", "Project", "Task", "Description", "Hours", "Billable",
                             "Rate", "Amount", "Currency", "Status", "Invoiced"])
            for e in qs.iterator():
                writer.writerow([e.date, _safe(e.user.full_name), _safe(e.project.client.name), _safe(e.project.code),
                                 _safe(e.task.title if e.task_id else ""), _safe(e.description), e.hours, "yes" if e.billable else "no",
                                 e.bill_rate, e.billable_amount, e.project.currency, e.status, "yes" if e.invoice_line_id else "no"])
            return response
        data = services.report_overview(request.membership, request.query_params, start, end)
        if name == "projects":
            cols = ["code", "name", "client", "status", "project_type", "currency", "hours_tracked", "hours_budget",
                    "hours_percent", "fees_used", "fees_budget", "fees_percent", "invoiced", "collected", "labor_cost",
                    "expense_cost", "total_cost", "revenue_basis", "estimated_margin", "estimated_margin_percent", "health"]
            if not request.membership.has_billing_access:
                cols.remove("collected")  # cash received is receivables data
            writer.writerow(cols)
            for row in data["projects"]:
                writer.writerow([_safe(row.get(c)) for c in cols])
        elif name == "clients":
            writer.writerow(["Client", "Hours", "Invoiced", "Collected", "Labor cost (est.)", "Expenses"])
            for row in data["clients"]:
                writer.writerow([_safe(row["name"]), row["hours"]] + [
                    "; ".join(f"{m['currency']} {m['amount']}" for m in row[k])
                    for k in ("invoiced", "collected", "labor_cost", "expenses")])
        elif name == "team":
            cols = ["full_name", "capacity_hours", "tracked_hours", "billable_hours", "utilization_percent",
                    "open_tasks", "overdue_tasks", "remaining_estimated_hours"]
            writer.writerow(cols)
            for row in data["team"]:
                writer.writerow([_safe(row["user"]["full_name"])] + [row.get(c) for c in cols[1:]])
        elif name == "expenses":
            writer.writerow(["Category", "Currency", "Amount", "Billable amount"])
            for row in data["expenses_by_category"]:
                writer.writerow([_safe(row["category"]), row["currency"], row["amount"], row["billable"]])
        elif name == "aging":
            writer.writerow(["Currency", "Current", "1-30", "31-60", "61-90", "90+"])
            for row in data["aging"]:
                writer.writerow([row["currency"]] + [row.get(k, "0.00") for k in ("current", "1_30", "31_60", "61_90", "90_plus")])
        return response


_PLAIN_NUMBER = re.compile(r"-?\d+(\.\d+)?")


def _safe(value):
    """Neutralises spreadsheet formula injection in exported text cells (plain numbers such as -12.50 pass through)."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r") and not _PLAIN_NUMBER.fullmatch(value):
        return "'" + value
    return value
