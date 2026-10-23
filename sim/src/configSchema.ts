// The teacher's config page: every number in GameConfig a teacher can change, with its group, explanation and allowed
// range. The server validates and stores overrides with it, and the web client draws the page from it.
//
// A path names one number in the config, dot-separated. Lists of things with an id (features, events) are keyed by
// id, other lists by position: "models.iaas.monthlyCost", "productTypes.video.features.hd.devDays",
// "events.osPatch.encounter.chance". Overrides are a flat map of path to number: only the numbers that differ.
import {
  CUSTOMER_TYPE_IDS,
  DANGER_RISKS,
  GAME_LENGTH_IDS,
  MIGRATION_PHASES,
  MODEL_IDS,
  PRODUCT_TYPE_IDS,
  RACK_SIZES,
  SERVER_SIZES,
  SERVER_TYPES,
  STAFF_GRADES,
  STAFF_POOLS,
  defaultConfig,
  type DangerRisk,
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
  "shares.min": "The range of shares a student can pick is fixed by the design: 10,000 to 100,000.",
  "shares.max": "The range of shares a student can pick is fixed by the design: 10,000 to 100,000.",
  "shares.default": "Only what the new-company form starts on; the student picks their own.",
  "calendar.startYear": "The server starts each game in the current year; this is only the sim's default.",
  // A holiday's dates are the real calendar's: Christmas is on the 25th whatever the preset.
  ...Object.fromEntries(
    defaultConfig.calendar.holidays.flatMap((h) =>
      numericPaths(h.start, `calendar.holidays.${h.id}.start`).map((p) => [p, "A holiday falls on its real dates every year."]),
    ),
  ),
};

const MODEL_LABELS = { onprem: "On-prem", iaas: "IaaS", paas: "PaaS", saas: "SaaS" } as const;
const RISK_LABELS: Record<DangerRisk, string> = {
  unpatched: "servers unpatched",
  overloaded: "capacity overloaded",
  lowSatisfaction: "low satisfaction",
};

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
  add("valuation.minimum", "Money", "Valuation", "Lowest valuation", "A company is never valued below this, even with no revenue.", POUNDS);
  add("valuation.averageDays", "Money", "Valuation", "Averaged over", "Days that revenue, paying users and satisfaction are averaged over for the valuation, so one day can't swing it and a price change can't move it at once.", GAME_DAY);
  add("valuation.fallDays", "Money", "Valuation", "Falls in revenue counted over", "Revenue is the lower of its average over the days above and over this many, so income lost shows within these days but a rise counts slowly.", GAME_DAY);
  add("valuation.revenueMultiple", "Money", "Valuation", "Revenue multiple", "Annual revenue counts this many times over in the valuation, before growth, satisfaction and uptime move it.", MULTIPLIER);
  add("valuation.minMultiple", "Money", "Valuation", "Lowest revenue multiple", "However badly growth, satisfaction and uptime are going, annual revenue counts at least this many times over.", MULTIPLIER);
  add("valuation.valuePerPayingUser", "Money", "Valuation", "Value per paying user", "Each paying user adds this to the valuation, so it can't be inflated by price alone.", range(0, 1_000, 1));
  add("valuation.growthDays", "Money", "Valuation", "Growth measured over", "Days back to compare average paying users with, for growth.", GAME_DAY);
  add("valuation.growthBaseUsers", "Money", "Valuation", "Growth measured from at least", "Growth is the change in paying users ÷ those then, or ÷ this many if there were fewer.", range(1, 100_000, 1));
  add("valuation.growthMultiple", "Money", "Valuation", "Multiple per 100% growth", "Added to the revenue multiple for each 100% growth in paying users over the period (taken off for a fall).", MULTIPLIER);
  add("valuation.maxGrowthMultiple", "Money", "Valuation", "Most growth adds", "The most growth can add to the multiple.", MULTIPLIER);
  add("valuation.maxGrowthPenalty", "Money", "Valuation", "Most a fall takes", "The most falling paying users can take off the multiple.", MULTIPLIER);
  add("valuation.goodSatisfaction", "Money", "Valuation", "Satisfaction that costs nothing", "Below this satisfaction %, the multiple falls.", range(0, 100, 1));
  add("valuation.satisfactionPenalty", "Money", "Valuation", "Multiple lost at 0% satisfaction", "Taken off the multiple at 0% satisfaction, and a share of it in between.", MULTIPLIER);
  add("valuation.goodUptime", "Money", "Valuation", "Uptime that costs nothing", "Below this recent uptime %, the multiple falls.", range(0, 100, 0.1));
  add("valuation.uptimePenaltyPerPoint", "Money", "Valuation", "Multiple lost per point of uptime", "Taken off the multiple for each percentage point of recent uptime below the line.", MULTIPLIER);
  add("valuation.maxUptimePenalty", "Money", "Valuation", "Most poor uptime takes", "The most poor uptime can take off the multiple.", MULTIPLIER);
  add("funding.friendsAndFamily.amount", "Money", "Friends and family", "Amount", "What friends and family put in, once, for new shares at the share price.", POUNDS);
  add("funding.grant.amount", "Money", "Grant", "Amount", "What the grant gives, once, for no shares.", POUNDS);
  add("funding.grant.days", "Money", "Grant", "Condition lasts", "Days the grant's uptime condition applies, from the day after it's accepted or after the launch ramp, whichever is later.", GAME_DAY);
  for (const m of MODEL_IDS) {
    add(`funding.grant.minUptime.${m}`, "Money", "Grant", `Uptime needed (${MODEL_LABELS[m]})`, "Uptime % a company on this model must keep over those days, or the grant is withdrawn and paid back.", range(0, 100, 0.1));
  }
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
          const managedName = t === "app" ? "App instance" : t === "api" ? "API instance" : `Managed ${name.toLowerCase()}`;
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
  const A = "Paid API";
  for (const p of PRODUCT_TYPE_IDS) {
    const api = base.productTypes[p]?.api;
    if (!api) continue;
    add(`productTypes.${p}.api.price`, "Money", A, `${api.name}: price`, "What buying the product's paid API costs, once.", POUNDS);
  }
  add("api.pricePerCall", "Money", A, "Income per call", "What each API call served earns (0.01 = 1p).", range(0, 1, 0.001));
  add("api.saasFeePerCall", "Money", A, "SaaS fee per call", "On SaaS the provider runs the API and takes this for each call served.", range(0, 1, 0.001));

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
    add(`productTypes.${p}.pricing.freeShare`, "Customers", s, "Free share", "Share of users on the free tier, at the start and among new users at the fair price.", SHARE);
    add(`productTypes.${p}.pricing.conversionRate`, "Customers", s, "Free-to-paid conversion rate", "Share of free users who start paying each day, before features, uptime, satisfaction and price (0.004 = 0.4%).", range(0, 0.1, 0.0005));
    for (const t of CUSTOMER_TYPE_IDS) {
      const type = base.customerTypes?.[t]?.name ?? t;
      add(`productTypes.${p}.pricing.customerMix.${t}`, "Customers", s, `Customer mix: ${type.toLowerCase()}`, "This customer type's share of the product's users. The shares are scaled to add up to 100%.", SHARE);
    }
    for (const f of product.features) {
      add(`productTypes.${p}.features.${f.id}.growthMultiplier`, "Customers", s, `${f.name}: growth multiplier`, "Once built or bought, daily growth is multiplied by this (1.1 = 10% faster).", range(0, 5, 0.01));
    }
  }
  add("outage.growthMultiplier", "Customers", "", "Growth on an outage day", "Growth is multiplied by this on a day with an outage.", SHARE);
  add("outage.paidChurnPerHour", "Customers", "", "Payers lost per hour down", "Share of paying users who stop paying for each hour of downtime (0.002 = 0.2%).", range(0, 0.1, 0.0005));
  add("pricing.growthSensitivity", "Customers", "", "Price effect on growth", "Growth is multiplied by (price ÷ fair price) to minus this. 0 for no effect.", range(0, 5, 0.05));
  add("pricing.maxGrowthBoost", "Customers", "", "Most a low price speeds growth", "A price below the fair price multiplies growth by at most this.", range(1, 10, 0.05));
  add("pricing.paidShareSensitivity", "Customers", "", "Price effect on new payers", "The paid share of new users is multiplied by (price ÷ fair price) to minus this.", range(0, 5, 0.05));

  // Customers: customer types
  for (const t of CUSTOMER_TYPE_IDS) {
    const type = base.customerTypes?.[t];
    if (!type) continue;
    add(`customerTypes.${t}.thresholdMultiple`, "Customers", "Customer types", `${type.name}: price threshold`, "The price at which this type starts to react badly, as a multiple of the product's fair price. A rise and a high price are measured against it.", range(0.1, 20, 0.05));
    add(`customerTypes.${t}.toFreeShare`, "Customers", "Customer types", `${type.name}: drop to free share`, "Of this type's paying users a price rise loses, the share who drop to free. The rest leave.", SHARE);
  }

  // Customers: price waves and the price lock
  const W = "Price changes";
  add("pricing.waveDays", "Customers", W, "Wave length (days)", "Days a price change's wave of reactions lasts: a small reaction on day 1, then the main effect.", range(1, 60, 1));
  add("pricing.lockDays", "Customers", W, "Price lock (days)", "Days the price can't be changed again after a change.", range(0, 90, 1));
  add("pricing.firstDayShare", "Customers", W, "First-day share", "Share of a wave's whole effect that lands on its first day.", SHARE);
  add("pricing.waveCurve", "Customers", W, "Wave curve", "Wave size grows with (change ÷ fair price) to this power. Above 1, small changes barely register and big jumps hit hard.", range(0.5, 4, 0.05));
  add("pricing.riseStrength", "Customers", W, "Rise strength", "A rise affects this × (rise ÷ fair price)^curve of paying users, before the extra hit and the cap.", range(0, 5, 0.05));
  add("pricing.dearness", "Customers", W, "Extra hit when already dear", "A rise's effect is multiplied by (new price ÷ fair price) to this power. 0 for no effect.", range(0, 5, 0.05));
  add("pricing.maxRiseShare", "Customers", W, "Most payers one rise can lose", "The biggest share of paying users one rise can affect.", SHARE);
  add("pricing.dropToFreeShare", "Customers", W, "Drop to free share", "Of the paying users who stop paying each day, the share who drop to free. The rest leave. A rise uses each customer type's own share.", SHARE);
  add("pricing.backlashTicketsPerUser", "Customers", W, "Backlash tickets per user", "Support tickets each affected user raises over a rise's backlash.", range(0, 20, 0.1));
  add("pricing.cutGainStrength", "Customers", W, "Cut: new users", "A cut brings this × (cut ÷ fair price)^curve new users, as a share of users, before the cap. Only the part below the fair price counts.", range(0, 5, 0.05));
  add("pricing.maxCutGain", "Customers", W, "Cut: most new users", "The most new users one cut can bring, as a share of users.", range(0, 5, 0.05));
  add("pricing.cutUpgradeStrength", "Customers", W, "Cut: upgrades", "A cut turns this × (cut ÷ fair price)^curve of free users into payers, before the cap.", range(0, 5, 0.05));
  add("pricing.maxCutUpgrade", "Customers", W, "Cut: most upgrades", "The most of the free users one cut can turn into payers.", SHARE);
  add("pricing.priceMemoryDays", "Customers", W, "Price memory (days)", "A rise counts from, and a cut only below, the lowest price customers remember from this many days: small rises add up like one, and undoing a cut brings no new wave.", range(0, 180, 1));
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

  // Customers: API traffic
  for (const p of PRODUCT_TYPE_IDS) {
    const api = base.productTypes[p]?.api;
    if (!api) continue;
    add(`productTypes.${p}.api.callsPerPaidUser`, "Customers", A, `${api.name}: calls per paying user`, "API calls a day each paying user brings, before features: where the traffic heads.", range(0, 1_000, 0.5));
  }
  add("api.startingCalls", "Customers", A, "Calls when bought", "API calls a day when the API is bought.", range(0, 1_000_000, 100));
  add("api.dailyGrowth", "Customers", A, "Traffic growth", "Share of the gap to the target traffic closed each day (0.1 = a tenth). Dropped calls slow it.", SHARE);
  add("api.perFeature", "Customers", A, "Calls boost per feature", "Each feature built or add-on bought adds this to the target traffic's multiplier.", range(0, 2, 0.01));
  add("api.outageDrop", "Customers", A, "Calls lost to an outage", "Share of the API traffic lost on a day with an outage.", SHARE);
  add("api.slowDays", "Customers", A, "Slow growth after an outage (days)", "Days after an outage that API traffic grows slowly.", range(0, 60, 1));
  add("api.slowGrowth", "Customers", A, "Growth while slow", "API traffic growth is multiplied by this while it's slow after an outage.", SHARE);

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
    const unit = t === "app" ? "CU" : t === "database" ? "DBU" : t === "cache" ? "CH" : t === "api" ? "APIU" : "app servers served";
    for (const size of SERVER_SIZES) {
      add(`servers.types.${t}.units.${size}`, "Infrastructure", S, `${type.name} (${size}): ${unit}`, t === "loadBalancer" ? "How many app servers one load balancer of this size can serve." : `The ${unit} one server of this size gives.`, range(0, 10_000, 1));
    }
  }
  add("servers.loadBalancerFrom", "Infrastructure", S, "Load balancers needed from", "App servers from which load balancers are needed. Without one, traffic reaches only one app server.", range(1, 20, 1));
  add("servers.cacheableShare", "Infrastructure", S, "Cacheable share of database demand", "The most of the database demand caches can take, one cache hit for one DBU.", SHARE);
  add("api.callsPerApiu", "Infrastructure", S, "API calls per APIU", "API calls one APIU serves in a day. Calls beyond the APIU are dropped.", range(1, 1_000_000, 100));
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
    add(`staff.${pool}.dayRate`, "People", s, "Day rate", "Cost per mid per day. Juniors and seniors are paid this × their grade's pay multiplier.", range(0, 2_000, 10));
    add(`staff.${pool}.startingCount`, "People", s, "Starting headcount", "How many mids a new company starts with.", HEADCOUNT);
  }
  for (const grade of STAFF_GRADES) {
    const g = base.staffGrades[grade]?.name ?? grade;
    add(`staffGrades.${grade}.payMultiplier`, "People", `${g} staff`, "Pay multiplier", "Pay as a multiple of each team's day rate (a mid's).", MULTIPLIER);
    add(`staffGrades.${grade}.output`, "People", `${g} staff`, "Output", "Work a day as a multiple of a mid's: developer-days, tickets cleared, or cover towards ops needed.", MULTIPLIER);
    add(`staffGrades.${grade}.leadDays`, "People", `${g} staff`, "Lead time (days)", "Days from hiring to starting work (0 = at once). They're paid only once they start.", range(0, 60, 1));
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
  add("encounters.dailyRise", "Events", "Danger meter", "Daily rise", "How much the danger meter rises on a well-run day after launch. A random event fires when it reaches the next threshold on the encounter list.", range(0, 20, 0.1));
  for (const r of DANGER_RISKS) {
    add(`encounters.riskRise.${r}`, "Events", "Danger meter", `Extra rise: ${RISK_LABELS[r]}`, "Added to the day's rise on a day with this risk.", range(0, 20, 0.1));
  }
  add("encounters.thresholdMin", "Events", "Danger meter", "Lowest threshold", "No event's threshold is lower: over the most a day can rise, the shortest gap between random events.", range(1, 365, 1));
  add("encounters.thresholdMax", "Events", "Danger meter", "Highest threshold", "No event's threshold is higher. Unlikely events get thresholds up to this.", range(1, 365, 1));
  add("calendar.noticeDays", "Events", "Calendar", "Holiday notice (days)", "A holiday that hits the product is announced in the log this many days before it starts.", range(0, 90, 1));
  for (const holiday of base.calendar.holidays) {
    const at = `calendar.holidays.${holiday.id}`;
    const s = holiday.name;
    add(`${at}.days`, "Events", s, "Days it lasts", "Days it lasts every year, from its real start date.", range(1, 90, 1));
    for (const p of PRODUCT_TYPE_IDS) {
      const product = base.productTypes[p]?.name ?? p;
      add(`${at}.effects.${p}.loadMultiplier`, "Events", s, `${product}: load multiplier`, "Load and CU and DBU demand are multiplied by this on each of its days.", MULTIPLIER);
      add(`${at}.effects.${p}.growthMultiplier`, "Events", s, `${product}: growth multiplier`, "Growth is multiplied by this on each of its days: below 1, fewer sign-ups.", MULTIPLIER);
    }
  }
  for (const event of base.events) {
    const at = `events.${event.id}`;
    const s = event.name;
    if (event.encounter) {
      add(`${at}.encounter.chance`, "Events", s, "Encounter chance", "The chance it goes on each encounter list rolled (0.5 = 1 in 2). 0 takes it out of random events.", SHARE);
      for (const r of DANGER_RISKS) {
        add(`${at}.encounter.risks.${r}`, "Events", s, `Chance multiplier: ${RISK_LABELS[r]}`, `Its chance is multiplied by this on a list rolled after a day with this risk.`, MULTIPLIER);
      }
      add(`${at}.encounter.maxTimes`, "Events", s, "Most times per game", "After firing this many times it no longer goes on the encounter list.", range(0, 20, 1));
      add(`${at}.encounter.fromDay`, "Events", s, "Earliest day", "It can't go on an encounter list rolled before this day.", GAME_DAY);
    }
    event.schedule?.days.forEach((_, i) => {
      add(`${at}.schedule.days.${i}`, "Events", s, `Fires on day (${i + 1})`, "A day it fires on in every game, outside the danger meter.", GAME_DAY);
    });
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
    ["encounters.thresholdMin", "encounters.thresholdMax", "The highest threshold can't be below the lowest."],
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
