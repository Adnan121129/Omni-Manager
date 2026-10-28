from datetime import date

from django.db.models import Q
from rest_framework.exceptions import ValidationError


def apply_ordering(qs, request, allowed: dict[str, str], default: str | None = None):
    """`?ordering=-name` where keys of `allowed` map to model field paths."""
    raw = request.query_params.get("ordering") or default
    if not raw:
        return qs
    desc = raw.startswith("-")
    key = raw.lstrip("-")
    field = allowed.get(key)
    if field is None:
        return qs
    return qs.order_by(f"-{field}" if desc else field, "-id" if desc else "id")


def apply_search(qs, request, fields: list[str]):
    term = (request.query_params.get("search") or request.query_params.get("q") or "").strip()
    if not term:
        return qs
    condition = Q()
    for field in fields:
        condition |= Q(**{f"{field}__icontains": term})
    return qs.filter(condition)


def parse_date(value: str | None, name: str = "date") -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise ValidationError({name: ["Use YYYY-MM-DD."]})


def csv_ints(value: str | None) -> list[int]:
    if not value:
        return []
    out = []
    for part in str(value).split(","):
        part = part.strip()
        if part.isdigit():
            out.append(int(part))
    return out
