import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileText, MoreHorizontal, Pencil, Plus, RotateCcw, Send, Trash2, Wallet, X } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import { EmptyState, FilterBar, PageHeader, Pagination, QueryState } from "@/components/common/layout-bits";
import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Tabs, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { Avatar, Badge, Card, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { useApiMutation, useExpenseCategories, useProjectOptions } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { api, ApiError, errorMessage, type Paginated } from "@/lib/api";
import { formatDate, formatMoney, isoDate } from "@/lib/format";
import type { Expense } from "@/lib/types";
import { toQuery } from "@/lib/utils";

const KEYS = [["expenses"], ["project"], ["dashboard"], ["revenue-leak"]];
const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "SGD", "INR", "ZAR", "AED"];

function ExpenseDialog({ open, onOpenChange, expense, defaultProject }: { open: boolean; onOpenChange: (o: boolean) => void; expense?: Expense | null; defaultProject?: number }) {
  const queryClient = useQueryClient();
  const { org } = useAuth();
  const projects = useProjectOptions({ enabled: open });
  const categories = useExpenseCategories();
  const [v, setV] = React.useState({ project: "", category: "", vendor: "", description: "", date: isoDate(new Date()), amount: "", currency: org.default_currency, billable: false, billable_amount: "" });
  const [file, setFile] = React.useState<File | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setErrors({});
    setFile(null);
    setV(expense ? {
      project: expense.project ? String(expense.project) : "", category: expense.category ? String(expense.category) : "", vendor: expense.vendor,
      description: expense.description, date: expense.date, amount: expense.amount, currency: expense.currency, billable: expense.billable,
      billable_amount: expense.billable ? expense.billable_amount : "",
    } : { project: defaultProject ? String(defaultProject) : "", category: "", vendor: "", description: "", date: isoDate(new Date()), amount: "", currency: org.default_currency, billable: false, billable_amount: "" });
  }, [open, expense, defaultProject, org.default_currency]);
  const project = projects.data?.find((p) => String(p.id) === v.project);
  React.useEffect(() => { if (project) setV((s) => ({ ...s, currency: project.currency })); }, [project]);
  const set = (k: keyof typeof v, value: string | boolean) => setV((s) => ({ ...s, [k]: value }));
  const markup = v.billable && v.amount && v.billable_amount ? ((Number(v.billable_amount) / Number(v.amount) - 1) * 100) : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title={expense ? "Edit expense" : "New expense"} description="Record what it cost the company; for billable expenses, set what the client should be charged." />
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErrors({});
            const form = new FormData();
            form.append("description", v.description);
            form.append("date", v.date);
            form.append("amount", v.amount);
            form.append("currency", v.currency);
            form.append("vendor", v.vendor);
            form.append("billable", String(v.billable));
            form.append("project", v.project); // empty string clears the relation
            form.append("category", v.category);
            if (v.billable && v.billable_amount) form.append("billable_amount", v.billable_amount);
            if (file) form.append("receipt", file);
            try {
              if (expense) await api.patch(`/expenses/${expense.id}/`, form);
              else await api.post("/expenses/", form);
              for (const k of KEYS) queryClient.invalidateQueries({ queryKey: k });
              toast.success(expense ? "Expense updated" : "Expense saved as draft");
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
            {expense?.status === "rejected" && <p className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger sm:col-span-2">Rejected: {expense.rejection_reason}</p>}
            <Field label="Description" htmlFor="x-desc" required className="sm:col-span-2" error={errors.description?.[0]}><Input id="x-desc" value={v.description} onChange={(e) => set("description", e.target.value)} required autoFocus /></Field>
            <Field label="Project" htmlFor="x-project" error={errors.project?.[0]} hint="Required for billable expenses.">
              <Select id="x-project" value={v.project} onChange={(e) => set("project", e.target.value)}>
                <option value="">No project (internal)</option>
                {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
              </Select>
            </Field>
            <Field label="Category" htmlFor="x-cat">
              <Select id="x-cat" value={v.category} onChange={(e) => set("category", e.target.value)}>
                <option value="">Uncategorized</option>
                {categories.data?.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Vendor" htmlFor="x-vendor"><Input id="x-vendor" value={v.vendor} onChange={(e) => set("vendor", e.target.value)} /></Field>
            <Field label="Date" htmlFor="x-date" required><Input id="x-date" type="date" value={v.date} onChange={(e) => set("date", e.target.value)} required /></Field>
            <div className="grid grid-cols-[1fr_6rem] gap-2">
              <Field label="Cost to company" htmlFor="x-amount" required error={errors.amount?.[0]}><Input id="x-amount" type="number" min="0.01" step="0.01" value={v.amount} onChange={(e) => set("amount", e.target.value)} required /></Field>
              <Field label="Currency" htmlFor="x-cur" error={errors.currency?.[0]}>
                <Select id="x-cur" value={v.currency} onChange={(e) => set("currency", e.target.value)} disabled={Boolean(project)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
              </Field>
            </div>
            <Field label="Receipt" htmlFor="x-receipt" hint={expense?.has_receipt ? `Current: ${expense.receipt_name}. Upload to replace.` : "PDF or image, up to 15 MB."} error={errors.receipt?.[0]}>
              <Input id="x-receipt" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <div className="space-y-3 rounded-lg border border-border bg-surface-2 p-3 sm:col-span-2">
              <label className="flex items-center gap-2 text-[13px] font-medium"><Checkbox checked={v.billable} onChange={(e) => set("billable", e.target.checked)} /> Billable to the client</label>
              {v.billable && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Amount to charge the client" htmlFor="x-bill" hint={markup !== null && Number.isFinite(markup) ? `${markup >= 0 ? "+" : ""}${markup.toFixed(1)}% vs cost` : "Defaults to the cost if left blank."} error={errors.billable_amount?.[0]}>
                    <Input id="x-bill" type="number" min="0" step="0.01" value={v.billable_amount} onChange={(e) => set("billable_amount", e.target.value)} placeholder={v.amount} />
                  </Field>
                  <p className="self-end text-xs text-muted">Once approved, it appears in the invoice wizard and Revenue Leak Radar until invoiced.</p>
                </div>
              )}
            </div>
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

export function ExpensesPage() {
  const { user, permissions } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "mine";
  const [editing, setEditing] = React.useState<Expense | null | undefined>(params.get("new") ? null : undefined);
  const [rejecting, setRejecting] = React.useState<Expense | null>(null);
  const [reopening, setReopening] = React.useState<Expense | null>(null);
  const [reason, setReason] = React.useState("");
  const [deleting, setDeleting] = React.useState<Expense | null>(null);
  const projects = useProjectOptions({ includeClosed: true });
  const categories = useExpenseCategories();
  const get = (k: string) => params.get(k) ?? "";
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== "page") next.delete("page");
    next.delete("new");
    setParams(next, { replace: true });
  };
  const qs = toQuery({
    scope: tab === "mine" ? "mine" : "team",
    status: tab === "approvals" ? "submitted" : get("status"),
    project: get("project"), category: get("category"), billable: get("billable"), page: get("page"),
  });
  const query = useQuery({ queryKey: ["expenses", qs], queryFn: () => api.get<Paginated<Expense> & { totals: { currency: string; amount: string; billable: string }[] }>(`/expenses/${qs}`) });
  const submit = useApiMutation((id: number) => api.post(`/expenses/${id}/submit/`), { success: "Submitted for approval", invalidate: KEYS });
  const approve = useApiMutation((id: number) => api.post(`/expenses/${id}/approve/`), { success: "Expense approved", invalidate: KEYS });
  const reject = useApiMutation((args: { id: number; reason: string }) => api.post(`/expenses/${args.id}/reject/`, { reason: args.reason }), { success: "Expense returned", invalidate: KEYS, onSuccess: () => { setRejecting(null); setReason(""); } });
  const reopen = useApiMutation((args: { id: number; reason: string }) => api.post(`/expenses/${args.id}/reopen/`, { reason: args.reason }), { success: "Expense reopened", invalidate: KEYS, onSuccess: () => { setReopening(null); setReason(""); } });
  const remove = useApiMutation((id: number) => api.delete(`/expenses/${id}/`), { success: "Expense deleted", invalidate: KEYS, onSuccess: () => setDeleting(null) });
  const items = query.data?.results ?? [];

  return (
    <>
      <PageHeader title="Expenses" description="Internal costs and client-chargeable expenses, with receipts and approvals." actions={<Button onClick={() => setEditing(null)}><Plus /> New expense</Button>} />
      <Tabs value={tab} onValueChange={(t) => set("tab", t === "mine" ? "" : t)}>
        <TabsList className="mb-4">
          <TabsTrigger value="mine">My expenses</TabsTrigger>
          {permissions.is_manager && <TabsTrigger value="approvals">Approvals</TabsTrigger>}
          {permissions.is_manager && <TabsTrigger value="team">All team expenses</TabsTrigger>}
        </TabsList>
      </Tabs>
      <Card>
        <FilterBar>
          {tab !== "approvals" && (
            <Select aria-label="Status" value={get("status")} onChange={(e) => set("status", e.target.value)} className="sm:w-36">
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="submitted">Submitted</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </Select>
          )}
          <Select aria-label="Project" value={get("project")} onChange={(e) => set("project", e.target.value)} className="sm:w-52">
            <option value="">All projects</option>
            {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </Select>
          <Select aria-label="Category" value={get("category")} onChange={(e) => set("category", e.target.value)} className="sm:w-48">
            <option value="">All categories</option>
            {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select aria-label="Billable" value={get("billable")} onChange={(e) => set("billable", e.target.value)} className="sm:w-36">
            <option value="">Billable & internal</option>
            <option value="true">Billable</option>
            <option value="false">Internal only</option>
          </Select>
          {query.data?.totals.length ? (
            <p className="text-[13px] text-muted sm:ml-auto">
              {query.data.totals.map((t) => <span key={t.currency} className="ml-3 tabular">Cost <strong className="text-fg">{formatMoney(t.amount, t.currency)}</strong> · chargeable {formatMoney(t.billable, t.currency)}</span>)}
            </p>
          ) : null}
        </FilterBar>
        <QueryState query={query} empty={items.length === 0 && <EmptyState icon={Wallet} title={tab === "approvals" ? "No expenses awaiting approval" : "No expenses"} action={tab === "mine" ? <Button onClick={() => setEditing(null)}><Plus /> New expense</Button> : undefined} />}>
          <Table>
            <THead>
              <tr>
                <TH className="w-24">Date</TH>
                {tab !== "mine" && <TH>Submitted by</TH>}
                <TH>Expense</TH>
                <TH className="hidden md:table-cell">Project</TH>
                <TH>Status</TH>
                <TH className="text-right">Cost</TH>
                <TH className="hidden text-right sm:table-cell">Chargeable</TH>
                <TH className="w-24" />
              </tr>
            </THead>
            <TBody>
              {items.map((x) => {
                const own = x.user.id === user.id;
                return (
                  <TR key={x.id}>
                    <TD className="text-[13px] text-muted">{formatDate(x.date, { month: "short", day: "numeric" })}</TD>
                    {tab !== "mine" && <TD><span className="inline-flex items-center gap-2 text-[13px]"><Avatar name={x.user.full_name} size={22} />{x.user.full_name}</span></TD>}
                    <TD>
                      <span className="block text-[13px] font-medium">{x.description}</span>
                      <span className="text-xs text-muted">{x.category_name ?? "Uncategorized"}{x.vendor ? ` · ${x.vendor}` : ""}</span>
                      {x.status === "rejected" && <span className="block text-xs text-danger">{x.rejection_reason}</span>}
                    </TD>
                    <TD className="hidden text-[13px] text-muted md:table-cell">{x.project_detail?.code ?? "Internal"}</TD>
                    <TD>
                      <span className="flex flex-wrap gap-1"><StatusBadge kind="entry" status={x.status} />{x.is_invoiced && <Badge tone="primary">Invoiced</Badge>}</span>
                    </TD>
                    <TD className="text-right text-[13px] tabular">{formatMoney(x.amount, x.currency)}</TD>
                    <TD className="hidden text-right text-[13px] tabular sm:table-cell">{x.billable ? formatMoney(x.billable_amount, x.currency) : <span className="text-muted">Not billable</span>}</TD>
                    <TD>
                      <div className="flex items-center justify-end gap-1">
                        {tab === "approvals" && x.status === "submitted" && (
                          <>
                            <Button size="icon-sm" variant="ghost" className="text-success" aria-label="Approve" onClick={() => approve.mutate(x.id)}><Check /></Button>
                            <Button size="icon-sm" variant="ghost" className="text-danger" aria-label="Reject" onClick={() => { setReason(""); setRejecting(x); }}><X /></Button>
                          </>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Expense actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
                          <DropdownMenuContent>
                            {x.has_receipt && <DropdownMenuItem asChild><a href={`/api/expenses/${x.id}/receipt/?inline=1`} target="_blank" rel="noreferrer"><FileText /> View receipt</a></DropdownMenuItem>}
                            {own && x.can_edit && <DropdownMenuItem onSelect={() => setEditing(x)}><Pencil /> Edit</DropdownMenuItem>}
                            {own && x.can_edit && <DropdownMenuItem onSelect={() => submit.mutate(x.id)}><Send /> Submit for approval</DropdownMenuItem>}
                            {permissions.is_manager && x.status === "submitted" && !own && <DropdownMenuItem onSelect={() => approve.mutate(x.id)}><Check /> Approve</DropdownMenuItem>}
                            {permissions.is_manager && x.status === "submitted" && !own && <DropdownMenuItem onSelect={() => { setReason(""); setRejecting(x); }}><X /> Reject</DropdownMenuItem>}
                            {permissions.is_manager && x.status === "approved" && !x.is_invoiced && <DropdownMenuItem onSelect={() => { setReason(""); setReopening(x); }}><RotateCcw /> Reopen for correction</DropdownMenuItem>}
                            {own && x.can_edit && <DropdownMenuItem destructive onSelect={() => setDeleting(x)}><Trash2 /> Delete</DropdownMenuItem>}
                            {!x.has_receipt && !(own && x.can_edit) && !(permissions.is_manager && ["submitted", "approved"].includes(x.status)) && <DropdownMenuItem disabled>No actions available</DropdownMenuItem>}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          {query.data && <Pagination page={query.data.page} totalPages={query.data.total_pages} count={query.data.count} onPage={(p) => set("page", String(p))} />}
        </QueryState>
      </Card>
      <ExpenseDialog open={editing !== undefined} onOpenChange={(o) => { if (!o) { setEditing(undefined); if (params.get("new")) set("new", ""); } }} expense={editing ?? null} defaultProject={params.get("project") ? Number(params.get("project")) : undefined} />
      <Dialog open={Boolean(rejecting || reopening)} onOpenChange={(o) => { if (!o) { setRejecting(null); setReopening(null); } }}>
        <DialogContent size="sm">
          <DialogHeader title={rejecting ? "Reject expense" : "Reopen approved expense"} description={rejecting ? "The submitter sees your reason and can correct and resubmit." : "Returns it to draft for correction. Recorded in the audit log."} />
          <DialogBody><Field label="Reason" htmlFor="x-reason" required><Textarea id="x-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field></DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRejecting(null); setReopening(null); }}>Cancel</Button>
            <Button
              variant={rejecting ? "danger" : "primary"}
              disabled={!reason.trim()}
              loading={reject.isPending || reopen.isPending}
              onClick={() => (rejecting ? reject.mutate({ id: rejecting.id, reason }) : reopening && reopen.mutate({ id: reopening.id, reason }))}
            >
              {rejecting ? "Reject" : "Reopen"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)} title="Delete this expense?" description="This cannot be undone." confirmLabel="Delete" loading={remove.isPending} onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </>
  );
}
