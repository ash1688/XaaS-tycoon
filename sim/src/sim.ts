import { defaultConfig, type GameConfig, type ModelId } from "./config.ts";
import { createCustomers } from "./customers.ts";
import { createEvents, type EventView, type FeatureGapView } from "./events.ts";
import { createFeatures, type FeatureView } from "./features.ts";
import { createFinance, noSpend } from "./finance.ts";
import { createInfrastructure } from "./infrastructure.ts";
import { createMigration, type MigrationQuote, type MigrationView } from "./migration.ts";
import { isNameAllowed } from "./nameFilter.ts";
import { createPricing } from "./pricing.ts";
import { seedRng } from "./rng.ts";
import { createStaff } from "./staff.ts";
import {
  GAME_STATE_VERSION,
  isCurrentState,
  isModelId,
  isProductTypeId,
  SimError,
  type Action,
  type AdvanceResult,
  type DayLog,
  type GameState,
  type LogEntry,
  type NewGameParams,
} from "./state.ts";
import { createSummary, type GameSummary } from "./summary.ts";

// The sim's one public interface is createSim. Its modules are internal; only the types and helpers the server and
// web client need are re-exported here.
export type { EventView, FeatureGapView } from "./events.ts";
export type { FeatureStatus, FeatureView } from "./features.ts";
export type { LostAddon, MigrationQuote, MigrationView } from "./migration.ts";
export type { GameSummary, SummaryDay } from "./summary.ts";
export {
  GAME_STATE_VERSION,
  isCurrentState,
  isModelId,
  isProductTypeId,
  isStaffPool,
  SimError,
  type Action,
  type AdvanceResult,
  type DayLog,
  type DaySpend,
  type EventRecord,
  type FeatureGap,
  type FeatureProgress,
  type GameEnding,
  type GameState,
  type GameStatus,
  type LogEntry,
  type Migration,
  type NewGameParams,
  type ScheduledEvent,
  type Spend,
} from "./state.ts";

export interface Sim {
  readonly config: GameConfig;
  newGame(params: NewGameParams): GameState;
  /**
   * Checks stored state is a game from this version, refusing anything older with an "old_version" SimError, and
   * ends a game that has reached the final day. Every other method loads its state this way first.
   */
  load(saved: unknown): GameState;
  /** Applies a player's action without moving time on. */
  applyAction(state: GameState, action: Action): GameState;
  /** The only way time moves. Continue calls it with 1. */
  advance(state: GameState, days?: number): AdvanceResult;
  /** Ops staff the model needs to keep running. */
  opsNeeded(model: ModelId): number;
  /** What the current headcount costs per day. */
  dailyStaffCost(state: GameState): number;
  /** What the current model costs per month at today's users. */
  monthlyInfrastructureCost(state: GameState): number;
  /** What the active add-ons cost per month at today's users. */
  monthlyAddonCost(state: GameState): number;
  /** What paying users pay per day at today's paid users and price: paid users × price ÷ daysPerMonth. */
  dailyIncome(state: GameState): number;
  /** The monthly price users think the product is worth. Pricing above it slows growth and means fewer new payers. */
  fairPrice(state: GameState): number;
  /** Load the company can serve in a day with its current model and staff. */
  capacity(state: GameState): number;
  /** Share of time up across every day played, as a percentage. 100 before the first day. */
  uptime(state: GameState): number;
  /** The product's features, in config order, with each one's progress. */
  features(state: GameState): FeatureView[];
  /** The migration under way, or null. */
  migration(state: GameState): MigrationView | null;
  /**
   * What migrating to the target would cost, before starting it. Rejects the same targets startMigration does: an
   * unknown model, the current one, or any while a migration is running.
   */
  migrationQuote(state: GameState, target: string): MigrationQuote;
  /** Scripted events that were on during the day just played, each explained, in config order. */
  events(state: GameState): EventView[];
  /** Feature gaps still slowing growth, oldest first. Shown every day, not just the day the event fired. */
  featureGaps(state: GameState): FeatureGapView[];
  /** How the company did: final figures, spend by category, migrations and spend over time. */
  summarise(state: GameState): GameSummary;
}

export function createSim(config: GameConfig = defaultConfig): Sim {
  const events = createEvents(config);
  const features = createFeatures(config);
  const pricing = createPricing(config);
  const customers = createCustomers(config, features, events, pricing);
  const infra = createInfrastructure(config, customers, events);
  const staff = createStaff(config);
  const finance = createFinance(config);
  const migration = createMigration(config, infra, features, events);
  const summary = createSummary(config, infra);

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
    const [schedule, rng] = events.rollSchedule(seedRng(seed), 1);
    const state: GameState = {
      version: GAME_STATE_VERSION,
      status: "playing",
      companyName: name,
      productType,
      model,
      day: 1,
      cash: config.startingCash,
      rng,
      developers: config.staff.developers.startingCount,
      ops: config.staff.ops.startingCount,
      ...customers.startingUsers(productType, 1),
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
    return finance.settle(state, 1, infra.upfrontEntries(model)).state;
  }

  /** Refuses a game from an older version, then ends one played under a config with more days than this one has. */
  function load(saved: unknown): GameState {
    if (!isCurrentState(saved)) {
      throw new SimError(
        "old_version",
        "This game is from an older version of XaaS Tycoon, so it can't be played any more. Start a new company to play again.",
      );
    }
    return saved.status === "playing" && saved.day >= config.finalDay ? { ...saved, status: "finished" } : saved;
  }

  /** Loads saved state and checks the game is still going. */
  function loadPlaying(saved: GameState): GameState {
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

  function applyAction(saved: GameState, action: Action): GameState {
    const state = loadPlaying(saved);
    switch (action.type) {
      case "hire":
      case "letGo":
        return staff.changeStaff(state, action.type, action.pool);
      case "buildFeature":
        return features.startBuild(state, action.feature);
      case "buyAddon":
        return features.buyAddon(state, action.feature);
      case "moveStaff":
        return staff.moveStaff(state, action.to);
      case "startMigration":
        return migration.startMigration(state, action.model);
      case "setPrice":
        return pricing.setPrice(state, action.price);
      default:
        throw new SimError("unknown_action", "That action isn't recognised.");
    }
  }

  function advanceOneDay(start: GameState): AdvanceResult {
    const day = start.day + 1;

    // Scripted events on today. A price rise or feature gap from today counts from today's bill and growth.
    const today = events.eventsToday(start, day);
    const state: GameState = { ...start, ...events.lastingEffects(start, day, today) };

    // Today's load against capacity, then growth, which slows on an outage day.
    const served = infra.serveLoad(state, day, today);
    const { users, paidUsers, rng } = customers.grow(state, day, served.hoursDown > 0, served.rng);

    // Developers work on the current build. A feature finished today helps growth from tomorrow.
    const build = features.buildDay(state);

    // Each event explains itself first, then any outage. Billed on the current model until a migration completes, so
    // the model being left is billed pro rata up to the day you leave. During a migration the new model is billed as
    // well (see migrationCharges).
    const recorded = events.record(state, today, served.overloaded);
    // Income comes from the users paying at the start of the day, at today's price, like the per-user fees.
    const entries: LogEntry[] = [
      ...recorded.entries,
      ...(served.outage ? [served.outage] : []),
      ...build.entries,
      ...pricing.incomeEntries(state),
      ...infra.infrastructureEntries(state, state.model, state.users),
      ...migration.migrationCharges(state),
      ...features.addonEntries(state),
      ...staff.staffEntries(state),
      ...served.charges,
      ...events.costEntries(today),
    ];
    const played: GameState = {
      ...state,
      day,
      rng,
      users,
      paidUsers,
      load: served.load,
      outageDays: state.outageDays + (served.hoursDown > 0 ? 1 : 0),
      downtimeHours: state.downtimeHours + served.hoursDown,
      features: build.features,
      events: recorded.records,
    };
    // The migration moves on after the day is played and billed, so a model switch takes effect from tomorrow.
    const migrated = migration.migrationDay(played);
    entries.push(...migrated.entries);
    const settled = finance.settle(migrated.state, day, entries);
    return { state: settled.state, log: [{ day, entries: settled.entries }] };
  }

  function advance(saved: GameState, days = 1): AdvanceResult {
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
    opsNeeded: infra.opsNeeded,
    dailyStaffCost: (s) => staff.dailyStaffCost(load(s)),
    monthlyInfrastructureCost: (s) => infra.monthlyInfrastructureCost(load(s)),
    monthlyAddonCost: (s) => features.monthlyAddonCost(load(s)),
    dailyIncome: (s) => pricing.dailyIncome(load(s)),
    fairPrice: (s) => pricing.fairPrice(load(s).productType),
    capacity: (s) => infra.capacity(load(s)),
    uptime: (s) => infra.uptime(load(s)),
    features: (s) => features.features(load(s)),
    migration: (s) => migration.migration(load(s)),
    migrationQuote: (s, target) => migration.migrationQuote(load(s), target),
    events: (s) => events.events(load(s)),
    featureGaps: (s) => events.featureGaps(load(s)),
    summarise: (s) => summary.summarise(load(s)),
  };
}
