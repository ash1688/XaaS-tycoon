import { gameDate } from "./calendar.ts";
import type { GameConfig } from "./config.ts";
import { noSchemes, schemeViews, STAFF_SCHEMES, type StaffSchemeId, type StaffSchemeView } from "./staffSchemes.ts";
import type { GameState, PayReviewOutcome, TribunalPick } from "./state.ts";

/** A scheme a pay review raised: from the level held before it to the level after. */
export interface SchemeRaise {
  id: StaffSchemeId;
  name: string;
  from: number;
  to: number;
  /** A yes/no scheme (death in service, discount) rather than a slider. */
  toggle: boolean;
}

/** One settled pay review in the pay history, as the student sees it. */
export interface PayHistoryEntry {
  quarter: number;
  /** The quarter's first day, the first played at the rise, and its date: "Mon 1 Apr 2026". */
  startDay: number;
  date: string;
  /** The day played when it was settled. */
  settledDay: number;
  inflation: number;
  /** The offers the student made: 1 to 3. */
  offers: number;
  /** Each offer's worth to staff, and staff's figures: their opening ask, then each counter. */
  studentOffers: number[];
  staffFigures: number[];
  outcome: PayReviewOutcome;
  /** What the tribunal picked, or null when it didn't sit. */
  tribunalPick: TribunalPick | null;
  /** The tribunal's fee: 0 when it didn't sit. */
  tribunalFee: number;
  /** The cash rise agreed, 0.04 = 4%, and how far it was above inflation (below when negative). */
  rise: number;
  realTerms: number;
  /** The schemes it raised: none on an accepted counter or a tribunal's pick of staff's figure, which are cash only. */
  schemeRaises: SchemeRaise[];
  /** The new shares share save issued to the staff share scheme: 0 if it wasn't raised. */
  shareSaveShares: number;
  /** Pay as a multiple of the day rates after it: every rise so far, compounded. */
  payMultiplier: number;
}

/** The staff share scheme's holding: the shares share save has issued it, and its share of the company. */
export interface StaffShareSchemeView {
  shares: number;
  share: number;
}

/** The pay history: every settled review, the schemes held now and their cost, and when the next review comes. */
export interface PayHistoryView {
  /** Oldest first. Empty before the first review is settled. */
  reviews: PayHistoryEntry[];
  /** Every rise so far, compounded: pay as a multiple of the day rates. 1 before the first. */
  payMultiplier: number;
  /** The tribunal fees paid in all. */
  tribunalFees: number;
  /** Each scheme at the level held, with its cost a day at today's team. */
  schemes: StaffSchemeView[];
  /** What the schemes held cost a day in all. */
  schemesCostPerDay: number;
  /** Null until share save has issued shares. */
  staffShareScheme: StaffShareSchemeView | null;
  /** The next review: its quarter and the day it starts. Null when none is still to come, or reviews are off. */
  nextReview: { quarter: number; startDay: number } | null;
}

/**
 * The pay history from the reviews settled so far. Read-only: it changes nothing. `reviewDays` are the days quarters 2,
 * 3 and 4 start, with `reviewQuarters` their quarters.
 */
export function payHistory(
  config: GameConfig,
  state: GameState,
  reviewDays: number[],
  reviewQuarters: readonly number[],
): PayHistoryView {
  let multiplier = 1;
  let held = noSchemes();
  const reviews = state.pastPayReviews.map((r): PayHistoryEntry => {
    multiplier = Number((multiplier * (1 + r.rise)).toPrecision(12));
    const schemeRaises = STAFF_SCHEMES.filter((id) => r.schemes[id] > held[id]).map((id): SchemeRaise => {
      const s = config.payReview.schemes[id];
      return { id, name: s.name, from: held[id], to: r.schemes[id], toggle: s.maxLevel === 1 };
    });
    held = r.schemes;
    return {
      quarter: r.quarter,
      startDay: r.startDay,
      date: gameDate(state, r.startDay).text,
      settledDay: r.settledDay,
      inflation: r.inflation,
      offers: r.studentOffers.length,
      studentOffers: r.studentOffers,
      staffFigures: r.staffFigures,
      outcome: r.outcome,
      tribunalPick: r.tribunal?.pick ?? null,
      tribunalFee: r.tribunal?.fee ?? 0,
      rise: r.rise,
      realTerms: Number((r.rise - r.inflation).toFixed(6)),
      schemeRaises,
      shareSaveShares: r.shareSaveShares,
      payMultiplier: multiplier,
    };
  });
  const schemes = schemeViews(config, state);
  const shares = state.shareholders.reduce((sum, h) => sum + h.shares, 0);
  const theirs = state.shareholders.find((h) => h.id === "staffScheme")?.shares ?? 0;
  // A review opens once the day before its quarter is played, so one starting tomorrow is open now or settled.
  const i = config.payReview.on === 1 ? reviewDays.findIndex((d) => d > state.day + 1) : -1;
  const startDay = reviewDays[i];
  const beforeEnd = startDay !== undefined && (state.finalDay === null || startDay <= state.finalDay);
  return {
    reviews,
    payMultiplier: state.payMultiplier,
    tribunalFees: reviews.reduce((sum, r) => sum + r.tribunalFee, 0),
    schemes,
    schemesCostPerDay: schemes.reduce((sum, s) => sum + s.costPerDay, 0),
    staffShareScheme: theirs > 0 ? { shares: theirs, share: theirs / shares } : null,
    nextReview: beforeEnd ? { quarter: reviewQuarters[i]!, startDay } : null,
  };
}
