from apps.core.pdf import logo_data_uri, render_pdf


def render_invoice_pdf(invoice) -> bytes:
    org = invoice.organization
    return render_pdf("pdf/invoice.html", {
        "invoice": invoice,
        "org": org,
        "client": invoice.client,
        "lines": invoice.lines.select_related("project").all(),
        "payments": invoice.payments.filter(status="succeeded").order_by("received_at"),
        "credit_notes": invoice.credit_notes.all(),
        "logo": logo_data_uri(org),
        "status": invoice.display_status,
    })
