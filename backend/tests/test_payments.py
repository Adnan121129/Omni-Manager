import json
import time
from decimal import Decimal
from unittest import mock

import pytest
from django.test import override_settings
from rest_framework.test import APIClient

from apps.finance import invoicing, payments
from apps.finance.models import CheckoutSession, Invoice, Payment, WebhookEvent
from apps.finance.payments import sandbox


@pytest.fixture
def open_invoice(agency, world):
    world.entry(agency.project, agency.dev, "10", "approved")  # USD 1500.00
    invoice = invoicing.generate_from_work(organization=agency.org, client=agency.client,
                                           project_ids=[agency.project.pk], actor=agency.owner)
    return invoicing.send_invoice(invoice, agency.owner, send_email=False)


def _checkout(world, agency, invoice, amount=None):
    portal = world.api(agency.portal_user)
    payload = {"amount": str(amount)} if amount is not None else {}
    r = portal.post(f"/api/portal/invoices/{invoice.pk}/checkout/", payload, format="json")
    assert r.status_code == 201, r.content
    return portal, r.json()


def test_full_sandbox_payment_flow_is_verified_server_side(agency, world, open_invoice):
    portal, checkout = _checkout(world, agency, open_invoice)
    session_id = checkout["checkout_url"].rsplit("/", 1)[1]
    # Visiting the success URL before paying does not mark anything paid.
    status = portal.get(f"/api/portal/checkouts/{checkout['checkout_id']}/").json()
    assert status["status"] == "open" and status["invoice"]["amount_due"] == "1500.00"

    anon = APIClient()
    r = anon.post(f"/api/payments/sandbox/{session_id}/", {"card_number": "4242 4242 4242 4242"}, format="json")
    assert r.json()["status"] == "succeeded"
    open_invoice.refresh_from_db()
    assert open_invoice.status == "paid" and open_invoice.amount_due == Decimal("0.00")
    payment = Payment.objects.get(invoice=open_invoice)
    assert payment.provider == "sandbox" and payment.provider_reference.startswith("sbx_pi_")
    status = portal.get(f"/api/portal/checkouts/{checkout['checkout_id']}/").json()
    assert status["status"] == "succeeded" and status["invoice"]["status"] == "paid"


def test_declined_card_records_failure(agency, world, open_invoice):
    portal, checkout = _checkout(world, agency, open_invoice)
    session_id = checkout["checkout_url"].rsplit("/", 1)[1]
    r = APIClient().post(f"/api/payments/sandbox/{session_id}/", {"card_number": "4000000000000002"}, format="json")
    assert r.json()["status"] == "failed"
    assert CheckoutSession.objects.get(pk=checkout["checkout_id"]).status == "failed"
    open_invoice.refresh_from_db()
    assert open_invoice.amount_due == Decimal("1500.00") and not Payment.objects.exists()


def test_partial_online_payment(agency, world, open_invoice):
    portal, checkout = _checkout(world, agency, open_invoice, Decimal("500.00"))
    session_id = checkout["checkout_url"].rsplit("/", 1)[1]
    APIClient().post(f"/api/payments/sandbox/{session_id}/", {"card_number": "4242424242424242"}, format="json")
    open_invoice.refresh_from_db()
    assert open_invoice.status == "partially_paid" and open_invoice.amount_due == Decimal("1000.00")


def test_partial_payments_can_be_disabled(agency, world, open_invoice):
    agency.org.allow_partial_payments = False
    agency.org.save()
    r = world.api(agency.portal_user).post(f"/api/portal/invoices/{open_invoice.pk}/checkout/", {"amount": "10.00"},
                                           format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "partial_not_allowed"


def test_checkout_amount_cannot_exceed_balance(agency, world, open_invoice):
    r = world.api(agency.portal_user).post(f"/api/portal/invoices/{open_invoice.pk}/checkout/", {"amount": "1500.01"},
                                           format="json")
    assert r.status_code == 400


def test_webhook_rejects_bad_signatures(agency, world, open_invoice):
    portal, checkout = _checkout(world, agency, open_invoice)
    session_id = checkout["checkout_url"].rsplit("/", 1)[1]
    body = json.dumps({"id": "evt_forged", "type": "charge.succeeded",
                       "data": {"session_id": session_id, "amount_minor": 150000, "currency": "USD",
                                "payment_reference": "forged"}}).encode()
    anon = APIClient()
    r = anon.post("/api/payments/webhooks/sandbox/", data=body, content_type="application/json",
                  HTTP_X_SANDBOX_SIGNATURE=f"t={int(time.time())},v1={'0' * 64}")
    assert r.status_code == 400
    r = anon.post("/api/payments/webhooks/sandbox/", data=body, content_type="application/json")
    assert r.status_code == 400
    old = int(time.time()) - 3600
    r = anon.post("/api/payments/webhooks/sandbox/", data=body, content_type="application/json",
                  HTTP_X_SANDBOX_SIGNATURE=sandbox.sign(body, old))
    assert r.status_code == 400  # replayed outside the tolerance window
    open_invoice.refresh_from_db()
    assert open_invoice.amount_due == Decimal("1500.00")


def test_webhook_processing_is_idempotent(agency, world, open_invoice):
    from apps.finance.models import SandboxCharge

    portal, checkout = _checkout(world, agency, open_invoice)
    session_id = checkout["checkout_url"].rsplit("/", 1)[1]
    SandboxCharge.objects.filter(session_id=session_id).update(status="succeeded", payment_reference="sbx_pi_1")
    event = {"id": "evt_1", "type": "charge.succeeded",
             "data": {"session_id": session_id, "amount_minor": 150000, "currency": "USD", "payment_reference": "sbx_pi_1"}}
    body = json.dumps(event).encode()
    anon = APIClient()
    for _ in range(3):
        r = anon.post("/api/payments/webhooks/sandbox/", data=body, content_type="application/json",
                      HTTP_X_SANDBOX_SIGNATURE=sandbox.sign(body))
        assert r.status_code == 200
    # A different event id for the same payment is also absorbed.
    event["id"] = "evt_2"
    body = json.dumps(event).encode()
    r = anon.post("/api/payments/webhooks/sandbox/", data=body, content_type="application/json",
                  HTTP_X_SANDBOX_SIGNATURE=sandbox.sign(body))
    assert r.json()["outcome"] == "already_processed"
    assert Payment.objects.filter(invoice=open_invoice).count() == 1
    assert WebhookEvent.objects.count() == 2
    open_invoice.refresh_from_db()
    assert open_invoice.amount_paid == Decimal("1500.00")


def test_webhook_amount_currency_mismatch_is_not_applied(agency, world, open_invoice):
    portal, checkout = _checkout(world, agency, open_invoice)
    session_id = checkout["checkout_url"].rsplit("/", 1)[1]
    body = json.dumps({"id": "evt_eur", "type": "charge.succeeded",
                       "data": {"session_id": session_id, "amount_minor": 150000, "currency": "EUR",
                                "payment_reference": "x"}}).encode()
    r = APIClient().post("/api/payments/webhooks/sandbox/", data=body, content_type="application/json",
                         HTTP_X_SANDBOX_SIGNATURE=sandbox.sign(body))
    assert r.json()["outcome"] == "currency_mismatch"
    assert not Payment.objects.exists()


@override_settings(PAYMENT_PROVIDER="stripe", STRIPE_SECRET_KEY="sk_test_dummy", STRIPE_WEBHOOK_SECRET="whsec_test")
def test_stripe_checkout_and_signed_webhook(agency, world, open_invoice):
    import stripe

    fake_session = {"id": "cs_test_123", "url": "https://checkout.stripe.com/c/pay/cs_test_123"}
    with mock.patch.object(stripe.checkout.Session, "create", return_value=fake_session) as create:
        portal, checkout = _checkout(world, agency, open_invoice, Decimal("1500.00"))
    kwargs = create.call_args.kwargs
    assert kwargs["line_items"][0]["price_data"]["unit_amount"] == 150000
    assert kwargs["line_items"][0]["price_data"]["currency"] == "usd"
    assert checkout["checkout_url"] == fake_session["url"]

    payload = json.dumps({
        "id": "evt_stripe_1", "object": "event", "type": "checkout.session.completed",
        "data": {"object": {"id": "cs_test_123", "object": "checkout.session", "payment_status": "paid",
                            "status": "complete", "amount_total": 150000, "currency": "usd",
                            "payment_intent": "pi_test_123"}},
    })
    timestamp = int(time.time())
    signature = stripe.WebhookSignature._compute_signature(f"{timestamp}.{payload}", "whsec_test")
    header = f"t={timestamp},v1={signature}"
    anon = APIClient()
    bad = anon.post("/api/payments/webhooks/stripe/", data=payload, content_type="application/json",
                    HTTP_STRIPE_SIGNATURE=f"t={timestamp},v1={'0' * 64}")
    assert bad.status_code == 400
    ok = anon.post("/api/payments/webhooks/stripe/", data=payload, content_type="application/json",
                   HTTP_STRIPE_SIGNATURE=header)
    assert ok.status_code == 200 and ok.json()["outcome"] == "succeeded"
    open_invoice.refresh_from_db()
    assert open_invoice.status == "paid"
    assert Payment.objects.get().provider_reference == "pi_test_123"


@override_settings(PAYMENT_PROVIDER="stripe", STRIPE_SECRET_KEY="sk_test_dummy", STRIPE_WEBHOOK_SECRET="whsec_test")
def test_stripe_return_url_verifies_with_provider(agency, world, open_invoice):
    import stripe

    with mock.patch.object(stripe.checkout.Session, "create", return_value={"id": "cs_2", "url": "https://x"}):
        portal, checkout = _checkout(world, agency, open_invoice)
    unpaid = {"id": "cs_2", "payment_status": "unpaid", "status": "open", "amount_total": 150000, "currency": "usd",
              "payment_intent": None}
    with mock.patch.object(stripe.checkout.Session, "retrieve", return_value=unpaid):
        assert portal.get(f"/api/portal/checkouts/{checkout['checkout_id']}/").json()["status"] == "open"
    paid = {**unpaid, "payment_status": "paid", "status": "complete", "payment_intent": "pi_2"}
    with mock.patch.object(stripe.checkout.Session, "retrieve", return_value=paid):
        assert portal.get(f"/api/portal/checkouts/{checkout['checkout_id']}/").json()["status"] == "succeeded"
    open_invoice.refresh_from_db()
    assert open_invoice.status == "paid"


def test_only_the_invoice_client_can_pay(agency, world, open_invoice):
    from apps.accounts.models import Role

    other_client = world.client_record(agency.org, "Globex")
    other_contact = world.member(agency.org, Role.CLIENT, "Other", client=other_client)
    r = world.api(other_contact).post(f"/api/portal/invoices/{open_invoice.pk}/checkout/", {}, format="json")
    assert r.status_code == 404


def test_void_invoice_cannot_be_paid(agency, world, open_invoice):
    invoicing.void_invoice(open_invoice, agency.owner, "Duplicate")
    r = world.api(agency.portal_user).post(f"/api/portal/invoices/{open_invoice.pk}/checkout/", {}, format="json")
    assert r.status_code == 400 and r.json()["error"]["code"] == "invoice_not_open"
