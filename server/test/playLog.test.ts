import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createSim, defaultConfig } from "@xaas/sim";
import { buildApp, UI_BATCHES_PER_MINUTE, UI_EVENTS_PER_BATCH } from "../src/app.ts";
import { EXPORT_COLUMNS } from "../src/playLog.ts";
import type {
  CompanyView,
  LogDeleteResult,
  LogStatsView,
  PlayEventView,
  TeacherCodeView,
  TeacherGamesView,
  TimelineView,
} from "../src/api-types.ts";
import { setupTestDb } from "./testDb.ts";

// The playtest log: game events from each request, UI events from the browser, the teacher's timeline, export and
// deletes, and that none of it can identify a student.
const PASSWORD = "test-teacher-password";
// Short games, so one can be played to the end.
const sim = createSim({ ...defaultConfig, finalDay: 4 });
// Distinctive, so a leak into any stored or exported text can be searched for.
const NAME = "Zebedee Quux Ltd";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  testDb = await setupTestDb();
  app = await buildApp({ db: testDb.db, teacherPassword: PASSWORD, sessionSecret: "x".repeat(32), sim, rateLimit: false });
});

afterAll(async () => {
  await app?.close();
  await testDb?.close();
});

beforeEach(async () => {
  await app.playLog.flush();
  await testDb.reset();
});

async function teacherCookie() {
  const res = await app.inject({ method: "POST", url: "/api/teacher/login", payload: { password: PASSWORD } });
  return { teacher: res.cookies.find((c) => c.name === "teacher")!.value };
}

async function newCode() {
  const res = await app.inject({ method: "POST", url: "/api/teacher/codes", cookies: await teacherCookie() });
  return res.json<TeacherCodeView>().code;
}

async function newGame(code?: string, headers: Record<string, string> = {}) {
  code ??= await newCode();
  const res = await app.inject({
    method: "POST",
    url: `/api/codes/${code}/companies`,
    payload: { name: NAME, productType: "social", model: "iaas" },
    headers,
  });
  expect(res.statusCode).toBe(201);
  const company = res.json<CompanyView>();
  const url = `/api/codes/${code}/companies/${company.id}`;
  return {
    code,
    company,
    url,
    play: (headers: Record<string, string> = {}) => app.inject({ method: "POST", url: `${url}/continue`, headers }),
    act: (payload: object) => app.inject({ method: "POST", url: `${url}/actions`, payload }),
    ui: (payload: object, headers: Record<string, string> = {}) =>
      app.inject({ method: "POST", url: `${url}/ui-events`, payload, headers }),
  };
}

async function timeline(id: string, kind?: "game" | "ui") {
  const res = await app.inject({
    method: "GET",
    url: `/api/teacher/companies/${id}/timeline${kind ? `?kind=${kind}` : ""}`,
    cookies: await teacherCookie(),
  });
  expect(res.statusCode).toBe(200);
  return res.json<TimelineView>();
}

async function exported(query = "") {
  const res = await app.inject({ method: "GET", url: `/api/teacher/logs/export${query}`, cookies: await teacherCookie() });
  expect(res.statusCode).toBe(200);
  return res;
}

async function storedRows() {
  await app.playLog.flush();
  return testDb.db.execute<{ row: string }>(sql`select row_to_json(e)::text as row from play_events e order by id`);
}

const events = (t: TimelineView, type: string) => t.events.filter((e) => e.type === type);

describe("game events", () => {
  it("logs the start, each Continue and each action, with params and a snapshot of key numbers", async () => {
    const { company, play, act } = await newGame();
    expect((await play()).statusCode).toBe(200);
    const hired = await act({ type: "hire", pool: "ops" });
    expect(hired.statusCode).toBe(200);
    const after = hired.json<CompanyView>();

    const t = await timeline(company.id);
    expect(t.events.map((e) => e.type)).toEqual(["start", "continue", "hire"]);
    const [start, cont, hire] = t.events as [PlayEventView, PlayEventView, PlayEventView];
    expect(start).toMatchObject({
      kind: "game",
      ok: true,
      error: null,
      day: company.day,
      params: { productType: "social", model: "iaas", takeLoan: false, preset: "Default" },
    });
    // A Continue is logged on the day it was pressed; its snapshot is the day after.
    expect(cont).toMatchObject({ ok: true, day: company.day, snapshot: { day: company.day + 1 } });
    expect(hire).toMatchObject({ ok: true, day: after.day, params: { pool: "ops" } });
    expect(hire.snapshot).toEqual({
      day: after.day,
      cash: Math.round(after.cash),
      paidUsers: after.paidUsers,
      freeUsers: after.freeUsers,
      dailyIncome: Math.round(after.dailyIncome),
      satisfaction: after.satisfaction,
      uptime: Math.round(after.uptime * 10) / 10,
      tier: after.units!.binding,
      tierUse: expect.any(Number),
      model: "iaas",
      developers: after.developers,
      ops: after.ops,
      support: after.support,
      loan: "none",
      loanRemaining: null,
    });
    expect(hire.snapshot!.ops).toBe(start.snapshot!.ops + 1);
  });

  it("logs an action the game refused, with its error code and the numbers as they stayed", async () => {
    const { company, act } = await newGame();
    const res = await act({ type: "setPrice", price: 1_000_000 });
    expect(res.statusCode).toBe(400);
    const [refused] = events(await timeline(company.id), "setPrice");
    expect(refused).toMatchObject({
      ok: false,
      error: res.json().error,
      params: { price: 1_000_000 },
      snapshot: { cash: Math.round(company.cash), day: company.day },
    });
  });

  it("logs the end of a game: played to the final day, or retired", async () => {
    const finished = await newGame();
    for (let i = 0; i < 10 && (await finished.play()).json().company?.status === "active"; i++);
    const ended = events(await timeline(finished.company.id), "end");
    expect(ended).toEqual([expect.objectContaining({ params: { status: "finished" }, ok: true })]);
    // Continue after the end is refused, and logged as refused.
    expect((await finished.play()).statusCode).toBe(409);
    expect(events(await timeline(finished.company.id), "continue").at(-1)).toMatchObject({ ok: false, error: "finished" });

    const retired = await newGame(finished.code);
    expect((await app.inject({ method: "POST", url: `${retired.url}/retire` })).statusCode).toBe(200);
    expect(events(await timeline(retired.company.id), "end")).toEqual([
      expect.objectContaining({ params: { status: "retired" } }),
    ]);
  });

  it("filters a timeline to game or UI events", async () => {
    const { company, play, ui } = await newGame();
    await play();
    expect((await ui({ events: [{ type: "page", ago: 0, day: 1, params: { page: "finance" } }] })).statusCode).toBe(204);
    expect((await timeline(company.id, "game")).events.map((e) => e.kind)).toEqual(["game", "game"]);
    expect((await timeline(company.id, "ui")).events).toEqual([
      expect.objectContaining({ kind: "ui", type: "page", params: { page: "finance" }, ok: null, snapshot: null }),
    ]);
  });

  it("doesn't fail a Continue or an action when the log can't be written", async () => {
    const { company, url, play, act } = await newGame();
    await app.playLog.flush();
    await testDb.db.execute(sql`alter table play_events rename to play_events_away`);
    try {
      expect((await play()).statusCode).toBe(200);
      expect((await act({ type: "hire", pool: "ops" })).statusCode).toBe(200);
      await app.playLog.flush();
    } finally {
      await testDb.db.execute(sql`alter table play_events_away rename to play_events`);
    }
    // The game went on; only the log missed those two.
    expect((await app.inject({ method: "GET", url })).json()).toMatchObject({ day: company.day + 1, ops: company.ops + 1 });
    expect((await timeline(company.id)).events.map((e) => e.type)).toEqual(["start"]);
  });
});

describe("UI events", () => {
  it("stores a batch, dated by how long ago each happened, on a day no later than the game's", async () => {
    const { company, ui } = await newGame();
    const before = Date.now();
    const res = await ui({
      events: [
        { type: "modal", ago: 5000, day: company.day, params: { modal: "set-your-price", ms: 4200 } },
        { type: "pricePreview", ago: 4000, day: company.day, params: { prices: [12, 15.5], confirmed: false } },
        { type: "quote", ago: 0, day: 999, params: { kind: "migration", target: "paas", confirmed: false } },
      ],
    });
    expect(res.statusCode).toBe(204);
    const t = await timeline(company.id, "ui");
    expect(t.events.map((e) => e.type)).toEqual(["modal", "pricePreview", "quote"]);
    expect(Date.parse(t.events[0]!.at)).toBeLessThanOrEqual(before - 4900);
    expect(t.events[2]).toMatchObject({ day: company.day, params: { kind: "migration", target: "paas", confirmed: false } });
  });

  it("refuses a batch that's too long, too big or carries anything but the game's own ids", async () => {
    const { ui } = await newGame();
    const page = { type: "page", ago: 0, day: 1, params: { page: "home" } };
    expect((await ui({ events: Array(UI_EVENTS_PER_BATCH + 1).fill(page) })).statusCode).toBe(400);
    expect((await ui({ events: [] })).statusCode).toBe(400);
    const huge = { events: [{ ...page, params: { page: "home", control: `a${"b".repeat(20_000)}` } }] };
    expect((await ui(huge)).statusCode).toBe(413);
    for (const params of [
      { page: "Zebedee Quux Ltd" },
      { modal: "<script>" },
      { prices: Array(21).fill(1) },
      { target: "mainframe" },
    ]) {
      expect((await ui({ events: [{ ...page, params }] })).statusCode, JSON.stringify(params)).toBe(400);
    }
    expect((await ui({ events: [{ ...page, type: "keystroke" }] })).statusCode).toBe(400);
    expect((await storedRows()).filter((r) => r.row.includes('"ui"'))).toEqual([]);
    // Fields it doesn't know are dropped, as everywhere in the API, so they never reach the log.
    expect((await ui({ events: [{ ...page, name: NAME, params: { page: "home", name: NAME } }] })).statusCode).toBe(204);
    const rows = (await storedRows()).filter((r) => r.row.includes('"ui"'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row).not.toContain("Zebedee");
  });

  it("limits how many batches a game may send a minute", async () => {
    const { ui } = await newGame();
    const batch = { events: [{ type: "control", ago: 0, day: 1, params: { control: "servers-app", value: "up" } }] };
    for (let i = 0; i < UI_BATCHES_PER_MINUTE; i++) expect((await ui(batch)).statusCode).toBe(204);
    const limited = await ui(batch);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // Another game isn't held up by it.
    expect((await (await newGame()).ui(batch)).statusCode).toBe(204);
  });

  it("refuses a game that isn't under the code", async () => {
    const { company } = await newGame();
    const other = await newCode();
    const res = await app.inject({
      method: "POST",
      url: `/api/codes/${other}/companies/${company.id}/ui-events`,
      payload: { events: [{ type: "page", ago: 0, day: 1 }] },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("anonymity", () => {
  it("stores and exports no company name, login code, IP address or user agent", async () => {
    const headers = { "user-agent": "SecretBrowser/9.9", "x-forwarded-for": "203.0.113.77" };
    const { code, company, play, act, ui } = await newGame(undefined, headers);
    await play(headers);
    await act({ type: "hire", pool: "developers" });
    await ui({ events: [{ type: "page", ago: 0, day: 1, params: { page: "people" } }] }, headers);
    const csv = (await exported()).body;
    const json = (await exported("?format=json")).body;
    const rows = (await storedRows()).map((r) => r.row);
    expect(rows.length).toBe(4);
    for (const text of [...rows, csv, json]) {
      for (const secret of [NAME, "Zebedee", code, "203.0.113.77", "127.0.0.1", "SecretBrowser"]) {
        expect(text).not.toContain(secret);
      }
    }
    // The link back to the game is the company's id, which only the server can turn into a name.
    expect(rows.every((r) => r.includes(company.id))).toBe(true);
    expect(csv).not.toContain(company.id);
    expect(json).not.toContain(company.id);
  });

  it("gives each company a stable pseudonym, the same on the dashboard, timeline and export", async () => {
    const first = await newGame();
    const second = await newGame(first.code);
    await first.play();
    await second.play();
    await first.play();
    const t1 = await timeline(first.company.id);
    const t2 = await timeline(second.company.id);
    expect(t1.player).toMatch(/^Player \d+$/);
    expect(t2.player).not.toBe(t1.player);
    expect((await timeline(first.company.id)).player).toBe(t1.player);
    const dashboard = (
      await app.inject({ method: "GET", url: "/api/teacher/games", cookies: await teacherCookie() })
    ).json<TeacherGamesView>();
    const players = Object.fromEntries(dashboard.codes[0]!.companies.map((g) => [g.id, g.player]));
    expect(players).toEqual({ [first.company.id]: t1.player, [second.company.id]: t2.player });
    const rows = (await exported("?format=json")).json<{ player: string; type: string }[]>();
    expect(rows.filter((r) => r.player === t1.player).map((r) => r.type)).toEqual(["start", "continue", "continue"]);
    expect(rows.filter((r) => r.player === t2.player).map((r) => r.type)).toEqual(["start", "continue"]);
  });
});

describe("export", () => {
  it("has one row per event, with flat key-number columns and the params as JSON", async () => {
    const { play, act } = await newGame();
    await play();
    await act({ type: "setPrice", price: 9.5 });
    const res = await exported();
    expect(res.headers["content-type"]).toMatch(/^text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="playtest-log-\d{4}-\d{2}-\d{2}\.csv"$/);
    const [header, ...lines] = res.body.trim().split("\r\n");
    expect(header).toBe(EXPORT_COLUMNS.join(","));
    expect(lines).toHaveLength(3);
    const price = lines[2]!.split(",");
    const col = (name: string) => EXPORT_COLUMNS.indexOf(name as (typeof EXPORT_COLUMNS)[number]);
    expect(price[col("type")]).toBe("setPrice");
    expect(price[col("kind")]).toBe("game");
    expect(price[col("model")]).toBe("iaas");
    expect(Number(price[col("cash")])).not.toBeNaN();
    expect(lines[2]!.endsWith(`"{""price"":9.5}"`)).toBe(true);

    const json = await exported("?format=json");
    expect(json.headers["content-type"]).toMatch(/^application\/json/);
    expect(json.json<object[]>()[2]).toMatchObject({ type: "setPrice", params: { price: 9.5 }, model: "iaas", ok: true });
  });

  it("filters by code, preset, kind and time", async () => {
    const a = await newGame();
    const b = await newGame();
    await b.ui({ events: [{ type: "page", ago: 0, day: 1, params: { page: "home" } }] });
    const cookies = await teacherCookie();
    const preset = await app.inject({ method: "POST", url: "/api/teacher/presets", payload: { name: "Easy", overrides: { finalDay: 30 } }, cookies });
    await app.inject({ method: "POST", url: `/api/teacher/presets/${preset.json().id}/activate`, cookies });
    expect(preset.statusCode, preset.body).toBe(201);
    const easy = await newGame(a.code);
    const types = async (q: string) => (await exported(`?format=json&${q}`)).json<{ player: string; type: string; preset: string }[]>();

    expect(await types(`code=${a.code}`)).toHaveLength(2);
    expect((await types(`code=${b.code}`)).map((r) => r.type)).toEqual(["start", "page"]);
    expect((await types("preset=Easy")).map((r) => r.player)).toEqual([(await timeline(easy.company.id)).player]);
    expect(await types("preset=Default")).toHaveLength(3);
    expect((await types("kind=ui")).map((r) => r.type)).toEqual(["page"]);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await types(`from=${encodeURIComponent(future)}`)).toEqual([]);
    expect(await types(`to=${encodeURIComponent(future)}`)).toHaveLength(4);
    const bad = await app.inject({ method: "GET", url: "/api/teacher/logs/export?from=yesterday", cookies });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/teacher/logs/export?code=12", cookies })).statusCode).toBe(400);
  });
});

describe("deleting logs", () => {
  async function count() {
    await app.playLog.flush();
    const [row] = await testDb.db.execute<{ n: number }>(sql`select count(*)::int as n from play_events`);
    return row!.n;
  }

  it("deletes one game's logs, a code's, or all, and leaves the games alone", async () => {
    const cookies = await teacherCookie();
    const del = async (url: string) => {
      const res = await app.inject({ method: "DELETE", url, cookies });
      expect(res.statusCode).toBe(200);
      return res.json<LogDeleteResult>().deleted;
    };
    const a1 = await newGame();
    const a2 = await newGame(a1.code);
    const b = await newGame();
    for (const g of [a1, a2, b]) await g.play();
    expect(await count()).toBe(6);
    const stats = await app.inject({ method: "GET", url: "/api/teacher/logs", cookies });
    expect(stats.json<LogStatsView>()).toEqual({ events: 6, companies: 3 });

    const player = (await timeline(a1.company.id)).player;
    expect(await del(`/api/teacher/companies/${a1.company.id}/logs`)).toBe(2);
    expect(await count()).toBe(4);
    // The game plays on and keeps its pseudonym.
    await a1.play();
    expect((await timeline(a1.company.id)).player).toBe(player);
    expect(await del(`/api/teacher/codes/${a1.code}/logs`)).toBe(3);
    expect((await timeline(b.company.id)).events).toHaveLength(2);
    expect(await del("/api/teacher/logs")).toBe(2);
    expect(await count()).toBe(0);
    expect((await app.inject({ method: "GET", url: a1.url })).statusCode).toBe(200);

    expect((await app.inject({ method: "DELETE", url: "/api/teacher/companies/not-a-uuid/logs", cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/teacher/codes/00000000/logs", cookies })).statusCode).toBe(404);
  });

  it("deletes a game's logs with the game, and a code's with the code", async () => {
    const cookies = await teacherCookie();
    const a = await newGame();
    const b = await newGame();
    const c = await newGame(b.code);
    for (const g of [a, b, c]) await g.play();
    expect(await count()).toBe(6);
    await app.inject({ method: "DELETE", url: `/api/teacher/companies/${a.company.id}`, cookies });
    expect(await count()).toBe(4);
    await app.inject({ method: "DELETE", url: `/api/teacher/codes/${b.code}`, cookies });
    expect(await count()).toBe(0);
  });
});

describe("teacher auth", () => {
  it("needs the teacher signed in for every log route", async () => {
    const { code, company } = await newGame();
    for (const [method, url] of [
      ["GET", `/api/teacher/companies/${company.id}/timeline`],
      ["GET", "/api/teacher/logs/export"],
      ["GET", "/api/teacher/logs/export?format=json"],
      ["GET", "/api/teacher/logs"],
      ["DELETE", `/api/teacher/companies/${company.id}/logs`],
      ["DELETE", `/api/teacher/codes/${code}/logs`],
      ["DELETE", "/api/teacher/logs"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      const forged = await app.inject({ method, url, cookies: { teacher: "forged" } });
      expect(forged.statusCode, `${method} ${url} forged`).toBe(401);
    }
    expect((await timeline(company.id)).events).toHaveLength(1);
  });
});
