import { describe, expect, it } from "vitest";
import {
  createSim,
  defaultConfig,
  MODEL_IDS,
  PRODUCT_TYPE_IDS,
  responsibilityStack,
  SPEND_CATEGORIES,
  SimError,
  type Action,
  type DayLog,
  type EventConfig,
  type GameConfig,
  type GameState,
  type GameStateV4,
  type GameStateV5,
  type GameStateV6,
  type GameStateV7,
  type LogEntry,
  type Sim,
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

function costs(monthlyCost: number) {
  return { upfrontCost: 0, monthlyCost, monthlyCostPerUser: 0, exitPenalty: 0 };
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
      features,
    },
    social: { name: "Social", profile: "", growth: { ...growth, dailyGrowth: 0.06 }, features },
    video: { name: "Video", profile: "", growth: { ...growth, dailyGrowth: 0.02, loadPerUser: 5 }, features },
  },
  // No starting staff, so the model's running cost is the only charge unless a test hires someone.
  staff: {
    developers: { name: "Developers", personName: "developer", dayRate: 7, startingCount: 0 },
    ops: { name: "Ops", personName: "ops person", dayRate: 3, startingCount: 0 },
  },
  capacity: { unstaffedShare: 0.4 },
  outage: { baseHours: 2, hoursPerOverload: 20, growthMultiplier: 0.25 },
  billing: { daysPerMonth: 30 },
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

  it("can buy add-ons on a game saved before features existed", () => {
    const { features: _, ...rest } = startOn();
    const v4: GameStateV4 = { ...rest, version: 4 };
    expect(feature(sim.applyAction(v4, buy("checkout")), "checkout").status).toBe("addon");
  });
});

describe("state saved before features existed (version 4)", () => {
  const v4 = () => {
    const { features: _f, ...rest } = JSON.parse(JSON.stringify(sim.advance(start(), 4).state));
    return { ...rest, version: 4 } as GameStateV4;
  };

  it("loads with no features started and keeps everything else", () => {
    const state = sim.load(v4());
    expect(state).toEqual({ ...sim.advance(start(), 4).state, version: 8, features: {} });
    expect(sim.features(state).every((f) => f.status === "notStarted")).toBe(true);
  });

  it("can start a build and advance", () => {
    const state = sim.applyAction({ ...v4(), developers: 6 }, { type: "buildFeature", feature: "checkout" });
    expect(sim.advance(state).state.features).toEqual({ checkout: { status: "built", progress: 6 } });
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
      version: 8,
      status: "playing",
      developers: 0,
      ops: 0,
      users: 1000,
      load: 1000,
      outageDays: 0,
      downtimeHours: 0,
      spend: { staff: 0, infrastructure: 0, addons: 0 },
      spendByDay: [],
      features: {},
      migration: null,
      migrations: 0,
      schedule: [],
      events: [],
      priceRises: {},
      addonPriceRise: 1,
      featureGaps: [],
    });
  });

  it("still advances, charging only the model's running cost", () => {
    const { state } = sim.advance(v1());
    expect(state).toMatchObject({ version: 8, day: 6, cash: 900, developers: 0, ops: 0 });
  });

  it("accepts actions", () => {
    expect(sim.applyAction(v1(), { type: "hire", pool: "developers" })).toMatchObject({ version: 8, developers: 1 });
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
    expect(state).toMatchObject({ version: 8, developers: 1, ops: 2, users: 1000, load: 5000, outageDays: 0 });
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
    expect(state).toMatchObject({ version: 8, status: "playing", day: 5, cash: 920, spendByDay: [] });
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

  it("lets every product reach day 180 without outages when fully staffed on IaaS, bar the provider's", () => {
    for (const p of ["ecommerce", "social", "video"]) {
      const state = run(p, "iaas", sim180.opsNeeded("iaas"));
      // The provider outage is the one an IaaS company can't staff its way out of.
      expect(state.outageDays).toBe(1);
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
      expect(end).toMatchObject({ day: defaultConfig.finalDay, status: "playing" });
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
    const s = createSim({
      ...config,
      models: {
        ...config.models,
        iaas: { ...config.models.iaas, capacity: 3000 },
        paas: { ...config.models.paas, capacity: 5000 },
      },
    });
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

    it("quotes from older saved state", () => {
      const { migration: _m, migrations: _n, ...rest } = start();
      expect(s.migrationQuote({ ...rest, version: 5 } as GameStateV5, "paas").total).toBe(1050);
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

  it("quotes and loses add-ons from state saved before migration existed (version 5)", () => {
    const { migration: _m, migrations: _n, ...rest } = withAddons();
    const v5 = { ...rest, version: 5 } as GameStateV5;
    expect(sim.migrationQuote(v5, "paas").lostAddons.map((a) => a.id)).toEqual(["checkout", "reviews"]);
    expect(leave(sim.load(v5)).state.features).toEqual({});
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

describe("state saved before migration existed (version 5)", () => {
  const v5 = () => {
    const { migration: _m, migrations: _n, ...rest } = JSON.parse(JSON.stringify(sim.advance(start(), 4).state));
    return { ...rest, version: 5 } as GameStateV5;
  };

  it("loads with no migration and none made, and keeps everything else", () => {
    expect(sim.load(v5())).toEqual(sim.advance(start(), 4).state);
    expect(sim.migration(v5())).toBeNull();
  });

  it("can start a migration and advance", () => {
    const state = sim.applyAction(v5(), { type: "startMigration", model: "paas" });
    expect(sim.advance(state, 14).state).toMatchObject({ version: 8, model: "paas", migrations: 1 });
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
  // A spike so big it overloads any model that can't scale, lasting 2 days from day 3.
  const spike: EventConfig = {
    id: "spike",
    name: "Traffic spike",
    description: "A flood of visitors.",
    layer: "runtime",
    schedule: { type: "fixed", days: [3] },
    days: 2,
    load: { multiplier: 2, extra: 1_000_000 },
    effects: {
      onprem: { detail: "Your kit can't grow." },
      iaas: {
        opsNeeded: 2,
        scaleCostPerLoad: 0.0001,
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

    it("scales IaaS when there are enough ops, and is charged for it", () => {
      const { state, log } = play(s, "iaas", 5, 2);
      expect(state.outageDays).toBe(0);
      expect(charges(log, "scaled up")).toHaveLength(2);
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

  describe("state saved before events existed (version 6)", () => {
    const s = withEvents({ ...patch, schedule: { type: "fixed", days: [2, 8] } });
    const v6 = () => {
      const saved = JSON.parse(JSON.stringify(quiet.advance(begin(quiet, "paas"), 4).state));
      const { schedule: _s, events: _e, ...rest } = saved;
      return { ...rest, version: 6 } as GameStateV6;
    };

    it("loads with the events still to come, and none on the day just played", () => {
      expect(s.load(v6())).toMatchObject({ version: 8, day: 5, schedule: [{ event: "patch", day: 8 }], events: [] });
      expect(s.events(v6())).toEqual([]);
    });

    it("fires those events as it advances", () => {
      expect(eventDays(s.advance(v6(), 5).log)).toEqual([8]);
    });
  });
});

describe("provider events and the SaaS feature gap", () => {
  // The ids of the default events, so a version 7 save schedules them.
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

  describe("state saved before these events existed (version 7)", () => {
    const s = withEvents({ ...priceRise, schedule: { type: "fixed", days: [2, 8] } });
    const v7 = () => {
      const saved = JSON.parse(JSON.stringify(quiet.advance(begin(quiet, "paas"), 4).state));
      const { priceRises: _p, addonPriceRise: _a, featureGaps: _f, ...rest } = saved;
      return { ...rest, version: 7 } as GameStateV7;
    };

    it("loads with these events still to come, and no price rises or gaps", () => {
      expect(s.load(v7())).toMatchObject({
        version: 8,
        day: 5,
        schedule: [{ event: "providerPriceRise", day: 8 }],
        priceRises: {},
        addonPriceRise: 1,
        featureGaps: [],
      });
    });

    it("fires them as it advances", () => {
      expect(s.monthlyInfrastructureCost(s.advance(v7(), 5).state)).toBe(1350);
    });
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
    expect(state).toMatchObject({ day: 180, status: "playing" });
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
