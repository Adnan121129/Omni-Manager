from django.urls import include, path
from rest_framework.routers import DefaultRouter

from apps.accounts import views as accounts
from apps.core import views as core
from apps.crm import views as crm
from apps.documents import views as documents
from apps.portal import views as portal
from apps.reports import views as reports
from apps.finance import views as finance
from apps.projects import views as projects
from apps.timetracking import views as timetracking

router = DefaultRouter(trailing_slash=True)
router.include_root_view = False
router.register("team/members", accounts.MemberViewSet, basename="member")
router.register("team/invitations", accounts.InvitationViewSet, basename="invitation")
router.register("notifications", core.NotificationViewSet, basename="notification")
router.register("clients", crm.ClientViewSet, basename="client")
router.register("leads", crm.LeadViewSet, basename="lead")
router.register("interactions", crm.InteractionViewSet, basename="interaction")
router.register("projects", projects.ProjectViewSet, basename="project")
router.register("tasks", projects.TaskViewSet, basename="task")
router.register("labels", projects.LabelViewSet, basename="label")
router.register("milestones", projects.MilestoneViewSet, basename="milestone")
router.register("deliverables", projects.DeliverableViewSet, basename="deliverable")
router.register("change-requests", projects.ChangeRequestViewSet, basename="change-request")
router.register("time-entries", timetracking.TimeEntryViewSet, basename="time-entry")
router.register("timer", timetracking.TimerViewSet, basename="timer")
router.register("approvals/time", timetracking.ApprovalViewSet, basename="time-approval")
router.register("expense-categories", finance.ExpenseCategoryViewSet, basename="expense-category")
router.register("expenses", finance.ExpenseViewSet, basename="expense")
router.register("invoices", finance.InvoiceViewSet, basename="invoice")
router.register("payments", finance.PaymentViewSet, basename="payment")
router.register("recurring-invoices", finance.RecurringScheduleViewSet, basename="recurring-invoice")
router.register("contract-templates", documents.ContractTemplateViewSet, basename="contract-template")
router.register("documents", documents.DocumentViewSet, basename="document")

auth_patterns = [
    path("csrf/", accounts.CsrfView.as_view()),
    path("signup/", accounts.SignupView.as_view()),
    path("login/", accounts.LoginView.as_view()),
    path("logout/", accounts.LogoutView.as_view()),
    path("me/", accounts.MeView.as_view()),
    path("change-password/", accounts.ChangePasswordView.as_view()),
    path("password-reset/", accounts.PasswordResetRequestView.as_view()),
    path("password-reset/confirm/", accounts.PasswordResetConfirmView.as_view()),
    path("switch-workspace/", accounts.SwitchWorkspaceView.as_view()),
    path("workspaces/", accounts.CreateWorkspaceView.as_view()),
    path("invitations/<str:token>/", accounts.InvitationLookupView.as_view()),
]

portal_patterns = [
    path("summary/", portal.PortalSummaryView.as_view()),
    path("projects/", portal.PortalProjectListView.as_view()),
    path("projects/<int:pk>/", portal.PortalProjectDetailView.as_view()),
    path("projects/<int:pk>/files/", portal.PortalFileUploadView.as_view()),
    path("deliverables/<int:pk>/<str:decision>/", portal.PortalDeliverableDecisionView.as_view()),
    path("change-requests/<int:pk>/<str:decision>/", portal.PortalChangeRequestDecisionView.as_view()),
    path("comments/", portal.PortalCommentsView.as_view()),
    path("files/<int:pk>/download/", portal.PortalFileDownloadView.as_view()),
    path("documents/", portal.PortalDocumentListView.as_view()),
    path("documents/<int:pk>/", portal.PortalDocumentDetailView.as_view()),
    path("documents/<int:pk>/sign/", portal.PortalDocumentSignView.as_view()),
    path("documents/<int:pk>/decline/", portal.PortalDocumentDeclineView.as_view()),
    path("documents/<int:pk>/pdf/", portal.PortalDocumentPdfView.as_view()),
    path("invoices/", portal.PortalInvoiceListView.as_view()),
    path("invoices/<int:pk>/", portal.PortalInvoiceDetailView.as_view()),
    path("invoices/<int:pk>/pdf/", portal.PortalInvoicePdfView.as_view()),
    path("invoices/<int:pk>/checkout/", portal.PortalCheckoutCreateView.as_view()),
    path("checkouts/<int:pk>/", portal.PortalCheckoutStatusView.as_view()),
    path("payments/", portal.PortalPaymentListView.as_view()),
]

urlpatterns = [
    path("auth/", include(auth_patterns)),
    path("portal/", include(portal_patterns)),
    path("dashboard/", reports.DashboardView.as_view()),
    path("reports/overview/", reports.ReportOverviewView.as_view()),
    path("reports/export/<str:name>/", reports.ReportExportView.as_view()),
    path("revenue-leak/", reports.RevenueLeakView.as_view()),
    path("team/workload/", reports.WorkloadView.as_view()),
    path("calendar/", reports.CalendarView.as_view()),
    path("search/", reports.SearchView.as_view()),
    path("workspace/", accounts.WorkspaceSettingsView.as_view()),
    path("workspace/logo/", accounts.WorkspaceLogoView.as_view()),
    path("workspace/notification-preferences/", accounts.NotificationPreferencesView.as_view()),
    path("comments/", core.CommentListView.as_view()),
    path("comments/<int:pk>/", core.CommentDetailView.as_view()),
    path("files/", core.AttachmentListView.as_view()),
    path("files/<int:pk>/", core.AttachmentDetailView.as_view()),
    path("files/<int:pk>/download/", core.AttachmentDownloadView.as_view()),
    path("activity/", core.ActivityFeedView.as_view()),
    path("timesheets/week/", timetracking.WeekTimesheetView.as_view()),
    path("payments/provider/", finance.PaymentProviderStatusView.as_view()),
    path("payments/webhooks/<str:provider>/", finance.WebhookView.as_view()),
    path("payments/sandbox/<str:session_id>/", finance.SandboxCheckoutView.as_view()),
    path("", include(router.urls)),
]
