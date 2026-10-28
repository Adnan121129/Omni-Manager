"""
Dashboard, reporting and workload calculations - all computed from persisted records.

Terminology used consistently in responses and the UI:
* invoiced       - totals of issued (non-draft, non-void) invoices, by issue date
* collected      - successful payments received, by payment date (cash)
* billable value - estimate: billable hours x recorded rates, regardless of invoicing
* costs          - expenses (actual) and labor cost (estimate from internal cost rates)
Amounts are always grouped by currency and never summed across currencies.
"""

from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from django.db.models import Count, DecimalField, ExpressionWrapper, F, Q, Sum, Value
from django.db.models.functions import Round, TruncMonth
from django.utils import timezone

from apps.accounts.models import Membership, Role, STAFF_ROLES
from apps.core.activity import visible_activity
from apps.core.models import ActivityLog
from apps.core.money import ZERO, hours_from_seconds, money_map, q2
from apps.crm.models import Client, Interaction, Lead
from apps.documents.models import Document
from apps.finance.models import Expense, Invoice, InvoiceLine, Payment
from apps.projects import metrics
from apps.projects.access import can_manage_project, managed_projects, visible_documents, visible_projects
from apps.projects.models import Deliverable, Milestone, Project, Task
from apps.timetracking.models import TimeEntry

_DEC = DecimalField(max_digits=18, decimal_places=4)


def _value_expr(rate="bill_rate"):
    return Round(ExpressionWrapper(F("duration_seconds") * F(rate) / Value(Decimal(3600)), output_field=_DEC), 2)


def _money_rows(rows, amount_key="t") -> list[dict]:
    return [{"currency": r["currency"], "amount": str(q2(r[amount_key] or ZERO))} for r in rows if r.get("currency")]


def month_start(d: date) -> date:
    return d.replace(day=1)


def months_back(n: int, today: date) -> list[date]:
    out = []
    current = month_start(today)
    for _ in range(n):
        out.append(current)
        current = month_start(current - timedelta(days=1))
    return list(reversed(out))


def week_bounds(today: date, week_start: int = 0) -> tuple[date, date]:
    start = today - timedelta(days=(today.weekday() - week_start) % 7)
    return start, start + timedelta(days=6)


def capacity_hours(membership: Membership, start: date, end: date) -> Decimal:
    days = membership.get_working_days()
    if not days:
        return ZERO
    per_day = Decimal(membership.weekly_capacity_hours) / Decimal(len(days))
    working = sum(1 for i in range((end - start).days + 1) if (start + timedelta(days=i)).weekday() in days)
    return q2(per_day * working)


def workload(organization, start: date, end: date, member_ids: list[int] | None = None) -> list[dict]:
    today = timezone.localdate()
    members = Membership.objects.filter(organization=organization, role__in=STAFF_ROLES,
                                        status=Membership.Status.ACTIVE).select_related("user")
    if member_ids is not None:
        members = members.filter(user_id__in=member_ids)
    members = list(members)
    user_ids = [m.user_id for m in members]
    time_rows = (TimeEntry.objects.filter(organization=organization, user_id__in=user_ids, date__gte=start, date__lte=end,
                                          timer_state=TimeEntry.TimerState.STOPPED)
                 .exclude(status=TimeEntry.Status.REJECTED).values("user_id", "billable")
                 .annotate(s=Sum("duration_seconds")))
    tracked = defaultdict(lambda: {"total": 0, "billable": 0})
    for row in time_rows:
        tracked[row["user_id"]]["total"] += row["s"] or 0
        if row["billable"]:
            tracked[row["user_id"]]["billable"] += row["s"] or 0
    open_tasks = Task.objects.filter(organization=organization, assignee_id__in=user_ids).exclude(status__in=Task.CLOSED_STATUSES)
    task_rows = open_tasks.values("assignee_id").annotate(
        count=Count("id"), est=Sum("estimated_hours"),
        overdue=Count("id", filter=Q(due_date__lt=today)),
        due_this_period=Sum("estimated_hours", filter=Q(due_date__gte=start, due_date__lte=end)))
    tasks = {r["assignee_id"]: r for r in task_rows}
    tracked_on_open = dict(TimeEntry.objects.filter(task__in=open_tasks).exclude(status="rejected")
                           .values("task__assignee_id").annotate(s=Sum("duration_seconds"))
                           .values_list("task__assignee_id", "s"))
    entry_status = defaultdict(dict)
    for row in (TimeEntry.objects.filter(organization=organization, user_id__in=user_ids,
                                         status__in=[TimeEntry.Status.DRAFT, TimeEntry.Status.REJECTED, TimeEntry.Status.SUBMITTED],
                                         timer_state=TimeEntry.TimerState.STOPPED)
                .values("user_id", "status").annotate(c=Count("id"))):
        entry_status[row["user_id"]][row["status"]] = row["c"]
    running = set(TimeEntry.objects.filter(user_id__in=user_ids, timer_state=TimeEntry.TimerState.RUNNING)
                  .values_list("user_id", flat=True))
    out = []
    for m in members:
        cap = capacity_hours(m, start, end)
        t = tracked[m.user_id]
        hours = hours_from_seconds(t["total"])
        billable = hours_from_seconds(t["billable"])
        task = tasks.get(m.user_id, {})
        est_open = Decimal(task.get("est") or 0)
        remaining = max(ZERO, q2(est_open - hours_from_seconds(tracked_on_open.get(m.user_id) or 0)))
        due_period = Decimal(task.get("due_this_period") or 0)
        overloaded = (cap > 0 and (hours > cap or due_period > cap))
        out.append({
            "user": {"id": m.user_id, "full_name": m.user.full_name, "email": m.user.email, "initials": m.user.initials},
            "membership_id": m.pk, "role": m.role, "title": m.title,
            "capacity_hours": str(cap), "weekly_capacity_hours": str(m.weekly_capacity_hours),
            "tracked_hours": str(hours), "billable_hours": str(billable),
            "utilization_percent": str((billable / cap * 100).quantize(Decimal("0.1"))) if cap else None,
            "load_percent": str((hours / cap * 100).quantize(Decimal("0.1"))) if cap else None,
            "open_tasks": task.get("count", 0), "overdue_tasks": task.get("overdue", 0),
            "open_estimated_hours": str(q2(est_open)), "remaining_estimated_hours": str(remaining),
            "due_this_period_hours": str(q2(due_period)),
            "draft_entries": entry_status[m.user_id].get("draft", 0),
            "rejected_entries": entry_status[m.user_id].get("rejected", 0),
            "submitted_entries": entry_status[m.user_id].get("submitted", 0),
            "timer_running": m.user_id in running, "overloaded": overloaded,
        })
    out.sort(key=lambda r: r["user"]["full_name"])
    return out


def _month_series(organization, currency: str, project_ids: list[int] | None, months: list[date]) -> list[dict]:
    first = months[0]
    issued = Invoice.objects.filter(organization=organization, currency=currency, issue_date__gte=first) \
        .exclude(status__in=[Invoice.Status.DRAFT, Invoice.Status.VOID])
    payments = Payment.objects.filter(organization=organization, currency=currency, status=Payment.Status.SUCCEEDED,
                                      received_at__date__gte=first)
    expenses = Expense.objects.filter(organization=organization, currency=currency, date__gte=first) \
        .exclude(status=Expense.Status.REJECTED)
    if project_ids is not None:
        lines = InvoiceLine.objects.filter(invoice__in=issued, project_id__in=project_ids)
        invoiced = {r["m"].date() if hasattr(r["m"], "date") else r["m"]: r["t"] for r in
                    lines.annotate(m=TruncMonth("invoice__issue_date")).values("m").annotate(t=Sum("amount"))}
        payments = payments.filter(invoice__in=Invoice.objects.filter(lines__project_id__in=project_ids))
        expenses = expenses.filter(project_id__in=project_ids)
    else:
        invoiced = {r["m"]: r["t"] for r in issued.annotate(m=TruncMonth("issue_date")).values("m").annotate(t=Sum("total"))}
    collected = {r["m"].date() if hasattr(r["m"], "date") else r["m"]: r["t"]
                 for r in payments.annotate(m=TruncMonth("received_at")).values("m").annotate(t=Sum("amount"))}
    spent = {r["m"]: r["t"] for r in expenses.annotate(m=TruncMonth("date")).values("m").annotate(t=Sum("amount"))}

    def get(d: dict, m: date):
        for key, value in d.items():
            k = key.date() if hasattr(key, "date") and not isinstance(key, date) else key
            if hasattr(k, "year") and k.year == m.year and k.month == m.month:
                return value or ZERO
        return ZERO

    return [{"month": m.strftime("%Y-%m"), "label": m.strftime("%b"), "invoiced": str(q2(get(invoiced, m))),
             "collected": str(q2(get(collected, m))), "expenses": str(q2(get(spent, m)))} for m in months]


def dashboard(membership: Membership) -> dict:
    org = membership.organization
    today = timezone.localdate()
    now = timezone.now()
    m_start = month_start(today)
    w_start, w_end = week_bounds(today, org.week_start)
    user = membership.user
    data: dict = {"role": membership.role, "generated_at": now.isoformat(), "currency": org.default_currency}

    projects = visible_projects(membership) if membership.role != Role.MEMBER else visible_projects(membership)
    scoped_projects = projects if not membership.is_admin else Project.objects.filter(organization=org)
    open_projects = list(scoped_projects.filter(status__in=Project.OPEN_STATUSES).select_related("client", "manager"))
    project_ids = [p.pk for p in scoped_projects.only("id")]
    proj_metrics = metrics.collect([p.pk for p in open_projects])

    # --- My work (everyone) ---
    my_tasks = (Task.objects.filter(organization=org, assignee=user, project__in=visible_projects(membership))
                .exclude(status__in=Task.CLOSED_STATUSES).select_related("project"))
    my_week = TimeEntry.objects.filter(organization=org, user=user, date__gte=w_start, date__lte=w_end,
                                       timer_state=TimeEntry.TimerState.STOPPED).exclude(status=TimeEntry.Status.REJECTED)
    my_seconds = my_week.aggregate(s=Sum("duration_seconds"))["s"] or 0
    my_billable = my_week.filter(billable=True).aggregate(s=Sum("duration_seconds"))["s"] or 0
    data["my_work"] = {
        "week_start": w_start.isoformat(), "week_end": w_end.isoformat(),
        "hours_this_week": str(hours_from_seconds(my_seconds)),
        "billable_hours_this_week": str(hours_from_seconds(my_billable)),
        "capacity_hours": str(capacity_hours(membership, w_start, w_end)),
        "open_tasks": my_tasks.count(),
        "overdue_tasks": my_tasks.filter(due_date__lt=today).count(),
        "draft_entries": TimeEntry.objects.filter(organization=org, user=user, status=TimeEntry.Status.DRAFT,
                                                  timer_state=TimeEntry.TimerState.STOPPED).count(),
        "rejected_entries": TimeEntry.objects.filter(organization=org, user=user, status=TimeEntry.Status.REJECTED).count(),
        "tasks": [{"id": t.pk, "key": f"{t.project.code}-{t.number}", "title": t.title, "status": t.status,
                   "priority": t.priority, "due_date": t.due_date, "project": t.project.name,
                   "overdue": bool(t.due_date and t.due_date < today)}
                  for t in my_tasks.order_by(F("due_date").asc(nulls_last=True), "-priority")[:8]],
    }

    # --- Project overview (managers see their scope, members see their projects) ---
    health_counts = defaultdict(int)
    attention = []
    for p in open_projects:
        computed = metrics.full(p, proj_metrics[p.pk])
        health_counts[computed["health"]["status"]] += 1
        sees_money = can_manage_project(membership, p)
        budget = computed["budget"]
        signals = computed["health"] if sees_money else metrics.redact_health(computed["health"])
        reasons = [s["reason"] for s in signals["signals"] if s["level"] != "ok"]
        deadline_soon = p.deadline and today <= p.deadline <= today + timedelta(days=14)
        used = Decimal(budget["used_percent"]) if budget["used_percent"] and sees_money else None
        if computed["health"]["status"] != "healthy" or deadline_soon or (used is not None and used >= 75):
            if deadline_soon and not any("Deadline" in r for r in reasons):
                reasons.append(f"Deadline in {(p.deadline - today).days} days ({p.deadline.isoformat()}).")
            if used is not None and used >= 75 and not any("budget" in r.lower() for r in reasons):
                reasons.append(f"{used}% of budget used.")
            attention.append({"id": p.pk, "code": p.code, "name": p.name, "client": p.client.name,
                              "health": computed["health"]["status"], "progress": computed["progress"]["percent"],
                              "budget_used_percent": budget["used_percent"] if sees_money else None,
                              "deadline": p.deadline, "reasons": reasons})
    attention.sort(key=lambda a: ({"critical": 0, "at_risk": 1, "healthy": 2}[a["health"]], a["deadline"] or date.max))
    data["projects"] = {
        "active": sum(1 for p in open_projects if p.status == Project.Status.ACTIVE),
        "open": len(open_projects),
        "completed": scoped_projects.filter(status=Project.Status.COMPLETED).count(),
        "completed_this_month": scoped_projects.filter(status=Project.Status.COMPLETED, completed_at__date__gte=m_start).count(),
        "health": {"healthy": health_counts["healthy"], "at_risk": health_counts["at_risk"],
                   "critical": health_counts["critical"]},
        "attention": attention[:8],
    }

    activity_qs = visible_activity(membership, ActivityLog.objects.filter(organization=org).select_related("actor"))
    if not membership.is_admin:
        activity_qs = activity_qs.filter(project_id__in=project_ids)
    data["activity"] = [{"id": a.pk, "verb": a.verb, "target_type": a.target_type, "target_id": a.target_id,
                         "target_label": a.target_label, "actor": a.actor.full_name if a.actor else "System",
                         "project_id": a.project_id, "created_at": a.created_at} for a in activity_qs[:12]]

    if not membership.is_manager:
        return data

    # --- Manager & admin sections ---
    approvable_time = TimeEntry.objects.filter(organization=org, status=TimeEntry.Status.SUBMITTED)
    approvable_exp = Expense.objects.filter(organization=org, status=Expense.Status.SUBMITTED)
    if not membership.is_admin:
        mp = managed_projects(membership)
        approvable_time = approvable_time.filter(project__in=mp)
        approvable_exp = approvable_exp.filter(project__in=mp)
    # Team time and its billable value cover the projects this manager leads (all projects for admins).
    managed_ids = project_ids if membership.is_admin else list(managed_projects(membership).values_list("id", flat=True))
    month_time = TimeEntry.objects.filter(organization=org, project_id__in=managed_ids, date__gte=m_start,
                                          timer_state=TimeEntry.TimerState.STOPPED).exclude(status=TimeEntry.Status.REJECTED)
    billable_month = month_time.filter(billable=True)
    data["time"] = {
        "billable_hours_this_month": str(hours_from_seconds(billable_month.aggregate(s=Sum("duration_seconds"))["s"] or 0)),
        "total_hours_this_month": str(hours_from_seconds(month_time.aggregate(s=Sum("duration_seconds"))["s"] or 0)),
        "awaiting_approval_hours": str(hours_from_seconds(approvable_time.aggregate(s=Sum("duration_seconds"))["s"] or 0)),
        "awaiting_approval_entries": approvable_time.count(),
        "billable_value_this_month": _money_rows(billable_month.values(currency=F("project__currency"))
                                                 .annotate(t=Sum(_value_expr()))),
    }
    data["approvals"] = {
        "time_entries": approvable_time.count(),
        "expenses": approvable_exp.count(),
        "documents_awaiting_client": visible_documents(membership).filter(status__in=Document.AWAITING_STATUSES).count(),
        "deliverables_awaiting_client": Deliverable.objects.filter(organization=org, project_id__in=project_ids,
                                                                   status=Deliverable.Status.PENDING_APPROVAL).count(),
    }
    data["clients"] = {
        "active": Client.objects.filter(organization=org, status=Client.Status.ACTIVE).count(),
        "new_leads_30d": Lead.objects.filter(organization=org, created_at__gte=now - timedelta(days=30)).count(),
        "open_leads": Lead.objects.filter(organization=org, stage__in=Lead.OPEN_STAGES).count(),
        "pipeline_value": _money_rows(Lead.objects.filter(organization=org, stage__in=Lead.OPEN_STAGES)
                                      .values("currency").annotate(t=Sum("value"))),
        "recent_leads": [{"id": lead.pk, "title": lead.title, "company": lead.company, "stage": lead.stage,
                          "value": str(lead.value), "currency": lead.currency, "created_at": lead.created_at}
                         for lead in Lead.objects.filter(organization=org).order_by("-created_at")[:5]],
        "follow_ups_due": Interaction.objects.filter(organization=org, follow_up_done=False,
                                                     follow_up_date__lte=today).count(),
    }
    w_members = workload(org, w_start, w_end)
    if not membership.is_admin:
        member_ids = set(Membership.objects.filter(organization=org, user__project_memberships__project__in=managed_projects(membership))
                         .values_list("user_id", flat=True))
        w_members = [w for w in w_members if w["user"]["id"] in member_ids]
    data["team"] = {"week_start": w_start.isoformat(), "members": w_members,
                    "overloaded": sum(1 for w in w_members if w["overloaded"])}

    if not membership.has_billing_access:
        return data

    issued = Invoice.objects.filter(organization=org).exclude(status__in=[Invoice.Status.DRAFT, Invoice.Status.VOID])
    open_inv = Invoice.objects.filter(organization=org, status__in=Invoice.OPEN_STATUSES, amount_due__gt=0)
    overdue = open_inv.filter(due_date__lt=today)
    data["finance"] = {
        "invoiced_this_month": _money_rows(issued.filter(issue_date__gte=m_start).values("currency").annotate(t=Sum("total"))),
        "collected_this_month": _money_rows(Payment.objects.filter(organization=org, status=Payment.Status.SUCCEEDED,
                                                                   received_at__date__gte=m_start)
                                            .values("currency").annotate(t=Sum("amount"))),
        "outstanding": _money_rows(open_inv.values("currency").annotate(t=Sum("amount_due"))),
        "overdue": _money_rows(overdue.values("currency").annotate(t=Sum("amount_due"))),
        "overdue_count": overdue.count(),
        "overdue_invoices": [{"id": i.pk, "number": i.number, "client": i.client.name, "due_date": i.due_date,
                              "days_overdue": (today - i.due_date).days, "amount_due": str(i.amount_due),
                              "currency": i.currency} for i in overdue.select_related("client").order_by("due_date")[:6]],
        "upcoming_payments": [{"id": i.pk, "number": i.number, "client": i.client.name, "due_date": i.due_date,
                               "amount_due": str(i.amount_due), "currency": i.currency}
                              for i in open_inv.filter(due_date__gte=today, due_date__lte=today + timedelta(days=14))
                              .select_related("client").order_by("due_date")[:6]],
        "expenses_this_month": _money_rows(Expense.objects.filter(organization=org, date__gte=m_start)
                                           .exclude(status=Expense.Status.REJECTED).values("currency").annotate(t=Sum("amount"))),
    }
    months = months_back(6, today)
    data["chart"] = {
        "currency": org.default_currency,
        "series": _month_series(org, org.default_currency, None, months),
        "other_currencies": sorted(set(issued.exclude(currency=org.default_currency).values_list("currency", flat=True))),
        "note": f"Amounts in {org.default_currency}. Invoices, payments and expenses in other currencies are not converted.",
    }
    return data


def _report_scope(membership: Membership, params) -> tuple:
    projects = Project.objects.filter(organization=membership.organization) if membership.is_admin else managed_projects(membership)
    if params.get("client"):
        projects = projects.filter(client_id=params["client"])
    if params.get("project"):
        projects = projects.filter(pk=params["project"])
    return projects


def report_overview(membership: Membership, params, start: date, end: date) -> dict:
    org = membership.organization
    projects_qs = _report_scope(membership, params)
    project_ids = list(projects_qs.values_list("id", flat=True))
    user_filter = params.get("user")

    entries = TimeEntry.objects.filter(organization=org, project_id__in=project_ids, date__gte=start, date__lte=end,
                                       timer_state=TimeEntry.TimerState.STOPPED).exclude(status=TimeEntry.Status.REJECTED)
    if user_filter:
        entries = entries.filter(user_id=user_filter)
    hours = entries.aggregate(total=Sum("duration_seconds"), billable=Sum("duration_seconds", filter=Q(billable=True)))
    billable_value = entries.filter(billable=True).values(currency=F("project__currency")).annotate(t=Sum(_value_expr()))
    labor_cost = entries.values(currency=F("project__currency")).annotate(t=Sum(_value_expr("cost_rate")))

    issued_lines = InvoiceLine.objects.filter(invoice__organization=org, project_id__in=project_ids,
                                              invoice__issue_date__gte=start, invoice__issue_date__lte=end) \
        .exclude(invoice__status__in=[Invoice.Status.DRAFT, Invoice.Status.VOID])
    invoiced = issued_lines.values(currency=F("invoice__currency")).annotate(t=Sum("amount"))

    full_scope = membership.is_admin and not params.get("client") and not params.get("project")
    # Receivables (collected, outstanding, overdue, aging) are invoice-level data: billing users only. Filters
    # narrow the role's scope; they never widen it.
    invoices = Invoice.objects.filter(organization=org)
    if params.get("client"):
        invoices = invoices.filter(client_id=params["client"])
    if not membership.is_admin or params.get("project"):
        invoices = invoices.filter(pk__in=InvoiceLine.objects.filter(project_id__in=project_ids).values("invoice_id"))
    if not membership.has_billing_access:
        invoices = invoices.none()
    payments = Payment.objects.filter(organization=org, status=Payment.Status.SUCCEEDED, received_at__date__gte=start,
                                      received_at__date__lte=end, invoice__in=invoices)
    collected = payments.values("currency").annotate(t=Sum("amount"))
    today = timezone.localdate()
    open_inv = invoices.filter(status__in=Invoice.OPEN_STATUSES, amount_due__gt=0)
    aging = defaultdict(lambda: defaultdict(lambda: ZERO))
    for inv in open_inv.only("currency", "amount_due", "due_date"):
        days = (today - inv.due_date).days
        bucket = "current" if days <= 0 else "1_30" if days <= 30 else "31_60" if days <= 60 else "61_90" if days <= 90 else "90_plus"
        aging[inv.currency][bucket] += inv.amount_due
    aging_out = [{"currency": c, **{k: str(q2(v)) for k, v in b.items()}} for c, b in aging.items()]

    expenses = Expense.objects.filter(organization=org, date__gte=start, date__lte=end).exclude(status=Expense.Status.REJECTED)
    if not full_scope:
        expenses = expenses.filter(project_id__in=project_ids)
    if user_filter:
        expenses = expenses.filter(user_id=user_filter)
    by_category = [{"category": r["category__name"] or "Uncategorized", "currency": r["currency"],
                    "amount": str(q2(r["t"])), "billable": str(q2(r["b"] or ZERO))}
                   for r in expenses.values("category__name", "currency").annotate(
                       t=Sum("amount"), b=Sum("billable_amount", filter=Q(billable=True))).order_by("-t")]

    # Per-project profitability (estimated) and budget utilization.
    proj_list = list(projects_qs.select_related("client"))
    data = metrics.collect([p.pk for p in proj_list])
    projects_out = []
    for p in proj_list:
        computed = metrics.full(p, data[p.pk])
        b = computed["budget"]
        projects_out.append({"id": p.pk, "code": p.code, "name": p.name, "client": p.client.name,
                             "status": p.status, "project_type": p.project_type, "currency": p.currency,
                             "health": computed["health"]["status"], "progress": computed["progress"]["percent"],
                             **{k: b[k] for k in ("hours_tracked", "hours_budget", "hours_percent", "fees_used",
                                                  "fees_budget", "fees_percent", "billable_value", "invoiced",
                                                  "collected", "labor_cost", "expense_cost", "total_cost",
                                                  "revenue_basis", "revenue_basis_label", "estimated_margin",
                                                  "estimated_margin_percent")}})

    # Revenue and cost by client (period).
    clients = defaultdict(lambda: {"invoiced": defaultdict(lambda: ZERO), "collected": defaultdict(lambda: ZERO),
                                   "labor_cost": defaultdict(lambda: ZERO), "expenses": defaultdict(lambda: ZERO),
                                   "hours": 0})
    names = dict(Client.objects.filter(organization=org).values_list("id", "name"))
    for r in issued_lines.values("invoice__client_id", "invoice__currency").annotate(t=Sum("amount")):
        clients[r["invoice__client_id"]]["invoiced"][r["invoice__currency"]] += r["t"] or ZERO
    for r in payments.values("invoice__client_id", "currency").annotate(t=Sum("amount")):
        clients[r["invoice__client_id"]]["collected"][r["currency"]] += r["t"] or ZERO
    for r in entries.values("project__client_id", "project__currency").annotate(t=Sum(_value_expr("cost_rate")), s=Sum("duration_seconds")):
        c = clients[r["project__client_id"]]
        c["labor_cost"][r["project__currency"]] += r["t"] or ZERO
        c["hours"] += r["s"] or 0
    for r in expenses.filter(client__isnull=False).values("client_id", "currency").annotate(t=Sum("amount")):
        clients[r["client_id"]]["expenses"][r["currency"]] += r["t"] or ZERO
    clients_out = [{"id": cid, "name": names.get(cid, "—"), "hours": str(hours_from_seconds(v["hours"])),
                    **{k: money_map(dict(v[k])) for k in ("invoiced", "collected", "labor_cost", "expenses")}}
                   for cid, v in clients.items() if cid]
    clients_out.sort(key=lambda c: c["name"])
    if not membership.has_billing_access:
        for row in projects_out:
            row.pop("collected", None)

    # Team utilization for the period.
    member_ids = [int(user_filter)] if user_filter else None
    team = workload(org, start, end, member_ids)
    if not membership.is_admin:
        allowed = set(Membership.objects.filter(organization=org, user__project_memberships__project__in=projects_qs)
                      .values_list("user_id", flat=True))
        team = [t for t in team if t["user"]["id"] in allowed]

    approvals = [{"status": r["status"], "count": r["c"], "hours": str(hours_from_seconds(r["s"] or 0))}
                 for r in entries.values("status").annotate(c=Count("id"), s=Sum("duration_seconds"))]
    approvals_by_user = defaultdict(dict)
    for r in entries.values("user__full_name", "status").annotate(s=Sum("duration_seconds")):
        approvals_by_user[r["user__full_name"]][r["status"]] = str(hours_from_seconds(r["s"] or 0))

    variance = []
    task_hours = dict(entries.filter(task__isnull=False).values("task_id").annotate(s=Sum("duration_seconds"))
                      .values_list("task_id", "s"))
    for t in Task.objects.filter(pk__in=list(task_hours), estimated_hours__gt=0).select_related("project"):
        actual = hours_from_seconds(task_hours[t.pk])
        variance.append({"task_id": t.pk, "title": t.title, "project": t.project.code, "estimated": str(t.estimated_hours),
                         "actual": str(actual), "difference": str(q2(actual - t.estimated_hours)), "status": t.status})
    variance.sort(key=lambda v: -abs(Decimal(v["difference"])))

    months = months_back(6, end if end <= today else today)
    currencies = {p.currency for p in proj_list} or {org.default_currency}
    series = {c: _month_series(org, c, None if full_scope else project_ids, months) for c in sorted(currencies)}
    if not membership.has_billing_access:
        for rows in series.values():
            for row in rows:
                row.pop("collected", None)

    return {
        "period": {"start": start.isoformat(), "end": end.isoformat()},
        "hours": {"total": str(hours_from_seconds(hours["total"] or 0)),
                  "billable": str(hours_from_seconds(hours["billable"] or 0)),
                  "non_billable": str(hours_from_seconds((hours["total"] or 0) - (hours["billable"] or 0)))},
        "billable_value": _money_rows(billable_value),
        "invoiced": _money_rows(invoiced),
        "collected": _money_rows(collected),
        "labor_cost": _money_rows(labor_cost),
        "expenses_total": _money_rows(expenses.values("currency").annotate(t=Sum("amount"))),
        "outstanding": _money_rows(open_inv.values("currency").annotate(t=Sum("amount_due"))),
        "overdue": _money_rows(open_inv.filter(due_date__lt=today).values("currency").annotate(t=Sum("amount_due"))),
        "aging": aging_out,
        "expenses_by_category": by_category,
        "projects": projects_out,
        "clients": clients_out,
        "team": team,
        "approvals": approvals,
        "approvals_by_user": [{"user": u, **s} for u, s in sorted(approvals_by_user.items())],
        "estimate_variance": variance[:25],
        "monthly": series,
        "definitions": {
            "billable_value": "Estimate: billable hours × recorded billing rates, before invoicing.",
            "invoiced": "Pre-tax line amounts on issued invoices dated in the period.",
            "collected": "Payments actually received in the period (cash).",
            "labor_cost": "Estimate: tracked hours × each person's internal cost rate.",
            "estimated_margin": "Estimate: revenue basis (contract value, billable fees or invoiced) minus labor and expense costs.",
        },
    }


def calendar_events(membership: Membership, start: date, end: date) -> list[dict]:
    org = membership.organization
    events = []
    projects = visible_projects(membership)
    tasks = Task.objects.filter(project__in=projects, due_date__gte=start, due_date__lte=end).select_related("project", "assignee")
    if membership.role == Role.MEMBER:
        tasks = tasks.filter(assignee=membership.user)
    for t in tasks:
        events.append({"id": f"task-{t.pk}", "type": "task", "date": t.due_date, "title": t.title,
                       "subtitle": f"{t.project.code}-{t.number}" + (f" · {t.assignee.full_name}" if t.assignee_id else ""),
                       "status": t.status, "color": t.project.color, "link": f"/tasks?task={t.pk}",
                       "done": t.status in Task.CLOSED_STATUSES})
    for m in Milestone.objects.filter(project__in=projects, due_date__gte=start, due_date__lte=end).select_related("project"):
        events.append({"id": f"milestone-{m.pk}", "type": "milestone", "date": m.due_date, "title": m.name,
                       "subtitle": m.project.code, "status": m.status, "color": m.project.color,
                       "link": f"/projects/{m.project_id}?tab=milestones", "done": m.status == "completed"})
    for p in projects.filter(deadline__gte=start, deadline__lte=end):
        events.append({"id": f"project-{p.pk}", "type": "deadline", "date": p.deadline, "title": f"{p.name} deadline",
                       "subtitle": p.code, "status": p.status, "color": p.color, "link": f"/projects/{p.pk}",
                       "done": p.status == "completed"})
    if membership.has_billing_access:
        for i in Invoice.objects.filter(organization=org, status__in=Invoice.OPEN_STATUSES, due_date__gte=start,
                                        due_date__lte=end).select_related("client"):
            events.append({"id": f"invoice-{i.pk}", "type": "invoice", "date": i.due_date, "title": f"{i.number} due",
                           "subtitle": f"{i.client.name} · {i.currency} {i.amount_due}", "status": i.display_status,
                           "color": "#0EA5E9", "link": f"/invoices/{i.pk}", "done": False})
    if membership.is_manager:
        for lead in Lead.objects.filter(organization=org, next_follow_up__gte=start, next_follow_up__lte=end,
                                        stage__in=Lead.OPEN_STAGES):
            events.append({"id": f"lead-{lead.pk}", "type": "follow_up", "date": lead.next_follow_up,
                           "title": f"Follow up: {lead.company}", "subtitle": lead.title, "status": lead.stage,
                           "color": "#8B5CF6", "link": "/crm", "done": False})
        for d in visible_documents(membership).filter(status__in=Document.AWAITING_STATUSES, expires_at__gte=start,
                                                      expires_at__lte=end).select_related("client"):
            events.append({"id": f"document-{d.pk}", "type": "document", "date": d.expires_at,
                           "title": f"{d.title} expires", "subtitle": d.client.name, "status": d.status,
                           "color": "#F59E0B", "link": f"/documents/{d.pk}", "done": False})
    events.sort(key=lambda e: (e["date"], e["type"]))
    return events


def search(membership: Membership, term: str) -> dict:
    org = membership.organization
    term = term.strip()
    if len(term) < 2:
        return {"results": []}
    results = []
    projects = visible_projects(membership)
    for p in projects.filter(Q(name__icontains=term) | Q(code__icontains=term)).select_related("client")[:5]:
        results.append({"type": "project", "id": p.pk, "title": f"{p.code} · {p.name}", "subtitle": p.client.name,
                        "link": f"/projects/{p.pk}"})
    task_q = Q(title__icontains=term)
    if "-" in term and term.rsplit("-", 1)[1].isdigit():
        code, number = term.rsplit("-", 1)
        task_q |= Q(project__code__iexact=code, number=int(number))
    for t in Task.objects.filter(task_q, project__in=projects).select_related("project")[:6]:
        results.append({"type": "task", "id": t.pk, "title": t.title, "subtitle": f"{t.project.code}-{t.number}",
                        "link": f"/tasks?task={t.pk}"})
    if membership.is_manager:
        for c in Client.objects.filter(organization=org).filter(Q(name__icontains=term) | Q(email__icontains=term) |
                                                                Q(contact_name__icontains=term))[:5]:
            results.append({"type": "client", "id": c.pk, "title": c.name, "subtitle": c.contact_name or c.email,
                            "link": f"/clients/{c.pk}"})
        for lead in Lead.objects.filter(organization=org).filter(Q(title__icontains=term) | Q(company__icontains=term))[:4]:
            results.append({"type": "lead", "id": lead.pk, "title": lead.title, "subtitle": lead.company, "link": "/crm"})
        for d in visible_documents(membership).filter(title__icontains=term).select_related("client")[:4]:
            results.append({"type": "document", "id": d.pk, "title": d.title, "subtitle": d.client.name,
                            "link": f"/documents/{d.pk}"})
    if membership.has_billing_access:
        for i in Invoice.objects.filter(organization=org).filter(Q(number__icontains=term) | Q(client__name__icontains=term)).select_related("client")[:5]:
            results.append({"type": "invoice", "id": i.pk, "title": i.number, "subtitle": f"{i.client.name} · {i.currency} {i.total}",
                            "link": f"/invoices/{i.pk}"})
    return {"results": results}
