import { ArrowRight, CheckCircle2, CheckSquare, FileSignature, FolderKanban, GitPullRequestArrow, PackageCheck, Receipt } from "lucide-react";
import type * as React from "react";
import { Link } from "react-router";

import { ActivityList } from "@/components/common/collab";
import { EmptyState, ErrorState, MoneyList, PageHeader, PageLoader, StatCard } from "@/components/common/layout-bits";
import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ProgressBar } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/session";
import { daysUntil, formatDate, formatMoney } from "@/lib/format";
import { NotificationSettings, ProfileSettings } from "@/pages/settings/SettingsPage";

import { CLIENT_NOTIFICATION_KINDS, type PortalApproval, usePortalSummary } from "./portalApi";

export const APPROVAL_ICONS: Record<PortalApproval["type"], React.ComponentType<{ className?: string }>> = {
  document: FileSignature,
  deliverable: PackageCheck,
  change_request: GitPullRequestArrow,
  invoice: Receipt,
};

export function DueText({ date, prefix = "Due" }: { date: string | null; prefix?: string }) {
  if (!date) return null;
  const days = daysUntil(date);
  const overdue = days !== null && days < 0;
  return (
    <span className={overdue ? "font-medium text-danger" : undefined}>
      {prefix} {formatDate(date)}
      {days !== null && (overdue ? ` · ${Math.abs(days)}d overdue` : days === 0 ? " · today" : days <= 7 ? ` · in ${days}d` : "")}
    </span>
  );
}

export function ApprovalRow({ item }: { item: PortalApproval }) {
  const Icon = APPROVAL_ICONS[item.type];
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{item.title}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
          <span className={item.status === "overdue" ? "font-medium text-danger" : undefined}>{item.status_label}</span>
          {item.project && <span>· {item.project}</span>}
          {item.due_date && <>· <DueText date={item.due_date} prefix={item.type === "document" ? "Expires" : "Due"} /></>}
        </p>
      </div>
      {/* On phones the amount and action move to their own line under the title. */}
      <div className="ml-12 flex w-full items-center justify-between gap-3 sm:ml-0 sm:w-auto">
        {item.amount && item.currency ? <span className="text-[13px] font-semibold tabular">{formatMoney(item.amount, item.currency)}</span> : <span />}
        <Button size="sm" variant={item.type === "invoice" ? "primary" : "outline"} asChild>
          <Link to={item.link}>
            {item.action} <ArrowRight />
          </Link>
        </Button>
      </div>
    </li>
  );
}

export function PortalHomePage() {
  const { user } = useAuth();
  const query = usePortalSummary();
  if (query.isLoading) return <PageLoader />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const d = query.data;
  const activeProjects = d.projects.filter((p) => p.status !== "completed" && p.status !== "cancelled");
  const firstName = user.full_name.split(" ")[0];
  return (
    <>
      <PageHeader title={`Welcome back, ${firstName}`} description={`Everything ${d.organization.name} needs from ${d.client.name}, and how your projects are progressing.`} />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Waiting on you" value={d.approvals.length} icon={CheckSquare} sub={d.approvals.length ? "Approvals, signatures and payments" : "Nothing needs your attention"} to="/portal/approvals" tone={d.approvals.length ? "warning" : "success"} />
        <StatCard label="Outstanding balance" value={<MoneyList list={d.outstanding} empty="Nothing due" />} icon={Receipt} sub="Across open invoices" to="/portal/invoices" />
        <StatCard label="Active projects" value={activeProjects.length} icon={FolderKanban} sub={`${d.projects.length} shared with you`} to="/portal/projects" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Needs your attention</CardTitle>
                <CardDescription>Items are ordered by due date.</CardDescription>
              </div>
              {d.approvals.length > 0 && <Button variant="ghost" size="sm" asChild><Link to="/portal/approvals">View all</Link></Button>}
            </CardHeader>
            {d.approvals.length ? (
              <ul className="divide-y divide-border border-t border-border" data-testid="portal-approvals">
                {d.approvals.slice(0, 6).map((a) => <ApprovalRow key={`${a.type}-${a.id}`} item={a} />)}
              </ul>
            ) : (
              <EmptyState compact icon={CheckCircle2} title="You're all caught up" description="We'll notify you when something needs your review." />
            )}
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Projects</CardTitle>
              <Button variant="ghost" size="sm" asChild><Link to="/portal/projects">All projects</Link></Button>
            </CardHeader>
            {d.projects.length ? (
              <ul className="divide-y divide-border border-t border-border">
                {d.projects.map((p) => (
                  <li key={p.id}>
                    <Link to={`/portal/projects/${p.id}`} className="flex flex-wrap items-center gap-4 px-4 py-3 hover:bg-surface-2 sm:flex-nowrap">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium">{p.name}</p>
                        <p className="text-xs text-muted">
                          {p.code}
                          {p.manager && ` · Managed by ${p.manager}`}
                          {p.deadline && <> · <DueText date={p.deadline} /></>}
                        </p>
                      </div>
                      <div className="flex w-full items-center gap-3 sm:w-auto">
                        <div className="flex flex-1 items-center gap-2 sm:w-40 sm:flex-none">
                          <ProgressBar value={p.progress} tone={p.progress >= 100 ? "success" : "primary"} label={`${p.name} progress`} />
                          <span className="w-9 text-right text-xs tabular text-muted">{p.progress}%</span>
                        </div>
                        <StatusBadge kind="project" status={p.status} />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact icon={FolderKanban} title="No shared projects yet" />
            )}
          </Card>
        </div>
        <Card>
          <CardHeader><CardTitle>Recent activity</CardTitle></CardHeader>
          <CardContent>
            <ActivityList items={d.activity} empty="No shared activity yet." />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export function PortalAccountPage() {
  const { session, org } = useAuth();
  return (
    <>
      <PageHeader
        title="Account settings"
        description={`Signed in as a contact for ${session.membership?.client?.name ?? "your organization"} in ${org.name}'s client portal.`}
        meta={<Badge tone="info">Client contact</Badge>}
      />
      <div className="space-y-6">
        <ProfileSettings />
        <NotificationSettings kinds={CLIENT_NOTIFICATION_KINDS} />
      </div>
    </>
  );
}
