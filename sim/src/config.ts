// All balance numbers live here. Figures are placeholders, to be tuned after the alpha.

export const MODEL_IDS = ["onprem", "iaas", "paas", "saas"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const PRODUCT_TYPE_IDS = ["ecommerce", "social", "video"] as const;
export type ProductTypeId = (typeof PRODUCT_TYPE_IDS)[number];

export const STAFF_POOLS = ["developers", "ops"] as const;
export type StaffPool = (typeof STAFF_POOLS)[number];

/** How a model compares, shown in the table when choosing one. Words, not numbers, for now. */
export interface ModelComparison {
  upfrontCost: string;
  monthlyCost: string;
  opsNeeded: string;
  control: string;
}

export interface ModelConfig {
  name: string;
  /** One-line description shown when choosing a model. */
  blurb: string;
  comparison: ModelComparison;
  /** Placeholder running cost per day until the full ledger lands. */
  dailyCost: number;
  /** Ops/sysadmins this model needs to keep running. Fewer as the provider manages more layers. */
  opsNeeded: number;
}

export interface StaffPoolConfig {
  /** Plural, for headings: "Developers". */
  name: string;
  /** One person, for buttons: "developer". */
  personName: string;
  /** Fixed cost per person per day. */
  dayRate: number;
  /** Headcount a new company starts with. */
  startingCount: number;
}

export interface ProductTypeConfig {
  name: string;
  /** Short description of how this product behaves. */
  profile: string;
}

export interface GameConfig {
  startingCash: number;
  finalDay: number;
  maxCompanyNameLength: number;
  models: Record<ModelId, ModelConfig>;
  productTypes: Record<ProductTypeId, ProductTypeConfig>;
  staff: Record<StaffPool, StaffPoolConfig>;
}

export const defaultConfig: GameConfig = {
  startingCash: 50_000,
  finalDay: 180,
  maxCompanyNameLength: 40,
  models: {
    onprem: {
      name: "Own servers (on-prem)",
      blurb: "Buy and run your own kit.",
      comparison: { upfrontCost: "High", monthlyCost: "Low–medium", opsNeeded: "High", control: "Full" },
      dailyCost: 150,
      opsNeeded: 3,
    },
    iaas: {
      name: "Rent VMs (IaaS)",
      blurb: "Rent virtual machines and run everything on them.",
      comparison: { upfrontCost: "Low", monthlyCost: "Medium", opsNeeded: "Medium", control: "High" },
      dailyCost: 200,
      opsNeeded: 2,
    },
    paas: {
      name: "Deploy to a platform (PaaS)",
      blurb: "Hand over your code; the platform runs it.",
      comparison: { upfrontCost: "Low", monthlyCost: "Medium–high", opsNeeded: "Low", control: "Medium" },
      dailyCost: 250,
      opsNeeded: 1,
    },
    saas: {
      name: "Build on a SaaS platform (SaaS)",
      blurb: "Build inside someone else's SaaS platform, like a shop on Shopify.",
      comparison: { upfrontCost: "Low", monthlyCost: "Per user, plus add-ons", opsNeeded: "None", control: "Low" },
      dailyCost: 120,
      opsNeeded: 0,
    },
  },
  productTypes: {
    ecommerce: { name: "E-commerce platform", profile: "Big seasonal traffic spikes" },
    social: { name: "Social network", profile: "Steady viral growth" },
    video: { name: "Video sharing platform", profile: "Heavy storage and bandwidth costs" },
  },
  staff: {
    developers: { name: "Developers", personName: "developer", dayRate: 160, startingCount: 2 },
    ops: { name: "Ops staff", personName: "ops person", dayRate: 140, startingCount: 1 },
  },
};
