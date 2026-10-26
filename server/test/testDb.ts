import postgres from "postgres";
import { eq } from "drizzle-orm";
import { PHASE_IDS, type GameState, type PhaseId } from "@xaas/sim";
import { createDb, runMigrations, type Db } from "../src/db/client.ts";
import { companies } from "../src/db/schema.ts";

/**
 * Creates (if needed), migrates and empties a real Postgres database for tests. The default is 127.0.0.1 rather than
 * localhost: on Windows localhost is IPv6 first, and Docker Desktop's IPv6 port forwarding adds about 45 ms to any
 * query over 16 KB, which is every save of a game's state.
 */
export async function setupTestDb(url = process.env.TEST_DATABASE_URL ?? "postgres://xaas:xaas@127.0.0.1:5433/xaas_test") {
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
  // Deletes rather than truncates: a truncate waits on, and can deadlock with, playtest log rows an app is still
  // writing after the last request. Rows for a company deleted here just fail their foreign key, which the log ignores.
  const reset = async () => {
    await db.execute("delete from play_events");
    await db.execute("delete from login_codes");
    await db.execute("delete from config_presets");
  };
  return { db, close, reset };
}

/**
 * Moves a stored game on to `phase` (#236), as if its milestone and any before it had come on `day` (the game's day by
 * default), so its jobs are open: for tests about those jobs rather than how the game reaches them. Like the sim tests'
 * inPhase, it changes nothing else, and a game already further on stays where it is.
 */
export async function reachPhase(db: Db, id: string, phase: PhaseId, day?: number) {
  const [row] = await db.select({ state: companies.state }).from(companies).where(eq(companies.id, id));
  const state = row!.state as GameState;
  const from = PHASE_IDS.indexOf(state.phase);
  const to = PHASE_IDS.indexOf(phase);
  if (from >= to) return;
  const phaseDays = { ...state.phaseDays };
  for (const p of PHASE_IDS.slice(from + 1, to + 1)) phaseDays[p] = day ?? state.day;
  await db.update(companies).set({ state: { ...state, phase, phaseDays } }).where(eq(companies.id, id));
}
