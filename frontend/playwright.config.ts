import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end suite. Starts its own API server against an isolated database (see
 * backend/scripts/e2e_server.py — it creates "<your db>_e2e", migrates and seeds demo data) and
 * its own Vite dev server, so your development data is never touched.
 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 8001);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5174);
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const BACKEND_PYTHON = process.env.BACKEND_PYTHON ?? "../backend/.venv/bin/python";

export default defineConfig({
  testDir: "./e2e",
  // Workflows share one seeded database, so run them serially for deterministic state.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: `"${BACKEND_PYTHON}" ../backend/scripts/e2e_server.py`,
      url: `http://127.0.0.1:${API_PORT}/api/auth/csrf/`,
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: "pipe",
      env: { E2E_API_PORT: String(API_PORT), E2E_FRONTEND_URL: WEB_URL },
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { VITE_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
