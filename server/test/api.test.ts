import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createSim, defaultConfig, GAME_STATE_VERSION } from "@xaas/sim";
import { buildApp } from "../src/app.ts";
import { companies } from "../src/db/schema.ts";
import type {
  ActionBody,
  CompanyView,
  ConfigErrorView,
  ContinueResult,
  MetaView,
  MigrationQuoteView,
  PresetsView,
  PresetView,
  PricePreviewView,
  SummaryView,
  TeacherCodeView,
  TeacherGamesView,
  TeacherSummaryView,
} from "../src/api-types.ts";
import { setupTestDb } from "./testDb.ts";

const PASSWORD = "test-teacher-password";
const iaasServers = defaultConfig.models.iaas.servers!;
const paasServers = defaultConfig.models.paas.servers!;
const LIGHT_DEMAND = { cuPerUser: 0.0005, dbuPerUser: 0.0005 };
// The server sizes, ops per server, starting users and starter setups these tests' sums were worked out with (before
// the balance pass and launch day), pinned so that tuning the defaults doesn't change them. Each game launches as it
// starts, with its starter setup in place and its launch users there; the launch tests change that with an override.
const UNITS = { small: 10, medium: 15, large: 20, massive: 25 };
const STARTING_USERS = { ecommerce: 2000, social: 1000, video: 1000 };
const sim = createSim({
  ...defaultConfig,
  startingCash: 1000,
  servers: {
    ...defaultConfig.servers,
    types: {
      ...defaultConfig.servers.types,
      app: { ...defaultConfig.servers.types.app, units: UNITS },
      database: { ...defaultConfig.servers.types.database, units: UNITS },
      cache: { ...defaultConfig.servers.types.cache, units: UNITS },
    },
  },
  // IaaS costs a flat 25 a day (750 a month), with nothing upfront, unless a test says otherwise: its starter VMs (a
  // medium app server and database, needing 1 ops) are free here. Leaving it costs 200, and PaaS 100 upfront and 10 a
  // day, its starter instance and managed database free too, so a migration between them fits in the starting cash.
  models: {
    ...defaultConfig.models,
    onprem: {
      ...defaultConfig.models.onprem,
      servers: {
        ...defaultConfig.models.onprem.servers!,
        opsPerServer: { app: 0.6, database: 0.6, cache: 0.3, loadBalancer: 0.3 },
        starter: [
          { type: "app", size: "large", count: 1 },
          { type: "database", size: "large", count: 1 },
        ],
      },
    },
    iaas: {
      ...defaultConfig.models.iaas,
      upfrontCost: 0,
      monthlyCost: 750,
      monthlyCostPerUser: 0,
      exitPenalty: 200,
      servers: {
        ...iaasServers,
        opsPerServer: { app: 0.5, database: 0.5, cache: 0.25, loadBalancer: 0.25 },
        monthlyCost: {
          ...iaasServers.monthlyCost,
          app: { ...iaasServers.monthlyCost.app, medium: 0 },
          database: { ...iaasServers.monthlyCost.database, medium: 0 },
        },
        starter: [
          { type: "app", size: "medium", count: 1 },
          { type: "database", size: "medium", count: 1 },
        ],
      },
    },
    paas: {
      ...defaultConfig.models.paas,
      upfrontCost: 100,
      monthlyCost: 300,
      monthlyCostPerUser: 0,
      servers: {
        ...paasServers,
        monthlyCost: {
          ...paasServers.monthlyCost,
          app: { medium: 0 },
          database: { ...paasServers.monthlyCost.database, small: 0 },
        },
        starter: [
          { type: "app", size: "medium", count: 1 },
          { type: "database", size: "small", count: 1 },
        ],
      },
    },
  },
  launch: { rampShares: [1] },
  // Seeds are random here, so migrations never overrun.
  migration: { ...defaultConfig.migration, overrun: { ...defaultConfig.migration.overrun, chance: 0 } },
  // No starting staff, so continue charges only the model's running cost unless a test hires someone.
  staff: {
    developers: { ...defaultConfig.staff.developers, dayRate: 10, startingCount: 0 },
    ops: { ...defaultConfig.staff.ops, dayRate: 4, startingCount: 0 },
    support: { ...defaultConfig.staff.support, dayRate: 3, startingCount: 0 },
  },
  // No scripted events, so continue charges and outages are only the ones a test sets up.
  events: [],
  // Everyone on the free tier and none converting, so continue brings in no income unless a test's config says otherwise.
  // Light demand, 2,000 users to a CU and a DBU, so the starter VMs serve every product for weeks even with no ops.
  productTypes: Object.fromEntries(
    Object.entries(defaultConfig.productTypes).map(([id, p]) => [
      id,
      {
        ...p,
        growth: { ...p.growth, launchUsers: STARTING_USERS[id as keyof typeof STARTING_USERS] },
        pricing: { ...p.pricing, freeShare: 1, conversionRate: 0 },
        demand: LIGHT_DEMAND,
      },
    ]),
  ) as typeof defaultConfig.productTypes,
});

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  testDb = await setupTestDb();
  // No rate limit here: tests make plenty of deliberate 404s from the one inject address. It has its own tests below.
  app = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim, rateLimit: false });
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

/** Makes new games use these overrides: saves them as a preset and makes it the active one. Returns its id. */
async function useOverrides(overrides: object, name = "Test") {
  const cookies = await teacherCookie();
  const created = await app.inject({ method: "POST", url: "/api/teacher/presets", payload: { name, overrides }, cookies });
  expect(created.statusCode).toBe(201);
  const { id } = created.json<PresetView>();
  const activated = await app.inject({ method: "POST", url: `/api/teacher/presets/${id}/activate`, cookies });
  expect(activated.statusCode).toBe(200);
  return id;
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

describe("active company limit and retiring", () => {
  const retire = (code: string, id: string) =>
    app.inject({ method: "POST", url: `/api/codes/${code}/companies/${id}/retire` });
  const setStatus = (id: string, status: string) =>
    testDb.db.execute(sql`update companies set status = ${status} where id = ${id}`);
  const statuses = async (code: string) =>
    (await app.inject({ method: "GET", url: `/api/codes/${code}` }))
      .json()
      .companies.map((c: CompanyView) => c.status)
      .sort();

  it("shows the limit in meta", async () => {
    expect((await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>().maxActiveCompanies).toBe(3);
  });

  it("rejects a 4th active company with 409 and a clear message, and creates nothing", async () => {
    const code = await newCode();
    for (let i = 0; i < 3; i++) expect((await newCompany(code)).statusCode).toBe(201);
    const res = await newCompany(code);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "too_many_active", message: expect.stringContaining("Retire one") });
    expect(await testDb.db.select().from(companies).where(eq(companies.loginCode, code))).toHaveLength(3);
  });

  it("counts each code's active companies separately", async () => {
    const a = await newCode();
    const b = await newCode();
    for (let i = 0; i < 3; i++) await newCompany(a);
    expect((await newCompany(b)).statusCode).toBe(201);
  });

  it("allows duplicate names, within a code and across codes", async () => {
    const a = await newCode();
    const b = await newCode();
    expect((await newCompany(a)).statusCode).toBe(201);
    expect((await newCompany(a)).statusCode).toBe(201);
    expect((await newCompany(b)).statusCode).toBe(201);
    const names = (await testDb.db.select().from(companies)).map((c) => c.name);
    expect(names).toEqual(["Acme", "Acme", "Acme"]);
  });

  it("retires an active company, which then doesn't count towards the limit", async () => {
    const code = await newCode();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await newCompany(code)).json<CompanyView>().id);
    const res = await retire(code, ids[0]!);
    expect(res.statusCode).toBe(200);
    expect(res.json<CompanyView>()).toMatchObject({ id: ids[0], status: "retired" });
    const [row] = await testDb.db.select().from(companies).where(eq(companies.id, ids[0]!));
    expect(row!.status).toBe("retired");

    expect((await newCompany(code)).statusCode).toBe(201);
    expect(await statuses(code)).toEqual(["active", "active", "active", "retired"]);
    expect((await newCompany(code)).statusCode).toBe(409);
  });

  it("doesn't count finished or bankrupt games", async () => {
    const code = await newCode();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await newCompany(code)).json<CompanyView>().id);
    await setStatus(ids[0]!, "finished");
    await setStatus(ids[1]!, "bankrupt");
    expect((await newCompany(code)).statusCode).toBe(201);
    expect((await newCompany(code)).statusCode).toBe(201);
    expect((await newCompany(code)).statusCode).toBe(409);
  });

  it("keeps a retired game viewable, with its summary, but rejects continue and actions with 409", async () => {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    await app.inject({ method: "POST", url: `${url}/continue` });
    await retire(code, company.id);

    for (const attempt of [
      app.inject({ method: "POST", url: `${url}/continue` }),
      app.inject({ method: "POST", url: `${url}/actions`, payload: { type: "hire", pool: "ops" } }),
    ]) {
      const rejected = await attempt;
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ error: "retired", message: expect.stringContaining("retired") });
    }

    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({
      day: 2,
      ops: 0,
      status: "retired",
    });
    const summary = await app.inject({ method: "GET", url: `${url}/summary` });
    expect(summary.statusCode).toBe(200);
    expect(summary.json<SummaryView>()).toMatchObject({ companyName: "Acme", day: 2 });
  });

  it("retiring twice is fine, but a finished or bankrupt game can't be retired", async () => {
    const code = await newCode();
    const a = (await newCompany(code)).json<CompanyView>().id;
    const b = (await newCompany(code)).json<CompanyView>().id;
    await retire(code, a);
    expect((await retire(code, a)).json<CompanyView>().status).toBe("retired");
    await setStatus(b, "bankrupt");
    const res = await retire(code, b);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_active" });
    expect(await statuses(code)).toEqual(["bankrupt", "retired"]);
  });

  it("returns 404 when retiring another code's company, or a malformed id", async () => {
    const a = await newCode();
    const b = await newCode();
    const company = (await newCompany(a)).json<CompanyView>();
    expect((await retire(b, company.id)).statusCode).toBe(404);
    expect((await retire(a, "not-a-uuid")).statusCode).toBe(404);
    expect((await retire("12345678", company.id)).statusCode).toBe(404);
    expect(await statuses(a)).toEqual(["active"]);
  });

  it("doesn't go over the limit when creates arrive at once", async () => {
    const code = await newCode();
    await newCompany(code);
    const results = await Promise.all(Array.from({ length: 6 }, () => newCompany(code)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 201, 409, 409, 409, 409]);
    expect(await statuses(code)).toEqual(["active", "active", "active"]);
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
    // IaaS's starter VMs need 1 ops.
    expect(company).toMatchObject({ developers: 0, ops: 0, opsNeeded: 1, dailyStaffCost: 0 });
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
});

describe("support and satisfaction", () => {
  // Everyone's free here: 2,000 free shoppers × 0.003 = 6 tickets a day. A support person clears 30.
  async function setup() {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    const play = async (days: number) => {
      let body: ContinueResult | undefined;
      for (let i = 0; i < days; i++) body = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
      return body!;
    };
    return { company, url, act, play };
  }

  it("starts a company with no support staff here, no tickets, no backlog and happy customers", async () => {
    const { company } = await setup();
    expect(company).toMatchObject({
      support: 0,
      ticketsToday: 0,
      clearedToday: 0,
      backlog: 0,
      satisfaction: 100,
      usualTickets: 6,
      dailyClearance: 0,
    });
  });

  it("hires and lets go support through the actions endpoint, and keeps them across reloads", async () => {
    const { url, act } = await setup();
    const hire: ActionBody = { type: "hire", pool: "support" };
    await act(hire);
    const res = await act(hire);
    expect(res.statusCode).toBe(200);
    expect(res.json<CompanyView>()).toMatchObject({ support: 2, dailyStaffCost: 6, dailyClearance: 60, day: 1 });
    expect((await act({ type: "letGo", pool: "support" })).json<CompanyView>()).toMatchObject({ support: 1 });
    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({ support: 1 });
    await act({ type: "letGo", pool: "support" });
    const none = await act({ type: "letGo", pool: "support" });
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ error: "no_staff" });
  });

  it("builds a backlog and lowers satisfaction with no support, on continue", async () => {
    const { play } = await setup();
    const { company, log } = await play(10);
    expect(company).toMatchObject({ day: 11, clearedToday: 0, support: 0 });
    // At least 6 a day, more as users grow, and none answered.
    expect(company.ticketsToday).toBeGreaterThanOrEqual(6);
    expect(company.backlog).toBeGreaterThanOrEqual(60);
    expect(company.satisfaction).toBeLessThan(70);
    expect(Number.isInteger(company.satisfaction)).toBe(true);
    expect(log).toHaveLength(1);
  });

  it("clears tickets with support staff, paying them each day", async () => {
    const { act, play } = await setup();
    await act({ type: "hire", pool: "support" });
    const { company, log } = await play(3);
    expect(company).toMatchObject({ backlog: 0, satisfaction: 100 });
    expect(company.clearedToday).toBe(company.ticketsToday);
    expect(log[0]!.entries).toContainEqual({ text: "Support staff pay (1)", cashDelta: -3, category: "staff" });
  });

  it("recovers satisfaction once support clears the backlog", async () => {
    const { act, play } = await setup();
    const low = (await play(10)).company.satisfaction;
    await act({ type: "hire", pool: "support" });
    await act({ type: "hire", pool: "support" });
    const { company } = await play(10);
    expect(company.backlog).toBe(0);
    expect(company.satisfaction).toBeGreaterThan(low + 20);
  });

  it("moves staff into support from a named pool", async () => {
    const { act } = await setup();
    await act({ type: "hire", pool: "ops" });
    const moved = await act({ type: "moveStaff", from: "ops", to: "support" });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<CompanyView>()).toMatchObject({ ops: 0, support: 1 });
    for (const payload of [{ type: "moveStaff", from: "sales", to: "ops" }, { type: "hire", pool: "complaints" }]) {
      expect((await act(payload)).statusCode).toBe(400);
    }
    const same = await act({ type: "moveStaff", from: "support", to: "support" });
    expect(same.json()).toMatchObject({ error: "same_pool" });
  });

  it("sends tickets per support person and the satisfaction thresholds in the meta", async () => {
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta).toMatchObject({
      ticketsPerPerson: defaultConfig.support.ticketsPerPerson,
      goodSatisfaction: defaultConfig.support.goodSatisfaction,
      poorSatisfaction: defaultConfig.support.poorSatisfaction,
    });
  });
});

describe("games from an older version", () => {
  async function setup() {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    // As the alpha saved it, before the clean break.
    await testDb.db.execute(
      sql`update companies set state = jsonb_set(state, '{version}', ${String(GAME_STATE_VERSION - 1)}::jsonb) where id = ${company.id}`,
    );
    return { code, company, url };
  }

  it("are refused with a clear message when loading, continuing, acting, quoting or summarising", async () => {
    const { company, url } = await setup();
    const cookies = await teacherCookie();
    for (const res of [
      await app.inject({ method: "GET", url }),
      await app.inject({ method: "POST", url: `${url}/continue` }),
      await app.inject({ method: "POST", url: `${url}/actions`, payload: { type: "hire", pool: "developers" } }),
      await app.inject({ method: "GET", url: `${url}/migration-quote?target=paas` }),
      await app.inject({ method: "GET", url: `${url}/summary` }),
      await app.inject({ method: "GET", url: `/api/teacher/companies/${company.id}/summary`, cookies }),
    ]) {
      expect(res.statusCode).toBe(410);
      expect(res.json()).toMatchObject({ error: "old_version", message: expect.stringContaining("This game is from an older version") });
    }
  });

  it("are left out of the code's companies, and don't count towards its limit", async () => {
    const { code } = await setup();
    expect((await app.inject({ method: "GET", url: `/api/codes/${code}` })).json<{ companies: unknown[] }>().companies).toEqual([]);
    for (const name of ["One", "Two", "Three"]) {
      expect((await newCompany(code, { name, productType: "ecommerce", model: "iaas" })).statusCode).toBe(201);
    }
    const list = (await app.inject({ method: "GET", url: `/api/codes/${code}` })).json<{ companies: CompanyView[] }>();
    expect(list.companies.map((c) => c.name).sort()).toEqual(["One", "Three", "Two"]);
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
    const { loadPerUser } = defaultConfig.productTypes.ecommerce.growth;
    const startingUsers = STARTING_USERS.ecommerce;
    const { cuPerUser, dbuPerUser } = LIGHT_DEMAND;
    const { unstaffedShare } = defaultConfig.capacity;
    // The starter's medium app server and database give 15 CU and 15 DBU, cut to 40% with none of the 1 ops needed.
    const units = UNITS.medium * unstaffedShare;
    expect(company).toMatchObject({
      users: startingUsers,
      load: startingUsers * loadPerUser,
      uptime: 100,
      outageDays: 0,
      opsNeeded: 1,
      capacity: Math.round((units / Math.max(cuPerUser, dbuPerUser)) * loadPerUser),
      units: {
        cu: { demand: startingUsers * cuPerUser, capacity: units },
        dbu: { demand: startingUsers * dbuPerUser, capacity: units, beforeCache: startingUsers * dbuPerUser },
        ch: { capacity: 0, absorbed: 0 },
      },
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
    expect(res.json<CompanyView>().capacity!).toBeGreaterThan(company.capacity!);
  });

  it("logs an outage and saves the lower uptime when load is over capacity", async () => {
    // Shoppers needing a whole CU each, far more than the starter VMs give.
    const { ecommerce } = sim.config.productTypes;
    const tight = createSim({
      ...sim.config,
      productTypes: { ...sim.config.productTypes, ecommerce: { ...ecommerce, demand: { ...ecommerce.demand, cuPerUser: 1 } } },
    });
    const tightApp = await buildApp({
      db: testDb.db,
      teacherPassword: PASSWORD,
      sessionSecret: "x".repeat(32),
      sim: tight,
    });
    try {
      // Started on the tight server, so the game keeps its config.
      const code = await newCode();
      const payload = { name: "Acme", productType: "ecommerce", model: "iaas" };
      const company = (
        await tightApp.inject({ method: "POST", url: `/api/codes/${code}/companies`, payload })
      ).json<CompanyView>();
      const url = `/api/codes/${code}/companies/${company.id}`;
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
});

describe("servers on IaaS", () => {
  async function setup(model = "iaas") {
    const code = await newCode();
    const company = (await newCompany(code, { name: "Acme", productType: "ecommerce", model })).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    return { code, company, url, act };
  }

  it("shows the starter VMs, units per tier with the binding tier, load balancers and what can be rented", async () => {
    const { company } = await setup();
    expect(company.servers).toEqual([
      expect.objectContaining({ id: 1, type: "app", size: "medium", name: "App server", status: "ready", units: 15 }),
      expect.objectContaining({ id: 2, type: "database", size: "medium", name: "Database", status: "ready", units: 15 }),
    ]);
    expect(company.units).toMatchObject({
      binding: expect.stringMatching(/^(cu|dbu)$/),
      loadBalancer: { appServers: 1, loadBalancers: 0, needed: false, counted: 1, uncovered: 0 },
      burst: false,
    });
    expect(company.serverOptions).toHaveLength(16);
    expect(company.serverOptions).toContainEqual(
      expect.objectContaining({ type: "loadBalancer", size: "small", units: 2, monthlyCost: 200 }),
    );
  });

  it("rents VMs that persist and are ready after Continue, needing a load balancer for a second app server", async () => {
    const { url, act } = await setup();
    const rented = await act({ type: "rentServer", server: "app", size: "large" });
    expect(rented.statusCode).toBe(200);
    expect(rented.json<CompanyView>().servers.at(-1)).toMatchObject({ id: 3, type: "app", size: "large", status: "pending" });
    const balanced = (await act({ type: "rentServer", server: "loadBalancer", size: "small" })).json<CompanyView>();
    // Pending: nothing changes until they're ready, and ops needed counts them already.
    expect(balanced.units!.cu.capacity).toBe(15 * defaultConfig.capacity.unstaffedShare);
    expect(balanced.opsNeeded).toBe(2);
    expect((await app.inject({ method: "GET", url })).json<CompanyView>().servers).toHaveLength(4);

    const next = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    expect(next.company.servers.every((s) => s.status === "ready")).toBe(true);
    expect(next.company.units).toMatchObject({
      cu: { capacity: (15 + 20) * defaultConfig.capacity.unstaffedShare },
      loadBalancer: { appServers: 2, loadBalancers: 1, needed: true, coverage: 2, counted: 2, uncovered: 0 },
    });
    // Billed from the day after renting: a large app server is £800 a month and a small load balancer £200.
    expect(next.log[0]!.entries).toContainEqual({
      text: "App server (large) rent: 1 × £800 a month",
      cashDelta: -Math.round(800 / 30),
      category: "infrastructure",
    });
    expect(next.company.monthlyInfrastructureCost).toBe(750 + 800 + 200);
  });

  it("cancels a VM, which stops its rent and persists", async () => {
    const { url, act } = await setup();
    await act({ type: "rentServer", server: "cache", size: "small" });
    await app.inject({ method: "POST", url: `${url}/continue` });
    const cancelled = await act({ type: "cancelServer", id: 3 });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<CompanyView>().servers.map((s) => s.id)).toEqual([1, 2]);
    const next = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    expect(next.log[0]!.entries.filter((e) => e.text.includes(" rent: "))).toEqual([]);
    expect((await app.inject({ method: "GET", url })).json<CompanyView>().servers).toHaveLength(2);
  });

  it("validates the body, and rejects servers off IaaS or that aren't the company's, changing nothing", async () => {
    const { url, act } = await setup();
    for (const payload of [
      { type: "rentServer", server: "app" },
      { type: "rentServer", size: "small" },
      { type: "rentServer", server: "mainframe", size: "small" },
      { type: "rentServer", server: "app", size: "huge" },
      { type: "cancelServer" },
      { type: "cancelServer", id: 0 },
      { type: "cancelServer", id: 1.5 },
      { type: "cancelServer", id: "one" },
    ]) {
      expect((await act(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    const unknown = await act({ type: "cancelServer", id: 99 });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: "unknown_server" });
    expect((await app.inject({ method: "GET", url })).json<CompanyView>().servers).toHaveLength(2);

    const saas = await setup("saas");
    expect(saas.company).toMatchObject({ servers: [], units: null, serverOptions: [], managed: null, capacity: null });
    const refused = await saas.act({ type: "rentServer", server: "app", size: "small" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "no_servers" });
  });
});

describe("servers on-prem", () => {
  // The default on-prem kit, with cash to buy it: a £5,000 server room plus a large app server (£1,000) and database
  // (£1,200), 10 days to arrive and 40% back on selling.
  const ownSim = createSim({ ...sim.config, startingCash: 100_000 });
  const onprem = defaultConfig.models.onprem.servers!;
  let ownApp: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ownApp = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim: ownSim });
  });

  afterAll(async () => {
    await ownApp?.close();
  });

  async function setup(model = "onprem") {
    const code = await newCode();
    const created = await ownApp.inject({
      method: "POST",
      url: `/api/codes/${code}/companies`,
      payload: { name: "Acme", productType: "social", model },
    });
    const company = created.json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => ownApp.inject({ method: "POST", url: `${url}/actions`, payload });
    const get = async () => (await ownApp.inject({ method: "GET", url })).json<CompanyView>();
    const next = async () => (await ownApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    return { company, act, get, next };
  }

  it("starts with the starter kit bought on top of the server room, and offers kit to buy", async () => {
    const { company } = await setup();
    expect(company.cash).toBe(100_000 - 5_000 - 1_000 - 1_200);
    expect(company.spend.infrastructure).toBe(7_200);
    expect(company.servers).toEqual([
      expect.objectContaining({ id: 1, type: "app", size: "large", status: "ready", daysLeft: 0, paid: 1_000, sellBack: 400 }),
      expect.objectContaining({ id: 2, type: "database", size: "large", status: "ready", daysLeft: 0, paid: 1_200, sellBack: 480 }),
    ]);
    expect(company.serverOptions).toHaveLength(16);
    expect(company.serverOptions).toContainEqual(
      expect.objectContaining({
        type: "cache",
        size: "small",
        units: 10,
        price: onprem.purchase!.price.cache.small,
        monthlyCost: onprem.monthlyCost.cache!.small,
        sellBackShare: 0.4,
        readyDays: 10,
      }),
    );
    const meta = (await ownApp.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta.models.find((m) => m.id === "onprem")!.upfrontCost).toBe(7_200);
  });

  it("buys kit, charging it at once, on order with the days left until it arrives", async () => {
    const { company: before, act, get, next } = await setup();
    const res = await act({ type: "buyServer", server: "app", size: "small" });
    expect(res.statusCode).toBe(200);
    const bought = res.json<CompanyView>();
    expect(bought.cash).toBe(before.cash - onprem.purchase!.price.app.small);
    expect(bought.servers.at(-1)).toMatchObject({ id: 3, type: "app", size: "small", status: "pending", daysLeft: 10 });
    // On order: no capacity and no ops needed until it arrives.
    expect(bought.units).toEqual(before.units);
    expect(bought.opsNeeded).toBe(before.opsNeeded);
    expect((await get()).servers.at(-1)).toMatchObject({ status: "pending", daysLeft: 10 });
    const { company } = await next();
    expect(company.servers.at(-1)).toMatchObject({ status: "pending", daysLeft: 9 });
  });

  it("sells kit back for its share, but not kit still on order", async () => {
    const { company: before, act, get } = await setup();
    await act({ type: "buyServer", server: "cache", size: "small" });
    const onOrder = await act({ type: "sellServer", id: 3 });
    expect(onOrder.statusCode).toBe(400);
    expect(onOrder.json()).toMatchObject({ error: "on_order" });
    const sold = await act({ type: "sellServer", id: 2 });
    expect(sold.statusCode).toBe(200);
    expect(sold.json<CompanyView>().cash).toBe(before.cash - onprem.purchase!.price.cache.small + 480);
    expect((await get()).servers.map((s) => s.id)).toEqual([1, 3]);
  });

  it("validates the body, and only buys and sells on-prem", async () => {
    const { act, get } = await setup();
    for (const payload of [
      { type: "buyServer", server: "app" },
      { type: "buyServer", size: "small" },
      { type: "buyServer", server: "mainframe", size: "small" },
      { type: "sellServer" },
      { type: "sellServer", id: 0 },
      { type: "sellServer", id: "one" },
    ]) {
      expect((await act(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await act({ type: "rentServer", server: "app", size: "small" })).json()).toMatchObject({ error: "not_for_rent" });
    expect((await act({ type: "cancelServer", id: 1 })).json()).toMatchObject({ error: "not_rented" });
    expect((await get()).servers).toHaveLength(2);

    const iaas = await setup("iaas");
    const refused = await iaas.act({ type: "buyServer", server: "app", size: "small" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "not_for_sale" });
    expect(iaas.company.servers.every((s) => s.paid === null && s.sellBack === null)).toBe(true);
  });
});

describe("PaaS managed services and SaaS with no servers", () => {
  // PaaS's starter instance and managed database are free here; the other sizes have their default prices.
  async function setup(model = "paas") {
    const code = await newCode();
    const company = (await newCompany(code, { name: "Acme", productType: "ecommerce", model })).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    const get = async () => (await app.inject({ method: "GET", url })).json<CompanyView>();
    const next = async () => (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    return { company, act, get, next };
  }

  it("shows PaaS's instances and managed services, with a built-in load balancer and nothing to rent", async () => {
    const { company } = await setup();
    const managed = paasServers.managed!;
    expect(company.managed).toMatchObject({
      instances: 1,
      maxInstances: managed.maxInstances,
      instanceSize: "medium",
      instanceUnits: 15,
      database: { size: "small", units: managed.units.database.small },
      cache: null,
    });
    expect(company.managed!.database!.options).toHaveLength(4);
    expect(company.managed!.databaseOptions).toHaveLength(4);
    expect(company.managed!.cacheOptions).toContainEqual({
      size: "large",
      units: managed.units.cache.large,
      monthlyCost: paasServers.monthlyCost.cache!.large,
    });
    expect(company.servers.map((s) => s.name)).toEqual(["App instance", "Managed database"]);
    expect(company.units!.loadBalancer).toMatchObject({ builtIn: true, needed: false });
    expect(company).toMatchObject({ serverOptions: [], provider: null, opsNeeded: 1 });
  });

  it("raises the instance count and managed sizes at once, saved, with no extra ops", async () => {
    const { company: before, act, get } = await setup();
    const res = await act({ type: "setInstances", count: 4 });
    expect(res.statusCode).toBe(200);
    const scaled = res.json<CompanyView>();
    expect(scaled.managed!.instances).toBe(4);
    // Ready at once: 4 instances' CU, before any Continue (cut for the missing ops person, as before).
    expect(scaled.units!.cu.capacity).toBeCloseTo(4 * before.units!.cu.capacity, 5);
    expect(scaled.servers.every((s) => s.status === "ready")).toBe(true);
    const db = (await act({ type: "setManagedService", service: "database", size: "large" })).json<CompanyView>();
    expect(db.managed!.database).toMatchObject({ size: "large", units: paasServers.managed!.units.database.large });
    const cached = (await act({ type: "setManagedService", service: "cache", size: "small" })).json<CompanyView>();
    expect(cached.managed!.cache).toMatchObject({ size: "small" });
    expect(cached.opsNeeded).toBe(1);
    // Instances are free here: the platform's £300, the large database and the small cache.
    expect(cached.monthlyInfrastructureCost).toBe(
      300 + paasServers.monthlyCost.database!.large! + paasServers.monthlyCost.cache!.small!,
    );
    const off = (await act({ type: "setManagedService", service: "cache", size: null })).json<CompanyView>();
    expect(off.managed!.cache).toBeNull();
    expect((await get()).managed).toEqual(off.managed);
  });

  it("validates the PaaS actions, and the sim refuses what doesn't fit", async () => {
    const { act } = await setup();
    for (const payload of [
      { type: "setInstances" },
      { type: "setInstances", count: 0 },
      { type: "setInstances", count: 2.5 },
      { type: "setInstances", count: "two" },
      { type: "setManagedService", size: "small" },
      { type: "setManagedService", service: "database" },
      { type: "setManagedService", service: "queue", size: "small" },
      { type: "setManagedService", service: "cache", size: "huge" },
      { type: "rentServer", server: "app", size: null },
    ]) {
      expect((await act(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    const tooMany = await act({ type: "setInstances", count: paasServers.managed!.maxInstances + 1 });
    expect(tooMany.json()).toMatchObject({ error: "bad_instances" });
    const noDb = await act({ type: "setManagedService", service: "database", size: null });
    expect(noDb.json()).toMatchObject({ error: "database_required" });
    const rent = await act({ type: "rentServer", server: "loadBalancer", size: "small" });
    expect(rent.json()).toMatchObject({ error: "managed" });
    const iaas = await setup("iaas");
    const elsewhere = await iaas.act({ type: "setInstances", count: 2 });
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.json()).toMatchObject({ error: "not_managed" });
  });

  it("shows SaaS as unlimited and provider-managed, with the per-user bill", async () => {
    const perUser = defaultConfig.models.saas.monthlyCostPerUser;
    const { company, next } = await setup("saas");
    expect(company).toMatchObject({ capacity: null, units: null, servers: [], managed: null, opsNeeded: 1 });
    expect(company.provider).toEqual({
      users: company.users,
      freeUsers: company.freeUsers,
      perUserFee: perUser,
      monthlyPerUserBill: Math.round(company.users * perUser),
      monthlyCost: defaultConfig.models.saas.monthlyCost,
    });
    const { company: later } = await next();
    expect(later).toMatchObject({ capacity: null, outageDays: 0 });
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
    const spend = { staff: 8, infrastructure: 50, addons: 0, debt: 0 };
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

describe("bank loan", () => {
  // The default loan, £35,000 at 10% from the start, on £1,000 of starting cash. IaaS costs £25 a day here.
  async function setup(body: object = {}) {
    const code = await newCode();
    const created = await newCompany(code, { name: "Acme", productType: "ecommerce", model: "iaas", ...body });
    expect(created.statusCode).toBe(201);
    const company = created.json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    const next = async () => (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    return { code, company, url, act, next };
  }
  const startLoan = async () => (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>().startLoan;

  it("shows the start terms in meta, and a new game can take them", async () => {
    const terms = await startLoan();
    // £38,500 over 179 days, rounded up to the pound a day.
    expect(terms).toEqual({
      amount: 35_000,
      rate: 0.1,
      dailyRepayment: 216,
      days: 179,
      total: 38_664,
      interest: 3_664,
      lastDay: 180,
    });
    const { company, next } = await setup({ takeLoan: true });
    expect(company.cash).toBe(1_000 + 35_000);
    expect(company.loan).toMatchObject({ amount: 35_000, day: 1, rate: 0.1, total: terms.total, repaid: 0 });
    expect(company.loan).toMatchObject({ dailyRepayment: terms.dailyRepayment, remaining: terms.total, daysLeft: 179 });
    expect(company.loanQuote).toBeNull();
    const { company: after, log } = await next();
    expect(after.spend.debt).toBe(terms.dailyRepayment);
    expect(after.loan).toMatchObject({ repaid: terms.dailyRepayment, daysLeft: 178 });
    expect(log[0]!.entries).toContainEqual(
      expect.objectContaining({ category: "debt", cashDelta: -terms.dailyRepayment }),
    );
    expect(log[0]!.entries).toContainEqual(expect.objectContaining({ kind: "loan" }));
  });

  it("starts without a loan by default, offering the start terms, which get worse later", async () => {
    const terms = await startLoan();
    const { company, next } = await setup();
    expect(company).toMatchObject({ cash: 1_000, loan: null, loanQuote: terms });
    let later = company;
    for (let i = 0; i < 10; i++) later = (await next()).company;
    expect(later.day).toBe(11);
    expect(later.loanQuote!.rate).toBeGreaterThan(terms.rate);
    expect(later.loanQuote!.dailyRepayment).toBeGreaterThan(terms.dailyRepayment);
    expect(later.loanQuote!.total).toBeGreaterThan(terms.total);
    expect(later.loanQuote!.days).toBe(169);
  });

  it("takes the loan later as an action, on the quoted terms, and only once", async () => {
    const { act, next } = await setup();
    await next();
    const before = (await next()).company;
    const res = await act({ type: "takeLoan" });
    expect(res.statusCode).toBe(200);
    const taken = res.json<CompanyView>();
    expect(taken.cash).toBe(before.cash + 35_000);
    expect(taken.loan).toMatchObject({
      day: 3,
      rate: before.loanQuote!.rate,
      dailyRepayment: before.loanQuote!.dailyRepayment,
      total: before.loanQuote!.total,
      repaid: 0,
    });
    expect(taken.loanQuote).toBeNull();
    const again = await act({ type: "takeLoan" });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: "loan_taken", message: expect.stringContaining("one") });
  });

  it("rejects a second loan on a game that took one at the start", async () => {
    const { act } = await setup({ takeLoan: true });
    const res = await act({ type: "takeLoan" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "loan_taken" });
  });

  it("validates the take-loan option", async () => {
    const code = await newCode();
    const res = await newCompany(code, { name: "Acme", productType: "ecommerce", model: "iaas", takeLoan: "yes" });
    expect(res.statusCode).toBe(400);
  });

  it("refuses on-prem without the loan, since its kit costs more than the starting cash, but not with it", async () => {
    const code = await newCode();
    const without = await newCompany(code, { name: "Acme", productType: "ecommerce", model: "onprem" });
    expect(without.statusCode).toBe(400);
    expect(without.json()).toMatchObject({ error: "cant_afford", message: expect.stringContaining("bank loan") });
    const withLoan = await newCompany(code, { name: "Acme", productType: "ecommerce", model: "onprem", takeLoan: true });
    expect(withLoan.statusCode).toBe(201);
    expect(withLoan.json<CompanyView>().cash).toBe(1_000 + 35_000 - 7_200);
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
      spend: { staff: 16, infrastructure: 100, addons: 0, debt: 0 },
      totalSpend: 116,
    });
    expect(summary.users).toBeGreaterThan(0);
    const logged = (category: string) =>
      logs.flatMap((d) => d.entries).filter((e) => e.category === category).reduce((sum, e) => sum - e.cashDelta, 0);
    expect(summary.spend).toEqual({
      staff: logged("staff"),
      infrastructure: logged("infrastructure"),
      addons: 0,
      debt: 0,
    });
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

describe("teacher dashboard", () => {
  async function games(query = "") {
    return app.inject({ method: "GET", url: `/api/teacher/games${query}`, cookies: await teacherCookie() });
  }

  async function lastPlayed(id: string, hoursAgo: number) {
    await testDb.db
      .update(companies)
      .set({ updatedAt: new Date(Date.now() - hoursAgo * 3600 * 1000) })
      .where(eq(companies.id, id));
  }

  it("requires the teacher session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/teacher/games" })).statusCode).toBe(401);
    const id = "00000000-0000-0000-0000-000000000000";
    expect((await app.inject({ method: "GET", url: `/api/teacher/companies/${id}/summary` })).statusCode).toBe(401);
  });

  it("groups games by code, with model, day, cash, users, uptime and status", async () => {
    const [first, second] = [await newCode(), await newCode()];
    const a = (await newCompany(first, { name: "Alpha", productType: "ecommerce", model: "iaas" })).json<CompanyView>();
    const b = (await newCompany(first, { name: "Beta", productType: "social", model: "paas" })).json<CompanyView>();
    const c = (await newCompany(second)).json<CompanyView>();
    await app.inject({ method: "POST", url: `/api/codes/${first}/companies/${a.id}/continue` });
    await app.inject({
      method: "POST",
      url: `/api/codes/${first}/companies/${a.id}/actions`,
      payload: { type: "startMigration", model: "paas" },
    });
    await app.inject({ method: "POST", url: `/api/codes/${second}/companies/${c.id}/retire` });
    const played = (await app.inject({ method: "GET", url: `/api/codes/${first}/companies/${a.id}` })).json<CompanyView>();

    const res = await games();
    expect(res.statusCode).toBe(200);
    const body = res.json<TeacherGamesView>();
    // Newest code first; each code's companies in the order they started.
    expect(body.codes.map((g) => g.code)).toEqual([second, first]);
    expect(body.codes[1]!.companies.map((g) => g.name)).toEqual(["Alpha", "Beta"]);
    expect(body.codes[1]!.companies[0]).toMatchObject({
      id: a.id,
      productType: "ecommerce",
      model: "iaas",
      migratingTo: "paas",
      day: 2,
      finalDay: sim.config.finalDay,
      cash: played.cash,
      users: played.users,
      uptime: played.uptime,
      status: "active",
    });
    expect(body.codes[1]!.companies[1]).toMatchObject({ id: b.id, model: "paas", migratingTo: null, day: 1 });
    expect(body.codes[0]!.companies).toMatchObject([{ id: c.id, status: "retired" }]);
  });

  it("gives each game's income on the last day, profit, satisfaction, paid and free users and the loan", async () => {
    await useOverrides({ "productTypes.ecommerce.pricing.freeShare": 0.5 });
    const code = await newCode();
    const body = { name: "Lender", productType: "ecommerce", model: "iaas", takeLoan: true };
    const lender = (await newCompany(code, body)).json<CompanyView>();
    const plain = (await newCompany(code, { ...body, name: "Plain", takeLoan: false })).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${lender.id}`;
    await app.inject({ method: "POST", url: `${url}/actions`, payload: { type: "setPrice", price: 40 } });
    for (let i = 0; i < 3; i++) await app.inject({ method: "POST", url: `${url}/continue` });
    const company = (await app.inject({ method: "GET", url })).json<CompanyView>();
    const summary = (await app.inject({ method: "GET", url: `${url}/summary` })).json<SummaryView>();

    const rows = (await games()).json<TeacherGamesView>().codes[0]!.companies;
    expect(rows[0]).toMatchObject({
      id: lender.id,
      day: 4,
      paidUsers: company.paidUsers,
      freeUsers: company.freeUsers,
      lastDayIncome: summary.days.at(-1)!.income,
      profit: summary.profit,
      satisfaction: company.satisfaction,
      loanRemaining: company.loan!.remaining,
    });
    expect(rows[0]!.lastDayIncome).toBeGreaterThan(0);
    // Only the interest in the repayments counts against profit, on the dashboard as in the summary.
    const spent = Object.values(company.spend).reduce((a, b) => a + b, 0);
    expect(rows[0]!.profit).toBe(company.income - spent + summary.loan!.principalRepaid);
    expect(summary.loan!.principalRepaid).toBeGreaterThan(0);
    expect(summary.loan!.interestPaid + summary.loan!.principalRepaid).toBe(company.spend.debt);
    expect(summary.totalSpend).toBe(spent);
    expect(rows[0]!.loanRemaining).toBe(company.loan!.total - 3 * company.loan!.dailyRepayment);
    // No loan, and day 1's income is nothing: no one has paid yet.
    expect(rows[1]).toMatchObject({ id: plain.id, day: 1, lastDayIncome: 0, loanRemaining: null, satisfaction: 100 });
    expect(rows[1]!.profit).toBe(0 - plain.spend.infrastructure);
  });

  it("shows the last 3 hours by default", async () => {
    const code = await newCode();
    const recent = (await newCompany(code, { name: "Recent", productType: "ecommerce", model: "iaas" })).json<CompanyView>();
    const old = (await newCompany(code, { name: "Old", productType: "ecommerce", model: "iaas" })).json<CompanyView>();
    await lastPlayed(recent.id, 2.5);
    await lastPlayed(old.id, 3.5);
    const body = (await games()).json<TeacherGamesView>();
    expect(body.hours).toBe(3);
    expect(body.codes).toMatchObject([{ code, companies: [{ name: "Recent" }] }]);
    expect(body.codes[0]!.companies).toHaveLength(1);
  });

  it("takes a custom window, leaving out older games and codes with none", async () => {
    const [kept, dropped] = [await newCode(), await newCode()];
    const a = (await newCompany(kept)).json<CompanyView>();
    const b = (await newCompany(dropped)).json<CompanyView>();
    await lastPlayed(a.id, 20);
    await lastPlayed(b.id, 30);
    const body = (await games("?hours=24")).json<TeacherGamesView>();
    expect(body.hours).toBe(24);
    expect(body.codes.map((g) => g.code)).toEqual([kept]);
    expect((await games("?hours=1")).json<TeacherGamesView>().codes).toEqual([]);
  });

  it("rejects an unreasonable window", async () => {
    for (const hours of ["0", "-1", "169", "1.5", "lots"]) {
      expect((await games(`?hours=${hours}`)).statusCode).toBe(400);
    }
  });

  it("gives any company's summary by id", async () => {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    await app.inject({ method: "POST", url: `/api/codes/${code}/companies/${company.id}/continue` });
    const res = await app.inject({
      method: "GET",
      url: `/api/teacher/companies/${company.id}/summary`,
      cookies: await teacherCookie(),
    });
    expect(res.statusCode).toBe(200);
    const student = (await app.inject({ method: "GET", url: `/api/codes/${code}/companies/${company.id}/summary` })).json();
    expect(res.json<TeacherSummaryView>()).toEqual({ code, status: "active", preset: "Default", summary: student });
  });

  it("is 404 for an unknown or malformed company id", async () => {
    const cookies = await teacherCookie();
    for (const id of ["00000000-0000-0000-0000-000000000000", "nope"]) {
      const res = await app.inject({ method: "GET", url: `/api/teacher/companies/${id}/summary`, cookies });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "unknown_company" });
    }
  });
});

describe("archiving and deleting", () => {
  async function teacher(method: "GET" | "POST" | "DELETE", url: string) {
    return app.inject({ method, url, cookies: await teacherCookie() });
  }
  const live = async () => (await teacher("GET", "/api/teacher/games")).json<TeacherGamesView>();
  const archived = async () => (await teacher("GET", "/api/teacher/games?archived=true")).json<TeacherGamesView>();
  const ids = (view: TeacherGamesView) => view.codes.flatMap((g) => g.companies.map((c) => c.id));

  it("moves an archived game from the live list to the archived list, and back", async () => {
    const code = await newCode();
    const kept = (await newCompany(code, { name: "Kept", productType: "ecommerce", model: "iaas" })).json<CompanyView>();
    const old = (await newCompany(code, { name: "Old", productType: "ecommerce", model: "iaas" })).json<CompanyView>();

    expect((await teacher("POST", `/api/teacher/companies/${old.id}/archive`)).statusCode).toBe(200);
    expect(ids(await live())).toEqual([kept.id]);
    const body = await archived();
    expect(body.hours).toBeNull();
    expect(body.codes).toMatchObject([{ code, archived: false, companies: [{ id: old.id, name: "Old" }] }]);
    expect(body.codes[0]!.companies[0]!.archivedAt).not.toBeNull();

    expect((await teacher("POST", `/api/teacher/companies/${old.id}/unarchive`)).statusCode).toBe(200);
    expect(ids(await live())).toEqual([kept.id, old.id]);
    expect((await archived()).codes).toEqual([]);
  });

  it("lists archived games however long ago they were played", async () => {
    const code = await newCode();
    const old = (await newCompany(code)).json<CompanyView>();
    await testDb.db
      .update(companies)
      .set({ updatedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) })
      .where(eq(companies.id, old.id));
    await teacher("POST", `/api/teacher/companies/${old.id}/archive`);
    expect(ids(await archived())).toEqual([old.id]);
  });

  it("changes nothing for the student: an archived game can still be played", async () => {
    const code = await newCode();
    const { id } = (await newCompany(code)).json<CompanyView>();
    await teacher("POST", `/api/teacher/companies/${id}/archive`);

    const view = await app.inject({ method: "GET", url: `/api/codes/${code}/companies/${id}` });
    expect(view.statusCode).toBe(200);
    expect(view.json<CompanyView>()).toMatchObject({ status: "active", day: 1 });
    const next = await app.inject({ method: "POST", url: `/api/codes/${code}/companies/${id}/continue` });
    expect(next.statusCode).toBe(200);
    expect(next.json<ContinueResult>().company.day).toBe(2);
    const action = await app.inject({
      method: "POST",
      url: `/api/codes/${code}/companies/${id}/actions`,
      payload: { type: "hire", pool: "developers" },
    });
    expect(action.statusCode).toBe(200);
    // Playing it doesn't bring it back to the live dashboard.
    expect(ids(await live())).toEqual([]);
    expect(ids(await archived())).toEqual([id]);
  });

  it("still counts an archived game towards the code's limit", async () => {
    const code = await newCode();
    const games = [];
    for (let i = 0; i < 3; i++) games.push((await newCompany(code)).json<CompanyView>());
    await teacher("POST", `/api/teacher/companies/${games[0]!.id}/archive`);
    const res = await newCompany(code);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "too_many_active" });
    // Retiring it as usual makes room.
    await app.inject({ method: "POST", url: `/api/codes/${code}/companies/${games[0]!.id}/retire` });
    expect((await newCompany(code)).statusCode).toBe(201);
  });

  it("deletes a game for good", async () => {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const res = await teacher("DELETE", `/api/teacher/companies/${company.id}`);
    expect(res.statusCode).toBe(200);
    expect((await teacher("GET", `/api/teacher/companies/${company.id}/summary`)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/codes/${code}/companies/${company.id}` })).statusCode).toBe(404);
    expect(ids(await live())).toEqual([]);
    expect((await teacher("DELETE", `/api/teacher/companies/${company.id}`)).statusCode).toBe(404);
  });

  it("archives a whole code with its games, so students can't use it, and unarchives it", async () => {
    const [code, other] = [await newCode(), await newCode()];
    const company = (await newCompany(code)).json<CompanyView>();
    const archivedAlone = (await newCompany(code)).json<CompanyView>();
    await teacher("POST", `/api/teacher/companies/${archivedAlone.id}/archive`);
    const empty = await newCode();
    const elsewhere = (await newCompany(other)).json<CompanyView>();

    expect((await teacher("POST", `/api/teacher/codes/${code}/archive`)).statusCode).toBe(200);
    expect((await teacher("POST", `/api/teacher/codes/${empty}/archive`)).statusCode).toBe(200);
    expect((await live()).codes.map((g) => g.code)).toEqual([other]);
    expect((await archived()).codes).toMatchObject([
      { code: empty, archived: true, companies: [] },
      { code, archived: true, companies: [{ id: company.id, archivedAt: null }, { id: archivedAlone.id }] },
    ]);
    const codes = (await teacher("GET", "/api/teacher/codes")).json<TeacherCodeView[]>();
    expect(codes.map((c) => c.code)).toEqual([other]);

    // Archived codes are unknown to students.
    for (const url of [`/api/codes/${code}`, `/api/codes/${code}/companies/${company.id}`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
    }
    expect((await newCompany(code)).statusCode).toBe(404);

    // Unarchiving the code brings back its games, except one the teacher archived on its own.
    expect((await teacher("POST", `/api/teacher/codes/${code}/unarchive`)).statusCode).toBe(200);
    expect(ids(await live())).toEqual([elsewhere.id, company.id]);
    expect(ids(await archived())).toEqual([archivedAlone.id]);
    expect((await app.inject({ method: "GET", url: `/api/codes/${code}` })).statusCode).toBe(200);
  });

  it("deletes a code and every game under it", async () => {
    const [code, other] = [await newCode(), await newCode()];
    const a = (await newCompany(code)).json<CompanyView>();
    const b = (await newCompany(code)).json<CompanyView>();
    const kept = (await newCompany(other)).json<CompanyView>();
    expect((await teacher("DELETE", `/api/teacher/codes/${code}`)).statusCode).toBe(200);
    for (const id of [a.id, b.id]) {
      expect((await teacher("GET", `/api/teacher/companies/${id}/summary`)).statusCode).toBe(404);
    }
    expect(ids(await live())).toEqual([kept.id]);
    expect((await app.inject({ method: "GET", url: `/api/codes/${code}` })).statusCode).toBe(404);
  });

  it("requires the teacher session", async () => {
    const code = await newCode();
    const { id } = (await newCompany(code)).json<CompanyView>();
    for (const [method, url] of [
      ["POST", `/api/teacher/companies/${id}/archive`],
      ["POST", `/api/teacher/companies/${id}/unarchive`],
      ["DELETE", `/api/teacher/companies/${id}`],
      ["POST", `/api/teacher/codes/${code}/archive`],
      ["POST", `/api/teacher/codes/${code}/unarchive`],
      ["DELETE", `/api/teacher/codes/${code}`],
      ["GET", "/api/teacher/games?archived=true"],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
    }
    // Nothing changed.
    expect(ids(await live())).toEqual([id]);
  });

  it("is 404 for an unknown or malformed id or code", async () => {
    for (const id of ["00000000-0000-0000-0000-000000000000", "nope"]) {
      for (const [method, url] of [
        ["POST", `/api/teacher/companies/${id}/archive`],
        ["POST", `/api/teacher/companies/${id}/unarchive`],
        ["DELETE", `/api/teacher/companies/${id}`],
      ] as const) {
        const res = await teacher(method, url);
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ error: "unknown_company" });
      }
    }
    for (const code of ["12345678", "abc"]) {
      for (const [method, url] of [
        ["POST", `/api/teacher/codes/${code}/archive`],
        ["POST", `/api/teacher/codes/${code}/unarchive`],
        ["DELETE", `/api/teacher/codes/${code}`],
      ] as const) {
        const res = await teacher(method, url);
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ error: "unknown_code" });
      }
    }
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
    // Both setups: the old VMs still serving, and the new one being built.
    const both = (await app.inject({ method: "GET", url })).json<CompanyView>();
    expect(both.servers.map((s) => [s.name, s.size])).toEqual([
      ["App server", "medium"],
      ["Database", "medium"],
    ]);
    expect(both.migration!.setup.map((s) => [s.name, s.size, s.count])).toEqual([
      ["App instance", "medium", 1],
      ["Managed database", "small", 1],
    ]);
    expect(both.migration!.setupMonthly).toBe(0);

    let body: ContinueResult | undefined;
    for (let day = 1; day <= 5; day++) body = await next();
    expect(body!.company.migration).toMatchObject({ phase: "testing", phaseDaysLeft: 2, daysLeft: 9 });
    expect(body!.log[0]!.entries).toContainEqual(
      expect.objectContaining({ kind: "migration", text: expect.stringContaining("Planning done") }),
    );
    for (let day = 6; day <= 13; day++) body = await next();
    expect(body!.company).toMatchObject({ model: "iaas", opsNeeded: 1, migration: { phase: "moving", daysLeft: 1 } });

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
      // 2,000 shoppers need 1 CU and 1 DBU; with a quarter's headroom, one instance and a small database, free here.
      setup: [
        { type: "app", size: "medium", name: "App instance", count: 1, units: 15, upfront: 0, monthly: 0, daysLeft: 0 },
        { type: "database", size: "small", name: "Managed database", count: 1, units: 10, upfront: 0, monthly: 0, daysLeft: 0 },
      ],
      sizedFor: { cu: 1.25, dbu: 1.25 },
      headroom: 0.25,
      setupUpfront: 0,
      setupMonthly: 0,
      opsNeeded: 1,
      deliveryDays: null,
      upfrontCost: 100,
      doubleBilling: 14 * 10,
      proRata: 14 * 25,
      exitPenalty: 200,
      sellBack: 0,
      total: 100 + 140 + 350 + 200,
      overrun: { chance: 0, minDays: 2, maxDays: 5 },
      lostAddons: [],
    });
    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({ cash: 1000, migration: null });
  });

  it("itemises a bought setup: what each item costs up front and a month, and the delivery time", async () => {
    const { quote } = await setup();
    const onprem = (await quote("onprem")).json<MigrationQuoteView>();
    const { price } = defaultConfig.models.onprem.servers!.purchase!;
    const upkeep = defaultConfig.models.onprem.servers!.monthlyCost;
    expect(onprem.setup).toEqual([
      { type: "app", size: "small", name: "App server", count: 1, units: 10, upfront: price.app.small, monthly: upkeep.app!.small!, daysLeft: 10 },
      { type: "database", size: "small", name: "Database", count: 1, units: 10, upfront: price.database.small, monthly: upkeep.database!.small!, daysLeft: 10 },
    ]);
    expect(onprem).toMatchObject({ setupUpfront: price.app.small + price.database.small, deliveryDays: 10 });
    expect(onprem.upfrontCost).toBe(defaultConfig.models.onprem.upfrontCost + onprem.setupUpfront);
    expect((await quote("saas")).json<MigrationQuoteView>()).toMatchObject({ setup: [], setupMonthly: 0 });
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
      // Demand is light here, so the spike multiplies it 50 times to be more than on-prem's starter kit can serve.
      {
        ...event("trafficSpike"),
        schedule: { type: "fixed", days: [3] },
        load: { ...event("trafficSpike").load!, unitMultiplier: 50 },
      },
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
    // Scaled to meet the day's demand, from the spike's first day: the platform does it at once.
    expect(company.capacity).toBe(company.load);
    expect(company.units).toMatchObject({ burst: true });
    expect(company.units!.cu.capacity).toBe(company.units!.cu.demand);
    const burst = log[0]!.entries.find((e) => e.text.startsWith("Traffic spike: the platform scaled up for"));
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
  it("reports timed flow as off by default, with the default interval", async () => {
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta.timedFlow).toEqual({ enabled: false, seconds: 15 });
  });

  it("reports timed flow and its interval when the server turns it on", async () => {
    const timed = await buildApp({
      db: testDb.db,
      teacherPassword: PASSWORD,
      sessionSecret: "x".repeat(32),
      sim,
      timedFlow: { enabled: true, seconds: 5 },
    });
    try {
      const meta = (await timed.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
      expect(meta.timedFlow).toEqual({ enabled: true, seconds: 5 });
    } finally {
      await timed.close();
    }
  });

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
      ["support", 3],
    ]);
    // On-prem's and IaaS's from their starter servers; PaaS's and SaaS's a small fixed number.
    expect(meta.models.map((m) => m.opsNeeded)).toEqual([2, 1, 1, 1]);
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
    expect(meta.models.find((m: { id: string }) => m.id === "saas").comparison.opsNeeded).toBe("Very low");
  });
});

describe("launch", () => {
  // The default 3-day ramp, and IaaS with no starter setup, so a new IaaS company has nothing to serve users with.
  const ramped = createSim({
    ...sim.config,
    launch: { rampShares: [0.2, 0.3, 0.5] },
    models: {
      ...sim.config.models,
      iaas: { ...sim.config.models.iaas, servers: { ...sim.config.models.iaas.servers!, starter: [] } },
    },
  });
  async function withRampedApp(test: (start: (model: string) => Promise<{ company: CompanyView; url: string }>, rampApp: Awaited<ReturnType<typeof buildApp>>) => Promise<void>) {
    const rampApp = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim: ramped });
    try {
      const code = await newCode();
      const start = async (model: string) => {
        const payload = { name: "Acme", productType: "ecommerce", model };
        const company = (await rampApp.inject({ method: "POST", url: `/api/codes/${code}/companies`, payload })).json<CompanyView>();
        return { company, url: `/api/codes/${code}/companies/${company.id}` };
      };
      await test(start, rampApp);
    } finally {
      await rampApp.close();
    }
  }

  it("shows a company with no capacity waiting, with no users", async () => {
    await withRampedApp(async (start, rampApp) => {
      const { company, url } = await start("iaas");
      expect(company).toMatchObject({ day: 1, users: 0, paidUsers: 0 });
      expect(company.launch).toEqual({
        status: "waiting",
        day: null,
        daysLeft: null,
        rampDays: 3,
        rampDay: 0,
        users: STARTING_USERS.ecommerce,
        paidUsers: 0,
        arrived: 0,
        needsServers: true,
        setUp: false,
        opsNeeded: 0,
      });
      const next = (await rampApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
      expect(next.company).toMatchObject({ day: 2, users: 0, launch: { status: "waiting" } });
    });
  });

  it("trickles the launch users in over the ramp, then shows the day it launched", async () => {
    await withRampedApp(async (start, rampApp) => {
      // SaaS can serve users from day 1: the first 20% of the shop's 2,000 arrive as the game starts.
      const { company, url } = await start("saas");
      expect(company).toMatchObject({ users: 400, launch: { status: "launching", day: 1, rampDay: 1, arrived: 400 } });
      const next = async () => (await rampApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
      const second = await next();
      expect(second.company).toMatchObject({ users: 1_000, launch: { status: "launching", rampDay: 2, arrived: 1_000 } });
      expect(second.log.at(-1)!.entries).toContainEqual({
        text: "Launch, day 2 of 3: 600 new users arrived, 0 of them paying.",
        cashDelta: 0,
        kind: "launch",
      });
      const third = await next();
      expect(third.company).toMatchObject({ users: 2_000, launch: { status: "launched", day: 1, rampDay: 3, arrived: 2_000 } });
    });
  });

  it("is launched in full as the game starts on a config with a one-day ramp and servers in place", async () => {
    const code = await newCode();
    const company = (await newCompany(code, { name: "Acme", productType: "ecommerce", model: "iaas" })).json<CompanyView>();
    expect(company).toMatchObject({ users: STARTING_USERS.ecommerce, launch: { status: "launched", day: 1, rampDays: 1 } });
  });
});

describe("pricing and income", () => {
  async function setup(overrides?: object) {
    // A teacher's overrides apply to new games, so a test that needs paying users sets the free share that way.
    if (overrides) await useOverrides(overrides);
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    const next = async () => (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    return { company, url, act, next };
  }
  const fairPrice = sim.config.productTypes.ecommerce.pricing.fairPrice;

  it("starts at the product's fair price, with paid and free users and no income yet", async () => {
    const { company } = await setup({ "productTypes.ecommerce.pricing.freeShare": 0.25 });
    expect(company).toMatchObject({
      users: 2000,
      paidUsers: 1500,
      freeUsers: 500,
      price: fairPrice,
      fairPrice,
      dailyIncome: Math.round((1500 * fairPrice) / 30),
      income: 0,
    });
  });

  it("sets the price, keeps it across reloads, and pays paid users × price ÷ 30 on continue", async () => {
    const { url, act, next } = await setup({ "productTypes.ecommerce.pricing.freeShare": 0.5 });
    const set = await act({ type: "setPrice", price: 30 });
    expect(set.statusCode).toBe(200);
    // 1,000 paying users at £30 a month: £1,000 a day. Nothing is paid until the day is played.
    expect(set.json<CompanyView>()).toMatchObject({ price: 30, paidUsers: 1000, dailyIncome: 1000, income: 0, cash: 1000 });
    expect((await app.inject({ method: "GET", url })).json<CompanyView>().price).toBe(30);

    const { company, log } = await next();
    expect(log[0]!.entries).toContainEqual({
      text: "Income: 1,000 paying users at £30 a month",
      cashDelta: 1000,
      kind: "income",
    });
    // £1,000 in, £25 of IaaS out.
    expect(company).toMatchObject({ day: 2, income: 1000, cash: 1975 });
    expect(company.paidUsers + company.freeUsers).toBe(company.users);
    const summary = (await app.inject({ method: "GET", url: `${url}/summary` })).json<SummaryView>();
    expect(summary).toMatchObject({ income: 1000, profit: 975, priceChanges: 1, loan: null });
    expect(summary.days.at(-1)).toMatchObject({ day: 2, income: 1000, cash: 1975 });
    expect(summary.incomeVsCosts).toEqual([
      { day: 1, income: 0, costs: 0, totalIncome: 0, totalCosts: 0 },
      { day: 2, income: 1000, costs: 25, totalIncome: 1000, totalCosts: 25 },
    ]);
    expect(summary.peak).toMatchObject({ users: Math.max(...summary.days.map((d) => d.users)) });
    expect(Math.round(summary.satisfaction)).toBe(company.satisfaction);
  });

  it("validates the price: a positive number, at most the game's highest price", async () => {
    const { url, act } = await setup();
    for (const payload of [
      { type: "setPrice" },
      { type: "setPrice", price: 0 },
      { type: "setPrice", price: -5 },
      { type: "setPrice", price: "lots" },
      { type: "setPrice", pool: "ops" },
    ]) {
      expect((await act(payload)).statusCode).toBe(400);
    }
    const tooHigh = await act({ type: "setPrice", price: sim.config.pricing.maxPrice + 1 });
    expect(tooHigh.statusCode).toBe(400);
    expect(tooHigh.json()).toMatchObject({ error: "price_too_high" });
    // Nothing changed.
    expect((await app.inject({ method: "GET", url })).json<CompanyView>().price).toBe(fairPrice);
    expect((await act({ type: "setPrice", price: sim.config.pricing.maxPrice })).statusCode).toBe(200);
  });

  it("uses the highest price from the game's config, shown in its meta", async () => {
    const { url, act } = await setup({ "pricing.maxPrice": 40 });
    expect((await app.inject({ method: "GET", url: `${url}/meta` })).json<MetaView>().maxPrice).toBe(40);
    expect((await act({ type: "setPrice", price: 41 })).json()).toMatchObject({ error: "price_too_high" });
    expect((await act({ type: "setPrice", price: 40 })).statusCode).toBe(200);
  });

  it("previews a price without changing anything, and the preview matches the wave that follows", async () => {
    const { url, act, next } = await setup({ "productTypes.ecommerce.pricing.freeShare": 0.5 });
    const preview = async (price: unknown) => app.inject({ method: "GET", url: `${url}/price-preview?price=${price}` });
    const res = await preview(fairPrice * 1.5);
    expect(res.statusCode).toBe(200);
    const body = res.json<PricePreviewView>();
    expect(body).toMatchObject({ price: fairPrice * 1.5, currentPrice: fairPrice, direction: "rise", locked: false, lockDaysLeft: 0 });
    expect(body.lockDays).toBe(sim.config.pricing.lockDays);
    expect(body.days).toHaveLength(sim.config.pricing.waveDays);
    expect(body.total.left + body.total.toFree).toBeGreaterThan(0);
    expect(body.days.reduce((sum, d) => sum + d.left, 0)).toBe(body.total.left);
    // Nothing changed.
    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({ price: fairPrice, priceWave: null });

    // The wave that follows is the one previewed.
    const set = (await act({ type: "setPrice", price: fairPrice * 1.5 })).json<CompanyView>();
    expect(set.priceWave).toMatchObject({ direction: "rise", day: 0, remaining: body.days.length, total: body.total });
    expect(set.priceWave!.days).toEqual(body.days);
    const { company } = await next();
    expect(company.priceWave).toMatchObject({ day: 1, remaining: body.days.length - 1 });
    expect(company.priceWave!.done).toMatchObject({ left: body.days[0]!.left, toFree: body.days[0]!.toFree });
    expect((await preview(fairPrice)).json<PricePreviewView>()).toMatchObject({ locked: true });
  });

  it("validates the preview's price", async () => {
    const { url } = await setup();
    for (const q of ["", "?price=", "?price=0", "?price=-5", "?price=lots"]) {
      const res = await app.inject({ method: "GET", url: `${url}/price-preview${q}` });
      expect(res.statusCode).toBe(400);
    }
    const tooHigh = await app.inject({ method: "GET", url: `${url}/price-preview?price=${sim.config.pricing.maxPrice + 1}` });
    expect(tooHigh.statusCode).toBe(400);
    expect(tooHigh.json()).toMatchObject({ error: "price_too_high" });
    const code = await newCode();
    const elsewhere = await app.inject({ method: "GET", url: url.replace(/codes\/[^/]+/, `codes/${code}`) + "/price-preview?price=5" });
    expect(elsewhere.statusCode).toBe(404);
  });

  it("locks the price after a change: another change is a 409 with the days left, counting down each day", async () => {
    const { act, next } = await setup();
    const first = (await act({ type: "setPrice", price: fairPrice + 1 })).json<CompanyView>();
    const lockDays = sim.config.pricing.lockDays;
    expect(first.priceLockDaysLeft).toBe(lockDays);
    const locked = await act({ type: "setPrice", price: fairPrice + 2 });
    expect(locked.statusCode).toBe(409);
    expect(locked.json()).toMatchObject({ error: "price_locked", daysLeft: lockDays });
    expect(locked.json().message).toContain(`${lockDays} more days`);
    expect((await next()).company.priceLockDaysLeft).toBe(lockDays - 1);
    expect((await act({ type: "setPrice", price: fairPrice + 2 })).json()).toMatchObject({ daysLeft: lockDays - 1 });
  });

  it("shows free-to-paid conversion: today's conversions, the rate and what's helping or hurting it", async () => {
    const { company, act, next } = await setup({
      "productTypes.ecommerce.pricing.freeShare": 0.5,
      "productTypes.ecommerce.pricing.conversionRate": 0.01,
    });
    expect(company.conversion).toMatchObject({ today: 0, total: 0, baseRate: 0.01, recentUptime: 100 });
    expect(company.conversion.drivers.map((d) => [d.id, d.effect])).toEqual([
      ["features", "neutral"],
      ["uptime", "helping"],
      ["satisfaction", "helping"],
      ["price", "neutral"],
    ]);
    expect(company.conversion.rate).toBeGreaterThan(0.01);

    const { company: after, log } = await next();
    const line = log[0]!.entries.find((e) => e.kind === "conversion")!;
    expect(line.text).toMatch(/^Free to paid: \d[\d,]* of \d[\d,]* free users started paying/);
    expect(after.conversion.today).toBeGreaterThan(0);
    expect(line.text).toContain(`Free to paid: ${after.conversion.today} of`);
    expect(after.conversion.total).toBe(after.conversion.today);

    // A price above the fair price hurts it.
    const dear = (await act({ type: "setPrice", price: fairPrice * 2 })).json<CompanyView>();
    expect(dear.conversion.drivers.find((d) => d.id === "price")).toMatchObject({ effect: "hurting", value: 2 });
    expect(dear.conversion.rate).toBeLessThan(after.conversion.rate);

  });
});

describe("config presets", () => {
  async function teacher(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) {
    return app.inject({ method, url, payload, cookies: await teacherCookie() });
  }
  const list = async () => (await teacher("GET", "/api/teacher/presets")).json<PresetsView>();
  const create = (payload: object) => teacher("POST", "/api/teacher/presets", payload);
  const update = (id: string, payload: object) => teacher("PATCH", `/api/teacher/presets/${id}`, payload);
  const activate = (id: string) => teacher("POST", `/api/teacher/presets/${id}/activate`);
  const get = async (id: string) => (await teacher("GET", `/api/teacher/presets/${id}`)).json<PresetView>();
  const meta = async () => (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();

  it("requires a teacher session on every preset route", async () => {
    const id = "00000000-0000-0000-0000-000000000000";
    const routes: [string, string, object?][] = [
      ["GET", "/api/teacher/presets"],
      ["GET", "/api/teacher/presets/default"],
      ["POST", "/api/teacher/presets", { name: "Easy" }],
      ["PATCH", `/api/teacher/presets/${id}`, { name: "Easy" }],
      ["DELETE", `/api/teacher/presets/${id}`],
      ["POST", "/api/teacher/presets/default/activate"],
    ];
    for (const [method, url, payload] of routes) {
      const res = await app.inject({ method: method as "GET", url, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("starts with only Default, built in and active, its fields defaulting to the server's base config", async () => {
    expect(await list()).toEqual({
      active: "default",
      maxNameLength: 40,
      presets: [{ id: "default", name: "Default", builtIn: true, active: true, changed: 0, updatedAt: null }],
    });
    const view = await get("default");
    expect(view.overrides).toEqual({});
    const field = (path: string) => view.fields.find((f) => f.path === path);
    expect(field("startingCash")).toMatchObject({ group: "Money", default: 1000, min: 0 });
    expect(field("staff.developers.dayRate")).toMatchObject({ group: "People", default: 10 });
    expect(view.values).toMatchObject({ startingCash: 1000, "staff.developers.dayRate": 10 });
    // The test config has no events, so no event fields.
    expect(view.fields.some((f) => f.path.startsWith("events."))).toBe(false);
  });

  it("creates a preset from values, dropping any equal to the default, and resolves it", async () => {
    const res = await create({
      name: "  Easy   mode ",
      overrides: { startingCash: 5000, "staff.developers.dayRate": 10, "models.iaas.monthlyCost": 900 },
    });
    expect(res.statusCode).toBe(201);
    const view = res.json<PresetView>();
    expect(view).toMatchObject({ name: "Easy mode", builtIn: false, active: false, changed: 2 });
    expect(view.overrides).toEqual({ startingCash: 5000, "models.iaas.monthlyCost": 900 });
    expect(view.values).toMatchObject({ startingCash: 5000, "staff.developers.dayRate": 10 });
    expect(await get(view.id)).toEqual(view);
    // Listed after Default, but not active until chosen: new games still use the defaults.
    expect((await list()).presets.map((p) => [p.name, p.active])).toEqual([
      ["Default", true],
      ["Easy mode", false],
    ]);
    expect((await meta()).startingCash).toBe(1000);
  });

  it("saves another preset as a copy (save as), Default included", async () => {
    const easy = (await create({ name: "Easy", overrides: { startingCash: 5000 } })).json<PresetView>();
    const copy = await create({ name: "Lesson 3", from: easy.id });
    expect(copy.statusCode).toBe(201);
    expect(copy.json<PresetView>().overrides).toEqual({ startingCash: 5000 });
    const fromDefault = (await create({ name: "Blank" })).json<PresetView>();
    expect(fromDefault.overrides).toEqual({});
    expect((await create({ name: "Nope", from: "00000000-0000-0000-0000-000000000000" })).statusCode).toBe(404);
    // A copy is its own preset: changing it leaves the original alone.
    await update(copy.json<PresetView>().id, { overrides: { startingCash: 9000 } });
    expect((await get(easy.id)).overrides).toEqual({ startingCash: 5000 });
  });

  it("keeps names unique whatever their case, trimmed, capped, and never Default", async () => {
    const easy = (await create({ name: "Easy" })).json<PresetView>();
    const clash = await create({ name: " easy " });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toBe("name_taken");
    for (const name of ["", "   ", "default", "x".repeat(41)]) {
      const res = await create({ name });
      expect(res.statusCode, JSON.stringify(name)).toBe(400);
      expect(res.json().error).toBe("invalid_name");
    }
    expect((await create({ name: "x".repeat(40) })).statusCode).toBe(201);
    // Renaming to another's name clashes too; to its own name in another case doesn't.
    const hard = (await create({ name: "Hard" })).json<PresetView>();
    expect((await update(hard.id, { name: "EASY" })).statusCode).toBe(409);
    const renamed = await update(easy.id, { name: "EASY" });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<PresetView>().name).toBe("EASY");
  });

  it("renames a preset and replaces its values", async () => {
    const easy = (await create({ name: "Easy", overrides: { startingCash: 5000 } })).json<PresetView>();
    const res = await update(easy.id, { name: "Lesson 3", overrides: { "staff.ops.dayRate": 8 } });
    expect(res.statusCode).toBe(200);
    expect(res.json<PresetView>()).toMatchObject({ name: "Lesson 3", overrides: { "staff.ops.dayRate": 8 } });
    // A rename alone keeps the values.
    const renamed = (await update(easy.id, { name: "Lesson 4" })).json<PresetView>();
    expect(renamed.overrides).toEqual({ "staff.ops.dayRate": 8 });
    expect((await update(easy.id, {})).statusCode).toBe(400);
    expect((await update("00000000-0000-0000-0000-000000000000", { name: "X" })).statusCode).toBe(404);
  });

  it("rejects invalid values with an error per field, saving none of them", async () => {
    const easy = (await create({ name: "Easy", overrides: { startingCash: 5000 } })).json<PresetView>();
    const bad = {
      startingCash: 7000,
      "staff.ops.dayRate": -5,
      "models.nope.capacity": 1,
      "staff.developers.startingCount": 1.5,
      "outage.baseHours": "3",
    };
    const res = await update(easy.id, { overrides: bad });
    expect(res.statusCode).toBe(400);
    const body = res.json<ConfigErrorView>();
    expect(body.error).toBe("invalid_config");
    expect(Object.keys(body.fields).sort()).toEqual([
      "models.nope.capacity",
      "outage.baseHours",
      "staff.developers.startingCount",
      "staff.ops.dayRate",
    ]);
    expect(body.message).toMatch(/4 settings/);
    expect((await get(easy.id)).overrides).toEqual({ startingCash: 5000 });
    // Creating with bad values makes nothing.
    expect((await create({ name: "Bad", overrides: bad })).statusCode).toBe(400);
    expect((await list()).presets).toHaveLength(2);
  });

  it("keeps Default read-only", async () => {
    for (const res of [
      await update("default", { name: "Mine" }),
      await update("default", { overrides: { startingCash: 5000 } }),
      await teacher("DELETE", "/api/teacher/presets/default"),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("read_only");
    }
    expect((await get("default")).overrides).toEqual({});
  });

  it("makes one preset active at a time, Default included, and refuses to delete the active one", async () => {
    const easy = (await create({ name: "Easy", overrides: { startingCash: 5000 } })).json<PresetView>();
    const hard = (await create({ name: "Hard", overrides: { startingCash: 500 } })).json<PresetView>();

    const activated = await activate(easy.id);
    expect(activated.statusCode).toBe(200);
    expect(activated.json<PresetsView>().active).toBe(easy.id);
    expect((await meta()).startingCash).toBe(5000);

    const switched = (await activate(hard.id)).json<PresetsView>();
    expect(switched.presets.filter((p) => p.active).map((p) => p.name)).toEqual(["Hard"]);
    expect((await meta()).startingCash).toBe(500);

    const refused = await teacher("DELETE", `/api/teacher/presets/${hard.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("preset_active");

    const deleted = await teacher("DELETE", `/api/teacher/presets/${easy.id}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json<PresetsView>().presets.map((p) => p.name)).toEqual(["Default", "Hard"]);
    expect((await teacher("DELETE", `/api/teacher/presets/${easy.id}`)).statusCode).toBe(404);

    // Back to Default: no preset row is active, and new games get the base config.
    expect((await activate("default")).json<PresetsView>().active).toBe("default");
    expect((await meta()).startingCash).toBe(1000);
    expect((await teacher("DELETE", `/api/teacher/presets/${hard.id}`)).statusCode).toBe(200);
    expect((await activate("00000000-0000-0000-0000-000000000000")).statusCode).toBe(404);
  });

  it("records the active preset's name and config in a new game, unchanged by later edits, renames or deletes", async () => {
    const code = await newCode();
    const before = (await newCompany(code)).json<CompanyView>();
    expect(before).toMatchObject({ cash: 1000, preset: "Default" });

    const easy = await useOverrides({ startingCash: 5000, "staff.developers.dayRate": 50, finalDay: 40 }, "Easy");
    const after = (await newCompany(code, { name: "Beta", productType: "social", model: "iaas" })).json<CompanyView>();
    expect(after).toMatchObject({ cash: 5000, finalDay: 40, preset: "Easy" });
    const [row] = await testDb.db.select().from(companies).where(eq(companies.id, after.id));
    expect(row!).toMatchObject({ preset: "Easy", config: { startingCash: 5000, finalDay: 40 } });

    // Edited and renamed: neither game changes.
    await update(easy, { name: "Easier", overrides: { startingCash: 9000, "staff.developers.dayRate": 70 } });
    const hire = (id: string) =>
      app.inject({
        method: "POST",
        url: `/api/codes/${code}/companies/${id}/actions`,
        payload: { type: "hire", pool: "developers" } satisfies ActionBody,
      });
    expect((await hire(before.id)).json<CompanyView>().dailyStaffCost).toBe(10);
    const hired = (await hire(after.id)).json<CompanyView>();
    expect(hired).toMatchObject({ dailyStaffCost: 50, preset: "Easy" });

    const played = await app.inject({ method: "POST", url: `/api/codes/${code}/companies/${after.id}/continue` });
    expect(played.json<ContinueResult>().company).toMatchObject({ finalDay: 40, cash: 5000 - 50 - 25 });

    // Each game's meta comes from its own config; the shared meta is what a new game would get.
    const metaOf = async (id: string) =>
      (await app.inject({ method: "GET", url: `/api/codes/${code}/companies/${id}/meta` })).json<MetaView>();
    expect((await metaOf(before.id)).staff.find((s) => s.id === "developers")!.dayRate).toBe(10);
    expect(await metaOf(after.id)).toMatchObject({ startingCash: 5000, finalDay: 40 });
    expect((await meta()).startingCash).toBe(9000);

    // Deleted (once it's no longer active): the game still shows the name it started with.
    await activate("default");
    expect((await teacher("DELETE", `/api/teacher/presets/${easy}`)).statusCode).toBe(200);
    const third = (await newCompany(code, { name: "Gamma", productType: "video", model: "iaas" })).json<CompanyView>();
    expect(third.preset).toBe("Default");

    // The dashboard and the teacher's view of a game show each game's own length and preset.
    const games = (await teacher("GET", "/api/teacher/games")).json<TeacherGamesView>();
    const shown = Object.fromEntries(games.codes[0]!.companies.map((c) => [c.name, [c.finalDay, c.preset]]));
    expect(shown).toEqual({ Acme: [sim.config.finalDay, "Default"], Beta: [40, "Easy"], Gamma: [sim.config.finalDay, "Default"] });
    const summary = (await teacher("GET", `/api/teacher/companies/${after.id}/summary`)).json<TeacherSummaryView>();
    expect(summary.preset).toBe("Easy");
    const own = (await app.inject({ method: "GET", url: `/api/codes/${code}/companies/${after.id}` })).json<CompanyView>();
    expect(own.preset).toBe("Easy");
  });

  it("names the preset of games started before presets had names when the server starts", async () => {
    const code = await newCode();
    const plain = (await newCompany(code)).json<CompanyView>();
    await useOverrides({ startingCash: 5000 });
    const custom = (await newCompany(code, { name: "Beta", productType: "social", model: "iaas" })).json<CompanyView>();
    const noConfig = (await newCompany(code, { name: "Gamma", productType: "video", model: "iaas" })).json<CompanyView>();
    await testDb.db.update(companies).set({ preset: null });
    await testDb.db.update(companies).set({ config: null }).where(eq(companies.id, noConfig.id));

    const restarted = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim, rateLimit: false });
    await restarted.close();
    const rows = await testDb.db.select({ id: companies.id, preset: companies.preset }).from(companies);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.preset]))).toEqual({
      [plain.id]: "Default",
      [custom.id]: "Custom",
      [noConfig.id]: "Default",
    });
  });

  it("refuses the per-game meta for an unknown company", async () => {
    const code = await newCode();
    const res = await app.inject({
      method: "GET",
      url: `/api/codes/${code}/companies/00000000-0000-0000-0000-000000000000/meta`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("health", () => {
  it("reports ok when the database answers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("behind a proxy", () => {
  async function loginCookie(trustProxy?: string) {
    const proxied = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), trustProxy });
    try {
      const res = await proxied.inject({
        method: "POST",
        url: "/api/teacher/login",
        headers: { "x-forwarded-proto": "https" },
        payload: { password: PASSWORD },
      });
      return res.cookies.find((c) => c.name === "teacher")!;
    } finally {
      await proxied.close();
    }
  }

  it("marks the teacher cookie Secure when a trusted proxy says the request was HTTPS", async () => {
    // inject requests come from 127.0.0.1, standing in for the proxy.
    expect((await loginCookie("loopback")).secure).toBe(true);
  });

  it("ignores X-Forwarded-Proto unless the proxy is trusted", async () => {
    expect((await loginCookie()).secure).toBeUndefined();
  });

  it("serves plain HTTP without Secure, for local use", async () => {
    const res = await app.inject({ method: "POST", url: "/api/teacher/login", payload: { password: PASSWORD } });
    expect(res.cookies.find((c) => c.name === "teacher")!.secure).toBeUndefined();
  });
});

describe("rate limits", () => {
  let limited: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    limited = await buildApp({
      db: testDb.db,
      teacherPassword: PASSWORD,
      sessionSecret: "x".repeat(32),
      sim,
      trustProxy: "loopback",
      rateLimit: { codeFailures: 3, loginFailures: 2, windowMinutes: 15 },
    });
  });

  afterEach(async () => {
    await limited.close();
  });

  const fromIp = (ip: string) => ({ "x-forwarded-for": ip });

  it("blocks an IP after too many unknown codes, even for a real code, but not other IPs", async () => {
    const code = await newCode();
    for (let i = 0; i < 3; i++) {
      const res = await limited.inject({ method: "GET", url: "/api/codes/12345678", headers: fromIp("10.0.0.1") });
      expect(res.statusCode).toBe(404);
    }
    const blocked = await limited.inject({ method: "GET", url: `/api/codes/${code}`, headers: fromIp("10.0.0.1") });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("rate_limited");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    // Every route under the code is covered, not just the lookup.
    const create = await limited.inject({
      method: "POST",
      url: `/api/codes/${code}/companies`,
      headers: fromIp("10.0.0.1"),
      payload: { name: "Acme", productType: "ecommerce", model: "iaas" },
    });
    expect(create.statusCode).toBe(429);

    const other = await limited.inject({ method: "GET", url: `/api/codes/${code}`, headers: fromIp("10.0.0.2") });
    expect(other.statusCode).toBe(200);
  });

  it("doesn't count successful lookups", async () => {
    const code = await newCode();
    for (let i = 0; i < 10; i++) {
      const res = await limited.inject({ method: "GET", url: `/api/codes/${code}`, headers: fromIp("10.0.0.3") });
      expect(res.statusCode).toBe(200);
    }
  });

  it("blocks an IP after too many wrong teacher passwords, even with the right one", async () => {
    const login = (password: string, ip = "10.0.0.4") =>
      limited.inject({ method: "POST", url: "/api/teacher/login", headers: fromIp(ip), payload: { password } });
    expect((await login("nope")).statusCode).toBe(401);
    expect((await login("nope")).statusCode).toBe(401);
    const blocked = await login(PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.cookies).toHaveLength(0);
    expect((await login(PASSWORD, "10.0.0.5")).statusCode).toBe(200);
  });
});
