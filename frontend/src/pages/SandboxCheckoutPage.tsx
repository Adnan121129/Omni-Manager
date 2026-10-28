import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CreditCard, FlaskConical, Lock, XCircle } from "lucide-react";
import * as React from "react";
import { useParams } from "react-router";

import { ErrorState } from "@/components/common/layout-bits";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/api";
import { formatMoney } from "@/lib/format";

interface SandboxSession {
  session_id: string;
  status: "open" | "succeeded" | "failed" | "canceled" | "expired";
  amount: string;
  currency: string;
  invoice_number: string;
  merchant: string;
  brand_color: string;
  return_url: string;
  cancel_url: string;
  test_cards: { number: string; outcome: string }[];
}

interface SandboxResult {
  status: SandboxSession["status"];
  failure_reason?: string;
}

function formatCardNumber(value: string) {
  return value.replace(/\D/g, "").slice(0, 16).replace(/(.{4})/g, "$1 ").trim();
}

/**
 * Hosted checkout page for the local sandbox payment provider. It stands in for a provider-hosted
 * page (e.g. Stripe Checkout): the charge is settled by the simulator, which then delivers a signed
 * webhook to the API. No real card data is collected and no money moves.
 */
export function SandboxCheckoutPage() {
  const { sessionId = "" } = useParams();
  const query = useQuery({
    queryKey: ["sandbox-checkout", sessionId],
    queryFn: () => api.get<SandboxSession>(`/payments/sandbox/${encodeURIComponent(sessionId)}/`),
    retry: false,
  });
  const [card, setCard] = React.useState("");
  const [busy, setBusy] = React.useState<"pay" | "cancel" | null>(null);
  const [result, setResult] = React.useState<SandboxResult | null>(null);
  const [error, setError] = React.useState("");

  const session = query.data;
  const status = result?.status ?? session?.status;

  React.useEffect(() => {
    if (status === "succeeded" && session) {
      const timer = window.setTimeout(() => window.location.assign(session.return_url), 1500);
      return () => window.clearTimeout(timer);
    }
  }, [status, session]);

  const pay = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (card.replace(/\D/g, "").length < 12) {
      setError("Enter a card number — use one of the test cards below.");
      return;
    }
    setBusy("pay");
    try {
      setResult(await api.post<SandboxResult>(`/payments/sandbox/${encodeURIComponent(sessionId)}/`, { card_number: card }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!session) return;
    setBusy("cancel");
    try {
      await api.post(`/payments/sandbox/${encodeURIComponent(sessionId)}/`, { action: "cancel" });
      window.location.assign(session.cancel_url);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  };

  return (
    <div className="min-h-full bg-bg">
      <div className="flex items-center justify-center gap-2 bg-warning px-4 py-2 text-center text-[13px] font-medium text-white">
        <FlaskConical className="size-4 shrink-0" />
        Sandbox checkout — a local payment simulator. No real card is charged and no money moves.
      </div>
      <main className="mx-auto w-full max-w-md px-4 py-10">
        {query.isLoading ? (
          <Card className="h-96 animate-pulse" aria-busy="true" />
        ) : query.isError || !session ? (
          <ErrorState error={query.error} />
        ) : (
          <Card className="overflow-hidden">
            <div className="border-b border-border px-6 py-5" style={{ borderTop: `4px solid ${session.brand_color}` }}>
              <p className="text-[13px] text-muted">Pay {session.merchant}</p>
              <p className="mt-1 text-3xl font-semibold tracking-tight tabular" data-testid="checkout-amount">
                {formatMoney(session.amount, session.currency)}
              </p>
              <p className="mt-1 text-[13px] text-muted">Invoice {session.invoice_number}</p>
            </div>

            {status === "succeeded" ? (
              <div className="px-6 py-8 text-center">
                <CheckCircle2 className="mx-auto size-10 text-success" />
                <p className="mt-3 text-base font-semibold">Payment successful</p>
                <p className="mt-1 text-[13px] text-muted">Returning you to {session.merchant}…</p>
                <Button className="mt-5" onClick={() => window.location.assign(session.return_url)}>Return now</Button>
              </div>
            ) : status === "failed" ? (
              <div className="px-6 py-8 text-center">
                <XCircle className="mx-auto size-10 text-danger" />
                <p className="mt-3 text-base font-semibold">Payment failed</p>
                <p className="mt-1 text-[13px] text-muted" data-testid="checkout-failure">{result?.failure_reason || "The payment was not completed."}</p>
                <p className="mt-3 text-xs text-muted">This checkout session is closed. Return to the invoice to try again.</p>
                <Button className="mt-5" variant="outline" onClick={() => window.location.assign(session.return_url)}>Back to invoice</Button>
              </div>
            ) : status !== "open" ? (
              <div className="px-6 py-8 text-center">
                <AlertTriangle className="mx-auto size-10 text-warning" />
                <p className="mt-3 text-base font-semibold">This checkout is no longer available</p>
                <p className="mt-1 text-[13px] text-muted">The session was {status}. Start a new payment from the invoice.</p>
                <Button className="mt-5" variant="outline" onClick={() => window.location.assign(session.cancel_url)}>Back to invoice</Button>
              </div>
            ) : (
              <form onSubmit={pay} className="space-y-4 px-6 py-5" noValidate>
                <Field label="Card number" htmlFor="card" error={error || undefined}>
                  <div className="relative">
                    <CreditCard className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                    <Input
                      id="card"
                      inputMode="numeric"
                      autoComplete="off"
                      className="pl-9 font-mono tabular"
                      placeholder="4242 4242 4242 4242"
                      value={card}
                      onChange={(e) => setCard(formatCardNumber(e.target.value))}
                    />
                  </div>
                </Field>
                <div className="rounded-md border border-dashed border-border bg-surface-2 p-3">
                  <p className="text-xs font-medium">Test cards</p>
                  <ul className="mt-1.5 space-y-1">
                    {session.test_cards.map((c) => (
                      <li key={c.number} className="flex items-center justify-between gap-3 text-xs">
                        <button type="button" className="font-mono text-primary hover:underline" onClick={() => setCard(c.number)}>
                          {c.number}
                        </button>
                        <span className="text-muted">{c.outcome}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <Button type="submit" size="lg" className="w-full" loading={busy === "pay"} disabled={busy !== null}>
                  <Lock /> Pay {formatMoney(session.amount, session.currency)}
                </Button>
                <Button type="button" variant="ghost" className="w-full" loading={busy === "cancel"} disabled={busy !== null} onClick={cancel}>
                  Cancel and return
                </Button>
              </form>
            )}
          </Card>
        )}
        <p className="mt-6 text-center text-xs text-muted">
          The simulator records the charge, then sends a signed webhook to the API — the same verification path a real
          provider uses. Only the last four digits of the test card are stored.
        </p>
      </main>
    </div>
  );
}
