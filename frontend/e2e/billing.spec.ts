import { expect, test } from "@playwright/test";

import { apiGet, approveTime, logAndSubmitTime, loginAs, runId, selectOptionContaining } from "./helpers";

/**
 * Workflow 1: task → time → approval → invoice from approved work → client portal →
 * sandbox online payment → server-verified balance.
 */
test("task to time to invoice to client payment", async ({ browser }) => {
  const id = runId();
  const taskTitle = `E2E checkout copy review ${id}`;
  const timeNote = `E2E billable work ${id}`;

  // 1. The project manager creates a task and assigns it to Sam.
  const pm = await loginAs(browser, "priya");
  await pm.goto("/tasks");
  await pm.getByRole("button", { name: "New task" }).first().click();
  let dialog = pm.getByRole("dialog");
  await selectOptionContaining(dialog.locator("#nt-project"), "ACME-001");
  await dialog.locator("#nt-title").fill(taskTitle);
  await selectOptionContaining(dialog.locator("#nt-assignee"), "Sam Whitaker");
  await dialog.locator("#nt-est").fill("3");
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toBeHidden();

  // 2. Sam logs time against the task and submits it.
  const member = await loginAs(browser, "sam");
  await logAndSubmitTime(member, { project: "ACME-001", task: taskTitle, duration: "2:30", description: timeNote });

  // 3. The project manager approves it.
  await approveTime(pm, timeNote);

  // 4. The owner (billing) generates an invoice from approved work and sends it.
  const billing = await loginAs(browser, "olivia");
  await billing.goto("/invoices/new");
  await selectOptionContaining(billing.locator("#ni-client"), "Acme Corporation");
  await billing.getByLabel("Include ACME-001").check();
  await billing.getByTestId("generate-invoice").click();
  await expect(billing).toHaveURL(/\/invoices\/\d+$/);
  const invoiceId = Number(billing.url().split("/").pop());
  await expect(billing.getByTestId("send-invoice")).toBeVisible();
  const draft = (await apiGet<{ client: number; lines: { kind: string; description: string }[] }>(billing, `/invoices/${invoiceId}/`)).body;
  expect(draft.lines.some((l) => l.kind === "time" && l.description.includes(taskTitle))).toBe(true);

  // The approved entry is now linked to an invoice line: generating again cannot bill it twice.
  const unbilled = await apiGet<{ projects: { project: { code: string }; time_entries: number }[] }>(billing, `/invoices/unbilled/?client=${draft.client}`);
  expect(unbilled.body.projects.find((p) => p.project.code === "ACME-001")?.time_entries ?? 0).toBe(0);

  await billing.getByTestId("send-invoice").click();
  await billing.getByTestId("confirm-send-invoice").click();
  await expect(billing.getByTestId("send-invoice")).toBeHidden();
  const invoice = (await apiGet<{ number: string; amount_due: string; status: string }>(billing, `/invoices/${invoiceId}/`)).body;
  expect(invoice.status).toBe("sent");
  expect(Number(invoice.amount_due)).toBeGreaterThan(0);

  // 5. The client sees it in the portal and pays online in the sandbox checkout.
  const client = await loginAs(browser, "jordan");
  await expect(client).toHaveURL(/\/portal$/);
  await client.goto("/portal/invoices");
  await client.getByRole("link", { name: invoice.number }).click();
  await expect(client.getByTestId("balance-due")).not.toHaveText("$0.00");

  // A declined card first: no money is applied.
  await client.getByTestId("pay-invoice").click();
  await expect(client).toHaveURL(/\/pay\/sandbox\//);
  await client.getByLabel("Card number").fill("4000 0000 0000 0002");
  await client.getByRole("button", { name: /^Pay / }).click();
  await expect(client.getByText("Payment failed")).toBeVisible();
  await client.getByRole("button", { name: "Back to invoice" }).click();
  await expect(client.getByTestId("checkout-result")).toHaveAttribute("data-status", "failed");
  expect((await apiGet<{ amount_due: string }>(client, `/portal/invoices/${invoiceId}/`)).body.amount_due).toBe(invoice.amount_due);

  // Then a successful payment of the full balance.
  await client.getByTestId("pay-invoice").click();
  await expect(client).toHaveURL(/\/pay\/sandbox\//);
  await client.getByLabel("Card number").fill("4242 4242 4242 4242");
  await client.getByRole("button", { name: /^Pay / }).click();
  await expect(client.getByText("Payment successful")).toBeVisible();
  await expect(client).toHaveURL(new RegExp(`/portal/invoices/${invoiceId}\\?checkout=`));
  await expect(client.getByTestId("checkout-result")).toHaveAttribute("data-status", "succeeded");
  await expect(client.getByTestId("balance-due")).toHaveText("$0.00");
  await expect(client.getByText("Paid in full")).toBeVisible();

  // 6. Back office: the invoice is paid, with exactly one sandbox payment recorded.
  const paid = (await apiGet<{ status: string; amount_due: string; payments: { provider: string; status: string }[] }>(billing, `/invoices/${invoiceId}/`)).body;
  expect(paid.status).toBe("paid");
  expect(paid.amount_due).toBe("0.00");
  expect(paid.payments.filter((p) => p.provider === "sandbox" && p.status === "succeeded")).toHaveLength(1);
});
