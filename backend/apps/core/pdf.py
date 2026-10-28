"""HTML-to-PDF rendering with WeasyPrint. Templates live in templates/pdf/."""

import base64

from django.template.loader import render_to_string


def logo_data_uri(organization) -> str | None:
    if not organization.logo:
        return None
    try:
        with organization.logo.open("rb") as fh:
            content = fh.read()
    except (FileNotFoundError, OSError):
        return None
    name = organization.logo.name.lower()
    mime = "image/png"
    if name.endswith((".jpg", ".jpeg")):
        mime = "image/jpeg"
    elif name.endswith(".webp"):
        mime = "image/webp"
    elif name.endswith(".gif"):
        mime = "image/gif"
    return f"data:{mime};base64,{base64.b64encode(content).decode()}"


def render_pdf(template: str, context: dict) -> bytes:
    from weasyprint import HTML

    html = render_to_string(template, context)
    # base_url=None plus inline assets only: templates never fetch remote resources.
    return HTML(string=html, base_url=None).write_pdf()
