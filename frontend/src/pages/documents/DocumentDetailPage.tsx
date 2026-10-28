import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, Eye, FilePen, Plus, Save, Send, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import * as React from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { ErrorState, PageHeader, PageLoader } from "@/components/common/layout-bits";
import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import type { DocumentRecord } from "@/lib/types";
import { uid } from "@/lib/utils";

import { PLACEHOLDERS } from "./DocumentsPage";

interface Detail extends DocumentRecord {
  versions: { version: number; content_hash: string; created_at: string }[];
  signatures: { id: number; version_number: number; content_hash: string; signer_name: string; signer_email: string; signer_title: string; method: string; signature_image: string; consent_text: string; ip_address: string | null; user_agent: string; signed_at: string }[];
  events: { sequence: number; event: string; actor_label: string; version: number; details: Record<string, unknown>; ip_address: string | null; created_at: string; previous_hash: string; hash: string }[];
  audit: { valid: boolean; broken_at: number | null };
  esign: { name: string; label: string; legal_notice: string };
  portal_contacts: { id: number; name: string; email: string }[];
}

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "SGD", "INR", "ZAR", "AED"];

function Editor({ doc, onSaved }: { doc: Detail; onSaved: () => void }) {
  const [v, setV] = React.useState({ title: doc.title, body: doc.body, scope: doc.scope, payment_terms: doc.payment_terms, milestones_summary: doc.milestones_summary, expires_at: doc.expires_at ?? "", currency: doc.currency });
  const [items, setItems] = React.useState(doc.pricing_items.map((i) => ({ key: uid(), ...i })));
  const [busy, setBusy] = React.useState(false);
  const total = items.reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unit_price || 0), 0);
  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/documents/${doc.id}/`, { ...v, expires_at: v.expires_at || null, pricing_items: items.map(({ description, quantity, unit_price }) => ({ description, quantity, unit_price })) });
      toast.success("Draft saved");
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <div><CardTitle>Edit draft</CardTitle><CardDescription>Use Markdown. Placeholders like {"{{client.name}}"} are resolved in the preview and frozen when sent.</CardDescription></div>
        <Button onClick={save} loading={busy}><Save /> Save draft</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label="Title" htmlFor="doc-title"><Input id="doc-title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
        <Field label="Body" htmlFor="doc-body" hint={<span className="flex flex-wrap gap-1">{PLACEHOLDERS.map((p) => <button type="button" key={p} className="rounded bg-subtle px-1 font-mono text-[10px] hover:text-fg" onClick={() => setV({ ...v, body: `${v.body}{{${p}}}` })}>{p}</button>)}</span>}>
          <Textarea id="doc-body" rows={14} className="font-mono text-xs" value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} />
        </Field>
        <Field label="Scope of work ({{scope}})" htmlFor="doc-scope"><Textarea id="doc-scope" rows={4} value={v.scope} onChange={(e) => setV({ ...v, scope: e.target.value })} /></Field>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[13px] font-medium">Pricing ({"{{pricing_table}}"} / {"{{total}}"})</p>
            <Select className="h-8 w-24 text-xs" aria-label="Currency" value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
          </div>
          <div className="space-y-2">
            {items.map((it, i) => (
              <div key={it.key} className="grid grid-cols-[1fr_5rem_7rem_2rem] gap-2">
                <Input aria-label="Item" placeholder="Item" value={it.description} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                <Input aria-label="Quantity" type="number" step="0.01" value={it.quantity} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                <Input aria-label="Unit price" type="number" step="0.01" value={it.unit_price} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, unit_price: e.target.value } : x)))} />
                <Button variant="ghost" size="icon-sm" aria-label="Remove item" onClick={() => setItems(items.filter((_, j) => j !== i))}><Trash2 /></Button>
              </div>
            ))}
            <div className="flex items-center justify-between">
              <Button size="sm" variant="outline" onClick={() => setItems([...items, { key: uid(), description: "", quantity: "1", unit_price: "0" }])}><Plus /> Add item</Button>
              <span className="text-[13px] text-muted">Total <strong className="tabular text-fg">{formatMoney(total, v.currency)}</strong></span>
            </div>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Payment terms ({{payment_terms}})" htmlFor="doc-terms"><Textarea id="doc-terms" rows={3} value={v.payment_terms} onChange={(e) => setV({ ...v, payment_terms: e.target.value })} /></Field>
          <Field label="Milestones ({{milestones}})" htmlFor="doc-ms"><Textarea id="doc-ms" rows={3} value={v.milestones_summary} onChange={(e) => setV({ ...v, milestones_summary: e.target.value })} /></Field>
        </div>
        <Field label="Respond by" htmlFor="doc-exp" className="sm:w-56"><Input id="doc-exp" type="date" value={v.expires_at} onChange={(e) => setV({ ...v, expires_at: e.target.value })} /></Field>
      </CardContent>
    </Card>
  );
}

function Preview({ docId, refreshKey }: { docId: number; refreshKey: number }) {
  const query = useQuery({ queryKey: ["document-preview", docId, refreshKey], queryFn: () => api.get<{ html: string; content_hash: string; version: number | null }>(`/documents/${docId}/preview/`) });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{query.data?.version ? `Version ${query.data.version}` : "Preview"}</CardTitle>
          {query.data && <CardDescription className="break-all font-mono text-[11px]">SHA-256 {query.data.content_hash}</CardDescription>}
        </div>
      </CardHeader>
      <CardContent>
        {/* Server-rendered and sanitised (nh3) HTML. */}
        <div className="om-document max-w-none" dangerouslySetInnerHTML={{ __html: query.data?.html ?? "" }} />
      </CardContent>
    </Card>
  );
}

const EVENT_LABEL: Record<string, string> = { created: "Draft created", sent: "Sent for signature", viewed: "Viewed by client", signed: "Signed", declined: "Declined", revised: "Revised (new version)", expired: "Expired" };

export function DocumentDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [sending, setSending] = React.useState(false);
  const [signer, setSigner] = React.useState("");
  const [revising, setRevising] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const key = ["document", Number(id)];
  const query = useQuery({ queryKey: key, queryFn: () => api.get<Detail>(`/documents/${id}/`) });
  if (query.isLoading) return <PageLoader />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const doc = query.data;
  const draft = doc.status === "draft";
  const refresh = () => { queryClient.invalidateQueries({ queryKey: key }); queryClient.invalidateQueries({ queryKey: ["documents"] }); setRefreshKey((k) => k + 1); };
  const signature = doc.signatures.find((s) => s.version_number === doc.current_version);

  return (
    <>
      <PageHeader
        back={{ to: "/documents", label: "Documents" }}
        title={doc.title}
        meta={<><StatusBadge kind="document" status={doc.status} /><span className="text-[13px] capitalize text-muted">{doc.kind} · {doc.client_name}{doc.project_code ? ` · ${doc.project_code}` : ""}{doc.current_version ? ` · v${doc.current_version}` : ""}</span></>}
        actions={
          <>
            <Button variant="outline" asChild><a href={`/api/documents/${doc.id}/pdf/`}><Download /> PDF</a></Button>
            {draft && doc.current_version === 0 && <Button variant="ghost" onClick={() => setDeleting(true)} aria-label="Delete draft"><Trash2 /></Button>}
            {!draft && doc.status !== "signed" && <Button variant="outline" onClick={() => setRevising(true)}><FilePen /> Revise</Button>}
            {draft && <Button onClick={() => { setSigner(String(doc.portal_contacts[0]?.id ?? "")); setSending(true); }} data-testid="send-document"><Send /> Send for signature</Button>}
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          {draft ? (
            <Tabs defaultValue="edit">
              <TabsList className="mb-4"><TabsTrigger value="edit"><FilePen className="size-3.5" /> Edit</TabsTrigger><TabsTrigger value="preview"><Eye className="size-3.5" /> Preview</TabsTrigger></TabsList>
              <TabsContent value="edit"><Editor doc={doc} onSaved={refresh} /></TabsContent>
              <TabsContent value="preview"><Preview docId={doc.id} refreshKey={refreshKey} /></TabsContent>
            </Tabs>
          ) : (
            <Preview docId={doc.id} refreshKey={refreshKey} />
          )}
          {signature && (
            <Card>
              <CardHeader><div><CardTitle>Electronic acceptance</CardTitle><CardDescription>{doc.esign.label}</CardDescription></div><Badge tone="success"><CheckCircle2 className="size-3" /> Signed</Badge></CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-lg border border-border bg-surface-2 p-4">
                  {signature.method === "drawn" && signature.signature_image ? (
                    <img src={signature.signature_image} alt={`Signature of ${signature.signer_name}`} className="h-16 object-contain dark:invert" />
                  ) : (
                    <p className="font-serif text-3xl italic">{signature.signer_name}</p>
                  )}
                  <p className="mt-2 text-[13px] font-medium">{signature.signer_name}{signature.signer_title ? `, ${signature.signer_title}` : ""}</p>
                  <p className="text-xs text-muted">{signature.signer_email}</p>
                </div>
                <dl className="space-y-1.5 text-xs">
                  <div><dt className="text-muted">Signed at</dt><dd>{formatDateTime(signature.signed_at)}</dd></div>
                  <div><dt className="text-muted">IP address</dt><dd>{signature.ip_address ?? "—"}</dd></div>
                  <div><dt className="text-muted">Version · method</dt><dd>v{signature.version_number} · {signature.method}</dd></div>
                  <div><dt className="text-muted">Content hash</dt><dd className="break-all font-mono text-[10px]">{signature.content_hash}</dd></div>
                </dl>
                <p className="text-xs text-muted sm:col-span-2">Consent recorded: “{signature.consent_text}”</p>
              </CardContent>
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-[13px]">
              <div className="flex justify-between"><span className="text-muted">Value</span><span className="tabular">{formatMoney(doc.total_amount, doc.currency)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Signer</span><span>{doc.signer_name ?? "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted">Respond by</span><span>{formatDate(doc.expires_at)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Sent</span><span>{formatDateTime(doc.sent_at)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Viewed</span><span>{formatDateTime(doc.viewed_at)}</span></div>
              {doc.status === "declined" && <p className="rounded-md bg-danger-soft px-3 py-2 text-danger">Declined: {doc.decline_reason}</p>}
              {!doc.portal_contacts.length && draft && <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">Invite a contact from {doc.client_name} to the client portal before sending.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <div><CardTitle>Audit trail</CardTitle><CardDescription>Hash-chained events</CardDescription></div>
              {doc.audit.valid ? <Badge tone="success"><ShieldCheck className="size-3" /> Verified</Badge> : <Badge tone="danger"><ShieldAlert className="size-3" /> Broken at #{doc.audit.broken_at}</Badge>}
            </CardHeader>
            <CardContent>
              <ol className="space-y-3">
                {doc.events.map((e) => (
                  <li key={e.sequence} className="text-[13px]">
                    <p><span className="font-medium">{EVENT_LABEL[e.event] ?? e.event}</span>{e.version ? <span className="text-muted"> · v{e.version}</span> : null}</p>
                    <p className="text-xs text-muted">{e.actor_label || "System"} · {formatDateTime(e.created_at)}{e.ip_address ? ` · ${e.ip_address}` : ""}</p>
                    <p className="truncate font-mono text-[10px] text-muted" title={e.hash}>{e.hash}</p>
                  </li>
                ))}
              </ol>
              <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-muted">{doc.esign.legal_notice}</p>
            </CardContent>
          </Card>
        </div>
      </div>
      <Dialog open={sending} onOpenChange={setSending}>
        <DialogContent size="sm">
          <DialogHeader title="Send for signature" description="The current draft is frozen as a new version, hashed, and shared in the client portal. You can revise later, which invalidates unsigned versions." />
          <DialogBody>
            <Field label="Signer" htmlFor="signer">
              <Select id="signer" value={signer} onChange={(e) => setSigner(e.target.value)}>
                {doc.portal_contacts.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.email})</option>)}
              </Select>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSending(false)}>Cancel</Button>
            <Button
              disabled={!doc.portal_contacts.length}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.post(`/documents/${doc.id}/send/`, { signer: signer ? Number(signer) : undefined });
                  toast.success("Document sent to the client portal");
                  setSending(false);
                  refresh();
                } catch (err) {
                  toast.error(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Send /> Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={revising}
        onOpenChange={setRevising}
        title="Revise this document?"
        description="It returns to draft so you can edit it. The client can't sign the current version until you send the new one. Previous versions stay in the audit trail."
        confirmLabel="Revise"
        tone="primary"
        onConfirm={async () => {
          try {
            await api.post(`/documents/${doc.id}/revise/`);
            setRevising(false);
            refresh();
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this draft?"
        confirmLabel="Delete"
        onConfirm={async () => {
          try {
            await api.delete(`/documents/${doc.id}/`);
            queryClient.invalidateQueries({ queryKey: ["documents"] });
            navigate("/documents");
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />
    </>
  );
}
