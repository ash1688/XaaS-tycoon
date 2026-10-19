import { describe, expect, it } from "vitest";
import {
  createSim,
  defaultConfig,
  MODEL_IDS,
  SPEND_CATEGORIES,
  SimError,
  type Action,
  type GameConfig,
  type GameStateV4,
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

// Small costs and a big growth boost, so builds finish quickly and their effect is easy to see.
// Add-on prices are per user per month: 1,000 users at £0.30 is £300 a month, £10 a day.
const features = [
  { id: "checkout", name: "Checkout", blurb: "", devDays: 6, growthMultiplier: 1.5, addonPricePerUser: 0.3 },
  { id: "reviews", name: "Reviews", blurb: "", devDays: 5, growthMultiplier: 1.2, addonPricePerUser: 0.15 },
  { id: "search", name: "Search", blurb: "", devDays: 4, growthMultiplier: 1.1, addonPricePerUser: 0.06 },
];

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
    expect(state).toEqual({ ...sim.advance(start(), 4).state, version: 5, features: {} });
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
      version: 5,
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
    });
  });

  it("still advances, charging only the model's running cost", () => {
    const { state } = sim.advance(v1());
    expect(state).toMatchObject({ version: 5, day: 6, cash: 900, developers: 0, ops: 0 });
  });

  it("accepts actions", () => {
    expect(sim.applyAction(v1(), { type: "hire", pool: "developers" })).toMatchObject({ version: 5, developers: 1 });
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
    expect(state).toMatchObject({ version: 5, developers: 1, ops: 2, users: 1000, load: 5000, outageDays: 0 });
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
    expect(state).toMatchObject({ version: 5, status: "playing", day: 5, cash: 920, spendByDay: [] });
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
