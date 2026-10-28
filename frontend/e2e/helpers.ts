import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";

export const PASSWORD = process.env.DEMO_PASSWORD ?? "Demo!2345";

export const USERS = {
  olivia: "olivia@demo.omnimanager.test", // owner (billing)
  priya: "priya@demo.omnimanager.test", // project manager
  sam: "sam@demo.omnimanager.test", // team member
  jordan: "jordan@acme.demo.omnimanager.test", // client portal: Acme Corporation
  lena: "lena@globex.demo.omnimanager.test", // client portal: Globex
  contoso: "owner@contoso.demo.omnimanager.test", // owner of a separate workspace
} as const;

export type UserKey = keyof typeof USERS;

/** A unique suffix so repeated runs never collide with earlier records. */
export const runId = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/** Signs in through the real login form in a fresh browser context (separate cookies per user). */
export async function loginAs(browser: Browser, user: UserKey): Promise<Page> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS[user]);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  return page;
}

/** Selects the first <option> whose text contains `text` (options often load asynchronously). */
export async function selectOptionContaining(select: Locator, text: string) {
  const option = select.locator("option", { hasText: text }).first();
  await expect(option).toBeAttached();
  const value = await option.getAttribute("value");
  await select.selectOption(value ?? "");
}

/** Reads JSON from the API using the page's session cookies. */
export async function apiGet<T>(page: Page, path: string): Promise<{ status: number; body: T }> {
  const res = await page.request.get(`/api${path}`);
  const body = res.headers()["content-type"]?.includes("json") ? await res.json() : null;
  return { status: res.status(), body };
}

/** Logs time through the Log time dialog, then submits the period's drafts for approval. */
export async function logAndSubmitTime(page: Page, opts: { project: string; task?: string; duration: string; description: string }) {
  await page.goto("/time");
  await page.getByRole("button", { name: "Log time" }).first().click();
  const dialog = page.getByRole("dialog");
  await selectOptionContaining(dialog.locator("#te-project"), opts.project);
  if (opts.task) await selectOptionContaining(dialog.locator("#te-task"), opts.task);
  await dialog.locator("#te-duration").fill(opts.duration);
  await dialog.locator("#te-desc").fill(opts.description);
  await dialog.getByRole("button", { name: "Log time" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(opts.description)).toBeVisible();
  await page.getByRole("button", { name: /^Submit (day|week)/ }).click();
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByRole("row", { name: new RegExp(escape(opts.description)) })).toContainText("Submitted");
}

/** Approves the submitted time entry identified by its description from the approvals queue. */
export async function approveTime(page: Page, description: string) {
  await page.goto("/timesheets?tab=approvals");
  const row = page.getByRole("row", { name: new RegExp(escape(description)) });
  await row.getByRole("checkbox").check();
  await page.getByTestId("approve-selected").click();
  await expect(row).toBeHidden();
}

export function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function money(value: string) {
  return Number(value.replace(/[^0-9.-]/g, ""));
}
