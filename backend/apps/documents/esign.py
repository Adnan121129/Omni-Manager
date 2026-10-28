"""
E-signature provider boundary.

`builtin` is the only implementation shipped: it records explicit electronic acceptance (drawn or
typed signature, consent text, signer identity, IP, user agent, timestamp, document version and
content hash) with a hash-chained audit trail. That is suitable for many commercial agreements but
is not a qualified/advanced electronic signature and may not meet every jurisdiction's rules.

To use a dedicated provider (e.g. DocuSign, Dropbox Sign), implement `ESignProvider`, select it with
ESIGN_PROVIDER, and translate the provider's completion webhook into `services.sign_document`-style
records. Documents keep `esign_provider` so mixed histories remain auditable.
"""

from django.conf import settings


class ESignProvider:
    name = "builtin"
    label = "Built-in electronic acceptance"
    legal_notice = ("Electronic acceptance is recorded with an auditable trail. It is not a qualified electronic "
                    "signature; use a dedicated e-signature provider where your jurisdiction requires one.")

    def describe(self) -> dict:
        return {"name": self.name, "label": self.label, "legal_notice": self.legal_notice}


def get_esign_provider() -> ESignProvider:
    configured = getattr(settings, "ESIGN_PROVIDER", "builtin")
    if configured != "builtin":
        raise RuntimeError(f"E-signature provider '{configured}' is not implemented in this build.")
    return ESignProvider()
