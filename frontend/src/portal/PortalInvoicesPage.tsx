import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CreditCard, Download, FlaskConical, Loader2, Receipt, X, XCircle } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { EmptyState, ErrorState, PageHeader, PageLoader, StatCard } from "@/components/common/layout-bits";
import { StatusBadge } from "@/components/common/status";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Badge, Card, CardContent, CardHeader, CardTitle, Table, TBody, TD, TH, THead, TR } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatDateTime, formatMoney, formatMoneyList, type MoneyAmount } from "@/lib/format";
import { cn } from "@/lib/utils";

import { DueText } from "./PortalHomePage";
import { PORTAL_KEYS, type PortalInvoice, type PortalInvoiceSummary, type PortalPayment, useInvalidatePortal } from "./portalApi";

function sumByCurrency(rows: { currency: string; amount: string }[]): MoneyAmount[] {
  const totals = new Map<string, number>();
  // Amounts are 2-dp decimal strings; sum in integer cents to avoid float drift.
  for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0) + Math.round(Number(r.amount) * 100));
  return [...totals.entries()].filter(([, cents]) => cents !== 0).map(([currency, cents]) => ({ currency, amount: (cents / 100).toFixed(2) }));
}

export function PortalInvoicesPage() {
  const navigate = useNavigate();
  const invoices = useQuery({ queryKey: PORTAL_KEYS.invoices, queryFn: () => api.get<PortalInvoiceSummary[]>("/portal/invoices/") });
  const paymentsQuery = useQuery({ queryKey: PORTAL_KEYS.payments, queryFn: () => api.get<PortalPayment[]>("/portal/payments/") });
  if (invoices.isLoading) return <PageLoader />;
  if (invoices.isError || !invoices.data) return <ErrorState error={invoices.error} onRetry={() => invoices.refetch()} />;
  const list = invoices.data;
  const open = list.filter((i) => Number(i.amount_due) > 0 && i.status !== "void");
  const outstanding = sumByCurrency(open.map((i) => ({ currency: i.currency, amount: i.amount_due })));
  const overdue = sumByCurrency(open.filter((i) => i.status === "overdue").map((i) => ({ currency: i.currency, amount: i.amount_due })));
  const paid = sumByCurrency((paymentsQuery.data ?? []).map((p) => ({ currency: p.currency, amount: p.amount })));
  return (
    <>
      <PageHeader title="Invoices" description="Invoices issued to you, balances due and your payment history." />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Balance due" value={formatMoneyList(outstanding, { empty: "Nothing due" })} sub={`${open.length} open invoice${open.length === 1 ? "" : "s"}`} />
        <StatCard label="Overdue" value={formatMoneyList(overdue, { empty: "None" })} tone={overdue.length ? "danger" : "default"} sub="Past the due date" />
        <StatCard label="Paid to date" value={formatMoneyList(paid, { empty: "—" })} sub={`${paymentsQuery.data?.length ?? 0} payments`} />
      </div>
      <Card className="mb-6">
        {list.length === 0 ? (
          <EmptyState icon={Receipt} title="No invoices yet" />
        ) : (
          <Table>
            <THead>
              <tr><TH>Invoice</TH><TH>Status</TH><TH>Issued</TH><TH>Due</TH><TH className="text-right">Total</TH><TH className="text-right">Balance</TH><TH className="w-28" /></tr>
            </THead>
            <TBody>
              {list.map((i) => (
                <TR key={i.id} className="cursor-pointer" onClick={() => navigate(`/portal/invoices/${i.id}`)}>
                  <TD><Link to={`/portal/invoices/${i.id}`} className="font-medium hover:text-primary" onClick={(e) => e.stopPropagation()}>{i.number}</Link></TD>
                  <TD><StatusBadge kind="invoice" status={i.status} /></TD>
                  <TD className="text-[13px] text-muted">{formatDate(i.issue_date)}</TD>
                  <TD className="text-[13px] text-muted">{Number(i.amount_due) > 0 ? <DueText date={i.due_date} prefix="" /> : formatDate(i.due_date)}</TD>
                  <TD className="text-right tabular">{formatMoney(i.total, i.currency)}</TD>
                  <TD className={cn("text-right font-medium tabular", i.status === "overdue" && "text-danger")}>{formatMoney(i.amount_due, i.currency)}</TD>
                  <TD className="text-right">
                    {i.can_pay && (
                      <Button size="sm" onClick={(e) => { e.stopPropagation(); navigate(`/portal/invoices/${i.id}#pay`); }}>Pay</Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader><CardTitle>Payment history</CardTitle></CardHeader>
        {paymentsQuery.data?.length ? (
          <Table>
            <THead><tr><TH>Date</TH><TH>Invoice</TH><TH>Method</TH><TH>Reference</TH><TH className="text-right">Amount</TH></tr></THead>
            <TBody>
              {paymentsQuery.data.map((p) => (
                <TR key={p.id}>
                  <TD className="text-[13px]">{formatDate(p.received_at)}</TD>
                  <TD><Link to={`/portal/invoices/${p.invoice_id}`} className="hover:text-primary">{p.invoice_number}</Link></TD>
                  <TD className="text-[13px] text-muted">{p.method}</TD>
                  <TD className="font-mono text-xs text-muted">{p.reference || "—"}</TD>
                  <TD className="text-right tabular">{formatMoney(p.amount, p.currency)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <EmptyState compact title={paymentsQuery.isLoading ? "Loading…" : "No payments yet"} />
        )}
      </Card>
    </>
  );
}

interface CheckoutStatus {
  checkout_id: number;
  status: "open" | "pending" | "succeeded" | "failed" | "canceled" | "expired";
  outcome: string;
  failure_reason: string;
  amount: string;
  invoice: PortalInvoiceSummary;
}

const TERMINAL = ["succeeded", "failed", "canceled", "expired"];

/** After returning from the hosted checkout, confirms the result server-side (never trusting the URL alone). */
function CheckoutResult({ checkoutId, canceled, currency, onDismiss }: { checkoutId: string; canceled: boolean; currency: string; onDismiss: () => void }) {
  const invalidate = useInvalidatePortal();
  const [attempts, setAttempts] = React.useState(0);
  const query = useQuery({
    queryKey: ["portal", "checkout", checkoutId],
    queryFn: () => api.get<CheckoutStatus>(`/portal/checkouts/${checkoutId}/`),
    refetchInterval: (q) => (q.state.data && TERMINAL.includes(q.state.data.status)) || attempts >= 20 ? false : 1500,
  });
  const status = query.data?.status;
  React.useEffect(() => {
    if (query.data) setAttempts((a) => a + 1);
  }, [query.dataUpdatedAt, query.data]);
  React.useEffect(() => {
    if (status && TERMINAL.includes(status)) invalidate();
  }, [status, invalidate]);

  let tone = "border-info/30 bg-info-soft";
  let icon = <Loader2 className="size-5 animate-spin text-info" />;
  let title = "Confirming your payment…";
  let body = "We're verifying the payment with the provider. This usually takes a few seconds.";
  if (query.isError) {
    tone = "border-danger/30 bg-danger-soft";
    icon = <XCircle className="size-5 text-danger" />;
    title = "We couldn't check this payment";
    body = errorMessage(query.error);
  } else if (status === "succeeded") {
    tone = "border-success/30 bg-success-soft";
    icon = <CheckCircle2 className="size-5 text-success" />;
    title = "Payment received — thank you";
    body = `${formatMoney(query.data!.amount, currency)} was applied to this invoice. A receipt has been recorded below.`;
  } else if (status === "failed") {
    tone = "border-danger/30 bg-danger-soft";
    icon = <XCircle className="size-5 text-danger" />;
    title = "Payment failed";
    body = `${query.data!.failure_reason || "The payment was declined."} No money was taken — you can try again.`;
  } else if (status === "canceled" || status === "expired" || (canceled && status === "open")) {
    tone = "border-border bg-surface-2";
    icon = <AlertTriangle className="size-5 text-muted" />;
    title = status === "expired" ? "Checkout expired" : "Payment canceled";
    body = "No payment was made. You can start a new payment whenever you're ready.";
  } else if (attempts >= 20) {
    tone = "border-warning/30 bg-warning-soft";
    icon = <AlertTriangle className="size-5 text-warning" />;
    title = "Still processing";
    body = "The provider hasn't confirmed this payment yet. Refresh in a minute — you won't be charged twice.";
  }
  return (
    <div className={cn("mb-6 flex items-start gap-3 rounded-lg border p-4", tone)} role="status" data-testid="checkout-result" data-status={status ?? "loading"}>
      {icon}
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold">{title}</p>
        <p className="mt-0.5 text-[13px] text-muted">{body}</p>
      </div>
      <Button variant="ghost" size="icon-sm" onClick={onDismiss} aria-label="Dismiss"><X /></Button>
    </div>
  );
}

function PayPanel({ invoice }: { invoice: PortalInvoice }) {
  const [mode, setMode] = React.useState<"full" | "partial">("full");
  const [amount, setAmount] = React.useState(invoice.amount_due);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const provider = invoice.payment_provider;
  const due = Number(invoice.amount_due);
  const value = mode === "full" ? invoice.amount_due : amount;
  const pay = async () => {
    setError("");
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > due) {
      setError(`Enter an amount between ${formatMoney("0.01", invoice.currency)} and ${formatMoney(invoice.amount_due, invoice.currency)}.`);
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ checkout_url: string }>(`/portal/invoices/${invoice.id}/checkout/`, { amount: n.toFixed(2) });
      window.location.assign(res.checkout_url);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Card id="pay" data-testid="pay-panel">
      <CardHeader>
        <CardTitle>Pay online</CardTitle>
        {provider.test_mode && <Badge tone="warning"><FlaskConical className="size-3" /> Test mode</Badge>}
      </CardHeader>
      <CardContent className="space-y-4">
        {!provider.configured ? (
          <p className="rounded-md bg-warning-soft px-3 py-2 text-[13px]">Online payment is temporarily unavailable. Please pay by bank transfer using the details on the invoice, or contact {invoice.organization.email || invoice.organization.name}.</p>
        ) : (
          <>
            {invoice.allow_partial_payments && (
              <div className="space-y-2" role="radiogroup" aria-label="Payment amount">
                {(["full", "partial"] as const).map((m) => (
                  <label key={m} className={cn("flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2.5 text-[13px]", mode === m ? "border-primary bg-primary-soft/50" : "border-border")}>
                    <input type="radio" name="pay-mode" checked={mode === m} onChange={() => setMode(m)} className="accent-[var(--color-primary)]" />
                    {m === "full" ? <>Full balance <span className="ml-auto font-semibold tabular">{formatMoney(invoice.amount_due, invoice.currency)}</span></> : "A different amount"}
                  </label>
                ))}
                {mode === "partial" && (
                  <Field label={`Amount (${invoice.currency})`} htmlFor="pay-amount">
                    <Input id="pay-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular" />
                  </Field>
                )}
              </div>
            )}
            {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">{error}</p>}
            <Button size="lg" className="w-full" onClick={pay} loading={busy} data-testid="pay-invoice">
              <CreditCard /> Pay {Number.isFinite(Number(value)) && Number(value) > 0 ? formatMoney(value, invoice.currency) : ""}
            </Button>
            <p className="text-xs text-muted">
              {provider.simulator
                ? "You'll continue to a sandbox checkout page — a local simulator where no real money moves."
                : `You'll be redirected to ${provider.label} to complete your payment securely. Card details never touch our servers.`}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function PortalInvoicePage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const checkoutId = params.get("checkout");
  const query = useQuery({ queryKey: PORTAL_KEYS.invoice(id), queryFn: () => api.get<PortalInvoice>(`/portal/invoices/${id}/`) });
  if (query.isLoading) return <PageLoader />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const inv = query.data;
  const money = (v: string) => formatMoney(v, inv.currency);
  return (
    <>
      <PageHeader
        back={{ to: "/portal/invoices", label: "Invoices" }}
        title={`Invoice ${inv.number}`}
        meta={<><StatusBadge kind="invoice" status={inv.status} /><span className="text-xs text-muted">from {inv.organization.name}</span></>}
        actions={<Button variant="outline" asChild><a href={`/api/portal/invoices/${inv.id}/pdf/`}><Download /> Download PDF</a></Button>}
      />
      {checkoutId && (
        <CheckoutResult
          checkoutId={checkoutId}
          canceled={params.get("canceled") === "1"}
          currency={inv.currency}
          onDismiss={() => setParams({}, { replace: true })}
        />
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="overflow-hidden">
          <div className="grid gap-4 border-b border-border p-5 sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted">From</p>
              <p className="text-[13px] font-medium">{inv.organization.name}</p>
              {inv.organization.address && <p className="whitespace-pre-line text-xs text-muted">{inv.organization.address}</p>}
            </div>
            <div>
              <p className="text-xs text-muted">Issued</p>
              <p className="text-[13px] font-medium">{formatDate(inv.issue_date)}</p>
            </div>
            <div>
              <p className="text-xs text-muted">Due</p>
              <p className="text-[13px] font-medium">{Number(inv.amount_due) > 0 ? <DueText date={inv.due_date} prefix="" /> : formatDate(inv.due_date)}</p>
              {inv.payment_terms && <p className="text-xs text-muted">{inv.payment_terms}</p>}
            </div>
          </div>
          <Table>
            <THead><tr><TH>Description</TH><TH className="text-right">Qty</TH><TH className="text-right">Rate</TH><TH className="text-right">Amount</TH></tr></THead>
            <TBody>
              {inv.lines.map((l, i) => (
                <TR key={i}>
                  <TD className="whitespace-pre-line text-[13px]">{l.description}</TD>
                  <TD className="text-right text-[13px] tabular">{Number(l.quantity).toLocaleString(undefined, { maximumFractionDigits: 2 })}{l.unit ? ` ${l.unit}` : ""}</TD>
                  <TD className="text-right text-[13px] tabular">{money(l.unit_price)}</TD>
                  <TD className="text-right text-[13px] tabular">{money(l.amount)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <dl className="ml-auto w-full max-w-xs space-y-1.5 border-t border-border p-5 text-[13px]">
            <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd className="tabular">{money(inv.subtotal)}</dd></div>
            {Number(inv.discount_amount) > 0 && <div className="flex justify-between"><dt className="text-muted">Discount</dt><dd className="tabular">−{money(inv.discount_amount)}</dd></div>}
            {Number(inv.tax_amount) > 0 && <div className="flex justify-between"><dt className="text-muted">{inv.tax_label || "Tax"} ({Number(inv.tax_rate)}%)</dt><dd className="tabular">{money(inv.tax_amount)}</dd></div>}
            <div className="flex justify-between border-t border-border pt-1.5 font-semibold"><dt>Total</dt><dd className="tabular">{money(inv.total)}</dd></div>
            {Number(inv.amount_paid) > 0 && <div className="flex justify-between"><dt className="text-muted">Paid</dt><dd className="tabular">−{money(inv.amount_paid)}</dd></div>}
            {Number(inv.amount_credited) > 0 && <div className="flex justify-between"><dt className="text-muted">Credited</dt><dd className="tabular">−{money(inv.amount_credited)}</dd></div>}
            <div className="flex justify-between border-t border-border pt-1.5 text-base font-semibold"><dt>Balance due</dt><dd className="tabular" data-testid="balance-due">{money(inv.amount_due)}</dd></div>
          </dl>
          {inv.notes && <p className="whitespace-pre-line border-t border-border px-5 py-4 text-[13px] text-muted">{inv.notes}</p>}
        </Card>
        <div className="order-first space-y-4 lg:sticky lg:top-4 lg:order-none lg:self-start">
          {inv.can_pay ? (
            <PayPanel key={inv.amount_due} invoice={inv} />
          ) : (
            <Card className="p-4">
              <p className="flex items-center gap-2 text-[13px] font-semibold">
                {inv.status === "paid" ? <><CheckCircle2 className="size-4 text-success" /> Paid in full</> : inv.status === "void" ? "This invoice was voided" : Number(inv.amount_due) > 0 ? "Online payment isn't enabled for this invoice" : "Nothing left to pay"}
              </p>
              {Number(inv.amount_due) > 0 && inv.status !== "void" && <p className="mt-1 text-xs text-muted">Please use the payment details on the PDF or contact {inv.organization.email || inv.organization.name}.</p>}
            </Card>
          )}
          <Card>
            <CardHeader><CardTitle>Payments</CardTitle></CardHeader>
            {inv.payments.length ? (
              <ul className="divide-y divide-border border-t border-border" data-testid="invoice-payments">
                {inv.payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                    <div className="min-w-0">
                      <p className="font-medium">{p.method}</p>
                      <p className="truncate text-xs text-muted" title={p.reference}>{formatDateTime(p.received_at)}{p.reference ? ` · ${p.reference}` : ""}</p>
                    </div>
                    <span className="font-medium tabular">{money(p.amount)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 pb-4 text-[13px] text-muted">No payments yet.</p>
            )}
          </Card>
          {inv.credit_notes.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Credit notes</CardTitle></CardHeader>
              <ul className="divide-y divide-border border-t border-border">
                {inv.credit_notes.map((c) => (
                  <li key={c.number} className="flex justify-between px-4 py-2.5 text-[13px]">
                    <span>{c.number} <span className="text-xs text-muted">· {formatDate(c.created_at)}</span></span>
                    <span className="tabular">{money(c.amount)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
