from decimal import Decimal

import pytest

from apps.accounts.models import Role
from apps.core.models import ActivityLog, Notification
from apps.crm.models import Client, Interaction, Lead
from apps.projects.models import ChangeRequest, Milestone, Project, Task


def test_client_crud_search_archive(agency, world):
    api = world.api(agency.pm)
    r = api.post("/api/clients/", {"name": "Globex", "email": "ops@globex.test", "currency": "EUR", "city": "Berlin"},
                 format="json")
    assert r.status_code == 201
    cid = r.json()["id"]
    assert api.post("/api/clients/", {"name": "globex"}, format="json").status_code == 400  # duplicate name
    assert api.patch(f"/api/clients/{cid}/", {"contact_name": "Lena"}, format="json").json()["contact_name"] == "Lena"
    names = [c["name"] for c in api.get("/api/clients/?search=glob").json()["results"]]
    assert names == ["Globex"]
    assert api.post(f"/api/clients/{cid}/archive/").json()["status"] == "archived"
    assert "Globex" not in [c["name"] for c in api.get("/api/clients/").json()["results"]]
    assert "Globex" in [c["name"] for c in api.get("/api/clients/?status=archived").json()["results"]]
    # Clients with projects cannot be hard-deleted.
    assert api.delete(f"/api/clients/{agency.client.pk}/").status_code == 400
    assert api.delete(f"/api/clients/{cid}/").status_code == 204


def test_archiving_client_disables_portal_access(agency, world):
    world.api(agency.owner).post(f"/api/clients/{agency.client.pk}/archive/")
    assert world.api(agency.portal_user).get("/api/portal/summary/").status_code == 403


def test_lead_conversion_creates_client_once(agency, world):
    api = world.api(agency.pm)
    lead = api.post("/api/leads/", {"title": "Rebrand", "company": "Initech", "contact_name": "Bill",
                                    "email": "bill@initech.test", "value": "12000", "stage": "qualified"}, format="json").json()
    api.post("/api/interactions/", {"lead": lead["id"], "kind": "call", "summary": "Intro",
                                    "occurred_at": "2026-10-01T10:00:00Z"}, format="json")
    # Leads cannot jump to "won" without conversion.
    assert api.patch(f"/api/leads/{lead['id']}/", {"stage": "won"}, format="json").status_code == 400
    r = api.post(f"/api/leads/{lead['id']}/convert/", {}, format="json")
    assert r.status_code == 200
    client = Client.objects.get(pk=r.json()["client"]["id"])
    assert client.name == "Initech" and client.email == "bill@initech.test"
    assert Lead.objects.get(pk=lead["id"]).stage == "won"
    # Interaction history moves to the client's timeline.
    assert Interaction.objects.get(lead_id=lead["id"]).client == client
    assert api.post(f"/api/leads/{lead['id']}/convert/", {}, format="json").json()["error"]["code"] == "already_converted"


def test_lead_conversion_links_existing_client(agency, world):
    api = world.api(agency.pm)
    lead = api.post("/api/leads/", {"title": "Phase 2", "company": "ACME", "value": "5000"}, format="json").json()
    assert api.get(f"/api/leads/{lead['id']}/duplicate-check/").json()["match"]["id"] == agency.client.pk
    r = api.post(f"/api/leads/{lead['id']}/convert/", {}, format="json")
    assert r.json()["client"]["id"] == agency.client.pk
    assert Client.objects.filter(organization=agency.org).count() == 1


def test_project_creation_defaults(agency, world):
    api = world.api(agency.pm)
    r = api.post("/api/projects/", {"name": "Mobile app", "client": agency.client.pk, "project_type": "fixed",
                                    "budget_amount": "20000", "budget_hours": "120"}, format="json")
    assert r.status_code == 201
    body = r.json()
    assert body["code"] == "ACME-002" and body["currency"] == "USD"
    assert body["manager"] == agency.pm.pk  # PMs lead the projects they create
    assert api.post("/api/projects/", {"name": "x", "client": agency.client.pk, "code": "ACME-002"},
                    format="json").status_code == 400
    r = api.post("/api/projects/", {"name": "x", "client": agency.client.pk, "start_date": "2026-05-01",
                                    "deadline": "2026-04-01"}, format="json")
    assert r.status_code == 400 and "deadline" in r.json()["error"]["fields"]
    # Team members cannot create projects.
    assert world.api(agency.dev).post("/api/projects/", {"name": "x", "client": agency.client.pk},
                                      format="json").status_code == 403


def test_task_crud_and_assignment_notification(agency, world):
    api = world.api(agency.pm)
    newbie = world.member(agency.org, Role.MEMBER, "New Dev")
    r = api.post("/api/tasks/", {"project": agency.project.pk, "title": "Design cart", "assignee": newbie.pk,
                                 "priority": "high", "estimated_hours": "6", "billable": True}, format="json")
    assert r.status_code == 201
    task = r.json()
    assert task["key"] == "ACME-001-2"
    # Assignee becomes a project member and is notified.
    assert agency.project.members.filter(user=newbie).exists()
    assert Notification.objects.filter(recipient=newbie, kind="task_assigned").exists()
    # Status change persists and is logged.
    dev = world.api(newbie)
    assert dev.patch(f"/api/tasks/{task['id']}/", {"status": "in_progress"}, format="json").json()["status"] == "in_progress"
    assert ActivityLog.objects.filter(verb="changed_status", target_id=task["id"]).exists()
    listing = api.get(f"/api/tasks/?project={agency.project.pk}&status=in_progress").json()["results"]
    assert [t["id"] for t in listing] == [task["id"]]


def test_subtasks_and_dependencies(agency, world):
    api = world.api(agency.pm)
    parent = agency.task
    sub = api.post("/api/tasks/", {"project": agency.project.pk, "title": "Sub", "parent": parent.pk}, format="json").json()
    r = api.post("/api/tasks/", {"project": agency.project.pk, "title": "Sub-sub", "parent": sub["id"]}, format="json")
    assert r.status_code == 400  # one level deep
    # Parent cannot complete while subtasks are open.
    r = api.patch(f"/api/tasks/{parent.pk}/", {"status": "done"}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "open_subtasks"
    api.patch(f"/api/tasks/{sub['id']}/", {"status": "done"}, format="json")

    blocker = world.task(agency.project, "Blocker")
    assert api.post(f"/api/tasks/{parent.pk}/dependencies/", {"blocked_by": blocker.pk}, format="json").json()["is_blocked"]
    r = api.post(f"/api/tasks/{blocker.pk}/dependencies/", {"blocked_by": parent.pk}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "dependency_cycle"
    r = api.patch(f"/api/tasks/{parent.pk}/", {"status": "done"}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "task_blocked"
    api.patch(f"/api/tasks/{blocker.pk}/", {"status": "done"}, format="json")
    r = api.patch(f"/api/tasks/{parent.pk}/", {"status": "done"}, format="json")
    assert r.status_code == 200 and r.json()["completed_at"]


def test_task_with_time_cannot_be_deleted(agency, world):
    world.entry(agency.project, agency.dev, "1", task=agency.task)
    r = world.api(agency.pm).delete(f"/api/tasks/{agency.task.pk}/")
    assert r.status_code == 400


def test_project_completion_requires_confirmation(agency, world):
    api = world.api(agency.pm)
    Milestone.objects.create(organization=agency.org, project=agency.project, name="Launch")
    r = api.post(f"/api/projects/{agency.project.pk}/complete/", {}, format="json")
    assert r.status_code == 409
    details = r.json()["error"]["details"]
    assert details["open_tasks_count"] == 1 and details["open_milestones"][0]["name"] == "Launch"
    assert api.post(f"/api/projects/{agency.project.pk}/complete/", {"force": True}, format="json").status_code == 400
    r = api.post(f"/api/projects/{agency.project.pk}/complete/", {"force": True, "reason": "Client cancelled the rest"},
                 format="json")
    assert r.status_code == 200 and r.json()["status"] == "completed"
    log = ActivityLog.objects.get(verb="completed_project")
    assert log.metadata["forced"] is True and log.metadata["reason"] == "Client cancelled the rest"
    # Status cannot be set to completed through a plain update.
    other = world.project(agency.org, agency.client, agency.pm, code="ACME-005")
    assert api.patch(f"/api/projects/{other.pk}/", {"status": "completed"}, format="json").status_code == 400


def test_project_completion_without_open_work(agency, world):
    api = world.api(agency.pm)
    api.patch(f"/api/tasks/{agency.task.pk}/", {"status": "done"}, format="json")
    assert api.post(f"/api/projects/{agency.project.pk}/complete/", {}, format="json").status_code == 200


def test_change_request_approval_updates_budget_explicitly(agency, world):
    agency.project.budget_hours = Decimal("100")
    agency.project.budget_amount = Decimal("15000")
    agency.project.save()
    pm = world.api(agency.pm)
    cr = pm.post("/api/change-requests/", {"project": agency.project.pk, "title": "Apple Pay",
                                           "description": "Add wallets", "estimated_hours": "20",
                                           "estimated_cost": "3000", "revised_deadline": "2026-12-31"}, format="json").json()
    assert cr["status"] == "draft"
    assert pm.post(f"/api/change-requests/{cr['id']}/apply/").status_code == 400  # not approved yet
    assert pm.post(f"/api/change-requests/{cr['id']}/send/").json()["status"] == "pending_client"
    client = world.api(agency.portal_user)
    assert client.post(f"/api/portal/change-requests/{cr['id']}/approve/", {"comment": "Go"}, format="json").json()["status"] == "approved"
    # Approval alone does not change the project...
    agency.project.refresh_from_db()
    assert agency.project.budget_hours == Decimal("100")
    # ...the manager applies it explicitly, with an audit snapshot.
    r = pm.post(f"/api/change-requests/{cr['id']}/apply/")
    assert r.status_code == 200 and r.json()["status"] == "applied"
    agency.project.refresh_from_db()
    assert agency.project.budget_hours == Decimal("120") and agency.project.budget_amount == Decimal("18000")
    assert str(agency.project.deadline) == "2026-12-31"
    snapshot = ChangeRequest.objects.get(pk=cr["id"]).applied_snapshot
    assert snapshot["before"]["budget_hours"] == "100.00" and snapshot["after"]["budget_hours"] == "120.00"
    assert pm.post(f"/api/change-requests/{cr['id']}/apply/").status_code == 400  # cannot apply twice


def test_deliverable_client_approval(agency, world):
    pm = world.api(agency.pm)
    d = pm.post("/api/deliverables/", {"project": agency.project.pk, "title": "Homepage design"}, format="json").json()
    portal = world.api(agency.portal_user)
    # Drafts are invisible to the client.
    assert portal.post(f"/api/portal/deliverables/{d['id']}/approve/", {}, format="json").status_code == 404
    assert pm.post(f"/api/deliverables/{d['id']}/submit/").json()["status"] == "pending_approval"
    summary = portal.get("/api/portal/summary/").json()
    assert any(a["type"] == "deliverable" and a["id"] == d["id"] for a in summary["approvals"])
    r = portal.post(f"/api/portal/deliverables/{d['id']}/request-changes/", {}, format="json")
    assert r.status_code == 400  # a comment is required
    r = portal.post(f"/api/portal/deliverables/{d['id']}/request-changes/", {"comment": "Bigger logo"}, format="json")
    assert r.json()["status"] == "changes_requested"
    assert Notification.objects.filter(recipient=agency.pm, kind="deliverable_decided").exists()
    resubmitted = pm.post(f"/api/deliverables/{d['id']}/submit/").json()
    assert resubmitted["revision"] == 2
    assert portal.post(f"/api/portal/deliverables/{d['id']}/approve/", {"comment": "Great"}, format="json").json()["status"] == "approved"
    assert pm.patch(f"/api/deliverables/{d['id']}/", {"title": "x"}, format="json").status_code == 400


def test_project_health_is_explained(agency, world):
    from datetime import timedelta

    from django.utils import timezone

    agency.project.budget_amount = Decimal("1000")
    agency.project.deadline = timezone.localdate() - timedelta(days=1)
    agency.project.save()
    world.entry(agency.project, agency.dev, "7", "approved")  # 7h x 150 = 1050 > budget
    data = world.api(agency.pm).get(f"/api/projects/{agency.project.pk}/health/").json()
    assert data["health"]["status"] == "critical"
    reasons = " ".join(s["reason"] for s in data["health"]["signals"])
    assert "Budget exceeded: 105.0%" in reasons and "Deadline passed" in reasons
