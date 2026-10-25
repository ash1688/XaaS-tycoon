import type { GameConfig } from "./config.ts";
import type { Conversion } from "./conversion.ts";
import { count, pounds, type Finance } from "./finance.ts";
import { loanOwed } from "./loan.ts";
import {
  createNegotiation,
  type CounterOdds,
  type Negotiation,
  type NegotiationRound,
  type TermSpec,
  type Terms,
} from "./negotiation.ts";
import {
  isFunderId,
  SimError,
  type FriendsAndFamilyFunding,
  type DaySpend,
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
  | "falling"
  | "investor"
  | "netCash"
  | "minimum"
  | "liquidation";

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
  /** Income earned over the last averageDays days, ÷ averageDays, × 365. */
  annualRevenue: number;
  /** What annual revenue is multiplied by, after growth, satisfaction and uptime; never below minMultiple. */
  multiple: number;
  /** Growth in average paying users on growthDays before, since the launch ramp ended, as a share (0.5 = 50%). */
  growth: number;
  /** Recent uptime %, as free-to-paid conversion measures it. */
  recentUptime: number;
  /**
   * Revenue first, then growth, satisfaction, uptime, paying users, what holds it down while the company is falling,
   * what an investor's valuation adds (or takes off), net cash and any top-up to the minimum, or for a liquidated
   * company what takes it to nothing.
   */
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

/**
 * What accepting friends and family's offer now would do: worked out at today's share price, or once it's been
 * countered, at the price the offer that stands puts on a share.
 */
export interface FriendsAndFamilyOffer {
  amount: number;
  /** The valuation the shares are priced at: today's, or what the negotiated cash and share make it. */
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
  /**
   * Days played the condition covers, and the first and last of them if accepted today: they start after the launch
   * ramp, so both are null until the company has launched.
   */
  days: number;
  fromDay: number | null;
  untilDay: number | null;
  /** The uptime % asked for on the company's model. */
  minUptime: number;
  /** Hours down allowed over those days in all. */
  maxHoursDown: number;
  /** The condition and what happens if it's broken, in words. */
  condition: string;
  ifMissed: string;
}

/** The grant once answered, with how its condition stands. */
export interface GrantView extends GrantFunding {
  /** The condition's first and last days: null until the company has launched, when they start after its ramp. */
  fromDay: number | null;
  untilDay: number | null;
  /** Days of the condition still to play: 0 once it's over. */
  daysLeft: number;
  /** Hours down still allowed before it's withdrawn: 0 once it's over. */
  hoursLeft: number;
}

/**
 * An open offer's negotiation: the offers so far (just the opening one, today's fixed offer, until the student
 * counters), the rolls between them, and how many counters are left. The last offer stands until it's answered.
 */
export interface NegotiationView {
  offers: Terms[];
  rounds: NegotiationRound[];
  countersLeft: number;
  /** Offer 3 is final: take it or leave it. */
  final: boolean;
  /** The terms it's negotiated on, and the most a counter can ask in all (0.5 = 50%). */
  terms: TermSpec[];
  maxAsk: number;
  /** Pips the roll gets on top, from a CFO and the like: 0 for now. */
  bonus: number;
}

/** Friends and family and the grant: each one's open offer, or how it was answered. */
export interface FundingView {
  /** Friends and family's offer, while it's open; null once answered. */
  friendsAndFamilyOffer: FriendsAndFamilyOffer | null;
  friendsAndFamily: FriendsAndFamilyFunding | null;
  /** The grant's offer, while it's open; null once answered. */
  grantOffer: GrantOffer | null;
  grant: GrantView | null;
  /** Each open offer's negotiation; null once it's answered. */
  negotiations: Record<FunderId, NegotiationView | null>;
  /**
   * The day the first angel was accepted, which closed friends and family and the grant: an offer still open then is
   * gone. Null before. A grant already accepted keeps its condition.
   */
  closedDay: number | null;
}

/** What friends and family's offer is negotiated on: their cash, and their share of the company after (0–1). */
const FF_TERMS: TermSpec[] = [
  { key: "amount", label: "the cash", better: "higher", step: 100 },
  { key: "share", label: "their share", better: "lower", step: 0.001, min: 0.001, max: 0.99 },
];
/** And the grant's: its cash, and the days its uptime condition runs. */
const GRANT_TERMS: TermSpec[] = [
  { key: "amount", label: "the cash", better: "higher", step: 100 },
  { key: "days", label: "the condition's days", better: "lower", step: 1, min: 1 },
];
const TERMS: Record<FunderId, TermSpec[]> = { friendsAndFamily: FF_TERMS, grant: GRANT_TERMS };

const DAYS_PER_YEAR = 365;
const HOURS_PER_DAY = 24;
const NAMES: Record<Shareholder["id"], string> = {
  student: "You",
  friendsAndFamily: "Friends and family",
  angel: "Angel investor",
  vulture: "Vulture VC",
  public: "Public shareholders",
  staffScheme: "Staff share scheme",
};
const FUNDER_NAMES: Record<FunderId, string> = { friendsAndFamily: "Friends and family", grant: "The grant" };
const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;
const round1 = (n: number) => Math.round(n * 10) / 10;
const multipleText = (m: number) => `${m >= 0 ? "+" : "−"}${Math.abs(Math.round(m * 100) / 100)}×`;
/** "Paying users", "Paying users and income", "Paying users, income and satisfaction". */
const sentence = (things: string[]) => {
  const text = things.length > 1 ? `${things.slice(0, -1).join(", ")} and ${things.at(-1)}` : (things[0] ?? "");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * Shares, valuation, the cap table, and the funders on the Finance page from day 1: friends and family, who buy new
 * shares at the share price, and the grant, which gives cash with an uptime condition and takes no shares.
 */
export function createShares(config: GameConfig, finance: Finance, conversion: Conversion) {
  const v = config.valuation;
  const f = config.funding;
  const uptimeDays = Math.max(1, config.conversion.uptimeDays);
  const negotiator = createNegotiation(config.negotiation);

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
    return {
      shareholders: [{ id: "student", shares, day: 1 }],
      funding: { friendsAndFamily: null, grant: null, negotiating: { friendsAndFamily: null, grant: null } },
    };
  }

  const sharesInIssue = (state: GameState) => state.shareholders.reduce((sum, h) => sum + h.shares, 0);

  // The launch ramp's users arriving aren't growth: it's measured from the end of the ramp at the earliest.
  const rampDays = config.launch.rampShares.some((x) => x > 0) ? config.launch.rampShares.length : 1;

  /** The days played from `from` to `to`, both included. */
  const daysBetween = (state: GameState, from: number, to: number) =>
    state.spendByDay.filter((d) => d.day >= from && d.day <= to);
  const mean = (days: DaySpend[], value: (d: DaySpend) => number) =>
    days.reduce((sum, d) => sum + value(d), 0) / days.length;

  /** Income earned over the last `days` days, ÷ days: days before launch count as nothing. */
  const incomeOver = (state: GameState, days: number) =>
    daysBetween(state, state.day - days + 1, state.day).reduce((sum, d) => sum + d.income, 0) / days;

  /**
   * Income actually earned a day, from paying users and any paid API: over the last averageDays days, or the last
   * fallDays if that's lower. So a new company's revenue builds up over its first weeks and a rise counts slowly, but
   * income lost shows within days. Not today's price: a price change only moves it as the income it brings comes in.
   */
  const averageIncome = (state: GameState) =>
    Math.min(incomeOver(state, v.averageDays), incomeOver(state, Math.max(1, v.fallDays)));

  /**
   * Over the last averageDays days played: paying users averaged, or today's if fewer, so a rush of payers counts
   * slowly but losing them counts at once; satisfaction averaged; and what a paying user paid a month on average,
   * from income earned ÷ paying-user days (none before any income). Today's figures before any day's played.
   */
  function recent(state: GameState): { paidUsers: number; satisfaction: number; monthlyPerUser: number | null } {
    const days = daysBetween(state, state.day - v.averageDays + 1, state.day);
    if (!days.length) return { paidUsers: state.paidUsers, satisfaction: state.satisfaction, monthlyPerUser: null };
    const userDays = days.reduce((sum, d) => sum + d.paidUsers, 0);
    const income = days.reduce((sum, d) => sum + d.income, 0);
    return {
      paidUsers: Math.min(state.paidUsers, userDays / days.length),
      satisfaction: mean(days, (d) => d.satisfaction),
      // None before any income has come in, as on launch day: then they count in full.
      monthlyPerUser: userDays > 0 && income > 0 ? (income / userDays) * config.billing.daysPerMonth : null,
    };
  }

  /**
   * Growth in paying users: their average over the last averageDays days against their average over the averageDays
   * days to growthDays ago. Only days after the end of the launch ramp count, and growth is scaled by the share of
   * those earlier days that do, so it builds up from nothing over the weeks after launch rather than counting the
   * launch rush. A rise only counts above the best the company had done by then (its highest averageDays average of
   * paying users, from the end of the ramp to growthDays ago), so winning back users lost in a crash isn't growth; a
   * fall counts from the average then.
   */
  function growthIn(state: GameState): number {
    if (state.launchDay === null) return 0;
    const rampEnd = state.launchDay + rampDays - 1;
    const now = daysBetween(state, Math.max(rampEnd, state.day - v.averageDays + 1), state.day);
    const thenTo = state.day - v.growthDays;
    const then = daysBetween(state, Math.max(rampEnd, thenTo - v.averageDays + 1), thenTo);
    if (!now.length || !then.length) return 0;
    const before = mean(then, (d) => d.paidUsers);
    const share = Math.min(1, then.length / v.averageDays);
    const users = mean(now, (d) => d.paidUsers);
    if (users <= before) return (share * (users - before)) / Math.max(before, v.growthBaseUsers);
    const best = bestAverageUsers(daysBetween(state, rampEnd, thenTo));
    return (share * Math.max(0, users - best)) / Math.max(best, v.growthBaseUsers);
  }

  /** The highest average of paying users over averageDays days played (fewer at the start) ending on any of `days`. */
  function bestAverageUsers(days: DaySpend[]): number {
    let best = 0;
    let sum = 0;
    for (let i = 0; i < days.length; i++) {
      sum += days[i]!.paidUsers;
      if (i >= v.averageDays) sum -= days[i - v.averageDays]!.paidUsers;
      best = Math.max(best, sum / Math.min(i + 1, v.averageDays));
    }
    return best;
  }

  /** The business's part of the valuation on the state's day: revenue at its multiple, and the paying users. */
  function business(state: GameState) {
    const annualRevenue = Math.round(averageIncome(state) * DAYS_PER_YEAR);
    const { paidUsers, satisfaction, monthlyPerUser } = recent(state);
    const growth = growthIn(state);
    const growthM = Math.min(v.maxGrowthMultiple, Math.max(-v.maxGrowthPenalty, v.growthMultiple * growth));
    const satisfactionM =
      satisfaction < v.goodSatisfaction
        ? (-v.satisfactionPenalty * (v.goodSatisfaction - satisfaction)) / Math.max(1, v.goodSatisfaction)
        : 0;
    const recentUptime = conversion.recentUptime(state);
    const uptimeM =
      recentUptime < v.goodUptime ? -Math.min(v.maxUptimePenalty, v.uptimePenaltyPerPoint * (v.goodUptime - recentUptime)) : 0;
    const raw = v.revenueMultiple + growthM + satisfactionM + uptimeM;
    const multiple = Math.max(v.minMultiple, raw);
    const part = (m: number) => Math.round(annualRevenue * m);

    const drivers: ValuationDriver[] = [
      {
        id: "revenue",
        label: "Revenue",
        amount: part(v.revenueMultiple),
        detail: `${pounds(annualRevenue)} a year, from income earned by users and any API over the last ${v.averageDays} days (or the last ${v.fallDays}, if lower), × ${v.revenueMultiple}`,
      },
      {
        id: "growth",
        label: "Growth",
        amount: part(growthM),
        detail: `Paying users over the last ${v.averageDays} days ${growth >= 0 ? "up" : "down"} ${percent(Math.abs(growth))} on the ${v.averageDays} days to ${v.growthDays} days ago (counting from the end of the launch, and a rise only above the best ${v.averageDays} days before then): ${multipleText(growthM)} revenue`,
      },
      {
        id: "satisfaction",
        label: "Satisfaction",
        amount: part(satisfactionM),
        detail: satisfactionM
          ? `${Math.round(satisfaction)}% over ${v.averageDays} days, below ${v.goodSatisfaction}%: ${multipleText(satisfactionM)} revenue`
          : `${Math.round(satisfaction)}% over ${v.averageDays} days: no effect at ${v.goodSatisfaction}% or more`,
      },
      {
        id: "uptime",
        label: "Uptime",
        amount: part(uptimeM),
        detail: uptimeM
          ? `${round1(recentUptime)}% over the last ${uptimeDays} days, below ${v.goodUptime}%: ${multipleText(uptimeM)} revenue`
          : `${round1(recentUptime)}% over the last ${uptimeDays} days: no effect at ${v.goodUptime}% or more`,
      },
    ];
    // Revenue always counts for at least the lowest multiple, however badly the rest is going.
    if (raw < v.minMultiple) {
      drivers.push({
        id: "multipleFloor",
        label: "Multiple floor",
        amount: part(v.minMultiple) - drivers.reduce((sum, d) => sum + d.amount, 0),
        detail: `Revenue always counts at least ${v.minMultiple} times over`,
      });
    }
    // A paying user is worth less for paying less than the fair price, so a give-away price can't inflate it either.
    const users = Math.round(paidUsers);
    // On the payments app, what a usual month costs a business at the fair fee and rate.
    const { pricing: fairPricing, transactions: tx } = config.productTypes[state.productType];
    const fair = fairPricing.fairPrice + (tx ? tx.fairRate * tx.volumePerPaidUser : 0);
    const perUser = v.valuePerPayingUser * Math.min(1, monthlyPerUser === null ? 1 : monthlyPerUser / fair);
    drivers.push({
      id: "payingUsers",
      label: "Paying users",
      amount: Math.round(users * perUser),
      detail:
        perUser < v.valuePerPayingUser
          ? `${count.format(users)} lately × ${pounds(perUser)}: ${pounds(v.valuePerPayingUser)} each at the fair price of ${pounds(fair)} a month, but they paid ${pounds(monthlyPerUser!)}`
          : `${count.format(users)} lately × ${pounds(perUser)}`,
    });
    return { annualRevenue, multiple, growth, recentUptime, drivers, value: drivers.reduce((sum, d) => sum + d.amount, 0) };
  }

  /** The state as it was at the end of the day of `spendByDay`'s last record, as far as business() needs it. */
  function asOf(state: GameState, spendByDay: DaySpend[]): GameState {
    const last = spendByDay.at(-1)!;
    return {
      ...state,
      day: last.day,
      spendByDay,
      paidUsers: last.paidUsers,
      satisfaction: last.satisfaction,
      recentHoursDown: spendByDay.slice(-uptimeDays).map((d) => d.hoursDown),
    };
  }

  /**
   * What's falling on `day`: income averaged over the last fallDays days below the fallDays before; paying users so,
   * or the day's below their average over the fallDays before, so a sudden crash counts at once; or the day's
   * satisfaction below goodSatisfaction and below its average over the fallDays before. Nothing until there are two
   * whole periods to compare.
   */
  function fallingOn(state: GameState, day: number): string[] {
    const f = Math.max(1, v.fallDays);
    const now = daysBetween(state, day - f + 1, day);
    const before = daysBetween(state, day - 2 * f + 1, day - f);
    if (now.length < f || before.length < f) return [];
    const down = (value: (d: DaySpend) => number) => mean(now, value) < mean(before, value);
    const falling: string[] = [];
    const today = now.at(-1)!;
    const lastWeek = daysBetween(state, day - f, day - 1);
    if (down((d) => d.paidUsers) || today.paidUsers < mean(lastWeek, (d) => d.paidUsers)) falling.push("paying users");
    if (down((d) => d.income)) falling.push("income");
    const satisfaction = today.satisfaction;
    if (satisfaction < v.goodSatisfaction && satisfaction < mean(lastWeek, (d) => d.satisfaction)) falling.push("satisfaction");
    return falling;
  }

  /** The business's worth at the end of a day, and what it was held to. */
  interface Held {
    worth: number;
    held: number;
  }

  // Each day played's Held, by that day's record. A game's records carry over from one day's state to the next, so
  // each day's is worked out once.
  const heldOn = new WeakMap<DaySpend, Held>();

  /**
   * The business's worth, held. On a day with anything falling it's at most the day before's. On a day with nothing
   * falling it gains whatever the worth gained since the day before, and closes 1/fallDays of any gap left below the
   * worth by days that were. So the averages catching up with a rise, or winning back what a crash lost, can't lift it
   * while the company is getting worse, and once it stops it catches up over about fallDays days rather than at once.
   */
  function held(worth: number, falling: boolean, before: Held | null): number {
    if (before === null) return worth;
    if (falling) return Math.min(worth, before.held);
    const gained = Math.max(0, worth - before.worth);
    return Math.min(worth, before.held + gained + (before.worth - before.held) / Math.max(1, v.fallDays));
  }

  /** The Held at the end of the last day played before today, or null before any. */
  function heldBefore(state: GameState): Held | null {
    const days = state.spendByDay;
    let i = days.length - 1;
    while (i >= 0 && days[i]!.day >= state.day) i--;
    if (i < 0) return null;
    // Back to the last day already worked out, then forward from there.
    let from = i;
    while (from >= 0 && !heldOn.has(days[from]!)) from--;
    let before = from >= 0 ? heldOn.get(days[from]!)! : null;
    for (let j = from + 1; j <= i; j++) {
      const upTo = days.slice(0, j + 1);
      const worth = business(asOf(state, upTo)).value;
      before = { worth, held: held(worth, fallingOn(state, days[j]!.day).length > 0, before) };
      heldOn.set(days[j]!, before);
    }
    return before;
  }

  /** The business today, held while anything's falling: the formula's valuation less net cash, before the minimum. */
  function heldBusiness(state: GameState) {
    const today = business(state);
    const falling = fallingOn(state, state.day);
    return { ...today, falling, heldWorth: Math.round(held(today.value, falling.length > 0, heldBefore(state))) };
  }

  /**
   * The formula's business today, before any investor's valuation: what an investor's offer values at a multiple. At
   * least £1, so a multiple of it always means something.
   */
  const businessWorth = (state: GameState) => Math.max(1, heldBusiness(state).heldWorth);

  function valuation(state: GameState): ValuationView {
    const { annualRevenue, multiple, growth, recentUptime, drivers, value: worth, falling, heldWorth } = heldBusiness(state);
    if (heldWorth < worth) {
      drivers.push({
        id: "falling",
        label: falling.length ? "Falling" : "Catching up",
        amount: heldWorth - worth,
        detail: falling.length
          ? `${sentence(falling)} down on the ${v.fallDays} days before: while anything's falling the business can't gain value`
          : `Nothing's falling now, so the business is catching up on what it couldn't gain while it was, over about ${v.fallDays} days`,
      });
    }
    // From the first investor after friends and family, the business is worth their multiple of the formula's: it
    // moves in step with it. Cash still counts at face value.
    const set = state.investors.valuation;
    if (set) {
      drivers.push({
        id: "investor",
        label: "Investor's valuation",
        amount: Math.round((set.multiple - 1) * heldWorth),
        detail: `${set.investor}, your angel, valued the business at ${Math.round(set.multiple * 100) / 100}× the formula's on day ${set.day}: it moves in step with the formula from then on`,
      });
    }
    // Cash counts, less what's still owed on a loan: a company is worth at least what's in the bank.
    const owed = loanOwed(state.loan);
    drivers.push({
      id: "netCash",
      label: "Net cash",
      amount: Math.round(state.cash - owed),
      detail: owed ? `${pounds(state.cash)} cash, less ${pounds(owed)} of the loan still to pay back` : `${pounds(state.cash)} cash`,
    });
    const formula = drivers.reduce((sum, d) => sum + d.amount, 0);
    // A liquidated company is worth nothing: the minimum is for one still trading, so wrecking it can't score.
    if (state.status === "liquidated") {
      drivers.push({ id: "liquidation", label: "Liquidation", amount: -formula, detail: "A company in liquidation is worth nothing" });
    } else if (formula < v.minimum) {
      drivers.push({
        id: "minimum",
        label: "Minimum",
        amount: v.minimum - formula,
        detail: `A company is never valued below ${pounds(v.minimum)}`,
      });
    }
    const value = state.status === "liquidated" ? 0 : Math.max(v.minimum, formula);
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
    // After the IPO the market prices the company: shares are worth the close of the first day of trading.
    const floated = state.ipo.result;
    const formula = valuation(state);
    const { sharesInIssue: shares } = formula;
    const value = floated ? floated.marketValue : formula.valuation;
    const sharePrice = floated ? floated.closePrice : formula.sharePrice;
    return {
      sharesInIssue: shares,
      sharePrice,
      rows: state.shareholders.map((h) => ({
        id: h.id,
        name: h.id === "angel" && state.investors.angel ? `${state.investors.angel.investor} (angel)` : NAMES[h.id],
        shares: h.shares,
        share: h.shares / shares,
        value: Math.round((value * h.shares) / shares),
      })),
    };
  }

  /** The student's share of the company, 0–1. */
  const studentShare = (state: GameState) =>
    (state.shareholders.find((h) => h.id === "student")?.shares ?? 0) / sharesInIssue(state);

  /** Friends and family and the grant close once the first angel is accepted. */
  const closed = (state: GameState) => state.investors.angel !== null;

  function friendsAndFamilyOffer(state: GameState): FriendsAndFamilyOffer | null {
    if (state.funding.friendsAndFamily || closed(state)) return null;
    const shares = sharesInIssue(state);
    const negotiating = state.funding.negotiating.friendsAndFamily;
    let amount: number, newShares: number, value: number, sharePrice: number;
    if (negotiating) {
      // The share they'd own after is what's been negotiated, so the new shares are share ÷ (1 − share) of those now.
      // It was agreed against what the company was worth then: if it's worth less now, so its opening offer would
      // buy a bigger share, theirs rises in step, so terms struck before a fall can't sell a sinking company dear.
      const terms = negotiator.latest(negotiating);
      amount = terms.amount!;
      const opening = negotiating.offers[0]!.share!;
      const openingNow = f.friendsAndFamily.amount / (valuation(state).valuation + f.friendsAndFamily.amount);
      const share = Math.max(terms.share!, (terms.share! * openingNow) / opening);
      newShares = Math.max(1, Math.round((share * shares) / (1 - share)));
      sharePrice = amount / newShares;
      value = Math.round(sharePrice * shares);
    } else {
      ({ valuation: value, sharePrice } = valuation(state));
      amount = f.friendsAndFamily.amount;
      // New shares at the share price: their share of the company after is amount ÷ (valuation + amount).
      newShares = Math.round((amount * shares) / value);
    }
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

  /**
   * The grant condition's first and last days, for a grant answered on `day`: from the day after it, or the first day
   * after the launch ramp if that's later. Null until the company has launched, as it can't be known before.
   */
  function grantDays(state: GameState, day: number, days: number): { fromDay: number; untilDay: number } | null {
    if (state.launchDay === null) return null;
    const fromDay = Math.max(day + 1, state.launchDay + rampDays);
    return { fromDay, untilDay: fromDay + days - 1 };
  }

  function grantOffer(state: GameState): GrantOffer | null {
    if (state.funding.grant || closed(state)) return null;
    const negotiating = state.funding.negotiating.grant;
    const { amount, days } = negotiating ? (negotiator.latest(negotiating) as { amount: number; days: number }) : f.grant;
    const minUptime = f.grant.minUptime[state.model];
    const maxHoursDown = round1(((100 - minUptime) / 100) * HOURS_PER_DAY * days);
    const window = grantDays(state, state.day, days);
    const launching = state.launchDay === null || state.day < state.launchDay + rampDays - 1;
    const when = launching ? "once your launch is over" : "after you accept it";
    return {
      amount,
      days,
      fromDay: window?.fromDay ?? null,
      untilDay: window?.untilDay ?? null,
      minUptime,
      maxHoursDown,
      condition: `Keep uptime at ${minUptime}% or more for the ${days} days ${when}: at most ${maxHoursDown} hours down in all.`,
      ifMissed: `Go over and the grant is withdrawn: all ${pounds(amount)} is paid back at once, which can run the company out of cash.`,
    };
  }

  function grantView(state: GameState): GrantView | null {
    const grant = state.funding.grant;
    if (!grant) return null;
    const window = grantDays(state, grant.day, grant.days);
    const running = grant.status === "accepted";
    const daysLeft = !running ? 0 : window ? Math.min(grant.days, Math.max(0, window.untilDay - state.day)) : grant.days;
    return {
      ...grant,
      fromDay: window?.fromDay ?? null,
      untilDay: window?.untilDay ?? null,
      daysLeft,
      hoursLeft: running ? round1(Math.max(0, grant.maxHoursDown - grant.hoursDown)) : 0,
    };
  }

  /** The terms an open offer stands at, as negotiation sees them. */
  function openTerms(state: GameState, funder: FunderId): Terms {
    if (funder === "friendsAndFamily") {
      const offer = friendsAndFamilyOffer(state)!;
      return { amount: offer.amount, share: offer.theirShare };
    }
    const offer = grantOffer(state)!;
    return { amount: offer.amount, days: offer.days };
  }

  /** The negotiation an open offer is in: its rounds so far, or just the opening offer if it hasn't been countered. */
  const negotiationOf = (state: GameState, funder: FunderId): Negotiation =>
    state.funding.negotiating[funder] ?? negotiator.open(openTerms(state, funder));

  /** Pips on top of every negotiation roll. None yet: a CFO will add some. */
  const rollBonus = (_state: GameState) => 0;

  function negotiationView(state: GameState, funder: FunderId): NegotiationView | null {
    if (state.funding[funder] || closed(state)) return null;
    const n = negotiationOf(state, funder);
    return {
      offers: n.offers,
      rounds: n.rounds,
      countersLeft: negotiator.countersLeft(n),
      final: negotiator.isFinal(n),
      terms: TERMS[funder],
      maxAsk: config.negotiation.maxAsk,
      bonus: rollBonus(state),
    };
  }

  function funding(state: GameState): FundingView {
    return {
      friendsAndFamilyOffer: friendsAndFamilyOffer(state),
      friendsAndFamily: state.funding.friendsAndFamily,
      grantOffer: grantOffer(state),
      grant: grantView(state),
      negotiations: {
        friendsAndFamily: negotiationView(state, "friendsAndFamily"),
        grant: negotiationView(state, "grant"),
      },
      closedDay: state.investors.angel?.day ?? null,
    };
  }

  /** Only the funder's own terms can be countered: friends and family's cash and share, the grant's cash and days. */
  function checkTerms(funder: FunderId, terms: Partial<Terms>) {
    const known = TERMS[funder].map((t) => t.key);
    if (typeof terms !== "object" || terms === null || Object.keys(terms).some((k) => !known.includes(k))) {
      throw new SimError("bad_counter", `${FUNDER_NAMES[funder]}'s offer is negotiated on ${known.join(" and ")}.`);
    }
  }

  /** What countering a funder's offer with `terms` would do: the odds on the roll, and the offer each roll brings. */
  function counterOdds(state: GameState, funder: string, terms: Partial<Terms>): CounterOdds {
    checkOpen(state, funder);
    checkTerms(funder, terms);
    return negotiator.odds(negotiationOf(state, funder), terms, TERMS[funder], rollBonus(state));
  }

  /**
   * Counters a funder's open offer between days: a roll on the negotiation RNG sets their next offer, which stands
   * until it's answered. Two counters at most; the third offer is final.
   */
  function counterFunding(state: GameState, funder: string, terms: Partial<Terms>): GameState {
    checkOpen(state, funder);
    checkTerms(funder, terms);
    const n = negotiationOf(state, funder);
    const done = negotiator.counter(n, terms, TERMS[funder], state.negotiationRng, rollBonus(state));
    return {
      ...state,
      negotiationRng: done.rng,
      funding: { ...state.funding, negotiating: { ...state.funding.negotiating, [funder]: done.negotiation } },
    };
  }

  /** The funding once a funder is answered: its negotiation is over. */
  const answered = (state: GameState, funder: FunderId, funding: Partial<Funding>): Funding => ({
    ...state.funding,
    ...funding,
    negotiating: { ...state.funding.negotiating, [funder]: null },
  });

  function checkOpen(state: GameState, funder: string): asserts funder is FunderId {
    if (!isFunderId(funder)) throw new SimError("unknown_funder", "Pick friends and family or the grant.");
    const answered = state.funding[funder];
    if (answered) {
      throw new SimError(
        "funding_answered",
        `${FUNDER_NAMES[funder]}'s offer can only be taken once, and you ${answered.status === "declined" ? "declined" : "accepted"} it on day ${answered.day}.`,
      );
    }
    if (closed(state)) {
      throw new SimError(
        "funding_closed",
        `${FUNDER_NAMES[funder]}'s offer closed when you took on your angel investor on day ${state.investors.angel!.day}.`,
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
        funding: answered(state, funder, {
          friendsAndFamily: {
            status: "accepted",
            day: state.day,
            amount: offer.amount,
            shares: offer.newShares,
            valuation: offer.valuation,
          },
        }),
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
      funding: answered(state, funder, {
        grant: {
          status: "accepted",
          day: state.day,
          amount: offer.amount,
          days: offer.days,
          minUptime: offer.minUptime,
          maxHoursDown: offer.maxHoursDown,
          hoursDown: 0,
        },
      }),
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
            const { amount, days, minUptime, maxHoursDown } = offer;
            return { status: "declined" as const, day: state.day, amount, days, minUptime, maxHoursDown, hoursDown: 0 };
          })();
    return { ...state, funding: answered(state, funder, { [funder]: declined }) };
  }

  /**
   * The grant's condition on a day played: its hours down count while it runs. Going over the hours allowed withdraws
   * it, paying it all back that day; reaching its last day within them meets it.
   */
  function grantDay(state: GameState, day: number, hoursDown: number): { funding: Funding; entries: LogEntry[] } {
    const grant = state.funding.grant;
    const window = grant && grantDays(state, grant.day, grant.days);
    if (!grant || grant.status !== "accepted" || !window || day < window.fromDay || day > window.untilDay) {
      return { funding: state.funding, entries: [] };
    }
    const down = round1(grant.hoursDown + hoursDown);
    if (down > grant.maxHoursDown) {
      return {
        funding: { ...state.funding, grant: { ...grant, hoursDown: down, status: "withdrawn" } },
        entries: [
          {
            text: `Grant withdrawn: ${down} hours down since its condition started on day ${window.fromDay}, over the ${grant.maxHoursDown} its ${grant.minUptime}% uptime condition allows. All ${pounds(grant.amount)} is paid back.`,
            cashDelta: -grant.amount,
            kind: "funding",
          },
        ],
      };
    }
    if (day === window.untilDay) {
      return {
        funding: { ...state.funding, grant: { ...grant, hoursDown: down, status: "met" } },
        entries: [
          {
            text: `Grant condition met: ${down} hours down over its ${grant.days} days, within the ${grant.maxHoursDown} allowed. The ${pounds(grant.amount)} is yours to keep.`,
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
    businessWorth,
    sharesInIssue,
    rollBonus,
    capTable,
    studentShare,
    funding,
    acceptFunding,
    declineFunding,
    counterFunding,
    counterOdds,
    grantDay,
  };
}

export type Shares = ReturnType<typeof createShares>;
