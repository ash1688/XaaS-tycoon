// The teacher's config page: every number in GameConfig a teacher can change, with its group, explanation and allowed
// range. The server validates and stores overrides with it, and the web client draws the page from it.
//
// A path names one number in the config, dot-separated. Lists of things with an id (features, events) are keyed by
// id, other lists by position: "models.iaas.monthlyCost", "productTypes.video.features.hd.devDays",
// "events.osPatch.encounter.chance". Overrides are a flat map of path to number: only the numbers that differ.
import {
  CSUITE_ROLES,
  CUSTOMER_TYPE_IDS,
  DANGER_RISKS,
  DIFFICULTIES,
  DIFFICULTY_IDS,
  GAME_LENGTH_IDS,
  SERIES_IDS,
  VC_LEANS,
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
import { STAFF_SCHEMES } from "./staffSchemes.ts";

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
  "launch.auto": "A switch for tests and demos about after launch, not a balance number: students press Launch.",
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
 * for what happens without enough ops, and "unpatched." for what happens with patches overdue. An effect only gets a field for the numbers it sets in the base config.
 */
const EFFECT_FIELDS: Record<string, { label: string; help: string } & Range> = {
  opsNeeded: { label: "ops needed", help: "Ops staff needed to deal with it; with fewer, the short-of-ops outcome happens.", ...HEADCOUNT },
  scaleCostPerUnit: { label: "cost per CU or DBU over capacity", help: "What scaling up to meet it costs, per CU and DBU of demand over capacity, from the day the extra servers are ready (at once on PaaS).", ...range(0, 1_000, 1) },
  downtimeHours: { label: "hours down", help: "Hours of downtime on top of any outage from load.", ...HOURS },
  "cost.amount": { label: "clean-up cost", help: "A one-off charge for dealing with it.", ...POUNDS },
  "priceRise.percent": { label: "price rise %", help: "The provider's prices go up by this percent for good.", ...range(0, 200, 1) },
  "featureGap.growthMultiplier": { label: "growth while the gap is open", help: "Daily growth is multiplied by this until the company migrates off the model.", ...range(0, 2, 0.05) },
  "freeUsers.share": { label: "new free users (share of users)", help: "A wave of free users arrives the day it fires, as a share of the users there (0.25 = a quarter more), as far as the market has room.", ...range(0, 5, 0.05) },
  "freeUsers.min": { label: "fewest new free users", help: "The wave brings at least this many free users, as far as the market has room.", ...range(0, 100_000, 100) },
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
  add("loan.emergencyTermDays", "Money", "Bank loan", "Emergency loan term", "Repayment days for the emergency loan the bank opens when cash goes below £0 with no loan being repaid.", range(1, 365, 1));
  add("valuation.minimum", "Money", "Valuation", "Lowest valuation", "A company is never valued below this, even with no revenue.", POUNDS);
  add("valuation.averageDays", "Money", "Valuation", "Averaged over", "Days that revenue, paying users and satisfaction are averaged over for the valuation, so one day can't swing it and a price change can't move it at once.", GAME_DAY);
  add("valuation.fallDays", "Money", "Valuation", "Falls in revenue counted over", "Revenue is the lower of its average over the days above and over this many, so income lost shows within these days but a rise counts slowly. While paying users or income over this many days are below the same days before (or satisfaction drops below the line), the valuation can't rise, and once they aren't it catches up over about this many days.", GAME_DAY);
  add("valuation.revenueMultiple", "Money", "Valuation", "Revenue multiple", "Annual revenue counts this many times over in the valuation, before growth, satisfaction and uptime move it.", MULTIPLIER);
  add("valuation.minMultiple", "Money", "Valuation", "Lowest revenue multiple", "However badly growth, satisfaction and uptime are going, annual revenue counts at least this many times over.", MULTIPLIER);
  add("valuation.valuePerPayingUser", "Money", "Valuation", "Value per paying user", "Each paying user adds this to the valuation, so it can't be inflated by price alone.", range(0, 1_000, 1));
  add("valuation.growthDays", "Money", "Valuation", "Growth measured over", "Days back to compare average paying users with, for growth.", GAME_DAY);
  add("valuation.growthBaseUsers", "Money", "Valuation", "Growth measured from at least", "Growth is the change in paying users ÷ those then, or ÷ this many if there were fewer. A rise only counts above the best the company had done before, so winning back users lost in a crash isn't growth.", range(1, 100_000, 1));
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
  for (const p of PRODUCT_TYPE_IDS) {
    const name = base.productTypes[p].name;
    add(`ipo.products.${p}.users`, "Money", "IPO", `Users needed (${name})`, "Users, paying or free, a company needs to float.", range(0, 1_000_000, 100));
    add(`ipo.products.${p}.annualRevenue`, "Money", "IPO", `Annual revenue needed (${name})`, "Annual revenue, as the valuation measures it, a company needs to float.", range(0, 100_000_000, 10_000));
    add(`ipo.products.${p}.payingUsers`, "Money", "IPO", `Paying users needed (${name})`, "The minimum paying customer base to float, so a few customers paying a lot can't.", range(0, 1_000_000, 100));
  }
  add("ipo.minTradingDays", "Money", "IPO", "Trading history needed", "Days of trading since the launch a company needs before it can float.", range(0, 365, 1));
  add("ipo.recordDays", "Money", "IPO", "Records over", "Days the uptime, satisfaction, costs and profit records are measured over.", GAME_DAY);
  add("ipo.minUptime", "Money", "IPO", "Uptime record needed", "Uptime % over the record's days a company needs to float.", range(0, 100, 0.1));
  add("ipo.minSatisfaction", "Money", "IPO", "Satisfaction the market wants", "Average satisfaction % over the record's days above which the market grows more comfortable, cutting the cold-market chance and helping the first day of trading. Not needed to float.", range(0, 100, 1));
  add("ipo.maxCostSwing", "Money", "IPO", "Most costs may vary", "Daily costs over the record's days may vary by at most this (their standard deviation ÷ their mean; 0.25 = 25%). One-offs such as kit bought don't count.", range(0, 5, 0.01));
  add("ipo.costsHoldDays", "Money", "IPO", "Costs hold after a hire", "Days daily costs must hold at their new level after the last C-suite hire before the company can apply to float.", range(0, 60, 1));
  add("ipo.costDaysSetAside", "Money", "IPO", "Costliest days set aside", "The costliest days of the record left out when measuring how much daily costs vary, so one costly day doesn't fail it.", range(0, 30, 1));
  add("ipo.comfortMargin", "Money", "IPO", "Comfortably ready at", "How far over a condition counts as comfortably ready (0.25 = 25% over), cutting the cold-market chance and helping the first day of trading.", range(0.01, 5, 0.01));
  add("ipo.coldChance.max", "Money", "IPO", "Cold-market chance, only just ready", "The chance applying meets a cold market when the company only just meets every condition.", SHARE);
  add("ipo.coldChance.min", "Money", "IPO", "Cold-market chance, comfortably ready", "The chance applying meets a cold market when the company is comfortably over every condition.", SHARE);
  add("ipo.coldDelayDays", "Money", "IPO", "Cold market postpones by", "Days a cold market postpones the IPO before the company can apply again.", GAME_DAY);
  add("ipo.coldSatisfactionLoss", "Money", "IPO", "Satisfaction lost to a cold market", "Points of satisfaction lost when a cold market postpones the IPO.", range(0, 100, 1));
  add("ipo.minFloat", "Money", "IPO", "Smallest float", "The least of the company (after the IPO) the float can be, in new shares (0.15 = 15%). Less would make the IPO fail.", range(0.01, 0.95, 0.01));
  add("ipo.maxFloat", "Money", "IPO", "Largest float", "The most of the company (after the IPO) the float can be, in new shares.", range(0.01, 0.95, 0.01));
  add("ipo.ticks", "Money", "IPO", "First-day price moves", "How many times the share price moves on the first day of trading, from the open to the close.", range(1, 100, 1));
  add("ipo.minDrift", "Money", "IPO", "First-day drift, only just ready", "How far the share price drifts over the first day when the company only just met every condition (−0.1 = down 10%).", range(-1, 1, 0.01));
  add("ipo.maxDrift", "Money", "IPO", "First-day drift, comfortably ready", "How far the share price drifts over the first day when the company is comfortably over every condition.", range(-1, 1, 0.01));
  add("ipo.growthDrift", "Money", "IPO", "First-day drift per 100% growth", "Added to the drift for each 100% growth in paying users, as the valuation measures it.", range(-1, 1, 0.01));
  add("ipo.swingAtMinFloat", "Money", "IPO", "First-day swing, smallest float", "How far luck can move the first day at the smallest float, about (0.2 = 20% either way): scarce shares swing further.", SHARE);
  add("ipo.swingAtMaxFloat", "Money", "IPO", "First-day swing, largest float", "The same at the largest float: plenty of shares make a steadier day.", SHARE);
  add("ipo.lowestClose", "Money", "IPO", "Lowest close", "The close is never below this share of the offer price.", SHARE);
  add("negotiation.dieSides", "Money", "Negotiation", "Sides on the die", "Each counter is answered by a roll of a die with this many sides.", range(2, 100, 1));
  add("negotiation.highFrom", "Money", "Negotiation", "High roll from", "A roll of this or more, after the penalty for asking a lot, moves the next offer most of the way to the counter.", range(1, 100, 1));
  add("negotiation.middleFrom", "Money", "Negotiation", "Middle roll from", "A roll of this or more, but below a high roll, meets the counter about halfway.", range(1, 100, 1));
  add("negotiation.greedPenalty", "Money", "Negotiation", "Penalty per 100% asked", "Taken off the roll for a counter asking 100% better terms, and in step for less: 30 is 3 per 10%.", range(0, 200, 1));
  add("negotiation.maxAsk", "Money", "Negotiation", "Most a counter can ask", "The most a counter can ask for in all, as a share of the offer (0.5 = 50% better terms).", range(0.05, 5, 0.05));
  add("negotiation.moves.high", "Money", "Negotiation", "High roll moves", "Share of the way from the offer to the counter the next offer moves on a high roll.", SHARE);
  add("negotiation.moves.middle", "Money", "Negotiation", "Middle roll moves", "Share of the way the next offer moves on a middle roll.", SHARE);
  add("negotiation.moves.low", "Money", "Negotiation", "Low roll moves", "Share of the way the next offer moves on a low roll. Below 0 the offer gets worse instead: −0.2 moves it a fifth of the counter's distance the other way.", range(-1, 1, 0.01));
  add("rescue.limitDays", "Money", "Rescue buyout", "How far below £0", "Days of daily costs, fixed when cash first goes below £0, that shortfalls can go onto the loan before the vulture VC steps in (or, after a rescue, liquidation).", GAME_DAY);
  add("rescue.breathingDays", "Money", "Rescue buyout", "Breathing space", "Days of losses the vulture VC's cash covers after the cost cuts, on top of what took cash below £0.", GAME_DAY);
  add("rescue.minCover", "Money", "Rescue buyout", "Least cover a day", "The breathing space counts at least this share of a day's running costs, even if the company is losing less.", SHARE);
  add("rescue.share", "Money", "Rescue buyout", "Share taken", "The vulture VC's share of the company once its new shares are issued (0.75 = 75%).", range(0.01, 0.99, 0.01));
  add("rescue.staffCut", "Money", "Rescue buyout", "Staff cut", "Share of each team let go in the forced cost cuts, rounded up, the dearest grades first. Ops are kept to what the servers need.", SHARE);
  add("rescue.buyBackPremium", "Money", "Rescue buyout", "Buy-back premium", "To sell its shares back, the vulture VC asks this many times its share of today's valuation, leaving out the company's cash.", MULTIPLIER);
  add("rescue.minReturn", "Money", "Rescue buyout", "Least buy-back price", "The vulture VC never sells its shares back for less than this many times the cash it put in.", MULTIPLIER);
  add("investors.approachDays", "Money", "Investors", "Days to approach", "Days after the company first hits an investor's hidden target before they approach.", range(0, 60, 1));
  add("investors.offerDays", "Money", "Investors", "Days an offer stands", "Days played an investor's offer stays open; unanswered by then it lapses, which counts as declining it.", range(1, 60, 1));
  add("investors.retryDays", "Money", "Investors", "Days to the next", "Days after an investor is declined before a new one approaches.", range(0, 60, 1));
  add("investors.angel.target.dailyRevenue", "Money", "Angel investor", "Hidden target: income a day", "The angel approaches once income, averaged over the days below, reaches this.", POUNDS);
  add("investors.angel.target.days", "Money", "Angel investor", "Days averaged", "Days of income averaged for the hidden target, and for the angel's own target once accepted.", GAME_DAY);
  add("investors.angel.premium.min", "Money", "Angel investor", "Least premium", "The least the angel values the business at, as a multiple of the formula's (cash counts at face value).", MULTIPLIER);
  add("investors.angel.premium.max", "Money", "Angel investor", "Most premium", "The most the angel values the business at, as a multiple of the formula's.", MULTIPLIER);
  add("investors.angel.share.min", "Money", "Angel investor", "Least share asked", "The smallest share of the company the angel's opening offer asks for (0.15 = 15%).", range(0.01, 0.9, 0.01));
  add("investors.angel.share.max", "Money", "Angel investor", "Most share asked", "The biggest share of the company the angel's opening offer asks for.", range(0.01, 0.9, 0.01));
  add("investors.angel.minAmount", "Money", "Angel investor", "Least cash", "The angel's opening offer never puts in less than this.", POUNDS);
  add("investors.angel.maxAmount", "Money", "Angel investor", "Most cash", "The angel's opening offer never puts in more than this: they ask for a smaller share instead.", POUNDS);
  add("investors.angel.declinePremium", "Money", "Angel investor", "Premium lost per decline", "Each angel you decline takes this off the next angel's most premium (never below the least).", range(0, 1, 0.05));
  add("investors.angel.declineShare", "Money", "Angel investor", "Share added per decline", "Each angel you decline adds this to the least share the next angel asks for (never above the most).", range(0, 0.2, 0.01));
  add("investors.angel.targetGrowth", "Money", "Angel investor", "Target growth", "The angel's target: income a day this many times what it was when you accepted (or the hidden target, if more).", MULTIPLIER);
  add("investors.angel.usersPace", "Money", "Angel investor", "Users target pace", "The angel's users target: paying users gained at this many times the company's recent pace (over the days averaged), kept up for the target's days.", MULTIPLIER);
  add("investors.angel.minUsersGained", "Money", "Angel investor", "Least users target", "The angel's users target is never fewer than this many paying users gained.", range(0, 100_000, 10));
  add("investors.angel.usersRoomShare", "Money", "Angel investor", "Users target room", "The angel's users target is at most this share of the users the market still has room for.", SHARE);
  add("investors.angel.targetDays", "Money", "Angel investor", "Days to hit the target", "Days after accepting the angel has to hit their target.", GAME_DAY);
  add("investors.angel.missShare", "Money", "Angel investor", "Extra share if missed", "Missing the target gives the angel new shares, taking their share of the company up by this (0.05 = five points).", range(0, 0.5, 0.01));
  {
    const V = "Venture capital";
    const BIG_POUNDS = range(0, 20_000_000, 1_000);
    add("investors.vc.gapDays", "Money", V, "Days between rounds", "A Series round's VCs can't approach until this many days after the rung before first approached (the angel, for Series A).", range(0, 90, 1));
    add("investors.vc.targetDays", "Money", V, "Days averaged", "Days of income a round's hidden target averages, and of uptime it counts.", GAME_DAY);
    add("investors.vc.leadPremium", "Money", V, "Lead VC's extra premium", "The lead VC, back for the next round, values the business at this much more premium than they otherwise would.", range(0, 1, 0.05));
    add("investors.vc.declinePremium", "Money", V, "Premium lost per decline", "Each approach declined in a round takes this off the most premium the round's next VCs offer (never below the least).", range(0, 1, 0.05));
    add("investors.vc.declineShare", "Money", V, "Share added per decline", "Each approach declined in a round adds this to the least share the round's next VCs ask for (never above the most).", range(0, 0.2, 0.01));
    const LEANS = { cash: "Most cash", conditions: "Fewest conditions", ownership: "Least ownership" } as const;
    for (const lean of VC_LEANS) {
      add(`investors.vc.leans.${lean}.share`, "Money", V, `${LEANS[lean]}: share asked`, "A VC leaning this way asks for the round's share multiplied by this.", range(0.1, 3, 0.05));
      add(`investors.vc.leans.${lean}.premium`, "Money", V, `${LEANS[lean]}: premium added`, "A VC leaning this way adds this to the round's premium (below 0 values the business lower).", range(-1, 1, 0.05));
    }
    for (const round of SERIES_IDS) {
      const name = `Series ${round.slice(-1)}`;
      const r = `investors.vc.rounds.${round}`;
      add(`${r}.target.payingUsers`, "Money", name, "Hidden target: paying users", "The round's VCs approach once paying users reach this share of the product's IPO paying users (0 leaves it out).", SHARE);
      add(`${r}.target.dailyRevenue`, "Money", name, "Hidden target: income", "The round's VCs approach once income a day, averaged, reaches this share of the product's IPO revenue a day (0 leaves it out).", SHARE);
      add(`${r}.target.minUptime`, "Money", name, "Hidden target: uptime %", "The round's VCs approach only with at least this uptime over the days averaged (0 leaves it out).", range(0, 100, 0.5));
      add(`${r}.premium.min`, "Money", name, "Least premium", "The least the round's VCs value the business at, as a multiple of the formula's (cash counts at face value).", MULTIPLIER);
      add(`${r}.premium.max`, "Money", name, "Most premium", "The most the round's VCs value the business at, as a multiple of the formula's.", MULTIPLIER);
      add(`${r}.share.min`, "Money", name, "Least share asked", "The smallest share of the company the round's VCs ask for, before their lean.", range(0.01, 0.9, 0.01));
      add(`${r}.share.max`, "Money", name, "Most share asked", "The biggest share of the company the round's VCs ask for, before their lean.", range(0.01, 0.9, 0.01));
      add(`${r}.minAmount`, "Money", name, "Least cash", "The round's VCs never offer less than this.", BIG_POUNDS);
      add(`${r}.maxAmount`, "Money", name, "Most cash", "The round's VCs never offer more than this: they ask for a smaller share instead.", BIG_POUNDS);
    }
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
    add(`productTypes.${p}.demand.perUserFeeMultiplier`, "Money", product.name, "Per-user fee multiplier", "On SaaS, the provider's per-user fee is multiplied by this for the product: higher for one heavy on compute.", range(0, 100, 0.1));
    const tx = product.transactions;
    if (!tx) continue;
    const t = `productTypes.${p}.transactions`;
    add(`${t}.fairRate`, "Money", product.name, "Fair transaction fee", "The share of each payment users think is fair to take (0.02 = 2%), on top of the fair monthly fee, and where a new company starts.", range(0, 1, 0.001));
    add(`${t}.maxRate`, "Money", product.name, "Highest transaction fee", "The most of each payment a student can take (0.2 = 20%).", range(0, 1, 0.01));
    add(`${t}.volumePerPaidUser`, "Money", product.name, "Payments per paying user a month", "What each paying user takes in payments in a usual month. Customers judge the fee plus the transaction fee's share of this.", range(0, 1_000_000, 10));
    add(`${t}.payday.firstDay`, "Money", product.name, "Payday: first day", "The day the first payday rush starts.", GAME_DAY);
    add(`${t}.payday.every`, "Money", product.name, "Payday: every (days)", "Days from one payday rush to the next.", GAME_DAY);
    add(`${t}.payday.length`, "Money", product.name, "Payday: length (days)", "How many days each payday rush lasts. 0 for none.", range(0, 365, 1));
    add(`${t}.saasFeeRate`, "Money", product.name, "SaaS platform's fee per payment", "On SaaS the platform takes the payments for you and charges this share of every payment (0.009 = 0.9%) as infrastructure, whatever you charge.", range(0, 1, 0.001));
    add(`${t}.payday.multiplier`, "Money", product.name, "Payday: payments multiplier", "Payments, and the load they bring, are multiplied by this on payday; the other days are lowered so a month averages out.", MULTIPLIER);
  }
  for (const p of PRODUCT_TYPE_IDS) {
    const name = base.productTypes[p]?.name ?? p;
    add(`mvp.baseDevDays.${p}`, "People", "MVP", `Base size (${name})`, "Developer-days the MVP takes on-prem, before any users arrive. Each model builds its share of it. 0 launches as soon as there are servers.", range(0, 365, 1));
  }
  for (const m of MODEL_IDS) {
    add(`mvp.modelShare.${m}`, "People", "MVP", `Share built (${MODEL_LABELS[m]})`, "The share of the base MVP size a company on this model builds: on SaaS only the storefront and payments.", range(0, 2, 0.05));
  }
  add("optimisation.k", "People", "Optimisation", "Developer-days to 63% of the cap", "How fast optimisation pays off: the saving is cap × (1 − e^(−days ÷ this)), so after this many developer-days it's about 63% of the cap. Bigger is slower.", range(1, 1_000, 1));
  for (const m of MODEL_IDS) {
    add(`optimisation.cap.${m}`, "People", "Optimisation", `Most it saves (${MODEL_LABELS[m]})`, "The most optimisation can cut resource need per user on this model (0.5 = half): CU and DBU per user, PaaS instances, or the SaaS per-user fee. Kept through a migration, capped at the new model's.", range(0, 0.95, 0.05));
  }
  add("research.pointsPerPerson", "People", "Research", "Research points per researcher", "Research points (RP) a mid researcher earns a day. Juniors and seniors earn this × their grade's output. RP bank with no cap.", range(0, 100, 0.5));
  add("csuite.shortlistSize", "People", "C-suite", "Candidates on a shortlist", "How many candidates each C-suite role's shortlist has, drawn as the game starts: one from each band of strength, weakest to strongest.", range(1, 6, 1));
  add("csuite.equityCap", "People", "C-suite", "Equity cap", "The most the whole C-suite's equity can add up to (0.1 = 10%). Each candidate's ask is their base ask × the share of the cap still unused, so asks shrink as it fills. The staff share scheme doesn't count.", range(0, 0.5, 0.005));
  add("csuite.payHoliday.startDays", "People", "C-suite", "Pay holiday below", "When cash falls below this many days of running costs (C-suite pay included), every executive forgoes their pay until it recovers. 0 turns the pay holiday off.", range(0, 365, 1));
  add("csuite.payHoliday.backPayDays", "People", "C-suite", "Back pay spread over", "Once the pay holiday is over, each day pays back pay owed from the cash above the pay holiday's start line, spread over this many days.", range(1, 90, 1));
  add("csuite.payHoliday.endDays", "People", "C-suite", "Pay holiday ends above", "The pay holiday ends, and executives are paid again, once cash is back above this many days of running costs.", range(0, 365, 1));
  add("csuite.payLuck", "People", "C-suite", "Luck in pay", "How much of a candidate's salary and equity ask is luck rather than strength: 0 makes the strongest always the dearest.", range(0, 1, 0.05));
  const EFFECT_HELP: Record<string, string> = {
    output: "Added to the pool's work a day (0.2 = +20%).",
    outageCut: "Taken off every outage's hours (0.2 = 20% shorter).",
    recovery: "Added to how fast satisfaction recovers while it's rising (0.5 = 50% faster).",
    rollBonus: "Pips added to every investor and funder negotiation roll, rounded to a whole number. Not pay reviews.",
    loanRateCut: "Taken off a bank loan's interest rate (0.2 = 20% lower).",
    research: "Added to research points earned (0.25 = +25%).",
    strength: "How far the head of people moves pay reviews from the none values: 1 gives the People lead: head of people figures, 1.5 half as far again.",
    campaigns: "Added to campaigns' users per pound (0.1 = +10%).",
    runningCostCut: "Taken off everyday running costs: hosting, rent, power and provider fees, not staff pay (0.08 = 8%).",
    migrationCut: "Taken off a migration's days, upfront bill and exit penalty (0.3 = 30%).",
    patching: "Taken off the ops a setup needs to keep patches up to date (0.3 = 30% fewer).",
    breachCut: "Taken off a security breach's chance of coming up (0.4 = 40% less likely).",
  };
  for (const role of CSUITE_ROLES) {
    const r = base.csuite.roles[role];
    const p = `csuite.roles.${role}`;
    const section = `C-suite: ${r.name}`;
    for (const end of ["min", "max"] as const) {
      const which = end === "min" ? "weakest" : "strongest";
      add(`${p}.salary.${end}`, "People", section, `Salary, ${which}`, `Pay a day for the ${which} candidate. Fixed for good: pay reviews leave the C-suite out.`, range(0, 5_000, 5));
      add(`${p}.equity.${end}`, "People", section, `Equity ask, ${which}`, `The ${which} candidate's equity ask with the cap empty (0.01 = 1%), paid in new shares.`, range(0, 0.1, 0.0005));
      for (const key of Object.keys(r.effects)) {
        add(`${p}.effects.${key}.${end}`, "People", section, `${key}, ${which}`, EFFECT_HELP[key] ?? "One of the role's effects.", range(0, key === "rollBonus" ? 10 : key === "strength" ? 3 : 1, key === "rollBonus" ? 1 : 0.01));
      }
    }
  }
  const CAMPAIGNS = "Campaigns";
  for (const t of CUSTOMER_TYPE_IDS) {
    const type = base.customerTypes?.[t]?.name ?? t;
    add(`campaigns.costPerUser.${t}`, "Customers", CAMPAIGNS, `${type}: cost per user`, "What one new user of this type costs a campaign aimed at it, before how full the market is, overlapping campaigns and a holiday bonus.", range(0.1, 10_000, 0.1));
  }
  add("campaigns.minBudget", "Customers", CAMPAIGNS, "Smallest budget", "The least a campaign's budget can be.", range(1, 1_000_000, 1));
  add("campaigns.maxBudget", "Customers", CAMPAIGNS, "Biggest budget", "The most a campaign's budget can be.", range(1, 100_000_000, 100));
  add("campaigns.minDays", "Customers", CAMPAIGNS, "Shortest (days)", "The fewest days a campaign can run.", GAME_DAY);
  add("campaigns.maxDays", "Customers", CAMPAIGNS, "Longest (days)", "The most days a campaign can run.", GAME_DAY);
  add("campaigns.overlapMultiplier", "Customers", CAMPAIGNS, "Overlap on one type", "With n campaigns on the same customer type running on a day, each brings this^(n − 1) of the users per pound it would alone (0.6: two bring 60% each).", SHARE);
  add("campaigns.holidayLeadDays", "Customers", CAMPAIGNS, "Holiday timing window (days)", "A campaign started up to this many days before a holiday that boosts the product's growth gets the holiday bonus.", range(0, 90, 1));
  add("campaigns.holidayBonus", "Customers", CAMPAIGNS, "Holiday bonus", "A campaign timed for a holiday brings this × the users per pound, for the whole of its run.", MULTIPLIER);
  add("campaigns.marketPerUser", "Customers", CAMPAIGNS, "Market growth per user", "Brand awareness: each user a campaign brings in adds this to the product's market size, for good.", range(0, 100, 0.1));
  add("campaigns.marketGrowthCap", "Customers", CAMPAIGNS, "Market growth cap", "The most campaigns can add to the market, all told, as a share of the product's base market size (0.5: +50%).", range(0, 10, 0.05));
  add("campaigns.quotePace.low", "Customers", CAMPAIGNS, "Quote: slow growth", "A campaign's quote plays its run forward with your other users growing at this × today's pace for its cheapest end.", range(0, 5, 0.05));
  add("campaigns.quotePace.high", "Customers", CAMPAIGNS, "Quote: fast growth", "A campaign's quote plays its run forward with your other users growing at this × today's pace for its dearest end.", range(0, 5, 0.05));
  add("campaigns.quoteMargin", "Customers", CAMPAIGNS, "Quote: margin", "Each end of a campaign's quote is widened by this share of its users, for chance (0.05 = 5%).", SHARE);
  add("campaigns.almostFull", "Customers", CAMPAIGNS, "Market almost full", "With this share of the market taken, a campaign's quote says the market is almost full.", SHARE);
  const T = "Tiers";
  const TIER = range(1, 4, 1);
  const RP = range(0, 100_000, 1);
  add("tiers.tier2.marketShare", "Infrastructure", T, "Tier 2: share of the market", "Tier 2 opens once the company's users, paying or free, reach this share of its product's market size (0.35 = 35%), to the nearest 100 users.", SHARE);
  add("tiers.tier3.dailyIncome", "Infrastructure", T, "Tier 3: income a day", "Tier 3 opens once the last days played (below) average this much income a day, with the uptime below.", POUNDS);
  add("tiers.tier3.uptime", "Infrastructure", T, "Tier 3: uptime %", "The uptime % over those days that tier 3 also needs.", range(0, 100, 0.1));
  add("tiers.tier1BuildMultiplier", "Infrastructure", T, "Tier 1: build time", "Tier 1 features open at Launch with no research, and take this × their developer-days to build (2 = twice as long).", MULTIPLIER);
  add("tiers.tier3.days", "Infrastructure", T, "Tier 3: days measured", "How many of the latest days played tier 3's income and uptime are averaged over.", GAME_DAY);
  add("tiers.tier4.dailyIncome", "Infrastructure", T, "Tier 4 on Hard: income a day", "On Hard, tier 4 also opens once the last days played (below) average this much income a day, so a company can float without outside investors.", POUNDS);
  add("tiers.tier4.days", "Infrastructure", T, "Tier 4 on Hard: days", "The days played that Hard's tier 4 income is averaged over.", GAME_DAY);
  for (const p of PRODUCT_TYPE_IDS) {
    for (const f of base.productTypes[p]?.features ?? []) {
      add(`productTypes.${p}.features.${f.id}.tier`, "Infrastructure", T, `${base.productTypes[p].name}: ${f.name} tier`, "The tier this feature is in: it can only be built or bought once that tier is unlocked. Tier 1 is open from the start.", TIER);
      if (f.rpPrice !== undefined) {
        add(`productTypes.${p}.features.${f.id}.rpPrice`, "Infrastructure", T, `${base.productTypes[p].name}: ${f.name} RP price`, "Research points (RP) to unlock this feature on the Research page once its tier is available, before it can be built or bought. Tier 1 features need none.", RP);
      }
    }
  }
  for (const b of base.tiers?.benefits ?? []) {
    const at = `tiers.benefits.${b.id}`;
    const name = `${b.name} (${MODEL_LABELS[b.model]})`;
    add(`${at}.tier`, "Infrastructure", T, `${name}: tier`, "The tier this model benefit is in: it can only be bought once that tier is unlocked.", TIER);
    if (b.rpPrice !== undefined) add(`${at}.rpPrice`, "Infrastructure", T, `${name}: RP price`, "Research points (RP) to unlock this model benefit on the Research page once its tier is available, before it can be bought. It stays unlocked through a migration.", RP);
    add(`${at}.setupFee`, "Infrastructure", T, `${name}: set-up fee`, "Paid once when the benefit is bought. A migration loses it with no refund.", POUNDS);
    add(`${at}.monthlyFee`, "Infrastructure", T, `${name}: monthly fee`, "Billed a day's share at a time while the benefit is on.", POUNDS);
    const e = b.effects;
    if (e.powerSaving !== undefined) add(`${at}.effects.powerSaving`, "Infrastructure", T, `${name}: power saving`, "The share taken off power and cooling and every server's power and upkeep (0.2 = 20% off).", SHARE);
    if (e.sliderRisk !== undefined) add(`${at}.effects.sliderRisk`, "Infrastructure", T, `${name}: slider risk`, "The hardware slider's chance of overheating or crashing is multiplied by this (0.5 = halved).", MULTIPLIER);
    if (e.rentSaving !== undefined) add(`${at}.effects.rentSaving`, "Infrastructure", T, `${name}: rent saving`, "The share taken off every server's rent (0.3 = 30% off).", SHARE);
    if (e.autoscaling) {
      add(`${at}.effects.autoscaling.pricePerUnit`, "Infrastructure", T, `${name}: price per unit`, "What each CU or DBU over capacity costs for the day when extra VMs cover it.", range(0, 1_000, 0.5));
      add(`${at}.effects.autoscaling.most`, "Infrastructure", T, `${name}: most extra`, "The most extra VMs can add, as a share of the servers' own units (0.5 = half as much again).", range(0, 10, 0.05));
    }
    if (e.managedAutoscaling) {
      add(`${at}.effects.managedAutoscaling.headroom`, "Infrastructure", T, `${name}: baseline headroom`, "With it, each night the instances are set to the day's CU demand plus this share (0.5 = 1.5×), in place of basic autoscaling's.", range(0, 5, 0.05));
    }
    if (e.outageHours !== undefined) add(`${at}.effects.outageHours`, "Infrastructure", T, `${name}: outage hours`, "Hours down in any outage are multiplied by this, rounded up (0.5 = half as long).", SHARE);
    if (e.cuDemand !== undefined) add(`${at}.effects.cuDemand`, "Infrastructure", T, `${name}: CU demand`, "CU demand is multiplied by this (0.75 = a quarter less).", SHARE);
    if (e.eventHours) add(`${at}.effects.eventHours.multiplier`, "Infrastructure", T, `${name}: provider outage hours`, "Hours down from the provider's outages are multiplied by this, rounded up (0.5 = half as long).", SHARE);
  }
  const H = "Hardware slider (on-prem)";
  add("hardware.maxPerformance", "Infrastructure", H, "Top of the slider", "The most of its normal capacity an on-prem server can be pushed to (1.5 = 150%).", range(1, 3, 0.05));
  add("hardware.overheat.chance", "Infrastructure", H, "Overheating: chance a day at the top", "A server at the top of the slider overheats on this share of days; between 100% and the top it's this × x², where x runs from 0 to 1.", SHARE);
  add("hardware.overheat.days", "Infrastructure", H, "Overheating: days", "How many days an overheated server gives less capacity.", range(1, 30, 1));
  add("hardware.overheat.capacity", "Infrastructure", H, "Overheating: capacity left", "The share of its capacity an overheated server gives (0.5 = half).", SHARE);
  add("hardware.crash.chance", "Infrastructure", H, "Crash: chance a day at the top", "A server at the top of the slider crashes on this share of days, the same curve as overheating.", SHARE);
  add("hardware.crash.days", "Infrastructure", H, "Crash: days down", "How many days a crashed server gives nothing while ops fix it.", range(1, 30, 1));
  add("hardware.lifespan", "Infrastructure", H, "Lifespan (days at 100%)", "Wear a server can build up before it's worn out, in a game of a year or more. It wears the slider² a day: 1 at 100%, 2.25 at 150%.", range(1, 20_000, 1));
  add("hardware.shortGameLifespan", "Infrastructure", H, "Lifespan in a 180-day game", "The same in a 180-day game, which counts as one year: above its days, a server at 100% never wears out, but one pushed hard does.", range(1, 20_000, 1));
  add("hardware.warnAt", "Infrastructure", H, "Wear warning", "The student is warned once a server's wear reaches this share of its lifespan (0.9 = 90%).", SHARE);
  add("hardware.wornCrashChance", "Infrastructure", H, "Worn out: extra crash chance", "Past its lifespan a server has this × (wear − lifespan) ÷ lifespan extra chance a day of a crash, whatever its slider.", SHARE);
  const D = "Drift (long games)";
  add("drift.on", "Infrastructure", D, "Drift", "At the end of each year of a long game, running prices rise and new kit gives more units. Off, prices and kit stay as they are all game.", TOGGLE);
  add("drift.yearDays", "Infrastructure", D, "Year", "Prices and kit drift at the end of each year this many days long. A game that ends first never drifts.", range(4, 3650, 1));
  add("drift.inflation.min", "Infrastructure", D, "Least price rise", "Each year's end rolls its own rise from the least to the most (0.02 = 2%): servers, VMs, rent, fees and power. Never the student's price or pay.", range(0, 0.5, 0.001));
  add("drift.inflation.max", "Infrastructure", D, "Most price rise", "The most a year's end can raise running prices.", range(0, 0.5, 0.001));
  add("drift.newKitUnits", "Infrastructure", D, "More units on new kit", "Each year's end, servers and VMs added from then give this much more capacity for the money (0.1 = 10%), compounding. Kit you have keeps its units.", range(0, 1, 0.01));
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
      for (const t of CUSTOMER_TYPE_IDS) {
        if (f.appeal?.[t] === undefined) continue;
        const type = base.customerTypes?.[t]?.name ?? t;
        add(`productTypes.${p}.features.${f.id}.appeal.${t}`, "Customers", s, `${f.name}: appeal to ${type.toLowerCase()}`, "Once built or bought, this customer type's weight among new users is multiplied by this (1.5 = half as many again). 1 for no effect.", MULTIPLIER);
      }
    }
  }
  add("outage.growthMultiplier", "Customers", "", "Growth on an outage day", "Growth is multiplied by this on a day with an outage.", SHARE);
  add("outage.paidChurnPerHour", "Customers", "", "Payers lost per hour down", "Share of paying users who stop paying for each hour of downtime (0.002 = 0.2%).", range(0, 0.1, 0.0005));
  for (const p of PRODUCT_TYPE_IDS) {
    const product = base.productTypes[p];
    if (product?.outageChurnMultiple === undefined) continue;
    add(`productTypes.${p}.outageChurnMultiple`, "Customers", product.name, "Payers lost per hour down: multiple", "The payers this product loses for each hour down are multiplied by this (2 = twice as many).", MULTIPLIER);
  }
  add("pricing.growthSensitivity", "Customers", "", "Price effect on growth", "Growth is multiplied by (price ÷ fair price) to minus this. 0 for no effect.", range(0, 5, 0.05));
  add("pricing.maxGrowthBoost", "Customers", "", "Most a low price speeds growth", "A price below the fair price multiplies growth by at most this.", range(1, 10, 0.05));
  add("pricing.paidShareSensitivity", "Customers", "", "Price effect on new payers", "The paid share of new users is multiplied by (price ÷ fair price) to minus this.", range(0, 5, 0.05));
  add("pricing.newUserFilter", "Customers", "", "Price effect on who joins", "Above a customer type's price threshold, its weight among new users is multiplied by (price ÷ threshold) to minus this, so a dear price brings fewer casual users. 0 for no effect.", range(0, 5, 0.05));

  // Customers: customer types
  for (const t of CUSTOMER_TYPE_IDS) {
    const type = base.customerTypes?.[t];
    if (!type) continue;
    add(`customerTypes.${t}.thresholdMultiple`, "Customers", "Customer types", `${type.name}: price threshold`, "The price at which this type starts to react badly, as a multiple of the product's fair price. A rise and a high price are measured against it.", range(0.1, 20, 0.05));
    add(`customerTypes.${t}.toFreeShare`, "Customers", "Customer types", `${type.name}: drop to free share`, "Of this type's paying users a price rise loses, the share who drop to free. The rest leave.", SHARE);
    add(`customerTypes.${t}.outageLeavePerHour`, "Customers", "Customer types", `${type.name}: users lost per hour down`, "Share of this type's users, paying or free, who leave for each hour of downtime (0.01 = 1%), on top of the payers every type loses. Poor uptime drives the type out.", range(0, 0.1, 0.0005));
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
  add("pricing.backlashTicketsPerUser", "Customers", W, "Backlash tickets per user", "Support tickets each paying user who contacts support over a rise raises.", range(0, 20, 0.1));
  add("pricing.grumbleStrength", "Customers", W, "Rise: grumbling", "Of the payers who stay through a rise, this × (rise ÷ the type's threshold)^curve grumble online, before the cap.", range(0, 5, 0.05));
  add("pricing.maxGrumble", "Customers", W, "Rise: most grumbling", "The most of the payers who stay through a rise who grumble online.", SHARE);
  add("pricing.supportStrength", "Customers", W, "Rise: contacting support", "Of the payers who stay through a rise, this × (rise ÷ the type's threshold)^curve contact support, before the cap.", range(0, 5, 0.05));
  add("pricing.maxSupport", "Customers", W, "Rise: most contacting support", "The most of the payers who stay through a rise who contact support.", SHARE);
  add("pricing.grumbleDivertStrength", "Customers", W, "Grumbling: new users to rivals", "While a rise's backlash lasts, this × grumblers ÷ users of new users go to rivals instead, before the cap.", range(0, 20, 0.1));
  add("pricing.maxGrumbleDivert", "Customers", W, "Grumbling: most new users to rivals", "The most of the new users grumbling can send to rivals.", SHARE);
  add("pricing.expectedPriceDays", "Customers", W, "Expected price (days)", "Every this many days, the price customers expect moves halfway to your price. A cut is measured from the price they expect.", range(1, 180, 1));
  add("pricing.cutGainStrength", "Customers", W, "Cut: new users", "A cut brings this × (cut ÷ the type's threshold)^curve new users, as a share of users, before the cap. Only the part below the price customers expect counts.", range(0, 5, 0.05));
  add("pricing.maxCutGain", "Customers", W, "Cut: most new users", "The most new users one cut can bring, as a share of users.", range(0, 5, 0.05));
  add("pricing.cutUpgradeStrength", "Customers", W, "Cut: upgrades", "A cut turns this × (cut ÷ fair price)^curve of free users into payers, before the cap.", range(0, 5, 0.05));
  add("pricing.maxCutUpgrade", "Customers", W, "Cut: most upgrades", "The most of the free users one cut can turn into payers.", SHARE);
  add("pricing.priceMemoryDays", "Customers", W, "Price memory (days)", "A rise counts from the lowest price customers remember from this many days: small rises add up like one, and rising then cutting back over and over loses overall.", range(0, 180, 1));
  add("pricing.priceChurn", "Customers", "", "Payers lost to a dear price", "Share of paying users who stop paying each day at twice the fair price; × (price ÷ fair − 1)² in general.", range(0, 0.5, 0.001));
  add("pricing.maxPriceChurn", "Customers", "", "Most payers lost to a dear price a day", "The most of the paying users a dear price can lose in a day.", SHARE);

  // Customers: rivals, the market and each product's rivals.
  const R = "Rivals";
  add("rivals.reactionDays", "Customers", R, "Reaction delay (days)", "Rivals answer the price the student charged this many days ago.", range(0, 90, 1));
  add("rivals.undercutChance", "Customers", R, "Undercut chance", "Chance a rival undercuts the student when it answers their price, rather than taking its usual stance.", SHARE);
  add("rivals.undercutShare", "Customers", R, "Undercut by", "An undercut prices this share below the student (0.1 = 10% under).", SHARE);
  add("rivals.minPriceMultiple", "Customers", R, "Lowest rival price", "A rival never charges less than this × the fair price.", range(0.01, 10, 0.05));
  add("rivals.maxPriceMultiple", "Customers", R, "Highest rival price", "A rival never charges more than this × the fair price.", range(0.01, 10, 0.05));
  add("rivals.qualityFromFeatures", "Customers", R, "Quality from features", "Quality points (out of 100) for having every feature: a share for each one.", range(0, 100, 1));
  add("rivals.qualityFromUptime", "Customers", R, "Quality from uptime", "Quality points (out of 100) for 100% uptime, fewer the closer uptime is to the worst uptime.", range(0, 100, 1));
  add("rivals.worstUptime", "Customers", R, "Worst uptime %", "Uptime that earns no quality points.", range(0, 99.9, 0.5));
  add("rivals.uptimeDays", "Customers", R, "Uptime counted over at least (days)", "The student's uptime for quality counts at least this many days, those not yet played as up, so one early outage doesn't wipe out their quality.", range(0, 365, 1));
  add("rivals.joinChance", "Customers", R, "Chance staff let go join a rival", "Each permanent member of staff the student lets go joins a rival with this chance.", SHARE);
  add("rivals.qualityPerStaff", "Customers", R, "Quality per member of staff joining", "Quality points a mid who joins a rival brings it; juniors and seniors by their output.", range(0, 20, 0.5));
  add("rivals.maxStaffQuality", "Customers", R, "Most quality from staff joining", "The most quality points a rival can get from staff who joined it.", range(0, 100, 1));
  add("rivals.growthEffect", "Customers", R, "Effect on growth", "How strongly winning or losing new users to rivals changes the student's growth: 0 for none, 1 in proportion.", range(0, 2, 0.05));
  add("rivals.minGrowth", "Customers", R, "Least growth with rivals", "Rivals never multiply the student's growth by less than this.", range(0, 1, 0.05));
  add("rivals.maxGrowth", "Customers", R, "Most growth with rivals", "Rivals never multiply the student's growth by more than this.", range(1, 5, 0.05));
  for (const t of CUSTOMER_TYPE_IDS) {
    const type = base.customerTypes?.[t]?.name ?? t;
    add(`rivals.priceWeight.${t}`, "Customers", R, `${type}: care about price`, "How much this type's choice of company turns on price: higher pulls them to the cheapest.", range(0, 10, 0.1));
    add(`rivals.qualityWeight.${t}`, "Customers", R, `${type}: care about quality`, "How much this type's choice of company turns on quality: higher pulls them to the best.", range(0, 10, 0.1));
  }
  for (const p of PRODUCT_TYPE_IDS) {
    const product = base.productTypes[p];
    if (!product) continue;
    for (const r of product.rivals ?? []) {
      const at = `productTypes.${p}.rivals.${r.id}`;
      const s = product.name;
      add(`${at}.priceStance`, "Customers", s, `Rival ${r.name}: price stance`, "Its price as a multiple of the student's: at the start (against the fair price) and each time it answers their price.", range(0.1, 5, 0.05));
      add(`${at}.startingUsers`, "Customers", s, `Rival ${r.name}: users at the start`, "Its users on day 1.", range(0, 10_000_000, 500));
      add(`${at}.maxUsers`, "Customers", s, `Rival ${r.name}: most users`, "Users it can reach. Its growth slows as it nears them.", range(1, 10_000_000, 500));
      add(`${at}.dailyGrowth`, "Customers", s, `Rival ${r.name}: daily growth`, "Share of its users it adds each day while it has room, before value.", range(0, 1, 0.001));
      add(`${at}.features`, "Customers", s, `Rival ${r.name}: features at the start`, "Features it has on day 1, out of the product's list.", range(0, 10, 1));
      add(`${at}.featureEveryDays`, "Customers", s, `Rival ${r.name}: a new feature every (days)`, "It builds one more feature every this many days, up to the product's list.", GAME_DAY);
      add(`${at}.uptime`, "Customers", s, `Rival ${r.name}: uptime %`, "Its uptime, which sets part of its quality.", range(0, 100, 0.1));
    }
  }

  // Customers: free-to-paid conversion. The daily rate is the product's base rate × each multiplier, at most the cap.
  const C = "Free-to-paid conversion";
  add("conversion.perFeature", "Customers", C, "Boost per feature", "Each feature built or add-on bought adds this to the conversion multiplier (0.15 = 15% more each).", range(0, 2, 0.01));
  add("conversion.uptimeDays", "Customers", C, "Recent uptime (days)", "Days of recent uptime that count towards conversion: the last days played.", range(1, 60, 1));
  add("conversion.neutralUptime", "Customers", C, "Neutral uptime %", "Recent uptime at which uptime neither helps nor hurts conversion. Above it helps, below it hurts.", range(0, 99, 0.5));
  add("conversion.uptimeEffect", "Customers", C, "Uptime effect", "100% recent uptime multiplies conversion by 1 + this; each step below neutral lowers it at the same rate.", range(0, 5, 0.05));
  add("conversion.satisfactionEffect", "Customers", C, "Satisfaction effect", "100% satisfaction multiplies conversion by 1 + this, with good satisfaction as the neutral line.", range(0, 5, 0.05));
  add("conversion.priceSensitivity", "Customers", C, "Price effect on conversion", "Conversion is multiplied by (price ÷ fair price) to minus this: less above the fair price, more at or below it, up to the most boost. 0 for no effect.", range(0, 5, 0.05));
  add("conversion.maxPriceBoost", "Customers", C, "Most price boost to conversion", "At or below the fair price, conversion rises by at most this share (0.3 = 30% more).", range(0, 5, 0.05));
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

  // Customers: reports on user content and moderators, on products with user content
  for (const p of PRODUCT_TYPE_IDS) {
    const product = base.productTypes[p];
    if (!product?.moderation) continue;
    add(`productTypes.${p}.moderation.reportsPerUser`, "Customers", product.name, "Reports per user", "Reports on user content each user raises a day, paying or free (0.002 = 2 per 1,000 users).", TICKET_RATE);
  }
  add("moderation.reportsPerPerson", "Customers", "Moderation", "Reports per moderator", "Reports one mid moderator handles a day.", range(1, 10_000, 1));
  add("moderation.backlogPerUserAtZero", "Customers", "Moderation", "Unhandled reports per user for 0% satisfaction", "Unhandled reports pull the satisfaction target down in a straight line, to 0% at this many per user (0.05 = 1 per 20).", range(0.001, 1, 0.001));
  add("moderation.lawsuitOddsAtZero", "Customers", "Moderation", "Lawsuit odds at the worst", "Lawsuit odds are multiplied by this at that many unhandled reports per user, rising from 1 at none.", range(1, 20, 0.1));
  add("moderation.warnShare", "Customers", "Moderation", "Unhandled reports worth logging", "Unhandled reports are logged once they take this share off the satisfaction target.", SHARE);

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
      add(`models.${m}.servers.managed.autoscaling.headroom`, "Infrastructure", MODEL_LABELS[m], "Basic autoscaling headroom", "Each night the instances are set to the day's CU demand plus this share (0.25 = 1.25×), never below the number set by hand. Managed autoscaling raises it.", range(0, 5, 0.05));
      add(`models.${m}.servers.managed.autoscaling.burstPremium`, "Infrastructure", MODEL_LABELS[m], "Burst premium", "Each burst instance added during a day costs this many times an instance's day rate (2 = double).", range(1, 10, 0.1));
      add(`models.${m}.servers.managed.autoscaling.maxFactor`, "Infrastructure", MODEL_LABELS[m], "Default autoscaling maximum", "Until the student sets a maximum, it's this many times today's instances.", range(1, 10, 0.5));
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
  add("agency.payMultiplier", "People", "Agency staff", "Pay multiplier", "Agency staff's pay as a multiple of a permanent member of the same grade's.", MULTIPLIER);
  add("agency.output", "People", "Agency staff", "Output", "Agency staff's work a day as a multiple of a permanent member of the same grade's.", MULTIPLIER);
  add("agency.leadDays", "People", "Agency staff", "Lead time (days)", "Days from hiring agency staff to their starting work, whatever the grade (0 = at once, 1 = the next day).", range(0, 60, 1));
  add("severance.days", "People", "", "Severance (days of pay)", "Letting go permanent staff pays each this many days of their pay at once. Agency staff get none.", range(0, 365, 1));
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
  add("payReview.on", "People", "Pay reviews", "Pay reviews", "Staff come about pay once the Grow phase is under way, then once a quarter (a quarter of the game each), and the clock waits until it's settled. Off, pay stays at the day rates all game.", TOGGLE);
  add("payReview.growDays", "People", "Pay reviews", "Days into Grow", "Days into the Grow phase (the first angel investor's approach) the first pay review's rise starts. There's none before.", range(0, 365, 1));
  add("payReview.openEndedYearDays", "People", "Pay reviews", "Year in long games", "Until IPO and a career have years this many days long: a review every quarter of one, once they've started.", range(4, 3650, 1));
  add("payReview.inflation.min", "People", "Pay reviews", "Least inflation", "Each review rolls its own inflation from the least to the most (0.02 = 2%).", range(0, 0.2, 0.001));
  add("payReview.inflation.max", "People", "Pay reviews", "Most inflation", "The most inflation a review can roll.", range(0, 0.2, 0.001));
  add("payReview.fairPriceShare", "People", "Pay reviews", "Inflation into the fair price", "The share of each review's inflation that lifts the product's fair price, compounding (0.25 = a quarter, 0 = never moves).", range(0, 1, 0.01));
  add("payReview.minOfferBelow", "People", "Pay reviews", "Least offer below inflation", "The student can't offer less than inflation less this (0.01 = one point), and never below 0%.", range(0, 0.2, 0.001));
  add("payReview.maxAskAbove", "People", "Pay reviews", "Most ask above inflation", "Staff open at inflation plus this, and never ask for more.", range(0, 0.2, 0.001));
  add("payReview.fairRise.days", "People", "Pay reviews", "Days of growth compared", "The fair rise looks at income over this many days against the same number before them.", GAME_DAY);
  add("payReview.fairRise.growthWeight", "People", "Pay reviews", "Rise per 100% growth", "Added to inflation for the fair rise per 100% income growth (0.02 = two points), and taken off for a fall.", range(0, 0.2, 0.001));
  add("payReview.fairRise.maxGrowthAdjust", "People", "Pay reviews", "Most for growth", "Income growth moves the fair rise by at most this either way.", range(0, 0.2, 0.001));
  add("payReview.fairRise.profitBonus", "People", "Pay reviews", "Rise for a profit", "Added to the fair rise when those days made a profit.", range(0, 0.2, 0.001));
  add("payReview.fairRise.tightCashDays", "People", "Pay reviews", "Tight cash below", "With fewer days of cash than this at today's burn, the fair rise is cut.", GAME_DAY);
  add("payReview.fairRise.tightCashCut", "People", "Pay reviews", "Cut when cash is tight", "Taken off the fair rise when cash is tight.", range(0, 0.2, 0.001));
  add("payReview.walkAwaySpread", "People", "Pay reviews", "Walk-away spread", "Staff accept any offer at or above a hidden figure within this of the fair rise.", range(0, 0.05, 0.001));
  add("payReview.negotiation.dieSides", "People", "Pay review rolls", "Sides on the die", "Each offer staff counter is answered by a roll of a die with this many sides.", range(2, 100, 1));
  add("payReview.negotiation.highFrom", "People", "Pay review rolls", "High roll from", "A roll of this or more, after the penalty, brings staff most of the way down to the offer.", range(1, 100, 1));
  add("payReview.negotiation.middleFrom", "People", "Pay review rolls", "Middle roll from", "A roll of this or more, but below a high roll, brings them about halfway.", range(1, 100, 1));
  add("payReview.negotiation.greedPenalty", "People", "Pay review rolls", "Penalty per 100% asked", "Taken off the roll for an offer asking staff to come all the way down to nothing, and in step for less: 10 is 1 per 10% below their figure.", range(0, 200, 1));
  add("payReview.negotiation.maxAsk", "People", "Pay review rolls", "Most an offer can ask", "The furthest below staff's figure an offer can be, as a share of it (1 = any offer from the least).", range(0.05, 5, 0.05));
  add("payReview.negotiation.moves.high", "People", "Pay review rolls", "High roll moves", "Share of the way from staff's figure to the offer their counter moves on a high roll.", SHARE);
  add("payReview.negotiation.moves.middle", "People", "Pay review rolls", "Middle roll moves", "Share of the way their counter moves on a middle roll.", SHARE);
  add("payReview.negotiation.moves.low", "People", "Pay review rolls", "Low roll moves", "Share of the way their counter moves on a low roll. Below 0 they ask for more instead, never above their opening ask.", range(-1, 1, 0.01));
  add("payReview.tribunal.fee", "People", "Pay review tribunal", "Tribunal fee", "Charged in cash every time a pay review goes to the tribunal, after a take it or leave it offer with no deal.", POUNDS);
  for (const [key, who] of [["none", "No head of people"], ["headOfPeople", "Head of people"]] as const) {
    const p = `payReview.peopleLead.${key}`;
    const g = `People lead: ${who.toLowerCase()}`;
    add(`${p}.rollBonus`, "People", g, `${who}: roll bonus`, "Added to the d20 on each staff counter in a pay review: below 0 staff are stricter and come down less, above 0 friendlier.", range(-10, 10, 1));
    add(`${p}.walkAwaySoftening`, "People", g, `${who}: walk-away softening`, "Taken off staff's hidden walk-away figure when a pay review opens (0.005 = half a point), so they accept a lower offer.", range(0, 0.05, 0.001));
    add(`${p}.schemeValuation`, "People", g, `${who}: scheme valuation`, "How much of a staff scheme's value staff count in a pay review: an offer is worth its cash rise plus each level it adds × the scheme's worth to staff × this. About 0.7 without a head of people, 1 or more with one.", range(0, 3, 0.05));
    add(`${p}.tribunalLean`, "People", g, `${who}: tribunal lean`, "How far the tribunal leans the student's way: it weighs each pick by its distance from the fair rise moved this share of the gap towards the student's offer. 0 is no lean.", range(0, 1, 0.01));
  }
  for (const id of STAFF_SCHEMES) {
    const name = base.payReview.schemes[id].name;
    const p = `payReview.schemes.${id}`;
    add(`${p}.maxLevel`, "People", "Staff schemes", `${name}: most level`, "The highest level it can be raised to: 1 makes it on or off.", range(1, 5, 1));
    add(`${p}.wageShare`, "People", "Staff schemes", `${name}: share of pay`, "Each level costs this share of the permanent staff's pay a day (0.004 = 0.4%).", range(0, 0.2, 0.0005));
    add(`${p}.perPerson`, "People", "Staff schemes", `${name}: £ per person`, "Each level costs this a day per permanent member of staff.", range(0, 50, 0.01));
    add(`${p}.staffValue`, "People", "Staff schemes", `${name}: worth to staff`, "What staff count a level as, as a rise before the scheme valuation (0.0075 = three quarters of a point).", range(0, 0.05, 0.0005));
  }
  add("payReview.shareSavePerLevel", "People", "Staff schemes", "Share save: shares per level", "Each share save level added issues new shares worth this share of the company at the time (0.01 = 1%) to the staff share scheme, diluting every holder.", range(0, 0.1, 0.001));
  add("payReview.tribunal.sharpness", "People", "Pay review tribunal", "Leans to the fair figure", "How strongly the tribunal picks whichever figure (the take it or leave it offer, staff's, or the middle) is closest to a fair rise. 0 picks each equally; at 3 a figure on the fair rise wins about 78% of the time.", range(0, 20, 0.1));
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
  add("timedFlow", "Events", "Game length", "Timed flow", "Time runs on its own, with pause and speed settings, and pauses itself when something needs the student. Off, students play each day (or week, in a career) with Continue. A change reaches games already being played.", TOGGLE);
  for (const d of DIFFICULTY_IDS) {
    add(`allowedDifficulties.${d}`, "Events", "Difficulty", `Allow ${DIFFICULTIES[d].name}`, `Students can pick this difficulty when starting a company. ${DIFFICULTIES[d].blurb} A change only affects new games.`, TOGGLE);
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
      if (event.encounter.spikeWaitDays !== undefined) {
        add(`${at}.encounter.spikeWaitDays`, "Events", s, "Waits for a spike day", "Once due, it waits for a payday, a busy holiday or a traffic spike, for up to about this many days.", range(0, 60, 1));
      }
      add(`${at}.warning.days`, "Events", s, "Warning days", "The student gets a warning when it's next and this many well-run days would bring it. 0 for no warning.", range(0, 30, 1));
      add(`${at}.encounter.followsWithinDays`, "Events", s, "Only within days of what it follows", `It can only fire within this many days of the event it follows (${event.encounter.follows?.join(", ")}).`, GAME_DAY);
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
        for (const [prefix, when, lead] of [
          ["", "", ""],
          ["shortOfOps.", ", short of ops", "Without enough ops"],
          ["unpatched.", ", patches overdue", "With patches overdue"],
        ] as const) {
          const help = lead ? `${lead}: ${meta.help[0]!.toLowerCase()}${meta.help.slice(1)}` : meta.help;
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
    ["ipo.minFloat", "ipo.maxFloat", "The largest float can't be smaller than the smallest."],
    ["ipo.coldChance.min", "ipo.coldChance.max", "The cold-market chance when only just ready can't be below the chance when comfortably ready."],
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
    ["negotiation.middleFrom", "negotiation.highFrom", "A high roll can't start below a middle one."],
    ["negotiation.highFrom", "negotiation.dieSides", "A high roll has to be possible on the die."],
    ["negotiation.moves.low", "negotiation.moves.middle", "A middle roll can't move less than a low one."],
    ["negotiation.moves.middle", "negotiation.moves.high", "A high roll can't move less than a middle one."],
    ["payReview.inflation.min", "payReview.inflation.max", "A review's most inflation can't be below its least."],
    ["drift.inflation.min", "drift.inflation.max", "A year's most price rise can't be below its least."],
    ["payReview.negotiation.middleFrom", "payReview.negotiation.highFrom", "A high roll can't start below a middle one."],
    ["payReview.negotiation.highFrom", "payReview.negotiation.dieSides", "A high roll has to be possible on the die."],
    ["payReview.negotiation.moves.low", "payReview.negotiation.moves.middle", "A middle roll can't move less than a low one."],
    ["payReview.negotiation.moves.middle", "payReview.negotiation.moves.high", "A high roll can't move less than a middle one."],
    ["rivals.minPriceMultiple", "rivals.maxPriceMultiple", "A rival's highest price can't be below its lowest."],
    ["investors.angel.premium.min", "investors.angel.premium.max", "The angel's most premium can't be below the least."],
    ["investors.angel.share.min", "investors.angel.share.max", "The most share the angel asks can't be below the least."],
    ...SERIES_IDS.flatMap((round): [string, string, string][] => [
      [`investors.vc.rounds.${round}.premium.min`, `investors.vc.rounds.${round}.premium.max`, "A round's most premium can't be below its least."],
      [`investors.vc.rounds.${round}.share.min`, `investors.vc.rounds.${round}.share.max`, "The most share a round asks can't be below the least."],
      [`investors.vc.rounds.${round}.minAmount`, `investors.vc.rounds.${round}.maxAmount`, "A round's most cash can't be below its least."],
    ]),
    ["campaigns.minBudget", "campaigns.maxBudget", "A campaign's biggest budget can't be below its smallest."],
    ["campaigns.minDays", "campaigns.maxDays", "A campaign's longest run can't be below its shortest."],
    ["csuite.payHoliday.startDays", "csuite.payHoliday.endDays", "The pay holiday can't end below where it starts."],
  ];
  if (GAME_LENGTH_IDS.every((l) => config.allowedGameLengths[l] !== 1)) {
    const changed = GAME_LENGTH_IDS.find((l) => `allowedGameLengths.${l}` in overrides) ?? GAME_LENGTH_IDS[0];
    errors[`allowedGameLengths.${changed}`] = "At least one game length must be allowed.";
  }
  if (DIFFICULTY_IDS.every((d) => config.allowedDifficulties[d] !== 1)) {
    const changed = DIFFICULTY_IDS.find((d) => `allowedDifficulties.${d}` in overrides) ?? "normal";
    errors[`allowedDifficulties.${changed}`] = "At least one difficulty must be allowed.";
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
