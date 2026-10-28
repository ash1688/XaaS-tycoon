import type { Calendar } from "./calendar.ts";
import { CUSTOMER_TYPE_IDS, STAFF_GRADES, type CustomerTypeId, type GameConfig, type StaffGrade } from "./config.ts";
import { cmoBoost } from "./executives.ts";
import { count, pounds } from "./finance.ts";
import { marketGrowth, marketGrowthCap, marketSize } from "./market.ts";
import { phaseReached } from "./phases.ts";
import type { UsersLost } from "./mix.ts";
import { SimError, type Campaign, type GameState, type LogEntry } from "./state.ts";

/** One campaign for the Marketing page, with its results so far. */
export interface CampaignView {
  id: number;
  customerType: CustomerTypeId;
  /** "Professionals". */
  customerTypeName: string;
  budget: number;
  days: number;
  startDay: number;
  endDay: number;
  /** "starting" until its first day is played, "running" while it has days left, then "finished" or "stopped". */
  status: "starting" | "running" | "finished" | "stopped";
  /** Days it has run so far. */
  daysRun: number;
  /** What it has spent so far, and the users it has brought in. */
  spent: number;
  users: number;
  /** Spent ÷ users, to the penny: null until it has brought anyone in. */
  costPerUser: number | null;
  /** Users it has added to the product's market size (brand awareness), to the whole user: they stay after it ends. */
  marketAdded: number;
  /** The holiday it was timed for, which boosts it, or null. */
  holiday: string | null;
  /** The cost per user it was quoted when started, low to high, to the penny: null if it might bring no-one. */
  quote: { low: number; high: number } | null;
  /** The grade of the marketer running it: "senior", and "Senior". */
  grade: StaffGrade;
  gradeName: string;
}

/** Marketers in one grade: on the team, and free (not running a campaign). */
export interface MarketerGradeView {
  grade: StaffGrade;
  name: string;
  count: number;
  free: number;
  /** Their work against a mid's 1: what multiplies the users per pound of a campaign they run. */
  output: number;
}

/** The marketers who run campaigns, one each. */
export interface MarketersView {
  /** Marketers on the team, and of them those not running a campaign. */
  count: number;
  free: number;
  grades: MarketerGradeView[];
  /** The grade of the marketer a campaign started now would get: the most senior free one. Null with none free. */
  next: StaffGrade | null;
}

/** A customer type a campaign can aim at, and what a pound buys now. */
export interface CampaignTypeView {
  id: CustomerTypeId;
  name: string;
  /** What one new user of the type costs a campaign on its own, before any scaling. */
  costPerUser: number;
  /** Campaigns on the type still to run or running. */
  running: number;
  /**
   * Users each pound of a campaign started now would bring on its first day: after how full the market is, the overlap
   * with the type's other campaigns, any holiday bonus, and the marketer it would get (a mid's, with none free).
   * Budget × this is about what it brings in all.
   */
  usersPerPound: number;
}

/**
 * What a campaign would bring over its whole run, quoted before it starts: day by day, as the market fills with its
 * users, everyone else's growth and the type's other campaigns. Growth can't be known, so it's a range: the most users
 * if growth runs slow, the fewest if it runs fast.
 */
export interface CampaignQuote {
  customerType: CustomerTypeId;
  budget: number;
  days: number;
  /** Users it would bring in all: fewest and most. */
  users: { low: number; high: number };
  /** Budget ÷ users, to the penny: cheapest and dearest. Null if it might bring no-one. */
  costPerUser: { low: number; high: number } | null;
  /** The market is almost full (campaigns.almostFull of it taken): each pound brings few users, whatever the type. */
  almostFull: boolean;
}

/** Campaigns, for the Marketing page. */
export interface CampaignsView {
  /** Campaigns and the Marketing page have opened: the first angel investor has approached. */
  unlocked: boolean;
  /** Whether a campaign can be started now, and if not, why. */
  canStart: boolean;
  why: string | null;
  /** How many campaigns can run at once (a marketer each), and how many are running or about to start. */
  capacity: number;
  running: number;
  minBudget: number;
  maxBudget: number;
  minDays: number;
  maxDays: number;
  /** Each type a campaign can aim at, in config order. */
  types: CampaignTypeView[];
  /** The holiday a campaign started now would be timed for, with its bonus, or null. */
  holiday: { name: string; startDay: number; daysUntil: number; bonus: number } | null;
  /** How full the market is: the share of new users each pound still brings (1 for an empty market). */
  saturation: number;
  /**
   * The market Campaigns have grown (brand awareness), to the whole user: the product's base size, what Campaigns have
   * added so far, and the most they can add all told. Each user a campaign brings in adds `perUser`, until the cap.
   */
  market: { base: number; added: number; cap: number; size: number; perUser: number };
  /** The marketers, and how many are free. */
  marketers: MarketersView;
  /** Every campaign started, newest first. */
  campaigns: CampaignView[];
}

/** A day of campaigns: the campaigns after it, the users they brought (by type, for the mix), and their charges. */
export interface CampaignsDay {
  campaigns: Campaign[];
  users: number;
  joined: UsersLost[];
  entries: LogEntry[];
}

const oneType = (type: CustomerTypeId) =>
  Object.fromEntries(CUSTOMER_TYPE_IDS.map((t) => [t, t === type ? 1 : 0])) as Record<CustomerTypeId, number>;

/** "£1.25": pounds and pence, for a cost per user. */
const penceText = (n: number) => `£${n.toFixed(2)}`;

/** Earned users kept to the millionth, so state stays tidy. */
const tidy = (n: number) => Math.round(n * 1e6) / 1e6;

/** Whether campaigns have opened: the game has reached Grow, which the first angel investor's approach opens. */
export const campaignsUnlocked = (state: Pick<GameState, "phase">) => phaseReached(state, "grow");

/** Whether a campaign runs on a day. */
const runsOn = (c: Campaign, day: number) => day >= c.startDay && day <= c.endDay;
/** What a campaign spends on a day it runs: its budget spread over its days, the last day taking what's left. */
const spendOn = (c: Campaign, day: number) =>
  day === c.startDay + c.days - 1 ? c.budget - c.spent : Math.min(c.budget - c.spent, Math.round(c.budget / c.days));

/** Campaigns still to run or running after the day just played: what counts against how many can run at once. */
const active = (state: Pick<GameState, "campaigns" | "day">) => state.campaigns.filter((c) => c.endDay > state.day);

/**
 * Campaigns: the student aims one at a customer type with a budget and a length, from the next day played. Each day
 * it spends its share of the budget and adds new users of that type directly, on top of normal growth: the day's spend
 * ÷ the type's cost per user, scaled by how full the market is, the overlap with other campaigns on the type that day,
 * any holiday it was timed for, and how well it's run.
 *
 * Marketers run them, one campaign each: a campaign gets the most senior free marketer when it's started, who is busy
 * with it until it ends. So headcount says how many can run at once, and the marketer's grade output how well each is
 * run. A busy marketer can't be let go or moved by the student; one lost in a rescue's cuts stops their campaign.
 */
export function createCampaigns(
  config: GameConfig,
  calendar: Calendar,
  outlook: (state: GameState, day: number) => { growth: number; churn: number },
) {
  const { campaigns: settings } = config;
  const typeName = (t: CustomerTypeId) => config.customerTypes[t].name;

  const gradeName = (g: StaffGrade) => config.staffGrades[g].name;

  /** How many campaigns can run at once: one for each marketer on the team. */
  const capacity = (state: GameState) => STAFF_GRADES.reduce((sum, g) => sum + state.staff.marketers[g], 0);

  /** Campaigns still to run or running with a marketer of a grade: each keeps theirs busy. */
  const busyAt = (state: GameState, grade: StaffGrade) => active(state).filter((c) => c.grade === grade).length;

  /** Marketers of a grade on the team and not running a campaign. */
  const freeAt = (state: GameState, grade: StaffGrade) => Math.max(0, state.staff.marketers[grade] - busyAt(state, grade));

  /** Marketers on the team and not running a campaign, every grade. */
  const freeMarketers = (state: GameState) => STAFF_GRADES.reduce((sum, g) => sum + freeAt(state, g), 0);

  /** The marketer a campaign started now gets: the most senior free one, or null with none free. */
  const nextMarketer = (state: GameState) => [...STAFF_GRADES].reverse().find((g) => freeAt(state, g) > 0) ?? null;

  /** What a CMO adds to every campaign: 1 without one. */
  const cmoBonus = (state: GameState) => cmoBoost(config, state);

  /** How well a campaign is run: multiplies its users per pound. Its marketer's grade output, × the CMO bonus. */
  const effectiveness = (state: GameState, campaign: Pick<Campaign, "grade">) =>
    config.staffGrades[campaign.grade].output * cmoBonus(state);

  /** The share of new users each pound still brings as the market fills: 1 − users ÷ the market's size, grown included. */
  const saturation = (state: GameState) => Math.max(0, 1 - state.users / marketSize(config, state));

  /** The overlap with n campaigns on one type running on a day: each brings overlapMultiplier^(n − 1) per pound. */
  const overlap = (n: number) => settings.overlapMultiplier ** Math.max(0, n - 1);

  /**
   * The holiday a campaign started now (running from tomorrow) is timed for: the soonest to start within
   * holidayLeadDays of its first day that boosts the product's growth. Null if none.
   */
  function holidayAhead(state: GameState) {
    const first = state.day + 1;
    const next = calendar
      .calendar(state)
      .upcoming.find((h) => h.startDay >= first && h.startDay <= first + settings.holidayLeadDays && (h.effect?.growthMultiplier ?? 1) > 1);
    return next ? { name: next.name, startDay: next.startDay, daysUntil: next.daysUntil, bonus: settings.holidayBonus } : null;
  }

  /** Why a campaign can't be started now, or null when it can. */
  function whyNot(state: GameState): string | null {
    if (!campaignsUnlocked(state)) return "Campaigns open once your company grows up: when your first angel investor approaches.";
    if (state.launchDay === null) return "Campaigns can start once your MVP is done and your first users have arrived.";
    if (nextMarketer(state) !== null) return null;
    const most = capacity(state);
    if (most === 0) return "Each campaign needs a marketer to run it: hire one on People.";
    const all = most === 1 ? "Your one marketer is" : `All ${most} of your marketers are`;
    return `${all} running a campaign: hire another, or start one when a campaign finishes or is stopped.`;
  }

  /** Why marketers are idle, if any are: they're on the team and not running a campaign. Null otherwise. */
  function marketersIdle(state: GameState): string | null {
    const free = freeMarketers(state);
    if (free === 0) return null;
    const who = free === 1 ? "1 marketer isn't" : `${free} marketers aren't`;
    return `${who} running a campaign: start one on Marketing, or let them go to save their pay.`;
  }

  /**
   * Refuses a team that would leave a running campaign without its marketer: the student letting go or moving a busy
   * one. They stop the campaign first, or pick a free marketer.
   */
  function checkBusyMarketers(state: GameState) {
    const short = STAFF_GRADES.find((g) => state.staff.marketers[g] < busyAt(state, g));
    if (!short) return;
    throw new SimError(
      "marketer_busy",
      `That would take a ${gradeName(short).toLowerCase()} marketer off a campaign they're running: stop the campaign on Marketing first, or pick a free marketer.`,
    );
  }

  /**
   * Stops the campaigns whose marketers have gone, as a rescue's cuts can let them go: at each grade, the newest
   * campaigns past the marketers left. Ones yet to run a day are dropped, having spent nothing.
   */
  function release(state: GameState): { state: GameState; entries: LogEntry[] } {
    const ending = new Set<number>();
    for (const g of STAFF_GRADES) {
      const over = busyAt(state, g) - state.staff.marketers[g];
      if (over > 0) for (const c of active(state).filter((c) => c.grade === g).slice(-over)) ending.add(c.id);
    }
    if (!ending.size) return { state, entries: [] };
    const entries: LogEntry[] = state.campaigns
      .filter((c) => ending.has(c.id))
      .map((c) => ({
        text: `Your campaign for ${typeName(c.customerType).toLowerCase()} has stopped: its marketer has gone.`,
        cashDelta: 0,
        kind: "campaign",
      }));
    const campaigns = state.campaigns
      .filter((c) => !ending.has(c.id) || c.startDay <= state.day)
      .map((c) => (ending.has(c.id) ? { ...c, endDay: state.day, stopped: true } : c));
    return { state: { ...state, campaigns }, entries };
  }

  /** Refuses a campaign aimed at no known type, or with a budget or length out of range. */
  function checkPlan(customerType: string, budget: number, days: number): asserts customerType is CustomerTypeId {
    if (!(CUSTOMER_TYPE_IDS as readonly string[]).includes(customerType)) {
      throw new SimError("unknown_customer_type", "Pick a customer type for the campaign to aim at.");
    }
    const { minBudget, maxBudget, minDays, maxDays } = settings;
    if (!Number.isInteger(budget) || budget < minBudget || budget > maxBudget) {
      throw new SimError("bad_budget", `A campaign's budget is a whole number of pounds from ${pounds(minBudget)} to ${pounds(maxBudget)}.`);
    }
    if (!Number.isInteger(days) || days < minDays || days > maxDays) {
      throw new SimError("bad_length", `A campaign runs for ${minDays} to ${maxDays} days.`);
    }
  }

  /** A campaign started now, from the next day played, run by the marketer it would get (a mid's, with none free). */
  function planned(state: GameState, customerType: CustomerTypeId, budget: number, days: number): Campaign {
    const startDay = state.day + 1;
    return {
      id: state.nextCampaignId,
      customerType,
      budget,
      days,
      startDay,
      endDay: startDay + days - 1,
      stopped: false,
      holiday: holidayAhead(state)?.name ?? null,
      grade: nextMarketer(state) ?? "mid",
      spent: 0,
      earned: 0,
      users: 0,
      marketAdded: 0,
      quote: null,
    };
  }

  /**
   * The users a campaign would bring over its whole run, played forward from today without chance: each day as
   * campaignsDay plays it, the campaigns running (the type's others included) bringing users and growing the market,
   * and the company's other users growing at today's outlook × `pace`, as the market fills, less churn.
   */
  function project(state: GameState, campaign: Campaign, pace: number): number {
    const { growth, churn } = outlook(state, state.day + 1);
    const all = [...active(state), campaign].map((c) => ({ ...c }));
    const cap = marketGrowthCap(config, state);
    const base = config.productTypes[state.productType].growth.marketSize;
    let users = state.users;
    let added = marketGrowth(state);
    for (let day = state.day + 1; day <= campaign.endDay; day++) {
      const full = Math.max(0, 1 - users / (base + added));
      const running = all.filter((c) => runsOn(c, day));
      const sameType = (t: CustomerTypeId) => running.filter((c) => c.customerType === t).length;
      let joined = 0;
      for (const c of running) {
        const spend = spendOn(c, day);
        const perPound =
          (full * overlap(sameType(c.customerType)) * (c.holiday ? settings.holidayBonus : 1) * effectiveness(state, c)) /
          settings.costPerUser[c.customerType];
        c.spent += spend;
        c.earned = tidy(c.earned + spend * perPound);
        const arrived = Math.floor(c.earned) - c.users;
        c.users += arrived;
        joined += arrived;
      }
      added = Math.min(cap, added + joined * settings.marketPerUser);
      users = Math.max(0, users + users * (pace * growth * full - churn) + joined);
    }
    return all.at(-1)!.users;
  }

  /**
   * What a campaign started now would bring over its whole run, as a range: the most users if everyone else's growth
   * runs at campaigns.quotePace.low × today's outlook, the fewest at quotePace.high × it, each widened by quoteMargin.
   */
  function quote(state: GameState, customerType: string, budget: number, days: number): CampaignQuote {
    checkPlan(customerType, budget, days);
    const campaign = planned(state, customerType, budget, days);
    // Chance (events, noise) moves a run either way: each end is widened by quoteMargin.
    const most = Math.ceil(project(state, campaign, settings.quotePace.low) * (1 + settings.quoteMargin));
    const fewest = Math.min(most, Math.floor(project(state, campaign, settings.quotePace.high) * (1 - settings.quoteMargin)));
    const each = (users: number, round: (x: number) => number) => round((100 * budget) / users) / 100;
    return {
      customerType,
      budget,
      days,
      users: { low: fewest, high: most },
      costPerUser: fewest > 0 ? { low: each(most, Math.floor), high: each(fewest, Math.ceil) } : null,
      almostFull: saturation(state) <= 1 - settings.almostFull,
    };
  }

  function startCampaign(state: GameState, customerType: string, budget: number, days: number): GameState {
    if (!campaignsUnlocked(state)) throw new SimError("not_yet", whyNot(state)!);
    if (state.launchDay === null) throw new SimError("mvp_first", whyNot(state)!);
    checkPlan(customerType, budget, days);
    const grade = nextMarketer(state);
    if (grade === null) throw new SimError("no_marketer", whyNot(state)!);
    if (budget > state.cash) {
      throw new SimError("cant_afford", `The campaign's budget is ${pounds(budget)} and you have ${pounds(state.cash)}.`, { cost: budget, cash: state.cash });
    }
    const campaign: Campaign = { ...planned(state, customerType, budget, days), quote: quote(state, customerType, budget, days).costPerUser };
    return { ...state, campaigns: [...state.campaigns, campaign], nextCampaignId: state.nextCampaignId + 1 };
  }

  /** Stops a campaign after the day just played. One that hasn't run a day yet is dropped, having spent nothing. */
  function stopCampaign(state: GameState, id: number): GameState {
    const campaign = state.campaigns.find((c) => c.id === id);
    if (!campaign) throw new SimError("unknown_campaign", "That campaign wasn't found.");
    if (campaign.endDay <= state.day) throw new SimError("campaign_over", "That campaign has already finished.");
    if (campaign.startDay > state.day) return { ...state, campaigns: state.campaigns.filter((c) => c.id !== id) };
    return { ...state, campaigns: state.campaigns.map((c) => (c.id === id ? { ...c, endDay: state.day, stopped: true } : c)) };
  }

  /**
   * A day of campaigns. Each running one spends its share of the budget (the last day what's left, so it spends exactly
   * its budget) and earns users: the spend ÷ the type's cost per user, × how full the market was at the start of the
   * day, × the overlap with the type's campaigns running today, × any holiday bonus, × how well it's run. Whole users
   * arrive as they're earned, as the targeted type. Each grows the market by marketPerUser, for good, until campaigns
   * have added marketGrowthCap of its base size: so the users it brings are extra, not ones who'd have joined anyway.
   */
  function campaignsDay(state: GameState, day: number): CampaignsDay {
    const running = state.campaigns.filter((c) => runsOn(c, day));
    if (!running.length) return { campaigns: state.campaigns, users: 0, joined: [], entries: [] };
    const full = saturation(state);
    const sameType = (t: CustomerTypeId) => running.filter((c) => c.customerType === t).length;
    const entries: LogEntry[] = [];
    const joined: UsersLost[] = [];
    let users = 0;
    let room = Math.max(0, marketGrowthCap(config, state) - marketGrowth(state));
    const campaigns = state.campaigns.map((c) => {
      if (!runsOn(c, day)) return c;
      const lastDay = day === c.startDay + c.days - 1;
      const spend = spendOn(c, day);
      const perPound =
        (full * overlap(sameType(c.customerType)) * (c.holiday ? settings.holidayBonus : 1) * effectiveness(state, c)) /
        settings.costPerUser[c.customerType];
      const earned = tidy(c.earned + spend * perPound);
      const arrived = Math.floor(earned) - c.users;
      users += arrived;
      if (arrived > 0) joined.push({ users: arrived, weights: oneType(c.customerType) });
      const added = Math.min(room, arrived * settings.marketPerUser);
      room -= added;
      const after: Campaign = { ...c, spent: c.spent + spend, earned, users: c.users + arrived, marketAdded: tidy(c.marketAdded + added) };
      const name = typeName(c.customerType).toLowerCase();
      if (spend > 0) {
        const text = `Campaign for ${name} (day ${day - c.startDay + 1} of ${c.days}): ${count.format(arrived)} new ${arrived === 1 ? "user" : "users"}`;
        entries.push({ text, cashDelta: -spend, category: "campaigns" });
      }
      if (lastDay) entries.push({ text: finishedText(after), cashDelta: 0, kind: "campaign" });
      return after;
    });
    return { campaigns, users, joined, entries };
  }

  /**
   * A campaign's final figures against its quote: "Your campaign for casual users has finished: £1,000 spent, 800
   * users brought in, £1.25 a user, within its quote of £1.10–£1.40."
   */
  function finishedText(c: Campaign): string {
    const name = typeName(c.customerType).toLowerCase();
    const each = c.users > 0 ? Math.round((100 * c.spent) / c.users) / 100 : null;
    const figures = `${pounds(c.spent)} spent, ${count.format(c.users)} ${c.users === 1 ? "user" : "users"} brought in${each !== null ? `, ${penceText(each)} a user` : ""}`;
    if (!c.quote) return `Your campaign for ${name} has finished: ${figures}.`;
    const range = `${penceText(c.quote.low)}–${penceText(c.quote.high)}`;
    const against =
      each === null ? `against a quote of ${range} a user` : each < c.quote.low ? `cheaper than its quote of ${range}` : each > c.quote.high ? `dearer than its quote of ${range}` : `within its quote of ${range}`;
    return `Your campaign for ${name} has finished: ${figures}, ${against}.`;
  }

  function campaignView(state: GameState, c: Campaign): CampaignView {
    const status = c.startDay > state.day ? "starting" : c.endDay > state.day ? "running" : c.stopped ? "stopped" : "finished";
    return {
      id: c.id,
      customerType: c.customerType,
      customerTypeName: typeName(c.customerType),
      budget: c.budget,
      days: c.days,
      startDay: c.startDay,
      endDay: c.endDay,
      status,
      daysRun: Math.max(0, Math.min(state.day, c.endDay) - c.startDay + 1),
      spent: c.spent,
      users: c.users,
      costPerUser: c.users > 0 ? Math.round((100 * c.spent) / c.users) / 100 : null,
      marketAdded: Math.round(c.marketAdded),
      holiday: c.holiday,
      quote: c.quote,
      grade: c.grade,
      gradeName: gradeName(c.grade),
    };
  }

  /** What the campaigns running on a day will spend on it, for the daily costs. */
  const dailySpend = (state: GameState, day: number) =>
    state.campaigns.reduce((sum, c) => sum + (runsOn(c, day) ? spendOn(c, day) : 0), 0);

  function campaignsView(state: GameState): CampaignsView {
    const why = whyNot(state);
    const holiday = holidayAhead(state);
    const full = saturation(state);
    const tomorrow = state.campaigns.filter((c) => runsOn(c, state.day + 1));
    const next = nextMarketer(state);
    const types = CUSTOMER_TYPE_IDS.map((t): CampaignTypeView => {
      const others = active(state).filter((c) => c.customerType === t).length;
      const sameTomorrow = tomorrow.filter((c) => c.customerType === t).length;
      const perPound =
        (full * overlap(sameTomorrow + 1) * (holiday ? settings.holidayBonus : 1) * effectiveness(state, { grade: next ?? "mid" })) /
        settings.costPerUser[t];
      return { id: t, name: typeName(t), costPerUser: settings.costPerUser[t], running: others, usersPerPound: Math.round(perPound * 1e4) / 1e4 };
    });
    return {
      unlocked: campaignsUnlocked(state),
      canStart: why === null,
      why,
      capacity: capacity(state),
      running: active(state).length,
      minBudget: settings.minBudget,
      maxBudget: settings.maxBudget,
      minDays: settings.minDays,
      maxDays: settings.maxDays,
      types,
      holiday,
      saturation: Math.round(full * 1e4) / 1e4,
      market: {
        base: config.productTypes[state.productType].growth.marketSize,
        added: Math.round(marketGrowth(state)),
        cap: marketGrowthCap(config, state),
        size: Math.round(marketSize(config, state)),
        perUser: settings.marketPerUser,
      },
      marketers: {
        count: capacity(state),
        free: freeMarketers(state),
        grades: STAFF_GRADES.map((g) => ({
          grade: g,
          name: gradeName(g),
          count: state.staff.marketers[g],
          free: freeAt(state, g),
          output: config.staffGrades[g].output,
        })),
        next,
      },
      campaigns: state.campaigns.map((c) => campaignView(state, c)).reverse(),
    };
  }

  return { startCampaign, stopCampaign, campaignsDay, dailySpend, campaignsView, quote, marketersIdle, checkBusyMarketers, release };
}

export type Campaigns = ReturnType<typeof createCampaigns>;
