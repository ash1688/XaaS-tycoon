import {
  defaultConfig,
  MODEL_IDS,
  PRODUCT_TYPE_IDS,
  SPEND_CATEGORIES,
  STAFF_POOLS,
  type FeatureConfig,
  type GameConfig,
  type ModelId,
  type ProductTypeId,
  type SpendCategory,
  type StaffPool,
} from "./config.ts";
import { nextRandom, seedRng } from "./rng.ts";
import { isNameAllowed } from "./nameFilter.ts";

/** Money spent in each category. */
export type Spend = Record<SpendCategory, number>;

/** What was spent on one day, for the cost-over-time chart. */
export interface DaySpend extends Spend {
  day: number;
}

/**
 * How far a feature has got. Features not started have no entry. A built feature or an add-on is active: its effect
 * applies. Add-ons are bought on SaaS rather than built, and billed per user; leaving SaaS removes them (delete the
 * entry), so the feature is not started again and can be rebuilt in developer-days.
 */
export interface FeatureProgress {
  status: "building" | "built" | "addon";
  /** Developer-days of work done so far. Equals the feature's cost once built; 0 for an add-on. */
  progress: number;
}

/** A bankrupt game is over: it accepts no more actions or advances. */
export type GameStatus = "playing" | "bankrupt";

/** Plain, JSON-serialisable game state. The server stores it as-is. */
export interface GameState {
  version: 5;
  status: GameStatus;
  companyName: string;
  productType: ProductTypeId;
  model: ModelId;
  day: number;
  cash: number;
  rng: number;
  developers: number;
  ops: number;
  users: number;
  /** Load on the day just played. */
  load: number;
  outageDays: number;
  /** Total hours down across every day played, for uptime. */
  downtimeHours: number;
  /** Running totals of every charge so far, by category. */
  spend: Spend;
  /** Spend on each day played, day 1 (upfront costs) first. Days before the ledger existed are missing. */
  spendByDay: DaySpend[];
  /** Features started or built, by feature id. */
  features: Record<string, FeatureProgress>;
}

/** State saved before features existed. */
export interface GameStateV4 extends Omit<GameState, "version" | "features"> {
  version: 4;
}

/** State saved before the ledger existed. */
export interface GameStateV3 extends Omit<GameStateV4, "version" | "status" | "spend" | "spendByDay"> {
  version: 3;
}

/** State saved before users and capacity existed. */
export interface GameStateV2 extends Omit<GameStateV3, "version" | "users" | "load" | "outageDays" | "downtimeHours"> {
  version: 2;
}

/** State saved before staff existed. */
export interface GameStateV1 extends Omit<GameStateV2, "version" | StaffPool> {
  version: 1;
}

/** Anything the server may have stored. Every Sim method accepts it and upgrades it first. */
export type SavedState = GameState | GameStateV4 | GameStateV3 | GameStateV2 | GameStateV1;

/** Something the player does between days. */
export type Action =
  | { type: "hire"; pool: StaffPool }
  | { type: "letGo"; pool: StaffPool }
  /** Starts building one of the product's features. One build at a time; not on SaaS. */
  | { type: "buildFeature"; feature: string }
  /** Buys one of the product's features as an add-on, active at once. SaaS only, with a configuration team. */
  | { type: "buyAddon"; feature: string };

export type FeatureStatus = "notStarted" | FeatureProgress["status"];

/** A feature on the product's list, and how far it has got. */
export interface FeatureView extends FeatureConfig {
  status: FeatureStatus;
  /** Developer-days done so far. */
  progress: number;
  /** Days until a build finishes at today's developers. Null unless building, or if there are no developers. */
  daysLeft: number | null;
}

export interface NewGameParams {
  companyName: string;
  productType: string;
  model: string;
  seed: number;
}

export interface LogEntry {
  text: string;
  cashDelta: number;
  /** Set on every charge, and only on charges. */
  category?: SpendCategory;
  /** Set on entries that need to stand out, such as an outage or bankruptcy. */
  kind?: "outage" | "bankrupt" | "feature";
}

export interface DayLog {
  day: number;
  entries: LogEntry[];
}

export interface AdvanceResult {
  state: GameState;
  log: DayLog[];
}

/** A player or caller asked for something the rules don't allow. */
export class SimError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SimError";
    this.code = code;
  }
}

export interface Sim {
  readonly config: GameConfig;
  newGame(params: NewGameParams): GameState;
  /** Upgrades saved state from an older version to the current one. */
  load(saved: SavedState): GameState;
  /** Applies a player's action without moving time on. */
  applyAction(state: SavedState, action: Action): GameState;
  /** The only way time moves. Continue calls it with 1. */
  advance(state: SavedState, days?: number): AdvanceResult;
  /** Ops staff the model needs to keep running. */
  opsNeeded(model: ModelId): number;
  /** What the current headcount costs per day. */
  dailyStaffCost(state: SavedState): number;
  /** What the current model costs per month at today's users. */
  monthlyInfrastructureCost(state: SavedState): number;
  /** What the active add-ons cost per month at today's users. */
  monthlyAddonCost(state: SavedState): number;
  /** Load the company can serve in a day with its current model and staff. */
  capacity(state: SavedState): number;
  /** Share of time up across every day played, as a percentage. 100 before the first day. */
  uptime(state: SavedState): number;
  /** The product's features, in config order, with each one's progress. */
  features(state: SavedState): FeatureView[];
}

export function isModelId(v: string): v is ModelId {
  return (MODEL_IDS as readonly string[]).includes(v);
}

export function isProductTypeId(v: string): v is ProductTypeId {
  return (PRODUCT_TYPE_IDS as readonly string[]).includes(v);
}

export function isStaffPool(v: string): v is StaffPool {
  return (STAFF_POOLS as readonly string[]).includes(v);
}

const noSpend = (): Spend => ({ staff: 0, infrastructure: 0, addons: 0 });

const count = new Intl.NumberFormat("en-GB");

function pounds(n: number): string {
  const digits = Number.isInteger(n) ? 0 : 2;
  return n.toLocaleString("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: digits });
}

export function createSim(config: GameConfig = defaultConfig): Sim {
  function newGame({ companyName, productType, model, seed }: NewGameParams): GameState {
    const name = companyName.trim();
    if (!name) throw new SimError("name_required", "Enter a company name.");
    if (name.length > config.maxCompanyNameLength) {
      throw new SimError("name_too_long", `Company names can be up to ${config.maxCompanyNameLength} characters.`);
    }
    if (!isNameAllowed(name)) {
      throw new SimError("name_not_allowed", "That name isn't allowed here. Please choose another company name.");
    }
    if (!isProductTypeId(productType)) throw new SimError("unknown_product_type", "Pick a product type from the list.");
    if (!isModelId(model)) throw new SimError("unknown_model", "Pick a deployment model from the list.");
    const state: GameState = {
      version: 5,
      status: "playing",
      companyName: name,
      productType,
      model,
      day: 1,
      cash: config.startingCash,
      rng: seedRng(seed),
      developers: config.staff.developers.startingCount,
      ops: config.staff.ops.startingCount,
      ...startingUsers(productType, 1),
      spend: noSpend(),
      spendByDay: [],
      features: {},
    };
    return settle(state, 1, upfrontEntries(model)).state;
  }

  function startingUsers(productType: ProductTypeId, day: number) {
    const users = config.productTypes[productType].growth.startingUsers;
    return { users, load: Math.round(baseLoad(productType, users, day)), outageDays: 0, downtimeHours: 0 };
  }

  function load(saved: SavedState): GameState {
    if (saved.version === 5) return saved;
    const v4 = saved.version === 4 ? saved : loadV3(saved);
    // Games started before features existed have none built yet.
    return { ...v4, version: 5, features: {} };
  }

  function loadV3(saved: GameStateV3 | GameStateV2 | GameStateV1): GameStateV4 {
    const v3 = saved.version === 3 ? saved : loadV2(saved);
    // Games started before the ledger existed count spend from now on. One already in debt is bankrupt.
    return { ...v3, version: 4, status: v3.cash < 0 ? "bankrupt" : "playing", spend: noSpend(), spendByDay: [] };
  }

  function loadV2(saved: GameStateV2 | GameStateV1): GameStateV3 {
    // Games started before staff existed keep going with no staff, rather than suddenly paying for some.
    const v2: GameStateV2 = saved.version === 2 ? saved : { ...saved, version: 2, developers: 0, ops: 0 };
    // Games started before users existed pick up with the product's starting users and a clean record.
    return { ...v2, version: 3, ...startingUsers(v2.productType, v2.day) };
  }

  /** Loads saved state and checks the game is still going. */
  function loadPlaying(saved: SavedState): GameState {
    const state = load(saved);
    if (state.status === "bankrupt") {
      throw new SimError("bankrupt", `${state.companyName} is bankrupt, so this game is over. Start a new company to play again.`);
    }
    return state;
  }

  function applyAction(saved: SavedState, action: Action): GameState {
    const state = loadPlaying(saved);
    switch (action.type) {
      case "hire":
      case "letGo":
        return changeStaff(state, action.type, action.pool);
      case "buildFeature":
        return startBuild(state, action.feature);
      case "buyAddon":
        return buyAddon(state, action.feature);
      default:
        throw new SimError("unknown_action", "That action isn't recognised.");
    }
  }

  function changeStaff(state: GameState, type: "hire" | "letGo", pool: StaffPool): GameState {
    if (!isStaffPool(pool)) throw new SimError("unknown_pool", "Pick developers or ops.");
    if (type === "hire") return { ...state, [pool]: state[pool] + 1 };
    if (state[pool] < 1) {
      throw new SimError("no_staff", `You have no ${config.staff[pool].name.toLowerCase()} to let go.`);
    }
    return { ...state, [pool]: state[pool] - 1 };
  }

  const featureList = (state: GameState) => config.productTypes[state.productType].features;

  const isActive = (state: GameState, id: string) => {
    const status = state.features[id]?.status;
    return status === "built" || status === "addon";
  };

  /** The feature being built, if any. Only one is built at a time. */
  function currentBuild(state: GameState): FeatureConfig | undefined {
    return featureList(state).find((f) => state.features[f.id]?.status === "building");
  }

  function startBuild(state: GameState, id: string): GameState {
    if (state.model === "saas") {
      throw new SimError(
        "saas_features",
        "On SaaS you don't build features yourself: they come as add-ons from the provider.",
      );
    }
    const feature = featureList(state).find((f) => f.id === id);
    if (!feature) throw new SimError("unknown_feature", "Pick a feature from your product's list.");
    const existing = state.features[id];
    if (isActive(state, id)) throw new SimError("feature_built", `${feature.name} is already built.`);
    if (existing) throw new SimError("feature_building", `${feature.name} is already being built.`);
    const building = currentBuild(state);
    if (building) {
      throw new SimError("build_in_progress", `Your developers are busy building ${building.name}. Finish that first.`);
    }
    return { ...state, features: { ...state.features, [id]: { status: "building", progress: 0 } } };
  }

  function buyAddon(state: GameState, id: string): GameState {
    if (state.model !== "saas") {
      throw new SimError("not_saas", "Add-ons are only sold on SaaS. On your model, your developers build features.");
    }
    const feature = featureList(state).find((f) => f.id === id);
    if (!feature) throw new SimError("unknown_feature", "Pick a feature from your product's list.");
    if (isActive(state, id)) throw new SimError("addon_active", `${feature.name} is already active.`);
    const needed = config.addons.minConfigDevelopers;
    if (state.developers < needed) {
      throw new SimError(
        "config_team",
        `Add-ons still need configuring: hire at least ${needed} developer${needed === 1 ? "" : "s"} first.`,
      );
    }
    return { ...state, features: { ...state.features, [id]: { status: "addon", progress: 0 } } };
  }

  /** A day's work on the current build: one developer-day per developer. Logs progress, or completion. */
  function buildDay(state: GameState): { features: GameState["features"]; entries: LogEntry[] } {
    const feature = currentBuild(state);
    if (!feature) return { features: state.features, entries: [] };
    if (state.developers === 0) {
      const text = `${feature.name}: no developers, so no progress today.`;
      return { features: state.features, entries: [{ text, cashDelta: 0, kind: "feature" }] };
    }
    const progress = Math.min(feature.devDays, state.features[feature.id]!.progress + state.developers);
    const built = progress === feature.devDays;
    const percent = Math.round(100 * (feature.growthMultiplier - 1));
    const text = built
      ? `Feature built: ${feature.name}. Growth up ${percent}% from now on.`
      : `Building ${feature.name}: ${progress} of ${feature.devDays} developer-days done.`;
    return {
      features: { ...state.features, [feature.id]: { status: built ? "built" : "building", progress } },
      entries: [{ text, cashDelta: 0, kind: "feature" }],
    };
  }

  function features(saved: SavedState): FeatureView[] {
    const state = load(saved);
    return featureList(state).map((f) => {
      const { status, progress } = state.features[f.id] ?? { status: "notStarted" as const, progress: 0 };
      const daysLeft =
        status === "building" && state.developers > 0 ? Math.ceil((f.devDays - progress) / state.developers) : null;
      return { ...f, status, progress, daysLeft };
    });
  }

  const opsNeeded = (model: ModelId) => config.models[model].opsNeeded;

  function staffEntries(state: GameState): LogEntry[] {
    return STAFF_POOLS.filter((pool) => state[pool] > 0).map((pool) => {
      const { name, dayRate } = config.staff[pool];
      return { text: `${name} pay (${state[pool]})`, cashDelta: -state[pool] * dayRate, category: "staff" };
    });
  }

  function upfrontEntries(modelId: ModelId): LogEntry[] {
    const { name, upfrontCost } = config.models[modelId];
    if (upfrontCost === 0) return [];
    return [{ text: `Upfront cost: ${name}`, cashDelta: -upfrontCost, category: "infrastructure" }];
  }

  /**
   * A model's running costs for some days: its monthly cost, plus its per-user cost on the given users, each billed
   * as days ÷ daysPerMonth of a month and rounded to the pound. Advance bills one day at a time; billing part of a
   * month (say when leaving a model) uses the same rule.
   */
  function infrastructureEntries(modelId: ModelId, users: number, days = 1): LogEntry[] {
    const { name, monthlyCost, monthlyCostPerUser } = config.models[modelId];
    const share = days / config.billing.daysPerMonth;
    const entries: LogEntry[] = [];
    if (monthlyCost > 0) {
      entries.push({
        text: `${name} running costs (${pounds(monthlyCost)} a month)`,
        cashDelta: -Math.round(monthlyCost * share),
        category: "infrastructure",
      });
    }
    if (monthlyCostPerUser > 0 && users > 0) {
      entries.push({
        text: `${name} per-user fee (${count.format(users)} users at ${pounds(monthlyCostPerUser)} a month)`,
        cashDelta: -Math.round(users * monthlyCostPerUser * share),
        category: "infrastructure",
      });
    }
    return entries;
  }

  const activeAddons = (state: GameState) => featureList(state).filter((f) => state.features[f.id]?.status === "addon");

  /** Each active add-on's per-user price on the given users, billed like the model's per-user fee. */
  function addonEntries(state: GameState, days = 1): LogEntry[] {
    const share = days / config.billing.daysPerMonth;
    return activeAddons(state).map((f) => ({
      text: `Add-on: ${f.name} (${count.format(state.users)} users at ${pounds(f.addonPricePerUser)} a month)`,
      cashDelta: -Math.round(state.users * f.addonPricePerUser * share),
      category: "addons",
    }));
  }

  function monthlyAddonCost(saved: SavedState): number {
    const state = load(saved);
    return Math.round(activeAddons(state).reduce((sum, f) => sum + state.users * f.addonPricePerUser, 0));
  }

  function monthlyInfrastructureCost(saved: SavedState): number {
    const state = load(saved);
    const { monthlyCost, monthlyCostPerUser } = config.models[state.model];
    return Math.round(monthlyCost + state.users * monthlyCostPerUser);
  }

  /**
   * The ledger. Applies a day's entries to cash, adds each charge to its category's running total and the day's
   * spend, and ends the game if cash has gone below zero. Returns the entries with any bankruptcy notice added.
   */
  function settle(state: GameState, day: number, entries: LogEntry[]): { state: GameState; entries: LogEntry[] } {
    const daySpend = noSpend();
    for (const e of entries) if (e.category) daySpend[e.category] -= e.cashDelta;
    const spend = noSpend();
    for (const c of SPEND_CATEGORIES) spend[c] = state.spend[c] + daySpend[c];
    const cash = state.cash + entries.reduce((sum, e) => sum + e.cashDelta, 0);
    if (cash >= 0) {
      return { state: { ...state, cash, spend, spendByDay: [...state.spendByDay, { day, ...daySpend }] }, entries };
    }
    return {
      state: { ...state, cash, spend, spendByDay: [...state.spendByDay, { day, ...daySpend }], status: "bankrupt" },
      entries: [
        ...entries,
        { text: `Cash ran out: ${state.companyName} is bankrupt. Game over.`, cashDelta: 0, kind: "bankrupt" },
      ],
    };
  }

  function dailyStaffCost(saved: SavedState): number {
    const state = load(saved);
    return STAFF_POOLS.reduce((sum, pool) => sum + state[pool] * config.staff[pool].dayRate, 0);
  }

  function inSpike(productType: ProductTypeId, day: number): boolean {
    const spike = config.productTypes[productType].growth.seasonalSpike;
    return !!spike && day >= spike.firstDay && (day - spike.firstDay) % spike.every < spike.length;
  }

  /** Load from a product's users on a given day, before random variation. */
  function baseLoad(productType: ProductTypeId, users: number, day: number): number {
    const { loadPerUser, seasonalSpike } = config.productTypes[productType].growth;
    const spike = seasonalSpike && inSpike(productType, day) ? seasonalSpike.loadMultiplier : 1;
    return users * loadPerUser * spike;
  }

  /**
   * Each factor scales capacity. Models that need ops lose capacity in step with missing ops.
   * Later mechanics (traffic events, scaling up) add their own factors here.
   */
  function capacityFactors(state: GameState): number[] {
    const needed = opsNeeded(state.model);
    const staffed = needed === 0 ? 1 : Math.min(state.ops, needed) / needed;
    const { unstaffedShare } = config.capacity;
    return [unstaffedShare + (1 - unstaffedShare) * staffed];
  }

  function capacity(saved: SavedState): number {
    const state = load(saved);
    const base = config.models[state.model].capacity;
    return Math.round(capacityFactors(state).reduce((c, f) => c * f, base));
  }

  /** Each factor scales the day's growth. Later mechanics (reputation) add their own here. */
  function growthFactors(state: GameState, day: number, outage: boolean): number[] {
    const spike = config.productTypes[state.productType].growth.seasonalSpike;
    return [
      spike && inSpike(state.productType, day) ? spike.growthMultiplier : 1,
      outage ? config.outage.growthMultiplier : 1,
      // Each feature built before today, and each add-on bought.
      ...featureList(state)
        .filter((f) => isActive(state, f.id))
        .map((f) => f.growthMultiplier),
    ];
  }

  function uptime(saved: SavedState): number {
    const state = load(saved);
    const hoursPlayed = (state.day - 1) * 24;
    return hoursPlayed === 0 ? 100 : (100 * (hoursPlayed - state.downtimeHours)) / hoursPlayed;
  }

  /** A random factor of 1 ± spread, and the next RNG state. */
  function vary(rng: number, spread: number): [factor: number, next: number] {
    const [r, next] = nextRandom(rng);
    return [1 + spread * (2 * r - 1), next];
  }

  function advanceOneDay(state: GameState): AdvanceResult {
    const day = state.day + 1;
    const profile = config.productTypes[state.productType].growth;

    // Today's load comes from the users at the start of the day.
    const [loadVariation, afterLoad] = vary(state.rng, profile.loadNoise);
    const load = Math.round(baseLoad(state.productType, state.users, day) * loadVariation);
    const cap = capacity(state);
    const outage = load > cap;
    const { baseHours, hoursPerOverload } = config.outage;
    const hoursDown = outage ? Math.min(24, Math.ceil(baseHours + hoursPerOverload * (load / cap - 1))) : 0;

    // Growth slows as the market fills up, and on an outage day.
    const [growthVariation, rng] = vary(afterLoad, profile.growthNoise);
    const rate = growthFactors(state, day, outage).reduce(
      (r, f) => r * f,
      profile.dailyGrowth * (1 - state.users / profile.marketSize) * growthVariation,
    );
    const users = Math.max(0, state.users + Math.round(state.users * rate));

    // Developers work on the current build. A feature finished today helps growth from tomorrow.
    const build = buildDay(state);

    const entries: LogEntry[] = [
      ...build.entries,
      ...infrastructureEntries(state.model, state.users),
      ...addonEntries(state),
      ...staffEntries(state),
    ];
    if (outage) {
      const percent = Math.round((100 * load) / cap);
      entries.unshift({
        text: `Outage: load hit ${percent}% of capacity. Down ${hoursDown} hours; growth slowed.`,
        cashDelta: 0,
        kind: "outage",
      });
    }
    const played: GameState = {
      ...state,
      day,
      rng,
      users,
      load,
      outageDays: state.outageDays + (outage ? 1 : 0),
      downtimeHours: state.downtimeHours + hoursDown,
      features: build.features,
    };
    const settled = settle(played, day, entries);
    return { state: settled.state, log: [{ day, entries: settled.entries }] };
  }

  function advance(saved: SavedState, days = 1): AdvanceResult {
    if (!Number.isInteger(days) || days < 1) {
      throw new SimError("bad_days", "Days to advance must be a whole number of at least 1.");
    }
    let current = loadPlaying(saved);
    const log: DayLog[] = [];
    // Stops early if the company goes bankrupt part-way through.
    for (let i = 0; i < days && current.status === "playing"; i++) {
      const result = advanceOneDay(current);
      current = result.state;
      log.push(...result.log);
    }
    return { state: current, log };
  }

  return {
    config,
    newGame,
    load,
    applyAction,
    advance,
    opsNeeded,
    dailyStaffCost,
    monthlyInfrastructureCost,
    monthlyAddonCost,
    capacity,
    uptime,
    features,
  };
}
