// Shapes the API sends and receives. Type-only, so the web client can import it.
import type { Action, DayLog, ModelComparison, ModelId, ProductTypeId, StackLayer, StaffPool } from "@xaas/sim";

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
  status: string;
  developers: number;
  ops: number;
  /** Ops staff the current model needs. */
  opsNeeded: number;
  /** What the current headcount costs per day. */
  dailyStaffCost: number;
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
