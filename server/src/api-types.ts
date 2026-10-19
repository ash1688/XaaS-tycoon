// Shapes the API sends and receives. Type-only, so the web client can import it.
import type {
  Action,
  DayLog,
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
  productTypes: { id: ProductTypeId; name: string; profile: string }[];
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
  /** Total spent so far in each category. */
  spend: Spend;
}


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
