import itertools
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import Membership, Role, User
from apps.accounts.services import create_workspace
from apps.crm.models import Client
from apps.projects.models import Project, ProjectMember, Task
from apps.projects.services import resolve_rates
from apps.timetracking.models import TimeEntry

PASSWORD = "Str0ng-Test-Passw0rd"
_seq = itertools.count(1)


class World:
    """Factory helpers that build realistic tenant data for tests."""

    def user(self, name="Test User", email=None):
        n = next(_seq)
        return User.objects.create_user(email=email or f"user{n}@example.test", password=PASSWORD, full_name=name)

    def workspace(self, name="Agency", currency="USD"):
        owner = self.user(f"{name} Owner")
        org = create_workspace(owner=owner, name=name, currency=currency)
        org.default_bill_rate = Decimal("100.00")
        org.save()
        return org, owner

    def member(self, org, role=Role.MEMBER, name=None, cost_rate="40.00", client=None, **extra):
        user = self.user(name or role.title())
        Membership.objects.create(organization=org, user=user, role=role, cost_rate=Decimal(cost_rate), client=client, **extra)
        return user

    def client_record(self, org, name=None, currency="USD"):
        return Client.objects.create(organization=org, name=name or f"Client {next(_seq)}", currency=currency,
                                     email=f"billing{next(_seq)}@client.test")

    def project(self, org, client, manager, members=(), code=None, **fields):
        defaults = {"project_type": "hourly", "status": "active", "hourly_rate": Decimal("150.00"),
                    "currency": client.currency}
        defaults.update(fields)
        project = Project.objects.create(organization=org, client=client, manager=manager,
                                         code=code or f"P-{next(_seq):03d}", name=f"Project {next(_seq)}", **defaults)
        for user in {manager, *members}:
            ProjectMember.objects.get_or_create(project=project, user=user)
        return project

    def task(self, project, title="Task", assignee=None, **fields):
        number = Task.objects.filter(project=project).count() + 1
        return Task.objects.create(organization=project.organization, project=project, title=title, assignee=assignee,
                                   number=number, created_by=project.manager, **fields)

    def entry(self, project, user, hours="1", status="draft", task=None, billable=True, days_ago=1):
        bill_rate, cost_rate = resolve_rates(organization=project.organization, project=project, task=task, user=user)
        seconds = int(Decimal(hours) * 3600)
        entry = TimeEntry.objects.create(
            organization=project.organization, user=user, project=project, task=task,
            date=timezone.localdate() - timedelta(days=days_ago), duration_seconds=seconds,
            accumulated_seconds=seconds, billable=billable, bill_rate=bill_rate, cost_rate=cost_rate, status=status,
        )
        if status == "approved":
            entry.approved_by = project.manager
            entry.approved_at = timezone.now()
            entry.save()
        return entry

    def api(self, user=None):
        client = APIClient()
        if user is not None:
            client.login(email=user.email, password=PASSWORD)
        return client


@pytest.fixture(autouse=True)
def _payment_settings(settings):
    """Tests never depend on the developer's .env payment configuration (test-only signing secret)."""
    settings.PAYMENT_PROVIDER = "sandbox"
    settings.SANDBOX_WEBHOOK_SECRET = "test-only-sandbox-signing-secret"


@pytest.fixture
def world(db):
    return World()


@pytest.fixture
def agency(world):
    """A workspace with a PM, a team member, a client, a project and a portal contact."""
    org, owner = world.workspace("Northwind")
    pm = world.member(org, Role.PROJECT_MANAGER, "Pat Manager")
    dev = world.member(org, Role.MEMBER, "Dana Developer")
    client = world.client_record(org, "Acme")
    portal_user = world.member(org, Role.CLIENT, "Casey Client", client=client)
    project = world.project(org, client, pm, members=[dev], code="ACME-001")
    task = world.task(project, "Build checkout", assignee=dev, estimated_hours=Decimal("10"))

    class Agency:
        pass

    a = Agency()
    a.org, a.owner, a.pm, a.dev, a.client, a.portal_user, a.project, a.task = org, owner, pm, dev, client, portal_user, project, task
    return a
