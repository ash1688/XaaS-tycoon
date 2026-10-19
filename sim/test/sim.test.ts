import { describe, expect, it } from "vitest";
import {
  createSim,
  defaultConfig,
  MODEL_IDS,
  SPEND_CATEGORIES,
  SimError,
  type Action,
  type GameConfig,
  type LogEntry,
} from "../src/index.ts";

const comparison = { upfrontCost: "", monthlyCost: "", opsNeeded: "", control: "" };
const growth = {
  startingUsers: 1000,
  marketSize: 1_000_000,
  dailyGrowth: 0.03,
  growthNoise: 0.2,
  loadPerUser: 1,
  loadNoise: 0.1,
};

function costs(monthlyCost: number) {
  return { upfrontCost: 0, monthlyCost, monthlyCostPerUser: 0 };
}

const config: GameConfig = {
  startingCash: 1000,
  finalDay: 180,
  maxCompanyNameLength: 20,
  // Capacity far above any load here, so outages only happen where a test lowers it.
  // No upfront or per-user costs, so each model costs a flat monthly ÷ 30 a day unless a test adds them.
  models: {
    onprem: { name: "On-prem", blurb: "", comparison, ...costs(300), opsNeeded: 3, capacity: 1_000_000 },
    iaas: { name: "IaaS", blurb: "", comparison, ...costs(600), opsNeeded: 2, capacity: 1_000_000 },
    paas: { name: "PaaS", blurb: "", comparison, ...costs(900), opsNeeded: 1, capacity: 1_000_000 },
    saas: { name: "SaaS", blurb: "", comparison, ...costs(150), opsNeeded: 0, capacity: 1_000_000 },
  },
  productTypes: {
    ecommerce: {
      name: "Shop",
      profile: "",
      growth: {
        ...growth,
        dailyGrowth: 0.02,
        seasonalSpike: { firstDay: 10, every: 10, length: 3, loadMultiplier: 3, growthMultiplier: 3 },
      },
    },
    social: { name: "Social", profile: "", growth: { ...growth, dailyGrowth: 0.06 } },
    video: { name: "Video", profile: "", growth: { ...growth, dailyGrowth: 0.02, loadPerUser: 5 } },
  },
  // No starting staff, so the model's running cost is the only charge unless a test hires someone.
  staff: {
    developers: { name: "Developers", personName: "developer", dayRate: 7, startingCount: 0 },
    ops: { name: "Ops", personName: "ops person", dayRate: 3, startingCount: 0 },
  },
  capacity: { unstaffedShare: 0.4 },
  outage: { baseHours: 2, hoursPerOverload: 20, growthMultiplier: 0.25 },
  billing: { daysPerMonth: 30 },
};

const sim = createSim(config);
const start = () => sim.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 });

describe("newGame", () => {
  it("starts on day 1 with the configured starting cash", () => {
    const state = start();
    expect(state).toMatchObject({ day: 1, cash: 1000, productType: "ecommerce", model: "iaas", companyName: "Acme" });
  });

  it("trims the company name", () => {
    const state = sim.newGame({ companyName: "  Acme  ", productType: "social", model: "saas", seed: 1 });
    expect(state.companyName).toBe("Acme");
  });

  it.each([
    [{ companyName: "   " }, "name_required"],
    [{ companyName: "x".repeat(21) }, "name_too_long"],
    [{ productType: "crafting" }, "unknown_product_type"],
    [{ model: "faas" }, "unknown_model"],
  ])("rejects bad input %o", (override, code) => {
    const params = { companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1, ...override };
    expect(() => sim.newGame(params)).toThrow(SimError);
    expect(() => sim.newGame(params)).toThrow(expect.objectContaining({ code }));
  });

  it("produces JSON-serialisable state", () => {
    const state = start();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});

describe("advance", () => {
  it("moves exactly one day by default and charges a day's share of the model's monthly cost", () => {
    const { state, log } = sim.advance(start());
    expect(state.day).toBe(2);
    expect(state.cash).toBe(980);
    expect(log).toEqual([{ day: 2, entries: [{ text: "IaaS running costs (£600 a month)", cashDelta: -20, category: "infrastructure" }] }]);
  });

  it("advances N days with one log per day", () => {
    const { state, log } = sim.advance(start(), 5);
    expect(state.day).toBe(6);
    expect(state.cash).toBe(900);
    expect(log.map((d) => d.day)).toEqual([2, 3, 4, 5, 6]);
  });

  it("gives the same result as advancing one day at a time", () => {
    let stepwise = start();
    for (let i = 0; i < 7; i++) stepwise = sim.advance(stepwise).state;
    expect(sim.advance(start(), 7).state).toEqual(stepwise);
  });

  it("does not mutate the input state", () => {
    const before = start();
    const copy = structuredClone(before);
    sim.advance(before, 3);
    expect(before).toEqual(copy);
  });

  it("rejects zero or fractional day counts", () => {
    expect(() => sim.advance(start(), 0)).toThrow(SimError);
    expect(() => sim.advance(start(), 1.5)).toThrow(SimError);
  });

  it("is deterministic for the same seed and inputs", () => {
    expect(sim.advance(start(), 30)).toEqual(sim.advance(start(), 30));
  });

  it("resumes identically after a JSON round trip", () => {
    const saved = JSON.parse(JSON.stringify(sim.advance(start(), 10).state));
    expect(sim.advance(saved, 10).state).toEqual(sim.advance(start(), 20).state);
  });

  it("takes its numbers from the config passed in", () => {
    const pricier = createSim({ ...config, models: { ...config.models, iaas: { ...config.models.iaas, monthlyCost: 3000 } } });
    const state = pricier.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1 });
    expect(pricier.advance(state).state.cash).toBe(900);
  });
});

describe("staff", () => {
  const hire = (pool: "developers" | "ops"): Action => ({ type: "hire", pool });
  const letGo = (pool: "developers" | "ops"): Action => ({ type: "letGo", pool });
  const apply = (state = start(), ...actions: Action[]) => actions.reduce((s, a) => sim.applyAction(s, a), state);

  it("starts with the configured headcount", () => {
    const staffed = createSim({
      ...config,
      staff: {
        developers: { ...config.staff.developers, startingCount: 2 },
        ops: { ...config.staff.ops, startingCount: 1 },
      },
    });
    const state = staffed.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1 });
    expect(state).toMatchObject({ developers: 2, ops: 1 });
  });

  it("hires and lets go each pool separately", () => {
    const state = apply(start(), hire("developers"), hire("developers"), hire("ops"), letGo("developers"));
    expect(state).toMatchObject({ developers: 1, ops: 1 });
  });

  it("does not move time on or touch cash", () => {
    const state = apply(start(), hire("ops"));
    expect(state).toMatchObject({ day: 1, cash: 1000 });
  });

  it.each(["developers", "ops"] as const)("rejects letting go below zero %s", (pool) => {
    expect(() => apply(start(), letGo(pool))).toThrow(expect.objectContaining({ code: "no_staff" }));
    expect(apply(start(), hire(pool), letGo(pool))[pool]).toBe(0);
  });

  it("rejects unknown actions and pools", () => {
    expect(() => sim.applyAction(start(), { type: "promote", pool: "ops" } as unknown as Action)).toThrow(SimError);
    expect(() => sim.applyAction(start(), { type: "hire", pool: "sales" } as unknown as Action)).toThrow(
      expect.objectContaining({ code: "unknown_pool" }),
    );
  });

  it("does not mutate the input state", () => {
    const before = start();
    const copy = structuredClone(before);
    sim.applyAction(before, hire("developers"));
    expect(before).toEqual(copy);
  });

  it("charges headcount × day rate on advance, one log entry per pool", () => {
    const staffed = apply(start(), hire("developers"), hire("developers"), hire("ops"));
    expect(sim.dailyStaffCost(staffed)).toBe(2 * 7 + 3);
    const { state, log } = sim.advance(staffed);
    expect(state.cash).toBe(1000 - 20 - 14 - 3);
    expect(log[0]!.entries).toEqual([
      { text: "IaaS running costs (£600 a month)", cashDelta: -20, category: "infrastructure" },
      { text: "Developers pay (2)", cashDelta: -14, category: "staff" },
      { text: "Ops pay (1)", cashDelta: -3, category: "staff" },
    ]);
  });

  it("charges nothing for an empty pool", () => {
    expect(sim.dailyStaffCost(start())).toBe(0);
    expect(sim.advance(apply(start(), hire("ops"))).log[0]!.entries.map((e) => e.text)).toEqual([
      "IaaS running costs (£600 a month)",
      "Ops pay (1)",
    ]);
  });

  it("takes day rates from the config passed in", () => {
    const pricier = createSim({ ...config, staff: { ...config.staff, ops: { ...config.staff.ops, dayRate: 50 } } });
    const state = pricier.applyAction(
      pricier.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1 }),
      hire("ops"),
    );
    expect(pricier.advance(state).state.cash).toBe(1000 - 20 - 50);
  });

  it("reads ops needed per model from config", () => {
    expect(MODEL_IDS.map((m) => sim.opsNeeded(m))).toEqual([3, 2, 1, 0]);
  });

  it("needs fewer ops from on-prem to IaaS to PaaS, and none on SaaS, by default", () => {
    const needed = MODEL_IDS.map((m) => createSim(defaultConfig).opsNeeded(m));
    for (let i = 1; i < needed.length; i++) expect(needed[i]).toBeLessThan(needed[i - 1]!);
    expect(createSim(defaultConfig).opsNeeded("saas")).toBe(0);
  });
});

describe("state saved before staff existed (version 1)", () => {
  // A version 1 save, exactly as the server stored it before this change.
  const v1 = () =>
    JSON.parse(
      '{"version":1,"companyName":"Acme","productType":"ecommerce","model":"iaas","day":5,"cash":920,"rng":12345}',
    );

  it("loads with no staff, starting users and the current version", () => {
    expect(sim.load(v1())).toEqual({
      ...v1(),
      version: 4,
      status: "playing",
      developers: 0,
      ops: 0,
      users: 1000,
      load: 1000,
      outageDays: 0,
      downtimeHours: 0,
      spend: { staff: 0, infrastructure: 0, addons: 0 },
      spendByDay: [],
    });
  });

  it("still advances, charging only the model's running cost", () => {
    const { state } = sim.advance(v1());
    expect(state).toMatchObject({ version: 4, day: 6, cash: 900, developers: 0, ops: 0 });
  });

  it("accepts actions", () => {
    expect(sim.applyAction(v1(), { type: "hire", pool: "developers" })).toMatchObject({ version: 4, developers: 1 });
    expect(() => sim.applyAction(v1(), { type: "letGo", pool: "ops" })).toThrow(SimError);
  });
});

describe("state saved before users existed (version 2)", () => {
  const v2 = () =>
    JSON.parse(
      '{"version":2,"companyName":"Acme","productType":"video","model":"iaas","day":5,"cash":920,"rng":12345,"developers":1,"ops":2}',
    );

  it("keeps its staff and picks up with the product's starting users and full uptime", () => {
    const state = sim.load(v2());
    expect(state).toMatchObject({ version: 4, developers: 1, ops: 2, users: 1000, load: 5000, outageDays: 0 });
    expect(sim.uptime(state)).toBe(100);
  });

  it("grows users on advance", () => {
    expect(sim.advance(v2(), 5).state.users).toBeGreaterThan(1000);
  });
});

describe("users and growth", () => {
  const play = (productType: string, days: number, s = sim, seed = 42) =>
    s.advance(s.newGame({ companyName: "Acme", productType, model: "saas", seed }), days);

  it("starts with the profile's users and their load", () => {
    const state = sim.newGame({ companyName: "Acme", productType: "video", model: "saas", seed: 1 });
    expect(state).toMatchObject({ users: 1000, load: 5000 });
    expect(sim.uptime(state)).toBe(100);
  });

  it("gives each product type visibly different growth", () => {
    const users = Object.fromEntries(
      (["ecommerce", "social", "video"] as const).map((p) => [p, play(p, 60).state.users]),
    );
    // Social grows steadily fastest. E-commerce and video share a base rate, but sale spikes put e-commerce ahead.
    expect(users.social).toBeGreaterThan(users.ecommerce! * 1.5);
    expect(users.ecommerce).toBeGreaterThan(users.video! * 1.1);
  });

  it("puts heavier load per user on video", () => {
    const perUser = (p: string) => {
      const { state } = play(p, 5);
      return state.load / state.users;
    };
    expect(perUser("video")).toBeGreaterThan(perUser("social") * 3);
  });

  it("spikes e-commerce load during the season", () => {
    const loads = [9, 10].map((d) => play("ecommerce", d - 1).state.load);
    expect(loads[1]! / loads[0]!).toBeGreaterThan(2);
  });

  it("slows as users approach the market size", () => {
    const small = createSim({
      ...config,
      productTypes: {
        ...config.productTypes,
        social: { ...config.productTypes.social, growth: { ...growth, dailyGrowth: 0.06, marketSize: 1500 } },
      },
    });
    const users = play("social", 120, small).state.users;
    expect(users).toBeGreaterThan(1400);
    expect(users).toBeLessThanOrEqual(1500);
  });

  it("is deterministic for a seed and varies between seeds", () => {
    expect(play("social", 30).state.users).toBe(play("social", 30).state.users);
    expect(play("social", 30, sim, 1).state.users).not.toBe(play("social", 30, sim, 2).state.users);
  });
});

describe("capacity and outages", () => {
  const withCapacity = (capacity: number) =>
    createSim({ ...config, models: { ...config.models, saas: { ...config.models.saas, capacity } } });
  const play = (s: ReturnType<typeof createSim>, days: number) =>
    s.advance(s.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 42 }), days);

  it("has no outages while load stays under capacity", () => {
    const { state, log } = play(sim, 30);
    expect(state.outageDays).toBe(0);
    expect(sim.uptime(state)).toBe(100);
    expect(log.flatMap((d) => d.entries).some((e) => e.kind === "outage")).toBe(false);
  });

  it("has an outage on a day load is over capacity, logs it and drops uptime", () => {
    const tight = withCapacity(800);
    const { state, log } = play(tight, 1);
    expect(state.load).toBeGreaterThan(800);
    expect(state.outageDays).toBe(1);
    expect(tight.uptime(state)).toBeLessThan(100);
    expect(log[0]!.entries[0]).toMatchObject({ kind: "outage", cashDelta: 0 });
    expect(log[0]!.entries[0]!.text).toMatch(/^Outage/);
  });

  it("is down for longer the further load is over capacity", () => {
    const uptimeAt = (capacity: number) => {
      const s = withCapacity(capacity);
      return s.uptime(play(s, 1).state);
    };
    expect(uptimeAt(400)).toBeLessThan(uptimeAt(850));
  });

  it("does not charge cash for an outage yet", () => {
    expect(play(withCapacity(800), 3).state.cash).toBe(play(sim, 3).state.cash);
  });

  it("grows slower on a run with outages than without", () => {
    const outages = play(withCapacity(1000), 30).state;
    const clear = play(sim, 30).state;
    expect(outages.outageDays).toBeGreaterThan(0);
    expect(outages.users).toBeLessThan(clear.users);
  });

  it("is deterministic for the same seed", () => {
    expect(play(withCapacity(1000), 30)).toEqual(play(withCapacity(1000), 30));
  });

  it("takes capacity from the model when fully staffed", () => {
    const opsFor = (model: (typeof MODEL_IDS)[number]) => {
      let state = sim.newGame({ companyName: "Acme", productType: "social", model, seed: 1 });
      for (let i = 0; i < sim.opsNeeded(model); i++) state = sim.applyAction(state, { type: "hire", pool: "ops" });
      return sim.capacity(state);
    };
    expect(MODEL_IDS.map(opsFor)).toEqual([1_000_000, 1_000_000, 1_000_000, 1_000_000]);
  });

  it("loses capacity with fewer ops than needed on models that need ops, but not on SaaS", () => {
    for (const model of MODEL_IDS) {
      const unstaffed = sim.newGame({ companyName: "Acme", productType: "social", model, seed: 1 });
      const staffed = { ...unstaffed, ops: sim.opsNeeded(model) };
      if (sim.opsNeeded(model) > 0) {
        expect(sim.capacity(unstaffed)).toBeLessThan(sim.capacity(staffed));
        // Each extra ops person restores some capacity.
        const one = sim.applyAction(unstaffed, { type: "hire", pool: "ops" });
        expect(sim.capacity(one)).toBeGreaterThan(sim.capacity(unstaffed));
        expect(sim.capacity(one)).toBeLessThanOrEqual(sim.capacity(staffed));
      } else {
        expect(sim.capacity(unstaffed)).toBe(sim.capacity(staffed));
      }
    }
  });

  it("does not add capacity beyond full staffing", () => {
    const state = sim.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 1 });
    expect(sim.capacity({ ...state, ops: 10 })).toBe(sim.capacity({ ...state, ops: 2 }));
  });

  it("causes outages when understaffed that full staffing avoids", () => {
    const s = createSim({ ...config, models: { ...config.models, iaas: { ...config.models.iaas, capacity: 3000 } } });
    const start = s.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 42 });
    const staffed = { ...start, ops: 2 };
    expect(s.advance(start, 10).state.outageDays).toBeGreaterThan(0);
    expect(s.advance(staffed, 10).state.outageDays).toBe(0);
  });
});

describe("ledger", () => {
  const withModel = (model: Partial<GameConfig["models"]["iaas"]>, base = config) =>
    createSim({ ...base, models: { ...base.models, iaas: { ...base.models.iaas, ...model } } });
  const startOn = (s: ReturnType<typeof createSim>, productType = "ecommerce") =>
    s.newGame({ companyName: "Acme", productType, model: "iaas", seed: 42 });
  const charges = (log: { entries: LogEntry[] }[]) => log.flatMap((d) => d.entries).filter((e) => e.category);

  it("charges the model's upfront cost once, at the start", () => {
    const s = withModel({ upfrontCost: 400 });
    const state = startOn(s);
    expect(state).toMatchObject({ day: 1, cash: 600, spend: { staff: 0, infrastructure: 400, addons: 0 } });
    const { state: later, log } = s.advance(state, 10);
    expect(later.cash).toBe(600 - 10 * 20);
    expect(charges(log).some((e) => e.text.startsWith("Upfront"))).toBe(false);
  });

  it("charges each model its own upfront cost", () => {
    const s = createSim({
      ...config,
      models: {
        ...config.models,
        onprem: { ...config.models.onprem, upfrontCost: 900 },
        saas: { ...config.models.saas, upfrontCost: 10 },
      },
    });
    const cashOn = (model: string) => s.newGame({ companyName: "Acme", productType: "social", model, seed: 1 }).cash;
    expect(cashOn("onprem")).toBe(100);
    expect(cashOn("saas")).toBe(990);
    expect(cashOn("iaas")).toBe(1000);
  });

  it("bills a day's share of the monthly cost every day, so a month of days bills the monthly cost", () => {
    const s = withModel({ monthlyCost: 300 });
    const { state, log } = s.advance(startOn(s), 30);
    expect(state.cash).toBe(700);
    expect(log.every((d) => d.entries.some((e) => e.cashDelta === -10 && e.category === "infrastructure"))).toBe(true);
  });

  it("rounds each day's share to the pound", () => {
    const s = withModel({ monthlyCost: 100 });
    expect(s.advance(startOn(s)).log[0]!.entries).toEqual([
      { text: "IaaS running costs (£100 a month)", cashDelta: -3, category: "infrastructure" },
    ]);
  });

  it("bills per user on that day's users where the model charges per user", () => {
    const s = withModel({ monthlyCost: 0, monthlyCostPerUser: 0.3 });
    const state = startOn(s);
    expect(s.monthlyInfrastructureCost(state)).toBe(300);
    const first = s.advance(state);
    expect(first.log[0]!.entries).toEqual([
      { text: "IaaS per-user fee (1,000 users at £0.30 a month)", cashDelta: -10, category: "infrastructure" },
    ]);
    // Later days charge more as users grow.
    const later = s.advance(first.state, 30);
    const fees = charges(later.log).map((e) => -e.cashDelta);
    expect(later.state.users).toBeGreaterThan(state.users);
    expect(fees.at(-1)).toBeGreaterThan(fees[0]!);
  });

  it("tags every charge with a category", () => {
    let state = sim.applyAction(start(), { type: "hire", pool: "developers" });
    const { log } = sim.advance(state, 5);
    for (const e of log.flatMap((d) => d.entries)) {
      if (e.cashDelta !== 0) expect(SPEND_CATEGORIES).toContain(e.category);
    }
    state = sim.advance(state, 5).state;
    expect(state.spend.staff).toBeGreaterThan(0);
    expect(state.spend.infrastructure).toBeGreaterThan(0);
  });

  it("keeps category totals equal to the sum of the tagged log entries", () => {
    const s = withModel({ upfrontCost: 50, monthlyCostPerUser: 0.1 });
    const opening = startOn(s);
    const hired = s.applyAction(s.applyAction(opening, { type: "hire", pool: "developers" }), { type: "hire", pool: "ops" });
    const { state, log } = s.advance(hired, 20);
    for (const c of SPEND_CATEGORIES) {
      const logged = charges(log)
        .filter((e) => e.category === c)
        .reduce((sum, e) => sum - e.cashDelta, 0);
      expect(state.spend[c] - opening.spend[c]).toBe(logged);
    }
    expect(state.spend.addons).toBe(0);
    // Cash is starting cash less everything spent.
    expect(state.cash).toBe(1000 - SPEND_CATEGORIES.reduce((sum, c) => sum + state.spend[c], 0));
  });

  it("records spend for every day, day 1 first, adding up to the totals", () => {
    const s = withModel({ upfrontCost: 50 });
    const { state } = s.advance(s.applyAction(startOn(s), { type: "hire", pool: "ops" }), 4);
    expect(state.spendByDay).toEqual([
      { day: 1, staff: 0, infrastructure: 50, addons: 0 },
      ...[2, 3, 4, 5].map((day) => ({ day, staff: 3, infrastructure: 20, addons: 0 })),
    ]);
    for (const c of SPEND_CATEGORIES) {
      expect(state.spendByDay.reduce((sum, d) => sum + d[c], 0)).toBe(state.spend[c]);
    }
  });

  it("is deterministic for the same seed and actions", () => {
    const s = withModel({ upfrontCost: 50, monthlyCostPerUser: 0.2 });
    const play = () => s.advance(s.applyAction(startOn(s, "social"), { type: "hire", pool: "developers" }), 40);
    expect(play()).toEqual(play());
  });
});

describe("bankruptcy", () => {
  // 1000 cash at 20 a day on IaaS: day 51 leaves exactly 0, day 52 goes below.
  const broke = () => sim.advance(start(), 50);

  it("does not end the game at exactly zero cash", () => {
    const { state } = broke();
    expect(state).toMatchObject({ day: 51, cash: 0, status: "playing" });
  });

  it("ends the game the day cash goes below zero, and says so in the log", () => {
    const { state, log } = sim.advance(broke().state);
    expect(state).toMatchObject({ day: 52, cash: -20, status: "bankrupt" });
    expect(log[0]!.entries.at(-1)).toMatchObject({ kind: "bankrupt", cashDelta: 0 });
    expect(log[0]!.entries.at(-1)!.text).toMatch(/bankrupt/);
  });

  it("stops a multi-day advance on the day of bankruptcy", () => {
    const { state, log } = sim.advance(start(), 100);
    expect(state).toMatchObject({ day: 52, status: "bankrupt" });
    expect(log.at(-1)!.day).toBe(52);
  });

  it("rejects advances and actions afterwards", () => {
    const { state } = sim.advance(start(), 100);
    for (const attempt of [
      () => sim.advance(state),
      () => sim.applyAction(state, { type: "hire", pool: "ops" }),
      () => sim.applyAction(state, { type: "letGo", pool: "ops" }),
    ]) {
      expect(attempt).toThrow(SimError);
      expect(attempt).toThrow(expect.objectContaining({ code: "bankrupt" }));
    }
  });

  it("goes bankrupt sooner with more staff", () => {
    const hired = sim.applyAction(start(), { type: "hire", pool: "developers" });
    expect(sim.advance(hired, 100).state.day).toBeLessThan(sim.advance(start(), 100).state.day);
  });

  it("is deterministic", () => {
    expect(sim.advance(start(), 100)).toEqual(sim.advance(start(), 100));
  });

  it("starts bankrupt if the upfront cost is more than the starting cash", () => {
    const s = createSim({ ...config, models: { ...config.models, iaas: { ...config.models.iaas, upfrontCost: 1001 } } });
    const state = s.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 1 });
    expect(state).toMatchObject({ cash: -1, status: "bankrupt" });
    expect(() => s.advance(state)).toThrow(expect.objectContaining({ code: "bankrupt" }));
  });
});

describe("state saved before the ledger existed (version 3)", () => {
  const v3 = (cash = 920) => ({ ...JSON.parse(JSON.stringify(start())), version: 3, day: 5, cash }) as Record<string, unknown>;
  const withoutLedger = (state: Record<string, unknown>) => {
    const { status: _s, spend: _sp, spendByDay: _d, ...rest } = state;
    return rest as unknown as Parameters<typeof sim.load>[0];
  };

  it("keeps playing with spend counted from now on", () => {
    const state = sim.load(withoutLedger(v3()));
    expect(state).toMatchObject({ version: 4, status: "playing", day: 5, cash: 920, spendByDay: [] });
    expect(state.spend).toEqual({ staff: 0, infrastructure: 0, addons: 0 });
    expect(sim.advance(state).state).toMatchObject({ cash: 900, spend: { infrastructure: 20 } });
  });

  it("loads a game already in debt as bankrupt", () => {
    const saved = withoutLedger(v3(-50));
    expect(sim.load(saved).status).toBe("bankrupt");
    expect(() => sim.advance(saved)).toThrow(SimError);
  });
});

describe("default config", () => {
  const sim180 = createSim(defaultConfig);
  const run = (productType: string, model: string, ops?: number) => {
    const start = sim180.newGame({ companyName: "Acme", productType, model, seed: 7 });
    return sim180.advance(ops === undefined ? start : { ...start, ops }, defaultConfig.finalDay - 1).state;
  };

  it("lets every product reach day 180 without outages when fully staffed on IaaS", () => {
    for (const p of ["ecommerce", "social", "video"]) {
      const state = run(p, "iaas", sim180.opsNeeded("iaas"));
      expect(state.outageDays).toBe(0);
      expect(state.users).toBeGreaterThan(defaultConfig.productTypes[p as "social"].growth.startingUsers * 5);
    }
  });

  it("makes outages possible when understaffed", () => {
    expect(run("video", "iaas", 1).outageDays).toBeGreaterThan(0);
  });

  it("lets every model and product reach day 180 with starting developers and the ops it needs", () => {
    for (const model of MODEL_IDS) {
      for (const p of ["ecommerce", "social", "video"]) {
        const state = run(p, model, sim180.opsNeeded(model));
        expect(state).toMatchObject({ day: defaultConfig.finalDay, status: "playing" });
      }
    }
  });

  it("bankrupts a company that hires far more than it needs", () => {
    const start = sim180.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 7 });
    const state = sim180.advance({ ...start, developers: 12, ops: 2 }, defaultConfig.finalDay - 1).state;
    expect(state.status).toBe("bankrupt");
    expect(state.day).toBeLessThan(defaultConfig.finalDay);
  });

  it("makes on-prem's upfront cost the highest, and only SaaS charge per user", () => {
    const upfront = (m: (typeof MODEL_IDS)[number]) => defaultConfig.models[m].upfrontCost;
    for (const m of ["iaas", "paas", "saas"] as const) expect(upfront("onprem")).toBeGreaterThan(upfront(m) * 10);
    expect(MODEL_IDS.filter((m) => defaultConfig.models[m].monthlyCostPerUser > 0)).toEqual(["saas"]);
  });
});
