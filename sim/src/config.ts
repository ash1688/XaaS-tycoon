// All balance numbers live here. Figures are placeholders, to be tuned after the alpha.
import type { LayerId } from "./responsibility.ts";

export const MODEL_IDS = ["onprem", "iaas", "paas", "saas"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const PRODUCT_TYPE_IDS = ["ecommerce", "social", "video"] as const;
export type ProductTypeId = (typeof PRODUCT_TYPE_IDS)[number];

export const STAFF_POOLS = ["developers", "ops", "support"] as const;
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
  /**
   * Charged once, in infrastructure, when a migration away from this model completes: the provider's fee for leaving
   * (early exit, getting your data out). Nothing on-prem, where you own the kit.
   */
  exitPenalty: number;
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

/** What a product's users expect to pay, and how many use it for free. */
export interface ProductPricing {
  /**
   * The monthly price users think the product is worth. A new company starts at it. Charging more slows growth and
   * puts more new users on the free tier; charging less does the opposite (see PricingConfig).
   */
  fairPrice: number;
  /** Share of users on the free tier, at the start and among new users at the fair price (0.7 = 70% free). */
  freeShare: number;
}

/** How many support tickets a product's users raise. Free users raise them too, but fewer. */
export interface ProductSupport {
  /** Tickets each paying user raises per day, on average (0.01 = one ticket per 100 paying users a day). */
  ticketsPerPaidUser: number;
  /** The same for each free user. Lower: free users ask for less, but you still answer them. */
  ticketsPerFreeUser: number;
}

export interface ProductTypeConfig {
  name: string;
  /** Short description of how this product behaves. */
  profile: string;
  growth: GrowthProfile;
  pricing: ProductPricing;
  support: ProductSupport;
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
 *
 * Pro rata on leaving maps straight onto this. The design notes' example is paying 280 a month in February and
 * leaving on the 14th, which charges 140: 14 of February's 28 days. Here the old provider is billed its daily share
 * on every day of a migration, up to and including the day it completes (the day you leave), and nothing after. So
 * for the migration's days you pay days ÷ daysPerMonth of the old provider's month: the pro-rata charge. With
 * daysPerMonth 28 and a 14-day migration starting on the 1st, that is 14 × 280 ÷ 28 = 140, as in the notes. The
 * migration quote shows it as the pro-rata charge. Per-user fees follow the same rule on each day's users.
 */
export interface BillingConfig {
  daysPerMonth: number;
}

/**
 * The monthly price the student charges each paying user, and how users react to it. Each paying user pays a day's
 * share of it every day, by the same rule as monthly costs: price ÷ daysPerMonth. Free users pay nothing, but still
 * add load and, on SaaS, per-user and add-on fees.
 *
 * How the price compares with the product's fair price sets two factors each day, from ratio = price ÷ fair price:
 * growth is multiplied by ratio ^ −growthSensitivity (at most maxGrowthBoost), and the paid share of new users,
 * 1 − freeShare at the fair price, is multiplied by ratio ^ −paidShareSensitivity (at most every new user pays).
 */
export interface PricingConfig {
  /** The highest monthly price a student can set. High on purpose, so they find the limit for themselves. */
  maxPrice: number;
  /** How strongly a price above the fair price slows growth, and one below it speeds growth up. 0 for no effect. */
  growthSensitivity: number;
  /** The most a low price can multiply growth by. */
  maxGrowthBoost: number;
  /** How strongly a price above the fair price puts new users on the free tier. 0 for no effect. */
  paidShareSensitivity: number;
  /**
   * Days a price change's wave lasts, from the first day played at the new price. Day 1 is the quick reaction
   * (firstDayShare of the whole effect); the rest is spread over the remaining days, building to a peak in the
   * middle and fading, like word spreading on social media.
   */
  waveDays: number;
  /** Days the price is locked after a change, counted in days played. Changes are refused until it ends. */
  lockDays: number;
  /** Share of a wave's whole effect that lands on its first day: the small next-day reaction. */
  firstDayShare: number;
  /**
   * How a wave's size grows with the size of the change. The change is measured against the fair price
   * (d = |new − old| ÷ fair price, so £5 on a £20 product is 0.25) and raised to this power. Above 1, a small tweak
   * barely registers and a big jump hits much harder: at 1.5, a change twice as big has nearly three times the effect.
   */
  waveCurve: number;
  /**
   * Share of paying users a rise affects at d = 1 (doubling a fair price), before the cap. Each affected user leaves
   * or drops to free. The share is riseStrength × d^waveCurve × (new price ÷ fair price)^dearness.
   */
  riseStrength: number;
  /**
   * How much harder a rise hits the further above the fair price it goes: the share is multiplied by (new price ÷
   * fair price) to this power when that's above 1. 0 for no effect. Stops small rises adding up for free.
   */
  dearness: number;
  /** The most of the paying users one rise can affect (0.9 = 90%). */
  maxRiseShare: number;
  /** Of the paying users a rise affects, the share who drop to the free tier. The rest leave altogether. */
  dropToFreeShare: number;
  /** Support tickets each affected user raises over a rise's backlash: complaints, cancellations, refund requests. */
  backlashTicketsPerUser: number;
  /** New users a cut brings at d = 1, as a share of today's users, before the cap: cutGainStrength × d^waveCurve. */
  cutGainStrength: number;
  /** The most new users one cut can bring, as a share of today's users. */
  maxCutGain: number;
  /** Share of free users a cut turns into payers at d = 1, before the cap: cutUpgradeStrength × d^waveCurve. */
  cutUpgradeStrength: number;
  /** The most of the free users one cut can turn into payers. */
  maxCutUpgrade: number;
}

/**
 * Customer care, the company's job on every model: even on SaaS the provider fixes the platform but doesn't answer
 * your customers. Each day users raise tickets (see ProductSupport), plus a burst for every hour down; support staff
 * clear what they can and the rest carries over as a backlog.
 *
 * Satisfaction % moves a share of the way each day towards a target set by the backlog against the user count:
 * 100% with no backlog, falling in a straight line to 0% when the backlog reaches backlogPerUserAtZero tickets per
 * user. Below goodSatisfaction it slows growth and makes users leave, more the lower it goes.
 */
export interface SupportConfig {
  /** Tickets one support person clears a day. */
  ticketsPerPerson: number;
  /** Extra tickets per user for each hour the service is down, from outages of any kind. */
  ticketsPerUserPerHourDown: number;
  /** A burst is logged when it adds at least this share of the day's usual tickets (0.5 = half as many again). */
  bigBurstShare: number;
  /** Backlog per user at which the satisfaction target reaches 0% (0.05 = one open ticket per 20 users). */
  backlogPerUserAtZero: number;
  /** Share of the gap to the target that satisfaction closes each day (0.2 = a fifth). Higher moves faster. */
  satisfactionSpeed: number;
  /** At or above this %, satisfaction has no effect on growth or churn. Falling below it is logged. */
  goodSatisfaction: number;
  /** Falling below this % is logged as a warning. Only a log threshold: the effects are set by goodSatisfaction. */
  poorSatisfaction: number;
  /** Growth is multiplied by this at 0% satisfaction, rising in a straight line to 1 at goodSatisfaction. */
  growthAtZero: number;
  /** Share of users who leave each day at 0% satisfaction, falling in a straight line to none at goodSatisfaction. */
  churnAtZero: number;
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
  /**
   * Whether the new provider bills in full from the first day of a migration, on top of the old one, so you pay for
   * two setups while you move. The design notes assume it does, still to confirm, hence the switch. Off, the new
   * provider bills from the day after the switch. Its upfront cost is charged on the migration's first day either way.
   */
  billNewFromStart: boolean;
  overrun: OverrunConfig;
}

/**
 * Migrations slip. When the moving phase starts, a seeded roll decides whether it overruns, and by how many extra
 * days. Both providers are billed for those days too. The quote can't know in advance, so it shows the odds.
 */
export interface OverrunConfig {
  /** Chance a migration overruns (0.25 = 1 in 4). */
  chance: number;
  /** Extra days on an overrun, picked evenly from minDays to maxDays. */
  minDays: number;
  maxDays: number;
}

/**
 * One way a scripted event can play out on a model. It applies on each day the event is on, after the day's load is
 * worked out; with none of these set, the event changes nothing.
 */
export interface EventOutcome {
  /** Why it played out like this on this model, for the student. Follows the line naming the responsible layer. */
  detail: string;
  /**
   * Capacity grows to meet the event's extra load, so the load causes no outage, charged per unit of load the event
   * adds (infrastructure). 0 scales for free. Left out, capacity stays as it is, so the extra load can cause an
   * outage by the usual capacity rules.
   */
  scaleCostPerLoad?: number;
  /** Hours down, on top of any outage from load. Counts as an outage. */
  downtimeHours?: number;
  /** A charge in infrastructure, such as cleaning up after a break-in. */
  cost?: { amount: number; text: string };
  /**
   * The provider puts its prices up, for good, from the day the event fires: the model's monthly and per-user charges
   * (infrastructure) rise by this percent, and with `addons` so do SaaS add-on prices (addons). A later rise compounds.
   * It sticks to the provider: leave and come back, and you pay the new prices.
   */
  priceRise?: { percent: number; addons?: boolean };
  /**
   * A feature the company needs that the platform can't provide and no add-on offers, named per product type. From
   * the day the event fires, every day's growth is multiplied by `growthMultiplier`, until the company completes a
   * migration off the model it hit: then it can build what it likes, so the gap closes. That migration (its time,
   * double billing and lost add-ons) is the price of getting control back.
   */
  featureGap?: { growthMultiplier: number; features: Record<ProductTypeId, string> };
}

/** How an event hits one model. */
export interface EventEffect extends EventOutcome {
  /** Ops staff needed to deal with it. With fewer, `shortOfOps` happens instead. */
  opsNeeded?: number;
  shortOfOps?: EventOutcome;
}

/** When an event fires. */
export type EventSchedule =
  /** On these days in every game. */
  | { type: "fixed"; days: number[] }
  /** On `count` different days from fromDay to toDay, picked with the game's seeded RNG when it starts. */
  | { type: "seeded"; count: number; fromDay: number; toDay: number };

/**
 * A scripted event. Each one shows a model handling the same situation its own way, so its effects are set per model,
 * along with the layer of the responsibility stack that decides who deals with it.
 */
export interface EventConfig {
  /** Unique. Saved in game state, so don't rename. */
  id: string;
  name: string;
  /** What happened, the same on every model. */
  description: string;
  /** The layer whose owner deals with it: the explanation names who that is on the student's model. */
  layer: LayerId;
  schedule: EventSchedule;
  /** Days it lasts, from the day it fires. */
  days: number;
  /** Extra load while it's on: the day's load × multiplier, plus extra. */
  load?: { multiplier: number; extra: number };
  /** A model left out isn't hit: the event doesn't happen at all for a company running on it. */
  effects: Partial<Record<ModelId, EventEffect>>;
}

export interface GameConfig {
  startingCash: number;
  /** The last day played. The game ends once it has been played, so day finalDay is played in full. */
  finalDay: number;
  maxCompanyNameLength: number;
  models: Record<ModelId, ModelConfig>;
  productTypes: Record<ProductTypeId, ProductTypeConfig>;
  staff: Record<StaffPool, StaffPoolConfig>;
  capacity: CapacityConfig;
  outage: OutageConfig;
  billing: BillingConfig;
  pricing: PricingConfig;
  support: SupportConfig;
  addons: AddonConfig;
  migration: MigrationConfig;
  /** Scripted events, in the order they're logged on a day when more than one is on. */
  events: EventConfig[];
}

export const defaultConfig: GameConfig = {
  // Set when there was no income, to carry a sensible setup to day 180 with room for mistakes. Lowered once the loan
  // arrives (#52).
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
      exitPenalty: 0,
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
      exitPenalty: 3_000,
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
      exitPenalty: 4_000,
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
      exitPenalty: 2_000,
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
      // Shoppers mostly pay: a shop's free tier is browsing without an account.
      pricing: { fairPrice: 5, freeShare: 0.3 },
      // Orders go wrong: paying shoppers raise the most tickets of any product.
      support: { ticketsPerPaidUser: 0.012, ticketsPerFreeUser: 0.003 },
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
      // Mostly free, like most social networks: a few pay for extras.
      pricing: { fairPrice: 6, freeShare: 0.8 },
      support: { ticketsPerPaidUser: 0.01, ticketsPerFreeUser: 0.002 },
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
      pricing: { fairPrice: 9, freeShare: 0.6 },
      support: { ticketsPerPaidUser: 0.01, ticketsPerFreeUser: 0.003 },
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
    // One to start, enough for the first few weeks: more are needed as users grow.
    support: { name: "Support staff", personName: "support person", dayRate: 100, startingCount: 1 },
  },
  capacity: { unstaffedShare: 0.4 },
  outage: { baseHours: 2, hoursPerOverload: 20, growthMultiplier: 0.25 },
  billing: { daysPerMonth: 30 },
  pricing: {
    maxPrice: 1_000,
    growthSensitivity: 1,
    maxGrowthBoost: 2,
    paidShareSensitivity: 1,
    // A change starts a 7-day wave and locks the price for 14. With these, a 25% rise on a fair price costs about 10%
    // of payers, 50% about 28% and doubling it 80%: the most income comes from about 25-30% above fair, and each rise
    // after that pays less, until raising the price stops paying at all.
    waveDays: 7,
    lockDays: 14,
    firstDayShare: 0.05,
    waveCurve: 1.5,
    riseStrength: 0.8,
    dearness: 1,
    maxRiseShare: 0.9,
    dropToFreeShare: 0.4,
    backlashTicketsPerUser: 1,
    // A 12.5% cut (£20 to £17.50) brings about 3% more users and turns about 2% of free users into payers.
    cutGainStrength: 0.6,
    maxCutGain: 0.5,
    cutUpgradeStrength: 0.5,
    maxCutUpgrade: 0.5,
  },
  support: {
    ticketsPerPerson: 30,
    ticketsPerUserPerHourDown: 0.002,
    bigBurstShare: 0.5,
    backlogPerUserAtZero: 0.05,
    satisfactionSpeed: 0.2,
    goodSatisfaction: 70,
    poorSatisfaction: 40,
    growthAtZero: 0.3,
    churnAtZero: 0.02,
  },
  addons: { minConfigDevelopers: 2 },
  migration: {
    phases: {
      planning: { name: "Planning", days: 5 },
      testing: { name: "Testing", days: 2 },
      moving: { name: "Moving infrastructure", days: 7 },
    },
    billNewFromStart: true,
    overrun: { chance: 0.3, minDays: 2, maxDays: 5 },
  },
  events: [
    {
      id: "trafficSpike",
      name: "Traffic spike",
      description: "Your product went viral: a flood of visitors on top of your usual users.",
      layer: "runtime",
      // Somewhere in the game, never in the first weeks.
      schedule: { type: "seeded", count: 2, fromDay: 20, toDay: 170 },
      days: 2,
      // More than any model's normal capacity, so only a model that scales stays up.
      load: { multiplier: 2, extra: 80_000 },
      effects: {
        onprem: {
          detail: "You own the hardware, and new servers take weeks to arrive, so capacity can't grow to meet it.",
        },
        iaas: {
          opsNeeded: 2,
          scaleCostPerLoad: 0.04,
          detail: "Your ops team rented extra VMs to meet it, so you stayed up, but you pay for every extra VM.",
          shortOfOps: {
            detail: "Without enough ops staff to rent and set up extra VMs in time, capacity stayed where it was.",
          },
        },
        paas: {
          scaleCostPerLoad: 0.05,
          detail: "The platform scaled up by itself, so you stayed up, but it bills you for the extra capacity.",
        },
        saas: {
          scaleCostPerLoad: 0,
          detail: "The SaaS provider absorbed it on their platform. You pay per user, so the burst cost you nothing.",
        },
      },
    },
    {
      id: "osPatch",
      name: "OS security patch",
      description: "A serious security hole was found in the operating system. Servers need patching today.",
      layer: "os",
      // Early, so students meet an event in their first lesson, then again later.
      schedule: { type: "fixed", days: [3, 75, 140] },
      days: 1,
      effects: {
        onprem: {
          opsNeeded: 2,
          detail: "Your ops team patched every server, so nothing got in.",
          shortOfOps: {
            detail: "Without enough ops staff to patch in time, attackers got in and you had to take everything down.",
            downtimeHours: 8,
            cost: { amount: 5_000, text: "Cleaning up after the break-in" },
          },
        },
        iaas: {
          opsNeeded: 1,
          detail: "Your ops team patched your VMs, so nothing got in.",
          shortOfOps: {
            detail: "Without enough ops staff to patch in time, attackers got in and you had to take everything down.",
            downtimeHours: 8,
            cost: { amount: 5_000, text: "Cleaning up after the break-in" },
          },
        },
        paas: { detail: "The provider patched the platform for you. Nothing for you to do." },
        saas: { detail: "The provider patched the platform for you. Nothing for you to do." },
      },
    },
    {
      id: "providerPriceRise",
      name: "Provider price rise",
      description: "Your provider announced new prices, starting today. Every customer pays them, you included.",
      layer: "hardware",
      // Once, after students have settled on a model, with time left to react by migrating.
      schedule: { type: "seeded", count: 1, fromDay: 30, toDay: 130 },
      days: 1,
      effects: {
        onprem: { detail: "You own your servers, so there's no provider to put prices up. Your costs stay the same." },
        iaas: {
          priceRise: { percent: 20 },
          detail:
            "You can't control what the provider charges. Leaving means a migration: double billing, an exit penalty and weeks of work.",
        },
        paas: {
          priceRise: { percent: 20 },
          detail:
            "You can't control what the provider charges. Leaving means a migration: double billing, an exit penalty and weeks of work.",
        },
        saas: {
          priceRise: { percent: 25, addons: true },
          detail:
            "You can't control what the provider charges, add-ons included. Leaving means a migration, and your add-ons stay behind.",
        },
      },
    },
    {
      id: "providerOutage",
      name: "Provider outage",
      description: "Your provider's data centre lost power, taking everything running there down with it.",
      layer: "facilities",
      schedule: { type: "seeded", count: 1, fromDay: 30, toDay: 160 },
      days: 1,
      effects: {
        onprem: { detail: "Your servers are in your own building, so the provider's outage didn't touch you." },
        iaas: {
          downtimeHours: 10,
          detail: "Your VMs went down with it. All you could do was wait for the provider to fix it.",
        },
        paas: {
          downtimeHours: 8,
          detail: "The platform went down with it. All you could do was wait for the provider to fix it.",
        },
        saas: {
          downtimeHours: 6,
          detail: "The SaaS platform went down with it. All you could do was wait for the provider to fix it.",
        },
      },
    },
    {
      id: "saasFeatureGap",
      name: "A feature SaaS can't provide",
      description: "Your customers keep asking for something the SaaS platform doesn't do.",
      layer: "application",
      // Early, so a SaaS company has time to weigh up migrating away.
      schedule: { type: "fixed", days: [6] },
      days: 1,
      // Only SaaS: on the other models your developers build whatever the product needs.
      effects: {
        saas: {
          featureGap: {
            growthMultiplier: 0.8,
            features: {
              ecommerce: "delivery options built around your own couriers",
              social: "a feed that ranks posts your way",
              video: "your own video player",
            },
          },
          detail:
            "The platform's code isn't yours to change, so you can't build it. Growth stays slower until you migrate off SaaS and build what you like.",
        },
      },
    },
  ],
};
