import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Clock, Pause, Play, Plus, Send, Square, Timer } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router";

import { EmptyState, PageHeader, QueryState } from "@/components/common/layout-bits";
import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { ConfirmDialog, Segmented } from "@/components/ui/overlays";
import { Badge, Card, CardDescription, CardHeader, CardTitle, ProgressBar, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { TIME_KEYS, TimeEntryDialog, TimeEntryTable } from "@/features/time/TimeComponents";
import { useApiMutation, useProjectOptions } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { useTimer } from "@/hooks/timer";
import { api, type Paginated } from "@/lib/api";
import { formatClock, formatDate, formatDuration, isoDate } from "@/lib/format";
import type { TimeEntry } from "@/lib/types";
import { cn, toQuery } from "@/lib/utils";

type View = "day" | "week" | "month";

interface WeekSheet {
  user: { id: number; full_name: string };
  start: string;
  end: string;
  days: string[];
  rows: { project: { id: number; code: string; name: string; color: string; client_name: string }; task: { id: number; title: string } | null; days: Record<string, number>; total_seconds: number; statuses: string[] }[];
  day_totals: Record<string, number>;
  total_seconds: number;
  capacity_hours: string;
  status_counts: Record<string, number>;
  entries: TimeEntry[];
}

function parseISO(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day);
}

function shift(date: string, view: View, dir: number): string {
  const d = parseISO(date);
  if (view === "day") d.setDate(d.getDate() + dir);
  else if (view === "week") d.setDate(d.getDate() + dir * 7);
  else d.setMonth(d.getMonth() + dir, 1);
  return isoDate(d);
}

function monday(date: string) {
  const d = parseISO(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoDate(d);
}

function RunningTimerCard() {
  const timer = useTimer();
  const e = timer.entry;
  if (!e) return null;
  const running = e.timer_state === "running";
  return (
    <Card className={cn("mb-6 flex flex-col gap-4 p-4 sm:flex-row sm:items-center", running ? "border-primary/30" : "border-warning/30")}>
      <div className={cn("flex size-10 items-center justify-center rounded-full", running ? "bg-primary-soft text-primary" : "bg-warning-soft text-warning")}>
        <Timer className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted">{running ? "Timer running" : "Timer paused"} · {e.project_detail.client_name}</p>
        <p className="truncate text-sm font-semibold">{e.task_detail?.title ?? e.project_detail.name} <span className="font-normal text-muted">· {e.project_detail.code}</span></p>
        {e.description && <p className="truncate text-xs text-muted">{e.description}</p>}
      </div>
      <div className="font-mono text-2xl font-semibold tabular">{formatClock(timer.elapsed)}</div>
      <div className="flex gap-2">
        {running ? <Button variant="outline" onClick={timer.pause} loading={timer.busy}><Pause /> Pause</Button> : <Button variant="outline" onClick={timer.resume} loading={timer.busy}><Play /> Resume</Button>}
        <Button variant="danger" onClick={timer.stop} loading={timer.busy}><Square /> Stop</Button>
      </div>
    </Card>
  );
}

function WeekGrid({ sheet }: { sheet: WeekSheet }) {
  const today = isoDate(new Date());
  return (
    <Table>
      <THead>
        <tr>
          <TH className="min-w-[14rem]">Project / task</TH>
          {sheet.days.map((d) => (
            <TH key={d} className={cn("w-20 text-right", d === today && "text-primary")}>
              {formatDate(d, { weekday: "short" })}
              <span className="block text-[11px] font-normal">{formatDate(d, { month: "short", day: "numeric" })}</span>
            </TH>
          ))}
          <TH className="w-20 text-right">Total</TH>
        </tr>
      </THead>
      <TBody>
        {sheet.rows.map((r, i) => (
          <TR key={i}>
            <TD>
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full" style={{ backgroundColor: r.project.color }} />
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{r.task?.title ?? r.project.name}</p>
                  <p className="truncate text-xs text-muted">{r.project.code} · {r.project.client_name}</p>
                </div>
              </div>
            </TD>
            {sheet.days.map((d) => (
              <TD key={d} className={cn("text-right text-[13px] tabular", !r.days[d] && "text-muted/50", d === today && "bg-primary-soft/30")}>
                {r.days[d] ? formatDuration(r.days[d]) : "–"}
              </TD>
            ))}
            <TD className="text-right text-[13px] font-medium tabular">{formatDuration(r.total_seconds)}</TD>
          </TR>
        ))}
        <TR className="bg-surface-2 font-medium">
          <TD className="text-[13px]">Daily total</TD>
          {sheet.days.map((d) => <TD key={d} className="text-right text-[13px] tabular">{sheet.day_totals[d] ? formatDuration(sheet.day_totals[d]) : "–"}</TD>)}
          <TD className="text-right text-[13px] tabular">{formatDuration(sheet.total_seconds)}</TD>
        </TR>
      </TBody>
    </Table>
  );
}

export function TimePage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = (params.get("view") as View) || "week";
  const date = params.get("date") ?? isoDate(new Date());
  const project = params.get("project") ?? "";
  const status = params.get("status") ?? "";
  const projects = useProjectOptions({ includeClosed: true });
  const [editing, setEditing] = React.useState<TimeEntry | null | undefined>(undefined);
  const [confirmSubmit, setConfirmSubmit] = React.useState(false);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const weekStart = monday(date);
  const week = useQuery({
    queryKey: ["timesheet", "week", weekStart, user.id],
    queryFn: () => api.get<WeekSheet>(`/timesheets/week/?start=${weekStart}`),
    enabled: view === "week",
  });
  const range = view === "day" ? { from: date, to: date } : view === "month" ? (() => {
    const d = parseISO(date);
    return { from: isoDate(new Date(d.getFullYear(), d.getMonth(), 1)), to: isoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
  })() : { from: weekStart, to: shift(weekStart, "day", 6) };
  const qs = toQuery({ ...range, project, status, page_size: 200 });
  const list = useQuery({
    queryKey: ["time-entries", "mine", qs],
    queryFn: () => api.get<Paginated<TimeEntry> & { totals: { total_seconds: number; billable_seconds: number; by_status: Record<string, number> } }>(`/time-entries/${qs}`),
  });
  const entries = list.data?.results ?? [];
  const drafts = entries.filter((e) => e.can_edit);
  const submit = useApiMutation(() => api.post<{ submitted: number }>("/time-entries/submit/", { start: range.from, end: range.to }), {
    success: (r) => `${r.submitted} entr${r.submitted === 1 ? "y" : "ies"} submitted for approval`,
    invalidate: TIME_KEYS,
    onSuccess: () => setConfirmSubmit(false),
  });
  const title =
    view === "day" ? formatDate(date, { weekday: "long", month: "long", day: "numeric" })
      : view === "week" ? `Week of ${formatDate(weekStart, { month: "short", day: "numeric", year: "numeric" })}`
        : formatDate(range.from, { month: "long", year: "numeric" });
  const totals = list.data?.totals;
  const capacity = Number(week.data?.capacity_hours ?? 0);

  const grouped = React.useMemo(() => {
    const map = new Map<string, TimeEntry[]>();
    for (const e of entries) map.set(e.date, [...(map.get(e.date) ?? []), e]);
    return [...map.entries()];
  }, [entries]);

  return (
    <>
      <PageHeader
        title="Time tracking"
        description="Track time with the timer or log it manually. Submit drafts for approval when you're done."
        actions={
          <>
            <Button variant="outline" onClick={() => setConfirmSubmit(true)} disabled={!drafts.length}>
              <Send /> Submit {view} ({drafts.length})
            </Button>
            <Button onClick={() => setEditing(null)}><Plus /> Log time</Button>
          </>
        }
      />
      <RunningTimerCard />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" aria-label="Previous" onClick={() => set("date", shift(date, view, -1))}><ChevronLeft /></Button>
          <Button variant="outline" size="sm" onClick={() => set("date", "")}>Today</Button>
          <Button variant="outline" size="icon-sm" aria-label="Next" onClick={() => set("date", shift(date, view, 1))}><ChevronRight /></Button>
          <h2 className="ml-2 text-[15px] font-semibold">{title}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <Select aria-label="Project" value={project} onChange={(e) => set("project", e.target.value)} className="h-8 w-48 text-xs">
            <option value="">All projects</option>
            {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </Select>
          <Select aria-label="Status" value={status} onChange={(e) => set("status", e.target.value)} className="h-8 w-36 text-xs">
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </Select>
          <Segmented size="sm" value={view} onChange={(v) => set("view", v)} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }]} />
        </div>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs text-muted">Total</p>
          <p className="mt-1 text-xl font-semibold tabular">{formatDuration(totals?.total_seconds ?? 0)}</p>
          {view === "week" && capacity > 0 && <ProgressBar className="mt-2" value={((totals?.total_seconds ?? 0) / 3600 / capacity) * 100} tone="primary" label="Capacity used" />}
          {view === "week" && capacity > 0 && <p className="mt-1 text-xs text-muted">of {capacity}h weekly capacity</p>}
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted">Billable</p>
          <p className="mt-1 text-xl font-semibold tabular">{formatDuration(totals?.billable_seconds ?? 0)}</p>
          <p className="mt-1 text-xs text-muted">{totals?.total_seconds ? Math.round(((totals.billable_seconds ?? 0) / totals.total_seconds) * 100) : 0}% of tracked time</p>
        </Card>
        <Card className="p-4 sm:col-span-2">
          <p className="text-xs text-muted">Approval status</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["draft", "submitted", "approved", "rejected"] as const).map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5 text-[13px]">
                <StatusBadge kind="entry" status={s} />
                <span className="tabular text-muted">{formatDuration(totals?.by_status?.[s] ?? 0)}</span>
              </span>
            ))}
          </div>
          {(totals?.by_status?.rejected ?? 0) > 0 && <p className="mt-2 text-xs text-danger">Rejected entries need correcting — edit them and resubmit.</p>}
        </Card>
      </div>

      {view === "week" && (
        <Card className="mb-6">
          <CardHeader>
            <div>
              <CardTitle>Weekly timesheet</CardTitle>
              <CardDescription>Totals per project and task for the week</CardDescription>
            </div>
            {week.data && Object.keys(week.data.status_counts).length > 0 && (
              <div className="flex gap-1.5">{Object.entries(week.data.status_counts).map(([s, c]) => <Badge key={s} tone="neutral">{c} {s}</Badge>)}</div>
            )}
          </CardHeader>
          <QueryState query={week} empty={week.data && week.data.rows.length === 0 && <EmptyState compact icon={Clock} title="No time tracked this week" description="Start a timer from the header or log time manually." />}>
            {week.data && <WeekGrid sheet={week.data} />}
          </QueryState>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Entries</CardTitle>
            <CardDescription>{entries.length} entries · drafts and rejected entries can be edited</CardDescription>
          </div>
        </CardHeader>
        <QueryState query={list} empty={entries.length === 0 && <EmptyState compact icon={Clock} title="No entries for this period" action={<Button size="sm" onClick={() => setEditing(null)}><Plus /> Log time</Button>} />}>
          {view === "month" ? (
            <div className="divide-y divide-border border-t border-border">
              {grouped.map(([day, items]) => (
                <div key={day}>
                  <div className="flex items-center justify-between bg-surface-2 px-4 py-2 text-xs font-medium text-muted">
                    <span>{formatDate(day, { weekday: "long", month: "short", day: "numeric" })}</span>
                    <span className="tabular">{formatDuration(items.reduce((s, e) => s + e.duration_seconds, 0))}</span>
                  </div>
                  <TimeEntryTable entries={items} onEdit={setEditing} compact />
                </div>
              ))}
            </div>
          ) : (
            <TimeEntryTable entries={entries} onEdit={setEditing} />
          )}
        </QueryState>
      </Card>

      <TimeEntryDialog open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)} entry={editing ?? null} defaults={{ date: view === "day" ? date : undefined, project: project ? Number(project) : undefined }} />
      <ConfirmDialog
        open={confirmSubmit}
        onOpenChange={setConfirmSubmit}
        title={`Submit ${drafts.length} entr${drafts.length === 1 ? "y" : "ies"} for approval?`}
        description={`All draft and corrected entries from ${formatDate(range.from)} to ${formatDate(range.to)} will be sent to your project managers. Submitted entries are locked until they are approved or returned.`}
        confirmLabel="Submit for approval"
        tone="primary"
        loading={submit.isPending}
        onConfirm={() => submit.mutate(undefined)}
      />
    </>
  );
}
