import { expect, test } from "@playwright/test";

import { apiGet, approveTime, logAndSubmitTime, loginAs, runId, selectOptionContaining } from "./helpers";

interface Radar {
  alerts: { id: string; type: string; project: { id: number; code: string } | null; amount: { currency: string; amount: string }[] }[];
}

/**
 * Workflow 3: budgeted project → time + chargeable expense → threshold warnings and notification →
 * Revenue Leak Radar flags the unbilled work → invoice draft from the radar → radar updates.
 */
test("budget thresholds, leak radar and invoicing stay consistent", async ({ browser }) => {
  const id = runId();
  const projectName = `E2E Budget pilot ${id}`;
  const timeNote = `E2E sprint planning ${id}`;
  const expenseNote = `E2E usability lab rental ${id}`;

  const owner = await loginAs(browser, "olivia");

  // 1. A time & materials project: $100/h with a $1,000 fee budget and 10 budgeted hours.
  await owner.goto("/projects");
  await owner.getByRole("button", { name: "New project" }).first().click();
  const form = owner.getByRole("dialog");
  await form.locator("#p-name").fill(projectName);
  await selectOptionContaining(form.locator("#p-client"), "Initech");
  await form.locator("#p-type").selectOption("hourly");
  await form.locator("#p-rate").fill("100");
  await form.locator("#p-budget").fill("1000");
  await form.locator("#p-hours").fill("10");
  await form.getByRole("button", { name: "Create project" }).click();
  await expect(owner).toHaveURL(/\/projects\/\d+$/);
  const projectId = Number(owner.url().split("/").pop());
  const code = (await apiGet<{ code: string }>(owner, `/projects/${projectId}/`)).body.code;

  // 2. Eight billable hours → 80% of the fee budget: the 75% threshold fires.
  await logAndSubmitTime(owner, { project: projectName, duration: "8:00", description: timeNote });
  await owner.goto(`/projects/${projectId}?tab=budget`);
  await expect(owner.getByText("75% threshold reached")).toBeVisible();

  // 3. A $300 chargeable expense pushes fees used to $1,100 → over budget.
  await owner.goto("/expenses");
  await owner.getByRole("button", { name: "New expense" }).first().click();
  const expense = owner.getByRole("dialog");
  await expense.locator("#x-desc").fill(expenseNote);
  await selectOptionContaining(expense.locator("#x-project"), projectName);
  await expense.locator("#x-amount").fill("300");
  const billable = expense.getByLabel("Billable to the client");
  if (!(await billable.isChecked())) await billable.check();
  await expense.getByRole("button", { name: "Save draft" }).click();
  await expect(expense).toBeHidden();
  const expenseRow = owner.getByRole("row", { name: new RegExp(expenseNote) });
  await expenseRow.getByRole("button", { name: "Expense actions" }).click();
  await owner.getByRole("menuitem", { name: "Submit for approval" }).click();
  await expect(expenseRow).toContainText("Submitted");

  // Approvals (an owner may approve their own entries; other roles cannot).
  await owner.goto("/expenses?tab=approvals");
  await owner.getByRole("row", { name: new RegExp(expenseNote) }).getByRole("button", { name: "Approve" }).click();
  await expect(owner.getByRole("row", { name: new RegExp(expenseNote) })).toBeHidden();
  await approveTime(owner, timeNote);

  await owner.goto(`/projects/${projectId}?tab=budget`);
  await expect(owner.getByText("100% threshold reached")).toBeVisible();
  const budget = (await apiGet<{ budget: { fees_used: string; fees_percent: string; alert_level: number } }>(owner, `/projects/${projectId}/`)).body.budget;
  expect(budget.fees_used).toBe("1100.00");
  expect(Number(budget.fees_percent)).toBeCloseTo(110, 0);
  expect(budget.alert_level).toBe(100);

  // The owner was notified once per threshold crossed.
  const notes = (await apiGet<{ results: { title: string }[] }>(owner, "/notifications/?page_size=50")).body.results.map((n) => n.title);
  expect(notes).toContain(`${code} has reached 75% of its budget`);
  expect(notes).toContain(`${code} has exceeded 100% of its budget`);

  // 4. The Revenue Leak Radar flags the approved, uninvoiced time and expense for this project.
  await owner.goto("/revenue-radar");
  const timeAlert = owner.locator(`[data-alert-id="unbilled_time:${projectId}"]`);
  await expect(timeAlert).toBeVisible();
  await expect(timeAlert).toContainText("$800.00");
  await expect(owner.locator(`[data-alert-id="unbilled_expenses:${projectId}"]`)).toContainText("$300.00");

  // 5. Create the invoice draft straight from the alert.
  await timeAlert.getByRole("button", { name: /Create invoice draft/ }).click();
  await expect(owner).toHaveURL(/\/invoices\/\d+$/);
  const invoiceId = Number(owner.url().split("/").pop());
  const invoice = (await apiGet<{ status: string; subtotal: string }>(owner, `/invoices/${invoiceId}/`)).body;
  expect(invoice.status).toBe("draft");
  expect(invoice.subtotal).toBe("1100.00");

  // 6. The radar no longer reports unbilled work for the project (the budget overrun remains).
  await owner.goto("/revenue-radar");
  await expect(owner.getByRole("heading", { name: /Revenue Leak Radar/ })).toBeVisible();
  await expect(owner.locator(`[data-alert-id="unbilled_time:${projectId}"]`)).toHaveCount(0);
  await expect(owner.locator(`[data-alert-id="unbilled_expenses:${projectId}"]`)).toHaveCount(0);
  const radar = (await apiGet<Radar>(owner, "/revenue-leak/")).body;
  const forProject = radar.alerts.filter((a) => a.project?.id === projectId).map((a) => a.type);
  expect(forProject).not.toContain("unbilled_time");
  expect(forProject).not.toContain("unbilled_expenses");
  expect(forProject).toContain("budget");
});
