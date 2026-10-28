"""
Stripe Checkout integration (use test-mode keys). Requires STRIPE_SECRET_KEY and
STRIPE_WEBHOOK_SECRET. Card data never touches this server - Stripe hosts the checkout.
"""

from django.conf import settings

from apps.core.money import from_minor_units, to_minor_units

from .base import CheckoutResult, PaymentProvider, ProviderNotConfigured, WebhookEventData, WebhookVerificationError


def _stripe():
    import stripe

    if not settings.STRIPE_SECRET_KEY:
        raise ProviderNotConfigured("STRIPE_SECRET_KEY is not set.")
    stripe.api_key = settings.STRIPE_SECRET_KEY
    return stripe


def _result_from_session(session) -> CheckoutResult:
    payment_status = session.get("payment_status")
    status = session.get("status")
    if payment_status in ("paid", "no_payment_required"):
        normalized = "succeeded"
    elif status == "expired":
        normalized = "expired"
    elif status == "complete":
        normalized = "pending"  # completed checkout awaiting an asynchronous payment method
    else:
        normalized = "open"
    amount = session.get("amount_total")
    return CheckoutResult(session_id=session["id"], status=normalized,
                          amount=from_minor_units(amount) if amount is not None else None,
                          currency=(session.get("currency") or "").upper() or None,
                          reference=str(session.get("payment_intent") or ""))


class StripeProvider(PaymentProvider):
    name = "stripe"
    label = "Stripe Checkout"

    @property
    def is_test_mode(self):  # type: ignore[override]
        return settings.STRIPE_SECRET_KEY.startswith("sk_test_")

    def create_checkout(self, checkout, *, success_url: str, cancel_url: str, customer_email: str = ""):
        stripe = _stripe()
        invoice = checkout.invoice
        session = stripe.checkout.Session.create(
            mode="payment",
            line_items=[{
                "quantity": 1,
                "price_data": {
                    "currency": checkout.currency.lower(),
                    "unit_amount": to_minor_units(checkout.amount),
                    "product_data": {"name": f"Invoice {invoice.number}"},
                },
            }],
            success_url=success_url,
            cancel_url=cancel_url,
            client_reference_id=str(checkout.pk),
            customer_email=customer_email or None,
            metadata={"invoice_id": str(invoice.pk), "checkout_id": str(checkout.pk),
                      "organization_id": str(invoice.organization_id)},
            payment_intent_data={"metadata": {"invoice_id": str(invoice.pk), "checkout_id": str(checkout.pk)}},
            idempotency_key=f"om-checkout-{checkout.pk}",
        )
        return session["id"], session["url"]

    def retrieve(self, checkout) -> CheckoutResult:
        stripe = _stripe()
        session = stripe.checkout.Session.retrieve(checkout.provider_session_id)
        return _result_from_session(session)

    def verify_webhook(self, body: bytes, headers) -> WebhookEventData:
        import stripe

        secret = settings.STRIPE_WEBHOOK_SECRET
        if not secret:
            raise ProviderNotConfigured("STRIPE_WEBHOOK_SECRET is not set.")
        signature = headers.get("HTTP_STRIPE_SIGNATURE") or headers.get("Stripe-Signature") or ""
        try:
            event = stripe.Webhook.construct_event(body, signature, secret)
        except (ValueError, stripe.error.SignatureVerificationError) as exc:
            raise WebhookVerificationError(str(exc))
        event_type = event["type"]
        obj = event["data"]["object"]
        result = None
        if event_type in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
            result = _result_from_session(obj)
        elif event_type == "checkout.session.async_payment_failed":
            result = _result_from_session(obj)
            result.status = "failed"
            result.failure_reason = "The payment could not be completed."
        elif event_type == "checkout.session.expired":
            result = _result_from_session(obj)
            result.status = "expired"
        payload = event.to_dict() if hasattr(event, "to_dict") else dict(event)
        return WebhookEventData(event_id=event["id"], event_type=event_type, payload=payload, result=result)
