"""
Contracts, proposals and electronic acceptance.

Every time a document is sent, its fully rendered HTML is frozen into a DocumentVersion with a
SHA-256 content hash. A signer must confirm the exact version and hash they reviewed, and the
signature record stores both. DocumentEvent rows form a hash chain (each event hashes its payload
plus the previous event's hash), so any later alteration of the history is detectable.

The built-in flow captures an explicit electronic acceptance with a drawn or typed signature. It
does not by itself guarantee compliance with every jurisdiction's e-signature requirements; see
apps/documents/esign.py for the integration point for a dedicated e-signature provider.
"""

import base64
import hashlib
import html
import json
import re
from decimal import Decimal

import markdown as md
import nh3
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import Role
from apps.core.activity import log_activity
from apps.core.email import send_templated_email
from apps.core.exceptions import BusinessRuleError
from apps.core.money import q2
from apps.core.notify import notify
from apps.crm.services import portal_users

from .models import Document, DocumentEvent, DocumentVersion, SignatureRecord

PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}")
CONSENT_TEXT = (
    "By signing, I agree that my electronic signature is the legal equivalent of my handwritten signature, "
    "that I have reviewed this document in full, and that I am authorised to accept it on behalf of the client."
)
MAX_SIGNATURE_BYTES = 200 * 1024
ALLOWED_TAGS = {"h1", "h2", "h3", "h4", "p", "strong", "em", "ul", "ol", "li", "blockquote", "table", "thead",
                "tbody", "tr", "th", "td", "hr", "br", "code", "pre", "a", "span", "div"}


def pricing_total(items) -> Decimal:
    total = Decimal("0")
    for item in items or []:
        total += q2(Decimal(str(item.get("quantity", 0))) * Decimal(str(item.get("unit_price", 0))))
    return q2(total)


def validate_pricing_items(items) -> list[dict]:
    if items in (None, ""):
        return []
    if not isinstance(items, list):
        raise BusinessRuleError("Pricing items must be a list.")
    clean = []
    for item in items:
        try:
            quantity = Decimal(str(item.get("quantity", 1)))
            unit_price = Decimal(str(item.get("unit_price", 0)))
            description = str(item.get("description", "")).strip()
        except (ArithmeticError, ValueError, AttributeError):
            raise BusinessRuleError("Each pricing item needs a description, quantity and unit price.")
        if not description or quantity <= 0 or unit_price < 0:
            raise BusinessRuleError("Pricing items need a description, a positive quantity and a non-negative price.")
        clean.append({"description": description[:300], "quantity": str(quantity), "unit_price": str(q2(unit_price))})
    return clean


def _money(amount, currency) -> str:
    return f"{currency} {q2(amount):,.2f}"


def placeholder_values(document: Document) -> dict[str, str]:
    org = document.organization
    client = document.client
    project = document.project
    return {
        "organization.name": org.name,
        "organization.email": org.email,
        "organization.address": org.address,
        "client.name": client.name,
        "client.contact_name": client.contact_name or client.name,
        "client.email": client.email,
        "client.address": client.billing_address,
        "project.name": project.name if project else document.title,
        "project.code": project.code if project else "",
        "project.deadline": project.deadline.strftime("%B %d, %Y") if project and project.deadline else "to be agreed",
        "project.budget": _money(project.budget_amount, project.currency) if project else "",
        "document.title": document.title,
        "today": timezone.localdate().strftime("%B %d, %Y"),
        "expires_at": document.expires_at.strftime("%B %d, %Y") if document.expires_at else "the date of signature",
        "scope": document.scope or "_Scope to be confirmed._",
        "payment_terms": document.payment_terms or "_Payment terms to be confirmed._",
        "milestones": document.milestones_summary or "_Milestones to be confirmed._",
        "total": _money(pricing_total(document.pricing_items), document.currency),
    }


def _pricing_table(document: Document) -> str:
    if not document.pricing_items:
        return ""
    rows = []
    for item in document.pricing_items:
        quantity = Decimal(item["quantity"])
        unit_price = Decimal(item["unit_price"])
        rows.append(
            f"<tr><td>{html.escape(item['description'])}</td><td class='num'>{quantity.normalize():f}</td>"
            f"<td class='num'>{_money(unit_price, document.currency)}</td>"
            f"<td class='num'>{_money(quantity * unit_price, document.currency)}</td></tr>"
        )
    total = _money(pricing_total(document.pricing_items), document.currency)
    return (
        "<h2>Pricing</h2><table class='pricing'><thead><tr><th>Item</th><th class='num'>Qty</th>"
        "<th class='num'>Unit price</th><th class='num'>Amount</th></tr></thead><tbody>"
        + "".join(rows)
        + f"</tbody><tfoot><tr><td colspan='3'><strong>Total</strong></td><td class='num'><strong>{total}</strong></td></tr></tfoot></table>"
    )


def render_html(document: Document) -> str:
    values = placeholder_values(document)
    body = PLACEHOLDER.sub(lambda m: values.get(m.group(1), m.group(0)) if m.group(1) != "pricing_table" else "[[PRICING_TABLE]]",
                           document.body)
    rendered = md.markdown(body, extensions=["tables", "sane_lists"])
    rendered = nh3.clean(rendered, tags=ALLOWED_TAGS, attributes={"a": {"href"}, "td": {"class"}, "th": {"class"},
                                                                  "span": {"class"}, "div": {"class"}},
                         url_schemes={"https", "mailto"})
    table = _pricing_table(document)
    if "[[PRICING_TABLE]]" in rendered:
        rendered = rendered.replace("<p>[[PRICING_TABLE]]</p>", table).replace("[[PRICING_TABLE]]", table)
    elif table:
        rendered += table
    return f"<article class='om-document'>{rendered}</article>"


def content_hash(rendered_html: str) -> str:
    return hashlib.sha256(rendered_html.encode("utf-8")).hexdigest()


def _event_hash(payload: dict) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


@transaction.atomic
def append_event(document: Document, event: str, *, actor=None, details: dict | None = None, ip: str | None = None) -> DocumentEvent:
    # Lock the document row so concurrent appends (including the very first one) are serialised.
    Document.objects.select_for_update(of=("self",)).filter(pk=document.pk).first()
    last = DocumentEvent.objects.filter(document=document).order_by("-sequence").first()
    sequence = (last.sequence + 1) if last else 1
    previous_hash = last.hash if last else ""
    created_at = timezone.now()
    actor_label = ""
    if actor is not None and getattr(actor, "is_authenticated", False):
        actor_label = f"{actor.full_name} <{actor.email}>"
    payload = {"document": document.pk, "sequence": sequence, "event": event, "actor": actor_label,
               "version": document.current_version, "details": details or {}, "ip": ip or "",
               "created_at": created_at.isoformat(), "previous_hash": previous_hash}
    return DocumentEvent.objects.create(
        document=document, sequence=sequence, event=event,
        actor=actor if actor_label else None, actor_label=actor_label, version=document.current_version,
        details=details or {}, ip_address=ip or None, created_at=created_at, previous_hash=previous_hash,
        hash=_event_hash(payload),
    )


def verify_chain(document: Document) -> dict:
    previous = ""
    for ev in DocumentEvent.objects.filter(document=document).order_by("sequence"):
        payload = {"document": document.pk, "sequence": ev.sequence, "event": ev.event, "actor": ev.actor_label,
                   "version": ev.version, "details": ev.details, "ip": ev.ip_address or "",
                   "created_at": ev.created_at.isoformat(), "previous_hash": ev.previous_hash}
        if ev.previous_hash != previous or _event_hash(payload) != ev.hash:
            return {"valid": False, "broken_at": ev.sequence}
        previous = ev.hash
    return {"valid": True, "broken_at": None}


def internal_recipients(document: Document):
    recipients = [document.created_by]
    if document.project_id and document.project.manager_id:
        recipients.append(document.project.manager)
    return recipients


@transaction.atomic
def send_document(document: Document, actor, *, signer=None, ip=None) -> Document:
    document = Document.objects.select_for_update(of=("self",)).select_related("client", "organization", "project").get(pk=document.pk)
    if document.status != Document.Status.DRAFT:
        raise BusinessRuleError("Only draft documents can be sent. Revise the document to send a new version.")
    if not document.body.strip():
        raise BusinessRuleError("The document has no content.")
    if document.expires_at and document.expires_at < timezone.localdate():
        raise BusinessRuleError("The expiry date is in the past.", code="expired")
    contacts = portal_users(document.client)
    if not contacts:
        raise BusinessRuleError("Invite a client contact to the portal before sending documents for signature.",
                                code="no_portal_contact")
    if signer is not None and signer.pk not in {u.pk for u in contacts}:
        raise BusinessRuleError("The signer must be an active portal contact for this client.")
    document.total_amount = pricing_total(document.pricing_items)
    document.current_version += 1
    rendered = render_html(document)
    version = DocumentVersion.objects.create(document=document, version=document.current_version, rendered_html=rendered,
                                             content_hash=content_hash(rendered), created_by=actor)
    document.status = Document.Status.SENT
    document.sent_at = timezone.now()
    document.signer = signer or contacts[0]
    document.viewed_at = None
    document.save()
    append_event(document, "sent", actor=actor, ip=ip,
                 details={"content_hash": version.content_hash, "signer": document.signer.email})
    log_activity(organization=document.organization, actor=actor, verb="sent_document", target=document,
                 client=document.client, client_visible=True, version=version.version)
    notify(organization=document.organization, recipients=contacts, kind="document_awaiting_signature",
           title=f"{document.get_kind_display()} ready for your signature: {document.title}",
           link=f"/portal/documents/{document.pk}")
    send_templated_email(to=[u.email for u in contacts], subject=f"Please review and sign: {document.title}",
                         template="document", context={"document": document, "client": document.client,
                                                       "organization": document.organization})
    return document


@transaction.atomic
def revise_document(document: Document, actor) -> Document:
    document = Document.objects.select_for_update(of=("self",)).get(pk=document.pk)
    if document.status == Document.Status.SIGNED:
        raise BusinessRuleError("Signed documents cannot be revised. Create a new document or amendment instead.")
    if document.status == Document.Status.DRAFT:
        return document
    previous = document.status
    document.status = Document.Status.DRAFT
    document.save(update_fields=["status", "updated_at"])
    append_event(document, "revised", actor=actor, details={"previous_status": previous})
    log_activity(organization=document.organization, actor=actor, verb="revised_document", target=document)
    return document


def _check_portal_access(document: Document, user) -> None:
    from apps.accounts.models import Membership

    ok = Membership.objects.filter(organization_id=document.organization_id, user=user, role=Role.CLIENT,
                                   client_id=document.client_id, status=Membership.Status.ACTIVE).exists()
    if not ok:
        raise BusinessRuleError("You do not have access to this document.", status_code=403)


def expire_if_needed(document: Document) -> Document:
    if document.status in Document.AWAITING_STATUSES and document.expires_at and document.expires_at < timezone.localdate():
        with transaction.atomic():
            locked = Document.objects.select_for_update(of=("self",)).get(pk=document.pk)
            if locked.status in Document.AWAITING_STATUSES:
                locked.status = Document.Status.EXPIRED
                locked.save(update_fields=["status", "updated_at"])
                append_event(locked, "expired", details={"expires_at": locked.expires_at.isoformat()})
            document.refresh_from_db()
    return document


@transaction.atomic
def mark_viewed(document: Document, user, ip=None) -> Document:
    document = Document.objects.select_for_update(of=("self",)).get(pk=document.pk)
    _check_portal_access(document, user)
    already = DocumentEvent.objects.filter(document=document, event="viewed", version=document.current_version,
                                           actor=user).exists()
    if document.status == Document.Status.SENT:
        document.status = Document.Status.VIEWED
        document.viewed_at = timezone.now()
        document.save(update_fields=["status", "viewed_at", "updated_at"])
    if not already and document.status in (Document.Status.VIEWED, Document.Status.SENT):
        append_event(document, "viewed", actor=user, ip=ip)
    return document


def _validate_signature_image(data_url: str) -> str:
    prefix = "data:image/png;base64,"
    if not data_url.startswith(prefix):
        raise BusinessRuleError("The drawn signature must be a PNG image.", code="invalid_signature")
    try:
        raw = base64.b64decode(data_url[len(prefix):], validate=True)
    except ValueError:
        raise BusinessRuleError("The drawn signature could not be read.", code="invalid_signature")
    if len(raw) > MAX_SIGNATURE_BYTES or not raw.startswith(b"\x89PNG"):
        raise BusinessRuleError("The drawn signature is invalid or too large.", code="invalid_signature")
    return data_url


def sign_document(document: Document, user, **kwargs) -> SignatureRecord:
    # Expiry is persisted in its own transaction so it survives the rejected signing attempt.
    document = expire_if_needed(document)
    if document.status == Document.Status.EXPIRED:
        raise BusinessRuleError("This document has expired.", code="expired")
    return _sign_document(document, user, **kwargs)


@transaction.atomic
def _sign_document(document: Document, user, *, version: int, content_hash_value: str, signer_name: str,
                   signer_title: str = "", method: str, signature_image: str = "", consent: bool, ip=None,
                   user_agent: str = "") -> SignatureRecord:
    document = Document.objects.select_for_update(of=("self",)).select_related("organization", "client", "project").get(pk=document.pk)
    _check_portal_access(document, user)
    if document.signer_id and document.signer_id != user.pk:
        raise BusinessRuleError("This document is assigned to a different signer.", status_code=403)
    if document.status not in Document.AWAITING_STATUSES:
        raise BusinessRuleError(f"This document cannot be signed (status: {document.get_status_display()}).",
                                code="invalid_status")
    current = DocumentVersion.objects.get(document=document, version=document.current_version)
    if int(version) != current.version or content_hash_value != current.content_hash:
        raise BusinessRuleError("The document changed while you were reviewing it. Please reload and review again.",
                                code="version_mismatch", status_code=409)
    if not consent:
        raise BusinessRuleError("You must agree to sign electronically.", code="consent_required")
    signer_name = (signer_name or "").strip()
    if len(signer_name) < 2:
        raise BusinessRuleError("Enter your full legal name.", code="name_required")
    if method == SignatureRecord.Method.DRAWN:
        signature_image = _validate_signature_image(signature_image or "")
    elif method == SignatureRecord.Method.TYPED:
        signature_image = ""
    else:
        raise BusinessRuleError("Choose a drawn or typed signature.", code="invalid_method")
    now = timezone.now()
    record = SignatureRecord.objects.create(
        document=document, version=current, content_hash=current.content_hash, signer=user, signer_name=signer_name[:150],
        signer_email=user.email, signer_title=(signer_title or "")[:100], method=method, signature_image=signature_image,
        consent_text=CONSENT_TEXT, ip_address=ip or None, user_agent=(user_agent or "")[:400], signed_at=now,
    )
    document.status = Document.Status.SIGNED
    document.signed_at = now
    document.save(update_fields=["status", "signed_at", "updated_at"])
    append_event(document, "signed", actor=user, ip=ip, details={
        "signer_name": record.signer_name, "method": method, "content_hash": current.content_hash,
        "user_agent": record.user_agent[:120]})
    log_activity(organization=document.organization, actor=user, verb="signed_document", target=document,
                 client=document.client, client_visible=True, version=current.version)
    notify(organization=document.organization, recipients=internal_recipients(document), kind="document_responded",
           title=f"{document.client.name} signed '{document.title}'", body=f"Signed by {record.signer_name}",
           link=f"/documents/{document.pk}")
    return record


@transaction.atomic
def decline_document(document: Document, user, *, reason: str, ip=None) -> Document:
    document = Document.objects.select_for_update(of=("self",)).select_related("organization", "client", "project").get(pk=document.pk)
    _check_portal_access(document, user)
    reason = (reason or "").strip()
    if not reason:
        raise BusinessRuleError("Please tell us why you are declining.", code="reason_required")
    if document.status not in Document.AWAITING_STATUSES:
        raise BusinessRuleError("This document can no longer be declined.", code="invalid_status")
    document.status = Document.Status.DECLINED
    document.declined_at = timezone.now()
    document.decline_reason = reason
    document.save(update_fields=["status", "declined_at", "decline_reason", "updated_at"])
    append_event(document, "declined", actor=user, ip=ip, details={"reason": reason})
    log_activity(organization=document.organization, actor=user, verb="declined_document", target=document,
                 client=document.client, client_visible=True, reason=reason)
    notify(organization=document.organization, recipients=internal_recipients(document), kind="document_responded",
           title=f"{document.client.name} declined '{document.title}'", body=reason, link=f"/documents/{document.pk}")
    return document


def render_document_pdf(document: Document) -> bytes:
    from apps.core.pdf import logo_data_uri, render_pdf

    version = document.versions.order_by("-version").first()
    body_html = version.rendered_html if version else render_html(document)
    signature = document.signatures.select_related("version").order_by("-signed_at").first()
    return render_pdf("pdf/document.html", {
        "document": document, "org": document.organization, "client": document.client, "body_html": body_html,
        "version": version, "signature": signature if signature and version and signature.version_id == version.pk else None,
        "events": document.events.order_by("sequence"), "chain": verify_chain(document),
        "logo": logo_data_uri(document.organization), "draft": version is None or document.status == Document.Status.DRAFT,
    })


def expire_overdue_documents() -> int:
    count = 0
    for document in Document.objects.filter(status__in=Document.AWAITING_STATUSES, expires_at__lt=timezone.localdate()):
        expire_if_needed(document)
        count += 1
    return count
