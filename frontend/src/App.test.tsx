import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiError, makeSession, mockApi, renderRoutes } from "@/test/utils";

import { routes } from "./App";

const emptyPage = { results: [], count: 0, page: 1, page_size: 25, total_pages: 0 };

/** Endpoints the shells request on mount; individual tests add page-specific ones. */
function shellApi(role: Parameters<typeof makeSession>[0], extra: Record<string, unknown> = {}) {
  return mockApi({
    "GET /api/auth/me/": makeSession(role),
    "GET /api/notifications/": { ...emptyPage, unread_count: 0 },
    "GET /api/timer/": { timer: null, server_now: new Date().toISOString() },
    "GET /api/portal/summary/": {
      client: { id: 9, name: "Acme" },
      organization: { name: "Test Studio", email: "", brand_color: "#4F46E5" },
      approvals: [],
      projects: [],
      outstanding: [],
      activity: [],
    },
    ...extra,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("route protection", () => {
  it("sends signed-out visitors to the login page and remembers where they were going", async () => {
    mockApi({ "GET /api/auth/me/": () => apiError(403, "not_authenticated", "Authentication credentials were not provided.") });
    const { router } = renderRoutes(routes, "/projects?status=active");
    expect(await screen.findByText("Sign in to your workspace")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(new URLSearchParams(router.state.location.search).get("next")).toBe("/projects?status=active");
  });

  it("keeps client contacts out of the workspace app", async () => {
    shellApi("client");
    const { router } = renderRoutes(routes, "/invoices");
    await waitFor(() => expect(router.state.location.pathname).toBe("/portal"));
    expect(await screen.findByText(/Client portal · Acme/)).toBeInTheDocument();
  });

  it("keeps staff out of the client portal", async () => {
    shellApi("member", { "GET /api/dashboard/": { my_work: { tasks: [], overdue: 0, today_seconds: 0, week_seconds: 0 }, projects: [], activity: [] } });
    const { router } = renderRoutes(routes, "/portal/invoices");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(await screen.findByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
  });

  it("hides manager-only areas from team members", async () => {
    shellApi("member");
    renderRoutes(routes, "/reports");
    expect(await screen.findByText("You don't have access to this area")).toBeInTheDocument();
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    expect(nav).not.toHaveTextContent("Invoices");
    expect(nav).not.toHaveTextContent("Revenue Leak Radar");
    expect(nav).toHaveTextContent("Time Tracking");
  });

  it("shows finance navigation to billing users", async () => {
    shellApi("owner");
    renderRoutes(routes, "/team");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    expect(nav).toHaveTextContent("Invoices");
    expect(nav).toHaveTextContent("Revenue Leak Radar");
  });
});
