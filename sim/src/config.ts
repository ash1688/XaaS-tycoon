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
  /** Load the model can serve in a day when fully staffed. */
  capacity: number;
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

/** A run of busy days that repeats, like a sale season. */
export interface SeasonalSpike {
  /** First day of the first spike. */
  firstDay: number;
  /** Days from the start of one spike to the start of the next. */
  every: number;
  /** How many days each spike lasts. */
  length: number;
  /** Load is multiplied by this during a spike. */
  loadMultiplier: number;
  /** Growth is multiplied by this during a spike. */
  growthMultiplier: number;
}

/** How a product's users grow and how much load they put on the system. */
export interface GrowthProfile {
  startingUsers: number;
  /** Users the product can reach. Growth slows as users approach it. */
  marketSize: number;
  /** Share of current users added each day while the market is wide open (0.05 = 5%). */
  dailyGrowth: number;
  /** Daily growth varies randomly by up to this share either way. */
  growthNoise: number;
  /** Load each user puts on the system per day. */
  loadPerUser: number;
  /** Daily load varies randomly by up to this share either way. */
  loadNoise: number;
  seasonalSpike?: SeasonalSpike;
}

export interface ProductTypeConfig {
  name: string;
  /** Short description of how this product behaves. */
  profile: string;
  growth: GrowthProfile;
}

/** What happens on a day when load exceeds capacity. */
export interface OutageConfig {
  /** Hours down on any outage day. */
  baseHours: number;
  /** Extra hours down per 100% of load over capacity. Down for at most 24 hours a day. */
  hoursPerOverload: number;
  /** Growth is multiplied by this on an outage day. */
  growthMultiplier: number;
}

export interface CapacityConfig {
  /** Share of capacity a model that needs ops keeps with no ops at all. Rises in step with ops up to full. */
  unstaffedShare: number;
}

export interface GameConfig {
  startingCash: number;
  finalDay: number;
  maxCompanyNameLength: number;
  models: Record<ModelId, ModelConfig>;
  productTypes: Record<ProductTypeId, ProductTypeConfig>;
  staff: Record<StaffPool, StaffPoolConfig>;
  capacity: CapacityConfig;
  outage: OutageConfig;
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
      capacity: 80_000,
    },
    iaas: {
      name: "Rent VMs (IaaS)",
      blurb: "Rent virtual machines and run everything on them.",
      comparison: { upfrontCost: "Low", monthlyCost: "Medium", opsNeeded: "Medium", control: "High" },
      dailyCost: 200,
      opsNeeded: 2,
      capacity: 90_000,
    },
    paas: {
      name: "Deploy to a platform (PaaS)",
      blurb: "Hand over your code; the platform runs it.",
      comparison: { upfrontCost: "Low", monthlyCost: "Medium–high", opsNeeded: "Low", control: "Medium" },
      dailyCost: 250,
      opsNeeded: 1,
      capacity: 100_000,
    },
    saas: {
      name: "Build on a SaaS platform (SaaS)",
      blurb: "Build inside someone else's SaaS platform, like a shop on Shopify.",
      comparison: { upfrontCost: "Low", monthlyCost: "Per user, plus add-ons", opsNeeded: "None", control: "Low" },
      dailyCost: 120,
      opsNeeded: 0,
      capacity: 100_000,
    },
  },
  productTypes: {
    ecommerce: {
      name: "E-commerce platform",
      profile: "Big seasonal traffic spikes",
      growth: {
        startingUsers: 2_000,
        marketSize: 25_000,
        dailyGrowth: 0.03,
        growthNoise: 0.5,
        loadPerUser: 2,
        loadNoise: 0.1,
        seasonalSpike: { firstDay: 45, every: 45, length: 5, loadMultiplier: 1.6, growthMultiplier: 2 },
      },
    },
    social: {
      name: "Social network",
      profile: "Steady viral growth",
      growth: {
        startingUsers: 1_000,
        marketSize: 40_000,
        dailyGrowth: 0.05,
        growthNoise: 0.2,
        loadPerUser: 1.5,
        loadNoise: 0.05,
      },
    },
    video: {
      name: "Video sharing platform",
      profile: "Heavy storage and bandwidth costs",
      growth: {
        startingUsers: 1_000,
        marketSize: 20_000,
        dailyGrowth: 0.035,
        growthNoise: 0.4,
        loadPerUser: 4,
        loadNoise: 0.15,
      },
    },
  },
  staff: {
    developers: { name: "Developers", personName: "developer", dayRate: 160, startingCount: 2 },
    ops: { name: "Ops staff", personName: "ops person", dayRate: 140, startingCount: 1 },
  },
  capacity: { unstaffedShare: 0.4 },
  outage: { baseHours: 2, hoursPerOverload: 20, growthMultiplier: 0.25 },
};
