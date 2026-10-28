import { describe, expect, it } from "vitest";
import { inPhase } from "./phases.ts";
import { settlingPay } from "./settlingPay.ts";
import {
  createSim,
  defaultConfig,
  DIFFICULTIES,
  GAME_STATE_VERSION,
  lawsuitOdds,
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

/** The state with these pools' teams set to that many mids and no one else, for tests that need a team in place. */
const withStaff = (state: GameState, teams: Partial<Record<StaffPool, number>>): GameState => ({
  ...state,
  staff: {
    ...state.staff,
    ...Object.fromEntries(Object.entries(teams).map(([pool, mid]) => [pool, { junior: 0, mid, senior: 0 }])),
  },
});

/** Everyone on the team in a pool, every grade. */
const team = (state: GameState, pool: StaffPool) => state.staff[pool].junior + state.staff[pool].mid + state.staff[pool].senior;

/** The state with each pool's headcount alongside, to match against. */
const counted = (state: GameState) => ({
  ...state,
  developers: team(state, "developers"),
  ops: team(state, "ops"),
  support: team(state, "support"),
});

const comparison = { upfrontCost: "", monthlyCost: "", opsNeeded: "", control: "" };
const growth = {
  launchUsersMin: 1000,
  launchUsersMax: 1000,
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
// Every user casual, at the fair price and going free like the alpha's rise: a rise reacts as it did in the alpha.
const allCasual = { casual: 1, enthusiasts: 0, professionals: 0, businesses: 0 };
const pricing = { fairPrice: 30, freeShare: 1, conversionRate: 0, customerMix: allCasual };
// No tickets unless a test says otherwise, so satisfaction stays at 100% and never touches growth.
const support = { ticketsPerPaidUser: 0, ticketsPerFreeUser: 0 };

// Units 10 a CU and DBU at 1,000 users, so a massive server serves 1,000,000: the starter setup never runs out unless a
// test makes it. Video needs five times the compute, like its load.
const demand = { cuPerUser: 0.01, dbuPerUser: 0.01, perUserFeeMultiplier: 1 };
const sizes = (small: number, medium: number, large: number, massive: number) => ({ small, medium, large, massive });
// Rent a month: £30 small, £60 medium, £90 large (£1, £2 and £3 a day). Massive is free, so the starter setup costs
// nothing and IaaS bills only its flat monthly cost unless a test rents more.
const rent = () => sizes(30, 60, 90, 0);
const iaasServers = {
  monthlyCost: { app: rent(), database: rent(), cache: rent(), loadBalancer: rent(), api: rent() },
  readyDays: 1,
  opsPerServer: { app: 1, database: 1, cache: 0.5, loadBalancer: 0.5, api: 1 },
  starter: [
    { type: "app" as const, size: "massive" as const, count: 1 },
    { type: "database" as const, size: "massive" as const, count: 1 },
  ],
};

// PaaS runs one massive app instance and a massive managed database, free like IaaS's starter, so it never runs out
// unless a test makes it. Smaller instances and services cost the same as IaaS's VMs.
const paasServers = {
  monthlyCost: { app: rent(), database: rent(), cache: rent(), api: rent() },
  managed: {
    instanceSize: "massive" as const,
    maxInstances: 5,
    units: { database: sizes(10, 100, 1_000, 10_000), cache: sizes(10, 100, 1_000, 10_000) },
  },
  starter: [
    { type: "app" as const, size: "massive" as const, count: 1 },
    { type: "database" as const, size: "massive" as const, count: 1 },
  ],
};

function costs(monthlyCost: number) {
  return { upfrontCost: 0, monthlyCost, monthlyCostPerUser: 0, powerAndCooling: 0, exitPenalty: 0 };
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
    priceMemoryDays: 0,
    priceChurn: 0,
    maxPriceChurn: 0.5,
    grumbleStrength: 0,
    maxGrumble: 0.5,
    supportStrength: 0,
    maxSupport: 0.3,
    grumbleDivertStrength: 0,
    maxGrumbleDivert: 0.5,
    expectedPriceDays: 30,
  };
}

/** An MVP of no size: a game launches as soon as it has somewhere to serve users, as the tests here were written for. */
const NO_MVP: GameConfig["mvp"] = {
  ...defaultConfig.mvp,
  baseDevDays: { ecommerce: 0, social: 0, video: 0, payments: 0, assistant: 0, games: 0 },
};

/** The default config with no MVP to build, launching by itself: the MVP and Launch have their own tests (mvp.test.ts). */
const withoutMvp: GameConfig = { ...defaultConfig, mvp: NO_MVP, launch: { ...defaultConfig.launch, auto: 1 } };

const config: GameConfig = {
  startingCash: 1000,
  finalDay: 180,
  allowedGameLengths: { "180-days": 1, "until-ipo": 0, "1-year": 0, career: 0 },
  timedFlow: 1,
  allowedDifficulties: { easy: 0, normal: 1, hard: 0 },
  maxCompanyNameLength: 20,
  // Launches in full on day 1, as the game starts, with the starter setups below in place: the launch tests set their own.
  launch: { rampShares: [1], auto: 1 },
  // No MVP to build, so it launches as the game starts: the MVP has its own tests (mvp.test.ts).
  mvp: NO_MVP,
  optimisation: defaultConfig.optimisation,
  research: defaultConfig.research,
  csuite: defaultConfig.csuite,
  campaigns: defaultConfig.campaigns,
  // Building at the features' own developer-days: tier 1's longer builds (#263) have their own tests (tiers.test.ts).
  tiers: { ...defaultConfig.tiers, tier1BuildMultiplier: 1 },
  hardware: defaultConfig.hardware,
  drift: defaultConfig.drift,
  // Capacity far above any load here, so outages only happen where a test lowers it.
  // No upfront or per-user costs, so each model costs a flat monthly ÷ 30 a day unless a test adds them.
  models: {
    onprem: { name: "On-prem", blurb: "", comparison, ...costs(300), opsNeeded: 3, capacity: 1_000_000 },
    // IaaS rents VMs: its capacity and ops needed come from its servers.
    iaas: { name: "IaaS", blurb: "", comparison, ...costs(600), servers: iaasServers },
    // PaaS runs app instances and managed services: a fixed 1 ops whatever it runs.
    paas: { name: "PaaS", blurb: "", comparison, ...costs(900), opsNeeded: 1, servers: paasServers },
    // SaaS has no servers and no capacity limit.
    saas: { name: "SaaS", blurb: "", comparison, ...costs(150), opsNeeded: 0 },
  },
  productTypes: {
    ecommerce: {
      name: "Shop",
      profile: "",
      growth: { ...growth, dailyGrowth: 0.02 },
      demand,
      pricing,
      support,
      features,
      // No rivals here, so growth is the product's own: the rivals tests use the default config.
      rivals: [],
    },
    social: { name: "Social", profile: "", growth: { ...growth, dailyGrowth: 0.06 }, demand, pricing, support, features, rivals: [] },
    video: {
      name: "Video",
      profile: "",
      growth: { ...growth, dailyGrowth: 0.02, loadPerUser: 5 },
      demand: { cuPerUser: 0.05, dbuPerUser: 0.01, perUserFeeMultiplier: 1 },
      pricing,
      support,
      features,
      rivals: [],
    },
    // A fee of £5 plus 1% of £1,000 of payments: £15 a usual month. No paydays or Black Friday unless a test sets them.
    payments: {
      name: "Payments",
      profile: "",
      growth: { ...growth, dailyGrowth: 0.02 },
      demand,
      pricing,
      support,
      rivals: [],
      features,
      transactions: { fairRate: 0.01, maxRate: 0.2, volumePerPaidUser: 1_000, payday: { firstDay: 28, every: 30, length: 0, multiplier: 1 }, saasFeeRate: 0 },
    },
    assistant: { name: "Assistant", profile: "", growth, demand, pricing, support, features, rivals: [] },
    games: { name: "Games", profile: "", growth, demand, pricing, support, features, rivals: [] },
  },
  customerTypes: {
    ...defaultConfig.customerTypes,
    casual: { ...defaultConfig.customerTypes.casual, thresholdMultiple: 1, toFreeShare: 0.4 },
  },
  rivals: defaultConfig.rivals,
  // No starting staff, so the model's running cost is the only charge unless a test hires someone.
  staff: {
    developers: { name: "Developers", personName: "developer", dayRate: 7, startingCount: 0 },
    ops: { name: "Ops", personName: "ops person", dayRate: 3, startingCount: 0 },
    support: { name: "Support", personName: "support person", dayRate: 2, startingCount: 0 },
    moderators: { name: "Moderators", personName: "moderator", dayRate: 2, startingCount: 0 },
    researchers: { name: "Researchers", personName: "researcher", dayRate: 2, startingCount: 0 },
    marketers: { name: "Marketers", personName: "marketer", dayRate: 2, startingCount: 0 },
  },
  // No lead times, so a hire joins at once unless a test sets one; mids at the pool's rate and output.
  staffGrades: {
    junior: { name: "Junior", payMultiplier: 0.5, output: 0.5, leadDays: 0 },
    mid: { name: "Mid", payMultiplier: 1, output: 1, leadDays: 0 },
    senior: { name: "Senior", payMultiplier: 2, output: 2, leadDays: 0 },
  },
  // Agency staff at double a permanent member's pay for half the work, from the next day. No severance unless a test
  // sets it, so letting go is free.
  agency: { payMultiplier: 2, output: 0.5, leadDays: 1 },
  severance: { days: 0 },
  capacity: { unstaffedShare: 0.4 },
  servers: {
    types: {
      app: { name: "App server", blurb: "", units: sizes(10, 100, 1_000, 10_000) },
      database: { name: "Database", blurb: "", units: sizes(10, 100, 1_000, 10_000) },
      cache: { name: "Cache", blurb: "", units: sizes(10, 100, 1_000, 10_000) },
      loadBalancer: { name: "Load balancer", blurb: "", units: sizes(2, 4, 8, 16) },
      api: { name: "API server", blurb: "", units: sizes(10, 100, 1_000, 10_000) },
    },
    loadBalancerFrom: 2,
    cacheableShare: 0.5,
  },
  outage: { baseHours: 2, hoursPerOverload: 20, growthMultiplier: 0.25, paidChurnPerHour: 0 },
  billing: { daysPerMonth: 30 },
  // Taken at the start: £17,900 at 10%, £19,690 over 179 days, £110 a day. The term is a day shorter for each day
  // later it's taken, so like the final day.
  loan: { amount: 17_900, baseRate: 0.1, ratePerDay: 0.002, termDays: 179, termPerDay: 1, minTermDays: 1, minDays: 14, emergencyTermDays: 30 },
  shares: { min: 10_000, max: 100_000, default: 10_000 },
  valuation: defaultConfig.valuation,
  funding: defaultConfig.funding,
  ipo: defaultConfig.ipo,
  negotiation: defaultConfig.negotiation,
  // No pay reviews, so pay stays at the day rates: they have their own tests (payReview.test.ts).
  payReview: { ...defaultConfig.payReview, on: 0 },
  // Cash runs out the moment it goes below £0, as the tests here were written for: shortfalls going on a loan first
  // have their own tests, on the default limit.
  rescue: { ...defaultConfig.rescue, limitDays: 0 },
  investors: defaultConfig.investors,
  // No price waves unless a test says otherwise, so a price change only has its ongoing effect on growth and payers.
  pricing: {
    maxPrice: 1_000,
    growthSensitivity: 1,
    maxGrowthBoost: 2,
    newUserFilter: 2,
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
    paidChurnAtZero: 0,
  },
  // At its defaults, but no product here has user content unless a test gives it some.
  moderation: { ...defaultConfig.moderation },
  // Conversion at its default strengths, but every product's base rate is 0 unless a test sets one.
  conversion: { ...defaultConfig.conversion },
  addons: { minConfigDevelopers: 1, setupFeePerDevDay: 0 },
  // At its defaults, but no product here has a paid API unless a test gives it one.
  api: { ...defaultConfig.api },
  migration: {
    phases: {
      planning: { name: "Planning", days: 5 },
      testing: { name: "Testing", days: 2 },
      moving: { name: "Moving infrastructure", days: 7 },
    },
    setupHeadroom: 0.25,
    // Never overruns unless a test says so.
    overrun: { chance: 0, minDays: 2, maxDays: 4 },
  },
  // The default danger meter, though with no events there's nothing for it to fire.
  encounters: {
    dailyRise: 1,
    riskRise: { unpatched: 0.5, overloaded: 0.5, lowSatisfaction: 0.5 },
    thresholdMin: 24,
    thresholdMax: 64,
  },
  // No holidays or scripted events unless a test adds some.
  calendar: { startYear: 2026, noticeDays: 14, holidays: [] },
  events: [],
};

const sim = createSim(config);

/** A config whose games all draw the smallest launch total in each product's range. */
const smallestLaunch = (base: GameConfig): GameConfig => ({
  ...base,
  productTypes: Object.fromEntries(
    Object.entries(base.productTypes).map(([id, p]) => [
      id,
      { ...p, growth: { ...p.growth, launchUsersMax: p.growth.launchUsersMin } },
    ]),
  ) as GameConfig["productTypes"],
});

// The default numbers with the starting cash they had before the bank loan, for tests of how the defaults play: they
// check the mechanics, not whether the money lasts, which the balance pass (#55) settles. Every game draws the smallest
// launch total, so a test's first setup carries it whatever the seed.
const roomyDefaults: GameConfig = smallestLaunch({ ...withoutMvp, startingCash: 250_000 });

/**
 * A first setup on the default config, as a student might set it up on day 1: a medium app server and database on
 * IaaS; large ones on-prem, with more room since kit takes a week to arrive; one app instance and a small managed
 * database on PaaS. Nothing on SaaS, which has no servers. Video needs five times the compute per user, so its app
 * servers are a size up, and on PaaS it runs two instances.
 */
const FIRST_SETUP: Record<ModelId, Action[]> = {
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
// Video and the AI assistant need far more compute per user: a bigger app server.
const COMPUTE_HEAVY = ["video", "assistant"];
const HEAVY_SETUP: Partial<Record<ModelId, Action[]>> = {
  onprem: [
    { type: "buyServer", server: "app", size: "massive" },
    { type: "buyServer", server: "database", size: "large" },
  ],
  iaas: [
    { type: "rentServer", server: "app", size: "large" },
    { type: "rentServer", server: "database", size: "medium" },
  ],
  paas: [
    { type: "setInstances", count: 2 },
    { type: "setManagedService", service: "database", size: "small" },
  ],
};
const setUp = (s: Sim, state: GameState) =>
  ((COMPUTE_HEAVY.includes(state.productType) && HEAVY_SETUP[state.model]) || FIRST_SETUP[state.model]).reduce(
    (st, a) => s.applyAction(st, a),
    state,
  );
/** A default-config game with its first setup, played until all its launch users have arrived. */
const launched = (s: Sim, state: GameState) => {
  let st = setUp(s, state);
  while (s.launch(st).status !== "launched" && st.status === "playing") st = s.advance(st).state;
  return st;
};

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

describe("launch", () => {
  const fresh = (s: Sim, model: ModelId, productType = "social", takeLoan = false) =>
    s.newGame({ companyName: "Acme", productType, model, seed: 7, takeLoan });
  // Round two's launch users, fixed per product, so the ramp's sums are exact: the default draws each game's from a range.
  const fixed = { ecommerce: 3_000, social: 4_000, video: 1_600, payments: 1_200, assistant: 1_000, games: 800 };
  const fixedTotals: GameConfig = {
    ...roomyDefaults,
    productTypes: Object.fromEntries(
      PRODUCT_TYPE_IDS.map((p) => {
        const product = roomyDefaults.productTypes[p];
        return [p, { ...product, growth: { ...product.growth, launchUsersMin: fixed[p], launchUsersMax: fixed[p] } }];
      }),
    ) as GameConfig["productTypes"],
  };
  const defaults = createSim(fixedTotals);
  /** Plays a day at a time until `last` has been played. */
  const playTo = (s: Sim, state: GameState, last: number) => {
    let st = state;
    while (st.day < last) st = s.advance(st).state;
    return st;
  };
  /** Users at the end of each day from `from` to `to`. */
  const usersOn = (s: Sim, state: GameState, from: number, to: number) => {
    const out: number[] = [];
    for (let d = from; d <= to; d++) out.push(playTo(s, state, d).users);
    return out;
  };

  it("starts a new game on every model and product with no users and no servers, bar SaaS's first arrivals", () => {
    for (const model of MODEL_IDS) {
      for (const p of PRODUCT_TYPE_IDS) {
        const state = fresh(defaults, model, p);
        expect(state.servers, `${model} ${p}`).toEqual([]);
        if (model === "saas") continue;
        expect(state, `${model} ${p}`).toMatchObject({ users: 0, paidUsers: 0, launchDay: null, load: 0 });
        expect(defaults.launch(state)).toMatchObject({ status: "waiting", day: null, rampDays: 3, rampDay: 0, arrived: 0 });
      }
    }
    for (const model of MODEL_IDS) expect(defaultConfig.models[model].servers?.starter).toBeUndefined();
    expect(defaultConfig.launch.rampShares).toEqual([0.2, 0.3, 0.5]);
  });

  it("starts SaaS's users trickling in on day 1, building up over 3 days to the launch total, then grows as normal", () => {
    const state = fresh(defaults, "saas");
    // A social network's 4,000: 20%, 30% and 50% of them.
    expect(state).toMatchObject({ launchDay: 1, users: 800 });
    expect(defaults.launch(state)).toMatchObject({ status: "launching", day: 1, rampDay: 1, arrived: 800 });
    expect(usersOn(defaults, state, 2, 3)).toEqual([2_000, 4_000]);
    const done = playTo(defaults, state, 3);
    expect(defaults.launch(done)).toMatchObject({ status: "launched", rampDay: 3, arrived: 4_000 });
    const { log } = defaults.advance(state, 2);
    expect(log.map((d) => d.entries.find((e) => e.kind === "launch")?.text)).toEqual([
      "Launch, day 2 of 3: 1,200 new users arrived, 420 of them paying.",
      "Launch, day 3 of 3: 2,000 new users arrived, 700 of them paying. That's everyone: normal growth takes over from tomorrow.",
    ]);
    // Then the product's normal daily growth.
    const next = defaults.advance(done).state;
    expect(next.users).toBeGreaterThan(4_000);
    expect(next.users).toBeLessThan(4_000 * (1 + 2 * defaultConfig.productTypes.social.growth.dailyGrowth));
    expect(defaults.advance(next).log[0]!.entries.some((e) => e.kind === "launch")).toBe(false);
  });

  it("starts IaaS's users the day after VMs are rented: ready by the end of it, they serve from the next", () => {
    let state = fresh(defaults, "iaas");
    state = setUp(defaults, state);
    expect(defaults.launch(state)).toMatchObject({ status: "upcoming", day: null, setUp: true });
    expect(usersOn(defaults, state, 2, 5).slice(0, 3)).toEqual([800, 2_000, 4_000]);
    expect(defaults.launch(playTo(defaults, state, 3))).toMatchObject({ status: "launching", day: 2, rampDay: 2, arrived: 2_000 });
  });

  it("starts PaaS's users the day after instances and a managed database are set up, and not with instances alone", () => {
    const instances = defaults.applyAction(fresh(defaults, "paas"), { type: "setInstances", count: 1 });
    expect(defaults.launch(instances).day).toBeNull();
    expect(playTo(defaults, instances, 5).launchDay).toBeNull();
    expect(playTo(defaults, setUp(defaults, fresh(defaults, "paas")), 2)).toMatchObject({ launchDay: 2, users: 800 });
  });

  it("starts on-prem's users trickling in on the day its first kit arrives, with the normal delivery time", () => {
    const state = setUp(defaults, fresh(defaults, "onprem", "video", true));
    // The kit on order needs an ops person once it arrives, though none yet.
    expect(defaults.launch(state)).toMatchObject({ status: "upcoming", day: null, opsNeeded: 1 });
    expect(defaults.opsNeededNow(state)).toBe(0);
    const waiting = playTo(defaults, state, 4);
    expect(waiting).toMatchObject({ users: 0, launchDay: null });
    expect(defaults.launch(waiting)).toMatchObject({ status: "upcoming", day: null });
    // Video's 1,600: 320, then 800, then all of them.
    expect(usersOn(defaults, state, 5, 7)).toEqual([320, 800, 1_600]);
    expect(defaults.launch(playTo(defaults, state, 7))).toMatchObject({ status: "launched", day: 5 });
  });

  it("waits for capacity, starting the ramp on the first day the company has it", () => {
    let state = playTo(defaults, fresh(defaults, "iaas"), 5);
    expect(state).toMatchObject({ users: 0, launchDay: null });
    expect(defaults.launch(state)).toMatchObject({ status: "waiting", day: null, setUp: false });
    // Rented on day 5, ready by the end of day 6: the first users arrive then.
    state = setUp(defaults, state);
    expect(defaults.launch(state)).toMatchObject({ status: "upcoming", day: null });
    const live = playTo(defaults, state, 6);
    expect(live).toMatchObject({ launchDay: 6, users: 800 });
    // The demand shown over the ramp is that of the users there now, for the servers to meet from tomorrow.
    expect(live.demand).toEqual({ cu: 0.96, dbu: 0.96 });
    // Shown to one decimal place.
    expect(defaults.units(live)!.cu).toEqual({ demand: 1, capacity: 10 });
  });

  it("needs both compute and a database to start", () => {
    const appOnly = defaults.applyAction(fresh(defaults, "iaas"), { type: "rentServer", server: "app", size: "large" });
    expect(playTo(defaults, appOnly, 5).launchDay).toBeNull();
  });

  it("takes the ramp's length and shares from config, scaled to bring the whole launch total", () => {
    const twoDays = createSim({
      ...roomyDefaults,
      launch: { rampShares: [1, 1], auto: 1 },
      productTypes: {
        ...roomyDefaults.productTypes,
        video: { ...roomyDefaults.productTypes.video, growth: { ...roomyDefaults.productTypes.video.growth, launchUsersMin: 2_500, launchUsersMax: 2_500 } },
      },
    });
    const state = fresh(twoDays, "saas", "video");
    // Half on each day. Video's free share is 60%, so 40% of each day's arrivals pay.
    expect(state).toMatchObject({ launchDay: 1, users: 1_250, paidUsers: 500 });
    // A free user or two may start paying on the way, as on any day.
    const both = twoDays.advance(state).state;
    expect(both.users).toBe(2_500);
    expect(both.paidUsers - 1_000).toBeGreaterThanOrEqual(0);
    expect(both.paidUsers - 1_000).toBeLessThanOrEqual(5);
    expect(twoDays.launch(state)).toMatchObject({ rampDays: 2, arrived: 1_250 });
    for (const p of PRODUCT_TYPE_IDS) {
      const { users, paidUsers } = playTo(defaults, fresh(defaults, "saas", p), 3);
      const { pricing } = defaultConfig.productTypes[p];
      expect(users, p).toBe(fixed[p]);
      // Each day rounded on its own, and a few free users converting on the way.
      expect(Math.abs(paidUsers - fixed[p] * (1 - pricing.freeShare)), p).toBeLessThanOrEqual(5);
    }
  });

  it("has launch users react to a price set above the fair one before they come, through the bands", () => {
    const setUpWithPrice = (price?: number) => {
      const st = setUp(defaults, fresh(defaults, "iaas", "ecommerce"));
      return price ? defaults.applyAction(inPhase(st, "launch"), { type: "setPrice", price }) : st;
    };
    // A shop's paid share is 70% at its £6 fair price. A free user or two may start paying on the way, as on any day.
    const fair = playTo(defaults, setUpWithPrice(), 4);
    expect(fair.users).toBe(3_000);
    expect(Math.abs(fair.paidUsers - 2_100)).toBeLessThanOrEqual(5);
    // At twice it, as the bands say: fewer join, and fewer of those who do pay.
    const priced = setUpWithPrice(12);
    const bands = defaults.launchBands(priced, 12);
    const total = (id: string) => bands.total.find((b) => b.id === id)!.share;
    const dear = playTo(defaults, priced, 4);
    expect(Math.abs(dear.users - 3_000 * (1 - total("notJoin")))).toBeLessThanOrEqual(3);
    expect(Math.abs(dear.paidUsers - 3_000 * total("joinPaid"))).toBeLessThanOrEqual(5);
    expect(dear.users).toBeLessThan(2_000);
    expect(dear.paidUsers / dear.users).toBeLessThan(0.5);
  });

  it("has no users, income, tickets, outages or hosting bills before the first users arrive, while staff and the loan are charged", () => {
    // A provider outage and a broken patch on days 2 and 3, before anything is running: neither touches the company.
    const s = createSim({
      ...roomyDefaults,
      events: roomyDefaults.events.map((e) =>
        e.id === "providerOutage" || e.id === "osPatch" ? { ...e, schedule: { type: "fixed" as const, days: [2, 3] } } : e,
      ),
    });
    const start = withStaff(fresh(s, "iaas", "ecommerce", true), { ops: 0 });
    const { state, log } = s.advance(start, 2);
    expect(state).toMatchObject({ users: 0, paidUsers: 0, income: 0, launchDay: null, outageDays: 0, downtimeHours: 0 });
    expect(state).toMatchObject({ ticketsToday: 0, backlog: 0, satisfaction: 100, events: [] });
    expect(s.uptime(state)).toBe(100);
    const entries = log.flatMap((d) => d.entries);
    expect(entries.filter((e) => e.kind === "outage" || e.kind === "event" || e.kind === "income")).toEqual([]);
    const charged = (category: string) => entries.some((e) => e.category === category && e.cashDelta < 0);
    expect(charged("staff")).toBe(true);
    // Hosting bills start at go-live.
    expect(charged("infrastructure")).toBe(false);
    expect(charged("debt")).toBe(true);
    expect(state.cash).toBeLessThan(start.cash);
  });

  it("draws each game's launch total from the product's range, the same for the same seed, and never shows it", () => {
    const s = createSim({ ...withoutMvp, startingCash: 250_000 });
    const totals = PRODUCT_TYPE_IDS.flatMap((p) =>
      Array.from({ length: 20 }, (_, seed) => {
        const state = s.newGame({ companyName: "Acme", productType: p, model: "saas", seed });
        const { launchUsersMin, launchUsersMax } = defaultConfig.productTypes[p].growth;
        expect(state.launchUsers).toBeGreaterThanOrEqual(launchUsersMin);
        expect(state.launchUsers).toBeLessThanOrEqual(launchUsersMax);
        // The same seed draws the same total, and the ramp brings exactly it.
        expect(s.newGame({ companyName: "Other", productType: p, model: "saas", seed }).launchUsers).toBe(state.launchUsers);
        expect(playTo(s, state, 3).users).toBe(state.launchUsers);
        return state.launchUsers;
      }),
    );
    const { growth } = defaultConfig.productTypes.social;
    expect([growth.launchUsersMin, growth.launchUsersMax]).toEqual([2_500, 7_500]);
    // Different seeds draw different totals.
    expect(new Set(totals).size).toBeGreaterThan(15);
    // The launch view shows only the users who have joined, never the total.
    const state = s.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 3 });
    const view = s.launch(state);
    expect(Object.keys(view)).not.toContain("users");
    expect(Object.keys(view)).not.toContain("paidUsers");
    expect(JSON.stringify(view)).not.toContain(String(state.launchUsers));
  });

  it("lets a test config launch in full as the game starts, with its starter setup in place", () => {
    const state = start();
    expect(state).toMatchObject({ launchDay: 1, users: 1000 });
    expect(sim.launch(state)).toMatchObject({ status: "launched", day: 1, rampDays: 1 });
    const ramped = createSim({ ...config, launch: { rampShares: [0.5, 0.5], auto: 1 } });
    const half = ramped.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1 });
    expect(half).toMatchObject({ launchDay: 1, users: 500 });
    expect(ramped.launch(half)).toMatchObject({ status: "launching", rampDay: 1, arrived: 500 });
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
        moderators: { ...config.staff.moderators, startingCount: 0 },
        researchers: { ...config.staff.researchers, startingCount: 0 },
        marketers: { ...config.staff.marketers, startingCount: 0 },
      },
    });
    const state = staffed.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1 });
    expect(counted(state)).toMatchObject({ developers: 2, ops: 1, support: 3 });
  });

  it("hires and lets go each pool separately", () => {
    const state = apply(start(), hire("developers"), hire("developers"), hire("ops"), hire("support"), letGo("developers"));
    expect(counted(state)).toMatchObject({ developers: 1, ops: 1, support: 1 });
  });

  it("hires and lets go several at once", () => {
    const many = (type: "hire" | "letGo", pool: StaffPool, count: number): Action => ({ type, pool, count });
    const state = apply(start(), many("hire", "support", 25), many("letGo", "support", 10));
    expect(team(state, "support")).toBe(15);
    expect(() => apply(state, many("letGo", "support", 16))).toThrow(
      expect.objectContaining({ code: "no_staff", message: "You only have 15 mid support to let go." }),
    );
    for (const count of [0, -1, 1.5]) {
      expect(() => apply(state, many("hire", "ops", count))).toThrow(expect.objectContaining({ code: "bad_count" }));
    }
  });

  it("does not move time on or touch cash", () => {
    const state = apply(start(), hire("ops"));
    expect(state).toMatchObject({ day: 1, cash: 1000 });
  });

  it.each(["developers", "ops", "support"] as const)("rejects letting go below zero %s", (pool) => {
    expect(() => apply(start(), letGo(pool))).toThrow(expect.objectContaining({ code: "no_staff" }));
    expect(team(apply(start(), hire(pool), letGo(pool)), pool)).toBe(0);
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
      { text: "Developers pay (2 mids)", cashDelta: -14, category: "staff" },
      { text: "Ops pay (1 mid)", cashDelta: -3, category: "staff" },
      { text: "Support pay (1 mid)", cashDelta: -2, category: "staff" },
    ]);
  });

  it("charges nothing for an empty pool", () => {
    expect(sim.dailyStaffCost(start())).toBe(0);
    expect(sim.advance(apply(start(), hire("ops"))).log[0]!.entries.map((e) => e.text)).toEqual([
      "IaaS running costs (£600 a month)",
      "Ops pay (1 mid)",
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

  it("needs no more ops on IaaS's first VMs than on-prem, and a few on PaaS and SaaS, by default", () => {
    const s = createSim(smallestLaunch(withoutMvp));
    const first = (m: ModelId) => launched(s, s.newGame({ companyName: "Acme", productType: "social", model: m, seed: 1 }));
    const needed = MODEL_IDS.map((m) => s.opsNeededNow(first(m)));
    expect(needed[1]).toBeLessThanOrEqual(needed[0]!);
    // Kit you rack yourself needs a bigger share of an ops person than a VM, and patching it takes more people.
    const { onprem, iaas } = defaultConfig.models;
    for (const t of SERVER_TYPES) expect(onprem.servers!.opsPerServer![t]).toBeGreaterThanOrEqual(iaas.servers!.opsPerServer![t]);
    const patch = defaultConfig.events.find((e) => e.id === "osPatch")!.effects;
    expect(patch.onprem!.opsNeeded).toBeGreaterThan(patch.iaas!.opsNeeded!);
    expect(needed[2]).toBeLessThanOrEqual(needed[1]!);
    expect(needed[2]).toBeGreaterThan(0);
    expect(needed[3]).toBeGreaterThan(0);
    expect(needed[3]).toBeLessThanOrEqual(needed[1]!);
  });
});

describe("staff grades and lead times", () => {
  // Juniors, mids and seniors at ½×, 1× and 2× the pay and work of a mid, starting 3, 7 and 14 days after hiring.
  const graded = createSim({
    ...config,
    staffGrades: {
      junior: { ...config.staffGrades.junior, leadDays: 3 },
      mid: { ...config.staffGrades.mid, leadDays: 7 },
      senior: { ...config.staffGrades.senior, leadDays: 14 },
    },
  });
  // In Grow, so features can be built.
  const begin = () => inPhase(graded.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 }), "grow");
  const hire = (pool: StaffPool, grade: "junior" | "mid" | "senior", count = 1): Action => ({ type: "hire", pool, grade, count });
  const apply = (state: GameState, ...actions: Action[]) => actions.reduce((s, a) => graded.applyAction(s, a), state);
  const pool = (state: GameState, p: StaffPool) => graded.staff(state).find((v) => v.pool === p)!;
  /** One mid in each pool and nothing else, so a grade's pay or work stands out against it. */
  const team = (staff: Partial<GameState["staff"]>) => ({ ...begin(), staff: { ...begin().staff, ...staff } });

  it("starts the opening team as mids, on the team from day 1", () => {
    const staffed = createSim({ ...config, staff: { ...config.staff, ops: { ...config.staff.ops, startingCount: 2 } } });
    const state = staffed.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 });
    expect(state.staff.ops).toEqual({ junior: 0, mid: 2, senior: 0 });
    expect(state.hiring).toEqual([]);
  });

  it("makes each grade wait its lead time, shown while they wait, and unpaid until they start", () => {
    const state = apply(begin(), hire("support", "junior", 2), hire("support", "mid"), hire("developers", "senior"));
    expect(pool(state, "support")).toMatchObject({
      headcount: 0,
      hiring: [
        { grade: "junior", count: 2, arrivesOn: 4, daysLeft: 3 },
        { grade: "mid", count: 1, arrivesOn: 8, daysLeft: 7 },
      ],
    });
    expect(pool(state, "developers").hiring).toEqual([{ grade: "senior", count: 1, agency: false, arrivesOn: 15, daysLeft: 14 }]);
    expect(graded.dailyStaffCost(state)).toBe(0);

    const day3 = graded.advance(state, 2);
    expect(day3.state.staff.support).toEqual({ junior: 0, mid: 0, senior: 0 });
    expect(day3.log.flatMap((d) => d.entries).filter((e) => e.category === "staff")).toEqual([]);
    expect(pool(day3.state, "support").hiring[0]).toMatchObject({ daysLeft: 1 });

    // The juniors start on day 4, so they work and are paid that day.
    const day4 = graded.advance(day3.state);
    expect(day4.state.staff.support).toEqual({ junior: 2, mid: 0, senior: 0 });
    expect(day4.log[0]!.entries).toContainEqual({ text: "2 junior support started work.", cashDelta: 0, kind: "staff" });
    expect(day4.log[0]!.entries).toContainEqual({ text: "Support pay (2 juniors)", cashDelta: -2, category: "staff" });
    expect(day4.state.clearedToday).toBeGreaterThanOrEqual(0);

    const day8 = graded.advance(day4.state, 4).state;
    expect(day8.staff.support).toEqual({ junior: 2, mid: 1, senior: 0 });
    const day15 = graded.advance(day8, 7);
    expect(day15.state.staff.developers).toEqual({ junior: 0, mid: 0, senior: 1 });
    expect(day15.log.at(-1)!.entries).toContainEqual({ text: "1 senior developer started work.", cashDelta: 0, kind: "staff" });
    expect(day15.state.hiring).toEqual([]);
  });

  it("puts hires of a grade on the same day together, and keeps another day's apart", () => {
    const state = apply(begin(), hire("ops", "junior"), hire("ops", "junior", 2), hire("ops", "mid"));
    expect(pool(state, "ops").hiring).toEqual([
      { grade: "junior", count: 3, agency: false, arrivesOn: 4, daysLeft: 3 },
      { grade: "mid", count: 1, agency: false, arrivesOn: 8, daysLeft: 7 },
    ]);
    const nextDay = apply(graded.advance(state).state, hire("ops", "junior"));
    expect(pool(nextDay, "ops").hiring.filter((h) => h.grade === "junior")).toEqual([
      { grade: "junior", count: 3, agency: false, arrivesOn: 4, daysLeft: 2 },
      { grade: "junior", count: 1, agency: false, arrivesOn: 5, daysLeft: 3 },
    ]);
  });

  it("pays each grade its multiple of the pool's day rate", () => {
    // Developers are £7 a day for a mid: a junior's £3.50 rounds to £4, a senior is £14.
    const state = team({ developers: { junior: 1, mid: 1, senior: 1 } });
    expect(graded.dailyStaffCost(state)).toBe(4 + 7 + 14);
    expect(pool(state, "developers").grades).toEqual([
      { grade: "junior", name: "Junior", count: 1, dayRate: 4, output: 0.5, leadDays: 3, severance: 0 },
      { grade: "mid", name: "Mid", count: 1, dayRate: 7, output: 1, leadDays: 7, severance: 0 },
      { grade: "senior", name: "Senior", count: 1, dayRate: 14, output: 2, leadDays: 14, severance: 0 },
    ]);
    expect(graded.advance(state).log[0]!.entries.filter((e) => e.category === "staff")).toEqual([
      { text: "Developers pay (1 junior)", cashDelta: -4, category: "staff" },
      { text: "Developers pay (1 mid)", cashDelta: -7, category: "staff" },
      { text: "Developers pay (1 senior)", cashDelta: -14, category: "staff" },
    ]);
  });

  it("gets each grade's output: tickets cleared, developer-days and ops cover", () => {
    const support = (counts: GameState["staff"]["support"]) => graded.dailyClearance(team({ support: counts }));
    expect(support({ junior: 2, mid: 0, senior: 0 })).toBe(support({ junior: 0, mid: 1, senior: 0 }));
    expect(support({ junior: 0, mid: 0, senior: 1 })).toBe(2 * config.support.ticketsPerPerson);
    expect(pool(team({ support: { junior: 1, mid: 1, senior: 1 } }), "support")).toMatchObject({ headcount: 3, output: 3.5 });

    const building = graded.applyAction(team({ developers: { junior: 1, mid: 0, senior: 1 } }), { type: "buildFeature", feature: "checkout" });
    expect(graded.features(graded.advance(building).state).find((f) => f.id === "checkout")!.progress).toBe(2.5);

    // IaaS needs 2 ops: one senior covers it, as two mids do; two juniors are one mid.
    const capacity = (ops: GameState["staff"]["ops"]) => graded.capacity(team({ ops }));
    expect(capacity({ junior: 0, mid: 0, senior: 1 })).toBe(capacity({ junior: 0, mid: 2, senior: 0 }));
    expect(capacity({ junior: 2, mid: 0, senior: 0 })).toBe(capacity({ junior: 0, mid: 1, senior: 0 }));
    expect(capacity({ junior: 2, mid: 0, senior: 0 })).toBeLessThan(capacity({ junior: 0, mid: 0, senior: 1 })!);
  });

  it("lets go by grade and number, only of those on the team", () => {
    const state = team({ support: { junior: 3, mid: 1, senior: 0 } });
    const after = graded.applyAction(state, { type: "letGo", pool: "support", grade: "junior", count: 2 });
    expect(after.staff.support).toEqual({ junior: 1, mid: 1, senior: 0 });
    expect(() => graded.applyAction(state, { type: "letGo", pool: "support", grade: "senior" })).toThrow(
      expect.objectContaining({ code: "no_staff", message: "You have no senior support to let go." }),
    );
    // Hires still to start can't be let go.
    const waiting = graded.applyAction(state, hire("support", "senior"));
    expect(() => graded.applyAction(waiting, { type: "letGo", pool: "support", grade: "senior" })).toThrow(
      expect.objectContaining({ code: "no_staff" }),
    );
    expect(() => graded.applyAction(state, { type: "hire", pool: "support", grade: "intern" } as unknown as Action)).toThrow(
      expect.objectContaining({ code: "unknown_grade" }),
    );
  });

  it("retrains people into another pool keeping their grade, a mid unless told otherwise", () => {
    const state = team({ developers: { junior: 1, mid: 1, senior: 1 }, ops: { junior: 0, mid: 0, senior: 0 } });
    const mid = graded.applyAction(state, { type: "moveStaff", from: "developers", to: "ops" });
    // They leave the old team at once and wait the grade's lead time to join the new one.
    expect(mid.staff).toMatchObject({ developers: { junior: 1, mid: 0, senior: 1 }, ops: { junior: 0, mid: 0, senior: 0 } });
    expect(pool(mid, "ops").hiring).toEqual([{ grade: "mid", count: 1, agency: false, arrivesOn: 8, daysLeft: 7, retraining: true }]);
    const senior = graded.applyAction(state, { type: "moveStaff", from: "developers", to: "ops", grade: "senior" });
    expect(pool(senior, "ops").hiring).toEqual([{ grade: "senior", count: 1, agency: false, arrivesOn: 15, daysLeft: 14, retraining: true }]);
    // With no mid, a junior moves.
    const junior = graded.applyAction(mid, { type: "moveStaff", from: "developers", to: "ops" });
    expect(junior.staff.developers).toEqual({ junior: 0, mid: 0, senior: 1 });
    expect(pool(junior, "ops").hiring.map((h) => [h.grade, h.arrivesOn])).toEqual([["mid", 8], ["junior", 4]]);
  });

  it("pays staff retraining the new team's rate, with no severance, until they join after the lead time (#258)", () => {
    const state = team({ developers: { junior: 0, mid: 2, senior: 0 }, ops: { junior: 0, mid: 1, senior: 0 } });
    const costBefore = graded.dailyStaffCost(state);
    const moved = graded.applyAction(state, { type: "moveStaff", from: "developers", to: "ops" });
    // No severance and no recruitment cost: the move itself costs nothing.
    expect(moved.cash).toBe(state.cash);
    // Paid ops' rate while retraining, not developers'.
    const opsRate = pool(moved, "ops").grades.find((g) => g.grade === "mid")!.dayRate;
    const devRate = pool(moved, "developers").grades.find((g) => g.grade === "mid")!.dayRate;
    expect(graded.dailyStaffCost(moved)).toBe(costBefore - devRate + opsRate);
    const day = graded.advance(moved);
    expect(day.log[0]!.entries).toContainEqual({ text: "Ops pay, retraining (1 mid)", cashDelta: -opsRate, category: "staff" });
    expect(day.state.staff.ops.mid).toBe(1);
    // A retraining member of staff isn't a hire, so it can't be cancelled.
    expect(() => graded.applyAction(day.state, { type: "cancelHire", pool: "ops", grade: "mid" })).toThrow(
      expect.objectContaining({ code: "no_hires" }),
    );
    // On the day the lead time is up they join the team at the same grade.
    const joined = graded.advance(moved, 7);
    expect(joined.state.staff.ops.mid).toBe(2);
    expect(joined.state.hiring).toEqual([]);
    expect(joined.log.at(-1)!.entries).toContainEqual({
      text: "1 mid ops person finished retraining and started work.",
      cashDelta: 0,
      kind: "staff",
    });
    // With no lead time (a teacher's config) they join at once.
    const instant = createSim({ ...config, staffGrades: { ...config.staffGrades, mid: { ...config.staffGrades.mid, leadDays: 0 } } });
    expect(instant.applyAction(state, { type: "moveStaff", from: "developers", to: "ops" }).staff.ops.mid).toBe(2);
  });

  it("makes a senior about twice a junior's work for about 1.7× the pay by default, arriving in 3, 7 and 14 days", () => {
    const { junior, mid, senior } = defaultConfig.staffGrades;
    expect(senior.output / junior.output).toBeCloseTo(2, 0);
    expect(senior.payMultiplier / junior.payMultiplier).toBeCloseTo(1.7, 1);
    // Cheaper per unit of work the higher the grade.
    expect(senior.payMultiplier / senior.output).toBeLessThan(mid.payMultiplier / mid.output);
    expect(mid.payMultiplier / mid.output).toBeLessThan(junior.payMultiplier / junior.output);
    expect([junior.leadDays, mid.leadDays, senior.leadDays]).toEqual([3, 7, 14]);
  });
});

describe("agency staff and severance", () => {
  // Agency staff at 2× the pay and ½ the work of permanent staff, from the next day; severance of 10 days' pay.
  const s = createSim({ ...config, severance: { days: 10 } });
  // In Grow, so features can be built and every pool hired.
  const begin = () => inPhase(s.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 }), "grow");
  const pool = (state: GameState, p: StaffPool) => s.staff(state).find((v) => v.pool === p)!;
  const none = { junior: 0, mid: 0, senior: 0 };
  const agencyHire = (pool: StaffPool, count = 1): Action => ({ type: "hire", pool, grade: "mid", count, agency: true });

  it("starts agency staff the next day, apart from permanent staff, at their pay for half their work", () => {
    const hired = s.applyAction(begin(), agencyHire("support", 2));
    expect(pool(hired, "support")).toMatchObject({
      headcount: 0,
      agencyCount: 0,
      hiring: [{ grade: "mid", count: 2, agency: true, arrivesOn: 2, daysLeft: 1 }],
    });
    expect(s.dailyStaffCost(hired)).toBe(0);

    const day2 = s.advance(hired);
    expect(day2.state.staff.support).toEqual(none);
    expect(day2.state.agency.support).toEqual({ ...none, mid: 2 });
    const view = pool(day2.state, "support");
    expect(view).toMatchObject({ headcount: 0, agencyCount: 2, output: 1, hiring: [] });
    // Support is £2 a day for a permanent mid: an agency mid is £4, does half the work, and goes with no severance.
    expect(view.agency.find((g) => g.grade === "mid")).toEqual({
      grade: "mid", name: "Mid", count: 2, dayRate: 4, output: 0.5, leadDays: 1, severance: 0,
    });
    expect(view.grades.find((g) => g.grade === "mid")).toMatchObject({ count: 0, dayRate: 2, output: 1, severance: 20 });
    expect(day2.log[0]!.entries).toContainEqual({ text: "2 agency mid support started work.", cashDelta: 0, kind: "staff" });
    expect(day2.log[0]!.entries).toContainEqual({ text: "Agency support pay (2 mids)", cashDelta: -8, category: "staff" });

    // Two agency mids clear what one permanent mid does.
    const permanent = s.applyAction(begin(), { type: "hire", pool: "support" });
    expect(s.dailyClearance(day2.state)).toBe(s.dailyClearance(permanent));
  });

  it("counts agency staff's work towards builds and ops cover", () => {
    const team = { ...begin(), agency: { ...begin().agency, developers: { ...none, senior: 1 }, ops: { ...none, mid: 4 } } };
    const withOps = { ...begin(), staff: { ...begin().staff, ops: { ...none, mid: 2 } } };
    expect(s.capacity(team)).toBe(s.capacity(withOps));
    const building = s.applyAction(team, { type: "buildFeature", feature: "checkout" });
    expect(s.features(s.advance(building).state).find((f) => f.id === "checkout")!.progress).toBe(1);
  });

  it("charges permanent staff's severance at once when they're let go, and none for agency staff", () => {
    const state = {
      ...begin(),
      cash: 1_000,
      staff: { ...begin().staff, developers: { ...none, mid: 3 } },
      agency: { ...begin().agency, developers: { ...none, mid: 3 } },
    };
    // Developers are £7 a day for a mid: 10 days' pay each.
    expect(pool(state, "developers").grades.find((g) => g.grade === "mid")!.severance).toBe(70);
    const cut = s.applyAction(state, { type: "letGo", pool: "developers", count: 2 });
    expect(cut.staff.developers).toEqual({ ...none, mid: 1 });
    expect(cut.agency.developers).toEqual({ ...none, mid: 3 });
    expect(cut.cash).toBe(1_000 - 140);
    expect(cut.spend.staff).toBe(state.spend.staff + 140);

    const agencyCut = s.applyAction(state, { type: "letGo", pool: "developers", count: 3, agency: true });
    expect(agencyCut.agency.developers).toEqual(none);
    expect(agencyCut.staff.developers).toEqual({ ...none, mid: 3 });
    expect(agencyCut.cash).toBe(1_000);
  });

  it("refuses to let go permanent staff without the cash for their severance, or agency staff who aren't there", () => {
    const state = { ...begin(), cash: 100, staff: { ...begin().staff, developers: { ...none, mid: 2 } } };
    expect(() => s.applyAction(state, { type: "letGo", pool: "developers", count: 2 })).toThrow(
      expect.objectContaining({ code: "cant_afford", message: "Letting go 2 mid developers costs £140 in severance, and you have £100." }),
    );
    expect(() => s.applyAction(state, { type: "letGo", pool: "developers", agency: true })).toThrow(
      expect.objectContaining({ code: "no_staff", message: "You have no agency mid developers to let go." }),
    );
  });

  // Lead times as the game's, so hires wait to start.
  const waits = createSim({
    ...config,
    staffGrades: {
      junior: { ...config.staffGrades.junior, leadDays: 3 },
      mid: { ...config.staffGrades.mid, leadDays: 7 },
      senior: { ...config.staffGrades.senior, leadDays: 14 },
    },
  });
  const beginWaiting = () => waits.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 });

  it("cancels hires still to start, the latest first, at no cost", () => {
    const first = waits.applyAction(beginWaiting(), { type: "hire", pool: "support", grade: "junior", count: 2 });
    const hired = waits.applyAction(waits.advance(first).state, { type: "hire", pool: "support", grade: "junior", count: 3 });
    const withAgency = waits.applyAction(hired, agencyHire("support"));
    const cut = waits.applyAction(withAgency, { type: "cancelHire", pool: "support", grade: "junior", count: 4 });
    expect(cut.hiring).toEqual([
      { pool: "support", grade: "junior", count: 1, agency: false, arrivesOn: 4 },
      { pool: "support", grade: "mid", count: 1, agency: true, arrivesOn: 3 },
    ]);
    expect(cut.cash).toBe(withAgency.cash);
    expect(waits.applyAction(cut, { type: "cancelHire", pool: "support", agency: true }).hiring).toHaveLength(1);
    expect(() => waits.applyAction(cut, { type: "cancelHire", pool: "support", grade: "junior", count: 2 })).toThrow(
      expect.objectContaining({ code: "no_hires", message: "You only have 1 junior support still to start." }),
    );
    expect(() => waits.applyAction(cut, { type: "cancelHire", pool: "developers" })).toThrow(
      expect.objectContaining({ code: "no_hires", message: "You have no mid developers still to start." }),
    );
  });

  it("lets go all agency staff in a pool or every pool, and cancels their hires still to start", () => {
    const state = {
      ...waits.applyAction(waits.applyAction(beginWaiting(), agencyHire("support", 2)), { type: "hire", pool: "support" }),
      agency: { ...beginWaiting().agency, support: { ...none, junior: 1, senior: 2 }, developers: { ...none, mid: 3 } },
    };
    const support = waits.applyAction(state, { type: "letGoAgency", pool: "support" });
    expect(support.agency.support).toEqual(none);
    expect(support.agency.developers).toEqual({ ...none, mid: 3 });
    expect(support.hiring).toEqual([{ pool: "support", grade: "mid", count: 1, agency: false, arrivesOn: 8 }]);
    expect(support.cash).toBe(state.cash);
    const all = waits.applyAction(state, { type: "letGoAgency" });
    expect(all.agency.developers).toEqual(none);
    expect(all.staff).toEqual(state.staff);
  });

  it("keeps agency staff in their pool: only permanent staff move", () => {
    const state = { ...begin(), agency: { ...begin().agency, developers: { ...none, mid: 1 } } };
    expect(() => s.applyAction(state, { type: "moveStaff", from: "developers", to: "ops" })).toThrow(
      expect.objectContaining({ code: "no_staff" }),
    );
  });

  it("hires agency moderators and pays permanent ones severance, only on a product with user content", () => {
    // Social with user content; moderators are £2 a day for a permanent mid, so severance is £20.
    const content = createSim({
      ...config,
      severance: { days: 10 },
      productTypes: { ...config.productTypes, social: { ...config.productTypes.social, moderation: { reportsPerUser: 0.01 } } },
    });
    const social = inPhase(content.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 42 }), "grow");
    const hired = content.advance(content.applyAction(social, { type: "hire", pool: "moderators", agency: true, count: 2 })).state;
    expect(hired.agency.moderators).toEqual({ ...none, mid: 2 });
    expect(content.staff(hired).find((p) => p.pool === "moderators")).toMatchObject({ agencyCount: 2, output: 1 });
    expect(content.applyAction(hired, { type: "letGo", pool: "moderators", agency: true, count: 2 }).cash).toBe(hired.cash);

    const permanent = { ...hired, cash: 1_000, staff: { ...hired.staff, moderators: { ...none, mid: 1 } } };
    expect(content.staff(permanent).find((p) => p.pool === "moderators")!.grades.find((g) => g.grade === "mid")!.severance).toBe(20);
    expect(content.applyAction(permanent, { type: "letGo", pool: "moderators" }).cash).toBe(980);

    const shop = inPhase(content.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 }), "grow");
    expect(() => content.applyAction(shop, { type: "hire", pool: "moderators", agency: true })).toThrow(
      expect.objectContaining({ code: "no_content" }),
    );
  });

  it("makes agency staff 1.25× the pay for half the work from the next day by default, and severance a cost", () => {
    expect(defaultConfig.agency).toEqual({ payMultiplier: 1.25, output: 0.5, leadDays: 1 });
    expect(defaultConfig.severance.days).toBeGreaterThan(0);
  });
});

describe("features", () => {
  const build = (feature: string): Action => ({ type: "buildFeature", feature });
  // In Grow, where features open.
  const startOn = (model = "iaas", developers = 1) =>
    withStaff(inPhase(sim.newGame({ companyName: "Acme", productType: "social", model, seed: 42 }), "grow"), { developers });
  const feature = (state: Parameters<typeof sim.features>[0], id: string) => sim.features(state).find((f) => f.id === id)!;

  it("lists the product's features from config, none started", () => {
    expect(sim.features(startOn())).toEqual(
      features.map((f) => ({ ...f, status: "notStarted", progress: 0, daysLeft: null, addonSetupFee: 0, tier: 1, rpPrice: 0, tierAvailable: true, unlocked: true })),
    );
  });

  it("says when developers have nothing to do: nothing being built, or on SaaS, where they only set up add-ons", () => {
    const idle = (state: GameState) => sim.staff(state).find((p) => p.pool === "developers")!.idle;
    expect(idle(startOn())).toMatch(/Nothing is being built/);
    expect(idle(sim.applyAction(startOn(), build("checkout")))).toBeNull();
    expect(idle(startOn("iaas", 0))).toBeNull();
    expect(idle(startOn("saas"))).toMatch(/^On SaaS the provider builds the features: your developers only set up add-ons/);
    const allOn = (state: GameState, status: "built" | "addon"): GameState => ({
      ...state,
      features: Object.fromEntries(features.map((f) => [f.id, { status, progress: 0 }])),
    });
    expect(idle(allOn(startOn("saas"), "addon"))).toMatch(/every add-on is on: your developers have nothing to do/);
    expect(idle(allOn(startOn(), "built"))).toBe(
      "Every feature is built: your developers have nothing to do. Or move the slider to put them on optimisation.",
    );
    // Only developers can sit idle like this.
    expect(sim.staff(startOn()).filter((p) => p.pool !== "developers").every((p) => p.idle === null)).toBe(true);
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
      const base = withStaff(inPhase(s.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 42 }), "grow"), { developers: 6 });
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
  // In Grow, where add-ons open.
  const startOn = (model = "saas", developers = 1) =>
    withStaff(inPhase(sim.newGame({ companyName: "Acme", productType: "social", model, seed: 42 }), "grow"), { developers });
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
    const strict = createSim({ ...config, addons: { minConfigDevelopers: 2, setupFeePerDevDay: 0 } });
    const state = (developers: number) =>
      withStaff(inPhase(strict.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 42 }), "grow"), { developers });
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
    // Social grows steadily fastest. E-commerce and video share a base rate here: holidays set them apart (see
    // calendar.test.ts).
    expect(users.social).toBeGreaterThan(users.ecommerce! * 1.5);
    expect(users.social).toBeGreaterThan(users.video! * 1.5);
  });

  it("puts heavier load per user on video", () => {
    const perUser = (p: string) => {
      const { state } = play(p, 5);
      return state.load / state.users;
    };
    expect(perUser("video")).toBeGreaterThan(perUser("social") * 3);
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
    expect(log[0]!.entries[0]!.text).toMatch(/^Load hit \d+% of capacity\. Down \d+ hours/);
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
    // SaaS has no capacity limit.
    expect(MODEL_IDS.map(opsFor)).toEqual([1_000_000, 1_000_000, 1_000_000, null]);
  });

  it("loses capacity with fewer ops than needed on models that need ops, but not on SaaS", () => {
    for (const model of MODEL_IDS) {
      const unstaffed = sim.newGame({ companyName: "Acme", productType: "social", model, seed: 1 });
      const staffed = withStaff(unstaffed, { ops: sim.opsNeeded(model) });
      if (sim.opsNeeded(model) > 0) {
        expect(sim.capacity(unstaffed)!).toBeLessThan(sim.capacity(staffed)!);
        // Each extra ops person restores some capacity.
        const one = sim.applyAction(unstaffed, { type: "hire", pool: "ops" });
        expect(sim.capacity(one)!).toBeGreaterThan(sim.capacity(unstaffed)!);
        expect(sim.capacity(one)!).toBeLessThanOrEqual(sim.capacity(staffed)!);
      } else {
        expect(sim.capacity(unstaffed)).toBe(sim.capacity(staffed));
      }
    }
  });

  it("does not add capacity beyond full staffing", () => {
    const state = sim.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 1 });
    expect(sim.capacity(withStaff(state, { ops: 10 }))).toBe(sim.capacity(withStaff(state, { ops: 2 })));
  });

  it("causes outages when understaffed that full staffing avoids", () => {
    const s = createSim(iaasCapacity(3000));
    const start = s.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 42 });
    const staffed = withStaff(start, { ops: 2 });
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
  const begin = (s: Sim = flat, model = "iaas") => withStaff(s.newGame({ companyName: "Acme", productType: "social", model, seed: 42 }), { ops: 10 });
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
      { id: 1, type: "app", size: "massive", name: "App server", status: "ready", readyDay: 1, daysLeft: 0, leavesOn: null, units: 10_000, unitBoost: 1, apiu: false, monthlyCost: 0, paid: null, sellBack: null, rack: null, performance: null, wear: null, wearDaysLeft: null, wearWarning: false, risk: null, crashedDays: 0, overheatedDays: 0 },
      { id: 2, type: "database", size: "massive", name: "Database", status: "ready", readyDay: 1, daysLeft: 0, leavesOn: null, units: 10_000, unitBoost: 1, apiu: false, monthlyCost: 0, paid: null, sellBack: null, rack: null, performance: null, wear: null, wearDaysLeft: null, wearWarning: false, risk: null, crashedDays: 0, overheatedDays: 0 },
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
    // API servers are offered once the company has a paid API.
    expect(options).toHaveLength((SERVER_TYPES.length - 1) * SERVER_SIZES.length);
    expect(options.some((o) => o.type === "api")).toBe(false);
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
    expect(outages(flat.advance(dbBound).log)).toEqual([expect.stringMatching(/^The database \(DBU\) hit 150% of capacity\./)]);

    const cuBound = withUsers(fleet(begin(), ["app", "small"], BIG_DB), 1_500);
    expect(flat.units(flat.advance(cuBound).state)!.binding).toBe("cu");
    expect(outages(flat.advance(cuBound).log)).toEqual([expect.stringMatching(/^Compute \(CU\) hit 150% of capacity\./)]);
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

    // Counting servers still being set up, so the shortfall shows the day the second app server is rented.
    const renting = rent(one, "app", "small");
    expect(lb(renting)).toMatchObject({ appServers: 1, uncovered: 0 });
    expect(flat.units(renting)!.loadBalancerOnceReady).toMatchObject({ appServers: 2, needed: true, uncovered: 1 });
    expect(flat.units(rent(renting, "loadBalancer", "small"))!.loadBalancerOnceReady).toMatchObject({ uncovered: 0 });

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

  it("derives ops needed from the servers running, not those on order, and cuts every tier when short", () => {
    // 1 ops for each app server and database, 0.5 for each cache and load balancer, rounded up.
    const state = begin();
    expect(flat.opsNeededNow(state)).toBe(2);
    expect(flat.opsNeeded("iaas")).toBe(2);
    // Servers on order need no ops until they're ready (#259), but are counted for once they are.
    const cached = rent(state, "cache", "small");
    expect(flat.opsNeededNow(cached)).toBe(2);
    expect(flat.opsNeededOnceReady(cached)).toBe(3);
    const more = rent(rent(cached, "loadBalancer", "small"), "app", "small");
    expect(flat.opsNeededOnceReady(more)).toBe(4);
    expect(flat.opsNeededNow(flat.advance(more).state)).toBe(4);
    expect(flat.opsNeededNow(fleet(state))).toBe(0);
    // With 1 of the 2 ops needed, each tier keeps 40% + 60% × ½ = 70%.
    expect(flat.units(withStaff(state, { ops: 1 }))).toMatchObject({ cu: { capacity: 7_000 }, dbu: { capacity: 7_000 } });
    expect(flat.units(withStaff(state, { ops: 2 }))).toMatchObject({ cu: { capacity: 10_000 } });
  });

  it("slides the ops cut with the share of ops work missing, shows it and stops time when it starts (#259)", () => {
    // Two app servers, a database and a cache: 3.5 ops of work, so 4 people.
    const kit = fleet(begin(), ["app", "massive"], ["app", "massive"], ["database", "massive"], ["cache", "small"]);
    expect(flat.opsNeededNow(kit)).toBe(4);
    expect(flat.opsShortfall(withStaff(kit, { ops: 4 }))).toBeNull();
    // 3 of the 3.5 ops of work: 40% + 60% × 3/3.5, about 91%, not the 85% that 3 of 4 people would give.
    expect(flat.opsShortfall(withStaff(kit, { ops: 3 }))).toEqual({ have: 3, needed: 4, capacityShare: 0.91 });
    // Each person short cuts more.
    const shares = [3, 2, 1, 0].map((ops) => flat.opsShortfall(withStaff(kit, { ops }))!.capacityShare);
    expect(shares).toEqual([...shares].sort((a, b) => b - a));
    expect(shares.at(-1)).toBe(config.capacity.unstaffedShare);
    expect(flat.units(withStaff(kit, { ops: 3 }))!.opsCut).toBeCloseTo(0.09, 2);

    // Ordering a server doesn't cut today's capacity; once it's ready the team is short, and time stops that day.
    const ready = withStaff(fleet(begin(), BIG_APP, BIG_DB), { ops: 2 });
    const ordered = rent(ready, "app", "massive");
    expect(flat.opsShortfall(ordered)).toBeNull();
    const tick = flat.tick(ordered);
    expect(tick.pauses).toContainEqual({ kind: "alert", id: "ops-shortfall", text: "Short of ops: 2 of 3 needed, capacity cut to 80%" });
    // It stays short without stopping again, until ops catch up.
    expect(flat.tick(tick.state).pauses.map((p) => p.id)).not.toContain("ops-shortfall");
  });

  describe("cancelling a VM (#260)", () => {
    // Every difficulty allowed, so a game can start on any.
    const anyLevel = createSim({ ...flatConfig, allowedDifficulties: { easy: 1, normal: 1, hard: 1 } });
    /** A massive app server, database and small cache, on a difficulty: 1,000 users need 10 CU and DBU. */
    const kit = (difficulty?: string) =>
      fleet(
        withStaff(anyLevel.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 42, ...(difficulty ? { difficulty } : {}) }), { ops: 10 }),
        BIG_APP,
        BIG_DB,
        ["cache", "small"],
      );
    const refusal = (state: GameState, action: Action) => {
      try {
        flat.applyAction(state, action);
      } catch (e) {
        return { code: (e as SimError).code, message: (e as SimError).message };
      }
      return null;
    };
    const ids = (state: GameState) => state.servers.map((s) => s.id);

    it("waits for a replacement of the same kind on order, still serving and billed, then goes", () => {
      const state = rent(kit(), "app", "small");
      const replacement = state.servers.at(-1)!;
      const waiting = flat.applyAction(state, { type: "cancelServer", id: 1 });
      expect(flat.servers(waiting).find((s) => s.id === 1)).toMatchObject({ status: "ready", leavesOn: replacement.readyDay });
      expect(flat.units(waiting)!.cu.capacity).toBe(flat.units(state)!.cu.capacity);
      expect(refusal(waiting, { type: "cancelServer", id: 1 })?.code).toBe("already_leaving");
      // It serves through the day the replacement is ready, then goes at the end of it.
      const day = flat.advance(waiting, replacement.readyDay - waiting.day);
      expect(ids(day.state)).not.toContain(1);
      expect(day.log.at(-1)!.entries).toContainEqual({ text: "App server #1 (massive) cancelled: its replacement is ready.", cashDelta: 0 });
      expect(outages(day.log)).toEqual([]);
    });

    it("refuses on Easy and Normal a cancel that leaves capacity below today's load, saying why", () => {
      for (const difficulty of ["easy", "normal"]) {
        const state = kit(difficulty);
        expect(refusal(state, { type: "cancelServer", id: 1 }), difficulty).toEqual({
          code: "cancel_unsafe",
          message: "You can't cancel that server: it would leave no compute (CU) for today's load. Rent a replacement first, and the cancel will wait until it's ready.",
        });
        // Confirming doesn't help below Hard.
        expect(refusal(state, { type: "cancelServer", id: 1, now: true })?.code, difficulty).toBe("cancel_unsafe");
        // A cancel that leaves enough goes at once.
        expect(ids(flat.applyAction(state, { type: "cancelServer", id: 3 }))).toEqual([1, 2]);
      }
    });

    it("lets Hard cancel it once confirmed, and the outage is the student's", () => {
      const state = kit("hard");
      expect(refusal(state, { type: "cancelServer", id: 1 })).toEqual({
        code: "confirm_cancel",
        message: "Cancelling that server would leave no compute (CU) for today's load: expect an outage. To go ahead anyway, confirm it (`cancel 1 now`).",
      });
      const gone = flat.applyAction(state, { type: "cancelServer", id: 1, now: true });
      expect(ids(gone)).toEqual([2, 3]);
      expect(outages(flat.advance(gone).log).length).toBeGreaterThan(0);
    });

    it("says so in each difficulty's description", () => {
      expect(DIFFICULTIES.easy.blurb).toMatch(/can't be cancelled or sold if that would leave you short of capacity/);
      expect(DIFFICULTIES.normal.blurb).toMatch(/can't be cancelled or sold if that would leave you short of capacity/);
      expect(DIFFICULTIES.hard.blurb).toMatch(/cancel or sell a server that leaves you short of capacity, once you confirm it/);
    });
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
    const state = video.advance(withStaff(video.newGame({ companyName: "Acme", productType: "video", model: "iaas", seed: 1 }), { ops: 10 })).state;
    expect(state.demand).toEqual({ cu: 50, dbu: 10 });
  });

  it("leaves a model with a fixed capacity (the test config's on-prem) on it, with no servers to rent", () => {
    for (const model of ["onprem"] as const) {
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
    // Cancelling with a replacement on order (it waits for it) leaves the state it started from alone too.
    flat.applyAction(rent(state, "app", "small"), { type: "cancelServer", id: 1 });
    expect(state).toEqual(copy);
  });

  describe("migrating off IaaS", () => {
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

    it("drops the VMs on leaving IaaS, so their rent stops", () => {
      const iaas = withStaff(smallStarter.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 1 }), { ops: 3 });
      const extra = smallStarter.applyAction(iaas, { type: "rentServer", server: "cache", size: "small" });
      const { state, log } = smallStarter.advance(migrate(extra, "saas"), 15);
      expect(state).toMatchObject({ model: "saas", servers: [] });
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

  it("starts with no VMs by default, and a medium app server and database launch every product with room to grow", () => {
    const s = createSim(smallestLaunch(withoutMvp));
    expect(s.opsNeeded("iaas")).toBe(0);
    for (const p of PRODUCT_TYPE_IDS) {
      expect(s.newGame({ companyName: "Acme", productType: p, model: "iaas", seed: 1 }).servers).toEqual([]);
      const state = launched(s, s.newGame({ companyName: "Acme", productType: p, model: "iaas", seed: 1 }));
      expect(state.launchDay, p).toBe(2);
      expect(s.opsNeededNow(state), p).toBe(1);
      expect(s.units(state)!.usersSupported, p).toBeGreaterThan(state.users * 1.5);
    }
    // One CU serves the same users whatever the size, and bigger VMs cost less per unit.
    const { units } = defaultConfig.servers.types.app;
    const prices = defaultConfig.models.iaas.servers!.monthlyCost.app as Record<ServerSize, number>;
    for (let i = 1; i < SERVER_SIZES.length; i++) {
      const [smaller, bigger] = [SERVER_SIZES[i - 1]!, SERVER_SIZES[i]!];
      expect(units[bigger]).toBeGreaterThan(units[smaller]);
      expect(prices[bigger] / units[bigger]).toBeLessThan(prices[smaller] / units[smaller]);
    }
  });
});

describe("servers on-prem", () => {
  // Bought kit: every type costs £1,000 small to £4,000 massive, runs at £30 to £120 a month (£1 to £4 a day), takes
  // 10 days to arrive and sells back for 40%. The starter is a massive app server and database, £8,000 in all, on
  // top of a £5,000 server room. No growth or variation, so 1,000 users need exactly 10 CU and 10 DBU.
  const still = { dailyGrowth: 0, growthNoise: 0, loadNoise: 0 };
  const each = (small: number, medium: number, large: number, massive: number) => {
    const s = sizes(small, medium, large, massive);
    return { app: s, database: s, cache: s, loadBalancer: s, api: s };
  };
  const onpremServers = {
    ...iaasServers,
    purchase: { price: each(1_000, 2_000, 3_000, 4_000), sellBackShare: 0.4, cablingCost: 0 },
    monthlyCost: each(30, 60, 90, 120),
    readyDays: 10,
  };
  const ownConfig: GameConfig = {
    ...config,
    startingCash: 100_000,
    // Ops come from the kit alone, as on the default config.
    models: {
      ...config.models,
      onprem: { ...config.models.onprem, upfrontCost: 5_000, opsNeeded: undefined, servers: onpremServers },
    },
    productTypes: {
      ...config.productTypes,
      social: { ...config.productTypes.social, growth: { ...config.productTypes.social.growth, ...still } },
    },
  };
  const own = createSim(ownConfig);
  const begin = (s: Sim = own, model = "onprem") => withStaff(s.newGame({ companyName: "Acme", productType: "social", model, seed: 42 }), { ops: 10 });
  type Kind = [type: ServerType, size: ServerSize];
  /** The state with exactly these servers, all arrived, each bought at its price. */
  const fleet = (state: GameState, ...servers: Kind[]): GameState => ({
    ...state,
    servers: servers.map(([type, size], i) => ({ id: i + 1, type, size, readyDay: state.day, paid: onpremServers.purchase.price[type][size] })),
    nextServerId: servers.length + 1,
  });
  const withUsers = (state: GameState, users: number) => ({ ...state, users, paidUsers: 0 });
  const buy = (state: GameState, server: ServerType, size: ServerSize, s: Sim = own) =>
    s.applyAction(state, { type: "buyServer", server, size });
  const sell = (state: GameState, id: number) => own.applyAction(state, { type: "sellServer", id });
  const outages = (log: DayLog[]) => log.flatMap((d) => d.entries.filter((e) => e.kind === "outage"));
  const upkeepLines = (log: DayLog[]) => log.flatMap((d) => d.entries.filter((e) => e.text.includes(" power and upkeep: ")));
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return (e as SimError).code;
    }
  };
  const BIG_DB: Kind = ["database", "massive"];
  const BIG_APP: Kind = ["app", "massive"];

  it("sells with the same rules as cancelling: waits for a replacement, and refuses one that leaves it short (#260)", () => {
    const state = fleet(begin(), BIG_APP, BIG_DB);
    expect(code(() => sell(state, 1))).toBe("cancel_unsafe");
    const ordered = buy(state, "app", "massive");
    const arrives = ordered.servers.at(-1)!.readyDay;
    const refund = own.servers(ordered).find((s) => s.id === 1)!.sellBack!;
    const waiting = sell(ordered, 1);
    // Refunded when it goes, not before.
    expect(waiting.cash).toBe(ordered.cash);
    expect(own.servers(waiting).find((s) => s.id === 1)!.leavesOn).toBe(arrives);
    const played = own.advance(waiting, arrives - waiting.day);
    expect(played.state.servers.map((s) => s.id)).not.toContain(1);
    expect(played.log.at(-1)!.entries).toContainEqual(
      expect.objectContaining({ text: expect.stringMatching(/^App server #1 \(massive\) sold back for £[\d,]+: its replacement is ready\.$/), cashDelta: refund }),
    );
    expect(outages(played.log)).toEqual([]);
  });

  it("starts with the starter kit, bought on day 1 on top of the server room, ready for the first day", () => {
    const state = own.newGame({ companyName: "Acme", productType: "social", model: "onprem", seed: 42 });
    // The £5,000 upfront cost is the server room; the kit is £4,000 + £4,000 at its purchase prices, charged once.
    expect(state).toMatchObject({ cash: 100_000 - 5_000 - 8_000, spend: { infrastructure: 13_000 } });
    expect(own.upfrontCost("onprem")).toBe(13_000);
    expect(own.servers(state).map((s) => [s.type, s.size, s.status, s.paid])).toEqual([
      ["app", "massive", "ready", 4_000],
      ["database", "massive", "ready", 4_000],
    ]);
    expect(own.units(withStaff(state, { ops: 2 }))).toMatchObject({ cu: { capacity: 10_000 }, dbu: { capacity: 10_000 } });
    // Never charged again: from day 2 it's the room's £10 a day and the kit's £8 a day of power and upkeep.
    const { state: later, log } = own.advance(withStaff(state, { ops: 10 }), 3);
    expect(later.cash).toBe(state.cash - 3 * (10 + 8 + 10 * 3));
    expect(log.flatMap((d) => d.entries).some((e) => e.text.startsWith("Starter kit"))).toBe(false);
  });

  it("charges the purchase price at once, in infrastructure, without moving time on", () => {
    const before = begin();
    const bought = buy(before, "database", "large");
    expect(bought).toMatchObject({ day: before.day, cash: before.cash - 3_000, nextServerId: before.nextServerId + 1 });
    expect(bought.spend.infrastructure).toBe(before.spend.infrastructure + 3_000);
    // Counted in the spend of the day just played, so the cost charts add up.
    expect(bought.spendByDay.at(-1)).toMatchObject({ day: before.day, infrastructure: before.spendByDay.at(-1)!.infrastructure + 3_000 });
    expect(own.servers(bought).at(-1)).toMatchObject({ type: "database", size: "large", status: "pending", daysLeft: 10, paid: 3_000, sellBack: 1_200 });
    // You can't buy what you can't pay for, and nothing changes.
    expect(code(() => buy({ ...before, cash: 2_999 }, "database", "large"))).toBe("cant_afford");
    expect(own.serverOptions(before).find((o) => o.type === "cache" && o.size === "small")).toMatchObject({
      price: 1_000,
      monthlyCost: 30,
      sellBackShare: 0.4,
      readyDays: 10,
      units: 10,
    });
  });

  it("counts down to delivery, and adds capacity only once the kit has arrived", () => {
    const bought = buy(fleet(begin(), BIG_DB), "app", "small");
    expect(own.units(bought)!.cu.capacity).toBe(0);
    let state = bought;
    for (let daysLeft = 10; daysLeft > 0; daysLeft--) {
      expect(own.servers(state).at(-1)).toMatchObject({ status: "pending", daysLeft });
      expect(own.units(state)!.cu.capacity).toBe(0);
      state = own.advance(state).state;
    }
    expect(own.servers(state).at(-1)).toMatchObject({ status: "ready", daysLeft: 0 });
    expect(own.units(state)!.cu.capacity).toBe(10);
    // Every day it was on order ran without it: 1,000 users need 10 CU.
    const { log } = own.advance(bought, 11);
    expect(log.map((d) => outages([d]).length)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
  });

  it("charges power and upkeep only from the day after the kit arrives, a day's share of the monthly cost", () => {
    const bought = buy(fleet(begin(), BIG_APP), "database", "small");
    const { log } = own.advance(bought, 15);
    const lines = upkeepLines(log).filter((e) => e.text.startsWith("Database (small)"));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toEqual({ text: "Database (small) power and upkeep: 1 × £30 a month", cashDelta: -1, category: "infrastructure" });
    expect(log.findIndex((d) => d.entries.includes(lines[0]!))).toBe(10);
    expect(own.monthlyInfrastructureCost(bought)).toBe(own.monthlyInfrastructureCost(fleet(begin(), BIG_APP)));
    expect(own.monthlyInfrastructureCost(own.advance(bought, 10).state)).toBe(own.monthlyInfrastructureCost(fleet(begin(), BIG_APP)) + 30);
  });

  it("sells kit back at the configured share of what it cost, refunded at once", () => {
    const state = fleet(begin(), BIG_APP, BIG_DB, ["cache", "medium"]);
    const sold = sell(state, 3);
    expect(sold).toMatchObject({ day: state.day, cash: state.cash + 800 });
    expect(sold.spend.infrastructure).toBe(state.spend.infrastructure - 800);
    expect(own.servers(sold).map((s) => s.id)).toEqual([1, 2]);
    // A share of what you paid, not today's price: so a server bought dearer sells for more.
    const dear = { ...state, servers: state.servers.map((s) => (s.id === 3 ? { ...s, paid: 5_000 } : s)) };
    expect(own.servers(dear).at(-1)!.sellBack).toBe(2_000);
    expect(sell(dear, 3).cash).toBe(state.cash + 2_000);
    expect(code(() => sell(state, 99))).toBe("unknown_server");
  });

  it("can't cancel an order or sell kit still on order, and has no rent to cancel", () => {
    const bought = buy(begin(), "app", "small");
    const id = bought.servers.at(-1)!.id;
    let refused: SimError | undefined;
    try {
      sell(bought, id);
    } catch (e) {
      refused = e as SimError;
    }
    expect(refused).toMatchObject({ code: "on_order", details: { daysLeft: 10 } });
    expect(code(() => own.applyAction(bought, { type: "cancelServer", id }))).toBe("not_rented");
    expect(code(() => own.applyAction(bought, { type: "rentServer", server: "app", size: "small" }))).toBe("not_for_rent");
    // Once it arrives it can be sold.
    expect(sell(own.advance(bought, 10).state, id).cash).toBe(own.advance(bought, 10).state.cash + 400);
  });

  it("derives ops needed from the kit that has arrived, and cuts every tier when short", () => {
    // 1 ops for each app server and database, 0.5 for each cache and load balancer, rounded up.
    const state = begin();
    expect(own.opsNeededNow(state)).toBe(2);
    expect(own.opsNeeded("onprem")).toBe(2);
    const ordered = buy(buy(state, "cache", "small"), "app", "small");
    expect(own.opsNeededNow(ordered)).toBe(2);
    // Kit on order needs its ops once it arrives: shown ahead.
    expect(own.opsNeededOnceReady(ordered)).toBe(4);
    expect(own.opsNeededNow(own.advance(ordered, 10).state)).toBe(4);
    expect(own.opsNeededNow(sell(own.advance(ordered, 10).state, 4))).toBe(3);
    // With 1 of the 2 ops needed, each tier keeps 40% + 60% × ½ = 70%.
    expect(own.units(withStaff(state, { ops: 1 }))).toMatchObject({ cu: { capacity: 7_000 }, dbu: { capacity: 7_000 } });
  });

  it("can't be bought out of a traffic spike: new kit arrives after it's over", () => {
    // Triples demand for 2 days from day 12: 3,000 users' worth against kit for 2,000.
    const spike: EventConfig = {
      id: "spike",
      name: "Traffic spike",
      description: "A flood of visitors.",
      layer: "runtime",
      schedule: { type: "fixed", days: [12] },
      days: 2,
      load: { multiplier: 2, extra: 0, unitMultiplier: 3 },
      effects: { onprem: { detail: "Your kit melted." } },
    };
    const spiky = createSim({ ...ownConfig, events: [spike] });
    // Kit for 2,000 users: two small app servers behind a load balancer, and two small databases.
    const tight = (s: Sim) =>
      withUsers(fleet(begin(s), ["app", "small"], ["app", "small"], ["loadBalancer", "small"], ["database", "small"], ["database", "small"]), 1_000);
    const daysDown = (log: DayLog[]) => log.filter((d) => outages([d]).length).map((d) => d.day);

    // Up every day without the spike, down both days with it.
    expect(daysDown(own.advance(tight(own), 14).log)).toEqual([]);
    expect(daysDown(spiky.advance(tight(spiky), 14).log)).toEqual([12, 13]);

    // Buying the day before the spike, or once it has hit, doesn't help: the kit is still on order.
    for (const day of [11, 12]) {
      let state = spiky.advance(tight(spiky), day - 1).state;
      for (const server of ["app", "database"] as const) state = buy(buy(state, server, "massive", spiky), server, "massive", spiky);
      state = buy(state, "loadBalancer", "massive", spiky);
      expect(spiky.servers(state).filter((s) => s.status === "pending")).toHaveLength(5);
      expect(daysDown(spiky.advance(state, 14 - day).log)).toEqual([12, 13].filter((d) => d > day));
    }
    // Only kit bought ahead, 10 days before, would have been there.
    let ahead = tight(spiky);
    ahead = buy(buy(ahead, "app", "massive", spiky), "database", "massive", spiky);
    expect(daysDown(spiky.advance(ahead, 14).log)).toEqual([]);
  });

  it("leaves IaaS, PaaS and SaaS as they were: nothing to buy or sell", () => {
    for (const model of ["iaas", "paas", "saas"] as const) {
      const state = begin(own, model);
      expect(code(() => buy(state, "app", "small"))).toBe("not_for_sale");
      expect(code(() => sell(state, 1))).toBe("not_for_sale");
      for (const o of own.serverOptions(state)) expect(o).toMatchObject({ price: null, sellBackShare: null, readyDays: 1 });
      for (const s of own.servers(state)) expect(s).toMatchObject({ paid: null, sellBack: null });
    }
    // Each plays, bills and serves exactly as on a config where on-prem has no kit, only a fixed capacity.
    const plain = createSim({ ...ownConfig, models: { ...ownConfig.models, onprem: config.models.onprem } });
    for (const model of ["iaas", "paas", "saas"] as const) {
      const state = begin(plain, model);
      const run = (s: Sim) => s.advance(model === "iaas" ? s.applyAction(state, { type: "rentServer", server: "cache", size: "small" }) : state, 20);
      expect(run(own)).toEqual(run(plain));
    }
  });

  describe("migrating off on-prem", () => {
    const migrate = (state: GameState, model: ModelId) => own.applyAction(state, { type: "startMigration", model });

    it("sells the kit back at a loss on leaving on-prem, kit on order included", () => {
      const state = buy(fleet(begin(), BIG_APP, BIG_DB), "cache", "small");
      const moving = own.advance(migrate(state, "iaas"), 13).state;
      const ordered = buy(moving, "cache", "small");
      const { state: after, log } = own.advance(ordered);
      expect(after).toMatchObject({ model: "iaas" });
      expect(after.servers.every((s) => s.paid === undefined)).toBe(true);
      // £4,000 + £4,000 + £1,000 + £1,000 paid: 40% back is £4,000.
      expect(log[0]!.entries).toContainEqual({
        text: "Your 4 servers were sold back for £4,000: 40% of the £10,000 you paid.",
        cashDelta: 4_000,
        category: "infrastructure",
      });
    });
  });

  it("is deterministic, and resumes identically after a JSON round trip", () => {
    const run = (state: GameState) => {
      let s = own.advance(buy(state, "app", "small"), 12).state;
      s = sell(s, s.servers.at(-1)!.id);
      return own.advance(buy(s, "cache", "medium"), 5);
    };
    expect(run(begin())).toEqual(run(begin()));
    const half = own.advance(buy(begin(), "loadBalancer", "small"), 3).state;
    expect(own.advance(JSON.parse(JSON.stringify(half)), 12)).toEqual(own.advance(half, 12));
  });

  it("by default, charges the server room up front and the first kit when it's bought, launching when it arrives", () => {
    const s = createSim(smallestLaunch(withoutMvp));
    const { onprem } = defaultConfig.models;
    // The model's upfront cost is the server room, which comes with a medium rack (£500) and its cabling (£50). There's
    // no kit until the company buys some, so nothing is charged twice.
    expect(s.upfrontCost("onprem")).toBe(onprem.upfrontCost + 550);
    expect(s.upfrontCost("onprem")).toBe(3_050);
    expect(onprem.servers!.readyDays).toBe(4);
    for (const p of PRODUCT_TYPE_IDS) {
      const own = s.newGame({ companyName: "Acme", productType: p, model: "onprem", seed: 1 });
      expect(own.cash).toBe(defaultConfig.startingCash - 3_050);
      expect(own.servers).toEqual([]);
      expect(own.racks).toEqual([{ id: 1, size: "medium", paid: 500 }]);
      // A large app server and database, £1,430 on day 1 (video's and the assistant's massive app server, £1,690), and
      // £50 cabling each: starting cash covers them, leaving little to buy more with.
      expect(setUp(s, own).cash).toBe(defaultConfig.startingCash - (COMPUTE_HEAVY.includes(p) ? 4_840 : 4_580));
      const loaned = s.newGame({ companyName: "Acme", productType: p, model: "onprem", seed: 1, takeLoan: true });
      expect(loaned.cash).toBe(defaultConfig.startingCash + defaultConfig.loan.amount - 3_050);
      // The kit arrives on day 5, and the users with it.
      const state = launched(s, loaned);
      expect(state.launchDay, p).toBe(5);
      expect(s.units(withStaff(state, { ops: s.opsNeededNow(state) }))!.usersSupported, p).toBeGreaterThan(state.users * 2);
    }
    // Every bought server sells back at a loss, and costs most of a month's rent of the same VM up front (#160), so it
    // pays for itself in about a month.
    const { purchase } = onprem.servers!;
    expect(purchase!.sellBackShare).toBeLessThan(1);
    for (const t of SERVER_TYPES) {
      for (const size of SERVER_SIZES) {
        expect(purchase!.price[t][size]).toBeGreaterThanOrEqual(0.8 * defaultConfig.models.iaas.servers!.monthlyCost[t]![size]!);
        expect(onprem.servers!.monthlyCost[t]![size]).toBeLessThan(defaultConfig.models.iaas.servers!.monthlyCost[t]![size]!);
      }
    }
  });
});

describe("PaaS managed services", () => {
  // Instances are small app servers, 10 CU at £30 a month (£1 a day). Managed databases and caches give 10, 100, 1,000
  // and 10,000 units at £30, £60, £90 and nothing a month. The starter is one instance and a small database. No growth
  // or variation, so 1,000 users need exactly 10 CU and 10 DBU: the starter setup, full.
  const still = { dailyGrowth: 0, growthNoise: 0, loadNoise: 0 };
  const paasConfig: GameConfig = {
    ...config,
    startingCash: 100_000,
    models: {
      ...config.models,
      paas: {
        ...config.models.paas,
        servers: {
          ...paasServers,
          managed: { ...paasServers.managed, instanceSize: "small" },
          starter: [
            { type: "app", size: "small", count: 1 },
            { type: "database", size: "small", count: 1 },
          ],
        },
      },
    },
    productTypes: {
      ...config.productTypes,
      social: { ...config.productTypes.social, growth: { ...config.productTypes.social.growth, ...still } },
    },
  };
  const paas = createSim(paasConfig);
  // Plenty of ops, so nothing is cut for missing staff unless a test says so.
  const begin = (s: Sim = paas, model = "paas") => withStaff(s.newGame({ companyName: "Acme", productType: "social", model, seed: 42 }), { ops: 10 });
  const act = (state: GameState, action: Action, s: Sim = paas) => s.applyAction(state, action);
  const instances = (state: GameState, count: number) => act(state, { type: "setInstances", count });
  const service = (state: GameState, svc: "database" | "cache", size: ServerSize | null) =>
    act(state, { type: "setManagedService", service: svc, size });
  const withUsers = (state: GameState, users: number) => ({ ...state, users, paidUsers: 0 });
  const outages = (log: DayLog[]) => log.flatMap((d) => d.entries.filter((e) => e.kind === "outage").map((e) => e.text));
  const infraLines = (log: DayLog[]) =>
    log.flatMap((d) => d.entries.filter((e) => e.category === "infrastructure").map((e) => [e.text, e.cashDelta]));
  const codeOf = (attempt: () => unknown) => {
    try {
      attempt();
    } catch (e) {
      return (e as SimError).code;
    }
  };

  it("starts with one app instance and a managed database, ready for the first day, and nothing to rent", () => {
    const state = begin();
    expect(paas.managed(state)).toMatchObject({
      instances: 1,
      maxInstances: 5,
      instanceSize: "small",
      instanceUnits: 10,
      instanceMonthlyCost: 30,
      database: { size: "small", units: 10, monthlyCost: 30 },
      cache: null,
      monthlyCost: 60,
    });
    expect(paas.managed(state)!.databaseOptions).toEqual(paas.managed(state)!.database!.options);
    expect(paas.managed(state)!.database!.options.map((o) => [o.size, o.units, o.monthlyCost])).toEqual([
      ["small", 10, 30],
      ["medium", 100, 60],
      ["large", 1_000, 90],
      ["massive", 10_000, 0],
    ]);
    expect(paas.servers(state).map((s) => [s.name, s.size, s.status])).toEqual([
      ["App instance", "small", "ready"],
      ["Managed database", "small", "ready"],
    ]);
    expect(paas.units(state)).toMatchObject({ cu: { capacity: 10 }, dbu: { capacity: 10 }, ch: { capacity: 0 } });
    expect(paas.serverOptions(state)).toEqual([]);
    expect(paas.provider(state)).toBeNull();
  });

  it("raises the instance count at once: the CU is there for the very next day, with no waiting", () => {
    const busy = withUsers(service(begin(), "database", "medium"), 2_500);
    // 25 CU of demand against one instance's 10: an outage.
    expect(outages(paas.advance(busy).log)).toEqual([expect.stringMatching(/^Compute \(CU\) hit 250% of capacity\./)]);
    const scaled = instances(busy, 3);
    expect(paas.units(scaled)!.cu.capacity).toBe(30);
    expect(paas.servers(scaled).every((s) => s.status === "ready")).toBe(true);
    expect(paas.managed(scaled)!.instances).toBe(3);
    const next = paas.advance(scaled);
    expect(outages(next.log)).toEqual([]);
    expect(next.state.outageDays).toBe(0);
  });

  it("lowers the instance count at once, dropping the newest", () => {
    const three = instances(begin(), 3);
    const one = instances(three, 1);
    expect(one.servers.filter((s) => s.type === "app").map((s) => s.id)).toEqual([1]);
    expect(paas.units(one)!.cu.capacity).toBe(10);
    // The same count again changes nothing.
    expect(instances(one, 1)).toEqual(one);
  });

  it("picks managed database and cache sizes at once, each giving the platform's units", () => {
    for (const size of SERVER_SIZES) {
      // A new company here starts with a small database: setting the size it has is refused.
      const state = service(size === "small" ? begin() : service(begin(), "database", size), "cache", size);
      const units = paasConfig.models.paas.servers!.managed!.units.database[size];
      expect(paas.units(state)).toMatchObject({ dbu: { capacity: units }, ch: { capacity: units } });
      expect(paas.managed(state)).toMatchObject({ database: { size, units }, cache: { size, units } });
      // Still one of each.
      expect(state.servers.filter((s) => s.type === "database")).toHaveLength(1);
      expect(state.servers.filter((s) => s.type === "cache")).toHaveLength(1);
    }
    const noCache = service(service(begin(), "cache", "small"), "cache", null);
    expect(paas.managed(noCache)!.cache).toBeNull();
    expect(paas.units(noCache)!.ch.capacity).toBe(0);
  });

  it("lets a managed cache take load off the managed database, by the same rule as servers", () => {
    // 2,000 users need 20 DBU and 20 CU: the small database's 10 DBU alone is over, but a small cache takes 10.
    const busy = withUsers(instances(begin(), 2), 2_000);
    expect(outages(paas.advance(busy).log)).toEqual([expect.stringMatching(/^The database \(DBU\) hit 200% of capacity\./)]);
    const cached = service(busy, "cache", "small");
    expect(outages(paas.advance(cached).log)).toEqual([]);
    expect(paas.units(paas.advance(cached).state)).toMatchObject({ dbu: { demand: 10, beforeCache: 20 }, ch: { absorbed: 10 } });
  });

  it("bills instances and managed services monthly, a day's share at a time, and stops when they go", () => {
    const setup = service(service(instances(begin(), 3), "database", "medium"), "cache", "small");
    expect(paas.managed(setup)!.monthlyCost).toBe(3 * 30 + 60 + 30);
    const { state, log } = paas.advance(setup);
    expect(infraLines(log)).toEqual([
      ["PaaS running costs (£900 a month)", -30],
      ["App instance (small): 3 × £30 a month", -3],
      ["Managed database (medium): 1 × £60 a month", -2],
      ["Managed cache (small): 1 × £30 a month", -1],
    ]);
    expect(paas.monthlyInfrastructureCost(state)).toBe(900 + 90 + 60 + 30);
    // Back to one instance and no cache: billed for that from the next day.
    const smaller = service(instances(state, 1), "cache", null);
    expect(infraLines(paas.advance(smaller).log)).toEqual([
      ["PaaS running costs (£900 a month)", -30],
      ["App instance (small): 1 × £30 a month", -1],
      ["Managed database (medium): 1 × £60 a month", -2],
    ]);
  });

  it("has a built-in, free load balancer: every instance counts, with no charge and no coverage limit", () => {
    const five = instances(begin(), 5);
    expect(paas.units(five)!.cu.capacity).toBe(50);
    expect(paas.units(five)!.loadBalancer).toEqual({
      builtIn: true,
      appServers: 5,
      loadBalancers: 0,
      needed: false,
      coverage: 0,
      counted: 5,
      uncovered: 0,
    });
    expect(infraLines(paas.advance(five).log).filter(([text]) => String(text).toLowerCase().includes("load balancer"))).toEqual([]);
    // There's no load balancer to rent: it's the platform's.
    expect(codeOf(() => act(five, { type: "rentServer", server: "loadBalancer", size: "small" }))).toBe("managed");
  });

  it("needs only its small fixed ops, however many instances and managed services it runs", () => {
    const state = begin();
    expect(paas.opsNeeded("paas")).toBe(1);
    expect(paas.opsNeededNow(state)).toBe(1);
    const big = service(service(instances(state, 5), "database", "massive"), "cache", "massive");
    expect(paas.opsNeededNow(big)).toBe(1);
    expect(paas.opsNeededNow(paas.advance(big, 3).state)).toBe(1);
    // From config: a teacher can change it.
    const two = createSim({ ...paasConfig, models: { ...paasConfig.models, paas: { ...paasConfig.models.paas, opsNeeded: 2 } } });
    expect(two.opsNeededNow(begin(two))).toBe(2);
    // Short of it, every tier is cut as on any model with servers: 40% with none.
    expect(paas.units(withStaff(big, { ops: 0 }))).toMatchObject({ cu: { capacity: 20 } });
  });

  it("refuses single-server actions on PaaS, PaaS actions elsewhere, and bad counts and sizes, changing nothing", () => {
    const state = begin();
    const copy = structuredClone(state);
    expect(codeOf(() => act(state, { type: "rentServer", server: "app", size: "small" }))).toBe("managed");
    expect(codeOf(() => act(state, { type: "cancelServer", id: 1 }))).toBe("managed");
    expect(codeOf(() => act(state, { type: "buyServer", server: "app", size: "small" }))).toBe("not_for_sale");
    expect(codeOf(() => act(state, { type: "sellServer", id: 1 }))).toBe("not_for_sale");
    for (const count of [0, 6, 1.5, -1]) expect(codeOf(() => instances(state, count))).toBe("bad_instances");
    expect(codeOf(() => service(state, "database", null))).toBe("database_required");
    expect(codeOf(() => act(state, { type: "setManagedService", service: "queue" as "cache", size: "small" }))).toBe("unknown_service");
    expect(codeOf(() => service(state, "cache", "huge" as ServerSize))).toBe("unknown_size");
    expect(state).toEqual(copy);
    for (const model of ["iaas", "onprem", "saas"]) {
      const other = begin(paas, model);
      expect(codeOf(() => instances(other, 2))).toBe("not_managed");
      expect(codeOf(() => service(other, "cache", "small"))).toBe("not_managed");
      expect(paas.managed(other)).toBeNull();
    }
  });

  // Playtest 1: a + that sent the size already running "worked" but changed nothing. Now it says why.
  it("refuses a managed service change that changes nothing, rather than quietly doing nothing", () => {
    // A new company here starts with a small database.
    const state = begin();
    expect(paas.managed(state)).toMatchObject({ database: { size: "small" }, cache: null });
    const copy = structuredClone(state);
    const refusal = (attempt: () => unknown) => {
      try {
        attempt();
      } catch (e) {
        return [(e as SimError).code, (e as SimError).message];
      }
    };
    expect(refusal(() => service(state, "database", "small"))).toEqual([
      "same_size",
      "Your database is already small: pick another size to resize it.",
    ]);
    expect(refusal(() => service(state, "cache", null))).toEqual(["no_cache", "You have no cache to remove."]);
    const cached = service(state, "cache", "medium");
    expect(codeOf(() => service(cached, "cache", "medium"))).toBe("same_size");
    expect(state).toEqual(copy);
    // A real change still goes through: one of each, at the new size.
    const resized = service(cached, "database", "large");
    expect(paas.managed(resized)).toMatchObject({ database: { size: "large" }, cache: { size: "medium" } });
    expect(resized.servers.filter((s) => s.type === "database")).toHaveLength(1);
  });

  it("is deterministic, and resumes identically after a JSON round trip", () => {
    const run = (state: GameState) => {
      let s = paas.advance(instances(withUsers(state, 3_000), 4), 5).state;
      s = service(service(s, "database", "large"), "cache", "medium");
      return paas.advance(instances(s, 2), 5);
    };
    expect(run(begin())).toEqual(run(begin()));
    const half = paas.advance(service(instances(begin(), 3), "cache", "small"), 4).state;
    const roundTrip = JSON.parse(JSON.stringify(half)) as GameState;
    expect(paas.advance(roundTrip, 6)).toEqual(paas.advance(half, 6));
  });

  describe("migrating off PaaS", () => {
    const migrate = (state: GameState, model: ModelId) => paas.applyAction(state, { type: "startMigration", model });

    it("cancels the instances and managed services on leaving PaaS, so their bill stops", () => {
      const big = service(instances(begin(), 4), "cache", "small");
      const { state, log } = paas.advance(migrate(big, "iaas"), 15);
      expect(state.model).toBe("iaas");
      expect(state.servers.map((s) => [s.type, s.size])).toEqual([
        ["app", "massive"],
        ["database", "massive"],
      ]);
      expect(log[13]!.entries.map((e) => e.text)).toContain(
        "Your app instances and managed services were cancelled: you paid for them only for the days you had them.",
      );
      const instanceLines = (days: DayLog[]) => days.flatMap((d) => d.entries.filter((e) => e.text.startsWith("App instance")));
      expect(instanceLines(log.slice(0, 14))).toHaveLength(14);
      expect(instanceLines(log.slice(14))).toEqual([]);
    });
  });
});

describe("SaaS with no servers", () => {
  // Users far beyond anything a server setup in this file could carry.
  const crowd = (state: GameState) => ({ ...state, users: 50_000_000, paidUsers: 0 });
  const begin = (s: Sim = sim) => s.newGame({ companyName: "Acme", productType: "video", model: "saas", seed: 42 });
  const outages = (log: DayLog[]) => log.flatMap((d) => d.entries.filter((e) => e.kind === "outage"));

  it("has no servers and no capacity limit: the provider scales", () => {
    const state = crowd(begin());
    expect(state.servers).toEqual([]);
    expect(sim.servers(state)).toEqual([]);
    expect(sim.serverOptions(state)).toEqual([]);
    expect(sim.units(state)).toBeNull();
    expect(sim.managed(state)).toBeNull();
    expect(sim.capacity(state)).toBeNull();
    expect(sim.provider(begin(sim))).toMatchObject({ users: 1_000, freeUsers: 1_000, perUserFee: 0, monthlyCost: 150 });
  });

  it("never has a capacity outage, however many users and with no ops at all", () => {
    const { state, log } = sim.advance(withStaff(crowd(begin()), { ops: 0 }), 30);
    expect(outages(log)).toEqual([]);
    expect(state.outageDays).toBe(0);
    expect(sim.uptime(state)).toBe(100);
  });

  it("shows the per-user bill, free users included, as the price of its capacity", () => {
    const perUser = createSim({ ...config, models: { ...config.models, saas: { ...config.models.saas, monthlyCostPerUser: 0.3 } } });
    const state = { ...begin(perUser), paidUsers: 400 };
    expect(perUser.provider(state)).toEqual({ users: 1_000, freeUsers: 600, perUserFee: 0.3, monthlyPerUserBill: 300, monthlyCost: 150 });
    expect(perUser.advance(state).log[0]!.entries.map((e) => [e.text, e.cashDelta])).toContainEqual([
      "SaaS per-user fee (1,000 users at £0.30 a month)",
      -10,
    ]);
  });

  it("needs only the small fixed ops from config, however many users", () => {
    const one = createSim({ ...config, models: { ...config.models, saas: { ...config.models.saas, opsNeeded: 1 } } });
    expect(one.opsNeeded("saas")).toBe(1);
    expect(one.opsNeededNow(begin(one))).toBe(1);
    expect(one.opsNeededNow(crowd(begin(one)))).toBe(1);
    expect(createSim(defaultConfig).opsNeeded("saas")).toBe(defaultConfig.models.saas.opsNeeded);
  });

  it("still goes down when the provider does", () => {
    const outage: EventConfig = {
      id: "providerOutage",
      name: "Provider outage",
      description: "The provider's data centre lost power.",
      layer: "facilities",
      schedule: { type: "fixed", days: [3] },
      days: 1,
      effects: { saas: { downtimeHours: 6, detail: "The SaaS platform went down with it." } },
    };
    const s = createSim({ ...config, events: [outage] });
    const { state, log } = s.advance(crowd(begin(s)), 5);
    expect(outages(log).map((e) => e.text)).toEqual(["Provider outage. Down 6 hours; growth slowed."]);
    expect(state.outageDays).toBe(1);
    expect(state.downtimeHours).toBe(6);
  });

  it("refuses every server action", () => {
    const state = begin();
    const codes = (["rentServer", "buyServer"] as const).map((type) => {
      try {
        sim.applyAction(state, { type, server: "app", size: "small" });
      } catch (e) {
        return (e as SimError).code;
      }
    });
    expect(codes).toEqual(["no_servers", "not_for_sale"]);
    expect(() => sim.applyAction(state, { type: "setInstances", count: 2 })).toThrow(expect.objectContaining({ code: "not_managed" }));
  });
});

describe("PaaS and SaaS leave on-prem and IaaS alone", () => {
  // The configs before this slice: PaaS and SaaS on a fixed capacity.
  const fixed = (base: GameConfig): GameConfig => ({
    ...base,
    models: {
      ...base.models,
      paas: { ...base.models.paas, servers: undefined, capacity: 100_000 },
      saas: { ...base.models.saas, opsNeeded: 0, capacity: 100_000 },
    },
  });

  it("plays on-prem and IaaS identically, on the test config and the default one", () => {
    for (const base of [config, roomyDefaults]) {
      const now = createSim(base);
      const before = createSim(fixed(base));
      for (const model of ["onprem", "iaas"]) {
        for (const productType of PRODUCT_TYPE_IDS) {
          const start = (s: Sim) => (withStaff(s.newGame({ companyName: "Acme", productType, model, seed: 3 }), { ops: 3 }));
          expect(now.advance(start(now), 40)).toEqual(before.advance(start(before), 40));
          expect(now.opsNeeded(model as ModelId)).toBe(before.opsNeeded(model as ModelId));
        }
      }
    }
  });
});

describe("default PaaS and SaaS", () => {
  const s = createSim(smallestLaunch(withoutMvp));
  const { paas, iaas, saas } = defaultConfig.models;
  const perUnit = (price: number | undefined, units: number) => price! / units;

  it("prices every PaaS unit above the cheapest IaaS one, with no load balancer charge", () => {
    const cheapest = (type: "app" | "database" | "cache") =>
      Math.min(...SERVER_SIZES.map((size) => perUnit(iaas.servers!.monthlyCost[type]![size], defaultConfig.servers.types[type].units[size])));
    const managed = paas.servers!.managed!;
    const instance = managed.instanceSize;
    expect(perUnit(paas.servers!.monthlyCost.app![instance], defaultConfig.servers.types.app.units[instance])).toBeGreaterThan(cheapest("app"));
    for (const type of ["database", "cache"] as const) {
      for (const size of SERVER_SIZES) {
        expect(perUnit(paas.servers!.monthlyCost[type]![size], managed.units[type][size]), `${type} ${size}`).toBeGreaterThan(cheapest(type));
      }
    }
    expect(paas.servers!.monthlyCost.loadBalancer).toBeUndefined();
    expect(paas.servers!.opsPerServer).toBeUndefined();
  });

  it("needs a few fixed ops on PaaS and SaaS, no more than IaaS's first VMs", () => {
    // The first VMs need their ops once they're ready (#259).
    const iaasOps = s.opsNeededOnceReady(setUp(s, s.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 1 })));
    for (const model of ["paas", "saas"] as const) {
      expect(s.opsNeeded(model)).toBeGreaterThan(0);
      expect(s.opsNeeded(model)).toBeLessThanOrEqual(iaasOps);
    }
    expect(paas.capacity).toBeUndefined();
    expect(saas.capacity).toBeUndefined();
    expect(saas.servers).toBeUndefined();
  });

  it("launches PaaS on day 2 with one instance and a small database, carrying every launch total with room to grow", () => {
    for (const p of PRODUCT_TYPE_IDS) {
      expect(s.managed(s.newGame({ companyName: "Acme", productType: p, model: "paas", seed: 1 }))!.instances).toBe(0);
      const state = launched(s, s.newGame({ companyName: "Acme", productType: p, model: "paas", seed: 1 }));
      expect(state.launchDay, p).toBe(2);
      expect(s.managed(state)!.instances, p).toBeLessThanOrEqual(2);
      expect(s.units(state)!.usersSupported, p).toBeGreaterThan(state.users * 1.5);
      expect(s.advance(state, 7).state.outageDays, p).toBe(0);
    }
  });

  it("scales PaaS through the traffic spike at a cost per unit", () => {
    const spike = defaultConfig.events.find((e) => e.id === "trafficSpike")!;
    expect(spike.effects.paas!.scaleCostPerUnit).toBeGreaterThan(0);
    expect(spike.effects.paas!.opsNeeded).toBeUndefined();
    expect(spike.effects.saas!.scaleCostPerUnit).toBeUndefined();
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
    expect(state.spendByDay).toMatchObject([
      { day: 1, staff: 0, infrastructure: 50, addons: 0, debt: 0, income: 0, borrowed: 0 },
      ...[2, 3, 4, 5].map((day) => ({ day, staff: 3, infrastructure: 20, addons: 0, debt: 0, income: 0, borrowed: 0 })),
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

describe("rescue buyout and liquidation", () => {
  // 1000 cash at 20 a day on IaaS: day 51 leaves exactly 0, day 52 goes below.
  const broke = () => sim.advance(start(), 50);
  // The vulture VC puts in the £20 of losses and 30 days at £20 a day, to the £100 above: £700, leaving £680. That
  // lasts 34 days, so cash runs out again on day 87.
  const rescued = () => sim.advance(start(), 51).state;

  it("does not rescue the company at exactly zero cash", () => {
    const { state } = broke();
    expect(state).toMatchObject({ day: 51, cash: 0, status: "playing", rescue: null });
    expect(sim.rescue(state)).toBeNull();
  });

  it("rescues the company the first time cash goes below zero: cash, the share taken and the cuts, in the log", () => {
    const { state, log } = sim.advance(broke().state);
    expect(state).toMatchObject({ day: 52, cash: 680, status: "playing" });
    expect(state.rescue).toEqual({
      day: 52,
      amount: 700,
      losses: 20,
      shares: 30_000,
      share: 0.75,
      cuts: [],
      hiresCancelled: 0,
      savedPerDay: 0,
      severance: 0,
      boughtBack: null,
    });
    const rescue = log[0]!.entries.filter((e) => e.kind === "rescue");
    expect(rescue).toHaveLength(2);
    expect(rescue[0]).toMatchObject({ cashDelta: 700 });
    expect(rescue[0]!.text).toMatch(/vulture VC rescued Acme: it put in £700 \(£20 to cover the losses.*30,000 new shares, 75% of the company\. You now own 25%/);
    expect(rescue[1]!.text).toMatch(/Forced cost cuts/);
    expect(sim.capTable(state).rows.map((r) => [r.id, r.name, r.share])).toEqual([
      ["student", "You", 0.25],
      ["vulture", "Vulture VC", 0.75],
    ]);
    // The rescue is money raised, not income, so the cash chart still adds up.
    expect(state.spendByDay.at(-1)).toMatchObject({ day: 52, raised: 700, income: 0 });
    expect(sim.summarise(state).days.at(-1)!.cash).toBe(680);
  });

  it("forces cost cuts: the dearest grades first, ops kept to what the servers need, and hires cancelled", () => {
    const base = start();
    const need = sim.opsNeededNow(base);
    const staffed: GameState = {
      ...base,
      staff: {
        developers: { junior: 1, mid: 2, senior: 1 },
        ops: { junior: 0, mid: need, senior: 0 },
        support: { junior: 4, mid: 0, senior: 0 },
        moderators: { junior: 0, mid: 0, senior: 0 },
        researchers: { junior: 0, mid: 0, senior: 0 },
        marketers: { junior: 0, mid: 0, senior: 0 },
      },
      hiring: [{ pool: "developers", grade: "mid", count: 2, agency: false, arrivesOn: 999 }],
    };
    const { state, log } = sim.advance(staffed, 200);
    const rescue = state.rescue!;
    expect(rescue.cuts).toEqual([
      { pool: "developers", grade: "senior", count: 1, agency: false },
      { pool: "support", grade: "junior", count: 1, agency: false },
    ]);
    expect(rescue.hiresCancelled).toBe(2);
    // A senior developer at £14 a day and a junior support person at £1.
    expect(rescue.savedPerDay).toBe(15);
    const after = sim.advance(staffed, rescue.day - 1).state;
    expect(after.hiring).toEqual([]);
    expect(after.staff.developers).toEqual({ junior: 1, mid: 2, senior: 0 });
    expect(after.staff.ops.mid).toBe(need);
    const text = log.flatMap((d) => d.entries).find((e) => e.text.startsWith("Forced cost cuts"))!.text;
    expect(text).toMatch(/let go 1 senior developer, let go 1 junior support person, cancelled 2 hires still to start, saving £15 a day/);
  });

  it("lets agency staff go first in the cuts, then pays permanent staff's severance out of the cash put in", () => {
    // Severance of 10 days' pay: a senior developer's £14 a day is £140.
    const severed = createSim({ ...config, severance: { days: 10 } });
    const base = severed.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 });
    const none = { junior: 0, mid: 0, senior: 0 };
    // 8 developers, a quarter cut: the agency mid, then the permanent senior.
    const staffed: GameState = {
      ...base,
      staff: { ...base.staff, developers: { junior: 3, mid: 3, senior: 1 } },
      agency: { ...base.agency, developers: { ...none, mid: 1 } },
    };
    const { state, log } = severed.advance(staffed, 200);
    const rescue = state.rescue!;
    expect(rescue.cuts).toEqual([
      { pool: "developers", grade: "mid", count: 1, agency: true },
      { pool: "developers", grade: "senior", count: 1, agency: false },
    ]);
    expect(rescue.severance).toBe(140);
    // An agency mid developer at £14 a day and a permanent senior at £14.
    expect(rescue.savedPerDay).toBe(28);
    const day = log.find((d) => d.day === rescue.day)!.entries;
    expect(day).toContainEqual({ text: "Severance for the permanent staff let go in the cuts", cashDelta: -140, category: "staff" });
    expect(day.find((e) => e.text.startsWith("Forced cost cuts"))!.text).toMatch(/let go 1 agency mid developer, let go 1 senior developer/);
    expect(day.find((e) => e.kind === "rescue")!.text).toMatch(/£140 for severance/);
  });

  it("goes into liquidation the second time cash goes below zero, and says so in the log", () => {
    const { state, log } = sim.advance(rescued(), 100);
    expect(state).toMatchObject({ day: 87, cash: -20, status: "liquidated" });
    expect(log.at(-1)!.day).toBe(87);
    expect(log.at(-1)!.entries.at(-1)).toMatchObject({ kind: "liquidation", cashDelta: 0 });
    expect(log.at(-1)!.entries.at(-1)!.text).toMatch(/after the rescue buyout on day 52: Acme goes into liquidation/);
    expect(sim.summarise(state)).toMatchObject({ ending: "liquidation", day: 87, rescue: { day: 52, amount: 700 } });
    expect(sim.valuation(state).valuation).toBe(0);
  });

  it("stops a multi-day advance on the day of liquidation, carrying on through the rescue", () => {
    const { state, log } = sim.advance(start(), 200);
    expect(state).toMatchObject({ day: 87, status: "liquidated" });
    expect(log.at(-1)!.day).toBe(87);
  });

  it("rejects advances and actions afterwards", () => {
    const { state } = sim.advance(start(), 200);
    for (const attempt of [
      () => sim.advance(state),
      () => sim.applyAction(state, { type: "hire", pool: "ops" }),
      () => sim.applyAction(state, { type: "buyBack" }),
    ]) {
      expect(attempt).toThrow(SimError);
      expect(attempt).toThrow(expect.objectContaining({ code: "liquidated" }));
    }
    expect(sim.rescue(state)).toMatchObject({ buyBackPrice: null, canBuyBack: false });
  });

  it("offers the vulture VC's shares back at its price, and sells them for it", () => {
    const state = rescued();
    const view = sim.rescue(state)!;
    // No paying users or revenue, so the business is worth nothing without its cash: the price is twice the £700.
    expect(view).toMatchObject({ vultureShares: 30_000, vultureShare: 0.75, buyBackPrice: 1_400, canBuyBack: false });
    expect(view.priceDetail).toMatch(/2× the £700 it put in: it never sells back for less/);
    expect(() => sim.applyAction(state, { type: "buyBack" })).toThrow(
      expect.objectContaining({ code: "cant_afford", details: { cost: 1_400, cash: 680 } }),
    );
    // More cash doesn't move the price: the company pays with it.
    const rich = { ...state, cash: 2_000 };
    expect(sim.rescue(rich)).toMatchObject({ buyBackPrice: 1_400, canBuyBack: true });
    const bought = sim.applyAction(rich, { type: "buyBack" });
    expect(bought.cash).toBe(600);
    expect(bought.rescue!.boughtBack).toEqual({ day: 52, price: 1_400 });
    expect(sim.capTable(bought).rows.map((r) => [r.id, r.share])).toEqual([["student", 1]]);
    expect(sim.rescue(bought)).toMatchObject({ vultureShares: 0, buyBackPrice: null, canBuyBack: false });
    expect(bought.spendByDay.at(-1)!.raised).toBe(700 - 1_400);
    expect(() => sim.applyAction(bought, { type: "buyBack" })).toThrow(expect.objectContaining({ code: "bought_back" }));
  });

  it("prices a trading business at the premium on its share of the valuation, leaving out the cash", () => {
    const real = settlingPay(createSim({ ...defaultConfig, launch: { ...defaultConfig.launch, auto: 1 } }));
    const begun = real.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 3 });
    let state = withStaff(real.advance(begun, 40).state, { developers: 30 });
    while (!state.rescue) state = real.advance(state).state;
    const { valuation, sharesInIssue, drivers } = real.valuation(state);
    const netCash = drivers.find((d) => d.id === "netCash")!.amount;
    const business = Math.max(0, valuation - netCash) - (drivers.find((d) => d.id === "minimum")?.amount ?? 0);
    expect(business).toBeGreaterThan(0);
    const premium = Math.ceil((1.5 * business * state.rescue.shares) / sharesInIssue / 100) * 100;
    const price = Math.max(premium, 2 * state.rescue.amount);
    expect(real.rescue(state)!.buyBackPrice).toBe(price);
  });

  it("refuses a buy-back before any rescue", () => {
    expect(() => sim.applyAction(start(), { type: "buyBack" })).toThrow(expect.objectContaining({ code: "no_rescue" }));
  });

  it("is rescued sooner with more staff", () => {
    const hired = sim.applyAction(start(), { type: "hire", pool: "developers" });
    expect(sim.advance(hired, 100).state.rescue!.day).toBeLessThan(sim.advance(start(), 100).state.rescue!.day);
  });


  it("is deterministic", () => {
    expect(sim.advance(start(), 100)).toEqual(sim.advance(start(), 100));
  });

  it("refuses to start on a model that costs more up front than the starting cash, unless the loan covers it", () => {
    const s = createSim({ ...config, models: { ...config.models, iaas: { ...config.models.iaas, upfrontCost: 1001 } } });
    const attempt = () => s.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 1 });
    expect(attempt).toThrow(expect.objectContaining({ code: "cant_afford", details: { cost: 1001, cash: 1000 } }));
    expect(attempt).toThrow(/bank loan/);
    const borrowed = s.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 1, takeLoan: true });
    expect(borrowed).toMatchObject({ cash: 1000 + 17_900 - 1001, status: "playing" });
    // Exactly enough is fine: it leaves £0.
    const exact = createSim({ ...config, models: { ...config.models, iaas: { ...config.models.iaas, upfrontCost: 1000 } } });
    expect(exact.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 1 })).toMatchObject({
      cash: 0,
      status: "playing",
    });
  });
});

describe("shortfalls onto the loan, and the vulture VC past 7 days", () => {
  // The default limit: shortfalls can go onto a loan up to 7 days of daily costs before cash has run out.
  const lenient = createSim({ ...config, rescue: { ...config.rescue, limitDays: 7 } });
  // 1000 cash at 20 a day on IaaS: day 51 leaves exactly 0, day 52 goes £20 below.
  const atZero = () => lenient.advance(start(), 50).state;

  it("opens an emergency loan on a short term for a small shortfall with no loan, not a rescue", () => {
    const { state, log } = lenient.advance(atZero());
    // The rate a loan taken on day 52 would have: 10% plus 0.2 points for each of the 51 days later.
    expect(state).toMatchObject({ day: 52, cash: 0, status: "playing", rescue: null, firstShortfallDay: 52 });
    expect(state.loan).toEqual({
      amount: 20,
      day: 52,
      rate: 0.202,
      term: 30,
      lastDay: 82,
      dailyRepayment: 1,
      total: 30,
      repaid: 0,
      interestPaid: 0,
      paidOffDay: null,
      emergency: true,
      shortfall: 20,
    });
    const note = log[0]!.entries.find((e) => e.text.startsWith("Cash went"))!;
    expect(note).toMatchObject({ cashDelta: 20 });
    expect(note.text).toMatch(/Cash went £20 below £0 with no bank loan, so the bank opened an emergency loan for it at 20.2%: £1 a day for 30 days/);
    // The daily costs are £21 with the repayment: 7 days is £147, £127 more than the £20 on the loan.
    expect(note.text).toMatch(/Shortfalls can go £127 further \(7 days of costs, £147 in all\) before a vulture VC steps in/);
    expect(lenient.shortfall(state)).toEqual({ limitDays: 7, limit: 147, owed: 20, room: 127 });
    // Borrowed, not income, so the cash chart adds up.
    expect(state.spendByDay.at(-1)).toMatchObject({ borrowed: 20, income: 0 });
    // Repaid from the next day like any loan.
    expect(lenient.advance(state).state.loan).toMatchObject({ repaid: 1 });
  });

  it("adds a shortfall to the bank loan being repaid: the same repayment a day, for longer", () => {
    const rich = createSim({ ...config, startingCash: 100_000, rescue: { ...config.rescue, limitDays: 7 } });
    const borrowed = rich.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42, takeLoan: true });
    // £50 against £130 a day (£20 of IaaS, £110 of repayment): £80 short.
    const { state, log } = rich.advance({ ...borrowed, cash: 50 });
    expect(state).toMatchObject({ cash: 0, rescue: null, pastLoans: [] });
    // £80 at the loan's 10% adds £88 to repay, at £110 a day: a day longer.
    expect(state.loan).toMatchObject({ amount: 17_980, total: 19_690 + 88, dailyRepayment: 110, term: 180, lastDay: 181, shortfall: 80 });
    expect(state.loan!.emergency).toBeUndefined();
    expect(log[0]!.entries.find((e) => e.text.startsWith("Cash went"))!.text).toMatch(/Cash went £80 below £0: the shortfall went on your bank loan, still £110 a day, now until day 181/);
  });

  it("stops time the first time cash goes below £0, saying how far it can still go", () => {
    const first = lenient.tick(atZero());
    expect(first.pauses).toEqual([
      { kind: "alert", id: "shortfall", text: "Cash went below £0 and the shortfall went on your loan: £127 more and a vulture VC steps in" },
    ]);
    // Only the first time.
    expect(lenient.tick(first.state).pauses.map((p) => p.id)).not.toContain("shortfall");
  });

  it("rescues only once shortfalls would go past 7 days of daily costs", () => {
    let state = atZero();
    while (state.status === "playing" && !state.rescue) {
      const before = state;
      state = lenient.advance(state).state;
      if (!state.rescue) {
        // Short of the limit, cash is never below £0: the shortfall is on the loan, within its 7 days.
        expect(state.cash).toBeGreaterThanOrEqual(0);
        const view = lenient.shortfall(state);
        expect(view.owed).toBeLessThanOrEqual(view.limit);
      } else {
        // The day it fires, that day's shortfall was more than the room left.
        expect(state.rescue.losses).toBeGreaterThan(lenient.shortfall(before).room);
      }
    }
    expect(state.rescue!.day).toBeGreaterThan(52);
    // What shortfalls put on the loan is still owed: the vulture VC only covered the day that took it past the limit.
    expect(state.loan).toMatchObject({ emergency: true });
    expect(state.loan!.shortfall).toBeGreaterThan(100);
  });

  it("goes into liquidation the second time cash runs out, past the limit again", () => {
    const strictEnd = sim.advance(start(), 200).state;
    const { state, log } = lenient.advance(start(), 400);
    expect(state.status).toBe("liquidated");
    expect(state.day).toBeGreaterThan(strictEnd.day);
    expect(log.at(-1)!.entries.find((e) => e.kind === "liquidation")!.text).toMatch(/Cash ran out again, after the rescue buyout on day \d+/);
  });

  it("prices the buy-back on the vulture VC's stake now, after later rounds dilute it", () => {
    // Rescued on day 52 for £700 and 75%: the price is twice the £700.
    const rescued = sim.advance(start(), 51).state;
    expect(sim.rescue(rescued)).toMatchObject({ vultureShare: 0.75, buyBackPrice: 1_400 });
    // New shares for an angel halve its stake to 37.5%: the least it takes halves too.
    const diluted = { ...rescued, shareholders: [...rescued.shareholders, { id: "angel" as const, shares: 40_000, day: 52 }] };
    const view = sim.rescue(diluted)!;
    expect(view).toMatchObject({ vultureShare: 0.375, buyBackPrice: 700 });
    expect(view.priceDetail).toMatch(/2× the £700 it put in, scaled to its 75% stake now diluted to 37.5%/);
    const bought = sim.applyAction({ ...diluted, cash: 1_000 }, { type: "buyBack" });
    expect(bought.cash).toBe(300);
  });

  it("takes an emergency loan still owed at the end off the final cash", () => {
    const short = createSim({ ...config, finalDay: 55, rescue: { ...config.rescue, limitDays: 7 } });
    const { state, log } = short.advance(short.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 }), 60);
    expect(state).toMatchObject({ day: 55, status: "finished" });
    // Days 52–55 went £20, £21, £21 and £21 below £0 onto the emergency loan, repaid £1, £1 and £1 a day: the rest is
    // owed, and comes off the cash as the game ends.
    const settled = log.at(-1)!.entries.find((e) => e.text.startsWith("The game is over"))!;
    expect(settled.text).toMatch(/still owed on your emergency loan comes off your cash/);
    expect(state.cash).toBe(settled.cashDelta);
    expect(short.loan(state)).toMatchObject({ remaining: 0, repaidInFull: true, paidOffDay: 55 });
    expect(short.summarise(state)).toMatchObject({ cash: state.cash, loan: { remaining: 0 } });
    expect(short.valuation(state).drivers.find((d) => d.id === "netCash")!.amount).toBe(state.cash);
  });
});

describe("runway", () => {
  const apply =(state: GameState, ...actions: Action[]) => actions.reduce((st, a) => sim.applyAction(st, a), state);

  /** The daily costs by heading, leaving out the headings at £0. */
  const headings = (state: GameState) =>
    Object.fromEntries(sim.runway(state).costs.filter((h) => h.amount !== 0).map((h) => [h.id, h.amount]));
  /** The state with these incomes recorded on its last days, the latest last. */
  const withIncomes = (state: GameState, incomes: number[]): GameState => ({
    ...state,
    spendByDay: state.spendByDay.map((d) => {
      const i = incomes.length - 1 - (state.day - d.day);
      return i >= 0 && i < incomes.length ? { ...d, income: incomes[i]! } : d;
    }),
  });

  it("is today's costs against income, and the days of cash that leaves", () => {
    // £20 a day on IaaS and nothing coming in: £1,000 lasts 50 days.
    expect(sim.runway(start())).toMatchObject({ dailyIncome: 0, dailyCosts: 20, dailyNet: -20, days: 50, oneOffsThisWeek: 0 });
    expect(headings(start())).toEqual({ hosting: 20 });
    const staffed = apply(start(), { type: "hire", pool: "developers", count: 2 }, { type: "hire", pool: "ops" });
    const runway = sim.runway(staffed);
    expect(runway).toMatchObject({ dailyCosts: 20 + 14 + 3, dailyNet: -37, days: 27 });
    expect(headings(staffed)).toEqual({ hosting: 20, staff: 17 });
    // The headings add up to the costs, and a day played costs the same.
    expect(runway.costs.reduce((sum, h) => sum + h.amount, 0)).toBe(runway.dailyCosts);
    expect(sim.advance(staffed).state.cash - staffed.cash).toBe(-runway.dailyCosts);
  });

  it("lists every heading in order", () => {
    expect(sim.runway(start()).costs.map((h) => h.label)).toEqual([
      "Staff pay",
      "Executive pay",
      "Staff schemes",
      "Hosting, rent and power",
      "Add-ons and platform fees",
      "Campaigns",
      "Loan repayments",
    ]);
  });

  it("counts loan repayments", () => {
    const rich = createSim({ ...config, startingCash: 100_000 });
    const borrowed = rich.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42, takeLoan: true });
    expect(rich.runway(borrowed)).toMatchObject({ dailyCosts: 20 + 110, dailyNet: -130 });
    expect(rich.runway(borrowed).costs.find((h) => h.id === "loan")!.amount).toBe(110);
  });

  it("counts executive pay, but none during the board's pay holiday", () => {
    const shortlisted = start();
    const c = shortlisted.csuite.shortlists.cto[0]!;
    const hired = (n: number): GameState => ({
      ...shortlisted,
      csuite: {
        ...shortlisted.csuite,
        hired: (["cto", "cfo", "legalCounsel"] as const)
          .slice(0, n)
          .map((role) => ({ role, name: c.name, strength: c.strength, salary: 50, equity: 0, shares: 0, day: 1 })),
      },
    });
    // Appointing executives puts the costs up, never down.
    expect([0, 1, 2, 3].map((n) => sim.runway(hired(n)).dailyCosts)).toEqual([20, 70, 120, 170]);
    expect(headings(hired(3))).toEqual({ hosting: 20, executives: 150 });
    const holiday = { ...hired(3), csuite: { ...hired(3).csuite, payHolidaySince: 1 } };
    expect(sim.runway(holiday)).toMatchObject({ dailyCosts: 20, payHoliday: true });
    expect(sim.advance(hired(3)).state.cash - hired(3).cash).toBe(-170);
  });

  it("counts staff schemes and campaigns", () => {
    const staffed = apply(start(), { type: "hire", pool: "developers", count: 2 });
    const schemes = { ...staffed, staffSchemes: { ...staffed.staffSchemes, pension: 3, health: 3 } };
    expect(headings(schemes).schemes).toBeGreaterThan(0);
    expect(sim.advance(schemes).state.cash - schemes.cash).toBe(-sim.runway(schemes).dailyCosts);
    const campaign = {
      ...{ id: 1, customerType: "casual" as const, budget: 700, days: 7, startDay: 2, endDay: 8, stopped: false },
      ...{ holiday: null, grade: "mid" as const, spent: 0, earned: 0, users: 0, marketAdded: 0, quote: null },
    };
    const marketing = { ...staffed, campaigns: [campaign] };
    expect(headings(marketing)).toMatchObject({ campaigns: 100 });
    expect(sim.advance(marketing).state.spendByDay.at(-1)!.campaigns).toBe(100);
    // Once it has run its days, it costs nothing.
    expect(headings({ ...marketing, day: 8 }).campaigns).toBeUndefined();
  });

  it("uses income averaged over the last 7 days, and is null days only when that covers the costs", () => {
    const week = sim.advance(start(), 8).state;
    const cash = week.cash;
    expect(sim.runway(week).dailyCosts).toBe(20);
    // £70 over the week is £10 a day: losing £10 a day.
    expect(sim.runway(withIncomes(week, [0, 0, 0, 0, 0, 0, 70]))).toMatchObject({
      dailyIncome: 10,
      dailyNet: -10,
      days: Math.floor(cash / 10),
    });
    // A payday of £140 a week covers £20 a day exactly: not losing money, whichever day it fell on.
    for (const incomes of [[140, 0, 0, 0, 0, 0, 0], [0, 0, 0, 140, 0, 0, 0]]) {
      expect(sim.runway(withIncomes(week, incomes))).toMatchObject({ dailyIncome: 20, dailyNet: 0, days: null });
    }
    // Income from before the last 7 days doesn't count.
    expect(sim.runway(withIncomes(week, [1_000, 0, 0, 0, 0, 0, 0, 0]))).toMatchObject({ dailyIncome: 0, days: Math.floor(cash / 20) });
    // Never "not losing money" while the net is negative.
    for (let income = 0; income <= 200; income += 7) {
      const r = sim.runway(withIncomes(week, Array(7).fill(income)));
      expect(r.days === null, `£${income} a day`).toBe(r.dailyNet >= 0);
    }
  });

  it("averages over the days played so far in the first week", () => {
    const day2 = withIncomes(sim.advance(start(), 1).state, [0, 30]);
    expect(day2.day).toBe(2);
    expect(sim.runway(day2).dailyIncome).toBe(15);
  });

  it("keeps one-offs apart, as this week's", () => {
    // Severance of 10 days' pay.
    const s = createSim({ ...config, severance: { days: 10 } });
    const begin = s.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 });
    const staffed = s.advance(s.applyAction(begin, { type: "hire", pool: "developers", count: 2 }), 10).state;
    const before = s.runway(staffed);
    const letGo = s.applyAction(staffed, { type: "letGo", pool: "developers", count: 1 });
    const severance = staffed.cash - letGo.cash;
    expect(severance).toBeGreaterThan(0);
    // The severance is a one-off: the costs fall by the pay, and the severance shows apart.
    expect(s.runway(letGo)).toMatchObject({ dailyCosts: before.dailyCosts - 7, oneOffsThisWeek: severance });
    expect(letGo.spendByDay.at(-1)!.oneOffs).toBe(severance);
    // Still this week's six days on, gone after seven.
    expect(s.runway(s.advance(letGo, 6).state).oneOffsThisWeek).toBe(severance);
    expect(s.runway(s.advance(letGo, 7).state).oneOffsThisWeek).toBe(0);
  });
});

describe("bank loan", () => {
  // Cash for 180 days on IaaS at £20 a day without the loan. The loan is £17,900: 10% at the start, plus 0.2 points a
  // day later, repaid by day 180.
  const rich = createSim({ ...config, startingCash: 100_000 });
  const begin = (takeLoan = false) =>
    rich.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42, takeLoan });
  const takeLoan: Action = { type: "takeLoan" };
  const debts = (log: DayLog[]) => log.flatMap((d) => d.entries.filter((e) => e.category === "debt"));
  const loanNotes = (log: DayLog[]) =>
    log.flatMap((d) => d.entries.filter((e) => e.kind === "loan").map((e) => ({ day: d.day, text: e.text })));
  // Day 60: 59 days later, so 21.8%, repaid over the 120 days from 61 to 180.
  const onDay60 = () => rich.advance(begin(), 59).state;

  it("can be taken at the start: the money arrives on day 1 as borrowing, not income", () => {
    const state = begin(true);
    expect(state.cash).toBe(100_000 + 17_900);
    expect(state.loan).toEqual({
      amount: 17_900,
      day: 1,
      rate: 0.1,
      term: 179,
      lastDay: 180,
      dailyRepayment: 110,
      total: 19_690,
      repaid: 0,
      interestPaid: 0,
      paidOffDay: null,
    });
    expect(state.spendByDay).toEqual([
      {
        day: 1,
        staff: 0,
        infrastructure: 0,
        cabling: 0,
        power: 0,
        addons: 0,
        campaigns: 0,
        debt: 0,
        income: 0,
        feeIncome: 0,
        transactionIncome: 0,
        borrowed: 17_900,
        raised: 0,
        interest: 0,
        users: 1000,
        paidUsers: 0,
        satisfaction: 100,
        hoursDown: 0,
        // No one-offs, and the daily costs it ended on: £20 of IaaS and £110 of loan repayment.
        oneOffs: 0,
        costs: 130,
      },
    ]);
    expect(state.income).toBe(0);
    expect(rich.startLoanQuote()).toEqual({
      amount: 17_900,
      rate: 0.1,
      interest: 1_790,
      total: 19_690,
      dailyRepayment: 110,
      days: 179,
      lastDay: 180,
    });
    expect(rich.loan(state)).toMatchObject({ remaining: 19_690, daysLeft: 179 });
  });

  it("costs more a day taken later, at a higher rate over fewer days", () => {
    const quote = rich.loanQuote(onDay60())!;
    // £21,802.20 over 120 days, rounded up to £182 a day.
    expect(quote).toEqual({
      amount: 17_900,
      rate: 0.218,
      interest: 3_940,
      total: 21_840,
      dailyRepayment: 182,
      days: 120,
      lastDay: 180,
    });
    const atStart = rich.loanQuote(begin())!;
    expect(atStart).toEqual(rich.startLoanQuote());
    expect(quote.dailyRepayment).toBeGreaterThan(atStart.dailyRepayment);
    expect(quote.rate).toBeGreaterThan(atStart.rate);
    expect(quote.interest).toBeGreaterThan(atStart.interest);
    // Later still is worse again.
    const day120 = rich.loanQuote(rich.advance(begin(), 119).state)!;
    expect(day120.dailyRepayment).toBeGreaterThan(quote.dailyRepayment);
  });

  it("charges exactly what the quote said, daily as debt, and is repaid on the final day", () => {
    const before = onDay60();
    const quote = rich.loanQuote(before)!;
    const taken = rich.applyAction(before, takeLoan);
    expect(taken.cash).toBe(before.cash + 17_900);
    expect(taken.day).toBe(60);
    const { state, log } = rich.advance(taken, 200);
    expect(state).toMatchObject({ day: 180, status: "finished" });
    const repayments = debts(log);
    expect(repayments).toHaveLength(quote.days);
    expect(repayments.every((e) => e.cashDelta === -quote.dailyRepayment)).toBe(true);
    expect(log[0]!.day).toBe(61);
    expect(log.at(-1)!.entries.some((e) => e.category === "debt")).toBe(true);
    expect(state.spend.debt).toBe(quote.total);
    expect(state.loan).toMatchObject({ day: 60, rate: quote.rate, total: quote.total, repaid: quote.total });
    expect(rich.loan(state)).toMatchObject({ remaining: 0, daysLeft: 0 });
    // A note when it's taken, on the first repayment, and when it's repaid.
    const notes = loanNotes(log);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ day: 61, text: expect.stringContaining("on day 60 at 21.8% interest") });
    expect(notes[0]!.text).toContain("£182 a day for 120 days, until day 180");
    expect(notes[1]).toMatchObject({ day: 180, text: expect.stringContaining("repaid in full") });
  });

  it("taken at the start, is repaid in equal amounts from day 2 to the final day", () => {
    const { state, log } = rich.advance(begin(true), 200);
    expect(state).toMatchObject({ day: 180, status: "finished" });
    expect(debts(log)).toHaveLength(179);
    expect(debts(log).every((e) => e.cashDelta === -110)).toBe(true);
    expect(state.spend.debt).toBe(19_690);
    expect(loanNotes(log)[0]).toMatchObject({ day: 2, text: expect.stringContaining("at the start at 10% interest") });
    // Nothing after it's repaid: the last repayment and the note are on day 180.
    expect(loanNotes(log).at(-1)!.day).toBe(180);
  });

  it("refuses a second loan while one is being repaid", () => {
    const refused = expect.objectContaining({ code: "loan_open" });
    expect(() => rich.applyAction(begin(true), takeLoan)).toThrow(refused);
    const taken = rich.applyAction(onDay60(), takeLoan);
    expect(() => rich.applyAction(taken, takeLoan)).toThrow(SimError);
    expect(() => rich.applyAction(rich.advance(taken, 10).state, takeLoan)).toThrow(refused);
    expect(rich.loanQuote(taken)).toBeNull();
    expect(rich.loanQuote(begin(true))).toBeNull();
  });

  it("isn't lent in the game's last days", () => {
    // Day 166 leaves 14 days: the fewest. Day 167 leaves 13.
    const day166 = rich.advance(begin(), 165).state;
    expect(rich.loanQuote(day166)).toMatchObject({ days: 14 });
    const day167 = rich.advance(day166).state;
    expect(rich.loanQuote(day167)).toBeNull();
    expect(() => rich.applyAction(day167, takeLoan)).toThrow(
      expect.objectContaining({ code: "too_late_for_loan", details: { daysLeft: 13 } }),
    );
    const short = createSim({ ...config, finalDay: 10 });
    expect(() => short.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1, takeLoan: true })).toThrow(
      expect.objectContaining({ code: "too_late_for_loan" }),
    );
  });

  it("makes debt a spend category, with the categories and the cash series adding up", () => {
    expect(SPEND_CATEGORIES).toContain("debt");
    const { state, log } = rich.advance(rich.applyAction(onDay60(), takeLoan), 30);
    expect(state.spend.debt).toBeCloseTo(-debts(log).reduce((sum, e) => sum + e.cashDelta, 0), 6);
    for (const c of SPEND_CATEGORIES) {
      expect(state.spendByDay.reduce((sum, d) => sum + d[c], 0)).toBeCloseTo(state.spend[c], 6);
    }
    // Cash is the start, plus income and borrowing, less every cost.
    const costs = SPEND_CATEGORIES.reduce((sum, c) => sum + state.spend[c], 0);
    expect(state.cash).toBeCloseTo(100_000 + state.income + 17_900 - costs, 6);
    // The borrowing is on day 60, so the cash chart shows the jump then and nothing before it.
    const { days } = rich.summarise(state);
    expect(days.find((d) => d.day === 60)).toMatchObject({ borrowed: 17_900 });
    expect(days.find((d) => d.day === 59)!.cash).toBe(rich.advance(begin(), 58).state.cash);
    expect(days[0]!.cash).toBe(begin().cash);
    // Profit counts only the interest in the repayments: the principal paid back was borrowed, not earned.
    const { loan } = state;
    expect(state.interestPaid).toBe(Math.round((state.spend.debt * (loan!.total - loan!.amount)) / loan!.total));
    expect(state.interestPaid).toBe(state.spendByDay.reduce((sum, d) => sum + d.interest, 0));
    const principal = state.spend.debt - state.interestPaid;
    expect(principal).toBeGreaterThan(0);
    const profit = rich.summarise(state).profit;
    expect(profit).toBeCloseTo(state.income - costs + principal, 6);
  });

  it("charges repayments whatever happens, so they can run a company out of cash", () => {
    // SaaS at £5 a day: £1,000 lasts to day 180 alone, but £110 a day of repayments on top of the £17,900 runs out.
    const play = (takeLoan: boolean) =>
      sim.advance(sim.newGame({ companyName: "Acme", productType: "ecommerce", model: "saas", seed: 1, takeLoan }), 200);
    expect(play(false).state).toMatchObject({ day: 180, status: "finished" });
    const { state, log } = play(true);
    expect(state.rescue!.day).toBeLessThan(180);
    const rescueDay = log.find((d) => d.day === state.rescue!.day)!.entries;
    expect(rescueDay.some((e) => e.category === "debt")).toBe(true);
    expect(rescueDay.some((e) => e.kind === "rescue")).toBe(true);
    expect(sim.summarise(state).loan).toMatchObject({ day: 1, amount: 17_900 });
  });

  it("is deterministic", () => {
    const play = () => rich.advance(rich.applyAction(onDay60(), takeLoan), 50);
    expect(play()).toEqual(play());
  });

  describe("with a fixed term", () => {
    // A 120-day term at the start, half a day shorter for each day later, and never under 60, whatever the game's
    // length.
    const termed = (finalDay: number) =>
      createSim({
        ...config,
        startingCash: 100_000,
        finalDay,
        loan: { ...config.loan, termDays: 120, termPerDay: 0.5, minTermDays: 60 },
      });
    const long = termed(400);
    const startLong = (takeLoan = false) =>
      long.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42, takeLoan });
    const repayLoan: Action = { type: "repayLoan" };

    it("repays over the same term in any game length", () => {
      // £19,690 over 120 days, rounded up to £165 a day.
      const quote = { amount: 17_900, rate: 0.1, interest: 1_900, total: 19_800, dailyRepayment: 165, days: 120 };
      for (const finalDay of [30, 180, 400]) {
        expect(termed(finalDay).startLoanQuote()).toEqual({ ...quote, lastDay: 121 });
      }
      const { state, log } = long.advance(startLong(true), 199);
      expect(state.day).toBe(200);
      expect(debts(log)).toHaveLength(120);
      expect(log.find((d) => d.day === 121)!.entries.some((e) => e.text.includes("repaid in full"))).toBe(true);
      expect(log.find((d) => d.day === 122)!.entries.some((e) => e.category === "debt")).toBe(false);
      expect(long.loan(state)).toMatchObject({ remaining: 0, daysLeft: 0, repaidInFull: true });
      expect(state.interestPaid).toBe(1_900);
    });

    it("runs past the final day of a short game, so what's still owed comes off the cash as it ends", () => {
      const short = termed(30);
      const begun = short.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42, takeLoan: true });
      const before = short.advance(begun, 28).state;
      const { state, log } = short.advance(before);
      expect(state.status).toBe("finished");
      const settled = log.at(-1)!.entries.find((e) => e.text.startsWith("The game is over"))!;
      expect(settled).toMatchObject({ category: "debt", interest: 0 });
      expect(settled.text).toMatch(/still owed on your bank loan comes off your cash/);
      const payoff = -settled.cashDelta;
      expect(payoff).toBeGreaterThan(0);
      // The money borrowed not yet paid back: less than the repayments left, as the interest still to come is waived.
      expect(payoff).toBeLessThan(19_800 - 29 * 165);
      // Nothing is left owing, so the valuation's net cash is just the cash.
      expect(short.summarise(state).loan).toMatchObject({ loans: 1, repaid: 29 * 165 + payoff, remaining: 0, fullyRepaid: true });
      expect(short.valuation(state).drivers.find((d) => d.id === "netCash")!.amount).toBe(Math.round(state.cash));
      expect(state.cash).toBe(before.cash - 20 - 165 - payoff);
    });

    it("settles what's still owed when the teacher ends the game", () => {
      const short = termed(30);
      const begun = short.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42, takeLoan: true });
      const state = short.advance(begun, 10).state;
      const { payoff } = short.loan(state)!;
      const ended = short.endGame(state);
      expect(ended).toMatchObject({ status: "finished", cash: state.cash - payoff });
      expect(short.loan(ended)).toMatchObject({ remaining: 0, repaidInFull: true, paidOffDay: state.day });
    });

    it("is lent until the last days of the game's own length", () => {
      const year = createSim({
        ...config,
        startingCash: 100_000,
        allowedGameLengths: { "180-days": 0, "until-ipo": 0, "1-year": 1, career: 0 },
        loan: { ...config.loan, termDays: 120, termPerDay: 0.5, minTermDays: 60 },
      });
      const begun = year.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 });
      expect(begun.finalDay).toBe(365);
      // Day 300 is past a 180-day game's end, but a year has 65 days left: the usual 60-day term, to day 360.
      expect(year.loanQuote(year.advance(begun, 299).state)).toMatchObject({ days: 60, lastDay: 360 });
      expect(year.loanQuote(year.advance(begun, 352).state)).toBeNull();
    });

    it("is shorter, and dearer, taken later", () => {
      const day61 = long.loanQuote(long.advance(startLong(), 60).state)!;
      // 22% over 90 days.
      expect(day61).toMatchObject({ rate: 0.22, days: 90, lastDay: 151 });
      const day200 = long.loanQuote(long.advance(startLong(), 199).state)!;
      expect(day200).toMatchObject({ days: 60, lastDay: 260 });
      expect(day200.interest).toBeGreaterThan(day61.interest);
    });

    it("allows a new loan once the last is repaid, at the later day's terms", () => {
      const repaid = long.advance(startLong(true), 120).state;
      expect(repaid.day).toBe(121);
      const quote = long.loanQuote(repaid)!;
      expect(quote).toMatchObject({ rate: 0.34, days: 60, lastDay: 181 });
      const second = long.applyAction(repaid, takeLoan);
      expect(second.cash).toBe(repaid.cash + 17_900);
      expect(second.pastLoans).toEqual([repaid.loan]);
      expect(second.loan).toMatchObject({ day: 121, rate: 0.34, repaid: 0 });
      expect(() => long.applyAction(second, takeLoan)).toThrow(expect.objectContaining({ code: "loan_open" }));

      const { state, log } = long.advance(second, 100);
      expect(debts(log)).toHaveLength(60);
      const summary = long.summarise(state);
      expect(summary.loan).toMatchObject({
        loans: 2,
        day: 1,
        amount: 35_800,
        total: 19_800 + quote.total,
        repaid: 19_800 + quote.total,
        interestPaid: 1_900 + quote.interest,
        principalRepaid: 35_800,
        remaining: 0,
        fullyRepaid: true,
      });
      // Only the two loans' interest counts against profit.
      const plain = long.summarise(long.advance(startLong(), 220).state);
      expect(summary.profit).toBeCloseTo(plain.profit - 1_900 - quote.interest, 6);
    });

    it("can be paid off early with what's left of the money borrowed, saving the interest still to come", () => {
      const midway = long.advance(startLong(true), 30).state;
      // 30 repayments of £165 so far, £1,900 × 4,950 ÷ 19,800 = £475 of them interest, so £4,475 of the £17,900
      // is paid back.
      const view = long.loan(midway)!;
      expect(view).toMatchObject({ repaid: 4_950, interestPaid: 475, remaining: 14_850, daysLeft: 90 });
      expect(view).toMatchObject({ payoff: 13_425, interestSaved: 1_425, repaidInFull: false });

      const paidOff = long.applyAction(midway, repayLoan);
      expect(paidOff.cash).toBe(midway.cash - 13_425);
      expect(paidOff.loan).toMatchObject({ repaid: 18_375, interestPaid: 475, paidOffDay: 31 });
      expect(paidOff.spend.debt).toBe(18_375);
      expect(paidOff.interestPaid).toBe(475);
      expect(long.loan(paidOff)).toMatchObject({ remaining: 0, payoff: 0, repaidInFull: true });

      // No more repayments, and a new loan can be taken.
      const { state, log } = long.advance(paidOff, 100);
      expect(debts(log)).toHaveLength(0);
      expect(long.loanQuote(paidOff)).not.toBeNull();

      // Against keeping it to the end of the term, profit is better by the interest saved.
      const kept = long.summarise(long.advance(startLong(true), 130).state);
      const early = long.summarise(state);
      expect(early.profit).toBeCloseTo(kept.profit + 1_425, 6);
      expect(early.loan).toMatchObject({ repaid: 18_375, interestPaid: 475, interestSaved: 1_425, fullyRepaid: true });
      expect(early.cash).toBe(kept.cash + 1_425);
    });

    it("refuses to pay off without a loan being repaid, or without the cash", () => {
      const noLoan = expect.objectContaining({ code: "no_loan" });
      expect(() => long.applyAction(startLong(), repayLoan)).toThrow(noLoan);
      expect(() => long.applyAction(long.advance(startLong(true), 120).state, repayLoan)).toThrow(noLoan);
      const midway = long.advance(startLong(true), 30).state;
      expect(() => long.applyAction({ ...midway, cash: 13_424 }, repayLoan)).toThrow(
        expect.objectContaining({ code: "not_enough_cash", details: { cost: 13_425, cash: 13_424 } }),
      );
    });
  });
});

describe("difficulty", () => {
  const every = { easy: 1, normal: 1, hard: 1 };
  const allowing = (difficulties: Partial<GameConfig["allowedDifficulties"]>) =>
    createSim({ ...defaultConfig, allowedDifficulties: { easy: 0, normal: 0, hard: 0, ...difficulties } });
  const newGame = (s: Sim, difficulty?: string) =>
    s.newGame({ companyName: "Acme", productType: "ecommerce", model: "saas", seed: 1, difficulty });

  it("allows only Normal by default, and Normal is the preset's own numbers", () => {
    const s = createSim();
    expect(s.config.allowedDifficulties).toEqual({ easy: 0, normal: 1, hard: 0 });
    expect(s.config).toBe(defaultConfig);
    const game = newGame(s);
    expect(game.difficulty).toBe("normal");
    expect(s.summarise(game).difficulty).toBe("normal");
    for (const difficulty of ["easy", "hard", "nightmare"]) {
      expect(() => newGame(s, difficulty)).toThrow(expect.objectContaining({ code: "difficulty_not_allowed" }));
    }
    expect(() => newGame(s, "hard")).toThrow(/difficulty your teacher allows: Normal\./);
  });

  it("starts on Normal when allowed and none is picked, otherwise the easiest allowed", () => {
    expect(newGame(allowing(every)).difficulty).toBe("normal");
    expect(newGame(allowing({ easy: 1, hard: 1 })).difficulty).toBe("easy");
    expect(newGame(allowing({ hard: 1 })).difficulty).toBe("hard");
  });

  it("changes the starting cash, how fast the danger meter climbs and the customers' price thresholds", () => {
    const s = allowing(every);
    const [easy, normal, hard] = (["easy", "normal", "hard"] as const).map((d) => newGame(s, d));
    // SaaS has nothing to pay up front, so the cash left after day 1 follows the starting cash.
    const spentOnDay1 = defaultConfig.startingCash - normal!.cash;
    expect(easy!.cash).toBe(defaultConfig.startingCash * 1.5 - spentOnDay1);
    expect(hard!.cash).toBe(defaultConfig.startingCash * 0.8 - spentOnDay1);

    expect(s.danger(normal!).dailyRise).toBe(defaultConfig.encounters.dailyRise);
    expect(s.danger(easy!).dailyRise).toBeLessThan(s.danger(normal!).dailyRise);
    expect(s.danger(hard!).dailyRise).toBeGreaterThan(s.danger(normal!).dailyRise);

    const thresholds = (g: GameState) => s.customerMix(g).types.map((t) => t.threshold);
    const fair = s.fairPrice(normal!);
    expect(thresholds(normal!)).toEqual(
      Object.values(defaultConfig.customerTypes).map((t) => Math.round(fair * t.thresholdMultiple * 100) / 100),
    );
    thresholds(easy!).forEach((t, i) => expect(t).toBeGreaterThan(thresholds(normal!)[i]!));
    thresholds(hard!).forEach((t, i) => expect(t).toBeLessThan(thresholds(normal!)[i]!));
    // The same price loses more payers on Hard.
    const rise = (g: GameState) => s.pricePreview(g, fair * 1.5).reaction;
    expect(rise(hard!)).toBeGreaterThan(rise(normal!));
    expect(rise(easy!)).toBeLessThan(rise(normal!));
  });

  it("never changes which systems a game has", () => {
    const s = allowing(every);
    const shape = (g: GameState) => Object.keys(g).toSorted();
    const [easy, normal, hard] = (["easy", "normal", "hard"] as const).map((d) => newGame(s, d));
    expect(shape(easy!)).toEqual(shape(normal!));
    expect(shape(hard!)).toEqual(shape(normal!));
    expect(s.events(hard!).map((e) => e.id)).toEqual(s.events(normal!).map((e) => e.id));
  });

  it("keeps playing a game on its own difficulty once the preset stops allowing it", () => {
    const easy = newGame(allowing({ easy: 1 }), "easy");
    // Launching by itself, as the danger meter only rises once the company is live.
    const s = createSim({ ...defaultConfig, launch: { ...defaultConfig.launch, auto: 1 } });
    const { state } = s.advance(easy, 20);
    expect(state).toMatchObject({ difficulty: "easy", day: 21 });
    expect(s.summarise(state).difficulty).toBe("easy");
    // On Normal's numbers from the same start, the danger meter climbs faster.
    const sameStart = { ...easy, difficulty: "normal" } as GameState;
    expect(s.danger(s.advance(sameStart, 10).state).meter).toBeGreaterThan(s.danger(s.advance(easy, 10).state).meter);
  });
});

describe("game lengths", () => {
  const allowing = (lengths: Partial<GameConfig["allowedGameLengths"]>) =>
    createSim({ ...config, allowedGameLengths: { "180-days": 0, "until-ipo": 0, "1-year": 0, career: 0, ...lengths } });
  const newGame = (s: Sim, gameLength?: string) =>
    s.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1, gameLength });
  const rich = (lengths: Partial<GameConfig["allowedGameLengths"]>) =>
    createSim({ ...config, startingCash: 10_000_000, allowedGameLengths: { "180-days": 0, "until-ipo": 0, "1-year": 0, career: 0, ...lengths } });

  it("allows only 180 days by default", () => {
    const s = createSim();
    expect(s.config.allowedGameLengths).toEqual({ "180-days": 1, "until-ipo": 0, "1-year": 0, career: 0 });
    expect(newGame(s)).toMatchObject({ gameLength: "180-days", finalDay: 180, endedByTeacher: false });
    for (const length of ["1-year", "career"]) {
      expect(() => newGame(s, length)).toThrow(expect.objectContaining({ code: "game_length_not_allowed" }));
    }
  });

  it("starts a game of any allowed length, with its final day", () => {
    const s = allowing({ "180-days": 1, "1-year": 1, career: 1 });
    expect(newGame(s, "180-days")).toMatchObject({ gameLength: "180-days", finalDay: 180 });
    expect(newGame(s, "1-year")).toMatchObject({ gameLength: "1-year", finalDay: 365 });
    expect(newGame(s, "career")).toMatchObject({ gameLength: "career", finalDay: 47 * 365 });
  });

  it("starts on the first allowed length when none is picked, and refuses one it doesn't know", () => {
    const s = allowing({ "1-year": 1, career: 1 });
    expect(newGame(s)).toMatchObject({ gameLength: "1-year" });
    expect(() => newGame(s, "180-days")).toThrow(/game length your teacher allows: 1 year, Career/);
    expect(() => newGame(s, "forever")).toThrow(expect.objectContaining({ code: "game_length_not_allowed" }));
  });

  it("ends a 1-year game on day 365 and a career after 47 years", () => {
    const s = rich({ "1-year": 1, career: 1 });
    const year = s.advance(newGame(s, "1-year"), 400);
    expect(year.state).toMatchObject({ day: 365, status: "finished" });
    expect(year.log.at(-1)!.entries.at(-1)!.text).toMatch(/Day 365 was the last/);
    expect(s.summarise(year.state)).toMatchObject({ ending: "completed", gameLength: "1-year", finalDay: 365 });

    const career = newGame(s, "career");
    const nearlyRetired = s.advance({ ...career, day: 47 * 365 - 2 }, 1).state;
    expect(nearlyRetired).toMatchObject({ day: 47 * 365 - 1, status: "playing" });
    expect(s.advance(nearlyRetired, 10).state).toMatchObject({ day: 17_155, status: "finished" });
  });

  it("lets the teacher end a game early, as it stands, with its summary", () => {
    const s = rich({ "1-year": 1 });
    const { state } = s.advance(newGame(s, "1-year"), 40);
    const ended = s.endGame(state);
    expect(ended).toMatchObject({ day: 41, cash: state.cash, status: "finished", endedByTeacher: true });
    expect(s.summarise(ended)).toMatchObject({ ending: "ended", day: 41, finalDay: 365, cash: state.cash });
    expect(() => s.advance(ended)).toThrow(/Your teacher ended Acme early/);
    expect(() => s.applyAction(ended, { type: "hire", pool: "ops" })).toThrow(expect.objectContaining({ code: "finished" }));
    // Ending a game that is already over leaves it as it was.
    expect(s.endGame(ended)).toEqual(ended);
    const liquidated = { ...state, status: "liquidated" } as GameState;
    expect(s.endGame(liquidated)).toEqual(liquidated);
  });
});

describe("game end and summary", () => {
  // A 30-day game, with cash for two migrations. IaaS costs 20 a day and £100 upfront; PaaS 30 a day. A loan's term
  // ends on the final day.
  const shortConfig: GameConfig = {
    ...config,
    startingCash: 100_000,
    finalDay: 30,
    loan: { ...config.loan, termDays: 29 },
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

  it("keeps the final day a game started with, whatever config loads it later", () => {
    const longer = sim.advance(sim.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1 }), 39);
    expect(longer.state).toMatchObject({ day: 40, finalDay: 180, status: "playing" });
    expect(s.load(longer.state).status).toBe("playing");
    expect(s.advance(longer.state).state).toMatchObject({ day: 41, status: "playing" });
  });

  it("ends a game saved on or past its final day", () => {
    const { state } = s.advance(begin(), 10);
    const saved = { ...state, day: 30, status: "playing" } as GameState;
    expect(s.load(saved).status).toBe("finished");
    expect(() => s.advance(saved)).toThrow(expect.objectContaining({ code: "finished" }));
    expect(s.summarise(saved).ending).toBe("completed");
  });

  it("counts liquidation on the final day as liquidation, and a rescue on it as finishing", () => {
    // 1000 cash at 20 a day on IaaS goes below zero on day 52, and again on day 87 after the rescue.
    const play = (finalDay: number) => {
      const tight = createSim({ ...config, finalDay });
      const { state } = tight.advance(tight.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1 }), 200);
      return { state, ending: tight.summarise(state).ending };
    };
    expect(play(87)).toMatchObject({ state: { day: 87, status: "liquidated" }, ending: "liquidation" });
    expect(play(52)).toMatchObject({ state: { day: 52, status: "finished", rescue: { day: 52 } }, ending: "completed" });
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
      cabling: charges(log, "cabling"),
      power: charges(log, "power"),
      addons: charges(log, "addons"),
      campaigns: charges(log, "campaigns"),
      debt: 0,
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
    expect(days[0]).toEqual({
      day: 1,
      staff: 0,
      infrastructure: 100,
      cabling: 0,
      power: 0,
      addons: 0,
      campaigns: 0,
      debt: 0,
      income: 0,
      feeIncome: 0,
      transactionIncome: 0,
      borrowed: 0,
      raised: 0,
      interest: 0,
      users: 1000,
      paidUsers: 0,
      satisfaction: 100,
      hoursDown: 0,
      // The upfront bill is a one-off, apart from the £20 a day of daily costs.
      oneOffs: 100,
      costs: 20,
      cash: 99_900,
    });
    expect(days.at(-1)!.cash).toBe(cash);
    for (let i = 1; i < days.length; i++) {
      const d = days[i]!;
      expect(days[i - 1]!.cash - d.cash).toBe(SPEND_CATEGORIES.reduce((sum, c) => sum + d[c], 0));
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

  it("summarises a liquidated game", () => {
    const { state, log } = sim.advance(start(), 200);
    const summary = sim.summarise(state);
    expect(summary).toMatchObject({ ending: "liquidation", day: 87, cash: -20, finalDay: 180 });
    expect(summary.days).toHaveLength(87);
    expect(summary.days.at(-1)!.cash).toBe(-20);
    expect(summary.spend.infrastructure).toBe(charges(log, "infrastructure"));
    expect(summary.totalSpend).toBe(1720);
    // Everyone free, so no income: all loss.
    expect(summary).toMatchObject({ income: 0, profit: -1720, priceChanges: 0, loan: null, satisfaction: 100 });
    expect(summary.incomeVsCosts).toHaveLength(87);
    expect(summary.incomeVsCosts.at(-1)).toMatchObject({ day: 87, totalIncome: 0, totalCosts: 1720 });
    expect(summary.peak.users).toBe(Math.max(...summary.days.map((d) => d.users)));
  });

  it("summarises a game still being played, with no ending", () => {
    const summary = s.summarise(s.advance(begin(), 5).state);
    expect(summary).toMatchObject({ ending: null, day: 6 });
    expect(summary.days).toHaveLength(6);
  });

  describe("for reflection: income, profit, users, satisfaction, price changes and the loan", () => {
    // A shop with 60% paying, tickets and no support so satisfaction falls, an app server that carries 1,100 load so
    // growth brings outages, a price rise on day 5 and the loan on day 10.
    const busy = createSim({
      ...shortConfig,
      servers: iaasCapacity(1_100, shortConfig).servers,
      productTypes: {
        ...shortConfig.productTypes,
        ecommerce: {
          ...shortConfig.productTypes.ecommerce,
          pricing: { fairPrice: 30, freeShare: 0.4, conversionRate: 0, customerMix: allCasual },
          support: { ticketsPerPaidUser: 0.05, ticketsPerFreeUser: 0.01 },
        },
      },
    });
    // Day by day, so the test can check the summary against every state on the way.
    const play = () => {
      let state = busy.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 });
      const states = [state];
      while (state.status === "playing") {
        if (state.day === 5) state = busy.applyAction(state, { type: "setPrice", price: 36 });
        if (state.day === 10) state = busy.applyAction(state, { type: "takeLoan" });
        state = busy.advance(state).state;
        states.push(state);
      }
      return { state, states, summary: busy.summarise(state) };
    };

    it("adds up income and costs to the daily figures, with only the loan's interest a cost, and profit is the difference", () => {
      const { state, summary } = play();
      expect(state).toMatchObject({ day: 30, status: "finished" });
      expect(summary.income).toBe(summary.days.reduce((sum, d) => sum + d.income, 0));
      expect(summary.income).toBeGreaterThan(0);
      const costs = summary.days.reduce((sum, d) => sum + SPEND_CATEGORIES.reduce((t, c) => t + d[c], 0), 0);
      expect(summary.totalSpend).toBeCloseTo(costs, 6);
      expect(summary.spend.debt).toBeGreaterThan(0);
      // Of the debt, only the interest is a cost: the principal paid back was borrowed, not earned.
      const interest = state.loan!.total - state.loan!.amount;
      expect(summary.costs).toBeCloseTo(summary.totalSpend - summary.spend.debt + interest, 6);
      expect(summary.profit).toBeCloseTo(summary.income - summary.costs, 6);
      // The series has each day's figures and running totals, ending on the summary's.
      expect(summary.incomeVsCosts.map((d) => d.day)).toEqual(summary.days.map((d) => d.day));
      summary.incomeVsCosts.forEach((d, i) => {
        const day = summary.days[i]!;
        expect(d.income).toBe(day.income);
        const spent = SPEND_CATEGORIES.reduce((t, c) => t + day[c], 0);
        expect(d.costs).toBeLessThanOrEqual(spent + 1e-6);
        expect(d.costs).toBeGreaterThanOrEqual(spent - day.debt - 1e-6);
      });
      expect(summary.incomeVsCosts.at(-1)!.totalIncome).toBe(summary.income);
      expect(summary.incomeVsCosts.at(-1)!.totalCosts).toBeCloseTo(summary.costs, 6);
    });

    it("gives peak users with the paid/free split then, and the split at the end", () => {
      const { state, states, summary } = play();
      const most = Math.max(...states.map((st) => st.users));
      const first = states.find((st) => st.users === most)!;
      expect(summary.peak).toEqual({ day: first.day, users: most, paidUsers: first.paidUsers });
      expect(summary).toMatchObject({ users: state.users, paidUsers: state.paidUsers });
      expect(summary.peak.paidUsers).toBeLessThan(summary.peak.users);
    });

    it("averages satisfaction over the days played, and gives uptime with the outages", () => {
      const { state, states, summary } = play();
      const played = states.filter((st) => st.day > 1);
      expect(summary.satisfaction).toBeCloseTo(played.reduce((sum, st) => sum + st.satisfaction, 0) / played.length, 9);
      expect(summary.satisfaction).toBeLessThan(100);
      expect(summary.outageDays).toBeGreaterThan(0);
      expect(summary.uptime).toBe(busy.uptime(state));
      expect(summary.uptime).toBeLessThan(100);
    });

    it("counts the price changes, and gives the loan: when, how much, and repaid in full by the final day", () => {
      const { state, summary } = play();
      expect(summary.priceChanges).toBe(1);
      expect(summary.loan).toEqual({
        loans: 1,
        day: 10,
        amount: 17_900,
        total: state.loan!.total,
        repaid: state.loan!.total,
        interestPaid: state.loan!.total - 17_900,
        principalRepaid: 17_900,
        interestSaved: 0,
        remaining: 0,
        settledAtEnd: 0,
        fullyRepaid: true,
      });
      expect(summary.spend.debt).toBe(state.loan!.total);
    });

    it("gives a loan still being repaid as not fully repaid", () => {
      const day10 = busy.advance(busy.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 }), 9);
      const midway = busy.advance(busy.applyAction(day10.state, { type: "takeLoan" }), 5).state;
      expect(busy.summarise(midway).loan).toMatchObject({
        day: 10,
        repaid: 5 * midway.loan!.dailyRepayment,
        remaining: midway.loan!.total - 5 * midway.loan!.dailyRepayment,
        fullyRepaid: false,
      });
    });

    it("is deterministic", () => {
      expect(play().summary).toEqual(play().summary);
    });
  });

  describe("profit with the bank loan", () => {
    // The same game twice, trading the same way, one with the loan at the start: there's cash enough either way, so
    // the loan changes nothing but the money.
    const play = (takeLoan: boolean, days = 29) =>
      s.advance(s.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42, takeLoan }), days)
        .state;

    it("differs from a game without the loan only by the interest", () => {
      const borrowed = play(true);
      const plain = play(false);
      expect(borrowed.status).toBe("finished");
      const a = s.summarise(borrowed);
      const b = s.summarise(plain);
      expect(a.income).toBe(b.income);
      const interest = borrowed.loan!.total - borrowed.loan!.amount;
      expect(interest).toBeGreaterThan(0);
      expect(a.profit).toBeCloseTo(b.profit - interest, 6);
      expect(a.loan).toMatchObject({ interestPaid: interest, principalRepaid: borrowed.loan!.amount, fullyRepaid: true });
      // The chart's gap at the end is the profit, too.
      const last = a.incomeVsCosts.at(-1)!;
      expect(last.totalIncome - last.totalCosts).toBeCloseTo(a.profit, 6);
    });

    it("counts the interest paid so far while the loan is being repaid", () => {
      const a = s.summarise(play(true, 10));
      const b = s.summarise(play(false, 10));
      const { amount, total, repaid } = a.loan!;
      expect(repaid).toBeGreaterThan(0);
      expect(a.loan!.interestPaid).toBe(Math.round((repaid * (total - amount)) / total));
      expect(a.loan!.interestPaid + a.loan!.principalRepaid).toBe(repaid);
      expect(a.profit).toBeCloseTo(b.profit - a.loan!.interestPaid, 6);
    });

    it("leaves cash and the debt category as they were: the whole repayment is spent", () => {
      const borrowed = play(true);
      const plain = play(false);
      const a = s.summarise(borrowed);
      const b = s.summarise(plain);
      expect(a.spend.debt).toBe(borrowed.loan!.total);
      expect(a.totalSpend).toBeCloseTo(b.totalSpend + borrowed.loan!.total, 6);
      expect(a.cash).toBeCloseTo(b.cash + borrowed.loan!.amount - borrowed.loan!.total, 6);
      expect(a.totalSpend).toBeCloseTo(SPEND_CATEGORIES.reduce((sum, c) => sum + a.spend[c], 0), 6);
      for (const c of SPEND_CATEGORIES) {
        expect(a.days.reduce((sum, d) => sum + d[c], 0)).toBeCloseTo(a.spend[c], 6);
      }
      expect(a.days.at(-1)!.cash).toBe(a.cash);
    });
  });

  it("is deterministic and JSON-serialisable", () => {
    const play = () => s.summarise(s.advance(s.applyAction(begin(7), migrate("saas")), 40).state);
    expect(play()).toEqual(play());
    expect(JSON.parse(JSON.stringify(play()))).toEqual(play());
  });
});

describe("default config", () => {
  const sim180 = settlingPay(createSim(roomyDefaults));
  const run = (productType: string, model: string, ops?: number) => {
    const start = setUp(sim180, sim180.newGame({ companyName: "Acme", productType, model, seed: 7 }));
    return sim180.advance(ops === undefined ? start : withStaff(start, { ops }), defaultConfig.finalDay - 1).state;
  };
  // On servers, rents (or on-prem, buys) a massive one for any tier past half its capacity, enough headroom for load
  // variation, the seasonal spike and on-prem's delivery time: a cache while it has room to take more off the
  // database, then a database.
  const rentAhead = (state: GameState): GameState => {
    const units = sim180.units(state);
    if (!units) return state;
    // On PaaS, an instance more, or the next size of managed database (then cache), at once.
    const managed = sim180.managed(state);
    if (managed) {
      const next = (size: ServerSize) => SERVER_SIZES[SERVER_SIZES.indexOf(size) + 1];
      const act = (action: Action) => rentAhead(sim180.applyAction(state, action));
      if (units.cu.demand > units.cu.capacity / 2 && managed.instances < managed.maxInstances) {
        return act({ type: "setInstances", count: managed.instances + 1 });
      }
      if (units.dbu.demand > units.dbu.capacity / 2) {
        const database = managed.database ? next(managed.database.size) : "small";
        if (database) return act({ type: "setManagedService", service: "database", size: database });
        const cache = managed.cache ? next(managed.cache.size) : "small";
        if (cache) return act({ type: "setManagedService", service: "cache", size: cache });
      }
      return state;
    }
    const type = state.model === "onprem" ? "buyServer" : "rentServer";
    // On-prem, a large rack first when no rack has room for a massive server.
    const racks = sim180.racks(state);
    const racked = racks && racks.mostFree < racks.serverUnits.massive ? sim180.applyAction(state, { type: "buyRack", size: "large" }) : state;
    const rent = (server: ServerType) =>
      rentAhead(sim180.applyAction(racked, { type, server, size: "massive" }));
    const { cu, dbu, ch, loadBalancer } = units;
    // VMs are ready the next day, so it waits for any being set up. Kit takes a week to arrive, so on-prem buys
    // further ahead, and waits only for kit of the same type already on order.
    const onprem = state.model === "onprem";
    const ahead = onprem ? 2.5 : 2;
    const pending = (type: ServerType) => sim180.servers(state).some((s) => s.status === "pending" && (!onprem || s.type === type));
    const add = (server: ServerType) => (pending(server) ? undefined : rent(server));
    if (loadBalancer.uncovered > 0) return add("loadBalancer") ?? state;
    const app = cu.demand > cu.capacity / ahead ? add("app") : undefined;
    if (app) return app;
    if (dbu.demand > dbu.capacity / ahead) return add(ch.absorbed < ch.demand && ch.capacity < dbu.capacity ? "cache" : "database") ?? state;
    return state;
  };
  // Plays to the end with a first setup, the ops the model needs, hiring support each day to keep up with the usual
  // tickets, moderators to keep up with the usual reports on a product with user content, and on servers renting
  // ahead of demand.
  // Without hireSupport, it keeps its starting support staff. onDay sees each day played.
  const runStaffed = (productType: string, model: string, hireSupport = true, onDay?: (state: GameState) => void) => {
    let state = setUp(sim180, sim180.newGame({ companyName: "Acme", productType, model, seed: 7 }));
    while (state.status === "playing") {
      state = rentAhead(state);
      const needed = hireSupport ? Math.ceil((sim180.usualTickets(state) * 1.2) / defaultConfig.support.ticketsPerPerson) : 0;
      const reports = sim180.moderation(state)?.usualReports ?? 0;
      const moderators = Math.ceil((reports * 1.2) / defaultConfig.moderation.reportsPerPerson);
      state = withStaff(state, {
        ops: Math.max(team(state, "ops"), sim180.opsNeededNow(state)),
        support: Math.max(team(state, "support"), needed),
        moderators: Math.max(team(state, "moderators"), moderators),
      });
      state = sim180.advance(state).state;
      onDay?.(state);
    }
    return state;
  };

  it("lets every product reach day 180 on IaaS renting ahead, down only for the provider and each wave's first day", () => {
    for (const p of ["ecommerce", "social", "video"]) {
      const state = runStaffed(p, "iaas");
      // A provider outage or a fire in its data centre is one an IaaS company can't staff its way out of. A traffic
      // spike or viral growth brings more demand than the VMs rented ahead, and the extra VMs are only ready the next
      // day (or not at all, short of the ops a spike needs), so the days it's on can be down too.
      const daysOn = (id: string) =>
        state.schedule.filter((e) => e.event === id).length * defaultConfig.events.find((e) => e.id === id)!.days;
      const unavoidable = ["providerOutage", "dataCentreFire", "trafficSpike", "viralGrowth"];
      // So can a holiday busier than the twice-demand it rents ahead for (Black Friday's 2.2x).
      const holidayDays = Array.from({ length: state.day }, (_, i) => i + 1).filter((day) =>
        sim180.calendar({ ...state, day }).on.some((h) => (h.effect?.loadMultiplier ?? 1) > 2),
      ).length;
      expect(state.outageDays).toBeLessThanOrEqual(unavoidable.reduce((sum, id) => sum + daysOn(id), 0) + holidayDays);
      expect(state.users).toBeGreaterThan(defaultConfig.productTypes[p as "social"].growth.launchUsersMin * 5);
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
        // A random event late on can leave customers unhappy at the end (a spike melts on-prem kit), but on average
        // over the game they're happy.
        const average = state.spendByDay.reduce((sum, d) => sum + d.satisfaction, 0) / state.spendByDay.length;
        expect(average).toBeGreaterThan(defaultConfig.support.goodSatisfaction);
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

  it("is happy at the start: one support person keeps up with every product's first tickets, one moderator its reports", () => {
    for (const p of PRODUCT_TYPE_IDS) {
      const begun = sim180.newGame({ companyName: "Acme", productType: p, model: "iaas", seed: 7 });
      const state = launched(sim180, sim180.moderation(begun) ? withStaff(begun, { moderators: 1 }) : begun);
      expect(sim180.usualTickets(state)).toBeLessThanOrEqual(sim180.dailyClearance(state));
      const moderation = sim180.moderation(state);
      if (moderation) expect(moderation.usualReports).toBeLessThanOrEqual(moderation.dailyClearance);
      expect(sim180.advance(state, 7).state).toMatchObject({ backlog: 0, satisfaction: 100 });
    }
  });

  it("liquidates a company that hires far more than it needs", () => {
    const start = sim180.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 7 });
    const state = sim180.advance(withStaff(start, { developers: 12, ops: 2 }), defaultConfig.finalDay - 1).state;
    expect(state.status).toBe("liquidated");
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

  it("lets a SaaS company that buys every add-on it can on day 1 reach day 180 with its starting developers", () => {
    const { addons, staff } = defaultConfig;
    expect(staff.developers.startingCount).toBeGreaterThanOrEqual(addons.minConfigDevelopers);
    for (const p of ["ecommerce", "social", "video"] as const) {
      // In Grow from day 1, so add-ons can be bought at once.
      let state = inPhase(sim180.newGame({ companyName: "Acme", productType: p, model: "saas", seed: 7 }), "grow");
      // Only tier 1's are unlocked on day 1.
      for (const f of defaultConfig.productTypes[p].features.filter((x) => (x.tier ?? 1) === 1)) {
        state = sim180.applyAction(state, { type: "buyAddon", feature: f.id });
      }
      const end = sim180.advance(state, defaultConfig.finalDay - 1).state;
      expect(end).toMatchObject({ day: defaultConfig.finalDay, status: "finished" });
      expect(end.spend.addons).toBeGreaterThan(0);
    }
  });

  it("makes on-prem's server room and first kit the dearest start by far, and only SaaS charge per user", () => {
    const s = createSim(smallestLaunch(withoutMvp));
    // Everything paid by the end of day 1 with a first setup: the model's upfront cost and, on-prem, the first kit.
    const upfront = (m: (typeof MODEL_IDS)[number]) =>
      defaultConfig.startingCash - setUp(s, s.newGame({ companyName: "Acme", productType: "social", model: m, seed: 1 })).cash;
    for (const m of ["iaas", "paas", "saas"] as const) expect(upfront("onprem")).toBeGreaterThan(upfront(m) * 2);
    expect(upfront("onprem")).toBeGreaterThan(s.upfrontCost("onprem"));
    expect(MODEL_IDS.filter((m) => defaultConfig.models[m].monthlyCostPerUser > 0)).toEqual(["saas"]);
  });
});

describe("migration", () => {
  const migrate = (model: string): Action => ({ type: "startMigration", model: model as never });
  const moveTo = (to: "developers" | "ops"): Action => ({ type: "moveStaff", to });
  // On IaaS with a developer and an ops person, migrating to PaaS from day 1, with cash for paying two providers.
  // In Grow, so features can be built and bought on the way.
  const migrating = () => sim.applyAction(withStaff(inPhase({ ...start(), cash: 100_000 }, "grow"), { developers: 1, ops: 1 }), migrate("paas"));
  const charges = (entries: LogEntry[]) => entries.filter((e) => e.category === "infrastructure").map((e) => e.text);

  it("starts in planning without moving time on, touching cash or staff", () => {
    const before = withStaff(start(), { developers: 1, ops: 1 });
    const state = sim.applyAction(before, migrate("paas"));
    expect(counted(state)).toMatchObject({ day: 1, cash: before.cash, model: "iaas", developers: 1, ops: 1, migrations: 0 });
    expect(sim.migration(state)).toEqual({
      from: "iaas",
      to: "paas",
      phase: "planning",
      phaseDaysLeft: 5,
      daysLeft: 14,
      totalDays: 14,
      overrunDays: 0,
      // Sized for 1,000 users' 10 CU and 10 DBU plus a quarter: one (free) massive instance and a medium database.
      setup: [
        { type: "app", size: "massive", name: "App instance", count: 1, units: 10_000, upfront: 0, monthly: 0, daysLeft: 0 },
        { type: "database", size: "medium", name: "Managed database", count: 1, units: 100, upfront: 0, monthly: 60, daysLeft: 0 },
      ],
      setupMonthly: 60,
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
      [
        15,
        "Your new PaaS setup takes over tomorrow: 1 app instance, 1 medium managed database. Fine-tune its sizes on Infrastructure as you grow.",
      ],
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
    expect(counted(state)).toMatchObject({ developers: 2, ops: 1 });
    // The migration carries on where it was.
    expect(sim.migration(state)).toMatchObject({ phase: "planning", daysLeft: 11 });
    const next = sim.advance(state).state;
    expect(next.features.checkout).toEqual({ status: "building", progress: 2 });
    expect(sim.migration(next)).toMatchObject({ daysLeft: 10 });
  });

  it("bills the current model until the migration completes, then only the new one", () => {
    const { log } = sim.advance(migrating(), 15);
    for (const day of log.slice(0, 14)) expect(charges(day.entries)).toContain("IaaS running costs (£600 a month)");
    expect(charges(log[14]!.entries)).toEqual(["PaaS running costs (£900 a month)", "Managed database (medium): 1 × £60 a month"]);
    expect(sim.monthlyInfrastructureCost(sim.advance(migrating(), 14).state)).toBe(960);
  });

  it("switches the stack, ops needed and capacity to the new model on completion", () => {
    // PaaS's starter instance is a massive app server too, so carries the same 3,000.
    const s = createSim(iaasCapacity(3000));
    const before = s.applyAction(withStaff(start(), { ops: 1 }), migrate("paas"));
    // IaaS needs 2 ops: with 1, capacity is 40% + 60% × ½ of 3,000.
    expect(s.capacity(before)).toBe(2100);
    expect(s.capacity(s.advance(before, 13).state)).toBe(2100);
    const done = s.advance(before, 14).state;
    expect(responsibilityStack(done.model)).toEqual(responsibilityStack("paas"));
    expect(s.opsNeeded(done.model)).toBe(1);
    // PaaS needs 1 ops, so the same team now runs it fully staffed.
    expect(s.capacity(done)).toBe(3000);
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
    const saasGame = inPhase(sim.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 42 }), "grow");
    const onSaas = withStaff(saasGame, { developers: 1 });
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

  it("bills both providers on every day of the migration, the new one and its new setup in full from day 1", () => {
    const { log } = sim.advance(sim.applyAction(rich(), migrate("paas")), 15);
    for (const day of log.slice(0, 14)) {
      expect(infra(day.entries)).toEqual([
        ["IaaS running costs (£600 a month)", -20],
        ["Double billing: PaaS running costs (£900 a month)", -30],
        ["Double billing: Managed database (medium): 1 × £60 a month", -2],
      ]);
    }
    // The day after you leave, only the new provider bills.
    expect(infra(log[14]!.entries)).toEqual([
      ["PaaS running costs (£900 a month)", -30],
      ["Managed database (medium): 1 × £60 a month", -2],
    ]);
  });

  it("charges the old provider pro rata up to the day you leave: 280 a month, leaving on 14 February, is 140", () => {
    // February has 28 days. Only the old provider costs anything: the new one is free and there are no staff.
    const feb = createSim({
      ...config,
      billing: { daysPerMonth: 28 },
      models: {
        ...config.models,
        iaas: { ...config.models.iaas, monthlyCost: 280 },
        paas: { ...config.models.paas, monthlyCost: 0, servers: { ...paasServers, monthlyCost: {} } },
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
      const doubleBilled = log.filter((d) => d.entries.some((e) => e.text.startsWith("Double billing")));
      expect(doubleBilled).toHaveLength(17);
      // IaaS's £20 a day, and PaaS's £30 and the new setup's £2, for 3 more days.
      expect(done.spend.infrastructure - state.spend.infrastructure).toBe(quote.total + 3 * (20 + 30 + 2));
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

    it("gives the duration, new setup, upfront cost, double billing, pro-rata charge, exit penalty and total", () => {
      expect(s.migrationQuote(start(), "paas")).toEqual({
        from: "iaas",
        to: "paas",
        days: 14,
        setup: [
          { type: "app", size: "massive", name: "App instance", count: 1, units: 10_000, upfront: 0, monthly: 0, daysLeft: 0 },
          { type: "database", size: "medium", name: "Managed database", count: 1, units: 100, upfront: 0, monthly: 60, daysLeft: 0 },
        ],
        // 1,000 users at 0.01 CU and DBU each, plus a quarter.
        sizedFor: { cu: 12.5, dbu: 12.5 },
        headroom: 0.25,
        setupUpfront: 0,
        racks: [],
        cabling: 0,
        setupMonthly: 60,
        opsNeeded: 1,
        deliveryDays: null,
        upfrontCost: 100,
        // 14 days of PaaS at £30 a day and its new database at £2, on top of IaaS.
        doubleBilling: 448,
        // 14 days of IaaS at £20 a day, up to the day you leave.
        proRata: 280,
        exitPenalty: 250,
        sellBack: 0,
        total: 1078,
        overrun: { chance: 0, minDays: 2, maxDays: 4 },
        lostAddons: [],
        lostBenefits: [],
        // £1,000 in the bank, so it says so.
        cashLeft: -78,
        warning: "You can't afford this: it costs £1,078 and you have £1,000.",
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
  const onSaas = () => withStaff({
    ...inPhase(sim.newGame({ companyName: "Acme", productType: "ecommerce", model: "saas", seed: 42 }), "grow"),
    cash: 100_000,
  }, { developers: 1 });
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
    const before = sim.applyAction(withStaff(inPhase({ ...start(), cash: 100_000 }, "grow"), { developers: 1 }), migrate("saas"));
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
    const state = withStaff(start(), { developers: 2, ops: 1 });
    expect(counted(sim.applyAction(state, moveTo("ops")))).toMatchObject({ developers: 1, ops: 2, day: 1, cash: state.cash });
    expect(counted(sim.applyAction(state, moveTo("developers")))).toMatchObject({ developers: 3, ops: 0 });
  });

  it("rejects a move from an empty pool, and unknown pools", () => {
    expect(() => sim.applyAction(start(), moveTo("ops"))).toThrow(expect.objectContaining({ code: "no_staff" }));
    expect(() => sim.applyAction(start(), { type: "moveStaff", to: "sales" as never })).toThrow(
      expect.objectContaining({ code: "unknown_pool" }),
    );
  });

  it("pays each person their new pool's day rate", () => {
    const { log } = sim.advance(sim.applyAction(withStaff(start(), { developers: 2 }), moveTo("ops")));
    expect(log[0]!.entries.filter((e) => e.category === "staff").map((e) => e.cashDelta)).toEqual([-7, -3]);
  });
});

describe("default migration config", () => {
  it("takes 2 weeks: 5 days planning, 2 testing and 7 moving", () => {
    const { phases } = defaultConfig.migration;
    expect([phases.planning.days, phases.testing.days, phases.moving.days]).toEqual([5, 2, 7]);
  });

  it("sizes the new setup with some headroom, and can overrun", () => {
    expect(defaultConfig.migration.setupHeadroom).toBeGreaterThan(0);
    expect(defaultConfig.migration.setupHeadroom).toBeLessThan(1);
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

describe("migration with servers", () => {
  // The servers, prices and social demand these sums were worked out with (round two's numbers before the balance
  // pass), pinned so that tuning the defaults doesn't change them. The default delivery time and migration rules, with
  // no events and no overrun unless a test says so, so a move's charges are exactly the quote's.
  const { onprem, iaas, paas, saas } = defaultConfig.models;
  const units = sizes(10, 15, 20, 25);
  const calm: GameConfig = {
    ...withoutMvp,
    startingCash: 10_000_000,
    models: {
      onprem: {
        ...onprem,
        upfrontCost: 30_000,
        monthlyCost: 1_500,
        servers: {
          ...onprem.servers!,
          purchase: {
            price: {
              app: sizes(1_200, 1_650, 2_100, 2_550),
              database: sizes(1_500, 2_100, 2_700, 3_300),
              cache: sizes(450, 600, 750, 900),
              loadBalancer: sizes(600, 900, 1_350, 1_800),
              api: sizes(1_200, 1_650, 2_100, 2_550),
            },
            sellBackShare: 0.4,
            cablingCost: 50,
          },
          monthlyCost: {
            app: sizes(40, 55, 70, 85),
            database: sizes(50, 70, 90, 110),
            cache: sizes(15, 20, 25, 30),
            loadBalancer: sizes(20, 30, 45, 60),
            api: sizes(40, 55, 70, 85),
          },
          opsPerServer: { app: 0.6, database: 0.6, cache: 0.3, loadBalancer: 0.3, api: 0.6 },
          starter: [
            { type: "app", size: "large", count: 1 },
            { type: "database", size: "large", count: 1 },
          ],
        },
      },
      iaas: {
        ...iaas,
        servers: {
          ...iaas.servers!,
          monthlyCost: {
            app: sizes(400, 550, 700, 850),
            database: sizes(500, 700, 900, 1_100),
            cache: sizes(150, 200, 250, 300),
            loadBalancer: sizes(200, 300, 450, 600),
            api: sizes(400, 550, 700, 850),
          },
          opsPerServer: { app: 0.5, database: 0.5, cache: 0.25, loadBalancer: 0.25, api: 0.5 },
          starter: [
            { type: "app", size: "medium", count: 1 },
            { type: "database", size: "medium", count: 1 },
          ],
        },
      },
      paas: {
        ...paas,
        servers: {
          ...paas.servers!,
          monthlyCost: {
            app: { medium: 800 },
            database: sizes(1_000, 1_800, 3_400, 6_400),
            cache: sizes(300, 550, 1_000, 1_900),
          },
          managed: { ...paas.servers!.managed!, units: { database: sizes(15, 30, 60, 120), cache: sizes(15, 30, 60, 120) } },
          starter: [
            { type: "app", size: "medium", count: 1 },
            { type: "database", size: "small", count: 1 },
          ],
        },
      },
      saas: { ...saas, monthlyCost: 1_500, monthlyCostPerUser: 0.5 },
    },
    productTypes: {
      ...defaultConfig.productTypes,
      social: { ...defaultConfig.productTypes.social, demand: { cuPerUser: 0.003, dbuPerUser: 0.004, perUserFeeMultiplier: 1 } },
    },
    servers: {
      ...defaultConfig.servers,
      types: Object.fromEntries(
        Object.entries(defaultConfig.servers.types).map(([t, type]) => [
          t,
          { ...type, units: t === "loadBalancer" ? type.units : units },
        ]),
      ) as GameConfig["servers"]["types"],
    },
    events: [],
    migration: { ...defaultConfig.migration, overrun: { ...defaultConfig.migration.overrun, chance: 0 } },
    // Each model's round-two starter setup above, in place and launched as the game starts.
    launch: { rampShares: [1], auto: 1 },
  };
  const s = createSim(calm);
  const migrate = (model: ModelId): Action => ({ type: "startMigration", model });
  /** A social network on a model with this many users, and ops enough for any setup here. */
  const on = (model: ModelId, users = 1_000, sim: Sim = s) => withStaff({
    ...sim.newGame({ companyName: "Acme", productType: "social", model, seed: 42 }),
    users,
    paidUsers: 0,
  }, { ops: 100 });
  const entries = (log: DayLog[]) => log.flatMap((d) => d.entries);
  const texts = (log: DayLog[]) => entries(log).map((e) => e.text);
  const total = (list: LogEntry[]) => list.reduce((sum, e) => sum - e.cashDelta, 0);
  /** Spend on running and buying kit: infrastructure, with cabling and power and cooling. */
  const kitSpend = (st: GameState) => st.spend.infrastructure + st.spend.cabling + st.spend.power;
  const pairs = MODEL_IDS.flatMap((from) => MODEL_IDS.filter((to) => to !== from).map((to) => [from, to] as const));

  describe("sizeSetupFor", () => {
    it("picks the cheapest single size of app server and database, with load balancers where needed", () => {
      // 60 CU and 80 DBU plus a quarter: 75 CU and 100 DBU. 3 massive VMs (£2,550) and a medium load balancer (£300)
      // beat 4 large ones and one (£3,100); 4 massive databases (£4,400) beat 5 large (£4,500).
      expect(s.sizeSetupFor("iaas", { cu: 60, dbu: 80 })).toEqual([
        { type: "app", size: "massive", count: 3 },
        { type: "loadBalancer", size: "medium", count: 1 },
        { type: "database", size: "massive", count: 4 },
      ]);
      // On-prem picks by purchase price, here the same sizes.
      expect(s.sizeSetupFor("onprem", { cu: 60, dbu: 80 })).toEqual([
        { type: "app", size: "massive", count: 3 },
        { type: "loadBalancer", size: "medium", count: 1 },
        { type: "database", size: "massive", count: 4 },
      ]);
    });

    it("needs no load balancer for one app server, and always has an app server and a database", () => {
      expect(s.sizeSetupFor("iaas", { cu: 8, dbu: 8 })).toEqual([
        { type: "app", size: "small", count: 1 },
        { type: "database", size: "small", count: 1 },
      ]);
      expect(s.sizeSetupFor("iaas", { cu: 0, dbu: 0 })).toEqual([
        { type: "app", size: "small", count: 1 },
        { type: "database", size: "small", count: 1 },
      ]);
    });

    it("on PaaS, runs enough instances and the smallest managed database, adding a cache past the biggest", () => {
      // 75 CU over 15-CU instances is 5; 100 DBU fits a massive (120) database.
      expect(s.sizeSetupFor("paas", { cu: 60, dbu: 80 })).toEqual([
        { type: "app", size: "medium", count: 5 },
        { type: "database", size: "massive", count: 1 },
      ]);
      expect(s.sizeSetupFor("paas", { cu: 1, dbu: 1 })).toEqual([
        { type: "app", size: "medium", count: 1 },
        { type: "database", size: "small", count: 1 },
      ]);
      // 200 DBU: 80 more than the massive database, taken by a massive (120 CH) cache. 50 instances is past the most.
      expect(s.sizeSetupFor("paas", { cu: 600, dbu: 160 })).toEqual([
        { type: "app", size: "medium", count: 20 },
        { type: "database", size: "massive", count: 1 },
        { type: "cache", size: "massive", count: 1 },
      ]);
    });

    it("builds nothing on SaaS", () => {
      expect(s.sizeSetupFor("saas", { cu: 60, dbu: 80 })).toEqual([]);
    });

    it("takes the headroom from config", () => {
      const tight = createSim({ ...calm, migration: { ...calm.migration, setupHeadroom: 0 } });
      // 15 CU exactly fits one medium instance with no headroom; a quarter more needs two.
      expect(tight.sizeSetupFor("paas", { cu: 15, dbu: 15 })[0]).toMatchObject({ count: 1 });
      expect(s.sizeSetupFor("paas", { cu: 15, dbu: 15 })[0]).toMatchObject({ count: 2 });
    });
  });

  it("builds a target setup that meets today's demand plus headroom on every model, once it takes over", () => {
    for (const [from, to] of pairs) {
      for (const users of [1_000, 20_000, 40_000]) {
        const state = on(from, users);
        const quote = s.migrationQuote(state, to);
        const done = s.advance(s.applyAction(state, migrate(to)), 14).state;
        expect(done.model).toBe(to);
        const units = s.units(done);
        if (to === "saas") {
          expect([units, s.capacity(done), done.servers]).toEqual([null, null, []]);
          continue;
        }
        expect(units!.cu.capacity).toBeGreaterThanOrEqual(quote.sizedFor.cu);
        // The database with any cache covers the DBU: the users it all serves include today's plus the headroom.
        expect(units!.usersSupported).toBeGreaterThanOrEqual(Math.floor(users * (1 + calm.migration.setupHeadroom)));
        expect(units!.loadBalancer.uncovered).toBe(0);
        expect(done.servers.every((srv) => srv.readyDay < done.day + 1)).toBe(true);
      }
    }
  });

  it("itemises the setup in the quote: type, size, count and cost, upfront for bought kit, monthly for rented", () => {
    const onprem = s.migrationQuote(on("iaas", 20_000), "onprem");
    // 20,000 users need 60 CU and 80 DBU; plus a quarter, 75 and 100.
    expect(onprem.sizedFor).toEqual({ cu: 75, dbu: 100 });
    expect(onprem.setup.map((i) => [i.name, i.size, i.count, i.upfront, i.monthly, i.daysLeft])).toEqual([
      ["App server", "massive", 3, 3 * 2_550, 3 * 85, 4],
      ["Database", "massive", 4, 4 * 3_300, 4 * 110, 4],
      ["Load balancer", "medium", 1, 900, 30, 4],
    ]);
    // 3 app servers and 4 databases at 0.6 ops each, and a load balancer at 0.3: 4.5, so 5.
    expect(onprem).toMatchObject({ setupUpfront: 21_750, setupMonthly: 725, deliveryDays: 4, opsNeeded: 5 });
    // 58U of kit: the server room's medium rack takes the 3 app servers (24U), and a large one (42U) the rest. Cabling
    // for 8 servers and 2 racks at £50.
    expect(onprem.racks).toEqual([
      { size: "medium", count: 1, upfront: 500 },
      { size: "large", count: 1, upfront: 800 },
    ]);
    expect(onprem.cabling).toBe(500);
    // The server room, the kit, its racks and cabling, on the first day.
    expect(onprem.upfrontCost).toBe(calm.models.onprem.upfrontCost + 21_750 + 1_300 + 500);

    const paas = s.migrationQuote(on("iaas", 20_000), "paas");
    expect(paas.setup.map((i) => [i.name, i.size, i.count, i.upfront, i.monthly])).toEqual([
      ["App instance", "medium", 5, 0, 5 * 800],
      ["Managed database", "massive", 1, 0, 6_400],
    ]);
    expect(paas).toMatchObject({ setupUpfront: 0, setupMonthly: 10_400, deliveryDays: null });
    expect(s.migrationQuote(on("iaas", 20_000), "saas")).toMatchObject({ setup: [], setupUpfront: 0, setupMonthly: 0 });
  });

  it("with no overrun, charges exactly the quote: setup, double billing, pro rata, exit penalty and sell-back", () => {
    // Not SaaS's per-user fees, which follow the users.
    for (const [from, to] of pairs.filter((p) => !p.includes("saas"))) {
      const state = on(from, 20_000);
      const quote = s.migrationQuote(state, to);
      const { state: done, log } = s.advance(s.applyAction(state, migrate(to)), 14);
      expect(done.model).toBe(to);
      expect(kitSpend(done) - kitSpend(state)).toBe(quote.total);
      // Item by item: the kit bought with its racks and cabling, and the new model's bill (its setup included) on every
      // day of the move.
      expect(total(entries(log).filter((e) => e.text.startsWith("New setup")))).toBe(quote.upfrontCost - calm.models[to].upfrontCost);
      expect(total(entries(log).filter((e) => e.text.startsWith("Double billing")))).toBe(quote.doubleBilling);
      expect(entries(log).filter((e) => e.text.startsWith("Exit penalty")).map((e) => -e.cashDelta)).toEqual(
        quote.exitPenalty > 0 ? [quote.exitPenalty] : [],
      );
    }
  });

  it("bills both setups during the move: the old servers, and the new ones from day 1 (bought kit once it arrives)", () => {
    const { log } = s.advance(s.applyAction(on("iaas", 20_000), migrate("onprem")), 14);
    for (const day of log) {
      const t = day.entries.map((e) => e.text);
      // The old VMs, every day up to and including the day you leave.
      expect(t.filter((x) => x.includes(") rent: "))).toHaveLength(2);
      expect(t).toContain("Double billing: Own servers (on-prem) running costs (£1,500 a month)");
    }
    // Ordered on day 1 and arriving 4 days later, the kit's power and upkeep is billed from the day after.
    const upkeepDays = log.filter((d) => d.entries.some((e) => e.text.includes("power and upkeep"))).map((d) => d.day);
    expect(upkeepDays).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(texts(log.slice(0, 1))).toContain("New setup: bought 3 massive app servers at £2,550 each");

    const paas = s.advance(s.applyAction(on("iaas", 20_000), migrate("paas")), 1).log;
    expect(texts(paas)).toEqual(
      expect.arrayContaining([
        "App server (medium) rent: 1 × £550 a month",
        "Double billing: App instance (medium): 5 × £800 a month",
        "Double billing: Managed database (massive): 1 × £6,400 a month",
      ]),
    );
  });

  it("shows the old setup and the new one side by side during the move, the new kit counting down to delivery", () => {
    const moving = s.applyAction(on("iaas", 20_000), migrate("onprem"));
    // The old setup is still the company's, and serves.
    expect(s.servers(moving).map((srv) => [srv.type, srv.size])).toEqual([
      ["app", "medium"],
      ["database", "medium"],
    ]);
    expect(s.migration(moving)!.setup.map((i) => [i.type, i.count, i.daysLeft])).toEqual([
      ["app", 3, 4],
      ["database", 4, 4],
      ["loadBalancer", 1, 4],
    ]);
    expect(s.migration(moving)!.setupMonthly).toBe(725);
    const later = s.advance(moving, 10).state;
    expect(s.migration(later)!.setup.every((i) => i.daysLeft === 0)).toBe(true);
    // The kit has arrived but doesn't serve until the switch: capacity is still the old VMs'.
    expect(s.units(later)!.cu.capacity).toBe(s.units(moving)!.cu.capacity);
  });

  it("delivers bought kit inside the move, and an overrun only adds days billed by both", () => {
    expect(calm.models.onprem.servers!.readyDays!).toBeLessThan(
      Object.values(calm.migration.phases).reduce((sum, p) => sum + p.days, 0),
    );
    const slips = createSim({ ...calm, migration: { ...calm.migration, overrun: { chance: 1, minDays: 3, maxDays: 3 } } });
    const state = on("iaas", 20_000, slips);
    const quote = slips.migrationQuote(state, "onprem");
    const { state: done, log } = slips.advance(slips.applyAction(state, migrate("onprem")), 17);
    expect(done.model).toBe("onprem");
    expect(slips.servers(done).every((srv) => srv.status === "ready")).toBe(true);
    // 3 more days of IaaS with its VMs, and of on-prem with its arrived kit.
    const extra = log.slice(14).reduce((sum, d) => sum + total(d.entries.filter((e) => e.category && e.category !== "staff")), 0);
    expect(kitSpend(done) - kitSpend(state)).toBe(quote.total + extra - total(log[16]!.entries.filter((e) => e.text.startsWith("Exit penalty"))));
    expect(extra).toBeGreaterThan(0);
  });

  it("on completion, sells old kit back at the configured loss, kit on order included", () => {
    const state = on("onprem", 20_000);
    const quote = s.migrationQuote(state, "iaas");
    // The starter kit: a large app server (£2,100) and database (£2,700), and its medium rack (£500). 40% back is £2,120.
    expect(quote.sellBack).toBe(2_120);
    let moving = s.advance(s.applyAction(state, migrate("iaas")), 10).state;
    moving = s.applyAction(moving, { type: "buyServer", server: "cache", size: "small" });
    const { state: done, log } = s.advance(moving, 4);
    expect(log.at(-1)!.entries).toContainEqual({
      text: "Your 3 servers and 1 rack were sold back for £2,300: 40% of the £5,750 you paid.",
      cashDelta: 2_300,
      category: "infrastructure",
    });
    expect(done.servers.every((srv) => srv.paid === undefined)).toBe(true);
  });

  it("on completion, cancels old rentals pro rata: billed up to the day you leave, and none after", () => {
    const state = on("paas", 20_000);
    const { state: done, log } = s.advance(s.applyAction(state, migrate("iaas")), 16);
    const instanceDays = (days: DayLog[]) =>
      days.filter((d) => d.entries.some((e) => e.text.startsWith("App instance"))).map((d) => d.day);
    expect(instanceDays(log)).toEqual(Array.from({ length: 14 }, (_, i) => i + 2));
    expect(texts(log.slice(13, 14))).toContain(
      "Your app instances and managed services were cancelled: you paid for them only for the days you had them.",
    );
    // The new VMs are the company's now, numbered after the old servers.
    expect(Math.min(...done.servers.map((srv) => srv.id))).toBeGreaterThanOrEqual(state.nextServerId);
    expect(texts(log.slice(13, 14)).find((t) => t.startsWith("Your new "))).toBe(
      "Your new Rent VMs (IaaS) setup takes over tomorrow: 3 massive app servers, 4 massive databases, 1 medium load balancer. Fine-tune its sizes on Infrastructure as you grow.",
    );
  });

  it("drops every server moving to SaaS: VMs cancelled, kit sold back", () => {
    for (const from of ["onprem", "iaas", "paas"] as const) {
      const state = on(from, 20_000);
      expect(s.migrationQuote(state, "saas").setup).toEqual([]);
      const { state: done } = s.advance(s.applyAction(state, migrate("saas")), 14);
      expect(done).toMatchObject({ model: "saas", servers: [] });
      expect(s.units(done)).toBeNull();
    }
  });

  it("lets the student fine-tune the new setup once it has taken over", () => {
    const onPaas = s.advance(s.applyAction(on("iaas", 20_000), migrate("paas")), 14).state;
    expect(s.managed(s.applyAction(onPaas, { type: "setInstances", count: 7 }))!.instances).toBe(7);
    const onIaas = s.advance(s.applyAction(on("paas", 20_000), migrate("iaas")), 14).state;
    const id = onIaas.servers.find((srv) => srv.type === "database")!.id;
    expect(s.applyAction(onIaas, { type: "cancelServer", id }).servers).toHaveLength(onIaas.servers.length - 1);
    // Mid-move the new setup isn't the company's yet, so it can't be changed.
    const moving = s.applyAction(on("paas", 20_000), migrate("iaas"));
    expect(() => s.applyAction(moving, { type: "cancelServer", id: moving.migration!.servers[0]!.id })).toThrow(
      expect.objectContaining({ code: "managed" }),
    );
  });

  it("keeps the existing rules: lost add-ons, exit penalty and staff free to move", () => {
    const saas = withStaff(inPhase(on("saas", 1_000), "grow"), { developers: 3 });
    const bought = s.applyAction(saas, { type: "buyAddon", feature: calm.productTypes.social.features.find((f) => (f.tier ?? 1) === 1)!.id });
    const quote = s.migrationQuote(bought, "iaas");
    expect(quote.lostAddons).toHaveLength(1);
    expect(quote.setup.length).toBeGreaterThan(0);
    expect(quote.exitPenalty).toBe(calm.models.saas.exitPenalty);
    const moving = s.applyAction(bought, migrate("iaas"));
    const moved = s.applyAction(moving, { type: "moveStaff", to: "ops" });
    expect(counted(moved)).toMatchObject({ developers: 2, ops: 100 });
    expect(moved.hiring).toMatchObject([{ pool: "ops", retraining: true }]);
  });

  it("is deterministic, and resumes identically after a JSON round trip", () => {
    const run = () => s.advance(s.applyAction(on("iaas", 20_000), migrate("onprem")), 16);
    expect(run()).toEqual(run());
    const half = s.advance(s.applyAction(on("iaas", 20_000), migrate("onprem")), 6).state;
    expect(s.advance(JSON.parse(JSON.stringify(half)) as GameState, 10).state).toEqual(run().state);
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
      paas: { scaleCostPerUnit: 0.005, detail: "The platform scaled." },
      saas: { detail: "The provider absorbed it." },
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
  const begin = (s: Sim, model: string, ops = 0, seed = 42) => withStaff(s.newGame({ companyName: "Acme", productType: "social", model, seed }), { ops });
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

    it("is deterministic for the same seed and config", () => {
      const s = withEvents(patch, spike);
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

    it("scales PaaS from its first day: it stays up but is charged per unit over its setup, in infrastructure", () => {
      const { state, log } = play(s, "paas", 5, 1);
      const without = play(quiet, "paas", 5, 1).state;
      expect(state.outageDays).toBe(0);
      const burst = charges(log, "Traffic spike: the platform scaled up");
      expect(burst.map((e) => log.find((d) => d.entries.includes(e))!.day)).toEqual([3, 4]);
      expect(burst[0]!.text).toMatch(/^Traffic spike: the platform scaled up for [\d,]+ CU and [\d,]+ DBU over your setup$/);
      // About 20,000 CU and 20,000 DBU of demand against 10,000 of each: 20,000 units over a day, at half a penny.
      for (const e of burst) expect(-e.cashDelta).toBeGreaterThan(60);
      for (const e of burst) expect(-e.cashDelta).toBeLessThan(150);
      const cost = -burst.reduce((sum, e) => sum + e.cashDelta, 0);
      expect(state.spend.infrastructure).toBe(without.spend.infrastructure + cost);
      expect(state.cash).toBe(without.cash - cost);
    });

    it("scales PaaS with no ops beyond its fixed few: the platform does it, not your team", () => {
      // Short of PaaS's 1 ops, capacity is cut, but the platform still scales: no outage.
      const { state } = play(s, "paas", 5, 0);
      expect(state.outageDays).toBe(0);
      expect(s.events(play(s, "paas", 2, 0).state)[0]).toMatchObject({ shortOfOps: false });
    });

    it("shows PaaS's units with the burst on a day it scaled, then back to its setup", () => {
      const scaled = play(s, "paas", 2, 1).state;
      expect(s.units(scaled)).toMatchObject({ burst: true });
      expect(s.units(scaled)!.cu.capacity).toBe(s.units(scaled)!.cu.demand);
      expect(s.capacity(scaled)).toBe(scaled.load);
      expect(s.units(play(s, "paas", 4, 1).state)).toMatchObject({ burst: false, cu: { capacity: 10_000 } });
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
      expect(outage.text).toMatch(/^Compute \(CU\) hit \d+% of capacity\./);
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
          "OS security patch. Down 6 hours; growth slowed.",
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
        featureGap: { growthMultiplier: 0.5, features: { ecommerce: "Own couriers", social: "Custom feeds", video: "Own player", payments: "Own bank", assistant: "Own model", games: "Own matchmaking" } },
        detail: "Not yours to change.",
      },
    },
  };
  const withEvents = (...events: EventConfig[]) => createSim({ ...config, events });
  const quiet = withEvents();
  const begin = (s: Sim, model: string, seed = 42) => withStaff(s.newGame({ companyName: "Acme", productType: "social", model, seed }), { ops: s.opsNeeded(model as (typeof MODEL_IDS)[number]) });
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
      let state = withStaff(inPhase(begin(s, "saas"), "grow"), { developers: 1 });
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
      const state = s2.applyAction(withStaff(inPhase(begin(s2, "saas"), "grow"), { developers: 1 }), { type: "buyAddon", feature: "checkout" });
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
          "Provider outage. Down 5 hours; growth slowed.",
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
    const random = (e: EventConfig) => ({ ...e, schedule: undefined, encounter: { chance: 0.7 } });
    const s = withEvents(random(priceRise), random(outage), random(gap));
    for (const model of MODEL_IDS) expect(play(s, model, 90)).toEqual(play(s, model, 90));
  });
});

describe("encounters", () => {
  // A patch that needs 1 ops on IaaS and does nothing much, and an outage the provider deals with.
  const patch: EventConfig = {
    id: "patch",
    name: "OS security patch",
    description: "A hole in the OS.",
    layer: "os",
    encounter: { chance: 1 },
    days: 1,
    effects: {
      onprem: { opsNeeded: 2, detail: "Patched." },
      iaas: { opsNeeded: 1, detail: "Patched." },
      paas: { detail: "The provider patched it." },
      saas: { detail: "The provider patched it." },
    },
  };
  const down = { downtimeHours: 2, detail: "You waited for the provider." };
  const outage: EventConfig = {
    id: "outage",
    name: "Provider outage",
    description: "The provider went down.",
    layer: "facilities",
    encounter: { chance: 1 },
    days: 1,
    effects: { onprem: { detail: "Your own building." }, iaas: down, paas: down, saas: down },
  };
  const withEncounters = (encounters: Partial<GameConfig["encounters"]>, ...events: EventConfig[]) =>
    createSim({ ...config, encounters: { ...config.encounters, ...encounters }, events });
  const begin = (s: Sim, model: string, seed = 42, ops?: number) => {
    const state = s.newGame({ companyName: "Acme", productType: "social", model, seed });
    return withStaff(state, { ops: ops ?? s.opsNeededNow(state) });
  };
  const eventDays = (log: DayLog[]) => log.filter((d) => d.entries.some((e) => e.kind === "event")).map((d) => d.day);
  const gaps = (days: number[]) => days.slice(1).map((d, i) => d - days[i]!);

  it("starts each game with the meter at 0 and an encounter list rolled from the seed", () => {
    const s = withEncounters({}, patch, outage);
    const state = begin(s, "paas");
    expect(state.dangerMeter).toBe(0);
    expect(state.encounterList.map((e) => e.event).sort()).toEqual(["outage", "patch"]);
    for (const { threshold } of state.encounterList) {
      expect(threshold).toBeGreaterThanOrEqual(24);
      expect(threshold).toBeLessThanOrEqual(64);
    }
    expect(begin(s, "paas").encounterList).toEqual(state.encounterList);
    expect(s.danger(state)).toEqual({ meter: 0, max: 64, rise: 0, dailyRise: 1, risks: [], warning: null });
  });

  it("creeps on a well-run day and rises faster with risky play: unpatched servers, overload, low satisfaction", () => {
    const s = withEncounters({ thresholdMin: 300, thresholdMax: 300 }, patch);
    const meterAfter = (state: GameState, days: number) => s.advance(state, days).state.dangerMeter;
    // Launched on day 1, so the meter rises from day 2: 10 well-run days add 10.
    const careful = begin(s, "iaas");
    expect(meterAfter(careful, 10)).toBe(10);
    // Fewer ops than the IaaS setup needs: patches fall behind, so it rises half as fast again.
    const unpatched = begin(s, "iaas", 42, 0);
    expect(meterAfter(unpatched, 10)).toBe(15);
    expect(s.danger(s.advance(unpatched, 1).state)).toMatchObject({
      meter: 1.5,
      rise: 1.5,
      risks: [{ id: "unpatched", label: "Servers going unpatched", rise: 0.5 }],
    });
    // On PaaS the provider patches, so having no ops isn't that risk there.
    expect(meterAfter(begin(s, "paas", 42, 0), 10)).toBe(10);
    // Overloaded: on-prem kit that can't carry the load.
    const cramped = createSim({ ...config, models: { ...config.models, onprem: { ...config.models.onprem, capacity: 1 } }, events: [patch] });
    const overloaded = cramped.advance(begin(cramped, "onprem"), 1).state;
    expect(cramped.danger(overloaded).risks.map((r) => r.id)).toEqual(["overloaded"]);
    // Unhappy customers.
    const unhappy = { ...careful, satisfaction: 10 };
    expect(s.danger(s.advance(unhappy, 1).state).risks.map((r) => r.id)).toContain("lowSatisfaction");
  });

  it("counts ops still waiting to start after hiring as not patching yet", () => {
    const s = createSim({
      ...config,
      staffGrades: { ...config.staffGrades, mid: { ...config.staffGrades.mid, leadDays: 3 } },
      encounters: { ...config.encounters, thresholdMin: 300, thresholdMax: 300 },
      events: [patch],
    });
    const hired = s.applyAction(begin(s, "iaas", 42, 0), { type: "hire", pool: "ops", count: 2 });
    const risks = (days: number) => s.danger(s.advance(hired, days).state).risks.map((r) => r.id);
    // Hired on day 1, they start on day 4: until then the servers go unpatched.
    expect(risks(2)).toEqual(["unpatched"]);
    expect(risks(3)).toEqual([]);
  });

  it("doesn't rise before launch, when nothing is running", () => {
    const s = settlingPay(createSim({ ...roomyDefaults, events: [patch] }));
    const state = s.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 42 });
    // No servers rented, so no launch: the meter stays at 0.
    expect(s.advance(state, 5).state.dangerMeter).toBe(0);
  });

  it("fires the next event when the meter reaches its threshold, then resets the meter and rolls a new list", () => {
    const s = withEncounters({ thresholdMin: 5, thresholdMax: 5 }, patch);
    const start = begin(s, "paas");
    expect(start.encounterList).toEqual([{ event: "patch", threshold: 5 }]);
    // The meter reaches 5 at the end of day 6, so the patch fires on day 7, and every 5 days after.
    const { state, log } = s.advance(start, 16);
    expect(eventDays(log)).toEqual([7, 12, 17]);
    expect(state.schedule.map((e) => e.day)).toEqual([7, 12, 17]);
    const fired = s.advance(start, 6).state;
    expect(fired.dangerMeter).toBe(1);
    expect(s.events(fired).map((e) => e.id)).toEqual(["patch"]);
    expect(fired.encounterList).toEqual([{ event: "patch", threshold: 5 }]);
  });

  it("warns of an event with a warning about its days ahead, once, and pauses time for it", () => {
    const warned: EventConfig = { ...patch, warning: { days: 7, text: "Patch coming." } };
    const s = withEncounters({ thresholdMin: 20, thresholdMax: 20 }, warned);
    const start = begin(s, "paas");
    // The meter is 13 at the end of day 14: seven well-run days from 20, so the warning comes that day. It fires on 22.
    const { log } = s.advance(start, 22);
    const warnings = log.filter((d) => d.entries.some((e) => e.kind === "danger" && e.text === "Warning: Patch coming."));
    expect(warnings.map((d) => d.day)).toEqual([14]);
    expect(eventDays(log)).toEqual([22]);
    // The game starts on day 1, so advancing 13 days plays to the end of day 14.
    expect(s.danger(s.advance(start, 12).state).warning).toBeNull();
    expect(s.danger(s.advance(start, 13).state).warning).toEqual({ event: "patch", name: "OS security patch", text: "Patch coming." });
    expect(s.danger(s.advance(start, 20).state).warning).not.toBeNull();
    // Once it fires the new list starts from 0, out of the warning's reach.
    expect(s.danger(s.advance(start, 21).state).warning).toBeNull();
    const paused = s.tick(s.advance(start, 12).state);
    expect(paused.pauses).toContainEqual({ kind: "alert", id: "warning-patch", text: "Warning: OS security patch may be coming" });
    expect(s.tick(s.advance(start, 13).state).pauses.some((p) => p.id === "warning-patch")).toBe(false);
    // Without a warning, the same event is a surprise.
    const quiet = withEncounters({ thresholdMin: 20, thresholdMax: 20 }, patch);
    expect(quiet.advance(quiet.newGame({ companyName: "Acme", productType: "social", model: "paas", seed: 42 }), 22).log.some((d) => d.entries.some((e) => e.text.startsWith("Warning:")))).toBe(false);
  });

  it("warns of a traffic spike a week ahead, by default", () => {
    const spike = defaultConfig.events.find((e) => e.id === "trafficSpike")!;
    expect(spike.warning?.days).toBe(7);
    // On-prem kit arrives in fewer days than the warning gives.
    expect(spike.warning!.days).toBeGreaterThan(defaultConfig.models.onprem.servers!.readyDays!);
  });

  it("fires the lowest threshold first, then rolls a new list", () => {
    const s = withEncounters({}, patch, outage);
    const state = begin(s, "paas");
    const [first, second] = state.encounterList;
    expect(first!.threshold).toBeLessThanOrEqual(second!.threshold);
    // The meter reaches the first threshold at the end of day threshold + 1: it fires the day after.
    const { log, state: after } = s.advance(state, first!.threshold + 1);
    expect(eventDays(log)).toEqual([first!.threshold + 2]);
    expect(after.schedule).toEqual([{ event: first!.event, day: first!.threshold + 2 }]);
    expect(after.dangerMeter).toBe(1);
    expect(after.encounterList).not.toEqual(state.encounterList);
  });

  it("lets the situation set the odds: an event that needs a risk goes on the list after a day with it", () => {
    const breach: EventConfig = { ...outage, id: "breach", name: "Breach", encounter: { chance: 0.02, risks: { unpatched: 50 } } };
    const s = withEncounters({ thresholdMin: 5, thresholdMax: 5 }, patch, breach);
    // The first list is rolled with no risks; the one on day 7, after a day with or without one.
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const breaches = (ops?: number) =>
      seeds.filter((seed) => s.advance(begin(s, "iaas", seed, ops), 6).state.encounterList.some((e) => e.event === "breach")).length;
    expect(breaches(0)).toBe(seeds.length);
    expect(breaches()).toBeLessThan(2);
  });

  it("stops an event going on the list once it has fired its most, and before its earliest day", () => {
    const once = withEncounters({ thresholdMin: 5, thresholdMax: 5 }, { ...outage, encounter: { chance: 1, maxTimes: 1 } });
    expect(eventDays(once.advance(begin(once, "paas"), 40).log)).toEqual([7]);
    const late = withEncounters({ thresholdMin: 5, thresholdMax: 5 }, { ...outage, encounter: { chance: 1, fromDay: 10 } });
    // Not on the first list, nor the one rolled when the meter tops out on day 7: the one rolled on day 12 has it.
    expect(begin(late, "paas").encounterList).toEqual([]);
    expect(eventDays(late.advance(begin(late, "paas"), 30).log)[0]).toBe(17);
  });

  it("only lists an event that follows another once that one has fired since it last did", () => {
    const breach: EventConfig = { ...outage, id: "breach", name: "Breach" };
    const lawsuit: EventConfig = { ...outage, id: "lawsuit", name: "Lawsuit", encounter: { chance: 1, follows: ["breach"] } };
    // Both always come up, at the same threshold: on a tie the lawsuit, first in config, fires first.
    const s = withEncounters({ thresholdMin: 5, thresholdMax: 5 }, lawsuit, breach);
    const start = begin(s, "paas");
    expect(start.encounterList.map((e) => e.event)).toEqual(["breach"]);
    // A breach every time the lawsuit has nothing new to follow, so they take turns.
    const { state } = s.advance(start, 30);
    expect(state.schedule.map((e) => e.event).slice(0, 5)).toEqual(["breach", "lawsuit", "breach", "lawsuit", "breach"]);
    // Only soon after: the meter takes at least 2 days to reach a threshold of 5, too late for a 1-day window.
    const soon = withEncounters({ thresholdMin: 5, thresholdMax: 5 }, { ...lawsuit, encounter: { chance: 1, follows: ["breach"], followsWithinDays: 1 } }, breach);
    const late = soon.advance(begin(soon, "paas"), 30).state;
    expect(late.schedule.map((e) => e.event)).not.toContain("lawsuit");
  });

  it("leaves the meter to top out on an empty list, then resets it quietly with a new roll", () => {
    const s = withEncounters({ thresholdMin: 5, thresholdMax: 8 }, { ...patch, encounter: { chance: 0 } });
    const start = begin(s, "paas");
    expect(start.encounterList).toEqual([]);
    // 8 by the end of day 9, reset on day 10 with nothing firing.
    expect(s.advance(start, 8).state.dangerMeter).toBe(8);
    const { state, log } = s.advance(start, 9);
    expect(state.dangerMeter).toBe(1);
    expect(eventDays(log)).toEqual([]);
    expect(log.at(-1)!.entries[0]).toEqual({
      text: "Danger meter: it reached the top and nothing went wrong this time. It starts again from 0.",
      cashDelta: 0,
      kind: "danger",
    });
    expect(log.slice(0, -1).flatMap((d) => d.entries).filter((e) => e.kind === "danger")).toEqual([]);
  });

  it("only lists events that hit the company's model, and drops one that no longer does", () => {
    const saasOnly: EventConfig = { ...outage, id: "saasOnly", effects: { saas: down } };
    const s = withEncounters({}, saasOnly);
    const state = begin(s, "saas");
    expect(state.encounterList.map((e) => e.event)).toEqual(["saasOnly"]);
    expect(begin(s, "paas").encounterList).toEqual([]);
    // Moved onto PaaS with it still on the list, it never fires.
    const moved = withStaff({ ...state, model: "paas" as const }, { ops: 1 });
    expect(eventDays(s.advance(moved, 70).log)).toEqual([]);
  });

  // Default games on PaaS with a first setup that's never grown: they get overloaded as users grow.
  const defaults = settlingPay(createSim(roomyDefaults));
  const defaultGame = (seed: number) => {
    const state = setUp(defaults, defaults.newGame({ companyName: "Acme", productType: "social", model: "paas", seed }));
    return defaults.advance(withStaff(state, { ops: 1 }), 179).state.schedule;
  };

  it("gives every game a different number and mix of events, the same for the same seed", () => {
    const games = Array.from({ length: 12 }, (_, i) => defaultGame(i + 1).map((e) => e.event));
    expect(new Set(games.map((g) => g.length)).size).toBeGreaterThan(1);
    expect(new Set(games.map((g) => [...g].sort().join())).size).toBeGreaterThan(6);
    expect(defaultGame(3).map((e) => e.event)).toEqual(games[2]);
  });

  it("keeps random events rarely closer than about 14 days apart, and never on well-run days", () => {
    // The default events and meter, with the events made harmless so they leave no risk behind.
    const harmless = defaultConfig.events.map((e) => ({
      ...e,
      load: undefined,
      effects: Object.fromEntries(Object.keys(e.effects).map((m) => [m, { detail: "Nothing happened." }])),
    }));
    const s = createSim({ ...config, startingCash: 1_000_000, encounters: defaultConfig.encounters, events: harmless });
    // 150 days: after that the test config's users outgrow its servers.
    const allGaps = (ops?: number) =>
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap((seed) =>
        gaps(s.advance(begin(s, "iaas", seed, ops), 149).state.schedule.map((e) => e.day)),
      );
    // Well run, the meter creeps 1 a day from the day an event fires, so the next is at least 20 days later.
    const careful = allGaps();
    expect(careful.length).toBeGreaterThan(20);
    expect(Math.min(...careful)).toBeGreaterThanOrEqual(defaultConfig.encounters.thresholdMin);
    // Short of ops all game, so patches are always behind, and here customers end up unhappy too: events come
    // faster, but even with every risk at once the meter takes 8 days to reach the lowest threshold.
    const risky = allGaps(0);
    expect(risky.length).toBeGreaterThan(careful.length);
    expect(Math.min(...risky)).toBeGreaterThanOrEqual(8);
    // Real default games that outgrow their setup and leave customers unhappy: rarely within 14 days. Some events
    // leave a risk behind that brings the next sooner (a viral wave overloads the servers, a fire's outage upsets
    // customers), so a few do.
    const real = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((seed) => gaps(defaultGame(seed).map((e) => e.day)));
    expect(real.filter((g) => g < 14).length / real.length).toBeLessThan(0.15);
  });

  it("carries on the same from a saved game", () => {
    const s = withEncounters({}, patch, outage);
    const run = () => s.advance(begin(s, "iaas", 7, 0), 120);
    const half = s.advance(begin(s, "iaas", 7, 0), 50).state;
    expect(s.advance(JSON.parse(JSON.stringify(half)) as GameState, 70).state).toEqual(run().state);
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

  it("are all random events on the encounter list, with no fixed days", () => {
    for (const e of defaultConfig.events) {
      expect(e.schedule).toBeUndefined();
      expect(e.encounter!.chance).toBeGreaterThan(0);
    }
    expect(event("osPatch").encounter!.risks!.unpatched).toBeGreaterThan(1);
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
    const s = settlingPay(createSim(roomyDefaults));
    const state = s.advance(s.newGame({ companyName: "Acme", productType: "video", model: "saas", seed: 7 }), 179).state;
    expect(state).toMatchObject({ day: 180, status: "finished" });
    expect(s.featureGaps(state)).toHaveLength(1);
  });

  it("melt on-prem in a spike, but scale PaaS", () => {
    // By day 30 a social network has grown into its first kit enough that tripled demand is too much for it. PaaS
    // runs plenty of instances and the biggest database, so only the spike could take it over. One ops person runs
    // either.
    const s = settlingPay(createSim({ ...roomyDefaults, events: [{ ...event("trafficSpike"), encounter: undefined, schedule: { type: "fixed", days: [30] } }] }));
    const run = (model: (typeof MODEL_IDS)[number]) => {
      let start = setUp(s, s.newGame({ companyName: "Acme", productType: "social", model, seed: 7 }));
      if (model === "paas") {
        start = s.applyAction(start, { type: "setInstances", count: 10 });
        start = s.applyAction(start, { type: "setManagedService", service: "database", size: "massive" });
      }
      return s.advance(withStaff(start, { ops: 1 }), 29).state;
    };
    expect(run("onprem").outageDays).toBeGreaterThan(0);
    expect(run("paas").outageDays).toBe(0);
  });
});

describe("events that are worse unpatched, and bring free users", () => {
  const begin = (s: Sim, model: string, ops?: number) => {
    const state = s.newGame({ companyName: "Acme", productType: "social", model, seed: 42 });
    return withStaff(state, { ops: ops ?? s.opsNeededNow(state) });
  };
  const onDay = (day: number) => ({ schedule: { type: "fixed" as const, days: [day] } });

  it("plays out worse when patches were overdue the day before", () => {
    const breach: EventConfig = {
      id: "breach",
      name: "Breach",
      description: "Attackers got in.",
      layer: "data",
      ...onDay(5),
      days: 1,
      effects: {
        iaas: {
          cost: { amount: 1_000, text: "Investigating" },
          detail: "Contained.",
          unpatched: { downtimeHours: 6, cost: { amount: 9_000, text: "Ransom" }, detail: "Ransomware." },
        },
      },
    };
    const s = createSim({ ...config, events: [breach] });
    const play = (ops?: number) => {
      // A game starts on day 1, so day 5 is the fourth played.
      const { state, log } = s.advance(begin(s, "iaas", ops), 4);
      const entries = log.at(-1)!.entries;
      const event = entries.find((e) => e.kind === "event")!.text;
      return { view: s.events(state)[0]!, event, cost: entries.find((e) => e.cashDelta < 0 && e.text.startsWith("Breach: "))! };
    };
    const patched = play();
    expect(patched.view).toMatchObject({ unpatched: false, hit: true, outcome: "Contained. It cost £1,000: investigating." });
    expect(patched.cost).toMatchObject({ text: "Breach: Investigating", cashDelta: -1_000 });
    // No ops on IaaS: the servers went unpatched on day 4.
    const unpatched = play(0);
    expect(unpatched.view).toMatchObject({ unpatched: true, hit: true, outcome: "Ransomware. It cost £9,000: ransom." });
    expect(unpatched.event).toBe("Breach: Data and users is your job on IaaS. Ransomware. It cost £9,000: ransom.");
    expect(unpatched.cost).toMatchObject({ text: "Breach: Ransom", cashDelta: -9_000 });
  });

  it("brings a wave of free users at the end of the day it fires, as far as the market has room", () => {
    const viral = (share: number, min: number): EventConfig => ({
      id: "viral",
      name: "Viral growth",
      description: "A post went viral.",
      layer: "runtime",
      ...onDay(5),
      days: 1,
      effects: { saas: { freeUsers: { share, min }, detail: "They're staying." } },
    });
    const without = createSim({ ...config, events: [] });
    // A game starts on day 1, so day 5 is the fourth played.
    const quiet = without.advance(begin(without, "saas"), 4).state;
    const s = createSim({ ...config, events: [viral(0.5, 100)] });
    const { state, log } = s.advance(begin(s, "saas"), 4);
    const wave = Math.round(quiet.users * 0.5);
    // The same day otherwise: none of them pay yet.
    expect(state.users).toBe(quiet.users + wave);
    expect(state.paidUsers).toBe(quiet.paidUsers);
    expect(s.events(state)[0]).toMatchObject({ newUsers: wave, hit: false });
    expect(log.at(-1)!.entries.find((e) => e.kind === "event")!.text).toBe(
      `Viral growth: Runtime and scaling is the provider's job on SaaS. ${wave.toLocaleString("en-GB")} new free users signed up. They're staying.`,
    );
    // Once: the day after, it's over.
    expect(s.events(s.advance(state, 1).state)).toEqual([]);
    // Never past the market.
    const flood = createSim({ ...config, events: [viral(0, 10_000_000)] });
    expect(flood.advance(begin(flood, "saas"), 4).state.users).toBe(config.productTypes.social.growth.marketSize);
  });
});

describe("the beta's new events", () => {
  const NEW = ["breach", "viralGrowth", "dataCentreFire", "fraud", "lawsuit"];
  const event = (id: string) => defaultConfig.events.find((e) => e.id === id)!;

  it("are all random events whose odds the company's situation changes", () => {
    for (const id of NEW) {
      const { encounter, effects } = event(id);
      expect(encounter!.chance).toBeGreaterThan(0);
      expect(Object.values(encounter!.risks ?? {}).some((m) => m !== 1)).toBe(true);
      // They hit every model, each its own way.
      expect(Object.keys(effects).sort()).toEqual([...MODEL_IDS].sort());
    }
    // Overdue patches let attackers in; kit run hot catches fire; unhappy customers don't spread the word, and sue.
    expect(event("breach").encounter!.risks!.unpatched).toBeGreaterThan(1);
    expect(event("dataCentreFire").encounter!.risks!.overloaded).toBeGreaterThan(1);
    expect(event("viralGrowth").encounter!.risks!.lowSatisfaction).toBeLessThan(1);
    expect(event("lawsuit").encounter!.risks!.lowSatisfaction).toBeGreaterThan(1);
  });

  it("only let a lawsuit follow a breach", () => {
    expect(event("lawsuit").encounter).toMatchObject({ follows: ["breach"], followsWithinDays: 60 });
  });

  it("make a breach worse with patches overdue, only where the OS is yours", () => {
    const { effects } = event("breach");
    for (const m of MODEL_IDS) {
      const osYours = responsibilityStack(m).find((l) => l.id === "os")!.owner === "you";
      expect(effects[m]!.unpatched !== undefined).toBe(osYours);
      if (osYours) {
        expect(effects[m]!.unpatched!.cost!.amount).toBeGreaterThan(effects[m]!.cost!.amount);
        expect(effects[m]!.unpatched!.downtimeHours).toBeGreaterThan(0);
      }
    }
  });

  it("hit on-prem hardest in a fire, and SaaS least in a fraud", () => {
    const fire = event("dataCentreFire").effects;
    for (const m of ["iaas", "paas", "saas"] as const) {
      expect(fire.onprem!.downtimeHours).toBeGreaterThan(fire[m]!.downtimeHours!);
      expect(fire[m]!.cost).toBeUndefined();
    }
    expect(fire.onprem!.cost!.amount).toBeGreaterThan(0);
    const fraud = event("fraud").effects;
    for (const m of ["onprem", "iaas", "paas"] as const) expect(fraud.saas!.cost!.amount).toBeLessThan(fraud[m]!.cost!.amount);
  });

  it("explain whose job it was on each model", () => {
    for (const id of NEW) {
      const e = event(id);
      const s = settlingPay(createSim({ ...roomyDefaults, events: [{ ...e, encounter: undefined, schedule: { type: "fixed", days: [6] } }] }));
      for (const model of MODEL_IDS) {
        const start = setUp(s, s.newGame({ companyName: "Acme", productType: "social", model, seed: 7 }));
        const { state } = s.advance(withStaff(start, { ops: 2 }), 5);
        const view = s.events(state)[0]!;
        const owner = responsibilityStack(model).find((l) => l.id === e.layer)!.owner;
        expect(view).toMatchObject({ id, owner, layer: e.layer });
        expect(view.responsibility).toMatch(owner === "you" ? /is your job/ : owner === "provider" ? /the provider's job/ : /shared/);
        expect(view.outcome).toContain(e.effects[model]!.detail);
      }
    }
  });

  it("lead onto an emergency loan when one empties the cash, or past the limit into the rescue buyout, not straight to the end", () => {
    const fraud = { ...event("fraud"), encounter: undefined, schedule: { type: "fixed" as const, days: [6] } };
    for (const limitDays of [7, 0]) {
      const s = settlingPay(createSim({ ...roomyDefaults, events: [fraud], rescue: { ...roomyDefaults.rescue, limitDays } }));
      const start = setUp(s, s.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 7 }));
      // Just less cash than the fraud takes, the day before it.
      const before = s.advance(start, 4).state;
      const { state, log } = s.advance({ ...before, cash: 1_000 }, 1);
      expect(log.at(-1)!.entries.some((e) => e.text.startsWith("Theft or fraud: Money clawed back"))).toBe(true);
      expect(state.status).toBe("playing");
      if (limitDays) {
        // Within 7 days of costs, the shortfall goes on an emergency loan, and cash is back at £0.
        expect(state).toMatchObject({ cash: 0, rescue: null, loan: { emergency: true, day: 6 } });
      } else {
        expect(state.rescue).toMatchObject({ day: 6 });
      }
    }
  });

  it("each fire in some games, with a lawsuit only ever soon after a breach", () => {
    const s = settlingPay(createSim(roomyDefaults));
    const fired = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const { schedule } = s.advance(s.newGame({ companyName: "Acme", productType: "social", model: "saas", seed }), 179).state;
      schedule.forEach((e, i) => {
        fired.add(e.event);
        if (e.event !== "lawsuit") return;
        const since = schedule.slice(0, i).map((x) => x.event);
        const breach = since.lastIndexOf("breach");
        expect(breach).toBeGreaterThan(since.lastIndexOf("lawsuit"));
        expect(e.day - schedule[breach]!.day).toBeLessThanOrEqual(60);
      });
    }
    for (const id of NEW) expect(fired).toContain(id);
  });
});

describe("pricing and income", () => {
  // Each product with its own free share and fair price.
  const priced = (
    overrides: Partial<GameConfig["pricing"]> = {},
    freeShares = { ecommerce: 0.4, social: 0.8, video: 0.5, payments: 0.5 },
  ) =>
    createSim({
      ...config,
      pricing: { ...config.pricing, ...overrides },
      productTypes: {
        ecommerce: { ...config.productTypes.ecommerce, pricing: { fairPrice: 30, freeShare: freeShares.ecommerce, conversionRate: 0, customerMix: allCasual } },
        social: { ...config.productTypes.social, pricing: { fairPrice: 6, freeShare: freeShares.social, conversionRate: 0, customerMix: allCasual } },
        video: { ...config.productTypes.video, pricing: { fairPrice: 9, freeShare: freeShares.video, conversionRate: 0, customerMix: allCasual } },
        payments: { ...config.productTypes.payments, pricing: { fairPrice: 5, freeShare: freeShares.payments, conversionRate: 0, customerMix: allCasual } },
        assistant: config.productTypes.assistant,
        games: config.productTypes.games,
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
    const allFree = priced({}, { ecommerce: 1, social: 1, video: 1, payments: 1 });
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
      const sm = priced({}, { ecommerce: free, social: free, video: free, payments: free });
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
        ecommerce: { ...s.config.productTypes.ecommerce, pricing: { fairPrice: 30, freeShare: 0.9, conversionRate: 0, customerMix: allCasual } },
      },
    });
    let state = inPhase(begin(sm, "ecommerce", "saas"), "grow");
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
          pricing: { fairPrice: 30, freeShare, conversionRate: 0, customerMix: allCasual },
          support: { ticketsPerPaidUser: 0.05, ticketsPerFreeUser: 0.01 },
        },
      },
      support: { ...config.support, ...overrides },
      ...extra,
    });
  const s = ticketed();
  const begin = (sm: Sim, model = "iaas", support = 0) => withStaff(sm.newGame({ companyName: "Acme", productType: "social", model, seed: 42 }), { ops: sm.opsNeeded(model as (typeof MODEL_IDS)[number]), support });
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
    const caught = s.advance(withStaff(state, { support: 20 })).state;
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
    let state = withStaff(s.advance(begin(s), 20).state, { support: 20 });
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
        social: { ...config.productTypes.social, growth: { ...growth, launchUsersMin: 1000, launchUsersMax: 1000, marketSize: 1000 } },
      },
    });
    const at = (sm: Sim, satisfaction: number) => withStaff({
      ...sm.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed: 42 }),
      satisfaction,
    }, { ops: 2 });

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
    expect(log[0]!.entries).toContainEqual({ text: "Support pay (2 mids)", cashDelta: -4, category: "staff" });
  });

  it("moves people into and out of support", () => {
    const state = withStaff(begin(s), { developers: 2, ops: 1, support: 1 });
    expect(counted(s.applyAction(state, { type: "moveStaff", from: "developers", to: "support" }))).toMatchObject({
      developers: 1,
      support: 2,
    });
    expect(counted(s.applyAction(state, { type: "moveStaff", from: "support", to: "ops" }))).toMatchObject({ support: 0, ops: 2 });
    expect(() => s.applyAction(withStaff(state, { support: 0 }), { type: "moveStaff", from: "support", to: "ops" })).toThrow(
      expect.objectContaining({ code: "no_staff" }),
    );
    expect(() => s.applyAction(state, { type: "moveStaff", from: "ops", to: "ops" })).toThrow(
      expect.objectContaining({ code: "same_pool" }),
    );
    // Without a from, a move into support comes from developers.
    expect(counted(s.applyAction(state, { type: "moveStaff", to: "support" }))).toMatchObject({ developers: 1, support: 2 });
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

describe("moderators and reports on user content", () => {
  // 1,000 social users, no growth, each raising 0.02 reports a day: 20 a day. A moderator handles 10. Support keeps up
  // with the tickets throughout, so only the reports move satisfaction.
  const moderated = createSim({
    ...config,
    productTypes: {
      ...config.productTypes,
      social: {
        ...config.productTypes.social,
        growth: { ...growth, dailyGrowth: 0 },
        pricing: { fairPrice: 30, freeShare: 0.5, conversionRate: 0, customerMix: allCasual },
        moderation: { reportsPerUser: 0.02 },
      },
    },
    moderation: { reportsPerPerson: 10, backlogPerUserAtZero: 0.05, lawsuitOddsAtZero: 4, warnShare: 0.1 },
  });
  const s = moderated;
  // In Launch, where moderators open.
  const begin = (moderators = 0, productType = "social") =>
    withStaff(inPhase(s.newGame({ companyName: "Acme", productType, model: "iaas", seed: 42 }), "launch"), { ops: s.opsNeeded("iaas"), support: 50, moderators });
  const supportLog = (log: DayLog[]) => log.flatMap((d) => d.entries.filter((e) => e.kind === "support").map((e) => e.text));

  it("can be hired only on a product with user content", () => {
    const shop = begin(0, "ecommerce");
    for (const action of [
      { type: "hire", pool: "moderators" },
      { type: "moveStaff", to: "moderators", from: "support" },
    ] as Action[]) {
      expect(() => s.applyAction(shop, action)).toThrow(expect.objectContaining({ code: "no_content" }));
    }
    expect(s.staff(shop).map((p) => p.pool)).toEqual(["developers", "ops", "support"]);
    expect(s.moderation(shop)).toBeNull();
    // On the social network they're the fourth pool, hired, moved and let go like any other.
    const social = s.applyAction(begin(), { type: "hire", pool: "moderators", grade: "senior", count: 2 });
    expect(s.staff(social).map((p) => p.pool)).toEqual(["developers", "ops", "support", "moderators"]);
    expect(team(social, "moderators")).toBe(2);
    expect(team(s.applyAction(social, { type: "moveStaff", to: "moderators", from: "support" }), "moderators")).toBe(3);
    expect(team(s.applyAction(social, { type: "letGo", pool: "moderators", grade: "senior" }), "moderators")).toBe(1);
  });

  it("makes social and video content products in the default config, and e-commerce not", () => {
    expect(defaultConfig.productTypes.social.moderation).toBeDefined();
    expect(defaultConfig.productTypes.video.moderation).toBeDefined();
    expect(defaultConfig.productTypes.ecommerce.moderation).toBeUndefined();
    // A starting moderator a config sets only joins a company with content to moderate.
    const starting = createSim({ ...s.config, staff: { ...s.config.staff, moderators: { ...s.config.staff.moderators, startingCount: 1 } } });
    const newGame = (productType: string) => starting.newGame({ companyName: "Acme", productType, model: "iaas", seed: 1 });
    expect(team(newGame("social"), "moderators")).toBe(1);
    expect(team(newGame("ecommerce"), "moderators")).toBe(0);
  });

  it("raises reports from every user, which moderators handle up to their output, the rest carrying over", () => {
    expect(s.moderation(begin(2))).toMatchObject({ usualReports: 20, dailyClearance: 20, backlog: 0, lawsuitOdds: 1, satisfactionFactor: 1 });
    expect(s.advance(begin(2)).state).toMatchObject({ reportsToday: 20, reportsHandled: 20, reportBacklog: 0 });
    // One moderator handles half; the rest waits, and is handled first once there are more.
    const short = s.advance(begin(1), 3).state;
    expect(short).toMatchObject({ reportsToday: 20, reportsHandled: 10, reportBacklog: 30 });
    const caughtUp = s.advance(withStaff(short, { moderators: 5 })).state;
    expect(caughtUp).toMatchObject({ reportsHandled: 50, reportBacklog: 0 });
    // A junior handles a junior's share.
    expect(s.moderation({ ...begin(), staff: { ...begin().staff, moderators: { junior: 2, mid: 0, senior: 0 } } })!.dailyClearance).toBe(10);
  });

  it("lowers satisfaction while reports go unhandled, and says so", () => {
    const covered = s.advance(begin(2), 20).state;
    const { state: neglected, log } = s.advance(begin(0), 20);
    expect(covered.satisfaction).toBe(100);
    // Hundreds of unhandled reports on under 1,000 users, far past 0.05 per user: the target is 0%, and users leave.
    expect(neglected.reportBacklog).toBeGreaterThan(300);
    expect(neglected.users).toBeLessThan(covered.users);
    expect(s.moderation(neglected)!.satisfactionFactor).toBe(0);
    expect(neglected.satisfaction).toBeLessThan(70);
    expect(neglected.backlog).toBe(0);
    const lines = supportLog(log);
    expect(lines[0]).toMatch(/reports on user content are waiting for a moderator.*Hire moderators\./);
    expect(lines).toContainEqual(expect.stringContaining("Customer satisfaction fell below 70%: reports on user content are waiting too long."));
    // Catching up is logged too, and satisfaction recovers.
    const { state: recovered, log: after } = s.advance(withStaff(neglected, { moderators: 60 }), 15);
    expect(supportLog(after)).toContain("Moderators have caught up with the reports on user content.");
    expect(recovered.satisfaction).toBeGreaterThan(neglected.satisfaction);
  });

  it("raises the lawsuit odds with the unhandled reports, up to the configured most", () => {
    const odds = (state: GameState) => s.moderation(state)!.lawsuitOdds;
    expect(odds(s.advance(begin(2), 10).state)).toBe(1);
    const day1 = s.advance(begin(0)).state;
    // 20 on 1,000 users: 0.4 of the way to the worst, so 1 + 3 × 0.4.
    expect(odds(day1)).toBeCloseTo(2.2, 6);
    expect(lawsuitOdds(s.config, day1)).toBe(odds(day1));
    // After 10 days, about 200 unhandled on 1,000 users: far past 0.05 per user, so the most.
    expect(odds(s.advance(begin(0), 10).state)).toBe(4);
    // Always 1 on a product without user content.
    expect(lawsuitOdds(s.config, begin(0, "ecommerce"))).toBe(1);
  });
});

describe("price waves and the price lock", () => {
  // A shop at a £30 fair price, 600 of 1,000 users paying, with no growth or random variation and no satisfaction
  // churn, so every change in users comes from the wave. Waves at their default strengths.
  const waved = (overrides: Partial<GameConfig["pricing"]> = {}) =>
    createSim({
      ...config,
      // No price churn, so a price above fair loses payers only through its wave.
      pricing: { ...defaultConfig.pricing, priceChurn: 0, ...overrides },
      support: { ...config.support, churnAtZero: 0 },
      productTypes: {
        ...config.productTypes,
        ecommerce: {
          ...config.productTypes.ecommerce,
          growth: { ...growth, dailyGrowth: 0, growthNoise: 0 },
          pricing: { fairPrice: 30, freeShare: 0.4, conversionRate: 0, customerMix: allCasual },
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

  it("previews a rise's ticket burst against today's support, and whether support clears it (#163)", () => {
    // No support staff: every backlash ticket waits, and the preview's backlog matches the game's after the wave.
    const start = begin();
    const preview = s.pricePreview(start, 45);
    const { tickets } = preview;
    expect(tickets.tickets).toBe(preview.total.tickets);
    expect(tickets.tickets).toBeGreaterThan(0);
    expect(tickets.peakDay).toBe(Math.max(...preview.days.map((d) => d.tickets)));
    expect(tickets).toMatchObject({ clearance: 0, usualTickets: 0, canClear: false, waitingAfter: tickets.tickets, peakWaiting: tickets.tickets });
    const { state } = daily(s, s.applyAction(start, setPrice(45)), preview.days.length);
    expect(state.backlog).toBe(tickets.waitingAfter);

    // Support that clears more than the busiest day: none wait.
    const staffed = s.applyAction(start, { type: "hire", pool: "support", count: Math.ceil(tickets.peakDay / 10) });
    expect(s.pricePreview(staffed, 45).tickets).toMatchObject({ canClear: true, peakWaiting: 0, waitingAfter: 0 });

    // Support that clears some each day falls behind on the busy days but catches up by the end.
    const some = s.applyAction(start, { type: "hire", pool: "support", count: Math.ceil(tickets.tickets / preview.days.length / 10) });
    const behind = s.pricePreview(some, 45).tickets;
    expect(behind.canClear).toBe(false);
    expect(behind.peakWaiting).toBeGreaterThan(0);
    expect(behind.peakWaiting).toBeLessThan(tickets.tickets);
    expect(behind.waitingAfter).toBeLessThan(behind.peakWaiting);

    // A cut brings no burst.
    expect(s.pricePreview(start, 20).tickets).toMatchObject({ tickets: 0, peakDay: 0, canClear: true });
    // Nor does today's price.
    expect(s.pricePreview(start, start.price).tickets).toMatchObject({ tickets: 0, canClear: true });
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
    // At most all but (1 − maxRiseShare) ÷ dearness keep paying: almost nobody at 33 times the fair price.
    expect(affected(1000)).toBe(Math.round(600 * (1 - (1 - defaultConfig.pricing.maxRiseShare) / (1000 / 30))));
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
    // A cut below the £30 customers remember, so it brings a wave.
    state = s.advance(end.state, 7).state;
    expect(s.applyAction(state, setPrice(20)).priceChanges).toHaveLength(2);
    expect(priceLog(s.advance(s.applyAction(state, setPrice(20))).log)[0]).toMatch(
      /^Customers noticed your price cut from £45 to £20: \d+ new users joined and \d+ free users started paying\./,
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
          growth: { ...growth, launchUsersMin: 10_000, launchUsersMax: 10_000, dailyGrowth: 0, growthNoise: 0 },
          pricing: { fairPrice: 30, freeShare: 0.5, conversionRate: rate, customerMix: allCasual },
        },
      },
      support: { ...config.support, churnAtZero: 0 },
      conversion: { ...defaultConfig.conversion, ...overrides },
      ...extra,
    });
  const s = converting();
  const begin = (sm = s, model = "iaas") => withStaff(sm.newGame({ companyName: "Acme", productType: "social", model, seed: 42 }), { ops: sm.opsNeeded(model as (typeof MODEL_IDS)[number]) });
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
      expect(entry!.text).toMatch(/^\d[\d,]* of \d[\d,]* free users started paying \([\d.]+% a day\)\.$/);
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
    const state = withStaff(inPhase(begin(s, "saas"), "grow"), { developers: 1 });
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

  it("falls with a price above the fair price, and rises at or below it, up to the cap (#251)", () => {
    const state = begin();
    const dear = s.applyAction(state, setPrice(60));
    expect(multiplier(s, dear, "price")).toBeCloseTo(0.25, 10);
    expect(s.conversion(dear).drivers[3]).toMatchObject({ effect: "hurting", value: 2 });
    expect(s.advance(dear).state.conversionsToday).toBeLessThan(s.advance(state).state.conversionsToday);
    // At the fair price it neither helps nor hurts; a little below it helps, and far below it is capped at 30% more.
    expect(multiplier(s, state, "price")).toBe(1);
    const under = s.applyAction(state, setPrice(28.5));
    expect(multiplier(s, under, "price")).toBeCloseTo(0.95 ** -2, 10);
    const cheap = s.applyAction(state, setPrice(15));
    expect(multiplier(s, cheap, "price")).toBeCloseTo(1.3, 10);
    expect(s.conversion(cheap).drivers[3]).toMatchObject({ effect: "helping" });
    expect(s.conversion(cheap).rate).toBeCloseTo(s.conversion(state).rate * 1.3, 10);
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
        // Conversions come from the free users the wave left, at the day's rate, which the cheaper price raises.
        const freeAfterWave = next.users - (next.paidUsers - next.conversionsToday);
        expect(next.conversionsToday).toBe(Math.round(freeAfterWave * sm.conversion(before).rate));
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
    // Features, uptime and satisfaction can double it.
    for (const p of PRODUCT_TYPE_IDS) {
      const rate = defaultConfig.productTypes[p].pricing.conversionRate;
      const chance = 1 - (1 - rate) ** defaultConfig.finalDay;
      expect(chance).toBeGreaterThan(0.1);
      expect(chance).toBeLessThan(0.6);
    }
  });
});

describe("alpha patch: pricing exploits and balance", () => {
  // A shop at a £30 fair price, 600 of 1,000 users paying, with no growth, conversion or random variation and no
  // satisfaction churn, so every change in paying users comes from the price. Pricing at its default strengths.
  const priced = (overrides: Partial<GameConfig["pricing"]> = {}, extra: Partial<GameConfig> = {}) =>
    createSim({
      ...config,
      pricing: { ...defaultConfig.pricing, ...overrides },
      support: { ...config.support, churnAtZero: 0 },
      productTypes: {
        ...config.productTypes,
        ecommerce: {
          ...config.productTypes.ecommerce,
          growth: { ...growth, dailyGrowth: 0, growthNoise: 0 },
          pricing: { fairPrice: 30, freeShare: 0.4, conversionRate: 0, customerMix: allCasual },
        },
      },
      ...extra,
    });
  const s = priced();
  const begin = (sm = s) => sm.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 });
  const setPrice = (price: number): Action => ({ type: "setPrice", price });
  const income = (log: DayLog[]) => log.flatMap((d) => d.entries).filter((e) => e.kind === "income").reduce((sum, e) => sum + e.cashDelta, 0);
  const gained = (sm: Sim, state: GameState, price: number) => {
    const t = sm.pricePreview(state, price).total;
    return t.joined + t.upgraded;
  };

  describe("price ladder", () => {
    it("brings almost nothing from a cut that leaves the price far above fair", () => {
      // Set £300 and wait past the price memory, so £300 is all customers remember.
      const dear = s.advance(s.applyAction(begin(), setPrice(300)), 70).state;
      const fromFair = gained(s, begin(), 20);
      expect(fromFair).toBeGreaterThan(50);
      // A £10 cut from £300 is the same size as one from £30 to £20, but £290 is still nearly ten times the fair price.
      expect(gained(s, dear, 290)).toBeLessThan(fromFair / 5);
      // Laddering down 4% at a time from there brings next to nothing at each step.
      expect(gained(s, dear, 288)).toBeLessThan(fromFair / 5);
    });

    it("counts a cut only below the price customers expect: one that has held for 30 days", () => {
      // Up to £45 and back to £30 two weeks later: £45 hasn't held long enough to be expected, so undoing it brings no
      // wave, and the preview says why.
      const risen = s.advance(s.applyAction(begin(), setPrice(45)), 14).state;
      expect(s.pricePreview(risen, 30)).toMatchObject({ expectedPrice: 30, total: { joined: 0, joinedPaid: 0, upgraded: 0 } });
      expect(s.pricePreview(risen, 30).noWave).toMatch(/^No wave: customers expect £30, the price that held for 30 days, and this is no lower/);
      // Below £30 it counts for the part below: a cut to £25 brings what £30 to £25 would (on the fewer users the rise
      // left), not £45 to £25.
      expect(gained(s, risen, 25)).toBeGreaterThan(0);
      expect(gained(s, risen, 25)).toBeLessThanOrEqual(gained(s, begin(), 25));
      expect(s.pricePreview(risen, 25).noWave).toBeNull();
      // Held 30 days, £45 is what customers expect: a cut from it is a discount, and counts from it.
      const settled = s.advance(s.applyAction(begin(), setPrice(45)), 31).state;
      expect(s.pricePreview(settled, 40).expectedPrice).toBe(45);
      expect(gained(s, settled, 40)).toBeGreaterThan(0);
      // The rise is still measured from the lowest price remembered, £30, for the 60 days.
      expect(s.pricePreview(settled, 50)).toMatchObject({ rememberedPrice: 30 });
    });

    it("counts a cut back from a price that has held as a discount, the more so the further below it", () => {
      // £45 held well past 30 days: customers expect it, so a cut back to the fair price brings a wave (#251).
      const dear = s.advance(s.applyAction(begin(), setPrice(45)), 40).state;
      expect(gained(s, dear, 30)).toBeGreaterThan(0);
      // A cut to £25 counts from £45, so it brings more than one from the fair price.
      expect(gained(s, dear, 25)).toBeGreaterThan(gained(s, begin(), 25));
    });

    it("earns no more from rising and cutting back to the fair price than from holding it", () => {
      const play = (prices: [day: number, price: number][], days: number) => {
        let state = begin();
        let earned = 0;
        for (let day = 1; day <= days; day++) {
          const change = prices.find(([d]) => d === day);
          if (change) state = s.applyAction(state, setPrice(change[1]));
          const played = s.advance(state);
          state = played.state;
          earned += income(played.log);
        }
        return { earned, paidUsers: state.paidUsers };
      };
      const held = play([], 170);
      // Up to £45, held past the price memory, back to £30, twice.
      const cycled = play([[1, 45], [75, 30], [90, 45], [160, 30]], 170);
      expect(cycled.earned).toBeLessThan(held.earned);
      expect(cycled.paidUsers).toBeLessThan(held.paidUsers);
      // Rising and cutting back each lock comes out no better.
      const quick = play(Array.from({ length: 12 }, (_, i) => [1 + 14 * i, i % 2 ? 30 : 45] as [number, number]), 170);
      expect(quick.earned).toBeLessThan(held.earned);
      // Nor does cutting back as soon as each rise has held long enough to be expected, so the cut counts as a
      // discount: the rise is measured from the lowest price remembered, and loses more than the cut wins back.
      const expected = defaultConfig.pricing.expectedPriceDays;
      const settled = play(Array.from({ length: 5 }, (_, i) => [1 + (expected + 1) * i, i % 2 ? 30 : 45] as [number, number]), 170);
      expect(settled.earned).toBeLessThan(held.earned);
      expect(settled.paidUsers).toBeLessThan(held.paidUsers);
    });
  });

  describe("small rises", () => {
    // Daily price churn off, so only the rises' waves move paying users.
    const flat = priced({ priceChurn: 0 });
    const ladder = [33, 36.3, 39.93, 43.92];
    const climb = (prices: number[]) => {
      let state = begin(flat);
      for (const price of prices) state = flat.advance(flat.applyAction(state, setPrice(price)), defaultConfig.pricing.lockDays).state;
      return flat.advance(state, defaultConfig.pricing.waveDays).state;
    };

    it("loses as many paying users to a run of small rises as to one rise to the same price", () => {
      const lostToLadder = 600 - climb(ladder).paidUsers;
      const lostToOne = 600 - climb([43.92]).paidUsers;
      expect(lostToOne).toBeGreaterThan(150);
      expect(Math.abs(lostToLadder - lostToOne)).toBeLessThanOrEqual(lostToOne * 0.02);
      // Each step's preview shows its share of the whole: the second step loses more than the first did alone.
      const firstStep = flat.applyAction(begin(flat), setPrice(33));
      const afterFirst = flat.advance(firstStep, defaultConfig.pricing.lockDays).state;
      expect(flat.pricePreview(afterFirst, 36.3).reaction).toBeGreaterThan(flat.pricePreview(begin(flat), 33).reaction * 2);
    });

    it("measures a rise from the lowest price customers remember, so stepping back up after a cut counts in full", () => {
      const cut = flat.advance(flat.applyAction(begin(flat), setPrice(20)), defaultConfig.pricing.lockDays).state;
      const upInSteps = (state: GameState) => {
        for (const price of [25, 30]) state = flat.advance(flat.applyAction(state, setPrice(price)), defaultConfig.pricing.lockDays).state;
        return state;
      };
      const oneStep = flat.pricePreview(cut, 30).reaction;
      const stepped = upInSteps(cut);
      expect(1 - stepped.paidUsers / cut.paidUsers).toBeCloseTo(oneStep, 2);
    });
  });

  describe("a price many times the fair one", () => {
    it("keeps almost no paying users, however a rise is capped", () => {
      const preview = s.pricePreview(begin(), 1000);
      expect(preview.paidUsers).toBeLessThan(600 * 0.01);
      expect(preview.dailyIncome).toBeLessThan(begin().paidUsers);
    });

    it("loses paying users every day it stays above the fair price, more the dearer it is", () => {
      // Waves off, so only the daily churn moves paying users.
      const flat = priced({ riseStrength: 0, cutGainStrength: 0, cutUpgradeStrength: 0 });
      const after = (price: number, days: number) => flat.advance(flat.applyAction(begin(flat), setPrice(price)), days).state.paidUsers;
      expect(after(30, 10)).toBe(600);
      expect(after(25, 10)).toBe(600);
      expect(after(60, 10)).toBeLessThan(600);
      expect(after(60, 10)).toBeGreaterThan(550);
      expect(after(150, 10)).toBeLessThan(after(60, 10) / 2);
      expect(after(1000, 10)).toBe(0);
      // Those who stop paying split between leaving and dropping to free, and the day's log says why.
      const { state, log } = flat.advance(flat.applyAction(begin(flat), setPrice(150)));
      expect(state.users).toBeLessThan(1000);
      expect(state.users - state.paidUsers).toBeGreaterThan(400);
      expect(log[0]!.entries.map((e) => e.text)).toContainEqual(expect.stringMatching(/^Paying users lost: \d+ left and \d+ dropped to free, because your price is above what they think it's worth\.$/));
      // From config.
      const none = priced({ riseStrength: 0, priceChurn: 0 });
      expect(none.advance(none.applyAction(begin(none), setPrice(150)), 10).state.paidUsers).toBe(600);
    });

    it("loses most of a dear rise on its first day, before anyone pays the new price", () => {
      // At the fair price, 600 payers bring £600 a day.
      const start = begin();
      expect(s.advance(start).log[0]!.entries.find((e) => e.kind === "income")!.cashDelta).toBe(600);
      const { log } = s.advance(s.applyAction(start, setPrice(1000)));
      // Those who refuse £1,000 don't pay it, so the first day at £1,000 brings in less than a day at £30.
      expect(income(log)).toBeLessThan(600);
      // A modest rise still lands gradually: a small reaction on its first day.
      const first = s.pricePreview(start, 36).days[0]!;
      const total = s.pricePreview(start, 36).total;
      expect(first.left + first.toFree).toBeLessThanOrEqual(Math.ceil((total.left + total.toFree) * defaultConfig.pricing.firstDayShare));
    });

    it("makes a last-minute rise to the maximum pay less than keeping the fair price", () => {
      const start = begin();
      const kept = income(s.advance(start, 9).log);
      const raised = income(s.advance(s.applyAction(start, setPrice(1000)), 9).log);
      expect(raised).toBeLessThan(kept);
    });

    it("gives price cycling nothing: up to the maximum and back down leaves fewer payers and less income", () => {
      let state = begin();
      let earned = 0;
      for (const price of [1000, 30, 1000, 30]) {
        const played = s.advance(s.applyAction(state, setPrice(price)), 14);
        state = played.state;
        earned += income(played.log);
      }
      const steady = s.advance(begin(), 56);
      expect(state.paidUsers).toBeLessThan(100);
      expect(earned).toBeLessThan(income(steady.log) / 2);
    });
  });

  describe("satisfaction and outages", () => {
    // 1,000 users, 600 paying, no tickets: satisfaction only moves where a test sets it.
    const unhappy = (support: Partial<GameConfig["support"]> = {}) =>
      priced({}, { support: { ...config.support, churnAtZero: 0, paidChurnAtZero: 0.03, ...support } });

    it("drives paying users away at low satisfaction, on top of churn", () => {
      const sm = unhappy();
      const at = (satisfaction: number) => sm.advance({ ...begin(sm), satisfaction });
      expect(at(100).state.paidUsers).toBe(600);
      expect(at(70).state.paidUsers).toBe(600);
      // 3% of payers a day at 0%, half that at half of good.
      expect(at(0).state.paidUsers).toBe(600 - 18);
      expect(at(35).state.paidUsers).toBe(600 - 9);
      expect(at(0).log[0]!.entries.map((e) => e.text)).toContainEqual(
        "Paying users lost: 11 left and 7 dropped to free, because they're unhappy with support.",
      );
      // A month at 0% loses well over half of them.
      let state = begin(sm);
      for (let i = 0; i < 30; i++) state = sm.advance({ ...state, satisfaction: 0 }).state;
      expect(state.paidUsers).toBeLessThan(260);
      const off = unhappy({ paidChurnAtZero: 0 });
      expect(off.advance({ ...begin(off), satisfaction: 0 }).state.paidUsers).toBe(600);
    });

    it("drives paying users away for each hour down", () => {
      const outage: EventConfig = {
        id: "providerOutage",
        name: "Provider outage",
        description: "The provider's data centre lost power.",
        layer: "facilities",
        schedule: { type: "fixed", days: [2] },
        days: 1,
        effects: { iaas: { downtimeHours: 10, detail: "Down." } },
      };
      const down = (paidChurnPerHour: number) => {
        const sm = priced({}, { events: [outage], outage: { ...config.outage, paidChurnPerHour } });
        return sm.advance(begin(sm)).state;
      };
      expect(down(0).paidUsers).toBe(600);
      // 10 hours at 0.1% an hour: 1% of payers.
      expect(down(0.001).paidUsers).toBe(594);
      expect(down(0.001).downtimeHours).toBe(10);
    });
  });

  describe("on-prem start", () => {
    it("leaves a company without the loan cash for a month after its first kit, which arrives in 4 days", () => {
      const sm = createSim(smallestLaunch(withoutMvp));
      for (const p of PRODUCT_TYPE_IDS) {
        const set = setUp(sm, sm.newGame({ companyName: "Acme", productType: p, model: "onprem", seed: 1 }));
        const daily = sm.dailyStaffCost(set) + sm.monthlyInfrastructureCost(set) / 30;
        expect(set.cash / daily, p).toBeGreaterThan(14);
        expect(launched(sm, set).launchDay, p).toBe(5);
      }
    });
  });

  describe("migration", () => {
    it("warns in the quote when a migration would leave less than a month of running costs", () => {
      const sm = createSim(defaultConfig);
      const early = sm.advance(sm.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 3 }), 5).state;
      const quote = sm.migrationQuote(early, "onprem");
      expect(quote.cashLeft).toBe(early.cash - quote.total);
      expect(quote.warning).toMatch(/^This would leave you £[\d,]+, about \d+ days of running costs before any income\./);
      // With the loan in the bank, it doesn't.
      expect(sm.migrationQuote({ ...early, cash: early.cash + defaultConfig.loan.amount }, "onprem").warning).toBeNull();
    });

    it("refuses a migration whose upfront bill is more than the company has", () => {
      const sm = createSim(defaultConfig);
      const early = sm.advance(sm.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 3 }), 5).state;
      const broke = { ...early, cash: 1_000 };
      expect(() => sm.applyAction(broke, { type: "startMigration", model: "onprem" })).toThrow(
        expect.objectContaining({ code: "cant_afford" }),
      );
      expect(sm.migrationQuote(broke, "onprem").warning).toMatch(/^You can't afford this/);
      expect(sm.applyAction(early, { type: "startMigration", model: "onprem" }).migration).not.toBeNull();
    });
  });

  describe("SaaS add-ons", () => {
    // £100 a developer-day: checkout's 6 days cost £600 to set up, reviews' 5 £500 and search's 4 £400.
    const fees = createSim({ ...config, startingCash: 1_000, addons: { minConfigDevelopers: 1, setupFeePerDevDay: 100 } });
    const onSaas = () => withStaff(inPhase(fees.newGame({ companyName: "Acme", productType: "ecommerce", model: "saas", seed: 42 }), "grow"), { developers: 1 });
    const buy = (feature: string): Action => ({ type: "buyAddon", feature });

    it("charges a set-up fee for its developer-days when bought, shown on the features", () => {
      const start = onSaas();
      expect(fees.features(start).map((f) => f.addonSetupFee)).toEqual([600, 500, 400]);
      const state = fees.applyAction(start, buy("checkout"));
      expect(state.cash).toBe(start.cash - 600);
      expect(state.spend.addons).toBe(start.spend.addons + 600);
    });

    it("refuses one the company can't afford, so it has to choose", () => {
      const state = fees.applyAction(onSaas(), buy("checkout"));
      expect(() => fees.applyAction(state, buy("reviews"))).toThrow(
        expect.objectContaining({ code: "cant_afford", message: "Setting up Reviews costs £500 and you have £400." }),
      );
      expect(fees.applyAction(state, buy("search")).cash).toBe(0);
    });

    it("costs more after a provider price rise on add-ons", () => {
      expect(fees.features({ ...onSaas(), addonPriceRise: 1.25 })[0]!.addonSetupFee).toBe(750);
    });
  });
});

describe("racks, cabling, power and cooling", () => {
  const sim = createSim(defaultConfig);
  const { onprem } = defaultConfig.models;
  const cabling = onprem.servers!.purchase!.cablingCost;
  const begin = (model: ModelId = "onprem") =>
    sim.newGame({ companyName: "Acme", productType: "video", model, seed: 1, takeLoan: true });
  const buy = (state: GameState, size: ServerSize, rack?: number, server: ServerType = "app") =>
    sim.applyAction(state, { type: "buyServer", server, size, ...(rack !== undefined && { rack }) });
  const refusal = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      if (e instanceof SimError) return e.code;
      throw e;
    }
    return null;
  };
  const lastDay = (state: GameState) => state.spendByDay.at(-1)!;

  describe("racks on-prem", () => {
    it("starts with the server room's rack, charged with its cabling as costs of their own", () => {
      const state = begin();
      expect(state.racks).toEqual([{ id: 1, size: "medium", paid: 500 }]);
      expect(sim.racks(state)).toMatchObject({
        racks: [{ id: 1, size: "medium", units: 24, used: 0, free: 24, servers: [], paid: 500, sellBack: 200 }],
        units: 24,
        used: 0,
        free: 24,
        mostFree: 24,
        serverUnits: { small: 1, medium: 2, large: 4, massive: 8 },
      });
      expect(sim.racks(state)!.options.map((o) => [o.size, o.units, o.price, o.cabling])).toEqual([
        ["small", 12, 300, cabling],
        ["medium", 24, 500, cabling],
        ["large", 42, 800, cabling],
      ]);
      expect(lastDay(state)).toMatchObject({ infrastructure: onprem.upfrontCost + 500, cabling });
      expect(state.spend.cabling).toBe(cabling);
    });

    it("installs each server in the first rack with room, taking its U from the day it's ordered", () => {
      let state = buy(begin(), "massive");
      state = buy(state, "large", undefined, "database");
      expect(state.servers.map((s) => s.rack)).toEqual([1, 1]);
      expect(sim.servers(state).map((s) => [s.status, s.rack])).toEqual([
        ["pending", 1],
        ["pending", 1],
      ]);
      expect(sim.racks(state)).toMatchObject({ used: 12, free: 12, mostFree: 12 });
      expect(sim.racks(state)!.racks[0]!.servers).toEqual(state.servers.map((s) => s.id));
    });

    it("refuses a server without enough free U in any one rack, until a rack is bought", () => {
      let state = buy(buy(buy(begin(), "massive"), "massive"), "large");
      // 20U used of 24: a massive server (8U) doesn't fit, a large one (4U) does.
      expect(sim.racks(state)).toMatchObject({ free: 4, mostFree: 4 });
      expect(refusal(() => buy(state, "massive"))).toBe("no_rack_space");
      expect(() => buy(state, "massive")).toThrow("A massive server takes 8U and the most free in any one rack is 4U.");
      state = sim.applyAction(state, { type: "buyRack", size: "small" });
      expect(sim.racks(state)).toMatchObject({ units: 36, free: 16, mostFree: 12 });
      state = buy(state, "massive");
      expect(state.servers.at(-1)!.rack).toBe(2);
      // U are counted rack by rack: 8U free in all, but no more than 4U in either, so another massive one won't go in.
      expect(sim.racks(state)).toMatchObject({ free: 8, mostFree: 4 });
      expect(refusal(() => buy(state, "massive"))).toBe("no_rack_space");
    });

    it("installs a server in the rack asked for, if it has room", () => {
      let state = sim.applyAction(begin(), { type: "buyRack", size: "small" });
      state = buy(state, "large", 2);
      expect(state.servers.at(-1)!.rack).toBe(2);
      state = buy(buy(state, "large", 2), "large", 2);
      expect(refusal(() => buy(state, "small", 2))).toBe("rack_full");
      expect(refusal(() => buy(state, "small", 9))).toBe("unknown_rack");
      expect(buy(state, "small", 1).servers.at(-1)!.rack).toBe(1);
    });

    it("charges cabling on every server and rack bought, as its own cost", () => {
      const start = begin();
      const state = sim.applyAction(buy(start, "large"), { type: "buyRack", size: "large" });
      const price = onprem.servers!.purchase!.price.app.large;
      expect(start.cash - state.cash).toBe(price + 800 + 2 * cabling);
      expect(state.spend.cabling - start.spend.cabling).toBe(2 * cabling);
      expect(state.spend.infrastructure - start.spend.infrastructure).toBe(price + 800);
      expect(lastDay(state).cabling - lastDay(start).cabling).toBe(2 * cabling);
      // Shown before buying, with the U each server takes.
      const option = sim.serverOptions(start).find((o) => o.type === "app" && o.size === "large")!;
      expect(option).toMatchObject({ price, cabling, rackUnits: 4 });
    });

    it("refuses a rack or server it can't pay for with its cabling", () => {
      const poor = { ...begin(), cash: 820 };
      expect(refusal(() => sim.applyAction(poor, { type: "buyRack", size: "large" }))).toBe("cant_afford");
      expect(refusal(() => buy({ ...poor, cash: 300 }, "small"))).toBe("cant_afford");
      expect(buy({ ...poor, cash: 310 }, "small").cash).toBe(0);
    });

    it("sells back an empty rack at the sell-back share, but not one with servers in it", () => {
      let state = buy(sim.applyAction(begin(), { type: "buyRack", size: "large" }), "small", 2);
      expect(refusal(() => sim.applyAction(state, { type: "sellRack", id: 2 }))).toBe("rack_in_use");
      expect(refusal(() => sim.applyAction(state, { type: "sellRack", id: 7 }))).toBe("unknown_rack");
      state = sim.advance(state, 7).state;
      state = sim.applyAction(state, { type: "sellServer", id: state.servers[0]!.id });
      const sold = sim.applyAction(state, { type: "sellRack", id: 2 });
      expect(sold.cash - state.cash).toBe(320);
      expect(sold.racks.map((r) => r.id)).toEqual([1]);
    });

    it("plays the same after a JSON round trip, racks and all", () => {
      const state = buy(sim.applyAction(begin(), { type: "buyRack", size: "small" }), "large", 2);
      expect(sim.advance(JSON.parse(JSON.stringify(state)), 10)).toEqual(sim.advance(state, 10));
    });
  });

  describe("on other models", () => {
    it("has no racks on IaaS, PaaS or SaaS", () => {
      for (const model of ["iaas", "paas", "saas"] as const) {
        const state = begin(model);
        expect(state.racks).toEqual([]);
        expect(sim.racks(state)).toBeNull();
        expect(refusal(() => sim.applyAction(state, { type: "buyRack", size: "small" }))).toBe("no_racks");
        expect(refusal(() => sim.applyAction(state, { type: "sellRack", id: 1 }))).toBe("no_racks");
        expect(sim.serverOptions(state).every((o) => o.rackUnits === null && o.cabling === 0)).toBe(true);
        expect(state.spend.cabling).toBe(0);
      }
    });
  });

  describe("power and cooling", () => {
    /** A company whose first users arrived on day 1: live, so billed for hosting. */
    const live = (state: GameState): GameState => ({ ...state, launchDay: 1 });

    it("is a fixed daily cost on every model, on-prem's the highest and SaaS's the least", () => {
      const daily = MODEL_IDS.map((m) => sim.powerAndCooling(m));
      expect(daily).toEqual(MODEL_IDS.map((m) => defaultConfig.models[m].powerAndCooling));
      expect([...daily].sort((a, b) => b - a)).toEqual(daily);
      expect(new Set(daily).size).toBe(MODEL_IDS.length);
      for (const model of MODEL_IDS) {
        // Billed from go-live, like every hosting bill: this company's first users have arrived.
        const { state, log } = sim.advance(live(begin(model)), 5);
        const power = log.flatMap((d) => d.entries.filter((e) => e.category === "power"));
        expect(power, model).toHaveLength(5);
        // Off on-prem the provider runs the building, so its power and cooling is its bill, passed on: the line says so.
        const passedOn = model === "onprem" ? "" : ": the provider's, passed on to you";
        expect(power[0]!.text).toBe(`${defaultConfig.models[model].name} power and cooling (£${sim.powerAndCooling(model)} a day)${passedOn}`);
        expect(state.spend.power).toBe(5 * sim.powerAndCooling(model));
        // In the daily running costs.
        expect(sim.runway(state).dailyCosts).toBeGreaterThanOrEqual(sim.powerAndCooling(model));
      }
    });

    it("is billed for both models during a migration, like the rest of the bill", () => {
      const moving = sim.applyAction(sim.advance(live(begin("iaas")), 3).state, { type: "startMigration", model: "paas" });
      const { log } = sim.advance(moving);
      expect(log[0]!.entries.filter((e) => e.category === "power").map((e) => -e.cashDelta)).toEqual([
        sim.powerAndCooling("iaas"),
        sim.powerAndCooling("paas"),
      ]);
    });
  });

  describe("migration", () => {
    it("onto on-prem, buys the racks the new setup needs, with cabling for all of it, as quoted", () => {
      const state = { ...sim.advance(begin("iaas"), 3).state, users: 20_000, cash: 1_000_000 };
      const quote = sim.migrationQuote(state, "onprem");
      expect(quote.racks.length).toBeGreaterThan(0);
      const pieces = quote.setup.reduce((sum, i) => sum + i.count, 0) + quote.racks.reduce((sum, r) => sum + r.count, 0);
      expect(quote.cabling).toBe(pieces * cabling);
      const moving = sim.applyAction(state, { type: "startMigration", model: "onprem" });
      const { log } = sim.advance(moving);
      expect(log[0]!.entries.filter((e) => e.category === "cabling").map((e) => -e.cashDelta)).toEqual([quote.cabling]);
      const done = sim.advance(moving, 20).state;
      expect(done.model).toBe("onprem");
      const racks = sim.racks(done)!;
      expect(racks.racks.map((r) => r.size)).toEqual(quote.racks.flatMap((r) => Array<string>(r.count).fill(r.size)));
      expect(racks.racks.every((r) => r.free >= 0)).toBe(true);
      expect(done.servers.every((s) => done.racks.some((r) => r.id === s.rack))).toBe(true);
    });

    it("off on-prem, sells the racks back with the servers", () => {
      const state = buy(begin(), "large");
      const quote = sim.migrationQuote(state, "iaas");
      expect(quote.sellBack).toBe(Math.round(onprem.servers!.purchase!.price.app.large * 0.4) + 200);
      const done = sim.advance(sim.applyAction(state, { type: "startMigration", model: "iaas" }), 20).state;
      expect(done.model).toBe("iaas");
      expect(done.racks).toEqual([]);
      expect(sim.racks(done)).toBeNull();
    });
  });
});

describe("ticks and pauses", () => {
  // A patch on day 10 that breaks in on IaaS with no ops: an event that hurts. Games start on day 1, so it's the second
  // day of the week played from day 8.
  const patch: EventConfig = {
    id: "patch",
    name: "OS security patch",
    description: "A hole in the OS.",
    layer: "os",
    schedule: { type: "fixed", days: [10] },
    days: 1,
    effects: {
      onprem: { opsNeeded: 1, detail: "Patched.", shortOfOps: { detail: "Attackers got in.", downtimeHours: 6 } },
      iaas: { opsNeeded: 1, detail: "Patched.", shortOfOps: { detail: "Attackers got in.", downtimeHours: 6 } },
      paas: { detail: "The provider patched it." },
      saas: { detail: "The provider patched it." },
    },
  };
  const s = createSim({
    ...config,
    startingCash: 1_000_000,
    allowedGameLengths: { "180-days": 1, "until-ipo": 0, "1-year": 0, career: 1 },
    events: [patch],
  });
  const begin = (gameLength: string) =>
    withStaff(s.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42, gameLength }), { ops: 0 });

  it("plays a day a tick, or a week in a career", () => {
    expect(s.tickDays(begin("180-days"))).toBe(1);
    expect(s.tickDays(begin("career"))).toBe(7);
    const day = s.tick(s.advance(begin("180-days"), 1).state);
    expect(day).toMatchObject({ days: 1, pauses: [] });
    expect(day.state.day).toBe(3);
    expect(day.log.map((d) => d.day)).toEqual([3]);
    const week = s.tick(s.advance(begin("career"), 1).state);
    expect(week).toMatchObject({ days: 7, pauses: [] });
    expect(week.state.day).toBe(9);
    expect(week.log.map((d) => d.day)).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });

  it("plays a week one day at a time: the same days as advance", () => {
    const start = s.advance(begin("career"), 1).state;
    expect(s.tick(start).state).toEqual(s.advance(start, 7).state);
  });

  it("stops a career's week on the day a pause trigger fires, with why", () => {
    const start = s.advance(begin("career"), 7).state;
    expect(start.day).toBe(8);
    const { state, days, pauses, log } = s.tick(start);
    expect(days).toBe(2);
    expect(state.day).toBe(10);
    expect(log.map((d) => d.day)).toEqual([9, 10]);
    expect(pauses).toEqual([{ kind: "event", id: "event-patch", text: "OS security patch" }]);
    // Playing on starts a new week from there, and the patch doesn't stop it again.
    const on = s.tick(state);
    expect(on.log[0]!.day).toBe(11);
    expect(on.pauses.map((p) => p.id)).not.toContain("event-patch");
  });

  it("pauses when the launch is over and when a feature is built", () => {
    // Users arriving over three days: time stops once the last of them are in.
    const ramped = createSim({ ...s.config, launch: { ...s.config.launch, rampShares: [0.2, 0.3, 0.5] } });
    let launching = ramped.tick(ramped.newGame({ companyName: "Acme", productType: "ecommerce", model: "saas", seed: 42 }));
    expect(launching.pauses).toEqual([]);
    while (ramped.launch(launching.state).status === "launching") launching = ramped.tick(launching.state);
    expect(launching.pauses).toEqual([{ kind: "finished", id: "launch", text: "Your launch is over" }]);
    const feature = s.config.productTypes.ecommerce.features[0]!;
    const building = withStaff(s.applyAction(inPhase(s.advance(begin("180-days"), 1).state, "grow"), { type: "buildFeature", feature: feature.id }), {
      ops: 0,
      developers: 50,
    });
    let tick = s.tick(building);
    while (!tick.pauses.length && tick.state.day < 100) tick = s.tick(tick.state);
    expect(tick.pauses).toContainEqual({ kind: "finished", id: `feature-${feature.id}`, text: `${feature.name} is built` });
  });

  it("pauses when cash gets low, not every day after, and again the day before it runs out", () => {
    const start = s.advance(begin("180-days"), 1).state;
    const burn = -s.runway(start).dailyNet;
    expect(burn).toBeGreaterThan(0);
    // Six days' cash: after a day, five are left.
    const low = s.tick({ ...start, cash: burn * 6.5 });
    expect(low.pauses).toEqual([expect.objectContaining({ kind: "lowCash", id: "low-cash" })]);
    expect(low.pauses[0]!.text).toMatch(/^Cash runs out in about \d days?$/);
    expect(s.tick(low.state).pauses).toEqual([]);
    const lastDay = s.tick({ ...start, cash: burn * 1.5 });
    expect(lastDay.pauses).toEqual([{ kind: "lowCash", id: "low-cash", text: "Cash runs out tomorrow" }]);
  });

  it("stops a career's week when a holiday that hits the product is announced, with its date", () => {
    const real = createSim({ ...defaultConfig, allowedGameLengths: { "180-days": 0, "until-ipo": 0, "1-year": 0, career: 1 } });
    const shop = real.newGame({ companyName: "Acme", productType: "ecommerce", model: "saas", seed: 3, gameLength: "career", startDate: "2026-11-01" });
    // Black Friday, on day 27, is announced 14 days ahead: day 13, in the week played from day 8.
    const start = real.advance(shop, 7).state;
    expect(start.day).toBe(8);
    const { state, pauses } = real.tick(start);
    expect(state.day).toBe(13);
    expect(pauses).toContainEqual({
      kind: "calendar",
      id: "holiday-blackFriday",
      text: "Holiday coming in 14 days: Black Friday, on Friday 27 November 2026",
    });
  });

  it("refuses a game that has ended", () => {
    const ended = s.endGame(begin("career"));
    expect(() => s.tick(ended)).toThrow(expect.objectContaining({ code: "finished" }));
  });
});
