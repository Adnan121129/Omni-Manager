import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, CalendarClock, Plus, Target, Trash2, UserCheck } from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { EmptyState, MoneyList, PageHeader, QueryState, SearchInput } from "@/components/common/layout-bits";
import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/overlays";
import { Avatar, Card } from "@/components/ui/primitives";
import { useApiMutation, useDebounced, useMembers } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { api, ApiError, errorMessage } from "@/lib/api";
import { daysUntil, formatDateShort, formatMoney } from "@/lib/format";
import type { Client, Lead, LeadStage } from "@/lib/types";
import { cn } from "@/lib/utils";

const OPEN_STAGES: LeadStage[] = ["new", "contacted", "qualified", "proposal"];
const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "SGD", "INR", "ZAR", "AED"];

function LeadDialog({ open, onOpenChange, lead }: { open: boolean; onOpenChange: (o: boolean) => void; lead?: Lead | null }) {
  const queryClient = useQueryClient();
  const { org } = useAuth();
  const members = useMembers();
  const empty = { title: "", company: "", contact_name: "", email: "", phone: "", source: "", stage: "new", value: "", currency: org.default_currency, expected_close_date: "", next_follow_up: "", notes: "", owner: "" };
  const [v, setV] = React.useState(empty);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setErrors({});
    setV(lead ? {
      title: lead.title, company: lead.company, contact_name: lead.contact_name, email: lead.email, phone: lead.phone, source: lead.source,
      stage: lead.stage, value: lead.value, currency: lead.currency, expected_close_date: lead.expected_close_date ?? "",
      next_follow_up: lead.next_follow_up ?? "", notes: lead.notes, owner: lead.owner ? String(lead.owner) : "",
    } : empty);
  }, [open, lead]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof empty, value: string) => setV((s) => ({ ...s, [k]: value }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title={lead ? "Edit lead" : "New lead"} description="Track an inquiry or opportunity until it becomes a client." />
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErrors({});
            const payload = { ...v, value: v.value || "0", expected_close_date: v.expected_close_date || null, next_follow_up: v.next_follow_up || null, owner: v.owner ? Number(v.owner) : null };
            try {
              if (lead) await api.patch(`/leads/${lead.id}/`, payload);
              else await api.post("/leads/", payload);
              queryClient.invalidateQueries({ queryKey: ["leads"] });
              toast.success(lead ? "Lead updated" : "Lead created");
              onOpenChange(false);
            } catch (err) {
              if (err instanceof ApiError) setErrors(err.fields);
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Opportunity" htmlFor="l-title" required error={errors.title?.[0]}><Input id="l-title" value={v.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Website redesign" required autoFocus /></Field>
            <Field label="Company" htmlFor="l-company" required error={errors.company?.[0]}><Input id="l-company" value={v.company} onChange={(e) => set("company", e.target.value)} required /></Field>
            <Field label="Contact name" htmlFor="l-contact"><Input id="l-contact" value={v.contact_name} onChange={(e) => set("contact_name", e.target.value)} /></Field>
            <Field label="Email" htmlFor="l-email" error={errors.email?.[0]}><Input id="l-email" type="email" value={v.email} onChange={(e) => set("email", e.target.value)} /></Field>
            <Field label="Phone" htmlFor="l-phone"><Input id="l-phone" value={v.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
            <Field label="Source" htmlFor="l-source"><Input id="l-source" value={v.source} onChange={(e) => set("source", e.target.value)} placeholder="Referral, website, event…" list="lead-sources" /></Field>
            <datalist id="lead-sources">{["Referral", "Website form", "LinkedIn", "Conference", "Existing client", "Cold outreach"].map((s) => <option key={s} value={s} />)}</datalist>
            <Field label="Stage" htmlFor="l-stage" error={errors.stage?.[0]}>
              <Select id="l-stage" value={v.stage} onChange={(e) => set("stage", e.target.value)}>
                {OPEN_STAGES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
                <option value="lost">Lost</option>
              </Select>
            </Field>
            <div className="grid grid-cols-[1fr_6rem] gap-2">
              <Field label="Potential value" htmlFor="l-value" error={errors.value?.[0]}><Input id="l-value" type="number" min="0" step="100" value={v.value} onChange={(e) => set("value", e.target.value)} /></Field>
              <Field label="Currency" htmlFor="l-cur"><Select id="l-cur" value={v.currency} onChange={(e) => set("currency", e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
            </div>
            <Field label="Expected close" htmlFor="l-close"><Input id="l-close" type="date" value={v.expected_close_date} onChange={(e) => set("expected_close_date", e.target.value)} /></Field>
            <Field label="Next follow-up" htmlFor="l-follow"><Input id="l-follow" type="date" value={v.next_follow_up} onChange={(e) => set("next_follow_up", e.target.value)} /></Field>
            <Field label="Owner" htmlFor="l-owner">
              <Select id="l-owner" value={v.owner} onChange={(e) => set("owner", e.target.value)}>
                <option value="">Me</option>
                {members.data?.filter((m) => m.role !== "member").map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name}</option>)}
              </Select>
            </Field>
            <Field label="Notes" htmlFor="l-notes" className="sm:col-span-2"><Textarea id="l-notes" value={v.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={busy}>{lead ? "Save" : "Create lead"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConvertDialog({ lead, onOpenChange }: { lead: Lead | null; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const dup = useQuery({
    queryKey: ["lead-dup", lead?.id],
    queryFn: () => api.get<{ match: { id: number; name: string; email: string } | null }>(`/leads/${lead!.id}/duplicate-check/`),
    enabled: Boolean(lead),
  });
  const [busy, setBusy] = React.useState(false);
  const convert = async (existing?: number) => {
    if (!lead) return;
    setBusy(true);
    try {
      const r = await api.post<{ client: Client }>(`/leads/${lead.id}/convert/`, existing ? { client: existing } : {});
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      queryClient.invalidateQueries({ queryKey: ["client-options"] });
      toast.success(`${lead.company} is now a client`);
      onOpenChange(false);
      navigate(`/clients/${r.client.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const match = dup.data?.match;
  return (
    <Dialog open={Boolean(lead)} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader title={`Convert ${lead?.company ?? ""} to a client`} description="The lead is marked as won and its interaction history moves to the client timeline." />
        <DialogBody className="space-y-3 text-[13px]">
          {dup.isLoading ? (
            <p className="text-muted">Checking for existing clients…</p>
          ) : match ? (
            <div className="rounded-md border border-warning/30 bg-warning-soft p-3 text-warning">
              A client named <strong>{match.name}</strong> already exists{match.email ? ` (${match.email})` : ""}. Link this lead to it to avoid a duplicate record.
            </div>
          ) : (
            <p className="text-muted">No existing client matches this company or email. A new client record will be created from the lead's details.</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {match ? (
            <>
              <Button variant="outline" loading={busy} onClick={() => convert()}>Create separate client</Button>
              <Button loading={busy} onClick={() => convert(match.id)}><UserCheck /> Link to {match.name}</Button>
            </>
          ) : (
            <Button loading={busy || dup.isLoading} onClick={() => convert()}><UserCheck /> Convert to client</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CrmPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState("");
  const debounced = useDebounced(search);
  const [editing, setEditing] = React.useState<Lead | null | undefined>(undefined);
  const [converting, setConverting] = React.useState<Lead | null>(null);
  const [losing, setLosing] = React.useState<Lead | null>(null);
  const [lostReason, setLostReason] = React.useState("");
  const [deleting, setDeleting] = React.useState<Lead | null>(null);
  const [showClosed, setShowClosed] = React.useState(false);
  const dragged = React.useRef<Lead | null>(null);
  const [over, setOver] = React.useState<string | null>(null);
  const query = useQuery({ queryKey: ["leads", debounced], queryFn: () => api.get<Lead[]>(`/leads/?search=${encodeURIComponent(debounced)}`) });
  const pipeline = useQuery({ queryKey: ["leads", "pipeline"], queryFn: () => api.get<{ stage: string; label: string; count: number; value: { currency: string; amount: string }[] }[]>("/leads/pipeline/") });
  const remove = useApiMutation((id: number) => api.delete(`/leads/${id}/`), { success: "Lead deleted", invalidate: [["leads"]], onSuccess: () => setDeleting(null) });
  const leads = query.data ?? [];
  const today = new Date();

  const moveTo = async (stage: LeadStage) => {
    const lead = dragged.current;
    dragged.current = null;
    setOver(null);
    if (!lead || lead.stage === stage) return;
    if (stage === "won") return setConverting(lead);
    if (stage === "lost") { setLostReason(""); return setLosing(lead); }
    queryClient.setQueryData<Lead[]>(["leads", debounced], (old) => old?.map((l) => (l.id === lead.id ? { ...l, stage } : l)));
    try {
      await api.patch(`/leads/${lead.id}/`, { stage });
      queryClient.invalidateQueries({ queryKey: ["leads"] });
    } catch (err) {
      toast.error(errorMessage(err));
      queryClient.invalidateQueries({ queryKey: ["leads"] });
    }
  };

  const columns: LeadStage[] = showClosed ? [...OPEN_STAGES, "won", "lost"] : [...OPEN_STAGES, "won"];
  return (
    <>
      <PageHeader
        title="CRM"
        description="Leads and opportunities. Drag cards between stages; drop on Won to convert to a client."
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Search leads…" />
            <Button variant="outline" onClick={() => setShowClosed((s) => !s)}>{showClosed ? "Hide lost" : "Show lost"}</Button>
            <Button onClick={() => setEditing(null)}><Plus /> New lead</Button>
          </>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {pipeline.data?.filter((p) => OPEN_STAGES.includes(p.stage as LeadStage)).map((p) => (
          <Card key={p.stage} className="p-4">
            <div className="flex items-center justify-between"><StatusBadge kind="lead" status={p.stage} /><span className="text-xs tabular text-muted">{p.count}</span></div>
            <p className="mt-2 text-lg font-semibold"><MoneyList list={p.value.filter((v) => Number(v.amount) > 0)} empty="—" /></p>
          </Card>
        ))}
      </div>
      <QueryState query={query} empty={leads.length === 0 && !debounced && <Card><EmptyState icon={Target} title="No leads yet" description="Add inquiries to track them through your pipeline." action={<Button onClick={() => setEditing(null)}><Plus /> New lead</Button>} /></Card>}>
        <div className="grid auto-cols-[minmax(250px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2 scrollbar-thin">
          {columns.map((stage) => {
            const items = leads.filter((l) => l.stage === stage);
            return (
              <section
                key={stage}
                aria-label={stage}
                onDragOver={(e) => { e.preventDefault(); setOver(stage); }}
                onDragLeave={() => setOver(null)}
                onDrop={() => moveTo(stage)}
                className={cn("flex min-h-[20rem] flex-col rounded-lg bg-subtle/70 p-2", over === stage && "bg-primary-soft ring-1 ring-primary/30", stage === "won" && "bg-success-soft/40")}
              >
                <header className="flex items-center justify-between px-1.5 pb-2 pt-1">
                  <StatusBadge kind="lead" status={stage} />
                  <span className="text-xs tabular text-muted">{items.length}</span>
                </header>
                <div className="flex flex-col gap-2">
                  {items.map((lead) => {
                    const followDays = daysUntil(lead.next_follow_up, today);
                    return (
                      <div
                        key={lead.id}
                        draggable={stage !== "won"}
                        onDragStart={() => { dragged.current = lead; }}
                        className="group rounded-lg border border-border bg-surface p-3 shadow-card hover:border-border-strong"
                      >
                        <button type="button" className="w-full text-left" onClick={() => setEditing(lead)}>
                          <p className="text-[13px] font-semibold">{lead.company}</p>
                          <p className="text-xs text-muted">{lead.title}</p>
                          <div className="mt-2 flex items-center justify-between text-xs">
                            <span className="font-medium tabular">{Number(lead.value) ? formatMoney(lead.value, lead.currency, { compact: true }) : "—"}</span>
                            {lead.owner_detail && <Avatar name={lead.owner_detail.full_name} size={20} />}
                          </div>
                          {lead.next_follow_up && stage !== "won" && stage !== "lost" && (
                            <p className={cn("mt-1.5 inline-flex items-center gap-1 text-[11px]", followDays !== null && followDays <= 0 ? "font-medium text-danger" : "text-muted")}>
                              <CalendarClock className="size-3" /> Follow up {followDays === 0 ? "today" : formatDateShort(lead.next_follow_up)}
                            </p>
                          )}
                          {lead.source && <p className="mt-1 text-[11px] text-muted">via {lead.source}</p>}
                        </button>
                        {stage === "won" && lead.converted_client && (
                          <Link to={`/clients/${lead.converted_client}`} className="mt-2 inline-flex text-xs font-medium text-primary hover:underline">Open client →</Link>
                        )}
                        {stage !== "won" && (
                          <div className="mt-2 flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
                            {stage !== "lost" && <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setConverting(lead)}><ArrowRightLeft /> Convert</Button>}
                            <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs text-muted" onClick={() => setDeleting(lead)} aria-label="Delete lead"><Trash2 /></Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {items.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted">{stage === "won" ? "Drop a lead here to convert it" : "No leads"}</p>}
                </div>
              </section>
            );
          })}
        </div>
      </QueryState>
      <LeadDialog open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)} lead={editing ?? null} />
      <ConvertDialog lead={converting} onOpenChange={(o) => !o && setConverting(null)} />
      <ConfirmDialog
        open={Boolean(losing)}
        onOpenChange={(o) => !o && setLosing(null)}
        title={`Mark ${losing?.company ?? ""} as lost?`}
        tone="primary"
        confirmLabel="Mark as lost"
        onConfirm={async () => {
          if (!losing) return;
          try {
            await api.patch(`/leads/${losing.id}/`, { stage: "lost", lost_reason: lostReason });
            queryClient.invalidateQueries({ queryKey: ["leads"] });
            setLosing(null);
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      >
        <Input value={lostReason} onChange={(e) => setLostReason(e.target.value)} placeholder="Why was it lost? (optional)" aria-label="Lost reason" />
      </ConfirmDialog>
      <ConfirmDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)} title="Delete this lead?" description="Its notes and interactions will be removed." confirmLabel="Delete" loading={remove.isPending} onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </>
  );
}
