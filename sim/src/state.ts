import {
  MANAGED_SERVICES,
  MODEL_IDS,
  PRODUCT_TYPE_IDS,
  SERVER_SIZES,
  SERVER_TYPES,
  STAFF_POOLS,
  type ManagedService,
  type MigrationPhase,
  type ModelId,
  type ProductTypeId,
  type ServerSize,
  type ServerType,
  type SpendCategory,
  type StaffPool,
} from "./config.ts";

/**
 * The game-state version. Saves from any other version are refused rather than upgraded: round two made a clean
 * break, so bump this whenever the shape of GameState changes.
 */
export const GAME_STATE_VERSION = 22;

/** Money spent in each category. */
export type Spend = Record<SpendCategory, number>;

/** What was spent on one day, for the cost-over-time chart, what came in, and where the customers stood after it. */
export interface DaySpend extends Spend {
  day: number;
  /** Income on the day: what paying users paid. */
  income: number;
  /** Money borrowed on the day: the bank loan, if it was taken then. Not income: it's paid back as debt. */
  borrowed: number;
  /** Users at the end of the day, paying or free, for the summary's peak. */
  users: number;
  /** Of them, those paying. */
  paidUsers: number;
  /** Customer satisfaction at the end of the day, 0–100, for the summary's average. */
  satisfaction: number;
}

/**
 * The company's bank loan. It's repaid in equal daily repayments (debt), from the day after it's taken to the final
 * day, whatever happens. See LoanConfig for how the rate and repayment are set.
 */
export interface Loan {
  amount: number;
  /** The day it was taken: 1 if taken when the game started. */
  day: number;
  /** Interest as a share of the amount (0.1 = 10%), set by the day it was taken. */
  rate: number;
  /** Charged on every day played after `day`, to the final day. */
  dailyRepayment: number;
  /** Everything to repay: the amount plus interest, dailyRepayment × the days to repay it. */
  total: number;
  /** Repaid so far. */
  repaid: number;
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
  /**
   * The setup being built on the target model, sized to demand when the migration started (see sizeSetupFor). Rented
   * servers are billed from the migration's first day; bought ones are paid for then and on order until they arrive.
   * They serve only once the model switches, when they become the company's servers.
   */
  servers: Server[];
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
 * What a price wave does on one of its days, or over all of them. A rise makes paying users leave or drop to free and
 * raises backlash tickets; a cut brings new users and turns free users into payers.
 */
export interface WaveEffect {
  /** Paying users who leave altogether. */
  left: number;
  /** Paying users who drop to the free tier. */
  toFree: number;
  /** New users who join. */
  joined: number;
  /** Of the new users, those who pay. */
  joinedPaid: number;
  /** Free users who start paying. */
  upgraded: number;
  /** Backlash support tickets. */
  tickets: number;
}

/**
 * A price change's wave of reactions. Planned in full when the price changes, from the users then, so the preview
 * shows exactly what happens if nothing else changes; each day applies its share.
 */
export interface PriceWave {
  direction: "rise" | "cut";
  from: number;
  to: number;
  /** The first day played at the new price: the wave's day 1. */
  firstDay: number;
  /** The plan: what each day of the wave does, day 1 first. */
  days: WaveEffect[];
  /** What it has done so far. Less than the plan only where users had already gone. */
  done: WaveEffect;
}

/**
 * A server the company has, on a model with servers: a rented VM on IaaS, billed from the first day played after it's
 * added until it's cancelled; or kit bought on-prem, paid for up front and on order until it arrives.
 */
export interface Server {
  /** Unique within the game, for cancelling or selling it. */
  id: number;
  type: ServerType;
  size: ServerSize;
  /** Ready at the end of this day: it serves load on every day played after it. Bought kit arrives on this day. */
  readyDay: number;
  /** What it was bought for, on a model that buys its servers. Selling it back refunds a share of this. */
  paid?: number;
  /** An app server switched from giving CU to giving APIU, for the paid API's calls. Left out while it gives CU. */
  apiu?: boolean;
}

/**
 * The company's paid API, once bought. Traffic is the calls a day developers make; each day it moves towards a target
 * set by paying users and features (see ApiConfig).
 */
export interface ApiState {
  /** Calls a day developers make now: what the next day played brings, before any are dropped. */
  calls: number;
  /** Calls served on the day just played: each earned its price. */
  served: number;
  /** Calls dropped on the day just played: beyond the APIU, or while the service was down. */
  dropped: number;
  /** After an outage, API growth is slow until this day has been played. 0 before any outage. */
  slowUntil: number;
}

/** CU and DBU demand on the day just played: what every user needed, before any cache. */
export interface UnitDemand {
  cu: number;
  dbu: number;
  /** APIU the paid API's calls need, when sizing a setup. Left out of the day's demand and with no API. */
  apiu?: number;
}

/** A price change, for the summary. */
export interface PriceChange {
  /** The first day played at the new price. */
  day: number;
  from: number;
  to: number;
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
  /**
   * The day the company launched: its first users arrived at the end of it, the first day of the launch ramp. Null until
   * then, when it has no users (see LaunchConfig).
   */
  launchDay: number | null;
  /**
   * The launch total: users who trickle in over the launch ramp, drawn from the product's range when the game starts.
   * Kept from the student: the screens show only those who have joined.
   */
  launchUsers: number;
  /** Every user, paying or free. Free users add load and per-user fees just like paying ones. */
  users: number;
  /** The users who pay. The rest of `users` are on the free tier. */
  paidUsers: number;
  /** The monthly price each paying user pays, a day's share at a time. A change applies from the next day played. */
  price: number;
  /** The wave from the last price change, kept after it ends; null before any change. */
  priceWave: PriceWave | null;
  /** The price can't be changed again until this day has been played. 0 before any change. */
  priceLockedUntil: number;
  /** Every price change made, oldest first. */
  priceChanges: PriceChange[];
  /** Everything paying users have paid so far. Not part of spend: profit is income − spend. */
  income: number;
  /** Load on the day just played. Over the launch ramp, the usual load of the users there now: what tomorrow brings. */
  load: number;
  /**
   * CU and DBU demand on the day just played, on any model. Only a model with servers serves it in units. Over the
   * launch ramp, the usual demand of the users there now.
   */
  demand: UnitDemand;
  /** The servers the company has, ready or not, oldest first. Empty on a model without servers. */
  servers: Server[];
  /** The id the next server added gets. */
  nextServerId: number;
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
  /** The bank loan once taken, kept once repaid, or null. One per company. */
  loan: Loan | null;
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
  /** Hours down on each of the last days played, oldest first, up to conversion.uptimeDays: recent uptime. */
  recentHoursDown: number[];
  /** Free users who started paying on the day just played (not counting a price wave's upgrades). */
  conversionsToday: number;
  /** Free users who have started paying in all, the same way. */
  conversions: number;
  /** The paid API, once bought: null until then, and on a product without one. */
  api: ApiState | null;
}

/** Something the player does between days. */
export type Action =
  /** Hires or lets go people in one pool: `count` of them, one if it's left out. */
  | { type: "hire"; pool: StaffPool; count?: number }
  | { type: "letGo"; pool: StaffPool; count?: number }
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
  | { type: "setPrice"; price: number }
  /** Rents a VM of a type and size, on IaaS. Billed monthly from the next day played, and ready the next day. */
  | { type: "rentServer"; server: ServerType; size: ServerSize }
  /** Cancels a rented VM, ready or not. Its rent stops: you pay only for the days you had it. */
  | { type: "cancelServer"; id: number }
  /**
   * Buys a server of a type and size, on-prem. Its price is charged at once (infrastructure). It's on order until it
   * arrives after the delivery time, adding no capacity until then. An order can't be cancelled.
   */
  | { type: "buyServer"; server: ServerType; size: ServerSize }
  /** Sells back a bought server that has arrived, refunding the configured share of what it cost, at once. */
  | { type: "sellServer"; id: number }
  /**
   * Sets how many app instances run, on PaaS: from 1 to the platform's most. The change is instant, serving from the
   * next day played, and billed monthly a day's share at a time from then.
   */
  | { type: "setInstances"; count: number }
  /**
   * Sets the size of a managed service on PaaS, at once, like an instance count. The cache can be turned off with
   * a null size; the database can't.
   */
  | { type: "setManagedService"; service: ManagedService; size: ServerSize | null }
  /**
   * Takes the bank loan, if it wasn't taken at the start: the money arrives at once, and repayments start the next day
   * played, at today's rate. One per company, and not with too few days left to repay it.
   */
  | { type: "takeLoan" }
  /** Buys the product's paid API, charged at once. Calls start arriving from the next day played. */
  | { type: "buyApi" }
  /**
   * Switches one of the company's app servers between giving CU and giving APIU, on a model where you add servers one
   * at a time. It serves the other way from the next day played.
   */
  | { type: "switchServer"; id: number; gives: "cu" | "apiu" }
  /** Sets how many API instances run on PaaS, from 0 to the platform's most, like the app instance count. */
  | { type: "setApiInstances"; count: number };

export interface NewGameParams {
  companyName: string;
  productType: string;
  model: string;
  seed: number;
  /** Take the bank loan at the start, on its best terms. */
  takeLoan?: boolean;
}

export interface LogEntry {
  text: string;
  cashDelta: number;
  /** Set on every charge, and only on charges. */
  category?: SpendCategory;
  /**
   * Set on entries that need to stand out, such as an outage, bankruptcy or the launch. "income" marks money coming in, which the
   * ledger counts as income rather than spend. "loan" marks the bank loan: money coming in with it is borrowed, which
   * is cash but not income.
   */
  kind?:
    | "outage"
    | "bankrupt"
    | "finished"
    | "feature"
    | "migration"
    | "event"
    | "income"
    | "support"
    | "price"
    | "conversion"
    | "loan"
    | "launch"
    | "api";
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

  /** Numbers that say more, sent with the error: daysLeft on a locked price. */
  readonly details: Record<string, number>;

  constructor(code: string, message: string, details: Record<string, number> = {}) {
    super(message);
    this.name = "SimError";
    this.code = code;
    this.details = details;
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

export function isServerType(v: string): v is ServerType {
  return (SERVER_TYPES as readonly string[]).includes(v);
}

export function isServerSize(v: string): v is ServerSize {
  return (SERVER_SIZES as readonly string[]).includes(v);
}

export function isManagedService(v: string): v is ManagedService {
  return (MANAGED_SERVICES as readonly string[]).includes(v);
}

export function isStaffPool(v: string): v is StaffPool {
  return (STAFF_POOLS as readonly string[]).includes(v);
}
