import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CreditCard, Download, FileMinus, MoreHorizontal, Plus, Send, Trash2, Undo2 } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { ActivityList } from "@/components/common/collab";
import { ErrorState, PageHeader, PageLoader } from "@/components/common/layout-bits";
import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/overlays";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { useApiMutation } from "@/hooks/data";
import { useAuth } from "@/hooks/session";
import { api, errorMessage } from "@/lib/api";
import { daysUntil, formatDate, formatDateTime, formatMoney, isoDate, titleCase } from "@/lib/format";
import type { Invoice, InvoiceLine } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<InvoiceLine["kind"], string> = { time: "Time", expense: "Expense", milestone: "Milestone", service: "Service" };

function EditableLine({ invoice, line, onChanged }: { invoice: Invoice; line: InvoiceLine; onChanged: (inv: Invoice) => void }) {
  const draft = invoice.status === "draft";
  const editableAmounts = draft && line.kind === "service";
  const [v, setV] = React.useState({ description: line.description, quantity: line.quantity, unit_price: line.unit_price });
  React.useEffect(() => setV({ description: line.description, quantity: line.quantity, unit_price: line.unit_price }), [line]);
  const save = async (changes: Partial<typeof v>) => {
    try {
      onChanged(await api.patch<Invoice>(`/invoices/${invoice.id}/lines/${line.id}/`, changes));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <tr className="border-b border-border align-top">
      <td className="py-2.5 pr-3">
        {draft ? (
          <Input className="h-8" aria-label="Line description" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} onBlur={() => v.description !== line.description && save({ description: v.description })} />
        ) : (
          <span className="text-[13px]">{line.description}</span>
        )}
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
          <Badge tone={line.kind === "time" ? "primary" : line.kind === "expense" ? "warning" : line.kind === "milestone" ? "success" : "neutral"}>{KIND_LABEL[line.kind]}</Badge>
          {line.source_count > 0 && <span>{line.source_count} linked {line.kind === "time" ? "time entries" : line.kind === "expense" ? "expense" : "milestone"}</span>}
        </div>
      </td>
      <td className="w-24 py-2.5 pr-3 text-right">
        {editableAmounts ? <Input className="h-8 text-right" aria-label="Quantity" type="number" step="0.01" value={v.quantity} onChange={(e) => setV({ ...v, quantity: e.target.value })} onBlur={() => v.quantity !== line.quantity && save({ quantity: v.quantity })} /> : <span className="text-[13px] tabular">{Number(line.quantity)} {line.unit}</span>}
      </td>
      <td className="w-28 py-2.5 pr-3 text-right">
        {editableAmounts ? <Input className="h-8 text-right" aria-label="Unit price" type="number" step="0.01" value={v.unit_price} onChange={(e) => setV({ ...v, unit_price: e.target.value })} onBlur={() => v.unit_price !== line.unit_price && save({ unit_price: v.unit_price })} /> : <span className="text-[13px] tabular">{formatMoney(line.unit_price, invoice.currency)}</span>}
      </td>
      <td className="w-28 py-2.5 text-right text-[13px] font-medium tabular">{formatMoney(line.amount, invoice.currency)}</td>
      {draft && (
        <td className="w-10 py-2 pl-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove line"
            onClick={async () => {
              try {
                onChanged(await api.delete<Invoice>(`/invoices/${invoice.id}/lines/${line.id}/`));
                toast.success(line.source_count ? "Line removed — linked work is available to invoice again" : "Line removed");
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            <Trash2 />
          </Button>
        </td>
      )}
    </tr>
  );
}

function SendDialog({ invoice, open, onOpenChange, onDone }: { invoice: Invoice; open: boolean; onOpenChange: (o: boolean) => void; onDone: (i: Invoice) => void }) {
  const [email, setEmail] = React.useState(true);
  const [to, setTo] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) setTo(invoice.client_detail?.email ?? ""); }, [open, invoice.client_detail?.email]);
  const resend = invoice.status !== "draft";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title={resend ? `Email ${invoice.number} again` : `Send ${invoice.number}`} description={resend ? "Sends the current invoice and balance as a reminder." : "Sending issues the invoice: it becomes locked and visible in the client portal."} />
        <DialogBody className="space-y-4">
          {!resend && <label className="flex items-center gap-2 text-[13px]"><Checkbox checked={email} onChange={(e) => setEmail(e.target.checked)} /> Email the invoice PDF to the client</label>}
          {(email || resend) && (
            <>
              <Field label="Recipients" htmlFor="send-to" hint="Separate multiple addresses with commas."><Input id="send-to" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
              <Field label="Message (optional)" htmlFor="send-msg"><Textarea id="send-msg" value={message} onChange={(e) => setMessage(e.target.value)} rows={3} /></Field>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            loading={busy}
            data-testid="confirm-send-invoice"
            onClick={async () => {
              setBusy(true);
              try {
                const recipients = to.split(",").map((s) => s.trim()).filter(Boolean);
                const inv = await api.post<Invoice>(`/invoices/${invoice.id}/send/`, { send_email: email || resend, message, recipients: recipients.length ? recipients : undefined });
                toast.success(resend ? "Invoice emailed" : email ? "Invoice sent" : "Invoice marked as sent");
                onDone(inv);
                onOpenChange(false);
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Send /> {resend ? "Send email" : email ? "Send invoice" : "Mark as sent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AmountDialog({ title, description, open, onOpenChange, max, currency, onSubmit, kind }: {
  title: string; description: string; open: boolean; onOpenChange: (o: boolean) => void; max: string; currency: string; kind: "payment" | "credit";
  onSubmit: (v: { amount: string; method: string; received_on: string; reference: string; reason: string }) => Promise<void>;
}) {
  const [v, setV] = React.useState({ amount: max, method: "bank_transfer", received_on: isoDate(new Date()), reference: "", reason: "" });
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) setV({ amount: max, method: "bank_transfer", received_on: isoDate(new Date()), reference: "", reason: "" }); }, [open, max]);
  const over = Number(v.amount) > Number(max);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader title={title} description={description} />
        <DialogBody className="grid gap-4">
          <Field label={`Amount (${currency})`} htmlFor="amt" error={over ? `Cannot exceed the balance of ${formatMoney(max, currency)}` : undefined} hint={`Balance due: ${formatMoney(max, currency)}`}>
            <Input id="amt" type="number" step="0.01" min="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} aria-invalid={over} />
          </Field>
          {kind === "payment" ? (
            <>
              <Field label="Method" htmlFor="method">
                <Select id="method" value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })}>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="check">Check</option>
                  <option value="cash">Cash</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
              <Field label="Received on" htmlFor="recv"><Input id="recv" type="date" value={v.received_on} onChange={(e) => setV({ ...v, received_on: e.target.value })} /></Field>
              <Field label="Reference" htmlFor="ref"><Input id="ref" value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} placeholder="Bank reference" /></Field>
            </>
          ) : (
            <Field label="Reason" htmlFor="reason"><Textarea id="reason" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            loading={busy}
            disabled={over || !Number(v.amount) || (kind === "credit" && !v.reason.trim())}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(v);
                onOpenChange(false);
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {kind === "payment" ? "Record payment" : "Issue credit note"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InvoiceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { org } = useAuth();
  const key = ["invoice", Number(id)];
  const query = useQuery({ queryKey: key, queryFn: () => api.get<Invoice>(`/invoices/${id}/`) });
  const [sending, setSending] = React.useState(false);
  const [paying, setPaying] = React.useState(false);
  const [crediting, setCrediting] = React.useState(false);
  const [voiding, setVoiding] = React.useState(false);
  const [voidReason, setVoidReason] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);
  const [reversing, setReversing] = React.useState<number | null>(null);
  const [reverseReason, setReverseReason] = React.useState("");
  const [newLine, setNewLine] = React.useState({ description: "", quantity: "1", unit_price: "" });

  const setInvoice = (inv: Invoice) => {
    queryClient.setQueryData(key, inv);
    queryClient.invalidateQueries({ queryKey: ["invoices"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    queryClient.invalidateQueries({ queryKey: ["revenue-leak"] });
  };
  const updateHeader = async (changes: Record<string, unknown>) => {
    try {
      await api.patch(`/invoices/${id}/`, changes);
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const reverse = useApiMutation((args: { id: number; reason: string }) => api.post(`/payments/${args.id}/reverse/`, { reason: args.reason }), {
    success: "Payment reversed",
    invalidate: [key, ["invoices"]],
    onSuccess: () => { setReversing(null); setReverseReason(""); },
  });

  if (query.isLoading) return <PageLoader />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const inv = query.data;
  const draft = inv.status === "draft";
  const open = inv.status === "sent" || inv.status === "partially_paid";
  const days = daysUntil(inv.due_date) ?? 0;

  return (
    <>
      <PageHeader
        back={{ to: "/invoices", label: "Invoices" }}
        title={<span className="flex items-center gap-3">{inv.number} <StatusBadge kind="invoice" status={inv.display_status} /></span>}
        meta={<span className="text-[13px] text-muted"><Link to={`/clients/${inv.client}`} className="hover:text-fg hover:underline">{inv.client_name}</Link>{inv.created_by_name && ` · created by ${inv.created_by_name}`}{inv.recurring_schedule && " · recurring"}</span>}
        actions={
          <>
            <Button variant="outline" asChild><a href={`/api/invoices/${inv.id}/pdf/`}><Download /> PDF</a></Button>
            {draft && <Button variant="outline" onClick={() => setDeleting(true)}><Trash2 /> Delete draft</Button>}
            {draft && <Button onClick={() => setSending(true)} data-testid="send-invoice"><Send /> Send invoice</Button>}
            {open && <Button variant="outline" onClick={() => setSending(true)}><Send /> Email reminder</Button>}
            {open && <Button onClick={() => setPaying(true)} data-testid="record-payment"><CreditCard /> Record payment</Button>}
            {open && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="More actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={() => setCrediting(true)}><FileMinus /> Issue credit note</DropdownMenuItem>
                  <DropdownMenuItem destructive onSelect={() => setVoiding(true)} disabled={Number(inv.amount_paid) > 0 || Number(inv.amount_credited) > 0}><Ban /> Void invoice</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="p-6 sm:p-8">
          <div className="flex flex-col justify-between gap-6 sm:flex-row">
            <div>
              {org.has_logo ? <img src="/api/workspace/logo/" alt={org.name} className="mb-2 h-10 max-w-[180px] object-contain" /> : <p className="text-lg font-semibold">{org.name}</p>}
              <p className="whitespace-pre-line text-xs text-muted">{org.address}</p>
            </div>
            <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1.5 text-[13px] sm:text-right">
              <span className="text-muted">Issue date</span>
              {draft ? <Input type="date" className="h-8" aria-label="Issue date" defaultValue={inv.issue_date} key={`i${inv.issue_date}`} onBlur={(e) => e.target.value !== inv.issue_date && updateHeader({ issue_date: e.target.value })} /> : <span>{formatDate(inv.issue_date)}</span>}
              <span className="text-muted">Due date</span>
              {draft ? <Input type="date" className="h-8" aria-label="Due date" defaultValue={inv.due_date} key={`d${inv.due_date}`} onBlur={(e) => e.target.value !== inv.due_date && updateHeader({ due_date: e.target.value })} /> : <span className={cn(inv.is_overdue && "font-medium text-danger")}>{formatDate(inv.due_date)}</span>}
              <span className="text-muted">Terms</span>
              <span>{inv.payment_terms || "—"}</span>
            </div>
          </div>
          <div className="mt-8">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Bill to</p>
            <p className="mt-1 font-medium">{inv.client_detail?.name}</p>
            <p className="whitespace-pre-line text-xs text-muted">{inv.client_detail?.address}</p>
            <p className="text-xs text-muted">{inv.client_detail?.email}</p>
          </div>
          <div className="mt-8 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left">
              <thead>
                <tr className="border-b border-border-strong text-xs text-muted">
                  <th className="pb-2 font-medium">Description</th>
                  <th className="pb-2 pr-3 text-right font-medium">Qty</th>
                  <th className="pb-2 pr-3 text-right font-medium">Rate</th>
                  <th className="pb-2 text-right font-medium">Amount</th>
                  {draft && <th />}
                </tr>
              </thead>
              <tbody>
                {inv.lines?.map((l) => <EditableLine key={l.id} invoice={inv} line={l} onChanged={setInvoice} />)}
                {draft && (
                  <tr>
                    <td className="pt-3 pr-3"><Input className="h-8" placeholder="Add a service line…" aria-label="New line description" value={newLine.description} onChange={(e) => setNewLine({ ...newLine, description: e.target.value })} /></td>
                    <td className="pt-3 pr-3"><Input className="h-8 text-right" type="number" step="0.01" aria-label="New line quantity" value={newLine.quantity} onChange={(e) => setNewLine({ ...newLine, quantity: e.target.value })} /></td>
                    <td className="pt-3 pr-3"><Input className="h-8 text-right" type="number" step="0.01" placeholder="0.00" aria-label="New line price" value={newLine.unit_price} onChange={(e) => setNewLine({ ...newLine, unit_price: e.target.value })} /></td>
                    <td className="pt-3 text-right" colSpan={2}>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!newLine.description.trim() || newLine.unit_price === ""}
                        onClick={async () => {
                          try {
                            setInvoice(await api.post<Invoice>(`/invoices/${inv.id}/lines/`, newLine));
                            setNewLine({ description: "", quantity: "1", unit_price: "" });
                          } catch (err) {
                            toast.error(errorMessage(err));
                          }
                        }}
                      >
                        <Plus /> Add
                      </Button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-6 ml-auto w-full max-w-sm space-y-2 text-[13px]">
            <div className="flex justify-between"><span className="text-muted">Subtotal</span><span className="tabular">{formatMoney(inv.subtotal, inv.currency)}</span></div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted">Discount</span>
              {draft ? (
                <span className="flex items-center gap-1">
                  <Select className="h-7 w-24 text-xs" aria-label="Discount type" value={inv.discount_type} onChange={(e) => updateHeader({ discount_type: e.target.value })}>
                    <option value="none">None</option>
                    <option value="percent">%</option>
                    <option value="amount">Amount</option>
                  </Select>
                  {inv.discount_type !== "none" && <Input className="h-7 w-20 text-right text-xs" type="number" step="0.01" min="0" aria-label="Discount value" defaultValue={inv.discount_value} key={`dv${inv.discount_value}`} onBlur={(e) => e.target.value !== inv.discount_value && updateHeader({ discount_value: e.target.value || "0" })} />}
                </span>
              ) : null}
              <span className="tabular">− {formatMoney(inv.discount_amount, inv.currency)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted">{inv.tax_label}{!draft && Number(inv.tax_rate) ? ` (${Number(inv.tax_rate)}%)` : ""}</span>
              {draft && <span className="flex items-center gap-1"><Input className="h-7 w-20 text-right text-xs" type="number" step="0.01" min="0" max="100" aria-label="Tax rate" defaultValue={inv.tax_rate} key={`tr${inv.tax_rate}`} onBlur={(e) => e.target.value !== inv.tax_rate && updateHeader({ tax_rate: e.target.value || "0" })} /><span className="text-xs text-muted">%</span></span>}
              <span className="tabular">{formatMoney(inv.tax_amount, inv.currency)}</span>
            </div>
            <div className="flex justify-between border-t border-border-strong pt-2 text-[15px] font-semibold"><span>Total</span><span className="tabular">{formatMoney(inv.total, inv.currency)}</span></div>
            {Number(inv.amount_paid) > 0 && <div className="flex justify-between text-muted"><span>Paid</span><span className="tabular">− {formatMoney(inv.amount_paid, inv.currency)}</span></div>}
            {Number(inv.amount_credited) > 0 && <div className="flex justify-between text-muted"><span>Credited</span><span className="tabular">− {formatMoney(inv.amount_credited, inv.currency)}</span></div>}
            {inv.status !== "void" && <div className="flex justify-between rounded-md bg-primary-soft px-2 py-1.5 font-semibold text-primary"><span>Balance due</span><span className="tabular">{formatMoney(inv.amount_due, inv.currency)}</span></div>}
          </div>
          <div className="mt-8 border-t border-border pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Notes</p>
            {draft ? (
              <Textarea className="mt-2" rows={2} defaultValue={inv.notes} key={`n${inv.notes}`} aria-label="Invoice notes" onBlur={(e) => e.target.value !== inv.notes && updateHeader({ notes: e.target.value })} placeholder="Shown on the invoice" />
            ) : (
              <p className="mt-1 whitespace-pre-wrap text-[13px]">{inv.notes || "—"}</p>
            )}
          </div>
          {inv.status === "void" && <p className="mt-4 rounded-md bg-subtle px-3 py-2 text-[13px] text-muted">Voided {formatDate(inv.voided_at)}: {inv.void_reason}. Linked work was released and can be invoiced again.</p>}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Summary</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-[13px]">
              <div className="flex justify-between"><span className="text-muted">Status</span><StatusBadge kind="invoice" status={inv.display_status} /></div>
              <div className="flex justify-between"><span className="text-muted">Balance due</span><span className="font-semibold tabular">{formatMoney(inv.amount_due, inv.currency)}</span></div>
              {open && <div className="flex justify-between"><span className="text-muted">Due</span><span className={cn(days < 0 && "font-medium text-danger")}>{days < 0 ? `${-days} days overdue` : days === 0 ? "Today" : `in ${days} days`}</span></div>}
              {inv.sent_at && <div className="flex justify-between"><span className="text-muted">Sent</span><span>{formatDateTime(inv.sent_at)}</span></div>}
              <div className="flex justify-between"><span className="text-muted">Viewed by client</span><span>{inv.viewed_at ? formatDateTime(inv.viewed_at) : "Not yet"}</span></div>
              {inv.paid_at && <div className="flex justify-between"><span className="text-muted">Paid</span><span>{formatDateTime(inv.paid_at)}</span></div>}
              <div className="flex justify-between"><span className="text-muted">Online payment</span><span>{inv.allow_online_payment ? "Enabled" : "Disabled"}</span></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Payments</CardTitle></CardHeader>
            <CardContent>
              {inv.payments?.length ? (
                <ul className="space-y-3">
                  {inv.payments.map((p) => (
                    <li key={p.id} className="flex items-start justify-between gap-2 text-[13px]">
                      <span>
                        <span className={cn("font-medium tabular", p.status === "reversed" && "text-muted line-through")}>{formatMoney(p.amount, p.currency)}</span>
                        <span className="block text-xs text-muted">{formatDate(p.received_at)} · {titleCase(p.method)}{p.provider ? ` via ${p.provider}` : ""}</span>
                        {p.provider_reference && <span className="block font-mono text-[11px] text-muted">{p.provider_reference}</span>}
                        {p.status === "reversed" && <span className="block text-xs text-danger">Reversed: {p.reversal_reason}</span>}
                      </span>
                      {p.status === "succeeded" && (
                        <Button variant="ghost" size="icon-sm" aria-label="Reverse payment" onClick={() => setReversing(p.id)}><Undo2 /></Button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted">No payments yet.</p>
              )}
              {inv.credit_notes && inv.credit_notes.length > 0 && (
                <div className="mt-4 border-t border-border pt-3">
                  <p className="mb-2 text-xs font-medium text-muted">Credit notes</p>
                  {inv.credit_notes.map((c) => (
                    <p key={c.id} className="flex justify-between text-[13px]"><span>{c.number} · <span className="text-muted">{c.reason}</span></span><span className="tabular">{formatMoney(c.amount, inv.currency)}</span></p>
                  ))}
                </div>
              )}
              {inv.checkouts && inv.checkouts.length > 0 && (
                <div className="mt-4 border-t border-border pt-3">
                  <p className="mb-2 text-xs font-medium text-muted">Online checkout attempts</p>
                  {inv.checkouts.map((c) => (
                    <p key={c.id} className="flex items-center justify-between gap-2 text-xs">
                      <span>{formatDateTime(c.created_at)} · {c.provider}</span>
                      <span className="flex items-center gap-2"><span className="tabular">{formatMoney(c.amount, c.currency)}</span><StatusBadge kind="checkout" status={c.status} /></span>
                    </p>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Activity</CardTitle></CardHeader>
            <CardContent>
              <ActivityList items={(inv.activity ?? []).map((a) => ({ id: a.id, actor: a.actor?.full_name ?? null, verb: a.verb, target_label: a.target_label, created_at: a.created_at, metadata: a.metadata }))} />
            </CardContent>
          </Card>
        </div>
      </div>

      <SendDialog invoice={inv} open={sending} onOpenChange={setSending} onDone={setInvoice} />
      <AmountDialog
        kind="payment"
        title="Record a payment"
        description="For bank transfers, checks or cash received outside the portal. Online payments are recorded automatically after provider verification."
        open={paying}
        onOpenChange={setPaying}
        max={inv.amount_due}
        currency={inv.currency}
        onSubmit={async (v) => {
          setInvoice(await api.post<Invoice>(`/invoices/${inv.id}/payments/`, { amount: v.amount, method: v.method, received_on: v.received_on, reference: v.reference }));
          toast.success("Payment recorded");
        }}
      />
      <AmountDialog
        kind="credit"
        title="Issue a credit note"
        description="Reduces the balance due. Credit notes are numbered and kept in the audit trail."
        open={crediting}
        onOpenChange={setCrediting}
        max={inv.amount_due}
        currency={inv.currency}
        onSubmit={async (v) => {
          setInvoice(await api.post<Invoice>(`/invoices/${inv.id}/credit-notes/`, { amount: v.amount, reason: v.reason }));
          toast.success("Credit note issued");
        }}
      />
      <ConfirmDialog
        open={voiding}
        onOpenChange={setVoiding}
        title={`Void ${inv.number}?`}
        description="The invoice is cancelled and kept for your records. Its time entries, expenses and milestones are released so they can be invoiced again."
        confirmLabel="Void invoice"
        onConfirm={async () => {
          if (!voidReason.trim()) return toast.error("Enter a reason.");
          try {
            setInvoice(await api.post<Invoice>(`/invoices/${inv.id}/void/`, { reason: voidReason }));
            setVoiding(false);
            toast.success("Invoice voided");
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      >
        <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="Reason (required)" aria-label="Void reason" />
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete draft ${inv.number}?`}
        description="The draft is removed and any linked time, expenses or milestones become available to invoice again."
        confirmLabel="Delete draft"
        onConfirm={async () => {
          try {
            await api.delete(`/invoices/${inv.id}/`);
            queryClient.invalidateQueries({ queryKey: ["invoices"] });
            toast.success("Draft deleted");
            navigate("/invoices");
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />
      <ConfirmDialog
        open={reversing !== null}
        onOpenChange={(o) => !o && setReversing(null)}
        title="Reverse this payment?"
        description="Use this for bounced transfers or refunds processed at the provider. The balance due is restored and the reversal is audited."
        confirmLabel="Reverse payment"
        loading={reverse.isPending}
        onConfirm={() => reversing && reverseReason.trim() && reverse.mutate({ id: reversing, reason: reverseReason })}
      >
        <Input value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} placeholder="Reason (required)" aria-label="Reversal reason" />
      </ConfirmDialog>
    </>
  );
}
