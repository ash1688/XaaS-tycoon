import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(url: string) {
  const client = postgres(url, { onnotice: () => {} });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder });
}
