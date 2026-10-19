import { defineConfig, devices } from "@playwright/test";

const PORT = 3180;
export const E2E_TEACHER_PASSWORD = "e2e-teacher-password";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Fresh e2e database, a production web build, then the real server serving it.
    command: "npx tsx e2e/prepareDb.ts && npm run build -w web && npx tsx server/src/index.ts",
    url: `http://localhost:${PORT}/api/meta`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? "postgres://xaas:xaas@localhost:5433/xaas_e2e",
      TEACHER_PASSWORD: E2E_TEACHER_PASSWORD,
      SESSION_SECRET: "e2e-session-secret-at-least-32-characters",
      PORT: String(PORT),
    },
  },
});
