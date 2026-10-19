import { describe, expect, it } from "vitest";
import { createSim, defaultConfig, MODEL_IDS, SimError, type Action, type GameConfig } from "../src/index.ts";

const comparison = { upfrontCost: "", monthlyCost: "", opsNeeded: "", control: "" };
const growth = {
  startingUsers: 1000,
  marketSize: 1_000_000,
  dailyGrowth: 0.03,
  growthNoise: 0.2,
  loadPerUser: 1,
  loadNoise: 0.1,
};

const config: GameConfig = {
  startingCash: 1000,
  finalDay: 180,
  maxCompanyNameLength: 20,
  // Capacity far above any load here, so outages only happen where a test lowers it.
  models: {
    onprem: { name: "On-prem", blurb: "", comparison, dailyCost: 10, opsNeeded: 3, capacity: 1_000_000 },
    iaas: { name: "IaaS", blurb: "", comparison, dailyCost: 20, opsNeeded: 2, capacity: 1_000_000 },
    paas: { name: "PaaS", blurb: "", comparison, dailyCost: 30, opsNeeded: 1, capacity: 1_000_000 },
    saas: { name: "SaaS", blurb: "", comparison, dailyCost: 5, opsNeeded: 0, capacity: 1_000_000 },
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
  it("moves exactly one day by default and charges the model's daily cost", () => {
    const { state, log } = sim.advance(start());
    expect(state.day).toBe(2);
    expect(state.cash).toBe(980);
    expect(log).toEqual([{ day: 2, entries: [{ text: "IaaS running costs", cashDelta: -20 }] }]);
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
    const pricier = createSim({ ...config, models: { ...config.models, iaas: { ...config.models.iaas, dailyCost: 100 } } });
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
      { text: "IaaS running costs", cashDelta: -20 },
      { text: "Developers pay (2)", cashDelta: -14 },
      { text: "Ops pay (1)", cashDelta: -3 },
    ]);
  });

  it("charges nothing for an empty pool", () => {
    expect(sim.dailyStaffCost(start())).toBe(0);
    expect(sim.advance(apply(start(), hire("ops"))).log[0]!.entries.map((e) => e.text)).toEqual([
      "IaaS running costs",
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
      version: 3,
      developers: 0,
      ops: 0,
      users: 1000,
      load: 1000,
      outageDays: 0,
      downtimeHours: 0,
    });
  });

  it("still advances, charging only the model's running cost", () => {
    const { state } = sim.advance(v1());
    expect(state).toMatchObject({ version: 3, day: 6, cash: 900, developers: 0, ops: 0 });
  });

  it("accepts actions", () => {
    expect(sim.applyAction(v1(), { type: "hire", pool: "developers" })).toMatchObject({ version: 3, developers: 1 });
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
    expect(state).toMatchObject({ version: 3, developers: 1, ops: 2, users: 1000, load: 5000, outageDays: 0 });
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
});
