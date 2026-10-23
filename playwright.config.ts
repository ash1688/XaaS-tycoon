import { defineConfig, devices } from "@playwright/test";

// E2E_PORT moves both servers, for running beside another checkout's e2e run.
const PORT = Number(process.env.E2E_PORT ?? 3180);
// A second server on the same database with timed flow on, for the "timed" project only.
const TIMED_PORT = PORT + 4;
export const E2E_TIMED_FLOW_SECONDS = 1;
export const E2E_TEACHER_PASSWORD = "e2e-teacher-password";
// A short game, so a test can play one to the end. Set on the server through GAME_FINAL_DAY, as anyone can.
export const E2E_FINAL_DAY = 30;
export const E2E_START_DATE = "2026-10-01";
export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://xaas:xaas@127.0.0.1:5433/xaas_e2e";

const serverEnv = {
  DATABASE_URL: E2E_DATABASE_URL,
  TEACHER_PASSWORD: E2E_TEACHER_PASSWORD,
  SESSION_SECRET: "e2e-session-secret-at-least-32-characters",
  GAME_FINAL_DAY: String(E2E_FINAL_DAY),
  // Every game starts on a date with no holidays in its 30 days, so holidays don't move a test's load and growth.
  GAME_START_DATE: E2E_START_DATE,
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /timedFlow\.spec\.ts/ },
    {
      name: "timed",
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${TIMED_PORT}` },
      testMatch: /timedFlow\.spec\.ts/,
    },
  ],
  // Started in order, so the timed server finds the database and web build the first one prepared.
  webServer: [
    {
      // Fresh e2e database, a production web build, then the real server serving it.
      command: "npx tsx e2e/prepareDb.ts && npm run build -w web && npx tsx server/src/index.ts",
      url: `http://localhost:${PORT}/api/meta`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...serverEnv, PORT: String(PORT) },
    },
    {
      command: "npx tsx server/src/index.ts",
      url: `http://localhost:${TIMED_PORT}/api/meta`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...serverEnv,
        PORT: String(TIMED_PORT),
        TIMED_FLOW: "on",
        TIMED_FLOW_SECONDS: String(E2E_TIMED_FLOW_SECONDS),
      },
    },
  ],
});
