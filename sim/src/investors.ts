import type { GameConfig } from "./config.ts";
import { count, pounds, type Finance } from "./finance.ts";
import { loanOwed } from "./loan.ts";
import { createNegotiation, type CounterOdds, type TermSpec, type Terms } from "./negotiation.ts";
import { nextRandom } from "./rng.ts";
import type { NegotiationView, Shares } from "./shares.ts";
import {
  SimError,
  type AngelDeal,
  type AngelTarget,
  type Approach,
  type GameState,
  type InvestorValuation,
  type Investors,
  type LogEntry,
  type RoundId,
} from "./state.ts";

/**
 * What accepting the open approach's offer now would do: the cash, their share and yours, the valuation their terms
 * put on the company, and the target that comes with it, all before accepting.
 */
export interface InvestorOffer {
  round: RoundId;
  investor: string;
  /** The day they approached, and the last day played it stands for: unanswered by the end of it, it lapses. */
  day: number;
  lastDay: number;
  /** Days played before it lapses: 1 means it lapses at the end of the next day played. */
  daysLeft: number;
  amount: number;
  /**
   * Their share of the company after, 0–1: as offered, or more if the business is worth less now than when they
   * approached, as their terms value it at a multiple of what it was worth then.
   */
  theirShare: number;
  /** The valuation their terms put on the company before their cash, and after it. */
  preMoney: number;
  valuation: number;
  /** Their valuation of the business, as a multiple of the formula's. */
  multiple: number;
  /** Today's valuation, for comparison. */
  formulaValuation: number;
  sharePrice: number;
  newShares: number;
  sharesInIssue: number;
  sharesAfter: number;
  yourShareBefore: number;
  yourShareAfter: number;
  /** Their target if accepted today: income and paying users gained, both by byDay. */
  target: AngelTarget;
  /** The target and what happens if it's missed, in words; then what else accepting does. */
  condition: string;
  ifMissed: string;
  effects: string[];
}

/** The angel's deal once accepted, with how its target stands. */
export interface AngelView extends AngelDeal {
  /** Income averaged over the target's days, today. */
  dailyRevenue: number;
  /** Paying users gained since accepting, as the target measures it: their average over the last week, less the start. */
  usersGained: number;
  /** Days left to hit the target: 0 once it's met or missed. */
  daysLeft: number;
}

/** The funding ladder: the approach open now and its negotiation, the angel's deal, and the valuation it set. */
export interface InvestorsView {
  offer: InvestorOffer | null;
  negotiation: NegotiationView | null;
  angel: AngelView | null;
  /** Investors turned down so far, oldest first. */
  declined: Investors["declined"];
  /** After a decline, until the next investor approaches: one will, in a few days. */
  anotherComing: boolean;
  valuation: InvestorValuation | null;
}

/** What an investor's offer is negotiated on: their cash, and their share of the company after (0–1). */
const INVESTOR_TERMS: TermSpec[] = [
  { key: "amount", label: "the cash", better: "higher", step: 100 },
  { key: "share", label: "their share", better: "lower", step: 0.001, min: 0.001, max: 0.99 },
];

/** Angels' names, drawn as they approach. */
const ANGEL_NAMES = [
  "Priya Shah",
  "Tom Okafor",
  "Grace Lindqvist",
  "Marcus Bell",
  "Aisha Rahman",
  "Owen Price",
  "Mei Chen",
  "Daniel Novak",
  "Fatima Haddad",
  "Liam Gallagher",
  "Sofia Moreau",
  "Ravi Patel",
  "Hannah Kowalski",
  "Kwame Mensah",
  "Ellie Fraser",
  "Jonas Weber",
];

const ROUND_NAMES: Record<RoundId, string> = { angel: "angel investor" };
const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;
const roundTo = (n: number, step: number) => Math.round(n / step) * step;
/** Days paying users are averaged over for users gained, so a sudden rush (or loss) counts slowly. */
const USERS_AVERAGE_DAYS = 7;
/** The most of the company an offer can come to, however far the business falls. */
const MAX_SHARE = 0.9;

/**
 * The funding ladder's investors, who approach the student: the angel now. A rung's hidden target, once hit, brings an
 * investor approachDays later with an offer of cash for a share, which the student negotiates, accepts or declines;
 * declining brings another retryDays later. See InvestorsConfig. Series A–D will add rungs here, with the same
 * approach, offer and negotiation.
 */
export function createInvestors(config: GameConfig, finance: Finance, shares: Shares) {
  const c = config.investors;
  const angel = c.angel;
  const negotiator = createNegotiation(config.negotiation);

  const startingInvestors = (): Investors => ({ nextApproachDay: null, approach: null, declined: [], angel: null, valuation: null });

  const netCash = (state: GameState) => state.cash - loanOwed(state.loan);

  /** Income earned a day over the last `days` days, ÷ days. */
  const incomeOver = (state: GameState, days: number) =>
    state.spendByDay.filter((d) => d.day > state.day - days && d.day <= state.day).reduce((sum, d) => sum + d.income, 0) / days;

  /** The angel's hidden target: income averaged over its days, every one of them after the launch, reaching its figure. */
  const angelTargetHit = (state: GameState) =>
    state.launchDay !== null && state.day - state.launchDay >= angel.target.days && incomeOver(state, angel.target.days) >= angel.target.dailyRevenue;

  /**
   * Too late in the game for an angel: fewer days left than their target runs for, so it couldn't run its course. None
   * approaches then, so a target can't be squeezed into the last days and met with a final flourish.
   */
  const tooLate = (state: GameState) => state.finalDay !== null && state.day + angel.targetDays > state.finalDay;

  /** An investor approaches: their opening offer values the business at a premium over the formula's. */
  function approach(state: GameState, round: RoundId): { state: GameState; entries: LogEntry[] } {
    let rng = state.investorRng;
    const draw = () => {
      const [r, next] = nextRandom(rng);
      rng = next;
      return r;
    };
    // A new name each time, unless every one has been turned down.
    const used = new Set(state.investors.declined.map((d) => d.investor));
    const names = ANGEL_NAMES.filter((n) => !used.has(n));
    const pool = names.length ? names : ANGEL_NAMES;
    const investor = pool[Math.floor(draw() * pool.length)]!;
    // Word gets round: each angel turned down makes the next less generous, so declining for a better roll doesn't pay.
    const declines = state.investors.declined.filter((d) => d.round === round).length;
    const premiumMax = Math.max(angel.premium.min, angel.premium.max - declines * angel.declinePremium);
    const shareMin = Math.min(angel.share.max, angel.share.min + declines * angel.declineShare);
    const premium = Math.round((angel.premium.min + draw() * (premiumMax - angel.premium.min)) * 100) / 100;
    const asked = roundTo(shareMin + draw() * (angel.share.max - shareMin), 0.005);

    const business = shares.businessWorth(state);
    const cash = netCash(state);
    // Cash counts at face value; a loan still owed can't take what they think it's worth below a quarter of the business.
    const preMoney = Math.max(premium * business + cash, 0.25 * premium * business);
    // Medium money: from minAmount to maxAmount, a smaller share for a company worth more than that buys.
    const amount = Math.min(angel.maxAmount, Math.max(angel.minAmount, roundTo((asked * preMoney) / (1 - asked), 500)));
    const share = amount / (preMoney + amount);
    const opening: Terms = { amount, share };
    const record: Approach = { round, investor, day: state.day, business, netCash: cash, negotiation: negotiator.open(opening) };
    const entries: LogEntry[] = [
      {
        text: `An ${ROUND_NAMES[round]}, ${investor}, likes what ${state.companyName} is doing and wants to invest: ${pounds(amount)} for ${percent(share)} of the company. Their offer is on Finance: negotiate, accept or decline.`,
        cashDelta: 0,
        kind: "funding",
      },
    ];
    return {
      state: { ...state, investorRng: rng, investors: { ...state.investors, approach: record, nextApproachDay: null } },
      entries,
    };
  }

  /**
   * The offer that stands, priced today. Their terms value the business at a multiple of what it was worth when they
   * approached, and net cash at face value, as it is now. The multiple holds, so if the business is worth less now
   * their share rises in step, and an offer can't be held open while the company sinks to sell it dear; a business
   * worth more gets the terms agreed. Cash raised or spent since moves it pound for pound.
   */
  function priced(state: GameState, a: Approach) {
    const terms = negotiator.latest(a.negotiation);
    const amount = terms.amount!;
    const agreed = amount / terms.share! - amount;
    const multiple = (agreed - a.netCash) / a.business;
    const business = shares.businessWorth(state);
    const cash = netCash(state);
    const preMoney = Math.max(amount * ((1 - MAX_SHARE) / MAX_SHARE), multiple * Math.min(a.business, business) + cash);
    return {
      amount,
      preMoney,
      share: amount / (preMoney + amount),
      // What the business is worth to them today, as a multiple of the formula's: what accepting sets the valuation to.
      multiple: Math.min(multiple, (preMoney - cash) / business),
    };
  }

  /** Paying users gained a day lately: over the last target.days days played, none if they fell. */
  function usersPace(state: GameState): number {
    const then = state.spendByDay.filter((d) => d.day <= state.day - angel.target.days).at(-1);
    return Math.max(0, (state.paidUsers - (then?.paidUsers ?? 0)) / angel.target.days);
  }

  /**
   * The angel's target if their offer were accepted today: income at targetGrowth × today's, and paying users gained
   * at the company's recent pace, so it suits a small company and a big one alike. It's due by the game's last day at
   * the latest, and then asks for growth in step with the days left.
   */
  function angelTarget(state: GameState): AngelTarget {
    const now = Math.max(angel.target.dailyRevenue, incomeOver(state, angel.target.days));
    const byDay = Math.min(state.day + angel.targetDays, state.finalDay ?? Infinity);
    const share = (byDay - state.day) / angel.targetDays;
    const growth = 1 + (angel.targetGrowth - 1) * share;
    const users = Math.max(angel.minUsersGained, angel.usersPace * usersPace(state) * angel.targetDays) * share;
    return {
      dailyRevenue: Math.ceil((growth * now) / 50) * 50,
      days: angel.target.days,
      usersGained: Math.ceil(users / 10) * 10,
      byDay,
    };
  }

  /** Paying users gained since the deal: their average over the days played since (the last week at most), less the start. */
  function usersGained(state: GameState, deal: AngelDeal): number {
    const since = state.spendByDay.filter((d) => d.day > deal.day).slice(-USERS_AVERAGE_DAYS);
    if (!since.length) return 0;
    return Math.round(since.reduce((sum, d) => sum + d.paidUsers, 0) / since.length - deal.paidUsersAtStart);
  }

  function offer(state: GameState): InvestorOffer | null {
    const a = state.investors.approach;
    if (!a) return null;
    const { amount, preMoney, share, multiple } = priced(state, a);
    const inIssue = shares.sharesInIssue(state);
    const newShares = Math.max(1, Math.round((share * inIssue) / (1 - share)));
    const sharesAfter = inIssue + newShares;
    const yours = state.shareholders.find((h) => h.id === "student")?.shares ?? 0;
    const target = angelTarget(state);
    const funding = shares.funding(state);
    const closing = [funding.friendsAndFamilyOffer && "friends and family's offer", funding.grantOffer && "the grant's offer"].filter(Boolean);
    return {
      round: a.round,
      investor: a.investor,
      day: a.day,
      lastDay: a.day + c.offerDays,
      daysLeft: a.day + c.offerDays - state.day,
      amount,
      theirShare: newShares / sharesAfter,
      preMoney: Math.round(preMoney),
      valuation: Math.round(preMoney + amount),
      multiple: Math.round(multiple * 100) / 100,
      formulaValuation: shares.valuation(state).valuation,
      sharePrice: amount / newShares,
      newShares,
      sharesInIssue: inIssue,
      sharesAfter,
      yourShareBefore: yours / inIssue,
      yourShareAfter: yours / sharesAfter,
      target,
      condition: `By day ${target.byDay} (${target.byDay - state.day} days after you accept${target.byDay - state.day < angel.targetDays ? ", the game's last day" : ""}), both at once: grow income to ${pounds(target.dailyRevenue)} a day, averaged over ${target.days} day${target.days === 1 ? "" : "s"}, and gain ${count.format(target.usersGained)} paying users from the day you accept, averaged over a week and net of any you lose.`,
      ifMissed: `Miss either and ${a.investor} takes extra equity: new shares raise their share of the company by ${Math.round(angel.missShare * 100)} points, diluting you.`,
      effects: [
        `The company's valuation becomes theirs, ${pounds(Math.round(preMoney + amount))} with their cash, and moves in step with the formula from then on.`,
        closing.length
          ? `Friends and family and grants close for good: ${closing.join(" and ")} will be gone.`
          : "Friends and family and grants close for good.",
      ],
    };
  }

  function angelView(state: GameState): AngelView | null {
    const deal = state.investors.angel;
    if (!deal) return null;
    return {
      ...deal,
      dailyRevenue: Math.round(incomeOver(state, deal.target.days)),
      usersGained: usersGained(state, deal),
      daysLeft: deal.status === "running" ? Math.max(0, deal.target.byDay - state.day) : 0,
    };
  }

  function negotiationView(state: GameState): NegotiationView | null {
    const a = state.investors.approach;
    if (!a) return null;
    const n = a.negotiation;
    return {
      offers: n.offers,
      rounds: n.rounds,
      countersLeft: negotiator.countersLeft(n),
      final: negotiator.isFinal(n),
      terms: INVESTOR_TERMS,
      maxAsk: config.negotiation.maxAsk,
      bonus: shares.rollBonus(state),
    };
  }

  function investors(state: GameState): InvestorsView {
    const i = state.investors;
    return {
      offer: offer(state),
      negotiation: negotiationView(state),
      angel: angelView(state),
      declined: i.declined,
      anotherComing: i.declined.length > 0 && !i.approach && !i.angel && i.nextApproachDay !== null && !tooLate(state),
      valuation: i.valuation,
    };
  }

  function openApproach(state: GameState): Approach {
    const a = state.investors.approach;
    if (!a) {
      throw new SimError(
        "no_approach",
        state.investors.angel
          ? `You already took on your angel, ${state.investors.angel.investor}, on day ${state.investors.angel.day}.`
          : "No investor has approached you yet: they come to companies doing well.",
      );
    }
    return a;
  }

  function checkTerms(terms: Partial<Terms>) {
    const known = INVESTOR_TERMS.map((t) => t.key);
    if (typeof terms !== "object" || terms === null || Object.keys(terms).some((k) => !known.includes(k))) {
      throw new SimError("bad_counter", `An investor's offer is negotiated on ${known.join(" and ")}.`);
    }
  }

  /** What countering the open approach's offer with `terms` would do: the odds on the roll, and each next offer. */
  function counterOdds(state: GameState, terms: Partial<Terms>): CounterOdds {
    const a = openApproach(state);
    checkTerms(terms);
    return negotiator.odds(a.negotiation, terms, INVESTOR_TERMS, shares.rollBonus(state));
  }

  /** Counters the open approach's offer between days: a roll sets their next offer, which stands until answered. */
  function counterInvestor(state: GameState, terms: Partial<Terms>): GameState {
    const a = openApproach(state);
    checkTerms(terms);
    const done = negotiator.counter(a.negotiation, terms, INVESTOR_TERMS, state.negotiationRng, shares.rollBonus(state));
    return {
      ...state,
      negotiationRng: done.rng,
      investors: { ...state.investors, approach: { ...a, negotiation: done.negotiation } },
    };
  }

  /**
   * Takes the offer that stands, at once: their cash for new shares. The angel sets the valuation to their figure and
   * closes friends and family and the grant; their target starts.
   */
  function acceptInvestor(state: GameState): GameState {
    const a = openApproach(state);
    const o = offer(state)!;
    const { multiple } = priced(state, a);
    const entry: LogEntry = {
      text: `${a.investor}, your angel investor, put in ${pounds(o.amount)} for ${count.format(o.newShares)} new shares: ${percent(o.theirShare)} of the company, valuing it at ${pounds(o.valuation)}. You now own ${percent(o.yourShareAfter)}. Their target: ${o.condition}`,
      cashDelta: o.amount,
      kind: "funding",
    };
    const deal: AngelDeal = {
      investor: a.investor,
      day: state.day,
      amount: o.amount,
      shares: o.newShares,
      share: o.theirShare,
      valuation: o.valuation,
      target: o.target,
      paidUsersAtStart: state.paidUsers,
      status: "running",
      settledDay: null,
      extraShares: 0,
    };
    return {
      ...finance.chargeNow(state, [entry]),
      shareholders: [...state.shareholders, { id: "angel", shares: o.newShares, day: state.day }],
      investors: {
        ...state.investors,
        approach: null,
        nextApproachDay: null,
        angel: deal,
        valuation: { investor: a.investor, round: a.round, day: state.day, multiple },
      },
    };
  }

  /** Turns the open approach down: a new investor approaches retryDays later. */
  function declineInvestor(state: GameState): GameState {
    const a = openApproach(state);
    return {
      ...state,
      investors: {
        ...state.investors,
        approach: null,
        declined: [...state.investors.declined, { round: a.round, investor: a.investor, day: state.day, lapsed: false }],
        nextApproachDay: state.day + c.retryDays,
      },
    };
  }

  /**
   * The angel's target on a day played: met once income and users gained are both enough on the same day, or missed on
   * its last day, for extra equity.
   */
  function angelDay(state: GameState): { state: GameState; entries: LogEntry[] } {
    const deal = state.investors.angel;
    if (!deal || deal.status !== "running") return { state, entries: [] };
    const income = incomeOver(state, deal.target.days);
    const gained = usersGained(state, deal);
    const t = deal.target;
    if (income >= t.dailyRevenue && gained >= t.usersGained) {
      const met: AngelDeal = { ...deal, status: "met", settledDay: state.day };
      return {
        state: { ...state, investors: { ...state.investors, angel: met } },
        entries: [
          {
            text: `${deal.investor}'s target met: income averaged ${pounds(Math.round(income))} a day over ${t.days} days (they asked for ${pounds(t.dailyRevenue)}), and you gained ${count.format(gained)} paying users (they asked for ${count.format(t.usersGained)}).`,
            cashDelta: 0,
            kind: "funding",
          },
        ],
      };
    }
    if (state.day < deal.target.byDay) return { state, entries: [] };
    // Missed: new shares take their share up by missShare.
    const inIssue = shares.sharesInIssue(state);
    const theirs = state.shareholders.find((h) => h.id === "angel")?.shares ?? 0;
    const after = Math.min(MAX_SHARE, theirs / inIssue + angel.missShare);
    const extra = Math.max(0, Math.round((after * inIssue - theirs) / (1 - after)));
    const yours = state.shareholders.find((h) => h.id === "student")?.shares ?? 0;
    const missed: AngelDeal = { ...deal, status: "missed", settledDay: state.day, extraShares: extra };
    return {
      state: {
        ...state,
        shareholders: state.shareholders.map((h) => (h.id === "angel" ? { ...h, shares: h.shares + extra } : h)),
        investors: { ...state.investors, angel: missed },
      },
      entries: [
        {
          text: `${deal.investor}'s target missed by day ${t.byDay}: income averaged ${pounds(Math.round(income))} a day (they asked for ${pounds(t.dailyRevenue)}) and you gained ${count.format(gained)} paying users (they asked for ${count.format(t.usersGained)}). They took ${count.format(extra)} new shares, ${percent(after)} of the company now. You own ${percent(yours / (inIssue + extra))}.`,
          cashDelta: 0,
          kind: "funding",
        },
      ],
    };
  }

  /**
   * After each day played: the angel's target, then the ladder. Before the angel is accepted, the first day the hidden
   * target is hit sets when one approaches, and on that day one does.
   */
  function investorDay(state: GameState): { state: GameState; entries: LogEntry[] } {
    if (state.status === "liquidated") return { state, entries: [] };
    // A target due on the last day is settled as the game finishes on it.
    const settled = angelDay(state);
    let s = settled.state;
    const i = s.investors;
    if (s.status !== "playing" || i.angel) return settled;
    // An offer left unanswered lapses at the end of its last day, as if declined.
    const a = i.approach;
    if (a) {
      if (s.day < a.day + c.offerDays) return settled;
      const lapsed: GameState = {
        ...s,
        investors: {
          ...i,
          approach: null,
          declined: [...i.declined, { round: a.round, investor: a.investor, day: s.day, lapsed: true }],
          nextApproachDay: s.day + c.retryDays,
        },
      };
      const entry: LogEntry = {
        text: `${a.investor}'s offer lapsed: you didn't accept it within ${c.offerDays} days, so it counts as declined. Another ${ROUND_NAMES[a.round]} will approach in a few days, on less generous terms.`,
        cashDelta: 0,
        kind: "funding",
      };
      return { state: lapsed, entries: [...settled.entries, entry] };
    }
    if (i.nextApproachDay === null && angelTargetHit(s)) {
      s = { ...s, investors: { ...i, nextApproachDay: s.day + c.approachDays } };
    }
    if (s.investors.nextApproachDay !== null && s.day >= s.investors.nextApproachDay && !tooLate(s)) {
      const came = approach(s, "angel");
      return { state: came.state, entries: [...settled.entries, ...came.entries] };
    }
    return { state: s, entries: settled.entries };
  }

  return { startingInvestors, investors, counterOdds, counterInvestor, acceptInvestor, declineInvestor, investorDay };
}

export type InvestorsModule = ReturnType<typeof createInvestors>;
