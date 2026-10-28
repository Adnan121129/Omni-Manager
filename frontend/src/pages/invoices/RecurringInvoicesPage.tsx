import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, MoreHorizontal, Pause, Pencil, Play, Plus, Repeat, Trash2, Zap } from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { EmptyState, PageHeader, QueryState } from "@/components/common/layout-bits";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/overlays";
import { Badge, Card, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { useApiMutation, useClientOptions, useProjectOptions } from "@/hooks/data";
import { api, ApiError, errorMessage, type Paginated } from "@/lib/api";
import { formatDate, formatMoney, isoDate } from "@/lib/format";
import { uid } from "@/lib/utils";

interface Schedule {
  id: number;
  client: number;
  client_name: string;
  project: number | null;
  project_code: string | null;
  name: string;
  frequency: "weekly" | "monthly" | "quarterly" | "yearly";
  start_date: string;
  next_run_date: string;
  end_date: string | null;
  is_active: boolean;
  currency: string;
  line_items: { description: string; quantity: string; unit_price: string }[];
  tax_rate: string;
  discount_type: string;
  discount_value: string;
  payment_terms_days: number;
  notes: string;
  auto_send: boolean;
  last_generated_at: string | null;
  invoice_count: number;
}

interface Preview {
  period_label: string;
  issue_date: string;
  due_date: string;
  currency: string;
  lines: { description: string; quantity: string; unit_price: string; amount: string }[];
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  will_auto_send: boolean;
}

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "SGD", "INR", "ZAR", "AED"];

function ScheduleDialog({ open, onOpenChange, schedule }: { open: boolean; onOpenChange: (o: boolean) => void; schedule?: Schedule | null }) {
  const queryClient = useQueryClient();
  const clients = useClientOptions(open);
  const projects = useProjectOptions({ enabled: open });
  const [v, setV] = React.useState({ name: "", client: "", project: "", frequency: "monthly", start_date: isoDate(new Date()), end_date: "", currency: "", tax_rate: "0", payment_terms_days: "14", notes: "", auto_send: false });
  const [lines, setLines] = React.useState([{ key: uid(), description: "", quantity: "1", unit_price: "" }]);
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setErrors({});
    if (schedule) {
      setV({ name: schedule.name, client: String(schedule.client), project: schedule.project ? String(schedule.project) : "", frequency: schedule.frequency, start_date: schedule.start_date, end_date: schedule.end_date ?? "", currency: schedule.currency, tax_rate: schedule.tax_rate, payment_terms_days: String(schedule.payment_terms_days), notes: schedule.notes, auto_send: schedule.auto_send });
      setLines(schedule.line_items.map((l) => ({ key: uid(), ...l })));
    } else {
      setV({ name: "", client: "", project: "", frequency: "monthly", start_date: isoDate(new Date()), end_date: "", currency: "", tax_rate: "0", payment_terms_days: "14", notes: "", auto_send: false });
      setLines([{ key: uid(), description: "", quantity: "1", unit_price: "" }]);
    }
  }, [open, schedule]);
  const client = clients.data?.find((c) => String(c.id) === v.client);
  const set = (k: keyof typeof v, value: string | boolean) => setV((s) => ({ ...s, [k]: value }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title={schedule ? "Edit recurring invoice" : "New recurring invoice"} description="Generated automatically by the daily job (or on demand). Each period is created exactly once." />
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErrors({});
            const payload = {
              ...v, client: Number(v.client), project: v.project ? Number(v.project) : null, end_date: v.end_date || null,
              currency: v.currency || client?.currency || "USD", payment_terms_days: Number(v.payment_terms_days || 0),
              line_items: lines.map(({ description, quantity, unit_price }) => ({ description, quantity, unit_price })),
            };
            try {
              if (schedule) await api.patch(`/recurring-invoices/${schedule.id}/`, payload);
              else await api.post("/recurring-invoices/", payload);
              queryClient.invalidateQueries({ queryKey: ["recurring"] });
              toast.success("Schedule saved");
              onOpenChange(false);
            } catch (err) {
              if (err instanceof ApiError) setErrors(err.fields);
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogBody className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="r-name" required error={errors.name?.[0]}><Input id="r-name" value={v.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Monthly SEO retainer" required /></Field>
              <Field label="Client" htmlFor="r-client" required error={errors.client?.[0]}>
                <Select id="r-client" value={v.client} onChange={(e) => set("client", e.target.value)} required disabled={Boolean(schedule)}>
                  <option value="">Select…</option>
                  {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
              <Field label="Project (optional)" htmlFor="r-project" error={errors.project?.[0]}>
                <Select id="r-project" value={v.project} onChange={(e) => set("project", e.target.value)}>
                  <option value="">None</option>
                  {projects.data?.filter((p) => String(p.client) === v.client).map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
                </Select>
              </Field>
              <Field label="Frequency" htmlFor="r-freq">
                <Select id="r-freq" value={v.frequency} onChange={(e) => set("frequency", e.target.value)}>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                </Select>
              </Field>
              <Field label="First invoice date" htmlFor="r-start" required><Input id="r-start" type="date" value={v.start_date} onChange={(e) => set("start_date", e.target.value)} required /></Field>
              <Field label="End date (optional)" htmlFor="r-end" error={errors.end_date?.[0]}><Input id="r-end" type="date" value={v.end_date} onChange={(e) => set("end_date", e.target.value)} /></Field>
              <Field label="Currency" htmlFor="r-cur"><Select id="r-cur" value={v.currency} onChange={(e) => set("currency", e.target.value)}><option value="">{client?.currency ?? "Client default"}</option>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Tax %" htmlFor="r-tax"><Input id="r-tax" type="number" step="0.01" min="0" max="100" value={v.tax_rate} onChange={(e) => set("tax_rate", e.target.value)} /></Field>
                <Field label="Terms (days)" htmlFor="r-terms"><Input id="r-terms" type="number" min="0" value={v.payment_terms_days} onChange={(e) => set("payment_terms_days", e.target.value)} /></Field>
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-[13px] font-medium">Line items</p>
              {errors.line_items && <p className="text-xs text-danger">{errors.line_items[0]}</p>}
              {lines.map((l, i) => (
                <div key={l.key} className="grid grid-cols-[1fr_5rem_7rem_2rem] gap-2">
                  <Input aria-label="Description" placeholder="Description" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                  <Input aria-label="Quantity" type="number" step="0.01" min="0.01" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                  <Input aria-label="Unit price" type="number" step="0.01" min="0" value={l.unit_price} placeholder="0.00" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unit_price: e.target.value } : x)))} />
                  <Button variant="ghost" size="icon-sm" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 /></Button>
                </div>
              ))}
              <Button size="sm" variant="outline" onClick={() => setLines([...lines, { key: uid(), description: "", quantity: "1", unit_price: "" }])}><Plus /> Add line</Button>
            </div>
            <Field label="Notes on each invoice" htmlFor="r-notes"><Textarea id="r-notes" rows={2} value={v.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
            <label className="flex items-center gap-2 text-[13px]"><Checkbox checked={v.auto_send} onChange={(e) => set("auto_send", e.target.checked)} /> Send automatically when generated (otherwise saved as draft for review)</label>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={busy}>Save schedule</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RecurringInvoicesPage() {
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ["recurring"], queryFn: () => api.get<Paginated<Schedule>>("/recurring-invoices/?page_size=100") });
  const [editing, setEditing] = React.useState<Schedule | null | undefined>(undefined);
  const [previewing, setPreviewing] = React.useState<Schedule | null>(null);
  const [deleting, setDeleting] = React.useState<Schedule | null>(null);
  const preview = useQuery({ queryKey: ["recurring-preview", previewing?.id], queryFn: () => api.get<Preview>(`/recurring-invoices/${previewing!.id}/preview/`), enabled: Boolean(previewing) });
  const toggle = useApiMutation((s: Schedule) => api.patch(`/recurring-invoices/${s.id}/`, { is_active: !s.is_active }), { success: "Schedule updated", invalidate: [["recurring"]] });
  const generate = useApiMutation((s: Schedule) => api.post<{ invoice_id: number; number: string }>(`/recurring-invoices/${s.id}/generate-next/`), {
    success: (r) => `Invoice ${r.number} generated`,
    invalidate: [["recurring"], ["invoices"]],
    onSuccess: (r) => navigate(`/invoices/${r.invoice_id}`),
  });
  const remove = useApiMutation((s: Schedule) => api.delete(`/recurring-invoices/${s.id}/`), { success: "Schedule deleted", invalidate: [["recurring"]], onSuccess: () => setDeleting(null) });
  const items = query.data?.results ?? [];
  return (
    <>
      <PageHeader
        back={{ to: "/invoices", label: "Invoices" }}
        title="Recurring invoices"
        description="Retainers and subscriptions. Run python manage.py run_jobs daily to generate due invoices automatically, or generate on demand."
        actions={<Button onClick={() => setEditing(null)}><Plus /> New schedule</Button>}
      />
      <Card>
        <QueryState query={query} empty={items.length === 0 && <EmptyState icon={Repeat} title="No recurring invoices" description="Set up retainers or recurring services billed on a fixed schedule." action={<Button onClick={() => setEditing(null)}><Plus /> New schedule</Button>} />}>
          <Table>
            <THead>
              <tr>
                <TH>Schedule</TH>
                <TH>Client</TH>
                <TH>Frequency</TH>
                <TH>Next invoice</TH>
                <TH className="text-right">Amount</TH>
                <TH className="text-right">Generated</TH>
                <TH>Status</TH>
                <TH className="w-10" />
              </tr>
            </THead>
            <TBody>
              {items.map((s) => {
                const amount = s.line_items.reduce((sum, l) => sum + Number(l.quantity) * Number(l.unit_price), 0);
                return (
                  <TR key={s.id}>
                    <TD><span className="font-medium">{s.name}</span>{s.project_code && <span className="ml-2 font-mono text-xs text-muted">{s.project_code}</span>}</TD>
                    <TD><Link to={`/clients/${s.client}`} className="hover:text-primary">{s.client_name}</Link></TD>
                    <TD className="capitalize">{s.frequency}{s.auto_send && <Badge tone="info" className="ml-2">Auto-send</Badge>}</TD>
                    <TD className="tabular">{s.is_active ? formatDate(s.next_run_date) : "—"}</TD>
                    <TD className="text-right tabular">{formatMoney(amount, s.currency)}<span className="block text-xs text-muted">before tax</span></TD>
                    <TD className="text-right tabular">{s.invoice_count}</TD>
                    <TD>{s.is_active ? <Badge tone="success" dot>Active</Badge> : <Badge dot>Paused</Badge>}</TD>
                    <TD>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Schedule actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem onSelect={() => setPreviewing(s)}><Eye /> Preview next invoice</DropdownMenuItem>
                          <DropdownMenuItem disabled={!s.is_active} onSelect={() => generate.mutate(s)}><Zap /> Generate next invoice now</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setEditing(s)}><Pencil /> Edit</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => toggle.mutate(s)}>{s.is_active ? <><Pause /> Pause</> : <><Play /> Resume</>}</DropdownMenuItem>
                          {s.invoice_count === 0 && <DropdownMenuItem destructive onSelect={() => setDeleting(s)}><Trash2 /> Delete</DropdownMenuItem>}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </QueryState>
      </Card>
      <ScheduleDialog open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)} schedule={editing ?? null} />
      <Dialog open={Boolean(previewing)} onOpenChange={(o) => !o && setPreviewing(null)}>
        <DialogContent>
          <DialogHeader title={`Next invoice · ${previewing?.name ?? ""}`} description={preview.data ? `Period ${preview.data.period_label}` : undefined} />
          <DialogBody>
            {preview.data ? (
              <div className="space-y-3 text-[13px]">
                <p className="text-muted">Issued {formatDate(preview.data.issue_date)} · due {formatDate(preview.data.due_date)} · {preview.data.will_auto_send ? "sent automatically" : "created as draft"}</p>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {preview.data.lines.map((l, i) => <li key={i} className="flex justify-between gap-3 px-3 py-2"><span>{l.description} × {Number(l.quantity)}</span><span className="tabular">{formatMoney(l.amount, preview.data!.currency)}</span></li>)}
                </ul>
                <div className="ml-auto max-w-xs space-y-1">
                  <p className="flex justify-between"><span className="text-muted">Subtotal</span><span className="tabular">{formatMoney(preview.data.subtotal, preview.data.currency)}</span></p>
                  {Number(preview.data.discount) > 0 && <p className="flex justify-between"><span className="text-muted">Discount</span><span className="tabular">− {formatMoney(preview.data.discount, preview.data.currency)}</span></p>}
                  <p className="flex justify-between"><span className="text-muted">Tax</span><span className="tabular">{formatMoney(preview.data.tax, preview.data.currency)}</span></p>
                  <p className="flex justify-between border-t border-border pt-1 font-semibold"><span>Total</span><span className="tabular">{formatMoney(preview.data.total, preview.data.currency)}</span></p>
                </div>
              </div>
            ) : (
              <p className="text-[13px] text-muted">Loading preview…</p>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)} title="Delete this schedule?" description="No invoices have been generated from it yet." confirmLabel="Delete" loading={remove.isPending} onConfirm={() => deleting && remove.mutate(deleting)} />
    </>
  );
}
