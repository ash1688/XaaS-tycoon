import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSim, defaultConfig } from "@xaas/sim";
import { buildApp } from "../src/app.ts";
import type { CompanyView, ContinueResult, TeacherCodeView } from "../src/api-types.ts";
import { setupTestDb } from "./testDb.ts";

const PASSWORD = "test-teacher-password";
const sim = createSim({ ...defaultConfig, startingCash: 1000, models: { ...defaultConfig.models, iaas: { ...defaultConfig.models.iaas, dailyCost: 25 } } });

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

describe("meta", () => {
  it("lists product types and models from config", async () => {
    const res = await app.inject({ method: "GET", url: "/api/meta" });
    const meta = res.json();
    expect(meta.productTypes.map((p: { id: string }) => p.id)).toEqual(["ecommerce", "social", "video"]);
    expect(meta.models.map((m: { id: string }) => m.id)).toEqual(["onprem", "iaas", "paas", "saas"]);
    expect(meta.startingCash).toBe(1000);
  });
});
