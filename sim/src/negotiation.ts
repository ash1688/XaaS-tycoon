import type { NegotiationConfig } from "./config.ts";
import { nextRandom } from "./rng.ts";
import { SimError } from "./state.ts";

/** An offer's terms by name, such as cash, a share of the company or the days a condition runs. */
export type Terms = Record<string, number>;

/** One term an offer can be negotiated on, and which way is better for the student. */
export interface TermSpec {
  key: string;
  /** For messages: "cash", "their share". */
  label: string;
  /** "higher" when more is better for the student (cash); "lower" when less is (a share given up, a condition's days). */
  better: "higher" | "lower";
  /** New offers are rounded to this: 100 for the nearest £100, 0.001 for a tenth of a percent, 1 for a whole day. */
  step: number;
  /** The least a counter can ask for, on a term where lower is better: a share above nothing, at least a day. */
  min?: number;
}

export type RollResult = "high" | "middle" | "low";
export const ROLL_RESULTS = ["high", "middle", "low"] as const;

/** A counter and the roll that answered it. */
export interface NegotiationRound {
  /** The terms the student asked for, in full. */
  counter: Terms;
  /** How far it asked: each term's change in the student's favour as a share of the offer's, added up. */
  ask: number;
  /** The die as it fell, 1 to dieSides. */
  die: number;
  /** Pips off for asking a lot, and on for any bonus (a CFO, later). */
  penalty: number;
  bonus: number;
  /** die − penalty + bonus. */
  total: number;
  result: RollResult;
  /** Share of the way from the offer to the counter that the next offer moved. */
  move: number;
}

/**
 * An offer being negotiated: the offers so far, oldest first, and the rounds between them. The first offer is the
 * other side's opening, and the last always stands until the student accepts or declines it. The third is final.
 */
export interface Negotiation {
  offers: Terms[];
  rounds: NegotiationRound[];
}

/** What a counter would do, before it's made: its odds, and the next offer on each kind of roll. */
export interface CounterOdds {
  counter: Terms;
  ask: number;
  maxAsk: number;
  penalty: number;
  bonus: number;
  /** The chance of each kind of roll, 0–1, adding up to 1. */
  chances: Record<RollResult, number>;
  /** The next offer each kind of roll would bring. */
  outcomes: Record<RollResult, Terms>;
}

/** The most offers a negotiation has: the opening, and one after each of two counters. */
export const MAX_OFFERS = 3;

const roundTo = (n: number, step: number) => Number((Math.round(n / step) * step).toPrecision(12));

/**
 * Negotiation, shared by every kind of offer: funders now, and investors, deals and renewals later. Each caller says
 * what its terms are (TermSpec) and keeps the Negotiation and the RNG in its own state. See NegotiationConfig.
 */
export function createNegotiation(config: NegotiationConfig) {
  const { dieSides, highFrom, middleFrom, greedPenalty, maxAsk, moves } = config;

  /** A negotiation opened on the other side's first offer. Nothing is rolled until the student counters. */
  const open = (offer: Terms): Negotiation => ({ offers: [{ ...offer }], rounds: [] });

  /** The offer that stands now. */
  const latest = (n: Negotiation): Terms => n.offers[n.offers.length - 1]!;

  /** Offer 3 is final: take it or leave it. */
  const isFinal = (n: Negotiation) => n.offers.length >= MAX_OFFERS;

  /** Counters still to make: 2, 1, then 0 on the final offer. */
  const countersLeft = (n: Negotiation) => MAX_OFFERS - n.offers.length;

  /**
   * The counter in full, with any term left out at the offer's, and how far it asks. Refused if it asks for worse terms
   * on any of them, for nothing at all, or for more than maxAsk.
   */
  function check(offer: Terms, asked: Partial<Terms>, specs: TermSpec[]): { counter: Terms; ask: number } {
    const counter: Terms = { ...offer };
    let ask = 0;
    for (const spec of specs) {
      const value = asked[spec.key] ?? offer[spec.key]!;
      const was = offer[spec.key]!;
      if (!Number.isFinite(value)) throw new SimError("bad_counter", `Give ${spec.label} as a number.`);
      const gain = spec.better === "higher" ? value - was : was - value;
      if (gain < -1e-9) {
        throw new SimError(
          "worse_counter",
          `A counter asks for better terms: ${spec.label} can't be ${spec.better === "higher" ? "lower" : "higher"} than offered.`,
        );
      }
      if (spec.min !== undefined && value < spec.min) {
        throw new SimError("bad_counter", `${spec.label[0]!.toUpperCase()}${spec.label.slice(1)} can't go below ${spec.min}.`);
      }
      counter[spec.key] = value;
      if (was !== 0) ask += gain / Math.abs(was);
    }
    if (ask <= 1e-9) throw new SimError("empty_counter", "That counter asks for the terms already offered: ask for something better.");
    if (ask > maxAsk + 1e-9) {
      throw new SimError(
        "counter_too_far",
        `That counter asks for ${Math.round(ask * 100)}% better terms in all; the most a counter can ask is ${Math.round(maxAsk * 100)}%.`,
        { ask, maxAsk },
      );
    }
    return { counter, ask };
  }

  const penaltyFor = (ask: number) => Math.round(ask * greedPenalty);

  function resultOf(total: number): RollResult {
    if (total >= highFrom) return "high";
    if (total >= middleFrom) return "middle";
    return "low";
  }

  /** The offer `move` of the way from `offer` to `counter`, each term rounded to its step but never past the counter. */
  function between(offer: Terms, counter: Terms, move: number, specs: TermSpec[]): Terms {
    const next: Terms = { ...offer };
    for (const spec of specs) {
      const from = offer[spec.key]!;
      const to = counter[spec.key]!;
      const moved = roundTo(from + (to - from) * move, spec.step);
      next[spec.key] = Math.min(Math.max(moved, Math.min(from, to)), Math.max(from, to));
    }
    return next;
  }

  function refuseIfFinal(n: Negotiation) {
    if (isFinal(n)) throw new SimError("final_offer", "This is the final offer: accept it or decline it.");
  }

  /** What countering the offer that stands with `asked` would do: the odds on the roll and each outcome. */
  function odds(n: Negotiation, asked: Partial<Terms>, specs: TermSpec[], bonus = 0): CounterOdds {
    refuseIfFinal(n);
    const offer = latest(n);
    const { counter, ask } = check(offer, asked, specs);
    const penalty = penaltyFor(ask);
    const chances: Record<RollResult, number> = { high: 0, middle: 0, low: 0 };
    for (let die = 1; die <= dieSides; die++) chances[resultOf(die - penalty + bonus)] += 1 / dieSides;
    const outcomes = Object.fromEntries(ROLL_RESULTS.map((r) => [r, between(offer, counter, moves[r], specs)])) as Record<
      RollResult,
      Terms
    >;
    return { counter, ask, maxAsk, penalty, bonus, chances, outcomes };
  }

  /**
   * Counters the offer that stands with `asked` (terms left out stay as offered): rolls the die on `rng`, less the
   * penalty for how far it asks, plus `bonus`, and the other side answers with the next offer. Refused on the final
   * offer. The other side never walks away.
   */
  function counter(
    n: Negotiation,
    asked: Partial<Terms>,
    specs: TermSpec[],
    rng: number,
    bonus = 0,
  ): { negotiation: Negotiation; rng: number; round: NegotiationRound } {
    refuseIfFinal(n);
    const offer = latest(n);
    const checked = check(offer, asked, specs);
    const [r, next] = nextRandom(rng);
    const die = 1 + Math.floor(r * dieSides);
    const penalty = penaltyFor(checked.ask);
    const total = die - penalty + bonus;
    const result = resultOf(total);
    const move = moves[result];
    const round: NegotiationRound = { ...checked, die, penalty, bonus, total, result, move };
    const negotiation = { offers: [...n.offers, between(offer, checked.counter, move, specs)], rounds: [...n.rounds, round] };
    return { negotiation, rng: next, round };
  }

  return { open, latest, isFinal, countersLeft, odds, counter };
}

export type Negotiator = ReturnType<typeof createNegotiation>;
