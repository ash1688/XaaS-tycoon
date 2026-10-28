import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { defaultConfig } from "@xaas/sim";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";

/**
 * Creates a login code from a signed-in staff page and returns it. The code comes from the server's reply, not the
 * table's first row: the table already lists codes from earlier tests, and until the new row lands its first row is
 * one of those, whose companies would then show up in this test.
 */
export async function createCode(teacher: Page) {
  const [response] = await Promise.all([
    teacher.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/teacher/codes",
    ),
    teacher.getByRole("button", { name: "Create code" }).click(),
  ]);
  expect(response.ok()).toBe(true);
  const { code } = (await response.json()) as { code: string };
  await expect(teacher.locator(`td[data-code="${code}"]`)).toBeVisible();
  return code;
}

/**
 * A first setup for each model, the one round two gave a new company before launch day: a medium app server and
 * database on IaaS, large ones on-prem, one app instance and a small managed database on PaaS, nothing on SaaS.
 */
const FIRST_SETUP: Record<string, object[]> = {
  onprem: [
    { type: "buyServer", server: "app", size: "large" },
    { type: "buyServer", server: "database", size: "large" },
  ],
  iaas: [
    { type: "rentServer", server: "app", size: "medium" },
    { type: "rentServer", server: "database", size: "medium" },
  ],
  paas: [
    { type: "setInstances", count: 1 },
    { type: "setManagedService", service: "database", size: "small" },
  ],
  saas: [],
};

/** Round two's launch users for each product (the payments app came later): what the specs' sums were worked out with. */
const ROUND_TWO_LAUNCH: Record<string, number> = { ecommerce: 3_000, social: 4_000, video: 1_600, payments: 600 };

/** Users arrived by the end of ramp day k out of a launch total, worked out as the sim does (see createLaunch). */
function arrivedBy(launchUsers: number, k: number) {
  const shares = defaultConfig.launch.rampShares;
  const total = shares.reduce((sum, s) => sum + s, 0);
  return Math.round((launchUsers * shares.slice(0, k).reduce((sum, s) => sum + s, 0)) / total);
}

/**
 * Opens every tier for a company, as if each condition had been met on day 1, and unlocks every item in them, as if
 * with research points, so a test about building or buying features can use any of the product's, not just tier 1's.
 * With `unlock: false` the tiers are only available, their items still to unlock.
 */
export async function openTiers(id: string, { unlock = true } = {}) {
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    const open = [2, 3, 4].map((tier) => ({ tier, day: 1 }));
    const features = Object.values(defaultConfig.productTypes).flatMap((p) => p.features.map((f) => f.id));
    const unlocks = unlock ? [...new Set([...features, ...defaultConfig.tiers.benefits.map((b) => b.id)])] : [];
    await sql`update companies set state = jsonb_set(jsonb_set(state, '{tiers}', ${sql.json(open)}), '{unlocks}', ${sql.json(unlocks)}) where id = ${id}`;
  } finally {
    await sql.end();
  }
}

/**
 * Moves a company on to a phase (#236), as if its milestones, and any before it, had come today, so the jobs it opens
 * show and can be used: for a spec about those jobs rather than how the game reaches them. Nothing else changes: no
 * angel or Series A approaches. A company already that far on stays where it is. Reload the page after.
 */
export async function reachPhase(id: string, phase: "launch" | "grow" | "scale") {
  const phases = ["build", "launch", "grow", "scale"];
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    const [row] = await sql`select state from companies where id = ${id}`;
    const state = row!.state as { day: number; phase: string; phaseDays: Record<string, number | null> };
    const from = phases.indexOf(state.phase);
    const to = phases.indexOf(phase);
    if (from >= to) return;
    const phaseDays = { ...state.phaseDays };
    for (const p of phases.slice(from + 1, to + 1)) phaseDays[p] = state.day;
    await sql`update companies set state = ${sql.json({ ...state, phase, phaseDays })} where id = ${id}`;
  } finally {
    await sql.end();
  }
}

/**
 * Pins a new company's launch total in the test database. Each game draws its own from a range, so a spec whose sums
 * depend on the users pins round two's number for its product instead.
 */
export async function pinLaunchUsers(id: string, users: number) {
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    const [row] = await sql`select state from companies where id = ${id}`;
    const state = row!.state as {
      day: number;
      launchUsers: number;
      launchDay: number | null;
      users: number;
      paidUsers: number;
    };
    // A company that can serve users at once (SaaS) has had its first day's share already: swap it for the new
    // total's share. Rescaling the old share instead rounds twice, so the ramp could end a user over or under.
    const arrived = state.launchDay === null ? 0 : arrivedBy(users, state.day - state.launchDay + 1);
    const pinned = {
      ...state,
      launchUsers: users,
      ...(state.launchDay !== null && {
        users: arrived,
        paidUsers: Math.round(state.paidUsers * (arrived / state.users)),
      }),
    };
    await sql`update companies set state = ${sql.json(pinned)} where id = ${id}`;
  } finally {
    await sql.end();
  }
}

/**
 * Pins a company's launch total to round two's for its product (see pinLaunchUsers), sets up its first servers
 * through the API, as a student would on day 1, then plays on until all its launch users have arrived: the end of day
 * 3 on SaaS, day 4 on IaaS and PaaS, and on-prem day 13, two days after its kit arrives. Returns the company then.
 */
export async function launch(request: APIRequestContext, code: string, id: string, model: string) {
  const url = `/api/codes/${code}/companies/${id}`;
  const { productType } = await (await request.get(url)).json();
  await pinLaunchUsers(id, ROUND_TWO_LAUNCH[productType]!);
  for (const action of FIRST_SETUP[model]!) expect((await request.post(`${url}/actions`, { data: action })).ok()).toBe(true);
  for (;;) {
    const res = await request.post(`${url}/continue`);
    expect(res.ok()).toBe(true);
    const { company } = await res.json();
    if (company.launch.status === "launched") return company;
  }
}

/**
 * Makes random events certain for the games started while `start` runs: only the one event can come up, at a
 * threshold of `threshold` on the danger meter. It rises 1 a day, and half as fast again with servers unpatched; the
 * other risks add nothing, so an outage can't bring the next event sooner. Its preset is active only while `start`
 * runs, then Default is again and the preset goes, so later games and specs play the defaults.
 */
export async function withOnlyEncounter<T>(
  request: APIRequestContext,
  event: string,
  threshold: number,
  start: () => Promise<T>,
): Promise<T> {
  const ids = [
    "trafficSpike",
    "osPatch",
    "providerPriceRise",
    "providerOutage",
    "saasFeatureGap",
    "breach",
    "viralGrowth",
    "dataCentreFire",
    "fraud",
    "lawsuit",
  ];
  const overrides: Record<string, number> = {
    "encounters.thresholdMin": threshold,
    "encounters.thresholdMax": threshold,
    "encounters.riskRise.overloaded": 0,
    "encounters.riskRise.lowSatisfaction": 0,
    ...Object.fromEntries(ids.map((id) => [`events.${id}.encounter.chance`, id === event ? 1 : 0])),
  };
  return withPreset(request, `Only ${event}`, overrides, start);
}

/**
 * Plays the games started while `start` runs on a preset of these overrides: it's active only while `start` runs,
 * then Default is again and the preset goes, so later games and specs play the defaults.
 */
export async function withPreset<T>(
  request: APIRequestContext,
  name: string,
  overrides: Record<string, number>,
  start: () => Promise<T>,
): Promise<T> {
  expect((await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } })).ok()).toBe(true);
  const created = await request.post("/api/teacher/presets", { data: { name, overrides } });
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  try {
    expect((await request.post(`/api/teacher/presets/${id}/activate`)).ok()).toBe(true);
    return await start();
  } finally {
    await request.post("/api/teacher/presets/default/activate");
    await request.delete(`/api/teacher/presets/${id}`);
  }
}

/**
 * Moves one mid straight from one team to another, a developer into ops unless told otherwise, as `move` did before it
 * became retraining (#258), for a spec that needs them on the new team today rather than after a mid's lead time.
 * Reload the page after.
 */
export async function movedNow(id: string, from = "developers", to = "ops") {
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    const [row] = await sql`select state from companies where id = ${id}`;
    const state = row!.state as { staff: Record<string, Record<string, number>> };
    const staff = { ...state.staff, [from]: { ...state.staff[from]! }, [to]: { ...state.staff[to]! } };
    staff[from]!.mid! -= 1;
    staff[to]!.mid! += 1;
    await sql`update companies set state = ${sql.json({ ...state, staff })} where id = ${id}`;
  } finally {
    await sql.end();
  }
}
