import type { GameConfig } from "./config.ts";
import { profitCosts } from "./finance.ts";
import { createNegotiation, MAX_OFFERS, type CounterOdds, type NegotiationRound, type TermSpec } from "./negotiation.ts";
import { nextRandom, seedRng } from "./rng.ts";
import { dailyStaffCost } from "./staff.ts";
import { SimError, type GameState, type LogEntry, type PayReview, type PayReviewOutcome, type PayReviewRecord } from "./state.ts";

/** Quarters with a pay review: every one after the first. */
export const REVIEW_QUARTERS = [2, 3, 4] as const;

/** Rises, caps and inflation are kept to a tenth of a point: 0.034 is 3.4%. */
const STEP = 0.001;
const roundRise = (n: number) => Number((Math.round(n / STEP) * STEP).toFixed(3));
const clamp = (n: number, low: number, high: number) => Math.min(Math.max(n, low), high);
/** 0.034 as "3.4%". */
export const risePercent = (n: number) => `${Math.round(n * 1000) / 10}%`;

/** The open pay review as the student sees it: the hidden fair rise and walk-away figure left out. */
export interface PayReviewView {
  quarter: number;
  /** The quarter's first day: the first day played at the agreed rise. */
  startDay: number;
  inflation: number;
  /** The least the student can offer, and the most staff ask. */
  minOffer: number;
  maxAsk: number;
  /** What staff are asking now: their opening ask, then their latest counter. */
  staffFigure: number;
  studentOffers: number[];
  /** Staff's figures: their opening ask, then each counter. */
  staffFigures: number[];
  /** The roll that answered each offer that fell short, oldest first. */
  rounds: NegotiationRound[];
  /** Offers the student has left: 3, 2, then 1 for the final offer. */
  offersLeft: number;
  /** The next offer is the last: short of a deal, it settles midway between it and staff's figure. */
  final: boolean;
  /** Whether staff have countered, so there's a counter to accept. */
  canAcceptCounter: boolean;
  /** What the team costs a day now, before any rise. */
  dailyStaffCost: number;
}

/** What offering a rise would do, before it's made: its cost, and staff's answer if it falls short of a deal. */
export interface PayOfferPreview {
  rise: number;
  /** What the rise adds to the team's pay a day, and over a year of 365 days, at today's team. */
  extraPerDay: number;
  extraPerYear: number;
  /** The rise against inflation: below 0 is a pay cut in real terms. */
  realTerms: number;
  /** The offer is what staff are asking, so they take it: there's nothing to roll for. */
  meetsAsk: boolean;
  /**
   * If staff counter, the odds of each roll and the counter each brings. Null on the final offer, which isn't rolled,
   * and on an offer that meets their ask.
   */
  odds: CounterOdds | null;
  /** On the final offer, the rise it settles on if it falls short of a deal: midway to staff's figure. Null before. */
  midpoint: number | null;
}

/**
 * Pay reviews: at the start of quarters 2, 3 and 4 staff come to the student about pay, and the clock is held until
 * it's settled. The student offers first; staff accept an offer that reaches their hidden walk-away figure, or counter
 * with the investor negotiation's roll the other way round: staff's figure is the offer, and the student's the counter
 * it moves towards. The third offer is final. The agreed rise multiplies every pool's pay. See PayReviewConfig.
 */
export function createPayReview(config: GameConfig, deps: { runwayDays(state: GameState): number | null }) {
  const c = config.payReview;
  const negotiator = createNegotiation(c.negotiation);

  /** No review yet, pay at the config's rates, and the reviews' own RNG, seeded apart from the game's. */
  const startingPayReview = (seed: number): Pick<GameState, "payReview" | "pastPayReviews" | "payMultiplier" | "payReviewRng"> => ({
    payReview: null,
    pastPayReviews: [],
    payMultiplier: 1,
    payReviewRng: seedRng(seed ^ 0x9a7e),
  });

  /** Days in the game's year: its days, or for a game with no last day, the configured year. */
  const yearDays = (state: GameState) => state.finalDay ?? c.openEndedYearDays;

  /** The first day of each quarter with a review, in order: 46, 91 and 136 in a 180-day game. */
  const quarterStarts = (state: GameState) => REVIEW_QUARTERS.map((q) => Math.floor(((q - 1) * yearDays(state)) / 4) + 1);

  /** The quarter whose first day is the next day to play, if it has a review: due now, after the day just played. */
  function reviewDue(state: GameState): number | null {
    if (c.on !== 1 || state.status !== "playing" || state.payReview) return null;
    const next = state.day + 1;
    const i = quarterStarts(state).indexOf(next);
    return i < 0 ? null : REVIEW_QUARTERS[i]!;
  }

  /** Income and profit over `days` days played ending on `last`, from the day-by-day record. */
  function window(state: GameState, last: number, days: number) {
    const span = state.spendByDay.filter((d) => d.day > last - days && d.day <= last);
    const income = span.reduce((sum, d) => sum + d.income, 0);
    const profit = income - span.reduce((sum, d) => sum + profitCosts(d, d.interest), 0);
    return { income, profit };
  }

  /** The fair rise for how the company is doing: inflation, income growth, profit and cash, within the caps. */
  function fairRiseFor(state: GameState, inflation: number, minOffer: number, maxAsk: number): number {
    const f = c.fairRise;
    const recent = window(state, state.day, f.days);
    const before = window(state, state.day - f.days, f.days);
    const growth = before.income > 0 ? (recent.income - before.income) / before.income : recent.income > 0 ? Infinity : 0;
    const days = deps.runwayDays(state);
    const adjust =
      clamp(f.growthWeight * growth, -f.maxGrowthAdjust, f.maxGrowthAdjust) +
      (recent.profit > 0 ? f.profitBonus : 0) -
      (days !== null && days < f.tightCashDays ? f.tightCashCut : 0);
    return clamp(roundRise(inflation + adjust), minOffer, maxAsk);
  }

  /**
   * Opens the review for `quarter` after the day just played: rolls inflation and staff's walk-away figure on the
   * reviews' own RNG, and staff open at their ask. The clock is held until it's settled.
   */
  function openReview(state: GameState, quarter: number): { state: GameState; entries: LogEntry[] } {
    const [r1, rng1] = nextRandom(state.payReviewRng);
    const [r2, rng2] = nextRandom(rng1);
    const inflation = roundRise(c.inflation.min + r1 * (c.inflation.max - c.inflation.min));
    const minOffer = Math.max(0, roundRise(inflation - c.minOfferBelow));
    const maxAsk = roundRise(inflation + c.maxAskAbove);
    const fairRise = fairRiseFor(state, inflation, minOffer, maxAsk);
    const walkAway = clamp(roundRise(fairRise + c.walkAwaySpread * (2 * r2 - 1)), minOffer, maxAsk);
    const review: PayReview = {
      quarter,
      startDay: state.day + 1,
      inflation,
      minOffer,
      maxAsk,
      fairRise,
      walkAway,
      studentOffers: [],
      negotiation: negotiator.open({ rise: maxAsk }),
    };
    const text =
      `Pay review: quarter ${quarter} starts on day ${review.startDay}, and your staff want to talk about pay. ` +
      `Inflation is ${risePercent(inflation)}, and they're asking for ${risePercent(maxAsk)}. ` +
      `Make them an offer from ${risePercent(minOffer)}: the day can't go on until it's settled.`;
    return { state: { ...state, payReview: review, payReviewRng: rng2 }, entries: [{ text, cashDelta: 0, kind: "staff" }] };
  }

  function openOrRefuse(state: GameState): PayReview {
    if (!state.payReview) throw new SimError("no_pay_review", "There's no pay review open.");
    return state.payReview;
  }

  /** The rise is negotiated as staff's figure, which the student wants lower, kept within the review's caps. */
  const specsFor = (review: PayReview): TermSpec[] => [
    { key: "rise", label: "the rise", better: "lower", step: STEP, min: review.minOffer, max: review.maxAsk },
  ];

  const staffFigure = (review: PayReview) => negotiator.latest(review.negotiation).rise!;

  /** A rise checked against the caps, rounded to a tenth of a point. Refused outside them. */
  function checkOffer(review: PayReview, rise: number): number {
    if (typeof rise !== "number" || !Number.isFinite(rise)) throw new SimError("bad_offer", "Offer a rise as a number.");
    const offered = roundRise(rise);
    if (offered < review.minOffer) {
      throw new SimError(
        "offer_too_low",
        `The least you can offer is ${risePercent(review.minOffer)}: inflation (${risePercent(review.inflation)}) less a point. Less would be an insult.`,
        { minOffer: review.minOffer },
      );
    }
    if (offered > review.maxAsk) {
      throw new SimError("offer_too_high", `Staff are asking for ${risePercent(review.maxAsk)} at most: offer that or less.`, {
        maxAsk: review.maxAsk,
      });
    }
    if (review.studentOffers.length && offered >= staffFigure(review)) {
      throw new SimError(
        "above_counter",
        `Staff are asking for ${risePercent(staffFigure(review))}: accept their counter rather than offer as much or more.`,
      );
    }
    return offered;
  }

  /** Settles the review on `rise`: it multiplies every pool's pay from the next day played. */
  function settle(state: GameState, review: PayReview, studentOffers: number[], outcome: PayReviewOutcome, rise: number): GameState {
    const record: PayReviewRecord = {
      quarter: review.quarter,
      startDay: review.startDay,
      settledDay: state.day,
      inflation: review.inflation,
      minOffer: review.minOffer,
      maxAsk: review.maxAsk,
      studentOffers,
      staffFigures: review.negotiation.offers.map((o) => o.rise!),
      outcome,
      rise,
    };
    return {
      ...state,
      payReview: null,
      pastPayReviews: [...state.pastPayReviews, record],
      payMultiplier: Number((state.payMultiplier * (1 + rise)).toPrecision(12)),
    };
  }

  /**
   * Offers staff `rise`. At or above their walk-away figure they accept. Short of it, they counter, with a roll on the
   * reviews' RNG for how far they come down from their figure towards the offer; on the final (third) offer there's no
   * counter, and it settles midway between the offer and their figure.
   */
  function offer(state: GameState, rise: number): GameState {
    const review = openOrRefuse(state);
    const offered = checkOffer(review, rise);
    const studentOffers = [...review.studentOffers, offered];
    if (offered >= review.walkAway) return settle(state, review, studentOffers, "offerAccepted", offered);
    if (studentOffers.length >= MAX_OFFERS) {
      return settle(state, review, studentOffers, "midpoint", roundRise((offered + staffFigure(review)) / 2));
    }
    const done = negotiator.counter(review.negotiation, { rise: offered }, specsFor(review), state.payReviewRng);
    return { ...state, payReviewRng: done.rng, payReview: { ...review, studentOffers, negotiation: done.negotiation } };
  }

  /** Accepts staff's counter: their figure is the rise. */
  function acceptCounter(state: GameState): GameState {
    const review = openOrRefuse(state);
    if (!review.studentOffers.length) throw new SimError("no_counter", "Staff haven't countered yet: make them an offer first.");
    return settle(state, review, review.studentOffers, "counterAccepted", staffFigure(review));
  }

  function payReviewView(state: GameState): PayReviewView | null {
    const review = state.payReview;
    if (!review) return null;
    const offersLeft = MAX_OFFERS - review.studentOffers.length;
    return {
      quarter: review.quarter,
      startDay: review.startDay,
      inflation: review.inflation,
      minOffer: review.minOffer,
      maxAsk: review.maxAsk,
      staffFigure: staffFigure(review),
      studentOffers: review.studentOffers,
      staffFigures: review.negotiation.offers.map((o) => o.rise!),
      rounds: review.negotiation.rounds,
      offersLeft,
      final: offersLeft === 1,
      canAcceptCounter: review.studentOffers.length > 0,
      dailyStaffCost: dailyStaffCost(config, state),
    };
  }

  /** What offering `rise` would do: its cost at today's team, and the roll's odds if staff counter. Refused as offer would. */
  function offerPreview(state: GameState, rise: number): PayOfferPreview {
    const review = openOrRefuse(state);
    const offered = checkOffer(review, rise);
    const now = dailyStaffCost(config, state);
    const extraPerDay = dailyStaffCost(config, { ...state, payMultiplier: state.payMultiplier * (1 + offered) }) - now;
    const final = review.studentOffers.length + 1 >= MAX_OFFERS;
    // Only staff's opening ask can be offered in full: once they've countered, offering it is refused.
    const meetsAsk = offered >= staffFigure(review);
    return {
      rise: offered,
      extraPerDay,
      extraPerYear: extraPerDay * 365,
      realTerms: roundRise(offered - review.inflation),
      meetsAsk,
      odds: final || meetsAsk ? null : negotiator.odds(review.negotiation, { rise: offered }, specsFor(review)),
      midpoint: final && !meetsAsk ? roundRise((offered + staffFigure(review)) / 2) : null,
    };
  }

  return { startingPayReview, quarterStarts, reviewDue, openReview, offer, acceptCounter, payReviewView, offerPreview };
}

/**
 * The game's inflation: the open review's, or the last settled one's, as a share (0.03 = 3%). Null before the first
 * review. Drift (#95) reads it for prices.
 */
export function inflationNow(state: Pick<GameState, "payReview" | "pastPayReviews">): number | null {
  return state.payReview?.inflation ?? state.pastPayReviews.at(-1)?.inflation ?? null;
}
