"""
Role-level data exposure: each role sees only the financial and scoped data its permissions allow.
(Workspace and client isolation are covered in test_isolation.py.)
"""

from datetime import timedelta
from decimal import Decimal

from django.utils import timezone

from apps.accounts import services as account_services
from apps.accounts.models import Membership, Role
from apps.documents.models import Document
from apps.finance import invoicing
from apps.projects.models import ChangeRequest, Milestone, ProjectMember
from apps.projects.services import apply_change_request


def _pm_member_only(agency, world):
    """A second project manager who is a member of ACME-001 but does not lead it."""
    pm2 = world.member(agency.org, Role.PROJECT_MANAGER, "Pam Member")
    ProjectMember.objects.create(project=agency.project, user=pm2)
    return pm2


def _money_keys(value):
    keys = set()
    if isinstance(value, dict):
        for k, v in value.items():
            keys.add(k)
            keys |= _money_keys(v)
    elif isinstance(value, list):
        for v in value:
            keys |= _money_keys(v)
    return keys


def _sent_invoice(agency, world):
    world.entry(agency.project, agency.dev, "10", "approved")
    invoice = invoicing.generate_from_work(organization=agency.org, client=agency.client,
                                           project_ids=[agency.project.pk], actor=agency.owner)
    invoicing.send_invoice(invoice, agency.owner, send_email=False)
    return invoice


def test_activity_metadata_hides_money_from_people_who_cannot_manage_the_project(agency, world):
    pm2 = _pm_member_only(agency, world)
    assert world.api(agency.owner).patch(f"/api/projects/{agency.project.pk}/", {"budget_amount": "48000.00"},
                                         format="json").status_code == 200
    for user in (agency.dev, pm2):
        feed = world.api(user).get(f"/api/activity/?project={agency.project.pk}").json()
        assert feed and not ({"budget_amount", "amount", "total"} & _money_keys([a["metadata"] for a in feed]))
    manager_feed = world.api(agency.pm).get(f"/api/activity/?project={agency.project.pk}").json()
    assert "budget_amount" in _money_keys([a["metadata"] for a in manager_feed])


def test_change_request_snapshot_and_milestone_amounts_follow_project_management(agency, world):
    cr = ChangeRequest.objects.create(organization=agency.org, project=agency.project, title="Extra page",
                                      estimated_hours=Decimal("8"), estimated_cost=Decimal("1200.00"),
                                      status="approved", requested_by=agency.pm)
    apply_change_request(change_request=cr, actor=agency.pm)
    Milestone.objects.create(organization=agency.org, project=agency.project, name="Phase 1", amount=Decimal("12500.00"))
    member_crs = world.api(agency.dev).get(f"/api/change-requests/?project={agency.project.pk}").json()["results"]
    member_milestones = world.api(agency.dev).get(f"/api/milestones/?project={agency.project.pk}").json()
    # Members keep the hours/deadline part of the snapshot, without the budget amount.
    assert member_crs and member_crs[0]["applied_snapshot"]["after"]["budget_hours"]
    assert "budget_amount" not in _money_keys(member_crs[0]["applied_snapshot"])
    assert member_milestones and all("amount" not in m for m in member_milestones)
    manager_crs = world.api(agency.pm).get(f"/api/change-requests/?project={agency.project.pk}").json()["results"]
    manager_milestones = world.api(agency.pm).get(f"/api/milestones/?project={agency.project.pk}").json()
    assert manager_crs[0]["applied_snapshot"]["after"]["budget_hours"]
    assert "budget_amount" in manager_crs[0]["applied_snapshot"]["after"]
    assert manager_milestones[0]["amount"] == "12500.00"


def test_invoice_activity_is_for_billing_users_only(agency, world):
    _sent_invoice(agency, world)
    no_billing_admin = world.member(agency.org, Role.ADMIN, "Ada Admin", can_manage_billing=False)
    finance = {"invoice", "payment", "creditnote"}
    timeline = world.api(agency.pm).get(f"/api/clients/{agency.client.pk}/timeline/").json()
    assert not [i for i in timeline if i["type"] == "activity" and i["data"]["target_type"] in finance]
    feed = world.api(no_billing_admin).get("/api/activity/").json()
    assert feed and not [a for a in feed if a["target_type"] in finance]
    dashboard = world.api(no_billing_admin).get("/api/dashboard/").json()
    assert not [a for a in dashboard["activity"] if a["target_type"] in finance]
    owner_feed = world.api(agency.owner).get("/api/activity/").json()
    assert [a for a in owner_feed if a["target_type"] == "invoice"]


def test_reports_receivables_are_for_billing_users_and_filters_never_widen_scope(agency, world):
    _sent_invoice(agency, world)
    other_client = world.client_record(agency.org, "Globex")
    lonely_pm = world.member(agency.org, Role.PROJECT_MANAGER, "Lonely PM")
    for user, params in ((lonely_pm, f"?client={agency.client.pk}"), (agency.pm, ""), (agency.pm, f"?client={other_client.pk}")):
        report = world.api(user).get(f"/api/reports/overview/{params}").json()
        assert report["outstanding"] == [] and report["aging"] == [] and report["collected"] == []
        assert all("collected" not in row for rows in report["monthly"].values() for row in rows)
    no_billing_admin = world.member(agency.org, Role.ADMIN, "Ada Admin", can_manage_billing=False)
    assert world.api(no_billing_admin).get("/api/reports/overview/").json()["outstanding"] == []
    assert world.api(agency.pm).get("/api/reports/export/aging/").status_code == 403
    owner_report = world.api(agency.owner).get("/api/reports/overview/").json()
    assert owner_report["outstanding"] and owner_report["aging"]
    assert world.api(agency.owner).get("/api/reports/export/aging/").status_code == 200


def test_dashboard_money_covers_only_projects_the_manager_leads(agency, world):
    pm2 = _pm_member_only(agency, world)
    agency.project.budget_amount = Decimal("1000.00")
    agency.project.save()
    world.entry(agency.project, agency.dev, "6", "approved", days_ago=0)
    data = world.api(pm2).get("/api/dashboard/").json()
    assert data["time"]["billable_value_this_month"] == []
    for item in data["projects"]["attention"]:
        assert item["budget_used_percent"] is None
        assert not any("%" in reason and "budget" in reason.lower() for reason in item["reasons"])
    lead = world.api(agency.pm).get("/api/dashboard/").json()
    assert lead["time"]["billable_value_this_month"]


def test_health_hides_fee_percentages_from_non_managers(agency, world):
    agency.project.budget_amount = Decimal("1000.00")
    agency.project.save()
    world.entry(agency.project, agency.dev, "6", "approved")  # 900 of 1000 -> 90%
    for path in (f"/api/projects/{agency.project.pk}/", f"/api/projects/{agency.project.pk}/health/"):
        health = world.api(agency.dev).get(path).json()["health"]
        budget_signal = next(s for s in health["signals"] if s["key"] == "budget")
        assert "%" not in budget_signal["reason"]
    manager_health = world.api(agency.pm).get(f"/api/projects/{agency.project.pk}/").json()["health"]
    assert "%" in next(s for s in manager_health["signals"] if s["key"] == "budget")["reason"]


def test_admin_without_billing_cannot_hand_out_billing_access(agency, world):
    no_billing_admin = world.member(agency.org, Role.ADMIN, "Ada Admin", can_manage_billing=False)
    target = Membership.objects.get(organization=agency.org, user=agency.dev)
    r = world.api(no_billing_admin).patch(f"/api/team/members/{target.pk}/", {"role": "admin"}, format="json")
    assert r.status_code == 200
    target.refresh_from_db()
    assert target.role == Role.ADMIN and target.can_manage_billing is False
    assert world.api(agency.dev).get("/api/invoices/").status_code == 403
    # Invitations to the admin role follow the same rule.
    invitation, _ = account_services.invite_member(organization=agency.org, email="new.admin@example.test",
                                                   role=Role.ADMIN, invited_by=no_billing_admin)
    new_user = world.user("New Admin", email="new.admin@example.test")
    membership = account_services.accept_invitation(invitation=invitation, user=new_user)
    assert membership.role == Role.ADMIN and membership.can_manage_billing is False
    # An owner's promotion keeps the default billing grant.
    pm_membership = Membership.objects.get(organization=agency.org, user=agency.pm)
    world.api(agency.owner).patch(f"/api/team/members/{pm_membership.pk}/", {"role": "admin"}, format="json")
    pm_membership.refresh_from_db()
    assert pm_membership.can_manage_billing is True


def test_portal_summary_never_mentions_unshared_projects(agency, world):
    r = world.api(agency.owner).post("/api/projects/", {"name": "Internal restructuring", "client": agency.client.pk,
                                                         "client_visible": False, "project_type": "hourly"}, format="json")
    assert r.status_code == 201, r.content
    summary = world.api(agency.portal_user).get("/api/portal/summary/").json()
    assert not [a for a in summary["activity"] if "Internal restructuring" in a["target_label"]]


def test_document_scope_applies_to_comments_files_calendar_and_client_overview(agency, world):
    pm2 = world.member(agency.org, Role.PROJECT_MANAGER, "Other PM")
    doc = Document.objects.create(organization=agency.org, title="Renewal contract", client=agency.client,
                                  project=agency.project, body="x", created_by=agency.owner, status="sent",
                                  expires_at=timezone.localdate() + timedelta(days=2))
    world.api(agency.owner).post("/api/comments/", {"target": f"document:{doc.pk}", "body": "Walk-away price is 80k"},
                                 format="json")
    assert world.api(pm2).get(f"/api/comments/?target=document:{doc.pk}").status_code == 403
    assert world.api(pm2).get(f"/api/files/?target=document:{doc.pk}").status_code == 403
    assert world.api(agency.pm).get(f"/api/comments/?target=document:{doc.pk}").status_code == 200  # leads the project
    today = timezone.localdate()
    events = world.api(pm2).get(f"/api/calendar/?start={today}&end={today + timedelta(days=5)}").json()
    assert not [e for e in events if e["type"] == "document"]
    overview = world.api(pm2).get(f"/api/clients/{agency.client.pk}/overview/").json()
    assert overview["documents"] == []
    assert [d["title"] for d in world.api(agency.pm).get(f"/api/clients/{agency.client.pk}/overview/").json()["documents"]] == ["Renewal contract"]


def test_only_the_project_manager_can_share_files_and_comments_with_the_client(agency, world):
    from django.core.files.uploadedfile import SimpleUploadedFile

    pm2 = _pm_member_only(agency, world)
    upload = world.api(agency.owner).post("/api/files/", {"target": f"project:{agency.project.pk}",
                                                         "file": SimpleUploadedFile("costing.txt", b"internal")})
    assert upload.status_code == 201, upload.content
    file_id = upload.json()["id"]
    assert world.api(pm2).patch(f"/api/files/{file_id}/", {"client_visible": True}, format="json").status_code == 403
    assert world.api(agency.dev).post("/api/comments/", {"target": f"project:{agency.project.pk}", "body": "hi",
                                                        "client_visible": True}, format="json").status_code == 403
    assert world.api(agency.pm).patch(f"/api/files/{file_id}/", {"client_visible": True}, format="json").status_code == 200


def test_assigning_a_task_is_not_a_back_door_onto_a_project(agency, world):
    outsider = world.member(agency.org, Role.MEMBER, "Olly Outsider")
    member_api = world.api(agency.dev)
    r = member_api.post("/api/tasks/", {"project": agency.project.pk, "title": "Help", "assignee": outsider.pk}, format="json")
    assert r.status_code == 400 and "assignee" in r.json()["error"]["fields"]
    r = member_api.patch(f"/api/tasks/{agency.task.pk}/", {"assignee": outsider.pk}, format="json")
    assert r.status_code == 400
    assert world.api(outsider).get(f"/api/projects/{agency.project.pk}/").status_code == 404
    r = world.api(agency.pm).post("/api/tasks/", {"project": agency.project.pk, "title": "Help", "assignee": outsider.pk},
                                  format="json")
    assert r.status_code == 201
    assert world.api(outsider).get(f"/api/projects/{agency.project.pk}/").status_code == 200


def test_workload_for_project_managers_covers_their_projects(agency, world):
    lonely_pm = world.member(agency.org, Role.PROJECT_MANAGER, "Lonely PM")
    assert world.api(lonely_pm).get("/api/team/workload/").json()["members"] == []
    names = {m["user"]["full_name"] for m in world.api(agency.pm).get("/api/team/workload/").json()["members"]}
    assert "Dana Developer" in names
    owner_names = {m["user"]["full_name"] for m in world.api(agency.owner).get("/api/team/workload/").json()["members"]}
    assert "Lonely PM" in owner_names



# --- Second review round -------------------------------------------------------------------------------


def _upload(api, target, name="note.txt", **extra):
    from django.core.files.uploadedfile import SimpleUploadedFile

    return api.post("/api/files/", {"target": target, "file": SimpleUploadedFile(name, b"data"), **extra})


def test_uploading_straight_to_the_portal_needs_the_project_manager(agency, world):
    pm2 = _pm_member_only(agency, world)
    target = f"project:{agency.project.pk}"
    assert _upload(world.api(agency.dev), target, client_visible="true").status_code == 403
    assert _upload(world.api(pm2), target, client_visible="true").status_code == 403
    shared = _upload(world.api(agency.pm), target, "final.txt", client_visible="true")
    assert shared.status_code == 201 and shared.json()["client_visible"] is True
    # The string "false" hides a file rather than sharing it.
    file_id = shared.json()["id"]
    r = world.api(agency.pm).patch(f"/api/files/{file_id}/", {"client_visible": "false"}, format="json")
    assert r.json()["client_visible"] is False
    # A project manager who only belongs to the project cannot delete the lead's files; uploaders can delete their own.
    assert world.api(pm2).delete(f"/api/files/{file_id}/").status_code == 403
    own = _upload(world.api(agency.dev), target, "mine.txt").json()["id"]
    assert world.api(agency.dev).delete(f"/api/files/{own}/").status_code == 204
    assert world.api(agency.pm).delete(f"/api/files/{file_id}/").status_code == 204


def test_document_activity_and_client_timeline_follow_visibility(agency, world):
    pm2 = _pm_member_only(agency, world)
    lonely_pm = world.member(agency.org, Role.PROJECT_MANAGER, "Lonely PM")
    owner_api = world.api(agency.owner)
    doc = owner_api.post("/api/documents/", {"kind": "contract", "title": "Confidential renegotiation",
                                             "client": agency.client.pk, "project": agency.project.pk,
                                             "body": "x"}, format="json").json()
    owner_api.post("/api/comments/", {"target": f"document:{doc['id']}", "body": "internal"}, format="json")
    for user in (agency.dev, pm2):
        feed = world.api(user).get("/api/activity/").json()
        dashboard = world.api(user).get("/api/dashboard/").json()["activity"]
        assert not [a for a in feed + dashboard if a["target_type"] == "document"]
    assert [a for a in world.api(agency.pm).get("/api/activity/").json() if a["target_type"] == "document"]
    timeline = world.api(lonely_pm).get(f"/api/clients/{agency.client.pk}/timeline/").json()
    assert not [i for i in timeline if i["type"] == "activity" and i["data"]["project"] == agency.project.pk]
    assert world.api(agency.dev).get("/api/activity/?limit=abc").status_code == 400
    assert world.api(agency.pm).get("/api/reports/overview/?user=abc").status_code == 400


def test_cash_collected_per_project_is_billing_data(agency, world):
    invoice = _sent_invoice(agency, world)
    invoicing.record_payment(invoice, amount=Decimal("100.00"), method="bank_transfer", actor=agency.owner)
    rows = world.api(agency.pm).get("/api/reports/overview/").json()["projects"]
    assert rows and all("collected" not in row for row in rows)
    header = world.api(agency.pm).get("/api/reports/export/projects/").content.decode().splitlines()[0]
    assert "collected" not in header.split(",")
    assert "collected" not in world.api(agency.pm).get(f"/api/projects/{agency.project.pk}/").json()["budget"]
    assert world.api(agency.owner).get(f"/api/projects/{agency.project.pk}/").json()["budget"]["collected"] == "100.00"


def test_task_moves_cannot_smuggle_people_onto_projects(agency, world):
    colleague = world.member(agency.org, Role.MEMBER, "Colleague")
    ProjectMember.objects.create(project=agency.project, user=colleague)
    other_lead = world.member(agency.org, Role.PROJECT_MANAGER, "Other Lead")
    secret = world.project(agency.org, agency.client, other_lead, members=[agency.dev], code="SECRET-B")
    task = world.task(agency.project, "Move me", assignee=agency.dev)
    api = world.api(agency.dev)
    r = api.patch(f"/api/tasks/{task.pk}/", {"project": secret.pk, "assignee": colleague.pk}, format="json")
    assert r.status_code == 400
    moving_task = world.task(agency.project, "Assigned to colleague", assignee=colleague)
    assert api.patch(f"/api/tasks/{moving_task.pk}/", {"project": secret.pk}, format="json").status_code == 400
    assert world.api(colleague).get(f"/api/projects/{secret.pk}/").status_code == 404
    # Owners and admins see every project anyway, so members may assign them.
    assert api.patch(f"/api/tasks/{task.pk}/", {"assignee": agency.owner.pk}, format="json").status_code == 200


def test_reactivation_and_stale_invitations_do_not_restore_billing(agency, world):
    no_billing_admin = world.member(agency.org, Role.ADMIN, "Ada Admin", can_manage_billing=False)
    billing_admin = world.member(agency.org, Role.ADMIN, "Bill Admin")
    target = Membership.objects.get(organization=agency.org, user=billing_admin)
    target.status = Membership.Status.DEACTIVATED
    target.save()
    r = world.api(no_billing_admin).post(f"/api/team/members/{target.pk}/reactivate/")
    assert r.status_code == 200
    target.refresh_from_db()
    assert target.status == Membership.Status.ACTIVE and target.can_manage_billing is False
    co_owner = world.member(agency.org, Role.OWNER, "Co Owner")
    co_owner_membership = Membership.objects.get(organization=agency.org, user=co_owner)
    co_owner_membership.status = Membership.Status.DEACTIVATED
    co_owner_membership.save()
    assert world.api(no_billing_admin).post(f"/api/team/members/{co_owner_membership.pk}/reactivate/").status_code == 403
    inviter = world.member(agency.org, Role.ADMIN, "Leaving Admin")
    invitation, _ = account_services.invite_member(organization=agency.org, email="late@example.test",
                                                   role=Role.ADMIN, invited_by=inviter)
    Membership.objects.filter(organization=agency.org, user=inviter).update(status=Membership.Status.DEACTIVATED)
    membership = account_services.accept_invitation(invitation=invitation, user=world.user("Late", email="late@example.test"))
    assert membership.can_manage_billing is False


def test_documents_and_projects_cannot_be_moved_across_scopes(agency, world):
    other_lead = world.member(agency.org, Role.PROJECT_MANAGER, "Other Lead")
    other_project = world.project(agency.org, agency.client, other_lead, members=[agency.pm], code="ACME-777",
                                  budget_amount=Decimal("98765.00"))
    api = world.api(agency.pm)
    doc = api.post("/api/documents/", {"kind": "contract", "title": "Budget probe", "client": agency.client.pk,
                                       "body": "Budget: {{project.budget}}"}, format="json").json()
    assert api.patch(f"/api/documents/{doc['id']}/", {"project": other_project.pk}, format="json").status_code == 403
    globex = world.client_record(agency.org, "Globex")
    r = world.api(agency.owner).patch(f"/api/projects/{agency.project.pk}/", {"client": globex.pk}, format="json")
    assert r.status_code == 400 and "client" in r.json()["error"]["fields"]


def test_portal_never_names_unshared_projects_or_milestones(agency, world):
    from apps.projects.models import Deliverable

    hidden = world.project(agency.org, agency.client, agency.pm, code="ACME-HID", client_visible=False)
    Document.objects.create(organization=agency.org, title="NDA", client=agency.client, project=hidden, body="x",
                            created_by=agency.owner, status="sent")
    secret_ms = Milestone.objects.create(organization=agency.org, project=agency.project, name="Internal hardening",
                                         client_visible=False)
    Deliverable.objects.create(organization=agency.org, project=agency.project, milestone=secret_ms,
                               title="Hardening report", status="pending_approval", submitted_by=agency.pm)
    portal = world.api(agency.portal_user)
    docs = portal.get("/api/portal/documents/").json()
    assert docs and all(d["project"] is None for d in docs)
    summary = portal.get("/api/portal/summary/").json()
    assert all(a.get("project") != hidden.name for a in summary["approvals"])
    detail = portal.get(f"/api/portal/projects/{agency.project.pk}/").json()
    assert [d["milestone"] for d in detail["deliverables"]] == [None]
    # Activity about a milestone disappears from the portal once the milestone is hidden.
    shown = Milestone.objects.create(organization=agency.org, project=agency.project, name="Vendor swap")
    assert world.api(agency.pm).post(f"/api/milestones/{shown.pk}/complete/", {"force": True}, format="json").status_code == 200
    world.api(agency.pm).patch(f"/api/milestones/{shown.pk}/", {"client_visible": False}, format="json")
    activity = portal.get(f"/api/portal/projects/{agency.project.pk}/").json()["activity"]
    assert not [a for a in activity if a["target_label"] == "Vendor swap"]
