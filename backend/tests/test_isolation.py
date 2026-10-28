"""Tenant isolation and role-based visibility, enforced by the API (not just the UI)."""

from decimal import Decimal

import pytest

from apps.accounts.models import Role
from apps.finance import invoicing


@pytest.fixture
def two_tenants(agency, world):
    other_org, other_owner = world.workspace("Contoso")
    other_client = world.client_record(other_org, "Fabrikam")
    other_project = world.project(other_org, other_client, other_owner, code="FAB-001")
    other_task = world.task(other_project, "Secret task")
    other_entry = world.entry(other_project, other_owner, "2", "approved")
    other_invoice = invoicing.generate_from_work(organization=other_org, client=other_client,
                                                 project_ids=[other_project.pk], actor=other_owner)
    return agency, other_owner, other_client, other_project, other_task, other_entry, other_invoice


@pytest.mark.parametrize("path", ["clients/{client}/", "projects/{project}/", "tasks/{task}/", "time-entries/{entry}/",
                                  "invoices/{invoice}/", "invoices/{invoice}/pdf/", "clients/{client}/overview/"])
def test_cross_tenant_reads_are_not_found(two_tenants, world, path):
    agency, _, other_client, other_project, other_task, other_entry, other_invoice = two_tenants
    client = world.api(agency.owner)
    url = "/api/" + path.format(client=other_client.pk, project=other_project.pk, task=other_task.pk,
                                entry=other_entry.pk, invoice=other_invoice.pk)
    assert client.get(url).status_code == 404


def test_cross_tenant_writes_are_rejected(two_tenants, world):
    agency, _, other_client, other_project, other_task, other_entry, other_invoice = two_tenants
    client = world.api(agency.owner)
    assert client.patch(f"/api/projects/{other_project.pk}/", {"name": "pwned"}, format="json").status_code == 404
    assert client.delete(f"/api/tasks/{other_task.pk}/").status_code == 404
    # Foreign ids in payloads fail validation exactly like non-existent ids.
    r = client.post("/api/projects/", {"name": "X", "client": other_client.pk}, format="json")
    assert r.status_code == 400 and "client" in r.json()["error"]["fields"]
    r = client.post("/api/tasks/", {"project": other_project.pk, "title": "x"}, format="json")
    assert r.status_code == 400
    r = client.post("/api/time-entries/", {"project": other_project.pk, "date": "2026-01-05", "duration_seconds": 60},
                    format="json")
    assert r.status_code == 400
    r = client.post("/api/timer/start/", {"project": other_project.pk}, format="json")
    assert r.status_code == 400
    r = client.post("/api/invoices/generate/", {"client": other_client.pk, "projects": [other_project.pk]}, format="json")
    assert r.status_code == 400
    r = client.post(f"/api/invoices/{other_invoice.pk}/payments/", {"amount": "1.00"}, format="json")
    assert r.status_code == 404
    r = client.post("/api/comments/", {"target": f"task:{other_task.pk}", "body": "hi"}, format="json")
    assert r.status_code == 404


def test_lists_only_include_own_workspace(two_tenants, world):
    agency, *_ = two_tenants
    client = world.api(agency.owner)
    assert [c["name"] for c in client.get("/api/clients/").json()["results"]] == ["Acme"]
    assert [p["code"] for p in client.get("/api/projects/").json()["results"]] == ["ACME-001"]
    assert client.get("/api/invoices/").json()["count"] == 0
    assert client.get("/api/search/?q=Secret").json()["results"] == []


def test_team_member_sees_only_assigned_projects_and_no_finance(agency, world):
    other_project = world.project(agency.org, agency.client, agency.pm, code="ACME-002")
    client = world.api(agency.dev)
    codes = [p["code"] for p in client.get("/api/projects/").json()["results"]]
    assert codes == ["ACME-001"]
    assert client.get(f"/api/projects/{other_project.pk}/").status_code == 404
    project = client.get(f"/api/projects/{agency.project.pk}/").json()
    assert "budget_amount" not in project and "hourly_rate" not in project
    assert client.get("/api/invoices/").status_code == 403
    assert client.get("/api/clients/").status_code == 403
    assert client.get("/api/reports/overview/").status_code == 403
    assert client.get("/api/revenue-leak/").status_code == 403


def test_project_manager_cannot_edit_unmanaged_project(agency, world):
    other_pm = world.member(agency.org, Role.PROJECT_MANAGER, "Other PM")
    project = world.project(agency.org, agency.client, other_pm, members=[agency.pm], code="ACME-009")
    client = world.api(agency.pm)
    assert client.get(f"/api/projects/{project.pk}/").status_code == 200  # visible as member
    assert client.patch(f"/api/projects/{project.pk}/", {"name": "Renamed"}, format="json").status_code == 403


def test_client_portal_users_cannot_use_internal_api(agency, world):
    client = world.api(agency.portal_user)
    for url in ("/api/projects/", "/api/tasks/", "/api/clients/", "/api/time-entries/", "/api/invoices/",
                "/api/dashboard/", "/api/documents/"):
        assert client.get(url).status_code == 403, url


def test_clients_only_see_their_own_records(agency, world):
    other_client = world.client_record(agency.org, "Globex")
    other_contact = world.member(agency.org, Role.CLIENT, "Gina Globex", client=other_client)
    other_project = world.project(agency.org, other_client, agency.pm, code="GLOB-001")
    world.entry(agency.project, agency.dev, "2", "approved")
    acme_invoice = invoicing.generate_from_work(organization=agency.org, client=agency.client,
                                                project_ids=[agency.project.pk], actor=agency.owner)
    invoicing.send_invoice(acme_invoice, agency.owner, send_email=False)

    globex = world.api(other_contact)
    assert globex.get(f"/api/portal/invoices/{acme_invoice.pk}/").status_code == 404
    assert globex.get(f"/api/portal/projects/{agency.project.pk}/").status_code == 404
    assert [p["code"] for p in globex.get("/api/portal/projects/").json()] == ["GLOB-001"]
    assert globex.get("/api/portal/invoices/").json() == []

    acme = world.api(agency.portal_user)
    assert acme.get(f"/api/portal/projects/{other_project.pk}/").status_code == 404
    assert [i["number"] for i in acme.get("/api/portal/invoices/").json()] == [acme_invoice.number]


def test_portal_hides_internal_data(agency, world):
    from apps.core.models import Comment
    from apps.core.serializers import content_type_for
    from apps.projects.models import Project

    agency.client.notes = "Internal: difficult to work with"
    agency.client.save()
    Comment.objects.create(organization=agency.org, content_type=content_type_for(Project), object_id=agency.project.pk,
                           author=agency.pm, body="internal only", client_visible=False)
    Comment.objects.create(organization=agency.org, content_type=content_type_for(Project), object_id=agency.project.pk,
                           author=agency.pm, body="shared update", client_visible=True)
    client = world.api(agency.portal_user)
    detail = client.get(f"/api/portal/projects/{agency.project.pk}/").json()
    raw = str(detail)
    assert "difficult" not in raw and "hourly_rate" not in raw and "budget" not in raw
    comments = client.get(f"/api/portal/comments/?target=project:{agency.project.pk}").json()
    assert [c["body"] for c in comments] == ["shared update"]


def test_hidden_projects_are_not_shared_with_client(agency, world):
    agency.project.client_visible = False
    agency.project.save()
    client = world.api(agency.portal_user)
    assert client.get("/api/portal/projects/").json() == []
    assert client.get(f"/api/portal/projects/{agency.project.pk}/").status_code == 404


def test_rates_hidden_from_members_in_time_entries(agency, world):
    world.entry(agency.project, agency.dev, "1", "draft")
    entries = world.api(agency.dev).get("/api/time-entries/").json()["results"]
    assert entries and "bill_rate" not in entries[0] and entries[0]["amount"] is None
    team = world.api(agency.pm).get("/api/time-entries/?scope=team").json()["results"]
    assert team[0]["bill_rate"] == "150.00" and team[0]["amount"] == "150.00"


def test_files_require_access_to_parent_record(agency, world):
    from django.core.files.uploadedfile import SimpleUploadedFile

    other_project = world.project(agency.org, agency.client, agency.pm, code="ACME-777")
    pm = world.api(agency.pm)
    upload = SimpleUploadedFile("brief.pdf", b"%PDF-1.4 test", content_type="application/pdf")
    r = pm.post("/api/files/", {"target": f"project:{other_project.pk}", "file": upload}, format="multipart")
    assert r.status_code == 201
    file_id = r.json()["id"]
    assert world.api(agency.dev).get(f"/api/files/{file_id}/download/").status_code == 403
    assert pm.get(f"/api/files/{file_id}/download/").status_code == 200
    # Not shared with the client yet.
    assert world.api(agency.portal_user).get(f"/api/portal/files/{file_id}/download/").status_code == 404


def test_upload_validation_rejects_disguised_files(agency, world):
    from django.core.files.uploadedfile import SimpleUploadedFile

    pm = world.api(agency.pm)
    fake = SimpleUploadedFile("invoice.pdf", b"<script>alert(1)</script>", content_type="application/pdf")
    r = pm.post("/api/files/", {"target": f"project:{agency.project.pk}", "file": fake}, format="multipart")
    assert r.status_code == 400
    exe = SimpleUploadedFile("tool.exe", b"MZ....", content_type="application/octet-stream")
    r = pm.post("/api/files/", {"target": f"project:{agency.project.pk}", "file": exe}, format="multipart")
    assert r.status_code == 400


def test_rates_are_hidden_from_people_who_cannot_manage_them(agency, world):
    from apps.projects.models import ProjectMember

    ProjectMember.objects.filter(project=agency.project, user=agency.dev).update(bill_rate=Decimal("175.00"))
    member_view = world.api(agency.dev).get(f"/api/projects/{agency.project.pk}/members/").json()
    assert member_view and all("bill_rate" not in m for m in member_view)
    manager_view = world.api(agency.pm).get(f"/api/projects/{agency.project.pk}/members/").json()
    assert any(m.get("bill_rate") == "175.00" for m in manager_view)
    # The workspace default billing rate: hidden from members, visible to managers and billing users.
    assert "default_bill_rate" not in world.api(agency.dev).get("/api/workspace/").json()
    assert "default_bill_rate" not in world.api(agency.dev).get("/api/auth/me/").json()["organization"]
    assert world.api(agency.pm).get("/api/workspace/").json()["default_bill_rate"] == "100.00"
    assert world.api(agency.owner).get("/api/auth/me/").json()["organization"]["default_bill_rate"] == "100.00"


def test_search_respects_document_scope_for_project_managers(agency, world):
    from apps.documents.models import Document

    other_pm = world.member(agency.org, Role.PROJECT_MANAGER, "Other Manager")
    other_project = world.project(agency.org, agency.client, other_pm, code="ACME-002")
    Document.objects.create(organization=agency.org, title="Confidential retainer terms", client=agency.client,
                            project=other_project, body="x", created_by=agency.owner)
    Document.objects.create(organization=agency.org, title="Confidential checkout SOW", client=agency.client,
                            project=agency.project, body="x", created_by=agency.owner)
    titles = lambda user: {r["title"] for r in world.api(user).get("/api/search/?q=Confidential").json()["results"]
                           if r["type"] == "document"}
    assert titles(agency.pm) == {"Confidential checkout SOW"}
    assert titles(agency.owner) == {"Confidential retainer terms", "Confidential checkout SOW"}
