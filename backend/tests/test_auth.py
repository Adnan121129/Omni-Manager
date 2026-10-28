import re

import pytest
from django.core import mail
from rest_framework.test import APIClient

from apps.accounts.models import Invitation, Membership, Organization, Role, User

from .conftest import PASSWORD


@pytest.mark.django_db
def test_signup_creates_workspace_and_owner_and_logs_in():
    client = APIClient()
    response = client.post("/api/auth/signup/", {"full_name": "Ada Owner", "email": "ADA@Example.test",
                                                 "password": "A-very-good-passw0rd", "organization_name": "Ada Studio"},
                           format="json")
    assert response.status_code == 201
    body = response.json()
    assert body["membership"]["role"] == "owner"
    assert body["organization"]["name"] == "Ada Studio"
    user = User.objects.get(email="ada@example.test")
    org = Organization.objects.get(name="Ada Studio")
    assert Membership.objects.filter(user=user, organization=org, role=Role.OWNER).exists()
    # Session is established.
    assert client.get("/api/auth/me/").json()["user"]["email"] == "ada@example.test"


@pytest.mark.django_db
def test_signup_rejects_duplicate_email_and_weak_password(world):
    existing = world.user(email="taken@example.test")
    client = APIClient()
    r = client.post("/api/auth/signup/", {"full_name": "X", "email": existing.email, "password": "A-very-good-passw0rd",
                                          "organization_name": "X"}, format="json")
    assert r.status_code == 400 and "email" in r.json()["error"]["fields"]
    r = client.post("/api/auth/signup/", {"full_name": "Y", "email": "y@example.test", "password": "password",
                                          "organization_name": "Y"}, format="json")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "validation_error"


def test_login_logout_and_bad_credentials(agency):
    client = APIClient()
    r = client.post("/api/auth/login/", {"email": agency.owner.email, "password": "wrong"}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_credentials"
    r = client.post("/api/auth/login/", {"email": agency.owner.email.upper(), "password": PASSWORD}, format="json")
    assert r.status_code == 200
    assert r.json()["permissions"]["is_owner"] is True
    assert client.post("/api/auth/logout/").status_code == 200
    assert client.get("/api/auth/me/").status_code == 403


def test_login_enforces_csrf_for_browser_clients(agency):
    client = APIClient(enforce_csrf_checks=True)
    r = client.post("/api/auth/login/", {"email": agency.owner.email, "password": PASSWORD}, format="json")
    assert r.status_code == 403
    client.get("/api/auth/csrf/")
    token = client.cookies["om_csrftoken"].value
    r = client.post("/api/auth/login/", {"email": agency.owner.email, "password": PASSWORD}, format="json",
                    HTTP_X_CSRFTOKEN=token)
    assert r.status_code == 200


def test_password_reset_flow(agency):
    client = APIClient()
    r = client.post("/api/auth/password-reset/", {"email": agency.dev.email}, format="json")
    assert r.status_code == 200
    # Unknown emails get the same response (no account enumeration).
    assert client.post("/api/auth/password-reset/", {"email": "nobody@example.test"}, format="json").json() == r.json()
    assert len(mail.outbox) == 1
    link = re.search(r"uid=(\S+)&token=(\S+)", mail.outbox[0].body)
    uid, token = link.group(1), link.group(2)
    r = client.post("/api/auth/password-reset/confirm/", {"uid": uid, "token": token, "password": "Brand-new-passw0rd"},
                    format="json")
    assert r.status_code == 200
    assert client.login(email=agency.dev.email, password="Brand-new-passw0rd")
    # Tokens are single use.
    r = client.post("/api/auth/password-reset/confirm/", {"uid": uid, "token": token, "password": "Another-passw0rd1"},
                    format="json")
    assert r.status_code == 400


def test_deactivated_member_loses_access_immediately(agency, world):
    client = world.api(agency.dev)
    assert client.get("/api/projects/").status_code == 200
    Membership.objects.filter(user=agency.dev).update(status=Membership.Status.DEACTIVATED)
    assert client.get("/api/projects/").status_code == 403


def test_owner_cannot_be_demoted_when_last_owner(agency, world):
    client = world.api(agency.owner)
    owner_membership = Membership.objects.get(user=agency.owner)
    r = client.patch(f"/api/team/members/{owner_membership.pk}/", {"role": "admin"}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "last_owner"


def test_admin_cannot_grant_owner_role(agency, world):
    admin = world.member(agency.org, Role.ADMIN, "Ann Admin")
    client = world.api(admin)
    dev_membership = Membership.objects.get(user=agency.dev)
    assert client.patch(f"/api/team/members/{dev_membership.pk}/", {"role": "owner"}, format="json").status_code == 403
    assert client.patch(f"/api/team/members/{dev_membership.pk}/", {"role": "project_manager"}, format="json").status_code == 200


def test_team_member_cannot_manage_team(agency, world):
    client = world.api(agency.dev)
    pm_membership = Membership.objects.get(user=agency.pm)
    assert client.patch(f"/api/team/members/{pm_membership.pk}/", {"role": "admin"}, format="json").status_code == 403
    assert client.post("/api/team/invitations/", {"email": "x@example.test", "role": "member"}, format="json").status_code == 403


def test_invitation_accept_creates_account_and_membership(agency, world, django_capture_on_commit_callbacks):
    owner = world.api(agency.owner)
    with django_capture_on_commit_callbacks(execute=True):
        r = owner.post("/api/team/invitations/", {"email": "new.hire@example.test", "role": "member"}, format="json")
    assert r.status_code == 201
    raw = re.search(r"token=([\w-]+)", mail.outbox[-1].body).group(1)
    invitation = Invitation.objects.get(email="new.hire@example.test")
    assert invitation.token_hash != raw  # only the hash is stored

    anon = APIClient()
    info = anon.get(f"/api/auth/invitations/{raw}/").json()
    assert info["organization"] == "Northwind" and info["account_exists"] is False
    r = anon.post(f"/api/auth/invitations/{raw}/", {"full_name": "New Hire", "password": "Welcome-aboard-2026"},
                  format="json")
    assert r.status_code == 200
    assert r.json()["membership"]["role"] == "member"
    # Token cannot be reused.
    assert APIClient().get(f"/api/auth/invitations/{raw}/").status_code == 404


def test_client_invitation_requires_client(agency, world):
    owner = world.api(agency.owner)
    r = owner.post("/api/team/invitations/", {"email": "c@example.test", "role": "client"}, format="json")
    assert r.status_code == 400
    r = owner.post("/api/team/invitations/", {"email": "c@example.test", "role": "client", "client": agency.client.pk},
                   format="json")
    assert r.status_code == 201


def test_switch_workspace_only_to_own_memberships(agency, world):
    other_org, _ = world.workspace("Other")
    client = world.api(agency.dev)
    assert client.post("/api/auth/switch-workspace/", {"organization_id": other_org.pk}, format="json").status_code == 404
    Membership.objects.create(organization=other_org, user=agency.dev, role=Role.MEMBER)
    r = client.post("/api/auth/switch-workspace/", {"organization_id": other_org.pk}, format="json")
    assert r.status_code == 200 and r.json()["organization"]["name"] == "Other"
    assert len(r.json()["workspaces"]) == 2
