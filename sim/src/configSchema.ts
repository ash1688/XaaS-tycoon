// The teacher's config page: every number in GameConfig a teacher can change, with its group, explanation and allowed
// range. The server validates and stores overrides with it, and the web client draws the page from it.
//
// A path names one number in the config, dot-separated. Lists of things with an id (features, events) are keyed by
// id, other lists by position: "models.iaas.monthlyCost", "productTypes.video.features.hd.devDays",
// "events.osPatch.schedule.days.0". Overrides are a flat map of path to number: only the numbers that differ.
import { MIGRATION_PHASES, MODEL_IDS, PRODUCT_TYPE_IDS, STAFF_POOLS, defaultConfig, type GameConfig } from "./config.ts";

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

type Range = Pick<ConfigField, "min" | "max" | "step">;
const range = (min: number, max: number, step: number): Range => ({ min, max, step });

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
  scaleCostPerLoad: { label: "cost per unit of extra load", help: "What scaling up to meet the extra load costs, per unit of load.", ...range(0, 1, 0.01) },
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
  add("billing.daysPerMonth", "Money", "", "Days in a billing month", "Monthly costs are charged a day at a time: the monthly cost ÷ this.", range(28, 31, 1));
  for (const m of MODEL_IDS) {
    const s = MODEL_LABELS[m];
    add(`models.${m}.upfrontCost`, "Money", s, "Upfront cost", "Charged once on moving to this model, such as buying servers.", POUNDS);
    add(`models.${m}.monthlyCost`, "Money", s, "Monthly cost", "The provider's fixed bill (power and upkeep on-prem), billed daily.", range(0, 200_000, 100));
    add(`models.${m}.monthlyCostPerUser`, "Money", s, "Monthly cost per user", "Extra per user per month, billed daily on that day's users.", PER_USER);
    add(`models.${m}.exitPenalty`, "Money", s, "Exit penalty", "The provider's fee for leaving, charged when a migration away completes.", POUNDS);
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
  for (const p of PRODUCT_TYPE_IDS) {
    const product = base.productTypes[p];
    if (!product) continue;
    const s = product.name;
    const g = `productTypes.${p}.growth`;
    add(`${g}.startingUsers`, "Customers", s, "Starting users", "Users a new company starts with.", range(0, 1_000_000, 100));
    add(`${g}.marketSize`, "Customers", s, "Market size", "Users the product can reach. Growth slows as users approach it.", range(1, 10_000_000, 1_000));
    add(`${g}.dailyGrowth`, "Customers", s, "Daily growth", "Share of users added each day while the market is wide open (0.05 = 5%).", range(0, 1, 0.005));
    add(`${g}.growthNoise`, "Customers", s, "Growth variation", "Daily growth varies randomly by up to this share either way.", SHARE);
    add(`${g}.seasonalSpike.firstDay`, "Customers", s, "Seasonal spike: first day", "The day the first busy season starts.", GAME_DAY);
    add(`${g}.seasonalSpike.every`, "Customers", s, "Seasonal spike: every (days)", "Days from the start of one busy season to the next.", GAME_DAY);
    add(`${g}.seasonalSpike.length`, "Customers", s, "Seasonal spike: length (days)", "How many days each busy season lasts.", GAME_DAY);
    add(`${g}.seasonalSpike.growthMultiplier`, "Customers", s, "Seasonal spike: growth multiplier", "Growth is multiplied by this during a busy season.", MULTIPLIER);
    add(`productTypes.${p}.pricing.freeShare`, "Customers", s, "Free share", "Share of users on the free tier, at the start and among new users at the fair price.", SHARE);
    for (const f of product.features) {
      add(`productTypes.${p}.features.${f.id}.growthMultiplier`, "Customers", s, `${f.name}: growth multiplier`, "Once built or bought, daily growth is multiplied by this (1.1 = 10% faster).", range(0, 5, 0.01));
    }
  }
  add("outage.growthMultiplier", "Customers", "", "Growth on an outage day", "Growth is multiplied by this on a day with an outage.", SHARE);
  add("pricing.growthSensitivity", "Customers", "", "Price effect on growth", "Growth is multiplied by (price ÷ fair price) to minus this. 0 for no effect.", range(0, 5, 0.05));
  add("pricing.maxGrowthBoost", "Customers", "", "Most a low price speeds growth", "A price below the fair price multiplies growth by at most this.", range(1, 10, 0.05));
  add("pricing.paidShareSensitivity", "Customers", "", "Price effect on new payers", "The paid share of new users is multiplied by (price ÷ fair price) to minus this.", range(0, 5, 0.05));

  // Infrastructure
  for (const m of MODEL_IDS) {
    add(`models.${m}.capacity`, "Infrastructure", MODEL_LABELS[m], "Capacity", "Load the model serves in a day when fully staffed.", range(0, 10_000_000, 1_000));
  }
  for (const p of PRODUCT_TYPE_IDS) {
    const product = base.productTypes[p];
    if (!product) continue;
    const g = `productTypes.${p}.growth`;
    add(`${g}.loadPerUser`, "Infrastructure", product.name, "Load per user", "Load each user puts on the system per day.", range(0, 100, 0.1));
    add(`${g}.loadNoise`, "Infrastructure", product.name, "Load variation", "Daily load varies randomly by up to this share either way.", SHARE);
    add(`${g}.seasonalSpike.loadMultiplier`, "Infrastructure", product.name, "Seasonal spike: load multiplier", "Load is multiplied by this during a busy season.", MULTIPLIER);
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
    add(`models.${m}.opsNeeded`, "People", MODEL_LABELS[m], "Ops needed", "Ops staff this model needs to run at full capacity.", HEADCOUNT);
  }
  for (const p of PRODUCT_TYPE_IDS) {
    for (const f of base.productTypes[p]?.features ?? []) {
      add(`productTypes.${p}.features.${f.id}.devDays`, "People", base.productTypes[p].name, `${f.name}: developer-days`, "Work to build it. A developer does one developer-day a day.", range(1, 365, 1));
    }
  }
  add("addons.minConfigDevelopers", "People", "", "Developers to configure add-ons", "On SaaS, add-ons can't be bought with fewer developers than this.", HEADCOUNT);

  // Migration
  for (const phase of MIGRATION_PHASES) {
    const name = base.migration.phases[phase]?.name ?? phase;
    add(`migration.phases.${phase}.days`, "Migration", "", `${name}: days`, "Days this phase of a migration takes before any overrun.", range(1, 90, 1));
  }
  add("migration.overrun.chance", "Migration", "", "Overrun chance", "Chance a migration overruns (0.3 = 3 in 10).", SHARE);
  add("migration.overrun.minDays", "Migration", "", "Overrun: fewest extra days", "An overrun adds between the fewest and most extra days.", range(0, 60, 1));
  add("migration.overrun.maxDays", "Migration", "", "Overrun: most extra days", "An overrun adds between the fewest and most extra days.", range(0, 60, 1));

  // Events
  add("finalDay", "Events", "", "Game length (days)", "The last day played. The game ends once it has been played.", range(2, 365, 1));
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
    // A new company starts at the fair price, so it has to be one the student could set.
    ...PRODUCT_TYPE_IDS.filter((p) => base.productTypes[p]).map((p): [string, string, string] => [
      `productTypes.${p}.pricing.fairPrice`,
      "pricing.maxPrice",
      "The highest price can't be below a product's fair price.",
    ]),
    ...base.events
      .filter((e) => e.schedule.type === "seeded")
      .map((e): [string, string, string] => [
        `events.${e.id}.schedule.fromDay`,
        `events.${e.id}.schedule.toDay`,
        "The latest day can't be before the earliest day.",
      ]),
  ];
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
