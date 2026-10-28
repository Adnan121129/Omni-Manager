"""Expense submission and approval workflow: draft -> submitted -> approved | rejected."""

from django.db import transaction
from django.utils import timezone

from apps.accounts.models import ADMIN_ROLES, Membership, Role
from apps.core.activity import log_activity
from apps.core.exceptions import BusinessRuleError
from apps.core.notify import notify
from apps.projects.access import can_manage_project, can_view_project, managed_projects
from apps.projects.services import check_budget_thresholds

from .models import Expense


def validate_expense_data(membership: Membership, data: dict, instance: Expense | None = None) -> dict:
    project = data.get("project", getattr(instance, "project", None))
    billable = data.get("billable", getattr(instance, "billable", False))
    currency = data.get("currency", getattr(instance, "currency", None)) or membership.organization.default_currency
    if project is not None:
        if not can_view_project(membership, project):
            raise BusinessRuleError("You can only log expenses on projects you are a member of.", code="not_project_member")
        if currency != project.currency:
            raise BusinessRuleError(f"Expenses on {project.code} must be in {project.currency}.", code="currency_mismatch")
        data["client"] = project.client
    if billable and project is None:
        raise BusinessRuleError("Billable expenses must be linked to a project so they can be invoiced.",
                                code="billable_requires_project")
    amount = data.get("amount", getattr(instance, "amount", None))
    if billable:
        if data.get("billable_amount") in (None, "") and (instance is None or not instance.billable or "amount" in data):
            data["billable_amount"] = amount
    else:
        data["billable_amount"] = 0
    data["currency"] = currency
    return data


def approvable_expenses(membership: Membership):
    qs = Expense.objects.filter(organization=membership.organization)
    if membership.is_admin:
        return qs
    if membership.role == Role.PROJECT_MANAGER:
        return qs.filter(project__in=managed_projects(membership))
    return qs.none()


def assert_editable(expense: Expense, user) -> None:
    if expense.user_id != user.pk:
        raise BusinessRuleError("You can only edit your own expenses.", code="not_owner", status_code=403)
    if expense.status not in Expense.EDITABLE_STATUSES:
        raise BusinessRuleError(f"{expense.get_status_display()} expenses are locked.", code="expense_locked")


def _approvers(expense: Expense):
    if expense.project_id and expense.project.manager_id:
        return [expense.project.manager]
    return [m.user for m in Membership.objects.filter(organization_id=expense.organization_id, role__in=ADMIN_ROLES,
                                                      status=Membership.Status.ACTIVE).select_related("user")]


@transaction.atomic
def submit(membership: Membership, expense: Expense) -> Expense:
    expense = Expense.objects.select_for_update(of=("self",)).select_related("project").get(pk=expense.pk)
    assert_editable(expense, membership.user)
    expense.status = Expense.Status.SUBMITTED
    expense.submitted_at = timezone.now()
    expense.rejection_reason = ""
    expense.save()
    log_activity(organization=expense.organization, actor=membership.user, verb="submitted_expense", target=expense,
                 amount=expense.amount, currency=expense.currency)
    notify(organization=expense.organization, recipients=_approvers(expense), kind="expense_submitted",
           title=f"{membership.user.full_name} submitted an expense: {expense.currency} {expense.amount}",
           body=expense.description, link="/expenses?tab=approvals", exclude=membership.user)
    return expense


@transaction.atomic
def decide(membership: Membership, expense: Expense, *, approve: bool, reason: str = "") -> Expense:
    expense = approvable_expenses(membership).select_for_update(of=("self",)).select_related("project").filter(pk=expense.pk).first()
    if expense is None:
        raise BusinessRuleError("You cannot review this expense.", code="not_approvable", status_code=403)
    if expense.status != Expense.Status.SUBMITTED:
        raise BusinessRuleError("Only submitted expenses can be reviewed.", code="invalid_status")
    if expense.user_id == membership.user_id and membership.role != Role.OWNER:
        raise BusinessRuleError("You cannot approve your own expense.", code="self_approval", status_code=403)
    if expense.project_id and not (membership.is_admin or can_manage_project(membership, expense.project)):
        raise BusinessRuleError("You cannot review this expense.", code="not_approvable", status_code=403)
    if approve:
        expense.status = Expense.Status.APPROVED
        expense.approved_at = timezone.now()
        expense.approved_by = membership.user
        expense.rejection_reason = ""
    else:
        reason = (reason or "").strip()
        if not reason:
            raise BusinessRuleError("A rejection reason is required.", code="reason_required")
        expense.status = Expense.Status.REJECTED
        expense.rejected_at = timezone.now()
        expense.rejection_reason = reason
    expense.save()
    verb = "approved_expense" if approve else "rejected_expense"
    log_activity(organization=expense.organization, actor=membership.user, verb=verb, target=expense,
                 amount=expense.amount, reason=reason)
    notify(organization=expense.organization, recipients=[expense.user], kind="expense_decided",
           title=f"Your expense '{expense.description[:60]}' was {'approved' if approve else 'rejected'}",
           body=reason, link="/expenses", exclude=membership.user)
    if approve and expense.project_id:
        project = expense.project
        transaction.on_commit(lambda: check_budget_thresholds(project))
    return expense


@transaction.atomic
def reopen(membership: Membership, expense: Expense, reason: str) -> Expense:
    reason = (reason or "").strip()
    if not reason:
        raise BusinessRuleError("Explain why this expense needs correction.", code="reason_required")
    expense = approvable_expenses(membership).select_for_update(of=("self",)).filter(pk=expense.pk).first()
    if expense is None:
        raise BusinessRuleError("You cannot reopen this expense.", code="not_approvable", status_code=403)
    if expense.status != Expense.Status.APPROVED:
        raise BusinessRuleError("Only approved expenses can be reopened.")
    if expense.invoice_line_id:
        raise BusinessRuleError("This expense has been invoiced. Void the invoice first.", code="already_invoiced")
    expense.status = Expense.Status.DRAFT
    expense.approved_at = None
    expense.approved_by = None
    expense.rejection_reason = f"Reopened for correction: {reason}"
    expense.save()
    log_activity(organization=expense.organization, actor=membership.user, verb="reopened_expense", target=expense,
                 reason=reason)
    return expense
