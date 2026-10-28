import { expect, test } from "@playwright/test";

import { apiGet, loginAs } from "./helpers";

type Page<T> = { results: T[] };

/** Workspace and client isolation, checked through both the UI and the API with real sessions. */
test("another workspace cannot see or reach this workspace's records", async ({ browser }) => {
  const owner = await loginAs(browser, "olivia");
  const project = (await apiGet<Page<{ id: number; code: string }>>(owner, "/projects/?search=ACME-001")).body.results[0];
  const invoice = (await apiGet<Page<{ id: number }>>(owner, "/invoices/?page_size=1")).body.results[0];
  const clientRecord = (await apiGet<Page<{ id: number; name: string }>>(owner, "/clients/?search=Acme")).body.results[0];
  expect(project.code).toBe("ACME-001");

  const outsider = await loginAs(browser, "contoso");
  // Lists only contain the outsider's own data.
  const projects = (await apiGet<Page<{ code: string }>>(outsider, "/projects/")).body.results.map((p) => p.code);
  expect(projects).not.toContain("ACME-001");
  const clients = (await apiGet<Page<{ name: string }>>(outsider, "/clients/")).body.results.map((c) => c.name);
  expect(clients).not.toContain("Acme Corporation");
  // Direct IDs behave exactly like records that do not exist.
  expect((await apiGet(outsider, `/projects/${project.id}/`)).status).toBe(404);
  expect((await apiGet(outsider, `/invoices/${invoice.id}/`)).status).toBe(404);
  expect((await apiGet(outsider, `/clients/${clientRecord.id}/`)).status).toBe(404);
  // Foreign IDs in writes are rejected too.
  const csrf = (await outsider.context().cookies()).find((c) => c.name === "om_csrftoken")?.value ?? "";
  const write = await outsider.request.post("/api/tasks/", { data: { project: project.id, title: "Should not exist" }, headers: { "X-CSRFToken": csrf } });
  expect(write.status()).toBe(400);
  // And the UI shows a not-found state rather than data.
  await outsider.goto(`/projects/${project.id}`);
  await expect(outsider.getByRole("alert")).toBeVisible();
  await expect(outsider.getByText("ACME-001")).toHaveCount(0);
});

test("client contacts only see their own company's records", async ({ browser }) => {
  const owner = await loginAs(browser, "olivia");
  const globexInvoices = (await apiGet<Page<{ id: number; client_name: string; status: string }>>(owner, "/invoices/?page_size=100")).body.results
    .filter((i) => i.client_name === "Globex" && i.status !== "draft");
  const globexDocs = (await apiGet<Page<{ id: number; client_name: string; status: string }>>(owner, "/documents/?page_size=100")).body.results
    .filter((d) => d.client_name === "Globex" && d.status !== "draft");
  expect(globexInvoices.length).toBeGreaterThan(0);
  expect(globexDocs.length).toBeGreaterThan(0);

  const acme = await loginAs(browser, "jordan");
  // Staff endpoints are closed to client users.
  expect((await apiGet(acme, "/invoices/")).status).toBe(403);
  expect((await apiGet(acme, "/time-entries/")).status).toBe(403);
  // Another client's portal records are not found.
  expect((await apiGet(acme, `/portal/invoices/${globexInvoices[0].id}/`)).status).toBe(404);
  expect((await apiGet(acme, `/portal/documents/${globexDocs[0].id}/`)).status).toBe(404);
  const own = (await apiGet<{ number: string }[]>(acme, "/portal/invoices/")).body;
  expect(own.length).toBeGreaterThan(0);
  // The UI route for a foreign invoice shows an error state.
  await acme.goto(`/portal/invoices/${globexInvoices[0].id}`);
  await expect(acme.getByRole("alert")).toBeVisible();
  // Staff pages redirect client users back to the portal.
  await acme.goto("/invoices");
  await expect(acme).toHaveURL(/\/portal$/);
});
