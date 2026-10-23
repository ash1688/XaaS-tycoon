// Shapes the API sends and receives. Type-only, so the web client can import it.
import type {
  Action,
  CapTableView,
  ApiView,
  ConfigErrors,
  ConfigField,
  ConfigOverrides,
  ConversionView,
  CustomerMixView,
  DangerView,
  DayLog,
  EventView,
  FeatureGapView,
  FeatureView,
  FundingView,
  GameLengthId,
  GameSummary,
  LaunchView,
  LoanQuote,
  LoanView,
  ManagedView,
  RacksView,
  MigrationPhase,
  MigrationQuote,
  CounterOdds,
  MigrationView,
  ModelComparison,
  PricePreview,
  PriceWaveView,
  ModelId,
  ProductTypeId,
  ProviderView,
  RunwayView,
  ServerOption,
  ServerView,
  SharesConfig,
  Spend,
  StackLayer,
  StaffGrade,
  StaffPool,
  StaffPoolView,
  UnitsView,
  ValuationView,
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

/** A game length a student can pick when starting a company. */
export interface GameLengthView {
  id: GameLengthId;
  /** "180 days", "1 year" or the career's name. */
  name: string;
  /** The last day played. */
  finalDay: number;
}

export interface MetaView {
  startingCash: number;
  /** The last day of the shortest game length, 180 by default: the bank loan is repaid by it. */
  finalDay: number;
  /** The game lengths the preset allows, shortest first: the first is picked unless the student chooses another. */
  gameLengths: GameLengthView[];
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
    /** Ops staff a new company on the model needs: the few PaaS and SaaS always need. Its servers' ops are on top. */
    opsNeeded: number;
    /**
     * Charged on adopting the model: on-prem, the server room with its rack and cabling. Servers are bought or rented
     * on top.
     */
    upfrontCost: number;
    monthlyCost: number;
    monthlyCostPerUser: number;
    /** Power and cooling a day, charged whatever the company runs: highest on-prem. */
    powerAndCooling: number;
  }[];
  /** Each pool, with a mid's day rate: a grade's pay is that × its pay multiplier. */
  staff: { id: StaffPool; name: string; personName: string; dayRate: number }[];
  /** Junior, mid and senior: pay and work a day against a mid's, and days from hiring to starting work. */
  grades: { id: StaffGrade; name: string; payMultiplier: number; output: number; leadDays: number }[];
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
  /** Shares in issue a new company can start with: the student picks from min to max; the form starts on default. */
  shares: SharesConfig;
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
  /** The config preset the game started with ("Default" for the built-in numbers). */
  preset: string;
  productType: ProductTypeId;
  model: ModelId;
  /** The game length picked when the company started. */
  gameLength: GameLengthId;
  gameLengthName: string;
  day: number;
  /** The game length's last day. */
  finalDay: number;
  /** True once the teacher has ended the game early (its status is then "finished"). */
  endedByTeacher: boolean;
  cash: number;
  /**
   * "active" while playing. Once the game is over it rejects Continue and actions, and shows its summary: "bankrupt"
   * if cash went below zero, "finished" if it played the final day, or "retired" if the student retired it.
   */
  status: CompanyStatus;
  /** People on each team, every grade. Hires still to start aren't counted. */
  developers: number;
  ops: number;
  /** Support staff: they answer customers' tickets, on every model. */
  support: number;
  /**
   * Each pool by grade: who's on the team, their work a day in mids (what's measured against ops needed, a build's
   * developer-days and tickets cleared), and hires still to start.
   */
  staff: StaffPoolView[];
  /**
   * Ops staff the company needs, in mids' work: on a model with servers, for the servers it has (on IaaS ready or
   * not, on-prem once they've arrived).
   */
  opsNeeded: number;
  /**
   * Ops staff the company will need once every server it has is in service: on-prem, kit on order included. The same
   * as opsNeeded where nothing is on order.
   */
  opsNeededOnceReady: number;
  /** What the current headcount costs per day. */
  dailyStaffCost: number;
  /**
   * The launch: "upcoming" with the launch day the setup gives and the days to it, "waiting" once the earliest launch
   * day has passed with nothing set up (or arrived) to serve users, "launched" with the day it did. The launch burst of
   * users (and of them those paying), whether the model has servers to set up, and whether they are.
   */
  launch: LaunchView;
  /** Every user, paying or free. No users until launch. */
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
   * The customer mix: each customer type's share of users, least willing to pay first, with its price threshold to
   * mark on the bar and whether the price is over it.
   */
  customerMix: CustomerMixView;
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
   * On-prem: the company's racks (size, the rack units (U) each holds and its servers take, and what each would sell
   * back for), the U each server size takes, and the racks it can buy with their price and cabling. Null on IaaS, PaaS
   * and SaaS, which have no racks.
   */
  racks: RacksView | null;
  /** What the current model charges a day for power and cooling: highest on-prem. */
  powerAndCooling: number;
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
  /** Total spent so far in each category. Debt is the bank loans' repayments. */
  spend: Spend;
  /** Of the debt spend, the interest: the part that counts against profit. */
  interestPaid: number;
  /**
   * The latest bank loan (kept once repaid), or null: amount, the day it was taken, rate, term, daily repayment, total,
   * repaid so far, what's left to repay, the repayments left, and what paying it off now would cost and save.
   */
  loan: LoanView | null;
  /**
   * What taking a bank loan now would cost, to show before accepting: amount, rate, interest, total repaid, the daily
   * repayment and the days of its term. Null when one can't be taken: one is being repaid, or the game is nearly over.
   */
  loanQuote: LoanQuote | null;
  /**
   * What a usual day does to cash at today's figures: income, running costs (staff, infrastructure, add-ons, a
   * migration's second bill and loan repayments) and the difference, with the days of cash left at that rate, or null
   * when the company isn't losing money.
   */
  runway: RunwayView;
  /**
   * What the company is worth today: the valuation, shares in issue, share price, and the drivers pushing it up or
   * down, in pounds, adding up to it.
   */
  valuation: ValuationView;
  /** Who owns the company: each shareholder's shares, share and what they're worth, the student first. */
  capTable: CapTableView;
  /**
   * Friends and family and the grant: each one's open offer, with what accepting it now would do, or how it was
   * answered and, for an accepted grant, how its uptime condition stands.
   */
  funding: FundingView;
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
   * The danger meter: how fast trouble is building and why. A random event fires when it reaches the next threshold
   * on the encounter list, which stays hidden.
   */
  danger: DangerView;
  /**
   * Features the platform can't provide, each still slowing growth until the company migrates off that model. Shown
   * every day, not just the day the event fired.
   */
  featureGaps: FeatureGapView[];
  /**
   * The product's paid API: its price until it's bought; then its calls a day and where they're heading, calls served
   * and dropped on the day just played and what they earned, what a usual day earns, the APIU the calls need against
   * what the ready servers give (null on SaaS, where the provider runs it for a fee per call) and any slow growth after
   * an outage. Null on a product without one.
   */
  api: ApiView | null;
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
 * GET .../counter-odds?funder=&amount=&share=&days=: what countering a funder's open offer with those terms would do,
 * before it's made: how far it asks, the odds of a high, middle or low roll, and the next offer each would bring.
 * Changes nothing. Refused as the counter would be.
 */
export type CounterOddsView = CounterOdds;

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
  /** Shares in issue at the start, all the student's, in MetaView.shares' range. Its default if left out. */
  shares?: number;
  /** One of MetaView.gameLengths. Left out, the first of them. */
  gameLength?: string;
}

/** How many games a teacher's end request ended: those still being played. */
export interface EndGamesResult {
  ended: number;
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
  /** The company's pseudonym in the playtest logs, such as "Player 7". */
  player: string;
  productType: ProductTypeId;
  model: ModelId;
  /** The model a migration under way is moving to, or null. */
  migratingTo: ModelId | null;
  day: number;
  finalDay: number;
  /** True once the teacher has ended the game early (its status is then "finished"). */
  endedByTeacher: boolean;
  cash: number;
  users: number;
  /** Percentage of time up across every day played. */
  uptime: number;
  status: CompanyStatus;
  updatedAt: string;
  /** When the teacher archived it, or null if it isn't. Only the teacher's view: the student can still play it. */
  archivedAt: string | null;
  /** The config preset the game started with. */
  preset: string;
  /** Of the users, those paying. */
  paidUsers: number;
  freeUsers: number;
  /** Income on the last day played. */
  lastDayIncome: number;
  /** Income − costs so far, as the summary's profit: of the loan repayments, only interest counts. Below 0 is a loss. */
  profit: number;
  /** Customer satisfaction now, 0–100, rounded. */
  satisfaction: number;
  /** Left to repay on the latest bank loan: null if none was taken, 0 once repaid. */
  loanRemaining: number | null;
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
  /** The config preset the game started with. */
  preset: string;
  /** The company's pseudonym in the playtest logs. */
  player: string;
  summary: SummaryView;
}

/** A config preset in the teacher's list. */
export interface PresetSummaryView {
  /** A uuid, or "default" for the built-in Default. */
  id: string;
  name: string;
  /** The built-in Default: the base config, which can't be changed, renamed or deleted. */
  builtIn: boolean;
  /** New games use this one. Exactly one preset is active. */
  active: boolean;
  /** How many numbers differ from the defaults. */
  changed: number;
  /** Null for Default. */
  updatedAt: string | null;
}

/** GET /api/teacher/presets: Default first, then the teacher's presets by name. */
export interface PresetsView {
  /** The id of the preset new games use. */
  active: string;
  presets: PresetSummaryView[];
  /** The longest a name can be. */
  maxNameLength: number;
}

/** GET /api/teacher/presets/:id: one preset with every editable number. */
export interface PresetView extends PresetSummaryView {
  fields: ConfigField[];
  /** Path → value, for the numbers that differ from each field's default. */
  overrides: ConfigOverrides;
  /** Path → value for every field: the override, or the default. */
  values: Record<string, number>;
}

/**
 * POST /api/teacher/presets: a new preset. With overrides, it holds them (the config page's current values); otherwise
 * it copies the preset `from` ("save as"), which defaults to Default.
 */
export interface PresetCreateBody {
  name: string;
  from?: string;
  overrides?: ConfigOverrides;
}

/** PATCH /api/teacher/presets/:id: rename it, replace its overrides, or both. Default can't be changed. */
export interface PresetUpdateBody {
  name?: string;
  overrides?: ConfigOverrides;
}

/** A 400 from saving the config: what's wrong with each field, by path. */
export interface ConfigErrorView extends ApiError {
  fields: ConfigErrors;
}

// --- playtest log ---

/** "game": from the server, as each action or Continue is handled. "ui": from the student's browser. */
export type PlayEventKind = "game" | "ui";

/** A game event's key numbers just after it. */
export interface PlaySnapshot {
  day: number;
  cash: number;
  paidUsers: number;
  freeUsers: number;
  dailyIncome: number;
  satisfaction: number;
  uptime: number;
  /** The capacity tier that runs out first, on a model with servers. */
  tier: "cu" | "dbu" | null;
  /**
   * How much of capacity is in use, in %: the binding tier's, or load against capacity. Null with no limit (SaaS), and
   * with demand but no capacity at all (see noCapacity).
   */
  tierUse: number | null;
  /** The binding tier had demand and no capacity, so there's no percentage. */
  noCapacity: boolean;
  model: ModelId;
  developers: number;
  ops: number;
  support: number;
  loan: "none" | "repaying" | "repaid";
  loanRemaining: number | null;
}

/**
 * What the browser logs: page visits, modals (with how long they were open), the prices a student previewed, quotes
 * they looked at, and the controls they used.
 */
export type UiEventType = "page" | "modal" | "pricePreview" | "quote" | "control";

/** A UI event's details. Only ids from the game's own UI, never anything the student typed but a price. */
export interface UiEventParams {
  /** page: the page visited, such as "finance". */
  page?: string;
  /** modal: which one, from its title, such as "set-your-price". */
  modal?: string;
  /** modal: how long it was open. */
  ms?: number;
  /** pricePreview: the prices tried, in order. */
  prices?: number[];
  /** pricePreview and quote: whether the student went on to confirm it. */
  confirmed?: boolean;
  /** quote: a migration, loan, friends and family or grant quote. */
  kind?: "migration" | "loan" | "friendsAndFamily" | "grant";
  /** quote: the model a migration quote was for. */
  target?: ModelId;
  /** control: which one, such as "servers-app" or "staff-hire-ops". */
  control?: string;
  /** control: what it did, such as "up", or the size picked. */
  value?: string;
}

/** POST /api/codes/:code/companies/:id/ui-events: a batch of UI events. */
export interface UiEventsBody {
  events: {
    type: UiEventType;
    /** How many milliseconds before sending it happened. */
    ago: number;
    day: number;
    params?: UiEventParams;
  }[];
}

/** One event in a company's timeline. */
export interface PlayEventView {
  id: number;
  at: string;
  day: number;
  kind: PlayEventKind;
  type: string;
  /** A game event's outcome: false when the game refused it, with the error code. Null for UI events. */
  ok: boolean | null;
  error: string | null;
  params: Record<string, unknown>;
  snapshot: PlaySnapshot | null;
}

/** GET /api/teacher/companies/:id/timeline?kind=: a company's events, oldest first. */
export interface TimelineView {
  id: string;
  /** The pseudonym the export uses. */
  player: string;
  /** The student's tester ID in the export, shared by every game under their code. */
  tester: string;
  name: string;
  code: string;
  preset: string;
  productType: ProductTypeId;
  status: CompanyStatus;
  events: PlayEventView[];
  /** Only the latest events fitted: older ones are in the export. */
  truncated: boolean;
}

/** GET /api/teacher/logs: how many events there are, and for how many companies. */
export interface LogStatsView {
  events: number;
  companies: number;
}

/** DELETE on a log route: how many events went. */
export interface LogDeleteResult {
  deleted: number;
}
