// Shapes the API sends and receives. Type-only, so the web client can import it.
import type { DayLog, ModelId, ProductTypeId } from "@xaas/sim";

export interface ApiError {
  error: string;
  message: string;
}

export interface MetaView {
  startingCash: number;
  finalDay: number;
  maxCompanyNameLength: number;
  productTypes: { id: ProductTypeId; name: string; profile: string }[];
  models: { id: ModelId; name: string; blurb: string }[];
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

export interface ContinueResult {
  company: CompanyView;
  log: DayLog[];
}

export interface TeacherCodeView {
  code: string;
  createdAt: string;
  companyCount: number;
}
