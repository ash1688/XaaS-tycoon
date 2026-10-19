import { fileURLToPath } from "node:url";
import { buildApp } from "./app.ts";
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

const { db } = createDb(required("DATABASE_URL"));
await runMigrations(db);

const app = await buildApp({
  db,
  teacherPassword: required("TEACHER_PASSWORD"),
  sessionSecret,
  webDist: fileURLToPath(new URL("../../web/dist", import.meta.url)),
  logger: true,
});

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3080) });
