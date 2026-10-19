import postgres from "postgres";
import { createDb, runMigrations } from "../src/db/client.ts";

/** Creates (if needed), migrates and empties a real Postgres database for tests. */
export async function setupTestDb(url = process.env.TEST_DATABASE_URL ?? "postgres://xaas:xaas@localhost:5433/xaas_test") {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const adminSql = postgres(admin.toString(), { onnotice: () => {} });
  try {
    const [exists] = await adminSql`select 1 from pg_database where datname = ${name}`;
    if (!exists) await adminSql.unsafe(`create database "${name.replace(/"/g, '""')}"`);
  } finally {
    await adminSql.end();
  }
  const { db, close } = createDb(url);
  await runMigrations(db);
  const reset = () => db.execute("truncate companies, login_codes cascade");
  return { db, close, reset };
}
