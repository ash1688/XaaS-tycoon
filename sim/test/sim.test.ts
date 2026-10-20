import { describe, expect, it } from "vitest";
import {
  createSim,
  defaultConfig,
  GAME_STATE_VERSION,
  MODEL_IDS,
  PRODUCT_TYPE_IDS,
  responsibilityStack,
  SERVER_SIZES,
  SERVER_TYPES,
  SPEND_CATEGORIES,
  SimError,
  type Action,
  type DayLog,
  type EventConfig,
  type GameConfig,
  type GameState,
  type LogEntry,
  type ModelId,
  type ServerSize,
  type ServerType,
  type Sim,
  type StaffPool,
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

// Small costs and a big growth boost, so builds finish quickly and their effect is easy to see.
// Add-on prices are per user per month: 1,000 users at £0.30 is £300 a month, £10 a day.
const features = [
  { id: "checkout", name: "Checkout", blurb: "", devDays: 6, growthMultiplier: 1.5, addonPricePerUser: 0.3 },
  { id: "reviews", name: "Reviews", blurb: "", devDays: 5, growthMultiplier: 1.2, addonPricePerUser: 0.15 },
  { id: "search", name: "Search", blurb: "", devDays: 4, growthMultiplier: 1.1, addonPricePerUser: 0.06 },
];

// Everyone free unless a test says otherwise, and none converting, so income only shows up where a test looks for it.
const pricing = { fairPrice: 30, freeShare: 1, conversionRate: 0 };
// No tickets unless a test says otherwise, so satisfaction stays at 100% and never touches growth.
const support = { ticketsPerPaidUser: 0, ticketsPerFreeUser: 0 };

// Units 10 a CU and DBU at 1,000 users, so a massive server serves 1,000,000: the starter setup never runs out unless a
// test makes it. Video needs five times the compute, like its load.
const demand = { cuPerUser: 0.01, dbuPerUser: 0.01 };
const sizes = (small: number, medium: number, large: number, massive: number) => ({ small, medium, large, massive });
// Rent a month: £30 small, £60 medium, £90 large (£1, £2 and £3 a day). Massive is free, so the starter setup costs
// nothing and IaaS bills only its flat monthly cost unless a test rents more.
const rent = () => sizes(30, 60, 90, 0);
const iaasServers = {
  monthlyCost: { app: rent(), database: rent(), cache: rent(), loadBalancer: rent() },
  readyDays: 1,
  opsPerServer: { app: 1, database: 1, cache: 0.5, loadBalancer: 0.5 },
  starter: [
    { type: "app" as const, size: "massive" as const, count: 1 },
    { type: "database" as const, size: "massive" as const, count: 1 },
  ],
};

function costs(monthlyCost: number) {
  return { upfrontCost: 0, monthlyCost, monthlyCostPerUser: 0, exitPenalty: 0 };
}

function noWaves() {
  return {
    waveDays: 7,
    lockDays: 14,
    firstDayShare: 0.05,
    waveCurve: 1.5,
    riseStrength: 0,
    dearness: 1,
    maxRiseShare: 0.9,
    dropToFreeShare: 0.4,
    backlashTicketsPerUser: 1,
    cutGainStrength: 0,
    maxCutGain: 0.5,
    cutUpgradeStrength: 0,
    maxCutUpgrade: 0.5,
  };
}

const config: GameConfig = {
  startingCash: 1000,
  finalDay: 180,
  maxCompanyNameLength: 20,
  // Capacity far above any load here, so outages only happen where a test lowers it.
  // No upfront or per-user costs, so each model costs a flat monthly ÷ 30 a day unless a test adds them.
  models: {
    onprem: { name: "On-prem", blurb: "", comparison, ...costs(300), opsNeeded: 3, capacity: 1_000_000 },
    // IaaS rents VMs: its capacity and ops needed come from its servers.
    iaas: { name: "IaaS", blurb: "", comparison, ...costs(600), servers: iaasServers },
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
      demand,
      pricing,
      support,
      features,
    },
    social: { name: "Social", profile: "", growth: { ...growth, dailyGrowth: 0.06 }, demand, pricing, support, features },
    video: {
      name: "Video",
      profile: "",
      growth: { ...growth, dailyGrowth: 0.02, loadPerUser: 5 },
      demand: { cuPerUser: 0.05, dbuPerUser: 0.01 },
      pricing,
      support,
      features,
    },
  },
  // No starting staff, so the model's running cost is the only charge unless a test hires someone.
  staff: {
    developers: { name: "Developers", personName: "developer", dayRate: 7, startingCount: 0 },
    ops: { name: "Ops", personName: "ops person", dayRate: 3, startingCount: 0 },
    support: { name: "Support", personName: "support person", dayRate: 2, startingCount: 0 },
  },
  capacity: { unstaffedShare: 0.4 },
  servers: {
    types: {
      app: { name: "App server", blurb: "", units: sizes(10, 100, 1_000, 10_000) },
      database: { name: "Database", blurb: "", units: sizes(10, 100, 1_000, 10_000) },
      cache: { name: "Cache", blurb: "", units: sizes(10, 100, 1_000, 10_000) },
      loadBalancer: { name: "Load balancer", blurb: "", units: sizes(2, 4, 8, 16) },
    },
    loadBalancerFrom: 2,
    cacheableShare: 0.5,
  },
  outage: { baseHours: 2, hoursPerOverload: 20, growthMultiplier: 0.25 },
  billing: { daysPerMonth: 30 },
  // No price waves unless a test says otherwise, so a price change only has its ongoing effect on growth and payers.
  pricing: {
    maxPrice: 1_000,
    growthSensitivity: 1,
    maxGrowthBoost: 2,
    paidShareSensitivity: 1,
    ...noWaves(),
  },
  support: {
    ticketsPerPerson: 10,
    ticketsPerUserPerHourDown: 0.01,
    bigBurstShare: 0.5,
    backlogPerUserAtZero: 0.05,
    satisfactionSpeed: 0.2,
    goodSatisfaction: 70,
    poorSatisfaction: 40,
    growthAtZero: 0.3,
    churnAtZero: 0.02,
  },
  // Conversion at its default strengths, but every product's base rate is 0 unless a test sets one.
  conversion: { ...defaultConfig.conversion },
  addons: { minConfigDevelopers: 1 },
  migration: {
    phases: {
      planning: { name: "Planning", days: 5 },
      testing: { name: "Testing", days: 2 },
      moving: { name: "Moving infrastructure", days: 7 },
    },
    billNewFromStart: true,
    // Never overruns unless a test says so.
    overrun: { chance: 0, minDays: 2, maxDays: 4 },
  },
  // No scripted events unless a test adds some.
  events: [],
};

const sim = createSim(config);

/**
 * A config whose IaaS starter app server carries this much load at 1 a user: its CU is load ÷ 100, at 0.01 CU a user.
 * The database stays far bigger, so compute is the tier that runs out.
 */
const iaasCapacity = (load: number, base: GameConfig = config): GameConfig => {
  const app = base.servers.types.app;
  return {
    ...base,
    servers: { ...base.servers, types: { ...base.servers.types, app: { ...app, units: { ...app.units, massive: load / 100 } } } },
  };
};

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

describe("games from an older version", () => {
  // A game saved by the alpha, before the clean break. Old games are refused, not upgraded.
  const old = () => ({ ...JSON.parse(JSON.stringify(start())), version: GAME_STATE_VERSION - 1 }) as GameState;

  it("are refused by every method that takes saved state", () => {
    for (const attempt of [
      () => sim.load(old()),
      () => sim.advance(old()),
      () => sim.applyAction(old(), { type: "hire", pool: "developers" }),
      () => sim.migrationQuote(old(), "paas"),
      () => sim.summarise(old()),
      () => sim.capacity(old()),
      () => sim.features(old()),
    ]) {
      expect(attempt).toThrow(SimError);
      expect(attempt).toThrow(expect.objectContaining({ code: "old_version" }));
      expect(attempt).toThrow(/older version/);
    }
  });

  it("are refused when the saved state isn't a game at all", () => {
    for (const saved of [null, "state", 9, {}, { version: "9" }]) {
      expect(() => sim.load(saved)).toThrow(expect.objectContaining({ code: "old_version" }));
    }
  });

  it("while a game from this version loads as it was saved", () => {
    const state = JSON.parse(JSON.stringify(start()));
    expect(sim.load(state)).toEqual(start());
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
  const hire = (pool: StaffPool): Action => ({ type: "hire", pool });
  const letGo = (pool: StaffPool): Action => ({ type: "letGo", pool });
  const apply = (state = start(), ...actions: Action[]) => actions.reduce((s, a) => sim.applyAction(s, a), state);

  it("starts with the configured headcount", () => {
    const staffed = createSim({
      ...config,
      staff: {
        developers: { ...config.staff.developers, startingCount: 2 },
        ops: { ...config.staff.ops, startingCount: 1 },
        support: { ...config.staff.support, startingCount: 3 },
      },
    });
    const state = staffed.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1 });
    expect(state).toMatchObject({ developers: 2, ops: 1, support: 3 });
  });

  it("hires and lets go each pool separately", () => {
    const state = apply(start(), hire("developers"), hire("developers"), hire("ops"), hire("support"), letGo("developers"));
    expect(state).toMatchObject({ developers: 1, ops: 1, support: 1 });
  });

  it("does not move time on or touch cash", () => {
    const state = apply(start(), hire("ops"));
    expect(state).toMatchObject({ day: 1, cash: 1000 });
  });

  it.each(["developers", "ops", "support"] as const)("rejects letting go below zero %s", (pool) => {
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
    const staffed = apply(start(), hire("developers"), hire("developers"), hire("ops"), hire("support"));
    expect(sim.dailyStaffCost(staffed)).toBe(2 * 7 + 3 + 2);
    const { state, log } = sim.advance(staffed);
    expect(state.cash).toBe(1000 - 20 - 14 - 3 - 2);
    expect(log[0]!.entries).toEqual([
      { text: "IaaS running costs (£600 a month)", cashDelta: -20, category: "infrastructure" },
      { text: "Developers pay (2)", cashDelta: -14, category: "staff" },
      { text: "Ops pay (1)", cashDelta: -3, category: "staff" },
      { text: "Support pay (1)", cashDelta: -2, category: "staff" },
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

  it("needs fewer ops on IaaS's starter VMs than on-prem, and none on SaaS, by default", () => {
    const needed = MODEL_IDS.map((m) => createSim(defaultConfig).opsNeeded(m));
    expect(needed[1]).toBeLessThan(needed[0]!);
    expect(needed[2]).toBeLessThanOrEqual(needed[1]!);
    expect(needed[2]).toBeGreaterThan(0);
    expect(createSim(defaultConfig).opsNeeded("saas")).toBe(0);
  });
});

describe("features", () => {
  const build = (feature: string): Action => ({ type: "buildFeature", feature });
  const startOn = (model = "iaas", developers = 1) => ({
    ...sim.newGame({ companyName: "Acme", productType: "social", model, seed: 42 }),
    developers,
  });
  const feature = (state: Parameters<typeof sim.features>[0], id: string) => sim.features(state).find((f) => f.id === id)!;

  it("lists the product's features from config, none started", () => {
    expect(sim.features(startOn())).toEqual(
      features.map((f) => ({ ...f, status: "notStarted", progress: 0, daysLeft: null })),
    );
  });

  it("starts a build without moving time on or touching cash", () => {
    const state = sim.applyAction(startOn(), build("checkout"));
    expect(state).toMatchObject({ day: 1, cash: 1000 });
    expect(feature(state, "checkout")).toMatchObject({ status: "building", progress: 0, daysLeft: 6 });
  });

  it.each([1, 2, 3])("makes a day's progress equal to the developers (%i)", (developers) => {
    const { state } = sim.advance(sim.applyAction(startOn("iaas", developers), build("checkout")));
    expect(feature(state, "checkout")).toMatchObject({ status: "building", progress: developers });
  });

  it("completes after exactly its developer-day cost", () => {
    const building = sim.applyAction(startOn("iaas", 1), build("checkout"));
    expect(feature(sim.advance(building, 5).state, "checkout")).toMatchObject({ status: "building", progress: 5 });
    const { state, log } = sim.advance(building, 6);
    expect(feature(state, "checkout")).toMatchObject({ status: "built", progress: 6, daysLeft: null });
    expect(log.at(-1)!.entries[0]).toEqual({
      text: "Feature built: Checkout. Growth up 50% from now on.",
      cashDelta: 0,
      kind: "feature",
    });
  });

  it("finishes sooner with more developers, without counting work past the cost", () => {
    const building = sim.applyAction(startOn("iaas", 4), build("checkout"));
    expect(feature(building, "checkout").daysLeft).toBe(2);
    expect(feature(sim.advance(building, 2).state, "checkout")).toMatchObject({ status: "built", progress: 6 });
  });

  it("logs progress each day, and makes none with no developers", () => {
    const { log } = sim.advance(sim.applyAction(startOn("iaas", 2), build("checkout")));
    expect(log[0]!.entries[0]).toEqual({
      text: "Building Checkout: 2 of 6 developer-days done.",
      cashDelta: 0,
      kind: "feature",
    });
    const idle = sim.advance(sim.applyAction(startOn("iaas", 0), build("checkout")));
    expect(feature(idle.state, "checkout")).toMatchObject({ status: "building", progress: 0, daysLeft: null });
    expect(idle.log[0]!.entries[0]!.text).toContain("no developers");
  });

  it.each(["onprem", "iaas", "paas"])("can be built on %s", (model) => {
    const { state } = sim.advance(sim.applyAction(startOn(model, 6), build("checkout")));
    expect(feature(state, "checkout").status).toBe("built");
  });

  it("rejects a build on SaaS, where features are add-ons", () => {
    expect(() => sim.applyAction(startOn("saas"), build("checkout"))).toThrow(
      expect.objectContaining({ code: "saas_features" }),
    );
  });

  it("rejects a feature already built or being built", () => {
    const building = sim.applyAction(startOn("iaas", 6), build("checkout"));
    expect(() => sim.applyAction(building, build("checkout"))).toThrow(
      expect.objectContaining({ code: "feature_building" }),
    );
    const built = sim.advance(building).state;
    expect(() => sim.applyAction(built, build("checkout"))).toThrow(expect.objectContaining({ code: "feature_built" }));
  });

  it("rejects a feature not on the product's list", () => {
    for (const id of ["teleport", "toString", ""]) {
      expect(() => sim.applyAction(startOn(), build(id))).toThrow(expect.objectContaining({ code: "unknown_feature" }));
    }
  });

  it("builds one feature at a time", () => {
    const building = sim.applyAction(startOn("iaas", 1), build("checkout"));
    expect(() => sim.applyAction(building, build("reviews"))).toThrow(
      expect.objectContaining({ code: "build_in_progress" }),
    );
    const built = sim.advance(building, 6).state;
    expect(feature(sim.applyAction(built, build("reviews")), "reviews").status).toBe("building");
  });

  it("raises growth once built, compared with the same run without it", () => {
    const base = startOn("iaas", 6);
    const withFeature = sim.advance(sim.applyAction(base, build("checkout")), 30).state;
    const without = sim.advance(base, 30).state;
    expect(feature(withFeature, "checkout").status).toBe("built");
    expect(withFeature.users).toBeGreaterThan(without.users);
    // The same seed and days, so the build is the only difference: growth is the same until it's done.
    expect(sim.advance(sim.applyAction(base, build("checkout")), 1).state.users).toBe(sim.advance(base, 1).state.users);
  });

  it("takes each feature's growth boost from config", () => {
    const weaker = createSim({
      ...config,
      productTypes: {
        ...config.productTypes,
        social: { ...config.productTypes.social, features: [{ ...features[0]!, growthMultiplier: 1.1 }] },
      },
    });
    const play = (s: ReturnType<typeof createSim>) => {
      const base = { ...s.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 42 }), developers: 6 };
      return s.advance(s.applyAction(base, build("checkout")), 30).state.users;
    };
    expect(play(sim)).toBeGreaterThan(play(weaker));
  });

  it("does not mutate the input state", () => {
    const before = startOn();
    const copy = structuredClone(before);
    sim.advance(sim.applyAction(before, build("checkout")), 3);
    expect(before).toEqual(copy);
  });

  it("is deterministic", () => {
    const run = () => sim.advance(sim.applyAction(startOn("iaas", 2), build("checkout")), 30);
    expect(run()).toEqual(run());
  });

  it("resumes a build identically after a JSON round trip", () => {
    const building = sim.applyAction(startOn("iaas", 1), build("checkout"));
    const saved = JSON.parse(JSON.stringify(sim.advance(building, 3).state));
    expect(sim.advance(saved, 10).state).toEqual(sim.advance(building, 13).state);
  });
});

describe("SaaS add-ons", () => {
  const buy = (feature: string): Action => ({ type: "buyAddon", feature });
  const startOn = (model = "saas", developers = 1) => ({
    ...sim.newGame({ companyName: "Acme", productType: "social", model, seed: 42 }),
    developers,
  });
  const feature = (state: Parameters<typeof sim.features>[0], id: string) => sim.features(state).find((f) => f.id === id)!;
  const addonCharges = (log: { entries: LogEntry[] }[]) =>
    log.map((d) => d.entries.filter((e) => e.category === "addons").reduce((sum, e) => sum - e.cashDelta, 0));

  it("makes the feature active at once, without moving time on or touching cash", () => {
    const state = sim.applyAction(startOn(), buy("checkout"));
    expect(state).toMatchObject({ day: 1, cash: 1000 });
    expect(feature(state, "checkout")).toMatchObject({ status: "addon", progress: 0, daysLeft: null });
  });

  it("raises growth from the very next day, unlike a build", () => {
    const base = startOn();
    const withAddon = sim.advance(sim.applyAction(base, buy("checkout"))).state;
    expect(withAddon.users).toBeGreaterThan(sim.advance(base).state.users);
  });

  it.each(["onprem", "iaas", "paas"])("is rejected on %s, where features are built", (model) => {
    expect(() => sim.applyAction(startOn(model), buy("checkout"))).toThrow(
      expect.objectContaining({ code: "not_saas" }),
    );
  });

  it("rejects an add-on already active", () => {
    const bought = sim.applyAction(startOn(), buy("checkout"));
    expect(() => sim.applyAction(bought, buy("checkout"))).toThrow(expect.objectContaining({ code: "addon_active" }));
  });

  it("rejects a feature not on the product's list", () => {
    for (const id of ["teleport", "toString", ""]) {
      expect(() => sim.applyAction(startOn(), buy(id))).toThrow(expect.objectContaining({ code: "unknown_feature" }));
    }
  });

  it("can buy several at once, with no waiting for builds", () => {
    let state = startOn();
    for (const f of features) state = sim.applyAction(state, buy(f.id));
    expect(sim.features(state).map((f) => f.status)).toEqual(["addon", "addon", "addon"]);
  });

  it("needs the configuration team from config to buy one", () => {
    const strict = createSim({ ...config, addons: { minConfigDevelopers: 2 } });
    const state = (developers: number) => ({
      ...strict.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 42 }),
      developers,
    });
    for (const developers of [0, 1]) {
      expect(() => strict.applyAction(state(developers), buy("checkout"))).toThrow(
        expect.objectContaining({ code: "config_team", message: expect.stringContaining("at least 2 developers") }),
      );
    }
    expect(strict.features(strict.applyAction(state(2), buy("checkout")))[0]!.status).toBe("addon");
  });

  it("keeps add-ons already bought working if the team shrinks later", () => {
    const bought = sim.applyAction(startOn(), buy("checkout"));
    const after = sim.advance(sim.applyAction(bought, { type: "letGo", pool: "developers" }), 5);
    expect(feature(after.state, "checkout").status).toBe("addon");
    expect(addonCharges(after.log).every((c) => c > 0)).toBe(true);
  });

  it("bills each add-on per user per month, a day at a time, tagged add-ons", () => {
    const state = sim.applyAction(sim.applyAction(startOn(), buy("checkout")), buy("reviews"));
    expect(sim.monthlyAddonCost(state)).toBe(450);
    const charges = sim.advance(state).log[0]!.entries.filter((e) => e.category === "addons");
    expect(charges).toEqual([
      { text: "Add-on: Checkout (1,000 users at £0.30 a month)", cashDelta: -10, category: "addons" },
      { text: "Add-on: Reviews (1,000 users at £0.15 a month)", cashDelta: -5, category: "addons" },
    ]);
  });

  it("charges nothing for add-ons until one is bought", () => {
    const { state, log } = sim.advance(startOn(), 10);
    expect(sim.monthlyAddonCost(state)).toBe(0);
    expect(state.spend.addons).toBe(0);
    expect(addonCharges(log).every((c) => c === 0)).toBe(true);
  });

  it("grows the add-on bill as users grow", () => {
    const state = sim.applyAction(startOn(), buy("checkout"));
    const { state: later, log } = sim.advance(state, 40);
    const daily = addonCharges(log);
    expect(later.users).toBeGreaterThan(state.users * 2);
    expect(daily.at(-1)).toBeGreaterThan(daily[0]! * 2);
    expect(sim.monthlyAddonCost(later)).toBeGreaterThan(sim.monthlyAddonCost(state) * 2);
  });

  it("keeps category totals equal to the tagged log entries and the cash spent", () => {
    const opening = sim.applyAction(sim.applyAction(startOn(), buy("checkout")), { type: "hire", pool: "developers" });
    const { state, log } = sim.advance(opening, 20);
    expect(state.spend.addons).toBeGreaterThan(0);
    for (const c of SPEND_CATEGORIES) {
      const logged = log
        .flatMap((d) => d.entries)
        .filter((e) => e.category === c)
        .reduce((sum, e) => sum - e.cashDelta, 0);
      expect(state.spend[c] - opening.spend[c]).toBe(logged);
      expect(state.spendByDay.reduce((sum, d) => sum + d[c], 0)).toBe(state.spend[c]);
    }
    expect(state.cash).toBe(1000 - SPEND_CATEGORIES.reduce((sum, c) => sum + state.spend[c], 0));
  });

  it("is deterministic and resumes identically after a JSON round trip", () => {
    const run = () => sim.advance(sim.applyAction(startOn(), buy("reviews")), 30);
    expect(run()).toEqual(run());
    const bought = sim.applyAction(startOn(), buy("reviews"));
    const saved = JSON.parse(JSON.stringify(sim.advance(bought, 3).state));
    expect(sim.advance(saved, 10).state).toEqual(sim.advance(bought, 13).state);
  });

  it("does not mutate the input state", () => {
    const before = startOn();
    const copy = structuredClone(before);
    sim.advance(sim.applyAction(before, buy("checkout")), 3);
    expect(before).toEqual(copy);
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
    const s = createSim(iaasCapacity(3000));
    const start = s.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 42 });
    const staffed = { ...start, ops: 2 };
    expect(s.advance(start, 10).state.outageDays).toBeGreaterThan(0);
    expect(s.advance(staffed, 10).state.outageDays).toBe(0);
  });
});

describe("servers on IaaS", () => {
  // No growth or variation, so demand is exactly users × 0.01 CU and DBU: 1,000 users need 10 of each. Cash for a
  // month or two of rent and ops.
  const still = { dailyGrowth: 0, growthNoise: 0, loadNoise: 0 };
  const flatConfig: GameConfig = {
    ...config,
    startingCash: 100_000,
    productTypes: {
      ...config.productTypes,
      social: { ...config.productTypes.social, growth: { ...config.productTypes.social.growth, ...still } },
    },
  };
  const flat = createSim(flatConfig);
  // Plenty of ops, so no tier is cut for missing staff unless a test says so.
  const begin = (s: Sim = flat, model = "iaas") => ({
    ...s.newGame({ companyName: "Acme", productType: "social", model, seed: 42 }),
    ops: 10,
  });
  type Kind = [type: ServerType, size: ServerSize];
  /** The state with exactly these servers, all ready. */
  const fleet = (state: GameState, ...servers: Kind[]): GameState => ({
    ...state,
    servers: servers.map(([type, size], i) => ({ id: i + 1, type, size, readyDay: state.day })),
    nextServerId: servers.length + 1,
  });
  const withUsers = (state: GameState, users: number) => ({ ...state, users, paidUsers: 0 });
  const rent = (state: GameState, server: ServerType, size: ServerSize, s: Sim = flat) =>
    s.applyAction(state, { type: "rentServer", server, size });
  const outages = (log: DayLog[]) => log.flatMap((d) => d.entries.filter((e) => e.kind === "outage").map((e) => e.text));
  const rentLines = (log: DayLog[]) => log.flatMap((d) => d.entries.filter((e) => e.text.includes(" rent: ")));
  const BIG_DB: Kind = ["database", "massive"];
  const BIG_APP: Kind = ["app", "massive"];

  it("starts a new IaaS game with the configured starter setup, ready for the first day", () => {
    const state = begin();
    expect(flat.servers(state)).toEqual([
      { id: 1, type: "app", size: "massive", name: "App server", status: "ready", readyDay: 1, units: 10_000, monthlyCost: 0 },
      { id: 2, type: "database", size: "massive", name: "Database", status: "ready", readyDay: 1, units: 10_000, monthlyCost: 0 },
    ]);
    expect(flat.units(state)).toMatchObject({ cu: { demand: 10, capacity: 10_000 }, dbu: { demand: 10, capacity: 10_000 } });
  });

  it("gives each size its units from config, and offers every type and size with its units and price", () => {
    for (const size of SERVER_SIZES) {
      const units = flat.units(fleet(begin(), ["app", size], ["database", size], ["cache", size]))!;
      const expected = config.servers.types.app.units[size];
      expect(units.cu.capacity).toBe(expected);
      expect(units.dbu.capacity).toBe(expected);
      expect(units.ch.capacity).toBe(expected);
    }
    const options = flat.serverOptions(begin());
    expect(options).toHaveLength(SERVER_TYPES.length * SERVER_SIZES.length);
    expect(options.find((o) => o.type === "database" && o.size === "large")).toMatchObject({
      name: "Database",
      units: 1_000,
      monthlyCost: 90,
    });
  });

  it("caps capacity at the weakest tier, and has an outage when demand is over it", () => {
    // 1,500 users need 15 CU and 15 DBU.
    const dbBound = withUsers(fleet(begin(), BIG_APP, ["database", "small"]), 1_500);
    const units = flat.units(flat.advance(dbBound).state)!;
    expect(units.binding).toBe("dbu");
    expect(units.usersSupported).toBe(1_000);
    expect(outages(flat.advance(dbBound).log)).toEqual([expect.stringMatching(/^Outage: the database \(DBU\) hit 150% of capacity\./)]);

    const cuBound = withUsers(fleet(begin(), ["app", "small"], BIG_DB), 1_500);
    expect(flat.units(flat.advance(cuBound).state)!.binding).toBe("cu");
    expect(outages(flat.advance(cuBound).log)).toEqual([expect.stringMatching(/^Outage: compute \(CU\) hit 150% of capacity\./)]);
    // Within both tiers, no outage: big enough on one tier doesn't make up for the other.
    expect(outages(flat.advance(withUsers(fleet(begin(), BIG_APP, BIG_DB), 1_500)).log)).toEqual([]);
    // The single capacity figure is the binding tier's, as load: 1,000 users at 1 load each.
    expect(flat.capacity(dbBound)).toBe(1_000);
  });

  it("takes database demand off with a cache, one hit a DBU, up to the cacheable share", () => {
    // 1,500 users need 15 DBU: a cache can take half, 7.5, leaving 7.5 for a 10 DBU database.
    const cached = withUsers(fleet(begin(), BIG_APP, ["database", "small"], ["cache", "small"]), 1_500);
    const { state, log } = flat.advance(cached);
    expect(outages(log)).toEqual([]);
    expect(flat.units(state)).toMatchObject({
      dbu: { demand: 7.5, capacity: 10, beforeCache: 15 },
      ch: { demand: 7.5, capacity: 10, absorbed: 7.5 },
    });
    // A database with a cache serves twice what it does alone, here.
    expect(flat.units(state)!.usersSupported).toBe(2_000);
    // However big the cache, half the demand still reaches the database: 3,000 users leave 15 DBU for its 10.
    const bigCache = withUsers(fleet(begin(), BIG_APP, ["database", "small"], ["cache", "massive"]), 3_000);
    expect(outages(flat.advance(bigCache).log)).toHaveLength(1);
    // A small cache takes all it can hold: 2,000 users leave 20 - 10 for the database.
    const full = flat.advance(withUsers(fleet(begin(), BIG_APP, ["database", "small"], ["cache", "small"]), 2_000)).state;
    expect(flat.units(full)).toMatchObject({ dbu: { demand: 10 }, ch: { demand: 10, absorbed: 10 } });
  });

  it("needs load balancers from 2 app servers, and counts only the app servers they cover", () => {
    const lb = (state: GameState) => flat.units(state)!.loadBalancer;
    const one = fleet(begin(), ["app", "small"], BIG_DB);
    expect(lb(one)).toMatchObject({ appServers: 1, needed: false, counted: 1, uncovered: 0 });
    expect(flat.units(one)!.cu.capacity).toBe(10);

    // Two app servers and no load balancer: traffic reaches only one, the biggest.
    const two = fleet(begin(), ["app", "small"], ["app", "medium"], BIG_DB);
    expect(lb(two)).toMatchObject({ appServers: 2, loadBalancers: 0, needed: true, coverage: 0, counted: 1, uncovered: 1 });
    expect(flat.units(two)!.cu.capacity).toBe(100);

    const balanced = fleet(begin(), ["app", "small"], ["app", "medium"], ["loadBalancer", "small"], BIG_DB);
    expect(lb(balanced)).toMatchObject({ coverage: 2, counted: 2, uncovered: 0 });
    expect(flat.units(balanced)!.cu.capacity).toBe(110);

    // A small load balancer serves 2: a third app server beyond it doesn't count, until a second covers it.
    const three = fleet(begin(), ["app", "small"], ["app", "small"], ["app", "small"], ["loadBalancer", "small"], BIG_DB);
    expect(lb(three)).toMatchObject({ appServers: 3, counted: 2, uncovered: 1 });
    expect(flat.units(three)!.cu.capacity).toBe(20);
    expect(flat.units({ ...three, servers: [...three.servers, { id: 9, type: "loadBalancer", size: "small", readyDay: 1 }] })!.cu.capacity).toBe(30);

    // Uncovered app servers can't stop an outage.
    const crowded = withUsers(fleet(begin(), ["app", "small"], ["app", "small"], BIG_DB), 1_500);
    expect(outages(flat.advance(crowded).log)).toHaveLength(1);
    expect(outages(flat.advance(rent(crowded, "loadBalancer", "small")).log)).toHaveLength(1);
    expect(outages(flat.advance(flat.advance(rent(crowded, "loadBalancer", "small")).state).log)).toHaveLength(0);
  });

  it("rents a VM without moving time on or touching cash, ready the next day", () => {
    const before = fleet(begin(), BIG_DB);
    const rented = rent(before, "app", "small");
    expect(rented).toMatchObject({ day: before.day, cash: before.cash, nextServerId: before.nextServerId + 1 });
    expect(flat.servers(rented).at(-1)).toMatchObject({ type: "app", size: "small", status: "pending", readyDay: 2 });
    // Not ready yet: it isn't serving.
    expect(flat.units(rented)!.cu.capacity).toBe(0);
    const next = flat.advance(rented);
    expect(flat.servers(next.state).at(-1)!.status).toBe("ready");
    expect(flat.units(next.state)!.cu.capacity).toBe(10);
    // The day it was set up ran without it.
    expect(outages(next.log)).toHaveLength(1);
    expect(outages(flat.advance(next.state).log)).toHaveLength(0);
  });

  it("bills each VM monthly, a day's share at a time from the next day played, in infrastructure", () => {
    // A small app server is £30 a month: £1 a day. The starter's massive servers are free here.
    const rented = rent(rent(begin(), "app", "small"), "app", "small");
    const { state, log } = flat.advance(rented, 30);
    const lines = rentLines(log);
    expect(lines).toHaveLength(30);
    expect(lines[0]).toEqual({ text: "App server (small) rent: 2 × £30 a month", cashDelta: -2, category: "infrastructure" });
    // A month of days bills the monthly price, on top of IaaS's own £20 a day.
    const without = flat.advance(begin(), 30).state;
    expect(without.spend.infrastructure - state.spend.infrastructure).toBe(-60);
    expect(flat.monthlyInfrastructureCost(rented)).toBe(flat.monthlyInfrastructureCost(begin()) + 60);
  });

  it("cancels pro rata: rent stops from the next day, so you pay only for the days you had it", () => {
    const rented = rent(fleet(begin(), BIG_APP, BIG_DB), "database", "medium");
    const id = rented.servers.at(-1)!.id;
    const ten = flat.advance(rented, 10).state;
    const cancelled = flat.applyAction(ten, { type: "cancelServer", id });
    expect(cancelled).toMatchObject({ day: ten.day, cash: ten.cash });
    expect(flat.servers(cancelled).map((s) => s.id)).not.toContain(id);
    const { state, log } = flat.advance(cancelled, 20);
    expect(rentLines(log)).toEqual([]);
    // A medium database is £60 a month: 10 days of it is £20.
    const without = flat.advance(fleet(begin(), BIG_APP, BIG_DB), 30).state;
    expect(state.spend.infrastructure - without.spend.infrastructure).toBe(20);
    // Cancelling one still being set up, before any day is played, costs nothing.
    const changedMind = flat.applyAction(rented, { type: "cancelServer", id });
    expect(flat.advance(changedMind, 5).state.spend).toEqual(flat.advance(fleet(begin(), BIG_APP, BIG_DB), 5).state.spend);
  });

  it("derives ops needed from the servers, ready or not, and cuts every tier when short", () => {
    // 1 ops for each app server and database, 0.5 for each cache and load balancer, rounded up.
    const state = begin();
    expect(flat.opsNeededNow(state)).toBe(2);
    expect(flat.opsNeeded("iaas")).toBe(2);
    const cached = rent(state, "cache", "small");
    expect(flat.opsNeededNow(cached)).toBe(3);
    expect(flat.opsNeededNow(rent(cached, "loadBalancer", "small"))).toBe(3);
    expect(flat.opsNeededNow(rent(rent(cached, "loadBalancer", "small"), "app", "small"))).toBe(4);
    expect(flat.opsNeededNow(fleet(state))).toBe(0);
    // With 1 of the 2 ops needed, each tier keeps 40% + 60% × ½ = 70%.
    expect(flat.units({ ...state, ops: 1 })).toMatchObject({ cu: { capacity: 7_000 }, dbu: { capacity: 7_000 } });
    expect(flat.units({ ...state, ops: 2 })).toMatchObject({ cu: { capacity: 10_000 } });
  });

  it("counts free users' demand as well as paying ones'", () => {
    const allPaid = { ...withUsers(begin(), 2_000), paidUsers: 2_000 };
    const allFree = withUsers(begin(), 2_000);
    expect(flat.advance(allFree).state.demand).toEqual(flat.advance(allPaid).state.demand);
    expect(flat.advance(allFree).state.demand).toEqual({ cu: 20, dbu: 20 });
    expect(flat.advance(withUsers(begin(), 4_000)).state.demand).toEqual({ cu: 40, dbu: 40 });
  });

  it("sets compute-heavy demand per product from config", () => {
    const video = createSim({
      ...flatConfig,
      productTypes: { ...flatConfig.productTypes, video: { ...flatConfig.productTypes.video, growth: { ...growth, ...still, loadPerUser: 5 } } },
    });
    const state = video.advance({ ...video.newGame({ companyName: "Acme", productType: "video", model: "iaas", seed: 1 }), ops: 10 }).state;
    expect(state.demand).toEqual({ cu: 50, dbu: 10 });
  });

  it("leaves on-prem, PaaS and SaaS on their fixed capacity, with no servers to rent", () => {
    for (const model of ["onprem", "paas", "saas"] as const) {
      const state = begin(flat, model);
      expect(state.servers).toEqual([]);
      expect(flat.servers(state)).toEqual([]);
      expect(flat.units(state)).toBeNull();
      expect(flat.serverOptions(state)).toEqual([]);
      expect(flat.capacity(state)).toBe(1_000_000);
      expect(flat.opsNeededNow(state)).toBe(config.models[model].opsNeeded);
      expect(() => rent(state, "app", "small")).toThrow(expect.objectContaining({ code: "no_servers" }));
      // Load still decides outages there, whatever the CU and DBU.
      const tight = createSim({ ...config, models: { ...config.models, [model]: { ...config.models[model], capacity: 800 } } });
      expect(tight.advance(begin(tight, model)).state.outageDays).toBe(1);
    }
  });

  it("rejects unknown types, sizes and servers, without changing anything", () => {
    const state = begin();
    const copy = structuredClone(state);
    const code = (action: Action) => {
      try {
        flat.applyAction(state, action);
      } catch (e) {
        return (e as SimError).code;
      }
    };
    expect(code({ type: "rentServer", server: "mainframe" as ServerType, size: "small" })).toBe("unknown_server");
    expect(code({ type: "rentServer", server: "app", size: "huge" as ServerSize })).toBe("unknown_server");
    expect(code({ type: "cancelServer", id: 99 })).toBe("unknown_server");
    rent(state, "app", "small");
    flat.applyAction(state, { type: "cancelServer", id: 1 });
    expect(state).toEqual(copy);
  });

  describe("migrating, until migration sizes the setup to demand", () => {
    // A starter that costs something: a small app server and database, £1 a day each.
    const smallStarter = createSim({
      ...config,
      models: {
        ...config.models,
        iaas: {
          ...config.models.iaas,
          servers: {
            ...config.models.iaas.servers!,
            starter: [
              { type: "app", size: "small", count: 1 },
              { type: "database", size: "small", count: 1 },
            ],
          },
        },
      },
    });
    const migrate = (state: GameState, model: ModelId) => smallStarter.applyAction(state, { type: "startMigration", model });

    it("gets the starter setup on moving onto IaaS, serving from the next day, and double-bills its rent", () => {
      const paas = { ...smallStarter.newGame({ companyName: "Acme", productType: "social", model: "paas", seed: 1 }), ops: 3 };
      const moving = migrate(paas, "iaas");
      const quote = smallStarter.migrationQuote(paas, "iaas");
      // IaaS's £20 a day plus £2 of rent, for 14 days.
      expect(quote.doubleBilling).toBe(14 * 22);
      const { state, log } = smallStarter.advance(moving, 14);
      expect(state.model).toBe("iaas");
      expect(rentLines(log)).toHaveLength(28);
      expect(smallStarter.servers(state).map((s) => [s.type, s.size, s.status])).toEqual([
        ["app", "small", "ready"],
        ["database", "small", "ready"],
      ]);
      expect(log.at(-1)!.entries.map((e) => e.text)).toContain(
        "Your IaaS starter setup is ready for tomorrow: 1 small app server, 1 small database. Rent more VMs as you grow.",
      );
      expect(smallStarter.units(state)!.cu.capacity).toBeGreaterThan(0);
    });

    it("drops the VMs on leaving IaaS, so their rent stops", () => {
      const iaas = { ...smallStarter.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 1 }), ops: 3 };
      const extra = smallStarter.applyAction(iaas, { type: "rentServer", server: "cache", size: "small" });
      const { state, log } = smallStarter.advance(migrate(extra, "paas"), 15);
      expect(state).toMatchObject({ model: "paas", servers: [] });
      expect(log[13]!.entries.map((e) => e.text)).toContain(
        "Your 3 rented VMs were cancelled: you paid rent only for the days you had them.",
      );
      // Rent on every day up to and including the day you leave, and none after.
      expect(rentLines(log.slice(0, 14)).length).toBeGreaterThan(0);
      expect(rentLines(log.slice(14))).toEqual([]);
      expect(smallStarter.units(state)).toBeNull();
    });
  });

  it("is deterministic, and resumes identically after a JSON round trip", () => {
    const run = (state: GameState) => {
      let s = flat.advance(rent(state, "app", "small"), 5).state;
      s = flat.applyAction(s, { type: "cancelServer", id: s.servers[0]!.id });
      return flat.advance(rent(s, "cache", "medium"), 5);
    };
    expect(run(begin())).toEqual(run(begin()));
    const half = flat.advance(rent(begin(), "loadBalancer", "small"), 3).state;
    expect(flat.advance(JSON.parse(JSON.stringify(half)), 5)).toEqual(flat.advance(half, 5));
  });

  it("starts every product on IaaS with room to grow by default, run by one ops person", () => {
    const s = createSim(defaultConfig);
    expect(s.opsNeeded("iaas")).toBe(1);
    for (const p of PRODUCT_TYPE_IDS) {
      const state = s.newGame({ companyName: "Acme", productType: p, model: "iaas", seed: 1 });
      expect(s.units(state)!.usersSupported, p).toBeGreaterThan(state.users * 1.5);
      expect(s.capacity(state), p).toBeGreaterThan(state.load * 1.5);
    }
    // One CU serves the same users whatever the size, and bigger VMs cost less per unit.
    const { units } = defaultConfig.servers.types.app;
    const prices = defaultConfig.models.iaas.servers!.monthlyCost.app;
    for (let i = 1; i < SERVER_SIZES.length; i++) {
      const [smaller, bigger] = [SERVER_SIZES[i - 1]!, SERVER_SIZES[i]!];
      expect(units[bigger]).toBeGreaterThan(units[smaller]);
      expect(prices[bigger] / units[bigger]).toBeLessThan(prices[smaller] / units[smaller]);
    }
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
      { day: 1, staff: 0, infrastructure: 50, addons: 0, income: 0 },
      ...[2, 3, 4, 5].map((day) => ({ day, staff: 3, infrastructure: 20, addons: 0, income: 0 })),
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

describe("game end and summary", () => {
  // A 30-day game, with cash for two migrations. IaaS costs 20 a day and £100 upfront; PaaS 30 a day.
  const shortConfig: GameConfig = {
    ...config,
    startingCash: 100_000,
    finalDay: 30,
    models: { ...config.models, iaas: { ...config.models.iaas, upfrontCost: 100 } },
  };
  const s = createSim(shortConfig);
  const begin = (seed = 42) => s.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed });
  const charges = (log: DayLog[], category: string) =>
    log.flatMap((d) => d.entries).filter((e) => e.category === category).reduce((sum, e) => sum - e.cashDelta, 0);
  const migrate = (model: string): Action => ({ type: "startMigration", model: model as never });

  it("plays the final day in full, then ends the game and says so in the log", () => {
    const before = s.advance(begin(), 28);
    expect(before.state).toMatchObject({ day: 29, status: "playing" });
    const { state, log } = s.advance(before.state);
    expect(state).toMatchObject({ day: 30, status: "finished" });
    expect(log[0]!.entries.some((e) => e.category === "infrastructure")).toBe(true);
    expect(log[0]!.entries.at(-1)).toMatchObject({ kind: "finished", cashDelta: 0 });
    expect(log[0]!.entries.at(-1)!.text).toMatch(/Day 30 was the last/);
  });

  it("stops a multi-day advance on the final day", () => {
    const { state, log } = s.advance(begin(), 100);
    expect(state).toMatchObject({ day: 30, status: "finished" });
    expect(log.at(-1)!.day).toBe(30);
    expect(log).toHaveLength(29);
  });

  it("rejects advances and actions once finished", () => {
    const { state } = s.advance(begin(), 29);
    for (const attempt of [
      () => s.advance(state),
      () => s.applyAction(state, { type: "hire", pool: "ops" }),
      () => s.applyAction(state, migrate("paas")),
    ]) {
      expect(attempt).toThrow(SimError);
      expect(attempt).toThrow(expect.objectContaining({ code: "finished" }));
    }
  });

  it("ends a game saved past the final day, such as one played under a longer config", () => {
    const longer = sim.advance(sim.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1 }), 39);
    expect(longer.state).toMatchObject({ day: 40, status: "playing" });
    expect(s.load(longer.state).status).toBe("finished");
    expect(() => s.advance(longer.state)).toThrow(expect.objectContaining({ code: "finished" }));
    expect(s.summarise(longer.state).ending).toBe("completed");
  });

  it("counts going bankrupt on the final day as bankrupt", () => {
    // 1000 cash at 20 a day on IaaS goes below zero on day 52.
    const tight = createSim({ ...config, finalDay: 52 });
    const { state } = tight.advance(tight.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1 }), 100);
    expect(state).toMatchObject({ day: 52, status: "bankrupt" });
    expect(tight.summarise(state).ending).toBe("bankrupt");
  });

  it("summarises a completed game: final figures, and spend totals equal to the sum of daily charges", () => {
    const hired = s.applyAction(s.applyAction(begin(), { type: "hire", pool: "developers" }), { type: "hire", pool: "ops" });
    const { state, log } = s.advance(hired, 29);
    const summary = s.summarise(state);
    expect(summary).toMatchObject({
      companyName: "Acme",
      productType: "ecommerce",
      model: "iaas",
      ending: "completed",
      day: 30,
      finalDay: 30,
      cash: state.cash,
      users: state.users,
      uptime: s.uptime(state),
      outageDays: state.outageDays,
      migrations: 0,
    });
    // Day 1's charge is the upfront cost; the log has the rest.
    expect(summary.spend).toEqual({
      staff: charges(log, "staff"),
      infrastructure: 100 + charges(log, "infrastructure"),
      addons: charges(log, "addons"),
    });
    expect(summary.spend.staff).toBe(29 * 10);
    expect(summary.totalSpend).toBe(SPEND_CATEGORIES.reduce((sum, c) => sum + summary.spend[c], 0));
    expect(summary.totalSpend).toBe(100_000 - summary.cash);
    // The series has every day, and each category adds up to its total.
    expect(summary.days.map((d) => d.day)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    for (const c of SPEND_CATEGORIES) {
      expect(summary.days.reduce((sum, d) => sum + d[c], 0)).toBe(summary.spend[c]);
    }
    // Each day's charges in the series match that day's log.
    for (const d of log) {
      const day = summary.days.find((x) => x.day === d.day)!;
      for (const c of SPEND_CATEGORIES) expect(day[c]).toBe(charges([d], c));
    }
  });

  it("gives the cash left after each day, ending on the final cash", () => {
    const { state } = s.advance(begin(), 29);
    const { days, cash } = s.summarise(state);
    expect(days[0]).toEqual({ day: 1, staff: 0, infrastructure: 100, addons: 0, income: 0, cash: 99_900 });
    expect(days.at(-1)!.cash).toBe(cash);
    for (let i = 1; i < days.length; i++) {
      const d = days[i]!;
      expect(days[i - 1]!.cash - d.cash).toBe(d.staff + d.infrastructure + d.addons);
    }
  });

  it("counts migrations completed, not one still under way", () => {
    // A migration takes 14 days: IaaS to PaaS from day 1 completes on day 15, and PaaS to SaaS from then on day 29.
    const first = s.advance(s.applyAction(begin(), migrate("paas")), 14).state;
    expect(first).toMatchObject({ day: 15, model: "paas" });
    const second = s.advance(s.applyAction(first, migrate("saas")), 14).state;
    expect(second).toMatchObject({ day: 29, model: "saas", status: "playing" });
    expect(s.summarise(second)).toMatchObject({ migrations: 2, ending: null });
    // A third, started on the last day, is still under way when the game ends.
    const end = s.advance(s.applyAction(second, migrate("iaas"))).state;
    expect(end).toMatchObject({ day: 30, model: "saas", status: "finished" });
    expect(s.summarise(end)).toMatchObject({ migrations: 2, model: "saas", ending: "completed" });
  });

  it("shows a migration's upfront cost as a jump in that day's spend", () => {
    const { state } = s.advance(s.applyAction(s.advance(begin(), 9).state, migrate("onprem")), 5);
    const pricier = createSim({
      ...shortConfig,
      models: { ...shortConfig.models, onprem: { ...shortConfig.models.onprem, upfrontCost: 5000 } },
    });
    const migrated = pricier.advance(pricier.applyAction(pricier.advance(begin(), 9).state, migrate("onprem")), 5).state;
    const day11 = (st: GameState, sm: Sim) => sm.summarise(st).days.find((d) => d.day === 11)!.infrastructure;
    expect(day11(migrated, pricier) - day11(state, s)).toBe(5000);
  });

  it("summarises a bankrupt game", () => {
    const { state, log } = sim.advance(start(), 100);
    const summary = sim.summarise(state);
    expect(summary).toMatchObject({ ending: "bankrupt", day: 52, cash: -20, finalDay: 180 });
    expect(summary.days).toHaveLength(52);
    expect(summary.days.at(-1)!.cash).toBe(-20);
    expect(summary.spend.infrastructure).toBe(charges(log, "infrastructure"));
    expect(summary.totalSpend).toBe(1020);
  });

  it("summarises a game still being played, with no ending", () => {
    const summary = s.summarise(s.advance(begin(), 5).state);
    expect(summary).toMatchObject({ ending: null, day: 6 });
    expect(summary.days).toHaveLength(6);
  });

  it("is deterministic and JSON-serialisable", () => {
    const play = () => s.summarise(s.advance(s.applyAction(begin(7), migrate("saas")), 40).state);
    expect(play()).toEqual(play());
    expect(JSON.parse(JSON.stringify(play()))).toEqual(play());
  });
});

describe("default config", () => {
  const sim180 = createSim(defaultConfig);
  const run = (productType: string, model: string, ops?: number) => {
    const start = sim180.newGame({ companyName: "Acme", productType, model, seed: 7 });
    return sim180.advance(ops === undefined ? start : { ...start, ops }, defaultConfig.finalDay - 1).state;
  };
  // On servers, rents a massive one for any tier past half its capacity, enough headroom for load variation and the
  // seasonal spike: a cache while it has room to take more off the database, then a database.
  const rentAhead = (state: GameState): GameState => {
    const units = sim180.units(state);
    if (!units) return state;
    const rent = (server: "app" | "database" | "cache" | "loadBalancer") =>
      rentAhead(sim180.applyAction(state, { type: "rentServer", server, size: "massive" }));
    const { cu, dbu, ch, loadBalancer } = units;
    const pending = sim180.servers(state).some((s) => s.status === "pending");
    if (pending) return state;
    if (loadBalancer.uncovered > 0) return rent("loadBalancer");
    if (cu.demand > cu.capacity / 2) return rent("app");
    if (dbu.demand > dbu.capacity / 2) return rent(ch.absorbed < ch.demand && ch.capacity < dbu.capacity ? "cache" : "database");
    return state;
  };
  // Plays to the end with the ops the model needs, hiring support each day to keep up with the usual tickets, and on
  // servers renting ahead of demand.
  // Without hireSupport, it keeps its starting support staff. onDay sees each day played.
  const runStaffed = (productType: string, model: string, hireSupport = true, onDay?: (state: GameState) => void) => {
    let state = sim180.newGame({ companyName: "Acme", productType, model, seed: 7 });
    while (state.status === "playing") {
      state = rentAhead(state);
      const needed = hireSupport ? Math.ceil((sim180.usualTickets(state) * 1.2) / defaultConfig.support.ticketsPerPerson) : 0;
      state = { ...state, ops: Math.max(state.ops, sim180.opsNeededNow(state)), support: Math.max(state.support, needed) };
      state = sim180.advance(state).state;
      onDay?.(state);
    }
    return state;
  };

  it("lets every product reach day 180 on IaaS renting ahead, down only for the provider and each spike's first day", () => {
    for (const p of ["ecommerce", "social", "video"]) {
      const state = runStaffed(p, "iaas");
      // The provider outage is the one an IaaS company can't staff its way out of. A traffic spike triples demand, and
      // the extra VMs are only ready the next day, so its first day can be down too: the spike fires twice.
      expect(state.outageDays).toBeGreaterThanOrEqual(1);
      expect(state.outageDays).toBeLessThanOrEqual(3);
      expect(state.users).toBeGreaterThan(defaultConfig.productTypes[p as "social"].growth.startingUsers * 5);
    }
  });

  it("makes outages possible when understaffed", () => {
    expect(run("video", "iaas", 1).outageDays).toBeGreaterThan(0);
  });

  it("lets every model and product reach day 180 with starting developers and the ops it needs", () => {
    for (const model of MODEL_IDS) {
      for (const p of ["ecommerce", "social", "video"]) {
        const state = runStaffed(p, model);
        expect(state).toMatchObject({ day: defaultConfig.finalDay, status: "finished" });
        expect(state.satisfaction).toBeGreaterThan(defaultConfig.support.goodSatisfaction);
      }
    }
  });

  it("makes support matter: a company that never hires more has unhappy customers and ends with fewer users", () => {
    for (const p of ["ecommerce", "social", "video"]) {
      let lowest = 100;
      const neglected = runStaffed(p, "iaas", false, (s) => (lowest = Math.min(lowest, s.satisfaction)));
      // Users leave until support can keep up again, so satisfaction can recover by the end.
      expect(lowest).toBeLessThan(defaultConfig.support.poorSatisfaction);
      expect(neglected.users).toBeLessThan(runStaffed(p, "iaas").users / 2);
    }
  });

  it("is happy at the start: one support person keeps up with every product's first tickets", () => {
    for (const p of PRODUCT_TYPE_IDS) {
      const state = sim180.newGame({ companyName: "Acme", productType: p, model: "iaas", seed: 7 });
      expect(sim180.usualTickets(state)).toBeLessThanOrEqual(sim180.dailyClearance(state));
      expect(sim180.advance(state, 7).state).toMatchObject({ backlog: 0, satisfaction: 100 });
    }
  });

  it("bankrupts a company that hires far more than it needs", () => {
    const start = sim180.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 7 });
    const state = sim180.advance({ ...start, developers: 12, ops: 2 }, defaultConfig.finalDay - 1).state;
    expect(state.status).toBe("bankrupt");
    expect(state.day).toBeLessThan(defaultConfig.finalDay);
  });

  it("gives every product 3–5 features with unique ids, each costing developer-days and boosting growth", () => {
    for (const { features } of Object.values(defaultConfig.productTypes)) {
      expect(features.length).toBeGreaterThanOrEqual(3);
      expect(features.length).toBeLessThanOrEqual(5);
      expect(new Set(features.map((f) => f.id)).size).toBe(features.length);
      for (const f of features) {
        expect(f.devDays).toBeGreaterThan(0);
        expect(f.growthMultiplier).toBeGreaterThan(1);
      }
    }
  });

  it("lets starting developers build every feature well within the game", () => {
    const { developers } = defaultConfig.staff;
    for (const { features } of Object.values(defaultConfig.productTypes)) {
      const days = features.reduce((sum, f) => sum + Math.ceil(f.devDays / developers.startingCount), 0);
      expect(days).toBeLessThan(defaultConfig.finalDay / 2);
    }
  });

  it("prices every add-on per user, dearer for a bigger growth boost", () => {
    for (const { features } of Object.values(defaultConfig.productTypes)) {
      for (const f of features) expect(f.addonPricePerUser).toBeGreaterThan(0);
      const byBoost = features.toSorted((a, b) => a.growthMultiplier - b.growthMultiplier);
      for (let i = 1; i < byBoost.length; i++) {
        expect(byBoost[i]!.addonPricePerUser).toBeGreaterThanOrEqual(byBoost[i - 1]!.addonPricePerUser);
      }
    }
  });

  it("lets a SaaS company that buys every add-on on day 1 reach day 180 with its starting developers", () => {
    const { addons, staff } = defaultConfig;
    expect(staff.developers.startingCount).toBeGreaterThanOrEqual(addons.minConfigDevelopers);
    for (const p of ["ecommerce", "social", "video"] as const) {
      let state = sim180.newGame({ companyName: "Acme", productType: p, model: "saas", seed: 7 });
      for (const f of defaultConfig.productTypes[p].features) {
        state = sim180.applyAction(state, { type: "buyAddon", feature: f.id });
      }
      const end = sim180.advance(state, defaultConfig.finalDay - 1).state;
      expect(end).toMatchObject({ day: defaultConfig.finalDay, status: "finished" });
      expect(end.spend.addons).toBeGreaterThan(0);
    }
  });

  it("makes on-prem's upfront cost the highest, and only SaaS charge per user", () => {
    const upfront = (m: (typeof MODEL_IDS)[number]) => defaultConfig.models[m].upfrontCost;
    for (const m of ["iaas", "paas", "saas"] as const) expect(upfront("onprem")).toBeGreaterThan(upfront(m) * 10);
    expect(MODEL_IDS.filter((m) => defaultConfig.models[m].monthlyCostPerUser > 0)).toEqual(["saas"]);
  });
});

describe("migration", () => {
  const migrate = (model: string): Action => ({ type: "startMigration", model: model as never });
  const moveTo = (to: "developers" | "ops"): Action => ({ type: "moveStaff", to });
  // On IaaS with a developer and an ops person, migrating to PaaS from day 1, with cash for paying two providers.
  const migrating = () => sim.applyAction({ ...start(), cash: 100_000, developers: 1, ops: 1 }, migrate("paas"));
  const charges = (entries: LogEntry[]) => entries.filter((e) => e.category === "infrastructure").map((e) => e.text);

  it("starts in planning without moving time on, touching cash or staff", () => {
    const before = { ...start(), developers: 1, ops: 1 };
    const state = sim.applyAction(before, migrate("paas"));
    expect(state).toMatchObject({ day: 1, cash: before.cash, model: "iaas", developers: 1, ops: 1, migrations: 0 });
    expect(sim.migration(state)).toEqual({
      from: "iaas",
      to: "paas",
      phase: "planning",
      phaseDaysLeft: 5,
      daysLeft: 14,
      totalDays: 14,
      overrunDays: 0,
    });
  });

  it("has no migration on a new game", () => {
    expect(sim.migration(start())).toBeNull();
    expect(start()).toMatchObject({ migration: null, migrations: 0 });
  });

  it("rejects migrating to the current model", () => {
    expect(() => sim.applyAction(start(), migrate("iaas"))).toThrow(expect.objectContaining({ code: "same_model" }));
  });

  it("rejects a second migration while one is running, even to another model", () => {
    for (const model of ["onprem", "paas", "saas"]) {
      expect(() => sim.applyAction(migrating(), migrate(model))).toThrow(
        expect.objectContaining({ code: "migration_running" }),
      );
    }
    // Still rejected part-way through.
    expect(() => sim.applyAction(sim.advance(migrating(), 9).state, migrate("saas"))).toThrow(SimError);
  });

  it("rejects an unknown model", () => {
    expect(() => sim.applyAction(start(), migrate("mainframe"))).toThrow(
      expect.objectContaining({ code: "unknown_model" }),
    );
  });

  it("does not mutate the input state", () => {
    const state = start();
    const copy = structuredClone(state);
    sim.applyAction(state, migrate("paas"));
    expect(state).toEqual(copy);
  });

  it("advances through the phases on the configured days and completes after 14", () => {
    const at = (days: number) => sim.migration(sim.advance(migrating(), days).state);
    expect(at(4)).toMatchObject({ phase: "planning", phaseDaysLeft: 1, daysLeft: 10 });
    expect(at(5)).toMatchObject({ phase: "testing", phaseDaysLeft: 2, daysLeft: 9 });
    expect(at(6)).toMatchObject({ phase: "testing", phaseDaysLeft: 1, daysLeft: 8 });
    expect(at(7)).toMatchObject({ phase: "moving", phaseDaysLeft: 7, daysLeft: 7 });
    expect(at(13)).toMatchObject({ phase: "moving", phaseDaysLeft: 1, daysLeft: 1 });
    expect(sim.advance(migrating(), 13).state.model).toBe("iaas");

    const done = sim.advance(migrating(), 14).state;
    expect(done).toMatchObject({ day: 15, model: "paas", migration: null, migrations: 1 });
    expect(sim.migration(done)).toBeNull();
  });

  it("takes its phase lengths from config", () => {
    const phases = { planning: { name: "P", days: 1 }, testing: { name: "T", days: 1 }, moving: { name: "M", days: 2 } };
    const quick = createSim({ ...config, migration: { ...config.migration, phases } });
    const state = quick.applyAction(start(), migrate("paas"));
    expect(quick.migration(state)).toMatchObject({ daysLeft: 4, totalDays: 4 });
    expect(quick.advance(state, 3).state.model).toBe("iaas");
    expect(quick.advance(state, 4).state.model).toBe("paas");
  });

  it("adds any overrun days to the moving phase", () => {
    const state = migrating();
    const overrun = { ...state, migration: { ...state.migration!, overrunDays: 3 } };
    expect(sim.migration(overrun)).toMatchObject({ daysLeft: 17, totalDays: 17 });
    expect(sim.migration(sim.advance(overrun, 7).state)).toMatchObject({ phase: "moving", phaseDaysLeft: 10 });
    expect(sim.advance(overrun, 16).state.model).toBe("iaas");
    expect(sim.advance(overrun, 17).state.model).toBe("paas");
  });

  it("logs each phase change and the completion in the day log", () => {
    const { log } = sim.advance(migrating(), 14);
    const events = log.flatMap((d) => d.entries.filter((e) => e.kind === "migration").map((e) => [d.day, e.text]));
    expect(events).toEqual([
      [6, "Migration to PaaS: Planning done. Testing next, 2 days."],
      [8, "Migration to PaaS: Testing done. Moving infrastructure next, 7 days."],
      [15, "Migration complete: you're now on PaaS, which needs 1 ops staff."],
      [15, "Your 2 rented VMs were cancelled: you paid rent only for the days you had them."],
    ]);
  });

  it("never locks staff: hiring, letting go, moving and building all work mid-migration", () => {
    let state = sim.advance(migrating(), 3).state;
    state = sim.applyAction(state, { type: "hire", pool: "developers" });
    state = sim.applyAction(state, { type: "letGo", pool: "ops" });
    state = sim.applyAction(state, { type: "hire", pool: "ops" });
    state = sim.applyAction(state, moveTo("ops"));
    state = sim.applyAction(state, moveTo("developers"));
    state = sim.applyAction(state, { type: "buildFeature", feature: "checkout" });
    expect(state).toMatchObject({ developers: 2, ops: 1 });
    // The migration carries on where it was.
    expect(sim.migration(state)).toMatchObject({ phase: "planning", daysLeft: 11 });
    const next = sim.advance(state).state;
    expect(next.features.checkout).toEqual({ status: "building", progress: 2 });
    expect(sim.migration(next)).toMatchObject({ daysLeft: 10 });
  });

  it("bills the current model until the migration completes, then only the new one", () => {
    const { log } = sim.advance(migrating(), 15);
    for (const day of log.slice(0, 14)) expect(charges(day.entries)).toContain("IaaS running costs (£600 a month)");
    expect(charges(log[14]!.entries)).toEqual(["PaaS running costs (£900 a month)"]);
    expect(sim.monthlyInfrastructureCost(sim.advance(migrating(), 14).state)).toBe(900);
  });

  it("switches the stack, ops needed and capacity to the new model on completion", () => {
    const base = iaasCapacity(3000);
    const s = createSim({ ...base, models: { ...base.models, paas: { ...base.models.paas, capacity: 5000 } } });
    const before = s.applyAction({ ...start(), ops: 1 }, migrate("paas"));
    // IaaS needs 2 ops: with 1, capacity is 40% + 60% × ½ of 3,000.
    expect(s.capacity(before)).toBe(2100);
    expect(s.capacity(s.advance(before, 13).state)).toBe(2100);
    const done = s.advance(before, 14).state;
    expect(responsibilityStack(done.model)).toEqual(responsibilityStack("paas"));
    expect(s.opsNeeded(done.model)).toBe(1);
    // PaaS needs 1 ops, so the same team now runs it fully staffed.
    expect(s.capacity(done)).toBe(5000);
  });

  it("follows the new model's feature rules: SaaS sells add-ons, other models build", () => {
    const onPaas = sim.advance(migrating(), 14).state;
    const onSaas = sim.advance(sim.applyAction(onPaas, migrate("saas")), 14).state;
    expect(onSaas.model).toBe("saas");
    expect(() => sim.applyAction(onSaas, { type: "buildFeature", feature: "reviews" })).toThrow(
      expect.objectContaining({ code: "saas_features" }),
    );
    expect(sim.applyAction(onSaas, { type: "buyAddon", feature: "reviews" }).features.reviews?.status).toBe("addon");
    // Not on SaaS yet while still migrating to it.
    const halfway = sim.advance(sim.applyAction(onPaas, migrate("saas")), 7).state;
    expect(() => sim.applyAction(halfway, { type: "buyAddon", feature: "reviews" })).toThrow(
      expect.objectContaining({ code: "not_saas" }),
    );
  });

  it("leaves SaaS add-ons behind on leaving SaaS, and stops billing them", () => {
    const saasGame = sim.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 42 });
    const onSaas = { ...saasGame, developers: 1 };
    const bought = sim.applyAction(onSaas, { type: "buyAddon", feature: "checkout" });
    const { state, log } = sim.advance(sim.applyAction(bought, migrate("iaas")), 15);
    const last = log[13]!.entries;
    expect(last.some((e) => e.category === "addons")).toBe(true);
    expect(last).toContainEqual(
      expect.objectContaining({ kind: "migration", text: expect.stringContaining("Checkout") }),
    );
    expect(log[14]!.entries.some((e) => e.category === "addons")).toBe(false);
    expect(sim.features(state).find((f) => f.id === "checkout")!.status).toBe("notStarted");
  });

  it("counts each completed migration, and can migrate again once one is done", () => {
    let state = migrating();
    expect(sim.advance(state, 13).state.migrations).toBe(0);
    state = sim.advance(state, 14).state;
    state = sim.advance(sim.applyAction(state, migrate("iaas")), 14).state;
    expect(state).toMatchObject({ model: "iaas", migrations: 2 });
  });

  it("is deterministic and resumes identically after a JSON round trip", () => {
    expect(sim.advance(migrating(), 20)).toEqual(sim.advance(migrating(), 20));
    const saved = JSON.parse(JSON.stringify(sim.advance(migrating(), 6).state));
    expect(sim.advance(saved, 14).state).toEqual(sim.advance(migrating(), 20).state);
  });
});

describe("migration costs", () => {
  const migrate = (model: string): Action => ({ type: "startMigration", model: model as never });
  // Plenty of cash, so paying two providers never bankrupts the company here.
  const rich = () => ({ ...start(), cash: 100_000 });
  const infra = (entries: LogEntry[]) =>
    entries.filter((e) => e.category === "infrastructure").map((e) => [e.text, e.cashDelta]);
  const withModels = (models: Partial<GameConfig["models"]>) =>
    createSim({ ...config, models: { ...config.models, ...models } });

  it("bills both providers on every day of the migration, the new one in full from day 1", () => {
    const { log } = sim.advance(sim.applyAction(rich(), migrate("paas")), 15);
    for (const day of log.slice(0, 14)) {
      expect(infra(day.entries)).toEqual([
        ["IaaS running costs (£600 a month)", -20],
        ["Double billing: PaaS running costs (£900 a month)", -30],
      ]);
    }
    // The day after you leave, only the new provider bills.
    expect(infra(log[14]!.entries)).toEqual([["PaaS running costs (£900 a month)", -30]]);
  });

  it("bills the new provider only after the switch when config turns double billing off", () => {
    const single = createSim({ ...config, migration: { ...config.migration, billNewFromStart: false } });
    const { log } = single.advance(single.applyAction(rich(), migrate("paas")), 15);
    for (const day of log.slice(0, 14)) {
      expect(infra(day.entries)).toEqual([["IaaS running costs (£600 a month)", -20]]);
    }
    expect(infra(log[14]!.entries)).toEqual([["PaaS running costs (£900 a month)", -30]]);
    expect(single.migrationQuote(rich(), "paas").doubleBilling).toBe(0);
  });

  it("charges the old provider pro rata up to the day you leave: 280 a month, leaving on 14 February, is 140", () => {
    // February has 28 days. Only the old provider costs anything: the new one is free and there are no staff.
    const feb = createSim({
      ...config,
      billing: { daysPerMonth: 28 },
      models: {
        ...config.models,
        iaas: { ...config.models.iaas, monthlyCost: 280 },
        paas: { ...config.models.paas, monthlyCost: 0 },
      },
    });
    // Start on the 1st: the 14-day migration completes, and you leave, on the 14th.
    const first = feb.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 });
    expect(feb.migrationQuote(first, "paas").proRata).toBe(140);
    const left = feb.advance(feb.applyAction(first, migrate("paas")), 14).state;
    expect(left.model).toBe("paas");
    expect(left.spend.infrastructure).toBe(140);
    // Nothing more from the old provider once you've left.
    expect(feb.advance(left, 10).state.spend.infrastructure).toBe(140);
  });

  it("charges the old provider's exit penalty once, on the day you leave, as infrastructure", () => {
    const s = withModels({ iaas: { ...config.models.iaas, exitPenalty: 250 } });
    const { log } = s.advance(s.applyAction(rich(), migrate("paas")), 20);
    const penalties = log.flatMap((d) =>
      d.entries.filter((e) => e.text.startsWith("Exit penalty")).map((e) => [d.day, e.text, e.cashDelta, e.category]),
    );
    expect(penalties).toEqual([[15, "Exit penalty: leaving IaaS", -250, "infrastructure"]]);
  });

  it("charges no exit penalty leaving a model that has none", () => {
    const { log } = sim.advance(sim.applyAction(rich(), migrate("paas")), 14);
    expect(log.flatMap((d) => d.entries).some((e) => e.text.startsWith("Exit penalty"))).toBe(false);
  });

  it("charges the new model's upfront cost once, on the migration's first day", () => {
    const s = withModels({ paas: { ...config.models.paas, upfrontCost: 100 } });
    const { log } = s.advance(s.applyAction(rich(), migrate("paas")), 14);
    const upfront = log.flatMap((d) =>
      d.entries.filter((e) => e.text.startsWith("Upfront")).map((e) => [d.day, e.cashDelta]),
    );
    expect(upfront).toEqual([[2, -100]]);
  });

  describe("overrun", () => {
    // Overruns half the time, by 2 to 4 days. Seed 7 rolls one of 3 days; seed 2 doesn't overrun.
    const withOverrun = (overrun: GameConfig["migration"]["overrun"]) =>
      createSim({ ...config, migration: { ...config.migration, overrun } });
    const slips = withOverrun({ chance: 0.5, minDays: 2, maxDays: 4 });
    const gameWith = (seed: number) => ({
      ...slips.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed }),
      cash: 100_000,
    });
    const migratingWith = (seed: number) => slips.applyAction(gameWith(seed), migrate("paas"));

    it("with a seed that forces it, adds days to moving infrastructure and logs them", () => {
      const state = migratingWith(7);
      // No overrun is known until moving starts.
      expect(slips.migration(slips.advance(state, 6).state)).toMatchObject({ overrunDays: 0, totalDays: 14 });
      const { state: moving, log } = slips.advance(state, 7);
      expect(slips.migration(moving)).toMatchObject({
        phase: "moving",
        phaseDaysLeft: 10,
        overrunDays: 3,
        totalDays: 17,
      });
      expect(log[6]!.entries.filter((e) => e.kind === "migration").map((e) => e.text)).toEqual([
        "Migration to PaaS: Testing done. Moving infrastructure next, 10 days.",
        "Migration overrun: moving infrastructure will take 3 extra days, billed by both providers.",
      ]);
      expect(slips.advance(state, 16).state.model).toBe("iaas");
      expect(slips.advance(state, 17).state.model).toBe("paas");
    });

    it("bills both providers for the extra days, so it costs more than the quote", () => {
      const quote = slips.migrationQuote(gameWith(7), "paas");
      const state = migratingWith(7);
      const { log, state: done } = slips.advance(state, 17);
      const doubleBilled = log.flatMap((d) => d.entries).filter((e) => e.text.startsWith("Double billing"));
      expect(doubleBilled).toHaveLength(17);
      expect(done.spend.infrastructure - state.spend.infrastructure).toBe(quote.total + 3 * (20 + 30));
    });

    it("doesn't overrun with a seed that rolls against it", () => {
      const { state } = slips.advance(migratingWith(2), 14);
      expect(state).toMatchObject({ model: "paas", migration: null, migrations: 1 });
    });

    it("always overruns at a chance of 1", () => {
      const always = withOverrun({ chance: 1, minDays: 2, maxDays: 2 });
      const state = always.advance(always.applyAction(rich(), migrate("paas")), 7).state;
      expect(always.migration(state)).toMatchObject({ overrunDays: 2, totalDays: 16 });
    });

    it("is deterministic and resumes identically after a JSON round trip", () => {
      expect(slips.advance(migratingWith(7), 20)).toEqual(slips.advance(migratingWith(7), 20));
      const saved = JSON.parse(JSON.stringify(slips.advance(migratingWith(7), 4).state));
      expect(slips.advance(saved, 16).state).toEqual(slips.advance(migratingWith(7), 20).state);
    });
  });

  describe("quote", () => {
    // IaaS charges 250 to leave; PaaS costs 100 upfront.
    const s = withModels({
      iaas: { ...config.models.iaas, exitPenalty: 250 },
      paas: { ...config.models.paas, upfrontCost: 100 },
    });

    it("gives the duration, upfront cost, double billing, pro-rata charge, exit penalty and total", () => {
      expect(s.migrationQuote(start(), "paas")).toEqual({
        from: "iaas",
        to: "paas",
        days: 14,
        upfrontCost: 100,
        // 14 days of PaaS at £30 a day, on top of IaaS.
        doubleBilling: 420,
        // 14 days of IaaS at £20 a day, up to the day you leave.
        proRata: 280,
        exitPenalty: 250,
        total: 1050,
        overrun: { chance: 0, minDays: 2, maxDays: 4 },
        lostAddons: [],
      });
    });

    it("equals what the migration actually charges when it doesn't overrun", () => {
      const before = rich();
      const quote = s.migrationQuote(before, "paas");
      const { state } = s.advance(s.applyAction(before, migrate("paas")), 14);
      expect(state.model).toBe("paas");
      expect(state.spend.infrastructure - before.spend.infrastructure).toBe(quote.total);
    });

    it("prices per-user fees on today's users", () => {
      const perUser = withModels({ saas: { ...config.models.saas, monthlyCost: 0, monthlyCostPerUser: 0.3 } });
      // 1,000 users at £0.30 a month is £10 a day.
      expect(perUser.migrationQuote(start(), "saas").doubleBilling).toBe(140);
    });

    it("rejects the targets starting a migration rejects, and changes nothing", () => {
      expect(() => s.migrationQuote(start(), "mainframe")).toThrow(expect.objectContaining({ code: "unknown_model" }));
      expect(() => s.migrationQuote(start(), "iaas")).toThrow(expect.objectContaining({ code: "same_model" }));
      const migrating = s.applyAction(rich(), migrate("paas"));
      expect(() => s.migrationQuote(migrating, "saas")).toThrow(expect.objectContaining({ code: "migration_running" }));
      const state = start();
      s.migrationQuote(state, "paas");
      expect(state).toEqual(start());
    });
  });
});

describe("leaving SaaS (vendor lock-in)", () => {
  const migrate = (model: string): Action => ({ type: "startMigration", model: model as never });
  const buy = (feature: string): Action => ({ type: "buyAddon", feature });
  const build = (feature: string): Action => ({ type: "buildFeature", feature });
  // On SaaS with a configuration team of 1 and cash for paying two providers.
  const onSaas = () => ({
    ...sim.newGame({ companyName: "Acme", productType: "ecommerce", model: "saas", seed: 42 }),
    cash: 100_000,
    developers: 1,
  });
  const withAddons = () => sim.applyAction(sim.applyAction(onSaas(), buy("checkout")), buy("reviews"));
  const status = (state: GameState, id: string) => sim.features(state).find((f) => f.id === id)!.status;
  const addonCharges = (entries: LogEntry[]) => entries.filter((e) => e.category === "addons").map((e) => e.text);
  // Leaves SaaS for IaaS: the 14-day migration completes at the end of the 14th day.
  const leave = (state = withAddons(), days = 14) => sim.advance(sim.applyAction(state, migrate("iaas")), days);

  it("quotes the add-ons that will be lost, with the developer-days to rebuild each, for any move off SaaS", () => {
    for (const target of ["onprem", "iaas", "paas"]) {
      expect(sim.migrationQuote(withAddons(), target).lostAddons).toEqual([
        { id: "checkout", name: "Checkout", devDays: 6 },
        { id: "reviews", name: "Reviews", devDays: 5 },
      ]);
    }
  });

  it("quotes no lost add-ons for any other move, or from SaaS with none bought", () => {
    expect(sim.migrationQuote(onSaas(), "iaas").lostAddons).toEqual([]);
    for (const target of ["onprem", "paas", "saas"]) expect(sim.migrationQuote(start(), target).lostAddons).toEqual([]);
    // A feature built on IaaS isn't an add-on, so moving to SaaS loses nothing.
    const built = { ...start(), features: { checkout: { status: "built" as const, progress: 6 } } };
    expect(sim.migrationQuote(built, "saas").lostAddons).toEqual([]);
  });

  it("keeps add-ons active and billed for the whole migration, as you're still on SaaS", () => {
    const { state, log } = leave(withAddons(), 13);
    for (const day of log) expect(addonCharges(day.entries)).toHaveLength(2);
    expect(state.model).toBe("saas");
    expect(sim.features(state).map((f) => f.status)).toEqual(["addon", "addon", "notStarted"]);
  });

  it("removes the add-ons on completion, logs the loss, and stops add-on billing", () => {
    const { state, log } = leave(withAddons(), 15);
    const leavingDay = log[13]!;
    // Billed up to and including the day you leave, then never again.
    expect(addonCharges(leavingDay.entries)).toHaveLength(2);
    expect(leavingDay.entries).toContainEqual({
      text:
        "Vendor lock-in: your add-ons stayed with the SaaS provider (Checkout, Reviews). " +
        "Rebuild them in developer-days to get them back: 11 in all.",
      cashDelta: 0,
      kind: "migration",
    });
    expect(addonCharges(log[14]!.entries)).toEqual([]);
    expect(state.model).toBe("iaas");
    expect(sim.monthlyAddonCost(state)).toBe(0);
    const spent = state.spend.addons;
    expect(sim.advance(state, 10).state.spend.addons).toBe(spent);
  });

  it("also leaves behind add-ons bought during the migration", () => {
    const midway = sim.advance(sim.applyAction(onSaas(), migrate("iaas")), 7).state;
    const { state, log } = sim.advance(sim.applyAction(midway, buy("search")), 7);
    expect(log[6]!.entries).toContainEqual(expect.objectContaining({ text: expect.stringContaining("(Search)") }));
    expect(status(state, "search")).toBe("notStarted");
  });

  it("makes the lost features buildable in developer-days from zero, and only then gives back their effect", () => {
    const left = leave().state;
    expect(sim.features(left).map((f) => [f.id, f.status, f.progress])).toEqual([
      ["checkout", "notStarted", 0],
      ["reviews", "notStarted", 0],
      ["search", "notStarted", 0],
    ]);
    // Their growth effect is gone: the same day with Checkout built would grow faster.
    const builtCheckout = { ...left, features: { checkout: { status: "built" as const, progress: 6 } } };
    expect(sim.advance(builtCheckout).state.users).toBeGreaterThan(sim.advance(left).state.users);
    expect(() => sim.applyAction(left, buy("checkout"))).toThrow(expect.objectContaining({ code: "not_saas" }));

    // Rebuild Checkout with the one developer: 6 developer-days.
    const started = sim.applyAction(left, build("checkout"));
    expect(sim.features(started)[0]).toMatchObject({ status: "building", progress: 0, daysLeft: 6 });
    expect(status(sim.advance(started, 5).state, "checkout")).toBe("building");
    const rebuilt = sim.advance(started, 6).state;
    expect(status(rebuilt, "checkout")).toBe("built");
    // Now it boosts growth again, and costs nothing per user.
    expect(sim.advance(rebuilt).state.users).toBeGreaterThan(sim.advance({ ...rebuilt, features: {} }).state.users);
    expect(sim.monthlyAddonCost(rebuilt)).toBe(0);
  });

  it("keeps built features when moving onto SaaS, still active, and loses nothing", () => {
    const built = { ...start(), cash: 100_000, features: { checkout: { status: "built" as const, progress: 6 } } };
    const { state, log } = sim.advance(sim.applyAction(built, migrate("saas")), 14);
    expect(state.model).toBe("saas");
    expect(state.features).toEqual(built.features);
    expect(log.flatMap((d) => d.entries).some((e) => e.text.startsWith("Vendor lock-in"))).toBe(false);
    // Still boosting growth on SaaS, with no add-on bill for it.
    expect(sim.advance(state).state.users).toBeGreaterThan(sim.advance({ ...state, features: {} }).state.users);
    expect(sim.monthlyAddonCost(state)).toBe(0);
  });

  it("pauses a build under way when moving onto SaaS, and carries it on after leaving", () => {
    // Checkout takes 6 developer-days with 1 developer: started 11 days in, 3 are done by the switch.
    const before = sim.applyAction({ ...start(), cash: 100_000, developers: 1 }, migrate("saas"));
    const midway = sim.advance(before, 11).state;
    const { state: switched, log } = sim.advance(sim.applyAction(midway, build("checkout")), 3);
    expect(switched.model).toBe("saas");
    expect(log[2]!.entries).toContainEqual({
      text: "Checkout build paused: on SaaS you buy features as add-ons. It carries on if you leave SaaS.",
      cashDelta: 0,
      kind: "feature",
    });
    const paused = sim.advance(switched, 5);
    expect(sim.features(paused.state)[0]).toMatchObject({ status: "building", progress: 3, daysLeft: null });
    expect(paused.log.flatMap((d) => d.entries).some((e) => e.kind === "feature")).toBe(false);

    const back = sim.advance(sim.applyAction(paused.state, migrate("iaas")), 14).state;
    expect(sim.features(back)[0]).toMatchObject({ status: "building", progress: 3, daysLeft: 3 });
    expect(status(sim.advance(back, 3).state, "checkout")).toBe("built");
  });

  it("is deterministic and resumes identically after a JSON round trip", () => {
    expect(leave(withAddons(), 20)).toEqual(leave(withAddons(), 20));
    const saved = JSON.parse(JSON.stringify(leave(withAddons(), 9).state));
    expect(sim.advance(saved, 11).state).toEqual(leave(withAddons(), 20).state);
  });
});

describe("moving staff between pools", () => {
  const moveTo = (to: "developers" | "ops"): Action => ({ type: "moveStaff", to });

  it("moves one person into the pool, without moving time on or touching cash", () => {
    const state = { ...start(), developers: 2, ops: 1 };
    expect(sim.applyAction(state, moveTo("ops"))).toMatchObject({ developers: 1, ops: 2, day: 1, cash: state.cash });
    expect(sim.applyAction(state, moveTo("developers"))).toMatchObject({ developers: 3, ops: 0 });
  });

  it("rejects a move from an empty pool, and unknown pools", () => {
    expect(() => sim.applyAction(start(), moveTo("ops"))).toThrow(expect.objectContaining({ code: "no_staff" }));
    expect(() => sim.applyAction(start(), { type: "moveStaff", to: "sales" as never })).toThrow(
      expect.objectContaining({ code: "unknown_pool" }),
    );
  });

  it("pays each person their new pool's day rate", () => {
    const { log } = sim.advance(sim.applyAction({ ...start(), developers: 2 }, moveTo("ops")));
    expect(log[0]!.entries.filter((e) => e.category === "staff").map((e) => e.cashDelta)).toEqual([-7, -3]);
  });
});

describe("default migration config", () => {
  it("takes 2 weeks: 5 days planning, 2 testing and 7 moving", () => {
    const { phases } = defaultConfig.migration;
    expect([phases.planning.days, phases.testing.days, phases.moving.days]).toEqual([5, 2, 7]);
  });

  it("bills the new provider from the first day, and can overrun", () => {
    expect(defaultConfig.migration.billNewFromStart).toBe(true);
    const { chance, minDays, maxDays } = defaultConfig.migration.overrun;
    expect(chance).toBeGreaterThan(0);
    expect(chance).toBeLessThan(1);
    expect(minDays).toBeGreaterThan(0);
    expect(maxDays).toBeGreaterThanOrEqual(minDays);
  });

  it("charges no exit penalty for leaving on-prem, and one for leaving a provider", () => {
    expect(defaultConfig.models.onprem.exitPenalty).toBe(0);
    for (const id of ["iaas", "paas", "saas"] as const) expect(defaultConfig.models[id].exitPenalty).toBeGreaterThan(0);
  });
});

describe("scripted events", () => {
  // A spike so big it overloads any model that can't scale, lasting 2 days from day 3: on servers, 2,000 times the
  // CU and DBU demand, 20,000 CU against the starter's 10,000.
  const spike: EventConfig = {
    id: "spike",
    name: "Traffic spike",
    description: "A flood of visitors.",
    layer: "runtime",
    schedule: { type: "fixed", days: [3] },
    days: 2,
    load: { multiplier: 2, extra: 1_000_000, unitMultiplier: 2_000 },
    effects: {
      onprem: { detail: "Your kit can't grow." },
      iaas: {
        opsNeeded: 2,
        scaleCostPerUnit: 0.01,
        detail: "Your ops team added VMs.",
        shortOfOps: { detail: "Nobody to add VMs." },
      },
      paas: { scaleCostPerLoad: 0.0002, detail: "The platform scaled." },
      saas: { scaleCostPerLoad: 0, detail: "The provider absorbed it." },
    },
  };
  const breakIn = { detail: "Attackers got in.", downtimeHours: 6, cost: { amount: 50, text: "Cleaning up" } };
  // A patch on day 2 that needs ops on on-prem and IaaS, and is the provider's on PaaS and SaaS.
  const patch: EventConfig = {
    id: "patch",
    name: "OS security patch",
    description: "A hole in the OS.",
    layer: "os",
    schedule: { type: "fixed", days: [2] },
    days: 1,
    effects: {
      onprem: { opsNeeded: 2, detail: "Your ops team patched it.", shortOfOps: breakIn },
      iaas: { opsNeeded: 1, detail: "Your ops team patched it.", shortOfOps: breakIn },
      paas: { detail: "The provider patched it." },
      saas: { detail: "The provider patched it." },
    },
  };
  const withEvents = (...events: EventConfig[]) => createSim({ ...config, events });
  const quiet = withEvents();
  const begin = (s: Sim, model: string, ops = 0, seed = 42) => ({
    ...s.newGame({ companyName: "Acme", productType: "social", model, seed }),
    ops,
  });
  const play = (s: Sim, model: string, days: number, ops = 0) => s.advance(begin(s, model, ops), days);
  const eventDays = (log: DayLog[]) => log.filter((d) => d.entries.some((e) => e.kind === "event")).map((d) => d.day);
  const charges = (log: DayLog[], text: string) =>
    log.flatMap((d) => d.entries).filter((e) => e.category === "infrastructure" && e.text.includes(text));

  describe("schedule", () => {
    it("fires on the fixed days from config, and logs each day it's on", () => {
      const s = withEvents({ ...patch, schedule: { type: "fixed", days: [2, 5] } });
      expect(eventDays(play(s, "paas", 9).log)).toEqual([2, 5]);
      expect(eventDays(play(withEvents(spike), "paas", 9).log)).toEqual([3, 4]);
    });

    it("lists the events on the day just played, and none on other days", () => {
      const s = withEvents(patch, spike);
      const day = (n: number) => s.events(play(s, "paas", n - 1).state).map((e) => e.id);
      expect([day(2), day(3), day(4), day(5), day(6)]).toEqual([["patch"], ["spike"], ["spike"], [], []]);
      expect(s.events(begin(s, "paas"))).toEqual([]);
    });

    it("logs both, in config order, when two are on the same day", () => {
      const s = withEvents({ ...patch, schedule: { type: "fixed", days: [3] } }, spike);
      const { state, log } = play(s, "paas", 2);
      expect(log[1]!.entries.filter((e) => e.kind === "event").map((e) => e.text.split(":")[0])).toEqual([
        "OS security patch",
        "Traffic spike",
      ]);
      expect(s.events(state).map((e) => e.id)).toEqual(["patch", "spike"]);
    });

    it("picks seeded days with the game's RNG: different days in range, the same for the same seed", () => {
      const s = withEvents({ ...patch, schedule: { type: "seeded", count: 3, fromDay: 5, toDay: 40 } });
      const daysFor = (seed: number) => eventDays(s.advance(begin(s, "paas", 0, seed), 45).log);
      for (const seed of [1, 2, 3, 42]) {
        const days = daysFor(seed);
        expect(days).toHaveLength(3);
        for (const day of days) expect(day).toBeGreaterThanOrEqual(5);
        for (const day of days) expect(day).toBeLessThanOrEqual(40);
        expect(daysFor(seed)).toEqual(days);
      }
      expect(new Set([1, 2, 3, 4, 5, 6].map((seed) => daysFor(seed).join())).size).toBeGreaterThan(1);
    });

    it("is deterministic for the same seed and config", () => {
      const s = withEvents(patch, { ...spike, schedule: { type: "seeded", count: 2, fromDay: 5, toDay: 25 } });
      expect(play(s, "iaas", 30, 1)).toEqual(play(s, "iaas", 30, 1));
    });
  });

  describe("traffic spike", () => {
    const s = withEvents(spike);

    it("melts on-prem kit: an outage on every day of the spike, even fully staffed", () => {
      const { state, log } = play(s, "onprem", 5, s.opsNeeded("onprem"));
      expect(log.filter((d) => d.entries.some((e) => e.kind === "outage")).map((d) => d.day)).toEqual([3, 4]);
      expect(state.outageDays).toBe(2);
      expect(play(quiet, "onprem", 5, 3).state.outageDays).toBe(0);
      expect(s.events(play(s, "onprem", 2, 3).state)[0]).toMatchObject({ id: "spike", hit: true });
    });

    it("scales PaaS: it stays up but is charged for the burst, in infrastructure", () => {
      const { state, log } = play(s, "paas", 5, 1);
      const without = play(quiet, "paas", 5, 1).state;
      expect(state.outageDays).toBe(0);
      const burst = charges(log, "Traffic spike: scaled up");
      expect(burst.map((e) => log.find((d) => d.entries.includes(e))!.day)).toEqual([3, 4]);
      const cost = -burst.reduce((sum, e) => sum + e.cashDelta, 0);
      // About 1,000,000 extra load a day at £0.0002.
      expect(cost).toBeGreaterThanOrEqual(400);
      expect(state.spend.infrastructure).toBe(without.spend.infrastructure + cost);
      expect(state.cash).toBe(without.cash - cost);
    });

    it("shows PaaS at full capacity on a day it scaled, then back to normal", () => {
      const scaled = play(s, "paas", 2, 1).state;
      expect(s.capacity(scaled)).toBe(scaled.load);
      expect(s.capacity(play(s, "paas", 4, 1).state)).toBe(1_000_000);
    });

    it("scales IaaS from its second day with enough ops: extra VMs are ready the next day, and charged per unit", () => {
      const { state, log } = play(s, "iaas", 5, 2);
      // Day 3 runs on the servers you have; from day 4 the extra VMs meet it.
      expect(log.filter((d) => d.entries.some((e) => e.kind === "outage")).map((d) => d.day)).toEqual([3]);
      expect(state.outageDays).toBe(1);
      const burst = charges(log, "Traffic spike: extra VMs");
      expect(burst.map((e) => log.find((d) => d.entries.includes(e))!.day)).toEqual([4]);
      // About 20,000 CU and 20,000 DBU of demand against 10,000 of each: 20,000 units over, at 1p.
      expect(-burst[0]!.cashDelta).toBeGreaterThan(150);
      expect(-burst[0]!.cashDelta).toBeLessThan(250);
      expect(burst[0]!.text).toMatch(/^Traffic spike: extra VMs for [\d,]+ CU and [\d,]+ DBU over capacity$/);
      // On the day it scaled, capacity met the demand, extra VMs included; back to the rented servers after.
      const scaled = play(s, "iaas", 3, 2).state;
      expect(s.units(scaled)).toMatchObject({ burst: true });
      expect(s.units(scaled)!.cu.capacity).toBe(s.units(scaled)!.cu.demand);
      expect(s.units(play(s, "iaas", 4, 2).state)).toMatchObject({ burst: false, cu: { capacity: 10_000 } });
    });

    it("multiplies CU and DBU demand on servers, and outages count against the weakest tier", () => {
      const quietDay = play(quiet, "iaas", 2, 2).state;
      const spikeDay = play(s, "iaas", 2, 2).state;
      expect(spikeDay.demand.cu / quietDay.demand.cu).toBeCloseTo(2_000, -1);
      expect(spikeDay.demand.dbu / quietDay.demand.dbu).toBeCloseTo(2_000, -1);
      const outage = play(s, "iaas", 2, 2).log[1]!.entries.find((e) => e.kind === "outage")!;
      expect(outage.text).toMatch(/^Outage: compute \(CU\) hit \d+% of capacity\./);
    });

    it("degrades IaaS short of ops: an outage, and no scaling charge", () => {
      const { state, log } = play(s, "iaas", 5, 1);
      expect(state.outageDays).toBe(2);
      expect(charges(log, "scaled up")).toHaveLength(0);
      const [event] = s.events(play(s, "iaas", 2, 1).state);
      expect(event).toMatchObject({ shortOfOps: true, hit: true });
      expect(event!.outcome).toBe("Nobody to add VMs. You needed 2 ops staff.");
    });

    it("is the provider's problem on SaaS: no outage and no charge", () => {
      const { state } = play(s, "saas", 5);
      const without = play(quiet, "saas", 5).state;
      expect(state).toMatchObject({ outageDays: 0, cash: without.cash, users: without.users });
      expect(s.events(play(s, "saas", 2).state)[0]).toMatchObject({ shortOfOps: false, hit: false });
    });
  });

  describe("OS security patch", () => {
    const s = withEvents(patch);
    const after = (model: string, ops: number) => play(s, model, 1, ops);

    it("is handled by enough ops on on-prem and IaaS, at no cost", () => {
      for (const [model, ops] of [
        ["onprem", 2],
        ["iaas", 1],
      ] as const) {
        const { state } = after(model, ops);
        expect(state).toMatchObject({ outageDays: 0, cash: play(quiet, model, 1, ops).state.cash });
        expect(s.events(state)[0]).toMatchObject({ shortOfOps: false, hit: false, outcome: "Your ops team patched it." });
      }
    });

    it("hits on-prem and IaaS short of ops: downtime and a clean-up charge", () => {
      for (const [model, ops] of [
        ["onprem", 1],
        ["iaas", 0],
      ] as const) {
        const { state, log } = after(model, ops);
        const without = play(quiet, model, 1, ops).state;
        expect(state).toMatchObject({ outageDays: 1, downtimeHours: 6, cash: without.cash - 50 });
        expect(charges(log, "OS security patch: Cleaning up")).toHaveLength(1);
        expect(log[0]!.entries.find((e) => e.kind === "outage")!.text).toBe(
          "Outage: OS security patch. Down 6 hours; growth slowed.",
        );
        expect(s.events(state)[0]).toMatchObject({ shortOfOps: true, hit: true });
      }
    });

    it("does nothing on PaaS or SaaS, even with no ops, and says the provider handled it", () => {
      for (const model of ["paas", "saas"]) {
        const { state, log } = after(model, 0);
        const quietRun = play(quiet, model, 1, 0);
        expect({ ...state, events: [], schedule: [] }).toEqual(quietRun.state);
        expect(log[0]!.entries.filter((e) => e.kind !== "event")).toEqual(quietRun.log[0]!.entries);
        expect(s.events(state)[0]).toMatchObject({ hit: false, owner: "provider", outcome: "The provider patched it." });
      }
    });
  });

  describe("explanations", () => {
    it("name the layer and who owns it on the student's model", () => {
      const s = withEvents(patch);
      const explain = (model: string) => s.events(play(s, model, 1, 0).state)[0]!;
      expect(MODEL_IDS.map((m) => explain(m).responsibility)).toEqual([
        "OS and patching is your job on-prem.",
        "OS and patching is your job on IaaS.",
        "OS and patching is the provider's job on PaaS.",
        "OS and patching is the provider's job on SaaS.",
      ]);
      for (const m of MODEL_IDS) {
        const event = explain(m);
        const owner = responsibilityStack(m).find((l) => l.id === "os")!.owner;
        expect(event).toMatchObject({ layer: "os", owner, model: m, name: "OS security patch" });
        expect(event.description).toBe("A hole in the OS.");
      }
    });

    it("name the layer in the day log", () => {
      const { log } = play(withEvents(spike), "paas", 2, 1);
      expect(log[1]!.entries[0]).toEqual({
        text: "Traffic spike: Runtime and scaling is the provider's job on PaaS. The platform scaled.",
        cashDelta: 0,
        kind: "event",
      });
    });
  });

  it("hits the model being left when it lands mid-migration", () => {
    const s = withEvents(patch);
    const migrating = s.applyAction(begin(s, "iaas"), { type: "startMigration", model: "paas" });
    const { state } = s.advance(migrating);
    expect(state.migration).not.toBeNull();
    expect(s.events(state)[0]).toMatchObject({ model: "iaas", owner: "you", hit: true });
    expect(state.outageDays).toBe(1);
  });
});

describe("provider events and the SaaS feature gap", () => {
  // The ids of the default events.
  const priceRise: EventConfig = {
    id: "providerPriceRise",
    name: "Provider price rise",
    description: "New prices from today.",
    layer: "hardware",
    schedule: { type: "fixed", days: [3] },
    days: 1,
    effects: {
      onprem: { detail: "No provider to put prices up." },
      iaas: { priceRise: { percent: 50 }, detail: "You can't control it." },
      paas: { priceRise: { percent: 50 }, detail: "You can't control it." },
      saas: { priceRise: { percent: 100, addons: true }, detail: "Add-ons too." },
    },
  };
  const down = { downtimeHours: 5, detail: "You waited for the provider." };
  const outage: EventConfig = {
    id: "providerOutage",
    name: "Provider outage",
    description: "The provider's data centre went down.",
    layer: "facilities",
    schedule: { type: "fixed", days: [3] },
    days: 2,
    effects: { onprem: { detail: "Your own building." }, iaas: down, paas: down, saas: down },
  };
  const gap: EventConfig = {
    id: "saasFeatureGap",
    name: "A feature SaaS can't provide",
    description: "Customers want something the platform doesn't do.",
    layer: "application",
    schedule: { type: "fixed", days: [3] },
    days: 1,
    effects: {
      saas: {
        featureGap: { growthMultiplier: 0.5, features: { ecommerce: "Own couriers", social: "Custom feeds", video: "Own player" } },
        detail: "Not yours to change.",
      },
    },
  };
  const withEvents = (...events: EventConfig[]) => createSim({ ...config, events });
  const quiet = withEvents();
  const begin = (s: Sim, model: string, seed = 42) => ({
    ...s.newGame({ companyName: "Acme", productType: "social", model, seed }),
    ops: s.opsNeeded(model as (typeof MODEL_IDS)[number]),
  });
  const play = (s: Sim, model: string, days: number) => s.advance(begin(s, model), days);
  const dayCharges = (log: DayLog[], category: string) =>
    log.map((d) => -d.entries.filter((e) => e.category === category).reduce((sum, e) => sum + e.cashDelta, 0));
  // State with only what an event leaves behind cleared, to compare with a run that had no events.
  const withoutEvents = (state: GameState) => ({ ...state, schedule: [], events: [] });

  describe("price rise", () => {
    const s = withEvents(priceRise);

    it("puts the provider's charges up from the day it fires, in infrastructure", () => {
      // PaaS is £900 a month, £30 a day; 50% more is £1,350, £45 a day.
      const { state, log } = play(s, "paas", 5);
      expect(dayCharges(log, "infrastructure")).toEqual([30, 45, 45, 45, 45]);
      expect(log[1]!.entries).toContainEqual(
        expect.objectContaining({ text: "PaaS running costs (£1,350 a month)", category: "infrastructure", cashDelta: -45 }),
      );
      expect(s.monthlyInfrastructureCost(state)).toBe(1350);
      expect(state.cash).toBe(play(quiet, "paas", 5).state.cash - 4 * 15);
      expect(s.events(play(s, "paas", 2).state)[0]).toMatchObject({ id: "providerPriceRise", hit: true });
    });

    it("puts SaaS add-on prices up too when config says so, in addons", () => {
      let state = { ...begin(s, "saas"), developers: 1 };
      state = s.applyAction(state, { type: "buyAddon", feature: "checkout" });
      const { state: after, log } = s.advance(state, 2);
      expect(log[0]!.entries.find((e) => e.category === "addons")!.text).toContain("at £0.30 a month");
      expect(log[1]!.entries.find((e) => e.category === "addons")!.text).toContain("at £0.60 a month");
      expect(s.monthlyAddonCost(after)).toBe(Math.round(after.users * 0.6));
      // SaaS is £150 a month, so £300 after doubling.
      expect(s.monthlyInfrastructureCost(after)).toBe(300);
    });

    it("leaves add-on prices alone when it doesn't cover them", () => {
      const s2 = withEvents({ ...priceRise, effects: { ...priceRise.effects, saas: { priceRise: { percent: 100 }, detail: "" } } });
      const state = s2.applyAction({ ...begin(s2, "saas"), developers: 1 }, { type: "buyAddon", feature: "checkout" });
      const { log } = s2.advance(state, 2);
      expect(log[1]!.entries.find((e) => e.category === "addons")!.text).toContain("at £0.30 a month");
    });

    it("sticks to the provider: the migration quote prices leaving at the new prices", () => {
      const risen = play(s, "paas", 2).state;
      // 14 days at £45, not £30.
      expect(s.migrationQuote(risen, "iaas").proRata).toBe(14 * 45);
      expect(s.migrationQuote(risen, "iaas").doubleBilling).toBe(14 * 20);
    });

    it("compounds when it fires again", () => {
      const twice = withEvents({ ...priceRise, schedule: { type: "fixed", days: [3, 5] } });
      // £900, then £1,350, then £2,025 a month.
      expect(twice.monthlyInfrastructureCost(play(twice, "paas", 5).state)).toBe(2025);
    });
  });

  describe("provider outage", () => {
    const s = withEvents(outage);

    it("takes down every model that depends on a provider, on each day it's on", () => {
      for (const model of ["iaas", "paas", "saas"]) {
        const { state, log } = play(s, model, 5);
        expect(state).toMatchObject({ outageDays: 2, downtimeHours: 10 });
        expect(s.uptime(state)).toBeLessThan(100);
        expect(log.filter((d) => d.entries.some((e) => e.kind === "outage")).map((d) => d.day)).toEqual([3, 4]);
        expect(log[1]!.entries.find((e) => e.kind === "outage")!.text).toBe(
          "Outage: Provider outage. Down 5 hours; growth slowed.",
        );
        expect(s.events(play(s, model, 2).state)[0]).toMatchObject({ id: "providerOutage", owner: "provider", hit: true });
      }
    });
  });

  describe("on-prem", () => {
    it("is untouched by provider events: no price rise, no outage", () => {
      const s = withEvents(priceRise, outage);
      const { state, log } = play(s, "onprem", 6);
      const quietRun = play(quiet, "onprem", 6);
      expect(withoutEvents(state)).toEqual(quietRun.state);
      expect(log.map((d) => d.entries.filter((e) => e.kind !== "event"))).toEqual(quietRun.log.map((d) => d.entries));
      expect(s.uptime(state)).toBe(100);
      expect(s.events(play(s, "onprem", 2).state)).toEqual([
        expect.objectContaining({ id: "providerPriceRise", owner: "you", hit: false }),
        expect.objectContaining({ id: "providerOutage", owner: "you", hit: false }),
      ]);
    });
  });

  describe("feature SaaS can't provide", () => {
    const s = withEvents(gap);

    it("doesn't happen at all off SaaS", () => {
      for (const model of ["onprem", "iaas", "paas"]) {
        const { state, log } = play(s, model, 6);
        expect(withoutEvents(state)).toEqual(play(quiet, model, 6).state);
        expect(log.flatMap((d) => d.entries).filter((e) => e.kind === "event")).toEqual([]);
        expect(s.events(play(s, model, 2).state)).toEqual([]);
        expect(s.featureGaps(state)).toEqual([]);
      }
    });

    it("on SaaS, multiplies growth by the configured amount from the day it fires", () => {
      const before = play(s, "saas", 1).state;
      const gapDay = play(s, "saas", 2).state;
      const quietDay = play(quiet, "saas", 2).state;
      // Same seed, so the same random growth: only the gap's multiplier differs (to within rounding).
      const growth = gapDay.users - before.users;
      const usual = quietDay.users - before.users;
      expect(usual).toBeGreaterThan(10);
      expect(Math.abs(growth - usual * 0.5)).toBeLessThanOrEqual(1);
      expect(s.events(gapDay)[0]).toMatchObject({ id: "saasFeatureGap", owner: "shared", hit: true });
    });

    it("lasts every day after, shown as an open gap that matches config", () => {
      const { state } = play(s, "saas", 10);
      expect(s.events(state)).toEqual([]);
      expect(state.users).toBeLessThan(play(quiet, "saas", 10).state.users);
      expect(s.featureGaps(state)).toEqual([
        {
          id: "saasFeatureGap",
          name: "A feature SaaS can't provide",
          feature: "Custom feeds",
          model: "saas",
          layer: "application",
          owner: "shared",
          growthMultiplier: 0.5,
          detail: "Not yours to change.",
        },
      ]);
    });

    it("closes when a migration off SaaS completes", () => {
      const opened = play(s, "saas", 2).state;
      const migrating = s.applyAction(opened, { type: "startMigration", model: "paas" });
      const during = s.advance(migrating, 13);
      expect(s.featureGaps(during.state)).toHaveLength(1);
      const { state, log } = s.advance(during.state);
      expect(state.model).toBe("paas");
      expect(s.featureGaps(state)).toEqual([]);
      expect(log[0]!.entries.map((e) => e.text)).toContainEqual(expect.stringContaining("Feature gap closed"));
    });
  });

  describe("explanations", () => {
    it("teach lock-in and name the layer, the lasting effect first", () => {
      const s = withEvents(priceRise, outage, gap);
      const explain = (model: string) => s.events(play(s, model, 2).state);
      expect(explain("paas").map((e) => [e.id, e.responsibility, e.outcome])).toEqual([
        ["providerPriceRise", "Hardware is the provider's job on PaaS.", "Its prices are up 50% from today. You can't control it."],
        ["providerOutage", "Building, power, cooling is the provider's job on PaaS.", "You waited for the provider."],
      ]);
      expect(explain("saas").map((e) => e.outcome)).toEqual([
        "Its prices are up 100% from today, add-ons included. Add-ons too.",
        "You waited for the provider.",
        "Your customers want Custom feeds, and no add-on offers it. Growth is 50% slower without it. Not yours to change.",
      ]);
      expect(explain("saas")[2]!.responsibility).toBe("Application / features is shared between you and the provider on SaaS.");
      expect(explain("onprem").map((e) => e.responsibility)).toEqual([
        "Hardware is your job on-prem.",
        "Building, power, cooling is your job on-prem.",
      ]);
    });

    it("appear in the day log", () => {
      const { log } = play(withEvents(priceRise), "iaas", 2);
      expect(log[1]!.entries[0]).toEqual({
        text: "Provider price rise: Hardware is the provider's job on IaaS. Its prices are up 50% from today. You can't control it.",
        cashDelta: 0,
        kind: "event",
      });
    });
  });

  it("is deterministic for the same seed and config", () => {
    const seeded = (e: EventConfig, fromDay: number) => ({ ...e, schedule: { type: "seeded" as const, count: 1, fromDay, toDay: 20 } });
    const s = withEvents(seeded(priceRise, 2), seeded(outage, 2), seeded(gap, 2));
    for (const model of MODEL_IDS) expect(play(s, model, 25)).toEqual(play(s, model, 25));
  });
});

describe("default events", () => {
  const ids = defaultConfig.events.map((e) => e.id);
  const event = (id: string) => defaultConfig.events.find((e) => e.id === id)!;

  it("include all four events, with unique ids", () => {
    expect(ids).toEqual(
      expect.arrayContaining(["trafficSpike", "osPatch", "providerPriceRise", "providerOutage", "saasFeatureGap"]),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("make the OS patch the student's job only where they own the OS", () => {
    const { effects, layer } = event("osPatch");
    for (const m of MODEL_IDS) {
      const yours = responsibilityStack(m).find((l) => l.id === layer)!.owner === "you";
      expect(yours).toBe(m === "onprem" || m === "iaas");
      expect(effects[m]?.opsNeeded !== undefined).toBe(yours);
    }
    expect(effects.paas).toEqual({ detail: expect.any(String) });
    expect(effects.saas).toEqual({ detail: expect.any(String) });
  });

  it("fire an OS patch on day 3, so every game meets an event in its first lesson", () => {
    const s = createSim(defaultConfig);
    const state = s.advance(s.newGame({ companyName: "Acme", productType: "social", model: "paas", seed: 7 }), 2).state;
    expect(s.events(state).map((e) => e.id)).toEqual(["osPatch"]);
  });

  it("hit only the models that depend on a provider with a price rise or outage", () => {
    for (const id of ["providerPriceRise", "providerOutage"]) {
      const { effects } = event(id);
      expect(effects.onprem).toEqual({ detail: expect.any(String) });
      for (const m of ["iaas", "paas", "saas"] as const) {
        expect(effects[m]!.priceRise ?? effects[m]!.downtimeHours).toBeDefined();
      }
    }
    expect(event("providerPriceRise").effects.saas!.priceRise!.addons).toBe(true);
  });

  it("give only SaaS the feature gap, naming a feature for every product that no add-on offers", () => {
    const { effects } = event("saasFeatureGap");
    expect(Object.keys(effects)).toEqual(["saas"]);
    const { features, growthMultiplier } = effects.saas!.featureGap!;
    expect(growthMultiplier).toBeLessThan(1);
    for (const p of PRODUCT_TYPE_IDS) {
      const addons = defaultConfig.productTypes[p].features.map((f) => f.name.toLowerCase());
      expect(addons).not.toContain(features[p].toLowerCase());
    }
  });

  it("let a SaaS company that never leaves still reach day 180 with the feature gap", () => {
    const s = createSim(defaultConfig);
    const state = s.advance(s.newGame({ companyName: "Acme", productType: "video", model: "saas", seed: 7 }), 179).state;
    expect(state).toMatchObject({ day: 180, status: "finished" });
    expect(s.featureGaps(state)).toHaveLength(1);
  });

  it("melt on-prem in a spike, but scale PaaS", () => {
    const s = createSim({ ...defaultConfig, events: [{ ...event("trafficSpike"), schedule: { type: "fixed", days: [10] } }] });
    const run = (model: (typeof MODEL_IDS)[number]) => {
      const start = s.newGame({ companyName: "Acme", productType: "social", model, seed: 7 });
      return s.advance({ ...start, ops: s.opsNeeded(model) }, 9).state;
    };
    expect(run("onprem").outageDays).toBeGreaterThan(0);
    expect(run("paas").outageDays).toBe(0);
  });
});

describe("pricing and income", () => {
  // Each product with its own free share and fair price.
  const priced = (
    overrides: Partial<GameConfig["pricing"]> = {},
    freeShares = { ecommerce: 0.4, social: 0.8, video: 0.5 },
  ) =>
    createSim({
      ...config,
      pricing: { ...config.pricing, ...overrides },
      productTypes: {
        ecommerce: { ...config.productTypes.ecommerce, pricing: { fairPrice: 30, freeShare: freeShares.ecommerce, conversionRate: 0 } },
        social: { ...config.productTypes.social, pricing: { fairPrice: 6, freeShare: freeShares.social, conversionRate: 0 } },
        video: { ...config.productTypes.video, pricing: { fairPrice: 9, freeShare: freeShares.video, conversionRate: 0 } },
      },
    });
  const s = priced();
  const begin = (sm = s, productType = "ecommerce", model = "iaas", seed = 42) =>
    sm.newGame({ companyName: "Acme", productType, model, seed });
  const setPrice = (price: number): Action => ({ type: "setPrice", price });
  const incomeEntries = (log: DayLog[]) => log.flatMap((d) => d.entries).filter((e) => e.kind === "income");

  it("starts each product at its fair price, with its own share of free users", () => {
    const states = Object.fromEntries(PRODUCT_TYPE_IDS.map((p) => [p, begin(s, p)]));
    expect(states.ecommerce).toMatchObject({ users: 1000, paidUsers: 600, price: 30, income: 0 });
    expect(states.social).toMatchObject({ users: 1000, paidUsers: 200, price: 6 });
    expect(states.video).toMatchObject({ users: 1000, paidUsers: 500, price: 9 });
    expect(s.fairPrice(states.social!)).toBe(6);
  });

  it("pays paid users × monthly price ÷ 30 a day, logged as income", () => {
    const state = s.applyAction(begin(), setPrice(15));
    // 600 paying users at £15 a month: £300 a day.
    expect(s.dailyIncome(state)).toBe(300);
    const { state: after, log } = s.advance(state);
    expect(incomeEntries(log)).toEqual([
      { text: "Income: 600 paying users at £15 a month", cashDelta: 300, kind: "income" },
    ]);
    expect(after.income).toBe(300);
    expect(after.spendByDay.at(-1)!.income).toBe(300);
  });

  it("pays nothing for free users", () => {
    const allFree = priced({}, { ecommerce: 1, social: 1, video: 1 });
    const { state, log } = allFree.advance(begin(allFree), 10);
    expect(state.paidUsers).toBe(0);
    expect(state.income).toBe(0);
    expect(incomeEntries(log)).toEqual([]);
  });

  it("rounds each day's income to the pound", () => {
    // 600 × £9.99 ÷ 30 = £199.80.
    expect(s.dailyIncome(s.applyAction(begin(), setPrice(9.99)))).toBe(200);
  });

  it("changes the price without moving time on or touching cash, and charges it from the next day", () => {
    const before = begin();
    const state = s.applyAction(before, setPrice(60));
    expect(state).toMatchObject({ day: before.day, cash: before.cash, price: 60 });
    expect(incomeEntries(s.advance(state).log)[0]!.cashDelta).toBe(1200);
  });

  it.each([
    [0, "bad_price"],
    [-5, "bad_price"],
    [Number.NaN, "bad_price"],
    [1000.01, "price_too_high"],
  ])("rejects a price of %d", (price, code) => {
    expect(() => s.applyAction(begin(), setPrice(price))).toThrow(expect.objectContaining({ code }));
  });

  it("accepts the configured maximum, which is high, and keeps a price to the penny", () => {
    expect(s.applyAction(begin(), setPrice(1000)).price).toBe(1000);
    expect(s.applyAction(begin(), setPrice(12.345)).price).toBe(12.35);
    const low = priced({ maxPrice: 50 });
    expect(() => low.applyAction(begin(low), setPrice(51))).toThrow(expect.objectContaining({ code: "price_too_high" }));
  });

  it("keeps income apart from the cost categories, so cash is starting cash + income − spend", () => {
    const { state } = s.advance(s.applyAction(begin(), { type: "hire", pool: "ops" }), 20);
    const spent = SPEND_CATEGORIES.reduce((sum, c) => sum + state.spend[c], 0);
    expect(state.income).toBeGreaterThan(0);
    expect(state.cash).toBe(1000 + state.income - spent);
    expect(state.spendByDay.reduce((sum, d) => sum + d.income, 0)).toBe(state.income);
    const summary = s.summarise(state);
    expect(summary).toMatchObject({ income: state.income, profit: state.income - spent, paidUsers: state.paidUsers });
    // The cash after each day steps by that day's income less its spend.
    for (let i = 1; i < summary.days.length; i++) {
      const d = summary.days[i]!;
      expect(d.cash - summary.days[i - 1]!.cash).toBe(d.income - d.staff - d.infrastructure - d.addons);
    }
  });

  it("puts load on the servers from free users as well as paying ones", () => {
    const firstDay = (free: number) => {
      const sm = priced({}, { ecommerce: free, social: free, video: free });
      // No load noise, so load is exactly users × load per user.
      const video = sm.config.productTypes.video;
      const quiet = createSim({
        ...sm.config,
        productTypes: { ...sm.config.productTypes, video: { ...video, growth: { ...video.growth, loadNoise: 0 } } },
      });
      return quiet.advance(begin(quiet, "video")).state;
    };
    const [mostlyPaid, mostlyFree] = [0, 0.9].map(firstDay);
    expect(mostlyFree!.paidUsers).toBeLessThan(mostlyPaid!.paidUsers);
    // Video has 5 load per user: 1,000 users make 5,000 load however many pay.
    expect(mostlyFree!.load).toBe(5000);
    expect(mostlyPaid!.load).toBe(5000);
  });

  it("bills SaaS per-user and add-on fees on free users too", () => {
    const sm = createSim({
      ...s.config,
      models: { ...s.config.models, saas: { ...s.config.models.saas, monthlyCost: 0, monthlyCostPerUser: 0.3 } },
      productTypes: {
        ...s.config.productTypes,
        ecommerce: { ...s.config.productTypes.ecommerce, pricing: { fairPrice: 30, freeShare: 0.9, conversionRate: 0 } },
      },
    });
    let state = begin(sm, "ecommerce", "saas");
    state = sm.applyAction(state, { type: "hire", pool: "developers" });
    state = sm.applyAction(state, { type: "buyAddon", feature: "checkout" });
    expect(state.paidUsers).toBe(100);
    const charged = sm.advance(state).log[0]!.entries.filter((e) => e.category && e.category !== "staff");
    // All 1,000 users at £0.30 a month, not just the 100 paying: £10 a day each.
    expect(charged).toEqual([
      { text: "SaaS per-user fee (1,000 users at £0.30 a month)", cashDelta: -10, category: "infrastructure" },
      { text: "Add-on: Checkout (1,000 users at £0.30 a month)", cashDelta: -10, category: "addons" },
    ]);
  });

  it("grows slower at a higher price, with a smaller share of new users paying", () => {
    const run = (price: number) => {
      const start = begin(s, "social");
      const { state } = s.advance(s.applyAction(start, setPrice(price)), 30);
      const grown = state.users - start.users;
      return { grown, paidShare: (state.paidUsers - start.paidUsers) / grown };
    };
    const fair = run(6);
    const dear = run(12);
    expect(dear.grown).toBeLessThan(fair.grown * 0.7);
    expect(dear.paidShare).toBeLessThan(fair.paidShare * 0.7);
    // At the fair price, new users pay at the product's paid share: 20% on this social network.
    expect(fair.paidShare).toBeCloseTo(0.2, 1);
  });

  it("grows faster at a lower price, up to the configured boost", () => {
    const grown = (sm: Sim, price: number) => {
      const start = begin(sm, "social");
      return sm.advance(sm.applyAction(start, setPrice(price)), 20).state.users - start.users;
    };
    expect(grown(s, 3)).toBeGreaterThan(grown(s, 6) * 1.3);
    // With no boost allowed, a cut doesn't help growth.
    const capped = priced({ maxGrowthBoost: 1 });
    expect(grown(capped, 3)).toBe(grown(capped, 6));
  });

  it("has no effect on growth or payers with zero sensitivity", () => {
    const flat = priced({ growthSensitivity: 0, paidShareSensitivity: 0 });
    const play = (price: number) => flat.advance(flat.applyAction(begin(flat, "social"), setPrice(price)), 20).state;
    const [fair, dear] = [play(6), play(60)];
    expect(dear.users).toBe(fair.users);
    expect(dear.paidUsers).toBe(fair.paidUsers);
  });

  it("is deterministic for the same seed and actions, and resumes identically after a JSON round trip", () => {
    const play = () => s.advance(s.applyAction(begin(s, "video"), setPrice(14)), 25);
    expect(play()).toEqual(play());
    const part = s.advance(s.applyAction(begin(s, "video"), setPrice(14)), 10).state;
    const resumed = s.advance(JSON.parse(JSON.stringify(part)) as GameState, 15).state;
    expect(resumed).toEqual(play().state);
  });

  it("does not mutate the input state", () => {
    const before = begin();
    const copy = structuredClone(before);
    s.advance(s.applyAction(before, setPrice(40)), 3);
    expect(before).toEqual(copy);
  });
});

describe("support, tickets and satisfaction", () => {
  // 1,000 users, half paying: 500 × 0.05 + 500 × 0.01 = 30 tickets a day. Each support person clears 10. No growth, so
  // the day's tickets only change where users leave.
  const ticketed = (overrides: Partial<GameConfig["support"]> = {}, freeShare = 0.5, extra: Partial<GameConfig> = {}) =>
    createSim({
      ...config,
      productTypes: {
        ...config.productTypes,
        social: {
          ...config.productTypes.social,
          growth: { ...growth, dailyGrowth: 0 },
          pricing: { fairPrice: 30, freeShare, conversionRate: 0 },
          support: { ticketsPerPaidUser: 0.05, ticketsPerFreeUser: 0.01 },
        },
      },
      support: { ...config.support, ...overrides },
      ...extra,
    });
  const s = ticketed();
  const begin = (sm: Sim, model = "iaas", support = 0) => ({
    ...sm.newGame({ companyName: "Acme", productType: "social", model, seed: 42 }),
    ops: sm.opsNeeded(model as (typeof MODEL_IDS)[number]),
    support,
  });
  const supportLog = (log: DayLog[]) => log.flatMap((d) => d.entries.filter((e) => e.kind === "support").map((e) => e.text));
  const withCapacity = (capacity: number) => ticketed({}, 0.5, { servers: iaasCapacity(capacity).servers });

  it("starts with no tickets, no backlog and happy customers", () => {
    expect(begin(s)).toMatchObject({ ticketsToday: 0, clearedToday: 0, backlog: 0, satisfaction: 100 });
  });

  it("raises tickets each day from users × the product's rates", () => {
    expect(s.usualTickets(begin(s))).toBe(30);
    expect(s.advance(begin(s, "iaas", 3)).state).toMatchObject({ ticketsToday: 30, clearedToday: 30, backlog: 0 });
  });

  it("scales tickets with users", () => {
    const state = begin(s);
    const doubled = { ...state, users: state.users * 2, paidUsers: state.paidUsers * 2 };
    expect(s.advance(doubled).state.ticketsToday).toBe(2 * s.advance(state).state.ticketsToday);
    // As users grow, so do the day's tickets.
    const growing = createSim({ ...s.config, productTypes: { ...s.config.productTypes, social: { ...s.config.productTypes.social, growth } } });
    const later = growing.advance(begin(growing, "iaas", 10), 20).state;
    expect(later.users).toBeGreaterThan(state.users);
    expect(later.ticketsToday).toBeGreaterThan(30);
  });

  it("raises fewer tickets from free users than paying ones", () => {
    const allFree = ticketed({}, 1);
    const allPaid = ticketed({}, 0);
    expect(allFree.advance(begin(allFree)).state.ticketsToday).toBe(10);
    expect(allPaid.advance(begin(allPaid)).state.ticketsToday).toBe(50);
    // But free users still raise some: you pay for them to use the service.
    expect(allFree.usualTickets(begin(allFree))).toBeGreaterThan(0);
  });

  it("adds a burst for an outage, bigger the longer it's down, and logs a big one", () => {
    const small = withCapacity(800);
    const tiny = withCapacity(400);
    const one = small.advance(begin(small, "iaas", 10)).state;
    const worse = tiny.advance(begin(tiny, "iaas", 10)).state;
    // 1,000 users × 0.01 per hour down.
    expect(one.downtimeHours).toBeGreaterThan(0);
    expect(one.burstTickets).toBe(Math.round(1000 * 0.01 * one.downtimeHours));
    expect(worse.downtimeHours).toBeGreaterThan(one.downtimeHours);
    expect(worse.burstTickets).toBeGreaterThan(one.burstTickets);
    expect(worse.ticketsToday).toBe(30 + worse.burstTickets);
    const { log } = tiny.advance(begin(tiny, "iaas", 10));
    expect(supportLog(log)[0]).toMatch(/^Ticket burst: \d+ extra tickets after \d+ hours down\./);
    // No outage, no burst.
    expect(s.advance(begin(s, "iaas", 10)).state.burstTickets).toBe(0);
  });

  it("adds a burst for a provider outage, on every model it hits", () => {
    const down = { downtimeHours: 5, detail: "You waited for the provider." };
    const outage: EventConfig = {
      id: "providerOutage",
      name: "Provider outage",
      description: "The provider's data centre went down.",
      layer: "facilities",
      schedule: { type: "fixed", days: [2] },
      days: 1,
      effects: { onprem: { detail: "Your own building." }, iaas: down, paas: down, saas: down },
    };
    const sm = ticketed({}, 0.5, { events: [outage] });
    for (const model of ["iaas", "paas", "saas"]) {
      const { state, log } = sm.advance(begin(sm, model, 10));
      // 1,000 users × 5 hours × 0.01 = 50 extra tickets, more than the usual 30.
      expect(state, model).toMatchObject({ burstTickets: 50, ticketsToday: 80 });
      expect(supportLog(log)).toContainEqual(expect.stringContaining("Ticket burst: 50 extra tickets after 5 hours down"));
    }
    expect(sm.advance(begin(sm, "onprem", 10)).state.burstTickets).toBe(0);
  });

  it("only logs a burst that's big against the day's usual tickets", () => {
    const quiet = createSim({ ...withCapacity(800).config, support: { ...config.support, ticketsPerUserPerHourDown: 0.001 } });
    const { state, log } = quiet.advance(begin(quiet, "iaas", 10));
    expect(state.burstTickets).toBeGreaterThan(0);
    expect(state.burstTickets).toBeLessThan(15);
    expect(state.downtimeHours).toBeGreaterThan(0);
    expect(supportLog(log)).toEqual([]);
  });

  it("clears tickets per support person and carries the rest over as a backlog when understaffed", () => {
    const state = s.advance(begin(s, "iaas", 1), 3).state;
    expect(s.dailyClearance(state)).toBe(10);
    expect(state.clearedToday).toBe(10);
    // 30 a day in, 10 a day out.
    expect(state.backlog).toBe(3 * 30 - 3 * 10);
    expect(s.advance(begin(s, "iaas", 0), 3).state).toMatchObject({ clearedToday: 0, backlog: 90 });
    // Enough staff clears the backlog, oldest tickets and today's alike.
    const caught = s.advance({ ...state, support: 20 }).state;
    expect(caught).toMatchObject({ clearedToday: 60 + caught.ticketsToday, backlog: 0 });
  });

  it("lowers satisfaction as the backlog grows, smoothly, and logs it crossing below good and poor", () => {
    let state = begin(s);
    const history = [state.satisfaction];
    const log: DayLog[] = [];
    for (let i = 0; i < 20; i++) {
      const result = s.advance(state);
      state = result.state;
      log.push(...result.log);
      history.push(state.satisfaction);
    }
    for (let i = 1; i < history.length; i++) {
      expect(history[i]).toBeLessThanOrEqual(history[i - 1]!);
      // Never jumps: at most the speed's share of the whole range in a day.
      expect(history[i - 1]! - history[i]!).toBeLessThanOrEqual(20);
    }
    expect(state.satisfaction).toBeLessThan(config.support.poorSatisfaction);
    expect(supportLog(log)).toEqual([expect.stringContaining("fell below 70%"), expect.stringContaining("fell below 40%")]);
  });

  it("recovers once the backlog is cleared, and logs it coming back", () => {
    let state = { ...s.advance(begin(s), 20).state, support: 20 };
    const history = [state.satisfaction];
    const log: DayLog[] = [];
    for (let i = 0; i < 25; i++) {
      const result = s.advance(state);
      state = result.state;
      log.push(...result.log);
      history.push(state.satisfaction);
    }
    expect(state.backlog).toBe(0);
    // It rises every day once the old tickets are cleared, a few days in.
    for (let i = 5; i < history.length; i++) expect(history[i]).toBeGreaterThan(history[i - 1]!);
    expect(state.satisfaction).toBeGreaterThan(95);
    expect(supportLog(log)).toEqual([expect.stringContaining("back above 40%"), expect.stringContaining("back above 70%")]);
  });

  it("moves faster with a higher satisfaction speed", () => {
    const quick = ticketed({ satisfactionSpeed: 0.5 });
    expect(quick.advance(begin(quick), 5).state.satisfaction).toBeLessThan(s.advance(begin(s), 5).state.satisfaction);
  });

  describe("effect on users", () => {
    // No tickets here, so satisfaction only changes where a test sets it. A full market, so nobody new arrives and
    // every change is churn.
    const full = createSim({
      ...config,
      productTypes: {
        ...config.productTypes,
        social: { ...config.productTypes.social, growth: { ...growth, startingUsers: 1000, marketSize: 1000 } },
      },
    });
    const at = (sm: Sim, satisfaction: number) => ({
      ...sm.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 42 }),
      ops: 2,
      satisfaction,
    });

    it("makes users leave when satisfaction is low, more the lower it is, and none when it's good", () => {
      expect(full.advance(at(full, 100)).state.users).toBe(1000);
      expect(full.advance(at(full, 70)).state.users).toBe(1000);
      // 2% a day at 0%, half that at half of good.
      expect(full.advance(at(full, 0)).state.users).toBe(980);
      expect(full.advance(at(full, 35)).state.users).toBe(990);
    });

    it("loses paid and free users alike", () => {
      expect(full.advance({ ...at(full, 0), paidUsers: 400 }).state).toMatchObject({ users: 980, paidUsers: 392 });
    });

    it("slows growth when satisfaction is low", () => {
      const grown = (satisfaction: number) => sim.advance({ ...start(), satisfaction }).state.users - start().users;
      expect(grown(100)).toBeGreaterThan(0);
      expect(grown(70)).toBe(grown(100));
      expect(grown(20)).toBeLessThan(grown(100) * 0.6);
      const over = (satisfaction: number) => sim.advance({ ...start(), satisfaction }, 30).state.users;
      expect(over(10)).toBeLessThan(over(100));
    });

    it("takes the churn and growth cut from config", () => {
      const harsh = createSim({ ...full.config, support: { ...config.support, churnAtZero: 0.1 } });
      expect(harsh.advance(at(harsh, 0)).state.users).toBe(900);
      const gentle = createSim({ ...config, support: { ...config.support, growthAtZero: 1, churnAtZero: 0 } });
      const state = gentle.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 42 });
      expect(gentle.advance({ ...state, satisfaction: 0 }).state.users).toBe(gentle.advance(state).state.users);
    });
  });

  it("is the company's job on every model, SaaS included: the provider doesn't answer your customers", () => {
    const onSaas = s.advance(begin(s, "saas", 0), 15).state;
    expect(onSaas.backlog).toBeGreaterThan(300);
    expect(onSaas.satisfaction).toBeLessThan(70);
    for (const model of MODEL_IDS) {
      // The same tickets, backlog and satisfaction on every model: support doesn't depend on who runs the platform.
      const neglected = s.advance(begin(s, model, 0), 15).state;
      expect(neglected, model).toMatchObject({ backlog: onSaas.backlog, satisfaction: onSaas.satisfaction });
      const staffed = s.advance(begin(s, model, 3), 15).state;
      expect(staffed.backlog, model).toBe(0);
      expect(staffed.satisfaction, model).toBe(100);
    }
  });

  it("pays support staff their day rate", () => {
    const { log } = s.advance(begin(s, "iaas", 2));
    expect(log[0]!.entries).toContainEqual({ text: "Support pay (2)", cashDelta: -4, category: "staff" });
  });

  it("moves people into and out of support", () => {
    const state = { ...begin(s), developers: 2, ops: 1, support: 1 };
    expect(s.applyAction(state, { type: "moveStaff", from: "developers", to: "support" })).toMatchObject({
      developers: 1,
      support: 2,
    });
    expect(s.applyAction(state, { type: "moveStaff", from: "support", to: "ops" })).toMatchObject({ support: 0, ops: 2 });
    expect(() => s.applyAction({ ...state, support: 0 }, { type: "moveStaff", from: "support", to: "ops" })).toThrow(
      expect.objectContaining({ code: "no_staff" }),
    );
    expect(() => s.applyAction(state, { type: "moveStaff", from: "ops", to: "ops" })).toThrow(
      expect.objectContaining({ code: "same_pool" }),
    );
    // Without a from, a move into support comes from developers.
    expect(s.applyAction(state, { type: "moveStaff", to: "support" })).toMatchObject({ developers: 1, support: 2 });
  });

  it("is deterministic, and resumes identically after a JSON round trip", () => {
    const play = () => s.advance(begin(s, "iaas", 2), 30);
    expect(play()).toEqual(play());
    const part = s.advance(begin(s, "iaas", 2), 12).state;
    expect(s.advance(JSON.parse(JSON.stringify(part)) as GameState, 18).state).toEqual(play().state);
  });

  it("does not mutate the input state", () => {
    const before = begin(s);
    const copy = structuredClone(before);
    s.advance(before, 5);
    expect(before).toEqual(copy);
  });
});

describe("price waves and the price lock", () => {
  // A shop at a £30 fair price, 600 of 1,000 users paying, with no growth or random variation and no satisfaction
  // churn, so every change in users comes from the wave. Waves at their default strengths.
  const waved = (overrides: Partial<GameConfig["pricing"]> = {}) =>
    createSim({
      ...config,
      pricing: { ...defaultConfig.pricing, ...overrides },
      support: { ...config.support, churnAtZero: 0 },
      productTypes: {
        ...config.productTypes,
        ecommerce: {
          ...config.productTypes.ecommerce,
          growth: { ...growth, dailyGrowth: 0, growthNoise: 0 },
          pricing: { fairPrice: 30, freeShare: 0.4, conversionRate: 0 },
        },
      },
    });
  const s = waved();
  const begin = (sm = s) => sm.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 });
  const setPrice = (price: number): Action => ({ type: "setPrice", price });
  // Paying and all users at the end of each day played.
  const daily = (sm: Sim, state: GameState, days: number) => {
    const out: { users: number; paidUsers: number; burstTickets: number }[] = [];
    let current = state;
    for (let i = 0; i < days; i++) {
      current = sm.advance(current).state;
      out.push({ users: current.users, paidUsers: current.paidUsers, burstTickets: current.burstTickets });
    }
    return { days: out, state: current };
  };
  const priceLog = (log: DayLog[]) => log.flatMap((d) => d.entries.filter((e) => e.kind === "price").map((e) => e.text));

  it("defaults to a 7-day wave and a 14-day lock", () => {
    expect(defaultConfig.pricing).toMatchObject({ waveDays: 7, lockDays: 14 });
  });

  it("gives a rise a small reaction the next day, then a backlash over the wave length", () => {
    const start = begin();
    const { days } = daily(s, s.applyAction(start, setPrice(45)), 10);
    const lost = days.map((d, i) => (i === 0 ? start.paidUsers : days[i - 1]!.paidUsers) - d.paidUsers);
    const total = start.paidUsers - days[6]!.paidUsers;
    expect(total).toBeGreaterThan(100);
    // Day 1 is the small reaction: a twentieth of the whole.
    expect(lost[0]).toBeGreaterThan(0);
    expect(lost[0]).toBeLessThan(total * 0.1);
    // Then it builds and fades: every backlash day loses more than day 1, with the peak in the middle.
    for (let i = 1; i < 7; i++) expect(lost[i]).toBeGreaterThan(lost[0]!);
    expect(Math.max(...lost)).toBe(Math.max(lost[3]!, lost[4]!));
    // And it's over after the wave length: nothing more is lost.
    expect(lost.slice(7)).toEqual([0, 0, 0]);
    // Some left altogether, and some dropped to free.
    expect(days[6]!.users).toBeLessThan(start.users);
    expect(start.users - days[6]!.users).toBeLessThan(total);
  });

  it("gives a cut a positive wave of new users and upgrades", () => {
    const start = begin();
    const { days } = daily(s, s.applyAction(start, setPrice(20)), 8);
    expect(days[0]!.users).toBeGreaterThan(start.users);
    expect(days[0]!.paidUsers).toBeGreaterThan(start.paidUsers);
    for (let i = 1; i < 7; i++) {
      expect(days[i]!.users).toBeGreaterThan(days[i - 1]!.users);
      expect(days[i]!.paidUsers).toBeGreaterThan(days[i - 1]!.paidUsers);
    }
    expect(days[7]).toEqual({ ...days[6], burstTickets: 0 });
    const preview = s.pricePreview(start, 20);
    expect(preview.direction).toBe("cut");
    expect(preview.total.upgraded).toBeGreaterThan(0);
    expect(preview.total.joined).toBeGreaterThan(0);
    expect(preview.total).toMatchObject({ left: 0, toFree: 0, tickets: 0 });
  });

  it("scales the wave with the size of the change against the fair price: a small tweak barely registers", () => {
    const start = begin();
    const affected = (price: number) => {
      const t = s.pricePreview(start, price).total;
      return t.left + t.toFree;
    };
    // +£1.50 (5%) loses under 2% of 600 payers; +£15 (50%) loses more than ten times as many.
    expect(affected(31.5)).toBeLessThan(12);
    expect(affected(45)).toBeGreaterThan(10 * affected(31.5));
    // Bigger changes always hit harder, up to the cap.
    const sizes = [33, 36, 40, 45, 50].map(affected);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]!);
    expect(affected(1000)).toBe(Math.round(600 * defaultConfig.pricing.maxRiseShare));
    // The same for cuts.
    const gained = (price: number) => s.pricePreview(start, price).total.joined;
    expect(gained(28.5)).toBeLessThan(gained(15) / 10);
    // The curve is tunable: at 1, the wave grows in step with the change.
    const linear = waved({ waveCurve: 1, dearness: 0 });
    const lin = (price: number) => linear.pricePreview(begin(linear), price).total;
    expect(lin(45).left + lin(45).toFree).toBeCloseTo(2 * (lin(37.5).left + lin(37.5).toFree), -1);
  });

  it("locks the price after a change, rejecting changes with the days left, then frees it", () => {
    let state = s.applyAction(begin(), setPrice(33));
    expect(s.priceLockDaysLeft(state)).toBe(14);
    const tryAgain = (st: GameState) => () => s.applyAction(st, setPrice(36));
    expect(tryAgain(state)).toThrow(
      expect.objectContaining({ code: "price_locked", details: { daysLeft: 14 }, message: expect.stringContaining("14 more days") }),
    );
    state = s.advance(state, 13).state;
    expect(s.priceLockDaysLeft(state)).toBe(1);
    expect(tryAgain(state)).toThrow(expect.objectContaining({ code: "price_locked", details: { daysLeft: 1 } }));
    // Setting the same price again is no change, so it isn't refused and doesn't restart the lock.
    expect(s.applyAction(state, setPrice(33))).toEqual(state);
    state = s.advance(state).state;
    expect(s.priceLockDaysLeft(state)).toBe(0);
    expect(s.applyAction(state, setPrice(36)).price).toBe(36);
    // The lock length is config.
    const short = waved({ lockDays: 2 });
    const st = short.advance(short.applyAction(begin(short), setPrice(33)), 2).state;
    expect(short.applyAction(st, setPrice(36)).price).toBe(36);
  });

  it("adds backlash tickets to support on each day of a rise, logged as a burst", () => {
    const start = begin();
    const preview = s.pricePreview(start, 45);
    expect(preview.total.tickets).toBeGreaterThan(0);
    const { state, log } = s.advance(s.applyAction(start, setPrice(45)), 7);
    expect(state.backlog).toBe(preview.total.tickets);
    const bursts = log.flatMap((d) => d.entries).filter((e) => e.text.startsWith("Ticket burst"));
    expect(bursts).toHaveLength(7);
    expect(bursts[0]!.text).toContain("after your price rise (backlash day 1 of 7)");
    // A cut raises none.
    expect(s.advance(s.applyAction(start, setPrice(20)), 7).state.backlog).toBe(0);
  });

  it.each([
    ["rise", 45],
    ["small rise", 31],
    ["cut", 20],
  ])("previews a %s exactly as it plays out when nothing else changes", (_, price) => {
    const start = begin();
    const preview = s.pricePreview(start, price);
    const { days, state } = daily(s, s.applyAction(start, setPrice(price)), 7);
    expect(state.users).toBe(preview.users);
    expect(state.paidUsers).toBe(preview.paidUsers);
    expect(s.dailyIncome(state)).toBe(preview.dailyIncome);
    expect(state.priceWave!.done).toEqual(preview.total);
    // Day by day too.
    let paid = start.paidUsers;
    preview.days.forEach((d, i) => {
      paid += d.joinedPaid + d.upgraded - d.left - d.toFree;
      expect(days[i]!.paidUsers).toBe(paid);
      expect(days[i]!.burstTickets).toBe(d.tickets);
      expect(d.day).toBe(start.day + 1 + i);
    });
  });

  it("previews without changing anything, today's price as no wave, and says when the price is locked", () => {
    const start = begin();
    const copy = structuredClone(start);
    const preview = s.pricePreview(start, 45);
    expect(start).toEqual(copy);
    expect(preview).toMatchObject({ price: 45, currentPrice: 30, direction: "rise", locked: false, lockDaysLeft: 0, lockDays: 14 });
    expect(preview.currentDailyIncome).toBe(600);
    expect(preview.dailyIncome).toBe(Math.round((preview.paidUsers * 45) / 30));
    expect(preview.days).toHaveLength(7);
    expect(s.pricePreview(start, 30)).toMatchObject({ direction: "none", days: [], dailyIncome: 600, paidUsers: 600 });
    const locked = s.advance(s.applyAction(start, setPrice(33)), 3).state;
    expect(s.pricePreview(locked, 40)).toMatchObject({ locked: true, lockDaysLeft: 11 });
    expect(() => s.pricePreview(start, 0)).toThrow(expect.objectContaining({ code: "bad_price" }));
    expect(() => s.pricePreview(start, 1000.01)).toThrow(expect.objectContaining({ code: "price_too_high" }));
  });

  it("finds a point where raising the price stops paying", () => {
    const start = begin();
    const income = (price: number) => s.pricePreview(start, price).dailyIncome;
    expect(income(37.5)).toBeGreaterThan(income(30));
    expect(income(60)).toBeLessThan(income(37.5));
    expect(income(90)).toBeLessThan(income(30));
  });

  it("shows the wave under way, logs it each day and keeps each price change", () => {
    const start = begin();
    let state = s.applyAction(start, setPrice(45));
    expect(state.priceChanges).toEqual([{ day: 2, from: 30, to: 45 }]);
    expect(s.priceWave(state)).toMatchObject({ direction: "rise", from: 30, to: 45, day: 0, length: 7, remaining: 7 });
    const { state: after3, log } = s.advance(state, 3);
    const view = s.priceWave(after3)!;
    expect(view).toMatchObject({ day: 3, remaining: 4 });
    expect(view.done.left + view.done.toFree).toBe(start.paidUsers - after3.paidUsers);
    expect(view.days.map((d) => d.day)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    const lines = priceLog(log);
    expect(lines[0]).toMatch(/^Customers noticed your price rise from £30 to £45: \d+ paying users left and \d+ dropped to free\. Expect a backlash over the next 6 days\.$/);
    expect(lines[1]).toMatch(/^Price backlash, day 2 of 7: complaints are spreading online\./);
    const end = s.advance(after3, 4);
    expect(priceLog(end.log).at(-1)).toMatch(/^The backlash from your price rise is over\. In all, \d+ paying users left and \d+ dropped to free\.$/);
    expect(s.priceWave(end.state)).toBeNull();
    state = s.advance(end.state, 7).state;
    expect(s.applyAction(state, setPrice(25)).priceChanges).toHaveLength(2);
    expect(priceLog(s.advance(s.applyAction(state, setPrice(25))).log)[0]).toMatch(
      /^Customers noticed your price cut from £45 to £25: \d+ new users joined and \d+ free users started paying\./,
    );
  });

  it("is deterministic, and resumes a wave identically after a JSON round trip", () => {
    const play = () => s.advance(s.applyAction(begin(), setPrice(50)), 10);
    expect(play()).toEqual(play());
    const part = s.advance(s.applyAction(begin(), setPrice(50)), 4).state;
    expect(s.advance(JSON.parse(JSON.stringify(part)) as GameState, 6).state).toEqual(play().state);
  });

  it("does less where users have already gone, never going below zero", () => {
    const start = begin();
    // Users vanish before the wave: the planned losses can't take paid users below zero.
    const state = { ...s.applyAction(start, setPrice(200)), paidUsers: 5 };
    const after = s.advance(state, 7).state;
    expect(after.paidUsers).toBe(0);
    expect(after.users).toBeGreaterThanOrEqual(0);
  });
});

describe("free-to-paid conversion", () => {
  // A social network with 10,000 users, half of them free, no growth, no random variation and no satisfaction churn,
  // so every change in paying users comes from conversion. A base rate of 1% a day, and plenty of capacity.
  const converting = (overrides: Partial<GameConfig["conversion"]> = {}, extra: Partial<GameConfig> = {}, rate = 0.01) =>
    createSim({
      ...config,
      productTypes: {
        ...config.productTypes,
        social: {
          ...config.productTypes.social,
          growth: { ...growth, startingUsers: 10_000, dailyGrowth: 0, growthNoise: 0 },
          pricing: { fairPrice: 30, freeShare: 0.5, conversionRate: rate },
        },
      },
      support: { ...config.support, churnAtZero: 0 },
      conversion: { ...defaultConfig.conversion, ...overrides },
      ...extra,
    });
  const s = converting();
  const begin = (sm = s, model = "iaas") => ({
    ...sm.newGame({ companyName: "Acme", productType: "social", model, seed: 42 }),
    ops: sm.opsNeeded(model as (typeof MODEL_IDS)[number]),
  });
  const conversionLog = (log: DayLog[]) => log.flatMap((d) => d.entries.filter((e) => e.kind === "conversion"));
  const multiplier = (sm: Sim, state: GameState, id: string) => sm.conversion(state).drivers.find((d) => d.id === id)!.multiplier;
  const setPrice = (price: number): Action => ({ type: "setPrice", price });

  it("starts with no conversions, and every driver neutral or helping", () => {
    const state = begin();
    const view = s.conversion(state);
    expect(state).toMatchObject({ conversionsToday: 0, conversions: 0, recentHoursDown: [] });
    expect(view).toMatchObject({ today: 0, total: 0, baseRate: 0.01, recentUptime: 100 });
    expect(view.drivers.map((d) => [d.id, d.effect])).toEqual([
      ["features", "neutral"],
      ["uptime", "helping"],
      ["satisfaction", "helping"],
      ["price", "neutral"],
    ]);
    // 100% uptime and satisfaction each multiply by 1 + 0.25.
    expect(view.rate).toBeCloseTo(0.01 * 1.25 * 1.25, 10);
  });

  it("turns a share of free users into payers every day, and logs it", () => {
    let state = begin();
    const { rate } = s.conversion(state);
    let total = 0;
    for (let day = 0; day < 5; day++) {
      const { state: next, log } = s.advance(state);
      const free = state.users - state.paidUsers;
      expect(next.conversionsToday).toBe(Math.round(free * rate));
      expect(next.conversionsToday).toBeGreaterThan(0);
      expect(next.paidUsers - state.paidUsers).toBe(next.conversionsToday);
      expect(next.users).toBe(state.users);
      const [entry] = conversionLog(log);
      expect(entry).toMatchObject({ cashDelta: 0, kind: "conversion" });
      expect(entry!.text).toMatch(/^Free to paid: \d[\d,]* of \d[\d,]* free users started paying \([\d.]+% a day\)\.$/);
      total += next.conversionsToday;
      state = next;
    }
    expect(state.conversions).toBe(total);
    expect(s.conversion(state)).toMatchObject({ today: state.conversionsToday, total });
    // Converted users pay from the next day.
    expect(s.dailyIncome(state)).toBeGreaterThan(s.dailyIncome(begin()));
  });

  it("takes its base rate from the product's config, and none convert at 0", () => {
    expect(defaultConfig.productTypes.ecommerce.pricing.conversionRate).toBeGreaterThan(0);
    const none = converting({}, {}, 0);
    const { state, log } = none.advance(begin(none), 5);
    expect(state.paidUsers).toBe(5000);
    expect(conversionLog(log)).toEqual([]);
  });

  it("rises with each feature built", () => {
    const state = begin();
    const oneBuilt = { ...state, features: { checkout: { status: "built" as const, progress: 6 } } };
    const twoBuilt = { ...oneBuilt, features: { ...oneBuilt.features, reviews: { status: "built" as const, progress: 5 } } };
    expect(multiplier(s, oneBuilt, "features")).toBeCloseTo(1.15, 10);
    expect(multiplier(s, twoBuilt, "features")).toBeCloseTo(1.3, 10);
    expect(s.conversion(twoBuilt).drivers[0]).toMatchObject({ effect: "helping", value: 2 });
    const converted = (st: GameState) => s.advance(st).state.conversionsToday;
    expect(converted(oneBuilt)).toBeGreaterThan(converted(state));
    expect(converted(twoBuilt)).toBeGreaterThan(converted(oneBuilt));
    // A build under way doesn't count until it's finished.
    expect(multiplier(s, { ...state, features: { checkout: { status: "building", progress: 3 } } }, "features")).toBe(1);
  });

  it("rises with add-ons bought on SaaS", () => {
    const state = { ...begin(s, "saas"), developers: 1 };
    const bought = s.applyAction(state, { type: "buyAddon", feature: "search" });
    expect(multiplier(s, bought, "features")).toBeCloseTo(1.15, 10);
    expect(s.advance(bought).state.conversionsToday).toBeGreaterThan(s.advance(state).state.conversionsToday);
  });

  it("falls with recent outages and recovers once the uptime window has passed", () => {
    // 10,000 users at 1 load each on 5,000 capacity: an outage every day.
    const overloaded = converting({}, { servers: iaasCapacity(5_000).servers });
    const good = s.advance(begin(), 3).state;
    const bad = overloaded.advance(begin(overloaded), 3).state;
    expect(bad.recentHoursDown).toHaveLength(3);
    expect(overloaded.conversion(bad).recentUptime).toBeLessThan(90);
    expect(multiplier(overloaded, bad, "uptime")).toBeLessThan(1);
    expect(overloaded.conversion(bad).drivers[1]!.effect).toBe("hurting");
    expect(bad.conversions).toBeLessThan(good.conversions);
    // Only the last uptimeDays (7) days count: after a week without outages, uptime is back to 100%.
    const recovered = s.advance(bad, 7).state;
    expect(recovered.recentHoursDown).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(s.conversion(recovered).recentUptime).toBe(100);
    expect(multiplier(s, recovered, "uptime")).toBeCloseTo(1.25, 10);
    // At the neutral uptime it neither helps nor hurts.
    const neutral = { ...good, recentHoursDown: [24 * 7 * 0.05, 0, 0, 0, 0, 0, 0] };
    expect(multiplier(s, neutral, "uptime")).toBeCloseTo(1, 10);
  });

  it("rises with satisfaction, and falls below good satisfaction", () => {
    const state = begin();
    const at = (satisfaction: number) => ({ ...state, satisfaction });
    expect(multiplier(s, at(70), "satisfaction")).toBeCloseTo(1, 10);
    expect(multiplier(s, at(100), "satisfaction")).toBeCloseTo(1.25, 10);
    expect(multiplier(s, at(40), "satisfaction")).toBeCloseTo(0.75, 10);
    const converted = (sat: number) => s.advance(at(sat)).state.conversionsToday;
    expect(converted(100)).toBeGreaterThan(converted(70));
    expect(converted(70)).toBeGreaterThan(converted(30));
  });

  it("falls with a price above the fair price, and isn't raised by a price below it", () => {
    const state = begin();
    const dear = s.applyAction(state, setPrice(60));
    expect(multiplier(s, dear, "price")).toBeCloseTo(0.25, 10);
    expect(s.conversion(dear).drivers[3]).toMatchObject({ effect: "hurting", value: 2 });
    expect(s.advance(dear).state.conversionsToday).toBeLessThan(s.advance(state).state.conversionsToday);
    // A cheap price brings its upgrades once, through the price wave, not every day here as well.
    const cheap = s.applyAction(state, setPrice(15));
    expect(multiplier(s, cheap, "price")).toBe(1);
    expect(s.conversion(cheap).rate).toBe(s.conversion(state).rate);
    // The effect is tunable: at 0 a high price makes no difference.
    const flat = converting({ priceSensitivity: 0 });
    expect(multiplier(flat, flat.applyAction(begin(flat), setPrice(60)), "price")).toBe(1);
  });

  it("is capped at the highest rate", () => {
    const capped = converting({ maxRate: 0.012, perFeature: 1 });
    const state = { ...begin(capped), features: { checkout: { status: "built" as const, progress: 6 } } };
    expect(capped.conversion(state).rate).toBe(0.012);
    expect(capped.advance(state).state.conversionsToday).toBe(60);
  });

  describe("with a price cut's wave", () => {
    const waved = (waveOverrides: Partial<GameConfig["pricing"]> = {}) =>
      converting({}, { pricing: { ...defaultConfig.pricing, ...waveOverrides } });

    it("counts the wave's upgrades and the day's conversions separately, never the same user twice", () => {
      const sm = waved();
      let state = sm.applyAction(begin(sm), setPrice(20));
      for (let i = 0; i < 7; i++) {
        const before = state;
        const { state: next, log } = sm.advance(before);
        const doneBefore = before.priceWave!.done;
        const done = next.priceWave!.done;
        const upgraded = done.upgraded - doneBefore.upgraded;
        const joinedPaid = done.joinedPaid - doneBefore.joinedPaid;
        // Paying users rise by the wave's upgrades and new payers plus the day's conversions, and nothing more.
        expect(next.paidUsers - before.paidUsers).toBe(upgraded + joinedPaid + next.conversionsToday);
        // Conversions come from the free users the wave left, at the usual rate: the cut doesn't raise it.
        const freeAfterWave = next.users - (next.paidUsers - next.conversionsToday);
        expect(next.conversionsToday).toBe(Math.round(freeAfterWave * sm.conversion(before).rate));
        expect(sm.conversion(before).drivers[3]!.multiplier).toBe(1);
        // Each has its own log line.
        expect(log[0]!.entries.some((e) => e.kind === "price")).toBe(true);
        expect(conversionLog(log)).toHaveLength(1);
        state = next;
      }
      expect(state.conversions).toBeGreaterThan(0);
      expect(state.priceWave!.done.upgraded).toBeGreaterThan(0);
    });

    it("has no one left to convert once the wave has upgraded every free user", () => {
      const sm = waved({ waveDays: 1, cutUpgradeStrength: 100, maxCutUpgrade: 1, cutGainStrength: 0 });
      const { state, log } = sm.advance(sm.applyAction(begin(sm), setPrice(20)));
      expect(state.priceWave!.done.upgraded).toBe(5000);
      expect(state.paidUsers).toBe(state.users);
      expect(state.conversionsToday).toBe(0);
      expect(conversionLog(log)).toEqual([]);
    });
  });

  it("is deterministic, and carries on identically after a JSON round trip", () => {
    const overloaded = converting({}, { models: { ...config.models, iaas: { ...config.models.iaas, capacity: 9_000 } } });
    const play = () => overloaded.advance(overloaded.applyAction(begin(overloaded), setPrice(40)), 20);
    expect(play()).toEqual(play());
    const part = overloaded.advance(overloaded.applyAction(begin(overloaded), setPrice(40)), 8).state;
    expect(overloaded.advance(JSON.parse(JSON.stringify(part)) as GameState, 12).state).toEqual(play().state);
  });

  it("makes a free user worth having over a game by default, without making the free tier pointless", () => {
    // The chance a free user starts paying within the game at each product's base rate, nothing helping or hurting.
    for (const p of PRODUCT_TYPE_IDS) {
      const rate = defaultConfig.productTypes[p].pricing.conversionRate;
      const chance = 1 - (1 - rate) ** defaultConfig.finalDay;
      expect(chance).toBeGreaterThan(0.2);
      expect(chance).toBeLessThan(0.6);
    }
  });
});
