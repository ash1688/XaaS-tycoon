// All balance numbers live here. Tuned with the balance harness (sim/scripts, `npm run balance -w sim`) in #55.
import type { LayerId } from "./responsibility.ts";

export const MODEL_IDS = ["onprem", "iaas", "paas", "saas"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const PRODUCT_TYPE_IDS = ["ecommerce", "social", "video"] as const;
export type ProductTypeId = (typeof PRODUCT_TYPE_IDS)[number];

export const STAFF_POOLS = ["developers", "ops", "support"] as const;
export type StaffPool = (typeof STAFF_POOLS)[number];
export const STAFF_GRADES = ["junior", "mid", "senior"] as const;
export type StaffGrade = (typeof STAFF_GRADES)[number];

/** A migration runs through these phases in order. Saved in game state, so don't rename. */
export const MIGRATION_PHASES = ["planning", "testing", "moving"] as const;
export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

/**
 * How long a game runs before it ends, if the company doesn't go bankrupt first. The student picks one of the lengths
 * the preset allows when starting a company. Saved in game state, so don't rename. (Until IPO comes with the IPO.)
 */
export const GAME_LENGTH_IDS = ["180-days", "1-year", "career"] as const;
export type GameLengthId = (typeof GAME_LENGTH_IDS)[number];

/** A career runs from founding the company at 18 to retiring at 65. */
export const CAREER_YEARS = 65 - 18;

/** Every charge is tagged with one of these, so students can see where their money goes. */
export const SPEND_CATEGORIES = ["staff", "infrastructure", "cabling", "power", "addons", "debt"] as const;
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

/**
 * Kinds of server. App servers give compute (CU), databases give database units (DBU) and caches give cache hits
 * (CH). A load balancer gives no units: it spreads traffic over app servers. API servers give APIU, for the paid API's
 * calls (see ApiConfig). Saved in game state, so don't rename.
 */
export const SERVER_TYPES = ["app", "database", "cache", "loadBalancer", "api"] as const;
export type ServerType = (typeof SERVER_TYPES)[number];

/** Every server type comes in these sizes, smallest first. Saved in game state, so don't rename. */
export const SERVER_SIZES = ["small", "medium", "large", "massive"] as const;
export type ServerSize = (typeof SERVER_SIZES)[number];

/** Racks come in these sizes, smallest first. Saved in game state, so don't rename. */
export const RACK_SIZES = ["small", "medium", "large"] as const;
export type RackSize = (typeof RACK_SIZES)[number];

/** The capacity tiers servers are measured in: compute units, database units and cache hits. */
export const UNIT_TIERS = ["cu", "dbu", "ch"] as const;
export type UnitTier = (typeof UNIT_TIERS)[number];

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
  /**
   * Charged once when a company adopts this model (capex). On a model that buys its servers, it's the server room
   * (racks, networking, power and cooling): the servers are bought on top, one at a time, at their purchase prices.
   */
  upfrontCost: number;
  /** Fixed provider bill (on-prem, the premises and bandwidth) per month, billed as a daily share (opex). */
  monthlyCost: number;
  /**
   * Power and cooling a day, charged on every day played whatever the company runs (power). Highest on-prem, where you
   * run the kit yourself, and falling through IaaS and PaaS to SaaS.
   */
  powerAndCooling: number;
  /** Extra per user per month, billed as a daily share on that day's users. SaaS charges per user. */
  monthlyCostPerUser: number;
  /**
   * Ops/sysadmins this model needs whatever it runs on: the few PaaS and SaaS need to keep the service running. On a
   * model with servers, the servers' own ops (see ModelServersConfig.opsPerServer) are added on top.
   */
  opsNeeded?: number;
  /**
   * Load the model can serve in a day when fully staffed: a fixed capacity, for a model without servers. No model in
   * the default config has one any more. A model with neither this nor servers has no capacity limit at all (SaaS):
   * the provider scales, so capacity is never the constraint.
   */
  capacity?: number;
  /**
   * How the model gets capacity from servers measured in units. IaaS rents VMs, on-prem buys servers and PaaS sets an
   * instance count and managed service sizes. Left out on SaaS, which has no servers and no capacity limit.
   */
  servers?: ModelServersConfig;
  /**
   * Charged once, in infrastructure, when a migration away from this model completes: the provider's fee for leaving
   * (early exit, getting your data out). Nothing on-prem, where you own the kit.
   */
  exitPenalty: number;
}

/** A number of servers of one type and size. */
export interface ServerCount {
  type: ServerType;
  size: ServerSize;
  count: number;
}

/**
 * Servers bought outright (capex), on a model that owns its kit. The purchase price is charged the moment you buy,
 * and the server arrives after the model's readyDays. An order can't be cancelled: once the server arrives you can
 * sell it back, at sellBackShare of what you paid, so bought kit is a sunk cost.
 */
export interface ServerPurchaseConfig {
  /** Purchase price of one server, by type and size. */
  price: Record<ServerType, Record<ServerSize, number>>;
  /** Share of the purchase price you get back on selling a server (0.4 = 40%). */
  sellBackShare: number;
  /** Cabling: charged on top of the price for each piece of hardware bought, a server or a rack (cabling). */
  cablingCost: number;
}

/**
 * Racks, on a model that buys its servers. Each server is installed in a rack and takes rack units (U) by its size,
 * from the day it's ordered, so a server can't be bought without a rack that has room for it. Racks are bought
 * outright, installed at once, and sold back like servers once they're empty.
 */
export interface RacksConfig {
  /** Each size of rack: the U it holds and its purchase price. */
  sizes: Record<RackSize, { units: number; price: number }>;
  /** The U a server of each size takes, whatever its type. */
  serverUnits: Record<ServerSize, number>;
  /** Racks a company gets on adopting the model, bought with its upfront cost: what the server room comes with. */
  starter: RackSize[];
}

/**
 * How a model gets servers. Each one is billed monthly, a day's share at a time like the model's own monthly cost. A
 * rented one is billed from the first day played after it's added until the day it's cancelled, so cancelling is pro
 * rata: you pay only for the days you had it. A bought one (see `purchase`) costs its power and upkeep from the day
 * after it arrives until it's sold. Prices go up with the provider's price rises.
 */
export interface ModelServersConfig {
  /**
   * Monthly price of one server, by type and size: rent, or on a model that buys them, power and upkeep. A type or
   * size left out costs nothing: on PaaS the load balancer is built in and free, and app instances come in one size.
   */
  monthlyCost: Partial<Record<ServerType, Partial<Record<ServerSize, number>>>>;
  /**
   * Days from adding a server to it being ready: 1 is the next day, and it serves load from the day after that. On a
   * model that buys its servers, the delivery time. Left out (0) on a managed model, where changes are instant.
   */
  readyDays?: number;
  /**
   * Ops staff each server of a type needs. Ops needed is the total over every server, rounded up: rented ones whether
   * ready or not, bought ones once they've arrived. Left out on a managed model: the provider runs them, so they need
   * no ops (the model's own opsNeeded still applies).
   */
  opsPerServer?: Record<ServerType, number>;
  /** Set on a model that buys its servers rather than renting them. */
  purchase?: ServerPurchaseConfig;
  /** Set on a model whose servers go in racks (on-prem). */
  racks?: RacksConfig;
  /** Set on a model whose platform runs the servers for you (PaaS). */
  managed?: ManagedServersConfig;
  /**
   * Servers a new company on this model starts with, ready for the first day; on a model that buys its servers,
   * bought along with the model's upfront cost. Left out of the default config, where a company starts with none and
   * buying its first setup is its first decision: test configs use it to start with servers in place. A migration
   * onto the model doesn't get these: it builds a setup sized to the company's demand (see Servers.sizeSetupFor).
   */
  starter?: ServerCount[];
}

/** The services a platform runs for you, one of each at a size you pick. The database is required, the cache isn't. */
export const MANAGED_SERVICES = ["database", "cache"] as const;
export type ManagedService = (typeof MANAGED_SERVICES)[number];

/**
 * A platform that runs the servers for you (PaaS). You set how many app instances to run, all one size, and pick the
 * size of one managed database and, if you like, one managed cache. The provider runs them, so they need no ops, and a
 * change takes effect at once. The load balancer is built in and free, so every instance counts however many you run.
 * Each is billed monthly, a day's share at a time, at the model's server prices (monthlyCost): more per unit than the
 * same units on IaaS, since the provider's work is in the price.
 *
 * Instances are app servers of instanceSize in game state, and the managed services databases and caches, so the
 * same unit rules (weakest tier, cache hits) apply.
 */
export interface ManagedServersConfig {
  /** The size every app instance is: each gives that size's CU (see ServersConfig.types.app). */
  instanceSize: ServerSize;
  /** The most app instances a company can run. */
  maxInstances: number;
  /**
   * Units each size of managed database and cache gives, in place of a server's. A managed service scales up further
   * than one server of the same size, since you only ever run one.
   */
  units: Record<ManagedService, Record<ServerSize, number>>;
}

/** One server type: what it's called and the units each size gives. */
export interface ServerTypeConfig {
  name: string;
  /** One line on what it does, for the rent modal. */
  blurb: string;
  /** Units each size gives: CU, DBU or CH; for a load balancer, the app servers it can serve. */
  units: Record<ServerSize, number>;
}

/**
 * Servers in units. Each user puts CU and DBU demand on the servers (see ProductDemand). Caches absorb database
 * demand, one cache hit for one DBU, up to cacheableShare of it. Capacity is set by the weakest tier: compute, or the
 * database after the cache. From loadBalancerFrom app servers, they need load balancers: only the app servers the
 * load balancers cover count, biggest first, and with none, traffic reaches just one.
 */
export interface ServersConfig {
  types: Record<ServerType, ServerTypeConfig>;
  /** App servers from which load balancers are needed. */
  loadBalancerFrom: number;
  /** Share of database demand a cache can take (0.5 = half). The rest always reaches the database. */
  cacheableShare: number;
}

export interface StaffPoolConfig {
  /** Plural, for headings: "Developers". */
  name: string;
  /** One person, for buttons: "developer". */
  personName: string;
  /** Fixed cost per mid per day. Each grade's pay is this × its pay multiplier. */
  dayRate: number;
  /** Mids a new company starts with, on the team from day 1. */
  startingCount: number;
}

/**
 * A grade of staff, the same in every pool. Output is work a day against a mid's: developer-days for developers,
 * tickets (× ticketsPerPerson) for support, and cover towards ops needed for ops.
 */
export interface StaffGradeConfig {
  /** For headings and buttons: "Junior". */
  name: string;
  /** Pay as a multiple of the pool's day rate (a mid's). */
  payMultiplier: number;
  /** Work a day as a multiple of a mid's. */
  output: number;
  /** Days from hiring to starting work: hired after day 10 with 3, they work and are paid from day 13. */
  leadDays: number;
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
  /**
   * The launch total's range. Each game draws its own total from it, evenly, when it starts: the product's first users,
   * who trickle in over the launch ramp (see LaunchConfig), split paid and free by the product's freeShare like any
   * new users, so a price above the fair one puts more on the free tier. Normal growth runs from the day after the
   * ramp. The student never sees the total, only the users who have joined.
   */
  launchUsersMin: number;
  launchUsersMax: number;
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
  /**
   * Share of free users who start paying each day before any multiplier (0.002 = 2 in 1,000 a day). See
   * ConversionConfig for what raises and lowers it.
   */
  conversionRate: number;
}

/** How many support tickets a product's users raise. Free users raise them too, but fewer. */
export interface ProductSupport {
  /** Tickets each paying user raises per day, on average (0.01 = one ticket per 100 paying users a day). */
  ticketsPerPaidUser: number;
  /** The same for each free user. Lower: free users ask for less, but you still answer them. */
  ticketsPerFreeUser: number;
}

/**
 * The units each user needs from the servers, on models with servers. Every user counts, paying or free, and the
 * day's load variation and seasonal spike apply to both.
 */
export interface ProductDemand {
  /** Compute units (CU) each user needs: app servers. */
  cuPerUser: number;
  /** Database units (DBU) each user needs before any cache: databases. */
  dbuPerUser: number;
}

export interface ProductTypeConfig {
  name: string;
  /** Short description of how this product behaves. */
  profile: string;
  growth: GrowthProfile;
  demand: ProductDemand;
  pricing: ProductPricing;
  support: ProductSupport;
  /** The fixed list of 3–5 features this product can have. */
  features: FeatureConfig[];
  /** The paid API other businesses build on, for a product that would have one. Left out, the product has none. */
  api?: ProductApiConfig;
}

/**
 * A product's paid API: other businesses build on it, and each call earns a little (see ApiConfig). The company buys
 * it once; calls then grow towards a target set by its paying users and features.
 */
export interface ProductApiConfig {
  /** "Shop API". */
  name: string;
  /** One line on what other businesses do with it. */
  blurb: string;
  /** What buying it costs, once, charged at once (infrastructure). */
  price: number;
  /** API calls a day each paying user brings: developers build on popular platforms. */
  callsPerPaidUser: number;
}

/** What happens on a day when load exceeds capacity. */
export interface OutageConfig {
  /** Hours down on any outage day. */
  baseHours: number;
  /** Extra hours down per 100% of load over capacity. Down for at most 24 hours a day. */
  hoursPerOverload: number;
  /** Growth is multiplied by this on an outage day. */
  growthMultiplier: number;
  /** Share of paying users who stop paying for each hour down, of any kind (0.001 = 0.1% an hour). */
  paidChurnPerHour: number;
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
   * How much a price above the fair price puts customers off, as (new price ÷ fair price) to this power when that's
   * above 1. 0 for no effect. A rise's share is multiplied by it, so small rises don't add up for free; a cut's new
   * users and upgrades are divided by it, so a cut that leaves the price dear brings few.
   */
  dearness: number;
  /**
   * The most of the paying users one rise to near the fair price can affect (0.9 = 90%). The dearer the new price, the
   * fewer can stay: at most (1 − this) ÷ (new price ÷ fair price)^dearness of them keep paying, so almost nobody pays
   * a price many times what it's worth.
   */
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
  /**
   * Days customers remember a lower price. A cut only counts for how far it goes below the lowest price in that time,
   * so undoing a rise, or cycling up and back down, brings no new wave.
   */
  priceMemoryDays: number;
  /**
   * Share of paying users who stop paying each day at twice the fair price: priceChurn × (price ÷ fair price − 1)²,
   * so barely any just above the fair price and most of them far above it. At most maxPriceChurn a day. Like a
   * rise's, dropToFreeShare of them drop to free and the rest leave.
   */
  priceChurn: number;
  maxPriceChurn: number;
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
  /**
   * On top of that, the share of paying users who stop paying each day at 0% satisfaction, falling in a straight line
   * to none at goodSatisfaction. Unhappy customers stop paying first.
   */
  paidChurnAtZero: number;
}

/**
 * Free-to-paid conversion: free users are an investment. Each day a share of them start paying: the product's
 * conversionRate (see ProductPricing) times four multipliers, each 1 when it neither helps nor hurts.
 *
 * - Features: 1 + perFeature × active features (built, or bought as add-ons). Two features at 0.15 make 1.3.
 * - Uptime: 1 + uptimeEffect × (u − neutralUptime) ÷ (100 − neutralUptime), where u is the uptime % over the last
 *   uptimeDays days played. Above the neutral line it helps, up to 1 + uptimeEffect at 100%; below it, it hurts, down
 *   to 0.
 * - Satisfaction: 1 + satisfactionEffect × (s − good) ÷ (100 − good), the same shape around SupportConfig's
 *   goodSatisfaction, from yesterday's satisfaction s like growth and churn.
 * - Price: (price ÷ fair price) ^ −priceSensitivity, at most 1. A price above fair puts free users off paying; one
 *   below it adds nothing here, because a cut's upgrades come once, from its price wave.
 *
 * The rate is at most maxRate. Conversions come from the free users left after the day's growth, churn and any price
 * wave, so a user a wave has already upgraded can't convert as well.
 */
export interface ConversionConfig {
  /** Each active feature or add-on adds this to the features multiplier (0.15 = 15% more conversions each). */
  perFeature: number;
  /** Days of recent uptime that count: the last days played. */
  uptimeDays: number;
  /** Uptime % at which uptime neither helps nor hurts. */
  neutralUptime: number;
  /** How much 100% uptime raises conversion (0.25 = 25% more). Each step below neutral lowers it at the same rate. */
  uptimeEffect: number;
  /** How much 100% satisfaction raises conversion, with goodSatisfaction as the neutral line. */
  satisfactionEffect: number;
  /** How strongly a price above the fair price puts free users off paying. 0 for no effect. */
  priceSensitivity: number;
  /** The highest daily conversion rate, whatever the multipliers (0.05 = 5% of free users a day). */
  maxRate: number;
}

/** SaaS add-ons: bought from the provider instead of built. */
export interface AddonConfig {
  /**
   * Developers needed to configure add-ons. SaaS isn't zero staff: with fewer, add-ons can't be bought.
   * Add-ons already bought keep working, as the provider runs them.
   */
  minConfigDevelopers: number;
  /**
   * The one-off fee to set an add-on up, per developer-day it would take to build: buying saves the time, not the
   * money. Paid when it's bought, so a new company has to choose which it can afford first.
   */
  setupFeePerDevDay: number;
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
   * Room to grow in the setup a migration builds on the target model, as a share on top of today's usual CU and DBU
   * demand (0.25 = sized for 25% more). The setup is built on the migration's first day and billed from then, on top
   * of the old one, so you pay for two setups while you move; it serves once the model switches.
   */
  setupHeadroom: number;
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
   * Capacity grows to meet the event's extra demand, so it causes no outage: extra servers meet the CU and DBU demand
   * over capacity, charged per unit over (infrastructure). They take the model's readyDays to arrive, so they only
   * help from that many days into the event: on IaaS its first day runs on the servers you have, while the PaaS
   * platform scales at once. Left out, capacity stays as it is, so the extra demand can cause an outage by the usual
   * capacity rules. (SaaS has no capacity limit, so needs neither.)
   */
  scaleCostPerUnit?: number;
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
  /**
   * Extra load while it's on: the day's load × multiplier, plus extra. On a model with servers, CU and DBU demand are
   * multiplied by unitMultiplier instead (by multiplier if it's left out).
   */
  load?: { multiplier: number; extra: number; unitMultiplier?: number };
  /** A model left out isn't hit: the event doesn't happen at all for a company running on it. */
  effects: Partial<Record<ModelId, EventEffect>>;
}

/**
 * A new company has no users and no servers. Its first users arrive at the end of the first day it has capacity to
 * serve them: servers ready by the end of that day, so rented VMs the day after they're rented, bought kit when it
 * arrives, a platform's instances and database at once. A model with no capacity limit (SaaS) is ready on day 1.
 * From then the game's launch users (see GrowthProfile.launchUsersMin) trickle in over the ramp, a share each day,
 * each day's split paid and free like any new users. Normal growth takes over after it.
 *
 * Before the first users arrive there's nothing running: no users, no income, no tickets and no scripted events, so no
 * outages. Staff, running costs and loan repayments are still charged, so a company that's slow to set up loses money.
 */
export interface LaunchConfig {
  /**
   * The share of the launch users arriving on each day of the ramp, first day first: its length is the ramp's. They're
   * scaled to add up to 1, so the whole launch total always arrives.
   */
  rampShares: number[];
}

/**
 * Bank loans: one at a time, taken when the game starts or at any point after, and another once the last is repaid.
 * Each is repaid in equal daily repayments (debt) over a fixed term from the next day played, whatever happens and
 * whatever the game's length, so it can run past the final day. The later it's taken, the shorter the term and the
 * more interest the bank charges. Paying one off early costs the money borrowed not yet paid back, and saves the
 * interest still to come.
 *
 * Interest is simple, on the whole amount, at a rate set by the day the loan is taken (day 1 at the start):
 *
 *   rate = baseRate + ratePerDay × (day − 1)
 *   days = max(minTermDays, termDays − termPerDay × (day − 1)), rounded      (the term)
 *   dailyRepayment = amount × (1 + rate) ÷ days, rounded up to the pound like every charge
 *   total repaid = dailyRepayment × days; interest = total repaid − amount
 *
 * Each repayment is interest and principal in the loan's own proportion. With the defaults: taken at the start, 10%
 * (£321 a day for 120 days, £38,520 in all); on day 61, 22% (£475 a day for 90 days, £42,750); on day 121, 34%
 * (£782 a day for 60 days, £46,920).
 */
export interface LoanConfig {
  /** What the bank lends. */
  amount: number;
  /** Interest on a loan taken at the start, as a share of the amount (0.1 = 10%). */
  baseRate: number;
  /** Added to the rate for each day later it's taken (0.002 = 0.2 percentage points a day). */
  ratePerDay: number;
  /** The term of a loan taken at the start: its repayment days. */
  termDays: number;
  /** Taken off the term for each day later it's taken. */
  termPerDay: number;
  /** The shortest term, however late it's taken. */
  minTermDays: number;
  /** The bank won't lend with fewer days than this left in the game. */
  minDays: number;
}

/**
 * Shares in issue: the student picks how many their company has when they start it, and owns all of them. Each
 * funding round adds more (see FundingConfig). The default is what the new-company form starts on.
 */
export interface SharesConfig {
  min: number;
  max: number;
  default: number;
}

/**
 * What the company is worth: the formula valuation. Revenue counts at a multiple that growth, satisfaction and uptime
 * move; paying users count at a value each, so price-gouging can't inflate it. Never below the minimum.
 *
 *   annual revenue = income earned a day (paying users and any paid API), averaged over the last revenueDays days
 *                    played since launch, × 365
 *                    (income earned, not today's price: a price change can't move it until the income comes in)
 *   growth = (paying users now − paying users growthDays ago) ÷ max(those then, growthBaseUsers)
 *   multiple = revenueMultiple
 *            + growthMultiple × growth, between −maxGrowthPenalty and +maxGrowthMultiple
 *            − satisfactionPenalty × (goodSatisfaction − satisfaction) ÷ goodSatisfaction, below goodSatisfaction
 *            − uptimePenaltyPerPoint × (goodUptime − recent uptime %), below goodUptime, at most maxUptimePenalty
 *   valuation = max(minimum, annual revenue × max(0, multiple) + paying users × valuePerPayingUser)
 *
 * Recent uptime is over ConversionConfig's uptimeDays. Share price = valuation ÷ shares in issue.
 */
export interface ValuationConfig {
  revenueDays: number;
  revenueMultiple: number;
  growthDays: number;
  growthBaseUsers: number;
  growthMultiple: number;
  maxGrowthMultiple: number;
  maxGrowthPenalty: number;
  goodSatisfaction: number;
  satisfactionPenalty: number;
  goodUptime: number;
  uptimePenaltyPerPoint: number;
  maxUptimePenalty: number;
  valuePerPayingUser: number;
  minimum: number;
}

/**
 * Friends and family and the grant: on the Finance page from day 1, each a fixed offer the student can accept or
 * decline once. Both pay everything up front.
 *
 * - Friends and family put in `amount` for new shares at today's share price: amount ÷ share price of them.
 * - The grant gives `amount` for no shares, on condition that uptime stays at least minUptime % over the `days` days
 *   played after it's accepted: at most (100 − minUptime)% of those days' hours down in all. Going over withdraws the
 *   grant: all of it is paid back at once.
 */
export interface FundingConfig {
  friendsAndFamily: { amount: number };
  grant: { amount: number; days: number; minUptime: number };
}

/**
 * Paid APIs, for a product that has one (see ProductApiConfig). Each call served earns pricePerCall. Calls need APIU,
 * from API servers or app servers switched from CU to APIU (on PaaS, API instances): calls beyond the APIU are
 * dropped, and their income with them. On SaaS the provider runs the API, so it needs no APIU, but takes a fee per
 * call served.
 *
 * Traffic, the calls a day developers make, moves each day a share of the way towards a target: paying users ×
 * callsPerPaidUser × (1 + perFeature × active features). Calls dropped for want of APIU slow it, in step with the
 * share dropped. A day with an outage loses outageDrop of the traffic, and for slowDays after it growth is multiplied by
 * slowGrowth: developers don't trust a flaky API.
 */
export interface ApiConfig {
  /** What each call served earns (0.01 = 1p). */
  pricePerCall: number;
  /** Calls one APIU serves in a day. */
  callsPerApiu: number;
  /** Calls a day when the API is bought. */
  startingCalls: number;
  /** Share of the gap to the target traffic closed each day (0.1 = a tenth). */
  dailyGrowth: number;
  /** Each active feature or add-on adds this to the target's multiplier (0.15 = 15% more calls each). */
  perFeature: number;
  /** Share of the traffic lost on a day with an outage. */
  outageDrop: number;
  /** Days after an outage that API growth stays slow. */
  slowDays: number;
  /** Growth is multiplied by this while it's slow. */
  slowGrowth: number;
  /** On SaaS, the provider's fee for each call served, before any provider price rise. */
  saasFeePerCall: number;
}

export interface GameConfig {
  startingCash: number;
  /**
   * The last day played in a 180-day game: the game ends once it has been played, so day finalDay is played in full.
   * Longer lengths have fixed days (see gameLengthDays). The bank loan is repaid by this day whatever the length.
   */
  finalDay: number;
  /**
   * Which game lengths students can pick from when starting a company: 1 if allowed, 0 if not. At least one must be.
   * Numbers rather than flags so the config page can store them like every other setting.
   */
  allowedGameLengths: Record<GameLengthId, number>;
  maxCompanyNameLength: number;
  launch: LaunchConfig;
  models: Record<ModelId, ModelConfig>;
  productTypes: Record<ProductTypeId, ProductTypeConfig>;
  staff: Record<StaffPool, StaffPoolConfig>;
  staffGrades: Record<StaffGrade, StaffGradeConfig>;
  capacity: CapacityConfig;
  servers: ServersConfig;
  outage: OutageConfig;
  billing: BillingConfig;
  loan: LoanConfig;
  shares: SharesConfig;
  valuation: ValuationConfig;
  funding: FundingConfig;
  pricing: PricingConfig;
  support: SupportConfig;
  conversion: ConversionConfig;
  addons: AddonConfig;
  api: ApiConfig;
  migration: MigrationConfig;
  /** Scripted events, in the order they're logged on a day when more than one is on. */
  events: EventConfig[];
}

export const defaultConfig: GameConfig = {
  // Your own money: enough to start on IaaS, PaaS or SaaS and see out the first month or so, until income covers the
  // costs. On-prem's server room and first kit leave too little to buy more kit for weeks without the bank loan.
  startingCash: 15_000,
  finalDay: 180,
  // A normal lesson plays 180 days. The longer lengths could take hours, so the teacher turns them on for clubs,
  // homework or extension work.
  allowedGameLengths: { "180-days": 1, "1-year": 0, career: 0 },
  maxCompanyNameLength: 40,
  // Users trickle in over 3 days, building up. SaaS starts on day 1; a platform set up or VMs rented on day 1 start on
  // day 2; on-prem kit bought on day 1 arrives on day 8, so it starts nearly a week after the cloud models.
  launch: { rampShares: [0.2, 0.3, 0.5] },
  models: {
    onprem: {
      name: "Own servers (on-prem)",
      blurb: "Buy and run your own kit.",
      comparison: { upfrontCost: "High", monthlyCost: "Low–medium", opsNeeded: "High", control: "Full" },
      // The server room: networking and fit-out. It comes with a medium rack (bought on top, with its cabling); the
      // servers are bought on top too: a first app server and database of a size that leaves room to grow (£2,200 for
      // large ones) make on-prem by far the dearest to start.
      upfrontCost: 2_500,
      // The premises and bandwidth. Power and cooling, and each server's power and upkeep, are on top.
      monthlyCost: 400,
      // Running and cooling the room yourself: the dearest of any model. Placeholder.
      powerAndCooling: 25,
      monthlyCostPerUser: 0,
      exitPenalty: 0,
      // A server costs about five weeks' rent of the same VM and a tenth of that rent a month to run, so it pays for
      // itself in under two months. That makes on-prem the cheapest at scale for a product with steady, heavy load
      // (video). But you buy for your peak, a week ahead: a spiky shop or a fast-growing social network pays for kit
      // that sits idle, and a traffic spike melts it. Selling one back gets 40% of what you paid. Kit you rack, power
      // and patch yourself needs a little more ops than a VM, and patching it takes two people.
      servers: {
        purchase: {
          price: {
            app: { small: 400, medium: 550, large: 1_000, massive: 1_400 },
            database: { small: 450, medium: 700, large: 1_200, massive: 1_650 },
            cache: { small: 150, medium: 250, large: 400, massive: 550 },
            loadBalancer: { small: 250, medium: 400, large: 550, massive: 750 },
            api: { small: 400, medium: 550, large: 1_000, massive: 1_400 },
          },
          sellBackShare: 0.4,
          // Placeholder: per server or rack bought.
          cablingCost: 50,
        },
        // Placeholders. The server room's medium rack holds a first setup with room to grow a little; a growing
        // company needs more racks as well as more servers. Bigger racks cost less per U.
        racks: {
          sizes: { small: { units: 12, price: 300 }, medium: { units: 24, price: 500 }, large: { units: 42, price: 800 } },
          serverUnits: { small: 1, medium: 2, large: 4, massive: 8 },
          starter: ["medium"],
        },
        monthlyCost: {
          app: { small: 30, medium: 45, large: 80, massive: 110 },
          database: { small: 35, medium: 55, large: 95, massive: 130 },
          cache: { small: 10, medium: 20, large: 30, massive: 45 },
          loadBalancer: { small: 20, medium: 30, large: 45, massive: 60 },
          api: { small: 30, medium: 45, large: 80, massive: 110 },
        },
        readyDays: 7,
        opsPerServer: { app: 0.25, database: 0.25, cache: 0.1, loadBalancer: 0.1, api: 0.25 },
      },
    },
    iaas: {
      name: "Rent VMs (IaaS)",
      blurb: "Rent virtual machines and run everything on them.",
      comparison: { upfrontCost: "Low", monthlyCost: "Medium", opsNeeded: "Medium", control: "High" },
      upfrontCost: 2_000,
      // The account, storage and bandwidth. The VMs are rented on top.
      monthlyCost: 700,
      // The provider's power and cooling, passed on. Placeholder.
      powerAndCooling: 10,
      monthlyCostPerUser: 0,
      exitPenalty: 3_000,
      // Bigger VMs cost less per unit (a small app server £50 a CU, a massive one £37), and caches are the cheap way to
      // take load off the database. Each VM needs a share of an ops person: two or three at scale, against PaaS's one.
      servers: {
        monthlyCost: {
          app: { small: 300, medium: 450, large: 800, massive: 1_100 },
          database: { small: 360, medium: 540, large: 960, massive: 1_320 },
          cache: { small: 120, medium: 180, large: 320, massive: 440 },
          loadBalancer: { small: 200, medium: 300, large: 450, massive: 600 },
          api: { small: 300, medium: 450, large: 800, massive: 1_100 },
        },
        readyDays: 1,
        opsPerServer: { app: 0.2, database: 0.2, cache: 0.1, loadBalancer: 0.1, api: 0.2 },
      },
    },
    paas: {
      name: "Deploy to a platform (PaaS)",
      blurb: "Hand over your code; the platform runs it.",
      comparison: { upfrontCost: "Low", monthlyCost: "Medium–high", opsNeeded: "Low", control: "Medium" },
      upfrontCost: 1_000,
      // The platform account. Instances and managed services are billed on top.
      monthlyCost: 1_300,
      // The provider's power and cooling, passed on. Placeholder.
      powerAndCooling: 6,
      monthlyCostPerUser: 0,
      // A small, fixed team to deploy and keep the service running, however many instances: the platform runs them.
      opsNeeded: 1,
      exitPenalty: 4_000,
      // A unit costs about twice as much as on IaaS (an instance is £90 a CU, a medium VM £45): the provider's ops are in
      // the price. That's the trade: one ops person however big you get, and scaling that's instant, so a company that
      // only scales once it's full (as most students do) loses least here; but the dearest bill for one that plans
      // ahead. A managed database or cache doubles its units with each size, so one is enough for any product's market.
      servers: {
        monthlyCost: {
          app: { medium: 900 },
          api: { medium: 900 },
          database: { small: 900, medium: 2_000, large: 3_800, massive: 7_200 },
          cache: { small: 300, medium: 650, large: 1_200, massive: 2_200 },
        },
        managed: {
          instanceSize: "medium",
          maxInstances: 20,
          units: {
            database: { small: 10, medium: 25, large: 50, massive: 100 },
            cache: { small: 10, medium: 25, large: 50, massive: 100 },
          },
        },
      },
    },
    saas: {
      name: "Build on a SaaS platform (SaaS)",
      blurb: "Build inside someone else's SaaS platform, like a shop on Shopify.",
      comparison: { upfrontCost: "Low", monthlyCost: "Per user, plus add-ons", opsNeeded: "Very low", control: "Low" },
      upfrontCost: 500,
      monthlyCost: 900,
      // Your share of the provider's power and cooling: the least of any model. Placeholder.
      powerAndCooling: 3,
      // Every user, free ones included. There are no servers and no capacity limit: the provider scales. Cheap for a shop
      // whose users mostly pay, dear for a social network whose users are mostly free.
      monthlyCostPerUser: 0.35,
      // One person for the settings and integrations that keep the shop running.
      opsNeeded: 1,
      exitPenalty: 2_000,
    },
  },
  productTypes: {
    ecommerce: {
      name: "E-commerce platform",
      profile: "Big seasonal traffic spikes",
      growth: {
        launchUsersMin: 2_500,
        launchUsersMax: 7_500,
        marketSize: 20_000,
        dailyGrowth: 0.03,
        growthNoise: 0.5,
        loadPerUser: 2,
        loadNoise: 0.1,
        seasonalSpike: { firstDay: 45, every: 45, length: 5, loadMultiplier: 1.6, growthMultiplier: 2 },
      },
      // Baskets and orders: as much database as compute, 500 shoppers to a CU and a DBU. Server sizes are set by it: a
      // small app server serves 3,000 shoppers, a medium 5,000, a large 10,000 and a massive 15,000.
      demand: { cuPerUser: 0.002, dbuPerUser: 0.002 },
      // Shoppers mostly pay: a shop's free tier is browsing without an account.
      pricing: { fairPrice: 5, freeShare: 0.3, conversionRate: 0.0012 },
      // Orders go wrong: paying shoppers raise as many tickets as any product's.
      support: { ticketsPerPaidUser: 0.01, ticketsPerFreeUser: 0.003 },
      features: [
        {
          id: "checkout",
          name: "One-click checkout",
          blurb: "Customers pay without filling in a long form.",
          devDays: 20,
          growthMultiplier: 1.15,
          addonPricePerUser: 0.04,
        },
        {
          id: "reviews",
          name: "Product reviews",
          blurb: "Shoppers trust what other customers say.",
          devDays: 12,
          growthMultiplier: 1.1,
          addonPricePerUser: 0.025,
        },
        {
          id: "recommendations",
          name: "Recommendations",
          blurb: "Suggests products each shopper is likely to want.",
          devDays: 30,
          growthMultiplier: 1.2,
          addonPricePerUser: 0.05,
        },
        {
          id: "wishlists",
          name: "Wishlists",
          blurb: "Shoppers save items and come back for them.",
          devDays: 10,
          growthMultiplier: 1.05,
          addonPricePerUser: 0.015,
        },
      ],
      // Other shops, marketplaces and delivery firms check stock and place orders through it.
      api: {
        name: "Shop API",
        blurb: "Other businesses check stock, place orders and track deliveries through your shop.",
        price: 4_000,
        callsPerPaidUser: 3,
      },
    },
    social: {
      name: "Social network",
      profile: "Steady viral growth",
      growth: {
        launchUsersMin: 2_500,
        launchUsersMax: 7_500,
        marketSize: 40_000,
        dailyGrowth: 0.05,
        growthNoise: 0.2,
        loadPerUser: 1.5,
        loadNoise: 0.05,
      },
      // Feeds and friends lists: light on both, but there are a lot of users.
      demand: { cuPerUser: 0.0015, dbuPerUser: 0.0015 },
      // Mostly free, like most social networks: a few pay for extras.
      pricing: { fairPrice: 5, freeShare: 0.7, conversionRate: 0.0008 },
      // Few tickets per user, but a lot of users.
      support: { ticketsPerPaidUser: 0.006, ticketsPerFreeUser: 0.0015 },
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
        launchUsersMin: 2_500,
        launchUsersMax: 7_500,
        marketSize: 20_000,
        dailyGrowth: 0.035,
        growthNoise: 0.4,
        loadPerUser: 4,
        loadNoise: 0.15,
      },
      // Encoding and streaming: compute-heavy, with a light database. Its big, steady server bill is where owning kit pays.
      demand: { cuPerUser: 0.004, dbuPerUser: 0.002 },
      pricing: { fairPrice: 9, freeShare: 0.6, conversionRate: 0.001 },
      support: { ticketsPerPaidUser: 0.01, ticketsPerFreeUser: 0.003 },
      features: [
        {
          id: "hd",
          name: "HD playback",
          blurb: "Videos play in sharp high definition.",
          devDays: 20,
          growthMultiplier: 1.12,
          addonPricePerUser: 0.14,
        },
        {
          id: "comments",
          name: "Comments",
          blurb: "Viewers talk about what they watched.",
          devDays: 10,
          growthMultiplier: 1.05,
          addonPricePerUser: 0.07,
        },
        {
          id: "recommendations",
          name: "Recommendations",
          blurb: "Suggests the next video to keep viewers watching.",
          devDays: 30,
          growthMultiplier: 1.2,
          addonPricePerUser: 0.2,
        },
        {
          id: "live",
          name: "Live streaming",
          blurb: "Creators broadcast live to their followers.",
          devDays: 36,
          growthMultiplier: 1.2,
          addonPricePerUser: 0.2,
        },
      ],
    },
  },
  staff: {
    developers: { name: "Developers", personName: "developer", dayRate: 120, startingCount: 2 },
    ops: { name: "Ops staff", personName: "ops person", dayRate: 120, startingCount: 1 },
    // One to start, enough for the first few weeks: more are needed as users grow.
    support: { name: "Support staff", personName: "support person", dayRate: 100, startingCount: 1 },
  },
  // A senior does about twice a junior's work for about 1.7× the pay: cheaper per unit of work, dearer up front, and
  // slowest to arrive. Placeholders from the beta design.
  staffGrades: {
    junior: { name: "Junior", payMultiplier: 0.75, output: 0.65, leadDays: 3 },
    mid: { name: "Mid", payMultiplier: 1, output: 1, leadDays: 7 },
    senior: { name: "Senior", payMultiplier: 1.3, output: 1.35, leadDays: 14 },
  },
  capacity: { unstaffedShare: 0.4 },
  // Each size gives a set number of units. A CU serves the same users whatever the size, so the sizes are 6/10/20/30 to
  // match the design notes' users per server: at a shop's 0.002 CU each, a small app server serves 3,000 shoppers, a
  // medium 5,000, a large 10,000 and a massive 15,000. Video needs more compute per user, and social less.
  servers: {
    types: {
      app: {
        name: "App server",
        blurb: "Runs your code: compute units (CU).",
        units: { small: 6, medium: 10, large: 20, massive: 30 },
      },
      database: {
        name: "Database",
        blurb: "Stores your data: database units (DBU).",
        units: { small: 6, medium: 10, large: 20, massive: 30 },
      },
      cache: {
        name: "Cache",
        blurb: "Answers repeat reads from memory: each cache hit (CH) takes a DBU off the database.",
        units: { small: 6, medium: 10, large: 20, massive: 30 },
      },
      loadBalancer: {
        name: "Load balancer",
        blurb: "Spreads traffic over your app servers. Needed once you run 2 or more.",
        units: { small: 2, medium: 4, large: 8, massive: 16 },
      },
      // The same sizes as an app server, so switching an app server to APIU gives as many APIU as it gave CU.
      api: {
        name: "API server",
        blurb: "Serves your paid API's calls: API units (APIU).",
        units: { small: 6, medium: 10, large: 20, massive: 30 },
      },
    },
    loadBalancerFrom: 2,
    cacheableShare: 0.5,
  },
  outage: { baseHours: 2, hoursPerOverload: 20, growthMultiplier: 0.25, paidChurnPerHour: 0.001 },
  billing: { daysPerMonth: 30 },
  // Enough for on-prem to buy kit ahead of demand from the start, or to see an IaaS, PaaS or SaaS company through a
  // tight start, for about £3,500 of interest. See LoanConfig for the interest formula.
  loan: { amount: 35_000, baseRate: 0.1, ratePerDay: 0.002, termDays: 120, termPerDay: 0.5, minTermDays: 60, minDays: 14 },
  shares: { min: 10_000, max: 100_000, default: 10_000 },
  // Placeholders. A new company with no revenue is worth the £50k minimum, so friends and family's £15k on day 1 buys
  // about 23% of it; a company making £500 a day with 2,000 paying users is worth about £590k, and the same £15k buys
  // under 3%. Selling early costs far more of the company.
  valuation: {
    revenueDays: 30,
    revenueMultiple: 3,
    growthDays: 30,
    growthBaseUsers: 100,
    growthMultiple: 2,
    maxGrowthMultiple: 4,
    maxGrowthPenalty: 1.5,
    goodSatisfaction: 70,
    satisfactionPenalty: 1.5,
    goodUptime: 99,
    uptimePenaltyPerPoint: 0.5,
    maxUptimePenalty: 1.5,
    valuePerPayingUser: 20,
    minimum: 50_000,
  },
  // Small, to carry a careful student through the early weeks. The grant's 99% over 60 days allows 14.4 hours down.
  funding: { friendsAndFamily: { amount: 15_000 }, grant: { amount: 10_000, days: 60, minUptime: 99 } },
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
    // Customers remember the lowest price for two months, and at twice the fair price 0.5% of payers stop paying each
    // day: at four times it 4.5%, and from 11 times half of them.
    priceMemoryDays: 60,
    priceChurn: 0.005,
    maxPriceChurn: 0.5,
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
    paidChurnAtZero: 0.02,
  },
  // At the fair price with nothing helping or hurting, a shop converts 0.12% of its free users a day. Features, uptime
  // and satisfaction can more than double that, so free users are worth having, but most stay free, still adding load
  // and tickets. Two features with 100% uptime and satisfaction double the rate; double the fair price quarters it.
  conversion: {
    perFeature: 0.15,
    uptimeDays: 7,
    neutralUptime: 95,
    uptimeEffect: 0.25,
    satisfactionEffect: 0.25,
    priceSensitivity: 2,
    maxRate: 0.05,
  },
  // A 20-day feature costs £2,000 to set up: all four on day 1 would take half the starting cash.
  addons: { minConfigDevelopers: 2, setupFeePerDevDay: 100 },
  // An APIU serves 1,000 calls a day, so a small API server (6 APIU) earns about £60 a day when full, for £300 a month
  // on IaaS. A CU earns far more from users, so switching app servers to APIU only pays with CU to spare. A shop with
  // 3,000 paying users heads for 9,000 calls a day (£90), and more with features. On SaaS the provider keeps 0.4p.
  api: {
    pricePerCall: 0.01,
    callsPerApiu: 1_000,
    startingCalls: 2_000,
    dailyGrowth: 0.1,
    perFeature: 0.15,
    outageDrop: 0.2,
    slowDays: 7,
    slowGrowth: 0.25,
    saasFeePerCall: 0.004,
  },
  migration: {
    phases: {
      planning: { name: "Planning", days: 5 },
      testing: { name: "Testing", days: 2 },
      moving: { name: "Moving infrastructure", days: 7 },
    },
    // Users grow while you move, so the new setup has a quarter more room than today's demand needs.
    setupHeadroom: 0.25,
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
      // Triple the CU and DBU demand: more than a sensible setup carries, so only a model that scales stays up.
      load: { multiplier: 2, extra: 80_000, unitMultiplier: 3 },
      effects: {
        onprem: {
          detail:
            "You own the hardware, and new servers take days to arrive, so you can't buy your way out: your kit melted under the load.",
        },
        iaas: {
          opsNeeded: 2,
          // A burst VM costs about 10 times a rented one per unit: renting your own ahead of time is cheaper.
          scaleCostPerUnit: 12,
          detail:
            "Your ops team rented extra VMs to meet it. They're ready the next day, so the first day ran on the servers you had; after that you stayed up, paying for every extra VM.",
          shortOfOps: {
            detail: "Without enough ops staff to rent and set up extra VMs, capacity stayed where it was.",
          },
        },
        paas: {
          // At once, but dearer than renting your own VMs ahead (and than IaaS's £12 from its second day).
          scaleCostPerUnit: 15,
          detail:
            "The platform scaled up by itself from the first minute, so you stayed up, but it bills you for every CU and DBU over your setup.",
        },
        saas: {
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

/** The last day played in a game of a length: day finalDay, 365 or a career's 47 years of 365 days. */
export function gameLengthDays(config: GameConfig, length: GameLengthId): number {
  if (length === "1-year") return 365;
  if (length === "career") return CAREER_YEARS * 365;
  return config.finalDay;
}

/** The game lengths a config lets students pick, shortest first. */
export function allowedGameLengths(config: GameConfig): GameLengthId[] {
  return GAME_LENGTH_IDS.filter((id) => config.allowedGameLengths[id] === 1);
}

/** A game length's name for the screens: "180 days" (or however many the config's shortest game has). */
export function gameLengthName(config: GameConfig, length: GameLengthId): string {
  if (length === "1-year") return "1 year";
  if (length === "career") return `Career (${CAREER_YEARS} years, age 18 to 65)`;
  return `${config.finalDay} days`;
}
