import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileSignature, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

import { EmptyState, FilterBar, PageHeader, Pagination, QueryState, SearchInput } from "@/components/common/layout-bits";
import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { Badge, Card, CardContent, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { useApiMutation, useClientOptions, useDebounced, useProjectOptions } from "@/hooks/data";
import { api, ApiError, errorMessage, type Paginated } from "@/lib/api";
import { formatDate, formatMoney } from "@/lib/format";
import type { DocumentRecord } from "@/lib/types";
import { toQuery } from "@/lib/utils";

export interface Template {
  id: number;
  name: string;
  kind: "contract" | "proposal";
  description: string;
  body: string;
  default_payment_terms: string;
  usage_count: number;
}

export const PLACEHOLDERS = [
  "client.name", "client.contact_name", "client.address", "organization.name", "project.name", "project.code",
  "project.deadline", "project.budget", "today", "expires_at", "scope", "payment_terms", "milestones", "total", "pricing_table",
];

function NewDocumentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const clients = useClientOptions(open);
  const projects = useProjectOptions({ enabled: open, includeClosed: true });
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api.get<Template[]>("/contract-templates/"), enabled: open });
  const [v, setV] = React.useState({ template: "", title: "", client: params.get("client") ?? "", project: "", expires_at: "" });
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const template = templates.data?.find((t) => String(t.id) === v.template);
  React.useEffect(() => {
    if (open && templates.data?.length && !v.template) setV((s) => ({ ...s, template: String(templates.data![0].id) }));
  }, [open, templates.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title="New contract or proposal" description="Start from a template; placeholders are filled from the client and project." />
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErrors({});
            try {
              const doc = await api.post<DocumentRecord>("/documents/", {
                template: v.template ? Number(v.template) : null, kind: template?.kind ?? "contract", title: v.title,
                client: Number(v.client), project: v.project ? Number(v.project) : null, expires_at: v.expires_at || null,
                body: template ? "" : "# Agreement\n\nWrite your document here.",
              });
              toast.success("Draft created");
              navigate(`/documents/${doc.id}`);
            } catch (err) {
              if (err instanceof ApiError) setErrors(err.fields);
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogBody className="grid gap-4">
            <Field label="Template" htmlFor="d-template">
              <Select id="d-template" value={v.template} onChange={(e) => setV({ ...v, template: e.target.value })}>
                <option value="">Blank document</option>
                {templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.kind})</option>)}
              </Select>
            </Field>
            <Field label="Title" htmlFor="d-title" required error={errors.title?.[0]}><Input id="d-title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} placeholder="e.g. Services agreement – Website redesign" required /></Field>
            <Field label="Client" htmlFor="d-client" required error={errors.client?.[0]}>
              <Select id="d-client" value={v.client} onChange={(e) => setV({ ...v, client: e.target.value, project: "" })} required>
                <option value="">Select…</option>
                {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Project" htmlFor="d-project" error={errors.project?.[0]}>
              <Select id="d-project" value={v.project} onChange={(e) => setV({ ...v, project: e.target.value })}>
                <option value="">None</option>
                {projects.data?.filter((p) => String(p.client) === v.client).map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
              </Select>
            </Field>
            <Field label="Respond by" htmlFor="d-exp" hint="After this date the document expires and can no longer be signed."><Input id="d-exp" type="date" value={v.expires_at} onChange={(e) => setV({ ...v, expires_at: e.target.value })} /></Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={busy}>Create draft</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TemplateDialog({ open, onOpenChange, template }: { open: boolean; onOpenChange: (o: boolean) => void; template?: Template | null }) {
  const queryClient = useQueryClient();
  const [v, setV] = React.useState({ name: "", kind: "contract", description: "", body: "", default_payment_terms: "" });
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) setV(template ? { name: template.name, kind: template.kind, description: template.description, body: template.body, default_payment_terms: template.default_payment_terms } : { name: "", kind: "contract", description: "", body: "# Title\n\nAgreement between {{organization.name}} and {{client.name}}.\n\n## Scope\n{{scope}}\n\n{{pricing_table}}\n\n## Payment terms\n{{payment_terms}}\n", default_payment_terms: "" });
  }, [open, template]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader title={template ? `Edit template · ${template.name}` : "New template"} description="Markdown with {{placeholders}}. Documents keep their own copy, so editing a template never changes sent documents." />
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              if (template) await api.patch(`/contract-templates/${template.id}/`, v);
              else await api.post("/contract-templates/", v);
              queryClient.invalidateQueries({ queryKey: ["templates"] });
              toast.success("Template saved");
              onOpenChange(false);
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogBody className="grid gap-4 lg:grid-cols-[1fr_14rem]">
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
                <Field label="Name" htmlFor="t-name" required><Input id="t-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required /></Field>
                <Field label="Type" htmlFor="t-kind"><Select id="t-kind" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}><option value="contract">Contract</option><option value="proposal">Proposal</option></Select></Field>
              </div>
              <Field label="Description" htmlFor="t-desc"><Input id="t-desc" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
              <Field label="Body (Markdown)" htmlFor="t-body" required><Textarea id="t-body" rows={16} className="font-mono text-xs" value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} required /></Field>
              <Field label="Default payment terms" htmlFor="t-terms"><Textarea id="t-terms" rows={2} value={v.default_payment_terms} onChange={(e) => setV({ ...v, default_payment_terms: e.target.value })} /></Field>
            </div>
            <div>
              <p className="mb-2 text-[13px] font-medium">Placeholders</p>
              <ul className="space-y-1">
                {PLACEHOLDERS.map((p) => (
                  <li key={p}>
                    <button type="button" className="w-full rounded px-2 py-1 text-left font-mono text-[11px] text-muted hover:bg-subtle hover:text-fg" onClick={() => setV({ ...v, body: `${v.body}{{${p}}}` })}>{`{{${p}}}`}</button>
                  </li>
                ))}
              </ul>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={busy}>Save template</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TemplatesTab() {
  const query = useQuery({ queryKey: ["templates"], queryFn: () => api.get<Template[]>("/contract-templates/") });
  const [editing, setEditing] = React.useState<Template | null | undefined>(undefined);
  const [deleting, setDeleting] = React.useState<Template | null>(null);
  const remove = useApiMutation((id: number) => api.delete(`/contract-templates/${id}/`), { success: "Template removed", invalidate: [["templates"]], onSuccess: () => setDeleting(null) });
  return (
    <>
      <div className="mb-4 flex justify-end"><Button onClick={() => setEditing(null)}><Plus /> New template</Button></div>
      <QueryState query={query} empty={!query.data?.length && <Card><EmptyState icon={FileText} title="No templates" /></Card>}>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {query.data?.map((t) => (
            <Card key={t.id} className="flex flex-col p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[13px] font-semibold">{t.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{t.description || "No description"}</p>
                </div>
                <Badge tone={t.kind === "contract" ? "primary" : "info"} className="capitalize">{t.kind}</Badge>
              </div>
              <p className="mt-3 line-clamp-3 flex-1 whitespace-pre-line font-mono text-[11px] text-muted">{t.body.slice(0, 220)}</p>
              <div className="mt-4 flex items-center justify-between">
                <span className="text-xs text-muted">Used by {t.usage_count} document{t.usage_count === 1 ? "" : "s"}</span>
                <div className="flex gap-1">
                  <Button size="icon-sm" variant="ghost" aria-label="Edit template" onClick={() => setEditing(t)}><Pencil /></Button>
                  <Button size="icon-sm" variant="ghost" aria-label="Delete template" onClick={() => setDeleting(t)}><Trash2 /></Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </QueryState>
      <TemplateDialog open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)} template={editing ?? null} />
      <ConfirmDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)} title="Remove this template?" description="Templates used by documents are archived instead of deleted." confirmLabel="Remove" loading={remove.isPending} onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </>
  );
}

export function DocumentsPage() {
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = React.useState(params.get("new") === "1");
  const [search, setSearch] = React.useState("");
  const debounced = useDebounced(search);
  const tab = params.get("tab") ?? "documents";
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== "page") next.delete("page");
    setParams(next, { replace: true });
  };
  const qs = toQuery({ search: debounced, status: params.get("status"), kind: params.get("kind"), client: params.get("client"), page: params.get("page") });
  const query = useQuery({ queryKey: ["documents", qs], queryFn: () => api.get<Paginated<DocumentRecord>>(`/documents/${qs}`), enabled: tab === "documents" });
  const docs = query.data?.results ?? [];
  return (
    <>
      <PageHeader title="Documents & contracts" description="Proposals and agreements with auditable electronic acceptance by your clients." actions={<Button onClick={() => setCreating(true)}><Plus /> New document</Button>} />
      <Tabs value={tab} onValueChange={(t) => set("tab", t === "documents" ? "" : t)}>
        <TabsList className="mb-4">
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
        </TabsList>
        <TabsContent value="documents">
          <Card>
            <FilterBar>
              <SearchInput value={search} onChange={setSearch} placeholder="Search title or client…" />
              <Select aria-label="Status" value={params.get("status") ?? ""} onChange={(e) => set("status", e.target.value)} className="sm:w-44">
                <option value="">All statuses</option>
                <option value="draft">Draft</option>
                <option value="sent,viewed">Awaiting signature</option>
                <option value="signed">Signed</option>
                <option value="declined">Declined</option>
                <option value="expired">Expired</option>
              </Select>
              <Select aria-label="Type" value={params.get("kind") ?? ""} onChange={(e) => set("kind", e.target.value)} className="sm:w-36">
                <option value="">All types</option>
                <option value="contract">Contracts</option>
                <option value="proposal">Proposals</option>
              </Select>
            </FilterBar>
            <QueryState query={query} empty={docs.length === 0 && <EmptyState icon={FileSignature} title="No documents" description="Create a contract or proposal from a template." action={<Button onClick={() => setCreating(true)}><Plus /> New document</Button>} />}>
              <Table>
                <THead>
                  <tr>
                    <TH>Document</TH>
                    <TH>Client</TH>
                    <TH className="hidden md:table-cell">Value</TH>
                    <TH>Status</TH>
                    <TH className="hidden lg:table-cell">Sent</TH>
                    <TH className="hidden lg:table-cell">Signed / expires</TH>
                  </tr>
                </THead>
                <TBody>
                  {docs.map((d) => (
                    <TR key={d.id}>
                      <TD>
                        <Link to={`/documents/${d.id}`} className="font-medium hover:text-primary">{d.title}</Link>
                        <span className="block text-xs capitalize text-muted">{d.kind}{d.project_code ? ` · ${d.project_code}` : ""}{d.current_version ? ` · v${d.current_version}` : ""}</span>
                      </TD>
                      <TD>{d.client_name}</TD>
                      <TD className="hidden tabular md:table-cell">{Number(d.total_amount) ? formatMoney(d.total_amount, d.currency) : "—"}</TD>
                      <TD><StatusBadge kind="document" status={d.status} /></TD>
                      <TD className="hidden text-muted lg:table-cell">{formatDate(d.sent_at)}</TD>
                      <TD className="hidden text-muted lg:table-cell">{d.signed_at ? formatDate(d.signed_at) : d.expires_at ? `Expires ${formatDate(d.expires_at)}` : "—"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              {query.data && <Pagination page={query.data.page} totalPages={query.data.total_pages} count={query.data.count} onPage={(p) => set("page", String(p))} />}
            </QueryState>
          </Card>
          <Card className="mt-4">
            <CardContent className="pt-4 text-xs leading-relaxed text-muted">
              Signatures are captured as explicit electronic acceptance with the signer's identity, IP address, time, the exact document version and its SHA-256 hash, in a tamper-evident audit trail. This is not a qualified electronic signature; connect a dedicated e-signature provider where your jurisdiction requires one.
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="templates"><TemplatesTab /></TabsContent>
      </Tabs>
      <NewDocumentDialog open={creating} onOpenChange={(o) => { setCreating(o); if (!o && params.get("new")) set("new", ""); }} />
    </>
  );
}
