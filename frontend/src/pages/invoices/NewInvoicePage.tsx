import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, FileStack, Plus, Receipt, Trash2 } from "lucide-react";
import * as React from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

import { EmptyState, LoadingRows, PageHeader } from "@/components/common/layout-bits";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/overlays";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { useClientOptions } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { api, ApiError, errorMessage } from "@/lib/api";
import { formatHours, formatMoney } from "@/lib/format";
import type { Invoice } from "@/lib/types";
import { uid } from "@/lib/utils";

interface UnbilledProject {
  project: { id: number; code: string; name: string; currency: string; project_type: string };
  time_seconds: number;
  time_entries: number;
  time_value: string;
  time_hours: string;
  expenses: number;
  expense_value: string;
  milestones: { id: number; name: string; amount: string }[];
  pending_time_hours: string;
}

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "SGD", "INR", "ZAR", "AED"];

function FromWork({ clientId }: { clientId: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [selected, setSelected] = React.useState<Set<number>>(new Set(params.get("project") ? [Number(params.get("project"))] : []));
  const [milestones, setMilestones] = React.useState<Set<number>>(new Set());
  const [includeTime, setIncludeTime] = React.useState(true);
  const [includeExpenses, setIncludeExpenses] = React.useState(true);
  const [grouping, setGrouping] = React.useState("task");
  const [dueDate, setDueDate] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const idempotencyKey = React.useRef(uid());
  const query = useQuery({
    queryKey: ["unbilled", clientId, from, to],
    queryFn: () => api.get<{ client: { name: string; currency: string }; projects: UnbilledProject[] }>(`/invoices/unbilled/?client=${clientId}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`),
    enabled: Boolean(clientId),
  });
  const rows = query.data?.projects ?? [];
  const chosen = rows.filter((r) => selected.has(r.project.id));
  const currencies = new Set(chosen.map((r) => r.project.currency));
  const mixed = currencies.size > 1;
  const currency = [...currencies][0] ?? query.data?.client.currency ?? "USD";
  const estimate = chosen.reduce((sum, r) => {
    let s = sum + (includeTime ? Number(r.time_value) : 0) + (includeExpenses ? Number(r.expense_value) : 0);
    for (const m of r.milestones) if (milestones.has(m.id)) s += Number(m.amount);
    return s;
  }, 0);
  const nothing = estimate === 0;

  if (query.isLoading) return <LoadingRows rows={4} />;
  if (!rows.length) return <EmptyState title="This client has no projects" description="Create a project first, or use a manual invoice." />;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>Approved, uninvoiced work</CardTitle>
            <CardDescription>Only approved billable time and expenses, and completed milestones, can be invoiced.</CardDescription>
          </div>
        </CardHeader>
        <div className="flex flex-wrap items-center gap-3 border-y border-border bg-surface-2 px-5 py-2.5 text-xs text-muted">
          <span>Work dated</span>
          <input type="date" aria-label="From date" className="h-8 rounded-md border border-border bg-surface px-2 text-[13px] text-fg" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span>to</span>
          <input type="date" aria-label="To date" className="h-8 rounded-md border border-border bg-surface px-2 text-[13px] text-fg" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Table>
          <THead>
            <tr>
              <TH className="w-8" />
              <TH>Project</TH>
              <TH className="text-right">Approved time</TH>
              <TH className="text-right">Billable expenses</TH>
              <TH>Completed milestones</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map((r) => {
              const has = r.time_entries > 0 || r.expenses > 0 || r.milestones.length > 0;
              return (
                <TR key={r.project.id} data-selected={selected.has(r.project.id)}>
                  <TD>
                    <Checkbox
                      aria-label={`Include ${r.project.code}`}
                      checked={selected.has(r.project.id)}
                      disabled={!has}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(r.project.id);
                        else next.delete(r.project.id);
                        setSelected(next);
                      }}
                    />
                  </TD>
                  <TD>
                    <span className="block font-medium">{r.project.name}</span>
                    <span className="text-xs text-muted">{r.project.code} · {r.project.currency}</span>
                    {Number(r.pending_time_hours) > 0 && (
                      <span className="mt-1 flex items-center gap-1 text-xs text-warning"><AlertTriangle className="size-3" /> {formatHours(r.pending_time_hours)} billable time still awaiting approval</span>
                    )}
                  </TD>
                  <TD className="text-right tabular">
                    {r.time_entries ? <><span className="block">{formatMoney(r.time_value, r.project.currency)}</span><span className="text-xs text-muted">{formatHours(r.time_hours, 2)} · {r.time_entries} entries</span></> : <span className="text-muted">—</span>}
                  </TD>
                  <TD className="text-right tabular">
                    {r.expenses ? <><span className="block">{formatMoney(r.expense_value, r.project.currency)}</span><span className="text-xs text-muted">{r.expenses} expense(s)</span></> : <span className="text-muted">—</span>}
                  </TD>
                  <TD>
                    {r.milestones.length ? (
                      <div className="space-y-1">
                        {r.milestones.map((m) => (
                          <label key={m.id} className="flex items-center gap-2 text-[13px]">
                            <Checkbox
                              checked={milestones.has(m.id)}
                              onChange={(e) => {
                                const next = new Set(milestones);
                                if (e.target.checked) { next.add(m.id); setSelected(new Set(selected).add(r.project.id)); }
                                else next.delete(m.id);
                                setMilestones(next);
                              }}
                            />
                            {m.name} <span className="tabular text-muted">{formatMoney(m.amount, r.project.currency)}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>
      <Card className="h-fit">
        <CardHeader><CardTitle>Invoice options</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-[13px]"><Checkbox checked={includeTime} onChange={(e) => setIncludeTime(e.target.checked)} /> Include approved time</label>
            <label className="flex items-center gap-2 text-[13px]"><Checkbox checked={includeExpenses} onChange={(e) => setIncludeExpenses(e.target.checked)} /> Include billable expenses</label>
          </div>
          <Field label="Group time into lines by" htmlFor="grouping">
            <Select id="grouping" value={grouping} onChange={(e) => setGrouping(e.target.value)}>
              <option value="task">Task</option>
              <option value="person">Person</option>
              <option value="project">Project (one line)</option>
              <option value="entry">Each time entry</option>
            </Select>
          </Field>
          <Field label="Due date" htmlFor="due" hint="Leave blank to use the client's payment terms."><Input id="due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          <Field label="Notes on invoice" htmlFor="notes"><Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></Field>
          <div className="rounded-md bg-subtle p-3">
            <p className="text-xs text-muted">Estimated subtotal (before discount & tax)</p>
            <p className="text-xl font-semibold tabular">{mixed ? "—" : formatMoney(estimate, currency)}</p>
            {mixed && <p className="mt-1 text-xs text-danger">Selected projects use different currencies. Create one invoice per currency.</p>}
          </div>
          <Button
            className="w-full"
            disabled={!selected.size || mixed || nothing}
            loading={busy}
            data-testid="generate-invoice"
            onClick={async () => {
              setBusy(true);
              try {
                const inv = await api.post<Invoice>("/invoices/generate/", {
                  client: Number(clientId), projects: [...selected], include_time: includeTime, include_expenses: includeExpenses,
                  milestones: [...milestones], date_from: from || null, date_to: to || null, grouping, due_date: dueDate || null, notes,
                  idempotency_key: idempotencyKey.current,
                });
                toast.success(`Draft ${inv.number} created`);
                navigate(`/invoices/${inv.id}`);
              } catch (err) {
                toast.error(errorMessage(err));
                if (err instanceof ApiError && err.code === "nothing_to_invoice") idempotencyKey.current = uid();
              } finally {
                setBusy(false);
              }
            }}
          >
            <FileStack /> Create draft invoice
          </Button>
          <p className="text-xs text-muted">Included work is locked to this invoice. Deleting the draft or voiding the invoice releases it.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function Manual({ clientId }: { clientId: string }) {
  const navigate = useNavigate();
  const clients = useClientOptions();
  const { org } = useAuth();
  const client = clients.data?.find((c) => String(c.id) === clientId);
  const [currency, setCurrency] = React.useState("");
  const [lines, setLines] = React.useState([{ key: uid(), description: "", quantity: "1", unit_price: "" }]);
  const [dueDate, setDueDate] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const idempotencyKey = React.useRef(uid());
  const cur = currency || client?.currency || org.default_currency;
  const subtotal = lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.unit_price || 0), 0);
  const valid = lines.every((l) => l.description.trim() && Number(l.quantity) > 0 && l.unit_price !== "" && Number(l.unit_price) >= 0);
  return (
    <Card>
      <CardHeader>
        <div><CardTitle>Line items</CardTitle><CardDescription>For fixed fees, deposits and services not tracked as time.</CardDescription></div>
        <Select value={cur} onChange={(e) => setCurrency(e.target.value)} className="h-8 w-28 text-xs" aria-label="Currency">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
      </CardHeader>
      <CardContent className="space-y-3">
        {lines.map((l, i) => (
          <div key={l.key} className="grid grid-cols-[1fr_5rem_7rem_6rem_2rem] items-center gap-2">
            <Input aria-label="Description" placeholder="Description" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
            <Input aria-label="Quantity" type="number" min="0.01" step="0.01" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
            <Input aria-label="Unit price" type="number" min="0" step="0.01" placeholder="0.00" value={l.unit_price} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unit_price: e.target.value } : x)))} />
            <span className="text-right text-[13px] tabular">{formatMoney(Number(l.quantity || 0) * Number(l.unit_price || 0), cur)}</span>
            <Button variant="ghost" size="icon-sm" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 /></Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setLines([...lines, { key: uid(), description: "", quantity: "1", unit_price: "" }])}><Plus /> Add line</Button>
        <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
          <Field label="Due date" htmlFor="m-due" hint="Blank = client payment terms"><Input id="m-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          <Field label="Notes" htmlFor="m-notes"><Textarea id="m-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <p className="text-[13px] text-muted">Subtotal before discount & tax: <span className="font-semibold text-fg tabular">{formatMoney(subtotal, cur)}</span></p>
          <Button
            disabled={!clientId || !valid}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const inv = await api.post<Invoice>("/invoices/", {
                  client: Number(clientId), currency: cur, due_date: dueDate || undefined, notes,
                  lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unit_price })),
                }, { headers: { "Idempotency-Key": idempotencyKey.current } });
                toast.success(`Draft ${inv.number} created`);
                navigate(`/invoices/${inv.id}`);
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Receipt /> Create draft invoice
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function NewInvoicePage() {
  const [params, setParams] = useSearchParams();
  const clients = useClientOptions();
  const mode = params.get("mode") === "manual" ? "manual" : "work";
  const clientId = params.get("client") ?? "";
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  return (
    <>
      <PageHeader back={{ to: "/invoices", label: "Invoices" }} title="New invoice" description="Invoices start as drafts — review and edit before sending." />
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Client" htmlFor="ni-client" className="sm:w-72">
          <Select id="ni-client" value={clientId} onChange={(e) => set("client", e.target.value)}>
            <option value="">Select a client…</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Segmented value={mode} onChange={(v) => set("mode", v === "manual" ? "manual" : "")} options={[{ value: "work", label: "From approved work" }, { value: "manual", label: "Manual" }]} />
        {mode === "work" && <Badge tone="primary" className="sm:ml-auto">Duplicate-safe: work already invoiced is excluded</Badge>}
      </div>
      {!clientId ? (
        <Card><EmptyState title="Choose a client to begin" description="You'll see their approved, uninvoiced time, billable expenses and completed milestones." /></Card>
      ) : mode === "work" ? (
        <FromWork clientId={clientId} />
      ) : (
        <Manual clientId={clientId} />
      )}
    </>
  );
}
