"""
Project metrics computed from persisted records, in bulk, so list views avoid N+1 queries.

Definitions (shown to users in the UI as well):

* Tracked hours      - stopped time entries that are not rejected (draft, submitted, approved).
* Billable value     - sum over billable tracked entries of hours x the entry's bill rate (estimate until invoiced).
* Fees used          - billable value + chargeable amount of billable expenses; compared with `budget_amount`.
* Hours used         - tracked hours compared with `budget_hours`.
* Labor cost         - tracked hours x each person's internal cost rate (estimate).
* Expense cost       - internal cost of non-rejected expenses (actual).
* Invoiced           - pre-tax invoice line amounts for this project on issued (non-draft, non-void) invoices.
* Collected          - invoiced line amounts allocated pro-rata by each invoice's paid share.
* Estimated margin   - revenue basis (fixed: contract value; T&M: fees used; retainer: invoiced) - total cost.
"""

from collections import defaultdict
from decimal import Decimal

from django.db.models import Count, DecimalField, ExpressionWrapper, F, Min, Q, Sum, Value
from django.db.models.functions import Round
from django.utils import timezone

from apps.core.money import ZERO, hours_from_seconds, q2

THRESHOLDS = (75, 90, 100)
_DEC = DecimalField(max_digits=18, decimal_places=4)


def _pct(used: Decimal, budget: Decimal) -> Decimal | None:
    if not budget or budget <= 0:
        return None
    return (used / budget * 100).quantize(Decimal("0.1"))


def _amount_expr(rate_field: str):
    return Round(ExpressionWrapper(F("duration_seconds") * F(rate_field) / Value(Decimal(3600)), output_field=_DEC), 2)


def collect(project_ids) -> dict[int, dict]:
    from apps.finance.models import Expense, Invoice, InvoiceLine
    from apps.timetracking.models import TimeEntry

    from .models import Milestone, Task

    ids = list(project_ids)
    today = timezone.localdate()
    data: dict[int, dict] = {
        pid: {
            "seconds": 0, "billable_seconds": 0, "billable_value": ZERO, "labor_cost": ZERO,
            "approved_unbilled_seconds": 0, "approved_unbilled_value": ZERO, "pending_seconds": 0,
            "tasks": defaultdict(int), "tasks_open_overdue": 0, "estimate_hours": ZERO, "done_estimate_hours": ZERO,
            "milestones_total": 0, "milestones_done": 0, "milestones_overdue": 0, "oldest_overdue_milestone": None,
            "expense_cost": ZERO, "billable_expenses": ZERO,
            "invoiced": ZERO, "collected": ZERO, "month_seconds": 0, "month_value": ZERO,
        }
        for pid in ids
    }
    if not ids:
        return data

    time_rows = (
        TimeEntry.objects.filter(project_id__in=ids, timer_state=TimeEntry.TimerState.STOPPED)
        .exclude(status=TimeEntry.Status.REJECTED)
        .values("project_id", "billable", "status", "invoice_line_id")
        .annotate(seconds=Sum("duration_seconds"), value=Sum(_amount_expr("bill_rate")), cost=Sum(_amount_expr("cost_rate")))
    )
    # Rows are split by status/billable/invoice line; each row is accumulated into the project totals.
    for row in time_rows:
        d = data[row["project_id"]]
        seconds = row["seconds"] or 0
        d["seconds"] += seconds
        d["labor_cost"] += row["cost"] or ZERO
        if row["status"] in (TimeEntry.Status.DRAFT, TimeEntry.Status.SUBMITTED):
            d["pending_seconds"] += seconds
        if row["billable"]:
            d["billable_seconds"] += seconds
            d["billable_value"] += row["value"] or ZERO
            if row["status"] == TimeEntry.Status.APPROVED and row["invoice_line_id"] is None:
                d["approved_unbilled_seconds"] += seconds
                d["approved_unbilled_value"] += row["value"] or ZERO

    month_rows = (
        TimeEntry.objects.filter(project_id__in=ids, timer_state=TimeEntry.TimerState.STOPPED, date__gte=today.replace(day=1),
                                 date__lte=today)
        .exclude(status=TimeEntry.Status.REJECTED).values("project_id")
        .annotate(seconds=Sum("duration_seconds"), value=Sum(_amount_expr("bill_rate"), filter=Q(billable=True)))
    )
    for row in month_rows:
        data[row["project_id"]]["month_seconds"] = row["seconds"] or 0
        data[row["project_id"]]["month_value"] = row["value"] or ZERO

    task_rows = Task.objects.filter(project_id__in=ids).values("project_id", "status").annotate(
        count=Count("id"), est=Sum("estimated_hours"))
    for row in task_rows:
        d = data[row["project_id"]]
        d["tasks"][row["status"]] += row["count"]
        if row["status"] != Task.Status.CANCELLED:
            d["estimate_hours"] += row["est"] or ZERO
        if row["status"] == Task.Status.DONE:
            d["done_estimate_hours"] += row["est"] or ZERO
    overdue_tasks = (Task.objects.filter(project_id__in=ids, due_date__lt=today)
                     .exclude(status__in=Task.CLOSED_STATUSES).values("project_id").annotate(count=Count("id")))
    for row in overdue_tasks:
        data[row["project_id"]]["tasks_open_overdue"] = row["count"]

    milestone_rows = Milestone.objects.filter(project_id__in=ids).values("project_id").annotate(
        total=Count("id"),
        done=Count("id", filter=Q(status=Milestone.Status.COMPLETED)),
        overdue=Count("id", filter=Q(due_date__lt=today) & ~Q(status=Milestone.Status.COMPLETED)),
        oldest=Min("due_date", filter=Q(due_date__lt=today) & ~Q(status=Milestone.Status.COMPLETED)),
    )
    for row in milestone_rows:
        d = data[row["project_id"]]
        d["milestones_total"] = row["total"]
        d["milestones_done"] = row["done"]
        d["milestones_overdue"] = row["overdue"]
        d["oldest_overdue_milestone"] = row["oldest"]

    expense_rows = (Expense.objects.filter(project_id__in=ids).exclude(status=Expense.Status.REJECTED)
                    .values("project_id").annotate(cost=Sum("amount"),
                                                   billable=Sum("billable_amount", filter=Q(billable=True))))
    for row in expense_rows:
        d = data[row["project_id"]]
        d["expense_cost"] = row["cost"] or ZERO
        d["billable_expenses"] = row["billable"] or ZERO

    issued = ~Q(invoice__status__in=[Invoice.Status.DRAFT, Invoice.Status.VOID])
    for row in InvoiceLine.objects.filter(issued, project_id__in=ids).values(
            "project_id", "amount", "invoice__total", "invoice__amount_paid"):
        d = data[row["project_id"]]
        d["invoiced"] += row["amount"]
        total = row["invoice__total"] or ZERO
        if total > 0:
            d["collected"] += q2(row["amount"] * min(row["invoice__amount_paid"], total) / total)
    return data


def progress(project, m: dict) -> dict:
    tasks = m["tasks"]
    total = sum(count for status, count in tasks.items() if status != "cancelled")
    done = tasks.get("done", 0)
    if total:
        percent = round(done / total * 100)
        basis = "tasks"
    elif m["milestones_total"]:
        percent = round(m["milestones_done"] / m["milestones_total"] * 100)
        basis = "milestones"
    else:
        percent = 100 if project.status == "completed" else 0
        basis = "none"
    return {"percent": percent, "basis": basis, "tasks_total": total, "tasks_done": done,
            "tasks_overdue": m["tasks_open_overdue"], "milestones_total": m["milestones_total"],
            "milestones_done": m["milestones_done"], "milestones_overdue": m["milestones_overdue"]}


def budget(project, m: dict, prog: dict | None = None) -> dict:
    prog = prog or progress(project, m)
    hours = hours_from_seconds(m["seconds"])
    billable_hours = hours_from_seconds(m["billable_seconds"])
    fees_used = q2(m["billable_value"] + m["billable_expenses"])
    total_cost = q2(m["labor_cost"] + m["expense_cost"])
    period = "project"
    if project.project_type == "retainer":
        # Retainer budgets renew monthly: measure this month's usage against the monthly allowance.
        period = "month"
        fees_used = q2(m["month_value"])
        budget_amount = project.retainer_amount or project.budget_amount
        budget_hours = project.retainer_hours or project.budget_hours
        period_hours = hours_from_seconds(m["month_seconds"])
        fees_pct = _pct(fees_used, budget_amount)
        hours_pct = _pct(period_hours, budget_hours)
    else:
        budget_amount, budget_hours, period_hours = project.budget_amount, project.budget_hours, hours
        fees_pct = _pct(fees_used, project.budget_amount)
        hours_pct = _pct(hours, project.budget_hours)
    expenses_pct = _pct(m["expense_cost"], project.estimated_expenses)
    used_pcts = [p for p in (fees_pct, hours_pct) if p is not None]
    used_pct = max(used_pcts) if used_pcts else None

    if project.project_type == "fixed":
        revenue_basis = project.budget_amount
        revenue_basis_label = "Contract value"
    elif project.project_type == "retainer":
        revenue_basis = q2(m["invoiced"])
        revenue_basis_label = "Invoiced to date"
    else:
        revenue_basis = fees_used
        revenue_basis_label = "Billable time & expenses"
    est_margin = q2(revenue_basis - total_cost)
    margin_pct = (est_margin / revenue_basis * 100).quantize(Decimal("0.1")) if revenue_basis > 0 else None

    projected_fees = None
    if prog["percent"] and prog["percent"] > 0 and project.status not in ("completed", "cancelled"):
        projected_fees = q2(fees_used / Decimal(prog["percent"]) * 100)

    return {
        "currency": project.currency,
        "budget_period": period,
        "hours_used": str(period_hours),
        "hours_tracked": str(hours),
        "hours_billable": str(billable_hours),
        "hours_non_billable": str(q2(hours - billable_hours)),
        "hours_pending_approval": str(hours_from_seconds(m["pending_seconds"])),
        "hours_budget": str(budget_hours),
        "hours_percent": str(hours_pct) if hours_pct is not None else None,
        "billable_value": str(q2(m["billable_value"])),
        "billable_expenses": str(q2(m["billable_expenses"])),
        "fees_used": str(fees_used),
        "fees_budget": str(budget_amount),
        "fees_percent": str(fees_pct) if fees_pct is not None else None,
        "fees_remaining": str(q2(budget_amount - fees_used)) if budget_amount else None,
        "used_percent": str(used_pct) if used_pct is not None else None,
        "alert_level": alert_level(used_pct),
        "expense_cost": str(q2(m["expense_cost"])),
        "expenses_estimated": str(project.estimated_expenses),
        "expenses_percent": str(expenses_pct) if expenses_pct is not None else None,
        "labor_cost": str(q2(m["labor_cost"])),
        "total_cost": str(total_cost),
        "invoiced": str(q2(m["invoiced"])),
        "collected": str(q2(m["collected"])),
        "unbilled_approved_value": str(q2(m["approved_unbilled_value"])),
        "revenue_basis": str(q2(revenue_basis)),
        "revenue_basis_label": revenue_basis_label,
        "estimated_margin": str(est_margin),
        "estimated_margin_percent": str(margin_pct) if margin_pct is not None else None,
        "projected_fees_at_completion": str(projected_fees) if projected_fees is not None else None,
    }


def alert_level(used_pct) -> int:
    if used_pct is None:
        return 0
    level = 0
    for threshold in THRESHOLDS:
        if used_pct >= threshold:
            level = threshold
    return level


_BUDGET_REASON = {"critical": "The budget is exceeded.", "at_risk": "The budget is nearly used up.",
                  "ok": "The budget is on track."}


def redact_health(h: dict) -> dict:
    """Health as shown to people who cannot see the project's finances: the budget signal keeps its level
    but loses the fee percentage."""
    return {**h, "signals": [{**sig, "reason": _BUDGET_REASON[sig["level"]]} if sig["key"] == "budget" else sig
                             for sig in h["signals"]]}


def health(project, m: dict, prog: dict | None = None, bud: dict | None = None) -> dict:
    """Explainable health: every signal has a level and a human-readable reason."""
    prog = prog or progress(project, m)
    bud = bud or budget(project, m, prog)
    if project.status in ("completed", "cancelled"):
        return {"status": "closed", "signals": [{"key": "status", "level": "ok",
                                                 "reason": f"Project is {project.get_status_display().lower()}."}]}
    today = timezone.localdate()
    signals = []

    def add(key, level, reason):
        signals.append({"key": key, "level": level, "reason": reason})

    scope = "this month's retainer" if bud.get("budget_period") == "month" else "the fee budget"
    fees_pct = Decimal(bud["fees_percent"]) if bud["fees_percent"] else None
    if fees_pct is not None:
        if fees_pct >= 100:
            add("budget", "critical", f"Budget exceeded: {fees_pct}% of {scope} is used.")
        elif fees_pct >= 90:
            add("budget", "at_risk", f"{fees_pct}% of {scope} is used.")
        else:
            add("budget", "ok", f"{fees_pct}% of {scope} is used.")
    hours_pct = Decimal(bud["hours_percent"]) if bud["hours_percent"] else None
    if hours_pct is not None:
        if hours_pct >= 100:
            add("hours", "critical", f"Hour budget exceeded: {hours_pct}% of planned hours tracked.")
        elif hours_pct >= 90:
            add("hours", "at_risk", f"{hours_pct}% of planned hours tracked.")
        else:
            add("hours", "ok", f"{hours_pct}% of planned hours tracked.")

    overdue_ms = prog["milestones_overdue"]
    if overdue_ms:
        oldest = m.get("oldest_overdue_milestone")
        days = (today - oldest).days if oldest else 0
        level = "critical" if overdue_ms >= 2 or days > 14 else "at_risk"
        add("milestones", level, f"{overdue_ms} milestone(s) overdue" + (f", oldest by {days} days." if days else "."))
    elif prog["milestones_total"]:
        add("milestones", "ok", "No overdue milestones.")

    overdue_tasks = prog["tasks_overdue"]
    open_tasks = prog["tasks_total"] - prog["tasks_done"]
    if overdue_tasks:
        ratio = overdue_tasks / open_tasks if open_tasks else 1
        level = "critical" if overdue_tasks >= 5 or ratio >= 0.3 else "at_risk"
        add("tasks", level, f"{overdue_tasks} of {open_tasks} open task(s) are past their due date.")
    elif prog["tasks_total"]:
        add("tasks", "ok", "No overdue tasks.")

    if project.deadline:
        if today > project.deadline:
            add("schedule", "critical", f"Deadline passed on {project.deadline.isoformat()} with {prog['percent']}% complete.")
        elif project.start_date and project.deadline > project.start_date and today >= project.start_date:
            span = (project.deadline - project.start_date).days
            elapsed = round((today - project.start_date).days / span * 100)
            gap = elapsed - prog["percent"]
            if gap >= 30:
                add("schedule", "at_risk", f"Schedule slipping: {elapsed}% of the timeline elapsed, {prog['percent']}% complete.")
            else:
                add("schedule", "ok", f"{elapsed}% of the timeline elapsed, {prog['percent']}% complete.")

    if any(s["level"] == "critical" for s in signals):
        status = "critical"
    elif any(s["level"] == "at_risk" for s in signals):
        status = "at_risk"
    else:
        status = "healthy"
    if not signals:
        signals.append({"key": "data", "level": "ok", "reason": "No budget, deadline or overdue work to flag yet."})
    return {"status": status, "signals": signals}


def full(project, m: dict) -> dict:
    prog = progress(project, m)
    bud = budget(project, m, prog)
    return {"progress": prog, "budget": bud, "health": health(project, m, prog, bud)}


def for_project(project) -> dict:
    return full(project, collect([project.pk])[project.pk])


def retainer_usage(project, month_start=None) -> dict | None:
    """Hours tracked against a retainer's monthly allowance for the current month."""
    from apps.timetracking.models import TimeEntry

    if project.project_type != "retainer" or not project.retainer_hours:
        return None
    today = timezone.localdate()
    start = month_start or today.replace(day=1)
    seconds = (TimeEntry.objects.filter(project=project, date__gte=start, date__lte=today,
                                        timer_state=TimeEntry.TimerState.STOPPED)
               .exclude(status=TimeEntry.Status.REJECTED).aggregate(s=Sum("duration_seconds"))["s"] or 0)
    hours = hours_from_seconds(seconds)
    return {"month_start": start.isoformat(), "hours_used": str(hours), "hours_included": str(project.retainer_hours),
            "percent": str(_pct(hours, project.retainer_hours))}
