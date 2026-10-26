import { SERIES_IDS, VC_LEANS, type GameConfig, type SeriesId, type VcLean, type VcRoundConfig } from "./config.ts";
import { count, pounds, type Finance } from "./finance.ts";
import { loanOwed } from "./loan.ts";
import { marketSize } from "./market.ts";
import { createNegotiation, type CounterOdds, type TermSpec, type Terms } from "./negotiation.ts";
import { nextRandom } from "./rng.ts";
import type { NegotiationView, Shares } from "./shares.ts";
import {
  ROUND_NAMES,
  SimError,
  type AngelDeal,
  type AngelTarget,
  type Approach,
  type GameState,
  type InvestorValuation,
  type Investors,
  type LogEntry,
  type RoundId,
  type VcApproach,
  type VcDeal,
  type VcPitch,
  type VentureCapital,
} from "./state.ts";

/** Users who joined and who left on a day played, free and paying: what an angel's users target counts. */
export interface UserFlows {
  joined: number;
  left: number;
}

/**
 * What accepting the open approach's offer now would do: the cash, their share and yours, the valuation their terms
 * put on the company, and the target that comes with it, all before accepting.
 */
export interface InvestorOffer {
  round: RoundId;
  investor: string;
  /**
   * The day they approached, and the last day it can be answered on (the day shown): unanswered then, it lapses as the
   * next day is played.
   */
  day: number;
  lastDay: number;
  /** Days it can still be answered on, today included: 1 means today is the last. */
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
  /** Users gained less users lost since accepting: what the users target measures. */
  netUsers: number;
  /** Days left to hit the target: 0 once it's met or missed. */
  daysLeft: number;
}

/** One VC's offer in an approach, priced today as an angel's is. */
export interface VcOfferView {
  investor: string;
  lean: VcLean;
  /** "Most cash", "Fewest conditions" or "Least ownership". */
  leanLabel: string;
  /** The lead VC, back from the last round the student went with. */
  lead: boolean;
  /** "open" until one is picked; then "picked" for that VC and "closed" for the other two. */
  status: "open" | "picked" | "closed";
  amount: number;
  /**
   * In a two-round game, the part of the cash held back as the second tranche, paid once the company hits their growth
   * target; the rest is paid on signing. Null in a four-round game, where all of it is paid on signing.
   */
  secondTranche: number | null;
  /** Their share of the company after, 0–1. */
  theirShare: number;
  preMoney: number;
  valuation: number;
  /** Their valuation of the business, as a multiple of the formula's. */
  multiple: number;
  sharePrice: number;
  newShares: number;
  sharesAfter: number;
  yourShareAfter: number;
}

/** Three VCs' approach for a round, still to be answered. */
export interface VcApproachView {
  round: SeriesId;
  /** "Series A". */
  name: string;
  day: number;
  /** The last day it can be answered on: unanswered then, it lapses as the next day is played. */
  lastDay: number;
  daysLeft: number;
  picked: string | null;
  offers: VcOfferView[];
  formulaValuation: number;
  sharesInIssue: number;
  yourShareBefore: number;
  /** What accepting any of them does, in words. */
  effects: string[];
}

/** A round of the ladder: the day it first approached (null until then) and its deal, if one was done. */
export interface VcRoundView {
  round: SeriesId;
  name: string;
  firstApproachDay: number | null;
  deal: VcDeal | null;
}

/** Venture capital: the approach open now and the negotiation with the VC picked, and how each round stands. */
export interface VcView {
  approach: VcApproachView | null;
  negotiation: NegotiationView | null;
  rounds: VcRoundView[];
  lead: VentureCapital["lead"];
  /** Approaches turned down, failed or lapsed, oldest first. */
  declined: VentureCapital["declined"];
  /** After a decline, until three new VCs approach for the same round: they will, in a few days. */
  anotherComing: boolean;
}

/**
 * The funding ladder: the angel's approach open now and its negotiation, the angel's deal, the valuation an investor
 * set, and venture capital.
 */
export interface InvestorsView {
  offer: InvestorOffer | null;
  negotiation: NegotiationView | null;
  angel: AngelView | null;
  /** Angels turned down so far, oldest first. */
  declined: Investors["declined"];
  /** After a decline, until the next angel approaches: one will, in a few days. */
  anotherComing: boolean;
  valuation: InvestorValuation | null;
  vc: VcView;
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

/** VC firms' names, drawn as they approach. */
const VC_NAMES = [
  "Northgate Ventures",
  "Halcyon Capital",
  "Redbrick Partners",
  "Ashgrove Ventures",
  "Lumen Capital",
  "Foundry Bridge",
  "Kestrel Partners",
  "Meridian Growth",
  "Tidewater Capital",
  "Oakline Ventures",
  "Silverpeak Partners",
  "Harbourlight Capital",
  "Brightwater Ventures",
  "Cobalt Square",
  "Fieldstone Growth",
  "Juniper Lane Capital",
  "Elmstead Ventures",
  "Quarry Hill Partners",
  "Blackthorn Capital",
  "Wayfarer Ventures",
  "Larkspur Growth",
  "Ironbridge Partners",
  "Sable Point Capital",
  "Greenhythe Ventures",
];

const LEAN_LABELS: Record<VcLean, string> = { cash: "Most cash", conditions: "Fewest conditions", ownership: "Least ownership" };

/** The day a VC round first approached, whatever the student made of it, or null: Series A's unlocks its C-suite roles. */
export const seriesApproachDay = (state: Pick<GameState, "investors">, round: SeriesId) =>
  state.investors.vc.firstApproachDay[round];

/** A rung of venture capital: its round, and the rounds of the four whose offers and targets it takes, earlier first. */
export interface VcRung {
  round: SeriesId;
  parts: SeriesId[];
}

/** A 180-day game has two VC rounds, not four. */
export const twoRoundGame = (state: Pick<GameState, "gameLength">) => state.gameLength === "180-days";

const FOUR_ROUNDS: VcRung[] = SERIES_IDS.map((round) => ({ round, parts: [round] }));
/** Series A takes A and B's offers and targets, and Series B takes C and D's. */
const TWO_ROUNDS: VcRung[] = [
  { round: "seriesA", parts: ["seriesA", "seriesB"] },
  { round: "seriesB", parts: ["seriesC", "seriesD"] },
];

/**
 * The game's VC rounds in order: Series A to D, or in a 180-day game Series A and B, each merging two of the four. A
 * merged round approaches at the earlier round's target, for both rounds' cash and share added together, and pays the
 * later round's part as a second tranche once the later round's target is hit.
 */
export const vcLadder = (state: Pick<GameState, "gameLength">): VcRung[] => (twoRoundGame(state) ? TWO_ROUNDS : FOUR_ROUNDS);

const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;
const roundTo = (n: number, step: number) => Math.round(n / step) * step;
/** The most of the company an offer can come to, however far the business falls. */
const MAX_SHARE = 0.9;

/**
 * The funding ladder's investors, who approach the student: the angel, then Series A–D venture capital (Series A and B
 * in a 180-day game, each merging two rounds: see vcLadder). A rung's hidden
 * target, once hit, brings an investor approachDays later with an offer of cash for a share (three VCs, for a VC
 * round), which the student negotiates, accepts or declines; declining brings another retryDays later. See
 * InvestorsConfig and VcConfig.
 */
export function createInvestors(config: GameConfig, finance: Finance, shares: Shares) {
  const c = config.investors;
  const angel = c.angel;
  const negotiator = createNegotiation(config.negotiation);

  const startingInvestors = (): Investors => ({
    nextApproachDay: null,
    firstApproachDay: null,
    approach: null,
    declined: [],
    angel: null,
    valuation: null,
    vc: {
      firstApproachDay: { seriesA: null, seriesB: null, seriesC: null, seriesD: null },
      next: null,
      approach: null,
      declined: [],
      deals: [],
      lead: null,
    },
  });

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
      // The first approach is the company growing up: researchers and marketers can be hired from now, whatever the
      // answer.
      ...(state.investors.firstApproachDay === null
        ? [
            {
              text: "Your company is growing up: you can hire researchers and marketers now, on People, and follow their work on Research and Marketing.",
              cashDelta: 0,
              kind: "staff" as const,
            },
          ]
        : []),
    ];
    const firstApproachDay = state.investors.firstApproachDay ?? state.day;
    return {
      state: { ...state, investorRng: rng, investors: { ...state.investors, approach: record, nextApproachDay: null, firstApproachDay } },
      entries,
    };
  }

  /**
   * The offer that stands, priced today. Their terms value the business at a multiple of what it was worth when they
   * approached, and net cash at face value, as it is now. The multiple holds, so if the business is worth less now
   * their share rises in step, and an offer can't be held open while the company sinks to sell it dear; a business
   * worth more gets the terms agreed. Cash raised or spent since moves it pound for pound.
   */
  function priced(state: GameState, a: Pick<Approach, "negotiation" | "business" | "netCash">) {
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

  /** Users gained a day lately, net, free and paying: over the last target.days days played, none if they fell. */
  function usersPace(state: GameState): number {
    const then = state.spendByDay.filter((d) => d.day <= state.day - angel.target.days).at(-1);
    return Math.max(0, (state.users - (then?.users ?? 0)) / angel.target.days);
  }

  /**
   * The angel's target if their offer were accepted today: income at targetGrowth × today's, and net users gained at
   * the company's recent pace, so it suits a small company and a big one alike. It's due by the game's last day at
   * the latest, and then asks for growth in step with the days left.
   */
  function angelTarget(state: GameState): AngelTarget {
    const now = Math.max(angel.target.dailyRevenue, incomeOver(state, angel.target.days));
    const byDay = Math.min(state.day + angel.targetDays, state.finalDay ?? Infinity);
    const share = (byDay - state.day) / angel.targetDays;
    const growth = 1 + (angel.targetGrowth - 1) * share;
    // Never more than a share of the users the market still has room for, so a fast start can't set one beyond reach.
    const room = Math.max(0, marketSize(config, state) - state.users);
    const users = Math.min(angel.usersRoomShare * room, Math.max(angel.minUsersGained, angel.usersPace * usersPace(state) * angel.targetDays) * share);
    return {
      dailyRevenue: Math.ceil((growth * now) / 50) * 50,
      days: angel.target.days,
      netUsers: Math.ceil(users / 10) * 10,
      byDay,
    };
  }

  /** Users gained less users lost since the deal. */
  const netUsers = (deal: AngelDeal) => deal.usersGained - deal.usersLost;

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
      lastDay: a.day + c.offerDays - 1,
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
      condition: `By day ${target.byDay} (${target.byDay - state.day} days after you accept${target.byDay - state.day < angel.targetDays ? ", the game's last day" : ""}), both at once: grow income to ${pounds(target.dailyRevenue)} a day, averaged over ${target.days} day${target.days === 1 ? "" : "s"}, and gain ${count.format(target.netUsers)} users net from the day you accept: users who join, free or paying, less users who leave.`,
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
      netUsers: netUsers(deal),
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
      anotherComing:
        i.declined.length > 0 &&
        !i.approach &&
        !i.angel &&
        i.nextApproachDay !== null &&
        i.vc.firstApproachDay.seriesA === null &&
        !tooLate(state),
      valuation: i.valuation,
      vc: vcView(state),
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
    if (state.investors.vc.approach) return vcCounterOdds(state, terms);
    const a = openApproach(state);
    checkTerms(terms);
    return negotiator.odds(a.negotiation, terms, INVESTOR_TERMS, shares.rollBonus(state));
  }

  /** Counters the open approach's offer between days: a roll sets their next offer, which stands until answered. */
  function counterInvestor(state: GameState, terms: Partial<Terms>): GameState {
    if (state.investors.vc.approach) return counterVc(state, terms);
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
    if (state.investors.vc.approach) return acceptVc(state);
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
      usersAtStart: state.users,
      usersGained: 0,
      usersLost: 0,
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
    if (state.investors.vc.approach) return declineVc(state);
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
  function angelDay(state: GameState, flows: UserFlows): { state: GameState; entries: LogEntry[] } {
    const running = state.investors.angel;
    if (!running || running.status !== "running") return { state, entries: [] };
    // The day's users who joined and left count towards the users target.
    const deal: AngelDeal = { ...running, usersGained: running.usersGained + flows.joined, usersLost: running.usersLost + flows.left };
    state = { ...state, investors: { ...state.investors, angel: deal } };
    const income = incomeOver(state, deal.target.days);
    const net = netUsers(deal);
    const t = deal.target;
    const users = `${count.format(deal.usersGained)} users gained less ${count.format(deal.usersLost)} lost is ${count.format(net)} net (they asked for ${count.format(t.netUsers)})`;
    if (income >= t.dailyRevenue && net >= t.netUsers) {
      const met: AngelDeal = { ...deal, status: "met", settledDay: state.day };
      return {
        state: { ...state, investors: { ...state.investors, angel: met } },
        entries: [
          {
            text: `${deal.investor}'s target met: income averaged ${pounds(Math.round(income))} a day over ${t.days} days (they asked for ${pounds(t.dailyRevenue)}), and ${users}.`,
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
          text: `${deal.investor}'s target missed by day ${t.byDay}: income averaged ${pounds(Math.round(income))} a day (they asked for ${pounds(t.dailyRevenue)}), and ${users}. They took ${count.format(extra)} new shares, ${percent(after)} of the company now. You own ${percent(yours / (inIssue + extra))}.`,
          cashDelta: 0,
          kind: "funding",
        },
      ],
    };
  }

  /**
   * The angel's rung on a day played, until an angel is accepted or Series A approaches: an offer left unanswered
   * lapses, and the first day the hidden target is hit sets when one approaches, and on that day one does.
   */
  function angelLadderDay(s: GameState): { state: GameState; entries: LogEntry[] } {
    const i = s.investors;
    if (i.angel || i.vc.firstApproachDay.seriesA !== null) return { state: s, entries: [] };
    // An offer left unanswered lapses at the end of its last day, as if declined.
    const a = i.approach;
    if (a) {
      if (s.day < a.day + c.offerDays) return { state: s, entries: [] };
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
      return { state: lapsed, entries: [entry] };
    }
    if (i.nextApproachDay === null && angelTargetHit(s)) {
      s = { ...s, investors: { ...i, nextApproachDay: s.day + c.approachDays } };
    }
    // Series A's VCs, due today, come ahead of another angel.
    const seriesADue = i.vc.next !== null && s.day >= i.vc.next.day;
    if (s.investors.nextApproachDay !== null && s.day >= s.investors.nextApproachDay && !tooLate(s) && !seriesADue) return approach(s, "angel");
    return { state: s, entries: [] };
  }

  /** After each day played: the angel's target, then the ladder: the angel's rung, then venture capital's. */
  function investorDay(state: GameState, flows: UserFlows): { state: GameState; entries: LogEntry[] } {
    if (state.status === "liquidated") return { state, entries: [] };
    // A target due on the last day is settled as the game finishes on it.
    const settled = angelDay(state, flows);
    if (settled.state.status !== "playing") return settled;
    const angelRung = angelLadderDay(settled.state);
    const vcRung = vcDay(angelRung.state);
    return { state: vcRung.state, entries: [...settled.entries, ...angelRung.entries, ...vcRung.entries] };
  }

  // Venture capital.

  const vcConfig = c.vc;
  const withVc = (state: GameState, vc: Partial<VentureCapital>): GameState => ({
    ...state,
    investors: { ...state.investors, vc: { ...state.investors.vc, ...vc } },
  });

  /** Uptime % over the last `days` days played. */
  const uptimeOver = (state: GameState, days: number) => {
    const recent = state.spendByDay.filter((d) => d.day > state.day - days && d.day <= state.day);
    return 100 * (1 - recent.reduce((sum, d) => sum + d.hoursDown, 0) / (Math.max(1, recent.length) * 24));
  };

  /** A round's hidden target: every part set, as a share of the product's IPO bar, holding today. */
  function vcTargetHit(state: GameState, round: SeriesId): boolean {
    const t = vcConfig.rounds[round].target;
    const bar = config.ipo.products[state.productType];
    const days = vcConfig.targetDays;
    if (state.launchDay === null || state.day - state.launchDay < days) return false;
    if (t.payingUsers > 0 && state.paidUsers < t.payingUsers * bar.payingUsers) return false;
    if (t.dailyRevenue > 0 && incomeOver(state, days) < (t.dailyRevenue * bar.annualRevenue) / 365) return false;
    if (t.minUptime > 0 && uptimeOver(state, days) < t.minUptime) return false;
    return true;
  }

  /** The day the rung before a round first approached: the angel for Series A. */
  const rungBefore = (state: GameState, round: SeriesId) => {
    const ladder = vcLadder(state);
    const at = ladder.findIndex((r) => r.round === round);
    return at === 0 ? state.investors.firstApproachDay : state.investors.vc.firstApproachDay[ladder[at - 1]!.round];
  };

  /**
   * A VC's offer for one of the four rounds' terms, from where its two draws fell (0–1) between the least and most
   * premium and share, as an angel's, plus the VC's lean and the lead VC's premium. `round` is the round approaching,
   * whose declines make it less generous.
   */
  function roundOffer(state: GameState, r: VcRoundConfig, round: SeriesId, lean: VcLean, isLead: boolean, premiumAt: number, shareAt: number) {
    const leaning = vcConfig.leans[lean];
    // Word gets round: each approach turned down in this round makes the next VCs less generous.
    const declines = state.investors.vc.declined.filter((d) => d.round === round).length;
    const premiumMax = Math.max(r.premium.min, r.premium.max - declines * vcConfig.declinePremium);
    const shareMin = Math.min(r.share.max, r.share.min + declines * vcConfig.declineShare);
    const business = shares.businessWorth(state);
    const cash = netCash(state);
    const premium =
      Math.round((r.premium.min + premiumAt * (premiumMax - r.premium.min) + leaning.premium + (isLead ? vcConfig.leadPremium : 0)) * 100) / 100;
    const asked = Math.min(MAX_SHARE, roundTo((shareMin + shareAt * (r.share.max - shareMin)) * leaning.share, 0.005));
    const preMoney = Math.max(premium * business + cash, 0.25 * premium * business);
    const amount = Math.min(r.maxAmount, Math.max(r.minAmount, roundTo((asked * preMoney) / (1 - asked), 1000)));
    return { amount, share: amount / (preMoney + amount) };
  }

  /**
   * A merged round's agreed cash split into its two tranches, in proportion to the two rounds' opening offers, to the
   * nearest £1,000: paid on signing, and paid once the later round's target is hit. Null for a round of four.
   */
  const tranches = (vc: VcPitch, amount: number): [number, number] | null => {
    if (!vc.parts) return null;
    const opening = vc.parts.reduce((sum, p) => sum + p.amount, 0);
    const first = Math.min(amount, roundTo((amount * vc.parts[0]!.amount) / opening, 1000));
    return [first, amount - first];
  };

  /**
   * Three VCs approach for a round. On the round's first approach the lead VC, if there is one, returns for B, C or D
   * alongside two new VCs; otherwise all three are new. Each leans its own way, and their offers value the business at
   * a premium over the formula's, as an angel's do. A merged round's offers are its two rounds' offers added together,
   * each VC's draws falling the same way in both.
   */
  function vcApproach(state: GameState, round: SeriesId): { state: GameState; entries: LogEntry[] } {
    let rng = state.investorRng;
    const draw = () => {
      const [r, next] = nextRandom(rng);
      rng = next;
      return r;
    };
    const v = state.investors.vc;
    const rung = vcLadder(state).find((r) => r.round === round)!;
    const first = v.firstApproachDay[round] === null;
    const lead = first && round !== "seriesA" ? v.lead : null;
    // New names each time: not the lead, nor any VC turned down or gone with before, unless too few are left.
    const used = new Set([...v.declined.flatMap((d) => d.investors), ...v.deals.map((d) => d.investor), ...(v.lead ? [v.lead.investor] : [])]);
    let pool = VC_NAMES.filter((n) => !used.has(n));
    if (pool.length < 3) pool = VC_NAMES.filter((n) => n !== lead?.investor);
    const business = shares.businessWorth(state);
    const cash = netCash(state);

    const pitch = (investor: string, lean: VcLean, isLead: boolean): VcPitch => {
      const premiumAt = draw();
      const shareAt = draw();
      const parts = rung.parts.map((p) => ({ round: p, ...roundOffer(state, vcConfig.rounds[p], round, lean, isLead, premiumAt, shareAt) }));
      const amount = parts.reduce((sum, p) => sum + p.amount, 0);
      const share = Math.min(MAX_SHARE, parts.reduce((sum, p) => sum + p.share, 0));
      return { investor, lean, lead: isLead, negotiation: negotiator.open({ amount, share }), parts: parts.length > 1 ? parts : null };
    };
    const vcs: VcPitch[] = lead ? [pitch(lead.investor, lead.lean, true)] : [];
    while (vcs.length < 3) {
      const investor = pool.splice(Math.floor(draw() * pool.length), 1)[0]!;
      const lean = VC_LEANS[Math.floor(draw() * VC_LEANS.length)]!;
      vcs.push(pitch(investor, lean, false));
    }
    const record: VcApproach = { round, day: state.day, business, netCash: cash, vcs, picked: null };
    const offers = vcs
      .map((p) => {
        const t = negotiator.latest(p.negotiation);
        return `${p.investor}${p.lead ? ", your lead VC," : ""} (${LEAN_LABELS[p.lean].toLowerCase()}) ${pounds(t.amount!)} for ${percent(t.share!)}`;
      })
      .join("; ");
    const entries: LogEntry[] = [
      {
        text: `${ROUND_NAMES[round]}: three venture capitalists want to invest in ${state.companyName}. ${offers}. Their offers are on Finance: pick one to negotiate with, or decline them all.`,
        cashDelta: 0,
        kind: "funding",
      },
    ];
    return {
      state: {
        ...withVc(state, {
          approach: record,
          next: null,
          firstApproachDay: { ...v.firstApproachDay, [round]: v.firstApproachDay[round] ?? state.day },
        }),
        investorRng: rng,
      },
      entries,
    };
  }

  /**
   * Venture capital's rung on a day played: an approach left unanswered lapses; otherwise, once the rung before has
   * approached and gapDays have passed, the first day the next round's target is hit sets when its VCs approach, ahead
   * of any retry for the round before; and on that day they do, or once an angel's offer open then is answered.
   */
  function vcDay(state: GameState): { state: GameState; entries: LogEntry[] } {
    const paid = trancheDay(state);
    const rung = vcRungDay(paid.state);
    return { state: rung.state, entries: [...paid.entries, ...rung.entries] };
  }

  /**
   * A merged round's second tranche, still to come: paid on the first day the later round's target is hit, once gapDays
   * have passed since the round first approached.
   */
  function trancheDay(s: GameState): { state: GameState; entries: LogEntry[] } {
    const v = s.investors.vc;
    const due = v.deals.find(
      (d) =>
        d.tranche !== null &&
        d.tranche.paidDay === null &&
        s.day >= v.firstApproachDay[d.round]! + vcConfig.gapDays &&
        vcTargetHit(s, d.tranche.target),
    );
    if (!due) return { state: s, entries: [] };
    const tranche = due.tranche!;
    const entry: LogEntry = {
      text: `${due.investor} paid the second tranche of your ${ROUND_NAMES[due.round]}: ${pounds(tranche.amount)}, now that ${s.companyName} has hit their growth target.`,
      cashDelta: tranche.amount,
      kind: "funding",
    };
    const deals = v.deals.map((d) => (d === due ? { ...d, tranche: { ...tranche, paidDay: s.day } } : d));
    return { state: withVc(finance.chargeNow(s, [entry]), { deals }), entries: [entry] };
  }

  function vcRungDay(s: GameState): { state: GameState; entries: LogEntry[] } {
    const v = s.investors.vc;
    const a = v.approach;
    if (a) {
      if (s.day < a.day + c.offerDays) return { state: s, entries: [] };
      const entry: LogEntry = {
        text: `The ${ROUND_NAMES[a.round]} offers lapsed: you didn't accept one within ${c.offerDays} days, so they count as declined. Three new VCs will approach in a few days, on less generous terms.`,
        cashDelta: 0,
        kind: "funding",
      };
      return {
        state: withVc(s, {
          approach: null,
          declined: [...v.declined, { round: a.round, investors: a.vcs.map((p) => p.investor), day: s.day, lapsed: true }],
          next: { round: a.round, day: s.day + c.retryDays },
        }),
        entries: [entry],
      };
    }
    const upcoming = vcLadder(s).find((r) => v.firstApproachDay[r.round] === null);
    if (upcoming && v.next?.round !== upcoming.round) {
      const before = rungBefore(s, upcoming.round);
      if (before !== null && s.day >= before + vcConfig.gapDays && vcTargetHit(s, upcoming.parts[0]!)) {
        s = withVc(s, { next: { round: upcoming.round, day: s.day + c.approachDays } });
      }
    }
    // They wait while an angel's offer is open, and come once it's answered.
    const next = s.investors.vc.next;
    if (next && s.day >= next.day && !s.investors.approach) return vcApproach(s, next.round);
    return { state: s, entries: [] };
  }

  function openVc(state: GameState): VcApproach {
    const a = state.investors.vc.approach;
    if (!a) throw new SimError("no_approach", "No VCs are waiting on an answer: they come to companies that grow.");
    return a;
  }

  /** The VC picked to negotiate with: refused until one is. */
  function pickedVc(state: GameState): { a: VcApproach; vc: VcPitch } {
    const a = openVc(state);
    const vc = a.vcs.find((p) => p.investor === a.picked);
    if (!vc) throw new SimError("pick_first", `Pick one of the three VCs to negotiate with first: ${a.vcs.map((p) => p.investor).join(", ")}.`);
    return { a, vc };
  }

  /** Picks one of the three VCs to negotiate with alone, which closes the other two. */
  function pickInvestor(state: GameState, investor: string): GameState {
    const a = openVc(state);
    if (a.picked) throw new SimError("already_picked", `You're already negotiating with ${a.picked}: the other two have closed.`);
    if (!a.vcs.some((p) => p.investor === investor)) {
      throw new SimError("unknown_investor", `Pick one of the VCs who approached: ${a.vcs.map((p) => p.investor).join(", ")}.`);
    }
    return withVc(state, { approach: { ...a, picked: investor } });
  }

  /** A VC's offer that stands, priced today. */
  function vcTerms(state: GameState, a: VcApproach, vc: VcPitch) {
    const { amount, preMoney, share, multiple } = priced(state, { negotiation: vc.negotiation, business: a.business, netCash: a.netCash });
    const inIssue = shares.sharesInIssue(state);
    const newShares = Math.max(1, Math.round((share * inIssue) / (1 - share)));
    const sharesAfter = inIssue + newShares;
    const yours = state.shareholders.find((h) => h.id === "student")?.shares ?? 0;
    return {
      amount,
      secondTranche: tranches(vc, amount)?.[1] ?? null,
      theirShare: newShares / sharesAfter,
      preMoney: Math.round(preMoney),
      valuation: Math.round(preMoney + amount),
      multiple: Math.round(multiple * 100) / 100,
      rawMultiple: multiple,
      sharePrice: amount / newShares,
      newShares,
      sharesAfter,
      yourShareAfter: yours / sharesAfter,
    };
  }

  function vcView(state: GameState): VcView {
    const v = state.investors.vc;
    const a = v.approach;
    let approachView: VcApproachView | null = null;
    let negotiation: NegotiationView | null = null;
    if (a) {
      const inIssue = shares.sharesInIssue(state);
      const yours = state.shareholders.find((h) => h.id === "student")?.shares ?? 0;
      const funding = shares.funding(state);
      const closing = [funding.friendsAndFamilyOffer && "friends and family's offer", funding.grantOffer && "the grant's offer"].filter(Boolean);
      const ladder = vcLadder(state);
      const after = ladder[ladder.findIndex((r) => r.round === a.round) + 1]?.round;
      const merged = a.vcs.some((p) => p.parts !== null);
      approachView = {
        round: a.round,
        name: ROUND_NAMES[a.round],
        day: a.day,
        lastDay: a.day + c.offerDays - 1,
        daysLeft: a.day + c.offerDays - state.day,
        picked: a.picked,
        offers: a.vcs.map((vc) => {
          const { rawMultiple: _, ...terms } = vcTerms(state, a, vc);
          return {
            investor: vc.investor,
            lean: vc.lean,
            leanLabel: LEAN_LABELS[vc.lean],
            lead: vc.lead,
            status: a.picked === null ? "open" : a.picked === vc.investor ? "picked" : "closed",
            ...terms,
          };
        }),
        formulaValuation: shares.valuation(state).valuation,
        sharesInIssue: inIssue,
        yourShareBefore: yours / inIssue,
        effects: [
          "The company's valuation becomes the VC's figure, with their cash, and moves in step with the formula from then on.",
          merged
            ? "Their cash comes in two tranches: the first on signing, the second once the company hits their growth target, which stays hidden as the rounds' targets do. Until it's paid, the valuation counts only the cash you have."
            : "All their cash is paid on signing.",
          ...(after ? [`They become your lead VC: they'll be back for ${ROUND_NAMES[after]} alongside two new VCs.`] : []),
          ...(closing.length ? [`Friends and family and grants close for good: ${closing.join(" and ")} will be gone.`] : []),
        ],
      };
      const picked = a.vcs.find((p) => p.investor === a.picked);
      if (picked) {
        const n = picked.negotiation;
        negotiation = {
          offers: n.offers,
          rounds: n.rounds,
          countersLeft: negotiator.countersLeft(n),
          final: negotiator.isFinal(n),
          terms: INVESTOR_TERMS,
          maxAsk: config.negotiation.maxAsk,
          bonus: shares.rollBonus(state),
        };
      }
    }
    // A retry is coming once a round's approach was turned down and the next round hasn't come first.
    const retry = v.next !== null && v.firstApproachDay[v.next.round] !== null;
    return {
      approach: approachView,
      negotiation,
      rounds: vcLadder(state).map(({ round }) => ({
        round,
        name: ROUND_NAMES[round],
        firstApproachDay: v.firstApproachDay[round],
        deal: v.deals.find((d) => d.round === round) ?? null,
      })),
      lead: v.lead,
      declined: v.declined,
      anotherComing: !a && retry,
    };
  }

  function vcCounterOdds(state: GameState, terms: Partial<Terms>): CounterOdds {
    const { vc } = pickedVc(state);
    checkTerms(terms);
    return negotiator.odds(vc.negotiation, terms, INVESTOR_TERMS, shares.rollBonus(state));
  }

  function counterVc(state: GameState, terms: Partial<Terms>): GameState {
    const { a, vc } = pickedVc(state);
    checkTerms(terms);
    const done = negotiator.counter(vc.negotiation, terms, INVESTOR_TERMS, state.negotiationRng, shares.rollBonus(state));
    const vcs = a.vcs.map((p) => (p === vc ? { ...p, negotiation: done.negotiation } : p));
    return { ...withVc(state, { approach: { ...a, vcs } }), negotiationRng: done.rng };
  }

  /**
   * Takes the picked VC's offer that stands, at once: their cash for new shares, a merged round's first tranche now and
   * its second once the later round's target is hit. Their figure becomes the valuation,
   * they become the lead VC, and friends and family and the grant close.
   */
  function acceptVc(state: GameState): GameState {
    const { a, vc } = pickedVc(state);
    const t = vcTerms(state, a, vc);
    const split = tranches(vc, t.amount);
    const entry: LogEntry = {
      text: `${vc.investor} led your ${ROUND_NAMES[a.round]}: ${pounds(t.amount)} for ${count.format(t.newShares)} new shares, ${percent(t.theirShare)} of the company, valuing it at ${pounds(t.valuation)}. You now own ${percent(t.yourShareAfter)}.${split ? ` They paid ${pounds(split[0])} on signing; the second tranche, ${pounds(split[1])}, comes once the company hits their growth target.` : ""}`,
      cashDelta: split ? split[0] : t.amount,
      kind: "funding",
    };
    const deal: VcDeal = {
      round: a.round,
      investor: vc.investor,
      lean: vc.lean,
      day: state.day,
      amount: t.amount,
      shares: t.newShares,
      share: t.theirShare,
      valuation: t.valuation,
      tranche: split ? { amount: split[1], target: vc.parts![1]!.round, paidDay: null } : null,
    };
    const v = state.investors.vc;
    const holding = state.shareholders.some((h) => h.id === "vc" && h.investor === vc.investor);
    return {
      ...finance.chargeNow(state, [entry]),
      shareholders: holding
        ? state.shareholders.map((h) => (h.id === "vc" && h.investor === vc.investor ? { ...h, shares: h.shares + t.newShares } : h))
        : [...state.shareholders, { id: "vc", investor: vc.investor, shares: t.newShares, day: state.day }],
      investors: {
        ...state.investors,
        valuation: { investor: vc.investor, round: a.round, day: state.day, multiple: t.rawMultiple },
        vc: { ...v, approach: null, next: null, deals: [...v.deals, deal], lead: { investor: vc.investor, lean: vc.lean } },
      },
    };
  }

  /** Turns the approach down (all three, or the VC picked): three new VCs approach retryDays later for the same round. */
  function declineVc(state: GameState): GameState {
    const a = openVc(state);
    const v = state.investors.vc;
    return withVc(state, {
      approach: null,
      declined: [...v.declined, { round: a.round, investors: a.vcs.map((p) => p.investor), day: state.day, lapsed: false }],
      next: { round: a.round, day: state.day + c.retryDays },
    });
  }

  return { startingInvestors, investors, counterOdds, counterInvestor, acceptInvestor, declineInvestor, pickInvestor, investorDay };
}

export type InvestorsModule = ReturnType<typeof createInvestors>;
