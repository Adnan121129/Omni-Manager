"""
Local sandbox payment provider.

It behaves like a hosted-checkout provider: the customer is redirected to a checkout page
(served by the React app at /pay/sandbox/<session>), the "provider" records the charge in its
own ledger (SandboxCharge) and then delivers an HMAC-signed webhook. The webhook goes through
exactly the same verification and idempotent processing path as a real provider's webhook.

No money moves and no card data is stored - only the last four digits of the test card.
"""

import hashlib
import hmac
import json
import secrets
import time

from django.conf import settings

from apps.core.money import from_minor_units, to_minor_units

from .base import CheckoutResult, PaymentProvider, ProviderNotConfigured, WebhookEventData, WebhookVerificationError

SIGNATURE_HEADER = "HTTP_X_SANDBOX_SIGNATURE"
TOLERANCE_SECONDS = 300

# Test cards understood by the simulator.
TEST_CARDS = {
    "4242424242424242": ("succeeded", ""),
    "4000000000000002": ("failed", "Your card was declined."),
    "4000000000009995": ("failed", "Your card has insufficient funds."),
}


def _secret() -> bytes:
    secret = settings.SANDBOX_WEBHOOK_SECRET
    if not secret:
        raise ProviderNotConfigured("SANDBOX_WEBHOOK_SECRET is not set.")
    return secret.encode()


def sign(body: bytes, timestamp: int | None = None) -> str:
    timestamp = timestamp or int(time.time())
    digest = hmac.new(_secret(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={digest}"


class SandboxProvider(PaymentProvider):
    name = "sandbox"
    label = "Sandbox (local simulator)"
    is_test_mode = True
    is_simulator = True

    def create_checkout(self, checkout, *, success_url: str, cancel_url: str, customer_email: str = ""):
        from apps.finance.models import SandboxCharge

        _secret()  # fail fast when not configured
        session_id = f"sbx_cs_{secrets.token_urlsafe(18)}"
        SandboxCharge.objects.create(session_id=session_id, amount_minor=to_minor_units(checkout.amount),
                                     currency=checkout.currency)
        return session_id, f"{settings.FRONTEND_URL}/pay/sandbox/{session_id}"

    def retrieve(self, checkout) -> CheckoutResult:
        from apps.finance.models import SandboxCharge

        charge = SandboxCharge.objects.filter(session_id=checkout.provider_session_id).first()
        if charge is None:
            return CheckoutResult(session_id=checkout.provider_session_id, status="failed",
                                  failure_reason="Unknown sandbox session")
        return CheckoutResult(session_id=charge.session_id, status=charge.status,
                              amount=from_minor_units(charge.amount_minor), currency=charge.currency,
                              reference=charge.payment_reference, failure_reason=charge.failure_reason)

    def verify_webhook(self, body: bytes, headers) -> WebhookEventData:
        header = headers.get(SIGNATURE_HEADER) or headers.get("X-Sandbox-Signature") or ""
        try:
            parts = dict(item.split("=", 1) for item in header.split(","))
            timestamp = int(parts["t"])
            signature = parts["v1"]
        except (KeyError, ValueError):
            raise WebhookVerificationError("Missing or malformed signature header.")
        if abs(time.time() - timestamp) > TOLERANCE_SECONDS:
            raise WebhookVerificationError("Signature timestamp outside the tolerance window.")
        expected = hmac.new(_secret(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise WebhookVerificationError("Signature mismatch.")
        try:
            event = json.loads(body)
        except json.JSONDecodeError:
            raise WebhookVerificationError("Invalid JSON payload.")
        data = event.get("data", {})
        status_map = {"charge.succeeded": "succeeded", "charge.failed": "failed", "checkout.expired": "expired"}
        status = status_map.get(event.get("type"))
        result = None
        if status:
            result = CheckoutResult(session_id=data.get("session_id", ""), status=status,
                                    amount=from_minor_units(int(data.get("amount_minor", 0))),
                                    currency=data.get("currency"), reference=data.get("payment_reference", ""),
                                    failure_reason=data.get("failure_reason", ""))
        return WebhookEventData(event_id=str(event.get("id", "")), event_type=str(event.get("type", "")),
                                payload=event, result=result)


def simulate_payment(session_id: str, card_number: str) -> tuple[bytes, str]:
    """
    Acts as the provider's payment processor: settles the sandbox charge and returns a signed
    webhook (body, signature header) for delivery to our webhook endpoint.
    """
    from apps.finance.models import SandboxCharge

    charge = SandboxCharge.objects.select_for_update(of=("self",)).get(session_id=session_id)
    digits = "".join(ch for ch in card_number if ch.isdigit())
    if charge.status in ("succeeded", "failed", "expired", "canceled"):
        outcome, reason = charge.status, charge.failure_reason
    else:
        outcome, reason = TEST_CARDS.get(digits, ("failed", "Use a sandbox test card number."))
        charge.status = outcome
        charge.failure_reason = reason
        charge.card_last4 = digits[-4:]
        if outcome == "succeeded":
            charge.payment_reference = f"sbx_pi_{secrets.token_urlsafe(12)}"
        charge.save()
    event = {
        "id": f"evt_sbx_{secrets.token_urlsafe(12)}",
        "type": "charge.succeeded" if outcome == "succeeded" else "charge.failed",
        "created": int(time.time()),
        "data": {"session_id": charge.session_id, "amount_minor": charge.amount_minor, "currency": charge.currency,
                 "payment_reference": charge.payment_reference, "failure_reason": reason,
                 "card_last4": charge.card_last4},
    }
    body = json.dumps(event, separators=(",", ":")).encode()
    return body, sign(body)
