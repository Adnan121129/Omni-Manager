from datetime import timedelta

import pytest
from django.utils import timezone

from apps.accounts.models import Role
from apps.documents import services
from apps.documents.models import ContractTemplate, Document, DocumentEvent, SignatureRecord

PNG = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")


@pytest.fixture
def contract(agency, world):
    template = ContractTemplate.objects.get(organization=agency.org, kind="contract")
    api = world.api(agency.pm)
    r = api.post("/api/documents/", {
        "title": "Services agreement", "client": agency.client.pk, "project": agency.project.pk,
        "template": template.pk, "scope": "Build the <b>checkout</b>",
        "pricing_items": [{"description": "Design", "quantity": "10", "unit_price": "150"},
                          {"description": "Build", "quantity": "1", "unit_price": "5000"}],
        "expires_at": str(timezone.localdate() + timedelta(days=14)),
    }, format="json")
    assert r.status_code == 201, r.content
    return Document.objects.get(pk=r.json()["id"])


def test_template_placeholders_and_pricing_render(contract, agency, world):
    assert contract.total_amount == 6500
    preview = world.api(agency.pm).get(f"/api/documents/{contract.pk}/preview/").json()
    html = preview["html"]
    assert agency.client.name in html and agency.project.name in html
    assert "USD 6,500.00" in html and "<table" in html
    assert "<b>" not in html  # user-supplied markup is sanitised


def test_full_signing_flow_with_audit_trail(contract, agency, world):
    pm = world.api(agency.pm)
    r = pm.post(f"/api/documents/{contract.pk}/send/", {}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "sent" and r.json()["current_version"] == 1
    assert pm.patch(f"/api/documents/{contract.pk}/", {"title": "x"}, format="json").status_code == 400  # locked

    portal = world.api(agency.portal_user)
    doc = portal.get(f"/api/portal/documents/{contract.pk}/").json()
    assert doc["status"] == "viewed" and doc["content_hash"]
    payload = {"version": doc["version"], "content_hash": doc["content_hash"], "signer_name": "Casey Client",
               "signer_title": "CEO", "method": "drawn", "signature_image": PNG, "consent": True}
    assert portal.post(f"/api/portal/documents/{contract.pk}/sign/", {**payload, "consent": False},
                       format="json").json()["error"]["code"] == "consent_required"
    r = portal.post(f"/api/portal/documents/{contract.pk}/sign/", {**payload, "content_hash": "0" * 64}, format="json")
    assert r.status_code == 409 and r.json()["error"]["code"] == "version_mismatch"
    r = portal.post(f"/api/portal/documents/{contract.pk}/sign/", payload, format="json",
                    HTTP_USER_AGENT="TestBrowser/1.0", REMOTE_ADDR="198.51.100.7")
    assert r.status_code == 200 and r.json()["status"] == "signed"

    record = SignatureRecord.objects.get(document=contract)
    assert record.signer == agency.portal_user and record.signer_name == "Casey Client"
    assert record.content_hash == doc["content_hash"] and record.version.version == 1
    assert record.ip_address == "198.51.100.7" and record.user_agent == "TestBrowser/1.0"
    events = list(DocumentEvent.objects.filter(document=contract).values_list("event", flat=True))
    assert events == ["created", "sent", "viewed", "signed"]
    detail = pm.get(f"/api/documents/{contract.pk}/").json()
    assert detail["audit"] == {"valid": True, "broken_at": None}
    # Signing twice is not possible, and signed documents cannot be revised.
    assert portal.post(f"/api/portal/documents/{contract.pk}/sign/", payload, format="json").status_code == 400
    assert pm.post(f"/api/documents/{contract.pk}/revise/").status_code == 400
    pdf = pm.get(f"/api/documents/{contract.pk}/pdf/")
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
    assert world.api(agency.portal_user).get(f"/api/portal/documents/{contract.pk}/pdf/").status_code == 200


@pytest.mark.django_db(transaction=True)
def test_document_lifecycle_in_autocommit_mode(contract, agency, world):
    """
    Runs without the per-test wrapping transaction, the way the real server executes requests.
    Regression: creating a document used a row lock outside any transaction and failed with a 500.
    """
    assert list(contract.events.values_list("event", flat=True)) == ["created"]
    pm, portal = world.api(agency.pm), world.api(agency.portal_user)
    assert pm.post(f"/api/documents/{contract.pk}/send/", {}, format="json").status_code == 200
    doc = portal.get(f"/api/portal/documents/{contract.pk}/").json()
    r = portal.post(f"/api/portal/documents/{contract.pk}/sign/", {
        "version": doc["version"], "content_hash": doc["content_hash"], "signer_name": "Casey Client",
        "method": "typed", "consent": True}, format="json")
    assert r.status_code == 200 and r.json()["status"] == "signed"
    assert list(contract.events.order_by("sequence").values_list("event", flat=True)) == ["created", "sent", "viewed", "signed"]
    assert pm.get(f"/api/documents/{contract.pk}/").json()["audit"] == {"valid": True, "broken_at": None}


def test_tampering_breaks_the_audit_chain(contract, agency, world):
    services.send_document(contract, agency.pm)
    event = DocumentEvent.objects.filter(document=contract).order_by("sequence").first()
    DocumentEvent.objects.filter(pk=event.pk).update(details={"template": "edited later"})
    assert services.verify_chain(contract) == {"valid": False, "broken_at": event.sequence}


def test_send_requires_portal_contact(agency, world):
    client = world.client_record(agency.org, "No Portal Inc")
    doc = Document.objects.create(organization=agency.org, client=client, title="T", body="Hello", created_by=agency.pm)
    r = world.api(agency.owner).post(f"/api/documents/{doc.pk}/send/", {}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "no_portal_contact"


def test_revision_creates_new_version_and_invalidates_old_hash(contract, agency, world):
    services.send_document(contract, agency.pm)
    old = contract.versions.get(version=1)
    pm = world.api(agency.pm)
    assert pm.post(f"/api/documents/{contract.pk}/revise/").json()["status"] == "draft"
    pm.patch(f"/api/documents/{contract.pk}/", {"scope": "Updated scope"}, format="json")
    pm.post(f"/api/documents/{contract.pk}/send/", {}, format="json")
    new = Document.objects.get(pk=contract.pk).versions.get(version=2)
    assert new.content_hash != old.content_hash
    portal = world.api(agency.portal_user)
    r = portal.post(f"/api/portal/documents/{contract.pk}/sign/", {
        "version": 1, "content_hash": old.content_hash, "signer_name": "Casey", "method": "typed", "consent": True},
        format="json")
    assert r.status_code == 409


def test_decline_and_notifications(contract, agency, world):
    from apps.core.models import Notification

    services.send_document(contract, agency.pm)
    portal = world.api(agency.portal_user)
    assert portal.post(f"/api/portal/documents/{contract.pk}/decline/", {}, format="json").status_code == 400
    assert portal.post(f"/api/portal/documents/{contract.pk}/decline/", {"reason": "Budget too high"},
                       format="json").status_code == 200
    contract.refresh_from_db()
    assert contract.status == "declined" and contract.decline_reason == "Budget too high"
    assert Notification.objects.filter(recipient=agency.pm, kind="document_responded").exists()


def test_expired_documents_cannot_be_signed(contract, agency, world):
    services.send_document(contract, agency.pm)
    Document.objects.filter(pk=contract.pk).update(expires_at=timezone.localdate() - timedelta(days=1))
    version = contract.versions.get(version=1)
    r = world.api(agency.portal_user).post(f"/api/portal/documents/{contract.pk}/sign/", {
        "version": 1, "content_hash": version.content_hash, "signer_name": "Casey", "method": "typed",
        "consent": True}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "expired"
    assert Document.objects.get(pk=contract.pk).status == "expired"


def test_other_clients_cannot_view_or_sign(contract, agency, world):
    services.send_document(contract, agency.pm)
    other_client = world.client_record(agency.org, "Globex")
    intruder = world.member(agency.org, Role.CLIENT, "Gina", client=other_client)
    api = world.api(intruder)
    assert api.get(f"/api/portal/documents/{contract.pk}/").status_code == 404
    assert api.post(f"/api/portal/documents/{contract.pk}/sign/", {}, format="json").status_code == 404
    # Draft documents are never visible to clients.
    draft = Document.objects.create(organization=agency.org, client=agency.client, title="Draft", body="x")
    assert world.api(agency.portal_user).get(f"/api/portal/documents/{draft.pk}/").status_code == 404


def test_only_assigned_signer_may_sign(contract, agency, world):
    second = world.member(agency.org, Role.CLIENT, "Second Contact", client=agency.client)
    services.send_document(contract, agency.pm, signer=agency.portal_user)
    version = contract.versions.get(version=1)
    r = world.api(second).post(f"/api/portal/documents/{contract.pk}/sign/", {
        "version": 1, "content_hash": version.content_hash, "signer_name": "Second", "method": "typed",
        "consent": True}, format="json")
    assert r.status_code == 403
