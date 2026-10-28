import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Play, Plus, Trash2, X } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";

import { ActivityFeed, AttachmentsPanel, CommentsThread } from "@/components/common/collab";
import { ErrorState, LoadingRows } from "@/components/common/layout-bits";
import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, SheetContent, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { Badge } from "@/components/ui/primitives";
import { useAssigneeOptions, useLabels, useProjectOptions } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { useTimer } from "@/hooks/timer";
import { api, ApiError, errorMessage, type Paginated } from "@/lib/api";
import { formatDate, formatDuration } from "@/lib/format";
import type { Milestone, Priority, Task, TaskStatus, TimeEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

import { TASK_COLUMNS, useTaskUpdater } from "./taskApi";

const STATUS_OPTIONS = [...TASK_COLUMNS, { status: "cancelled" as TaskStatus, label: "Cancelled" }];
const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];

function useProjectMilestones(projectId?: number) {
  return useQuery({
    queryKey: ["milestones", projectId],
    queryFn: () => api.get<Milestone[]>(`/milestones/?project=${projectId}`),
    enabled: Boolean(projectId),
  });
}

function TaskDetail({ taskId, onClose }: { taskId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { permissions } = useAuth();
  const timer = useTimer();
  const update = useTaskUpdater();
  const query = useQuery({ queryKey: ["task", taskId], queryFn: () => api.get<Task>(`/tasks/${taskId}/`) });
  const labels = useLabels();
  const task = query.data;
  const assignees = useAssigneeOptions(task?.project);
  const milestones = useProjectMilestones(task?.project);
  const projectTasks = useQuery({
    queryKey: ["task-options", task?.project, "all"],
    queryFn: () => api.get<Paginated<Task>>(`/tasks/?project=${task!.project}&page_size=200`).then((r) => r.results),
    enabled: Boolean(task?.project),
  });
  const entries = useQuery({
    queryKey: ["time-entries", "task", taskId],
    queryFn: () => api.get<Paginated<TimeEntry>>(`/time-entries/?task=${taskId}&scope=${permissions.is_manager ? "team" : "mine"}&page_size=50`),
  });
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [subtask, setSubtask] = React.useState("");
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  React.useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description);
    }
  }, [task?.id, task?.title, task?.description]); // eslint-disable-line react-hooks/exhaustive-deps

  if (query.isLoading) return <LoadingRows rows={8} />;
  if (query.isError || !task) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  const save = (changes: Record<string, unknown>) =>
    update(task, changes as Partial<Task>).then(() => queryClient.invalidateQueries({ queryKey: ["task", taskId] })).catch(() => undefined);
  const running = timer.entry?.task === task.id;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 pb-4 pt-5 pr-12">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="font-mono">{task.key}</span>
          <span>·</span>
          <Link to={`/projects/${task.project}`} className="hover:text-fg hover:underline">{task.project_name}</Link>
          <span>·</span>
          <span>{task.client_name}</span>
          {task.is_blocked && <Badge tone="warning"><Lock className="size-3" /> Blocked</Badge>}
        </div>
        <DialogPrimitive.Title asChild>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== task.title && save({ title: title.trim() })}
            className="mt-2 w-full rounded-md bg-transparent px-1 -mx-1 text-lg font-semibold tracking-tight outline-none focus:bg-subtle"
            aria-label="Task title"
          />
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="sr-only">Task details</DialogPrimitive.Description>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={running ? "secondary" : "primary"}
            disabled={running || timer.busy || ["done", "cancelled"].includes(task.status)}
            onClick={() => timer.start({ project: task.project, task: task.id, billable: task.billable })}
            data-testid="task-start-timer"
          >
            <Play /> {running ? "Timer running" : "Start timer"}
          </Button>
          {task.status !== "done" && (
            <Button size="sm" variant="outline" onClick={() => save({ status: "done" })}>
              Mark done
            </Button>
          )}
          <Button size="sm" variant="ghost" className="ml-auto text-muted" onClick={() => setConfirmDelete(true)} aria-label="Delete task">
            <Trash2 />
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="grid gap-x-4 gap-y-3 border-b border-border px-6 py-4 sm:grid-cols-2">
          <Field label="Status" htmlFor="t-status">
            <Select id="t-status" value={task.status} onChange={(e) => save({ status: e.target.value })}>
              {STATUS_OPTIONS.map((s) => <option key={s.status} value={s.status}>{s.label}</option>)}
            </Select>
          </Field>
          <Field label="Assignee" htmlFor="t-assignee">
            <Select id="t-assignee" value={task.assignee ?? ""} onChange={(e) => save({ assignee: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Unassigned</option>
              {assignees.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name}</option>)}
              {task.assignee_detail && !assignees.some((m) => m.user.id === task.assignee) && (
                <option value={task.assignee!}>{task.assignee_detail.full_name}</option>
              )}
            </Select>
          </Field>
          <Field label="Priority" htmlFor="t-priority">
            <Select id="t-priority" value={task.priority} onChange={(e) => save({ priority: e.target.value })}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
            </Select>
          </Field>
          <Field label="Milestone" htmlFor="t-milestone">
            <Select id="t-milestone" value={task.milestone ?? ""} onChange={(e) => save({ milestone: e.target.value ? Number(e.target.value) : null })}>
              <option value="">None</option>
              {milestones.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
          <Field label="Start date" htmlFor="t-start">
            <Input id="t-start" type="date" value={task.start_date ?? ""} onChange={(e) => save({ start_date: e.target.value || null })} />
          </Field>
          <Field label="Due date" htmlFor="t-due">
            <Input id="t-due" type="date" value={task.due_date ?? ""} onChange={(e) => save({ due_date: e.target.value || null })} />
          </Field>
          <Field label="Estimate (hours)" htmlFor="t-est">
            <Input
              id="t-est"
              type="number"
              step="0.25"
              min="0"
              defaultValue={task.estimated_hours ?? ""}
              key={`est-${task.estimated_hours}`}
              onBlur={(e) => {
                const v = e.target.value === "" ? null : e.target.value;
                if (v !== task.estimated_hours) save({ estimated_hours: v });
              }}
            />
          </Field>
          <Field label="Billing" htmlFor="t-billable">
            <div className="flex h-9 items-center gap-4">
              <label className="flex items-center gap-2 text-[13px]">
                <Checkbox id="t-billable" checked={task.billable} onChange={(e) => save({ billable: e.target.checked })} /> Billable
              </label>
              {"rate_override" in task && (
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Rate override"
                  aria-label="Rate override"
                  className="h-8"
                  defaultValue={task.rate_override ?? ""}
                  key={`rate-${task.rate_override}`}
                  onBlur={(e) => {
                    const v = e.target.value === "" ? null : e.target.value;
                    if (v !== (task.rate_override ?? null)) save({ rate_override: v });
                  }}
                />
              )}
            </div>
          </Field>
          <div className="sm:col-span-2">
            <p className="mb-1.5 text-[13px] font-medium">Labels</p>
            <div className="flex flex-wrap gap-1.5">
              {labels.data?.map((l) => {
                const on = task.labels.includes(l.id);
                return (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => save({ labels: on ? task.labels.filter((x) => x !== l.id) : [...task.labels, l.id] })}
                    className={cn("rounded-md border px-2 py-0.5 text-xs font-medium transition-colors", on ? "border-transparent" : "border-border text-muted hover:text-fg")}
                    style={on ? { backgroundColor: `${l.color}22`, color: l.color } : undefined}
                    aria-pressed={on}
                  >
                    {l.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <Tabs defaultValue="details" className="px-6 pt-2">
          <TabsList>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="time">Time · {formatDuration(task.tracked_seconds)}</TabsTrigger>
            <TabsTrigger value="comments">Comments</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="space-y-6 py-4">
            <Field label="Description" htmlFor="t-desc">
              <Textarea
                id="t-desc"
                rows={5}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => description !== task.description && save({ description })}
                placeholder="Add context, acceptance criteria or links…"
              />
            </Field>
            <Field label="Reference link" htmlFor="t-ref">
              <Input
                id="t-ref"
                type="url"
                placeholder="https://"
                defaultValue={task.reference_url}
                key={`ref-${task.reference_url}`}
                onBlur={(e) => e.target.value !== task.reference_url && save({ reference_url: e.target.value })}
              />
            </Field>
            {!task.parent && (
              <div>
                <p className="mb-2 text-[13px] font-medium">Subtasks</p>
                <ul className="space-y-1">
                  {task.subtasks?.map((s) => (
                    <li key={s.id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-subtle">
                      <Checkbox
                        checked={s.status === "done"}
                        aria-label={`Complete ${s.title}`}
                        onChange={async (e) => {
                          try {
                            await api.patch(`/tasks/${s.id}/`, { status: e.target.checked ? "done" : "todo" });
                            queryClient.invalidateQueries({ queryKey: ["task", taskId] });
                            queryClient.invalidateQueries({ queryKey: ["tasks"] });
                          } catch (err) {
                            toast.error(errorMessage(err));
                          }
                        }}
                      />
                      <span className={cn("flex-1 text-[13px]", s.status === "done" && "text-muted line-through")}>{s.title}</span>
                      <span className="text-xs text-muted">{s.assignee_detail?.full_name}</span>
                    </li>
                  ))}
                </ul>
                <form
                  className="mt-2 flex gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!subtask.trim()) return;
                    try {
                      await api.post("/tasks/", { project: task.project, parent: task.id, title: subtask.trim(), billable: task.billable });
                      setSubtask("");
                      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
                      queryClient.invalidateQueries({ queryKey: ["tasks"] });
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                >
                  <Input value={subtask} onChange={(e) => setSubtask(e.target.value)} placeholder="Add a subtask" className="h-8" aria-label="New subtask" />
                  <Button size="sm" variant="outline" type="submit"><Plus /> Add</Button>
                </form>
              </div>
            )}
            <div>
              <p className="mb-2 text-[13px] font-medium">Blocked by</p>
              {task.blocked_by.length ? (
                <ul className="space-y-1">
                  {task.blocked_by.map((b) => (
                    <li key={b.id} className="flex items-center gap-2 text-[13px]">
                      <StatusBadge kind="task" status={b.status} />
                      <span className="flex-1">{b.title}</span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove dependency on ${b.title}`}
                        onClick={async () => {
                          await api.delete(`/tasks/${task.id}/dependencies/${b.id}/`);
                          queryClient.invalidateQueries({ queryKey: ["task", taskId] });
                          queryClient.invalidateQueries({ queryKey: ["tasks"] });
                        }}
                      >
                        <X />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">No blocking tasks.</p>
              )}
              <Select
                className="mt-2 h-8 text-xs"
                value=""
                aria-label="Add blocking task"
                onChange={async (e) => {
                  if (!e.target.value) return;
                  try {
                    await api.post(`/tasks/${task.id}/dependencies/`, { blocked_by: Number(e.target.value) });
                    queryClient.invalidateQueries({ queryKey: ["task", taskId] });
                    queryClient.invalidateQueries({ queryKey: ["tasks"] });
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.message : errorMessage(err));
                  }
                }}
              >
                <option value="">+ Add a task this depends on…</option>
                {projectTasks.data
                  ?.filter((t) => t.id !== task.id && !task.blocked_by.some((b) => b.id === t.id))
                  .map((t) => <option key={t.id} value={t.id}>{t.key} · {t.title}</option>)}
              </Select>
              {task.blocking && task.blocking.length > 0 && (
                <p className="mt-2 text-xs text-muted">Blocking: {task.blocking.map((b) => b.title).join(", ")}</p>
              )}
            </div>
          </TabsContent>
          <TabsContent value="time" className="py-4">
            {entries.data?.results.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {entries.data.results.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                    <span className="w-24 text-muted">{formatDate(e.date, { month: "short", day: "numeric" })}</span>
                    <span className="flex-1 truncate">{e.user.full_name}{e.description ? ` · ${e.description}` : ""}</span>
                    <StatusBadge kind="entry" status={e.status} />
                    <span className="w-16 text-right tabular">{formatDuration(e.duration_seconds)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">No time tracked on this task yet.</p>
            )}
          </TabsContent>
          <TabsContent value="comments" className="py-4">
            <CommentsThread target={`task:${task.id}`} />
          </TabsContent>
          <TabsContent value="files" className="py-4">
            <AttachmentsPanel target={`task:${task.id}`} canManage={permissions.is_manager} />
          </TabsContent>
          <TabsContent value="activity" className="py-4">
            <ActivityFeed params={`target_type=task&target_id=${task.id}`} />
          </TabsContent>
        </Tabs>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this task?"
        description="The task and its subtasks will be removed. Tasks with tracked time cannot be deleted — cancel them instead."
        confirmLabel="Delete task"
        onConfirm={async () => {
          try {
            await api.delete(`/tasks/${task.id}/`);
            toast.success("Task deleted");
            queryClient.invalidateQueries({ queryKey: ["tasks"] });
            onClose();
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setConfirmDelete(false);
          }
        }}
      />
    </div>
  );
}

/** Opens whenever the URL contains ?task=<id>, from any page. */
export function TaskDrawer() {
  const [params, setParams] = useSearchParams();
  const id = Number(params.get("task")) || null;
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete("task");
    setParams(next);
  };
  return (
    <DialogPrimitive.Root open={Boolean(id)} onOpenChange={(o) => !o && close()}>
      <SheetContent>{id && <TaskDetail taskId={id} onClose={close} />}</SheetContent>
    </DialogPrimitive.Root>
  );
}

export function TaskCreateDialog({ open, onOpenChange, projectId, defaultStatus = "todo" }: { open: boolean; onOpenChange: (o: boolean) => void; projectId?: number; defaultStatus?: TaskStatus }) {
  const queryClient = useQueryClient();
  const projects = useProjectOptions({ enabled: open });
  const [form, setForm] = React.useState({ project: projectId ?? 0, title: "", assignee: "", priority: "medium", due_date: "", estimated_hours: "", billable: true, description: "" });
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [busy, setBusy] = React.useState(false);
  const assignees = useAssigneeOptions(form.project || null, open);
  React.useEffect(() => {
    if (open) {
      setForm((f) => ({ ...f, project: projectId ?? f.project, title: "", description: "", due_date: "", estimated_hours: "" }));
      setErrors({});
    }
  }, [open, projectId]);
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title="New task" description="Tasks can be tracked, assigned and billed against their project." />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErrors({});
            try {
              await api.post("/tasks/", {
                project: form.project, title: form.title, description: form.description, status: defaultStatus,
                assignee: form.assignee ? Number(form.assignee) : null, priority: form.priority, due_date: form.due_date || null,
                estimated_hours: form.estimated_hours || null, billable: form.billable,
              });
              toast.success("Task created");
              queryClient.invalidateQueries({ queryKey: ["tasks"] });
              queryClient.invalidateQueries({ queryKey: ["project"] });
              onOpenChange(false);
            } catch (err) {
              if (err instanceof ApiError) setErrors(err.fields);
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
          className="contents"
        >
          <DialogBody className="grid gap-4 sm:grid-cols-2">
            {!projectId && (
              <Field label="Project" htmlFor="nt-project" required className="sm:col-span-2" error={errors.project?.[0]}>
                <Select id="nt-project" value={form.project || ""} onChange={(e) => set("project", Number(e.target.value))} required>
                  <option value="">Select a project…</option>
                  {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Title" htmlFor="nt-title" required className="sm:col-span-2" error={errors.title?.[0]}>
              <Input id="nt-title" value={form.title} onChange={(e) => set("title", e.target.value)} required autoFocus />
            </Field>
            <Field label="Assignee" htmlFor="nt-assignee">
              <Select id="nt-assignee" value={form.assignee} onChange={(e) => set("assignee", e.target.value)}>
                <option value="">Unassigned</option>
                {assignees.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name}</option>)}
              </Select>
            </Field>
            <Field label="Priority" htmlFor="nt-priority">
              <Select id="nt-priority" value={form.priority} onChange={(e) => set("priority", e.target.value)}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
              </Select>
            </Field>
            <Field label="Due date" htmlFor="nt-due" error={errors.due_date?.[0]}>
              <Input id="nt-due" type="date" value={form.due_date} onChange={(e) => set("due_date", e.target.value)} />
            </Field>
            <Field label="Estimate (hours)" htmlFor="nt-est" error={errors.estimated_hours?.[0]}>
              <Input id="nt-est" type="number" min="0" step="0.25" value={form.estimated_hours} onChange={(e) => set("estimated_hours", e.target.value)} />
            </Field>
            <Field label="Description" htmlFor="nt-desc" className="sm:col-span-2">
              <Textarea id="nt-desc" value={form.description} onChange={(e) => set("description", e.target.value)} />
            </Field>
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox checked={form.billable} onChange={(e) => set("billable", e.target.checked)} /> Billable work
            </label>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={busy}>Create task</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
