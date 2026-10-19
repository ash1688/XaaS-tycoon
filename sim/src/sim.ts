import { defaultConfig, MODEL_IDS, PRODUCT_TYPE_IDS, type GameConfig, type ModelId, type ProductTypeId } from "./config.ts";
import { seedRng } from "./rng.ts";

/** Plain, JSON-serialisable game state. The server stores it as-is. */
export interface GameState {
  version: 1;
  companyName: string;
  productType: ProductTypeId;
  model: ModelId;
  day: number;
  cash: number;
  rng: number;
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
  /** The only way time moves. Continue calls it with 1. */
  advance(state: GameState, days?: number): AdvanceResult;
}

export function isModelId(v: string): v is ModelId {
  return (MODEL_IDS as readonly string[]).includes(v);
}

export function isProductTypeId(v: string): v is ProductTypeId {
  return (PRODUCT_TYPE_IDS as readonly string[]).includes(v);
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
      version: 1,
      companyName: name,
      productType,
      model,
      day: 1,
      cash: config.startingCash,
      rng: seedRng(seed),
    };
  }

  function advanceOneDay(state: GameState): AdvanceResult {
    const day = state.day + 1;
    const model = config.models[state.model];
    const entries: LogEntry[] = [{ text: `${model.name} running costs`, cashDelta: -model.dailyCost }];
    const cash = state.cash + entries.reduce((sum, e) => sum + e.cashDelta, 0);
    return { state: { ...state, day, cash }, log: [{ day, entries }] };
  }

  function advance(state: GameState, days = 1): AdvanceResult {
    if (!Number.isInteger(days) || days < 1) {
      throw new SimError("bad_days", "Days to advance must be a whole number of at least 1.");
    }
    let current = state;
    const log: DayLog[] = [];
    for (let i = 0; i < days; i++) {
      const result = advanceOneDay(current);
      current = result.state;
      log.push(...result.log);
    }
    return { state: current, log };
  }

  return { config, newGame, advance };
}
