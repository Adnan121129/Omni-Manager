import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ClipboardCheck, Flag, Info, MoreHorizontal, Pencil, Plus, RotateCcw, Send, Trash2, Undo2, UserMinus, Wand2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { AttachmentsPanel, CommentsThread } from "@/components/common/collab";
import { DefinitionList, EmptyState, LoadingRows, Money } from "@/components/common/layout-bits";
import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Tooltip } from "@/components/ui/overlays";
import { Avatar, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ProgressBar } from "@/components/ui/primitives";
import { useApiMutation, useMembers } from "@/hooks/data";
import { api, ApiError, errorMessage } from "@/lib/api";
import { daysUntil, formatDate, formatDateShort, formatHours, formatMoney, percent, relativeTime } from "@/lib/format";
import type { Budget, ChangeRequest, Deliverable, Milestone, Project } from "@/lib/types";
import { cn } from "@/lib/utils";

const projectKeys = (id: number) => [["project", id], ["projects"], ["milestones", id], ["deliverables", id], ["change-requests", id], ["revenue-leak"], ["dashboard"]];

/* ------------------------------------------------------------------ Members */
export function MembersCard({ project }: { project: Project }) {
  const members = useMembers();
  const [adding, setAdding] = React.useState("");
  const add = useApiMutation((user: number) => api.post(`/projects/${project.id}/members/`, { user }), { success: "Member added", invalidate: projectKeys(project.id), onSuccess: () => setAdding("") });
  const remove = useApiMutation((user: number) => api.delete(`/projects/${project.id}/members/${user}/`), { success: "Member removed", invalidate: projectKeys(project.id) });
  const existing = new Set(project.members?.map((m) => m.user.id));
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Team</CardTitle>
          <CardDescription>{project.members?.length ?? 0} people can see and track time on this project</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2">
          {project.members?.map((m) => (
            <li key={m.id} className="flex items-center gap-2.5 text-[13px]">
              <Avatar name={m.user.full_name} size={26} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{m.user.full_name}</span>
                <span className="block truncate text-xs text-muted">
                  {m.user.id === project.manager ? "Project manager" : m.role || "Member"}
                  {m.bill_rate ? ` · ${formatMoney(m.bill_rate, project.currency)}/h` : ""}
                </span>
              </span>
              {project.can_manage && m.user.id !== project.manager && (
                <Button variant="ghost" size="icon-sm" aria-label={`Remove ${m.user.full_name}`} onClick={() => remove.mutate(m.user.id)}>
                  <UserMinus />
                </Button>
              )}
            </li>
          ))}
        </ul>
        {project.can_manage && (
          <div className="flex gap-2">
            <Select value={adding} onChange={(e) => setAdding(e.target.value)} className="h-8 text-xs" aria-label="Add member">
              <option value="">Add a team member…</option>
              {members.data?.filter((m) => !existing.has(m.user.id)).map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name}</option>)}
            </Select>
            <Button size="sm" variant="outline" disabled={!adding} loading={add.isPending} onClick={() => add.mutate(Number(adding))}>Add</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ Health */
export function HealthCard({ project }: { project: Project }) {
  if (!project.health) return null;
  const tone = { ok: "text-success", at_risk: "text-warning", critical: "text-danger" } as const;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">Health <StatusBadge kind="health" status={project.health.status} /></CardTitle>
          <CardDescription>Explainable signals from budget, schedule and overdue work</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2.5">
          {project.health.signals.map((s) => (
            <li key={s.key} className="flex gap-2.5 text-[13px]">
              <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", s.level === "ok" ? "bg-success" : s.level === "at_risk" ? "bg-warning" : "bg-danger")} aria-hidden />
              <span>
                <span className={cn("mr-1 text-xs font-semibold uppercase tracking-wide", tone[s.level])}>{s.key}</span>
                {s.reason}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ Budget */
function Meter({ label, used, budget, pct, currency, unit }: { label: string; used: string | undefined; budget: string | undefined; pct: string | null | undefined; currency?: string; unit?: string }) {
  const value = Number(pct ?? 0);
  const fmt = (v?: string) => (currency ? formatMoney(v ?? 0, currency) : `${Number(v ?? 0).toLocaleString()}${unit ?? ""}`);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="tabular text-muted">
          <span className="font-medium text-fg">{fmt(used)}</span> of {Number(budget ?? 0) ? fmt(budget) : "no budget set"}
        </span>
      </div>
      <div className="relative mt-2">
        <ProgressBar value={value} />
        {[75, 90].map((t) => (
          <span key={t} className="absolute top-[-3px] h-3 w-px bg-border-strong" style={{ left: `${t}%` }} title={`${t}% threshold`} />
        ))}
      </div>
      <p className={cn("mt-1 text-xs tabular", value >= 100 ? "text-danger" : value >= 75 ? "text-warning" : "text-muted")}>{pct ? `${Number(pct).toFixed(1)}% used` : "—"}</p>
    </div>
  );
}

export function BudgetPanel({ project }: { project: Project }) {
  const b = project.budget as Budget | undefined;
  if (!b) return null;
  const c = project.currency;
  const monthly = b.budget_period === "month";
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>Budget consumption {monthly && <span className="text-sm font-normal text-muted">· this month (retainer)</span>}</CardTitle>
            <CardDescription>Alerts are sent to the project manager at 75%, 90% and 100%.</CardDescription>
          </div>
          {b.alert_level ? <Badge tone={b.alert_level >= 100 ? "danger" : "warning"}>{b.alert_level}% threshold reached</Badge> : null}
        </CardHeader>
        <CardContent className="space-y-6">
          {b.fees_used !== undefined && <Meter label={monthly ? "Retainer fees used" : "Fees used (billable time + chargeable expenses)"} used={b.fees_used} budget={b.fees_budget} pct={b.fees_percent} currency={c} />}
          <Meter label={monthly ? "Retainer hours used" : "Hours tracked"} used={monthly ? b.hours_used : b.hours_tracked} budget={b.hours_budget} pct={b.hours_percent} unit="h" />
          {b.expense_cost !== undefined && <Meter label="Expenses vs estimate (internal cost)" used={b.expense_cost} budget={b.expenses_estimated} pct={b.expenses_percent} currency={c} />}
          {b.projected_fees_at_completion && (
            <p className="flex items-start gap-2 rounded-md bg-info-soft px-3 py-2 text-[13px] text-info">
              <Info className="mt-0.5 size-4 shrink-0" />
              At the current rate, fees are projected to reach {formatMoney(b.projected_fees_at_completion, c)} at completion (based on {project.progress?.percent}% task progress). This is an estimate.
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Estimated profitability</CardTitle>
            <CardDescription>Estimates — not accounting profit</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2.5 text-[13px]">
            {[
              [b.revenue_basis_label ?? "Revenue basis", b.revenue_basis],
              ["Labor cost (est., from cost rates)", b.labor_cost],
              ["Expenses (actual cost)", b.expense_cost],
              ["Total cost", b.total_cost],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-muted">{label}</dt>
                <dd className="tabular">{formatMoney(value ?? 0, c)}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-3 border-t border-border pt-2.5 font-semibold">
              <dt>Estimated margin</dt>
              <dd className={cn("tabular", Number(b.estimated_margin) < 0 && "text-danger")}>
                {formatMoney(b.estimated_margin ?? 0, c)} {b.estimated_margin_percent && <span className="text-xs font-normal text-muted">({percent(b.estimated_margin_percent, 1)})</span>}
              </dd>
            </div>
          </dl>
          <dl className="mt-5 space-y-2.5 border-t border-border pt-4 text-[13px]">
            {[
              ["Invoiced (issued, pre-tax)", b.invoiced],
              ...(b.collected !== undefined ? [["Collected (cash received, pro-rata)", b.collected]] : []),
              ["Approved, not yet invoiced", b.unbilled_approved_value],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-muted">{label}</dt>
                <dd className="tabular">{formatMoney(value ?? 0, c)}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Hours awaiting approval</dt>
              <dd className="tabular">{formatHours(b.hours_pending_approval)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ Milestones */
function MilestoneDialog({ project, milestone, open, onOpenChange }: { project: Project; milestone?: Milestone | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [v, setV] = React.useState({ name: "", description: "", due_date: "", amount: "", client_visible: true });
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) setV({ name: milestone?.name ?? "", description: milestone?.description ?? "", due_date: milestone?.due_date ?? "", amount: milestone && Number(milestone.amount) ? milestone.amount ?? "" : "", client_visible: milestone?.client_visible ?? true });
  }, [open, milestone]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title={milestone ? "Edit milestone" : "New milestone"} description="Milestones with a billable amount can be invoiced once completed (fixed-price billing)." />
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const payload = { project: project.id, ...v, due_date: v.due_date || null, amount: v.amount || "0" };
              if (milestone) await api.patch(`/milestones/${milestone.id}/`, payload);
              else await api.post("/milestones/", payload);
              for (const k of projectKeys(project.id)) queryClient.invalidateQueries({ queryKey: k });
              toast.success("Milestone saved");
              onOpenChange(false);
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="ms-name" required className="sm:col-span-2"><Input id="ms-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required autoFocus /></Field>
            <Field label="Due date" htmlFor="ms-due"><Input id="ms-due" type="date" value={v.due_date} onChange={(e) => setV({ ...v, due_date: e.target.value })} /></Field>
            {project.can_manage && (
              <Field label={`Billable amount (${project.currency})`} htmlFor="ms-amount" hint="Optional, for milestone billing">
                <Input id="ms-amount" type="number" min="0" step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} disabled={milestone?.is_invoiced} />
              </Field>
            )}
            <Field label="Description" htmlFor="ms-desc" className="sm:col-span-2"><Textarea id="ms-desc" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
            <label className="flex items-center gap-2 text-[13px] sm:col-span-2"><Checkbox checked={v.client_visible} onChange={(e) => setV({ ...v, client_visible: e.target.checked })} /> Show in client portal</label>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={busy}>Save milestone</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MilestonesTab({ project }: { project: Project }) {
  const query = useQuery({ queryKey: ["milestones", project.id], queryFn: () => api.get<Milestone[]>(`/milestones/?project=${project.id}`) });
  const [editing, setEditing] = React.useState<Milestone | null | undefined>(undefined);
  const [forceComplete, setForceComplete] = React.useState<Milestone | null>(null);
  const keys = projectKeys(project.id);
  const complete = useApiMutation((args: { id: number; force?: boolean }) => api.post(`/milestones/${args.id}/complete/`, { force: args.force }), {
    success: "Milestone completed",
    invalidate: keys,
    silentError: true,
    onSuccess: () => setForceComplete(null),
  });
  const reopen = useApiMutation((id: number) => api.post(`/milestones/${id}/reopen/`), { success: "Milestone reopened", invalidate: keys });
  const remove = useApiMutation((id: number) => api.delete(`/milestones/${id}/`), { success: "Milestone deleted", invalidate: keys });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Milestones</CardTitle>
          <CardDescription>Key checkpoints shared with the client when marked visible</CardDescription>
        </div>
        {project.can_manage && <Button size="sm" onClick={() => setEditing(null)}><Plus /> Milestone</Button>}
      </CardHeader>
      {query.isLoading ? (
        <LoadingRows rows={3} />
      ) : !query.data?.length ? (
        <EmptyState compact icon={Flag} title="No milestones yet" description="Break the project into phases with due dates." />
      ) : (
        <ol className="divide-y divide-border border-t border-border">
          {query.data.map((m) => {
            const overdue = m.status !== "completed" && m.due_date && (daysUntil(m.due_date) ?? 0) < 0;
            return (
              <li key={m.id} className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium">{m.name}</span>
                    <StatusBadge kind="milestone" status={m.status} />
                    {m.is_invoiced && <Badge tone="primary">Invoiced</Badge>}
                    {!m.client_visible && <Badge>Internal</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    <span className={cn(overdue && "font-medium text-danger")}>{m.due_date ? `Due ${formatDate(m.due_date)}` : "No due date"}{overdue ? " · overdue" : ""}</span>
                    {" · "}{m.task_done}/{m.task_count} tasks done
                    {Number(m.amount) > 0 && ` · ${formatMoney(m.amount, project.currency)}`}
                  </p>
                </div>
                <div className="flex w-full items-center gap-2 sm:w-56">
                  <ProgressBar value={m.task_count ? (m.task_done / m.task_count) * 100 : m.status === "completed" ? 100 : 0} tone={m.status === "completed" ? "success" : "primary"} />
                  {project.can_manage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Milestone actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {m.status !== "completed" ? (
                          <DropdownMenuItem
                            onSelect={() =>
                              complete.mutate({ id: m.id }, {
                                onError: (err) => (err instanceof ApiError && err.code === "open_tasks" ? setForceComplete(m) : toast.error(errorMessage(err))),
                              })
                            }
                          >
                            <CheckCircle2 /> Mark completed
                          </DropdownMenuItem>
                        ) : (
                          !m.is_invoiced && <DropdownMenuItem onSelect={() => reopen.mutate(m.id)}><RotateCcw /> Reopen</DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => setEditing(m)}><Pencil /> Edit</DropdownMenuItem>
                        {!m.is_invoiced && <DropdownMenuItem destructive onSelect={() => remove.mutate(m.id)}><Trash2 /> Delete</DropdownMenuItem>}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <MilestoneDialog project={project} milestone={editing ?? null} open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)} />
      <ConfirmDialog
        open={Boolean(forceComplete)}
        onOpenChange={(o) => !o && setForceComplete(null)}
        title="Complete milestone with open tasks?"
        description="Some tasks in this milestone are still open. Completing it anyway will be recorded in the activity log."
        confirmLabel="Complete anyway"
        tone="primary"
        loading={complete.isPending}
        onConfirm={() => forceComplete && complete.mutate({ id: forceComplete.id, force: true })}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ Deliverables */
function DeliverableDialog({ project, deliverable, open, onOpenChange }: { project: Project; deliverable?: Deliverable | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const milestones = useQuery({ queryKey: ["milestones", project.id], queryFn: () => api.get<Milestone[]>(`/milestones/?project=${project.id}`), enabled: open });
  const [v, setV] = React.useState({ title: "", description: "", due_date: "", milestone: "" });
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) setV({ title: deliverable?.title ?? "", description: deliverable?.description ?? "", due_date: deliverable?.due_date ?? "", milestone: deliverable?.milestone ? String(deliverable.milestone) : "" });
  }, [open, deliverable]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title={deliverable ? "Edit deliverable" : "New deliverable"} description="Attach the files to review, then submit it to the client for approval." />
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const payload = { project: project.id, title: v.title, description: v.description, due_date: v.due_date || null, milestone: v.milestone ? Number(v.milestone) : null };
              if (deliverable) await api.patch(`/deliverables/${deliverable.id}/`, payload);
              else await api.post("/deliverables/", payload);
              queryClient.invalidateQueries({ queryKey: ["deliverables", project.id] });
              toast.success("Deliverable saved");
              onOpenChange(false);
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Title" htmlFor="dl-title" required className="sm:col-span-2"><Input id="dl-title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} required autoFocus /></Field>
              <Field label="Milestone" htmlFor="dl-ms">
                <Select id="dl-ms" value={v.milestone} onChange={(e) => setV({ ...v, milestone: e.target.value })}>
                  <option value="">None</option>
                  {milestones.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              </Field>
              <Field label="Review due" htmlFor="dl-due"><Input id="dl-due" type="date" value={v.due_date} onChange={(e) => setV({ ...v, due_date: e.target.value })} /></Field>
              <Field label="Notes for the client" htmlFor="dl-desc" className="sm:col-span-2"><Textarea id="dl-desc" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
            </div>
            {deliverable && (
              <div>
                <p className="mb-2 text-[13px] font-medium">Files</p>
                <AttachmentsPanel target={`deliverable:${deliverable.id}`} allowClientShare={project.can_manage} canManage={project.can_manage} />
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            <Button type="submit" loading={busy}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeliverablesTab({ project }: { project: Project }) {
  const query = useQuery({ queryKey: ["deliverables", project.id], queryFn: () => api.get<Deliverable[]>(`/deliverables/?project=${project.id}`) });
  const [editing, setEditing] = React.useState<Deliverable | null | undefined>(undefined);
  const [discuss, setDiscuss] = React.useState<Deliverable | null>(null);
  const keys = [["deliverables", project.id], ["dashboard"]];
  const submit = useApiMutation((id: number) => api.post(`/deliverables/${id}/submit/`), { success: "Sent to the client for approval", invalidate: keys });
  const withdraw = useApiMutation((id: number) => api.post(`/deliverables/${id}/withdraw/`), { success: "Withdrawn", invalidate: keys });
  const remove = useApiMutation((id: number) => api.delete(`/deliverables/${id}/`), { success: "Deliverable deleted", invalidate: keys });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Deliverables</CardTitle>
          <CardDescription>Client approval workflow — the client approves or requests revisions in their portal</CardDescription>
        </div>
        <Button size="sm" onClick={() => setEditing(null)}><Plus /> Deliverable</Button>
      </CardHeader>
      {query.isLoading ? (
        <LoadingRows rows={3} />
      ) : !query.data?.length ? (
        <EmptyState compact icon={ClipboardCheck} title="No deliverables yet" description="Create a deliverable, attach files and submit it for client approval." />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {query.data.map((d) => (
            <li key={d.id} className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">{d.title}</span>
                  <StatusBadge kind="deliverable" status={d.status} />
                  {d.revision > 1 && <Badge>Revision {d.revision}</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {d.milestone_name ? `${d.milestone_name} · ` : ""}
                  {d.submitted_at ? `Submitted ${relativeTime(d.submitted_at)}` : "Not submitted"}
                  {d.due_date ? ` · review due ${formatDateShort(d.due_date)}` : ""}
                </p>
                {d.decision_comment && (
                  <p className={cn("mt-1.5 rounded-md px-2.5 py-1.5 text-xs", d.status === "changes_requested" ? "bg-danger-soft text-danger" : "bg-success-soft text-success")}>
                    {d.decided_by_detail?.full_name}: “{d.decision_comment}”
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {(d.status === "draft" || d.status === "changes_requested") && (
                  <Button size="sm" variant="outline" loading={submit.isPending && submit.variables === d.id} onClick={() => submit.mutate(d.id)} disabled={!project.client_visible}>
                    <Send /> {d.status === "changes_requested" ? "Resubmit" : "Submit for approval"}
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Deliverable actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent>
                    {d.status !== "approved" && <DropdownMenuItem onSelect={() => setEditing(d)}><Pencil /> Edit & files</DropdownMenuItem>}
                    <DropdownMenuItem onSelect={() => setDiscuss(d)}><Send /> Discussion</DropdownMenuItem>
                    {d.status === "pending_approval" && <DropdownMenuItem onSelect={() => withdraw.mutate(d.id)}><Undo2 /> Withdraw</DropdownMenuItem>}
                    {d.status === "draft" && <DropdownMenuItem destructive onSelect={() => remove.mutate(d.id)}><Trash2 /> Delete</DropdownMenuItem>}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!project.client_visible && <p className="border-t border-border px-5 py-3 text-xs text-warning">This project is hidden from the client portal. Share it in project settings to request approvals.</p>}
      <DeliverableDialog project={project} deliverable={editing ?? null} open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)} />
      <Dialog open={Boolean(discuss)} onOpenChange={(o) => !o && setDiscuss(null)}>
        <DialogContent size="lg">
          <DialogHeader title={discuss?.title ?? ""} description="Comments marked visible are shared with the client." />
          <DialogBody>{discuss && <CommentsThread target={`deliverable:${discuss.id}`} allowClientShare={project.can_manage} />}</DialogBody>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/* ------------------------------------------------------------------ Change requests */
function ChangeRequestDialog({ project, open, onOpenChange, cr }: { project: Project; open: boolean; onOpenChange: (o: boolean) => void; cr?: ChangeRequest | null }) {
  const queryClient = useQueryClient();
  const [v, setV] = React.useState({ title: "", description: "", estimated_hours: "", estimated_cost: "", revised_deadline: "" });
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) setV({ title: cr?.title ?? "", description: cr?.description ?? "", estimated_hours: cr?.estimated_hours ?? "", estimated_cost: cr?.estimated_cost ?? "", revised_deadline: cr?.revised_deadline ?? "" });
  }, [open, cr]);
  const suggested = project.hourly_rate && v.estimated_hours ? (Number(v.estimated_hours) * Number(project.hourly_rate)).toFixed(2) : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title={cr ? "Edit change request" : "New change request"} description="Out-of-scope work the client must approve before the project scope and budget change." />
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const payload = { project: project.id, ...v, estimated_hours: v.estimated_hours || "0", estimated_cost: v.estimated_cost || "0", revised_deadline: v.revised_deadline || null };
              if (cr) await api.patch(`/change-requests/${cr.id}/`, payload);
              else await api.post("/change-requests/", payload);
              queryClient.invalidateQueries({ queryKey: ["change-requests", project.id] });
              toast.success("Change request saved as draft");
              onOpenChange(false);
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogBody className="grid gap-4 sm:grid-cols-3">
            <Field label="Title" htmlFor="cr-title" required className="sm:col-span-3"><Input id="cr-title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} required autoFocus /></Field>
            <Field label="Requested change" htmlFor="cr-desc" required className="sm:col-span-3"><Textarea id="cr-desc" rows={4} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} required /></Field>
            <Field label="Additional hours" htmlFor="cr-hours"><Input id="cr-hours" type="number" step="0.5" min="0" value={v.estimated_hours} onChange={(e) => setV({ ...v, estimated_hours: e.target.value })} /></Field>
            <Field label={`Additional cost (${project.currency})`} htmlFor="cr-cost" hint={suggested ? <button type="button" className="text-primary hover:underline" onClick={() => setV({ ...v, estimated_cost: suggested })}>Use {formatMoney(suggested, project.currency)} (hours × rate)</button> : undefined}>
              <Input id="cr-cost" type="number" step="0.01" min="0" value={v.estimated_cost} onChange={(e) => setV({ ...v, estimated_cost: e.target.value })} />
            </Field>
            <Field label="Revised deadline" htmlFor="cr-deadline"><Input id="cr-deadline" type="date" value={v.revised_deadline} onChange={(e) => setV({ ...v, revised_deadline: e.target.value })} /></Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={busy}>Save draft</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ChangeRequestsTab({ project }: { project: Project }) {
  const query = useQuery({ queryKey: ["change-requests", project.id], queryFn: () => api.get<{ results: ChangeRequest[] }>(`/change-requests/?project=${project.id}&page_size=100`) });
  const [editing, setEditing] = React.useState<ChangeRequest | null | undefined>(undefined);
  const [applying, setApplying] = React.useState<ChangeRequest | null>(null);
  const [recording, setRecording] = React.useState<ChangeRequest | null>(null);
  const [decision, setDecision] = React.useState({ decision: "approved", comment: "" });
  const keys = projectKeys(project.id);
  const send = useApiMutation((id: number) => api.post(`/change-requests/${id}/send/`), { success: "Sent to the client", invalidate: keys });
  const withdraw = useApiMutation((id: number) => api.post(`/change-requests/${id}/withdraw/`), { success: "Withdrawn to draft", invalidate: keys });
  const remove = useApiMutation((id: number) => api.delete(`/change-requests/${id}/`), { success: "Deleted", invalidate: keys });
  const apply = useApiMutation((id: number) => api.post(`/change-requests/${id}/apply/`), { success: "Project scope and budget updated", invalidate: keys, onSuccess: () => setApplying(null) });
  const record = useApiMutation((args: { id: number; decision: string; comment: string }) => api.post(`/change-requests/${args.id}/record-decision/`, args), {
    success: "Decision recorded",
    invalidate: keys,
    onSuccess: () => setRecording(null),
  });
  const items = query.data?.results ?? [];
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Change requests</CardTitle>
          <CardDescription>Scope changes approved by the client, then explicitly applied to the budget</CardDescription>
        </div>
        <Button size="sm" onClick={() => setEditing(null)}><Plus /> Change request</Button>
      </CardHeader>
      {query.isLoading ? (
        <LoadingRows rows={3} />
      ) : !items.length ? (
        <EmptyState compact icon={Wand2} title="No change requests" description="When the client asks for something outside the agreed scope, capture it here for approval." />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {items.map((cr) => (
            <li key={cr.id} className="px-5 py-3.5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium">{cr.title}</span>
                    <StatusBadge kind="change" status={cr.status} />
                  </div>
                  <p className="mt-1 text-[13px] text-muted">{cr.description}</p>
                  <p className="mt-1.5 text-xs text-muted tabular">
                    +{formatHours(cr.estimated_hours)} · +{formatMoney(cr.estimated_cost, cr.currency)}
                    {cr.revised_deadline ? ` · new deadline ${formatDate(cr.revised_deadline)}` : ""}
                    {cr.decided_by_detail ? ` · decided by ${cr.decided_by_detail.full_name}` : ""}
                  </p>
                  {cr.decision_comment && <p className="mt-1 text-xs italic text-muted">“{cr.decision_comment}”</p>}
                  {cr.status === "applied" && cr.applied_snapshot?.before && (
                    <p className="mt-1 text-xs text-primary">
                      Applied {cr.applied_at ? relativeTime(cr.applied_at) : ""}: hours {cr.applied_snapshot.before.budget_hours} → {cr.applied_snapshot.after?.budget_hours}
                      {project.can_manage && `, budget ${cr.applied_snapshot.before.budget_amount} → ${cr.applied_snapshot.after?.budget_amount}`}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {cr.status === "draft" && project.can_manage && <Button size="sm" variant="outline" onClick={() => send.mutate(cr.id)} disabled={!project.client_visible}><Send /> Send to client</Button>}
                  {cr.status === "approved" && project.can_manage && <Button size="sm" onClick={() => setApplying(cr)}><CheckCircle2 /> Apply to project</Button>}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Change request actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent>
                      {cr.status === "draft" && <DropdownMenuItem onSelect={() => setEditing(cr)}><Pencil /> Edit</DropdownMenuItem>}
                      {cr.status === "pending_client" && project.can_manage && <DropdownMenuItem onSelect={() => withdraw.mutate(cr.id)}><Undo2 /> Withdraw</DropdownMenuItem>}
                      {["draft", "pending_client"].includes(cr.status) && project.can_manage && (
                        <DropdownMenuItem onSelect={() => { setDecision({ decision: "approved", comment: "" }); setRecording(cr); }}><ClipboardCheck /> Record client decision…</DropdownMenuItem>
                      )}
                      {cr.status === "draft" && <DropdownMenuItem destructive onSelect={() => remove.mutate(cr.id)}><Trash2 /> Delete</DropdownMenuItem>}
                      {!["draft", "pending_client"].includes(cr.status) && cr.status !== "approved" && <DropdownMenuItem disabled>No further actions</DropdownMenuItem>}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ChangeRequestDialog project={project} cr={editing ?? null} open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)} />
      <ConfirmDialog
        open={Boolean(applying)}
        onOpenChange={(o) => !o && setApplying(null)}
        title="Apply change request to the project?"
        tone="primary"
        confirmLabel="Apply changes"
        loading={apply.isPending}
        onConfirm={() => applying && apply.mutate(applying.id)}
        description={
          applying ? (
            <>
              This adds <strong>{formatHours(applying.estimated_hours)}</strong> to the hour budget and <strong>{formatMoney(applying.estimated_cost, applying.currency)}</strong> to the fee budget
              {applying.revised_deadline ? <> and moves the deadline to <strong>{formatDate(applying.revised_deadline)}</strong></> : null}. The before/after values are recorded in the audit log.
            </>
          ) : null
        }
      />
      <Dialog open={Boolean(recording)} onOpenChange={(o) => !o && setRecording(null)}>
        <DialogContent size="sm">
          <DialogHeader title="Record the client's decision" description="Use this when the client decided outside the portal, e.g. by email. The note is kept in the audit log." />
          <DialogBody className="space-y-3">
            <Field label="Decision" htmlFor="rd-decision">
              <Select id="rd-decision" value={decision.decision} onChange={(e) => setDecision({ ...decision, decision: e.target.value })}>
                <option value="approved">Approved by client</option>
                <option value="rejected">Rejected by client</option>
              </Select>
            </Field>
            <Field label="How was it communicated?" htmlFor="rd-comment">
              <Textarea id="rd-comment" value={decision.comment} onChange={(e) => setDecision({ ...decision, comment: e.target.value })} placeholder="e.g. Approved by Jordan in email on 12 Oct" />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecording(null)}>Cancel</Button>
            <Button disabled={!decision.comment.trim()} loading={record.isPending} onClick={() => recording && record.mutate({ id: recording.id, ...decision })}>Record decision</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function ProjectFacts({ project }: { project: Project }) {
  const typeLabel = { fixed: "Fixed price", hourly: "Time & materials", retainer: "Retainer (monthly)" }[project.project_type];
  return (
    <DefinitionList
      items={[
        { label: "Client", value: project.client_name },
        { label: "Billing model", value: typeLabel },
        { label: "Start date", value: project.start_date ? formatDate(project.start_date) : null },
        { label: "Deadline", value: project.deadline ? formatDate(project.deadline) : null },
        ...(project.can_manage
          ? [
              { label: project.project_type === "retainer" ? "Monthly fee" : "Fee budget", value: <Money amount={project.project_type === "retainer" ? project.retainer_amount : project.budget_amount} currency={project.currency} /> },
              { label: "Hourly rate", value: project.hourly_rate ? <Money amount={project.hourly_rate} currency={project.currency} /> : "Workspace default" },
            ]
          : []),
        { label: project.project_type === "retainer" ? "Hours / month" : "Budgeted hours", value: formatHours(project.project_type === "retainer" ? project.retainer_hours : project.budget_hours) },
        { label: "Client portal", value: project.client_visible ? <Tooltip content="The client sees progress, shared milestones, deliverables and files."><span>Shared</span></Tooltip> : "Hidden" },
      ]}
    />
  );
}
