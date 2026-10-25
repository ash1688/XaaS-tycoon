import type { GameConfig } from "./config.ts";
import { count, pounds, profitCosts } from "./finance.ts";
import { createNegotiation, MAX_OFFERS, type CounterOdds, type NegotiationRound, type TermSpec } from "./negotiation.ts";
import { peopleLead } from "./peopleLead.ts";
import { nextRandom, seedRng } from "./rng.ts";
import { dailyStaffCost } from "./staff.ts";
import {
  checkSchemes,
  noSchemes,
  schemeCost,
  schemeRaisesText,
  schemesCost,
  schemeValuation,
  schemeValue,
  schemeViews,
  shareSaveIssue,
  STAFF_SCHEMES,
  withShareSave,
  type ShareSaveIssue,
  type SchemeLevels,
  type StaffSchemeId,
  type StaffSchemeView,
} from "./staffSchemes.ts";
import {
  SimError,
  type GameState,
  type LogEntry,
  type PayOfferTerms,
  type PayReview,
  type PayReviewOutcome,
  type PayReviewRecord,
  type TribunalPick,
} from "./state.ts";

/** Quarters with a pay review in a game's first year: every one after the first. A long game's later years have all four. */
export const REVIEW_QUARTERS = [2, 3, 4] as const;

/** A pay review's place in the game: the quarter it opens, the game year that's in, and the quarter's first day. */
export interface ReviewSlot {
  quarter: number;
  year: number;
  startDay: number;
}

/** "quarter 3", or in a long game's later years "quarter 1 of year 2". */
export const quarterName = (r: Pick<ReviewSlot, "quarter" | "year">) =>
  r.year > 1 ? `quarter ${r.quarter} of year ${r.year}` : `quarter ${r.quarter}`;

/** A game long enough for years of reviews: until IPO or a career. */
const longGame = (state: Pick<GameState, "gameLength">) => state.gameLength === "until-ipo" || state.gameLength === "career";

/** Rises, caps and inflation are kept to a tenth of a point: 0.034 is 3.4%. */
const STEP = 0.001;
const roundRise = (n: number) => Number((Math.round(n / STEP) * STEP).toFixed(3));
const clamp = (n: number, low: number, high: number) => Math.min(Math.max(n, low), high);
/** 0.034 as "3.4%". */
export const risePercent = (n: number) => `${Math.round(n * 1000) / 10}%`;

/** The open pay review as the student sees it: the hidden fair rise and walk-away figure left out. */
export interface PayReviewView {
  quarter: number;
  /** The game year the quarter is in: above 1 only in a long game's later years. */
  year: number;
  /** The quarter's first day: the first day played at the agreed rise. */
  startDay: number;
  inflation: number;
  /** The least the student can offer, and the most staff ask. */
  minOffer: number;
  maxAsk: number;
  /** What staff are asking now: their opening ask, then their latest counter. A counter is a cash rise. */
  staffFigure: number;
  /** Each offer's worth to staff: its cash rise plus the schemes it raises, as staff value them. */
  studentOffers: number[];
  /** What made up each offer: its cash rise and the scheme levels it asked for. */
  offerTerms: PayOfferTerms[];
  /** Staff's figures: their opening ask, then each counter. */
  staffFigures: number[];
  /** The roll that answered each offer that fell short, oldest first. */
  rounds: NegotiationRound[];
  /** Offers the student has left: 3, 2, then 1 for the final offer. */
  offersLeft: number;
  /** The next offer is the last: short of a deal, the review goes to the tribunal, which charges its fee. */
  final: boolean;
  /** What the tribunal charges, every time it sits. */
  tribunalFee: number;
  /** Whether staff have countered, so there's a counter to accept. */
  canAcceptCounter: boolean;
  /** What the team costs a day now, before any rise: pay and staff schemes. */
  dailyStaffCost: number;
  /** The staff schemes, at the levels held: an offer can raise them, never lower them. */
  schemes: StaffSchemeView[];
  /** How much of a scheme's value staff count (0.7 = 70%). */
  schemeValuation: number;
  /**
   * Whether a head of people handles the review. Without one the student deals with staff directly, so staff are
   * stricter on the roll (rollBonus below 0) and want cash. Always false until the C-suite (#108) is built.
   */
  headOfPeople: boolean;
  /** Added to the d20 on each staff counter, from the people-lead modifier: below 0 is a penalty. */
  rollBonus: number;
}

/** One scheme in an offer's preview: the level offered, what that adds to its worth to staff, and its cost a day. */
export interface SchemeOfferPreview {
  id: StaffSchemeId;
  name: string;
  /** The level held now, and the level offered. */
  held: number;
  level: number;
  /** What the levels added are worth to staff, as a rise, after the valuation. */
  value: number;
  /** What it would cost a day at the offered level, at today's team after the rise. */
  costPerDay: number;
  /** Its cost a day more than now. */
  extraPerDay: number;
}

/** What offering a rise would do, before it's made: its cost, and staff's answer if it falls short of a deal. */
export interface PayOfferPreview {
  /** The cash rise. */
  rise: number;
  /** The scheme levels offered. */
  schemes: SchemeLevels;
  /** What the schemes raised are worth to staff, as a rise, after the valuation: only the increases count. */
  schemeValue: number;
  /** The offer's worth to staff: the cash rise plus schemeValue. This is what they weigh against their figure. */
  value: number;
  /** Each scheme: the level offered, its worth to staff and its cost a day. */
  schemeCosts: SchemeOfferPreview[];
  /** Share save raised: the new shares it would issue to the staff share scheme, and your stake before and after. */
  dilution: ShareSaveIssue | null;
  /** What the rise and the schemes add to the team's cost a day, and over a year of 365 days, at today's team. */
  extraPerDay: number;
  extraPerYear: number;
  /** The cash rise against inflation: below 0 is a pay cut in real terms. */
  realTerms: number;
  /** The offer is what staff are asking, so they take it: there's nothing to roll for. */
  meetsAsk: boolean;
  /**
   * If staff counter, the odds of each roll and the counter each brings. Null on the final offer, which isn't rolled,
   * and on an offer that meets their ask.
   */
  odds: CounterOdds | null;
  /** On the final offer, what the tribunal would do if it falls short of a deal. Null before, and on an offer at their ask. */
  tribunal: TribunalOdds | null;
}

/** The tribunal's three figures, its chance of picking each, and its fee. */
export interface TribunalOdds {
  fee: number;
  /** Each pick's worth to staff: the student's final offer, midway, and staff's last counter. */
  rises: Record<TribunalPick, number>;
  /**
   * The cash rise each pick sets. The student's offer and the middle keep the offer's schemes, so the middle's cash is
   * its worth less theirs; staff's figure is cash only.
   */
  cash: Record<TribunalPick, number>;
  /** The chance of each pick, 0–1, adding up to 1. */
  chances: Record<TribunalPick, number>;
}

export const TRIBUNAL_PICKS = ["student", "middle", "staff"] as const satisfies readonly TribunalPick[];

/**
 * Pay reviews: at the start of quarters 2, 3 and 4 (and in a long game's later years, every quarter) staff come to
 * the student about pay, and the clock is held until it's settled. The student offers first; staff accept an offer that reaches their hidden walk-away figure, or counter
 * with the investor negotiation's roll the other way round: staff's figure is the offer, and the student's the counter
 * it moves towards. The third offer is final: short of a deal it goes to the tribunal. The agreed rise multiplies every
 * pool's pay. See PayReviewConfig.
 */
export function createPayReview(
  config: GameConfig,
  deps: { runwayDays(state: GameState): number | null; chargeNow(state: GameState, entries: LogEntry[]): GameState },
) {
  const c = config.payReview;
  const negotiator = createNegotiation(c.negotiation);

  /** No review yet, pay at the config's rates, and the reviews' own RNG, seeded apart from the game's. */
  const startingPayReview = (
    seed: number,
  ): Pick<GameState, "payReview" | "pastPayReviews" | "payMultiplier" | "staffSchemes" | "payReviewRng"> => ({
    payReview: null,
    pastPayReviews: [],
    payMultiplier: 1,
    staffSchemes: noSchemes(),
    payReviewRng: seedRng(seed ^ 0x9a7e),
  });

  /**
   * The k-th quarter boundary of a long game (k from 1): the first day of the quarter after it, in years of
   * openEndedYearDays. k = 1 to 3 are quarters 2 to 4 of year 1; k = 4 is quarter 1 of year 2, and so on.
   */
  const longSlot = (k: number): ReviewSlot => ({
    quarter: (k % 4) + 1,
    year: Math.floor(k / 4) + 1,
    startDay: Math.floor((k * c.openEndedYearDays) / 4) + 1,
  });

  /**
   * Every pay review in the game, in order. A game of a year or less counts as one year of four quarters (its days ÷
   * 4), with reviews at the start of quarters 2, 3 and 4: days 46, 91 and 136 in a 180-day game. A long game (until IPO
   * or a career) has the same in its first year, then one at the start of every quarter (#95). With no last day
   * (until IPO), they're listed up to the end of next year.
   */
  function reviewSlots(state: GameState): ReviewSlot[] {
    if (!longGame(state)) {
      const days = state.finalDay ?? c.openEndedYearDays;
      return REVIEW_QUARTERS.map((q) => ({ quarter: q, year: 1, startDay: Math.floor(((q - 1) * days) / 4) + 1 }));
    }
    const year = c.openEndedYearDays;
    const last = state.finalDay ?? (Math.floor(state.day / year) + 2) * year;
    const slots: ReviewSlot[] = [];
    for (let k = 1; ; k++) {
      const slot = longSlot(k);
      if (slot.startDay > last) return slots;
      slots.push(slot);
    }
  }

  /** The first day of each quarter with a review, in order. */
  const quarterStarts = (state: GameState) => reviewSlots(state).map((r) => r.startDay);

  /** The review whose quarter starts on `day`, if there is one. */
  function slotStarting(state: GameState, day: number): ReviewSlot | null {
    if (!longGame(state)) return reviewSlots(state).find((r) => r.startDay === day) ?? null;
    // Worked out rather than listed, so a career's 47 years of reviews aren't listed every day.
    const near = Math.floor(((day - 1) * 4) / c.openEndedYearDays);
    for (const k of [near - 1, near, near + 1]) {
      if (k >= 1 && longSlot(k).startDay === day) return longSlot(k);
    }
    return null;
  }

  /** The review whose quarter starts on the next day to play, if any: due now, after the day just played. */
  function reviewDue(state: GameState): ReviewSlot | null {
    if (c.on !== 1 || state.status !== "playing" || state.payReview) return null;
    return slotStarting(state, state.day + 1);
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
   * Opens the review for a quarter after the day just played: rolls inflation and staff's walk-away figure on the
   * reviews' own RNG, softened by the people-lead modifier, and staff open at their ask. The clock is held until it's
   * settled.
   */
  function openReview(state: GameState, slot: ReviewSlot): { state: GameState; entries: LogEntry[] } {
    const { quarter, year } = slot;
    const lead = peopleLead(config, state);
    const [r1, rng1] = nextRandom(state.payReviewRng);
    const [r2, rng2] = nextRandom(rng1);
    const inflation = roundRise(c.inflation.min + r1 * (c.inflation.max - c.inflation.min));
    const minOffer = Math.max(0, roundRise(inflation - c.minOfferBelow));
    const maxAsk = roundRise(inflation + c.maxAskAbove);
    const fairRise = fairRiseFor(state, inflation, minOffer, maxAsk);
    const walkAway = clamp(roundRise(fairRise + c.walkAwaySpread * (2 * r2 - 1) - lead.walkAwaySoftening), minOffer, maxAsk);
    const review: PayReview = {
      quarter,
      year,
      startDay: state.day + 1,
      inflation,
      minOffer,
      maxAsk,
      fairRise,
      walkAway,
      studentOffers: [],
      offerTerms: [],
      negotiation: negotiator.open({ rise: maxAsk }),
    };
    const text =
      `Pay review: ${quarterName(review)} starts on day ${review.startDay}, and your staff want to talk about pay. ` +
      `Inflation is ${risePercent(inflation)}, and they're asking for ${risePercent(maxAsk)}. ` +
      `Make them an offer from ${risePercent(minOffer)}: the day can't go on until it's settled.` +
      (lead.headOfPeople ? "" : " You're dealing with staff directly: with no head of people, they're stricter and want cash.");
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

  /**
   * An offer checked: a cash rise from 0, rounded to a tenth of a point, and scheme levels none below those held. Its
   * worth to staff (the rise plus the schemes raised, as they value them) has to be within the caps, and once staff
   * have countered, below their figure. Refused otherwise.
   */
  function checkOffer(
    state: GameState,
    review: PayReview,
    rise: number,
    asked: Partial<SchemeLevels> | undefined,
  ): { terms: PayOfferTerms; schemeValue: number; value: number } {
    if (typeof rise !== "number" || !Number.isFinite(rise)) throw new SimError("bad_offer", "Offer a rise as a number.");
    const cash = roundRise(rise);
    if (cash < 0) throw new SimError("bad_offer", "A cash rise can't be below 0%.");
    const schemes = checkSchemes(config, state.staffSchemes, asked);
    const worth = schemeValue(config, state, state.staffSchemes, schemes);
    // Schemes add finer amounts (0.525 points for a pension level), but the offer's worth is kept to a tenth of a point
    // like every rise, so staff's counters move in the same steps.
    const value = roundRise(cash + worth);
    const withSchemes = worth > 0 ? ", with schemes as staff value them," : "";
    if (value < review.minOffer) {
      throw new SimError(
        "offer_too_low",
        `The least you can offer${withSchemes} is ${risePercent(review.minOffer)}: inflation (${risePercent(review.inflation)}) less a point. Less would be an insult.`,
        { minOffer: review.minOffer },
      );
    }
    if (value > review.maxAsk) {
      throw new SimError("offer_too_high", `Staff are asking for ${risePercent(review.maxAsk)} at most: offer that${withSchemes} or less.`, {
        maxAsk: review.maxAsk,
      });
    }
    if (review.studentOffers.length && value >= staffFigure(review)) {
      throw new SimError(
        "above_counter",
        `Staff are asking for ${risePercent(staffFigure(review))}: accept their counter rather than offer as much or more.`,
      );
    }
    return { terms: { rise: cash, schemes }, schemeValue: worth, value };
  }

  /**
   * Settles the review on a cash `rise`, which multiplies every pool's pay from the next day played, and the scheme
   * levels `schemes`, paid from the next day too. Share save raised issues its new shares to the staff share scheme
   * now, at the cap table as it stands.
   */
  function settle(
    state: GameState,
    review: PayReview,
    offers: { studentOffers: number[]; offerTerms: PayOfferTerms[] },
    outcome: PayReviewOutcome,
    rise: number,
    schemes: SchemeLevels,
    tribunal: PayReviewRecord["tribunal"] = null,
  ): GameState {
    const issue = shareSaveIssue(config, state, state.staffSchemes, schemes);
    const record: PayReviewRecord = {
      quarter: review.quarter,
      year: review.year,
      startDay: review.startDay,
      settledDay: state.day,
      inflation: review.inflation,
      minOffer: review.minOffer,
      maxAsk: review.maxAsk,
      studentOffers: offers.studentOffers,
      offerTerms: offers.offerTerms,
      staffFigures: review.negotiation.offers.map((o) => o.rise!),
      outcome,
      rise,
      schemes,
      shareSaveShares: issue?.newShares ?? 0,
      tribunal,
    };
    return {
      ...state,
      shareholders: issue ? withShareSave(state.shareholders, issue.newShares, review.startDay) : state.shareholders,
      payReview: null,
      pastPayReviews: [...state.pastPayReviews, record],
      payMultiplier: Number((state.payMultiplier * (1 + rise)).toPrecision(12)),
      staffSchemes: schemes,
    };
  }

  /**
   * The tribunal's odds on a final offer of `offered` against staff's last figure. Each pick is weighted by how far its
   * rise is from the fair rise, as a share of the gap between the two figures: the closer, the likelier, and the middle
   * likeliest when the fair rise is about halfway. The people-lead modifier's lean moves the fair rise it weighs against
   * a share of the gap towards the student's offer. See PayReviewConfig's tribunal.
   */
  function tribunalOdds(state: GameState, review: PayReview, offered: number, cash: number): TribunalOdds {
    const staff = staffFigure(review);
    const rises: Record<TribunalPick, number> = { student: offered, middle: roundRise((offered + staff) / 2), staff };
    // The schemes' share of the offer stays with the middle, which tops up the cash.
    const schemes = offered - cash;
    const cashRises: Record<TribunalPick, number> = { student: cash, middle: Math.max(0, roundRise(rises.middle - schemes)), staff };
    const gap = Math.max(staff - offered, STEP);
    const fair = review.fairRise - peopleLead(config, state).tribunalLean * gap;
    const weights = TRIBUNAL_PICKS.map((p) => Math.exp((-c.tribunal.sharpness * Math.abs(rises[p] - fair)) / gap));
    const total = weights.reduce((sum, w) => sum + w, 0);
    const chances = Object.fromEntries(TRIBUNAL_PICKS.map((p, i) => [p, weights[i]! / total])) as Record<TribunalPick, number>;
    return { fee: c.tribunal.fee, rises, cash: cashRises, chances };
  }

  /**
   * The tribunal, after a final offer short of a deal: a roll on the reviews' RNG picks the student's offer, staff's
   * figure or the middle at tribunalOdds, and its fee is charged at once. The pick is recorded: the offer's schemes
   * apply on the student's figure or the middle, but not staff's, which is cash only.
   */
  function goToTribunal(
    state: GameState,
    review: PayReview,
    offers: { studentOffers: number[]; offerTerms: PayOfferTerms[] },
  ): GameState {
    const final = offers.offerTerms.at(-1)!;
    const odds = tribunalOdds(state, review, offers.studentOffers.at(-1)!, final.rise);
    const [roll, rng] = nextRandom(state.payReviewRng);
    let below = 0;
    const pick = TRIBUNAL_PICKS.find((p) => roll < (below += odds.chances[p])) ?? "staff";
    const charged = deps.chargeNow({ ...state, payReviewRng: rng }, [
      { text: `Tribunal fee for ${quarterName(review)}'s pay review`, cashDelta: -odds.fee, category: "staff" },
    ]);
    const schemes = pick === "staff" ? state.staffSchemes : final.schemes;
    return settle(charged, review, offers, "tribunal", odds.cash[pick], schemes, { pick, fee: odds.fee, chances: odds.chances });
  }

  /**
   * Offers staff a cash `rise` and any scheme levels raised. Staff weigh its worth: the rise plus the schemes raised,
   * as they value them. At or above their walk-away figure they accept. Short of it, they counter with a cash figure,
   * with a roll on the reviews' RNG for how far they come down from their figure towards the offer, plus the
   * people-lead modifier's roll bonus (a penalty without a head of people); on the final
   * (third) offer there's no counter, and it goes to the tribunal.
   */
  function offer(state: GameState, rise: number, schemes?: Partial<SchemeLevels>): GameState {
    const review = openOrRefuse(state);
    const checked = checkOffer(state, review, rise, schemes);
    const offers = {
      studentOffers: [...review.studentOffers, checked.value],
      offerTerms: [...review.offerTerms, checked.terms],
    };
    if (checked.value >= review.walkAway) {
      return settle(state, review, offers, "offerAccepted", checked.terms.rise, checked.terms.schemes);
    }
    if (offers.studentOffers.length >= MAX_OFFERS) {
      return goToTribunal(state, review, offers);
    }
    const bonus = peopleLead(config, state).rollBonus;
    const done = negotiator.counter(review.negotiation, { rise: checked.value }, specsFor(review), state.payReviewRng, bonus);
    return { ...state, payReviewRng: done.rng, payReview: { ...review, ...offers, negotiation: done.negotiation } };
  }

  /** Accepts staff's counter: their figure is the cash rise, and no schemes are raised. */
  function acceptCounter(state: GameState): GameState {
    const review = openOrRefuse(state);
    if (!review.studentOffers.length) throw new SimError("no_counter", "Staff haven't countered yet: make them an offer first.");
    return settle(state, review, review, "counterAccepted", staffFigure(review), state.staffSchemes);
  }

  /** What the team costs a day: everyone's pay and the staff schemes held. */
  const teamCost = (state: GameState) => dailyStaffCost(config, state) + schemesCost(config, state, state.staffSchemes);

  function payReviewView(state: GameState): PayReviewView | null {
    const review = state.payReview;
    if (!review) return null;
    const offersLeft = MAX_OFFERS - review.studentOffers.length;
    const lead = peopleLead(config, state);
    return {
      quarter: review.quarter,
      year: review.year,
      startDay: review.startDay,
      inflation: review.inflation,
      minOffer: review.minOffer,
      maxAsk: review.maxAsk,
      staffFigure: staffFigure(review),
      studentOffers: review.studentOffers,
      offerTerms: review.offerTerms,
      staffFigures: review.negotiation.offers.map((o) => o.rise!),
      rounds: review.negotiation.rounds,
      offersLeft,
      final: offersLeft === 1,
      tribunalFee: c.tribunal.fee,
      canAcceptCounter: review.studentOffers.length > 0,
      dailyStaffCost: teamCost(state),
      schemes: schemeViews(config, state),
      schemeValuation: lead.schemeValuation,
      headOfPeople: lead.headOfPeople,
      rollBonus: lead.rollBonus,
    };
  }

  /**
   * What offering a cash `rise` and scheme levels would do: its worth to staff, its cost at today's team, each scheme's
   * cost a day, and the roll's odds if staff counter. Refused as offer would.
   */
  function offerPreview(state: GameState, rise: number, schemes?: Partial<SchemeLevels>): PayOfferPreview {
    const review = openOrRefuse(state);
    const { terms, schemeValue: worth, value } = checkOffer(state, review, rise, schemes);
    const after: GameState = { ...state, payMultiplier: state.payMultiplier * (1 + terms.rise), staffSchemes: terms.schemes };
    const extraPerDay = Math.round((teamCost(after) - teamCost(state)) * 100) / 100;
    const final = review.studentOffers.length + 1 >= MAX_OFFERS;
    // Only staff's opening ask can be offered in full: once they've countered, offering it is refused.
    const meetsAsk = value >= staffFigure(review);
    const valuation = schemeValuation(config, state);
    const schemeCosts = STAFF_SCHEMES.map((id): SchemeOfferPreview => {
      const costPerDay = schemeCost(config, after, id, terms.schemes[id]);
      return {
        id,
        name: config.payReview.schemes[id].name,
        held: state.staffSchemes[id],
        level: terms.schemes[id],
        value: (terms.schemes[id] - state.staffSchemes[id]) * config.payReview.schemes[id].staffValue * valuation,
        costPerDay,
        extraPerDay: Math.round((costPerDay - schemeCost(config, state, id, state.staffSchemes[id])) * 100) / 100,
      };
    });
    return {
      rise: terms.rise,
      schemes: terms.schemes,
      schemeValue: worth,
      value,
      schemeCosts,
      dilution: shareSaveIssue(config, state, state.staffSchemes, terms.schemes),
      extraPerDay,
      extraPerYear: extraPerDay * 365,
      realTerms: roundRise(terms.rise - review.inflation),
      meetsAsk,
      odds: final || meetsAsk ? null : negotiator.odds(review.negotiation, { rise: value }, specsFor(review), peopleLead(config, state).rollBonus),
      tribunal: final && !meetsAsk ? tribunalOdds(state, review, value, terms.rise) : null,
    };
  }

  /**
   * On the first day played after a review the tribunal settled, the day log says what it picked, the rise and its fee
   * (charged when it sat, in the day before).
   */
  function tribunalEntries(state: GameState, day: number): LogEntry[] {
    const last = state.pastPayReviews.at(-1);
    if (!last?.tribunal || last.startDay !== day) return [];
    const picked = { student: "your final offer", middle: "the middle", staff: "your staff's figure" }[last.tribunal.pick];
    const text =
      `The tribunal settled ${quarterName(last)}'s pay review on ${picked}: a ${risePercent(last.rise)} rise from today. ` +
      `Its fee was ${pounds(last.tribunal.fee)}.`;
    return [{ text, cashDelta: 0, kind: "staff" }];
  }

  /** On the first day played after a review that raised staff schemes, the day log says which, paid from today. */
  function schemeStartEntries(state: GameState, day: number): LogEntry[] {
    const last = state.pastPayReviews.at(-1);
    if (!last || last.startDay !== day) return [];
    const before = state.pastPayReviews.at(-2)?.schemes ?? noSchemes();
    const raised = schemeRaisesText(config, before, last.schemes);
    if (!raised) return [];
    const text = `Staff schemes from today: ${raised}. They're paid every day from now on, and can't be taken away.`;
    const entries: LogEntry[] = [{ text, cashDelta: 0, kind: "staff" }];
    if (last.shareSaveShares > 0) {
      const inIssue = state.shareholders.reduce((sum, h) => sum + h.shares, 0);
      const yours = (state.shareholders.find((h) => h.id === "student")?.shares ?? 0) / inIssue;
      const scheme = (state.shareholders.find((h) => h.id === "staffScheme")?.shares ?? 0) / inIssue;
      entries.push({
        text:
          `The staff share scheme has ${count.format(last.shareSaveShares)} new shares from share save, and owns ` +
          `${risePercent(scheme)} of the company. They dilute every holder: you own ${risePercent(yours)}.`,
        cashDelta: 0,
        kind: "staff",
      });
    }
    return entries;
  }

  return {
    startingPayReview,
    reviewSlots,
    quarterStarts,
    reviewDue,
    openReview,
    offer,
    acceptCounter,
    payReviewView,
    offerPreview,
    tribunalEntries,
    schemeStartEntries,
    teamCost,
  };
}

/**
 * The game's inflation: the open review's, or the last settled one's, as a share (0.03 = 3%). Null before the first
 * review. Drift (#95) reads it for prices.
 */
export function inflationNow(state: Pick<GameState, "payReview" | "pastPayReviews">): number | null {
  return state.payReview?.inflation ?? state.pastPayReviews.at(-1)?.inflation ?? null;
}
