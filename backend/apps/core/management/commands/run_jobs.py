"""
Scheduled maintenance jobs. Run once a day (e.g. from cron) or keep running with --loop:

    python manage.py run_jobs            # run all jobs once
    python manage.py run_jobs --loop 3600

Every job is idempotent: notifications use dedupe keys and recurring invoices are unique per period.
"""

import logging
import time
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.core.notify import notify
from apps.documents.services import expire_overdue_documents
from apps.finance.invoicing import billing_users
from apps.finance.models import Invoice
from apps.finance.recurring import run_due_schedules
from apps.projects.models import Task

logger = logging.getLogger(__name__)


def notify_due_tasks() -> int:
    today = timezone.localdate()
    count = 0
    for task in (Task.objects.filter(due_date__in=[today, today + timedelta(days=1)], assignee__isnull=False)
                 .exclude(status__in=Task.CLOSED_STATUSES).select_related("project", "assignee", "organization")):
        when = "today" if task.due_date == today else "tomorrow"
        count += notify(organization=task.organization, recipients=[task.assignee], kind="task_due_soon",
                        title=f"{task.project.code}-{task.number} is due {when}: {task.title}",
                        link=f"/tasks?task={task.pk}", dedupe_key=f"task_due:{task.pk}:{task.due_date}")
    return count


def notify_invoices() -> int:
    from apps.crm.services import portal_users

    today = timezone.localdate()
    count = 0
    open_invoices = Invoice.objects.filter(status__in=Invoice.OPEN_STATUSES, amount_due__gt=0).select_related("client", "organization")
    for inv in open_invoices.filter(due_date=today + timedelta(days=3)):
        count += notify(organization=inv.organization, recipients=portal_users(inv.client) + billing_users(inv.organization),
                        kind="invoice_due_soon", title=f"Invoice {inv.number} is due in 3 days",
                        body=f"{inv.currency} {inv.amount_due} due {inv.due_date.isoformat()}",
                        link=f"/invoices/{inv.pk}", dedupe_key=f"invoice_due:{inv.pk}:{inv.due_date}")
    for inv in open_invoices.filter(due_date__lt=today):
        days = (today - inv.due_date).days
        if days in (1, 7, 14, 30) or days % 30 == 0:
            count += notify(organization=inv.organization, recipients=billing_users(inv.organization),
                            kind="invoice_overdue", title=f"Invoice {inv.number} is {days} day(s) overdue",
                            body=f"{inv.client.name} owes {inv.currency} {inv.amount_due}",
                            link=f"/invoices/{inv.pk}", dedupe_key=f"invoice_overdue:{inv.pk}:{days}")
            count += notify(organization=inv.organization, recipients=portal_users(inv.client), kind="invoice_overdue",
                            title=f"Invoice {inv.number} is overdue", body=f"{inv.currency} {inv.amount_due} outstanding",
                            link=f"/portal/invoices/{inv.pk}", dedupe_key=f"invoice_overdue:{inv.pk}:{days}")
    return count


JOBS = [
    ("recurring invoices", run_due_schedules),
    ("expired documents", expire_overdue_documents),
    ("task reminders", notify_due_tasks),
    ("invoice reminders", notify_invoices),
]


class Command(BaseCommand):
    help = "Runs scheduled jobs: recurring invoices, reminders and document expiry."

    def add_arguments(self, parser):
        parser.add_argument("--loop", type=int, default=0, help="Repeat every N seconds instead of exiting.")

    def handle(self, *args, **options):
        while True:
            for name, job in JOBS:
                try:
                    result = job()
                    self.stdout.write(f"[{timezone.now():%Y-%m-%d %H:%M:%S}] {name}: {result}")
                except Exception:
                    logger.exception("Job '%s' failed", name)
            if not options["loop"]:
                break
            time.sleep(options["loop"])
