import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, LayoutGrid, List, Pencil, Plus, Receipt, RotateCcw } from "lucide-react";
import * as React from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";

import { ActivityFeed, AttachmentsPanel, CommentsThread } from "@/components/common/collab";
import { EmptyState, ErrorState, MoneyList, PageHeader, PageLoader, StatCard } from "@/components/common/layout-bits";
import { PriorityIndicator, StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ProgressBar } from "@/components/ui/primitives";
import { BudgetPanel, ChangeRequestsTab, DeliverablesTab, HealthCard, MembersCard, MilestonesTab, ProjectFacts } from "@/features/projects/ProjectTabs";
import { ProjectFormDialog } from "@/features/projects/ProjectForm";
import { asList, useTaskList } from "@/features/tasks/taskApi";
import { TaskCreateDialog } from "@/features/tasks/TaskDrawer";
import { TaskBoard, TaskTable } from "@/features/tasks/TaskViews";
import { TimeEntryDialog, TimeEntryTable } from "@/features/time/TimeComponents";
import { useMembers } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { api, ApiError, errorMessage, type Paginated } from "@/lib/api";
import { daysUntil, formatDate, formatDuration, formatHours, formatMoney } from "@/lib/format";
import type { Expense, Project, TimeEntry } from "@/lib/types";
import { safeStorage } from "@/lib/utils";

function CompleteDialog({ project, open, onOpenChange }: { project: Project; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const blockers = project.completion_blockers;
  const hasBlockers = Boolean(blockers && (blockers.open_tasks_count || blockers.open_milestones.length || blockers.pending_deliverables.length));
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Complete ${project.code}?`}
      tone="primary"
      confirmLabel={hasBlockers ? "Complete with open work" : "Mark project complete"}
      loading={busy}
      description={
        hasBlockers ? (
          <div className="space-y-2">
            <p>Completion is normally based on finished tasks and milestones. This project still has:</p>
            <ul className="list-disc pl-5">
              {blockers!.open_tasks_count > 0 && <li>{blockers!.open_tasks_count} open task(s): {blockers!.open_tasks.slice(0, 3).map((t) => t.title).join(", ")}</li>}
              {blockers!.open_milestones.length > 0 && <li>Open milestones: {blockers!.open_milestones.map((m) => m.name).join(", ")}</li>}
              {blockers!.pending_deliverables.length > 0 && <li>Deliverables awaiting client approval: {blockers!.pending_deliverables.map((d) => d.title).join(", ")}</li>}
            </ul>
            <p>To complete anyway, give a reason — it's recorded in the activity log.</p>
          </div>
        ) : (
          "All tasks and milestones are finished. The client will see the project as completed."
        )
      }
      onConfirm={async () => {
        if (hasBlockers && !reason.trim()) return toast.error("Please give a reason.");
        setBusy(true);
        try {
          await api.post(`/projects/${project.id}/complete/`, { force: hasBlockers, reason });
          queryClient.invalidateQueries({ queryKey: ["project", project.id] });
          queryClient.invalidateQueries({ queryKey: ["projects"] });
          toast.success("Project completed");
          onOpenChange(false);
        } catch (err) {
          toast.error(err instanceof ApiError ? err.message : errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {hasBlockers && <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for completing with open work" aria-label="Reason" />}
    </ConfirmDialog>
  );
}

function TasksTab({ project }: { project: Project }) {
  const [view, setView] = React.useState<"board" | "list">(() => (safeStorage.get("om-project-tasks-view") as "board" | "list") || "board");
  const [assignee, setAssignee] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const members = useMembers();
  const query = useTaskList(`project=${project.id}&all=1${assignee ? `&assignee=${assignee}` : ""}${view === "board" ? "&parent=none" : ""}`);
  const tasks = asList(query.data);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={view}
          onChange={(v) => { setView(v); safeStorage.set("om-project-tasks-view", v); }}
          options={[{ value: "board", label: "Board", icon: <LayoutGrid /> }, { value: "list", label: "List", icon: <List /> }]}
        />
        <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="h-8 w-48 text-xs" aria-label="Filter by assignee">
          <option value="">Everyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
          {members.data?.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name}</option>)}
        </Select>
        <Button size="sm" className="ml-auto" onClick={() => setCreating(true)} disabled={["completed", "cancelled"].includes(project.status)}><Plus /> New task</Button>
      </div>
      {query.isLoading ? (
        <Card><EmptyState compact title="Loading tasks…" /></Card>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : tasks.length === 0 && !assignee ? (
        <Card><EmptyState title="No tasks yet" description="Break the work down into tasks your team can track time against." action={<Button onClick={() => setCreating(true)}><Plus /> New task</Button>} /></Card>
      ) : view === "board" ? (
        <TaskBoard tasks={tasks} showProject={false} />
      ) : (
        <Card><TaskTable tasks={tasks} showProject={false} /></Card>
      )}
      <TaskCreateDialog open={creating} onOpenChange={setCreating} projectId={project.id} />
    </div>
  );
}

function TimeTab({ project }: { project: Project }) {
  const { permissions } = useAuth();
  const [editing, setEditing] = React.useState<TimeEntry | null | undefined>(undefined);
  const scope = project.can_manage || permissions.is_admin ? "team" : "mine";
  const query = useQuery({ queryKey: ["time-entries", "project", project.id, scope], queryFn: () => api.get<Paginated<TimeEntry> & { totals: { total_seconds: number; billable_seconds: number } }>(`/time-entries/?project=${project.id}&scope=${scope}&page_size=100`) });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Time entries</CardTitle>
          <CardDescription>
            {scope === "team" ? "All tracked time on this project" : "Your time on this project"}
            {query.data && ` · ${formatDuration(query.data.totals.total_seconds)} total, ${formatDuration(query.data.totals.billable_seconds)} billable`}
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => setEditing(null)}><Clock /> Log time</Button>
      </CardHeader>
      {query.data?.results.length ? (
        <TimeEntryTable entries={query.data.results} showUser={scope === "team"} onEdit={setEditing} />
      ) : (
        <EmptyState compact title={query.isLoading ? "Loading…" : "No time tracked yet"} />
      )}
      <TimeEntryDialog open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)} entry={editing ?? null} defaults={{ project: project.id }} />
    </Card>
  );
}

function ExpensesTab({ project }: { project: Project }) {
  const query = useQuery({ queryKey: ["expenses", "project", project.id], queryFn: () => api.get<Paginated<Expense>>(`/expenses/?project=${project.id}&scope=team&page_size=100`) });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Expenses</CardTitle>
          <CardDescription>Internal cost and the amount chargeable to the client</CardDescription>
        </div>
        <Button size="sm" variant="outline" asChild><Link to={`/expenses?new=1&project=${project.id}`}><Plus /> Add expense</Link></Button>
      </CardHeader>
      {query.data?.results.length ? (
        <ul className="divide-y divide-border border-t border-border">
          {query.data.results.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-[13px]">
              <span className="w-20 text-muted">{formatDate(x.date, { month: "short", day: "numeric" })}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{x.description}</span>
                <span className="text-xs text-muted">{x.category_name ?? "Uncategorized"} · {x.user.full_name}</span>
              </span>
              <StatusBadge kind="entry" status={x.status} />
              {x.is_invoiced && <Badge tone="primary">Invoiced</Badge>}
              <span className="w-40 text-right tabular">
                {formatMoney(x.amount, x.currency)}
                {x.billable && <span className="block text-xs text-muted">bill {formatMoney(x.billable_amount, x.currency)}</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState compact title={query.isLoading ? "Loading…" : "No expenses recorded"} />
      )}
    </Card>
  );
}

export function ProjectDetailPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { permissions } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["project", Number(id)], queryFn: () => api.get<Project>(`/projects/${id}/`) });
  const [editing, setEditing] = React.useState(false);
  const [completing, setCompleting] = React.useState(params.get("complete") === "1");
  const requestedTab = params.get("tab") ?? "overview";
  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", t);
    next.delete("complete");
    setParams(next, { replace: true });
  };
  if (query.isLoading) return <PageLoader />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const p = query.data;
  const allowedTabs = ["overview", "tasks", "milestones", "deliverables", "time", "changes", "files", "discussion", "activity", ...(p.can_manage ? ["budget", "expenses"] : [])];
  const tab = allowedTabs.includes(requestedTab) ? requestedTab : "overview";
  const closed = ["completed", "cancelled"].includes(p.status);
  const days = daysUntil(p.deadline);
  const b = p.budget;

  return (
    <>
      <PageHeader
        back={{ to: "/projects", label: "Projects" }}
        title={
          <span className="flex items-center gap-2.5">
            <span className="size-3 rounded-sm" style={{ backgroundColor: p.color }} />
            {p.name}
          </span>
        }
        meta={
          <>
            <span className="font-mono text-xs text-muted">{p.code}</span>
            <StatusBadge kind="project" status={p.status} />
            {p.health && <StatusBadge kind="health" status={p.health.status} />}
            <PriorityIndicator priority={p.priority} />
            <span className="text-[13px] text-muted">
              {permissions.is_manager ? <Link to={`/clients/${p.client}`} className="hover:text-fg hover:underline">{p.client_name}</Link> : p.client_name}
              {p.manager_detail && ` · managed by ${p.manager_detail.full_name}`}
            </span>
          </>
        }
        actions={
          p.can_manage && (
            <>
              {permissions.billing && !closed && (
                <Button variant="outline" asChild><Link to={`/invoices/new?client=${p.client}&project=${p.id}`}><Receipt /> Invoice work</Link></Button>
              )}
              <Button variant="outline" onClick={() => setEditing(true)}><Pencil /> Edit</Button>
              {closed ? (
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      await api.post(`/projects/${p.id}/reopen/`);
                      queryClient.invalidateQueries({ queryKey: ["project", p.id] });
                      toast.success("Project reopened");
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                >
                  <RotateCcw /> Reopen
                </Button>
              ) : (
                <Button onClick={() => setCompleting(true)}><CheckCircle2 /> Mark complete</Button>
              )}
            </>
          )
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Progress"
          value={`${p.progress?.percent ?? 0}%`}
          sub={<span className="block space-y-1.5"><ProgressBar value={p.progress?.percent ?? 0} tone="primary" /><span className="block">{p.progress?.tasks_done}/{p.progress?.tasks_total} tasks · {p.progress?.milestones_done}/{p.progress?.milestones_total} milestones</span></span>}
        />
        <StatCard
          label={b?.budget_period === "month" ? "Hours this month" : "Hours tracked"}
          value={formatHours(b?.budget_period === "month" ? b?.hours_used : b?.hours_tracked)}
          sub={Number(b?.hours_budget) ? `of ${formatHours(b?.hours_budget)} budgeted${b?.hours_percent ? ` · ${Number(b.hours_percent).toFixed(0)}%` : ""}` : "No hour budget"}
          tone={Number(b?.hours_percent ?? 0) >= 100 ? "danger" : "default"}
        />
        {p.can_manage && b?.fees_used !== undefined ? (
          <StatCard
            label={b.budget_period === "month" ? "Retainer fees this month" : "Fees used"}
            value={formatMoney(b.fees_used, p.currency)}
            sub={Number(b.fees_budget) ? `of ${formatMoney(b.fees_budget, p.currency)} · ${Number(b.fees_percent ?? 0).toFixed(0)}%` : "No fee budget"}
            tone={Number(b.fees_percent ?? 0) >= 100 ? "danger" : "default"}
          />
        ) : (
          <StatCard label="Open tasks" value={(p.progress?.tasks_total ?? 0) - (p.progress?.tasks_done ?? 0)} sub={`${p.progress?.tasks_overdue ?? 0} overdue`} />
        )}
        <StatCard
          label="Deadline"
          value={p.deadline ? formatDate(p.deadline, { month: "short", day: "numeric" }) : "—"}
          sub={closed ? `Project ${p.status}` : days === null ? "No deadline set" : days < 0 ? <span className="text-danger">{-days} days overdue</span> : `${days} days left`}
          tone={!closed && days !== null && days < 0 ? "danger" : "default"}
        />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="milestones">Milestones</TabsTrigger>
          <TabsTrigger value="deliverables">Deliverables</TabsTrigger>
          <TabsTrigger value="time">Time</TabsTrigger>
          {p.can_manage && <TabsTrigger value="budget">Budget</TabsTrigger>}
          {p.can_manage && <TabsTrigger value="expenses">Expenses</TabsTrigger>}
          <TabsTrigger value="changes">Change requests</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="discussion">Discussion</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <Card>
                <CardHeader><CardTitle>About this project</CardTitle></CardHeader>
                <CardContent className="space-y-5">
                  {p.description ? <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{p.description}</p> : <p className="text-[13px] text-muted">No description.</p>}
                  <ProjectFacts project={p} />
                  {p.retainer && (
                    <div className="rounded-md bg-subtle px-3 py-2 text-[13px]">
                      Retainer this month: <strong className="tabular">{formatHours(p.retainer.hours_used)}</strong> of {formatHours(p.retainer.hours_included)} used
                      {p.retainer.percent && ` (${Number(p.retainer.percent).toFixed(0)}%)`}
                    </div>
                  )}
                  {p.can_manage && b && (
                    <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-[13px]">
                      <span><span className="text-muted">Invoiced</span> <span className="tabular font-medium">{formatMoney(b.invoiced ?? 0, p.currency)}</span></span>
                      <span><span className="text-muted">Collected</span> <span className="tabular font-medium">{formatMoney(b.collected ?? 0, p.currency)}</span></span>
                      <span><span className="text-muted">Approved, unbilled</span> <span className="tabular font-medium">{formatMoney(b.unbilled_approved_value ?? 0, p.currency)}</span></span>
                      <span><span className="text-muted">Hours awaiting approval</span> <span className="tabular font-medium">{formatHours(b.hours_pending_approval)}</span></span>
                    </div>
                  )}
                </CardContent>
              </Card>
              <MilestonesTab project={p} />
            </div>
            <div className="space-y-6">
              <HealthCard project={p} />
              <MembersCard project={p} />
              <Card>
                <CardHeader><CardTitle>Recent activity</CardTitle></CardHeader>
                <CardContent><ActivityFeed params={`project=${p.id}&limit=8`} /></CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="tasks"><TasksTab project={p} /></TabsContent>
        <TabsContent value="milestones"><MilestonesTab project={p} /></TabsContent>
        <TabsContent value="deliverables"><DeliverablesTab project={p} /></TabsContent>
        <TabsContent value="time"><TimeTab project={p} /></TabsContent>
        {p.can_manage && <TabsContent value="budget"><BudgetPanel project={p} /></TabsContent>}
        {p.can_manage && <TabsContent value="expenses"><ExpensesTab project={p} /></TabsContent>}
        <TabsContent value="changes"><ChangeRequestsTab project={p} /></TabsContent>
        <TabsContent value="files">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Files</CardTitle>
                <CardDescription>Shared files appear in the client portal; others stay internal.</CardDescription>
              </div>
            </CardHeader>
            <CardContent><AttachmentsPanel target={`project:${p.id}`} allowClientShare={p.can_manage} canManage={p.can_manage} /></CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="discussion">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Discussion</CardTitle>
                <CardDescription>Internal by default. Tick “Visible to client” to post an update to the portal.</CardDescription>
              </div>
            </CardHeader>
            <CardContent><CommentsThread target={`project:${p.id}`} allowClientShare={p.can_manage} /></CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="activity">
          <Card><CardContent className="pt-5"><ActivityFeed params={`project=${p.id}&limit=100`} /></CardContent></Card>
        </TabsContent>
      </Tabs>
      {b && p.can_manage && tab === "overview" && b.unbilled_approved_value && Number(b.unbilled_approved_value) > 0 && permissions.billing && (
        <p className="mt-4 text-xs text-muted">
          <MoneyList list={[{ currency: p.currency, amount: b.unbilled_approved_value }]} /> of approved work is ready to invoice.
        </p>
      )}
      <ProjectFormDialog open={editing} onOpenChange={setEditing} project={p} />
      <CompleteDialog project={p} open={completing} onOpenChange={setCompleting} />
    </>
  );
}
