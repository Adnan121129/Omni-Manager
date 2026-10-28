"""
Client portal API. Every query is scoped to the requesting client's own records and to items
explicitly shared with the client; responses use client-safe fields only (no internal notes,
rates, costs or other clients' data).
"""

from django.db import transaction
from django.db.models import Q
from django.http import HttpResponse
from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.activity import log_activity
from apps.core.exceptions import BusinessRuleError
from apps.core.files import file_download_response, guess_content_type, validate_upload
from apps.core.models import ActivityLog, Attachment, Comment
from apps.core.notify import notify
from apps.core.permissions import IsClientUser
from apps.core.serializers import content_type_for
from apps.core.targets import client_can_access
from apps.documents import services as document_services
from apps.documents.models import Document
from apps.documents.views import client_ip
from apps.finance import payments
from apps.finance.models import CheckoutSession, Invoice, Payment
from apps.finance.pdf import render_invoice_pdf
from apps.projects import metrics
from apps.projects.models import ChangeRequest, Deliverable, Milestone, Project


class PortalView(APIView):
    permission_classes = [IsClientUser]

    @property
    def client(self):
        return self.request.membership.client

    def projects(self):
        return Project.objects.filter(organization=self.request.org, client=self.client, client_visible=True)

    def invoices(self):
        return Invoice.objects.filter(organization=self.request.org, client=self.client).exclude(status=Invoice.Status.DRAFT)

    def documents(self):
        return Document.objects.filter(organization=self.request.org, client=self.client).exclude(status=Document.Status.DRAFT)

    def deliverables(self):
        return Deliverable.objects.filter(organization=self.request.org, project__in=self.projects()).exclude(
            status=Deliverable.Status.DRAFT)

    def change_requests(self):
        return ChangeRequest.objects.filter(organization=self.request.org, project__in=self.projects()).exclude(
            status=ChangeRequest.Status.DRAFT)


def _invoice_summary(inv: Invoice) -> dict:
    return {"id": inv.pk, "number": inv.number, "status": inv.display_status, "issue_date": inv.issue_date,
            "due_date": inv.due_date, "currency": inv.currency, "total": str(inv.total),
            "amount_paid": str(inv.amount_paid), "amount_due": str(inv.amount_due),
            "can_pay": inv.status in Invoice.OPEN_STATUSES and inv.allow_online_payment and inv.amount_due > 0}


def _deliverable(d: Deliverable) -> dict:
    return {"id": d.pk, "title": d.title, "description": d.description, "status": d.status,
            "status_label": d.get_status_display(), "due_date": d.due_date, "revision": d.revision,
            "submitted_at": d.submitted_at, "decided_at": d.decided_at, "decision_comment": d.decision_comment,
            "project": {"id": d.project_id, "name": d.project.name, "code": d.project.code},
            "milestone": d.milestone.name if d.milestone_id and d.milestone.client_visible else None}


def _change_request(cr: ChangeRequest) -> dict:
    return {"id": cr.pk, "title": cr.title, "description": cr.description, "status": cr.status,
            "status_label": cr.get_status_display(), "estimated_hours": str(cr.estimated_hours),
            "estimated_cost": str(cr.estimated_cost), "currency": cr.project.currency,
            "revised_deadline": cr.revised_deadline, "sent_at": cr.sent_at, "decided_at": cr.decided_at,
            "decision_comment": cr.decision_comment,
            "project": {"id": cr.project_id, "name": cr.project.name, "code": cr.project.code}}


def _shared_project_name(doc: Document) -> str | None:
    project = doc.project if doc.project_id else None
    return project.name if project and project.client_visible and project.client_id == doc.client_id else None


def _document_summary(doc: Document) -> dict:
    return {"id": doc.pk, "title": doc.title, "kind": doc.kind, "status": doc.status,
            "status_label": doc.get_status_display(), "sent_at": doc.sent_at, "signed_at": doc.signed_at,
            "expires_at": doc.expires_at, "total_amount": str(doc.total_amount), "currency": doc.currency,
            "project": _shared_project_name(doc), "version": doc.current_version}


def _portal_activity(org, client):
    """Client-visible activity for this client, minus milestones that have since been hidden from the portal."""
    hidden_milestones = Milestone.objects.filter(organization=org, client_visible=False).values("id")
    return (ActivityLog.objects.filter(organization=org, client=client, client_visible=True)
            .exclude(target_type="milestone", target_id__in=hidden_milestones))


def _activity(qs):
    return [{"id": a.pk, "verb": a.verb, "target_type": a.target_type, "target_label": a.target_label,
             "actor": a.actor.full_name if a.actor else None, "created_at": a.created_at,
             "project_id": a.project_id} for a in qs]


class PortalSummaryView(PortalView):
    def get(self, request):
        today = timezone.localdate()
        documents = [document_services.expire_if_needed(d) for d in self.documents().filter(status__in=Document.AWAITING_STATUSES)]
        approvals = []
        for doc in documents:
            if doc.status in Document.AWAITING_STATUSES:
                approvals.append({"type": "document", "id": doc.pk, "title": doc.title, "status": doc.status,
                                  "status_label": "Awaiting your signature", "project": _shared_project_name(doc),
                                  "due_date": doc.expires_at, "action": "Review & sign", "link": f"/portal/documents/{doc.pk}"})
        for d in self.deliverables().filter(status=Deliverable.Status.PENDING_APPROVAL).select_related("project"):
            approvals.append({"type": "deliverable", "id": d.pk, "title": d.title, "status": d.status,
                              "status_label": "Awaiting your approval", "project": d.project.name, "due_date": d.due_date,
                              "action": "Review deliverable", "link": f"/portal/projects/{d.project_id}?deliverable={d.pk}",
                              "description": d.description, "revision": d.revision})
        for cr in self.change_requests().filter(status=ChangeRequest.Status.PENDING_CLIENT).select_related("project"):
            approvals.append({"type": "change_request", "id": cr.pk, "title": cr.title, "status": cr.status,
                              "status_label": "Change request awaiting decision", "project": cr.project.name,
                              "due_date": cr.revised_deadline, "action": "Approve or reject",
                              "amount": str(cr.estimated_cost), "currency": cr.project.currency,
                              "link": f"/portal/approvals?change_request={cr.pk}",
                              "description": cr.description, "estimated_hours": str(cr.estimated_hours)})
        for inv in self.invoices().filter(status__in=Invoice.OPEN_STATUSES, amount_due__gt=0):
            approvals.append({"type": "invoice", "id": inv.pk, "title": f"Invoice {inv.number}", "status": inv.display_status,
                              "status_label": "Overdue" if inv.is_overdue else "Payment due", "project": None,
                              "due_date": inv.due_date, "action": "View & pay", "amount": str(inv.amount_due),
                              "currency": inv.currency, "link": f"/portal/invoices/{inv.pk}"})
        approvals.sort(key=lambda a: (a["due_date"] is None, a["due_date"] or today))
        projects = list(self.projects().select_related("manager"))
        data = metrics.collect([p.pk for p in projects])
        outstanding = {}
        for inv in self.invoices().filter(status__in=Invoice.OPEN_STATUSES):
            outstanding[inv.currency] = outstanding.get(inv.currency, 0) + inv.amount_due
        activity = (_portal_activity(request.org, self.client)
                    .filter(Q(project__isnull=True) | Q(project__client_visible=True, project__client=self.client))
                    .select_related("actor")[:15])
        return Response({
            "client": {"id": self.client.pk, "name": self.client.name},
            "organization": {"name": request.org.name, "email": request.org.email, "brand_color": request.org.brand_color},
            "approvals": approvals,
            "projects": [{"id": p.pk, "code": p.code, "name": p.name, "status": p.status, "deadline": p.deadline,
                          "progress": metrics.progress(p, data[p.pk])["percent"],
                          "manager": p.manager.full_name if p.manager else None} for p in projects],
            "outstanding": [{"currency": c, "amount": str(a)} for c, a in outstanding.items()],
            "activity": _activity(activity),
        })


class PortalProjectListView(PortalView):
    def get(self, request):
        projects = list(self.projects().select_related("manager"))
        data = metrics.collect([p.pk for p in projects])
        return Response([{
            "id": p.pk, "code": p.code, "name": p.name, "status": p.status, "start_date": p.start_date,
            "deadline": p.deadline, "completed_at": p.completed_at, "progress": metrics.progress(p, data[p.pk]),
            "manager": {"name": p.manager.full_name, "email": p.manager.email} if p.manager else None,
        } for p in projects])


class PortalProjectDetailView(PortalView):
    def get(self, request, pk):
        project = self.projects().select_related("manager").filter(pk=pk).first()
        if project is None:
            raise NotFound()
        m = metrics.collect([project.pk])[project.pk]
        deliverables = self.deliverables().filter(project=project).select_related("project", "milestone")
        change_requests = self.change_requests().filter(project=project).select_related("project")
        file_targets = Q(content_type=content_type_for(Project), object_id=project.pk)
        file_targets |= Q(content_type=content_type_for(Deliverable), object_id__in=[d.pk for d in deliverables])
        file_targets |= Q(content_type=content_type_for(ChangeRequest), object_id__in=[c.pk for c in change_requests])
        files = Attachment.objects.filter(file_targets, organization=request.org, client_visible=True).select_related("uploaded_by", "content_type")
        return Response({
            "id": project.pk, "code": project.code, "name": project.name, "description": project.description,
            "status": project.status, "start_date": project.start_date, "deadline": project.deadline,
            "completed_at": project.completed_at, "progress": metrics.progress(project, m),
            "manager": {"name": project.manager.full_name, "email": project.manager.email} if project.manager else None,
            "milestones": [{"id": ms.pk, "name": ms.name, "description": ms.description, "due_date": ms.due_date,
                            "status": ms.status, "completed_at": ms.completed_at}
                           for ms in Milestone.objects.filter(project=project, client_visible=True)],
            "deliverables": [_deliverable(d) for d in deliverables],
            "change_requests": [_change_request(c) for c in change_requests],
            "files": [{"id": f.pk, "name": f.original_name, "size": f.size, "created_at": f.created_at,
                       "uploaded_by": f.uploaded_by.full_name if f.uploaded_by else None,
                       "attached_to": f.content_type.model, "download_url": f"/api/portal/files/{f.pk}/download/"}
                      for f in files],
            "activity": _activity(_portal_activity(request.org, self.client).filter(project=project)
                                  .select_related("actor")[:30]),
        })


class PortalDeliverableDecisionView(PortalView):
    def post(self, request, pk, decision):
        comment = str(request.data.get("comment", "")).strip()
        with transaction.atomic():
            deliverable = self.deliverables().select_for_update(of=("self",)).select_related("project", "project__manager").filter(pk=pk).first()
            if deliverable is None:
                raise NotFound()
            if deliverable.status != Deliverable.Status.PENDING_APPROVAL:
                raise BusinessRuleError("This deliverable is not awaiting your approval.")
            if decision == "approve":
                deliverable.status = Deliverable.Status.APPROVED
            elif decision == "request-changes":
                if not comment:
                    raise ValidationError({"comment": ["Describe the changes you need."]})
                deliverable.status = Deliverable.Status.CHANGES_REQUESTED
            else:
                raise NotFound()
            deliverable.decided_at = timezone.now()
            deliverable.decided_by = request.user
            deliverable.decision_comment = comment
            deliverable.save()
            if comment:
                Comment.objects.create(organization=request.org, content_type=content_type_for(Deliverable),
                                       object_id=deliverable.pk, author=request.user, body=comment, client_visible=True)
            verb = "approved_deliverable" if decision == "approve" else "requested_revisions"
            log_activity(organization=request.org, actor=request.user, verb=verb, target=deliverable,
                         client_visible=True, comment=comment)
            notify(organization=request.org, recipients=[deliverable.project.manager, deliverable.submitted_by],
                   kind="deliverable_decided",
                   title=f"{self.client.name} {'approved' if decision == 'approve' else 'requested revisions on'} '{deliverable.title}'",
                   body=comment, link=f"/projects/{deliverable.project_id}?tab=deliverables")
        return Response(_deliverable(deliverable))


class PortalChangeRequestDecisionView(PortalView):
    def post(self, request, pk, decision):
        comment = str(request.data.get("comment", "")).strip()
        with transaction.atomic():
            cr = self.change_requests().select_for_update(of=("self",)).select_related("project", "project__manager").filter(pk=pk).first()
            if cr is None:
                raise NotFound()
            if cr.status != ChangeRequest.Status.PENDING_CLIENT:
                raise BusinessRuleError("This change request is not awaiting your decision.")
            if decision == "approve":
                cr.status = ChangeRequest.Status.APPROVED
            elif decision == "reject":
                cr.status = ChangeRequest.Status.REJECTED
            else:
                raise NotFound()
            cr.decided_at = timezone.now()
            cr.decided_by = request.user
            cr.decision_comment = comment
            cr.save()
            log_activity(organization=request.org, actor=request.user, verb=f"change_request_{cr.status}", target=cr,
                         client_visible=True, comment=comment)
            notify(organization=request.org, recipients=[cr.project.manager, cr.requested_by], kind="change_request_decided",
                   title=f"{self.client.name} {cr.status} change request '{cr.title}'", body=comment,
                   link=f"/projects/{cr.project_id}?tab=changes")
        return Response(_change_request(cr))


class PortalCommentsView(PortalView):
    TYPES = {"project": Project, "deliverable": Deliverable, "changerequest": ChangeRequest, "document": Document}

    def _target(self, request):
        raw = request.query_params.get("target") or request.data.get("target") or ""
        if ":" not in raw:
            raise ValidationError({"target": ["Specify target as 'type:id'."]})
        target_type, target_id = raw.split(":", 1)
        model = self.TYPES.get(target_type)
        if model is None:
            raise ValidationError({"target": ["Unsupported target."]})
        obj = model.objects.filter(organization=request.org, pk=target_id).first() if target_id.isdigit() else None
        if obj is None or not client_can_access(request.membership, obj):
            raise NotFound()
        return obj

    def get(self, request):
        obj = self._target(request)
        comments = Comment.objects.filter(organization=request.org, content_type=content_type_for(obj.__class__),
                                          object_id=obj.pk, client_visible=True).select_related("author")
        return Response([{"id": c.pk, "body": c.body, "created_at": c.created_at,
                          "author": c.author.full_name if c.author else "Former user",
                          "is_mine": c.author_id == request.user.pk} for c in comments])

    def post(self, request):
        obj = self._target(request)
        body = str(request.data.get("body", "")).strip()
        if not body:
            raise ValidationError({"body": ["Write a comment."]})
        comment = Comment.objects.create(organization=request.org, content_type=content_type_for(obj.__class__),
                                         object_id=obj.pk, author=request.user, body=body[:5000], client_visible=True)
        project = obj if isinstance(obj, Project) else getattr(obj, "project", None)
        log_activity(organization=request.org, actor=request.user, verb="client_commented", target=obj, project=project,
                     client_visible=True)
        recipients = [project.manager] if project is not None else [getattr(obj, "created_by", None)]
        notify(organization=request.org, recipients=recipients, kind="comment_added",
               title=f"{request.user.full_name} ({self.client.name}) commented on {str(obj)[:80]}", body=body[:300],
               link=f"/projects/{project.pk}" if project is not None else "")
        return Response({"id": comment.pk, "body": comment.body, "created_at": comment.created_at,
                         "author": request.user.full_name, "is_mine": True}, status=status.HTTP_201_CREATED)


class PortalFileUploadView(PortalView):
    def post(self, request, pk):
        project = self.projects().filter(pk=pk).first()
        if project is None:
            raise NotFound()
        upload = request.FILES.get("file")
        name = validate_upload(upload)
        attachment = Attachment(organization=request.org, content_type=content_type_for(Project), object_id=project.pk,
                                original_name=name, size=upload.size, content_type_header=guess_content_type(name),
                                uploaded_by=request.user, client_visible=True)
        attachment.file.save(name, upload, save=False)
        attachment.save()
        log_activity(organization=request.org, actor=request.user, verb="client_uploaded_file", target=project,
                     client_visible=True, file=name)
        notify(organization=request.org, recipients=[project.manager], kind="comment_added",
               title=f"{self.client.name} uploaded {name}", link=f"/projects/{project.pk}?tab=files")
        return Response({"id": attachment.pk, "name": name}, status=status.HTTP_201_CREATED)


class PortalFileDownloadView(PortalView):
    def get(self, request, pk):
        attachment = Attachment.objects.filter(organization=request.org, pk=pk, client_visible=True).select_related("content_type").first()
        if attachment is None:
            raise NotFound()
        target = attachment.content_type.get_object_for_this_type(pk=attachment.object_id)
        if not client_can_access(request.membership, target):
            raise NotFound()
        return file_download_response(attachment.file, attachment.original_name, inline=request.query_params.get("inline") == "1")


class PortalDocumentListView(PortalView):
    def get(self, request):
        docs = [document_services.expire_if_needed(d) for d in self.documents().select_related("project")]
        return Response([_document_summary(d) for d in docs])


class PortalDocumentDetailView(PortalView):
    def get(self, request, pk):
        doc = self.documents().select_related("project", "organization").filter(pk=pk).first()
        if doc is None:
            raise NotFound()
        doc = document_services.expire_if_needed(doc)
        if doc.status in Document.AWAITING_STATUSES:
            doc = document_services.mark_viewed(doc, request.user, ip=client_ip(request))
        version = doc.versions.order_by("-version").first()
        signature = doc.signatures.filter(version=version).first() if version else None
        return Response({
            **_document_summary(doc),
            "html": version.rendered_html if version else "",
            "content_hash": version.content_hash if version else None,
            "decline_reason": doc.decline_reason,
            "is_signer": doc.signer_id in (None, request.user.pk),
            "consent_text": document_services.CONSENT_TEXT,
            "legal_notice": "Electronic acceptance is recorded with your name, email, IP address, time and the exact "
                            "document version you reviewed.",
            "signature": {"signer_name": signature.signer_name, "signer_title": signature.signer_title,
                          "method": signature.method, "signature_image": signature.signature_image,
                          "signed_at": signature.signed_at, "content_hash": signature.content_hash} if signature else None,
            "organization": {"name": doc.organization.name},
        })


class PortalDocumentSignView(PortalDocumentDetailView):
    http_method_names = ["post"]

    def post(self, request, pk):
        doc = self.documents().filter(pk=pk).first()
        if doc is None:
            raise NotFound()
        d = request.data
        document_services.sign_document(
            doc, request.user, version=d.get("version") or 0, content_hash_value=str(d.get("content_hash", "")),
            signer_name=str(d.get("signer_name", "")), signer_title=str(d.get("signer_title", "")),
            method=str(d.get("method", "")), signature_image=str(d.get("signature_image", "")),
            consent=bool(d.get("consent")), ip=client_ip(request), user_agent=request.META.get("HTTP_USER_AGENT", ""))
        return self.get(request, pk)


class PortalDocumentDeclineView(PortalView):
    def post(self, request, pk):
        doc = self.documents().filter(pk=pk).first()
        if doc is None:
            raise NotFound()
        document_services.decline_document(doc, request.user, reason=str(request.data.get("reason", "")), ip=client_ip(request))
        return Response({"status": "declined"})


class PortalDocumentPdfView(PortalView):
    def get(self, request, pk):
        doc = self.documents().filter(pk=pk).first()
        if doc is None:
            raise NotFound()
        response = HttpResponse(document_services.render_document_pdf(doc), content_type="application/pdf")
        response["Content-Disposition"] = f'attachment; filename="document-{doc.pk}.pdf"'
        return response


class PortalInvoiceListView(PortalView):
    def get(self, request):
        return Response([_invoice_summary(inv) for inv in self.invoices().order_by("-issue_date", "-id")])


class PortalInvoiceDetailView(PortalView):
    def get(self, request, pk):
        invoice = self.invoices().select_related("organization").filter(pk=pk).first()
        if invoice is None:
            raise NotFound()
        if invoice.viewed_at is None and invoice.status != Invoice.Status.VOID:
            Invoice.objects.filter(pk=invoice.pk, viewed_at__isnull=True).update(viewed_at=timezone.now())
            log_activity(organization=request.org, actor=request.user, verb="viewed_invoice", target=invoice,
                         client=self.client)
        org = invoice.organization
        return Response({
            **_invoice_summary(invoice),
            "payment_terms": invoice.payment_terms, "notes": invoice.notes,
            "subtotal": str(invoice.subtotal), "discount_amount": str(invoice.discount_amount),
            "tax_label": invoice.tax_label, "tax_rate": str(invoice.tax_rate), "tax_amount": str(invoice.tax_amount),
            "amount_credited": str(invoice.amount_credited),
            "lines": [{"description": line.description, "quantity": str(line.quantity), "unit": line.unit,
                       "unit_price": str(line.unit_price), "amount": str(line.amount)} for line in invoice.lines.all()],
            "payments": [{"id": p.pk, "amount": str(p.amount), "method": p.get_method_display(),
                          "received_at": p.received_at, "reference": p.provider_reference}
                         for p in invoice.payments.filter(status=Payment.Status.SUCCEEDED)],
            "credit_notes": [{"number": c.number, "amount": str(c.amount), "created_at": c.created_at}
                             for c in invoice.credit_notes.all()],
            "organization": {"name": org.name, "address": org.address, "email": org.email},
            "allow_partial_payments": org.allow_partial_payments,
            "payment_provider": payments.provider_status(),
        })


class PortalInvoicePdfView(PortalView):
    def get(self, request, pk):
        invoice = self.invoices().filter(pk=pk).first()
        if invoice is None:
            raise NotFound()
        response = HttpResponse(render_invoice_pdf(invoice), content_type="application/pdf")
        response["Content-Disposition"] = f'attachment; filename="{invoice.number}.pdf"'
        return response


class PortalCheckoutCreateView(PortalView):
    throttle_scope = "payments"

    def post(self, request, pk):
        from decimal import Decimal, InvalidOperation

        invoice = self.invoices().filter(pk=pk).first()
        if invoice is None:
            raise NotFound()
        raw = request.data.get("amount")
        try:
            amount = Decimal(str(raw)) if raw not in (None, "") else invoice.amount_due
        except InvalidOperation:
            raise ValidationError({"amount": ["Enter a valid amount."]})
        try:
            checkout = payments.create_checkout(invoice, amount=amount, initiated_by=request.user,
                                                customer_email=request.user.email)
        except payments.ProviderNotConfigured as exc:
            raise BusinessRuleError(f"Online payments are not configured: {exc}", code="provider_not_configured",
                                    status_code=503)
        return Response({"checkout_id": checkout.pk, "checkout_url": checkout.checkout_url,
                         "provider": checkout.provider, "amount": str(checkout.amount)}, status=status.HTTP_201_CREATED)


class PortalCheckoutStatusView(PortalView):
    def get(self, request, pk):
        checkout = CheckoutSession.objects.filter(organization=request.org, pk=pk, invoice__client=self.client).select_related("invoice").first()
        if checkout is None:
            raise NotFound()
        outcome = payments.verify_checkout(checkout)
        checkout.refresh_from_db()
        invoice = Invoice.objects.get(pk=checkout.invoice_id)
        return Response({"checkout_id": checkout.pk, "status": checkout.status, "outcome": outcome,
                         "failure_reason": checkout.failure_reason, "amount": str(checkout.amount),
                         "invoice": _invoice_summary(invoice)})


class PortalPaymentListView(PortalView):
    def get(self, request):
        qs = Payment.objects.filter(organization=request.org, invoice__client=self.client,
                                    status=Payment.Status.SUCCEEDED).select_related("invoice")
        return Response([{"id": p.pk, "invoice_id": p.invoice_id, "invoice_number": p.invoice.number,
                          "amount": str(p.amount), "currency": p.currency, "method": p.get_method_display(),
                          "received_at": p.received_at, "reference": p.provider_reference} for p in qs])
