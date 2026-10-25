import type { Calendar } from "./calendar.ts";
import { CUSTOMER_TYPE_IDS, type CustomerTypeId, type GameConfig } from "./config.ts";
import { count, pounds } from "./finance.ts";
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
  /** The holiday it was timed for, which boosts it, or null. */
  holiday: string | null;
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
   * with the type's other campaigns, and any holiday bonus. Budget × this is about what it brings in all.
   */
  usersPerPound: number;
}

/** Campaigns, for the Marketing page. */
export interface CampaignsView {
  /** Campaigns and the Marketing page have opened: the first angel investor has approached. */
  unlocked: boolean;
  /** Whether a campaign can be started now, and if not, why. */
  canStart: boolean;
  why: string | null;
  /** How many campaigns can run at once, and how many are running or about to start. */
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

/** Earned users kept to the millionth, so state stays tidy. */
const tidy = (n: number) => Math.round(n * 1e6) / 1e6;

/** Whether campaigns have opened: the first angel investor has approached, whatever the student made of them. */
export const campaignsUnlocked = (state: Pick<GameState, "investors">) => state.investors.firstApproachDay !== null;

/** Whether a campaign runs on a day. */
const runsOn = (c: Campaign, day: number) => day >= c.startDay && day <= c.endDay;

/** Campaigns still to run or running after the day just played: what counts against how many can run at once. */
const active = (state: Pick<GameState, "campaigns" | "day">) => state.campaigns.filter((c) => c.endDay > state.day);

/**
 * Campaigns: the student aims one at a customer type with a budget and a length, from the next day played. Each day
 * it spends its share of the budget and adds new users of that type directly, on top of normal growth: the day's spend
 * ÷ the type's cost per user, scaled by how full the market is, the overlap with other campaigns on the type that day,
 * any holiday it was timed for, and how well it's run.
 *
 * Two seams are for marketers (#180): capacity says how many campaigns can run at once, and effectiveness how well
 * each is run. Both are fixed for now.
 */
export function createCampaigns(config: GameConfig, calendar: Calendar) {
  const { campaigns: settings } = config;
  const typeName = (t: CustomerTypeId) => config.customerTypes[t].name;

  /** How many campaigns can run at once. */
  const capacity = (_state: GameState) => settings.maxRunning;

  /** How well a campaign is run: multiplies its users per pound. 1 until marketers and a CMO run them. */
  const effectiveness = (_state: GameState, _campaign: Pick<Campaign, "customerType">) => 1;

  /** The share of new users each pound still brings as the market fills: 1 − users ÷ the market's size. */
  const saturation = (state: GameState) =>
    Math.max(0, 1 - state.users / config.productTypes[state.productType].growth.marketSize);

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
    const most = capacity(state);
    if (active(state).length >= most) {
      return `You're running ${most === 1 ? "the one campaign" : `all ${most} campaigns`} you can at once: start another when one finishes or is stopped.`;
    }
    return null;
  }

  function startCampaign(state: GameState, customerType: string, budget: number, days: number): GameState {
    if (!campaignsUnlocked(state)) throw new SimError("not_yet", whyNot(state)!);
    if (state.launchDay === null) throw new SimError("mvp_first", whyNot(state)!);
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
    const reason = whyNot(state);
    if (reason) throw new SimError("campaigns_full", reason);
    if (budget > state.cash) {
      throw new SimError("cant_afford", `The campaign's budget is ${pounds(budget)} and you have ${pounds(state.cash)}.`, { cost: budget, cash: state.cash });
    }
    const startDay = state.day + 1;
    const campaign: Campaign = {
      id: state.nextCampaignId,
      customerType: customerType as CustomerTypeId,
      budget,
      days,
      startDay,
      endDay: startDay + days - 1,
      stopped: false,
      holiday: holidayAhead(state)?.name ?? null,
      spent: 0,
      earned: 0,
      users: 0,
    };
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
   * arrive as they're earned, as the targeted type.
   */
  function campaignsDay(state: GameState, day: number): CampaignsDay {
    const running = state.campaigns.filter((c) => runsOn(c, day));
    if (!running.length) return { campaigns: state.campaigns, users: 0, joined: [], entries: [] };
    const full = saturation(state);
    const sameType = (t: CustomerTypeId) => running.filter((c) => c.customerType === t).length;
    const entries: LogEntry[] = [];
    const joined: UsersLost[] = [];
    let users = 0;
    const campaigns = state.campaigns.map((c) => {
      if (!runsOn(c, day)) return c;
      const lastDay = day === c.startDay + c.days - 1;
      const spend = lastDay ? c.budget - c.spent : Math.min(c.budget - c.spent, Math.round(c.budget / c.days));
      const perPound =
        (full * overlap(sameType(c.customerType)) * (c.holiday ? settings.holidayBonus : 1) * effectiveness(state, c)) /
        settings.costPerUser[c.customerType];
      const earned = tidy(c.earned + spend * perPound);
      const arrived = Math.floor(earned) - c.users;
      users += arrived;
      if (arrived > 0) joined.push({ users: arrived, weights: oneType(c.customerType) });
      const after: Campaign = { ...c, spent: c.spent + spend, earned, users: c.users + arrived };
      const name = typeName(c.customerType).toLowerCase();
      if (spend > 0) {
        const text = `Campaign for ${name} (day ${day - c.startDay + 1} of ${c.days}): ${count.format(arrived)} new ${arrived === 1 ? "user" : "users"}`;
        entries.push({ text, cashDelta: -spend, category: "campaigns" });
      }
      if (lastDay) {
        const each = after.users > 0 ? `, ${pounds(Math.round((100 * after.spent) / after.users) / 100)} a user` : "";
        const text = `Your campaign for ${name} has finished: ${pounds(after.spent)} spent, ${count.format(after.users)} users brought in${each}.`;
        entries.push({ text, cashDelta: 0, kind: "campaign" });
      }
      return after;
    });
    return { campaigns, users, joined, entries };
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
      holiday: c.holiday,
    };
  }

  function campaignsView(state: GameState): CampaignsView {
    const why = whyNot(state);
    const holiday = holidayAhead(state);
    const full = saturation(state);
    const tomorrow = state.campaigns.filter((c) => runsOn(c, state.day + 1));
    const types = CUSTOMER_TYPE_IDS.map((t): CampaignTypeView => {
      const others = active(state).filter((c) => c.customerType === t).length;
      const sameTomorrow = tomorrow.filter((c) => c.customerType === t).length;
      const perPound =
        (full * overlap(sameTomorrow + 1) * (holiday ? settings.holidayBonus : 1) * effectiveness(state, { customerType: t })) /
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
      campaigns: state.campaigns.map((c) => campaignView(state, c)).reverse(),
    };
  }

  return { startCampaign, stopCampaign, campaignsDay, campaignsView };
}

export type Campaigns = ReturnType<typeof createCampaigns>;
