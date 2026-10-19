import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createSim, defaultConfig } from "@xaas/sim";
import { buildApp } from "../src/app.ts";
import { companies } from "../src/db/schema.ts";
import type {
  ActionBody,
  CompanyView,
  ContinueResult,
  MetaView,
  MigrationQuoteView,
  SummaryView,
  TeacherCodeView,
} from "../src/api-types.ts";
import { setupTestDb } from "./testDb.ts";

const PASSWORD = "test-teacher-password";
const sim = createSim({
  ...defaultConfig,
  startingCash: 1000,
  // IaaS costs a flat 25 a day (750 a month), with nothing upfront, unless a test says otherwise. Leaving it costs
  // 200, and PaaS 100 upfront and 10 a day, so a migration between them fits in the starting cash.
  models: {
    ...defaultConfig.models,
    iaas: {
      ...defaultConfig.models.iaas,
      upfrontCost: 0,
      monthlyCost: 750,
      monthlyCostPerUser: 0,
      opsNeeded: 2,
      exitPenalty: 200,
    },
    paas: { ...defaultConfig.models.paas, upfrontCost: 100, monthlyCost: 300, monthlyCostPerUser: 0 },
  },
  // Seeds are random here, so migrations never overrun.
  migration: { ...defaultConfig.migration, overrun: { ...defaultConfig.migration.overrun, chance: 0 } },
  // No starting staff, so continue charges only the model's running cost unless a test hires someone.
  staff: {
    developers: { ...defaultConfig.staff.developers, dayRate: 10, startingCount: 0 },
    ops: { ...defaultConfig.staff.ops, dayRate: 4, startingCount: 0 },
  },
  // No scripted events, so continue charges and outages are only the ones a test sets up.
  events: [],
});

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  testDb = await setupTestDb();
  app = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim });
});

afterAll(async () => {
  await app?.close();
  await testDb?.close();
});

beforeEach(async () => {
  await testDb.reset();
});

async function teacherCookie() {
  const res = await app.inject({ method: "POST", url: "/api/teacher/login", payload: { password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "teacher");
  return { teacher: cookie!.value };
}

async function newCode() {
  const res = await app.inject({ method: "POST", url: "/api/teacher/codes", cookies: await teacherCookie() });
  expect(res.statusCode).toBe(201);
  return res.json<TeacherCodeView>().code;
}

async function newCompany(code: string, body: object = { name: "Acme", productType: "ecommerce", model: "iaas" }) {
  return app.inject({ method: "POST", url: `/api/codes/${code}/companies`, payload: body });
}

describe("teacher sign-in", () => {
  it("rejects the wrong password", async () => {
    const res = await app.inject({ method: "POST", url: "/api/teacher/login", payload: { password: "nope" } });
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toHaveLength(0);
  });

  it("requires a session for teacher routes", async () => {
    expect((await app.inject({ method: "GET", url: "/api/teacher/me" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/teacher/codes" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/teacher/codes" })).statusCode).toBe(401);
  });

  it("rejects a tampered session cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/api/teacher/me", cookies: { teacher: String(Date.now()) } });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the session after signing in", async () => {
    const res = await app.inject({ method: "GET", url: "/api/teacher/me", cookies: await teacherCookie() });
    expect(res.statusCode).toBe(200);
  });
});

describe("login codes", () => {
  it("creates unique random 8-digit codes and lists them", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) codes.add(await newCode());
    expect(codes.size).toBe(20);
    for (const code of codes) expect(code).toMatch(/^[1-9]\d{7}$/);

    const res = await app.inject({ method: "GET", url: "/api/teacher/codes", cookies: await teacherCookie() });
    expect(res.json<TeacherCodeView[]>().map((c) => c.code).sort()).toEqual([...codes].sort());
  });

  it("returns a clear error for an unknown code", async () => {
    for (const code of ["12345678", "abc", "1234567890"]) {
      const res = await app.inject({ method: "GET", url: `/api/codes/${code}` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "unknown_code" });
    }
  });

  it("shows a known code with no companies yet", async () => {
    const code = await newCode();
    const res = await app.inject({ method: "GET", url: `/api/codes/${code}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ code, companies: [] });
  });
});

describe("companies", () => {
  it("creates a company on day 1 with starting cash", async () => {
    const code = await newCode();
    const res = await newCompany(code);
    expect(res.statusCode).toBe(201);
    expect(res.json<CompanyView>()).toMatchObject({
      name: "Acme",
      productType: "ecommerce",
      model: "iaas",
      day: 1,
      finalDay: 180,
      cash: 1000,
      status: "active",
    });
  });

  it("rejects invalid choices with the sim's message", async () => {
    const code = await newCode();
    const res = await newCompany(code, { name: "Acme", productType: "crafting", model: "iaas" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "unknown_product_type" });
    expect((await newCompany(code, { name: " ", productType: "social", model: "iaas" })).json()).toMatchObject({
      error: "name_required",
    });
  });

  it("rejects a profane name and creates nothing", async () => {
    const code = await newCode();
    const res = await newCompany(code, { name: "Big Arse Ltd", productType: "social", model: "iaas" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "name_not_allowed", message: expect.stringContaining("another") });
    expect(await testDb.db.select().from(companies).where(eq(companies.loginCode, code))).toHaveLength(0);
  });

  it("does not accept client-supplied state", async () => {
    const code = await newCode();
    const res = await newCompany(code, { name: "Acme", productType: "ecommerce", model: "iaas", cash: 1_000_000, day: 99 });
    expect(res.json<CompanyView>()).toMatchObject({ cash: 1000, day: 1 });
  });

  it("cannot create a company under an unknown code", async () => {
    expect((await newCompany("12345678")).statusCode).toBe(404);
  });

  it("lists companies under their code only", async () => {
    const a = await newCode();
    const b = await newCode();
    const company = (await newCompany(a)).json<CompanyView>();
    expect((await app.inject({ method: "GET", url: `/api/codes/${a}` })).json().companies).toEqual([company]);
    expect((await app.inject({ method: "GET", url: `/api/codes/${b}` })).json().companies).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/api/codes/${b}/companies/${company.id}` })).statusCode).toBe(404);
  });

  it("returns 404 for a malformed company id", async () => {
    const code = await newCode();
    expect((await app.inject({ method: "GET", url: `/api/codes/${code}/companies/not-a-uuid` })).statusCode).toBe(404);
  });
});

describe("continue", () => {
  it("advances exactly one day and saves the result", async () => {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;

    const res = await app.inject({ method: "POST", url: `${url}/continue` });
    expect(res.statusCode).toBe(200);
    const body = res.json<ContinueResult>();
    expect(body.company).toMatchObject({ day: 2, cash: 975 });
    expect(body.log).toHaveLength(1);
    expect(body.log[0]!.day).toBe(2);

    // Resuming later (a fresh request, as from another machine) sees the saved state.
    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({ day: 2, cash: 975 });
  });

  it("serialises concurrent presses so each advances one day", async () => {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}/continue`;
    const results = await Promise.all(Array.from({ length: 5 }, () => app.inject({ method: "POST", url })));
    const days = results.map((r) => r.json<ContinueResult>().company.day).sort((x, y) => x - y);
    expect(days).toEqual([2, 3, 4, 5, 6]);
  });

  it("returns 404 for another code's company", async () => {
    const a = await newCode();
    const b = await newCode();
    const company = (await newCompany(a)).json<CompanyView>();
    const res = await app.inject({ method: "POST", url: `/api/codes/${b}/companies/${company.id}/continue` });
    expect(res.statusCode).toBe(404);
  });
});

describe("staff actions", () => {
  async function setup() {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    return { code, company, url, act };
  }

  it("starts with the configured staff and the model's ops requirement", async () => {
    const { company } = await setup();
    expect(company).toMatchObject({ developers: 0, ops: 0, opsNeeded: 2, dailyStaffCost: 0 });
  });

  it("hires staff and keeps them across reloads", async () => {
    const { url, act } = await setup();
    const hireDev: ActionBody = { type: "hire", pool: "developers" };
    expect((await act(hireDev)).statusCode).toBe(200);
    const res = await act({ type: "hire", pool: "ops" });
    expect(res.statusCode).toBe(200);
    expect(res.json<CompanyView>()).toMatchObject({ developers: 1, ops: 1, dailyStaffCost: 14, day: 1, cash: 1000 });

    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({ developers: 1, ops: 1 });
  });

  it("deducts staff cost on continue", async () => {
    const { url, act } = await setup();
    await act({ type: "hire", pool: "developers" });
    await act({ type: "hire", pool: "developers" });
    const body = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    expect(body.company).toMatchObject({ day: 2, cash: 1000 - 25 - 20, developers: 2 });
    expect(body.log[0]!.entries).toContainEqual({ text: "Developers pay (2)", cashDelta: -20, category: "staff" });
  });

  it("rejects letting go below zero with 400 and changes nothing", async () => {
    const { url, act } = await setup();
    const res = await act({ type: "letGo", pool: "ops" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "no_staff" });
    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({ ops: 0 });
  });

  it("validates the body", async () => {
    const { act } = await setup();
    for (const payload of [{ type: "promote", pool: "ops" }, { type: "hire", pool: "sales" }, { type: "hire" }]) {
      expect((await act(payload)).statusCode).toBe(400);
    }
    // Extra fields are stripped, so a client can't set headcount directly.
    expect((await act({ type: "hire", pool: "ops", ops: 50 })).json<CompanyView>().ops).toBe(1);
  });

  it("returns 404 for another code's company", async () => {
    const { company } = await setup();
    const other = await newCode();
    const res = await app.inject({
      method: "POST",
      url: `/api/codes/${other}/companies/${company.id}/actions`,
      payload: { type: "hire", pool: "developers" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "unknown_company" });
  });

  it("serialises concurrent hires so none are lost", async () => {
    const { url, act } = await setup();
    await Promise.all(Array.from({ length: 5 }, () => act({ type: "hire", pool: "developers" })));
    expect((await app.inject({ method: "GET", url })).json<CompanyView>().developers).toBe(5);
  });

  it("shows a game saved before staff existed with no staff", async () => {
    const { company, url } = await setup();
    const v1 = { version: 1, companyName: "Acme", productType: "ecommerce", model: "iaas", day: 3, cash: 950, rng: 1 };
    await testDb.db.execute(sql`update companies set state = ${JSON.stringify(v1)}::jsonb where id = ${company.id}`);
    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({ day: 3, developers: 0, ops: 0 });
    const res = await app.inject({ method: "POST", url: `${url}/continue` });
    expect(res.json<ContinueResult>().company).toMatchObject({ day: 4, cash: 925 });
  });
});

describe("users, capacity and uptime", () => {
  async function setup() {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    return { code, company, url };
  }

  it("starts with the product's users, full uptime and capacity cut for missing ops", async () => {
    const { company } = await setup();
    const { startingUsers, loadPerUser } = defaultConfig.productTypes.ecommerce.growth;
    expect(company).toMatchObject({
      users: startingUsers,
      load: startingUsers * loadPerUser,
      uptime: 100,
      outageDays: 0,
      // IaaS needs 2 ops and the test config starts with none.
      capacity: Math.round(defaultConfig.models.iaas.capacity * defaultConfig.capacity.unstaffedShare),
    });
  });

  it("grows users on continue and keeps them across reloads", async () => {
    const { company, url } = await setup();
    let latest = company;
    for (let i = 0; i < 3; i++) {
      latest = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>().company;
    }
    expect(latest.users).toBeGreaterThan(company.users);
    expect(latest.load).not.toBe(company.load);
    expect(latest.uptime).toBe(100);
    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({
      users: latest.users,
      load: latest.load,
      uptime: 100,
    });
  });

  it("raises capacity when ops are hired", async () => {
    const { company, url } = await setup();
    const res = await app.inject({ method: "POST", url: `${url}/actions`, payload: { type: "hire", pool: "ops" } });
    expect(res.json<CompanyView>().capacity).toBeGreaterThan(company.capacity);
  });

  it("logs an outage and saves the lower uptime when load is over capacity", async () => {
    const tight = createSim({
      ...sim.config,
      models: { ...sim.config.models, iaas: { ...sim.config.models.iaas, capacity: 100 } },
    });
    const tightApp = await buildApp({
      db: testDb.db,
      teacherPassword: PASSWORD,
      sessionSecret: "x".repeat(32),
      sim: tight,
    });
    try {
      const { url } = await setup();
      const body = (await tightApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
      expect(body.company.outageDays).toBe(1);
      expect(body.company.uptime).toBeLessThan(100);
      expect(body.log[0]!.entries[0]).toMatchObject({ kind: "outage" });
      expect((await tightApp.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({
        outageDays: 1,
        uptime: body.company.uptime,
      });
    } finally {
      await tightApp.close();
    }
  });

  it("shows a game saved before users existed with the product's starting users", async () => {
    const { company, url } = await setup();
    const v2 = {
      version: 2,
      companyName: "Acme",
      productType: "social",
      model: "iaas",
      day: 3,
      cash: 950,
      rng: 1,
      developers: 0,
      ops: 2,
    };
    await testDb.db.execute(sql`update companies set state = ${JSON.stringify(v2)}::jsonb where id = ${company.id}`);
    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({
      day: 3,
      ops: 2,
      users: defaultConfig.productTypes.social.growth.startingUsers,
      uptime: 100,
    });
    const res = await app.inject({ method: "POST", url: `${url}/continue` });
    expect(res.json<ContinueResult>().company.day).toBe(4);
  });
});

describe("ledger and bankruptcy", () => {
  async function setup() {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    return { code, company, url };
  }
  const setCash = (id: string, cash: number) =>
    testDb.db.execute(sql`update companies set state = jsonb_set(state, '{cash}', ${String(cash)}::jsonb) where id = ${id}`);

  it("starts active with nothing spent", async () => {
    const { company } = await setup();
    expect(company).toMatchObject({ status: "active", spend: { staff: 0, infrastructure: 0, addons: 0 } });
    expect(company.monthlyInfrastructureCost).toBe(750);
  });

  it("charges the model's upfront cost when the company starts", async () => {
    const pricey = createSim({
      ...sim.config,
      models: { ...sim.config.models, iaas: { ...sim.config.models.iaas, upfrontCost: 300 } },
    });
    const priceyApp = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim: pricey });
    try {
      const code = await newCode();
      const res = await priceyApp.inject({
        method: "POST",
        url: `/api/codes/${code}/companies`,
        payload: { name: "Acme", productType: "ecommerce", model: "iaas" },
      });
      expect(res.json<CompanyView>()).toMatchObject({ cash: 700, spend: { infrastructure: 300 } });
    } finally {
      await priceyApp.close();
    }
  });

  it("totals spend by category on continue and keeps it across reloads", async () => {
    const { url } = await setup();
    await app.inject({ method: "POST", url: `${url}/actions`, payload: { type: "hire", pool: "ops" } });
    let body: ContinueResult | undefined;
    for (let i = 0; i < 2; i++) body = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    expect(body!.log[0]!.entries).toEqual([
      { text: expect.stringContaining("running costs"), cashDelta: -25, category: "infrastructure" },
      { text: "Ops staff pay (1)", cashDelta: -4, category: "staff" },
    ]);
    const spend = { staff: 8, infrastructure: 50, addons: 0 };
    expect(body!.company).toMatchObject({ cash: 1000 - 58, spend });
    expect((await app.inject({ method: "GET", url })).json<CompanyView>().spend).toEqual(spend);
  });

  it("goes bankrupt when cash drops below zero, then rejects continue and actions with 409", async () => {
    const { company, url } = await setup();
    await setCash(company.id, 10);
    const res = await app.inject({ method: "POST", url: `${url}/continue` });
    expect(res.statusCode).toBe(200);
    const body = res.json<ContinueResult>();
    expect(body.company).toMatchObject({ day: 2, cash: -15, status: "bankrupt" });
    expect(body.log[0]!.entries.at(-1)).toMatchObject({ kind: "bankrupt" });

    for (const attempt of [
      app.inject({ method: "POST", url: `${url}/continue` }),
      app.inject({ method: "POST", url: `${url}/actions`, payload: { type: "hire", pool: "ops" } }),
    ]) {
      const rejected = await attempt;
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ error: "bankrupt", message: expect.stringContaining("bankrupt") });
    }

    // Nothing changed, and the game still shows as bankrupt after a reload.
    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({
      day: 2,
      cash: -15,
      ops: 0,
      status: "bankrupt",
    });
    const [row] = await testDb.db.select().from(companies).where(eq(companies.id, company.id));
    expect(row!.status).toBe("bankrupt");
  });

  it("keeps going at exactly zero cash", async () => {
    const { company, url } = await setup();
    await setCash(company.id, 25);
    const body = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    expect(body.company).toMatchObject({ cash: 0, status: "active" });
    expect((await app.inject({ method: "POST", url: `${url}/continue` })).statusCode).toBe(200);
  });
});

describe("game end and summary", () => {
  // A 5-day game: continue plays days 2 to 5, then the game is over.
  const short = createSim({ ...sim.config, finalDay: 5 });
  let shortApp: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    shortApp = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim: short });
  });

  afterAll(async () => {
    await shortApp?.close();
  });

  async function setup() {
    const code = await newCode();
    const res = await shortApp.inject({
      method: "POST",
      url: `/api/codes/${code}/companies`,
      payload: { name: "Acme", productType: "ecommerce", model: "iaas" },
    });
    const url = `/api/codes/${code}/companies/${res.json<CompanyView>().id}`;
    return { code, url, id: res.json<CompanyView>().id };
  }

  it("finishes after the final day, then rejects continue and actions with 409", async () => {
    const { id, url } = await setup();
    await shortApp.inject({ method: "POST", url: `${url}/actions`, payload: { type: "hire", pool: "ops" } });
    const logs: ContinueResult["log"] = [];
    let body: ContinueResult | undefined;
    for (let day = 2; day <= 5; day++) {
      const res = await shortApp.inject({ method: "POST", url: `${url}/continue` });
      expect(res.statusCode).toBe(200);
      body = res.json<ContinueResult>();
      logs.push(...body.log);
      expect(body.company).toMatchObject({ day, status: day < 5 ? "active" : "finished" });
    }
    expect(body!.log[0]!.entries.at(-1)).toMatchObject({ kind: "finished" });

    for (const attempt of [
      shortApp.inject({ method: "POST", url: `${url}/continue` }),
      shortApp.inject({ method: "POST", url: `${url}/actions`, payload: { type: "hire", pool: "ops" } }),
    ]) {
      const rejected = await attempt;
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ error: "finished", message: expect.stringContaining("game is over") });
    }

    // Nothing changed, and the game still shows as finished after a reload and in the company list.
    expect((await shortApp.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({
      day: 5,
      ops: 1,
      status: "finished",
    });
    const [row] = await testDb.db.select().from(companies).where(eq(companies.id, id));
    expect(row!.status).toBe("finished");

    // The summary's totals: 4 days of IaaS at 25 and 1 ops person at 4, matching the day logs.
    const res = await shortApp.inject({ method: "GET", url: `${url}/summary` });
    expect(res.statusCode).toBe(200);
    const summary = res.json<SummaryView>();
    expect(summary).toMatchObject({
      companyName: "Acme",
      ending: "completed",
      day: 5,
      finalDay: 5,
      cash: 1000 - 116,
      uptime: 100,
      migrations: 0,
      spend: { staff: 16, infrastructure: 100, addons: 0 },
      totalSpend: 116,
    });
    expect(summary.users).toBeGreaterThan(0);
    const logged = (category: string) =>
      logs.flatMap((d) => d.entries).filter((e) => e.category === category).reduce((sum, e) => sum - e.cashDelta, 0);
    expect(summary.spend).toEqual({ staff: logged("staff"), infrastructure: logged("infrastructure"), addons: 0 });
    expect(summary.days.map((d) => [d.day, d.staff, d.infrastructure, d.cash])).toEqual([
      [1, 0, 0, 1000],
      [2, 4, 25, 971],
      [3, 4, 25, 942],
      [4, 4, 25, 913],
      [5, 4, 25, 884],
    ]);
  });

  it("summarises a bankrupt game", async () => {
    const { id, url } = await setup();
    await testDb.db.execute(sql`update companies set state = jsonb_set(state, '{cash}', '10'::jsonb) where id = ${id}`);
    await shortApp.inject({ method: "POST", url: `${url}/continue` });
    const summary = (await shortApp.inject({ method: "GET", url: `${url}/summary` })).json<SummaryView>();
    expect(summary).toMatchObject({ ending: "bankrupt", day: 2, cash: -15 });
  });

  it("gives a summary so far for a game still being played", async () => {
    const { url } = await setup();
    await shortApp.inject({ method: "POST", url: `${url}/continue` });
    const summary = (await shortApp.inject({ method: "GET", url: `${url}/summary` })).json<SummaryView>();
    expect(summary).toMatchObject({ ending: null, day: 2, totalSpend: 25 });
  });

  it("is 404 for a company under another code", async () => {
    const { url } = await setup();
    const other = await newCode();
    const res = await shortApp.inject({ method: "GET", url: url.replace(/codes\/\d+/, `codes/${other}`) + "/summary" });
    expect(res.statusCode).toBe(404);
  });
});

describe("features", () => {
  async function setup(model = "iaas") {
    const code = await newCode();
    const company = (await newCompany(code, { name: "Acme", productType: "ecommerce", model })).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    return { code, company, url, act };
  }
  // The cheapest feature, so builds finish in a few days.
  const [cheapest] = defaultConfig.productTypes.ecommerce.features.toSorted((a, b) => a.devDays - b.devDays);
  const statusOf = (company: CompanyView, id = cheapest!.id) => company.features.find((f) => f.id === id)!;

  it("lists the product's features from config, none started", async () => {
    const { company } = await setup();
    expect(company.features.map((f) => f.id)).toEqual(defaultConfig.productTypes.ecommerce.features.map((f) => f.id));
    expect(company.features.every((f) => f.status === "notStarted" && f.progress === 0)).toBe(true);
  });

  it("starts a build, progresses with developers on continue and completes at its cost", async () => {
    const { url, act } = await setup();
    for (let i = 0; i < 3; i++) await act({ type: "hire", pool: "developers" });
    const building: ActionBody = { type: "buildFeature", feature: cheapest!.id };
    const started = await act(building);
    expect(started.statusCode).toBe(200);
    const daysNeeded = Math.ceil(cheapest!.devDays / 3);
    expect(statusOf(started.json<CompanyView>())).toMatchObject({ status: "building", progress: 0, daysLeft: daysNeeded });

    let body: ContinueResult | undefined;
    for (let day = 1; day <= daysNeeded; day++) {
      body = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
      const expected = day < daysNeeded ? { status: "building", progress: 3 * day } : { status: "built" };
      expect(statusOf(body.company)).toMatchObject(expected);
    }
    expect(body!.log[0]!.entries[0]).toMatchObject({ kind: "feature", text: expect.stringContaining("Feature built") });

    // Kept across reloads, and can't be built twice.
    expect(statusOf((await app.inject({ method: "GET", url })).json<CompanyView>())).toMatchObject({
      status: "built",
      progress: cheapest!.devDays,
    });
    const again = await act(building);
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: "feature_built" });
  });

  it("rejects a build on SaaS with 400 and changes nothing", async () => {
    const { url, act } = await setup("saas");
    const res = await act({ type: "buildFeature", feature: cheapest!.id });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "saas_features", message: expect.stringContaining("add-ons") });
    expect(statusOf((await app.inject({ method: "GET", url })).json<CompanyView>()).status).toBe("notStarted");
  });

  it("rejects unknown features and validates the body", async () => {
    const { act } = await setup();
    const unknown = await act({ type: "buildFeature", feature: "teleport" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: "unknown_feature" });
    const bad = [{ type: "buildFeature" }, { type: "buildFeature", feature: 5 }, { type: "buildFeature", pool: "ops" }];
    for (const payload of bad) {
      expect((await act(payload)).statusCode).toBe(400);
    }
    // Extra fields are stripped, so a client can't set progress directly.
    const res = await act({ type: "buildFeature", feature: cheapest!.id, progress: 999 });
    expect(statusOf(res.json<CompanyView>())).toMatchObject({ status: "building", progress: 0 });
  });

  it("returns 404 for another code's company", async () => {
    const { company } = await setup();
    const other = await newCode();
    const res = await app.inject({
      method: "POST",
      url: `/api/codes/${other}/companies/${company.id}/actions`,
      payload: { type: "buildFeature", feature: cheapest!.id },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "unknown_company" });
  });

  it("shows a game saved before features existed with none started", async () => {
    const { company, url } = await setup();
    const [row] = await testDb.db.select().from(companies).where(eq(companies.id, company.id));
    const { features: _f, ...v4 } = { ...row!.state, version: 4 };
    await testDb.db.execute(sql`update companies set state = ${JSON.stringify(v4)}::jsonb where id = ${company.id}`);
    const loaded = (await app.inject({ method: "GET", url })).json<CompanyView>();
    expect(loaded.features.every((f) => f.status === "notStarted")).toBe(true);
    expect((await app.inject({ method: "POST", url: `${url}/continue` })).statusCode).toBe(200);
  });
});

describe("SaaS add-ons", () => {
  // Starting staff is 0 here, so a company hires the configuration team itself.
  const { minConfigDevelopers } = defaultConfig.addons;
  const [addon] = defaultConfig.productTypes.ecommerce.features;

  async function setup(model = "saas", developers = minConfigDevelopers) {
    const code = await newCode();
    const company = (await newCompany(code, { name: "Acme", productType: "ecommerce", model })).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    for (let i = 0; i < developers; i++) await act({ type: "hire", pool: "developers" });
    return { company, url, act };
  }
  const buy: ActionBody = { type: "buyAddon", feature: addon!.id };
  const statusOf = (company: CompanyView) => company.features.find((f) => f.id === addon!.id)!.status;

  it("buys an add-on on SaaS, active at once, and shows its monthly bill", async () => {
    const { company, url, act } = await setup();
    expect(company.monthlyAddonCost).toBe(0);
    const res = await act(buy);
    expect(res.statusCode).toBe(200);
    const bought = res.json<CompanyView>();
    expect(statusOf(bought)).toBe("addon");
    expect(bought).toMatchObject({ day: 1, cash: company.cash });
    expect(bought.monthlyAddonCost).toBe(Math.round(bought.users * addon!.addonPricePerUser));
    // Kept across reloads, and can't be bought twice.
    expect(statusOf((await app.inject({ method: "GET", url })).json<CompanyView>())).toBe("addon");
    const again = await act(buy);
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: "addon_active" });
  });

  it("bills the add-on per user on continue, as add-ons spend", async () => {
    const { act, url } = await setup();
    const bought = (await act(buy)).json<CompanyView>();
    const res = await app.inject({ method: "POST", url: `${url}/continue` });
    const { company, log } = res.json<ContinueResult>();
    const charge = Math.round((bought.users * addon!.addonPricePerUser) / defaultConfig.billing.daysPerMonth);
    expect(log[0]!.entries.filter((e) => e.category === "addons")).toEqual([
      { text: expect.stringContaining(addon!.name), cashDelta: -charge, category: "addons" },
    ]);
    expect(company.spend.addons).toBe(charge);
    const reloaded = (await app.inject({ method: "GET", url })).json<CompanyView>();
    expect(reloaded.spend.addons).toBe(charge);
  });

  it("rejects buying on IaaS with 400 and changes nothing", async () => {
    const { act, url } = await setup("iaas");
    const res = await act(buy);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "not_saas" });
    expect(statusOf((await app.inject({ method: "GET", url })).json<CompanyView>())).toBe("notStarted");
  });

  it("rejects buying without the configuration team, explaining why", async () => {
    const { act } = await setup("saas", minConfigDevelopers - 1);
    const res = await act(buy);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "config_team", message: expect.stringContaining("developer") });
  });

  it("rejects unknown features and validates the body", async () => {
    const { act } = await setup();
    const unknown = await act({ type: "buyAddon", feature: "teleport" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: "unknown_feature" });
    for (const payload of [{ type: "buyAddon" }, { type: "buyAddon", feature: 5 }, { type: "buyAddon", pool: "ops" }]) {
      expect((await act(payload)).statusCode).toBe(400);
    }
  });
});

describe("migration", () => {
  async function setup() {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    const next = async () => (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    return { code, company, url, act, next };
  }
  const toPaas: ActionBody = { type: "startMigration", model: "paas" };

  it("starts with no migration and none made", async () => {
    const { company } = await setup();
    expect(company).toMatchObject({ migration: null, migrations: 0 });
  });

  it("starts a migration, shows its phase and days left, and switches model when it completes", async () => {
    const { url, act, next } = await setup();
    const started = await act(toPaas);
    expect(started.statusCode).toBe(200);
    expect(started.json<CompanyView>()).toMatchObject({
      day: 1,
      cash: 1000,
      model: "iaas",
      migration: {
        from: "iaas",
        to: "paas",
        phase: "planning",
        phaseDaysLeft: 5,
        daysLeft: 14,
        totalDays: 14,
        overrunDays: 0,
      },
    });
    // Kept across reloads.
    expect((await app.inject({ method: "GET", url })).json<CompanyView>().migration).toMatchObject({ to: "paas" });

    let body: ContinueResult | undefined;
    for (let day = 1; day <= 5; day++) body = await next();
    expect(body!.company.migration).toMatchObject({ phase: "testing", phaseDaysLeft: 2, daysLeft: 9 });
    expect(body!.log[0]!.entries).toContainEqual(
      expect.objectContaining({ kind: "migration", text: expect.stringContaining("Planning done") }),
    );
    for (let day = 6; day <= 13; day++) body = await next();
    expect(body!.company).toMatchObject({ model: "iaas", opsNeeded: 2, migration: { phase: "moving", daysLeft: 1 } });

    body = await next();
    expect(body.company).toMatchObject({ day: 15, model: "paas", opsNeeded: 1, migration: null, migrations: 1 });
    expect(body.company.monthlyInfrastructureCost).toBe(sim.config.models.paas.monthlyCost);
    expect(body.log[0]!.entries).toContainEqual(
      expect.objectContaining({ kind: "migration", text: expect.stringContaining("Migration complete") }),
    );
    // The model column follows, for the dashboard.
    const [row] = await testDb.db.select().from(companies).where(eq(companies.model, "paas"));
    expect(row?.day).toBe(15);
  });

  it("rejects a second start while one is running, and the current model, with 400", async () => {
    const { url, act, next } = await setup();
    await act(toPaas);
    await next();
    const again = await act({ type: "startMigration", model: "saas" });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: "migration_running" });
    expect((await app.inject({ method: "GET", url })).json<CompanyView>().migration).toMatchObject({
      to: "paas",
      daysLeft: 13,
    });

    const { act: actFresh } = await setup();
    const same = await actFresh({ type: "startMigration", model: "iaas" });
    expect(same.statusCode).toBe(400);
    expect(same.json()).toMatchObject({ error: "same_model" });
  });

  it("moves staff between pools, mid-migration too", async () => {
    const { act } = await setup();
    await act({ type: "hire", pool: "developers" });
    await act(toPaas);
    const moved = await act({ type: "moveStaff", to: "ops" });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<CompanyView>()).toMatchObject({ developers: 0, ops: 1, migration: { daysLeft: 14 } });
    const empty = await act({ type: "moveStaff", to: "ops" });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: "no_staff" });
  });

  it("validates the body", async () => {
    const { act } = await setup();
    const bad = [
      { type: "startMigration" },
      { type: "startMigration", model: "mainframe" },
      { type: "startMigration", pool: "ops" },
      { type: "moveStaff" },
      { type: "moveStaff", to: "sales" },
      { type: "moveStaff", pool: "ops" },
    ];
    for (const payload of bad) expect((await act(payload)).statusCode).toBe(400);
    // Extra fields are stripped, so a client can't skip ahead.
    const res = await act({ ...toPaas, phase: "moving", phaseDaysDone: 6 });
    expect(res.json<CompanyView>().migration).toMatchObject({ phase: "planning", daysLeft: 14 });
  });

  it("returns 404 for another code's company", async () => {
    const { company, url } = await setup();
    const other = await newCode();
    const res = await app.inject({
      method: "POST",
      url: `/api/codes/${other}/companies/${company.id}/actions`,
      payload: toPaas,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "unknown_company" });
    expect((await app.inject({ method: "GET", url })).json<CompanyView>().migration).toBeNull();
  });

  it("shows a game saved before migration existed with none running", async () => {
    const { company, url } = await setup();
    const [row] = await testDb.db.select().from(companies).where(eq(companies.id, company.id));
    const { migration: _m, migrations: _n, ...v5 } = { ...row!.state, version: 5 };
    await testDb.db.execute(sql`update companies set state = ${JSON.stringify(v5)}::jsonb where id = ${company.id}`);
    const loaded = (await app.inject({ method: "GET", url })).json<CompanyView>();
    expect(loaded).toMatchObject({ migration: null, migrations: 0 });
    expect((await app.inject({ method: "POST", url: `${url}/actions`, payload: toPaas })).statusCode).toBe(200);
  });
});

describe("migration quote", () => {
  async function setup() {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const quote = (target: string) => app.inject({ method: "GET", url: `${url}/migration-quote?target=${target}` });
    return { code, company, url, quote };
  }

  it("quotes the duration and each charge, without changing anything", async () => {
    const { url, quote } = await setup();
    const res = await quote("paas");
    expect(res.statusCode).toBe(200);
    expect(res.json<MigrationQuoteView>()).toEqual({
      from: "iaas",
      to: "paas",
      days: 14,
      upfrontCost: 100,
      doubleBilling: 14 * 10,
      proRata: 14 * 25,
      exitPenalty: 200,
      total: 100 + 140 + 350 + 200,
      overrun: { chance: 0, minDays: 2, maxDays: 5 },
      lostAddons: [],
    });
    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({ cash: 1000, migration: null });
  });

  it("matches what continuing through the migration charges, with no overrun", async () => {
    const { url, quote, company } = await setup();
    const quoted = (await quote("paas")).json<MigrationQuoteView>();
    await app.inject({ method: "POST", url: `${url}/actions`, payload: { type: "startMigration", model: "paas" } });
    let body: ContinueResult | undefined;
    for (let day = 1; day <= quoted.days; day++) {
      body = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    }
    expect(body!.company).toMatchObject({ model: "paas", migration: null, migrations: 1 });
    expect(body!.company.spend.infrastructure - company.spend.infrastructure).toBe(quoted.total);
    expect(company.cash - body!.company.cash).toBe(quoted.total);
  });

  it("rejects an unknown or missing target with 400", async () => {
    const { url, quote } = await setup();
    for (const res of [await quote("mainframe"), await app.inject({ method: "GET", url: `${url}/migration-quote` })]) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "bad_request" });
    }
  });

  it("rejects the current model, and a quote while migrating, with 400", async () => {
    const { url, quote } = await setup();
    expect((await quote("iaas")).json()).toMatchObject({ error: "same_model" });
    await app.inject({ method: "POST", url: `${url}/actions`, payload: { type: "startMigration", model: "paas" } });
    const running = await quote("saas");
    expect(running.statusCode).toBe(400);
    expect(running.json()).toMatchObject({ error: "migration_running" });
  });

  it("returns 404 for another code's company", async () => {
    const { company } = await setup();
    const other = await newCode();
    const res = await app.inject({
      method: "GET",
      url: `/api/codes/${other}/companies/${company.id}/migration-quote?target=paas`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("leaving SaaS (vendor lock-in)", () => {
  // Starting staff is 0 here, so the company hires its configuration team, then buys two add-ons.
  const { minConfigDevelopers } = defaultConfig.addons;
  const [checkout, reviews] = defaultConfig.productTypes.ecommerce.features;

  async function setup() {
    const code = await newCode();
    const company = (await newCompany(code, { name: "Acme", productType: "ecommerce", model: "saas" })).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    for (let i = 0; i < minConfigDevelopers; i++) await act({ type: "hire", pool: "developers" });
    for (const f of [checkout!, reviews!]) await act({ type: "buyAddon", feature: f.id });
    // Enough cash to pay both providers and the exit penalty.
    await testDb.db.execute(
      sql`update companies set state = jsonb_set(state, '{cash}', '1000000') where id = ${company.id}`,
    );
    const quote = (target: string) => app.inject({ method: "GET", url: `${url}/migration-quote?target=${target}` });
    return { url, act, quote };
  }

  it("quotes the add-ons that will be lost when leaving SaaS", async () => {
    const { quote } = await setup();
    const res = await quote("iaas");
    expect(res.statusCode).toBe(200);
    expect(res.json<MigrationQuoteView>()).toMatchObject({
      from: "saas",
      to: "iaas",
      lostAddons: [
        { id: checkout!.id, name: checkout!.name, devDays: checkout!.devDays },
        { id: reviews!.id, name: reviews!.name, devDays: reviews!.devDays },
      ],
    });
  });

  it("removes the add-ons after a SaaS to IaaS migration, stops their bill and makes them buildable", async () => {
    const { url, act } = await setup();
    await act({ type: "startMigration", model: "iaas" });
    let body: ContinueResult | undefined;
    for (let day = 1; day <= 14; day++) {
      body = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    }
    expect(body!.company).toMatchObject({ model: "iaas", migration: null, monthlyAddonCost: 0 });
    expect(body!.log[0]!.entries).toContainEqual(
      expect.objectContaining({ kind: "migration", text: expect.stringContaining("Vendor lock-in") }),
    );
    const statuses = (c: CompanyView) => c.features.map((f) => f.status);
    expect(statuses(body!.company)).toEqual(body!.company.features.map(() => "notStarted"));

    // No more add-on charges, and the lost feature can be built in developer-days.
    const next = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    expect(next.log[0]!.entries.some((e) => e.category === "addons")).toBe(false);
    const built = await act({ type: "buildFeature", feature: checkout!.id });
    expect(built.statusCode).toBe(200);
    const feature = built.json<CompanyView>().features.find((f) => f.id === checkout!.id);
    expect(feature).toMatchObject({ status: "building", progress: 0 });
  });

  it("quotes no lost add-ons for other moves", async () => {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const res = await app.inject({
      method: "GET",
      url: `/api/codes/${code}/companies/${company.id}/migration-quote?target=saas`,
    });
    expect(res.json<MigrationQuoteView>().lostAddons).toEqual([]);
  });
});

describe("scripted events", () => {
  // The default events, on fixed days: the OS patch on day 2 and the traffic spike on day 3. Cash to pay for them.
  const event = (id: string) => defaultConfig.events.find((e) => e.id === id)!;
  const eventSim = createSim({
    ...sim.config,
    startingCash: 100_000,
    events: [
      { ...event("osPatch"), schedule: { type: "fixed", days: [2] } },
      { ...event("trafficSpike"), schedule: { type: "fixed", days: [3] } },
    ],
  });
  let eventApp: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    eventApp = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim: eventSim });
  });

  afterAll(async () => {
    await eventApp?.close();
  });

  async function setup(model: string, ops = 0) {
    const code = await newCode();
    const created = await eventApp.inject({
      method: "POST",
      url: `/api/codes/${code}/companies`,
      payload: { name: "Acme", productType: "social", model },
    });
    const url = `/api/codes/${code}/companies/${created.json<CompanyView>().id}`;
    for (let i = 0; i < ops; i++) {
      await eventApp.inject({ method: "POST", url: `${url}/actions`, payload: { type: "hire", pool: "ops" } });
    }
    const next = async () => (await eventApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    return { url, company: created.json<CompanyView>(), next };
  }

  it("has none before the first one fires", async () => {
    const { company } = await setup("iaas");
    expect(company.events).toEqual([]);
  });

  it("shows the OS patch on its day, explained, and hits IaaS short of ops", async () => {
    const { url, next } = await setup("iaas");
    const { company, log } = await next();
    expect(company.day).toBe(2);
    expect(company.events).toEqual([
      expect.objectContaining({
        id: "osPatch",
        name: "OS security patch",
        model: "iaas",
        layer: "os",
        owner: "you",
        responsibility: "OS and patching is your job on IaaS.",
        shortOfOps: true,
        hit: true,
      }),
    ]);
    const entries = log[0]!.entries;
    expect(entries[0]).toMatchObject({ kind: "event", text: expect.stringContaining("OS and patching is your job on IaaS.") });
    expect(entries).toContainEqual(expect.objectContaining({ kind: "outage" }));
    const cleanUp = event("osPatch").effects.iaas!.shortOfOps!.cost!.amount;
    expect(entries).toContainEqual(expect.objectContaining({ category: "infrastructure", cashDelta: -cleanUp }));
    expect(company.outageDays).toBe(1);

    // Saved with the day: a reload shows the same event.
    expect((await eventApp.inject({ method: "GET", url })).json<CompanyView>().events).toEqual(company.events);
  });

  it("lets an IaaS company with ops patch it, at no cost", async () => {
    const { next } = await setup("iaas", 1);
    const { company } = await next();
    expect(company.events).toEqual([expect.objectContaining({ id: "osPatch", shortOfOps: false, hit: false })]);
    expect(company.outageDays).toBe(0);
  });

  it("does nothing on PaaS: the provider patches it", async () => {
    const { company: before, next } = await setup("paas");
    const { company, log } = await next();
    expect(company.events).toEqual([
      expect.objectContaining({
        id: "osPatch",
        owner: "provider",
        responsibility: "OS and patching is the provider's job on PaaS.",
        hit: false,
      }),
    ]);
    // Only PaaS's running costs: £300 a month here, £10 a day.
    expect(company.cash).toBe(before.cash - 10);
    expect(log[0]!.entries.filter((e) => e.category).map((e) => e.text)).toEqual([
      expect.stringContaining("running costs"),
    ]);
  });

  it("takes on-prem down in a traffic spike, even fully staffed", async () => {
    const { next } = await setup("onprem", eventSim.opsNeeded("onprem"));
    await next();
    const { company } = await next();
    expect(company.day).toBe(3);
    expect(company.events).toEqual([
      expect.objectContaining({ id: "trafficSpike", layer: "runtime", owner: "you", hit: true }),
    ]);
    expect(company.outageDays).toBe(1);
  });

  it("keeps PaaS up in a traffic spike, charging for the burst", async () => {
    const { next } = await setup("paas");
    await next();
    const { company, log } = await next();
    expect(company.events).toEqual([
      expect.objectContaining({ id: "trafficSpike", owner: "provider", hit: false }),
    ]);
    expect(company.outageDays).toBe(0);
    // Scaled to meet the day's load.
    expect(company.capacity).toBe(company.load);
    const burst = log[0]!.entries.find((e) => e.text.startsWith("Traffic spike: scaled up"));
    expect(burst).toMatchObject({ category: "infrastructure" });
    expect(burst!.cashDelta).toBeLessThan(0);
  });
});

describe("provider and SaaS events", () => {
  // The default price rise and feature gap on fixed days: the price rise on day 2 and the gap on day 3. Cash to
  // pay for on-prem's kit.
  const event = (id: string) => defaultConfig.events.find((e) => e.id === id)!;
  const eventSim = createSim({
    ...sim.config,
    startingCash: 100_000,
    events: [
      { ...event("providerPriceRise"), schedule: { type: "fixed", days: [2] } },
      { ...event("saasFeatureGap"), schedule: { type: "fixed", days: [3] } },
    ],
  });
  let eventApp: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    eventApp = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim: eventSim });
  });

  afterAll(async () => {
    await eventApp?.close();
  });

  async function setup(model: string) {
    const code = await newCode();
    const created = await eventApp.inject({
      method: "POST",
      url: `/api/codes/${code}/companies`,
      payload: { name: "Acme", productType: "social", model },
    });
    const url = `/api/codes/${code}/companies/${created.json<CompanyView>().id}`;
    const next = async () => (await eventApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    return { url, company: created.json<CompanyView>(), next };
  }

  it("puts PaaS's charges up from the day of the price rise", async () => {
    const { company: before, next } = await setup("paas");
    const percent = event("providerPriceRise").effects.paas!.priceRise!.percent;
    // £300 a month here, so £10 a day before the rise.
    expect(before.monthlyInfrastructureCost).toBe(300);
    const { company, log } = await next();
    expect(company.events).toEqual([
      expect.objectContaining({
        id: "providerPriceRise",
        layer: "hardware",
        owner: "provider",
        responsibility: "Hardware is the provider's job on PaaS.",
        hit: true,
      }),
    ]);
    const risen = 300 * (1 + percent / 100);
    expect(company.monthlyInfrastructureCost).toBe(risen);
    const charge = Math.round(risen / defaultConfig.billing.daysPerMonth);
    expect(log[0]!.entries).toContainEqual(
      expect.objectContaining({ category: "infrastructure", cashDelta: -charge, text: expect.stringContaining("running costs") }),
    );
    expect(company.cash).toBe(before.cash - charge);
    expect(company.spend.infrastructure).toBe(before.spend.infrastructure + charge);
  });

  it("leaves an on-prem company's charges alone", async () => {
    const { company: before, next } = await setup("onprem");
    const { company } = await next();
    expect(company.events).toEqual([expect.objectContaining({ id: "providerPriceRise", owner: "you", hit: false })]);
    expect(company.monthlyInfrastructureCost).toBe(before.monthlyInfrastructureCost);
  });

  it("gives only a SaaS company the feature gap, and keeps showing it after the day it fired", async () => {
    const saas = await setup("saas");
    await saas.next();
    const { company } = await saas.next();
    expect(company.day).toBe(3);
    expect(company.events).toEqual([
      expect.objectContaining({ id: "saasFeatureGap", layer: "application", owner: "shared", hit: true }),
    ]);
    const { growthMultiplier, features } = event("saasFeatureGap").effects.saas!.featureGap!;
    expect(company.featureGaps).toEqual([
      expect.objectContaining({ id: "saasFeatureGap", model: "saas", feature: features.social, growthMultiplier }),
    ]);
    const { company: later } = await saas.next();
    expect(later.events).toEqual([]);
    expect(later.featureGaps).toEqual(company.featureGaps);
    expect((await eventApp.inject({ method: "GET", url: saas.url })).json<CompanyView>().featureGaps).toEqual(
      company.featureGaps,
    );

    for (const model of ["onprem", "iaas", "paas"]) {
      const other = await setup(model);
      await other.next();
      const { company: day3 } = await other.next();
      expect(day3.day).toBe(3);
      expect(day3.events).toEqual([]);
      expect(day3.featureGaps).toEqual([]);
    }
  });
});

describe("meta", () => {
  it("includes the migration phases and their lengths", async () => {
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta.migrationPhases.map((p) => [p.id, p.days])).toEqual([
      ["planning", 5],
      ["testing", 2],
      ["moving", 7],
    ]);
  });

  it("includes add-on prices per user and the configuration team needed", async () => {
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    const social = meta.productTypes.find((p) => p.id === "social")!;
    expect(social.features).toEqual(
      defaultConfig.productTypes.social.features.map(({ id, name, addonPricePerUser }) => ({ id, name, addonPricePerUser })),
    );
    expect(meta.minConfigDevelopers).toBe(defaultConfig.addons.minConfigDevelopers);
  });

  it("includes staff day rates and ops needed per model", async () => {
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta.staff.map((s) => [s.id, s.dayRate])).toEqual([
      ["developers", 10],
      ["ops", 4],
    ]);
    expect(meta.models.map((m) => m.opsNeeded)).toEqual([3, 2, 1, 0]);
  });

  it("includes each model's upfront and monthly costs", async () => {
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    const iaas = meta.models.find((m) => m.id === "iaas")!;
    expect(iaas).toMatchObject({ upfrontCost: 0, monthlyCost: 750, monthlyCostPerUser: 0 });
    expect(meta.models.find((m) => m.id === "saas")!.monthlyCostPerUser).toBeGreaterThan(0);
  });

  it("lists product types and models from config", async () => {
    const res = await app.inject({ method: "GET", url: "/api/meta" });
    const meta = res.json();
    expect(meta.productTypes.map((p: { id: string }) => p.id)).toEqual(["ecommerce", "social", "video"]);
    expect(meta.models.map((m: { id: string }) => m.id)).toEqual(["onprem", "iaas", "paas", "saas"]);
    expect(meta.startingCash).toBe(1000);
  });

  it("includes each model's comparison and responsibility stack", async () => {
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json();
    type Layer = { id: string; owner: string };
    const owner = (model: string, layer: string) =>
      meta.models.find((m: { id: string }) => m.id === model).stack.find((l: Layer) => l.id === layer).owner;
    for (const m of meta.models) {
      expect(owner(m.id, "data")).toBe("you");
      expect(Object.keys(m.comparison)).toEqual(["upfrontCost", "monthlyCost", "opsNeeded", "control"]);
    }
    expect(owner("saas", "application")).toBe("shared");
    expect(owner("iaas", "os")).toBe("you");
    expect(meta.models.find((m: { id: string }) => m.id === "saas").comparison.opsNeeded).toBe("None");
  });
});
