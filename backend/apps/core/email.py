"""
Email service abstraction. Messages are rendered from templates/emails/<name>.txt (and an
optional .html) and handed to the configured Django email backend after the surrounding
database transaction commits. In development the file backend writes each message to
backend/var/mail so they can be inspected.
"""

import logging

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.db import transaction
from django.template import TemplateDoesNotExist
from django.template.loader import render_to_string

logger = logging.getLogger(__name__)


def _render(template: str, context: dict) -> tuple[str, str | None]:
    ctx = {"frontend_url": settings.FRONTEND_URL, **context}
    text = render_to_string(f"emails/{template}.txt", ctx)
    try:
        html = render_to_string(f"emails/{template}.html", ctx)
    except TemplateDoesNotExist:
        html = None
    return text, html


def send_templated_email(*, to: list[str] | str, subject: str, template: str, context: dict,
                         attachments: list[tuple[str, bytes, str]] | None = None, defer: bool = True) -> None:
    recipients = [to] if isinstance(to, str) else [r for r in to if r]
    if not recipients:
        return
    text, html = _render(template, context)

    def _send():
        message = EmailMultiAlternatives(subject=subject, body=text, from_email=settings.DEFAULT_FROM_EMAIL, to=recipients)
        if html:
            message.attach_alternative(html, "text/html")
        for name, content, mimetype in attachments or []:
            message.attach(name, content, mimetype)
        try:
            message.send(fail_silently=False)
        except Exception:  # Email delivery must never break a business workflow.
            logger.exception("Failed to send email '%s' to %d recipient(s)", template, len(recipients))

    if defer:
        transaction.on_commit(_send)
    else:
        _send()
