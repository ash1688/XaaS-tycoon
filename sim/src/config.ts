// All balance numbers live here. Figures are placeholders, to be tuned after the alpha.

export const MODEL_IDS = ["onprem", "iaas", "paas", "saas"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const PRODUCT_TYPE_IDS = ["ecommerce", "social", "video"] as const;
export type ProductTypeId = (typeof PRODUCT_TYPE_IDS)[number];

export const STAFF_POOLS = ["developers", "ops"] as const;
export type StaffPool = (typeof STAFF_POOLS)[number];

/** A migration runs through these phases in order. Saved in game state, so don't rename. */
export const MIGRATION_PHASES = ["planning", "testing", "moving"] as const;
export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

/** Every charge is tagged with one of these, so students can see where their money goes. */
export const SPEND_CATEGORIES = ["staff", "infrastructure", "addons"] as const;
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

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
  /** Charged once when a company adopts this model, such as buying servers (capex). */
  upfrontCost: number;
  /** Fixed provider bill (or power and upkeep on-prem) per month, billed as a daily share (opex). */
  monthlyCost: number;
  /** Extra per user per month, billed as a daily share on that day's users. SaaS charges per user. */
  monthlyCostPerUser: number;
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

/**
 * Something the product can do, such as checkout on a shop. Built in developer-days on on-prem, IaaS and PaaS.
 * The same list is offered as paid add-ons on SaaS.
 */
export interface FeatureConfig {
  /** Unique within its product type. Saved in game state, so don't rename. */
  id: string;
  name: string;
  /** One line on what it does for customers. */
  blurb: string;
  /** Work to build it. A developer does one developer-day of work a day. */
  devDays: number;
  /** Once active, the day's growth is multiplied by this (1.1 = 10% faster). */
  growthMultiplier: number;
  /** On SaaS, the add-on's price per user per month, billed a day at a time like the model's per-user fee. */
  addonPricePerUser: number;
}

export interface ProductTypeConfig {
  name: string;
  /** Short description of how this product behaves. */
  profile: string;
  growth: GrowthProfile;
  /** The fixed list of 3–5 features this product can have. */
  features: FeatureConfig[];
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

/**
 * How monthly costs are billed. Each day is charged its share of the month: monthly cost × days ÷ daysPerMonth,
 * rounded to the pound. Students see the same line every day rather than a lump once a month, and a model can be
 * billed for part of a month (say when leaving it) with the same rule.
 */
export interface BillingConfig {
  daysPerMonth: number;
}

/** SaaS add-ons: bought from the provider instead of built. */
export interface AddonConfig {
  /**
   * Developers needed to configure add-ons. SaaS isn't zero staff: with fewer, add-ons can't be bought.
   * Add-ons already bought keep working, as the provider runs them.
   */
  minConfigDevelopers: number;
}

export interface MigrationPhaseConfig {
  /** Shown on screen: "Moving infrastructure". */
  name: string;
  /** Days the phase takes before any overrun. */
  days: number;
}

/**
 * Changing deployment model. The same phases and lengths in every direction. It runs in the background: staff are
 * never tied up, and the model switches when the last phase ends.
 */
export interface MigrationConfig {
  phases: Record<MigrationPhase, MigrationPhaseConfig>;
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
  billing: BillingConfig;
  addons: AddonConfig;
  migration: MigrationConfig;
}

export const defaultConfig: GameConfig = {
  // There's no revenue in the alpha, so this has to carry a sensible setup to day 180 with room for mistakes.
  startingCash: 250_000,
  finalDay: 180,
  maxCompanyNameLength: 40,
  models: {
    onprem: {
      name: "Own servers (on-prem)",
      blurb: "Buy and run your own kit.",
      comparison: { upfrontCost: "High", monthlyCost: "Low–medium", opsNeeded: "High", control: "Full" },
      upfrontCost: 40_000,
      monthlyCost: 1_500,
      monthlyCostPerUser: 0,
      opsNeeded: 3,
      capacity: 80_000,
    },
    iaas: {
      name: "Rent VMs (IaaS)",
      blurb: "Rent virtual machines and run everything on them.",
      comparison: { upfrontCost: "Low", monthlyCost: "Medium", opsNeeded: "Medium", control: "High" },
      upfrontCost: 2_000,
      monthlyCost: 6_000,
      monthlyCostPerUser: 0,
      opsNeeded: 2,
      capacity: 90_000,
    },
    paas: {
      name: "Deploy to a platform (PaaS)",
      blurb: "Hand over your code; the platform runs it.",
      comparison: { upfrontCost: "Low", monthlyCost: "Medium–high", opsNeeded: "Low", control: "Medium" },
      upfrontCost: 1_000,
      monthlyCost: 9_000,
      monthlyCostPerUser: 0,
      opsNeeded: 1,
      capacity: 100_000,
    },
    saas: {
      name: "Build on a SaaS platform (SaaS)",
      blurb: "Build inside someone else's SaaS platform, like a shop on Shopify.",
      comparison: { upfrontCost: "Low", monthlyCost: "Per user, plus add-ons", opsNeeded: "None", control: "Low" },
      upfrontCost: 500,
      monthlyCost: 1_500,
      monthlyCostPerUser: 0.5,
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
      features: [
        {
          id: "checkout",
          name: "One-click checkout",
          blurb: "Customers pay without filling in a long form.",
          devDays: 20,
          growthMultiplier: 1.15,
          addonPricePerUser: 0.08,
        },
        {
          id: "reviews",
          name: "Product reviews",
          blurb: "Shoppers trust what other customers say.",
          devDays: 12,
          growthMultiplier: 1.1,
          addonPricePerUser: 0.05,
        },
        {
          id: "recommendations",
          name: "Recommendations",
          blurb: "Suggests products each shopper is likely to want.",
          devDays: 30,
          growthMultiplier: 1.2,
          addonPricePerUser: 0.1,
        },
        {
          id: "wishlists",
          name: "Wishlists",
          blurb: "Shoppers save items and come back for them.",
          devDays: 10,
          growthMultiplier: 1.05,
          addonPricePerUser: 0.03,
        },
      ],
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
      features: [
        {
          id: "messaging",
          name: "Direct messages",
          blurb: "Users chat privately with friends.",
          devDays: 20,
          growthMultiplier: 1.15,
          addonPricePerUser: 0.08,
        },
        {
          id: "photos",
          name: "Photo sharing",
          blurb: "Users post photos to their feed.",
          devDays: 16,
          growthMultiplier: 1.12,
          addonPricePerUser: 0.06,
        },
        {
          id: "groups",
          name: "Groups",
          blurb: "People with shared interests gather in one place.",
          devDays: 24,
          growthMultiplier: 1.15,
          addonPricePerUser: 0.08,
        },
        {
          id: "notifications",
          name: "Notifications",
          blurb: "Brings users back when something happens.",
          devDays: 10,
          growthMultiplier: 1.05,
          addonPricePerUser: 0.03,
        },
      ],
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
      features: [
        {
          id: "hd",
          name: "HD playback",
          blurb: "Videos play in sharp high definition.",
          devDays: 20,
          growthMultiplier: 1.12,
          addonPricePerUser: 0.06,
        },
        {
          id: "comments",
          name: "Comments",
          blurb: "Viewers talk about what they watched.",
          devDays: 10,
          growthMultiplier: 1.05,
          addonPricePerUser: 0.03,
        },
        {
          id: "recommendations",
          name: "Recommendations",
          blurb: "Suggests the next video to keep viewers watching.",
          devDays: 30,
          growthMultiplier: 1.2,
          addonPricePerUser: 0.1,
        },
        {
          id: "live",
          name: "Live streaming",
          blurb: "Creators broadcast live to their followers.",
          devDays: 36,
          growthMultiplier: 1.2,
          addonPricePerUser: 0.1,
        },
      ],
    },
  },
  staff: {
    developers: { name: "Developers", personName: "developer", dayRate: 160, startingCount: 2 },
    ops: { name: "Ops staff", personName: "ops person", dayRate: 140, startingCount: 1 },
  },
  capacity: { unstaffedShare: 0.4 },
  outage: { baseHours: 2, hoursPerOverload: 20, growthMultiplier: 0.25 },
  billing: { daysPerMonth: 30 },
  addons: { minConfigDevelopers: 2 },
  migration: {
    phases: {
      planning: { name: "Planning", days: 5 },
      testing: { name: "Testing", days: 2 },
      moving: { name: "Moving infrastructure", days: 7 },
    },
  },
};
