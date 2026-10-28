"""
Revenue Leak Radar. Every alert is derived from persisted records, names those records, and
explains the rule that produced it. The radar only flags what the data can show - e.g. a task
marked done with an estimate but no tracked time - and never guesses at unrecorded work.
"""

from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db.models import Count, Q, Sum
from django.utils import timezone

from apps.core.money import ZERO, hours_from_seconds, money_map, q2
from apps.finance.models import Expense, Invoice
from apps.projects import metrics
from apps.projects.access import managed_projects
from apps.projects.models import Milestone, Project, Task
from apps.timetracking.models import TimeEntry

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}


def _record(kind, obj_id, label, url):
    return {"type": kind, "id": obj_id, "label": label, "url": url}


def scope_projects(membership):
    if membership.is_admin:
        return Project.objects.filter(organization=membership.organization)
    return managed_projects(membership)


def radar(membership) -> dict:
    today = timezone.localdate()
    projects_qs = scope_projects(membership).select_related("client")
    projects = {p.pk: p for p in projects_qs}
    ids = list(projects)
    billing = membership.has_billing_access
    alerts: list[dict] = []

    def invoice_action(project):
        if billing:
            return {"kind": "generate_invoice", "label": "Create invoice draft",
                    "params": {"client": project.client_id, "projects": [project.pk]}}
        return {"kind": "link", "label": "Open project", "url": f"/projects/{project.pk}?tab=budget"}

    # 1. Approved billable time that has not been invoiced.
    unbilled = defaultdict(list)
    for e in (TimeEntry.objects.filter(project_id__in=ids, status=TimeEntry.Status.APPROVED, billable=True,
                                       invoice_line__isnull=True, timer_state=TimeEntry.TimerState.STOPPED)
              .select_related("user", "task").order_by("date")):
        unbilled[e.project_id].append(e)
    for pid, entries in unbilled.items():
        project = projects[pid]
        seconds = sum(e.duration_seconds for e in entries)
        value = q2(sum((e.billable_amount for e in entries), ZERO))
        oldest = entries[0].date
        age = (today - oldest).days
        alerts.append({
            "id": f"unbilled_time:{pid}", "type": "unbilled_time", "severity": "high" if age > 30 else "medium",
            "title": f"{hours_from_seconds(seconds)}h of approved billable time not invoiced on {project.code}",
            "explanation": f"{len(entries)} approved, billable time entries (oldest from {oldest.isoformat()}, {age} days ago) "
                           f"are not linked to any invoice. Estimated value at recorded rates: {project.currency} {value}.",
            "project": {"id": pid, "code": project.code, "name": project.name},
            "client": {"id": project.client_id, "name": project.client.name},
            "amount": [{"currency": project.currency, "amount": str(value)}],
            "records": [_record("time_entry", e.pk, f"{e.date.isoformat()} · {e.user.full_name} · {hours_from_seconds(e.duration_seconds)}h"
                                + (f" · {e.task.title}" if e.task_id else ""), f"/timesheets?tab=team&project={pid}")
                        for e in entries[:8]],
            "record_count": len(entries),
            "action": invoice_action(project),
        })

    # 2. Approved billable expenses that have not been invoiced.
    unbilled_exp = defaultdict(list)
    for x in Expense.objects.filter(project_id__in=ids, status=Expense.Status.APPROVED, billable=True,
                                    invoice_line__isnull=True).order_by("date"):
        unbilled_exp[x.project_id].append(x)
    for pid, expenses in unbilled_exp.items():
        project = projects[pid]
        value = q2(sum((x.billable_amount for x in expenses), ZERO))
        alerts.append({
            "id": f"unbilled_expenses:{pid}", "type": "unbilled_expenses",
            "severity": "medium" if (today - expenses[0].date).days <= 30 else "high",
            "title": f"{len(expenses)} billable expense(s) not invoiced on {project.code}",
            "explanation": f"Approved expenses marked billable to the client have not been added to an invoice "
                           f"(chargeable total {project.currency} {value}).",
            "project": {"id": pid, "code": project.code, "name": project.name},
            "client": {"id": project.client_id, "name": project.client.name},
            "amount": [{"currency": project.currency, "amount": str(value)}],
            "records": [_record("expense", x.pk, f"{x.date.isoformat()} · {x.description} · {x.currency} {x.billable_amount}",
                                f"/expenses?tab=team&project={pid}") for x in expenses[:8]],
            "record_count": len(expenses),
            "action": invoice_action(project),
        })

    # 3. Completed fixed-fee milestones that have not been invoiced.
    for m in Milestone.objects.filter(project_id__in=ids, status=Milestone.Status.COMPLETED, amount__gt=0,
                                      invoice_line__isnull=True).select_related("project"):
        project = projects[m.project_id]
        alerts.append({
            "id": f"milestone:{m.pk}", "type": "uninvoiced_milestone", "severity": "high",
            "title": f"Completed milestone '{m.name}' not invoiced",
            "explanation": f"The milestone was completed{f' on {m.completed_at.date().isoformat()}' if m.completed_at else ''} "
                           f"and carries a billable amount of {project.currency} {m.amount}, but no invoice line references it.",
            "project": {"id": project.pk, "code": project.code, "name": project.name},
            "client": {"id": project.client_id, "name": project.client.name},
            "amount": [{"currency": project.currency, "amount": str(m.amount)}],
            "records": [_record("milestone", m.pk, m.name, f"/projects/{project.pk}?tab=milestones")],
            "record_count": 1,
            "action": invoice_action(project),
        })

    # 4. Billable time stuck in approval (cannot be invoiced until approved).
    stale = timezone.now() - timedelta(days=5)
    pending = defaultdict(list)
    for e in (TimeEntry.objects.filter(project_id__in=ids, status=TimeEntry.Status.SUBMITTED, billable=True,
                                       submitted_at__lt=stale)
              .select_related("user", "task").order_by("submitted_at")):
        pending[e.project_id].append(e)
    for pid, entries in pending.items():
        project = projects[pid]
        seconds = sum(e.duration_seconds for e in entries)
        days = (timezone.now() - entries[0].submitted_at).days
        url = f"/timesheets?tab=approvals&project={pid}"
        alerts.append({
            "id": f"pending_approval:{pid}", "type": "pending_approval", "severity": "low",
            "title": f"{hours_from_seconds(seconds)}h of billable time awaiting approval for 5+ days on {project.code}",
            "explanation": f"{len(entries)} submitted billable time entries (the oldest waiting {days} days) cannot be "
                           f"invoiced until they are approved.",
            "project": {"id": pid, "code": project.code, "name": project.name},
            "client": {"id": project.client_id, "name": project.client.name},
            "amount": [],
            "records": [_record("time_entry", e.pk, f"{e.date.isoformat()} · {e.user.full_name} · {hours_from_seconds(e.duration_seconds)}h"
                                + (f" · {e.task.title}" if e.task_id else ""), url)
                        for e in entries[:8]],
            "record_count": len(entries),
            "action": {"kind": "link", "label": "Review approvals", "url": url},
        })

    # 5. Completed billable tasks with an estimate but no tracked time.
    done_without_time = (Task.objects.filter(project_id__in=ids, status=Task.Status.DONE, billable=True,
                                             estimated_hours__gt=0)
                         .annotate(tracked_count=Count("time_entries", filter=~Q(time_entries__status="rejected")))
                         .filter(tracked_count=0).select_related("project", "assignee"))
    grouped = defaultdict(list)
    for t in done_without_time:
        grouped[t.project_id].append(t)
    for pid, tasks in grouped.items():
        project = projects[pid]
        est = sum((t.estimated_hours for t in tasks), Decimal(0))
        alerts.append({
            "id": f"done_no_time:{pid}", "type": "done_without_time", "severity": "medium",
            "title": f"{len(tasks)} completed billable task(s) on {project.code} have no time recorded",
            "explanation": f"These tasks are marked done and were estimated at {est}h in total, yet no time entries "
                           "exist for them. If work was performed, it may not have been tracked or billed.",
            "project": {"id": pid, "code": project.code, "name": project.name},
            "client": {"id": project.client_id, "name": project.client.name},
            "amount": [], "record_count": len(tasks),
            "records": [_record("task", t.pk, f"{project.code}-{t.number} {t.title} (est. {t.estimated_hours}h"
                                + (f", {t.assignee.full_name}" if t.assignee_id else "") + ")", f"/tasks?task={t.pk}")
                        for t in tasks[:8]],
            "action": {"kind": "link", "label": "Review tasks", "url": f"/projects/{pid}?tab=tasks"},
        })

    # 6. Budget consumption and 7. retainer allowances.
    open_ids = [pid for pid, p in projects.items() if p.status in Project.OPEN_STATUSES]
    data = metrics.collect(open_ids)
    for pid in open_ids:
        project = projects[pid]
        budget = metrics.budget(project, data[pid])
        used = Decimal(budget["used_percent"]) if budget["used_percent"] else None
        if used is not None and used >= 90 and project.project_type != Project.Type.RETAINER:  # retainers: see below
            exceeded = used >= 100
            fixed = project.project_type == Project.Type.FIXED
            alerts.append({
                "id": f"budget:{pid}", "type": "budget", "severity": "high" if exceeded else "medium",
                "title": f"{project.code} has {'exceeded' if exceeded else 'used'} {used}% of its budget",
                "explanation": (f"Fees used {project.currency} {budget['fees_used']} of {budget['fees_budget']}"
                                f" ({budget['fees_percent'] or '-'}%), hours {budget['hours_tracked']} of {budget['hours_budget']}"
                                f" ({budget['hours_percent'] or '-'}%). ")
                               + ("On a fixed-price project, work beyond the budget cannot be billed unless a change "
                                  "request is approved." if fixed else "Work beyond the budget may need client approval."),
                "project": {"id": pid, "code": project.code, "name": project.name},
                "client": {"id": project.client_id, "name": project.client.name},
                "amount": [], "records": [_record("project", pid, project.name, f"/projects/{pid}?tab=budget")],
                "record_count": 1,
                "action": {"kind": "link", "label": "Create change request" if fixed else "Open budget",
                           "url": f"/projects/{pid}?tab={'changes' if fixed else 'budget'}"},
            })
        usage = metrics.retainer_usage(project)
        if usage and usage["percent"] and Decimal(usage["percent"]) >= 80:
            pct = Decimal(usage["percent"])
            alerts.append({
                "id": f"retainer:{pid}", "type": "retainer_limit", "severity": "high" if pct >= 100 else "medium",
                "title": f"{project.code} retainer at {pct}% of this month's hours",
                "explanation": f"{usage['hours_used']}h tracked since {usage['month_start']} against "
                               f"{usage['hours_included']}h included in the retainer. Hours beyond the allowance should be "
                               "agreed and billed separately.",
                "project": {"id": pid, "code": project.code, "name": project.name},
                "client": {"id": project.client_id, "name": project.client.name},
                "amount": [], "records": [_record("project", pid, project.name, f"/projects/{pid}?tab=budget")],
                "record_count": 1,
                "action": {"kind": "link", "label": "Open project", "url": f"/projects/{pid}?tab=budget"},
            })

    # 8. Significant estimate overruns.
    tracked_by_task = dict(TimeEntry.objects.filter(project_id__in=open_ids, task__isnull=False)
                           .exclude(status=TimeEntry.Status.REJECTED).values("task_id")
                           .annotate(s=Sum("duration_seconds")).values_list("task_id", "s"))
    overruns = defaultdict(list)
    for t in Task.objects.filter(pk__in=list(tracked_by_task), estimated_hours__gt=0).select_related("project"):
        actual = hours_from_seconds(tracked_by_task[t.pk])
        if actual > t.estimated_hours * Decimal("1.25") and actual - t.estimated_hours >= 2:
            overruns[t.project_id].append((t, actual))
    for pid, items in overruns.items():
        project = projects[pid]
        over = sum((a - t.estimated_hours for t, a in items), Decimal(0))
        fixed = project.project_type == Project.Type.FIXED
        alerts.append({
            "id": f"overrun:{pid}", "type": "estimate_overrun", "severity": "medium" if fixed else "low",
            "title": f"{len(items)} task(s) on {project.code} exceed their estimates by {q2(over)}h",
            "explanation": "Tracked time is more than 25% (and at least 2h) above the estimate. "
                           + ("On fixed-price work this effort is absorbed as cost." if fixed
                              else "Confirm the client expects the additional billable hours."),
            "project": {"id": pid, "code": project.code, "name": project.name},
            "client": {"id": project.client_id, "name": project.client.name},
            "amount": [], "record_count": len(items),
            "records": [_record("task", t.pk, f"{t.title}: {a}h tracked vs {t.estimated_hours}h estimated", f"/tasks?task={t.pk}")
                        for t, a in sorted(items, key=lambda x: x[0].estimated_hours - x[1])[:8]],
            "action": {"kind": "link", "label": "Review tasks", "url": f"/projects/{pid}?tab=tasks"},
        })

    # 9. Overdue and partially paid invoices (billing users only).
    if billing:
        for inv in Invoice.objects.filter(organization=membership.organization, status__in=Invoice.OPEN_STATUSES,
                                          amount_due__gt=0).select_related("client"):
            overdue = inv.due_date < today
            partial = inv.status == Invoice.Status.PARTIALLY_PAID
            if not (overdue or partial):
                continue
            days = (today - inv.due_date).days
            alerts.append({
                "id": f"invoice:{inv.pk}", "type": "overdue_invoice" if overdue else "partially_paid",
                "severity": "high" if overdue and days > 30 else ("medium" if overdue else "low"),
                "title": f"Invoice {inv.number} {'overdue by ' + str(days) + ' days' if overdue else 'partially paid'}",
                "explanation": f"{inv.client.name} owes {inv.currency} {inv.amount_due} of {inv.total}"
                               + (f"; it was due on {inv.due_date.isoformat()}." if overdue else "."),
                "project": None, "client": {"id": inv.client_id, "name": inv.client.name},
                "amount": [{"currency": inv.currency, "amount": str(inv.amount_due)}],
                "records": [_record("invoice", inv.pk, inv.number, f"/invoices/{inv.pk}")], "record_count": 1,
                "action": {"kind": "link", "label": "Open invoice", "url": f"/invoices/{inv.pk}"},
            })

    alerts.sort(key=lambda a: (SEVERITY_ORDER[a["severity"]], a["type"]))
    potential = defaultdict(lambda: ZERO)
    for a in alerts:
        if a["type"] in ("unbilled_time", "unbilled_expenses", "uninvoiced_milestone"):
            for amt in a["amount"]:
                potential[amt["currency"]] += Decimal(amt["amount"])
    receivable = defaultdict(lambda: ZERO)
    for a in alerts:
        if a["type"] in ("overdue_invoice", "partially_paid"):
            for amt in a["amount"]:
                receivable[amt["currency"]] += Decimal(amt["amount"])
    counts = defaultdict(int)
    for a in alerts:
        counts[a["type"]] += 1
    return {
        "generated_at": timezone.now().isoformat(),
        "alerts": alerts,
        "summary": {
            "total": len(alerts),
            "high": sum(1 for a in alerts if a["severity"] == "high"),
            "by_type": dict(counts),
            "unbilled_value": money_map(dict(potential)),
            "at_risk_receivables": money_map(dict(receivable)),
        },
    }
