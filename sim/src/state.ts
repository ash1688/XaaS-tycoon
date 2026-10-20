import {
  MODEL_IDS,
  PRODUCT_TYPE_IDS,
  STAFF_POOLS,
  type MigrationPhase,
  type ModelId,
  type ProductTypeId,
  type SpendCategory,
  type StaffPool,
} from "./config.ts";

/**
 * The game-state version. Saves from any other version are refused rather than upgraded: round two made a clean
 * break, so bump this whenever the shape of GameState changes.
 */
export const GAME_STATE_VERSION = 11;

/** Money spent in each category. */
export type Spend = Record<SpendCategory, number>;

/** What was spent on one day, for the cost-over-time chart, and what came in. */
export interface DaySpend extends Spend {
  day: number;
  /** Income on the day: what paying users paid. */
  income: number;
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
  version: typeof GAME_STATE_VERSION;
  status: GameStatus;
  companyName: string;
  productType: ProductTypeId;
  model: ModelId;
  day: number;
  cash: number;
  rng: number;
  developers: number;
  ops: number;
  /** Support staff: they answer customers' tickets, on every model. */
  support: number;
  /** Every user, paying or free. Free users add load and per-user fees just like paying ones. */
  users: number;
  /** The users who pay. The rest of `users` are on the free tier. */
  paidUsers: number;
  /** The monthly price each paying user pays, a day's share at a time. A change applies from the next day played. */
  price: number;
  /** Everything paying users have paid so far. Not part of spend: profit is income − spend. */
  income: number;
  /** Load on the day just played. */
  load: number;
  outageDays: number;
  /** Total hours down across every day played, for uptime. */
  downtimeHours: number;
  /** Running totals of every charge so far, by category. */
  spend: Spend;
  /** Spend and income on each day played, day 1 (upfront costs) first. */
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
  /** Tickets raised on the day just played, bursts included. */
  ticketsToday: number;
  /** Of today's tickets, those from bursts (outages, and later price backlash). */
  burstTickets: number;
  /** Tickets support cleared on the day just played, from the backlog and today's. */
  clearedToday: number;
  /** Tickets still unanswered at the end of the day just played. They carry over. */
  backlog: number;
  /** Customer satisfaction, 0–100. Moves a share of the way each day towards a target set by the backlog. */
  satisfaction: number;
}

/** Something the player does between days. */
export type Action =
  | { type: "hire"; pool: StaffPool }
  | { type: "letGo"; pool: StaffPool }
  /** Starts building one of the product's features. One build at a time; not on SaaS. */
  | { type: "buildFeature"; feature: string }
  /** Buys one of the product's features as an add-on, active at once. SaaS only, with a configuration team. */
  | { type: "buyAddon"; feature: string }
  /**
   * Moves one person from one pool into another. Any time, including during a migration. Without `from`, a move
   * into developers comes from ops and any other move from developers.
   */
  | { type: "moveStaff"; to: StaffPool; from?: StaffPool }
  /** Starts a migration to another model. One at a time; it runs in the background. */
  | { type: "startMigration"; model: ModelId }
  /** Sets the monthly price paying users pay, from the next day played. Above 0 and at most the configured maximum. */
  | { type: "setPrice"; price: number };

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
  /**
   * Set on entries that need to stand out, such as an outage or bankruptcy. "income" marks money coming in, which the
   * ledger counts as income rather than spend.
   */
  kind?: "outage" | "bankrupt" | "finished" | "feature" | "migration" | "event" | "income" | "support";
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

/** Whether something stored is a game from this version. Anything else is refused, not upgraded. */
export function isCurrentState(saved: unknown): saved is GameState {
  return typeof saved === "object" && saved !== null && (saved as { version?: unknown }).version === GAME_STATE_VERSION;
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
