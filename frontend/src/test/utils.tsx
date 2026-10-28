import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type * as React from "react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";
import { vi } from "vitest";

import { TooltipProvider } from "@/components/ui/overlays";
import type { Permissions, Role, Session } from "@/lib/types";

type Reply = { status?: number; body?: unknown };
type Route = unknown | ((init: RequestInit | undefined, url: URL) => Reply);

/**
 * Replaces global fetch with a router keyed by "METHOD /api/path/". Unmatched requests get a 404
 * in the API's error envelope. Values are returned as 200 JSON; functions may choose a status.
 */
export function mockApi(routes: Record<string, Route>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const route = routes[key];
    let reply: Reply;
    if (route === undefined) reply = { status: 404, body: { error: { code: "not_found", message: "Not found." } } };
    else if (typeof route === "function") reply = (route as (i: RequestInit | undefined, u: URL) => Reply)(init, url);
    else reply = { status: 200, body: route };
    const status = reply.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(reply.body ?? {}), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export function apiError(status: number, code: string, message: string, fields?: Record<string, string[]>): Reply {
  return { status, body: { error: { code, message, fields: fields ?? {} } } };
}

const PERMISSIONS: Record<Role, Permissions> = {
  owner: { is_client: false, is_admin: true, is_manager: true, is_owner: true, billing: true, manage_team: true, approve_time: true, reports: true },
  admin: { is_client: false, is_admin: true, is_manager: true, is_owner: false, billing: true, manage_team: true, approve_time: true, reports: true },
  project_manager: { is_client: false, is_admin: false, is_manager: true, is_owner: false, billing: false, manage_team: false, approve_time: true, reports: true },
  member: { is_client: false, is_admin: false, is_manager: false, is_owner: false, billing: false, manage_team: false, approve_time: false, reports: false },
  client: { is_client: true, is_admin: false, is_manager: false, is_owner: false, billing: false, manage_team: false, approve_time: false, reports: false },
};

export function makeSession(role: Role = "owner"): Session {
  return {
    user: { id: 1, email: "user@example.test", full_name: "Test User", timezone: "UTC", initials: "TU" },
    workspaces: [{ id: 1, name: "Test Studio", role }],
    membership: { id: 1, role, role_label: role, title: "", client: role === "client" ? { id: 9, name: "Acme" } : null },
    organization: { id: 1, name: "Test Studio", default_currency: "USD", timezone: "UTC", brand_color: "#4F46E5", has_logo: false, is_demo: false } as Session["organization"],
    permissions: PERMISSIONS[role],
  };
}

export function renderRoutes(routes: RouteObject[], initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...utils, router, queryClient };
}

export function renderPage(element: React.ReactNode, path = "/") {
  return renderRoutes([{ path: "*", element }], path);
}
