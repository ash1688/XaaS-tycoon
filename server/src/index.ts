import { fileURLToPath } from "node:url";
import { createSim, defaultConfig } from "@xaas/sim";
import { buildApp, DEFAULT_TIMED_FLOW_SECONDS, RATE_LIMIT_DEFAULTS } from "./app.ts";
import { createDb, runMigrations } from "./db/client.ts";

function required(name: string) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing environment variable ${name}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

// Checked before anything connects, so a deploy with a secret missing stops at once with a clear message.
const databaseUrl = required("DATABASE_URL");
const teacherPassword = required("TEACHER_PASSWORD");
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

// Optional: behind a proxy such as Dokploy's Traefik, TRUST_PROXY lists the proxy addresses to trust for the client's
// IP and HTTPS, comma-separated: IPs, CIDRs, or proxy-addr names such as "uniquelocal" (the private ranges a Docker
// network uses). "true" trusts any address. Hop counts aren't accepted: Fastify treats them as trusting nothing.
const trustProxyEnv = process.env.TRUST_PROXY;
if (trustProxyEnv && /^\d+$/.test(trustProxyEnv)) {
  console.error("TRUST_PROXY takes proxy addresses (for example uniquelocal), not a hop count.");
  process.exit(1);
}
const trustProxy = trustProxyEnv === "true" ? true : trustProxyEnv || false;

// Optional: limits on failed code lookups and teacher sign-ins per client IP, in a window of minutes.
function positiveInteger(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${name} must be a whole number of at least 1.`);
    process.exit(1);
  }
  return value;
}
const rateLimit = {
  codeFailures: positiveInteger("RATE_LIMIT_CODE_FAILURES", RATE_LIMIT_DEFAULTS.codeFailures),
  loginFailures: positiveInteger("RATE_LIMIT_LOGIN_FAILURES", RATE_LIMIT_DEFAULTS.loginFailures),
  windowMinutes: positiveInteger("RATE_LIMIT_WINDOW_MINUTES", RATE_LIMIT_DEFAULTS.windowMinutes),
};

const { db, close } = createDb(databaseUrl);
await runMigrations(db);

const app = await buildApp({
  db,
  teacherPassword,
  sessionSecret,
  sim: createSim({ ...defaultConfig, finalDay }),
  timedFlow,
  trustProxy,
  rateLimit,
  webDist: fileURLToPath(new URL("../../web/dist", import.meta.url)),
  logger: true,
});

// Docker stops the container with SIGTERM: finish open requests and close the database first.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    await app.close();
    await close();
    process.exit(0);
  });
}

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3080) });
