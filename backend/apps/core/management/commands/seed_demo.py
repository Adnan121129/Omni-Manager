"""
Creates a realistic demonstration dataset. Demo data is isolated in workspaces flagged
`is_demo=True` and users with @demo.omnimanager.test addresses, and can be removed with --reset.

    python manage.py seed_demo            # create (fails if demo data exists)
    python manage.py seed_demo --reset    # delete demo data and recreate it
"""

import base64
import random
from datetime import datetime, time, timedelta
from decimal import Decimal

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from apps.accounts.models import Membership, Organization, Role, User
from apps.accounts.services import create_workspace
from apps.core.activity import log_activity
from apps.crm.models import Client, Interaction, Lead
from apps.documents import services as doc_services
from apps.documents.models import ContractTemplate, Document
from apps.finance import invoicing
from apps.finance.models import Expense, ExpenseCategory, Invoice, RecurringInvoiceSchedule
from apps.projects.models import ChangeRequest, Deliverable, Label, Milestone, Project, ProjectMember, Task, TaskDependency
from apps.projects.services import resolve_rates
from apps.timetracking.models import TimeEntry

DOMAIN = "demo.omnimanager.test"
# 1x1 transparent PNG used as a stand-in drawn signature in seeded signature records.
TINY_PNG = "data:image/png;base64," + base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")).decode()


def demo_password() -> str:
    return getattr(settings, "DEMO_PASSWORD", None) or "Demo!2345"


class Command(BaseCommand):
    help = "Seeds realistic demo data (two isolated workspaces, clients, projects, time, invoices, documents)."

    def add_arguments(self, parser):
        parser.add_argument("--reset", action="store_true", help="Delete existing demo data first.")
        parser.add_argument("--allow-non-debug", action="store_true",
                            help="Allow seeding when DJANGO_DEBUG is off (e.g. a staging demo). Never use in production.")

    def handle(self, *args, **options):
        if not settings.DEBUG and not options["allow_non_debug"]:
            raise CommandError("Refusing to create demo data with DJANGO_DEBUG off. "
                               "Pass --allow-non-debug for a dedicated demo/staging environment.")
        if options["reset"]:
            self.reset()
        elif Organization.objects.filter(is_demo=True).exists():
            raise CommandError("Demo data already exists. Use --reset to recreate it.")
        self.rng = random.Random(42)
        self.today = timezone.localdate()
        with transaction.atomic():
            self.seed_northwind()
            self.seed_contoso()
        pw = demo_password()
        self.stdout.write(self.style.SUCCESS("Demo data created. Sign in with any of these accounts:"))
        for email, label in [
            (f"olivia@{DOMAIN}", "Workspace owner (Northwind Studio)"),
            (f"marcus@{DOMAIN}", "Administrator"),
            (f"priya@{DOMAIN}", "Project manager"),
            (f"sam@{DOMAIN}", "Team member"),
            (f"jordan@acme.{DOMAIN}", "Client portal (Acme Corporation)"),
            (f"lena@globex.{DOMAIN}", "Client portal (Globex)"),
            (f"owner@contoso.{DOMAIN}", "Owner of a second, isolated workspace"),
        ]:
            self.stdout.write(f"  {email:<34} {label}")
        self.stdout.write(f"  Password for all demo accounts: {pw}")

    # ------------------------------------------------------------------ helpers
    def reset(self):
        demo_orgs = Organization.objects.filter(is_demo=True)
        for org in demo_orgs:
            # Delete in dependency order; PROTECT relations prevent a plain cascade.
            from apps.core.models import ActivityLog, Attachment, Comment, Notification
            from apps.documents.models import DocumentEvent, SignatureRecord
            from apps.finance.models import CheckoutSession, CreditNote, InvoiceLine, Payment, RecurringInvoiceRun

            SignatureRecord.objects.filter(document__organization=org).delete()
            DocumentEvent.objects.filter(document__organization=org).delete()
            Document.objects.filter(organization=org).delete()
            Payment.objects.filter(organization=org).delete()
            CreditNote.objects.filter(organization=org).delete()
            CheckoutSession.objects.filter(organization=org).delete()
            RecurringInvoiceRun.objects.filter(schedule__organization=org).delete()
            TimeEntry.objects.filter(organization=org).update(invoice_line=None)
            Expense.objects.filter(organization=org).update(invoice_line=None)
            Milestone.objects.filter(organization=org).update(invoice_line=None)
            InvoiceLine.objects.filter(invoice__organization=org).delete()
            Invoice.objects.filter(organization=org).delete()
            RecurringInvoiceSchedule.objects.filter(organization=org).delete()
            TimeEntry.objects.filter(organization=org).delete()
            Expense.objects.filter(organization=org).delete()
            for model in (Attachment, Comment, Notification, ActivityLog):
                model.objects.filter(organization=org).delete()
            Project.objects.filter(organization=org).delete()
            Membership.objects.filter(organization=org).delete()
            Client.objects.filter(organization=org).delete()
            org.delete()
        User.objects.filter(email__iendswith=DOMAIN).delete()
        self.stdout.write("Removed existing demo data.")

    def user(self, email, name, tz="America/New_York"):
        u = User.objects.create_user(email=email, password=demo_password(), full_name=name, timezone=tz)
        return u

    def member(self, org, user, role, title, cost, bill=None, capacity=40, client=None):
        return Membership.objects.create(organization=org, user=user, role=role, title=title, cost_rate=Decimal(cost),
                                         default_bill_rate=Decimal(bill) if bill else None,
                                         weekly_capacity_hours=Decimal(capacity), client=client)

    def days_ago(self, n):
        return self.today - timedelta(days=n)

    def at(self, d, hour=9, minute=0):
        return timezone.make_aware(datetime.combine(d, time(hour, minute)))

    def log_time(self, org, project, user, task, day, hours, status, desc="", billable=None):
        bill_rate, cost_rate = resolve_rates(organization=org, project=project, task=task, user=user)
        seconds = int(Decimal(str(hours)) * 3600)
        start = self.at(day, self.rng.choice([9, 10, 13, 14]))
        entry = TimeEntry.objects.create(
            organization=org, user=user, project=project, task=task, description=desc, date=day,
            started_at=start, ended_at=start + timedelta(seconds=seconds), duration_seconds=seconds,
            accumulated_seconds=seconds, source=self.rng.choice(["timer", "manual"]), timer_state="stopped",
            billable=task.billable if billable is None and task else (True if billable is None else billable),
            bill_rate=bill_rate, cost_rate=cost_rate, status=status,
        )
        now = timezone.now()
        if status in ("submitted", "approved", "rejected"):
            entry.submitted_at = self.at(day + timedelta(days=2), 17)
        if status == "approved":
            entry.approved_at = self.at(day + timedelta(days=3), 10)
            entry.approved_by = project.manager
        if status == "rejected":
            entry.rejected_at = now
            entry.rejected_by = project.manager
            entry.rejection_reason = "Please split this entry by task and add a short description."
        entry.save()
        return entry

    # ------------------------------------------------------------------ Northwind
    def seed_northwind(self):
        rng = self.rng
        olivia = self.user(f"olivia@{DOMAIN}", "Olivia Bennett")
        org = create_workspace(owner=olivia, name="Northwind Studio", currency="USD", tz="America/New_York", is_demo=True)
        org.address = "220 Hudson Street, Suite 4\nNew York, NY 10013\nUnited States"
        org.phone = "+1 (212) 555-0148"
        org.website = "https://northwind.example"
        org.tax_id = "US-81-4422190"
        org.default_bill_rate = Decimal("140.00")
        org.invoice_prefix = "NW-"
        org.invoice_footer = "Payment by bank transfer: Northwind Studio LLC · Routing 021000021 · Account 0071 3388 21\nThank you for your business."
        org.save()
        owner_m = Membership.objects.get(organization=org, user=olivia)
        owner_m.cost_rate = Decimal("85.00")
        owner_m.save()

        marcus = self.user(f"marcus@{DOMAIN}", "Marcus Chen")
        priya = self.user(f"priya@{DOMAIN}", "Priya Raman")
        diego = self.user(f"diego@{DOMAIN}", "Diego Alvarez", "America/Chicago")
        sam = self.user(f"sam@{DOMAIN}", "Sam Whitaker")
        aisha = self.user(f"aisha@{DOMAIN}", "Aisha Okafor", "Europe/London")
        tom = self.user(f"tom@{DOMAIN}", "Tom Becker", "Europe/Berlin")
        mei = self.user(f"mei@{DOMAIN}", "Mei Tanaka", "America/Los_Angeles")
        self.member(org, marcus, Role.ADMIN, "Operations Director", "75")
        self.member(org, priya, Role.PROJECT_MANAGER, "Senior Project Manager", "62", "150")
        self.member(org, diego, Role.PROJECT_MANAGER, "Delivery Lead", "58", "150")
        self.member(org, sam, Role.MEMBER, "Frontend Engineer", "48", "135")
        self.member(org, aisha, Role.MEMBER, "Product Designer", "50", "140")
        self.member(org, tom, Role.MEMBER, "Backend Engineer", "52", "145", capacity=32)
        self.member(org, mei, Role.MEMBER, "QA & Content Specialist", "38", "110")
        team = {"olivia": olivia, "marcus": marcus, "priya": priya, "diego": diego, "sam": sam, "aisha": aisha,
                "tom": tom, "mei": mei}

        clients = {}
        client_rows = [
            ("acme", "Acme Corporation", "Jordan Hayes", "USD", "Retail", "New York", "United States", 14),
            ("globex", "Globex", "Lena Fischer", "EUR", "Manufacturing", "Berlin", "Germany", 30),
            ("initech", "Initech", "Bill Lumbergh", "USD", "Software", "Austin", "United States", 14),
            ("umbrella", "Umbrella Health", "Dr. Alice Park", "USD", "Healthcare", "Boston", "United States", 21),
            ("stark", "Stark Retail Group", "Pepper Collins", "GBP", "Retail", "London", "United Kingdom", 30),
            ("wayne", "Wayne Foundation", "Lucius Fox", "USD", "Non-profit", "Chicago", "United States", 14),
        ]
        for key, name, contact, currency, industry, city, country, terms in client_rows:
            clients[key] = Client.objects.create(
                organization=org, name=name, contact_name=contact, email=f"{contact.split()[-1].lower()}@{key}.example",
                billing_email=f"accounts@{key}.example", phone=f"+1 555 01{rng.randint(10, 99)}", industry=industry,
                city=city, country=country, address_line1=f"{rng.randint(10, 999)} Market Street", currency=currency,
                payment_terms_days=terms, owner=rng.choice([olivia, marcus]),
                notes="Prefers async updates; weekly status email on Fridays." if key == "acme" else "")
        Client.objects.create(organization=org, name="Hooli (former client)", contact_name="Gavin B.", status="archived",
                              archived_at=timezone.now() - timedelta(days=200), currency="USD")

        # Client portal contacts
        jordan = self.user(f"jordan@acme.{DOMAIN}", "Jordan Hayes")
        lena = self.user(f"lena@globex.{DOMAIN}", "Lena Fischer", "Europe/Berlin")
        alice = self.user(f"alice@umbrella.{DOMAIN}", "Alice Park")
        Membership.objects.create(organization=org, user=jordan, role=Role.CLIENT, client=clients["acme"])
        Membership.objects.create(organization=org, user=lena, role=Role.CLIENT, client=clients["globex"])
        Membership.objects.create(organization=org, user=alice, role=Role.CLIENT, client=clients["umbrella"])

        # Leads
        lead_rows = [
            ("E-commerce replatform", "Soylent Foods", "Rita Gomez", "Referral", "new", 48000, 2),
            ("Brand refresh", "Vandelay Industries", "Art Vandelay", "Website form", "contacted", 18000, 6),
            ("Patient portal MVP", "Mercy Clinics", "Dr. Owen Hart", "Conference", "qualified", 95000, 10),
            ("Analytics dashboard", "Pied Piper", "Richard Hendricks", "LinkedIn", "proposal", 36000, 15),
            ("Mobile app audit", "Massive Dynamic", "Nina Sharp", "Referral", "qualified", 12000, 4),
            ("Annual maintenance retainer", "Oscorp", "Harry Osborn", "Existing network", "lost", 24000, 40),
            ("Website redesign", "Acme Corporation", "Jordan Hayes", "Existing client", "won", 64000, 120),
        ]
        for title, company, contact, source, stage, value, age in lead_rows:
            lead = Lead.objects.create(organization=org, title=title, company=company, contact_name=contact,
                                       email=f"{contact.split()[-1].lower()}@{company.split()[0].lower()}.example",
                                       source=source, stage=stage, value=Decimal(value), currency="USD",
                                       owner=rng.choice([olivia, marcus, priya]),
                                       expected_close_date=self.today + timedelta(days=rng.randint(10, 60)),
                                       next_follow_up=self.today + timedelta(days=rng.randint(-2, 9)) if stage not in ("won", "lost") else None,
                                       lost_reason="Chose an in-house team" if stage == "lost" else "")
            Lead.objects.filter(pk=lead.pk).update(created_at=timezone.now() - timedelta(days=age))
            if stage == "won":
                lead.converted_client = clients["acme"]
                lead.converted_at = timezone.now() - timedelta(days=age - 5)
                lead.save()
            Interaction.objects.create(organization=org, lead=lead, client=lead.converted_client, kind="call",
                                       summary=f"Intro call with {contact}: discussed goals, budget range and timeline.",
                                       occurred_at=timezone.now() - timedelta(days=max(age - 1, 1)), author=olivia,
                                       follow_up_date=lead.next_follow_up)
        Interaction.objects.create(organization=org, client=clients["acme"], kind="meeting",
                                   summary="Quarterly business review. Client happy with velocity; wants checkout work prioritised.",
                                   occurred_at=timezone.now() - timedelta(days=12), author=priya)
        Interaction.objects.create(organization=org, client=clients["globex"], kind="email",
                                   summary="Sent revised timeline for the supplier portal; awaiting procurement sign-off.",
                                   occurred_at=timezone.now() - timedelta(days=3), author=diego,
                                   follow_up_date=self.today + timedelta(days=2))

        labels = {lab.name: lab for lab in Label.objects.filter(organization=org)}

        def project(code, name, client, manager, ptype, status, start_ago, deadline_in, budget, hours, rate=None,
                    members=(), retainer_amount=0, retainer_hours=0, est_exp=0, desc=""):
            p = Project.objects.create(
                organization=org, code=code, name=name, client=client, manager=manager, project_type=ptype,
                status=status, priority=rng.choice(["medium", "high", "medium", "low"]), currency=client.currency,
                start_date=self.days_ago(start_ago), deadline=self.today + timedelta(days=deadline_in) if deadline_in is not None else None,
                budget_amount=Decimal(budget), budget_hours=Decimal(hours), hourly_rate=Decimal(rate) if rate else None,
                retainer_amount=Decimal(retainer_amount), retainer_hours=Decimal(retainer_hours),
                estimated_expenses=Decimal(est_exp), description=desc,
                color=rng.choice(["#4F46E5", "#0EA5E9", "#10B981", "#F59E0B", "#EC4899", "#8B5CF6"]))
            for u in {manager, *members}:
                ProjectMember.objects.create(project=p, user=u, role="Project manager" if u == manager else "")
            log_activity(organization=org, actor=manager, verb="created", target=p, client_visible=p.client_visible)
            return p

        acme_web = project("ACME-001", "Website redesign & checkout", clients["acme"], priya, "hourly", "active", 70, 35,
                           "64000", "420", "150", members=(sam, aisha, tom, mei), est_exp=2500,
                           desc="Redesign of the marketing site and a rebuilt, faster checkout flow.")
        acme_seo = project("ACME-002", "SEO & content retainer", clients["acme"], priya, "retainer", "active", 120, None,
                           "6000", "40", "150", members=(mei, aisha), retainer_amount=6000, retainer_hours=40,
                           desc="Monthly SEO, content updates and reporting.")
        globex = project("GLOB-001", "Supplier portal", clients["globex"], diego, "fixed", "active", 55, 20,
                         "48000", "300", "140", members=(tom, sam, mei), est_exp=1500,
                         desc="Fixed-fee B2B portal for supplier onboarding and order tracking.")
        initech = project("INIT-001", "Internal tools integration", clients["initech"], diego, "hourly", "active", 30, 45,
                          "22000", "150", "145", members=(tom,), desc="API integrations between CRM, billing and support tools.")
        umbrella = project("UMBR-001", "Patient onboarding app", clients["umbrella"], priya, "fixed", "active", 40, -3,
                           "30000", "200", "150", members=(aisha, sam), est_exp=800,
                           desc="Accessible onboarding flow for new patients.")
        stark = project("STAR-001", "Loyalty programme discovery", clients["stark"], diego, "fixed", "planning", 5, 50,
                        "12000", "80", "120", members=(aisha,), desc="Research and service design for a loyalty programme.")
        wayne = project("WAYN-001", "Donor CRM migration", clients["wayne"], priya, "hourly", "completed", 150, -40,
                        "18000", "120", "130", members=(tom, mei))
        Project.objects.filter(pk=wayne.pk).update(completed_at=timezone.now() - timedelta(days=42))

        # Milestones
        def milestone(p, name, due_in, status, amount=0, pos=0):
            m = Milestone.objects.create(organization=org, project=p, name=name, due_date=self.today + timedelta(days=due_in),
                                         status=status, amount=Decimal(amount), position=pos,
                                         completed_at=timezone.now() - timedelta(days=max(-due_in, 1)) if status == "completed" else None)
            return m

        ms_acme = [milestone(acme_web, "Discovery & UX", -45, "completed", pos=0),
                   milestone(acme_web, "Design system & templates", -10, "completed", pos=1),
                   milestone(acme_web, "Checkout build", 18, "in_progress", pos=2),
                   milestone(acme_web, "Launch & QA", 35, "pending", pos=3)]
        ms_glob = [milestone(globex, "Specification sign-off", -40, "completed", 12000, 0),
                   milestone(globex, "Supplier onboarding module", -6, "completed", 18000, 1),
                   milestone(globex, "Order tracking & go-live", 20, "in_progress", 18000, 2)]
        ms_umb = [milestone(umbrella, "Research & flows", -25, "completed", 10000, 0),
                  milestone(umbrella, "Accessible prototype", -8, "in_progress", 10000, 1),
                  milestone(umbrella, "Build & handover", 12, "pending", 10000, 2)]
        milestone(initech, "Integration design", -12, "completed", pos=0)
        milestone(initech, "Billing sync", 20, "in_progress", pos=1)
        milestone(stark, "Discovery workshop", 14, "pending", 4000, 0)

        # Tasks
        def task(p, title, assignee, status, est, due_in=None, priority="medium", billable=True, ms=None, label=None,
                 parent=None, desc=""):
            number = (Task.objects.filter(project=p).count() or 0) + 1
            t = Task.objects.create(
                organization=org, project=p, title=title, assignee=assignee, status=status, priority=priority,
                estimated_hours=Decimal(est) if est else None, due_date=self.today + timedelta(days=due_in) if due_in is not None else None,
                billable=billable, milestone=ms, parent=parent, number=number, created_by=p.manager, description=desc,
                position=number * 1000, completed_at=timezone.now() - timedelta(days=rng.randint(1, 20)) if status == "done" else None)
            if label:
                t.labels.add(labels[label])
            return t

        T = {}
        T["ux"] = task(acme_web, "Stakeholder interviews & UX audit", aisha, "done", 16, -48, ms=ms_acme[0], label="Design")
        T["ia"] = task(acme_web, "Information architecture", aisha, "done", 12, -40, ms=ms_acme[0], label="Design")
        T["ds"] = task(acme_web, "Design system tokens & components", aisha, "done", 30, -12, ms=ms_acme[1], label="Design")
        T["tmpl"] = task(acme_web, "Page templates in React", sam, "done", 40, -8, ms=ms_acme[1], label="Frontend")
        T["cart"] = task(acme_web, "Cart & checkout UI", sam, "in_progress", 32, 6, "high", ms=ms_acme[2], label="Frontend",
                         desc="Single-page checkout with address autocomplete and saved cards.")
        T["pay"] = task(acme_web, "Payment gateway integration", tom, "in_progress", 24, 9, "high", ms=ms_acme[2], label="Backend")
        T["tax"] = task(acme_web, "Tax & shipping rules engine", tom, "todo", 18, 14, ms=ms_acme[2], label="Backend")
        T["perf"] = task(acme_web, "Performance budget & Lighthouse fixes", sam, "todo", 10, 24, ms=ms_acme[3], label="Frontend")
        T["qa"] = task(acme_web, "Cross-browser QA pass", mei, "todo", 16, 30, ms=ms_acme[3], label="QA")
        T["copy"] = task(acme_web, "Checkout microcopy review", mei, "done", 4, -3, ms=ms_acme[2], label="Content")
        T["a11y"] = task(acme_web, "Accessibility review of checkout", mei, "in_review", 6, 2, ms=ms_acme[2], label="QA")
        T["promo"] = task(acme_web, "Promo code validation", sam, "todo", 6, -2, "high", ms=ms_acme[2], label="Frontend")
        sub1 = task(acme_web, "Address autocomplete", sam, "done", 6, 1, parent=T["cart"], label="Frontend")
        task(acme_web, "Saved payment methods", sam, "in_progress", 8, 5, parent=T["cart"], label="Frontend")
        task(acme_web, "Order confirmation email", None, "todo", 4, 8, parent=T["cart"])
        TaskDependency.objects.create(task=T["qa"], blocked_by=T["cart"])
        TaskDependency.objects.create(task=T["tax"], blocked_by=T["pay"])
        T["seo1"] = task(acme_seo, "Monthly keyword report", mei, "done", 4, -5, label="Content")
        T["seo2"] = task(acme_seo, "Product page metadata refresh", mei, "in_progress", 10, 6, label="Content")
        T["seo3"] = task(acme_seo, "Blog: holiday gift guide", aisha, "todo", 8, 12, label="Content")
        T["g1"] = task(globex, "Supplier registration flow", sam, "done", 40, -20, ms=ms_glob[1], label="Frontend")
        T["g2"] = task(globex, "Document upload & verification", tom, "done", 36, -9, ms=ms_glob[1], label="Backend")
        T["g3"] = task(globex, "Order status API", tom, "in_progress", 30, 7, "high", ms=ms_glob[2], label="Backend")
        T["g4"] = task(globex, "Order tracking UI", sam, "todo", 28, 12, ms=ms_glob[2], label="Frontend")
        T["g5"] = task(globex, "UAT with supplier pilot group", mei, "todo", 12, 18, ms=ms_glob[2], label="QA")
        T["g6"] = task(globex, "Data migration from spreadsheets", tom, "done", 8, -15, ms=ms_glob[1], label="Backend")
        T["i1"] = task(initech, "Map CRM ↔ billing data model", tom, "done", 12, -10, label="Backend")
        T["i2"] = task(initech, "Billing sync worker", tom, "in_progress", 24, 10, label="Backend")
        T["i3"] = task(initech, "Support ticket webhook", None, "todo", 10, 22, label="Backend")
        T["u1"] = task(umbrella, "Patient journey mapping", aisha, "done", 20, -26, ms=ms_umb[0], label="Design")
        T["u2"] = task(umbrella, "Accessible form components", sam, "in_progress", 30, -4, "urgent", ms=ms_umb[1], label="Frontend")
        T["u3"] = task(umbrella, "Screen-reader testing", mei, "todo", 10, -1, "high", ms=ms_umb[1], label="QA")
        T["u4"] = task(umbrella, "Clinic admin dashboard", sam, "todo", 30, 10, ms=ms_umb[2], label="Frontend")
        T["u5"] = task(umbrella, "Insurance card OCR spike", tom, "todo", 6, -6, ms=ms_umb[1], label="Backend")
        T["s1"] = task(stark, "Customer interviews (8)", aisha, "todo", 16, 10, label="Design")
        T["s2"] = task(stark, "Competitor loyalty teardown", aisha, "todo", 8, 7, label="Design")
        T["w1"] = task(wayne, "Donor data migration", tom, "done", 50, -60, label="Backend")
        T["w2"] = task(wayne, "Staff training session", mei, "done", 6, -45, label="Content")
        # A billable task completed with an estimate but no time logged (Revenue Leak Radar evidence).
        T["mobile"] = task(acme_web, "Mobile menu redesign", aisha, "done", 6, -6, ms=ms_acme[1], label="Design")

        # Time entries over the last ~10 weeks
        def burst(p, assignments, weeks, status_fn):
            for week in range(weeks, 0, -1):
                for user, task_key, hours_range in assignments:
                    for _ in range(rng.randint(1, 2)):
                        day = self.days_ago(week * 7 - rng.randint(0, 4))
                        if day.weekday() > 4:
                            day -= timedelta(days=2)
                        hours = Decimal(rng.choice(hours_range))
                        self.log_time(org, p, user, T[task_key], day, hours, status_fn(week),
                                      desc=rng.choice(["", "Implementation", "Review & fixes", "Pairing session", "Client feedback round"]))

        def status_for(week):
            if week >= 3:
                return "approved"
            if week == 2:
                return rng.choice(["approved", "approved", "submitted"])
            return rng.choice(["submitted", "draft", "draft"])

        burst(acme_web, [(aisha, "ux", ["2", "3", "4"]), (aisha, "ia", ["2", "3"])], 9, lambda w: "approved")
        burst(acme_web, [(aisha, "ds", ["3", "4", "5"]), (sam, "tmpl", ["4", "5", "6"])], 6, status_for)
        burst(acme_web, [(sam, "cart", ["3", "4", "5"]), (tom, "pay", ["2", "3", "4"]), (mei, "copy", ["1", "1.5"])], 3, status_for)
        burst(acme_seo, [(mei, "seo1", ["1", "2"]), (mei, "seo2", ["2", "3"]), (aisha, "seo3", ["1", "2"])], 3, status_for)
        burst(globex, [(sam, "g1", ["4", "5", "6"]), (tom, "g2", ["4", "5"]), (tom, "g6", ["2", "3"])], 7, lambda w: "approved")
        burst(globex, [(tom, "g3", ["3", "4", "5"])], 2, status_for)
        burst(initech, [(tom, "i1", ["2", "3"]), (tom, "i2", ["3", "4"])], 4, status_for)
        burst(umbrella, [(aisha, "u1", ["4", "5", "6"]), (sam, "u2", ["5", "6", "7"])], 5, status_for)
        burst(wayne, [(tom, "w1", ["5", "6", "7"]), (mei, "w2", ["2", "3"])], 4, lambda w: "approved")
        Task.objects.filter(pk=T["w1"].pk).update(estimated_hours=Decimal("50"))
        # A rejected entry to correct and a non-billable internal entry
        self.log_time(org, acme_web, sam, T["cart"], self.days_ago(3), "6", "rejected", "Checkout work")
        self.log_time(org, acme_web, priya, None, self.days_ago(2), "1.5", "approved", "Weekly client sync", billable=False)
        self.log_time(org, globex, diego, None, self.days_ago(4), "2", "submitted", "Sprint planning", billable=False)

        # Make estimates realistic relative to tracked time, keeping a few deliberate overruns.
        overrun_keys = {"g3", "u2"}
        for key, t in T.items():
            seconds = TimeEntry.objects.filter(task=t).aggregate(s=Sum("duration_seconds"))["s"] or 0
            if not seconds:
                continue
            actual = Decimal(seconds) / 3600
            factor = Decimal("0.7") if key in overrun_keys else Decimal(str(rng.choice([0.9, 1.0, 1.1, 1.2, 1.3])))
            estimate = (actual * factor).quantize(Decimal("1"))
            if t.status not in ("done", "cancelled"):
                estimate = max(estimate, (actual * Decimal("1.4")).quantize(Decimal("1"))) if key not in overrun_keys else estimate
            Task.objects.filter(pk=t.pk).update(estimated_hours=max(estimate, Decimal("1")))
        # Today's work in progress, including a running timer.
        for user, key, hrs in [(aisha, "seo3", "1.5"), (tom, "pay", "2"), (mei, "a11y", "1")]:
            self.log_time(org, T[key].project, user, T[key], self.today, hrs, "draft", "Morning session")
        bill_rate, cost_rate = resolve_rates(organization=org, project=acme_web, task=T["cart"], user=sam)
        started = timezone.now() - timedelta(minutes=47)
        TimeEntry.objects.create(organization=org, user=sam, project=acme_web, task=T["cart"],
                                 description="Saved payment methods", date=self.today, started_at=started,
                                 segment_started_at=started, source="timer", timer_state="running", billable=True,
                                 bill_rate=bill_rate, cost_rate=cost_rate)

        # Expenses
        cats = {c.name: c for c in ExpenseCategory.objects.filter(organization=org)}

        def expense(user, p, cat, desc, amount, days, status, billable, markup="0", vendor=""):
            amt = Decimal(amount)
            bill_amt = (amt * (1 + Decimal(markup) / 100)).quantize(Decimal("0.01")) if billable else Decimal("0")
            x = Expense.objects.create(organization=org, user=user, project=p, client=p.client if p else None,
                                       category=cats[cat], description=desc, vendor=vendor, date=self.days_ago(days),
                                       amount=amt, currency=p.currency if p else "USD", billable=billable,
                                       billable_amount=bill_amt, status=status)
            if status in ("submitted", "approved"):
                x.submitted_at = timezone.now() - timedelta(days=days - 1)
            if status == "approved":
                x.approved_at = timezone.now() - timedelta(days=max(days - 2, 0))
                x.approved_by = p.manager if p else olivia
            x.save()
            return x

        expense(aisha, acme_web, "Stock assets", "Hero photography licence", "420.00", 30, "approved", True, "10", "Unsplash+")
        expense(sam, acme_web, "Software & subscriptions", "BrowserStack (1 month)", "199.00", 12, "approved", True, "0", "BrowserStack")
        expense(tom, acme_web, "Hosting & infrastructure", "Staging environment", "86.40", 6, "submitted", True, "0", "AWS")
        expense(diego, globex, "Travel", "Train to supplier workshop", "164.00", 18, "approved", False, vendor="Deutsche Bahn")
        expense(tom, globex, "Software & subscriptions", "Document OCR API credits", "240.00", 9, "approved", True, "15", "Mindee")
        expense(priya, umbrella, "Meals", "Workshop lunch with clinic staff", "138.50", 22, "approved", False, vendor="Sweetgreen")
        expense(aisha, umbrella, "Stock assets", "Icon set licence", "59.00", 15, "draft", True, "0", "Streamline")
        expense(mei, None, "Software & subscriptions", "Grammarly team seat", "15.00", 10, "submitted", False, vendor="Grammarly")
        expense(tom, initech, "Hosting & infrastructure", "Queue service (dev)", "45.00", 5, "rejected", True, "0", "CloudAMQP")
        Expense.objects.filter(description="Queue service (dev)").update(rejection_reason="Covered by the client's own AWS account.")

        # Invoices from approved work
        def generate(client, projects, days_ago, date_to=None, send=True, pay=None, milestones=()):
            inv = invoicing.generate_from_work(organization=org, client=client, project_ids=[p.pk for p in projects],
                                               actor=olivia, date_to=date_to, milestone_ids=[m.pk for m in milestones],
                                               include_expenses=True)
            issue = self.days_ago(days_ago)
            terms = client.payment_terms_days or 14
            Invoice.objects.filter(pk=inv.pk).update(issue_date=issue, due_date=issue + timedelta(days=terms),
                                                     created_at=timezone.now() - timedelta(days=days_ago))
            inv.refresh_from_db()
            if send:
                invoicing.send_invoice(inv, olivia, send_email=False)
                Invoice.objects.filter(pk=inv.pk).update(sent_at=self.at(issue, 11))
                inv.refresh_from_db()
            if pay:
                for amount, method, ago in pay:
                    payment = invoicing.record_payment(inv, amount=Decimal(amount) if amount != "full" else inv.amount_due,
                                                       method=method, actor=marcus, reference=f"BT-{rng.randint(10000, 99999)}")
                    payment.received_at = self.at(self.days_ago(ago), 15)
                    payment.save(update_fields=["received_at"])
                    inv.refresh_from_db()
            return inv

        wayne_inv = generate(clients["wayne"], [wayne], 50, pay=[("full", "bank_transfer", 38)])
        acme_inv1 = generate(clients["acme"], [acme_web], 45, date_to=self.days_ago(46), pay=[("full", "bank_transfer", 30)])
        acme_inv2 = generate(clients["acme"], [acme_web], 24, date_to=self.days_ago(25), pay=[("6000.00", "bank_transfer", 8)])
        glob_inv = generate(clients["globex"], [globex], 38, date_to=self.days_ago(39), milestones=[ms_glob[0]])
        umb_inv = generate(clients["umbrella"], [umbrella], 20, date_to=self.days_ago(21), milestones=[ms_umb[0]])
        invoicing.issue_credit_note(umb_inv, olivia, amount=Decimal("500.00"), reason="Goodwill credit for delayed research readout")
        initech_inv = generate(clients["initech"], [initech], 3, date_to=self.days_ago(14), send=False)
        manual = invoicing.create_manual_invoice(
            organization=org, client=clients["stark"], currency="GBP", actor=olivia,
            lines=[{"description": "Loyalty discovery workshop (deposit)", "quantity": Decimal("1"), "unit_price": Decimal("4000.00")}],
            notes="Deposit for the discovery phase.")
        invoicing.send_invoice(manual, olivia, send_email=False)

        # Retainer schedule (monthly): last month's invoice was paid, this month's is open.
        this_month_start = self.today.replace(day=1)
        last_month_start = (this_month_start - timedelta(days=1)).replace(day=1)
        schedule = RecurringInvoiceSchedule.objects.create(
            organization=org, client=clients["acme"], project=acme_seo, name="Acme SEO retainer", frequency="monthly",
            start_date=last_month_start, next_run_date=last_month_start,
            currency="USD", line_items=[{"description": "SEO & content retainer (40 hours)", "quantity": "1", "unit_price": "6000.00"}],
            payment_terms_days=14, created_by=olivia, notes="Hours beyond 40 per month are billed at $150/h.")
        from apps.finance.recurring import run_schedule
        # Each period is generated on its start date, as the daily job would have done.
        generated = (run_schedule(schedule, actor=olivia, today=last_month_start)
                     + run_schedule(schedule, actor=olivia, today=this_month_start))
        for index, inv in enumerate(generated):
            if inv.status == "draft":
                invoicing.send_invoice(inv, olivia, send_email=False)
                Invoice.objects.filter(pk=inv.pk).update(sent_at=self.at(inv.issue_date, 10))
            if index == 0:
                payment = invoicing.record_payment(inv, amount=inv.amount_due, method="bank_transfer", actor=marcus,
                                                   reference="BT-RET-0901")
                payment.received_at = self.at(inv.issue_date + timedelta(days=9), 12)
                payment.save(update_fields=["received_at"])

        # Documents
        contract_tpl = ContractTemplate.objects.get(organization=org, kind="contract")
        proposal_tpl = ContractTemplate.objects.get(organization=org, kind="proposal")
        signed = Document.objects.create(
            organization=org, kind="contract", title="Services agreement – Website redesign", client=clients["acme"],
            project=acme_web, template=contract_tpl, body=contract_tpl.body, currency="USD",
            scope="Redesign of acme.example including design system, page templates and a rebuilt checkout.",
            pricing_items=[{"description": "Design & build (time and materials, estimate)", "quantity": "420", "unit_price": "150.00"}],
            payment_terms="Invoiced monthly for approved time. Net 14.",
            milestones_summary="1. Discovery & UX\n2. Design system & templates\n3. Checkout build\n4. Launch & QA",
            created_by=priya, expires_at=None)
        doc_services.append_event(signed, "created", actor=priya)
        doc_services.send_document(signed, priya, signer=jordan)
        doc_services.mark_viewed(signed, jordan, ip="203.0.113.24")
        version = signed.versions.first()
        doc_services.sign_document(signed, jordan, version=version.version, content_hash_value=version.content_hash,
                                   signer_name="Jordan Hayes", signer_title="VP Digital", method="typed", consent=True,
                                   ip="203.0.113.24", user_agent="Mozilla/5.0 (Macintosh) Safari/605.1.15")
        proposal = Document.objects.create(
            organization=org, kind="proposal", title="Proposal – Supplier portal phase 2", client=clients["globex"],
            project=globex, template=proposal_tpl, body=proposal_tpl.body, currency="EUR",
            scope="Phase 2 adds supplier scorecards, automated reminders and an analytics dashboard.",
            pricing_items=[{"description": "Supplier scorecards", "quantity": "1", "unit_price": "14000.00"},
                           {"description": "Analytics dashboard", "quantity": "1", "unit_price": "9500.00"}],
            payment_terms="40% on signature, 60% on go-live.", milestones_summary="Scorecards (6 weeks), Dashboard (4 weeks)",
            expires_at=self.today + timedelta(days=21), created_by=diego)
        doc_services.append_event(proposal, "created", actor=diego)
        doc_services.send_document(proposal, diego, signer=lena)
        draft = Document.objects.create(
            organization=org, kind="contract", title="Statement of work – Loyalty discovery", client=clients["stark"],
            project=stark, template=contract_tpl, body=contract_tpl.body, currency="GBP",
            scope="Eight customer interviews, competitor teardown and a service blueprint.",
            pricing_items=[{"description": "Discovery phase (fixed fee)", "quantity": "1", "unit_price": "12000.00"}],
            payment_terms="Deposit of £4,000 on signature, balance on delivery.", created_by=diego)
        doc_services.append_event(draft, "created", actor=diego)
        umbrella_sow = Document.objects.create(
            organization=org, kind="contract", title="Statement of work – Patient onboarding", client=clients["umbrella"],
            project=umbrella, template=contract_tpl, body=contract_tpl.body, currency="USD",
            scope="Design and build of an accessible patient onboarding flow.",
            pricing_items=[{"description": "Fixed fee", "quantity": "1", "unit_price": "30000.00"}],
            payment_terms="Billed per milestone. Net 21.", created_by=priya, expires_at=self.today + timedelta(days=10))
        doc_services.append_event(umbrella_sow, "created", actor=priya)
        doc_services.send_document(umbrella_sow, priya, signer=alice)

        # Deliverables & change requests
        Deliverable.objects.create(organization=org, project=acme_web, milestone=ms_acme[1], title="Design system v1 (Figma + Storybook)",
                                   description="Tokens, 42 components and documentation.", status="approved", revision=2,
                                   submitted_at=timezone.now() - timedelta(days=14), submitted_by=aisha,
                                   decided_at=timezone.now() - timedelta(days=11), decided_by=jordan,
                                   decision_comment="Approved — great work on the dark mode tokens.")
        Deliverable.objects.create(organization=org, project=acme_web, milestone=ms_acme[2], title="Checkout prototype for review",
                                   description="Clickable prototype of the single-page checkout. Please review the address and payment steps.",
                                   status="pending_approval", revision=1, due_date=self.today + timedelta(days=3),
                                   submitted_at=timezone.now() - timedelta(days=1), submitted_by=sam)
        Deliverable.objects.create(organization=org, project=globex, milestone=ms_glob[1], title="Supplier onboarding module (staging)",
                                   description="Ready for supplier pilot on staging.", status="approved",
                                   submitted_at=timezone.now() - timedelta(days=8), submitted_by=tom,
                                   decided_at=timezone.now() - timedelta(days=6), decided_by=lena)
        Deliverable.objects.create(organization=org, project=umbrella, milestone=ms_umb[1], title="Accessible prototype",
                                   description="WCAG 2.2 AA prototype.", status="changes_requested", revision=1,
                                   submitted_at=timezone.now() - timedelta(days=6), submitted_by=aisha,
                                   decided_at=timezone.now() - timedelta(days=4), decided_by=alice,
                                   decision_comment="Please increase contrast on the insurance step and add a progress indicator.")
        ChangeRequest.objects.create(organization=org, project=acme_web, title="Add Apple Pay & Google Pay",
                                     description="Client requested express wallets on the checkout page.",
                                     estimated_hours=Decimal("24"), estimated_cost=Decimal("3600.00"),
                                     revised_deadline=self.today + timedelta(days=42), status="pending_client",
                                     requested_by=priya, sent_at=timezone.now() - timedelta(days=2))
        applied = ChangeRequest.objects.create(organization=org, project=globex, title="Bulk CSV supplier import",
                                               description="Import existing suppliers from the ERP export.",
                                               estimated_hours=Decimal("16"), estimated_cost=Decimal("2200.00"),
                                               status="approved", requested_by=diego,
                                               sent_at=timezone.now() - timedelta(days=20),
                                               decided_at=timezone.now() - timedelta(days=18), decided_by=lena)
        from apps.projects.services import apply_change_request
        apply_change_request(change_request=applied, actor=diego)

        # Comments for collaboration context
        from apps.core.models import Comment
        from apps.core.serializers import content_type_for
        Comment.objects.create(organization=org, content_type=content_type_for(Task), object_id=T["cart"].pk, author=priya,
                               body="Let's keep the coupon field collapsed by default — conversion data supports it.")
        Comment.objects.create(organization=org, content_type=content_type_for(Task), object_id=T["cart"].pk, author=sam,
                               body="Done. Also added inline validation for postcode formats.")
        Comment.objects.create(organization=org, content_type=content_type_for(Project), object_id=acme_web.pk, author=priya,
                               body="Weekly update: checkout build on track, payment integration starts Monday.",
                               client_visible=True)

        # Size budgets relative to the seeded effort so the demo shows a realistic mix of budget states.
        from apps.projects import metrics as project_metrics
        for p, target in ((acme_web, "0.82"), (globex, "0.93"), (initech, "0.45"), (umbrella, "0.68"), (wayne, "0.96")):
            b = project_metrics.for_project(p)["budget"]
            fees, hrs = Decimal(b["fees_used"]), Decimal(b["hours_tracked"])
            if fees > 0 and hrs > 0:
                Project.objects.filter(pk=p.pk).update(
                    budget_amount=(fees / Decimal(target) / 500).quantize(Decimal("1")) * 500,
                    budget_hours=(hrs / Decimal(target)).quantize(Decimal("1")))

        # Budget alerts based on the seeded data
        from apps.projects.services import check_budget_thresholds
        for p in (acme_web, acme_seo, globex, initech, umbrella):
            check_budget_thresholds(p)
        self.northwind = org

    # ------------------------------------------------------------------ Contoso (isolation)
    def seed_contoso(self):
        owner = self.user(f"owner@contoso.{DOMAIN}", "Carla Diaz")
        org = create_workspace(owner=owner, name="Contoso Labs", currency="EUR", tz="Europe/Madrid", is_demo=True)
        client = Client.objects.create(organization=org, name="Fabrikam", contact_name="Ken Myer", currency="EUR")
        p = Project.objects.create(organization=org, code="FAB-001", name="Data platform", client=client, manager=owner,
                                   status="active", project_type="hourly", currency="EUR", hourly_rate=Decimal("120"),
                                   budget_amount=Decimal("15000"), budget_hours=Decimal("120"))
        ProjectMember.objects.create(project=p, user=owner)
        t = Task.objects.create(organization=org, project=p, title="Warehouse schema", number=1, created_by=owner, assignee=owner)
        self.log_time(org, p, owner, t, self.days_ago(2), "3", "draft", "Schema design")
