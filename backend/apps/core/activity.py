from .models import ActivityLog

# Activity about these records reveals invoice/payment data: only billing users see it.
FINANCE_TARGET_TYPES = ("invoice", "payment", "creditnote", "recurringinvoiceschedule")
# Metadata keys holding money or budget-derived figures. They are removed for viewers who cannot manage the
# project an entry belongs to; keys match at any depth (e.g. changes.budget_amount, before/after snapshots).
MONEY_KEYS = frozenset({
    "amount", "total", "balance", "subtotal", "amount_due", "amount_paid", "billable_amount", "value",
    "budget_amount", "estimated_expenses", "estimated_cost", "hourly_rate", "retainer_amount",
    "bill_rate", "cost_rate", "default_bill_rate", "rate_override", "fees_used", "fees_percent",
    "used_percent", "level",
})


def visible_activity(membership, qs):
    """Role filter for any ActivityLog queryset shown to staff."""
    if not membership.has_billing_access:
        qs = qs.exclude(target_type__in=FINANCE_TARGET_TYPES)
    if not membership.is_admin:
        from django.db.models import Q

        from apps.projects.access import visible_documents

        # Document activity (titles, comments, files on it) follows the document scope.
        qs = qs.exclude(Q(target_type="document") & ~Q(target_id__in=visible_documents(membership).values("id")))
    return qs


def _strip_money(value):
    if isinstance(value, dict):
        return {k: _strip_money(v) for k, v in value.items() if k not in MONEY_KEYS}
    if isinstance(value, list):
        return [_strip_money(v) for v in value]
    return value


def serialize_activity(membership, entries) -> list[dict]:
    """Serialises activity, removing money from entries on projects the viewer cannot manage."""
    from apps.projects.access import managed_projects

    from .serializers import ActivitySerializer

    managed = None if membership.is_admin else set(managed_projects(membership).values_list("id", flat=True))
    rows = ActivitySerializer(entries, many=True).data
    for row in rows:
        if managed is not None and row["project"] not in managed:
            row["metadata"] = _strip_money(row["metadata"] or {})
    return rows


def log_activity(*, organization, actor, verb: str, target=None, target_type: str = "", target_id=None,
                 target_label: str = "", project=None, client=None, client_visible: bool = False, **metadata):
    """Records an audit entry. `target` may be any model instance; its label is captured at write time."""
    if target is not None:
        target_type = target_type or target._meta.model_name
        target_id = target_id or target.pk
        target_label = target_label or str(target)[:255]
        if project is None and target._meta.model_name == "project":
            project = target
        if project is None and hasattr(target, "project_id") and target.project_id:
            project = target.project
        if client is None and hasattr(target, "client_id") and target.client_id:
            client = target.client
    if client is None and project is not None:
        client = project.client
    return ActivityLog.objects.create(
        organization=organization,
        actor=actor if (actor is not None and actor.is_authenticated) else None,
        verb=verb,
        target_type=target_type,
        target_id=target_id,
        target_label=target_label,
        project=project,
        client=client,
        client_visible=client_visible,
        metadata=_json_safe(metadata),
    )


def _json_safe(value):
    from datetime import date, datetime
    from decimal import Decimal

    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value
