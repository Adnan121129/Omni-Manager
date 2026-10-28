import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiError, mockApi } from "@/test/utils";

import { api, ApiError, errorMessage } from "./api";

beforeEach(() => {
  document.cookie = "om_csrftoken=test-token; path=/";
});

/** Resolves with the error a request rejects with (and fails the test if it resolves). */
function rejection(promise: Promise<unknown>): Promise<ApiError> {
  return promise.then(
    () => { throw new Error("Expected the request to fail"); },
    (err: ApiError) => err,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "om_csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

describe("api client", () => {
  it("prefixes /api, sends JSON and returns the parsed body", async () => {
    const fetchMock = mockApi({ "GET /api/projects/": { results: [], count: 0 } });
    await expect(api.get("/projects/")).resolves.toEqual({ results: [], count: 0 });
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
  });

  it("echoes the CSRF cookie on unsafe methods only", async () => {
    const fetchMock = mockApi({ "POST /api/tasks/": { id: 1 }, "GET /api/tasks/": [] });
    await api.post("/tasks/", { title: "A" });
    await api.get("/tasks/");
    const [, postInit] = fetchMock.mock.calls[0];
    const [, getInit] = fetchMock.mock.calls[1];
    expect((postInit?.headers as Record<string, string>)["X-CSRFToken"]).toBe("test-token");
    expect((postInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(postInit?.body).toBe(JSON.stringify({ title: "A" }));
    expect((getInit?.headers as Record<string, string>)["X-CSRFToken"]).toBeUndefined();
  });

  it("does not set a JSON content type for file uploads", async () => {
    const fetchMock = mockApi({ "POST /api/files/": { id: 3 } });
    const form = new FormData();
    form.append("file", new Blob(["x"]), "a.txt");
    await api.post("/files/", form);
    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(init?.body).toBe(form);
  });

  it("turns the error envelope into an ApiError with field errors", async () => {
    mockApi({ "POST /api/clients/": () => apiError(400, "validation_error", "Invalid input.", { name: ["This field is required."] }) });
    const err = await rejection(api.post("/clients/", {}));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.fields).toEqual({ name: ["This field is required."] });
    expect(errorMessage(err)).toBe("This field is required.");
  });

  it("keeps business-rule messages and codes", async () => {
    mockApi({ "POST /api/invoices/generate/": () => apiError(409, "nothing_to_invoice", "No approved, unbilled work in this range.") });
    const err = await rejection(api.post("/invoices/generate/", {}));
    expect(err.code).toBe("nothing_to_invoice");
    expect(errorMessage(err)).toBe("No approved, unbilled work in this range.");
  });

  it("falls back to a readable message when the body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>oops</html>", { status: 500, headers: { "content-type": "text/html" } })));
    const err = await rejection(api.get("/dashboard/"));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toMatch(/something went wrong/i);
  });

  it("reports network failures distinctly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const err = await rejection(api.get("/dashboard/"));
    expect(err.code).toBe("network_error");
  });

  it("returns undefined for 204 responses", async () => {
    mockApi({ "DELETE /api/tasks/4/": () => ({ status: 204 }) });
    await expect(api.delete("/tasks/4/")).resolves.toBeUndefined();
  });
});
