"""Decimal-only money helpers. Floats are never used for monetary values."""

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

CENT = Decimal("0.01")
ZERO = Decimal("0.00")

# Two-decimal currencies supported for invoicing and payments.
SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "SGD", "INR", "ZAR", "AED"]


def to_decimal(value) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        raise TypeError("Refusing to convert float to Decimal for money; pass a string.")
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"Invalid decimal value: {value!r}") from exc


def q2(value) -> Decimal:
    """Round to cents with commercial (half-up) rounding."""
    return to_decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def hours_from_seconds(seconds: int) -> Decimal:
    return (Decimal(seconds) / Decimal(3600)).quantize(CENT, rounding=ROUND_HALF_UP)


def amount_for_seconds(seconds: int, rate: Decimal) -> Decimal:
    return q2(Decimal(seconds) / Decimal(3600) * to_decimal(rate))


def to_minor_units(amount: Decimal) -> int:
    return int((q2(amount) * 100).to_integral_value(rounding=ROUND_HALF_UP))


def from_minor_units(value: int) -> Decimal:
    return q2(Decimal(value) / Decimal(100))


def sum_by_currency(rows, amount_key="amount", currency_key="currency") -> dict[str, Decimal]:
    """Aggregates amounts per currency - different currencies are never added together."""
    totals: dict[str, Decimal] = {}
    for row in rows:
        currency = row[currency_key] if isinstance(row, dict) else getattr(row, currency_key)
        amount = row[amount_key] if isinstance(row, dict) else getattr(row, amount_key)
        totals[currency] = q2(totals.get(currency, ZERO) + to_decimal(amount or 0))
    return totals


def money_map(totals: dict[str, Decimal]) -> list[dict]:
    """Serialises a per-currency dict as a stable list for JSON responses."""
    return [{"currency": c, "amount": str(q2(a))} for c, a in sorted(totals.items())]
