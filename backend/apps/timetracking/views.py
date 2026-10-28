from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db.models import Count, Sum
from django.utils import timezone
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.filters import csv_ints, parse_date
from apps.core.money import amount_for_seconds, hours_from_seconds, money_map, q2
from apps.core.permissions import IsManager, IsStaff
from apps.projects.access import managed_projects

from . import services
from .models import TimeEntry
from .serializers import TimeEntrySerializer, TimeEntryWriteSerializer, TimerStartSerializer, TimerUpdateSerializer


def _filter_entries(qs, params):
    if params.get("user"):
        qs = qs.filter(user_id__in=csv_ints(params["user"]))
    if params.get("project"):
        qs = qs.filter(project_id__in=csv_ints(params["project"]))
    if params.get("client"):
        qs = qs.filter(project__client_id__in=csv_ints(params["client"]))
    if params.get("task"):
        qs = qs.filter(task_id=params["task"])
    if params.get("status"):
        qs = qs.filter(status__in=params["status"].split(","))
    if params.get("billable") in ("true", "false"):
        qs = qs.filter(billable=params["billable"] == "true")
    billing = params.get("billing")
    if billing == "unbilled":
        qs = qs.filter(billable=True, invoice_line__isnull=True)
    elif billing == "invoiced":
        qs = qs.filter(invoice_line__isnull=False)
    if params.get("from"):
        qs = qs.filter(date__gte=parse_date(params["from"], "from"))
    if params.get("to"):
        qs = qs.filter(date__lte=parse_date(params["to"], "to"))
    return qs


def _totals(qs):
    agg = qs.aggregate(total=Sum("duration_seconds"), count=Count("id"))
    billable = qs.filter(billable=True).aggregate(s=Sum("duration_seconds"))["s"] or 0
    by_status = {row["status"]: row["s"] or 0 for row in qs.values("status").annotate(s=Sum("duration_seconds"))}
    return {"count": agg["count"], "total_seconds": agg["total"] or 0, "billable_seconds": billable,
            "by_status": by_status}


class TimeEntryViewSet(viewsets.ModelViewSet):
    permission_classes = [IsStaff]
    serializer_class = TimeEntrySerializer

    def get_queryset(self):
        membership = self.request.membership
        base = TimeEntry.objects.filter(organization=self.request.org).select_related(
            "user", "project", "project__client", "task", "approved_by", "rejected_by")
        scope = self.request.query_params.get("scope", "mine")
        if self.action in ("list",) and scope == "team":
            if membership.is_admin:
                qs = base
            elif membership.is_manager:
                qs = base.filter(project__in=managed_projects(membership))
            else:
                raise PermissionDenied("Only managers can view team time.")
        elif self.action == "list":
            qs = base.filter(user=self.request.user)
        else:
            qs = base
        qs = qs.filter(timer_state=TimeEntry.TimerState.STOPPED) if self.request.query_params.get("include_running") != "1" else qs
        return _filter_entries(qs, self.request.query_params).order_by("-date", "-started_at", "-id")

    def get_object(self):
        entry = TimeEntry.objects.filter(organization=self.request.org, pk=self.kwargs["pk"]).select_related(
            "user", "project", "project__client", "task").first()
        if entry is None or not services.can_view_entry(self.request.membership, entry):
            raise NotFound()
        return entry

    def list(self, request, *args, **kwargs):
        qs = self.get_queryset()
        page = self.paginate_queryset(qs)
        data = self.get_serializer(page, many=True).data
        response = self.get_paginated_response(data)
        response.data["totals"] = _totals(qs)
        return response

    def create(self, request, *args, **kwargs):
        serializer = TimeEntryWriteSerializer(data=request.data, context=self.get_serializer_context())
        serializer.is_valid(raise_exception=True)
        entry = services.create_manual_entry(request.membership, serializer.validated_data)
        return Response(self.get_serializer(entry).data, status=status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        entry = self.get_object()
        serializer = TimeEntryWriteSerializer(data=request.data, partial=True, context=self.get_serializer_context())
        serializer.is_valid(raise_exception=True)
        entry = services.update_entry(request.membership, entry, serializer.validated_data)
        return Response(self.get_serializer(entry).data)

    def destroy(self, request, *args, **kwargs):
        services.delete_entry(request.membership, self.get_object())
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=["post"])
    def submit(self, request):
        ids = request.data.get("ids") or []
        start = parse_date(request.data.get("start"), "start")
        end = parse_date(request.data.get("end"), "end")
        entries = services.submit_entries(request.membership, ids=[int(i) for i in ids], start=start, end=end)
        return Response({"submitted": len(entries)})

    @action(detail=True, methods=["post"])
    def reopen(self, request, pk=None):
        entry = services.reopen_entry(request.membership, self.get_object(), request.data.get("reason", ""))
        return Response(self.get_serializer(entry).data)


class TimerViewSet(viewsets.ViewSet):
    permission_classes = [IsStaff]

    def _payload(self, request, entry):
        return {"entry": TimeEntrySerializer(entry, context={"request": request}).data if entry else None,
                "server_now": timezone.now().isoformat()}

    def list(self, request):
        return Response(self._payload(request, services.get_active_timer(request.user)))

    @action(detail=False, methods=["post"])
    def start(self, request):
        serializer = TimerStartSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        entry = services.start_timer(membership=request.membership, project=data["project"], task=data.get("task"),
                                     description=data.get("description", ""), billable=data.get("billable"),
                                     request_id=data.get("request_id") or None, switch=data.get("switch", False))
        return Response(self._payload(request, services.get_active_timer(request.user) or entry),
                        status=status.HTTP_201_CREATED)

    @action(detail=False, methods=["post"])
    def pause(self, request):
        services.pause_timer(request.user)
        return Response(self._payload(request, services.get_active_timer(request.user)))

    @action(detail=False, methods=["post"])
    def resume(self, request):
        services.resume_timer(request.user)
        return Response(self._payload(request, services.get_active_timer(request.user)))

    @action(detail=False, methods=["post"])
    def stop(self, request):
        entry = services.stop_timer(request.user, entry_id=request.data.get("entry_id"))
        if getattr(entry, "discarded", False):
            return Response({"entry": None, "stopped": True, "discarded": True, "server_now": timezone.now().isoformat()})
        return Response({"entry": TimeEntrySerializer(entry, context={"request": request}).data, "stopped": True,
                         "server_now": timezone.now().isoformat()})

    @action(detail=False, methods=["post"])
    def discard(self, request):
        services.discard_timer(request.user)
        return Response(self._payload(request, None))

    @action(detail=False, methods=["patch"], url_path="current")
    def update_current(self, request):
        serializer = TimerUpdateSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        services.update_timer(request.membership, data=serializer.validated_data)
        return Response(self._payload(request, services.get_active_timer(request.user)))


class WeekTimesheetView(APIView):
    permission_classes = [IsStaff]

    def get(self, request):
        membership = request.membership
        org = request.org
        start = parse_date(request.query_params.get("start"), "start") or services.user_today(request.user)
        start = start - timedelta(days=(start.weekday() - org.week_start) % 7)
        end = start + timedelta(days=6)
        user_id = int(request.query_params.get("user") or request.user.id)
        qs = TimeEntry.objects.filter(organization=org, user_id=user_id, date__gte=start, date__lte=end,
                                      timer_state=TimeEntry.TimerState.STOPPED)
        if user_id != request.user.id:
            if membership.is_admin:
                pass
            elif membership.is_manager:
                qs = qs.filter(project__in=managed_projects(membership))
            else:
                raise PermissionDenied("You can only view your own timesheet.")
        qs = qs.select_related("project", "project__client", "task", "user")
        days = [(start + timedelta(days=i)).isoformat() for i in range(7)]
        rows: dict[tuple, dict] = {}
        day_totals = defaultdict(int)
        status_counts = defaultdict(int)
        for entry in qs:
            key = (entry.project_id, entry.task_id)
            row = rows.setdefault(key, {
                "project": {"id": entry.project_id, "code": entry.project.code, "name": entry.project.name,
                            "color": entry.project.color, "client_name": entry.project.client.name},
                "task": {"id": entry.task_id, "title": entry.task.title} if entry.task_id else None,
                "days": {d: 0 for d in days}, "total_seconds": 0, "statuses": set(),
            })
            row["days"][entry.date.isoformat()] += entry.duration_seconds
            row["total_seconds"] += entry.duration_seconds
            row["statuses"].add(entry.status)
            day_totals[entry.date.isoformat()] += entry.duration_seconds
            status_counts[entry.status] += 1
        out_rows = []
        for row in rows.values():
            row["statuses"] = sorted(row["statuses"])
            out_rows.append(row)
        out_rows.sort(key=lambda r: (r["project"]["code"], r["task"]["title"] if r["task"] else ""))
        from apps.accounts.models import Membership
        target = Membership.objects.filter(organization=org, user_id=user_id).select_related("user").first()
        if target is None:
            raise NotFound("Member not found.")
        return Response({
            "user": {"id": target.user_id, "full_name": target.user.full_name},
            "start": start.isoformat(), "end": end.isoformat(), "days": days, "rows": out_rows,
            "day_totals": {d: day_totals.get(d, 0) for d in days},
            "total_seconds": sum(day_totals.values()),
            "capacity_hours": str(target.weekly_capacity_hours),
            "status_counts": dict(status_counts),
            "entries": TimeEntrySerializer(qs.order_by("date", "started_at", "id"), many=True,
                                           context={"request": request}).data,
        })


class ApprovalViewSet(viewsets.ViewSet):
    permission_classes = [IsManager]

    def list(self, request):
        qs = services.approvable_entries(request.membership).filter(timer_state=TimeEntry.TimerState.STOPPED)
        params = request.query_params
        qs = qs.filter(status__in=(params.get("status") or "submitted").split(","))
        qs = _filter_entries(qs.select_related("user", "project", "project__client", "task"),
                             {k: v for k, v in params.items() if k != "status"})
        entries = list(qs.order_by("user__full_name", "date", "id")[:1000])
        groups = {"person": {}, "project": {}, "client": {}, "task": {}}

        def bump(kind, key, label, entry, extra=None):
            g = groups[kind].setdefault(key, {"key": key, "label": label, "seconds": 0, "billable_seconds": 0,
                                              "count": 0, "value": defaultdict(Decimal), **(extra or {})})
            g["seconds"] += entry.duration_seconds
            g["count"] += 1
            if entry.billable:
                g["billable_seconds"] += entry.duration_seconds
                g["value"][entry.project.currency] += amount_for_seconds(entry.duration_seconds, entry.bill_rate)

        for e in entries:
            bump("person", e.user_id, e.user.full_name, e)
            bump("project", e.project_id, f"{e.project.code} · {e.project.name}", e)
            bump("client", e.project.client_id, e.project.client.name, e)
            bump("task", e.task_id or 0, e.task.title if e.task_id else "No task", e, {"project": e.project.code})
        summary = {}
        for kind, values in groups.items():
            summary[kind] = sorted([
                {**g, "hours": str(hours_from_seconds(g["seconds"])),
                 "billable_hours": str(hours_from_seconds(g["billable_seconds"])),
                 "value": money_map({k: q2(v) for k, v in g["value"].items()})}
                for g in values.values()], key=lambda g: -g["seconds"])
        return Response({
            "entries": TimeEntrySerializer(entries, many=True, context={"request": request}).data,
            "summary": summary,
            "total_seconds": sum(e.duration_seconds for e in entries),
            "count": len(entries),
        })

    @action(detail=False, methods=["post"])
    def approve(self, request):
        ids = request.data.get("ids") or []
        if not isinstance(ids, list):
            raise ValidationError({"ids": ["Provide a list of entry ids."]})
        entries = services.approve_entries(request.membership, [int(i) for i in ids])
        return Response({"approved": len(entries)})

    @action(detail=False, methods=["post"])
    def reject(self, request):
        ids = request.data.get("ids") or []
        if not isinstance(ids, list):
            raise ValidationError({"ids": ["Provide a list of entry ids."]})
        entries = services.reject_entries(request.membership, [int(i) for i in ids], request.data.get("reason", ""))
        return Response({"rejected": len(entries)})
