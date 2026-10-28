import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StatusBadge } from "@/components/common/status";
import { AuthProvider } from "@/hooks/session";
import { apiError, makeSession, mockApi, renderRoutes } from "@/test/utils";

import { PortalInvoicePage } from "./PortalInvoicesPage";
import { DecisionDialog, deliverableDecision } from "./portalApi";

const invoice = {
  id: 5,
  number: "NW-0042",
  status: "sent",
  issue_date: "2026-10-01",
  due_date: "2026-10-15",
  currency: "USD",
  total: "1000.00",
  amount_paid: "400.00",
  amount_due: "600.00",
  can_pay: true,
  payment_terms: "Net 14",
  notes: "",
  subtotal: "1000.00",
  discount_amount: "0.00",
  tax_label: "",
  tax_rate: "0.00",
  tax_amount: "0.00",
  amount_credited: "0.00",
  lines: [{ description: "Design work", quantity: "10", unit: "hrs", unit_price: "100.00", amount: "1000.00" }],
  payments: [{ id: 1, amount: "400.00", method: "Bank transfer", received_at: "2026-10-05T10:00:00Z", reference: "BT-1" }],
  credit_notes: [],
  organization: { name: "Test Studio", address: "", email: "billing@studio.test" },
  allow_partial_payments: true,
  payment_provider: { name: "sandbox", label: "Sandbox", test_mode: true, simulator: true, configured: true, problem: "" },
};

function renderInvoice(path: string) {
  const session = makeSession("client");
  return renderRoutes([{ path: "/portal/invoices/:id", element: <AuthProvider session={session}><PortalInvoicePage /></AuthProvider> }], path);
}

const assign = vi.fn();
beforeEach(() => {
  document.cookie = "om_csrftoken=t; path=/";
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  assign.mockReset();
});

describe("portal invoice payment", () => {
  it("validates partial amounts against the balance before starting a checkout", async () => {
    const fetchMock = mockApi({
      "GET /api/portal/invoices/5/": invoice,
      "POST /api/portal/invoices/5/checkout/": { checkout_id: 7, checkout_url: "http://localhost/pay/sandbox/sbx_1", provider: "sandbox", amount: "250.00" },
    });
    renderInvoice("/portal/invoices/5");
    const user = userEvent.setup();
    expect(await screen.findByTestId("balance-due")).toHaveTextContent("$600.00");
    await user.click(screen.getByLabelText(/A different amount/));
    const amount = screen.getByLabelText("Amount (USD)");
    await user.clear(amount);
    await user.type(amount, "700");
    await user.click(screen.getByTestId("pay-invoice"));
    expect(await screen.findByRole("alert")).toHaveTextContent("between");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    await user.clear(amount);
    await user.type(amount, "250");
    await user.click(screen.getByTestId("pay-invoice"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://localhost/pay/sandbox/sbx_1"));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ amount: "250.00" });
  });

  it("confirms the payment outcome with the server after returning from checkout", async () => {
    const checkout = vi.fn(() => ({ status: 200, body: { checkout_id: 7, status: "succeeded", outcome: "applied", failure_reason: "", amount: "600.00", invoice: { ...invoice, status: "paid", amount_due: "0.00", can_pay: false } } }));
    mockApi({ "GET /api/portal/invoices/5/": invoice, "GET /api/portal/checkouts/7/": checkout });
    renderInvoice("/portal/invoices/5?checkout=7");
    const banner = await screen.findByTestId("checkout-result");
    await waitFor(() => expect(banner).toHaveAttribute("data-status", "succeeded"));
    expect(banner).toHaveTextContent("Payment received");
    expect(checkout).toHaveBeenCalled();
  });

  it("explains a declined payment", async () => {
    mockApi({
      "GET /api/portal/invoices/5/": invoice,
      "GET /api/portal/checkouts/7/": { checkout_id: 7, status: "failed", outcome: "failed", failure_reason: "Your card was declined.", amount: "600.00", invoice },
    });
    renderInvoice("/portal/invoices/5?checkout=7");
    expect(await screen.findByText("Payment failed")).toBeInTheDocument();
    expect(screen.getByText(/Your card was declined\./)).toBeInTheDocument();
  });

  it("says when online payment is unavailable instead of offering a dead button", async () => {
    mockApi({ "GET /api/portal/invoices/5/": { ...invoice, payment_provider: { ...invoice.payment_provider, configured: false, problem: "SANDBOX_WEBHOOK_SECRET is not set." } } });
    renderInvoice("/portal/invoices/5");
    expect(await screen.findByText(/Online payment is temporarily unavailable/)).toBeInTheDocument();
    expect(screen.queryByTestId("pay-invoice")).not.toBeInTheDocument();
  });
});

describe("client decisions", () => {
  function renderDialog() {
    const onClose = vi.fn();
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <DecisionDialog config={deliverableDecision.requestChanges({ id: 3, title: "Homepage" })} onClose={onClose} />
      </QueryClientProvider>,
    );
    return onClose;
  }

  it("requires a comment when requesting changes", async () => {
    const fetchMock = mockApi({ "POST /api/portal/deliverables/3/request-changes/": { id: 3 } });
    const onClose = renderDialog();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    expect(await screen.findByText("Please add a comment.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/What should change/), "Larger hero image");
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(url).toBe("/api/portal/deliverables/3/request-changes/");
    expect(JSON.parse(String(init?.body))).toEqual({ comment: "Larger hero image" });
  });

  it("shows the server's validation message", async () => {
    mockApi({ "POST /api/portal/deliverables/3/request-changes/": () => apiError(400, "validation_error", "Invalid input.", { comment: ["Describe the changes you need."] }) });
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/What should change/), " ");
    await user.type(screen.getByLabelText(/What should change/), "x");
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    expect(await screen.findByText("Describe the changes you need.")).toBeInTheDocument();
  });
});

describe("StatusBadge", () => {
  it("uses friendly labels and falls back to title case", () => {
    render(
      <>
        <StatusBadge kind="invoice" status="partially_paid" />
        <StatusBadge kind="deliverable" status="pending_approval" />
        <StatusBadge kind="invoice" status="some_new_state" />
      </>,
    );
    expect(screen.getByText("Partially paid")).toBeInTheDocument();
    expect(screen.getByText("Awaiting client")).toBeInTheDocument();
    expect(screen.getByText("Some New State")).toBeInTheDocument();
  });
});
