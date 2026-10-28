"""
Payment provider registry and the provider-independent processing pipeline.

Invoices are only marked paid from provider-verified data: either a signature-verified webhook
or a server-side `retrieve()` call to the provider. A browser redirect alone never changes state.
"""

import logging
from datetime import timedelta

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.core.activity import log_activity
from apps.core.exceptions import BusinessRuleError
from apps.core.money import q2
from apps.core.notify import notify

from .base import CheckoutResult, PaymentProvider, ProviderNotConfigured, WebhookVerificationError
from .sandbox import SandboxProvider
from .stripe_provider import StripeProvider

logger = logging.getLogger(__name__)

PROVIDERS: dict[str, type[PaymentProvider]] = {"sandbox": SandboxProvider, "stripe": StripeProvider}


def get_provider(name: str | None = None) -> PaymentProvider:
    name = name or settings.PAYMENT_PROVIDER
    cls = PROVIDERS.get(name)
    if cls is None:
        raise ProviderNotConfigured(f"Unknown payment provider '{name}'.")
    return cls()


def provider_status() -> dict:
    provider = get_provider()
    configured = True
    problem = ""
    if provider.name == "sandbox" and not settings.SANDBOX_WEBHOOK_SECRET:
        configured, problem = False, "SANDBOX_WEBHOOK_SECRET is not set."
    if provider.name == "stripe" and not (settings.STRIPE_SECRET_KEY and settings.STRIPE_WEBHOOK_SECRET):
        configured, problem = False, "STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set."
    return {**provider.describe(), "configured": configured, "problem": problem}


@transaction.atomic
def create_checkout(invoice, *, amount, initiated_by, customer_email: str = ""):
    from apps.finance.models import CheckoutSession, Invoice

    invoice = Invoice.objects.select_for_update(of=("self",)).select_related("organization").get(pk=invoice.pk)
    amount = q2(amount)
    if invoice.status not in Invoice.OPEN_STATUSES:
        raise BusinessRuleError("This invoice is not open for payment.", code="invoice_not_open")
    if not invoice.allow_online_payment:
        raise BusinessRuleError("Online payment is not enabled for this invoice.", code="online_payment_disabled")
    if amount <= 0 or amount > invoice.amount_due:
        raise BusinessRuleError(f"Amount must be between 0.01 and the balance due ({invoice.amount_due}).",
                                code="invalid_amount")
    if amount != invoice.amount_due and not invoice.organization.allow_partial_payments:
        raise BusinessRuleError("Partial payments are not accepted for this invoice.", code="partial_not_allowed")
    provider = get_provider()
    # Re-use a recent open checkout for the same amount (double clicks, page refreshes).
    recent = CheckoutSession.objects.filter(invoice=invoice, provider=provider.name, amount=amount, status="open",
                                            created_at__gte=timezone.now() - timedelta(minutes=30)).first()
    if recent is not None and recent.checkout_url:
        return recent
    checkout = CheckoutSession.objects.create(organization=invoice.organization, invoice=invoice, provider=provider.name,
                                              provider_session_id=f"pending-{timezone.now().timestamp()}-{invoice.pk}",
                                              amount=amount, currency=invoice.currency, initiated_by=initiated_by)
    base = f"{settings.FRONTEND_URL}/portal/invoices/{invoice.pk}"
    session_id, url = provider.create_checkout(checkout, success_url=f"{base}?checkout={checkout.pk}",
                                               cancel_url=f"{base}?checkout={checkout.pk}&canceled=1",
                                               customer_email=customer_email)
    checkout.provider_session_id = session_id
    checkout.checkout_url = url
    checkout.save(update_fields=["provider_session_id", "checkout_url", "updated_at"])
    log_activity(organization=invoice.organization, actor=initiated_by, verb="started_checkout", target=invoice,
                 client=invoice.client, provider=provider.name, amount=amount)
    return checkout


@transaction.atomic
def apply_result(provider_name: str, result: CheckoutResult, *, source: str) -> str:
    """Applies a provider-verified checkout result. Safe to call repeatedly for the same result."""
    from apps.crm.services import portal_users
    from apps.finance.invoicing import billing_users, recalculate, record_payment
    from apps.finance.models import CheckoutSession, Invoice, Payment

    checkout = (CheckoutSession.objects.select_for_update(of=("self",)).select_related("invoice")
                .filter(provider=provider_name, provider_session_id=result.session_id).first())
    if checkout is None:
        logger.warning("Payment result for unknown %s session", provider_name)
        return "unknown_session"
    if checkout.status == CheckoutSession.Status.SUCCEEDED:
        return "already_processed"
    invoice = Invoice.objects.select_for_update(of=("self",)).get(pk=checkout.invoice_id)

    if result.status == "succeeded":
        amount = q2(result.amount if result.amount is not None else checkout.amount)
        if (result.currency or checkout.currency).upper() != checkout.currency:
            logger.error("Currency mismatch for checkout %s", checkout.pk)
            checkout.status = CheckoutSession.Status.FAILED
            checkout.failure_reason = "Currency mismatch reported by provider"
            checkout.save(update_fields=["status", "failure_reason", "updated_at"])
            return "currency_mismatch"
        reference = result.reference or result.session_id
        if Payment.objects.filter(provider=provider_name, provider_reference=reference).exists():
            checkout.status = CheckoutSession.Status.SUCCEEDED
            checkout.save(update_fields=["status", "updated_at"])
            return "already_processed"
        if invoice.status in Invoice.OPEN_STATUSES:
            # Money has been captured by the provider, so it is always recorded; any excess over the
            # balance (e.g. a manual payment recorded meanwhile) is flagged rather than rejected.
            overpaid = amount > invoice.amount_due
            record_payment(invoice, amount=amount, method="card", provider=provider_name, reference=reference,
                           checkout=checkout, note=f"Online payment ({source})", allow_overpayment=True)
            if overpaid:
                log_activity(organization=invoice.organization, actor=None, verb="payment_overpaid", target=invoice,
                             amount=amount)
        else:
            # Invoice was voided/paid in the meantime: keep a record for refund handling.
            Payment.objects.create(organization=invoice.organization, invoice=invoice, amount=amount,
                                   currency=checkout.currency, method="card", provider=provider_name,
                                   provider_reference=reference, checkout=checkout,
                                   note="Received while invoice was not open - review for refund")
            recalculate(invoice)
            notify(organization=invoice.organization, recipients=billing_users(invoice.organization),
                   kind="payment_received", title=f"Review payment on {invoice.number}",
                   body="An online payment arrived for an invoice that was not open.", link=f"/invoices/{invoice.pk}")
        checkout.status = CheckoutSession.Status.SUCCEEDED
        checkout.completed_at = timezone.now()
        checkout.save(update_fields=["status", "completed_at", "updated_at"])
        return "succeeded"

    if result.status == "failed":
        if checkout.status != CheckoutSession.Status.FAILED:
            checkout.status = CheckoutSession.Status.FAILED
            checkout.failure_reason = (result.failure_reason or "Payment failed")[:255]
            checkout.save(update_fields=["status", "failure_reason", "updated_at"])
            log_activity(organization=invoice.organization, actor=None, verb="payment_failed", target=invoice,
                         client=invoice.client, reason=checkout.failure_reason, provider=provider_name)
            recipients = billing_users(invoice.organization) + portal_users(invoice.client)
            notify(organization=invoice.organization, recipients=recipients, kind="payment_failed",
                   title=f"Payment for {invoice.number} failed", body=checkout.failure_reason,
                   link=f"/invoices/{invoice.pk}", dedupe_key=f"checkout_failed:{checkout.pk}")
        return "failed"

    if result.status in ("expired", "canceled"):
        checkout.status = result.status
        checkout.save(update_fields=["status", "updated_at"])
        return result.status
    if result.status == "pending" and checkout.status == CheckoutSession.Status.OPEN:
        checkout.status = CheckoutSession.Status.PENDING
        checkout.save(update_fields=["status", "updated_at"])
    return result.status


def process_webhook(provider_name: str, body: bytes, headers) -> str:
    """Verifies, de-duplicates and applies a provider webhook. Returns a short outcome string."""
    from apps.finance.models import WebhookEvent

    provider = get_provider(provider_name)
    event = provider.verify_webhook(body, headers)  # raises WebhookVerificationError
    with transaction.atomic():
        try:
            with transaction.atomic():
                record = WebhookEvent.objects.create(provider=provider_name, event_id=event.event_id,
                                                     event_type=event.event_type, payload=event.payload)
        except IntegrityError:
            return "duplicate"
        if event.result is None:
            record.status = "ignored"
        else:
            record.status = apply_result(provider_name, event.result, source="webhook")
        record.processed_at = timezone.now()
        record.save(update_fields=["status", "processed_at"])
        return record.status


def verify_checkout(checkout) -> str:
    """Server-side verification used when the customer returns from the provider's checkout."""
    if checkout.status in ("succeeded", "failed", "expired", "canceled"):
        return checkout.status
    provider = get_provider(checkout.provider)
    result = provider.retrieve(checkout)
    if result.status in ("open",):
        return checkout.status
    return apply_result(checkout.provider, result, source="verification")


__all__ = ["get_provider", "provider_status", "create_checkout", "process_webhook", "verify_checkout",
           "WebhookVerificationError", "ProviderNotConfigured"]
