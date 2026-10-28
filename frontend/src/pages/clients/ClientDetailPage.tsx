import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, FolderKanban, Mail, MessageSquarePlus, Pencil, Phone, Plus, Receipt, UserPlus } from "lucide-react";
import * as React from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";

import { activityText } from "@/components/common/collab";
import { DefinitionList, EmptyState, ErrorState, MoneyList, PageHeader, PageLoader, StatCard } from "@/components/common/layout-bits";
import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { Avatar, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { ClientFormDialog } from "@/features/clients/ClientForm";
import { useApiMutation } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatDateTime, formatMoney, relativeTime, type MoneyAmount } from "@/lib/format";
import type { Activity, Client, Interaction } from "@/lib/types";

interface Overview {
  client: Client;
  projects: { id: number; code: string; name: string; status: string; deadline: string | null; manager: string | null; project_type: string }[];
  documents: { id: number; title: string; kind: string; status: string; sent_at: string | null; signed_at: string | null }[];
  portal_users: { id: number; user_id: number; name: string; email: string; status: string }[];
  leads: { id: number; title: string; stage: string; value: string; currency: string }[];
  invoices?: { id: number; number: string; status: string; issue_date: string; due_date: string; total: string; amount_due: string; currency: string }[];
  payments?: { id: number; invoice_id: number; invoice_number: string; amount: string; currency: string; method: string; received_at: string }[];
  outstanding?: MoneyAmount[];
  overdue?: MoneyAmount[];
  lifetime_paid?: MoneyAmount[];
}

type TimelineItem = { type: "interaction"; id: string; at: string; data: Interaction } | { type: "activity"; id: string; at: string; data: Activity };

function LogInteraction({ clientId }: { clientId: number }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [v, setV] = React.useState({ kind: "call", summary: "", occurred_at: "", follow_up_date: "" });
  const save = useApiMutation(
    () => api.post("/interactions/", { client: clientId, kind: v.kind, summary: v.summary, occurred_at: v.occurred_at ? new Date(v.occurred_at).toISOString() : new Date().toISOString(), follow_up_date: v.follow_up_date || null }),
    { success: "Interaction logged", onSuccess: () => { setOpen(false); setV({ kind: "call", summary: "", occurred_at: "", follow_up_date: "" }); queryClient.invalidateQueries({ queryKey: ["client", clientId, "timeline"] }); } },
  );
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}><MessageSquarePlus /> Log interaction</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader title="Log an interaction" description="Calls, emails, meetings and notes build the client's relationship timeline." />
          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Type" htmlFor="i-kind">
              <Select id="i-kind" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>
                <option value="call">Call</option>
                <option value="email">Email</option>
                <option value="meeting">Meeting</option>
                <option value="note">Note</option>
              </Select>
            </Field>
            <Field label="When" htmlFor="i-when"><Input id="i-when" type="datetime-local" value={v.occurred_at} onChange={(e) => setV({ ...v, occurred_at: e.target.value })} /></Field>
            <Field label="Summary" htmlFor="i-summary" required className="sm:col-span-2"><Textarea id="i-summary" rows={4} value={v.summary} onChange={(e) => setV({ ...v, summary: e.target.value })} /></Field>
            <Field label="Follow up on" htmlFor="i-follow"><Input id="i-follow" type="date" value={v.follow_up_date} onChange={(e) => setV({ ...v, follow_up_date: e.target.value })} /></Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!v.summary.trim()} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function InviteContact({ client }: { client: Client }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState(client.email);
  const [link, setLink] = React.useState<string | null>(null);
  const invite = useApiMutation(() => api.post<{ dev_accept_url?: string }>("/team/invitations/", { email, role: "client", client: client.id }), {
    success: `Invitation sent to ${email}`,
    onSuccess: (r) => { setLink(r.dev_accept_url ?? null); queryClient.invalidateQueries({ queryKey: ["client", client.id] }); if (!r.dev_accept_url) setOpen(false); },
  });
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => { setOpen(true); setLink(null); setEmail(client.email); }}><UserPlus /> Invite to portal</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader title="Invite a client contact" description="They'll get a link to create their portal account and see only this client's shared projects, documents and invoices." />
          <DialogBody className="space-y-3">
            <Field label="Email" htmlFor="inv-email"><Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            {link && (
              <p className="break-all rounded-md bg-subtle p-2 text-xs text-muted">
                Development mode — the invitation email was written to the local mailbox. Accept link: <a className="text-primary underline" href={link}>{link}</a>
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
            <Button disabled={!email} loading={invite.isPending} onClick={() => invite.mutate(undefined)}>Send invitation</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ClientDetailPage() {
  const { id } = useParams();
  const clientId = Number(id);
  const { permissions } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [archiving, setArchiving] = React.useState(false);
  const query = useQuery({ queryKey: ["client", clientId], queryFn: () => api.get<Overview>(`/clients/${clientId}/overview/`) });
  const timeline = useQuery({ queryKey: ["client", clientId, "timeline"], queryFn: () => api.get<TimelineItem[]>(`/clients/${clientId}/timeline/`) });
  if (query.isLoading) return <PageLoader />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const d = query.data;
  const c = d.client;
  const archived = c.status === "archived";

  return (
    <>
      <PageHeader
        back={{ to: "/clients", label: "Clients" }}
        title={<span className="flex items-center gap-3"><Avatar name={c.name} size={34} className="rounded-lg" />{c.name}</span>}
        meta={
          <>
            <StatusBadge kind="client" status={c.status} />
            {c.industry && <span className="text-[13px] text-muted">{c.industry}</span>}
            {c.owner_detail && <span className="text-[13px] text-muted">· Account owner {c.owner_detail.full_name}</span>}
          </>
        }
        actions={
          <>
            {!archived && <Button variant="outline" asChild><Link to={`/projects?new=1&client=${c.id}`}><FolderKanban /> New project</Link></Button>}
            {permissions.billing && !archived && <Button variant="outline" asChild><Link to={`/invoices/new?client=${c.id}`}><Receipt /> New invoice</Link></Button>}
            <Button variant="outline" onClick={() => setEditing(true)}><Pencil /> Edit</Button>
            {archived ? (
              <Button
                variant="outline"
                onClick={async () => {
                  await api.post(`/clients/${c.id}/restore/`);
                  queryClient.invalidateQueries({ queryKey: ["client", clientId] });
                  toast.success("Client restored");
                }}
              >
                <ArchiveRestore /> Restore
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setArchiving(true)} aria-label="Archive client"><Archive /></Button>
            )}
          </>
        }
      />

      {permissions.billing && d.outstanding && (
        <div className="mb-6 grid gap-4 sm:grid-cols-3">
          <StatCard label="Outstanding" value={<MoneyList list={d.outstanding} empty={formatMoney(0, c.currency)} />} />
          <StatCard label="Overdue" value={<MoneyList list={d.overdue} empty={formatMoney(0, c.currency)} />} tone={d.overdue?.length ? "danger" : "default"} />
          <StatCard label="Paid to date" value={<MoneyList list={d.lifetime_paid} empty={formatMoney(0, c.currency)} />} tone="success" />
        </div>
      )}

      <Tabs defaultValue="overview">
        <TabsList className="mb-5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="documents">Documents ({d.documents.length})</TabsTrigger>
          {permissions.billing && <TabsTrigger value="billing">Invoices & payments</TabsTrigger>}
        </TabsList>
        <TabsContent value="overview">
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <Card>
                <CardHeader>
                  <div><CardTitle>Projects</CardTitle><CardDescription>{d.projects.length} projects</CardDescription></div>
                </CardHeader>
                {d.projects.length ? (
                  <ul className="divide-y divide-border border-t border-border">
                    {d.projects.map((p) => (
                      <li key={p.id}>
                        <Link to={`/projects/${p.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2">
                          <span className="font-mono text-xs text-muted">{p.code}</span>
                          <span className="flex-1 truncate text-[13px] font-medium">{p.name}</span>
                          <span className="hidden text-xs text-muted sm:inline">{p.manager}</span>
                          <StatusBadge kind="project" status={p.status} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState compact title="No projects yet" action={!archived && <Button size="sm" asChild><Link to={`/projects?new=1&client=${c.id}`}><Plus /> New project</Link></Button>} />
                )}
              </Card>
              {c.notes && (
                <Card>
                  <CardHeader><div><CardTitle>Internal notes</CardTitle><CardDescription>Never shown to the client</CardDescription></div></CardHeader>
                  <CardContent><p className="whitespace-pre-wrap text-[13px] leading-relaxed">{c.notes}</p></CardContent>
                </Card>
              )}
            </div>
            <div className="space-y-6">
              <Card>
                <CardHeader><CardTitle>Contact & billing</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <DefinitionList
                    className="sm:grid-cols-1"
                    items={[
                      { label: "Primary contact", value: c.contact_name },
                      { label: "Email", value: c.email && <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 text-primary hover:underline"><Mail className="size-3.5" />{c.email}</a> },
                      { label: "Phone", value: c.phone && <span className="inline-flex items-center gap-1"><Phone className="size-3.5 text-muted" />{c.phone}</span> },
                      { label: "Billing email", value: c.billing_email },
                      { label: "Billing address", value: [c.address_line1, c.address_line2, [c.city, c.state, c.postal_code].filter(Boolean).join(" "), c.country].filter(Boolean).join(", ") },
                      { label: "Currency · terms", value: `${c.currency} · ${c.payment_terms_days !== null ? `Net ${c.payment_terms_days}` : "workspace default terms"}` },
                      { label: "Tax ID", value: c.tax_id },
                    ]}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <div><CardTitle>Client portal</CardTitle><CardDescription>Who can sign, approve and pay online</CardDescription></div>
                  {!archived && <InviteContact client={c} />}
                </CardHeader>
                <CardContent>
                  {d.portal_users.length ? (
                    <ul className="space-y-2">
                      {d.portal_users.map((u) => (
                        <li key={u.id} className="flex items-center gap-2 text-[13px]">
                          <Avatar name={u.name} size={24} />
                          <span className="min-w-0 flex-1"><span className="block truncate font-medium">{u.name}</span><span className="block truncate text-xs text-muted">{u.email}</span></span>
                          {u.status !== "active" && <Badge>Deactivated</Badge>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[13px] text-muted">No portal users yet. Invite a contact to share progress, documents and invoices.</p>
                  )}
                </CardContent>
              </Card>
              {d.leads.length > 0 && (
                <Card>
                  <CardHeader><CardTitle>Opportunities</CardTitle></CardHeader>
                  <CardContent>
                    <ul className="space-y-2">
                      {d.leads.map((l) => (
                        <li key={l.id} className="flex items-center gap-2 text-[13px]">
                          <span className="flex-1 truncate">{l.title}</span>
                          <span className="tabular text-muted">{formatMoney(l.value, l.currency, { compact: true })}</span>
                          <StatusBadge kind="lead" status={l.stage} />
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </TabsContent>
        <TabsContent value="timeline">
          <Card>
            <CardHeader>
              <div><CardTitle>Relationship timeline</CardTitle><CardDescription>Interactions, project events, documents and billing in one chronological view</CardDescription></div>
              <LogInteraction clientId={c.id} />
            </CardHeader>
            <CardContent>
              {timeline.data?.length ? (
                <ol className="relative space-y-5 border-l border-border pl-5">
                  {timeline.data.map((item) => (
                    <li key={item.id} className="relative">
                      <span className="absolute -left-[25px] top-1 size-2.5 rounded-full border-2 border-surface bg-border-strong" style={item.type === "interaction" ? { backgroundColor: "var(--primary)" } : undefined} />
                      {item.type === "interaction" ? (
                        <div>
                          <p className="text-[13px]"><Badge tone="primary" className="mr-2 capitalize">{item.data.kind}</Badge><span className="font-medium">{item.data.author?.full_name ?? "Someone"}</span></p>
                          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed">{item.data.summary}</p>
                          <p className="mt-1 text-xs text-muted">
                            {formatDateTime(item.data.occurred_at)}
                            {item.data.follow_up_date && ` · follow up ${formatDate(item.data.follow_up_date)}`}
                          </p>
                        </div>
                      ) : (
                        <div>
                          <p className="text-[13px]"><span className="font-medium">{item.data.actor?.full_name ?? "System"}</span> <span className="text-muted">{activityText(item.data)}</span></p>
                          <p className="mt-0.5 text-xs text-muted" title={formatDateTime(item.at)}>{relativeTime(item.at)}</p>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState compact title="No history yet" />
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="documents">
          <Card>
            <CardHeader>
              <div><CardTitle>Contracts & proposals</CardTitle></div>
              <Button size="sm" variant="outline" asChild><Link to={`/documents?new=1&client=${c.id}`}><Plus /> New document</Link></Button>
            </CardHeader>
            {d.documents.length ? (
              <Table>
                <THead><tr><TH>Title</TH><TH>Type</TH><TH>Status</TH><TH className="hidden sm:table-cell">Sent</TH><TH className="hidden sm:table-cell">Signed</TH></tr></THead>
                <TBody>
                  {d.documents.map((doc) => (
                    <TR key={doc.id}>
                      <TD><Link to={`/documents/${doc.id}`} className="font-medium hover:text-primary">{doc.title}</Link></TD>
                      <TD className="capitalize text-muted">{doc.kind}</TD>
                      <TD><StatusBadge kind="document" status={doc.status} /></TD>
                      <TD className="hidden text-muted sm:table-cell">{formatDate(doc.sent_at)}</TD>
                      <TD className="hidden text-muted sm:table-cell">{formatDate(doc.signed_at)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <EmptyState compact title="No documents" />
            )}
          </Card>
        </TabsContent>
        {permissions.billing && (
          <TabsContent value="billing">
            <div className="grid gap-6 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader><CardTitle>Invoices</CardTitle></CardHeader>
                {d.invoices?.length ? (
                  <Table>
                    <THead><tr><TH>Number</TH><TH>Status</TH><TH className="hidden sm:table-cell">Issued</TH><TH className="hidden sm:table-cell">Due</TH><TH className="text-right">Total</TH><TH className="text-right">Balance</TH></tr></THead>
                    <TBody>
                      {d.invoices.map((i) => (
                        <TR key={i.id}>
                          <TD><Link to={`/invoices/${i.id}`} className="font-medium hover:text-primary">{i.number}</Link></TD>
                          <TD><StatusBadge kind="invoice" status={i.status} /></TD>
                          <TD className="hidden text-muted sm:table-cell">{formatDate(i.issue_date)}</TD>
                          <TD className="hidden text-muted sm:table-cell">{formatDate(i.due_date)}</TD>
                          <TD className="text-right tabular">{formatMoney(i.total, i.currency)}</TD>
                          <TD className="text-right font-medium tabular">{formatMoney(i.amount_due, i.currency)}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                ) : (
                  <EmptyState compact title="No invoices yet" />
                )}
              </Card>
              <Card>
                <CardHeader><CardTitle>Payment history</CardTitle></CardHeader>
                <CardContent>
                  {d.payments?.length ? (
                    <ul className="space-y-3">
                      {d.payments.map((p) => (
                        <li key={p.id} className="flex items-center justify-between gap-2 text-[13px]">
                          <span><span className="font-medium">{p.invoice_number}</span><span className="block text-xs capitalize text-muted">{formatDate(p.received_at)} · {p.method.replace("_", " ")}</span></span>
                          <span className="font-medium tabular text-success">{formatMoney(p.amount, p.currency)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[13px] text-muted">No payments recorded.</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        )}
      </Tabs>
      <ClientFormDialog open={editing} onOpenChange={setEditing} client={c} />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title={`Archive ${c.name}?`}
        description="Archived clients are hidden from lists and their portal users lose access. Projects, invoices and history are kept and you can restore the client at any time."
        confirmLabel="Archive client"
        onConfirm={async () => {
          try {
            await api.post(`/clients/${c.id}/archive/`);
            queryClient.invalidateQueries({ queryKey: ["client", clientId] });
            queryClient.invalidateQueries({ queryKey: ["clients"] });
            toast.success("Client archived");
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setArchiving(false);
          }
        }}
      />
    </>
  );
}
