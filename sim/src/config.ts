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

/**
 * Kinds of server. App servers give compute (CU), databases give database units (DBU) and caches give cache hits
 * (CH). A load balancer gives no units: it spreads traffic over app servers. Saved in game state, so don't rename.
 */
export const SERVER_TYPES = ["app", "database", "cache", "loadBalancer"] as const;
export type ServerType = (typeof SERVER_TYPES)[number];

/** Every server type comes in these sizes, smallest first. Saved in game state, so don't rename. */
export const SERVER_SIZES = ["small", "medium", "large", "massive"] as const;
export type ServerSize = (typeof SERVER_SIZES)[number];

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
   * (racks, networking, power and cooling): the starter servers are bought on top, at their purchase prices.
   */
  upfrontCost: number;
  /** Fixed provider bill (or power and upkeep on-prem) per month, billed as a daily share (opex). */
  monthlyCost: number;
  /** Extra per user per month, billed as a daily share on that day's users. SaaS charges per user. */
  monthlyCostPerUser: number;
  /**
   * Ops/sysadmins this model needs to keep running. Fewer as the provider manages more layers. Only for a model
   * without servers: with them, ops needed come from the servers (see ModelServersConfig.opsPerServer).
   */
  opsNeeded?: number;
  /** Load the model can serve in a day when fully staffed. Only for a model without servers, which uses units. */
  capacity?: number;
  /**
   * How the model gets capacity from servers measured in units; left out for a fixed capacity. IaaS rents VMs and
   * on-prem buys servers. PaaS and SaaS keep a fixed capacity until their own slice.
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
}

/**
 * How a model gets servers. Each one is billed monthly, a day's share at a time like the model's own monthly cost. A
 * rented one is billed from the first day played after it's added until the day it's cancelled, so cancelling is pro
 * rata: you pay only for the days you had it. A bought one (see `purchase`) costs its power and upkeep from the day
 * after it arrives until it's sold. Prices go up with the provider's price rises.
 */
export interface ModelServersConfig {
  /** Monthly price of one server, by type and size: rent, or on a model that buys them, power and upkeep. */
  monthlyCost: Record<ServerType, Record<ServerSize, number>>;
  /**
   * Days from adding a server to it being ready: 1 is the next day, and it serves load from the day after that. On a
   * model that buys its servers, the delivery time.
   */
  readyDays: number;
  /**
   * Ops staff each server of a type needs. Ops needed is the total over every server, rounded up: rented ones whether
   * ready or not, bought ones once they've arrived.
   */
  opsPerServer: Record<ServerType, number>;
  /** Set on a model that buys its servers rather than renting them. */
  purchase?: ServerPurchaseConfig;
  /**
   * The servers a new company on this model starts with, ready for the first day. Until migration sizes a setup to
   * demand (#51), a migration onto the model gets these too. On a model that buys its servers, they're bought along
   * with the model's upfront cost, at their purchase prices.
   */
  starter: ServerCount[];
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
  /**
   * The same on a model with servers: extra servers meet the CU and DBU demand over capacity, charged per unit over
   * (infrastructure). They take the model's readyDays to arrive, so they only help from that many days into the
   * event: on IaaS, its first day runs on the servers you have.
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

export interface GameConfig {
  startingCash: number;
  /** The last day played. The game ends once it has been played, so day finalDay is played in full. */
  finalDay: number;
  maxCompanyNameLength: number;
  models: Record<ModelId, ModelConfig>;
  productTypes: Record<ProductTypeId, ProductTypeConfig>;
  staff: Record<StaffPool, StaffPoolConfig>;
  capacity: CapacityConfig;
  servers: ServersConfig;
  outage: OutageConfig;
  billing: BillingConfig;
  pricing: PricingConfig;
  support: SupportConfig;
  conversion: ConversionConfig;
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
      // The server room: racks, networking, power and cooling. The starter servers are bought on top (£4,800), so a new
      // on-prem company pays £34,800 up front, close to the £40,000 it paid before it had servers.
      upfrontCost: 30_000,
      // The premises, bandwidth and the room's own power. Each server's power and upkeep is on top.
      monthlyCost: 1_500,
      monthlyCostPerUser: 0,
      exitPenalty: 0,
      // Placeholders, balanced in #55. A server costs three months' rent of the same VM and a tenth of that rent a month
      // to run, so buying pays off after about three and a half months: worth it early in a game, not late. Selling one
      // back gets 40% of what you paid. Kit you rack, power and patch yourself needs more ops than a VM.
      servers: {
        purchase: {
          price: {
            app: { small: 1_200, medium: 1_650, large: 2_100, massive: 2_550 },
            database: { small: 1_500, medium: 2_100, large: 2_700, massive: 3_300 },
            cache: { small: 450, medium: 600, large: 750, massive: 900 },
            loadBalancer: { small: 600, medium: 900, large: 1_350, massive: 1_800 },
          },
          sellBackShare: 0.4,
        },
        monthlyCost: {
          app: { small: 40, medium: 55, large: 70, massive: 85 },
          database: { small: 50, medium: 70, large: 90, massive: 110 },
          cache: { small: 15, medium: 20, large: 25, massive: 30 },
          loadBalancer: { small: 20, medium: 30, large: 45, massive: 60 },
        },
        readyDays: 10,
        opsPerServer: { app: 0.6, database: 0.6, cache: 0.3, loadBalancer: 0.3 },
        // Bigger than IaaS's, since more takes 10 days to arrive: room for every product to grow for a few weeks.
        starter: [
          { type: "app", size: "large", count: 1 },
          { type: "database", size: "large", count: 1 },
        ],
      },
    },
    iaas: {
      name: "Rent VMs (IaaS)",
      blurb: "Rent virtual machines and run everything on them.",
      comparison: { upfrontCost: "Low", monthlyCost: "Medium", opsNeeded: "Medium", control: "High" },
      upfrontCost: 2_000,
      // The account, storage and bandwidth. The VMs are rented on top.
      monthlyCost: 1_000,
      monthlyCostPerUser: 0,
      exitPenalty: 3_000,
      // Bigger VMs cost less per unit, and caches are the cheap way to take load off the database.
      servers: {
        monthlyCost: {
          app: { small: 400, medium: 550, large: 700, massive: 850 },
          database: { small: 500, medium: 700, large: 900, massive: 1_100 },
          cache: { small: 150, medium: 200, large: 250, massive: 300 },
          loadBalancer: { small: 200, medium: 300, large: 450, massive: 600 },
        },
        readyDays: 1,
        opsPerServer: { app: 0.5, database: 0.5, cache: 0.25, loadBalancer: 0.25 },
        // Enough for every product's starting users with room to grow for a few weeks, run by one ops person.
        starter: [
          { type: "app", size: "medium", count: 1 },
          { type: "database", size: "medium", count: 1 },
        ],
      },
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
      // Baskets and orders: as much database as compute, 250 shoppers to a CU and a DBU.
      demand: { cuPerUser: 0.004, dbuPerUser: 0.004 },
      // Shoppers mostly pay: a shop's free tier is browsing without an account.
      pricing: { fairPrice: 5, freeShare: 0.3, conversionRate: 0.004 },
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
      // Feeds and friends lists: a bit more database than compute.
      demand: { cuPerUser: 0.003, dbuPerUser: 0.004 },
      // Mostly free, like most social networks: a few pay for extras.
      pricing: { fairPrice: 6, freeShare: 0.8, conversionRate: 0.0015 },
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
      // Encoding and streaming: compute-heavy, with a light database.
      demand: { cuPerUser: 0.008, dbuPerUser: 0.002 },
      pricing: { fairPrice: 9, freeShare: 0.6, conversionRate: 0.0025 },
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
  // Placeholders, balanced in #55. Each size gives a set number of units, app servers 10/15/20/25 CU as in the design
  // notes. A CU serves the same users whatever the size (250 shoppers at 0.004 CU each), so a small app server serves
  // 2,500 shoppers and a massive one 6,250, not the notes' 3k/5k/10k/15k, which no one per-user figure fits.
  servers: {
    types: {
      app: {
        name: "App server",
        blurb: "Runs your code: compute units (CU).",
        units: { small: 10, medium: 15, large: 20, massive: 25 },
      },
      database: {
        name: "Database",
        blurb: "Stores your data: database units (DBU).",
        units: { small: 10, medium: 15, large: 20, massive: 25 },
      },
      cache: {
        name: "Cache",
        blurb: "Answers repeat reads from memory: each cache hit (CH) takes a DBU off the database.",
        units: { small: 10, medium: 15, large: 20, massive: 25 },
      },
      loadBalancer: {
        name: "Load balancer",
        blurb: "Spreads traffic over your app servers. Needed once you run 2 or more.",
        units: { small: 2, medium: 4, large: 8, massive: 16 },
      },
    },
    loadBalancerFrom: 2,
    cacheableShare: 0.5,
  },
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
  // Placeholders. At the fair price with nothing helping or hurting, a shop converts 0.4% of its free users a day, so
  // a free user has about an even chance of paying within 180 days: worth having, but most new users still start
  // free. Two features with 100% uptime and satisfaction double the rate; double the fair price quarters it.
  conversion: {
    perFeature: 0.15,
    uptimeDays: 7,
    neutralUptime: 95,
    uptimeEffect: 0.25,
    satisfactionEffect: 0.25,
    priceSensitivity: 2,
    maxRate: 0.05,
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
      // More than any model's normal capacity, so only a model that scales stays up. On servers, triple the demand.
      load: { multiplier: 2, extra: 80_000, unitMultiplier: 3 },
      effects: {
        onprem: {
          detail:
            "You own the hardware, and new servers take days to arrive, so you can't buy your way out: your kit melted under the load.",
        },
        iaas: {
          opsNeeded: 2,
          // A burst VM costs about 20 times a rented one per unit: renting your own ahead of time is cheaper.
          scaleCostPerUnit: 25,
          detail:
            "Your ops team rented extra VMs to meet it. They're ready the next day, so the first day ran on the servers you had; after that you stayed up, paying for every extra VM.",
          shortOfOps: {
            detail: "Without enough ops staff to rent and set up extra VMs, capacity stayed where it was.",
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
