// Shapes the API sends and receives. Type-only, so the web client can import it.
import type {
  Action,
  DayLog,
  EventView,
  FeatureGapView,
  FeatureView,
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

export interface MetaView {
  startingCash: number;
  finalDay: number;
  maxCompanyNameLength: number;
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

export interface CompanyView {
  id: string;
  name: string;
  productType: ProductTypeId;
  model: ModelId;
  day: number;
  finalDay: number;
  cash: number;
  /** "active", or "bankrupt" once cash has gone below zero: the game is over and rejects Continue and actions. */
  status: string;
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
