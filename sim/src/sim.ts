import {
  defaultConfig,
  MODEL_IDS,
  PRODUCT_TYPE_IDS,
  STAFF_POOLS,
  type GameConfig,
  type ModelId,
  type ProductTypeId,
  type StaffPool,
} from "./config.ts";
import { nextRandom, seedRng } from "./rng.ts";

/** Plain, JSON-serialisable game state. The server stores it as-is. */
export interface GameState {
  version: 3;
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
}

/** State saved before users and capacity existed. */
export interface GameStateV2 extends Omit<GameState, "version" | "users" | "load" | "outageDays" | "downtimeHours"> {
  version: 2;
}

/** State saved before staff existed. */
export interface GameStateV1 extends Omit<GameStateV2, "version" | StaffPool> {
  version: 1;
}

/** Anything the server may have stored. Every Sim method accepts it and upgrades it first. */
export type SavedState = GameState | GameStateV2 | GameStateV1;

/** Something the player does between days. */
export type Action = { type: "hire"; pool: StaffPool } | { type: "letGo"; pool: StaffPool };

export interface NewGameParams {
  companyName: string;
  productType: string;
  model: string;
  seed: number;
}

export interface LogEntry {
  text: string;
  cashDelta: number;
  /** Set on entries that need to stand out, such as an outage. */
  kind?: "outage";
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
  /** Load the company can serve in a day with its current model and staff. */
  capacity(state: SavedState): number;
  /** Share of time up across every day played, as a percentage. 100 before the first day. */
  uptime(state: SavedState): number;
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

export function createSim(config: GameConfig = defaultConfig): Sim {
  function newGame({ companyName, productType, model, seed }: NewGameParams): GameState {
    const name = companyName.trim();
    if (!name) throw new SimError("name_required", "Enter a company name.");
    if (name.length > config.maxCompanyNameLength) {
      throw new SimError("name_too_long", `Company names can be up to ${config.maxCompanyNameLength} characters.`);
    }
    if (!isProductTypeId(productType)) throw new SimError("unknown_product_type", "Pick a product type from the list.");
    if (!isModelId(model)) throw new SimError("unknown_model", "Pick a deployment model from the list.");
    return {
      version: 3,
      companyName: name,
      productType,
      model,
      day: 1,
      cash: config.startingCash,
      rng: seedRng(seed),
      developers: config.staff.developers.startingCount,
      ops: config.staff.ops.startingCount,
      ...startingUsers(productType, 1),
    };
  }

  function startingUsers(productType: ProductTypeId, day: number) {
    const users = config.productTypes[productType].growth.startingUsers;
    return { users, load: Math.round(baseLoad(productType, users, day)), outageDays: 0, downtimeHours: 0 };
  }

  function load(saved: SavedState): GameState {
    if (saved.version === 3) return saved;
    // Games started before staff existed keep going with no staff, rather than suddenly paying for some.
    const v2: GameStateV2 = saved.version === 2 ? saved : { ...saved, version: 2, developers: 0, ops: 0 };
    // Games started before users existed pick up with the product's starting users and a clean record.
    return { ...v2, version: 3, ...startingUsers(v2.productType, v2.day) };
  }

  function applyAction(saved: SavedState, action: Action): GameState {
    const state = load(saved);
    if (!isStaffPool(action.pool)) throw new SimError("unknown_pool", "Pick developers or ops.");
    const { pool } = action;
    switch (action.type) {
      case "hire":
        return { ...state, [pool]: state[pool] + 1 };
      case "letGo":
        if (state[pool] < 1) {
          throw new SimError("no_staff", `You have no ${config.staff[pool].name.toLowerCase()} to let go.`);
        }
        return { ...state, [pool]: state[pool] - 1 };
      default:
        throw new SimError("unknown_action", "That action isn't recognised.");
    }
  }

  const opsNeeded = (model: ModelId) => config.models[model].opsNeeded;

  function staffEntries(state: GameState): LogEntry[] {
    return STAFF_POOLS.filter((pool) => state[pool] > 0).map((pool) => {
      const { name, dayRate } = config.staff[pool];
      return { text: `${name} pay (${state[pool]})`, cashDelta: -state[pool] * dayRate };
    });
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

  /** Each factor scales the day's growth. Later mechanics (features, reputation) add their own here. */
  function growthFactors(state: GameState, day: number, outage: boolean): number[] {
    const spike = config.productTypes[state.productType].growth.seasonalSpike;
    return [
      spike && inSpike(state.productType, day) ? spike.growthMultiplier : 1,
      outage ? config.outage.growthMultiplier : 1,
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
    const model = config.models[state.model];
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

    const entries: LogEntry[] = [
      { text: `${model.name} running costs`, cashDelta: -model.dailyCost },
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
    const cash = state.cash + entries.reduce((sum, e) => sum + e.cashDelta, 0);
    return {
      state: {
        ...state,
        day,
        cash,
        rng,
        users,
        load,
        outageDays: state.outageDays + (outage ? 1 : 0),
        downtimeHours: state.downtimeHours + hoursDown,
      },
      log: [{ day, entries }],
    };
  }

  function advance(saved: SavedState, days = 1): AdvanceResult {
    if (!Number.isInteger(days) || days < 1) {
      throw new SimError("bad_days", "Days to advance must be a whole number of at least 1.");
    }
    let current = load(saved);
    const log: DayLog[] = [];
    for (let i = 0; i < days; i++) {
      const result = advanceOneDay(current);
      current = result.state;
      log.push(...result.log);
    }
    return { state: current, log };
  }

  return { config, newGame, load, applyAction, advance, opsNeeded, dailyStaffCost, capacity, uptime };
}
