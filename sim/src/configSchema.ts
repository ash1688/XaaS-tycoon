// The teacher's config page: every number in GameConfig a teacher can change, with its group, explanation and allowed
// range. The server validates and stores overrides with it, and the web client draws the page from it.
//
// A path names one number in the config, dot-separated. Lists of things with an id (features, events) are keyed by
// id, other lists by position: "models.iaas.monthlyCost", "productTypes.video.features.hd.devDays",
// "events.osPatch.schedule.days.0". Overrides are a flat map of path to number: only the numbers that differ.
import {
  GAME_LENGTH_IDS,
  MIGRATION_PHASES,
  MODEL_IDS,
  PRODUCT_TYPE_IDS,
  RACK_SIZES,
  SERVER_SIZES,
  SERVER_TYPES,
  STAFF_POOLS,
  defaultConfig,
  gameLengthName,
  type GameConfig,
} from "./config.ts";

export const CONFIG_GROUPS = ["Money", "Customers", "Infrastructure", "People", "Migration", "Events"] as const;
export type ConfigGroup = (typeof CONFIG_GROUPS)[number];

export interface ConfigField {
  path: string;
  group: ConfigGroup;
  /** What it belongs to, for a sub-heading within the group: "IaaS", "Video sharing platform". Empty for game-wide. */
  section: string;
  label: string;
  /** One line on what it does. */
  help: string;
  /** The value in the base config, which a reset goes back to. */
  default: number;
  min: number;
  max: number;
  step: number;
  /** "toggle" for a setting that's on (1) or off (0), drawn as a checkbox. */
  kind?: "toggle";
}

/** Path → number, for only the numbers that differ from the base config. */
export type ConfigOverrides = Record<string, number>;
/** Path → what's wrong with its value. Empty when the overrides are fine. "" is for the overrides as a whole. */
export type ConfigErrors = Record<string, string>;

/**
 * Numbers in GameConfig that aren't on the config page, each with the reason. The completeness test fails on any
 * number that's neither a field nor listed here, so a new number has to be one or the other.
 */
export const CONFIG_EXCLUSIONS: Record<string, string> = {
  maxCompanyNameLength: "A limit on what students type, not a balance number; the name filter and screens rely on it.",
};

const MODEL_LABELS = { onprem: "On-prem", iaas: "IaaS", paas: "PaaS", saas: "SaaS" } as const;

type Range = Pick<ConfigField, "min" | "max" | "step" | "kind">;
const range = (min: number, max: number, step: number): Range => ({ min, max, step });
const TOGGLE = { ...range(0, 1, 1), kind: "toggle" as const };

const POUNDS = range(0, 1_000_000, 100);
const PER_USER = range(0, 10, 0.01);
const SHARE = range(0, 1, 0.01);
const MULTIPLIER = range(0, 10, 0.05);
const HEADCOUNT = range(0, 20, 1);
const GAME_DAY = range(1, 365, 1);
const HOURS = range(0, 24, 1);

/**
 * The numbers an event's effect on one model can set, relative to the effect. The same with "shortOfOps." in front
 * for what happens without enough ops. An effect only gets a field for the numbers it sets in the base config.
 */
const EFFECT_FIELDS: Record<string, { label: string; help: string } & Range> = {
  opsNeeded: { label: "ops needed", help: "Ops staff needed to deal with it; with fewer, the short-of-ops outcome happens.", ...HEADCOUNT },
  scaleCostPerUnit: { label: "cost per CU or DBU over capacity", help: "What scaling up to meet it costs, per CU and DBU of demand over capacity, from the day the extra servers are ready (at once on PaaS).", ...range(0, 1_000, 1) },
  downtimeHours: { label: "hours down", help: "Hours of downtime on top of any outage from load.", ...HOURS },
  "cost.amount": { label: "clean-up cost", help: "A one-off charge for dealing with it.", ...POUNDS },
  "priceRise.percent": { label: "price rise %", help: "The provider's prices go up by this percent for good.", ...range(0, 200, 1) },
  "featureGap.growthMultiplier": { label: "growth while the gap is open", help: "Daily growth is multiplied by this until the company migrates off the model.", ...range(0, 2, 0.05) },
};

/** Every editable number, with its default from the base config. The server's base is defaultConfig plus env. */
export function configFields(base: GameConfig = defaultConfig): ConfigField[] {
  const fields: ConfigField[] = [];
  const add = (path: string, group: ConfigGroup, section: string, label: string, help: string, r: Range) => {
    const value = getAt(base, path);
    // A structure the base config doesn't have (an effect an event doesn't set) has no field.
    if (typeof value === "number") fields.push({ path, group, section, label, help, default: value, ...r });
  };

  // Money
  add("startingCash", "Money", "", "Starting cash", "Cash each new company starts with.", range(0, 10_000_000, 1_000));
  add("loan.amount", "Money", "Bank loan", "Loan amount", "What the bank lends. One loan at a time, at the start or later, and another once it's repaid.", range(0, 10_000_000, 1_000));
  add("loan.baseRate", "Money", "Bank loan", "Interest at the start", "Interest on a loan taken when the game starts, as a share of the amount (0.1 = 10%), repaid with it in equal daily repayments over the loan's term.", range(0, 5, 0.01));
  add("loan.ratePerDay", "Money", "Bank loan", "Extra interest per day later", "Added to the interest rate for each day later the loan is taken (0.002 = 0.2 percentage points a day).", range(0, 0.1, 0.0005));
  add("loan.termDays", "Money", "Bank loan", "Term at the start", "Repayment days for a loan taken when the game starts, whatever the game's length.", range(1, 3_650, 1));
  add("loan.termPerDay", "Money", "Bank loan", "Shorter term per day later", "Days taken off the term for each day later the loan is taken (0.5 = a day shorter every two days).", range(0, 10, 0.05));
  add("loan.minTermDays", "Money", "Bank loan", "Shortest term", "The fewest repayment days a loan has, however late it's taken.", range(1, 3_650, 1));
  add("loan.minDays", "Money", "Bank loan", "No loans in the last days", "The bank won't lend with fewer days than this left in the game.", range(1, 365, 1));
  add("billing.daysPerMonth", "Money", "", "Days in a billing month", "Monthly costs are charged a day at a time: the monthly cost ÷ this.", range(28, 31, 1));
  for (const m of MODEL_IDS) {
    const s = MODEL_LABELS[m];
    const upfrontHelp = base.models[m]?.servers?.purchase
      ? "Charged once on moving to this model: the server room. The servers are bought on top, at their purchase prices."
      : "Charged once on moving to this model.";
    add(`models.${m}.upfrontCost`, "Money", s, "Upfront cost", upfrontHelp, POUNDS);
    add(`models.${m}.monthlyCost`, "Money", s, "Monthly cost", "The provider's fixed bill (the premises and bandwidth on-prem), billed daily.", range(0, 200_000, 100));
    add(`models.${m}.powerAndCooling`, "Money", s, "Power and cooling a day", "Charged every day played, whatever the company runs. Highest on-prem, where you run the kit yourself.", range(0, 10_000, 1));
    add(`models.${m}.monthlyCostPerUser`, "Money", s, "Monthly cost per user", "Extra per user per month, billed daily on that day's users.", PER_USER);
    add(`models.${m}.exitPenalty`, "Money", s, "Exit penalty", "The provider's fee for leaving, charged when a migration away completes.", POUNDS);
  }
  for (const m of MODEL_IDS) {
    const servers = base.models[m]?.servers;
    if (!servers) continue;
    for (const t of SERVER_TYPES) {
      for (const size of SERVER_SIZES) {
        const name = base.servers.types[t]?.name ?? t;
        if (servers.managed) {
          const managedName = t === "app" ? "App instance" : `Managed ${name.toLowerCase()}`;
          add(`models.${m}.servers.monthlyCost.${t}.${size}`, "Money", MODEL_LABELS[m], `${managedName} (${size}): monthly price`, "What one costs a month, billed daily. The provider runs it, so it's ready at once and needs no ops.", range(0, 100_000, 10));
        } else if (servers.purchase) {
          add(`models.${m}.servers.purchase.price.${t}.${size}`, "Money", MODEL_LABELS[m], `${name} (${size}): purchase price`, "What buying one of these servers costs, charged at once (capex).", range(0, 1_000_000, 100));
          add(`models.${m}.servers.monthlyCost.${t}.${size}`, "Money", MODEL_LABELS[m], `${name} (${size}): running cost a month`, "Power and upkeep for one of these servers, billed daily from the day after it arrives.", range(0, 100_000, 5));
        } else {
          add(`models.${m}.servers.monthlyCost.${t}.${size}`, "Money", MODEL_LABELS[m], `${name} (${size}): monthly price`, "What one of these servers costs a month, billed daily from the day after it's added.", range(0, 100_000, 10));
        }
      }
    }
    if (servers.purchase) {
      add(`models.${m}.servers.purchase.sellBackShare`, "Money", MODEL_LABELS[m], "Sell-back share", "Share of what a server or rack cost that selling it back refunds (0.4 = 40%), so bought kit is sold at a loss.", SHARE);
      add(`models.${m}.servers.purchase.cablingCost`, "Money", MODEL_LABELS[m], "Cabling", "Charged on top of the price for each server or rack bought.", range(0, 100_000, 5));
    }
    if (servers.racks) {
      for (const size of RACK_SIZES) {
        add(`models.${m}.servers.racks.sizes.${size}.price`, "Money", MODEL_LABELS[m], `Rack (${size}): purchase price`, "What buying a rack of this size costs, charged at once (capex).", range(0, 1_000_000, 50));
      }
    }
  }
  add("pricing.maxPrice", "Money", "", "Highest monthly price", "The most a student can charge each paying user a month. High on purpose.", range(1, 100_000, 1));
  for (const p of PRODUCT_TYPE_IDS) {
    const product = base.productTypes[p];
    if (!product) continue;
    add(`productTypes.${p}.pricing.fairPrice`, "Money", product.name, "Fair price", "The monthly price users think it's worth, and where a new company starts.", range(0.01, 10_000, 0.01));
  }
  for (const p of PRODUCT_TYPE_IDS) {
    for (const f of base.productTypes[p]?.features ?? []) {
      const at = `productTypes.${p}.features.${f.id}`;
      const s = base.productTypes[p].name;
      add(`${at}.addonPricePerUser`, "Money", s, `${f.name}: add-on price per user`, "On SaaS, the add-on's monthly price per user, billed daily.", PER_USER);
    }
  }

  // Customers
  (base.launch?.rampShares ?? []).forEach((_, i) => {
    add(`launch.rampShares.${i}`, "Customers", "Launch", `Launch ramp: share on day ${i + 1}`, "Share of the launch users arriving on this day of the launch ramp, from the first day with servers ready. The days' shares are scaled to add up to the whole launch total.", SHARE);
  });
  for (const p of PRODUCT_TYPE_IDS) {
    const product = base.productTypes[p];
    if (!product) continue;
    const s = product.name;
    const g = `productTypes.${p}.growth`;
    add(`${g}.launchUsersMin`, "Customers", s, "Launch users: fewest", "Each game draws how many users trickle in over its launch ramp from this range, split paid and free by the free share. Students see only those who have joined.", range(0, 1_000_000, 100));
    add(`${g}.launchUsersMax`, "Customers", s, "Launch users: most", "The top of the range each game's launch users are drawn from.", range(0, 1_000_000, 100));
    add(`${g}.marketSize`, "Customers", s, "Market size", "Users the product can reach. Growth slows as users approach it.", range(1, 10_000_000, 1_000));
    add(`${g}.dailyGrowth`, "Customers", s, "Daily growth", "Share of users added each day while the market is wide open (0.05 = 5%).", range(0, 1, 0.005));
    add(`${g}.growthNoise`, "Customers", s, "Growth variation", "Daily growth varies randomly by up to this share either way.", SHARE);
    add(`${g}.seasonalSpike.firstDay`, "Customers", s, "Seasonal spike: first day", "The day the first busy season starts.", GAME_DAY);
    add(`${g}.seasonalSpike.every`, "Customers", s, "Seasonal spike: every (days)", "Days from the start of one busy season to the next.", GAME_DAY);
    add(`${g}.seasonalSpike.length`, "Customers", s, "Seasonal spike: length (days)", "How many days each busy season lasts.", GAME_DAY);
    add(`${g}.seasonalSpike.growthMultiplier`, "Customers", s, "Seasonal spike: growth multiplier", "Growth is multiplied by this during a busy season.", MULTIPLIER);
    add(`productTypes.${p}.pricing.freeShare`, "Customers", s, "Free share", "Share of users on the free tier, at the start and among new users at the fair price.", SHARE);
    add(`productTypes.${p}.pricing.conversionRate`, "Customers", s, "Free-to-paid conversion rate", "Share of free users who start paying each day, before features, uptime, satisfaction and price (0.004 = 0.4%).", range(0, 0.1, 0.0005));
    for (const f of product.features) {
      add(`productTypes.${p}.features.${f.id}.growthMultiplier`, "Customers", s, `${f.name}: growth multiplier`, "Once built or bought, daily growth is multiplied by this (1.1 = 10% faster).", range(0, 5, 0.01));
    }
  }
  add("outage.growthMultiplier", "Customers", "", "Growth on an outage day", "Growth is multiplied by this on a day with an outage.", SHARE);
  add("outage.paidChurnPerHour", "Customers", "", "Payers lost per hour down", "Share of paying users who stop paying for each hour of downtime (0.002 = 0.2%).", range(0, 0.1, 0.0005));
  add("pricing.growthSensitivity", "Customers", "", "Price effect on growth", "Growth is multiplied by (price ÷ fair price) to minus this. 0 for no effect.", range(0, 5, 0.05));
  add("pricing.maxGrowthBoost", "Customers", "", "Most a low price speeds growth", "A price below the fair price multiplies growth by at most this.", range(1, 10, 0.05));
  add("pricing.paidShareSensitivity", "Customers", "", "Price effect on new payers", "The paid share of new users is multiplied by (price ÷ fair price) to minus this.", range(0, 5, 0.05));

  // Customers: price waves and the price lock
  const W = "Price changes";
  add("pricing.waveDays", "Customers", W, "Wave length (days)", "Days a price change's wave of reactions lasts: a small reaction on day 1, then the main effect.", range(1, 60, 1));
  add("pricing.lockDays", "Customers", W, "Price lock (days)", "Days the price can't be changed again after a change.", range(0, 90, 1));
  add("pricing.firstDayShare", "Customers", W, "First-day share", "Share of a wave's whole effect that lands on its first day.", SHARE);
  add("pricing.waveCurve", "Customers", W, "Wave curve", "Wave size grows with (change ÷ fair price) to this power. Above 1, small changes barely register and big jumps hit hard.", range(0.5, 4, 0.05));
  add("pricing.riseStrength", "Customers", W, "Rise strength", "A rise affects this × (rise ÷ fair price)^curve of paying users, before the extra hit and the cap.", range(0, 5, 0.05));
  add("pricing.dearness", "Customers", W, "Extra hit when already dear", "A rise's effect is multiplied by (new price ÷ fair price) to this power. 0 for no effect.", range(0, 5, 0.05));
  add("pricing.maxRiseShare", "Customers", W, "Most payers one rise can lose", "The biggest share of paying users one rise can affect.", SHARE);
  add("pricing.dropToFreeShare", "Customers", W, "Drop to free share", "Of the paying users a rise affects, the share who drop to free. The rest leave.", SHARE);
  add("pricing.backlashTicketsPerUser", "Customers", W, "Backlash tickets per user", "Support tickets each affected user raises over a rise's backlash.", range(0, 20, 0.1));
  add("pricing.cutGainStrength", "Customers", W, "Cut: new users", "A cut brings this × (cut ÷ fair price)^curve new users, as a share of users, before the cap.", range(0, 5, 0.05));
  add("pricing.maxCutGain", "Customers", W, "Cut: most new users", "The most new users one cut can bring, as a share of users.", range(0, 5, 0.05));
  add("pricing.cutUpgradeStrength", "Customers", W, "Cut: upgrades", "A cut turns this × (cut ÷ fair price)^curve of free users into payers, before the cap.", range(0, 5, 0.05));
  add("pricing.maxCutUpgrade", "Customers", W, "Cut: most upgrades", "The most of the free users one cut can turn into payers.", SHARE);
  add("pricing.priceMemoryDays", "Customers", W, "Price memory (days)", "A cut only counts below the lowest price customers remember from this many days, so undoing a rise brings no wave.", range(0, 180, 1));
  add("pricing.priceChurn", "Customers", "", "Payers lost to a dear price", "Share of paying users who stop paying each day at twice the fair price; × (price ÷ fair − 1)² in general.", range(0, 0.5, 0.001));
  add("pricing.maxPriceChurn", "Customers", "", "Most payers lost to a dear price a day", "The most of the paying users a dear price can lose in a day.", SHARE);

  // Customers: free-to-paid conversion. The daily rate is the product's base rate × each multiplier, at most the cap.
  const C = "Free-to-paid conversion";
  add("conversion.perFeature", "Customers", C, "Boost per feature", "Each feature built or add-on bought adds this to the conversion multiplier (0.15 = 15% more each).", range(0, 2, 0.01));
  add("conversion.uptimeDays", "Customers", C, "Recent uptime (days)", "Days of recent uptime that count towards conversion: the last days played.", range(1, 60, 1));
  add("conversion.neutralUptime", "Customers", C, "Neutral uptime %", "Recent uptime at which uptime neither helps nor hurts conversion. Above it helps, below it hurts.", range(0, 99, 0.5));
  add("conversion.uptimeEffect", "Customers", C, "Uptime effect", "100% recent uptime multiplies conversion by 1 + this; each step below neutral lowers it at the same rate.", range(0, 5, 0.05));
  add("conversion.satisfactionEffect", "Customers", C, "Satisfaction effect", "100% satisfaction multiplies conversion by 1 + this, with good satisfaction as the neutral line.", range(0, 5, 0.05));
  add("conversion.priceSensitivity", "Customers", C, "Price effect on conversion", "Above the fair price, conversion is multiplied by (price ÷ fair price) to minus this. 0 for no effect.", range(0, 5, 0.05));
  add("conversion.maxRate", "Customers", C, "Highest conversion rate", "The most of the free users who can start paying in a day, whatever helps.", range(0, 1, 0.005));

  // Customers: support tickets and satisfaction
  const TICKET_RATE = range(0, 1, 0.001);
  for (const p of PRODUCT_TYPE_IDS) {
    const product = base.productTypes[p];
    if (!product) continue;
    add(`productTypes.${p}.support.ticketsPerPaidUser`, "Customers", product.name, "Tickets per paying user", "Support tickets each paying user raises a day, on average (0.01 = 1 per 100 users).", TICKET_RATE);
    add(`productTypes.${p}.support.ticketsPerFreeUser`, "Customers", product.name, "Tickets per free user", "The same for each free user: usually lower, but you still answer them.", TICKET_RATE);
  }
  add("support.ticketsPerUserPerHourDown", "Customers", "Support", "Tickets per user per hour down", "Extra tickets each user raises for every hour of an outage, yours or the provider's.", range(0, 0.1, 0.0005));
  add("support.bigBurstShare", "Customers", "Support", "Burst worth logging", "A burst of tickets is logged when it adds at least this share of the day's usual tickets.", range(0, 10, 0.05));
  add("support.backlogPerUserAtZero", "Customers", "Support", "Backlog per user for 0% satisfaction", "Satisfaction heads for 0% when the backlog reaches this many tickets per user (0.05 = 1 per 20).", range(0.001, 1, 0.001));
  add("support.satisfactionSpeed", "Customers", "Support", "Satisfaction speed", "Share of the gap to its target satisfaction closes each day. Higher moves faster.", range(0.01, 1, 0.01));
  add("support.goodSatisfaction", "Customers", "Support", "Good satisfaction %", "At or above this, satisfaction doesn't hurt growth or churn. Below it, the lower the worse.", range(1, 100, 1));
  add("support.poorSatisfaction", "Customers", "Support", "Poor satisfaction %", "Falling below this is logged as a warning.", range(0, 100, 1));
  add("support.growthAtZero", "Customers", "Support", "Growth at 0% satisfaction", "Daily growth is multiplied by this at 0% satisfaction, rising to 1 at good satisfaction.", SHARE);
  add("support.churnAtZero", "Customers", "Support", "Churn at 0% satisfaction", "Share of users who leave each day at 0% satisfaction, falling to none at good satisfaction.", range(0, 0.5, 0.001));
  add("support.paidChurnAtZero", "Customers", "Support", "Payers lost at 0% satisfaction", "On top, the share of paying users who stop paying each day at 0% satisfaction, falling to none at good satisfaction.", range(0, 0.5, 0.001));

  // Infrastructure
  for (const p of PRODUCT_TYPE_IDS) {
    const product = base.productTypes[p];
    if (!product) continue;
    const g = `productTypes.${p}.growth`;
    add(`${g}.loadPerUser`, "Infrastructure", product.name, "Load per user", "Load each user puts on the system per day.", range(0, 100, 0.1));
    add(`${g}.loadNoise`, "Infrastructure", product.name, "Load variation", "Daily load varies randomly by up to this share either way.", SHARE);
    add(`${g}.seasonalSpike.loadMultiplier`, "Infrastructure", product.name, "Seasonal spike: load multiplier", "Load is multiplied by this during a busy season.", MULTIPLIER);
  }
  for (const p of PRODUCT_TYPE_IDS) {
    const product = base.productTypes[p];
    if (!product) continue;
    const UNIT_DEMAND = range(0, 1, 0.0005);
    add(`productTypes.${p}.demand.cuPerUser`, "Infrastructure", product.name, "CU per user", "Compute units each user needs from app servers, paying or free (0.004 = 250 users a CU).", UNIT_DEMAND);
    add(`productTypes.${p}.demand.dbuPerUser`, "Infrastructure", product.name, "DBU per user", "Database units each user needs, paying or free, before any cache.", UNIT_DEMAND);
  }
  const S = "Servers";
  for (const t of SERVER_TYPES) {
    const type = base.servers.types[t];
    if (!type) continue;
    const unit = t === "app" ? "CU" : t === "database" ? "DBU" : t === "cache" ? "CH" : "app servers served";
    for (const size of SERVER_SIZES) {
      add(`servers.types.${t}.units.${size}`, "Infrastructure", S, `${type.name} (${size}): ${unit}`, t === "loadBalancer" ? "How many app servers one load balancer of this size can serve." : `The ${unit} one server of this size gives.`, range(0, 10_000, 1));
    }
  }
  add("servers.loadBalancerFrom", "Infrastructure", S, "Load balancers needed from", "App servers from which load balancers are needed. Without one, traffic reaches only one app server.", range(1, 20, 1));
  add("servers.cacheableShare", "Infrastructure", S, "Cacheable share of database demand", "The most of the database demand caches can take, one cache hit for one DBU.", SHARE);
  for (const m of MODEL_IDS) {
    const servers = base.models[m]?.servers;
    if (!servers) continue;
    if (servers.purchase) {
      add(`models.${m}.servers.readyDays`, "Infrastructure", MODEL_LABELS[m], "Delivery time (days)", "Days from buying a server to it arriving. It's on order until then, and serves from the day after.", range(0, 60, 1));
    } else {
      add(`models.${m}.servers.readyDays`, "Infrastructure", MODEL_LABELS[m], "Days until a server is ready", "Days from adding a server to it being ready (1 = the next day). It serves from the day after.", range(0, 60, 1));
    }
    if (servers.racks) {
      for (const size of RACK_SIZES) {
        add(`models.${m}.servers.racks.sizes.${size}.units`, "Infrastructure", MODEL_LABELS[m], `Rack (${size}): rack units (U)`, "The U a rack of this size holds. Every server is installed in a rack with room for it.", range(1, 100, 1));
      }
      for (const size of SERVER_SIZES) {
        add(`models.${m}.servers.racks.serverUnits.${size}`, "Infrastructure", MODEL_LABELS[m], `Server (${size}): rack units (U)`, "The U a server of this size takes in its rack, from the day it's ordered.", range(0, 100, 1));
      }
    }
    if (servers.managed) {
      add(`models.${m}.servers.managed.maxInstances`, "Infrastructure", MODEL_LABELS[m], "Most app instances", "The most app instances a company can run on the platform.", range(1, 100, 1));
      for (const t of ["database", "cache"] as const) {
        for (const size of SERVER_SIZES) {
          const unit = t === "database" ? "DBU" : "CH";
          add(`models.${m}.servers.managed.units.${t}.${size}`, "Infrastructure", MODEL_LABELS[m], `Managed ${t} (${size}): ${unit}`, `The ${unit} a managed ${t} of this size gives. You run only one, so the sizes go higher than a server's.`, range(0, 10_000, 1));
        }
      }
    }
  }
  add("capacity.unstaffedShare", "Infrastructure", "", "Capacity with no ops", "Share of capacity a model keeps with no ops at all, rising with ops up to full.", SHARE);
  add("outage.baseHours", "Infrastructure", "", "Outage hours", "Hours down on any day load exceeds capacity.", HOURS);
  add("outage.hoursPerOverload", "Infrastructure", "", "Extra hours per 100% overload", "Extra hours down per 100% of load over capacity, up to 24 a day.", range(0, 100, 1));

  // People
  for (const pool of STAFF_POOLS) {
    const s = base.staff[pool]?.name ?? pool;
    add(`staff.${pool}.dayRate`, "People", s, "Day rate", "Cost per person per day.", range(0, 2_000, 10));
    add(`staff.${pool}.startingCount`, "People", s, "Starting headcount", "How many a new company starts with.", HEADCOUNT);
  }
  for (const m of MODEL_IDS) {
    add(`models.${m}.opsNeeded`, "People", MODEL_LABELS[m], "Ops needed", "Ops staff this model needs to keep the service running, however big it gets. Too few cuts capacity on a model with servers.", HEADCOUNT);
    for (const t of SERVER_TYPES) {
      const name = base.servers.types[t]?.name ?? t;
      add(`models.${m}.servers.opsPerServer.${t}`, "People", MODEL_LABELS[m], `Ops per ${name.toLowerCase()}`, "Ops staff each one needs. Ops needed is the total over every server, rounded up.", range(0, 5, 0.05));
    }
  }
  for (const p of PRODUCT_TYPE_IDS) {
    for (const f of base.productTypes[p]?.features ?? []) {
      add(`productTypes.${p}.features.${f.id}.devDays`, "People", base.productTypes[p].name, `${f.name}: developer-days`, "Work to build it. A developer does one developer-day a day.", range(1, 365, 1));
    }
  }
  add("support.ticketsPerPerson", "People", "", "Tickets per support person", "Tickets one support person clears a day.", range(1, 1_000, 1));
  add("addons.minConfigDevelopers", "People", "", "Developers to configure add-ons", "On SaaS, add-ons can't be bought with fewer developers than this.", HEADCOUNT);
  add("addons.setupFeePerDevDay", "Money", "", "Add-on set-up fee per developer-day", "On SaaS, an add-on costs this × the developer-days it would take to build, once, when it's bought.", range(0, 10_000, 10));

  // Migration
  for (const phase of MIGRATION_PHASES) {
    const name = base.migration.phases[phase]?.name ?? phase;
    add(`migration.phases.${phase}.days`, "Migration", "", `${name}: days`, "Days this phase of a migration takes before any overrun.", range(1, 90, 1));
  }
  add("migration.setupHeadroom", "Migration", "", "New setup headroom", "A migration builds a setup on the new model sized to today's usual demand plus this share (0.25 = 25% more), so there's room to grow.", range(0, 2, 0.05));
  add("migration.overrun.chance", "Migration", "", "Overrun chance", "Chance a migration overruns (0.3 = 3 in 10).", SHARE);
  add("migration.overrun.minDays", "Migration", "", "Overrun: fewest extra days", "An overrun adds between the fewest and most extra days.", range(0, 60, 1));
  add("migration.overrun.maxDays", "Migration", "", "Overrun: most extra days", "An overrun adds between the fewest and most extra days.", range(0, 60, 1));

  // Events
  add("finalDay", "Events", "Game length", "Short game length (days)", "The last day played in the shortest game length (180 days by default). The game ends once it has been played. The bank loan is repaid by this day in every length.", range(2, 365, 1));
  for (const l of GAME_LENGTH_IDS) {
    const name = l === "180-days" ? "the short game" : gameLengthName(base, l);
    add(`allowedGameLengths.${l}`, "Events", "Game length", `Allow ${name}`, "Students can pick this length when starting a company. A change only affects new games.", TOGGLE);
  }
  for (const event of base.events) {
    const at = `events.${event.id}`;
    const s = event.name;
    if (event.schedule.type === "fixed") {
      event.schedule.days.forEach((_, i) => {
        add(`${at}.schedule.days.${i}`, "Events", s, `Fires on day (${i + 1})`, "A day it fires on in every game.", GAME_DAY);
      });
    } else {
      add(`${at}.schedule.count`, "Events", s, "Times it fires", "How many different days it fires on, picked at random per game.", range(0, 20, 1));
      add(`${at}.schedule.fromDay`, "Events", s, "Earliest day", "The first day it can be picked for.", GAME_DAY);
      add(`${at}.schedule.toDay`, "Events", s, "Latest day", "The last day it can be picked for.", GAME_DAY);
    }
    add(`${at}.days`, "Events", s, "Days it lasts", "Days it lasts from the day it fires.", range(1, 30, 1));
    add(`${at}.load.multiplier`, "Events", s, "Load multiplier", "While it's on, the day's load is multiplied by this…", MULTIPLIER);
    add(`${at}.load.extra`, "Events", s, "Extra load", "…and this much load is added.", range(0, 1_000_000, 1_000));
    add(`${at}.load.unitMultiplier`, "Events", s, "CU and DBU demand multiplier", "On a model with servers, CU and DBU demand are multiplied by this while it's on.", MULTIPLIER);
    for (const m of MODEL_IDS) {
      if (!event.effects[m]) continue;
      for (const [rel, meta] of Object.entries(EFFECT_FIELDS)) {
        for (const [prefix, when] of [["", ""], ["shortOfOps.", ", short of ops"]] as const) {
          const help = prefix ? `Without enough ops: ${meta.help[0]!.toLowerCase()}${meta.help.slice(1)}` : meta.help;
          add(`${at}.effects.${m}.${prefix}${rel}`, "Events", s, `${MODEL_LABELS[m]}${when}: ${meta.label}`, help, meta);
        }
      }
    }
  }
  return fields;
}

/** The value at a path, or undefined if there's nothing there. */
export function getAt(config: unknown, path: string): unknown {
  let at: unknown = config;
  for (const key of path ? path.split(".") : []) {
    if (Array.isArray(at)) at = at.find((item) => item?.id === key) ?? (/^\d+$/.test(key) ? at[Number(key)] : undefined);
    else if (at && typeof at === "object") at = (at as Record<string, unknown>)[key];
    else return undefined;
  }
  return at;
}

/** Every number in a config, as paths: the completeness test checks each is a field or excluded. */
export function numericPaths(config: unknown, prefix = ""): string[] {
  if (typeof config === "number") return [prefix];
  if (!config || typeof config !== "object") return [];
  const entries = Array.isArray(config)
    ? config.map((item, i) => [item && typeof item === "object" && "id" in item ? String(item.id) : String(i), item])
    : Object.entries(config);
  return entries.flatMap(([key, value]) => numericPaths(value, prefix ? `${prefix}.${key}` : key));
}

const formatNumber = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 4 });

/**
 * Checks overrides against the fields: each must be a known path with a number in range (a whole number where the
 * step is whole). Then checks the pairs that only make sense together, once merged over the base. Returns an error
 * per path; empty when they're fine.
 */
export function validateOverrides(overrides: unknown, base: GameConfig = defaultConfig): ConfigErrors {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return { "": "The settings must be a list of numbers by name." };
  }
  const fields = new Map(configFields(base).map((f) => [f.path, f]));
  const errors: ConfigErrors = {};
  for (const [path, value] of Object.entries(overrides)) {
    const field = fields.get(path);
    if (!field) errors[path] = "There's no setting with this name.";
    else if (typeof value !== "number" || !Number.isFinite(value)) errors[path] = "Must be a number.";
    else if (value < field.min || value > field.max) {
      errors[path] = `Must be from ${formatNumber(field.min)} to ${formatNumber(field.max)}.`;
    } else if (Number.isInteger(field.step) && !Number.isInteger(value)) errors[path] = "Must be a whole number.";
  }
  if (Object.keys(errors).length) return errors;

  // Pairs where the second must be at least the first. The error goes on whichever one was changed.
  const config = applyOverrides(overrides as ConfigOverrides, base);
  const pairs: [low: string, high: string, message: string][] = [
    ["migration.overrun.minDays", "migration.overrun.maxDays", "The most extra days can't be fewer than the fewest."],
    ["support.poorSatisfaction", "support.goodSatisfaction", "Good satisfaction can't be below poor satisfaction."],
    ["loan.minDays", "finalDay", "The days with no loans can't be more than the game's length."],
    ["loan.minTermDays", "loan.termDays", "The term at the start can't be shorter than the shortest term."],
    // A new company starts at the fair price, so it has to be one the student could set.
    ...PRODUCT_TYPE_IDS.filter((p) => base.productTypes[p]).map((p): [string, string, string] => [
      `productTypes.${p}.pricing.fairPrice`,
      "pricing.maxPrice",
      "The highest price can't be below a product's fair price.",
    ]),
    ...PRODUCT_TYPE_IDS.filter((p) => base.productTypes[p]).map((p): [string, string, string] => [
      `productTypes.${p}.growth.launchUsersMin`,
      `productTypes.${p}.growth.launchUsersMax`,
      "The most launch users can't be fewer than the fewest.",
    ]),
    // Every server has to fit in the biggest rack, or it could never be bought.
    ...MODEL_IDS.filter((m) => base.models[m]?.servers?.racks).flatMap((m) =>
      SERVER_SIZES.map((size): [string, string, string] => [
        `models.${m}.servers.racks.serverUnits.${size}`,
        `models.${m}.servers.racks.sizes.${RACK_SIZES[RACK_SIZES.length - 1]}.units`,
        "Every server has to fit in the biggest rack.",
      ]),
    ),
    ...base.events
      .filter((e) => e.schedule.type === "seeded")
      .map((e): [string, string, string] => [
        `events.${e.id}.schedule.fromDay`,
        `events.${e.id}.schedule.toDay`,
        "The latest day can't be before the earliest day.",
      ]),
  ];
  if (GAME_LENGTH_IDS.every((l) => config.allowedGameLengths[l] !== 1)) {
    const changed = GAME_LENGTH_IDS.find((l) => `allowedGameLengths.${l}` in overrides) ?? GAME_LENGTH_IDS[0];
    errors[`allowedGameLengths.${changed}`] = "At least one game length must be allowed.";
  }
  for (const [low, high, message] of pairs) {
    if ((getAt(config, high) as number) < (getAt(config, low) as number)) {
      errors[high in overrides ? high : low] = message;
    }
  }
  return errors;
}

/** The base config with the overrides merged over it. Throws on a path that isn't in the config. */
export function applyOverrides(overrides: ConfigOverrides, base: GameConfig = defaultConfig): GameConfig {
  const config = structuredClone(base);
  for (const [path, value] of Object.entries(overrides)) {
    const keys = path.split(".");
    const last = keys.pop()!;
    const parent = getAt(config, keys.join(".")) as Record<string, unknown> | undefined;
    if (!parent || typeof parent !== "object" || typeof parent[last] !== "number") {
      throw new Error(`Unknown config setting: ${path}`);
    }
    parent[last] = value;
  }
  return config;
}

/** The fields whose value in the config differs from the base: the overrides that turn the base into it. */
export function diffFromDefaults(config: GameConfig, base: GameConfig = defaultConfig): ConfigOverrides {
  const overrides: ConfigOverrides = {};
  for (const field of configFields(base)) {
    const value = getAt(config, field.path);
    if (typeof value === "number" && value !== field.default) overrides[field.path] = value;
  }
  return overrides;
}
