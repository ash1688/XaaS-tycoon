import type { GameConfig } from "./config.ts";
import type { Conversion } from "./conversion.ts";
import { count, pounds, type Finance } from "./finance.ts";
import {
  isFunderId,
  SimError,
  type FriendsAndFamilyFunding,
  type Funding,
  type FunderId,
  type GameState,
  type GrantFunding,
  type LogEntry,
  type Shareholder,
} from "./state.ts";

export type ValuationDriverId =
  | "revenue"
  | "growth"
  | "satisfaction"
  | "uptime"
  | "multipleFloor"
  | "payingUsers"
  | "minimum";

/** One thing pushing the valuation up or down, in pounds. The drivers add up to the valuation. */
export interface ValuationDriver {
  id: ValuationDriverId;
  label: string;
  /** Its part of the valuation: below 0 it's pulling it down. */
  amount: number;
  /** What it's measured on, in words. */
  detail: string;
}

/** What the company is worth today, and why. See ValuationConfig for the formula. */
export interface ValuationView {
  valuation: number;
  sharesInIssue: number;
  /** valuation ÷ shares in issue, unrounded: with many shares it can be a fraction of a penny. */
  sharePrice: number;
  /** Income earned a day over the last revenueDays days since launch, averaged, × 365. */
  annualRevenue: number;
  /** What annual revenue is multiplied by, after growth, satisfaction and uptime; never below 0. */
  multiple: number;
  /** Growth in paying users over the configured days, since the launch ramp ended, as a share (0.5 = 50%). */
  growth: number;
  /** Recent uptime %, as free-to-paid conversion measures it. */
  recentUptime: number;
  /** Revenue first, then growth, satisfaction, uptime, paying users and any top-up to the minimum. */
  drivers: ValuationDriver[];
}

/** One line of the cap table. */
export interface CapTableRow {
  id: Shareholder["id"];
  name: string;
  shares: number;
  /** Their share of the company, 0–1. */
  share: number;
  /** What their shares are worth at today's share price. */
  value: number;
}

/** Who owns the company: the student first. */
export interface CapTableView {
  sharesInIssue: number;
  sharePrice: number;
  rows: CapTableRow[];
}

/** What accepting friends and family's offer now would do: worked out at today's share price. */
export interface FriendsAndFamilyOffer {
  amount: number;
  valuation: number;
  sharePrice: number;
  /** New shares they'd get: amount ÷ share price, to the whole share. */
  newShares: number;
  sharesInIssue: number;
  sharesAfter: number;
  /** Their share of the company after, 0–1. */
  theirShare: number;
  /** Yours now and after, 0–1. */
  yourShareBefore: number;
  yourShareAfter: number;
}

/** The grant's offer: cash for no shares, on an uptime condition. */
export interface GrantOffer {
  amount: number;
  /** Days played after accepting that the condition covers, and the last of them if accepted today. */
  days: number;
  untilDay: number;
  minUptime: number;
  /** Hours down allowed over those days in all. */
  maxHoursDown: number;
  /** The condition and what happens if it's broken, in words. */
  condition: string;
  ifMissed: string;
}

/** The grant once answered, with how its condition stands. */
export interface GrantView extends GrantFunding {
  /** Days of the condition still to play: 0 once it's over. */
  daysLeft: number;
  /** Hours down still allowed before it's withdrawn: 0 once it's over. */
  hoursLeft: number;
}

/** Friends and family and the grant: each one's open offer, or how it was answered. */
export interface FundingView {
  /** Friends and family's offer, while it's open; null once answered. */
  friendsAndFamilyOffer: FriendsAndFamilyOffer | null;
  friendsAndFamily: FriendsAndFamilyFunding | null;
  /** The grant's offer, while it's open; null once answered. */
  grantOffer: GrantOffer | null;
  grant: GrantView | null;
}

const DAYS_PER_YEAR = 365;
const HOURS_PER_DAY = 24;
const NAMES: Record<Shareholder["id"], string> = { student: "You", friendsAndFamily: "Friends and family" };
const FUNDER_NAMES: Record<FunderId, string> = { friendsAndFamily: "Friends and family", grant: "The grant" };
const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;
const round1 = (n: number) => Math.round(n * 10) / 10;
const multipleText = (m: number) => `${m >= 0 ? "+" : "−"}${Math.abs(Math.round(m * 100) / 100)}×`;

/**
 * Shares, valuation, the cap table, and the funders on the Finance page from day 1: friends and family, who buy new
 * shares at the share price, and the grant, which gives cash with an uptime condition and takes no shares.
 */
export function createShares(config: GameConfig, finance: Finance, conversion: Conversion) {
  const v = config.valuation;
  const f = config.funding;

  /** A new company's cap table: every share the student's. Refuses a count outside the configured range. */
  function startingShares(shares = config.shares.default): { shareholders: Shareholder[]; funding: Funding } {
    const { min, max } = config.shares;
    if (!Number.isInteger(shares) || shares < min || shares > max) {
      throw new SimError(
        "bad_shares",
        `Pick a whole number of shares from ${count.format(min)} to ${count.format(max)}.`,
        { min, max },
      );
    }
    return { shareholders: [{ id: "student", shares, day: 1 }], funding: { friendsAndFamily: null, grant: null } };
  }

  const sharesInIssue = (state: GameState) => state.shareholders.reduce((sum, h) => sum + h.shares, 0);

  // The launch ramp's users arriving aren't growth: it's measured from the end of the ramp at the earliest.
  const rampDays = config.launch.rampShares.some((x) => x > 0) ? config.launch.rampShares.length : 1;

  /**
   * Paying users growthDays ago, or at the end of the launch ramp if that was later. Today's before the ramp has
   * ended, so there's no growth yet.
   */
  function paidUsersBefore(state: GameState): number {
    if (state.launchDay === null) return state.paidUsers;
    const from = Math.max(state.day - v.growthDays, state.launchDay + rampDays - 1);
    const then = state.spendByDay.find((d) => d.day >= from);
    return then?.paidUsers ?? state.paidUsers;
  }

  /**
   * Income actually earned a day, averaged over the last revenueDays days played since launch: not today's price, so
   * a price change only moves the valuation as the income it brings comes in. 0 before any.
   */
  function averageIncome(state: GameState): number {
    if (state.launchDay === null) return 0;
    const from = Math.max(state.day - v.revenueDays + 1, state.launchDay + 1);
    const days = state.spendByDay.filter((d) => d.day >= from);
    return days.length ? days.reduce((sum, d) => sum + d.income, 0) / days.length : 0;
  }

  function valuation(state: GameState): ValuationView {
    const annualRevenue = Math.round(averageIncome(state) * DAYS_PER_YEAR);
    const before = paidUsersBefore(state);
    const growth = (state.paidUsers - before) / Math.max(before, v.growthBaseUsers);
    const growthM = Math.min(v.maxGrowthMultiple, Math.max(-v.maxGrowthPenalty, v.growthMultiple * growth));
    const satisfactionM =
      state.satisfaction < v.goodSatisfaction
        ? (-v.satisfactionPenalty * (v.goodSatisfaction - state.satisfaction)) / Math.max(1, v.goodSatisfaction)
        : 0;
    const recentUptime = conversion.recentUptime(state);
    const uptimeM =
      recentUptime < v.goodUptime ? -Math.min(v.maxUptimePenalty, v.uptimePenaltyPerPoint * (v.goodUptime - recentUptime)) : 0;
    const raw = v.revenueMultiple + growthM + satisfactionM + uptimeM;
    const multiple = Math.max(0, raw);
    const part = (m: number) => Math.round(annualRevenue * m);

    const drivers: ValuationDriver[] = [
      {
        id: "revenue",
        label: "Revenue",
        amount: part(v.revenueMultiple),
        detail: `${pounds(annualRevenue)} a year, from the income earned over the last ${v.revenueDays} days, × ${v.revenueMultiple}`,
      },
      {
        id: "growth",
        label: "Growth",
        amount: part(growthM),
        detail: `Paying users ${growth >= 0 ? "up" : "down"} ${percent(Math.abs(growth))} over ${v.growthDays} days: ${multipleText(growthM)} revenue`,
      },
      {
        id: "satisfaction",
        label: "Satisfaction",
        amount: part(satisfactionM),
        detail: satisfactionM
          ? `${Math.round(state.satisfaction)}%, below ${v.goodSatisfaction}%: ${multipleText(satisfactionM)} revenue`
          : `${Math.round(state.satisfaction)}%: no effect at ${v.goodSatisfaction}% or more`,
      },
      {
        id: "uptime",
        label: "Uptime",
        amount: part(uptimeM),
        detail: uptimeM
          ? `${round1(recentUptime)}% lately, below ${v.goodUptime}%: ${multipleText(uptimeM)} revenue`
          : `${round1(recentUptime)}% lately: no effect at ${v.goodUptime}% or more`,
      },
    ];
    // The multiple can't go below 0: a company isn't worth less for having revenue.
    if (raw < 0) {
      drivers.push({
        id: "multipleFloor",
        label: "Multiple floor",
        amount: -drivers.reduce((sum, d) => sum + d.amount, 0),
        detail: "Revenue can't count for less than nothing",
      });
    }
    drivers.push({
      id: "payingUsers",
      label: "Paying users",
      amount: state.paidUsers * v.valuePerPayingUser,
      detail: `${count.format(state.paidUsers)} × ${pounds(v.valuePerPayingUser)}`,
    });
    const formula = drivers.reduce((sum, d) => sum + d.amount, 0);
    if (formula < v.minimum) {
      drivers.push({
        id: "minimum",
        label: "Minimum",
        amount: v.minimum - formula,
        detail: `A company is never valued below ${pounds(v.minimum)}`,
      });
    }
    const value = Math.max(v.minimum, formula);
    const shares = sharesInIssue(state);
    return {
      valuation: value,
      sharesInIssue: shares,
      sharePrice: value / shares,
      annualRevenue,
      multiple: Math.round(multiple * 100) / 100,
      growth,
      recentUptime,
      drivers,
    };
  }

  function capTable(state: GameState): CapTableView {
    const { valuation: value, sharesInIssue: shares, sharePrice } = valuation(state);
    return {
      sharesInIssue: shares,
      sharePrice,
      rows: state.shareholders.map((h) => ({
        id: h.id,
        name: NAMES[h.id],
        shares: h.shares,
        share: h.shares / shares,
        value: Math.round((value * h.shares) / shares),
      })),
    };
  }

  /** The student's share of the company, 0–1. */
  const studentShare = (state: GameState) =>
    (state.shareholders.find((h) => h.id === "student")?.shares ?? 0) / sharesInIssue(state);

  function friendsAndFamilyOffer(state: GameState): FriendsAndFamilyOffer | null {
    if (state.funding.friendsAndFamily) return null;
    const { valuation: value, sharesInIssue: shares, sharePrice } = valuation(state);
    const amount = f.friendsAndFamily.amount;
    // New shares at the share price: their share of the company after is amount ÷ (valuation + amount).
    const newShares = Math.round((amount * shares) / value);
    const sharesAfter = shares + newShares;
    const yours = state.shareholders.find((h) => h.id === "student")?.shares ?? 0;
    return {
      amount,
      valuation: value,
      sharePrice,
      newShares,
      sharesInIssue: shares,
      sharesAfter,
      theirShare: newShares / sharesAfter,
      yourShareBefore: yours / shares,
      yourShareAfter: yours / sharesAfter,
    };
  }

  function grantOffer(state: GameState): GrantOffer | null {
    if (state.funding.grant) return null;
    const { amount, days, minUptime } = f.grant;
    const maxHoursDown = round1(((100 - minUptime) / 100) * HOURS_PER_DAY * days);
    return {
      amount,
      days,
      untilDay: state.day + days,
      minUptime,
      maxHoursDown,
      condition: `Keep uptime at ${minUptime}% or more for the ${days} days after you accept it: at most ${maxHoursDown} hours down in all.`,
      ifMissed: `Go over and the grant is withdrawn: all ${pounds(amount)} is paid back at once, which can bankrupt the company.`,
    };
  }

  function grantView(state: GameState): GrantView | null {
    const grant = state.funding.grant;
    if (!grant) return null;
    const running = grant.status === "accepted";
    return {
      ...grant,
      daysLeft: running ? Math.max(0, grant.untilDay - state.day) : 0,
      hoursLeft: running ? round1(Math.max(0, grant.maxHoursDown - grant.hoursDown)) : 0,
    };
  }

  function funding(state: GameState): FundingView {
    return {
      friendsAndFamilyOffer: friendsAndFamilyOffer(state),
      friendsAndFamily: state.funding.friendsAndFamily,
      grantOffer: grantOffer(state),
      grant: grantView(state),
    };
  }

  function checkOpen(state: GameState, funder: string): asserts funder is FunderId {
    if (!isFunderId(funder)) throw new SimError("unknown_funder", "Pick friends and family or the grant.");
    const answered = state.funding[funder];
    if (answered) {
      throw new SimError(
        "funding_answered",
        `${FUNDER_NAMES[funder]}'s offer can only be taken once, and you ${answered.status === "declined" ? "declined" : "accepted"} it on day ${answered.day}.`,
      );
    }
  }

  /** Takes a funder's offer between days: the cash arrives at once, with friends and family's new shares. */
  function acceptFunding(state: GameState, funder: string): GameState {
    checkOpen(state, funder);
    if (funder === "friendsAndFamily") {
      const offer = friendsAndFamilyOffer(state)!;
      const entry: LogEntry = {
        text: `Friends and family put in ${pounds(offer.amount)} for ${count.format(offer.newShares)} new shares at ${pounds(offer.sharePrice)} each: ${percent(offer.theirShare)} of the company. You now own ${percent(offer.yourShareAfter)}.`,
        cashDelta: offer.amount,
        kind: "funding",
      };
      return {
        ...finance.chargeNow(state, [entry]),
        shareholders: [...state.shareholders, { id: "friendsAndFamily", shares: offer.newShares, day: state.day }],
        funding: {
          ...state.funding,
          friendsAndFamily: {
            status: "accepted",
            day: state.day,
            amount: offer.amount,
            shares: offer.newShares,
            valuation: offer.valuation,
          },
        },
      };
    }
    const offer = grantOffer(state)!;
    const entry: LogEntry = {
      text: `You accepted a ${pounds(offer.amount)} grant. ${offer.condition}`,
      cashDelta: offer.amount,
      kind: "funding",
    };
    return {
      ...finance.chargeNow(state, [entry]),
      funding: {
        ...state.funding,
        grant: {
          status: "accepted",
          day: state.day,
          amount: offer.amount,
          untilDay: offer.untilDay,
          minUptime: offer.minUptime,
          maxHoursDown: offer.maxHoursDown,
          hoursDown: 0,
        },
      },
    };
  }

  /** Turns a funder down for good. */
  function declineFunding(state: GameState, funder: string): GameState {
    checkOpen(state, funder);
    const declined =
      funder === "friendsAndFamily"
        ? { status: "declined" as const, day: state.day, amount: 0, shares: 0, valuation: 0 }
        : (() => {
            const offer = grantOffer(state)!;
            const { amount, untilDay, minUptime, maxHoursDown } = offer;
            return { status: "declined" as const, day: state.day, amount, untilDay, minUptime, maxHoursDown, hoursDown: 0 };
          })();
    return { ...state, funding: { ...state.funding, [funder]: declined } };
  }

  /**
   * The grant's condition on a day played: its hours down count while it runs. Going over the hours allowed withdraws
   * it, paying it all back that day; reaching its last day within them meets it.
   */
  function grantDay(state: GameState, day: number, hoursDown: number): { funding: Funding; entries: LogEntry[] } {
    const grant = state.funding.grant;
    if (!grant || grant.status !== "accepted" || day <= grant.day || day > grant.untilDay) {
      return { funding: state.funding, entries: [] };
    }
    const down = round1(grant.hoursDown + hoursDown);
    if (down > grant.maxHoursDown) {
      return {
        funding: { ...state.funding, grant: { ...grant, hoursDown: down, status: "withdrawn" } },
        entries: [
          {
            text: `Grant withdrawn: ${down} hours down since you accepted it, over the ${grant.maxHoursDown} its ${grant.minUptime}% uptime condition allows. All ${pounds(grant.amount)} is paid back.`,
            cashDelta: -grant.amount,
            kind: "funding",
          },
        ],
      };
    }
    if (day === grant.untilDay) {
      return {
        funding: { ...state.funding, grant: { ...grant, hoursDown: down, status: "met" } },
        entries: [
          {
            text: `Grant condition met: ${down} hours down over its ${grant.untilDay - grant.day} days, within the ${grant.maxHoursDown} allowed. The ${pounds(grant.amount)} is yours to keep.`,
            cashDelta: 0,
            kind: "funding",
          },
        ],
      };
    }
    return { funding: { ...state.funding, grant: { ...grant, hoursDown: down } }, entries: [] };
  }

  return {
    startingShares,
    valuation,
    capTable,
    studentShare,
    funding,
    acceptFunding,
    declineFunding,
    grantDay,
  };
}

export type Shares = ReturnType<typeof createShares>;
