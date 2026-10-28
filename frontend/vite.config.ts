/// <reference types="vitest/config" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API_PROXY_TARGET || "http://127.0.0.1:8000";
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": path.resolve(__dirname, "src") } },
    server: {
      port: Number(env.VITE_PORT || 5173),
      host: "127.0.0.1",
      // The API is served from the same origin in development, so session cookies and CSRF work unchanged.
      proxy: { "/api": { target: apiTarget, changeOrigin: false } },
    },
    preview: { port: 4173, proxy: { "/api": { target: apiTarget, changeOrigin: false } } },
    build: { chunkSizeWarningLimit: 900 },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      css: false,
    },
  };
});
