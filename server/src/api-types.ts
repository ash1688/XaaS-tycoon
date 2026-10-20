// Shapes the API sends and receives. Type-only, so the web client can import it.
import type {
  Action,
  ConfigErrors,
  ConfigField,
  ConfigOverrides,
  DayLog,
  EventView,
  FeatureGapView,
  FeatureView,
  GameSummary,
  MigrationPhase,
  MigrationQuote,
  MigrationView,
  ModelComparison,
  ModelId,
  ProductTypeId,
  Spend,
  StackLayer,
  StaffPool,
} from "@xaas/sim";

export interface ApiError {
  error: string;
  message: string;
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
    opsNeeded: number;
    upfrontCost: number;
    monthlyCost: number;
    monthlyCostPerUser: number;
  }[];
  staff: { id: StaffPool; name: string; personName: string; dayRate: number }[];
  /** Developers a SaaS company needs to configure add-ons before it can buy one. */
  minConfigDevelopers: number;
  /** A migration's phases in order, and how long each takes before any overrun. */
  migrationPhases: { id: MigrationPhase; name: string; days: number }[];
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
  /** Ops staff the current model needs. */
  opsNeeded: number;
  /** What the current headcount costs per day. */
  dailyStaffCost: number;
  users: number;
  /** Load on the day just played. */
  load: number;
  /** Load the company can serve in a day with its current model and staff. */
  capacity: number;
  /** Percentage of time up across every day played. */
  uptime: number;
  outageDays: number;
  /** What the current model costs per month at today's users. */
  monthlyInfrastructureCost: number;
  /** What the active add-ons cost per month at today's users. */
  monthlyAddonCost: number;
  /** Total spent so far in each category. */
  spend: Spend;
  /** The product's features, with each one's status (built, building or a SaaS add-on) and build progress. */
  features: FeatureView[];
  /** The migration under way (target, phase, days left in the phase and overall), or null. */
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
 * GET .../migration-quote?target=: what migrating to the target would cost (duration, upfront, double billing, pro
 * rata, exit penalty, total), the odds of an overrun, and the add-ons lost when leaving SaaS, for the confirm step.
 */
export type MigrationQuoteView = MigrationQuote;

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
