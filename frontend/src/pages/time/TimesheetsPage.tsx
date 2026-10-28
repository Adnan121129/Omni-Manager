import { useQuery } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, ClipboardCheck, X } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router";

import { EmptyState, FilterBar, MoneyList, PageHeader, QueryState } from "@/components/common/layout-bits";
import { Button } from "@/components/ui/button";
import { Field, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { Card, CardDescription, CardHeader, CardTitle, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { TIME_KEYS, TimeEntryTable } from "@/features/time/TimeComponents";
import { useApiMutation, useClientOptions, useMembers, useProjectOptions } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { api, type Paginated } from "@/lib/api";
import { formatDate, formatDuration, formatHours, isoDate, type MoneyAmount } from "@/lib/format";
import type { TimeEntry } from "@/lib/types";
import { toQuery } from "@/lib/utils";

interface Group {
  key: number;
  label: string;
  seconds: number;
  billable_seconds: number;
  count: number;
  hours: string;
  billable_hours: string;
  value: MoneyAmount[];
  project?: string;
}

interface ApprovalQueue {
  entries: TimeEntry[];
  summary: { person: Group[]; project: Group[]; client: Group[]; task: Group[] };
  total_seconds: number;
  count: number;
}

function ApprovalsTab() {
  const [params, setParams] = useSearchParams();
  const [groupBy, setGroupBy] = React.useState<"person" | "project" | "client" | "task">("person");
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const members = useMembers();
  const projects = useProjectOptions({ includeClosed: true });
  const clients = useClientOptions();
  const get = (k: string) => params.get(k) ?? "";
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const status = get("status") || "submitted";
  const qs = toQuery({ status, user: get("user"), project: get("project"), client: get("client"), from: get("from"), to: get("to") });
  const query = useQuery({ queryKey: ["approvals", qs], queryFn: () => api.get<ApprovalQueue>(`/approvals/time/${qs}`) });
  React.useEffect(() => setSelected(new Set()), [qs]);
  const approve = useApiMutation((ids: number[]) => api.post<{ approved: number }>("/approvals/time/approve/", { ids }), {
    success: (r) => `${r.approved} entr${r.approved === 1 ? "y" : "ies"} approved`,
    invalidate: TIME_KEYS,
    onSuccess: () => setSelected(new Set()),
  });
  const reject = useApiMutation((args: { ids: number[]; reason: string }) => api.post<{ rejected: number }>("/approvals/time/reject/", args), {
    success: (r) => `${r.rejected} entr${r.rejected === 1 ? "y" : "ies"} returned for correction`,
    invalidate: TIME_KEYS,
    onSuccess: () => { setSelected(new Set()); setRejecting(false); setReason(""); },
  });
  const entries = query.data?.entries ?? [];
  const selectedEntries = entries.filter((e) => selected.has(e.id));
  const selectedSeconds = selectedEntries.reduce((s, e) => s + e.duration_seconds, 0);
  const groups = query.data?.summary[groupBy] ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <FilterBar>
          <Select aria-label="Status" value={status} onChange={(e) => set("status", e.target.value)} className="sm:w-40">
            <option value="submitted">Awaiting approval</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </Select>
          <Select aria-label="Person" value={get("user")} onChange={(e) => set("user", e.target.value)} className="sm:w-44">
            <option value="">Everyone</option>
            {members.data?.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name}</option>)}
          </Select>
          <Select aria-label="Project" value={get("project")} onChange={(e) => set("project", e.target.value)} className="sm:w-48">
            <option value="">All projects</option>
            {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </Select>
          <Select aria-label="Client" value={get("client")} onChange={(e) => set("client", e.target.value)} className="sm:w-44">
            <option value="">All clients</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <label className="flex items-center gap-1.5 text-xs text-muted">From <input type="date" className="h-8 rounded-md border border-border bg-surface px-2 text-[13px] text-fg" value={get("from")} onChange={(e) => set("from", e.target.value)} /></label>
          <label className="flex items-center gap-1.5 text-xs text-muted">To <input type="date" className="h-8 rounded-md border border-border bg-surface px-2 text-[13px] text-fg" value={get("to")} onChange={(e) => set("to", e.target.value)} /></label>
        </FilterBar>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Segmented size="sm" value={groupBy} onChange={setGroupBy} options={[{ value: "person", label: "By person" }, { value: "project", label: "By project" }, { value: "client", label: "By client" }, { value: "task", label: "By task" }]} />
          <p className="text-[13px] text-muted">{query.data?.count ?? 0} entries · {formatDuration(query.data?.total_seconds ?? 0)}</p>
        </div>
        {groups.length > 0 && (
          <Table>
            <THead>
              <tr>
                <TH>{groupBy === "person" ? "Person" : groupBy === "project" ? "Project" : groupBy === "client" ? "Client" : "Task"}</TH>
                <TH className="text-right">Entries</TH>
                <TH className="text-right">Hours</TH>
                <TH className="text-right">Billable hours</TH>
                <TH className="text-right">Estimated billing value</TH>
              </tr>
            </THead>
            <TBody>
              {groups.map((g) => (
                <TR key={`${groupBy}-${g.key}`}>
                  <TD className="font-medium">{g.label}{g.project ? <span className="ml-2 text-xs font-normal text-muted">{g.project}</span> : null}</TD>
                  <TD className="text-right tabular">{g.count}</TD>
                  <TD className="text-right tabular">{formatHours(g.hours, 2)}</TD>
                  <TD className="text-right tabular">{formatHours(g.billable_hours, 2)}</TD>
                  <TD className="text-right"><MoneyList list={g.value} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{status === "submitted" ? "Entries awaiting approval" : status === "approved" ? "Approved entries" : "Rejected entries"}</CardTitle>
            <CardDescription>
              {status === "submitted"
                ? "Select entries to approve in bulk, or return them with a reason so the owner can correct them."
                : status === "approved"
                  ? "Approved time is locked. Use “Reopen for correction” for audited changes (not possible once invoiced)."
                  : "Returned to their owners for correction."}
            </CardDescription>
          </div>
          {status === "submitted" && (
            <div className="flex items-center gap-2">
              {selected.size > 0 && <span className="text-[13px] text-muted">{selected.size} selected · {formatDuration(selectedSeconds)}</span>}
              <Button variant="danger-outline" size="sm" disabled={!selected.size} onClick={() => setRejecting(true)}><X /> Reject</Button>
              <Button variant="success" size="sm" disabled={!selected.size} loading={approve.isPending} onClick={() => approve.mutate([...selected])} data-testid="approve-selected"><Check /> Approve</Button>
            </div>
          )}
        </CardHeader>
        <QueryState query={query} empty={entries.length === 0 && <EmptyState compact icon={ClipboardCheck} title={status === "submitted" ? "Nothing to approve" : "No entries"} description={status === "submitted" ? "You're all caught up." : undefined} />}>
          <TimeEntryTable entries={entries} showUser selectable={status === "submitted"} selected={selected} onSelect={setSelected} />
        </QueryState>
      </Card>

      <Dialog open={rejecting} onOpenChange={setRejecting}>
        <DialogContent size="sm">
          <DialogHeader title={`Reject ${selected.size} entr${selected.size === 1 ? "y" : "ies"}?`} description="The entries return to their owners with your reason so they can correct and resubmit." />
          <DialogBody>
            <Field label="Reason" htmlFor="reject-reason" required>
              <Textarea id="reject-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Please split this by task and add a description." autoFocus />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(false)}>Cancel</Button>
            <Button variant="danger" disabled={!reason.trim()} loading={reject.isPending} onClick={() => reject.mutate({ ids: [...selected], reason })}>Reject entries</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TeamWeekTab() {
  const members = useMembers();
  const [user, setUser] = React.useState<string>("");
  const [start, setStart] = React.useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return isoDate(d);
  });
  const userId = user || String(members.data?.[0]?.user.id ?? "");
  const query = useQuery({
    queryKey: ["timesheet", "team", userId, start],
    queryFn: () => api.get<{ days: string[]; rows: { project: { code: string; name: string; color: string }; task: { title: string } | null; days: Record<string, number>; total_seconds: number }[]; day_totals: Record<string, number>; total_seconds: number; capacity_hours: string; entries: TimeEntry[] }>(`/timesheets/week/?user=${userId}&start=${start}`),
    enabled: Boolean(userId),
  });
  const move = (dir: number) => {
    const d = new Date(start);
    d.setDate(d.getDate() + dir * 7);
    setStart(isoDate(d));
  };
  return (
    <Card>
      <FilterBar>
        <Select aria-label="Team member" value={userId} onChange={(e) => setUser(e.target.value)} className="sm:w-56">
          {members.data?.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name}</option>)}
        </Select>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" aria-label="Previous week" onClick={() => move(-1)}><ChevronLeft /></Button>
          <span className="px-2 text-[13px] font-medium">Week of {formatDate(start)}</span>
          <Button variant="outline" size="icon-sm" aria-label="Next week" onClick={() => move(1)}><ChevronRight /></Button>
        </div>
        {query.data && <span className="text-[13px] text-muted sm:ml-auto">{formatDuration(query.data.total_seconds)} of {query.data.capacity_hours}h capacity</span>}
      </FilterBar>
      <QueryState query={query} empty={query.data && query.data.rows.length === 0 && <EmptyState compact title="No time tracked in this week" description="Only projects you manage are shown for other people." />}>
        {query.data && (
          <>
            <Table>
              <THead>
                <tr>
                  <TH>Project / task</TH>
                  {query.data.days.map((d) => <TH key={d} className="text-right">{formatDate(d, { weekday: "short", day: "numeric" })}</TH>)}
                  <TH className="text-right">Total</TH>
                </tr>
              </THead>
              <TBody>
                {query.data.rows.map((r, i) => (
                  <TR key={i}>
                    <TD><span className="mr-2 inline-block size-2 rounded-full" style={{ backgroundColor: r.project.color }} />{r.task?.title ?? r.project.name} <span className="text-xs text-muted">{r.project.code}</span></TD>
                    {query.data.days.map((d) => <TD key={d} className="text-right tabular text-[13px]">{r.days[d] ? formatDuration(r.days[d]) : "–"}</TD>)}
                    <TD className="text-right font-medium tabular">{formatDuration(r.total_seconds)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <div className="border-t border-border">
              <TimeEntryTable entries={query.data.entries} />
            </div>
          </>
        )}
      </QueryState>
    </Card>
  );
}

function MySubmissionsTab() {
  const query = useQuery({
    queryKey: ["time-entries", "mine", "submissions"],
    queryFn: () => api.get<Paginated<TimeEntry>>("/time-entries/?status=submitted,approved,rejected&page_size=100"),
  });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>My submitted time</CardTitle>
          <CardDescription>Track approvals. Rejected entries show the reviewer's reason — edit them on the Time Tracking page and resubmit.</CardDescription>
        </div>
      </CardHeader>
      <QueryState query={query} empty={query.data?.results.length === 0 && <EmptyState compact title="Nothing submitted yet" />}>
        <TimeEntryTable entries={query.data?.results ?? []} />
      </QueryState>
    </Card>
  );
}

export function TimesheetsPage() {
  const { permissions } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? (permissions.approve_time ? "approvals" : "mine");
  return (
    <>
      <PageHeader title="Timesheets" description="Draft → Submitted → Approved or Rejected. Approved time is locked and becomes billable." />
      <Tabs value={tab} onValueChange={(t) => setParams({ tab: t }, { replace: true })}>
        <TabsList className="mb-5">
          {permissions.approve_time && <TabsTrigger value="approvals">Approvals</TabsTrigger>}
          {permissions.approve_time && <TabsTrigger value="team">Team timesheets</TabsTrigger>}
          <TabsTrigger value="mine">My submissions</TabsTrigger>
        </TabsList>
        {permissions.approve_time && <TabsContent value="approvals"><ApprovalsTab /></TabsContent>}
        {permissions.approve_time && <TabsContent value="team"><TeamWeekTab /></TabsContent>}
        <TabsContent value="mine"><MySubmissionsTab /></TabsContent>
      </Tabs>
    </>
  );
}
