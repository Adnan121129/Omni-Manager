import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Pencil, Play, RotateCcw, Send, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Tooltip } from "@/components/ui/overlays";
import { Avatar, Badge, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { useProjectTasks } from "@/components/layout/TimerWidget";
import { useApiMutation, useProjectOptions } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { useTimer } from "@/hooks/timer";
import { api, ApiError, errorMessage } from "@/lib/api";
import { formatDate, formatDuration, formatMoney, formatTime, isoDate } from "@/lib/format";
import type { TimeEntry } from "@/lib/types";
import { cn, uid } from "@/lib/utils";

export const TIME_KEYS = [["time-entries"], ["timesheet"], ["tasks"], ["task"], ["dashboard"], ["project"], ["approvals"]];

/** "1:30", "1.5", "90m", "1h 30m" → seconds. */
export function parseDurationInput(value: string): number | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  let m = v.match(/^(\d+):(\d{1,2})$/);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60;
  m = v.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m)?$/);
  if (m && (m[1] || m[2])) return Math.round(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60);
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 3600);
  return null;
}

export function durationInputValue(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

export function TimeEntryDialog({ open, onOpenChange, entry, defaults }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  entry?: TimeEntry | null;
  defaults?: { project?: number; task?: number | null; date?: string };
}) {
  const queryClient = useQueryClient();
  const projects = useProjectOptions({ enabled: open });
  const [project, setProject] = React.useState<number | "">("");
  const [task, setTask] = React.useState<number | "">("");
  const [date, setDate] = React.useState(isoDate(new Date()));
  const [duration, setDuration] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [billable, setBillable] = React.useState(true);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [busy, setBusy] = React.useState(false);
  const requestId = React.useRef(uid());
  const tasks = useProjectTasks(project || null);

  React.useEffect(() => {
    if (!open) return;
    requestId.current = uid();
    setErrors({});
    setProject(entry?.project ?? defaults?.project ?? "");
    setTask(entry?.task ?? defaults?.task ?? "");
    setDate(entry?.date ?? defaults?.date ?? isoDate(new Date()));
    setDuration(entry ? durationInputValue(entry.duration_seconds) : "");
    setDescription(entry?.description ?? "");
    setBillable(entry?.billable ?? true);
  }, [open, entry, defaults?.project, defaults?.task, defaults?.date]);

  const seconds = parseDurationInput(duration);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!seconds) return setErrors({ duration_seconds: ["Enter a duration like 1:30, 1.5 or 90m."] });
    setBusy(true);
    setErrors({});
    const payload = { project, task: task || null, date, duration_seconds: seconds, description, billable };
    try {
      if (entry) await api.patch(`/time-entries/${entry.id}/`, payload);
      else await api.post("/time-entries/", { ...payload, client_request_id: requestId.current });
      for (const key of TIME_KEYS) queryClient.invalidateQueries({ queryKey: key });
      toast.success(entry ? "Time entry updated" : "Time logged");
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title={entry ? "Edit time entry" : "Log time"} description="Manual entries are saved as drafts until you submit them for approval." />
        <form onSubmit={submit} className="contents">
          <DialogBody className="grid gap-4 sm:grid-cols-2">
            {entry?.status === "rejected" && entry.rejection_reason && (
              <div className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger sm:col-span-2">
                Rejected: {entry.rejection_reason}
              </div>
            )}
            <Field label="Project" htmlFor="te-project" required className="sm:col-span-2" error={errors.project?.[0]}>
              <Select id="te-project" value={project} onChange={(e) => { setProject(e.target.value ? Number(e.target.value) : ""); setTask(""); }} required>
                <option value="">Select a project…</option>
                {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
              </Select>
            </Field>
            <Field label="Task" htmlFor="te-task" className="sm:col-span-2" error={errors.task?.[0]}>
              <Select
                id="te-task"
                value={task}
                disabled={!project}
                onChange={(e) => {
                  const id = e.target.value ? Number(e.target.value) : "";
                  setTask(id);
                  const t = tasks.data?.find((x) => x.id === id);
                  if (t) setBillable(t.billable);
                }}
              >
                <option value="">No specific task</option>
                {tasks.data?.map((t) => <option key={t.id} value={t.id}>{t.key} · {t.title}</option>)}
                {entry?.task_detail && !tasks.data?.some((t) => t.id === entry.task) && <option value={entry.task!}>{entry.task_detail.key} · {entry.task_detail.title}</option>}
              </Select>
            </Field>
            <Field label="Date" htmlFor="te-date" required error={errors.date?.[0] ?? errors.non_field_errors?.[0]}>
              <Input id="te-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required max={isoDate(new Date(Date.now() + 86400000))} />
            </Field>
            <Field label="Duration" htmlFor="te-duration" required error={errors.duration_seconds?.[0]} hint={seconds ? `= ${formatDuration(seconds)}` : "e.g. 1:30, 1.5 or 90m"}>
              <Input id="te-duration" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="1:30" required inputMode="decimal" />
            </Field>
            <Field label="Description" htmlFor="te-desc" className="sm:col-span-2">
              <Textarea id="te-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What did you work on?" />
            </Field>
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable to client
            </label>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={busy}>{entry ? "Save changes" : "Log time"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EntryStatus({ entry }: { entry: TimeEntry }) {
  if (entry.timer_state !== "stopped") return <StatusBadge kind="entry" status="running" />;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Tooltip content={entry.status === "rejected" ? `Rejected: ${entry.rejection_reason}` : entry.approved_by_name ? `Approved by ${entry.approved_by_name}` : undefined}>
        <span><StatusBadge kind="entry" status={entry.status} /></span>
      </Tooltip>
      {entry.is_invoiced && <Badge tone="primary">Invoiced</Badge>}
    </span>
  );
}

export function TimeEntryTable({ entries, showUser = false, selectable = false, selected, onSelect, onEdit, compact }: {
  entries: TimeEntry[];
  showUser?: boolean;
  selectable?: boolean;
  selected?: Set<number>;
  onSelect?: (ids: Set<number>) => void;
  onEdit?: (e: TimeEntry) => void;
  compact?: boolean;
}) {
  const { user, permissions } = useAuth();
  const timer = useTimer();
  const [deleting, setDeleting] = React.useState<TimeEntry | null>(null);
  const [reopening, setReopening] = React.useState<TimeEntry | null>(null);
  const [reason, setReason] = React.useState("");
  const remove = useApiMutation((id: number) => api.delete(`/time-entries/${id}/`), { success: "Entry deleted", invalidate: TIME_KEYS, onSuccess: () => setDeleting(null) });
  const submit = useApiMutation((ids: number[]) => api.post("/time-entries/submit/", { ids }), { success: "Submitted for approval", invalidate: TIME_KEYS });
  const reopen = useApiMutation((args: { id: number; reason: string }) => api.post(`/time-entries/${args.id}/reopen/`, { reason: args.reason }), {
    success: "Entry reopened for correction",
    invalidate: TIME_KEYS,
    onSuccess: () => { setReopening(null); setReason(""); },
  });
  const allSelectable = entries.filter((e) => e.status === "submitted");
  const allChecked = selectable && allSelectable.length > 0 && allSelectable.every((e) => selected?.has(e.id));
  return (
    <>
      <Table>
        <THead>
          <tr>
            {selectable && (
              <TH className="w-8">
                <Checkbox
                  aria-label="Select all"
                  checked={allChecked}
                  onChange={(ev) => onSelect?.(new Set(ev.target.checked ? allSelectable.map((e) => e.id) : []))}
                />
              </TH>
            )}
            <TH className="w-28">Date</TH>
            {showUser && <TH>Person</TH>}
            <TH>Work</TH>
            <TH className="hidden md:table-cell">Status</TH>
            <TH className="text-right">Duration</TH>
            {!compact && <TH className="hidden text-right lg:table-cell">Amount</TH>}
            <TH className="w-10" />
          </tr>
        </THead>
        <TBody>
          {entries.map((e) => {
            const own = e.user.id === user.id;
            return (
              <TR key={e.id} data-selected={selected?.has(e.id)}>
                {selectable && (
                  <TD>
                    {e.status === "submitted" && (
                      <Checkbox
                        aria-label={`Select entry ${e.id}`}
                        checked={selected?.has(e.id) ?? false}
                        onChange={(ev) => {
                          const next = new Set(selected);
                          if (ev.target.checked) next.add(e.id);
                          else next.delete(e.id);
                          onSelect?.(next);
                        }}
                      />
                    )}
                  </TD>
                )}
                <TD className="text-[13px]">
                  <span className="block">{formatDate(e.date, { weekday: "short", month: "short", day: "numeric" })}</span>
                  {e.started_at && <span className="text-xs text-muted">{formatTime(e.started_at)}{e.ended_at ? `–${formatTime(e.ended_at)}` : ""}</span>}
                </TD>
                {showUser && (
                  <TD>
                    <span className="inline-flex items-center gap-2 text-[13px]"><Avatar name={e.user.full_name} size={22} />{e.user.full_name}</span>
                  </TD>
                )}
                <TD>
                  <div className="flex items-center gap-2">
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: e.project_detail.color }} />
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium">
                        {e.task_detail ? e.task_detail.title : e.project_detail.name}
                        {!e.billable && <span className="ml-2 text-xs font-normal text-muted">Non-billable</span>}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {e.project_detail.code} · {e.project_detail.client_name}
                        {e.description ? ` · ${e.description}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="mt-1 md:hidden"><EntryStatus entry={e} /></div>
                </TD>
                <TD className="hidden md:table-cell"><EntryStatus entry={e} /></TD>
                <TD className="text-right font-medium tabular">{formatDuration(e.timer_state === "stopped" ? e.duration_seconds : e.elapsed_seconds)}</TD>
                {!compact && <TD className="hidden text-right text-[13px] tabular text-muted lg:table-cell">{e.amount !== null && e.billable ? formatMoney(e.amount, e.project_detail.currency) : "—"}</TD>}
                <TD>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="Entry actions"><MoreHorizontal /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      {own && e.can_edit && onEdit && <DropdownMenuItem onSelect={() => onEdit(e)}><Pencil /> Edit</DropdownMenuItem>}
                      {own && e.can_edit && <DropdownMenuItem onSelect={() => submit.mutate([e.id])}><Send /> Submit for approval</DropdownMenuItem>}
                      {own && (
                        <DropdownMenuItem
                          disabled={timer.busy || Boolean(timer.entry)}
                          onSelect={() => timer.start({ project: e.project, task: e.task, description: e.description, billable: e.billable })}
                        >
                          <Play /> Start timer with same work
                        </DropdownMenuItem>
                      )}
                      {permissions.approve_time && e.status === "approved" && !e.is_invoiced && (
                        <DropdownMenuItem onSelect={() => setReopening(e)}><RotateCcw /> Reopen for correction</DropdownMenuItem>
                      )}
                      {own && e.can_edit && <DropdownMenuItem destructive onSelect={() => setDeleting(e)}><Trash2 /> Delete</DropdownMenuItem>}
                      {!(own && e.can_edit) && !(permissions.approve_time && e.status === "approved") && !own && (
                        <DropdownMenuItem disabled>No actions available</DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this time entry?"
        description={deleting ? `${formatDuration(deleting.duration_seconds)} on ${deleting.project_detail.code} will be permanently removed.` : ""}
        confirmLabel="Delete entry"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
      <ConfirmDialog
        open={Boolean(reopening)}
        onOpenChange={(o) => !o && setReopening(null)}
        title="Reopen approved time?"
        description="The entry returns to draft so its owner can correct and resubmit it. Your reason is recorded in the audit log."
        confirmLabel="Reopen entry"
        tone="primary"
        loading={reopen.isPending}
        onConfirm={() => reopening && reason.trim() && reopen.mutate({ id: reopening.id, reason })}
      >
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for correction (required)" aria-label="Reason" className={cn(!reason.trim() && "border-warning")} />
      </ConfirmDialog>
    </>
  );
}
