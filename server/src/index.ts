import { fileURLToPath } from "node:url";
import { createSim, defaultConfig } from "@xaas/sim";
import { buildApp, DEFAULT_TIMED_FLOW_SECONDS } from "./app.ts";
import { createDb, runMigrations } from "./db/client.ts";

function required(name: string) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing environment variable ${name}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

const sessionSecret = required("SESSION_SECRET");
if (sessionSecret.length < 32) {
  console.error("SESSION_SECRET must be at least 32 characters.");
  process.exit(1);
}

// Optional: a shorter game, for testing the end of one without playing 180 days.
let finalDay = defaultConfig.finalDay;
if (process.env.GAME_FINAL_DAY) {
  finalDay = Number(process.env.GAME_FINAL_DAY);
  if (!Number.isInteger(finalDay) || finalDay < 2) {
    console.error("GAME_FINAL_DAY must be a whole number of at least 2.");
    process.exit(1);
  }
}

// Optional: timed flow, a day every TIMED_FLOW_SECONDS with Play/Pause. Off unless TIMED_FLOW=on.
const timedFlow = { enabled: process.env.TIMED_FLOW === "on", seconds: DEFAULT_TIMED_FLOW_SECONDS };
if (process.env.TIMED_FLOW_SECONDS) {
  timedFlow.seconds = Number(process.env.TIMED_FLOW_SECONDS);
  if (!Number.isFinite(timedFlow.seconds) || timedFlow.seconds < 1) {
    console.error("TIMED_FLOW_SECONDS must be a number of at least 1.");
    process.exit(1);
  }
}

const { db } = createDb(required("DATABASE_URL"));
await runMigrations(db);

const app = await buildApp({
  db,
  teacherPassword: required("TEACHER_PASSWORD"),
  sessionSecret,
  sim: createSim({ ...defaultConfig, finalDay }),
  timedFlow,
  webDist: fileURLToPath(new URL("../../web/dist", import.meta.url)),
  logger: true,
});

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3080) });
