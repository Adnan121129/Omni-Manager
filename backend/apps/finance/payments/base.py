from dataclasses import dataclass
from decimal import Decimal


class WebhookVerificationError(Exception):
    """Raised when a webhook signature or payload cannot be trusted."""


class ProviderNotConfigured(Exception):
    pass


@dataclass
class CheckoutResult:
    """Provider-agnostic view of a checkout's state, as reported by the provider."""

    session_id: str
    status: str  # pending | succeeded | failed | canceled | expired | open
    amount: Decimal | None = None
    currency: str | None = None
    reference: str = ""
    failure_reason: str = ""


@dataclass
class WebhookEventData:
    event_id: str
    event_type: str
    payload: dict
    result: CheckoutResult | None  # None for event types we do not act on


class PaymentProvider:
    name: str = ""
    label: str = ""
    is_test_mode: bool = True
    is_simulator: bool = False

    def create_checkout(self, checkout, *, success_url: str, cancel_url: str, customer_email: str = "") -> tuple[str, str]:
        """Creates a hosted checkout. Returns (provider_session_id, redirect_url)."""
        raise NotImplementedError

    def retrieve(self, checkout) -> CheckoutResult:
        """Fetches the authoritative state of a checkout from the provider."""
        raise NotImplementedError

    def verify_webhook(self, body: bytes, headers) -> WebhookEventData:
        """Verifies the signature and parses the event. Raises WebhookVerificationError."""
        raise NotImplementedError

    def describe(self) -> dict:
        return {"name": self.name, "label": self.label, "test_mode": self.is_test_mode, "simulator": self.is_simulator}
