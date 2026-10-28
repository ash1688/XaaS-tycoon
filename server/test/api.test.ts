import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createSim, defaultConfig, GAME_STATE_VERSION, PRODUCT_TYPE_IDS, type GameState } from "@xaas/sim";
import { buildApp } from "../src/app.ts";
import { companies } from "../src/db/schema.ts";
import type {
  ActionBody,
  CompanyView,
  ConfigErrorView,
  CounterOddsView,
  ContinueResult,
  MetaView,
  MigrationQuoteView,
  PayOfferView,
  PresetsView,
  PresetView,
  PricePreviewView,
  SummaryView,
  TeacherCodeView,
  TeacherGamesView,
  TeacherSummaryView,
} from "../src/api-types.ts";
import { reachPhase, setupTestDb } from "./testDb.ts";

const PASSWORD = "test-teacher-password";
const iaasServers = defaultConfig.models.iaas.servers!;
const paasServers = defaultConfig.models.paas.servers!;
const LIGHT_DEMAND = { cuPerUser: 0.0005, dbuPerUser: 0.0005 };
// The server sizes, ops per server, starting users and starter setups these tests' sums were worked out with (before
// the balance pass and launch day), pinned so that tuning the defaults doesn't change them. Each game launches as it
// starts, with its starter setup in place and its launch users there; the launch tests change that with an override.
const UNITS = { small: 10, medium: 15, large: 20, massive: 25 };
const STARTING_USERS = { ecommerce: 2000, social: 1000, video: 1000, payments: 1000, assistant: 1000, games: 1000 };
const sim = createSim({
  ...defaultConfig,
  startingCash: 1000,
  // No pay reviews, which hold the clock each quarter, unless a test turns them on: they have their own tests below.
  payReview: { ...defaultConfig.payReview, on: 0 },
  // Games start on a random date, so holidays are left out unless a test adds them: they'd move load and growth.
  calendar: { ...defaultConfig.calendar, holidays: [] },
  // Add-ons cost only their per-user price, so buying one fits in the starting cash.
  addons: { ...defaultConfig.addons, setupFeePerDevDay: 0 },
  // Cash runs out the moment it goes below £0, as the rescue tests here were written for, unless a test says
  // otherwise: shortfalls going on a loan first have their own test.
  rescue: { ...defaultConfig.rescue, limitDays: 0 },
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
        opsPerServer: { app: 0.6, database: 0.6, cache: 0.3, loadBalancer: 0.3, api: 0.6 },
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
      powerAndCooling: 0,
      exitPenalty: 200,
      servers: {
        ...iaasServers,
        opsPerServer: { app: 0.5, database: 0.5, cache: 0.25, loadBalancer: 0.25, api: 0.5 },
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
      powerAndCooling: 0,
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
  // No MVP to build, and Launch presses itself, so a company launches as soon as it can serve users: the sim tests the
  // MVP and Launch.
  launch: { rampShares: [1], auto: 1 },
  mvp: { ...defaultConfig.mvp, baseDevDays: { ecommerce: 0, social: 0, video: 0, payments: 0, assistant: 0, games: 0 } },
  // Seeds are random here, so migrations never overrun.
  migration: { ...defaultConfig.migration, overrun: { ...defaultConfig.migration.overrun, chance: 0 } },
  // No starting staff, so continue charges only the model's running cost unless a test hires someone.
  staff: {
    developers: { ...defaultConfig.staff.developers, dayRate: 10, startingCount: 0 },
    ops: { ...defaultConfig.staff.ops, dayRate: 4, startingCount: 0 },
    support: { ...defaultConfig.staff.support, dayRate: 3, startingCount: 0 },
    moderators: { ...defaultConfig.staff.moderators, dayRate: 2, startingCount: 0 },
    researchers: { ...defaultConfig.staff.researchers, dayRate: 5, startingCount: 0 },
    marketers: { ...defaultConfig.staff.marketers, dayRate: 6, startingCount: 0 },
  },
  // Mids (the default hire) and seniors start at once, so tests needn't wait; juniors wait 3 days, to test lead times.
  staffGrades: {
    junior: { ...defaultConfig.staffGrades.junior, leadDays: 3 },
    mid: { ...defaultConfig.staffGrades.mid, leadDays: 0 },
    senior: { ...defaultConfig.staffGrades.senior, leadDays: 0 },
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
        growth: {
          ...p.growth,
          launchUsersMin: STARTING_USERS[id as keyof typeof STARTING_USERS],
          launchUsersMax: STARTING_USERS[id as keyof typeof STARTING_USERS],
        },
        pricing: { ...p.pricing, freeShare: 1, conversionRate: 0 },
        demand: { ...LIGHT_DEMAND, perUserFeeMultiplier: p.demand.perUserFeeMultiplier },
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

  it("doesn't count finished or liquidated games", async () => {
    const code = await newCode();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await newCompany(code)).json<CompanyView>().id);
    await setStatus(ids[0]!, "finished");
    await setStatus(ids[1]!, "liquidated");
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

  it("retiring twice is fine, but a finished or liquidated game can't be retired", async () => {
    const code = await newCode();
    const a = (await newCompany(code)).json<CompanyView>().id;
    const b = (await newCompany(code)).json<CompanyView>().id;
    await retire(code, a);
    expect((await retire(code, a)).json<CompanyView>().status).toBe("retired");
    await setStatus(b, "liquidated");
    const res = await retire(code, b);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_active" });
    expect(await statuses(code)).toEqual(["liquidated", "retired"]);
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
    expect(body.company).toMatchObject({ day: 2, cash: 975, tickDays: 1 });
    expect(body).toMatchObject({ days: 1, pauses: [] });
    expect(body.log).toHaveLength(1);
    expect(body.log[0]!.day).toBe(2);

    // Resuming later (a fresh request, as from another machine) sees the saved state.
    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({ day: 2, cash: 975 });
  });

  it("plays a week a press in a career, stopping on the day something needs the student, with why", async () => {
    await useOverrides({ "allowedGameLengths.career": 1 });
    const code = await newCode();
    const company = (
      await newCompany(code, { name: "Lifer", productType: "social", model: "saas", gameLength: "career" })
    ).json<CompanyView>();
    expect(company.tickDays).toBe(7);
    const url = `/api/codes/${code}/companies/${company.id}/continue`;

    // £1,000 of cash runs low inside the first week: time stops that day, with why.
    const first = (await app.inject({ method: "POST", url })).json<ContinueResult>();
    expect(first.days).toBeGreaterThan(0);
    expect(first.days).toBeLessThan(7);
    expect(first.pauses).toContainEqual({ kind: "lowCash", id: "low-cash", text: expect.stringMatching(/^Cash runs out/) });
    expect(first.company.day).toBe(1 + first.days);
    expect(first.log.map((d) => d.day)).toEqual(Array.from({ length: first.days }, (_, i) => 2 + i));

    // The next press plays on from there, up to a week.
    const second = (await app.inject({ method: "POST", url })).json<ContinueResult>();
    expect(second.log[0]!.day).toBe(first.company.day + 1);
    expect(second.days).toBeLessThanOrEqual(7);
    expect(second.company.day).toBe(first.company.day + second.days);
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
    expect(body.log[0]!.entries).toContainEqual({ text: "Developers pay (2 mids)", cashDelta: -20, category: "staff" });
  });

  it("hires and lets go several at once, within limits", async () => {
    const { act } = await setup();
    expect((await act({ type: "hire", pool: "support", count: 30 })).json<CompanyView>().support).toBe(30);
    expect((await act({ type: "letGo", pool: "support", count: 12 })).json<CompanyView>().support).toBe(18);
    const tooMany = await act({ type: "letGo", pool: "support", count: 19 });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json()).toMatchObject({ error: "no_staff" });
    for (const count of [0, 1.5, 1000]) expect((await act({ type: "hire", pool: "ops", count })).statusCode).toBe(400);
  });

  it("shows the runway: the daily costs by heading against the last 7 days' income, and the days of cash they leave", async () => {
    const { url, act } = await setup();
    await act({ type: "hire", pool: "developers", count: 2 });
    const company = (await app.inject({ method: "GET", url })).json<CompanyView>();
    // £25 a day of IaaS and £20 of developers against £1,000: 22 days, as a day played costs.
    expect(company.runway).toMatchObject({ dailyIncome: 0, dailyCosts: 45, dailyNet: -45, days: 22, payHoliday: false });
    expect(company.runway.costs.filter((h) => h.amount > 0).map((h) => [h.label, h.amount])).toEqual([
      ["Staff pay", 20],
      ["Hosting, rent and power", 25],
    ]);
    expect(company.opsNeededOnceReady).toBe(company.opsNeeded);
    const played = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    expect(played.company.cash).toBe(1000 - 45);
  });

  it("keeps researchers and research locked until the first angel approaches", async () => {
    const { company, act } = await setup();
    expect(company).toMatchObject({ researchers: 0, research: { unlocked: false, unlockedDay: null, points: 0, pointsPerDay: 0 } });
    expect(company.staff.map((p) => p.pool)).not.toContain("researchers");
    for (const payload of [{ type: "hire", pool: "researchers" }, { type: "hire", pool: "researchers", agency: true }]) {
      const refused = await act(payload);
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ error: "not_yet" });
    }
  });

  it("hires moderators only on a product with user content, and shows its reports", async () => {
    const { code, company, act } = await setup();
    // Moderators open in Grow.
    await reachPhase(testDb.db, company.id, "grow");
    const refused = await act({ type: "hire", pool: "moderators" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "no_content" });
    const shop = (await act({ type: "hire", pool: "support" })).json<CompanyView>();
    expect(shop).toMatchObject({ moderators: 0, moderation: null });
    expect(shop.staff.map((p) => p.pool)).not.toContain("moderators");

    const created = (await newCompany(code, { name: "Chatter", productType: "social", model: "saas" })).json<CompanyView>();
    await reachPhase(testDb.db, created.id, "grow");
    const url = `/api/codes/${code}/companies/${created.id}`;
    const social = (await app.inject({ method: "GET", url })).json<CompanyView>();
    expect(social.staff.map((p) => p.pool)).toContain("moderators");
    expect(social.moderation).toMatchObject({ backlog: 0, dailyClearance: 0, lawsuitOdds: 1 });
    // With no moderators, the reports the users raise go unhandled, and the lawsuit odds rise.
    const played = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>().company;
    expect(played.moderation!.reportsToday).toBeGreaterThan(0);
    expect(played.moderation!.backlog).toBe(played.moderation!.reportsToday);
    expect(played.moderation!.lawsuitOdds).toBeGreaterThan(1);
    const hired = await app.inject({ method: "POST", url: `${url}/actions`, payload: { type: "hire", pool: "moderators", count: 2 } });
    expect(hired.json<CompanyView>()).toMatchObject({ moderators: 2, moderation: { dailyClearance: 2 * defaultConfig.moderation.reportsPerPerson } });
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta.reportsPerPerson).toBe(defaultConfig.moderation.reportsPerPerson);
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

  it("hires by grade: each grade's pay and work, and juniors shown waiting until they start", async () => {
    const { url, act } = await setup();
    // A senior support person is £3 × 1.3 = £3.90, rounded to £4, and clears 1.35 × 30 tickets.
    const senior = (await act({ type: "hire", pool: "support", grade: "senior" })).json<CompanyView>();
    expect(senior).toMatchObject({ support: 1, dailyStaffCost: 4, dailyClearance: 40.5 });
    const waiting = (await act({ type: "hire", pool: "support", grade: "junior", count: 2 })).json<CompanyView>();
    expect(waiting).toMatchObject({ support: 1, dailyStaffCost: 4 });
    expect(waiting.staff.find((p) => p.pool === "support")).toMatchObject({
      headcount: 1,
      output: 1.35,
      grades: [
        { grade: "junior", count: 0, dayRate: 2, output: 0.65, leadDays: 3 },
        { grade: "mid", count: 0, dayRate: 3 },
        { grade: "senior", count: 1, dayRate: 4, output: 1.35 },
      ],
      hiring: [{ grade: "junior", count: 2, arrivesOn: 4, daysLeft: 3 }],
    });
    // Juniors can't be let go before they start.
    expect((await act({ type: "letGo", pool: "support", grade: "junior" })).json()).toMatchObject({ error: "no_staff" });
    let played: ContinueResult | undefined;
    for (let i = 0; i < 3; i++) played = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    expect(played!.company).toMatchObject({ day: 4, support: 3, dailyStaffCost: 8 });
    expect(played!.log[0]!.entries).toContainEqual({ text: "2 junior support staff started work.", cashDelta: 0, kind: "staff" });
    expect((await act({ type: "hire", pool: "support", grade: "intern" })).statusCode).toBe(400);
  });

  it("hires agency staff for the next day, shown apart, and charges severance only for permanent staff", async () => {
    const { url, act } = await setup();
    // An agency mid in support is £3 × 1.25 = £3.75, rounded to £4, and does half a mid's work.
    const hired = (await act({ type: "hire", pool: "support", agency: true, count: 2 })).json<CompanyView>();
    expect(hired.staff.find((p) => p.pool === "support")).toMatchObject({
      headcount: 0,
      agencyCount: 0,
      hiring: [{ grade: "mid", count: 2, agency: true, arrivesOn: 2, daysLeft: 1 }],
    });
    const played = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    expect(played.company).toMatchObject({ support: 0, dailyStaffCost: 8, dailyClearance: 30 });
    expect(played.company.staff.find((p) => p.pool === "support")).toMatchObject({
      agencyCount: 2,
      output: 1,
      agency: [{ grade: "junior", count: 0 }, { grade: "mid", count: 2, dayRate: 4, output: 0.5, severance: 0 }, { grade: "senior", count: 0 }],
    });
    expect(played.log[0]!.entries).toContainEqual({ text: "Agency support staff pay (2 mids)", cashDelta: -8, category: "staff" });

    const cash = played.company.cash;
    const agencyGone = (await act({ type: "letGo", pool: "support", agency: true, count: 2 })).json<CompanyView>();
    expect(agencyGone).toMatchObject({ cash, dailyStaffCost: 0 });

    // A permanent mid in support is £3 a day: severance is 14 days' pay, £42, shown before they go and paid at once.
    const permanent = (await act({ type: "hire", pool: "support" })).json<CompanyView>();
    const mid = permanent.staff.find((p) => p.pool === "support")!.grades.find((g) => g.grade === "mid")!;
    expect(mid.severance).toBe(42);
    expect((await act({ type: "letGo", pool: "support" })).json<CompanyView>()).toMatchObject({ support: 0, cash: cash - 42 });
  });

  it("lists the grades in the game's meta", async () => {
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta.grades).toEqual([
      { id: "junior", name: "Junior", payMultiplier: 0.75, output: 0.65, leadDays: 3 },
      { id: "mid", name: "Mid", payMultiplier: 1, output: 1, leadDays: 0 },
      { id: "senior", name: "Senior", payMultiplier: 1.3, output: 1.35, leadDays: 0 },
    ]);
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
    expect(log[0]!.entries).toContainEqual({ text: "Support staff pay (1 mid)", cashDelta: -3, category: "staff" });
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

describe("difficulty", () => {
  it("offers only Normal by default, and refuses a difficulty the preset doesn't allow", async () => {
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta.difficulties).toEqual([
      { id: "normal", name: "Normal", blurb: expect.any(String), startingCash: meta.startingCash },
    ]);
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    expect(company).toMatchObject({ difficulty: "normal", difficultyName: "Normal" });
    const refused = await newCompany(code, { name: "Acme", productType: "ecommerce", model: "iaas", difficulty: "easy" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "difficulty_not_allowed", message: expect.stringContaining("Normal") });
  });

  it("starts a game on a difficulty the preset allows, with its numbers, and records it", async () => {
    await useOverrides({ "allowedDifficulties.easy": 1, "allowedDifficulties.hard": 1 });
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta.difficulties.map((d) => d.id)).toEqual(["easy", "normal", "hard"]);
    const [easy, normal, hard] = meta.difficulties.map((d) => d.startingCash);
    expect(easy).toBeGreaterThan(normal!);
    expect(hard).toBeLessThan(normal!);
    const code = await newCode();
    const games: Record<string, CompanyView> = {};
    for (const difficulty of ["easy", "normal", "hard"]) {
      const created = await newCompany(code, { name: difficulty, productType: "social", model: "saas", difficulty });
      expect(created.statusCode).toBe(201);
      games[difficulty] = created.json<CompanyView>();
    }
    expect(games.hard).toMatchObject({ difficulty: "hard", difficultyName: "Hard" });
    // SaaS has nothing to pay up front, so each game's cash follows its starting cash.
    expect(games.easy!.cash - games.normal!.cash).toBe(easy! - normal!);
    expect(games.normal!.cash - games.hard!.cash).toBe(normal! - hard!);
    // Left out, Normal.
    const plain = await newCompany(await newCode(), { name: "Plain", productType: "social", model: "saas" });
    expect(plain.json<CompanyView>().difficulty).toBe("normal");

    // The game keeps its difficulty after the preset stops allowing it.
    await useOverrides({}, "Normal only");
    const url = `/api/codes/${code}/companies/${games.hard!.id}`;
    expect((await app.inject({ method: "POST", url: `${url}/continue` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({ difficulty: "hard", day: 2 });
    expect((await app.inject({ method: "GET", url: `${url}/summary` })).json<SummaryView>()).toMatchObject({ difficulty: "hard" });
  });
});

describe("products", () => {
  it("lists every product in the meta, with its per-user fee multiplier", async () => {
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta.productTypes.map((p) => [p.id, p.perUserFeeMultiplier])).toEqual(
      PRODUCT_TYPE_IDS.map((id) => [id, defaultConfig.productTypes[id].demand.perUserFeeMultiplier]),
    );
    expect(meta.productTypes.map((p) => p.name)).toEqual(PRODUCT_TYPE_IDS.map((id) => defaultConfig.productTypes[id].name));
  });

  it("starts an AI assistant and a games network, with their own features and paid API", async () => {
    const code = await newCode();
    for (const productType of ["assistant", "games"] as const) {
      const created = await newCompany(code, { name: `New ${productType}`, productType, model: "saas" });
      expect(created.statusCode, productType).toBe(201);
      const company = created.json<CompanyView>();
      expect(company.productType).toBe(productType);
      expect(company.features.map((f) => f.id)).toEqual(defaultConfig.productTypes[productType].features.map((f) => f.id));
      expect(company.api).toMatchObject({ name: defaultConfig.productTypes[productType].api!.name, owned: false });
      // The SaaS platform bills each user its fee times the product's multiplier, to the penny.
      const fee = sim.config.models.saas.monthlyCostPerUser * defaultConfig.productTypes[productType].demand.perUserFeeMultiplier;
      expect(company.provider!.perUserFee).toBe(Math.round(fee * 100) / 100);
    }
  });
});

describe("game lengths", () => {
  const ALL_LENGTHS = { "allowedGameLengths.1-year": 1, "allowedGameLengths.career": 1 };

  it("offers only 180 days by default, and refuses a length the preset doesn't allow", async () => {
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta.gameLengths).toEqual([{ id: "180-days", name: "180 days", finalDay: 180 }]);
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    expect(company).toMatchObject({ gameLength: "180-days", gameLengthName: "180 days", finalDay: 180, endedByTeacher: false });
    const refused = await newCompany(code, { name: "Acme", productType: "ecommerce", model: "iaas", gameLength: "1-year" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "game_length_not_allowed", message: expect.stringContaining("180 days") });
  });

  it("starts a game of a length the preset allows, which keeps its final day", async () => {
    await useOverrides(ALL_LENGTHS);
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta.gameLengths.map((l) => [l.id, l.finalDay])).toEqual([
      ["180-days", 180],
      ["1-year", 365],
      ["career", 17_155],
    ]);
    const code = await newCode();
    const created = await newCompany(code, { name: "Acme", productType: "ecommerce", model: "iaas", gameLength: "1-year" });
    expect(created.statusCode).toBe(201);
    expect(created.json<CompanyView>()).toMatchObject({ gameLength: "1-year", finalDay: 365 });
    const career = (await newCompany(code, { name: "Lifer", productType: "social", model: "saas", gameLength: "career" })).json<CompanyView>();
    expect(career).toMatchObject({ gameLength: "career", finalDay: 17_155 });
    const games = (await app.inject({ method: "GET", url: "/api/teacher/games", cookies: await teacherCookie() })).json<TeacherGamesView>();
    expect(games.codes[0]!.companies.map((c) => c.finalDay).sort()).toEqual([17_155, 365]);
  });

  it("lets the teacher end one game, which then shows its summary and can't be played", async () => {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    await app.inject({ method: "POST", url: `${url}/continue` });
    const endUrl = `/api/teacher/companies/${company.id}/end`;
    expect((await app.inject({ method: "POST", url: endUrl })).statusCode).toBe(401);
    const cookies = await teacherCookie();
    const ended = await app.inject({ method: "POST", url: endUrl, cookies });
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toEqual({ ended: 1 });
    const after = (await app.inject({ method: "GET", url })).json<CompanyView>();
    expect(after).toMatchObject({ status: "finished", endedByTeacher: true, day: 2 });
    const summary = (await app.inject({ method: "GET", url: `${url}/summary` })).json<SummaryView>();
    expect(summary).toMatchObject({ ending: "ended", day: 2, finalDay: 180 });
    const next = await app.inject({ method: "POST", url: `${url}/continue` });
    expect(next.statusCode).toBe(409);
    expect(next.json()).toMatchObject({ error: "finished", message: expect.stringContaining("Your teacher ended Acme early") });
    // Ending it again ends nothing more.
    expect((await app.inject({ method: "POST", url: endUrl, cookies })).json()).toEqual({ ended: 0 });
    const games = (await app.inject({ method: "GET", url: "/api/teacher/games", cookies })).json<TeacherGamesView>();
    expect(games.codes[0]!.companies[0]).toMatchObject({ status: "finished", endedByTeacher: true });
    for (const id of ["00000000-0000-0000-0000-000000000000", "nope"]) {
      expect((await app.inject({ method: "POST", url: `/api/teacher/companies/${id}/end`, cookies })).statusCode).toBe(404);
    }
  });

  it("lets the teacher end every game still being played under a code, leaving others alone", async () => {
    const code = await newCode();
    const other = await newCode();
    const ids: string[] = [];
    for (const name of ["One", "Two", "Retired"]) {
      ids.push((await newCompany(code, { name, productType: "ecommerce", model: "iaas" })).json<CompanyView>().id);
    }
    await app.inject({ method: "POST", url: `/api/codes/${code}/companies/${ids[2]}/retire` });
    const elsewhere = (await newCompany(other)).json<CompanyView>();
    const cookies = await teacherCookie();
    expect((await app.inject({ method: "POST", url: `/api/teacher/codes/${code}/end` })).statusCode).toBe(401);
    const ended = await app.inject({ method: "POST", url: `/api/teacher/codes/${code}/end`, cookies });
    expect(ended.json()).toEqual({ ended: 2 });
    const list = (await app.inject({ method: "GET", url: `/api/codes/${code}` })).json<{ companies: CompanyView[] }>();
    expect(Object.fromEntries(list.companies.map((c) => [c.name, [c.status, c.endedByTeacher]]))).toEqual({
      One: ["finished", true],
      Two: ["finished", true],
      Retired: ["retired", false],
    });
    const untouched = (await app.inject({ method: "GET", url: `/api/codes/${other}/companies/${elsewhere.id}` })).json<CompanyView>();
    expect(untouched.status).toBe("active");
    // Ended games are history, so they don't count towards the limit.
    expect((await newCompany(code, { name: "Again", productType: "ecommerce", model: "iaas" })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/teacher/codes/99999999/end", cookies })).statusCode).toBe(404);
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
    // Pending: nothing changes until they're ready, and they need no ops until then (#259), though the order says so.
    expect(balanced.units!.cu.capacity).toBe(15 * defaultConfig.capacity.unstaffedShare);
    expect(balanced).toMatchObject({ opsNeeded: 1, opsNeededOnceReady: 1.75 });
    expect((await app.inject({ method: "GET", url })).json<CompanyView>().servers).toHaveLength(4);

    const next = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    expect(next.company.servers.every((s) => s.status === "ready")).toBe(true);
    expect(next.company.units).toMatchObject({
      cu: { capacity: (15 + 20) * defaultConfig.capacity.unstaffedShare },
      loadBalancer: { appServers: 2, loadBalancers: 1, needed: true, coverage: 2, counted: 2, uncovered: 0 },
    });
    // With no ops at all, the shortfall cuts every tier to 40%.
    expect(next.company.opsShortfall).toEqual({ have: 0, needed: 1.75, capacityShare: defaultConfig.capacity.unstaffedShare });
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
  /** What selling a bought server back refunds: its sell-back share of what it cost. */
  const sellBack = (paid: number) => Math.round(paid * onprem.purchase!.sellBackShare);
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
    // The server room (£2,500) with its medium rack (£500), the large app server and database, and cabling for the
    // rack and 2 servers.
    const kit = onprem.purchase!.price.app.large + onprem.purchase!.price.database.large;
    expect(company.cash).toBe(100_000 - 2_500 - 500 - kit - 150);
    expect(company.spend.infrastructure).toBe(2_500 + 500 + kit);
    expect(company.spend.cabling).toBe(150);
    expect(company.servers).toEqual([
      expect.objectContaining({ id: 1, type: "app", size: "large", status: "ready", daysLeft: 0, paid: onprem.purchase!.price.app.large, sellBack: sellBack(onprem.purchase!.price.app.large) }),
      expect.objectContaining({ id: 2, type: "database", size: "large", status: "ready", daysLeft: 0, paid: onprem.purchase!.price.database.large, sellBack: sellBack(onprem.purchase!.price.database.large) }),
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
        readyDays: 4,
      }),
    );
    const meta = (await ownApp.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta.models.find((m) => m.id === "onprem")).toMatchObject({ upfrontCost: 2_500 + 500 + kit + 150, powerAndCooling: 25 });
  });

  it("buys kit, charging it at once, on order with the days left until it arrives", async () => {
    const { company: before, act, get, next } = await setup();
    const res = await act({ type: "buyServer", server: "app", size: "small" });
    expect(res.statusCode).toBe(200);
    const bought = res.json<CompanyView>();
    expect(bought.cash).toBe(before.cash - onprem.purchase!.price.app.small - onprem.purchase!.cablingCost);
    expect(bought.servers.at(-1)).toMatchObject({ id: 3, type: "app", size: "small", status: "pending", daysLeft: 4 });
    // On order: no capacity and no ops needed until it arrives (its share shows in opsNeededOnceReady).
    expect({ ...bought.units, loadBalancerOnceReady: null }).toEqual({ ...before.units, loadBalancerOnceReady: null });
    expect(bought.opsNeeded).toBe(before.opsNeeded);
    expect(bought.opsNeededOnceReady).toBeGreaterThanOrEqual(before.opsNeeded);
    expect((await get()).servers.at(-1)).toMatchObject({ status: "pending", daysLeft: 4 });
    const { company } = await next();
    expect(company.servers.at(-1)).toMatchObject({ status: "pending", daysLeft: 3 });
  });

  it("sells kit back for its share once a replacement is ready, but not kit still on order (#260)", async () => {
    const { company: before, act, get } = await setup();
    // Its only database: selling it would leave nothing for today's load.
    expect((await act({ type: "sellServer", id: 2 })).json()).toMatchObject({ error: "cancel_unsafe" });
    await act({ type: "buyServer", server: "database", size: "large" });
    const onOrder = await act({ type: "sellServer", id: 3 });
    expect(onOrder.statusCode).toBe(400);
    expect(onOrder.json()).toMatchObject({ error: "on_order" });
    // With a replacement on order, the sale waits for it: still serving, and refunded when it goes.
    const sold = await act({ type: "sellServer", id: 2 });
    expect(sold.statusCode).toBe(200);
    const bought = before.cash - onprem.purchase!.price.database.large - onprem.purchase!.cablingCost;
    expect(sold.json<CompanyView>().cash).toBe(bought);
    const servers = (await get()).servers;
    expect(servers.map((s) => s.id)).toEqual([1, 2, 3]);
    expect(servers.find((s) => s.id === 2)!.leavesOn).toBe(servers.find((s) => s.id === 3)!.readyDay);
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

  it("buys racks and installs servers in them, with cabling and power and cooling as costs of their own", async () => {
    const { company: before, act, get, next } = await setup();
    // The starter kit's large app server and database take 8U of the server room's medium rack (24U).
    expect(before.racks).toMatchObject({ units: 24, used: 8, free: 16, mostFree: 16 });
    expect(before.racks!.racks).toEqual([expect.objectContaining({ id: 1, size: "medium", servers: [1, 2] })]);
    expect(before.servers.map((s) => s.rack)).toEqual([1, 1]);
    expect(before.serverOptions.find((o) => o.size === "massive")).toMatchObject({ rackUnits: 8, cabling: 50 });
    expect(before.powerAndCooling).toBe(defaultConfig.models.onprem.powerAndCooling);
    // Two massive servers fill it: a third needs another rack.
    for (let i = 0; i < 2; i++) expect((await act({ type: "buyServer", server: "app", size: "massive" })).statusCode).toBe(200);
    const full = await act({ type: "buyServer", server: "app", size: "massive" });
    expect(full.statusCode).toBe(400);
    expect(full.json()).toMatchObject({ error: "no_rack_space" });
    for (const payload of [
      { type: "buyRack" },
      { type: "buyRack", size: "massive" },
      { type: "sellRack" },
      { type: "sellRack", id: 0 },
      { type: "buyServer", server: "app", size: "small", rack: 0 },
    ]) {
      expect((await act(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    const filled = await get();
    const racked = await act({ type: "buyRack", size: "large" });
    expect(racked.statusCode).toBe(200);
    const withRack = racked.json<CompanyView>();
    expect(withRack.cash).toBe(filled.cash - 800 - 50);
    expect(withRack.spend.cabling).toBe(filled.spend.cabling + 50);
    expect(withRack.racks).toMatchObject({ units: 66, mostFree: 42 });
    const placed = (await act({ type: "buyServer", server: "app", size: "massive", rack: 2 })).json<CompanyView>();
    expect(placed.servers.at(-1)!.rack).toBe(2);
    expect((await act({ type: "sellRack", id: 2 })).json()).toMatchObject({ error: "rack_in_use" });
    // A day's power and cooling, as its own cost.
    const { company } = await next();
    expect(company.spend.power - placed.spend.power).toBe(defaultConfig.models.onprem.powerAndCooling);

    const iaas = await setup("iaas");
    expect(iaas.company.racks).toBeNull();
    expect((await iaas.act({ type: "buyRack", size: "small" })).json()).toMatchObject({ error: "no_racks" });
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
    // A change that changes nothing is refused with why, not a quiet success (playtest 1: + seemed to add, but didn't).
    const again = await act({ type: "setManagedService", service: "database", size: "large" });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: "same_size", message: "Your database is already large: pick another size to resize it." });
    expect((await act({ type: "setManagedService", service: "cache", size: null })).json()).toMatchObject({ error: "no_cache" });
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

describe("ledger, rescue buyout and liquidation", () => {
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
      { text: "Ops staff pay (1 mid)", cashDelta: -4, category: "staff" },
    ]);
    const spend = { staff: 8, infrastructure: 50, cabling: 0, power: 0, addons: 0, campaigns: 0, debt: 0 };
    expect(body!.company).toMatchObject({ cash: 1000 - 58, spend });
    expect((await app.inject({ method: "GET", url })).json<CompanyView>().spend).toEqual(spend);
  });

  it("has a vulture VC rescue the company the first time cash drops below zero", async () => {
    const { company, url } = await setup();
    await setCash(company.id, 10);
    const res = await app.inject({ method: "POST", url: `${url}/continue` });
    expect(res.statusCode).toBe(200);
    const body = res.json<ContinueResult>();
    // £15 of losses and 30 days at £25 a day, to the £100 above: £800.
    expect(body.company).toMatchObject({ day: 2, cash: 785, status: "active" });
    expect(body.company.rescue).toMatchObject({ day: 2, amount: 800, losses: 15, shares: 30_000, share: 0.75, buyBackPrice: 1_600 });
    expect(body.company.capTable.rows.map((r) => r.id)).toEqual(["student", "vulture"]);
    const rescue = body.log[0]!.entries.filter((e) => e.kind === "rescue");
    expect(rescue.map((e) => e.text)).toEqual([expect.stringMatching(/vulture VC rescued Acme: it put in £800/), expect.stringMatching(/^Forced cost cuts/)]);
    expect((await app.inject({ method: "GET", url })).json<CompanyView>().rescue).toMatchObject({ day: 2, amount: 800 });
  });

  it("buys the vulture VC's shares back at its price", async () => {
    const { company, url } = await setup();
    await setCash(company.id, 10);
    await app.inject({ method: "POST", url: `${url}/continue` });
    const refused = await app.inject({ method: "POST", url: `${url}/actions`, payload: { type: "buyBack" } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "cant_afford", cost: 1_600, cash: 785 });
    await setCash(company.id, 2_000);
    const bought = (await app.inject({ method: "POST", url: `${url}/actions`, payload: { type: "buyBack" } })).json<CompanyView>();
    expect(bought).toMatchObject({ cash: 400, rescue: { boughtBack: { day: 2, price: 1_600 }, buyBackPrice: null } });
    expect(bought.capTable.rows.map((r) => [r.id, r.share])).toEqual([["student", 1]]);
  });

  it("goes into liquidation when cash drops below zero again, then rejects continue and actions with 409", async () => {
    const { company, url } = await setup();
    await setCash(company.id, 10);
    await app.inject({ method: "POST", url: `${url}/continue` });
    await setCash(company.id, 10);
    const res = await app.inject({ method: "POST", url: `${url}/continue` });
    expect(res.statusCode).toBe(200);
    const body = res.json<ContinueResult>();
    expect(body.company).toMatchObject({ day: 3, cash: -15, status: "liquidated" });
    expect(body.log[0]!.entries.at(-1)).toMatchObject({ kind: "liquidation" });
    expect(body.company.valuation.valuation).toBe(0);

    for (const attempt of [
      app.inject({ method: "POST", url: `${url}/continue` }),
      app.inject({ method: "POST", url: `${url}/actions`, payload: { type: "hire", pool: "ops" } }),
    ]) {
      const rejected = await attempt;
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ error: "liquidated", message: expect.stringContaining("liquidation") });
    }

    // Nothing changed, and the game still shows as liquidated after a reload.
    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({
      day: 3,
      cash: -15,
      ops: 0,
      status: "liquidated",
    });
    const [row] = await testDb.db.select().from(companies).where(eq(companies.id, company.id));
    expect(row!.status).toBe("liquidated");
  });

  it("puts a small shortfall on an emergency loan, with the room left before a rescue", async () => {
    const lenient = createSim({ ...sim.config, rescue: defaultConfig.rescue });
    const lenientApp = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim: lenient });
    try {
      const code = await newCode();
      const created = await lenientApp.inject({
        method: "POST",
        url: `/api/codes/${code}/companies`,
        payload: { name: "Acme", productType: "ecommerce", model: "iaas" },
      });
      const company = created.json<CompanyView>();
      const url = `/api/codes/${code}/companies/${company.id}`;
      await setCash(company.id, 10);
      const body = (await lenientApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
      // £10 against the £25 a day: £15 short, on an emergency loan, and cash back at £0.
      expect(body.company).toMatchObject({ day: 2, cash: 0, status: "active", rescue: null, loan: { emergency: true, amount: 15, term: 30 } });
      expect(body.company.shortfall).toMatchObject({ limitDays: 7, owed: 15 });
      expect(body.company.shortfall.room).toBe(body.company.shortfall.limit - 15);
      expect(body.log[0]!.entries.map((e) => e.text)).toContainEqual(expect.stringMatching(/^Cash went £15 below £0 with no bank loan, so the bank opened an emergency loan/));
    } finally {
      await lenientApp.close();
    }
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
    // £38,500 over the 120-day term, rounded up to the pound a day.
    expect(terms).toEqual({
      amount: 35_000,
      rate: 0.1,
      dailyRepayment: 321,
      days: 120,
      total: 38_520,
      interest: 3_520,
      lastDay: 121,
    });
    const { company, next } = await setup({ takeLoan: true });
    expect(company.cash).toBe(1_000 + 35_000);
    expect(company.loan).toMatchObject({ amount: 35_000, day: 1, rate: 0.1, total: terms.total, repaid: 0 });
    expect(company.loan).toMatchObject({ dailyRepayment: terms.dailyRepayment, remaining: terms.total, daysLeft: 120 });
    expect(company.loanQuote).toBeNull();
    const { company: after, log } = await next();
    expect(after.spend.debt).toBe(terms.dailyRepayment);
    expect(after.loan).toMatchObject({ repaid: terms.dailyRepayment, daysLeft: 119 });
    // £3,520 of the £38,520 is interest, so £29 of the first £321.
    expect(after.interestPaid).toBe(29);
    expect(log[0]!.entries).toContainEqual(
      expect.objectContaining({ category: "debt", cashDelta: -terms.dailyRepayment }),
    );
    expect(log[0]!.entries).toContainEqual(expect.objectContaining({ kind: "loan" }));
  });

  it("starts without a loan by default, offering the start terms, which get worse and shorter later", async () => {
    const terms = await startLoan();
    const { company, next } = await setup();
    expect(company).toMatchObject({ cash: 1_000, loan: null, loanQuote: terms });
    let later = company;
    for (let i = 0; i < 10; i++) later = (await next()).company;
    expect(later.day).toBe(11);
    expect(later.loanQuote!.rate).toBeGreaterThan(terms.rate);
    expect(later.loanQuote!.dailyRepayment).toBeGreaterThan(terms.dailyRepayment);
    expect(later.loanQuote!.total).toBeGreaterThan(terms.total);
    // Half a day off the 120-day term for each of the 10 days later.
    expect(later.loanQuote!.days).toBe(115);
  });

  it("takes a loan later as an action, on the quoted terms, and not a second while it's being repaid", async () => {
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
    expect(again.json()).toMatchObject({ error: "loan_open", message: expect.stringContaining("one at a time") });
  });

  it("rejects a second loan on a game that took one at the start", async () => {
    const { act } = await setup({ takeLoan: true });
    const res = await act({ type: "takeLoan" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "loan_open" });
  });

  it("pays a loan off early, saving the interest the quote showed, and then lends again", async () => {
    const { act, next } = await setup({ takeLoan: true });
    await next();
    const { company } = await next();
    // Two repayments of £321, £59 of them interest: £34,417 of the money borrowed is left.
    expect(company.loan).toMatchObject({ repaid: 642, interestPaid: 59, payoff: 34_417, interestSaved: 3_461 });
    const res = await act({ type: "repayLoan" });
    expect(res.statusCode).toBe(200);
    const paid = res.json<CompanyView>();
    expect(paid.cash).toBe(company.cash - 34_417);
    expect(paid.loan).toMatchObject({ paidOffDay: 3, remaining: 0, payoff: 0, repaidInFull: true });
    expect(paid.interestPaid).toBe(59);
    expect(paid.loanQuote).toMatchObject({ amount: 35_000, rate: 0.104, days: 119 });
    const { company: after } = await next();
    expect(after.spend.debt).toBe(642 + 34_417);
    const again = await act({ type: "takeLoan" });
    expect(again.statusCode).toBe(200);
    expect(again.json<CompanyView>().loan).toMatchObject({ day: 4, repaid: 0, repaidInFull: false });
  });

  it("refuses to pay off a loan that isn't being repaid", async () => {
    const { act } = await setup();
    const res = await act({ type: "repayLoan" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "no_loan" });
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
    const kit = defaultConfig.models.onprem.servers!.purchase!.price;
    expect(withLoan.json<CompanyView>().cash).toBe(1_000 + 35_000 - (2_500 + 500 + kit.app.large + kit.database.large + 150));
  });
});

describe("shares and funding", () => {
  async function setup(body: object = {}) {
    const code = await newCode();
    const created = await newCompany(code, { name: "Acme", productType: "ecommerce", model: "iaas", ...body });
    expect(created.statusCode).toBe(201);
    const company = created.json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    return { code, company, url, act };
  }

  it("starts with the shares picked, all the student's, and offers the range in meta", async () => {
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta.shares).toEqual({ min: 10_000, max: 100_000, default: 10_000 });
    const { company } = await setup({ shares: 40_000 });
    expect(company.capTable).toMatchObject({
      sharesInIssue: 40_000,
      rows: [{ id: "student", name: "You", shares: 40_000, share: 1 }],
    });
    expect(company.valuation.sharesInIssue).toBe(40_000);
    expect(company.valuation.sharePrice).toBe(company.valuation.valuation / 40_000);
    expect((await setup()).company.capTable.sharesInIssue).toBe(10_000);
  });

  it("refuses shares outside the range or not whole", async () => {
    const code = await newCode();
    for (const shares of [9_999, 100_001]) {
      const res = await newCompany(code, { name: "Acme", productType: "ecommerce", model: "iaas", shares });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "bad_shares", message: expect.stringContaining("10,000 to 100,000") });
    }
    const half = await newCompany(code, { name: "Acme", productType: "ecommerce", model: "iaas", shares: 12_000.5 });
    expect(half.statusCode).toBe(400);
  });

  it("shows the valuation with its drivers adding up to it", async () => {
    const { company } = await setup();
    const { valuation, drivers } = company.valuation;
    expect(valuation).toBeGreaterThanOrEqual(sim.config.valuation.minimum);
    expect(drivers.map((d) => d.id)).toEqual(expect.arrayContaining(["revenue", "growth", "satisfaction", "uptime", "payingUsers"]));
    expect(drivers.reduce((sum, d) => sum + d.amount, 0)).toBe(valuation);
  });

  it("accepts friends and family as previewed: new shares, the student diluted, cash at once, once", async () => {
    const { company, act } = await setup();
    const offer = company.funding.friendsAndFamilyOffer!;
    expect(offer).toMatchObject({ amount: sim.config.funding.friendsAndFamily.amount, sharesInIssue: 10_000, yourShareBefore: 1 });
    const res = await act({ type: "acceptFunding", funder: "friendsAndFamily" });
    expect(res.statusCode).toBe(200);
    const after = res.json<CompanyView>();
    expect(after.cash).toBe(company.cash + offer.amount);
    expect(after.capTable).toMatchObject({
      sharesInIssue: offer.sharesAfter,
      rows: [
        { id: "student", shares: 10_000, share: offer.yourShareAfter },
        { id: "friendsAndFamily", shares: offer.newShares, share: offer.theirShare },
      ],
    });
    expect(after.funding).toMatchObject({ friendsAndFamilyOffer: null, friendsAndFamily: { status: "accepted", shares: offer.newShares } });
    const again = await act({ type: "acceptFunding", funder: "friendsAndFamily" });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: "funding_answered" });
  });

  it("shows the grant's condition, and declining it is for good", async () => {
    const { company, act } = await setup();
    expect(company.funding.grantOffer).toMatchObject({
      amount: sim.config.funding.grant.amount,
      minUptime: sim.config.funding.grant.minUptime.iaas,
      condition: expect.stringContaining(`Keep uptime at ${sim.config.funding.grant.minUptime.iaas}% or more`),
      ifMissed: expect.stringContaining("withdrawn"),
    });
    const declined = (await act({ type: "declineFunding", funder: "grant" })).json<CompanyView>();
    expect(declined.cash).toBe(company.cash);
    expect(declined.funding).toMatchObject({ grantOffer: null, grant: { status: "declined" } });
    expect((await act({ type: "acceptFunding", funder: "grant" })).json()).toMatchObject({ error: "funding_answered" });
  });

  it("accepts the grant: cash and no shares, its condition running", async () => {
    const { company, act } = await setup();
    const after = (await act({ type: "acceptFunding", funder: "grant" })).json<CompanyView>();
    expect(after.cash).toBe(company.cash + sim.config.funding.grant.amount);
    expect(after.capTable.rows).toHaveLength(1);
    expect(after.funding.grant).toMatchObject({ status: "accepted", day: 1, hoursDown: 0, daysLeft: sim.config.funding.grant.days });
  });

  it("negotiates an offer: odds first, then counters, the offer that stands accepted", async () => {
    const { company, act, url } = await setup();
    const opening = company.funding.negotiations.friendsAndFamily!;
    expect(opening).toMatchObject({ countersLeft: 2, final: false, rounds: [] });
    const amount = opening.offers[0]!.amount! * 1.2;
    const odds = await app.inject({ method: "GET", url: `${url}/counter-odds?funder=friendsAndFamily&amount=${amount}` });
    expect(odds.statusCode).toBe(200);
    expect(odds.json<CounterOddsView>()).toMatchObject({ ask: expect.closeTo(0.2), penalty: 6, chances: { high: expect.closeTo(0.05) } });
    const greedy = await app.inject({ method: "GET", url: `${url}/counter-odds?funder=friendsAndFamily&amount=${amount * 2}` });
    expect(greedy.json()).toMatchObject({ error: "counter_too_far" });

    const first = (await act({ type: "counterFunding", funder: "friendsAndFamily", terms: { amount } })).json<CompanyView>();
    const talks = first.funding.negotiations.friendsAndFamily!;
    expect(talks.offers).toHaveLength(2);
    expect(talks.rounds[0]).toMatchObject({ ask: expect.closeTo(0.2), penalty: 6 });
    expect(first.funding.friendsAndFamilyOffer!.amount).toBe(talks.offers[1]!.amount);
    // The game's own randomness is untouched, so the cash and the day are as they were.
    expect(first.cash).toBe(company.cash);

    const share = talks.offers[1]!.share! * 0.9;
    const second = (await act({ type: "counterFunding", funder: "friendsAndFamily", terms: { share } })).json<CompanyView>();
    expect(second.funding.negotiations.friendsAndFamily).toMatchObject({ final: true, countersLeft: 0 });
    const third = await act({ type: "counterFunding", funder: "friendsAndFamily", terms: { share: share * 0.9 } });
    expect(third.statusCode).toBe(400);
    expect(third.json()).toMatchObject({ error: "final_offer" });

    const standing = second.funding.friendsAndFamilyOffer!;
    const accepted = (await act({ type: "acceptFunding", funder: "friendsAndFamily" })).json<CompanyView>();
    expect(accepted.cash).toBe(company.cash + standing.amount);
    expect(accepted.capTable.rows[1]).toMatchObject({ id: "friendsAndFamily", shares: standing.newShares });
    expect(accepted.funding.negotiations.friendsAndFamily).toBeNull();
  });

  it("negotiates the grant on its cash and days, and validates counters", async () => {
    const { act } = await setup();
    const res = await act({ type: "counterFunding", funder: "grant", terms: { days: 45 } });
    expect(res.statusCode).toBe(200);
    // A low roll makes the grant dig in, with a longer condition; any other roll shortens it.
    const { funding } = res.json<CompanyView>();
    const days = funding.grantOffer!.days;
    if (funding.negotiations.grant!.rounds[0]!.result === "low") expect(days).toBeGreaterThan(sim.config.funding.grant.days);
    else expect(days).toBeLessThan(sim.config.funding.grant.days);
    expect((await act({ type: "counterFunding", funder: "grant" })).statusCode).toBe(400);
    expect((await act({ type: "counterFunding", funder: "grant", terms: { price: 5 } })).statusCode).toBe(400);
    expect((await act({ type: "counterFunding", funder: "grant", terms: { days: 2.5 } })).statusCode).toBe(400);
    const wrong = await act({ type: "counterFunding", funder: "grant", terms: { share: 0.1 } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ error: "bad_counter" });
    const worse = await act({ type: "counterFunding", funder: "grant", terms: { days: 90 } });
    expect(worse.json()).toMatchObject({ error: "worse_counter" });
  });

  it("validates the funder", async () => {
    const { act } = await setup();
    expect((await act({ type: "acceptFunding" })).statusCode).toBe(400);
    expect((await act({ type: "acceptFunding", funder: "angel" })).statusCode).toBe(400);
  });
});

describe("the angel investor", () => {
  // A hidden target any launched company hits on its first day of income, so an angel approaches within days.
  const angelSim = createSim({
    ...defaultConfig,
    // Launch presses itself once there are servers: the sim tests Launch.
    launch: { ...defaultConfig.launch, auto: 1 },
    events: [],
    calendar: { ...defaultConfig.calendar, holidays: [] },
    investors: {
      ...defaultConfig.investors,
      approachDays: 1,
      angel: { ...defaultConfig.investors.angel, target: { dailyRevenue: 10, days: 1 } },
    },
  });
  let angelApp: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    angelApp = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim: angelSim });
  });

  afterAll(async () => {
    await angelApp?.close();
  });

  /** A SaaS company played on until an angel approaches, with the pauses on the way. */
  async function approached() {
    const code = await newCode();
    const created = await angelApp.inject({
      method: "POST",
      url: `/api/codes/${code}/companies`,
      payload: { name: "Acme", productType: "social", model: "saas" },
    });
    const url = `/api/codes/${code}/companies/${created.json<CompanyView>().id}`;
    const act = (payload: object) => angelApp.inject({ method: "POST", url: `${url}/actions`, payload });
    expect(created.json<CompanyView>().investors).toMatchObject({ offer: null, angel: null, valuation: null });
    let result: ContinueResult | undefined;
    for (let i = 0; i < 10 && !result?.company.investors.offer; i++) {
      result = (await angelApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    }
    return { url, act, result: result! };
  }

  it("approaches with an offer showing its target and what missing it costs, pausing time", async () => {
    const { result } = await approached();
    const offer = result.company.investors.offer!;
    expect(offer).toMatchObject({
      round: "angel",
      day: result.company.day,
      condition: expect.stringMatching(/^By day \d+ \(\d+ days after you accept\), both at once: grow income to £[\d,]+ a day, averaged over 1 day, and gain [\d,]+ users net from the day you accept/),
      target: { netUsers: expect.any(Number) },
      ifMissed: expect.stringContaining("takes extra equity"),
    });
    expect(result.pauses).toContainEqual(expect.objectContaining({ kind: "offer", id: "offer-angel" }));
    expect(result.log.at(-1)!.entries).toContainEqual(expect.objectContaining({ kind: "funding", text: expect.stringContaining("angel investor") }));
    expect(result.company.investors.negotiation).toMatchObject({ countersLeft: 2, final: false });
  });

  it("negotiates and accepts the angel: their cash, their valuation, and friends and family closed", async () => {
    const { url, act, result } = await approached();
    const offer = result.company.investors.offer!;
    const share = Math.round(offer.theirShare * 900) / 1000;
    const odds = await angelApp.inject({ method: "GET", url: `${url}/investor-odds?share=${share}` });
    expect(odds.statusCode).toBe(200);
    expect(odds.json<CounterOddsView>()).toMatchObject({ counter: { amount: offer.amount, share } });
    const greedy = await angelApp.inject({ method: "GET", url: `${url}/investor-odds?share=${offer.theirShare / 4}` });
    expect(greedy.json()).toMatchObject({ error: "counter_too_far" });
    expect((await angelApp.inject({ method: "GET", url: `${url}/investor-odds?days=5` })).statusCode).toBe(400);

    const countered = (await act({ type: "counterInvestor", terms: { share } })).json<CompanyView>();
    expect(countered.investors.negotiation).toMatchObject({ countersLeft: 1 });
    expect((await act({ type: "counterInvestor" })).statusCode).toBe(400);
    expect((await act({ type: "counterInvestor", terms: { days: 5 } })).statusCode).toBe(400);

    const standing = countered.investors.offer!;
    const accepted = (await act({ type: "acceptInvestor" })).json<CompanyView>();
    expect(accepted.cash).toBe(countered.cash + standing.amount);
    expect(accepted.capTable.rows[1]).toMatchObject({ id: "angel", name: `${standing.investor} (angel)`, shares: standing.newShares });
    // Their figure, but never below the minimum: this company is barely a day old.
    const figure = Math.max(angelSim.config.valuation.minimum, standing.valuation);
    expect(Math.abs(accepted.valuation.valuation - figure)).toBeLessThanOrEqual(2);
    expect(accepted.valuation.drivers.map((d) => d.id)).toContain("investor");
    expect(accepted.investors).toMatchObject({ offer: null, angel: { investor: standing.investor, status: "running" } });
    expect(accepted.funding).toMatchObject({ friendsAndFamilyOffer: null, grantOffer: null, closedDay: accepted.day });
    expect((await act({ type: "acceptFunding", funder: "friendsAndFamily" })).json()).toMatchObject({ error: "funding_closed" });
    expect((await act({ type: "acceptInvestor" })).json()).toMatchObject({ error: "no_approach" });
  });

  it("auto-negotiates the angel to their final offer, and leaves accepting to the student", async () => {
    const { act, result } = await approached();
    const offer = result.company.investors.offer!;
    expect((await act({ type: "autoNegotiateInvestor" })).statusCode).toBe(400);
    expect((await act({ type: "autoNegotiateInvestor", terms: { days: 5 } })).statusCode).toBe(400);
    const share = Math.round(offer.theirShare * 900) / 1000;
    const played = (await act({ type: "autoNegotiateInvestor", terms: { share } })).json<CompanyView>();
    expect(played.investors.negotiation).toMatchObject({ final: true, countersLeft: 0 });
    expect(played.investors.negotiation!.rounds).toHaveLength(2);
    expect(played.investors.negotiation!.rounds.every((r) => r.auto)).toBe(true);
    expect(played.investors).toMatchObject({ angel: null });
    expect(played.cash).toBe(result.company.cash);
    expect((await act({ type: "autoNegotiateInvestor", terms: { share: share / 2 } })).json()).toMatchObject({ error: "final_offer" });
    // Friends and family and the grant auto-negotiate the same way, named as countering them is.
    expect((await act({ type: "autoNegotiateFunding", terms: { amount: 1 } })).statusCode).toBe(400);
  });

  it("lets an unanswered offer lapse after its days, as a decline, pausing time", async () => {
    const { url, result } = await approached();
    const offer = result.company.investors.offer!;
    expect(offer).toMatchObject({ daysLeft: angelSim.config.investors.offerDays, lastDay: result.company.day + angelSim.config.investors.offerDays - 1 });
    let last: ContinueResult = result;
    while (last.company.investors.offer) last = (await angelApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    expect(last.company.day).toBe(offer.lastDay + 1);
    expect(last.company.investors).toMatchObject({ anotherComing: true, declined: [{ investor: offer.investor, lapsed: true }] });
    expect(last.pauses).toContainEqual(expect.objectContaining({ kind: "alert", id: "lapsed-angel" }));
  });

  it("declines the angel, and another approaches a few days later", async () => {
    const { url, act, result } = await approached();
    const first = result.company.investors.offer!;
    const declined = (await act({ type: "declineInvestor" })).json<CompanyView>();
    expect(declined.investors).toMatchObject({ offer: null, anotherComing: true, declined: [{ investor: first.investor }] });
    expect(declined.funding.friendsAndFamilyOffer).not.toBeNull();
    let next: CompanyView = declined;
    for (let i = 0; i < 10 && !next.investors.offer; i++) {
      next = (await angelApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>().company;
    }
    expect(next.day).toBe(declined.day + angelSim.config.investors.retryDays);
    expect(next.investors.offer!.investor).not.toBe(first.investor);
  });
});

describe("venture capital rounds", () => {
  // An angel within days of the launch, and each round soon after the one before.
  const vc = defaultConfig.investors.vc;
  const vcSim = createSim({
    ...defaultConfig,
    // Launch presses itself once there are servers: the sim tests Launch.
    launch: { ...defaultConfig.launch, auto: 1 },
    events: [],
    calendar: { ...defaultConfig.calendar, holidays: [] },
    investors: {
      ...defaultConfig.investors,
      approachDays: 1,
      angel: { ...defaultConfig.investors.angel, target: { dailyRevenue: 10, days: 1 } },
      vc: {
        ...vc,
        gapDays: 2,
        targetDays: 1,
        rounds: {
          seriesA: { ...vc.rounds.seriesA, target: { payingUsers: 0.001, dailyRevenue: 0, minUptime: 0 } },
          seriesB: { ...vc.rounds.seriesB, target: { payingUsers: 0.001, dailyRevenue: 0, minUptime: 0 } },
          seriesC: { ...vc.rounds.seriesC, target: { payingUsers: 0.001, dailyRevenue: 0, minUptime: 0 } },
          seriesD: { ...vc.rounds.seriesD, target: { payingUsers: 0.001, dailyRevenue: 0, minUptime: 0 } },
        },
      },
    },
  });
  let vcApp: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    vcApp = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim: vcSim });
  });

  afterAll(async () => {
    await vcApp?.close();
  });

  /** A SaaS company played on, declining every angel, until Series A's VCs approach. */
  async function seriesA() {
    const code = await newCode();
    const created = await vcApp.inject({
      method: "POST",
      url: `/api/codes/${code}/companies`,
      payload: { name: "Acme", productType: "social", model: "saas" },
    });
    const url = `/api/codes/${code}/companies/${created.json<CompanyView>().id}`;
    const act = (payload: object) => vcApp.inject({ method: "POST", url: `${url}/actions`, payload });
    expect(created.json<CompanyView>().investors.vc).toMatchObject({ approach: null, negotiation: null, lead: null });
    let result: ContinueResult | undefined;
    for (let i = 0; i < 40 && !result?.company.investors.vc.approach; i++) {
      if (result?.company.investors.offer) await act({ type: "declineInvestor" });
      result = (await vcApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    }
    return { url, act, result: result! };
  }

  it("brings three VCs for Series A, pausing time, and shows each round", async () => {
    const { result } = await seriesA();
    const v = result.company.investors.vc;
    expect(v.approach).toMatchObject({ round: "seriesA", name: "Series A", day: result.company.day, picked: null });
    expect(v.approach!.offers).toHaveLength(3);
    for (const o of v.approach!.offers) expect(o).toMatchObject({ status: "open", lead: false, leanLabel: expect.stringMatching(/^(Most cash|Fewest conditions|Least ownership)$/) });
    // A 180-day game: two rounds, each merging two, its cash in two tranches.
    expect(v.rounds.map((r) => [r.name, r.firstApproachDay])).toEqual([["Series A", result.company.day], ["Series B", null]]);
    for (const o of v.approach!.offers) expect(o.secondTranche).toBeGreaterThan(0);
    expect(result.pauses).toContainEqual(expect.objectContaining({ kind: "offer", id: "offer-seriesA" }));
    // Series A approaching opens the last C-suite roles, which the IPO needs.
    expect(result.company.csuite.roles.every((r) => r.open)).toBe(true);
  });

  it("picks one VC, negotiates with them alone, and accepts: their cash, their valuation, and a VC on the cap table", async () => {
    const { url, act, result } = await seriesA();
    const offer = result.company.investors.vc.approach!.offers[1]!;
    expect((await act({ type: "pickInvestor" })).statusCode).toBe(400);
    expect((await act({ type: "pickInvestor", investor: "Nobody Capital" })).json()).toMatchObject({ error: "unknown_investor" });
    expect((await act({ type: "acceptInvestor" })).json()).toMatchObject({ error: "pick_first" });
    const picked = (await act({ type: "pickInvestor", investor: offer.investor })).json<CompanyView>();
    expect(picked.investors.vc.approach!.offers.map((o) => o.status)).toEqual(["closed", "picked", "closed"]);
    expect(picked.investors.vc.negotiation).toMatchObject({ countersLeft: 2, final: false });

    const share = Math.round(offer.theirShare * 900) / 1000;
    const odds = await vcApp.inject({ method: "GET", url: `${url}/investor-odds?share=${share}` });
    expect(odds.statusCode).toBe(200);
    expect(odds.json<CounterOddsView>()).toMatchObject({ counter: { amount: offer.amount, share } });
    const countered = (await act({ type: "counterInvestor", terms: { share } })).json<CompanyView>();
    expect(countered.investors.vc.negotiation).toMatchObject({ countersLeft: 1 });

    const standing = countered.investors.vc.approach!.offers[1]!;
    const accepted = (await act({ type: "acceptInvestor" })).json<CompanyView>();
    // The first tranche now; the second once the company hits their growth target.
    expect(accepted.cash).toBe(countered.cash + standing.amount - standing.secondTranche!);
    expect(accepted.capTable.rows.find((r) => r.id === "vc")).toMatchObject({ name: `${standing.investor} (VC)`, shares: standing.newShares });
    // Their figure, less the cash still to come: net cash counts at face value.
    expect(Math.abs(accepted.valuation.valuation - (standing.valuation - standing.secondTranche!))).toBeLessThanOrEqual(2);
    expect(accepted.investors.valuation).toMatchObject({ investor: standing.investor, round: "seriesA" });
    expect(accepted.investors.vc).toMatchObject({ approach: null, lead: { investor: standing.investor } });
    expect(accepted.investors.vc.rounds[0]!.deal).toMatchObject({
      investor: standing.investor,
      amount: standing.amount,
      tranche: { amount: standing.secondTranche, target: "seriesB", paidDay: null },
    });
  });

  it("declines all three, and three new VCs approach a few days later for the same round", async () => {
    const { url, act, result } = await seriesA();
    const first = result.company.investors.vc.approach!;
    const declined = (await act({ type: "declineInvestor" })).json<CompanyView>();
    expect(declined.investors.vc).toMatchObject({ approach: null, declined: [{ round: "seriesA", investors: first.offers.map((o) => o.investor) }] });
    let next: CompanyView = declined;
    for (let i = 0; i < 10 && !next.investors.vc.approach; i++) {
      next = (await vcApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>().company;
    }
    // Series B's target is low, so after the gap its VCs come ahead of a retry for Series A; either way, three new ones.
    expect(next.investors.vc.approach!.offers.map((o) => o.investor)).not.toContain(first.offers[0]!.investor);
    expect(next.investors.vc.rounds[0]!.firstApproachDay).toBe(first.day);
  });
});

describe("the IPO", () => {
  // Thresholds anyone can meet after a couple of days, every user paying, and never a cold market.
  const EASY_IPO = {
    "productTypes.ecommerce.pricing.freeShare": 0,
    "ipo.products.ecommerce.users": 0,
    "ipo.products.ecommerce.annualRevenue": 0,
    "ipo.products.ecommerce.payingUsers": 0,
    "ipo.minTradingDays": 0,
    "ipo.recordDays": 2,
    "ipo.minUptime": 0,
    "ipo.minSatisfaction": 0,
    "ipo.maxCostSwing": 5,
    "ipo.coldChance.min": 0,
    "ipo.coldChance.max": 0,
  };

  async function setup(overrides: object = EASY_IPO, body: object = {}) {
    await useOverrides(overrides);
    const code = await newCode();
    const created = await newCompany(code, { name: "Acme", productType: "ecommerce", model: "saas", ...body });
    expect(created.statusCode).toBe(201);
    // The IPO opens in Scale.
    await reachPhase(testDb.db, created.json<CompanyView>().id, "scale");
    const url = `/api/codes/${code}/companies/${created.json<CompanyView>().id}`;
    const company = (await app.inject({ method: "GET", url })).json<CompanyView>();
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    const next = () => app.inject({ method: "POST", url: `${url}/continue` });
    return { code, company, url, act, next };
  }

  it("shows the readiness checklist, and refuses to apply until every condition is met", async () => {
    const { company, act } = await setup({});
    expect(company.ipo.conditions.map((c) => c.id)).toEqual(["trading", "usersAndRevenue", "uptime", "costs", "security", "csuite"]);
    expect(company.ipo.conditions.find((c) => c.id === "csuite")).toMatchObject({
      label: "The full C-suite",
      met: false,
      now: expect.stringMatching(/^0 of 11 hired; still to hire: Head of development, /),
    });
    expect(company.ipo).toMatchObject({ status: "not-ready", ready: false, canApply: false, offer: null, result: null });
    const res = await act({ type: "applyForIpo" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "ipo_not_ready", message: expect.stringContaining("Not ready to float yet") });
  });

  it("applies once ready, holds the game, then floats and rings the bell, ending it", async () => {
    const { company, url, act, next } = await setup();
    await next();
    const waiting = (await next()).json<ContinueResult>().company;
    // Everything else is met, but the C-suite is empty.
    expect(waiting.ipo.conditions.filter((c) => !c.met).map((c) => c.id)).toEqual(["csuite"]);
    expect((await act({ type: "applyForIpo" })).json()).toMatchObject({ error: "ipo_not_ready" });
    // As if the angel and Series A had approached on day 1 and been declined, so no later round is needed. Every role is
    // open in Scale.
    await testDb.db
      .update(companies)
      .set({
        state: sql`jsonb_set(jsonb_set(${companies.state}, '{investors,vc,firstApproachDay,seriesA}', '1'), '{investors,firstApproachDay}', '1')`,
      })
      .where(eq(companies.id, company.id));
    const approachedView = (await app.inject({ method: "GET", url })).json<CompanyView>();
    expect(approachedView.csuite.roles.every((r) => r.open)).toBe(true);
    // Every role but one, each the first on their shortlist: still not ready, 10 of 11.
    const rest = approachedView.csuite.roles.map((r) => r.role);
    const last = rest.pop()!;
    for (const role of rest) {
      const candidate = approachedView.csuite.roles.find((r) => r.role === role)!.shortlist[0]!;
      expect((await act({ type: "hireExecutive", role, candidate: candidate.id })).statusCode).toBe(200);
    }
    const nearly = (await app.inject({ method: "GET", url })).json<CompanyView>();
    expect(nearly.ipo.conditions.find((c) => c.id === "csuite")).toMatchObject({ met: false, now: expect.stringMatching(/^10 of 11 hired/) });
    expect((await act({ type: "applyForIpo" })).json()).toMatchObject({ error: "ipo_not_ready" });
    const lastCandidate = approachedView.csuite.roles.find((r) => r.role === last)!.shortlist[0]!;
    expect((await act({ type: "hireExecutive", role: last, candidate: lastCandidate.id })).statusCode).toBe(200);
    const ready = (await app.inject({ method: "GET", url })).json<CompanyView>();
    expect(ready.ipo).toMatchObject({ status: "ready", canApply: true });
    const approved = (await act({ type: "applyForIpo" })).json<CompanyView>();
    expect(approved.ipo).toMatchObject({ status: "approved", approvedDay: 3, offer: { minFloat: 0.15, maxFloat: 0.4 } });
    const held = await next();
    expect(held.statusCode).toBe(409);
    expect(held.json()).toMatchObject({ error: "ring_the_bell" });

    for (const payload of [{ type: "ringBell" }, { type: "ringBell", float: 2 }]) expect((await act(payload)).statusCode).toBe(400);
    expect((await act({ type: "ringBell", float: 0.5 })).json()).toMatchObject({ error: "bad_float" });

    const preview = approved.ipo.offer!.floats.find((f) => f.float === 0.2)!;
    const rung = await act({ type: "ringBell", float: 0.2 });
    expect(rung.statusCode).toBe(200);
    const floated = rung.json<CompanyView>();
    const result = floated.ipo.result!;
    expect(floated).toMatchObject({ status: "finished", cash: approved.cash + preview.cashRaised });
    expect(floated.ipo.status).toBe("floated");
    expect(result).toMatchObject({ float: 0.2, newShares: preview.newShares, cashRaised: preview.cashRaised, day: 3 });
    expect(result.prices).toHaveLength(sim.config.ipo.ticks + 1);
    expect(result.marketValue).toBe(Math.round(result.closePrice * result.sharesAfter));
    const executives = ready.csuite.roles.flatMap((r) => (r.executive ? [["executive", r.executive.shares]] : []));
    expect(executives).toHaveLength(11);
    expect(floated.capTable.rows.map((r) => [r.id, r.shares])).toEqual([["student", 10_000], ...executives, ["public", preview.newShares]]);
    const summary = (await app.inject({ method: "GET", url: `${url}/summary` })).json<SummaryView>();
    expect(summary).toMatchObject({ ending: "ipo", ipo: result });
    const after = await next();
    expect(after.statusCode).toBe(409);
    expect(after.json()).toMatchObject({ error: "finished", message: expect.stringContaining("Acme floated on day 3") });
  });

  it("offers until IPO as a game length with no last day, when the preset allows it", async () => {
    const { company } = await setup({ "allowedGameLengths.until-ipo": 1 }, { gameLength: "until-ipo" });
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta.gameLengths).toEqual([
      { id: "180-days", name: "180 days", finalDay: 180 },
      { id: "until-ipo", name: "Until IPO", finalDay: null },
    ]);
    expect(company).toMatchObject({ gameLength: "until-ipo", gameLengthName: "Until IPO", finalDay: null });
    const games = (await app.inject({ method: "GET", url: "/api/teacher/games", cookies: await teacherCookie() })).json<TeacherGamesView>();
    expect(games.codes[0]!.companies[0]).toMatchObject({ finalDay: null });
  });
});

describe("the C-suite (#108)", () => {
  async function setup() {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    const next = async () => (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    return { company, url, act, next };
  }

  it("shows every role, opening them a phase at a time (#236), with shortlists of three", async () => {
    const { company, url } = await setup();
    expect(company.csuite).toMatchObject({ equityCap: 0.1, equityUsed: 0, equityLeft: 0.1, dailyPay: 0 });
    const roles = async () => (await app.inject({ method: "GET", url })).json<CompanyView>().csuite.roles;
    // None before Grow, which opens the CFO, CTO and head of people; Scale opens the rest.
    expect(company.csuite.roles.map((r) => [r.role, r.open])).toEqual([
      ["headOfDevelopment", false],
      ["headOfOps", false],
      ["headOfSupport", false],
      ["cfo", false],
      ["cto", false],
      ["headOfPeople", false],
      ["cmo", false],
      ["coo", false],
      ["cio", false],
      ["ciso", false],
      ["legalCounsel", false],
    ]);
    await reachPhase(testDb.db, company.id, "grow");
    expect((await roles()).filter((r) => r.open).map((r) => r.role)).toEqual(["cfo", "cto", "headOfPeople"]);
    await reachPhase(testDb.db, company.id, "scale");
    const scaled = await roles();
    expect(scaled.every((r) => r.open)).toBe(true);
    const dev = scaled[0]!;
    expect(dev.shortlist).toHaveLength(3);
    expect(dev.shortlist[0]).toMatchObject({ id: "headOfDevelopment-1", name: expect.any(String), salary: expect.any(Number), equity: expect.any(Number) });
    expect(dev.shortlist[0]!.effects[0]!.text).toMatch(/developer output/);
  });

  it("hires for good: pay from the next day, equity in new shares, and no second hire", async () => {
    const { company: created, url, act, next } = await setup();
    // The head of ops opens in Scale.
    await reachPhase(testDb.db, created.id, "scale");
    const company = (await app.inject({ method: "GET", url })).json<CompanyView>();
    const candidate = company.csuite.roles.find((r) => r.role === "headOfOps")!.shortlist[1]!;
    const hired = await act({ type: "hireExecutive", role: "headOfOps", candidate: candidate.id });
    expect(hired.statusCode).toBe(200);
    const view = hired.json<CompanyView>();
    const role = view.csuite.roles.find((r) => r.role === "headOfOps")!;
    expect(role).toMatchObject({ shortlist: [], executive: { name: candidate.name, salary: candidate.salary, day: 1, shares: candidate.newShares } });
    expect(view.capTable.rows.find((r) => r.id === "executive")).toMatchObject({ name: `${candidate.name} (Head of ops)`, shares: candidate.newShares });
    expect(view.csuite.dailyPay).toBe(candidate.salary);
    const { log } = await next();
    expect(log.flatMap((d) => d.entries)).toContainEqual(
      expect.objectContaining({ text: `Head of ops pay (${candidate.name})`, cashDelta: -candidate.salary, category: "staff" }),
    );
    const again = await act({ type: "hireExecutive", role: "headOfOps", candidate: "headOfOps-1" });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: "role_filled" });
  });

  it("refuses a role not open yet, an unknown candidate, a bad payload and letting an executive go", async () => {
    const { company, act } = await setup();
    expect((await act({ type: "hireExecutive", role: "cfo", candidate: "cfo-1" })).json()).toMatchObject({ error: "role_not_open" });
    // Grow opens the CFO, CTO and head of people, but the head of ops waits for Scale.
    await reachPhase(testDb.db, company.id, "grow");
    expect((await act({ type: "hireExecutive", role: "headOfOps", candidate: "headOfOps-1" })).json()).toMatchObject({ error: "role_not_open" });
    expect((await act({ type: "hireExecutive", role: "cto", candidate: "cfo-1" })).json()).toMatchObject({ error: "unknown_candidate" });
    for (const payload of [
      { type: "hireExecutive", role: "headOfOps" },
      { type: "hireExecutive", candidate: "headOfOps-1" },
      { type: "hireExecutive", role: "ceo", candidate: "ceo-1" },
      { type: "letGo", pool: "csuite" },
    ]) {
      expect((await act(payload)).statusCode).toBe(400);
    }
  });

  it("opens the CFO on outside money", async () => {
    const { act } = await setup();
    const funded = (await act({ type: "acceptFunding", funder: "grant" })).json<CompanyView>();
    expect(funded.csuite.roles.find((r) => r.role === "cfo")).toMatchObject({ open: true, openDay: 1 });
    expect(funded.csuite.roles.find((r) => r.role === "cfo")!.shortlist).toHaveLength(3);
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
      spend: { staff: 16, infrastructure: 100, addons: 0, campaigns: 0, debt: 0 },
      totalSpend: 116,
    });
    expect(summary.users).toBeGreaterThan(0);
    const logged = (category: string) =>
      logs.flatMap((d) => d.entries).filter((e) => e.category === category).reduce((sum, e) => sum - e.cashDelta, 0);
    expect(summary.spend).toEqual({
      staff: logged("staff"),
      infrastructure: logged("infrastructure"),
      cabling: 0,
      power: 0,
      addons: 0,
      campaigns: 0,
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

  it("summarises a liquidated game, with its rescue", async () => {
    const { id, url } = await setup();
    for (let i = 0; i < 2; i++) {
      await testDb.db.execute(sql`update companies set state = jsonb_set(state, '{cash}', '10'::jsonb) where id = ${id}`);
      await shortApp.inject({ method: "POST", url: `${url}/continue` });
    }
    const summary = (await shortApp.inject({ method: "GET", url: `${url}/summary` })).json<SummaryView>();
    expect(summary).toMatchObject({ ending: "liquidation", day: 3, cash: -15, rescue: { day: 2 } });
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
    // A £40 price keeps its payers: no rise wave or daily churn from a price above fair.
    await useOverrides({ "productTypes.ecommerce.pricing.freeShare": 0.5, "pricing.riseStrength": 0, "pricing.priceChurn": 0 });
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
    expect(res.json<TeacherSummaryView>()).toEqual({
      code,
      status: "active",
      preset: "Default",
      player: expect.stringMatching(/^Player \d+$/),
      summary: student,
    });
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
    for (const action of ["continue", "retire"]) {
      const res = await app.inject({ method: "POST", url: `/api/codes/${code}/companies/${company.id}/${action}` });
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
    // Features open in Grow.
    await reachPhase(testDb.db, company.id, "grow");
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    return { code, company, url, act };
  }
  // The cheapest feature, so builds finish in a few days.
  const [cheapest] = defaultConfig.productTypes.ecommerce.features.toSorted((a, b) => a.devDays - b.devDays);
  // Its developer-days to build: tier 1's are multiplied (#263).
  const cheapestDays = (cheapest!.tier ?? 1) === 1 ? cheapest!.devDays * defaultConfig.tiers.tier1BuildMultiplier : cheapest!.devDays;
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
    const daysNeeded = Math.ceil(cheapestDays / 3);
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
      progress: cheapestDays,
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

  it("sets the developer slider, builds up optimisation on continue and validates the share", async () => {
    const { url, act } = await setup();
    await act({ type: "hire", pool: "developers", count: 2 });
    const set = await act({ type: "setOptimisation", share: 1 });
    expect(set.statusCode).toBe(200);
    expect(set.json<CompanyView>().optimisation).toMatchObject({ share: 1, days: 0, saving: 0, cap: defaultConfig.optimisation.cap.iaas, output: 2 });
    const next = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    expect(next.company.optimisation.days).toBe(2);
    expect(next.company.optimisation.saving).toBeGreaterThan(0);
    for (const payload of [{ type: "setOptimisation" }, { type: "setOptimisation", share: 1.5 }, { type: "setOptimisation", share: -1 }]) {
      expect((await act(payload)).statusCode).toBe(400);
    }
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
  // Tier 1's, open from the start.
  const addon = defaultConfig.productTypes.ecommerce.features.find((f) => (f.tier ?? 1) === 1);

  async function setup(model = "saas", developers = minConfigDevelopers) {
    const code = await newCode();
    const company = (await newCompany(code, { name: "Acme", productType: "ecommerce", model })).json<CompanyView>();
    // Add-ons open in Grow, with features.
    await reachPhase(testDb.db, company.id, "grow");
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
    // The price is charged to the penny.
    expect(bought.monthlyAddonCost).toBe(Math.round(bought.users * (Math.round(addon!.addonPricePerUser * 100) / 100)));
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
      racks: [],
      cabling: 0,
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
      lostBenefits: [],
      // £1,000 less the total, which leaves under a month of running costs.
      cashLeft: 1000 - 790,
      warning: expect.stringMatching(/^This would leave you £210, about \d+ days of running costs before any income\./),
    });
    expect((await app.inject({ method: "GET", url })).json<CompanyView>()).toMatchObject({ cash: 1000, migration: null });
  });

  it("itemises a bought setup: what each item costs up front and a month, and the delivery time", async () => {
    const { quote } = await setup();
    const onprem = (await quote("onprem")).json<MigrationQuoteView>();
    const { price } = defaultConfig.models.onprem.servers!.purchase!;
    const upkeep = defaultConfig.models.onprem.servers!.monthlyCost;
    expect(onprem.setup).toEqual([
      { type: "app", size: "small", name: "App server", count: 1, units: 10, upfront: price.app.small, monthly: upkeep.app!.small!, daysLeft: 4 },
      { type: "database", size: "small", name: "Database", count: 1, units: 10, upfront: price.database.small, monthly: upkeep.database!.small!, daysLeft: 4 },
    ]);
    expect(onprem).toMatchObject({ setupUpfront: price.app.small + price.database.small, deliveryDays: 4 });
    // With the server room's medium rack, and cabling for it and the 2 servers.
    expect(onprem).toMatchObject({ racks: [{ size: "medium", count: 1, upfront: 500 }], cabling: 150 });
    expect(onprem.upfrontCost).toBe(defaultConfig.models.onprem.upfrontCost + onprem.setupUpfront + 500 + 150);
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
    // Add-ons open in Grow.
    await reachPhase(testDb.db, company.id, "grow");
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    for (let i = 0; i < minConfigDevelopers; i++) await act({ type: "hire", pool: "developers" });
    // Every tier open and both unlocked with research points, so both can be bought.
    const open = JSON.stringify([2, 3, 4].map((tier) => ({ tier, day: 1 })));
    const unlocks = JSON.stringify([checkout!.id, reviews!.id]);
    await testDb.db.execute(
      sql`update companies set state = jsonb_set(jsonb_set(state, '{tiers}', ${open}::jsonb), '{unlocks}', ${unlocks}::jsonb) where id = ${company.id}`,
    );
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

describe("the real calendar", () => {
  const calendarSim = createSim({ ...sim.config, calendar: defaultConfig.calendar });
  let calendarApp: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    calendarApp = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim: calendarSim });
  });

  afterAll(async () => {
    await calendarApp?.close();
  });

  it("starts the company on a random date this year, and counts the calendar forward a day at a time", async () => {
    const code = await newCode();
    const payload = { name: "Acme", productType: "ecommerce", model: "iaas" };
    const created = await calendarApp.inject({ method: "POST", url: `/api/codes/${code}/companies`, payload });
    const company = created.json<CompanyView>();
    const year = new Date().getUTCFullYear();
    expect(company.calendar).toMatchObject({ startYear: year, today: { year } });
    expect(company.calendar.today.iso.startsWith(`${year}-`)).toBe(true);
    // The next holidays are shown ahead of time, soonest first, each with what it does to a shop (or null).
    const { upcoming } = company.calendar;
    expect(upcoming.length).toBeGreaterThan(0);
    expect(upcoming.map((h) => h.startDay)).toEqual([...upcoming.map((h) => h.startDay)].sort((x, y) => x - y));
    for (const h of upcoming) {
      expect(h.effect === null || h.effect.loadMultiplier > 0).toBe(true);
      expect(h.daysUntil).toBe(h.startDay - 1);
    }
    const url = `/api/codes/${code}/companies/${company.id}/continue`;
    const next = (await calendarApp.inject({ method: "POST", url })).json<ContinueResult>();
    const tomorrow = new Date(Date.parse(company.calendar.today.iso) + 864e5).toISOString().slice(0, 10);
    expect(next.company.calendar.today.iso).toBe(tomorrow);
  });
});

describe("encounters", () => {
  // Only the OS patch, certain to come up, at a threshold of 2: it fires when the meter reaches 2.
  const encounterSim = createSim({
    ...sim.config,
    encounters: { ...sim.config.encounters, thresholdMin: 2, thresholdMax: 2 },
    events: [{ ...defaultConfig.events.find((e) => e.id === "osPatch")!, encounter: { chance: 1 } }],
  });
  let encounterApp: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    encounterApp = await buildApp({
      db: testDb.db,
      teacherPassword: PASSWORD,
      sessionSecret: "x".repeat(32),
      sim: encounterSim,
    });
  });

  afterAll(async () => {
    await encounterApp?.close();
  });

  it("shows the danger meter rising, then the event it fires, then the meter back from 0", async () => {
    const code = await newCode();
    // SaaS launches as the game starts, so the meter rises from day 2. SaaS has no traffic-spike warning.
    const created = await encounterApp.inject({
      method: "POST",
      url: `/api/codes/${code}/companies`,
      payload: { name: "Acme", productType: "social", model: "saas" },
    });
    const url = `/api/codes/${code}/companies/${created.json<CompanyView>().id}`;
    expect(created.json<CompanyView>().danger).toEqual({ meter: 0, max: 2, rise: 0, dailyRise: 1, risks: [], warning: null });
    const next = async () => (await encounterApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();

    expect((await next()).company).toMatchObject({ day: 2, events: [], danger: { meter: 1, rise: 1, risks: [] } });
    expect((await next()).company).toMatchObject({ day: 3, events: [], danger: { meter: 2 } });
    const { company } = await next();
    expect(company.day).toBe(4);
    expect(company.events).toEqual([expect.objectContaining({ id: "osPatch", owner: "provider", hit: false })]);
    expect(company.danger).toMatchObject({ meter: 1, rise: 1 });
    // Saved with the day: a reload shows the same.
    expect((await encounterApp.inject({ method: "GET", url })).json<CompanyView>().danger).toEqual(company.danger);
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
  const SPEEDS_AT_10 = [
    { id: "slow", name: "Slow", seconds: 20 },
    { id: "normal", name: "Normal", seconds: 10 },
    { id: "fast", name: "Fast", seconds: 3.33 },
    { id: "fastest", name: "Fastest", seconds: 1 },
  ];

  it("reports timed flow as on by default, with the default interval and its speeds", async () => {
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
    expect(meta.timedFlow).toEqual({ enabled: true, seconds: 10, speeds: SPEEDS_AT_10 });
  });

  it("lets the teacher switch timed flow off, reaching games already being played", async () => {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const gameMeta = async () =>
      (await app.inject({ method: "GET", url: `/api/codes/${code}/companies/${company.id}/meta` })).json<MetaView>().timedFlow;
    expect((await gameMeta()).enabled).toBe(true);
    await useOverrides({ timedFlow: 0 });
    expect((await gameMeta()).enabled).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/meta" })).json<MetaView>().timedFlow.enabled).toBe(false);
  });

  it("reports timed flow off when the server switches it off, whatever the preset says", async () => {
    const timed = await buildApp({
      db: testDb.db,
      teacherPassword: PASSWORD,
      sessionSecret: "x".repeat(32),
      sim,
      timedFlow: { enabled: false, seconds: 3 },
    });
    try {
      const meta = (await timed.inject({ method: "GET", url: "/api/meta" })).json<MetaView>();
      expect(meta.timedFlow).toMatchObject({ enabled: false, seconds: 3 });
      expect(meta.timedFlow.speeds.map((s) => s.seconds)).toEqual([6, 3, 1, 0.3]);
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
      ["moderators", 2],
      ["researchers", 5],
      ["marketers", 6],
    ]);
    // On-prem's and IaaS's from their starter servers; PaaS's and SaaS's a small fixed number.
    expect(meta.models.map((m) => m.opsNeeded)).toEqual([1.2, 1, 1, 1]);
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
    expect(meta.productTypes.map((p: { id: string }) => p.id)).toEqual(["ecommerce", "social", "video", "payments", "assistant", "games"]);
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
    launch: { ...sim.config.launch, rampShares: [0.2, 0.3, 0.5] },
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
        rampDays: 3,
        rampDay: 0,
        arrived: 0,
        needsServers: true,
        setUp: false,
        opsNeeded: 0,
        missing: ["No app server: no users can be served", "No database: no users can be served"],
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

  it("waits, ready to launch, until Launch is pressed, warning of what's missing but going ahead", async () => {
    // Launch doesn't press itself, and IaaS has no starter setup: nothing to serve users with.
    const button = createSim({ ...ramped.config, launch: { ...ramped.config.launch, auto: 0 } });
    const buttonApp = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim: button });
    try {
      const code = await newCode();
      const payload = { name: "Acme", productType: "ecommerce", model: "iaas" };
      const company = (await buttonApp.inject({ method: "POST", url: `/api/codes/${code}/companies`, payload })).json<CompanyView>();
      const url = `/api/codes/${code}/companies/${company.id}`;
      expect(company).toMatchObject({ users: 0, launch: { status: "ready", day: null } });
      expect(company.launch.missing).toEqual(["No app server: no users can be served", "No database: no users can be served"]);
      const waited = (await buttonApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
      expect(waited.company).toMatchObject({ day: 2, users: 0, launch: { status: "ready" } });
      const launched = await buttonApp.inject({ method: "POST", url: `${url}/actions`, payload: { type: "launch" } });
      expect(launched.statusCode).toBe(200);
      expect(launched.json<CompanyView>().launch).toMatchObject({ status: "launching", day: 3, rampDay: 0, missing: [] });
      const live = (await buttonApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
      expect(live.company).toMatchObject({ day: 3, launch: { status: "launching", day: 3, rampDay: 1 } });
      expect(live.company.users).toBeGreaterThan(0);
      const again = await buttonApp.inject({ method: "POST", url: `${url}/actions`, payload: { type: "launch" } });
      expect(again.statusCode).toBe(400);
      expect(again.json()).toMatchObject({ error: "already_launched" });
    } finally {
      await buttonApp.close();
    }
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
    // A £30 price keeps its payers: no rise wave or daily churn from a price above fair.
    const { url, act, next } = await setup({ "productTypes.ecommerce.pricing.freeShare": 0.5, "pricing.riseStrength": 0, "pricing.priceChurn": 0 });
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

  it("shows the customer mix with each type's threshold, and a rise's reaction weighted by it", async () => {
    const { company, url } = await setup({
      "productTypes.ecommerce.pricing.freeShare": 0.5,
      "productTypes.ecommerce.pricing.customerMix.casual": 0.5,
      "productTypes.ecommerce.pricing.customerMix.enthusiasts": 0.5,
      "productTypes.ecommerce.pricing.customerMix.professionals": 0,
      "productTypes.ecommerce.pricing.customerMix.businesses": 0,
      "customerTypes.enthusiasts.thresholdMultiple": 2,
    });
    expect(company.customerMix).toMatchObject({ price: fairPrice, fairPrice });
    expect(company.customerMix.types.map(({ id, share, threshold, overThreshold }) => ({ id, share, threshold, overThreshold }))).toEqual([
      { id: "casual", share: 0.5, threshold: fairPrice, overThreshold: false },
      { id: "enthusiasts", share: 0.5, threshold: fairPrice * 2, overThreshold: false },
      { id: "professionals", share: 0, threshold: fairPrice * sim.config.customerTypes.professionals.thresholdMultiple, overThreshold: false },
      { id: "businesses", share: 0, threshold: fairPrice * sim.config.customerTypes.businesses.thresholdMultiple, overThreshold: false },
    ]);
    const body = (await app.inject({ method: "GET", url: `${url}/price-preview?price=${fairPrice * 1.5}` })).json<PricePreviewView>();
    const [casual, enthusiasts] = body.reactions;
    expect(casual!.reaction).toBeGreaterThan(enthusiasts!.reaction);
    expect(body.reaction).toBeCloseTo(0.5 * casual!.reaction + 0.5 * enthusiasts!.reaction, 12);
    expect(body.total.left + body.total.toFree).toBe(Math.round(company.paidUsers * body.reaction));
  });

  it("shows the market share, and rivals answering a price change after the delay", async () => {
    const { company, act, next } = await setup({ "rivals.undercutChance": 0 });
    const rivals = sim.config.productTypes.ecommerce.rivals;
    expect(company.market.companies.map((c) => c.name)).toEqual([company.name, ...rivals.map((r) => r.name)]);
    expect(company.market.companies.reduce((sum, c) => sum + c.share, 0)).toBeCloseTo(1, 10);
    expect(company.market.byType.map((t) => t.id)).toEqual(["casual", "enthusiasts", "professionals", "businesses"]);

    const raised = fairPrice + 1;
    const priced = (await act({ type: "setPrice", price: raised })).json<CompanyView>();
    const { day } = priced.market.nextReaction!;
    expect(day).toBe(company.day + 1 + sim.config.rivals.reactionDays);
    let body = await next();
    while (body.company.day < day - 1) body = await next();
    expect(body.company.market.companies[1]!.price).toBe(fairPrice * rivals[0]!.priceStance);
    body = await next();
    expect(body.company.market.companies.slice(1).map((c) => c.price)).toEqual(rivals.map((r) => Math.round(raised * r.priceStance * 100) / 100));
    expect(body.company.market.nextReaction).toBeNull();
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

  it("sets the payments app's fee and transaction fee as one change, with one lock, and shows both income streams", async () => {
    const overrides = { "productTypes.payments.pricing.freeShare": 0.5, "pricing.riseStrength": 0, "pricing.priceChurn": 0 };
    await useOverrides(overrides);
    const code = await newCode();
    const created = (await newCompany(code, { name: "Pay Co", productType: "payments", model: "saas" })).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${created.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    const { transactions: tx, pricing } = sim.config.productTypes.payments;
    expect(created).toMatchObject({ price: pricing.fairPrice, paidUsers: 500 });
    expect(created.payments).toMatchObject({ fee: pricing.fairPrice, rate: tx!.fairRate, monthly: 30, fairMonthly: 30 });
    expect(created.customerMix).toMatchObject({ price: 30, includesRate: true });

    // The preview takes both: +£5 a usual month by the rate alone.
    const preview = (await app.inject({ method: "GET", url: `${url}/price-preview?price=10&rate=0.025` })).json<PricePreviewView>();
    expect(preview).toMatchObject({ price: 10, rate: 0.025, currentRate: 0.02, monthly: 35, currentMonthly: 30, direction: "rise" });
    // A £0 fee is fine with a rate here, but no rate is refused on another product.
    expect((await app.inject({ method: "GET", url: `${url}/price-preview?price=0&rate=0.03` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `${url}/price-preview?price=10&rate=-1` })).statusCode).toBe(400);

    const set = await act({ type: "setPrice", price: 12, rate: 0.025 });
    expect(set.statusCode).toBe(200);
    const company = set.json<CompanyView>();
    expect(company).toMatchObject({ price: 12, priceLockDaysLeft: sim.config.pricing.lockDays });
    expect(company.payments).toMatchObject({ fee: 12, rate: 0.025, monthly: 37 });
    expect(company.priceWave).toMatchObject({ from: 10, to: 12, fromRate: 0.02, toRate: 0.025 });
    // One lock for both.
    expect((await act({ type: "setPrice", price: 12, rate: 0.03 })).json()).toMatchObject({ error: "price_locked" });

    const { company: after, log } = (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    const incomes = log[0]!.entries.filter((e) => e.kind === "income");
    expect(incomes.map((e) => e.stream)).toEqual(["fees", "transactions"]);
    expect(incomes[0]).toMatchObject({ text: "Income: 500 paying users at £12 a month fee", cashDelta: 200 });
    expect(incomes[1]!.text).toMatch(/^Transaction fees: 2\.5% of £[\d,]+ of payments/);
    expect(after.payments).toMatchObject({ feeIncome: 200, transactionIncome: incomes[1]!.cashDelta });
    const summary = (await app.inject({ method: "GET", url: `${url}/summary` })).json<SummaryView>();
    expect(summary.income).toBe(200 + incomes[1]!.cashDelta);

    // Other products take no rate.
    const shop = await setup();
    expect(shop.company.payments).toBeNull();
    expect((await shop.act({ type: "setPrice", price: 10, rate: 0.02 })).json()).toMatchObject({ error: "no_transaction_rate" });
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
    expect(line.text).toMatch(/^\d[\d,]* of \d[\d,]* free users started paying/);
    expect(after.conversion.today).toBeGreaterThan(0);
    expect(line.text).toContain(`${after.conversion.today} of`);
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

describe("paid APIs", () => {
  async function setup(model = "iaas", productType = "ecommerce") {
    // Cheap enough to buy from the starting cash here.
    await useOverrides({ "productTypes.ecommerce.api.price": 500 });
    const code = await newCode();
    const company = (await newCompany(code, { name: "Acme", productType, model })).json<CompanyView>();
    // The paid API opens in Grow.
    await reachPhase(testDb.db, company.id, "grow");
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    const next = async () => (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    return { company, act, next };
  }

  it("offers e-commerce's API, buys it, and serves its calls as far as the APIU go", async () => {
    const { company, act, next } = await setup();
    expect(company.api).toMatchObject({ name: "Shop API", price: 500, owned: false, calls: 0 });
    const bought = await act({ type: "buyApi" });
    expect(bought.statusCode).toBe(200);
    expect(bought.json<CompanyView>()).toMatchObject({ cash: company.cash - 500, api: { owned: true, calls: 2_000 } });
    expect((await act({ type: "buyApi" })).json()).toMatchObject({ error: "api_owned" });
    // No APIU yet: every call is dropped, and the log says so.
    const { company: after, log } = await next();
    expect(after.api).toMatchObject({ served: 0, dropped: 2_000, apiu: { capacity: 0 } });
    expect(log.flatMap((d) => d.entries).some((e) => e.kind === "api" && e.text.includes("calls dropped"))).toBe(true);
    // API servers are on offer now.
    expect(after.serverOptions.some((o) => o.type === "api")).toBe(true);
  });

  it("switches an app server between CU and APIU", async () => {
    const { company, act } = await setup();
    await act({ type: "buyApi" });
    const app1 = company.servers.find((s) => s.type === "app")!;
    const switched = (await act({ type: "switchServer", id: app1.id, gives: "apiu" })).json<CompanyView>();
    expect(switched.servers.find((s) => s.id === app1.id)).toMatchObject({ apiu: true });
    expect(switched.units!.cu.capacity).toBe(0);
    expect(switched.api!.apiu!.capacity).toBeGreaterThan(0);
    const back = (await act({ type: "switchServer", id: app1.id, gives: "cu" })).json<CompanyView>();
    expect(back.units!.cu.capacity).toBe(company.units!.cu.capacity);
    expect(back.api!.apiu!.capacity).toBe(0);
  });

  it("validates the API actions, and the sim refuses what doesn't fit", async () => {
    const { company, act } = await setup();
    for (const payload of [
      { type: "switchServer", id: 1 },
      { type: "switchServer", gives: "apiu" },
      { type: "switchServer", id: 1, gives: "dbu" },
      { type: "setApiInstances" },
      { type: "setApiInstances", count: -1 },
      { type: "hire", pool: "ops", count: 0 },
    ]) {
      expect((await act(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    const app1 = company.servers.find((s) => s.type === "app")!;
    expect((await act({ type: "switchServer", id: app1.id, gives: "apiu" })).json()).toMatchObject({ error: "no_api" });
    expect((await act({ type: "rentServer", server: "api", size: "small" })).json()).toMatchObject({ error: "no_api" });
    expect((await act({ type: "setApiInstances", count: 1 })).json()).toMatchObject({ error: "not_managed" });
  });

  it("runs API instances on PaaS, none to start", async () => {
    const { act } = await setup("paas");
    await act({ type: "buyApi" });
    const two = (await act({ type: "setApiInstances", count: 2 })).json<CompanyView>();
    expect(two.managed).toMatchObject({ apiInstances: 2, apiInstanceUnits: 10 });
    expect(two.api!.apiu!.capacity).toBeGreaterThan(0);
    const none = (await act({ type: "setApiInstances", count: 0 })).json<CompanyView>();
    expect(none.managed!.apiInstances).toBe(0);
  });

  it("lets the provider run it on SaaS, for a fee per call", async () => {
    const { act, next } = await setup("saas");
    const bought = (await act({ type: "buyApi" })).json<CompanyView>();
    expect(bought.api).toMatchObject({ providerRuns: true, apiu: null, feePerCall: 0.004, dailyFee: 8, dailyIncome: 20 });
    const { company, log } = await next();
    const entries = log.flatMap((d) => d.entries);
    if (company.outageDays === 0) {
      expect(entries).toContainEqual(expect.objectContaining({ kind: "income", cashDelta: 20, text: expect.stringContaining("Shop API") }));
      expect(entries).toContainEqual(expect.objectContaining({ category: "infrastructure", cashDelta: -8, text: expect.stringContaining("runs your Shop API") }));
    }
  });

  it("isn't offered on a product without one", async () => {
    const { company, act } = await setup("saas", "social");
    expect(company.api).toBeNull();
    expect((await act({ type: "buyApi" })).json()).toMatchObject({ error: "no_api" });
  });
});

describe("tiers, model benefits and the hardware slider (#123)", () => {
  async function setup(model = "iaas") {
    const code = await newCode();
    const company = (await newCompany(code, { name: "Acme", productType: "ecommerce", model, takeLoan: model === "onprem" })).json<CompanyView>();
    // Tier items and benefits open in Grow, with features.
    await reachPhase(testDb.db, company.id, "grow");
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    const openTiers = async () => {
      const open = JSON.stringify([2, 3, 4].map((tier) => ({ tier, day: 1 })));
      await testDb.db.execute(sql`update companies set state = jsonb_set(state, '{tiers}', ${open}::jsonb) where id = ${company.id}`);
    };
    const withRp = async (points: number) => {
      await testDb.db.execute(sql`update companies set state = jsonb_set(state, '{researchPoints}', ${String(points)}::jsonb) where id = ${company.id}`);
    };
    return { company, act, openTiers, withRp };
  }

  it("unlocks a tier item with research points once its tier is available, in any order (#179)", async () => {
    const { company, act, openTiers, withRp } = await setup();
    const item = (view: CompanyView, id: string) => view.tiers.flatMap((t) => t.items).find((i) => i.id === id)!;
    expect(item(company, "wishlists")).toMatchObject({ rpPrice: 0, unlocked: true });
    expect(item(company, "checkout")).toMatchObject({ rpPrice: 50, unlocked: false, unlockable: false });
    await withRp(65);
    expect((await act({ type: "unlockItem", item: "checkout" })).json()).toMatchObject({ error: "tier_unavailable" });
    await openTiers();
    expect((await act({ type: "unlockItem", item: "recommendations" })).json()).toMatchObject({ error: "not_enough_rp" });
    // Tier 3 before tier 2: the RP come off the bank.
    const done = await act({ type: "unlockItem", item: "checkout" });
    expect(done.statusCode).toBe(200);
    const view = done.json<CompanyView>();
    expect(view.research.points).toBe(15);
    expect(item(view, "checkout")).toMatchObject({ unlocked: true, unlockable: false });
    expect(view.features.find((f) => f.id === "checkout")).toMatchObject({ unlocked: true });
    const second = (await act({ type: "unlockItem", item: "reviews" })).json<CompanyView>();
    expect(second.research.points).toBe(0);
    expect(item(second, "reviews").unlocked).toBe(true);
    expect((await act({ type: "unlockItem", item: "wishlists" })).json()).toMatchObject({ error: "already_unlocked" });
    expect((await act({ type: "unlockItem", item: "teleporter" })).json()).toMatchObject({ error: "unknown_item" });
    for (const payload of [{ type: "unlockItem" }, { type: "unlockItem", item: 5 }, { type: "unlockItem", item: "x".repeat(65) }]) {
      expect((await act(payload)).statusCode).toBe(400);
    }
  });

  it("shows the tiers and benefits, and buys and cancels a benefit once it's unlocked", async () => {
    const { company, act, openTiers, withRp } = await setup();
    expect(company.tiers.map((t) => [t.tier, t.available])).toEqual([[1, true], [2, false], [3, false], [4, false]]);
    expect(company.benefits.find((b) => b.id === "reservedInstances")).toMatchObject({ onModel: true, unlocked: false, active: false });
    const locked = await act({ type: "buyBenefit", benefit: "reservedInstances" });
    expect(locked.statusCode).toBe(400);
    expect(locked.json()).toMatchObject({ error: "locked" });
    await openTiers();
    await testDb.db.execute(sql`update companies set state = jsonb_set(state, '{cash}', '100000') where id = ${company.id}`);
    // Its tier is available, but it needs unlocking with research points first (#179).
    expect((await act({ type: "buyBenefit", benefit: "reservedInstances" })).json()).toMatchObject({ error: "locked" });
    await withRp(15);
    expect((await act({ type: "unlockItem", item: "reservedInstances" })).statusCode).toBe(200);
    const bought = await act({ type: "buyBenefit", benefit: "reservedInstances" });
    expect(bought.statusCode).toBe(200);
    expect(bought.json<CompanyView>().benefits.find((b) => b.id === "reservedInstances")!.active).toBe(true);
    const cancelled = (await act({ type: "cancelBenefit", benefit: "reservedInstances" })).json<CompanyView>();
    expect(cancelled.benefits.find((b) => b.id === "reservedInstances")!.active).toBe(false);
    for (const payload of [{ type: "buyBenefit" }, { type: "cancelBenefit", benefit: 5 }, { type: "setPerformance", id: 1 }]) {
      expect((await act(payload)).statusCode).toBe(400);
    }
  });

  it("sets an on-prem server's hardware slider, and refuses it elsewhere", async () => {
    const { company, act } = await setup("onprem");
    const id = company.servers[0]!.id;
    const set = await act({ type: "setPerformance", id, performance: 1.25 });
    expect(set.statusCode).toBe(200);
    expect(set.json<CompanyView>().servers.find((s) => s.id === id)).toMatchObject({ performance: 1.25 });
    expect((await act({ type: "setPerformance", id, performance: 2 })).json()).toMatchObject({ error: "bad_performance" });
    const iaas = await setup();
    const refused = await iaas.act({ type: "setPerformance", id: iaas.company.servers[0]!.id, performance: 1.2 });
    expect(refused.json()).toMatchObject({ error: "no_slider" });
  });
});

describe("campaigns (#115) and marketers (#180)", () => {
  async function setup() {
    const code = await newCode();
    const company = (await newCompany(code)).json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload });
    const next = async () => (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    // The first angel investor has approached, opening Grow (#236) and with it campaigns and marketers.
    const approached = async () => {
      await testDb.db.execute(sql`update companies set state = jsonb_set(state, '{investors,firstApproachDay}', '1'::jsonb) where id = ${company.id}`);
      await reachPhase(testDb.db, company.id, "grow");
    };
    return { company, act, next, approached };
  }

  it("keeps campaigns locked until the first angel approaches", async () => {
    const { company, act } = await setup();
    expect(company.campaigns).toMatchObject({ unlocked: false, canStart: false, campaigns: [] });
    const refused = await act({ type: "startCampaign", customerType: "casual", budget: 700, days: 7 });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "not_yet" });
  });

  it("starts a campaign, runs it with its spend, users and cost per user, and stops it", async () => {
    const { act, next, approached } = await setup();
    await approached();
    await act({ type: "hire", pool: "marketers" });
    const started = await act({ type: "startCampaign", customerType: "casual", budget: 700, days: 7 });
    expect(started.statusCode).toBe(200);
    const view = started.json<CompanyView>().campaigns;
    expect(view).toMatchObject({
      unlocked: true,
      running: 1,
      marketers: { count: 1, free: 0 },
      campaigns: [{ id: 1, customerType: "casual", budget: 700, days: 7, status: "starting", spent: 0, grade: "mid", gradeName: "Mid" }],
    });
    const { company, log } = await next();
    const [campaign] = company.campaigns.campaigns;
    expect(campaign).toMatchObject({ status: "running", daysRun: 1, spent: 100 });
    expect(campaign!.users).toBeGreaterThan(0);
    expect(campaign!.costPerUser).toBe(Math.round((100 * 100) / campaign!.users) / 100);
    expect(company.spend.campaigns).toBe(100);
    expect(log.flatMap((d) => d.entries)).toContainEqual(expect.objectContaining({ category: "campaigns", cashDelta: -100 }));
    const stopped = await act({ type: "stopCampaign", id: 1 });
    expect(stopped.json<CompanyView>().campaigns).toMatchObject({ running: 0, campaigns: [{ id: 1, status: "stopped", spent: 100 }] });
  });

  it("refuses a bad campaign, and checks the action's fields", async () => {
    const { act, approached } = await setup();
    await approached();
    await act({ type: "hire", pool: "marketers" });
    expect((await act({ type: "startCampaign", customerType: "casual", budget: 50, days: 7 })).json()).toMatchObject({ error: "bad_budget" });
    expect((await act({ type: "startCampaign", customerType: "casual", budget: 700, days: 2 })).json()).toMatchObject({ error: "bad_length" });
    expect((await act({ type: "startCampaign", customerType: "casual", budget: 5_000, days: 7 })).json()).toMatchObject({ error: "cant_afford" });
    expect((await act({ type: "stopCampaign", id: 9 })).json()).toMatchObject({ error: "unknown_campaign" });
    for (const payload of [
      { type: "startCampaign", customerType: "pensioners", budget: 700, days: 7 },
      { type: "startCampaign", customerType: "casual", days: 7 },
      { type: "startCampaign", customerType: "casual", budget: 700.5, days: 7 },
      { type: "stopCampaign" },
    ]) {
      expect((await act(payload)).statusCode).toBe(400);
    }
  });

  it("keeps marketers locked until the first angel approaches, then hires them as permanent staff only", async () => {
    const { company, act, approached } = await setup();
    expect(company.marketers).toBe(0);
    expect(company.staff.map((p) => p.pool)).not.toContain("marketers");
    expect((await act({ type: "hire", pool: "marketers" })).json()).toMatchObject({ error: "not_yet" });
    await approached();
    const agency = await act({ type: "hire", pool: "marketers", agency: true });
    expect(agency.statusCode).toBe(400);
    expect(agency.json()).toMatchObject({ error: "permanent_only" });
    const hired = (await act({ type: "hire", pool: "marketers", grade: "senior" })).json<CompanyView>();
    expect(hired.marketers).toBe(1);
    expect(hired.staff.find((p) => p.pool === "marketers")).toMatchObject({ agencyAllowed: false, idle: expect.stringMatching(/^1 marketer isn't running a campaign/) });
    expect(hired.campaigns).toMatchObject({ canStart: true, capacity: 1, marketers: { count: 1, free: 1, next: "senior" } });
  });

  it("needs a free marketer to start a campaign, and keeps a busy one from being let go", async () => {
    const { act, approached } = await setup();
    await approached();
    const none = await act({ type: "startCampaign", customerType: "casual", budget: 700, days: 7 });
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ error: "no_marketer" });
    await act({ type: "hire", pool: "marketers" });
    const started = (await act({ type: "startCampaign", customerType: "casual", budget: 700, days: 7 })).json<CompanyView>();
    expect(started.campaigns).toMatchObject({ canStart: false, marketers: { free: 0 } });
    expect(started.staff.find((p) => p.pool === "marketers")!.idle).toBeNull();
    const busy = await act({ type: "letGo", pool: "marketers" });
    expect(busy.statusCode).toBe(400);
    expect(busy.json()).toMatchObject({ error: "marketer_busy" });
    expect((await act({ type: "moveStaff", from: "marketers", to: "developers" })).json()).toMatchObject({ error: "marketer_busy" });
    await act({ type: "stopCampaign", id: 1 });
    expect((await act({ type: "letGo", pool: "marketers" })).json<CompanyView>().marketers).toBe(0);
  });
});

describe("pay reviews", () => {
  // A 12-day game with plenty of cash, put in Grow on day 1 (#236), with the first rise 3 days into it: a quarter is 3
  // days, so the reviews' rises start on days 4, 7 and 10, and the first review opens after day 3.
  const paySim = createSim({
    ...defaultConfig,
    startingCash: 100_000,
    finalDay: 12,
    events: [],
    calendar: { ...defaultConfig.calendar, holidays: [] },
    payReview: { ...defaultConfig.payReview, walkAwaySpread: 0, growDays: 3 },
  });
  let payApp: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    payApp = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim: paySim });
  });

  afterAll(async () => {
    await payApp?.close();
  });

  /** A company played until its first pay review opens. */
  async function reviewing() {
    const code = await newCode();
    const created = await payApp.inject({
      method: "POST",
      url: `/api/codes/${code}/companies`,
      payload: { name: "Acme", productType: "social", model: "saas" },
    });
    const company = created.json<CompanyView>();
    expect(company).toMatchObject({ payReview: null, payMultiplier: 1 });
    await reachPhase(testDb.db, company.id, "grow");
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = (payload: object) => payApp.inject({ method: "POST", url: `${url}/actions`, payload });
    const next = () => payApp.inject({ method: "POST", url: `${url}/continue` });
    let result: ContinueResult | undefined;
    for (let i = 0; i < 5 && !result?.company.payReview; i++) result = (await next()).json<ContinueResult>();
    return { url, act, next, result: result! };
  }

  it("opens a review that pauses time, and refuses the next day until it's settled", async () => {
    const { result, next } = await reviewing();
    expect(result.company.day).toBe(3);
    expect(result.pauses).toContainEqual(expect.objectContaining({ kind: "payReview", id: "pay-review" }));
    const review = result.company.payReview!;
    expect(review).toMatchObject({ quarter: 2, startDay: 4, offersLeft: 3, final: false, canAcceptCounter: false, staffFigure: review.maxAsk });
    expect(review.inflation).toBeGreaterThanOrEqual(0.02);
    expect(review.inflation).toBeLessThanOrEqual(0.06);
    // The hidden figures stay on the server.
    expect(review).not.toHaveProperty("walkAway");
    expect(review).not.toHaveProperty("fairRise");
    const held = await next();
    expect(held.statusCode).toBe(409);
    expect(held.json()).toMatchObject({ error: "pay_review" });
  });

  it("previews an offer's cost and odds, refusing one outside the caps", async () => {
    const { url, result } = await reviewing();
    const review = result.company.payReview!;
    const preview = await payApp.inject({ method: "GET", url: `${url}/pay-offer?rise=${review.minOffer}` });
    expect(preview.statusCode).toBe(200);
    const body = preview.json<PayOfferView>();
    expect(body).toMatchObject({ rise: review.minOffer, tribunal: null, odds: { counter: { rise: review.minOffer } } });
    expect(body.extraPerYear).toBe(body.extraPerDay * 365);
    expect(body.extraPerDay).toBeGreaterThan(0);
    const low = await payApp.inject({ method: "GET", url: `${url}/pay-offer?rise=${review.minOffer - 0.005}` });
    expect(low.statusCode).toBe(400);
    expect(low.json()).toMatchObject({ error: "offer_too_low" });
    expect((await payApp.inject({ method: "GET", url: `${url}/pay-offer` })).statusCode).toBe(400);
  });

  it("takes offers: staff counter one short of their figure, and the counter can be accepted", async () => {
    const { act, next, result } = await reviewing();
    const review = result.company.payReview!;
    expect((await act({ type: "offerPayRise" })).statusCode).toBe(400);
    expect((await act({ type: "offerPayRise", rise: review.maxAsk + 0.01 })).json()).toMatchObject({ error: "offer_too_high" });
    expect((await act({ type: "acceptPayCounter" })).json()).toMatchObject({ error: "no_counter" });
    const countered = (await act({ type: "offerPayRise", rise: review.minOffer })).json<CompanyView>();
    expect(countered.payReview).toMatchObject({ studentOffers: [review.minOffer], offersLeft: 2, canAcceptCounter: true });
    expect(countered.payReview!.rounds).toHaveLength(1);
    const figure = countered.payReview!.staffFigure;
    const settled = (await act({ type: "acceptPayCounter" })).json<CompanyView>();
    expect(settled.payReview).toBeNull();
    expect(settled.payMultiplier).toBeCloseTo(1 + figure, 9);
    expect(settled.dailyStaffCost).toBeGreaterThan(countered.dailyStaffCost);
    const played = await next();
    expect(played.statusCode).toBe(200);
    expect(played.json<ContinueResult>().company.day).toBe(4);
  });

  it("auto-negotiates a review to staff's last counter, leaving the counter or the tribunal to the student", async () => {
    const { act, result } = await reviewing();
    const { minOffer } = result.company.payReview!;
    expect((await act({ type: "autoNegotiatePay" })).statusCode).toBe(400);
    const played = (await act({ type: "autoNegotiatePay", rise: minOffer })).json<CompanyView>();
    if (played.payReview) {
      expect(played.payReview).toMatchObject({ studentOffers: [minOffer, minOffer], final: true, canAcceptCounter: true });
      expect(played.payReview.rounds.every((r) => r.auto)).toBe(true);
      expect(played.cash).toBe(result.company.cash);
      expect((await act({ type: "autoNegotiatePay", rise: minOffer })).json()).toMatchObject({ error: "final_offer" });
      const settled = (await act({ type: "acceptPayCounter" })).json<CompanyView>();
      expect(settled.lastPayReview).toMatchObject({ outcome: "counterAccepted", rise: played.payReview.staffFigure });
    } else {
      expect(played.lastPayReview).toMatchObject({ outcome: "offerAccepted", rise: minOffer });
    }
  });

  it("rolls each review's inflation fresh, on the reviews' RNG as saved after the review before", async () => {
    // The playtest's kind of game (social on IaaS), each review settled on a counter. The reviews' RNG is set to a
    // known state, so the rolls are known to differ, and the game is played again in the sim alone from the saved row:
    // save and load between days and actions must leave the same rolls.
    const code = await newCode();
    const created = await payApp.inject({
      method: "POST",
      url: `/api/codes/${code}/companies`,
      payload: { name: "Acme", productType: "social", model: "iaas" },
    });
    const { id } = created.json<CompanyView>();
    await reachPhase(testDb.db, id, "grow");
    await testDb.db
      .update(companies)
      .set({ state: sql`jsonb_set(${companies.state}, '{payReviewRng}', '12345')` })
      .where(eq(companies.id, id));
    const [row] = await testDb.db.select().from(companies).where(eq(companies.id, id));
    const url = `/api/codes/${code}/companies/${id}`;
    const act = (payload: object) => payApp.inject({ method: "POST", url: `${url}/actions`, payload });
    let local = row!.state as GameState;
    const served: number[] = [];
    const replayed: number[] = [];
    for (let i = 0; i < 12 && local.status === "playing"; i++) {
      const played = (await payApp.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
      local = paySim.tick(local).state;
      const review = played.company.payReview;
      if (!review) continue;
      served.push(review.inflation);
      replayed.push(local.payReview!.inflation);
      await act({ type: "offerPayRise", rise: review.minOffer });
      expect((await act({ type: "acceptPayCounter" })).json<CompanyView>().payReview).toBeNull();
      local = paySim.applyAction(paySim.applyAction(local, { type: "offerPayRise", rise: review.minOffer }), { type: "acceptPayCounter" });
    }
    expect(served).toEqual(replayed);
    expect(served).toEqual([0.059, 0.053, 0.023]);
    const [saved] = await testDb.db.select().from(companies).where(eq(companies.id, id));
    expect((saved!.state as GameState).payReviewRng).toBe(local.payReviewRng);
  });

  it("settles at once on an offer of staff's ask", async () => {
    const { act, result } = await reviewing();
    const settled = (await act({ type: "offerPayRise", rise: result.company.payReview!.maxAsk })).json<CompanyView>();
    expect(settled.payReview).toBeNull();
    expect(settled.payMultiplier).toBeCloseTo(1 + result.company.payReview!.maxAsk, 9);
    expect(settled.lastPayReview).toMatchObject({ outcome: "offerAccepted", tribunal: null });
  });

  it("sends a final offer short of a deal to the tribunal, which charges its fee and says what it picked", async () => {
    const { url, act, next, result } = await reviewing();
    const { minOffer } = result.company.payReview!;
    await act({ type: "offerPayRise", rise: minOffer });
    const final = (await act({ type: "offerPayRise", rise: minOffer })).json<CompanyView>();
    expect(final.payReview).toMatchObject({ final: true, offersLeft: 1, tribunalFee: 2_000 });
    // The preview of the final offer shows the tribunal's odds, not a counter's.
    const preview = (await payApp.inject({ method: "GET", url: `${url}/pay-offer?rise=${minOffer}` })).json<PayOfferView>();
    expect(preview).toMatchObject({ odds: null, tribunal: { fee: 2_000, rises: { student: minOffer, staff: final.payReview!.staffFigure } } });
    const { student, middle, staff } = preview.tribunal!.chances;
    expect(student + middle + staff).toBeCloseTo(1, 9);
    // No separate step: the failed final offer goes straight to the tribunal, which settles the review.
    const settled = (await act({ type: "offerPayRise", rise: minOffer })).json<CompanyView>();
    expect(settled.payReview).toBeNull();
    expect(settled.cash).toBe(final.cash - 2_000);
    const record = settled.lastPayReview!;
    expect(record).toMatchObject({ outcome: "tribunal", tribunal: { fee: 2_000 } });
    expect(record.rise).toBe(preview.tribunal!.rises[record.tribunal!.pick]);
    expect(settled.payMultiplier).toBeCloseTo(1 + record.rise, 9);
    const played = (await next()).json<ContinueResult>();
    expect(played.company.day).toBe(4);
    expect(played.log[0]!.entries[0]!.text).toMatch(/^The tribunal settled quarter 2's pay review on/);
  });

  it("takes staff schemes with an offer: previews their worth and cost, settles them, charges them daily and never lowers them", async () => {
    const { url, act, next, result } = await reviewing();
    const review = result.company.payReview!;
    expect(result.company.staffSchemes.map((s) => [s.id, s.level])).toEqual([
      ["pension", 0],
      ["health", 0],
      ["deathInService", 0],
      ["discount", 0],
      ["shareSave", 0],
    ]);
    expect(review.schemeValuation).toBe(0.7);
    // No head of people yet (#108): the student deals with staff directly, and staff take a point off the roll.
    expect(review).toMatchObject({ headOfPeople: false, rollBonus: -1 });
    const preview = (
      await payApp.inject({ method: "GET", url: `${url}/pay-offer?rise=${review.minOffer}&pension=2&deathInService=1` })
    ).json<PayOfferView>();
    expect(preview.schemes).toEqual({ pension: 2, health: 0, deathInService: 1, discount: 0, shareSave: 0 });
    expect(preview.dilution).toBeNull();
    expect(preview.schemeValue).toBeCloseTo((2 * 0.0075 + 0.0025) * 0.7, 9);
    expect(preview.value).toBeCloseTo(review.minOffer + preview.schemeValue, 3);
    expect(preview.schemeCosts.find((s) => s.id === "pension")!.costPerDay).toBeGreaterThan(0);
    expect((await payApp.inject({ method: "GET", url: `${url}/pay-offer?rise=${review.minOffer}&pension=x` })).statusCode).toBe(400);
    expect((await payApp.inject({ method: "GET", url: `${url}/pay-offer?rise=${review.minOffer}&pension=4` })).json()).toMatchObject({ error: "bad_offer" });
    expect((await act({ type: "offerPayRise", rise: review.minOffer, schemes: { pension: "two" } })).statusCode).toBe(400);
    // Worth staff's ask, so they accept: less cash, with the schemes.
    const cash = Math.floor((review.maxAsk - preview.schemeValue) * 1000) / 1000;
    const settled = (await act({ type: "offerPayRise", rise: cash, schemes: { pension: 2, deathInService: 1 } })).json<CompanyView>();
    expect(settled.payReview).toBeNull();
    expect(settled.lastPayReview).toMatchObject({ outcome: "offerAccepted", rise: cash, schemes: { pension: 2, deathInService: 1 } });
    expect(settled.payMultiplier).toBeCloseTo(1 + cash, 9);
    const pension = settled.staffSchemes.find((s) => s.id === "pension")!;
    expect(pension).toMatchObject({ level: 2, maxLevel: 3, toggle: false });
    expect(pension.costPerDay).toBeGreaterThan(0);
    // Charged from the next day, as staff spend.
    const played = (await next()).json<ContinueResult>();
    const line = played.log[0]!.entries.find((e) => e.text.startsWith("Pension top-up level 2"));
    expect(line).toMatchObject({ cashDelta: -pension.costPerDay, category: "staff" });
    // The next review refuses lowering them.
    let later = played;
    for (let i = 0; i < 5 && !later.company.payReview; i++) later = (await next()).json<ContinueResult>();
    const lower = await act({ type: "offerPayRise", rise: later.company.payReview!.maxAsk, schemes: { pension: 1 } });
    expect(lower.statusCode).toBe(400);
    expect(lower.json()).toMatchObject({ error: "scheme_decrease" });
    expect(later.company.payReview!.schemes.find((s) => s.id === "deathInService")!.level).toBe(1);
  });

  it("takes share save with an offer: previews the dilution, issues the shares to the staff share scheme on the cap table", async () => {
    const { url, act, result } = await reviewing();
    const review = result.company.payReview!;
    const before = result.company.capTable;
    expect(before.rows.map((r) => r.id)).toEqual(["student"]);
    const preview = (await payApp.inject({ method: "GET", url: `${url}/pay-offer?rise=${review.minOffer}&shareSave=2` })).json<PayOfferView>();
    expect(preview.schemes.shareSave).toBe(2);
    expect(preview.schemeValue).toBeCloseTo(2 * 0.01 * 0.7, 9);
    expect(preview.dilution).toEqual({
      newShares: Math.round(before.sharesInIssue * 0.02),
      sharesInIssue: before.sharesInIssue,
      sharesAfter: before.sharesInIssue + Math.round(before.sharesInIssue * 0.02),
      yourShareBefore: 1,
      yourShareAfter: before.sharesInIssue / (before.sharesInIssue + Math.round(before.sharesInIssue * 0.02)),
      schemeShareAfter: Math.round(before.sharesInIssue * 0.02) / (before.sharesInIssue + Math.round(before.sharesInIssue * 0.02)),
    });
    expect((await payApp.inject({ method: "GET", url: `${url}/pay-offer?rise=${review.minOffer}&shareSave=4` })).json()).toMatchObject({ error: "bad_offer" });
    const cash = Math.floor((review.maxAsk - preview.schemeValue) * 1000) / 1000;
    const settled = (await act({ type: "offerPayRise", rise: cash, schemes: { shareSave: 2 } })).json<CompanyView>();
    expect(settled.lastPayReview).toMatchObject({ outcome: "offerAccepted", schemes: { shareSave: 2 }, shareSaveShares: preview.dilution!.newShares });
    expect(settled.staffSchemes.find((s) => s.id === "shareSave")).toMatchObject({ level: 2, sharesPerLevel: 0.01 });
    const staffRow = settled.capTable.rows.find((r) => r.id === "staffScheme")!;
    expect(staffRow).toMatchObject({ name: "Staff share scheme", shares: preview.dilution!.newShares });
    expect(settled.capTable.rows.find((r) => r.id === "student")!.share).toBeCloseTo(preview.dilution!.yourShareAfter, 9);
  });

  it("shows the pay history: empty before the first review, then each review settled with its schemes and shares", async () => {
    const { act, result } = await reviewing();
    const review = result.company.payReview!;
    const empty = result.company.payHistory;
    expect(empty).toMatchObject({ reviews: [], payMultiplier: 1, tribunalFees: 0, schemesCostPerDay: 0, staffShareScheme: null });
    // The open review is the current one: the next is quarter 3's.
    expect(empty.nextReview).toMatchObject({ quarter: 3 });
    const worth = (2 * 0.0075 + 0.01) * 0.7;
    const cash = Math.floor((review.maxAsk - worth) * 1000) / 1000;
    const settled = (await act({ type: "offerPayRise", rise: cash, schemes: { pension: 2, shareSave: 1 } })).json<CompanyView>();
    const h = settled.payHistory;
    expect(h.payMultiplier).toBe(settled.payMultiplier);
    expect(h.reviews).toHaveLength(1);
    expect(h.reviews[0]).toMatchObject({
      quarter: 2,
      startDay: review.startDay,
      inflation: review.inflation,
      offers: 1,
      outcome: "offerAccepted",
      tribunalPick: null,
      tribunalFee: 0,
      rise: cash,
      shareSaveShares: settled.lastPayReview!.shareSaveShares,
      payMultiplier: settled.payMultiplier,
    });
    expect(h.reviews[0]!.date).toMatch(/^\w+ \d+ \w+ \d{4}$/);
    expect(h.reviews[0]!.schemeRaises.map((s) => [s.id, s.from, s.to])).toEqual([
      ["pension", 0, 2],
      ["shareSave", 0, 1],
    ]);
    expect(h.schemesCostPerDay).toBeCloseTo(settled.staffSchemes.reduce((sum, s) => sum + s.costPerDay, 0), 9);
    const staffRow = settled.capTable.rows.find((r) => r.id === "staffScheme")!;
    expect(h.staffShareScheme).toEqual({ shares: staffRow.shares, share: staffRow.share });
  });
});

describe("drift", () => {
  async function setup(body: object) {
    await useOverrides({ "allowedGameLengths.until-ipo": 1, "payReview.on": 0 });
    const code = await newCode();
    const created = await newCompany(code, { name: "Acme", productType: "ecommerce", model: "iaas", ...body });
    expect(created.statusCode).toBe(201);
    const company = created.json<CompanyView>();
    const url = `/api/codes/${code}/companies/${company.id}`;
    const act = async (payload: object) => (await app.inject({ method: "POST", url: `${url}/actions`, payload })).json<CompanyView>();
    const next = async () => (await app.inject({ method: "POST", url: `${url}/continue` })).json<ContinueResult>();
    /** Moves the game to the eve of `day`, as if it had played up to the day before. */
    const eveOf = (day: number) =>
      testDb.db.execute(sql`update companies set state = jsonb_set(state, '{day}', ${String(day - 1)}::jsonb) where id = ${company.id}`);
    return { company, act, next, eveOf };
  }

  it("shows a long game's year's end: prices up, a pause, and more units on kit added after it", async () => {
    const { company, act, next, eveOf } = await setup({ gameLength: "until-ipo" });
    expect(company.drift).toEqual({ on: true, yearDays: 365, priceLevel: 1, newKitUnits: 1, yearEnds: [], nextYearEnd: 365 });
    const before = await act({ type: "rentServer", server: "app", size: "large" });
    const units = before.servers.at(-1)!.units;
    await eveOf(365);
    const played = await next();
    const [year] = played.company.drift.yearEnds;
    expect(year).toMatchObject({ year: 1, day: 365, newKitUnits: 1.1 });
    expect(year!.inflation).toBeGreaterThanOrEqual(0.02);
    expect(year!.inflation).toBeLessThanOrEqual(0.06);
    expect(played.company.drift.nextYearEnd).toBe(730);
    expect(played.pauses).toContainEqual(expect.objectContaining({ kind: "alert", id: "year-end" }));
    expect(played.log.flatMap((d) => d.entries).find((e) => e.kind === "drift")!.text).toMatch(/^Year 1 is over/);
    // The VM rented before keeps its units, at the new rent; one rented now gives 10% more.
    expect(played.company.servers.at(-1)).toMatchObject({ units, unitBoost: 1 });
    expect(played.company.servers.at(-1)!.monthlyCost).toBeCloseTo(before.servers.at(-1)!.monthlyCost * year!.priceLevel, 1);
    const after = await act({ type: "rentServer", server: "app", size: "large" });
    expect(after.servers.at(-1)).toMatchObject({ units: units * 1.1, unitBoost: 1.1 });
  });

  it("has no year's end to come in a 180-day game", async () => {
    const { company } = await setup({});
    expect(company.drift).toMatchObject({ yearEnds: [], nextYearEnd: null });
  });
});
