import { Loader2, ShieldAlert } from "lucide-react";
import * as React from "react";
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from "react-router";

import { EmptyState, ErrorState } from "@/components/common/layout-bits";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { AuthProvider, useAuth, useSessionQuery } from "@/hooks/session";
import type { Permissions } from "@/lib/types";

function lazy<M, K extends keyof M>(factory: () => Promise<M>, name: K) {
  return React.lazy(async () => ({ default: (await factory())[name] as unknown as React.ComponentType }));
}

const LoginPage = lazy(() => import("@/pages/auth/AuthPages"), "LoginPage");
const SignupPage = lazy(() => import("@/pages/auth/AuthPages"), "SignupPage");
const ForgotPasswordPage = lazy(() => import("@/pages/auth/AuthPages"), "ForgotPasswordPage");
const ResetPasswordPage = lazy(() => import("@/pages/auth/AuthPages"), "ResetPasswordPage");
const AcceptInvitePage = lazy(() => import("@/pages/auth/AuthPages"), "AcceptInvitePage");
const NoWorkspacePage = lazy(() => import("@/pages/auth/AuthPages"), "NoWorkspacePage");
const DashboardPage = lazy(() => import("@/pages/dashboard/DashboardPage"), "DashboardPage");
const ProjectsPage = lazy(() => import("@/pages/projects/ProjectsPage"), "ProjectsPage");
const ProjectDetailPage = lazy(() => import("@/pages/projects/ProjectDetailPage"), "ProjectDetailPage");
const TasksPage = lazy(() => import("@/pages/tasks/TasksPage"), "TasksPage");
const CalendarPage = lazy(() => import("@/pages/calendar/CalendarPage"), "CalendarPage");
const TimePage = lazy(() => import("@/pages/time/TimePage"), "TimePage");
const TimesheetsPage = lazy(() => import("@/pages/time/TimesheetsPage"), "TimesheetsPage");
const CrmPage = lazy(() => import("@/pages/crm/CrmPage"), "CrmPage");
const ClientsPage = lazy(() => import("@/pages/clients/ClientsPage"), "ClientsPage");
const ClientDetailPage = lazy(() => import("@/pages/clients/ClientDetailPage"), "ClientDetailPage");
const DocumentsPage = lazy(() => import("@/pages/documents/DocumentsPage"), "DocumentsPage");
const DocumentDetailPage = lazy(() => import("@/pages/documents/DocumentDetailPage"), "DocumentDetailPage");
const InvoicesPage = lazy(() => import("@/pages/invoices/InvoicesPage"), "InvoicesPage");
const NewInvoicePage = lazy(() => import("@/pages/invoices/NewInvoicePage"), "NewInvoicePage");
const InvoiceDetailPage = lazy(() => import("@/pages/invoices/InvoiceDetailPage"), "InvoiceDetailPage");
const RecurringInvoicesPage = lazy(() => import("@/pages/invoices/RecurringInvoicesPage"), "RecurringInvoicesPage");
const ExpensesPage = lazy(() => import("@/pages/expenses/ExpensesPage"), "ExpensesPage");
const ReportsPage = lazy(() => import("@/pages/reports/ReportsPage"), "ReportsPage");
const RevenueRadarPage = lazy(() => import("@/pages/reports/RevenueRadarPage"), "RevenueRadarPage");
const TeamPage = lazy(() => import("@/pages/team/TeamPage"), "TeamPage");
const SettingsPage = lazy(() => import("@/pages/settings/SettingsPage"), "SettingsPage");
const SandboxCheckoutPage = lazy(() => import("@/pages/SandboxCheckoutPage"), "SandboxCheckoutPage");
const PortalShell = lazy(() => import("@/portal/PortalShell"), "PortalShell");
const PortalHomePage = lazy(() => import("@/portal/PortalHomePage"), "PortalHomePage");
const PortalApprovalsPage = lazy(() => import("@/portal/PortalApprovalsPage"), "PortalApprovalsPage");
const PortalProjectsPage = lazy(() => import("@/portal/PortalProjectsPage"), "PortalProjectsPage");
const PortalProjectDetailPage = lazy(() => import("@/portal/PortalProjectsPage"), "PortalProjectDetailPage");
const PortalDocumentsPage = lazy(() => import("@/portal/PortalDocumentsPage"), "PortalDocumentsPage");
const PortalDocumentPage = lazy(() => import("@/portal/PortalDocumentsPage"), "PortalDocumentPage");
const PortalInvoicesPage = lazy(() => import("@/portal/PortalInvoicesPage"), "PortalInvoicesPage");
const PortalInvoicePage = lazy(() => import("@/portal/PortalInvoicesPage"), "PortalInvoicePage");
const PortalAccountPage = lazy(() => import("@/portal/PortalHomePage"), "PortalAccountPage");

export function FullPageSpinner() {
  return (
    <div className="flex h-full items-center justify-center" aria-busy="true">
      <Loader2 className="size-6 animate-spin text-muted" aria-label="Loading" />
    </div>
  );
}

function Suspended({ children }: { children: React.ReactNode }) {
  return <React.Suspense fallback={<FullPageSpinner />}>{children}</React.Suspense>;
}

/** Loads the session; children render only when the user is signed in with a workspace. */
export function RequireAuth({ children }: { children?: React.ReactNode }) {
  const query = useSessionQuery();
  const location = useLocation();
  if (query.isLoading) return <FullPageSpinner />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} className="h-full" />;
  const session = query.data;
  if (!session) {
    const next = location.pathname + location.search;
    return <Navigate to={`/login${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`} replace />;
  }
  if (!session.membership || !session.organization) {
    return (
      <Suspended>
        <NoWorkspacePage />
      </Suspended>
    );
  }
  return <AuthProvider session={session}>{children ?? <Outlet />}</AuthProvider>;
}

function StaffOnly() {
  const { isClient } = useAuth();
  if (isClient) return <Navigate to="/portal" replace />;
  return <AppShell />;
}

function ClientOnly() {
  const { isClient } = useAuth();
  if (!isClient) return <Navigate to="/" replace />;
  return (
    <Suspended>
      <PortalShell />
    </Suspended>
  );
}

export function Gate({ allow, children }: { allow: (p: Permissions) => boolean; children: React.ReactNode }) {
  const { permissions } = useAuth();
  if (!allow(permissions)) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="You don't have access to this area"
        description="Ask a workspace owner or administrator if you need access."
        action={
          <Button variant="outline" asChild>
            <a href="/">Back to overview</a>
          </Button>
        }
      />
    );
  }
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState title="Page not found" description="The page you're looking for doesn't exist or was moved." action={<Button asChild><a href="/">Go home</a></Button>} />
    </div>
  );
}

const s = (el: React.ReactNode) => <Suspended>{el}</Suspended>;
const manager = (p: Permissions) => p.is_manager;
const billing = (p: Permissions) => p.billing;

export const routes = [
  { path: "/login", element: s(<LoginPage />) },
  { path: "/signup", element: s(<SignupPage />) },
  { path: "/forgot-password", element: s(<ForgotPasswordPage />) },
  { path: "/reset-password", element: s(<ResetPasswordPage />) },
  { path: "/accept-invite", element: s(<AcceptInvitePage />) },
  { path: "/pay/sandbox/:sessionId", element: s(<SandboxCheckoutPage />) },
  {
    element: <RequireAuth />,
    children: [
      {
        path: "/",
        element: <StaffOnly />,
        children: [
          { index: true, element: s(<DashboardPage />) },
          { path: "projects", element: s(<ProjectsPage />) },
          { path: "projects/:id", element: s(<ProjectDetailPage />) },
          { path: "tasks", element: s(<TasksPage />) },
          { path: "calendar", element: s(<CalendarPage />) },
          { path: "time", element: s(<TimePage />) },
          { path: "timesheets", element: s(<TimesheetsPage />) },
          { path: "crm", element: s(<Gate allow={manager}><CrmPage /></Gate>) },
          { path: "clients", element: s(<Gate allow={manager}><ClientsPage /></Gate>) },
          { path: "clients/:id", element: s(<Gate allow={manager}><ClientDetailPage /></Gate>) },
          { path: "documents", element: s(<Gate allow={manager}><DocumentsPage /></Gate>) },
          { path: "documents/:id", element: s(<Gate allow={manager}><DocumentDetailPage /></Gate>) },
          { path: "invoices", element: s(<Gate allow={billing}><InvoicesPage /></Gate>) },
          { path: "invoices/new", element: s(<Gate allow={billing}><NewInvoicePage /></Gate>) },
          { path: "invoices/recurring", element: s(<Gate allow={billing}><RecurringInvoicesPage /></Gate>) },
          { path: "invoices/:id", element: s(<Gate allow={billing}><InvoiceDetailPage /></Gate>) },
          { path: "expenses", element: s(<ExpensesPage />) },
          { path: "reports", element: s(<Gate allow={manager}><ReportsPage /></Gate>) },
          { path: "revenue-radar", element: s(<Gate allow={manager}><RevenueRadarPage /></Gate>) },
          { path: "team", element: s(<TeamPage />) },
          { path: "settings", element: s(<SettingsPage />) },
        ],
      },
      {
        path: "/portal",
        element: <ClientOnly />,
        children: [
          { index: true, element: s(<PortalHomePage />) },
          { path: "approvals", element: s(<PortalApprovalsPage />) },
          { path: "projects", element: s(<PortalProjectsPage />) },
          { path: "projects/:id", element: s(<PortalProjectDetailPage />) },
          { path: "documents", element: s(<PortalDocumentsPage />) },
          { path: "documents/:id", element: s(<PortalDocumentPage />) },
          { path: "invoices", element: s(<PortalInvoicesPage />) },
          { path: "invoices/:id", element: s(<PortalInvoicePage />) },
          { path: "account", element: s(<PortalAccountPage />) },
        ],
      },
    ],
  },
  { path: "*", element: <NotFound /> },
];

const router = createBrowserRouter(routes);

export default function App() {
  return <RouterProvider router={router} />;
}
