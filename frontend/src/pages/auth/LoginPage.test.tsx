import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiError, makeSession, mockApi, renderRoutes } from "@/test/utils";

import { LoginPage } from "./AuthPages";

const signedOut = () => apiError(403, "not_authenticated", "Authentication credentials were not provided.");

function renderLogin() {
  return renderRoutes(
    [
      { path: "/login", element: <LoginPage /> },
      { path: "/", element: <p>Workspace home</p> },
      { path: "/portal", element: <p>Portal home</p> },
    ],
    "/login",
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("LoginPage", () => {
  it("validates the form before calling the API", async () => {
    const fetchMock = mockApi({ "GET /api/auth/me/": signedOut });
    renderLogin();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter your email")).toBeInTheDocument();
    expect(screen.getByText("Enter your password")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("shows the server's error for bad credentials", async () => {
    mockApi({
      "GET /api/auth/me/": signedOut,
      "GET /api/auth/csrf/": {},
      "POST /api/auth/login/": () => apiError(400, "invalid_credentials", "Email or password is incorrect."),
    });
    renderLogin();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "olivia@example.test");
    await user.type(screen.getByLabelText(/^Password/), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect.");
  });

  it("routes client contacts to the portal after signing in", async () => {
    mockApi({
      "GET /api/auth/me/": signedOut,
      "GET /api/auth/csrf/": {},
      "POST /api/auth/login/": makeSession("client"),
    });
    const { router } = renderLogin();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "jordan@example.test");
    await user.type(screen.getByLabelText(/^Password/), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/portal"));
  });
});
