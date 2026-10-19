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
import { seedRng } from "./rng.ts";

/** Plain, JSON-serialisable game state. The server stores it as-is. */
export interface GameState {
  version: 2;
  companyName: string;
  productType: ProductTypeId;
  model: ModelId;
  day: number;
  cash: number;
  rng: number;
  developers: number;
  ops: number;
}

/** State saved before staff existed. */
export interface GameStateV1 extends Omit<GameState, "version" | StaffPool> {
  version: 1;
}

/** Anything the server may have stored. Every Sim method accepts it and upgrades it first. */
export type SavedState = GameState | GameStateV1;

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
      version: 2,
      companyName: name,
      productType,
      model,
      day: 1,
      cash: config.startingCash,
      rng: seedRng(seed),
      developers: config.staff.developers.startingCount,
      ops: config.staff.ops.startingCount,
    };
  }

  function load(saved: SavedState): GameState {
    if (saved.version === 2) return saved;
    // Games started before staff existed keep going with no staff, rather than suddenly paying for some.
    return { ...saved, version: 2, developers: 0, ops: 0 };
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

  function advanceOneDay(state: GameState): AdvanceResult {
    const day = state.day + 1;
    const model = config.models[state.model];
    const entries: LogEntry[] = [
      { text: `${model.name} running costs`, cashDelta: -model.dailyCost },
      ...staffEntries(state),
    ];
    const cash = state.cash + entries.reduce((sum, e) => sum + e.cashDelta, 0);
    return { state: { ...state, day, cash }, log: [{ day, entries }] };
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

  return { config, newGame, load, applyAction, advance, opsNeeded, dailyStaffCost };
}
