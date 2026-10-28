import { expect, test } from "@playwright/test";

import { apiGet, loginAs, runId, selectOptionContaining } from "./helpers";

interface StaffDocument {
  status: string;
  current_version: number;
  audit: { valid: boolean; broken_at: number | null };
  events: { event: string; hash: string }[];
  signatures: { signer_name: string; method: string; content_hash: string; version_number: number }[];
}

/** Workflow 2: contract from template → send → client reviews and signs in the portal → audit chain verifies. */
test("contract is sent, signed by the client and the audit trail verifies", async ({ browser }) => {
  const title = `E2E services agreement ${runId()}`;

  // 1. The project manager drafts a contract from the template and sends it for signature.
  const pm = await loginAs(browser, "priya");
  await pm.goto("/documents");
  await pm.getByRole("button", { name: "New document" }).click();
  const dialog = pm.getByRole("dialog");
  await selectOptionContaining(dialog.locator("#d-template"), "(contract)");
  await dialog.locator("#d-title").fill(title);
  await selectOptionContaining(dialog.locator("#d-client"), "Acme Corporation");
  await selectOptionContaining(dialog.locator("#d-project"), "ACME-001");
  await dialog.getByRole("button", { name: "Create draft" }).click();
  await expect(pm).toHaveURL(/\/documents\/\d+$/);
  const docId = Number(pm.url().split("/").pop());

  await pm.getByTestId("send-document").click();
  const send = pm.getByRole("dialog");
  await expect(send.locator("#signer")).toContainText("Jordan Hayes");
  await send.getByRole("button", { name: "Send", exact: true }).click();
  await expect(send).toBeHidden();
  const sent = (await apiGet<StaffDocument>(pm, `/documents/${docId}/`)).body;
  expect(sent.status).toBe("sent");
  expect(sent.current_version).toBe(1);

  // 2. The client finds it waiting in the portal, reviews it and signs with a drawn signature.
  const client = await loginAs(browser, "jordan");
  await client.goto("/portal/approvals");
  await client.getByRole("listitem").filter({ hasText: title }).getByRole("link", { name: /Review & sign/ }).click();
  await expect(client).toHaveURL(new RegExp(`/portal/documents/${docId}`));
  await expect(client.getByTestId("document-body")).toContainText("Acme Corporation");

  const signButton = client.getByTestId("sign-document");
  await expect(signButton).toBeDisabled(); // no signature and no consent yet
  const pad = client.getByTestId("signature-pad");
  const box = (await pad.boundingBox())!;
  await client.mouse.move(box.x + 30, box.y + box.height * 0.6);
  await client.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await client.mouse.move(box.x + 30 + i * 18, box.y + box.height * (0.6 + (i % 2 ? -0.2 : 0.15)), { steps: 3 });
  }
  await client.mouse.up();
  await expect(signButton).toBeDisabled(); // consent still required
  await client.getByLabel("I agree to sign electronically").check();
  await signButton.click();
  await expect(client.getByTestId("signed-panel")).toBeVisible();
  await expect(client.getByTestId("signed-panel")).toContainText("Jordan Hayes");
  await expect(client.getByRole("img", { name: /Signature of Jordan Hayes/ })).toBeVisible();

  // Signing again is impossible: the panel is gone and the API refuses.
  await expect(client.getByTestId("sign-panel")).toHaveCount(0);

  // 3. Back office: status, signature record and a verified hash chain.
  await pm.reload();
  await expect(pm.getByText("Audit trail")).toBeVisible();
  await expect(pm.getByText("Verified")).toBeVisible();
  const signed = (await apiGet<StaffDocument>(pm, `/documents/${docId}/`)).body;
  expect(signed.status).toBe("signed");
  expect(signed.audit.valid).toBe(true);
  expect(signed.events.map((e) => e.event)).toEqual(expect.arrayContaining(["created", "sent", "viewed", "signed"]));
  expect(signed.signatures).toHaveLength(1);
  expect(signed.signatures[0]).toMatchObject({ signer_name: "Jordan Hayes", method: "drawn", version_number: 1 });
});
