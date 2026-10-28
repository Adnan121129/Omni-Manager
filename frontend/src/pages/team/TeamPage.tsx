import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, ChevronRight, MailPlus, MoreHorizontal, Pencil, Timer, UserCheck, UserX, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { EmptyState, PageHeader, QueryState } from "@/components/common/layout-bits";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Tabs, TabsContent, TabsList, TabsTrigger, Tooltip } from "@/components/ui/overlays";
import { Avatar, Badge, Card, CardDescription, CardHeader, CardTitle, ProgressBar, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { useApiMutation } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { api, ApiError, errorMessage, type Paginated } from "@/lib/api";
import { formatDate, formatHours, formatMoney, isoDate, relativeTime } from "@/lib/format";
import type { Member, Role } from "@/lib/types";

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Administrator", project_manager: "Project manager", member: "Team member", client: "Client" };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface Workload {
  start: string;
  end: string;
  members: { user: { id: number; full_name: string }; membership_id: number; role: Role; title: string; capacity_hours: string; tracked_hours: string; billable_hours: string; utilization_percent: string | null; load_percent: string | null; open_tasks: number; overdue_tasks: number; open_estimated_hours: string; remaining_estimated_hours: string; due_this_period_hours: string; draft_entries: number; rejected_entries: number; submitted_entries: number; timer_running: boolean; overloaded: boolean }[];
}

interface InvitationRow { id: number; email: string; role: Role; client_name: string | null; status: string; invited_by_name: string | null; created_at: string; expires_at: string }

function EditMemberDialog({ member, onOpenChange }: { member: Member | null; onOpenChange: (o: boolean) => void }) {
  const { permissions } = useAuth();
  const queryClient = useQueryClient();
  const [v, setV] = React.useState({ role: "member", title: "", weekly_capacity_hours: "40", working_days: [0, 1, 2, 3, 4], default_bill_rate: "", cost_rate: "", can_manage_billing: true });
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (member) setV({ role: member.role, title: member.title, weekly_capacity_hours: member.weekly_capacity_hours, working_days: member.working_days.length ? member.working_days : [0, 1, 2, 3, 4], default_bill_rate: member.default_bill_rate ?? "", cost_rate: member.cost_rate ?? "", can_manage_billing: member.can_manage_billing });
  }, [member]);
  return (
    <Dialog open={Boolean(member)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title={`Edit ${member?.user.full_name ?? ""}`} description="Role controls access; capacity drives workload and utilization." />
        <DialogBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Role" htmlFor="m-role">
            <Select id="m-role" value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })} disabled={member?.role === "owner" && !permissions.is_owner}>
              {permissions.is_owner && <option value="owner">Owner</option>}
              <option value="admin">Administrator</option>
              <option value="project_manager">Project manager</option>
              <option value="member">Team member</option>
            </Select>
          </Field>
          <Field label="Job title" htmlFor="m-title"><Input id="m-title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
          <Field label="Weekly capacity (hours)" htmlFor="m-cap"><Input id="m-cap" type="number" min="0" max="100" step="0.5" value={v.weekly_capacity_hours} onChange={(e) => setV({ ...v, weekly_capacity_hours: e.target.value })} /></Field>
          <Field label="Working days" htmlFor="m-days">
            <div className="flex flex-wrap gap-1" id="m-days">
              {DAYS.map((d, i) => {
                const on = v.working_days.includes(i);
                return <button key={d} type="button" aria-pressed={on} onClick={() => setV({ ...v, working_days: on ? v.working_days.filter((x) => x !== i) : [...v.working_days, i].sort() })} className={`h-8 w-10 rounded-md border text-xs font-medium ${on ? "border-primary/30 bg-primary-soft text-primary" : "border-border text-muted"}`}>{d}</button>;
              })}
            </div>
          </Field>
          {permissions.billing && (
            <>
              <Field label="Default billing rate" htmlFor="m-bill" hint="Used when the project has no rate"><Input id="m-bill" type="number" min="0" step="0.01" value={v.default_bill_rate} onChange={(e) => setV({ ...v, default_bill_rate: e.target.value })} /></Field>
              <Field label="Internal cost rate / hour" htmlFor="m-cost" hint="For profitability estimates"><Input id="m-cost" type="number" min="0" step="0.01" value={v.cost_rate} onChange={(e) => setV({ ...v, cost_rate: e.target.value })} /></Field>
              {v.role === "admin" && <label className="flex items-center gap-2 text-[13px] sm:col-span-2"><Checkbox checked={v.can_manage_billing} onChange={(e) => setV({ ...v, can_manage_billing: e.target.checked })} /> Can access invoices, payments and financial reports</label>}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            loading={busy}
            onClick={async () => {
              if (!member) return;
              setBusy(true);
              const payload: Record<string, unknown> = { role: v.role, title: v.title, weekly_capacity_hours: v.weekly_capacity_hours, working_days: v.working_days };
              if (permissions.billing) Object.assign(payload, { default_bill_rate: v.default_bill_rate || null, cost_rate: v.cost_rate || "0", can_manage_billing: v.can_manage_billing });
              try {
                await api.patch(`/team/members/${member.id}/`, payload);
                queryClient.invalidateQueries({ queryKey: ["members"] });
                queryClient.invalidateQueries({ queryKey: ["team"] });
                toast.success("Member updated");
                onOpenChange(false);
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState("member");
  const [link, setLink] = React.useState<string | null>(null);
  const invite = useApiMutation(() => api.post<{ dev_accept_url?: string }>("/team/invitations/", { email, role }), {
    success: `Invitation sent to ${email}`,
    onSuccess: (r) => { queryClient.invalidateQueries({ queryKey: ["team", "invitations"] }); setLink(r.dev_accept_url ?? null); if (!r.dev_accept_url) onOpenChange(false); },
  });
  React.useEffect(() => { if (open) { setEmail(""); setRole("member"); setLink(null); } }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader title="Invite a team member" description="To invite a client contact, use “Invite to portal” on the client's page." />
        <DialogBody className="space-y-4">
          <Field label="Email" htmlFor="inv-email"><Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></Field>
          <Field label="Role" htmlFor="inv-role">
            <Select id="inv-role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">Team member — assigned work, time and expenses</option>
              <option value="project_manager">Project manager — manages assigned projects and approvals</option>
              <option value="admin">Administrator — manages the workspace</option>
            </Select>
          </Field>
          {link && <p className="break-all rounded-md bg-subtle p-2 text-xs text-muted">Development mode — accept link: <a href={link} className="text-primary underline">{link}</a></p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button disabled={!email} loading={invite.isPending} onClick={() => invite.mutate(undefined)}><MailPlus /> Send invitation</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WorkloadTab() {
  const [start, setStart] = React.useState(() => isoDate(new Date()));
  const query = useQuery({ queryKey: ["team", "workload", start], queryFn: () => api.get<Workload>(`/team/workload/?start=${start}`) });
  const move = (dir: number) => { const d = new Date(query.data?.start ?? start); d.setDate(d.getDate() + dir * 7); setStart(isoDate(d)); };
  return (
    <Card>
      <CardHeader>
        <div><CardTitle>Weekly workload</CardTitle><CardDescription>Tracked time vs capacity, assigned work and timesheet status</CardDescription></div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" aria-label="Previous week" onClick={() => move(-1)}><ChevronLeft /></Button>
          <span className="px-2 text-[13px] font-medium">{query.data ? `${formatDate(query.data.start, { month: "short", day: "numeric" })} – ${formatDate(query.data.end, { month: "short", day: "numeric" })}` : "…"}</span>
          <Button variant="outline" size="icon-sm" aria-label="Next week" onClick={() => move(1)}><ChevronRight /></Button>
        </div>
      </CardHeader>
      <QueryState query={query}>
        <Table>
          <THead>
            <tr>
              <TH>Person</TH>
              <TH className="w-56">Load (tracked / capacity)</TH>
              <TH className="text-right">Billable</TH>
              <TH className="text-right">Open tasks</TH>
              <TH className="hidden text-right lg:table-cell">Due this week</TH>
              <TH className="hidden text-right lg:table-cell">Est. remaining</TH>
              <TH>Timesheet</TH>
            </tr>
          </THead>
          <TBody>
            {query.data?.members.map((m) => {
              const load = Number(m.load_percent ?? 0);
              return (
                <TR key={m.user.id}>
                  <TD>
                    <span className="flex items-center gap-2.5">
                      <Avatar name={m.user.full_name} size={28} />
                      <span>
                        <span className="flex items-center gap-1.5 font-medium">{m.user.full_name}{m.timer_running && <Tooltip content="Timer running"><Timer className="size-3.5 text-primary" /></Tooltip>}</span>
                        <span className="text-xs text-muted">{m.title || ROLE_LABEL[m.role]}</span>
                      </span>
                    </span>
                  </TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      <ProgressBar value={load} tone={m.overloaded ? "danger" : load >= 85 ? "warning" : "primary"} className="w-28" />
                      <span className="text-xs tabular text-muted">{formatHours(m.tracked_hours)} / {formatHours(m.capacity_hours)}</span>
                    </div>
                    {m.overloaded && <span className="mt-1 flex items-center gap-1 text-xs text-danger"><AlertTriangle className="size-3" /> Overloaded</span>}
                  </TD>
                  <TD className="text-right tabular">{formatHours(m.billable_hours)}</TD>
                  <TD className="text-right tabular">{m.open_tasks}{m.overdue_tasks > 0 && <span className="ml-1 text-xs text-danger">({m.overdue_tasks} late)</span>}</TD>
                  <TD className="hidden text-right tabular lg:table-cell">{formatHours(m.due_this_period_hours)}</TD>
                  <TD className="hidden text-right tabular text-muted lg:table-cell">{formatHours(m.remaining_estimated_hours)}</TD>
                  <TD>
                    <span className="flex flex-wrap gap-1">
                      {m.draft_entries > 0 && <Badge>{m.draft_entries} draft</Badge>}
                      {m.submitted_entries > 0 && <Badge tone="info">{m.submitted_entries} to review</Badge>}
                      {m.rejected_entries > 0 && <Badge tone="danger">{m.rejected_entries} rejected</Badge>}
                      {!m.draft_entries && !m.submitted_entries && !m.rejected_entries && <span className="text-xs text-muted">Up to date</span>}
                    </span>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </QueryState>
    </Card>
  );
}

function MembersTab() {
  const { permissions, user, org } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["team", "members"], queryFn: () => api.get<Paginated<Member>>("/team/members/?role=staff&page_size=200") });
  const [editing, setEditing] = React.useState<Member | null>(null);
  const [deactivating, setDeactivating] = React.useState<Member | null>(null);
  const action = async (m: Member, verb: "deactivate" | "reactivate") => {
    try {
      await api.post(`/team/members/${m.id}/${verb}/`);
      queryClient.invalidateQueries({ queryKey: ["team"] });
      queryClient.invalidateQueries({ queryKey: ["members"] });
      toast.success(verb === "deactivate" ? `${m.user.full_name} deactivated` : `${m.user.full_name} reactivated`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Card>
      <QueryState query={query} empty={!query.data?.results.length && <EmptyState title="No members" />}>
        <Table>
          <THead>
            <tr>
              <TH>Person</TH>
              <TH>Role</TH>
              <TH className="hidden md:table-cell">Capacity</TH>
              {permissions.billing && <TH className="hidden lg:table-cell text-right">Bill rate</TH>}
              {permissions.billing && <TH className="hidden lg:table-cell text-right">Cost rate</TH>}
              <TH className="hidden sm:table-cell">Joined</TH>
              <TH>Status</TH>
              {permissions.manage_team && <TH className="w-10" />}
            </tr>
          </THead>
          <TBody>
            {query.data?.results.map((m) => (
              <TR key={m.id}>
                <TD><span className="flex items-center gap-2.5"><Avatar name={m.user.full_name} size={28} /><span><span className="block font-medium">{m.user.full_name}</span><span className="text-xs text-muted">{m.user.email}</span></span></span></TD>
                <TD><span className="block text-[13px]">{ROLE_LABEL[m.role]}</span><span className="text-xs text-muted">{m.title}</span></TD>
                <TD className="hidden text-[13px] md:table-cell">{formatHours(m.weekly_capacity_hours)}/wk <span className="text-xs text-muted">· {m.working_days.length || 5} days</span></TD>
                {permissions.billing && <TD className="hidden text-right tabular lg:table-cell">{m.default_bill_rate ? formatMoney(m.default_bill_rate, org.default_currency) : <span className="text-muted">Project rate</span>}</TD>}
                {permissions.billing && <TD className="hidden text-right tabular lg:table-cell">{m.cost_rate ? formatMoney(m.cost_rate, org.default_currency) : "—"}</TD>}
                <TD className="hidden text-muted sm:table-cell">{relativeTime(m.joined_at)}</TD>
                <TD>{m.status === "active" ? <Badge tone="success" dot>Active</Badge> : <Badge dot>Deactivated</Badge>}</TD>
                {permissions.manage_team && (
                  <TD>
                    {m.user.id !== user.id && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Member actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem onSelect={() => setEditing(m)}><Pencil /> Edit role & capacity</DropdownMenuItem>
                          {m.status === "active" ? <DropdownMenuItem destructive onSelect={() => setDeactivating(m)}><UserX /> Deactivate</DropdownMenuItem> : <DropdownMenuItem onSelect={() => action(m, "reactivate")}><UserCheck /> Reactivate</DropdownMenuItem>}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TD>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
      </QueryState>
      <EditMemberDialog member={editing} onOpenChange={(o) => !o && setEditing(null)} />
      <ConfirmDialog
        open={Boolean(deactivating)}
        onOpenChange={(o) => !o && setDeactivating(null)}
        title={`Deactivate ${deactivating?.user.full_name ?? ""}?`}
        description="They lose access to this workspace immediately. Their time, tasks and history are kept, and you can reactivate them later."
        confirmLabel="Deactivate"
        onConfirm={async () => { if (deactivating) await action(deactivating, "deactivate"); setDeactivating(null); }}
      />
    </Card>
  );
}

function InvitationsTab() {
  const query = useQuery({ queryKey: ["team", "invitations"], queryFn: () => api.get<Paginated<InvitationRow>>("/team/invitations/?page_size=100") });
  const revoke = useApiMutation((id: number) => api.post(`/team/invitations/${id}/revoke/`), { success: "Invitation revoked", invalidate: [["team", "invitations"]] });
  return (
    <Card>
      <QueryState query={query} empty={!query.data?.results.length && <EmptyState compact title="No invitations sent yet" />}>
        <Table>
          <THead><tr><TH>Email</TH><TH>Role</TH><TH className="hidden sm:table-cell">Invited by</TH><TH>Status</TH><TH className="hidden sm:table-cell">Expires</TH><TH className="w-10" /></tr></THead>
          <TBody>
            {query.data?.results.map((i) => (
              <TR key={i.id}>
                <TD className="font-medium">{i.email}</TD>
                <TD>{ROLE_LABEL[i.role]}{i.client_name ? ` · ${i.client_name}` : ""}</TD>
                <TD className="hidden text-muted sm:table-cell">{i.invited_by_name}</TD>
                <TD><Badge tone={i.status === "pending" ? "info" : i.status === "accepted" ? "success" : "neutral"}>{i.status}</Badge></TD>
                <TD className="hidden text-muted sm:table-cell">{formatDate(i.expires_at)}</TD>
                <TD>{i.status === "pending" && <Button variant="ghost" size="icon-sm" aria-label="Revoke" onClick={() => revoke.mutate(i.id)}><X /></Button>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </QueryState>
    </Card>
  );
}

export function TeamPage() {
  const { permissions } = useAuth();
  const [inviting, setInviting] = React.useState(false);
  return (
    <>
      <PageHeader title="Team" description="Members, roles, capacity and workload." actions={permissions.manage_team && <Button onClick={() => setInviting(true)}><MailPlus /> Invite member</Button>} />
      <Tabs defaultValue={permissions.is_manager ? "workload" : "members"}>
        <TabsList className="mb-4">
          {permissions.is_manager && <TabsTrigger value="workload">Workload</TabsTrigger>}
          <TabsTrigger value="members">Members</TabsTrigger>
          {permissions.manage_team && <TabsTrigger value="invitations">Invitations</TabsTrigger>}
        </TabsList>
        {permissions.is_manager && <TabsContent value="workload"><WorkloadTab /></TabsContent>}
        <TabsContent value="members"><MembersTab /></TabsContent>
        {permissions.manage_team && <TabsContent value="invitations"><InvitationsTab /></TabsContent>}
      </Tabs>
      <InviteDialog open={inviting} onOpenChange={setInviting} />
    </>
  );
}
