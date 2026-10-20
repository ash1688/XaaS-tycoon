// Shapes the API sends and receives. Type-only, so the web client can import it.
import type {
  Action,
  ConfigErrors,
  ConfigField,
  ConfigOverrides,
  ConversionView,
  DayLog,
  EventView,
  FeatureGapView,
  FeatureView,
  GameSummary,
  LoanQuote,
  LoanView,
  ManagedView,
  MigrationPhase,
  MigrationQuote,
  MigrationView,
  ModelComparison,
  PricePreview,
  PriceWaveView,
  ModelId,
  ProductTypeId,
  ProviderView,
  ServerOption,
  ServerView,
  Spend,
  StackLayer,
  StaffPool,
  UnitsView,
} from "@xaas/sim";

export interface ApiError {
  error: string;
  message: string;
  /** A 409 "price_locked" from setPrice: days until the price can be changed again. */
  daysLeft?: number;
}

/** Timed flow: when enabled, the game page has Play/Pause and plays a day every `seconds`. */
export interface TimedFlowView {
  enabled: boolean;
  seconds: number;
}

export interface MetaView {
  startingCash: number;
  finalDay: number;
  maxCompanyNameLength: number;
  /** Companies still being played (status "active") that one login code can have at once. */
  maxActiveCompanies: number;
  /** Whether the game page plays days on a timer, and how often. Off by default. */
  timedFlow: TimedFlowView;
  productTypes: {
    id: ProductTypeId;
    name: string;
    profile: string;
    /** On SaaS, each feature is an add-on at this price per user per month. */
    features: { id: string; name: string; addonPricePerUser: number }[];
  }[];
  models: {
    id: ModelId;
    name: string;
    blurb: string;
    comparison: ModelComparison;
    /** Responsibility stack, bottom layer first. */
    stack: StackLayer[];
    /** Ops staff the model needs: on a model with servers, for the starter setup a company gets. */
    opsNeeded: number;
    /** Everything charged on adopting the model: on a model that buys its servers, the starter kit too. */
    upfrontCost: number;
    monthlyCost: number;
    monthlyCostPerUser: number;
  }[];
  staff: { id: StaffPool; name: string; personName: string; dayRate: number }[];
  /** Developers a SaaS company needs to configure add-ons before it can buy one. */
  minConfigDevelopers: number;
  /** Tickets one support person clears a day. */
  ticketsPerPerson: number;
  /** At or above this satisfaction %, customers are happy: no slower growth or extra churn. */
  goodSatisfaction: number;
  /** Below this satisfaction %, customers are angry. */
  poorSatisfaction: number;
  /** The highest monthly price a company can set. */
  maxPrice: number;
  /** Days a price change's wave lasts, and days the price is locked after a change. */
  priceWaveDays: number;
  priceLockDays: number;
  /** Days of recent uptime that count towards free-to-paid conversion. */
  conversionUptimeDays: number;
  /** On servers: app servers from which load balancers are needed, and the most of database demand caches can take. */
  loadBalancerFrom: number;
  cacheableShare: number;
  /** A migration's phases in order, and how long each takes before any overrun. */
  migrationPhases: { id: MigrationPhase; name: string; days: number }[];
  /**
   * The bank loan's terms if it's taken when the game starts, the best there are: amount, rate, interest, total
   * repaid, the daily repayment and the days to repay it.
   */
  startLoan: LoanQuote;
}

/**
 * Where a game is. Only "active" games are still being played and count towards the code's limit; the others are its
 * history. "retired" is a game the student stopped playing, "bankrupt" one that ran out of cash, and "finished" one
 * that played the final day. All of them can still be viewed, with their summary.
 */
export type CompanyStatus = "active" | "retired" | "bankrupt" | "finished";

export interface CompanyView {
  id: string;
  name: string;
  productType: ProductTypeId;
  model: ModelId;
  day: number;
  finalDay: number;
  cash: number;
  /**
   * "active" while playing. Once the game is over it rejects Continue and actions, and shows its summary: "bankrupt"
   * if cash went below zero, "finished" if it played the final day, or "retired" if the student retired it.
   */
  status: CompanyStatus;
  developers: number;
  ops: number;
  /** Support staff: they answer customers' tickets, on every model. */
  support: number;
  /**
   * Ops staff the company needs: on a model with servers, for the servers it has (on IaaS ready or not, on-prem once
   * they've arrived).
   */
  opsNeeded: number;
  /** What the current headcount costs per day. */
  dailyStaffCost: number;
  /** Every user, paying or free. */
  users: number;
  /** Of the users, those who pay. */
  paidUsers: number;
  /** Of the users, those on the free tier. They pay nothing, but add load and, on SaaS, per-user fees. */
  freeUsers: number;
  /** The monthly price each paying user pays. A change applies from the next day played. */
  price: number;
  /** The monthly price users think the product is worth. Above it growth slows and fewer new users pay. */
  fairPrice: number;
  /** What paying users pay per day at today's paid users and price: paid users × price ÷ 30. */
  dailyIncome: number;
  /** Everything paying users have paid so far. */
  income: number;
  /**
   * The wave from the last price change while it's under way, or null: rise or cut, wave days played of its length,
   * what it has done so far and its whole plan day by day.
   */
  priceWave: PriceWaveView | null;
  /** Days until the price can be changed again after the last change. 0 when it can. */
  priceLockDaysLeft: number;
  /**
   * Free-to-paid conversion: free users who started paying on the day just played and in all (a price wave's upgrades
   * aren't counted here), the base and current daily rates (from the next day played), recent uptime, and each
   * driver (features, uptime, satisfaction, price) as a multiplier that's helping, hurting or neutral.
   */
  conversion: ConversionView;
  /** Tickets raised on the day just played, bursts included. */
  ticketsToday: number;
  /** Of today's tickets, those from bursts such as outages. */
  burstTickets: number;
  /** Tickets support cleared on the day just played. */
  clearedToday: number;
  /** Tickets still waiting at the end of the day just played. */
  backlog: number;
  /** Customer satisfaction, 0–100, rounded to a whole number. Falls while the backlog grows; low hurts growth and churn. */
  satisfaction: number;
  /** Tickets today's users raise in a day before any burst. */
  usualTickets: number;
  /** Tickets the support staff can clear in a day. */
  dailyClearance: number;
  /** Load on the day just played. */
  load: number;
  /**
   * Load the company can serve in a day with its current model and staff. On a model with servers, the load its ready
   * servers carry at the product's usual demand: see units for each tier. Null on SaaS: no limit, the provider scales.
   */
  capacity: number | null;
  /**
   * On a model with servers (on-prem, IaaS and PaaS): CU, DBU (after the cache) and CH demand on the day just played
   * against what the ready servers give, the binding tier that runs out first, the users the servers can serve, and
   * load balancer coverage of the app servers (built in on PaaS). Null on SaaS, which has no servers.
   */
  units: UnitsView | null;
  /**
   * The company's servers (type, size, ready or pending with the days left, units and monthly price; for bought kit,
   * what it cost and what selling it back would refund), oldest first. On-prem, pending servers are on order; on PaaS,
   * they're the app instances and managed services. Empty on SaaS.
   */
  servers: ServerView[];
  /**
   * What the company can add one at a time on its model, every type and size with its units and monthly price;
   * on-prem, the purchase price, sell-back share and delivery days too. Empty on PaaS (see managed) and SaaS.
   */
  serverOptions: ServerOption[];
  /**
   * On PaaS: the app instance count and the managed database and cache, each with the sizes it comes in and its price.
   * Changes are instant, managed services need no ops, and the load balancer is built in. Null on other models.
   */
  managed: ManagedView | null;
  /**
   * On SaaS: unlimited, provider-managed capacity, paid for through the per-user fee (free users included), shown as
   * that bill. Null on other models.
   */
  provider: ProviderView | null;
  /** Percentage of time up across every day played. */
  uptime: number;
  outageDays: number;
  /** What the current model costs per month at today's users. */
  monthlyInfrastructureCost: number;
  /** What the active add-ons cost per month at today's users. */
  monthlyAddonCost: number;
  /** Total spent so far in each category. Debt is the bank loan's repayments. */
  spend: Spend;
  /**
   * The bank loan once taken (kept once repaid), or null: amount, the day it was taken, rate, daily repayment, total,
   * repaid so far, what's left to repay and the repayments left.
   */
  loan: LoanView | null;
  /**
   * What taking the bank loan now would cost, to show before accepting: amount, rate, interest, total repaid, the daily
   * repayment and the days to repay it. Null when it can't be taken: one has been, or there are too few days left.
   */
  loanQuote: LoanQuote | null;
  /** The product's features, with each one's status (built, building or a SaaS add-on) and build progress. */
  features: FeatureView[];
  /**
   * The migration under way (target, phase, days left in the phase and overall), or null. It holds the new setup
   * being built on the target, itemised; the old setup is still `servers` until the switch, so both show.
   */
  migration: MigrationView | null;
  /** Migrations completed so far. */
  migrations: number;
  /**
   * Scripted events that were on during the day just played, each explained: what happened, the responsibility-stack
   * layer that decided it and who owns that layer on the model it hit, and how it played out. Empty on other days.
   */
  events: EventView[];
  /**
   * Features the platform can't provide, each still slowing growth until the company migrates off that model. Shown
   * every day, not just the day the event fired.
   */
  featureGaps: FeatureGapView[];
}


/**
 * GET .../migration-quote?target=: what migrating to the target would cost (duration, the new setup itemised by type
 * and size with its upfront and monthly cost, upfront, double billing, pro rata, exit penalty, sell-back, total), the
 * odds of an overrun, and the add-ons lost when leaving SaaS, for the confirm step.
 */
export type MigrationQuoteView = MigrationQuote;

/**
 * GET .../price-preview?price=: what setting that monthly price would do if nothing else changed. Income a day now and
 * once the wave settles, users and paying users after it, the wave's totals (paying users leaving and dropping to
 * free; new users and upgrades on a cut; backlash tickets) and its day-by-day shape, and whether the price is locked.
 * Changes nothing.
 */
export type PricePreviewView = PricePreview;

/**
 * GET .../summary: how the company did. Final cash, users and uptime, spend by category, migrations, and spend and
 * cash for each day played. ending is "completed" or "bankrupt", or null for a game still being played.
 */
export type SummaryView = GameSummary;

export interface CodeView {
  code: string;
  companies: CompanyView[];
}

export interface NewCompanyBody {
  name: string;
  productType: string;
  model: string;
  /** Take the bank loan at the start, on the terms in MetaView.startLoan. */
  takeLoan?: boolean;
}

export type ActionBody = Action;

export interface ContinueResult {
  company: CompanyView;
  log: DayLog[];
}

export interface TeacherCodeView {
  code: string;
  createdAt: string;
  companyCount: number;
}

/** One company on the teacher's live dashboard: enough to spot who's struggling, without its full state. */
export interface TeacherGameView {
  id: string;
  name: string;
  productType: ProductTypeId;
  model: ModelId;
  /** The model a migration under way is moving to, or null. */
  migratingTo: ModelId | null;
  day: number;
  finalDay: number;
  cash: number;
  users: number;
  /** Percentage of time up across every day played. */
  uptime: number;
  status: CompanyStatus;
  updatedAt: string;
  /** When the teacher archived it, or null if it isn't. Only the teacher's view: the student can still play it. */
  archivedAt: string | null;
}

/**
 * GET /api/teacher/games?hours=: companies played in the last `hours` hours, grouped by login code. Codes newest first,
 * and each code's companies in the order they were started, so rows stay put as the dashboard refreshes.
 *
 * GET /api/teacher/games?archived=true: every archived game however old, and every archived code (with all its games,
 * or none), grouped the same way. hours is null.
 */
export interface TeacherGamesView {
  hours: number | null;
  codes: {
    code: string;
    /** The code itself is archived: students can't use it, and its games stay here until it's unarchived. */
    archived: boolean;
    companies: TeacherGameView[];
  }[];
}

/** GET /api/teacher/companies/:id/summary: any company's summary, with what the teacher needs around it. */
export interface TeacherSummaryView {
  code: string;
  status: CompanyStatus;
  summary: SummaryView;
}

/** The teacher's config page: every editable number, and the overrides new games use. */
export interface ConfigView {
  /** The preset being edited. For now there's only "Custom". */
  preset: string;
  fields: ConfigField[];
  /** Path → value, for the numbers that differ from each field's default. */
  overrides: ConfigOverrides;
}

export interface ConfigSaveBody {
  overrides: ConfigOverrides;
}

/** A 400 from saving the config: what's wrong with each field, by path. */
export interface ConfigErrorView extends ApiError {
  fields: ConfigErrors;
}
