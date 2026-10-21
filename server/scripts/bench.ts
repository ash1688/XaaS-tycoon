// Times the server's hot requests against a real Postgres: what a lesson does, with every student pressing Continue
// and the teacher's live dashboard refreshing. Not part of the game: a tool for checking the server stays fast.
//
//   npm run bench -w server
//   BENCH_DATABASE_URL=postgres://xaas:xaas@127.0.0.1:5433/xaas_bench npm run bench -w server -- --json bench.json
//
// It empties the database it's given, so never point it at the real one. Requests go through Fastify's inject, so the
// times are the server's own work and its database round trips, without the network.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { sql } from "drizzle-orm";
import { createSim, defaultConfig, type GameState } from "@xaas/sim";
import { playDay, STRATEGIES } from "../../sim/scripts/harness.ts";
import { buildApp } from "../src/app.ts";
import { setupTestDb } from "../test/testDb.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "100" },
    json: { type: "string" },
  },
});
const iterations = Number(values.iterations);
const url = process.env.BENCH_DATABASE_URL ?? "postgres://xaas:xaas@127.0.0.1:5433/xaas_bench";
if (new URL(url).pathname === "/xaas") throw new Error("The benchmark empties its database: give it its own.");

const PASSWORD = "bench-teacher-password";
const { db, close, reset } = await setupTestDb(url);
await reset();
const app = await buildApp({
  db,
  teacherPassword: PASSWORD,
  sessionSecret: "bench-session-secret-at-least-32-characters",
  rateLimit: false,
  // Room for the dashboard's 3 games per code.
  maxActiveCompanies: 3,
});

// Late-game states from the balance harness's sensible bot, on the default config the server starts games with.
const sim = createSim(defaultConfig);
const sensible = STRATEGIES.find((s) => s.id === "sensible")!;
function stateOnDay(model: GameState["model"], productType: GameState["productType"], day: number): GameState {
  let state = sim.newGame({ companyName: "Bench Ltd", productType, model, seed: 1, takeLoan: model === "onprem" });
  while (state.day < day && state.status === "playing") state = sim.advance(playDay(sim, state, sensible)).state;
  return state;
}
const late = stateOnDay("iaas", "social", 170);

async function inject(method: "GET" | "POST", path: string, body?: object, cookie?: string) {
  const res = await app.inject({ method, url: path, payload: body, headers: cookie ? { cookie } : {} });
  if (res.statusCode >= 400) throw new Error(`${method} ${path}: ${res.statusCode} ${res.body}`);
  return res;
}

const login = await inject("POST", "/api/teacher/login", { password: PASSWORD });
const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
const newCode = async () => (await inject("POST", "/api/teacher/codes", undefined, cookie)).json().code as string;
const newCompany = async (code: string, name: string) =>
  (await inject("POST", `/api/codes/${code}/companies`, { name, productType: "social", model: "iaas" })).json().id as string;

/** Puts a company's game at a saved state, as if it had been played there. */
async function setState(id: string, state: GameState) {
  await db.execute(sql`
    update companies set state = ${JSON.stringify(state)}::jsonb, day = ${state.day}, cash = ${state.cash},
      users = ${state.users}, model = ${state.model}, status = 'active', updated_at = now()
    where id = ${id}`);
}

interface Timing {
  medianMs: number;
  p95Ms: number;
  meanMs: number;
}
const stats = (ms: number[]): Timing => {
  const s = [...ms].sort((a, b) => a - b);
  return {
    medianMs: s[Math.floor(s.length / 2)]!,
    p95Ms: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!,
    meanMs: s.reduce((a, b) => a + b, 0) / s.length,
  };
};

/** Times fn, after a few warm-up runs. `before` runs untimed ahead of each one. */
async function timeIt(fn: () => Promise<unknown>, before?: () => Promise<unknown>, n = iterations): Promise<Timing> {
  for (let i = 0; i < 5; i++) {
    await before?.();
    await fn();
  }
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    await before?.();
    const t0 = performance.now();
    await fn();
    ms.push(performance.now() - t0);
  }
  return stats(ms);
}

// --- one student's requests, on a late-game company ---
const code = await newCode();
const id = await newCompany(code, "Bench Ltd");
await setState(id, late);
const base = `/api/codes/${code}/companies/${id}`;
const reqs: Record<string, Timing> = {};
reqs["POST continue (day 170)"] = await timeIt(() => inject("POST", `${base}/continue`), () => setState(id, late));
reqs["POST action: hire"] = await timeIt(() => inject("POST", `${base}/actions`, { type: "hire", pool: "support" }), () => setState(id, late));
reqs["GET company"] = await timeIt(() => inject("GET", base));
reqs["GET company meta"] = await timeIt(() => inject("GET", `${base}/meta`));
reqs["GET summary"] = await timeIt(() => inject("GET", `${base}/summary`));
reqs["GET price-preview"] = await timeIt(() => inject("GET", `${base}/price-preview?price=12`));
reqs["GET migration-quote"] = await timeIt(() => inject("GET", `${base}/migration-quote?target=paas`));
reqs["GET code (3 companies)"] = await timeIt(async () => inject("GET", `/api/codes/${code}`), undefined);
const responseBytes = {
  continue: (await (async () => (await setState(id, late), inject("POST", `${base}/continue`)))()).body.length,
  company: (await inject("GET", base)).body.length,
  summary: (await inject("GET", `${base}/summary`)).body.length,
};

// --- a lesson: 30 codes × 3 companies, all on day 180, then everyone presses Continue at once ---
const CODES = 30;
const PER_CODE = 3;
const finished = stateOnDay("iaas", "social", 180);
const lessonIds: string[] = [];
for (let c = 0; c < CODES; c++) {
  const lessonCode = await newCode();
  for (let i = 0; i < PER_CODE; i++) lessonIds.push(await newCompany(lessonCode, `Bench ${c}-${i}`));
}
const dashboard = async () => inject("GET", "/api/teacher/games", undefined, cookie);
for (const lessonId of lessonIds) await setState(lessonId, finished);
reqs[`GET teacher dashboard (${CODES}×${PER_CODE} at day 180)`] = await timeIt(dashboard);
const dashboardBytes = (await dashboard()).body.length;

// Everyone's Continue at once, from day 170 so the games keep going: wall time for the whole class.
const lessonCodes = await db.execute<{ id: string; login_code: string }>(sql`select id, login_code from companies`);
const codeOf = new Map(lessonCodes.map((r) => [r.id, r.login_code]));
const classWave = async () => {
  await Promise.all(lessonIds.map((lessonId) => inject("POST", `/api/codes/${codeOf.get(lessonId)}/companies/${lessonId}/continue`)));
};
const resetClass = async () => {
  await db.execute(sql`
    update companies set state = ${JSON.stringify(late)}::jsonb, day = ${late.day}, cash = ${late.cash}, users = ${late.users},
      model = ${late.model}, status = 'active', updated_at = now()
    where id in ${sql.raw(`(${lessonIds.map((i) => `'${i}'`).join(",")})`)}`);
};
const waveTiming = await timeIt(classWave, resetClass, Math.max(5, Math.floor(iterations / 10)));
reqs[`${lessonIds.length} Continues at once (wall time)`] = waveTiming;

// The dashboard query's plan, at a lesson's size.
const plan = await db.execute<{ "QUERY PLAN": string }>(sql`
  explain (analyze, buffers)
  select lc.code, c.id, c.name, (c.config->>'finalDay')::int, (c.state->>'income')::double precision, c.state->'spend',
    (c.state->'spendByDay'->-1->>'income')::double precision, (c.state->>'paidUsers')::int,
    (c.state->>'satisfaction')::double precision, c.state->'loan'
  from login_codes lc left join companies c on c.login_code = lc.code
  where c.updated_at >= now() - interval '3 hours' and c.archived_at is null and lc.archived = false
  order by lc.created_at desc, c.created_at asc`);
const [{ bytes: stateBytes }] = await db.execute<{ bytes: number }>(
  sql`select pg_column_size(state) as bytes from companies where id = ${lessonIds[0]!}`,
);
const [{ bytes: configBytes }] = await db.execute<{ bytes: number }>(
  sql`select pg_column_size(config) as bytes from companies where id = ${lessonIds[0]!}`,
);

await app.close();
await close();

const f = (ms: number) => `${ms.toFixed(2)} ms`;
console.log(`# Server benchmark (${iterations} iterations, ${url.replace(/\/\/.*@/, "//")})\n`);
console.log("| Request | median | p95 | mean |\n| --- | --- | --- | --- |");
for (const [name, t] of Object.entries(reqs)) console.log(`| ${name} | ${f(t.medianMs)} | ${f(t.p95Ms)} | ${f(t.meanMs)} |`);
console.log(`\nResponse bytes: continue ${responseBytes.continue}, company ${responseBytes.company}, summary ${responseBytes.summary}, dashboard ${dashboardBytes}`);
console.log(`Stored (TOAST-compressed) bytes per company: state ${stateBytes}, config ${configBytes}`);
console.log(`\nDashboard query plan:\n${plan.map((r) => `    ${r["QUERY PLAN"]}`).join("\n")}`);
if (values.json) writeFileSync(values.json, JSON.stringify({ requests: reqs, responseBytes, dashboardBytes, stateBytes, configBytes }, null, 2));
process.exit(0);
