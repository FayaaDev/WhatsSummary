import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  webServer: [{
    command: "npx vite preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 120_000,
  }, {
    command: "node test/e2e/serve-worker.mjs",
    url: "http://127.0.0.1:8788/api/config",
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  }],
  projects: [
    { name: "desktop", testMatch: "app.spec.ts", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", testMatch: "app.spec.ts", use: { ...devices["iPhone SE"], defaultBrowserType: "chromium" } },
    { name: "worker-desktop", testMatch: "integration.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:8788" } },
    { name: "worker-mobile", testMatch: "integration.spec.ts", dependencies: ["worker-desktop"],
      use: { ...devices["iPhone SE"], defaultBrowserType: "chromium", baseURL: "http://127.0.0.1:8788" } },
  ],
});
