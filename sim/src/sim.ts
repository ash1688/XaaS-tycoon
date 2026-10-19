import {
  defaultConfig,
  MIGRATION_PHASES,
  MODEL_IDS,
  PRODUCT_TYPE_IDS,
  SPEND_CATEGORIES,
  STAFF_POOLS,
  type EventConfig,
  type EventEffect,
  type EventOutcome,
  type FeatureConfig,
  type GameConfig,
  type MigrationPhase,
  type ModelId,
  type ProductTypeId,
  type SpendCategory,
  type StaffPool,
} from "./config.ts";
import { nextRandom, seedRng } from "./rng.ts";
import { layerOwner, layerResponsibility, type LayerId, type Owner } from "./responsibility.ts";
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
 * entry), so the feature is not started again and can be rebuilt in developer-days from zero.
 *
 * Moving onto SaaS keeps built features: they're your own work, and stay active. A build under way pauses, since on
 * SaaS developers configure add-ons rather than build; it keeps its progress and carries on if you leave SaaS.
 */
export interface FeatureProgress {
  status: "building" | "built" | "addon";
  /** Developer-days of work done so far. Equals the feature's cost once built; 0 for an add-on. */
  progress: number;
}

/**
 * A change of deployment model in progress. It moves through the configured phases a day at a time; the company
 * stays on its current model (and is billed for it) until the last phase ends, then switches to the target.
 */
export interface Migration {
  /** The model being moved to. The model being left is still the state's model. */
  to: ModelId;
  phase: MigrationPhase;
  /** Days done in the current phase. */
  phaseDaysDone: number;
  /** Extra days added to the moving phase by an overrun, rolled when that phase starts. 0 until then. */
  overrunDays: number;
}

/** A day a scripted event fires on, fixed when the game starts. */
export interface ScheduledEvent {
  /** The event's id in config. */
  event: string;
  day: number;
}

/** A scripted event that was on during the day just played, and how it played out. */
export interface EventRecord {
  event: string;
  /** The model it hit: the one the company was running on that day, even if a migration completed that evening. */
  model: ModelId;
  /** Short of the ops staff needed to deal with it. */
  shortOfOps: boolean;
  /** It hurt: it caused downtime, a penalty, a price rise or a feature gap. */
  hit: boolean;
}

/** A feature the platform can't provide (see EventOutcome.featureGap), slowing growth until the company leaves it. */
export interface FeatureGap {
  /** The event that opened it. */
  event: string;
  /** The model it's tied to: completing a migration off it closes the gap. */
  model: ModelId;
}

/**
 * A bankrupt game is over, and so is a finished one: one that has played the configured final day. Either way it
 * accepts no more actions or advances. The final day is the last day played, so a 180-day game plays day 180 in full
 * (billed, with its events) and finishes at the end of it.
 */
export type GameStatus = "playing" | "bankrupt" | "finished";

/** How a game ended, for the summary. */
export type GameEnding = "completed" | "bankrupt";

/** Plain, JSON-serialisable game state. The server stores it as-is. */
export interface GameState {
  version: 8;
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
  /** The migration under way, or null if there isn't one. */
  migration: Migration | null;
  /** Migrations completed, for the end-of-game summary. */
  migrations: number;
  /** When each scripted event fires, in day order. Rolled when the game starts. */
  schedule: ScheduledEvent[];
  /** Scripted events that were on during the day just played. */
  events: EventRecord[];
  /**
   * What provider price rises have done to each model's charges, as a multiplier (1.2 = 20% dearer). Models with no
   * rise yet are missing. Applies to the model's monthly and per-user costs.
   */
  priceRises: Partial<Record<ModelId, number>>;
  /** The same for SaaS add-on prices. 1 until a price rise covers add-ons. */
  addonPriceRise: number;
  /** Features the platform can't provide, each slowing growth until the company migrates off that model. */
  featureGaps: FeatureGap[];
}

/** State saved before provider price rises and feature gaps existed. */
export interface GameStateV7 extends Omit<GameState, "version" | "priceRises" | "addonPriceRise" | "featureGaps"> {
  version: 7;
}

/** State saved before scripted events existed. */
export interface GameStateV6 extends Omit<GameStateV7, "version" | "schedule" | "events"> {
  version: 6;
}

/** State saved before migration existed. */
export interface GameStateV5 extends Omit<GameStateV6, "version" | "migration" | "migrations"> {
  version: 5;
}

/** State saved before features existed. */
export interface GameStateV4 extends Omit<GameStateV5, "version" | "features"> {
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
export type SavedState =
  | GameState
  | GameStateV7
  | GameStateV6
  | GameStateV5 | GameStateV4 | GameStateV3 | GameStateV2 | GameStateV1;

/** Something the player does between days. */
export type Action =
  | { type: "hire"; pool: StaffPool }
  | { type: "letGo"; pool: StaffPool }
  /** Starts building one of the product's features. One build at a time; not on SaaS. */
  | { type: "buildFeature"; feature: string }
  /** Buys one of the product's features as an add-on, active at once. SaaS only, with a configuration team. */
  | { type: "buyAddon"; feature: string }
  /** Moves one person from the other pool into this one. Any time, including during a migration. */
  | { type: "moveStaff"; to: StaffPool }
  /** Starts a migration to another model. One at a time; it runs in the background. */
  | { type: "startMigration"; model: ModelId };

export type FeatureStatus = "notStarted" | FeatureProgress["status"];

/** A feature on the product's list, and how far it has got. */
export interface FeatureView extends FeatureConfig {
  status: FeatureStatus;
  /** Developer-days done so far. */
  progress: number;
  /** Days until a build finishes at today's developers. Null unless building, with no developers, or paused on SaaS. */
  daysLeft: number | null;
}

/** Where a migration has got to, for the screen. */
export interface MigrationView {
  from: ModelId;
  to: ModelId;
  phase: MigrationPhase;
  /** Days left in the current phase. */
  phaseDaysLeft: number;
  /** Days until the model switches. */
  daysLeft: number;
  /** Days the whole migration takes, overrun included. */
  totalDays: number;
  /** Extra days from an overrun, included in the days above. 0 if it hasn't overrun (or not yet). */
  overrunDays: number;
}

/**
 * What a migration is expected to cost, for the student to see before confirming. Every charge in it is
 * infrastructure. Charges with a per-user part are priced at today's users, as they are billed on each day's users;
 * with no overrun and no per-user fees, the quote is exactly what gets charged.
 */
export interface MigrationQuote {
  from: ModelId;
  to: ModelId;
  /** Days the migration takes if it doesn't overrun. The model switches at the end of the last one. */
  days: number;
  /** The new model's upfront cost, charged on the migration's first day. */
  upfrontCost: number;
  /** The new provider's running costs for every day of the migration, on top of the old one's. */
  doubleBilling: number;
  /** The old provider's running costs from the first day of the migration up to the day you leave. */
  proRata: number;
  /** Charged once by the old provider on the day you leave. */
  exitPenalty: number;
  /** Everything above added up. */
  total: number;
  /** The odds of an overrun and how many extra days it can add. Both providers bill for those days too. */
  overrun: { chance: number; minDays: number; maxDays: number };
  /**
   * Vendor lock-in: the add-ons you'd leave behind with the SaaS provider, in config order, and the developer-days
   * each takes to rebuild. Empty unless leaving SaaS. These are today's; any bought before you leave go too.
   */
  lostAddons: LostAddon[];
}

/** An add-on that won't come with you when you leave SaaS. */
export interface LostAddon {
  id: string;
  name: string;
  /** Developer-days to build it yourself on the new model. */
  devDays: number;
}

/** A scripted event that was on during the day just played, explained for the student. */
export interface EventView {
  id: string;
  name: string;
  /** What happened, the same on every model. */
  description: string;
  /** The model it hit. */
  model: ModelId;
  /** The layer of the responsibility stack that decided how it played out, and who owns it on that model. */
  layer: LayerId;
  owner: Owner;
  /** Names the responsible layer and who looks after it: "OS and patching is your job on IaaS." */
  responsibility: string;
  /** How it played out on that model, and why. */
  outcome: string;
  /** Short of the ops staff needed to deal with it. */
  shortOfOps: boolean;
  /** It hurt: it caused downtime, a penalty, a price rise or a feature gap. */
  hit: boolean;
}

/** A feature gap still slowing growth, for the screen to show every day until it closes. */
export interface FeatureGapView {
  /** The event that opened it. */
  id: string;
  name: string;
  /** The feature the company needs and can't have. */
  feature: string;
  /** The model it's tied to: migrating off it closes the gap. */
  model: ModelId;
  /** The layer of the responsibility stack it's about, and who owns it on that model. */
  layer: LayerId;
  owner: Owner;
  /** Growth is multiplied by this every day while it's open. */
  growthMultiplier: number;
  /** Why, and how it ends: the event's explanation on that model. */
  detail: string;
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
  kind?: "outage" | "bankrupt" | "finished" | "feature" | "migration" | "event";
}

export interface DayLog {
  day: number;
  entries: LogEntry[];
}

export interface AdvanceResult {
  state: GameState;
  log: DayLog[];
}

/** What was spent on one day, and the cash left at the end of it. */
export interface SummaryDay extends DaySpend {
  cash: number;
}

/**
 * How a company did, for the end-of-game summary and the teacher's dashboard. Plain and JSON-serialisable, like state.
 * Works on a game still being played too, as a summary so far.
 */
export interface GameSummary {
  companyName: string;
  productType: ProductTypeId;
  /** The model the company ended on. */
  model: ModelId;
  /** How the game ended, or null while it's still being played. */
  ending: GameEnding | null;
  /** The last day played. */
  day: number;
  finalDay: number;
  cash: number;
  users: number;
  /** Share of time up across every day played, as a percentage. */
  uptime: number;
  outageDays: number;
  /** Everything spent, by category. */
  spend: Spend;
  /** The categories added up. */
  totalSpend: number;
  /** Migrations completed. One still under way at the end doesn't count. */
  migrations: number;
  /**
   * Spend on each day played and the cash left after it, day 1 (upfront costs) first: the cost-over-time chart.
   * Games saved before the ledger existed are missing their early days.
   */
  days: SummaryDay[];
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
  /** The migration under way, or null. */
  migration(state: SavedState): MigrationView | null;
  /**
   * What migrating to the target would cost, before starting it. Rejects the same targets startMigration does: an
   * unknown model, the current one, or any while a migration is running.
   */
  migrationQuote(state: SavedState, target: string): MigrationQuote;
  /** Scripted events that were on during the day just played, each explained, in config order. */
  events(state: SavedState): EventView[];
  /** Feature gaps still slowing growth, oldest first. Shown every day, not just the day the event fired. */
  featureGaps(state: SavedState): FeatureGapView[];
  /** How the company did: final figures, spend by category, migrations and spend over time. */
  summarise(state: SavedState): GameSummary;
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

/** Events added with state version 8. Saves from version 7 get a schedule for these only, keeping the rest. */
const EVENTS_ADDED_IN_V8 = ["providerPriceRise", "providerOutage", "saasFeatureGap"];

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
    const [schedule, rng] = rollSchedule(seedRng(seed), 1, config.events);
    const state: GameState = {
      version: 8,
      status: "playing",
      companyName: name,
      productType,
      model,
      day: 1,
      cash: config.startingCash,
      rng,
      developers: config.staff.developers.startingCount,
      ops: config.staff.ops.startingCount,
      ...startingUsers(productType, 1),
      spend: noSpend(),
      spendByDay: [],
      features: {},
      migration: null,
      migrations: 0,
      schedule,
      events: [],
      priceRises: {},
      addonPriceRise: 1,
      featureGaps: [],
    };
    return settle(state, 1, upfrontEntries(model)).state;
  }

  function startingUsers(productType: ProductTypeId, day: number) {
    const users = config.productTypes[productType].growth.startingUsers;
    return { users, load: Math.round(baseLoad(productType, users, day)), outageDays: 0, downtimeHours: 0 };
  }

  /**
   * Upgrades saved state, then ends a game that has reached the final day: one saved before games ended, or one
   * played under a config with more days than this one has.
   */
  function load(saved: SavedState): GameState {
    const state = upgrade(saved);
    return state.status === "playing" && state.day >= config.finalDay ? { ...state, status: "finished" } : state;
  }

  function upgrade(saved: SavedState): GameState {
    if (saved.version === 8) return saved;
    const v7 = saved.version === 7 ? saved : loadV6(saved);
    // Games started before these events existed keep their schedule, and get these events in the days still to come.
    const added = config.events.filter((e) => EVENTS_ADDED_IN_V8.includes(e.id));
    const [more, rng] = rollSchedule(v7.rng, v7.day, added);
    const schedule = [...v7.schedule, ...more].sort((a, b) => a.day - b.day);
    return { ...v7, version: 8, rng, schedule, priceRises: {}, addonPriceRise: 1, featureGaps: [] };
  }

  function loadV6(saved: Exclude<SavedState, GameState | GameStateV7>): GameStateV7 {
    const v6 = saved.version === 6 ? saved : loadV5(saved);
    // Games started before events existed get their schedule now, from the days still to come.
    const older = config.events.filter((e) => !EVENTS_ADDED_IN_V8.includes(e.id));
    const [schedule, rng] = rollSchedule(v6.rng, v6.day, older);
    return { ...v6, version: 7, rng, schedule, events: [] };
  }

  function loadV5(saved: Exclude<SavedState, GameState | GameStateV7 | GameStateV6>): GameStateV6 {
    const v5 = saved.version === 5 ? saved : loadV4(saved);
    // Games started before migration existed have never migrated.
    return { ...v5, version: 6, migration: null, migrations: 0 };
  }

  function loadV4(saved: GameStateV4 | GameStateV3 | GameStateV2 | GameStateV1): GameStateV5 {
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
    if (state.status === "finished") {
      throw new SimError(
        "finished",
        `${state.companyName} has played all ${config.finalDay} days, so this game is over. Start a new company to play again.`,
      );
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
      case "moveStaff":
        return moveStaff(state, action.to);
      case "startMigration":
        return startMigration(state, action.model);
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

  function moveStaff(state: GameState, to: StaffPool): GameState {
    if (!isStaffPool(to)) throw new SimError("unknown_pool", "Pick developers or ops.");
    const from = STAFF_POOLS.find((pool) => pool !== to)!;
    if (state[from] < 1) {
      throw new SimError("no_staff", `You have no ${config.staff[from].name.toLowerCase()} to move.`);
    }
    return { ...state, [from]: state[from] - 1, [to]: state[to] + 1 };
  }

  /** Checks a migration to this model can start, and returns it as a model id. */
  function migrationTarget(state: GameState, to: string): ModelId {
    if (!isModelId(to)) throw new SimError("unknown_model", "Pick a deployment model from the list.");
    if (state.migration) {
      const { name } = config.models[state.migration.to];
      throw new SimError("migration_running", `You're already migrating to ${name}. Finish that first.`);
    }
    if (to === state.model) throw new SimError("same_model", `You're already on ${config.models[to].name}.`);
    return to;
  }

  function startMigration(state: GameState, model: string): GameState {
    const to = migrationTarget(state, model);
    return { ...state, migration: { to, phase: MIGRATION_PHASES[0], phaseDaysDone: 0, overrunDays: 0 } };
  }

  /** What a day of a model's running costs comes to, on the given users. */
  const dailyInfrastructure = (state: GameState, modelId: ModelId, users: number) =>
    -infrastructureEntries(state, modelId, users).reduce((sum, e) => sum + e.cashDelta, 0);

  function migrationQuote(saved: SavedState, target: string): MigrationQuote {
    const state = load(saved);
    const to = migrationTarget(state, target);
    const days = MIGRATION_PHASES.reduce((sum, p) => sum + config.migration.phases[p].days, 0);
    // Priced by the same daily rules advanceOneDay bills by, so the rounding matches too.
    const upfrontCost = config.models[to].upfrontCost;
    const doubleBilling = config.migration.billNewFromStart ? days * dailyInfrastructure(state, to, state.users) : 0;
    const proRata = days * dailyInfrastructure(state, state.model, state.users);
    const exitPenalty = config.models[state.model].exitPenalty;
    const { chance, minDays, maxDays } = config.migration.overrun;
    const lostAddons = addonsLeftBehind(state, to).map(({ id, name, devDays }) => ({ id, name, devDays }));
    return {
      from: state.model,
      to,
      days,
      upfrontCost,
      doubleBilling,
      proRata,
      exitPenalty,
      total: upfrontCost + doubleBilling + proRata + exitPenalty,
      overrun: { chance, minDays, maxDays },
      lostAddons,
    };
  }

  /**
   * The migration's own charges for a day, on top of the current model's bill: the new model's upfront cost on the
   * first day, and (if config says so) the new provider's running costs in full from that day to the switch.
   */
  function migrationCharges(state: GameState): LogEntry[] {
    const m = state.migration;
    if (!m) return [];
    const firstDay = m.phase === MIGRATION_PHASES[0] && m.phaseDaysDone === 0;
    const running = config.migration.billNewFromStart
      ? infrastructureEntries(state, m.to, state.users).map((e) => ({ ...e, text: `Double billing: ${e.text}` }))
      : [];
    return [...(firstDay ? upfrontEntries(m.to) : []), ...running];
  }

  /** A seeded roll for whether a migration overruns, and by how many days. Always draws once, then again if so. */
  function rollOverrun(rng: number): [days: number, next: number] {
    const { chance, minDays, maxDays } = config.migration.overrun;
    const [r, afterChance] = nextRandom(rng);
    if (r >= chance) return [0, afterChance];
    const [d, next] = nextRandom(afterChance);
    return [minDays + Math.floor(d * (maxDays - minDays + 1)), next];
  }

  /** How long a phase of this migration takes: the configured days, plus any overrun on the moving phase. */
  function phaseLength(m: Migration, phase: MigrationPhase): number {
    return config.migration.phases[phase].days + (phase === "moving" ? m.overrunDays : 0);
  }

  function migration(saved: SavedState): MigrationView | null {
    const state = load(saved);
    const m = state.migration;
    if (!m) return null;
    const later = MIGRATION_PHASES.slice(MIGRATION_PHASES.indexOf(m.phase) + 1);
    const phaseDaysLeft = phaseLength(m, m.phase) - m.phaseDaysDone;
    const daysLeft = later.reduce((sum, p) => sum + phaseLength(m, p), phaseDaysLeft);
    const totalDays = MIGRATION_PHASES.reduce((sum, p) => sum + phaseLength(m, p), 0);
    const { overrunDays } = m;
    return { from: state.model, to: m.to, phase: m.phase, phaseDaysLeft, daysLeft, totalDays, overrunDays };
  }

  /**
   * A day's work on the migration, after the day has been played and billed on the current model. Moves to the next
   * phase when one ends, logging it, and switches the model when the last one ends.
   */
  function migrationDay(state: GameState): { state: GameState; entries: LogEntry[] } {
    const m = state.migration;
    if (!m) return { state, entries: [] };
    const toName = config.models[m.to].name;
    const phaseDaysDone = m.phaseDaysDone + 1;
    if (phaseDaysDone < phaseLength(m, m.phase)) {
      return { state: { ...state, migration: { ...m, phaseDaysDone } }, entries: [] };
    }
    const done = config.migration.phases[m.phase].name;
    const next = MIGRATION_PHASES[MIGRATION_PHASES.indexOf(m.phase) + 1];
    if (next) {
      // Migrations slip while moving: roll for an overrun as that phase starts.
      const [extraDays, rng] = next === "moving" ? rollOverrun(state.rng) : [0, state.rng];
      const moved: Migration = { ...m, phase: next, phaseDaysDone: 0, overrunDays: m.overrunDays + extraDays };
      const days = phaseLength(moved, next);
      const nextName = config.migration.phases[next].name;
      const text = `Migration to ${toName}: ${done} done. ${nextName} next, ${days} day${days === 1 ? "" : "s"}.`;
      const entries: LogEntry[] = [{ text, cashDelta: 0, kind: "migration" }];
      if (extraDays > 0) {
        const extra = `${extraDays} extra day${extraDays === 1 ? "" : "s"}`;
        const overrun = `Migration overrun: ${nextName.toLowerCase()} will take ${extra}, billed by both providers.`;
        entries.push({ text: overrun, cashDelta: 0, kind: "migration" });
      }
      return { state: { ...state, rng, migration: moved }, entries };
    }
    const switched: GameState = { ...state, model: m.to, migration: null, migrations: state.migrations + 1 };
    const needed = opsNeeded(m.to);
    const left = config.models[state.model];
    const entries: LogEntry[] = [
      {
        text: `Migration complete: you're now on ${toName}, which needs ${needed} ops staff.`,
        cashDelta: 0,
        kind: "migration",
      },
    ];
    // Charged once, on the day you leave. The old provider's pro-rata share for today was billed with the rest.
    if (left.exitPenalty > 0) {
      const text = `Exit penalty: leaving ${left.name}`;
      entries.push({ text, cashDelta: -left.exitPenalty, category: "infrastructure" });
    }
    // Vendor lock-in. Add-ons belong to the SaaS provider, so they stay active and billed for the whole migration
    // (you're still on SaaS, paying for both setups) and are left behind on the day you leave: billing and their
    // growth effect stop, and they're not started again, ready to rebuild in developer-days from zero.
    const lost = addonsLeftBehind(state, m.to);
    if (lost.length) {
      const features = { ...state.features };
      for (const f of lost) delete features[f.id];
      switched.features = features;
      const names = lost.map((f) => f.name).join(", ");
      const devDays = lost.reduce((sum, f) => sum + f.devDays, 0);
      const text =
        `Vendor lock-in: your add-ons stayed with the SaaS provider (${names}). ` +
        `Rebuild them in developer-days to get them back: ${devDays} in all.`;
      entries.push({ text, cashDelta: 0, kind: "migration" });
    }
    // Off the model a feature gap is tied to, you can build what you like, so the gap closes.
    const closed = state.featureGaps.filter((g) => g.model === state.model);
    if (closed.length) {
      switched.featureGaps = state.featureGaps.filter((g) => g.model !== state.model);
      for (const g of closed) {
        const feature = gapFeature(state, g);
        if (feature === undefined) continue;
        const text = `Feature gap closed: off ${left.name}, you're free to build ${feature} yourself. Growth is back to normal.`;
        entries.push({ text, cashDelta: 0, kind: "migration" });
      }
    }
    // Onto SaaS, a build under way pauses: developers there configure add-ons rather than build.
    const paused = m.to === "saas" ? currentBuild(state) : undefined;
    if (paused) {
      const text = `${paused.name} build paused: on SaaS you buy features as add-ons. It carries on if you leave SaaS.`;
      entries.push({ text, cashDelta: 0, kind: "feature" });
    }
    return { state: switched, entries };
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

  /**
   * A day's work on the current build: one developer-day per developer. Logs progress, or completion. A build is
   * paused on SaaS (it only gets there by migrating mid-build).
   */
  function buildDay(state: GameState): { features: GameState["features"]; entries: LogEntry[] } {
    const feature = currentBuild(state);
    if (!feature || state.model === "saas") return { features: state.features, entries: [] };
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
        status === "building" && state.developers > 0 && state.model !== "saas" ? Math.ceil((f.devDays - progress) / state.developers) : null;
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

  /** A price after any provider price rises, to the penny. */
  const risen = (price: number, rise: number) => Math.round(price * rise * 100) / 100;

  /** A model's monthly and per-user prices, after any provider price rises. */
  function modelPrices(state: GameState, modelId: ModelId) {
    const rise = state.priceRises[modelId] ?? 1;
    const { monthlyCost, monthlyCostPerUser } = config.models[modelId];
    return { monthlyCost: risen(monthlyCost, rise), monthlyCostPerUser: risen(monthlyCostPerUser, rise) };
  }

  /**
   * A model's running costs for some days: its monthly cost, plus its per-user cost on the given users, each billed
   * as days ÷ daysPerMonth of a month and rounded to the pound. Advance bills one day at a time; billing part of a
   * month (say when leaving a model) uses the same rule. Prices include any provider price rises.
   */
  function infrastructureEntries(state: GameState, modelId: ModelId, users: number, days = 1): LogEntry[] {
    const { name } = config.models[modelId];
    const { monthlyCost, monthlyCostPerUser } = modelPrices(state, modelId);
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

  /** The add-ons a migration to this model would leave behind: all of them when leaving SaaS, none otherwise. */
  const addonsLeftBehind = (state: GameState, to: ModelId) =>
    state.model === "saas" && to !== "saas" ? activeAddons(state) : [];

  /** Each active add-on's per-user price on the given users, billed like the model's per-user fee, after price rises. */
  function addonEntries(state: GameState, days = 1): LogEntry[] {
    const share = days / config.billing.daysPerMonth;
    return activeAddons(state).map((f) => {
      const price = risen(f.addonPricePerUser, state.addonPriceRise);
      return {
        text: `Add-on: ${f.name} (${count.format(state.users)} users at ${pounds(price)} a month)`,
        cashDelta: -Math.round(state.users * price * share),
        category: "addons",
      };
    });
  }

  function monthlyAddonCost(saved: SavedState): number {
    const state = load(saved);
    const perUser = activeAddons(state).reduce((sum, f) => sum + risen(f.addonPricePerUser, state.addonPriceRise), 0);
    return Math.round(state.users * perUser);
  }

  function monthlyInfrastructureCost(saved: SavedState): number {
    const state = load(saved);
    const { monthlyCost, monthlyCostPerUser } = modelPrices(state, state.model);
    return Math.round(monthlyCost + state.users * monthlyCostPerUser);
  }

  /**
   * The ledger. Applies a day's entries to cash, adds each charge to its category's running total and the day's
   * spend, and ends the game if cash has gone below zero or this was the final day. Returns the entries with any
   * notice of the end added. Going bankrupt on the final day counts as bankrupt.
   */
  function settle(state: GameState, day: number, entries: LogEntry[]): { state: GameState; entries: LogEntry[] } {
    const daySpend = noSpend();
    for (const e of entries) if (e.category) daySpend[e.category] -= e.cashDelta;
    const spend = noSpend();
    for (const c of SPEND_CATEGORIES) spend[c] = state.spend[c] + daySpend[c];
    const cash = state.cash + entries.reduce((sum, e) => sum + e.cashDelta, 0);
    const settled: GameState = { ...state, cash, spend, spendByDay: [...state.spendByDay, { day, ...daySpend }] };
    if (cash < 0) {
      return {
        state: { ...settled, status: "bankrupt" },
        entries: [
          ...entries,
          { text: `Cash ran out: ${state.companyName} is bankrupt. Game over.`, cashDelta: 0, kind: "bankrupt" },
        ],
      };
    }
    if (day >= config.finalDay) {
      const text = `Day ${day} was the last: ${state.companyName} made it to the end. See how you did in the summary.`;
      return { state: { ...settled, status: "finished" }, entries: [...entries, { text, cashDelta: 0, kind: "finished" }] };
    }
    return { state: settled, entries };
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

  /** Capacity with the current model and staff, before any event scales it. */
  function baseCapacity(state: GameState): number {
    const base = config.models[state.model].capacity;
    return Math.round(capacityFactors(state).reduce((c, f) => c * f, base));
  }

  /** As baseCapacity, but on a day an event scaled the company up, capacity met that day's load. */
  function capacity(saved: SavedState): number {
    const state = load(saved);
    const scaled = state.events.some((r) => {
      const event = eventConfig(r.event);
      return event?.load && outcomeFor(event, r.model, r.shortOfOps).scaleCostPerLoad !== undefined;
    });
    return scaled ? Math.max(baseCapacity(state), state.load) : baseCapacity(state);
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
      // Each feature the platform can't provide.
      ...state.featureGaps.map((g) => gapOutcome(g)?.featureGap?.growthMultiplier ?? 1),
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

  const eventConfig = (id: string) => config.events.find((e) => e.id === id);

  /**
   * The days each event fires on, in day order. Fixed days come from config; seeded ones are picked with the RNG,
   * drawing once per day picked. Only days after afterDay are kept, as the game has already played the rest.
   */
  function rollSchedule(
    rng: number,
    afterDay: number,
    events: EventConfig[],
  ): [schedule: ScheduledEvent[], next: number] {
    const schedule: ScheduledEvent[] = [];
    for (const event of events) {
      const when = event.schedule;
      let days = when.type === "fixed" ? when.days : [];
      if (when.type === "seeded") {
        // A partial shuffle of the days in range, so each pick is a different day.
        const range = Array.from({ length: Math.max(0, when.toDay - when.fromDay + 1) }, (_, i) => when.fromDay + i);
        for (let i = 0; i < Math.min(when.count, range.length); i++) {
          const [r, next] = nextRandom(rng);
          rng = next;
          const j = i + Math.floor(r * (range.length - i));
          [range[i], range[j]] = [range[j]!, range[i]!];
        }
        days = range.slice(0, when.count);
      }
      schedule.push(...days.filter((day) => day > afterDay).map((day) => ({ event: event.id, day })));
    }
    // A stable sort, so events on the same day keep config order.
    return [schedule.sort((a, b) => a.day - b.day), rng];
  }

  /**
   * Events on during a day for a company on this model: each one that fired that day or recently enough to last until
   * it, and has an effect on the model. In config order.
   */
  function eventsOn(state: GameState, day: number, model: ModelId): EventConfig[] {
    return config.events.filter(
      (e) => e.effects[model] && state.schedule.some((s) => s.event === e.id && day >= s.day && day < s.day + e.days),
    );
  }

  const NO_EFFECT: EventEffect = { detail: "" };

  /** How an event plays out on a model, short of ops or not. */
  function outcomeFor(event: EventConfig, model: ModelId, shortOfOps: boolean): EventOutcome {
    const effect = event.effects[model] ?? NO_EFFECT;
    return shortOfOps && effect.shortOfOps ? effect.shortOfOps : effect;
  }

  /** The outcome that opened a feature gap, if its event is still in config. */
  function gapOutcome(gap: FeatureGap): EventOutcome | undefined {
    const event = eventConfig(gap.event);
    return event && outcomeFor(event, gap.model, false);
  }

  /** The feature a gap is about, for this company's product. */
  const gapFeature = (state: GameState, gap: FeatureGap) => gapOutcome(gap)?.featureGap?.features[state.productType];

  /** What an outcome does that lasts beyond the day, put first in its explanation. */
  function lastingNote(outcome: EventOutcome, productType: ProductTypeId): string {
    const notes: string[] = [];
    if (outcome.priceRise) {
      const { percent, addons } = outcome.priceRise;
      notes.push(`Its prices are up ${percent}% from today${addons ? ", add-ons included" : ""}.`);
    }
    if (outcome.featureGap) {
      const feature = outcome.featureGap.features[productType];
      const slower = Math.round(100 * (1 - outcome.featureGap.growthMultiplier));
      notes.push(`Your customers want ${feature}, and no add-on offers it. Growth is ${slower}% slower without it.`);
    }
    return notes.map((n) => `${n} `).join("");
  }

  function explain(
    event: EventConfig,
    { model, shortOfOps, hit }: Omit<EventRecord, "event">,
    productType: ProductTypeId,
  ): EventView {
    const { id, name, description, layer } = event;
    const needed = event.effects[model]?.opsNeeded;
    const result = outcomeFor(event, model, shortOfOps);
    const detail = lastingNote(result, productType) + result.detail;
    const outcome = shortOfOps ? `${detail} You needed ${needed} ops staff.` : detail;
    const owner = layerOwner(model, layer);
    const responsibility = layerResponsibility(model, layer);
    return { id, name, description, model, layer, owner, responsibility, outcome, shortOfOps, hit };
  }

  function events(saved: SavedState): EventView[] {
    const state = load(saved);
    // An event taken out of config since the day was played has nothing left to explain it.
    return state.events.flatMap((r) => {
      const event = eventConfig(r.event);
      return event ? [explain(event, r, state.productType)] : [];
    });
  }

  function featureGaps(saved: SavedState): FeatureGapView[] {
    const state = load(saved);
    // A gap whose event was taken out of config no longer slows growth either, so there's nothing to show.
    return state.featureGaps.flatMap((g) => {
      const event = eventConfig(g.event);
      const gap = gapOutcome(g)?.featureGap;
      if (!event || !gap) return [];
      const feature = gap.features[state.productType];
      const { id, name, layer } = event;
      const { detail } = outcomeFor(event, g.model, false);
      const owner = layerOwner(g.model, layer);
      return [{ id, name, feature, model: g.model, layer, owner, growthMultiplier: gap.growthMultiplier, detail }];
    });
  }

  /**
   * Price rises and feature gaps from events that fire today. They last: they apply from today's bill and growth on,
   * so they're applied before the day is played. Each applies once, on the day its event fires.
   */
  function lastingEffects(state: GameState, day: number, today: { event: EventConfig; outcome: EventOutcome }[]) {
    let { priceRises, addonPriceRise, featureGaps } = state;
    for (const { event, outcome } of today) {
      if (!state.schedule.some((s) => s.event === event.id && s.day === day)) continue;
      if (outcome.priceRise) {
        const rise = 1 + outcome.priceRise.percent / 100;
        priceRises = { ...priceRises, [state.model]: (priceRises[state.model] ?? 1) * rise };
        if (outcome.priceRise.addons) addonPriceRise *= rise;
      }
      if (outcome.featureGap && !featureGaps.some((g) => g.event === event.id && g.model === state.model)) {
        featureGaps = [...featureGaps, { event: event.id, model: state.model }];
      }
    }
    return { priceRises, addonPriceRise, featureGaps };
  }

  function advanceOneDay(start: GameState): AdvanceResult {
    const day = start.day + 1;
    const profile = config.productTypes[start.productType].growth;

    // Scripted events on today, and how each plays out on the current model with today's ops.
    const today = eventsOn(start, day, start.model).map((event) => {
      const needed = event.effects[start.model]?.opsNeeded;
      const shortOfOps = needed !== undefined && start.ops < needed;
      return { event, shortOfOps, outcome: outcomeFor(event, start.model, shortOfOps) };
    });
    // A price rise or feature gap from today counts from today's bill and growth.
    const state: GameState = { ...start, ...lastingEffects(start, day, today) };

    // Today's load comes from the users at the start of the day, plus any an event brings.
    const [loadVariation, afterLoad] = vary(state.rng, profile.loadNoise);
    let load = Math.round(baseLoad(state.productType, state.users, day) * loadVariation);
    const scaling: { event: EventConfig; extraLoad: number; costPerLoad: number }[] = [];
    for (const { event, outcome } of today) {
      if (!event.load) continue;
      const before = load;
      load = Math.round(load * event.load.multiplier + event.load.extra);
      const costPerLoad = outcome.scaleCostPerLoad;
      if (costPerLoad !== undefined) scaling.push({ event, extraLoad: load - before, costPerLoad });
    }
    // A model that scales grows to meet the load; otherwise the usual capacity rules decide whether there's an outage.
    const cap = scaling.length ? Math.max(baseCapacity(state), load) : baseCapacity(state);
    const overloaded = load > cap;
    const { baseHours, hoursPerOverload } = config.outage;
    const overloadHours = overloaded ? Math.ceil(baseHours + hoursPerOverload * (load / cap - 1)) : 0;
    const eventHours = today.reduce((sum, t) => sum + (t.outcome.downtimeHours ?? 0), 0);
    const hoursDown = Math.min(24, overloadHours + eventHours);
    const outage = hoursDown > 0;

    // Growth slows as the market fills up, and on an outage day.
    const [growthVariation, rng] = vary(afterLoad, profile.growthNoise);
    const rate = growthFactors(state, day, outage).reduce(
      (r, f) => r * f,
      profile.dailyGrowth * (1 - state.users / profile.marketSize) * growthVariation,
    );
    const users = Math.max(0, state.users + Math.round(state.users * rate));

    // Developers work on the current build. A feature finished today helps growth from tomorrow.
    const build = buildDay(state);

    // Billed on the current model until a migration completes, so the model being left is billed pro rata up to the
    // day you leave. During a migration the new model is billed as well (see migrationCharges).
    const entries: LogEntry[] = [
      ...build.entries,
      ...infrastructureEntries(state, state.model, state.users),
      ...migrationCharges(state),
      ...addonEntries(state),
      ...staffEntries(state),
    ];
    // Charges for scaling up to meet an event, or for the damage it did.
    for (const { event, extraLoad, costPerLoad } of scaling) {
      const cost = Math.round(extraLoad * costPerLoad);
      if (cost > 0) {
        const text = `${event.name}: scaled up for ${count.format(extraLoad)} extra load`;
        entries.push({ text, cashDelta: -cost, category: "infrastructure" });
      }
    }
    for (const { event, outcome } of today) {
      if (outcome.cost) {
        const text = `${event.name}: ${outcome.cost.text}`;
        entries.push({ text, cashDelta: -outcome.cost.amount, category: "infrastructure" });
      }
    }
    if (outage) {
      const percent = Math.round((100 * load) / cap);
      const cause = overloaded
        ? `load hit ${percent}% of capacity`
        : today.find((t) => t.outcome.downtimeHours)!.event.name;
      entries.unshift({
        text: `Outage: ${cause}. Down ${hoursDown} hours; growth slowed.`,
        cashDelta: 0,
        kind: "outage",
      });
    }
    // Each event explains itself first: what happened, whose job it is on this model, and how it played out.
    const records: EventRecord[] = today.map(({ event, shortOfOps, outcome }) => ({
      event: event.id,
      model: state.model,
      shortOfOps,
      hit:
        !!outcome.downtimeHours ||
        !!outcome.cost ||
        !!outcome.priceRise ||
        !!outcome.featureGap ||
        (overloaded && !!event.load),
    }));
    entries.unshift(
      ...today.map(({ event }, i): LogEntry => {
        const { name, responsibility, outcome } = explain(event, records[i]!, state.productType);
        return { text: `${name}: ${responsibility} ${outcome}`, cashDelta: 0, kind: "event" };
      }),
    );
    const played: GameState = {
      ...state,
      day,
      rng,
      users,
      load,
      outageDays: state.outageDays + (outage ? 1 : 0),
      downtimeHours: state.downtimeHours + hoursDown,
      features: build.features,
      events: records,
    };
    // The migration moves on after the day is played and billed, so a model switch takes effect from tomorrow.
    const migrated = migrationDay(played);
    entries.push(...migrated.entries);
    const settled = settle(migrated.state, day, entries);
    return { state: settled.state, log: [{ day, entries: settled.entries }] };
  }

  function summarise(saved: SavedState): GameSummary {
    const state = load(saved);
    const total = (s: Spend) => SPEND_CATEGORIES.reduce((sum, c) => sum + s[c], 0);
    // Only charges move cash (there's no revenue in the alpha), so the cash after each day is today's cash plus
    // everything spent since. That works for saves whose series is missing its early days, too.
    let cash = state.cash;
    const days: SummaryDay[] = [];
    for (let i = state.spendByDay.length - 1; i >= 0; i--) {
      const d = state.spendByDay[i]!;
      days.unshift({ ...d, cash });
      cash += total(d);
    }
    const ending = state.status === "playing" ? null : state.status === "bankrupt" ? "bankrupt" : "completed";
    return {
      companyName: state.companyName,
      productType: state.productType,
      model: state.model,
      ending,
      day: state.day,
      finalDay: config.finalDay,
      cash: state.cash,
      users: state.users,
      uptime: uptime(state),
      outageDays: state.outageDays,
      spend: { ...state.spend },
      totalSpend: total(state.spend),
      migrations: state.migrations,
      days,
    };
  }

  function advance(saved: SavedState, days = 1): AdvanceResult {
    if (!Number.isInteger(days) || days < 1) {
      throw new SimError("bad_days", "Days to advance must be a whole number of at least 1.");
    }
    let current = loadPlaying(saved);
    const log: DayLog[] = [];
    // Stops early if the game ends part-way through: bankrupt, or the final day played.
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
    migration,
    migrationQuote,
    events,
    featureGaps,
    summarise,
  };
}
