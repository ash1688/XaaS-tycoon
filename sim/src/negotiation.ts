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
  /** The most a term can be, if a low roll pushes it the student's way: a share below the whole company. */
  max?: number;
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
  /** Played by Auto-negotiate rather than countered by hand. Left out by hand. */
  auto?: true;
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

/** A share as a percent, to a tenth where a whole percent would hide it: 50.2%, not 50%. */
const percent = (n: number) => `${Math.round(n * 1000) / 10}%`;
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
    // A counter has to move at least one term by its step, or it would spend a roll on nothing.
    let moved = false;
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
      if (gain >= spec.step - 1e-9) moved = true;
      if (was !== 0) ask += gain / Math.abs(was);
    }
    if (ask <= 1e-9) throw new SimError("empty_counter", "That counter asks for the terms already offered: ask for something better.");
    if (!moved) throw new SimError("empty_counter", "That counter asks for too little to change the offer: ask for something better.");
    if (ask > maxAsk + 1e-9) {
      throw new SimError(
        "counter_too_far",
        `That counter asks for ${percent(ask)} better terms in all; the most a counter can ask is ${percent(maxAsk)}.`,
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

  /**
   * The offer `move` of the way from `offer` to `counter`, each term rounded to its step but never past the counter. A
   * move below 0 goes the other way: the other side hardens, and the next offer is worse than the last, but never
   * outside a term's min and max (no cash below nothing).
   */
  function between(offer: Terms, counter: Terms, move: number, specs: TermSpec[]): Terms {
    const next: Terms = { ...offer };
    for (const spec of specs) {
      const from = offer[spec.key]!;
      const to = counter[spec.key]!;
      const moved = roundTo(from + (to - from) * move, spec.step);
      const kept =
        move >= 0
          ? Math.min(Math.max(moved, Math.min(from, to)), Math.max(from, to))
          : Math.min(Math.max(moved, spec.min ?? 0), spec.max ?? Infinity);
      next[spec.key] = kept;
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
    auto = false,
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
    const round: NegotiationRound = { ...checked, die, penalty, bonus, total, result, move, ...(auto ? { auto: true as const } : {}) };
    const negotiation = { offers: [...n.offers, between(offer, checked.counter, move, specs)], rounds: [...n.rounds, round] };
    return { negotiation, rng: next, round };
  }

  /**
   * What repeating the student's `figure` (a counter in full) asks of the offer that stands: the figure itself, or, if
   * the other side dug in and it now asks more than maxAsk, as far towards it as a counter can ask, each term rounded
   * back towards the offer. Null when there's nothing left to ask: the offer has reached the figure.
   */
  function repeatAsk(offer: Terms, figure: Terms, specs: TermSpec[]): Terms | null {
    const tryCheck = (terms: Terms) => {
      try {
        return { terms: check(offer, terms, specs).counter, refused: null };
      } catch (e) {
        if (e instanceof SimError) return { terms: null, refused: e };
        throw e;
      }
    };
    const first = tryCheck(figure);
    if (first.terms || first.refused?.code !== "counter_too_far") return first.terms;
    const scale = maxAsk / first.refused.details.ask!;
    const capped: Terms = { ...offer };
    for (const spec of specs) {
      const was = offer[spec.key]!;
      const gain = spec.better === "higher" ? figure[spec.key]! - was : was - figure[spec.key]!;
      if (gain <= 0) continue;
      const steps = Math.floor((gain * scale) / spec.step + 1e-9);
      capped[spec.key] = roundTo(was + (spec.better === "higher" ? 1 : -1) * steps * spec.step, spec.step);
    }
    return tryCheck(capped).terms;
  }

  /**
   * Auto-negotiate: counters with `asked` exactly as counter does, then repeats that counter in full on each offer
   * after it with the same rolls and rules, until the final offer, or until the offer reaches it and there's nothing
   * left to ask. A counter that would now ask too far (after they dug in) asks as far as it can, as repeatAsk does.
   * Never accepts: the offer it ends on stands. Refused as counter would refuse the first counter.
   */
  function auto(
    n: Negotiation,
    asked: Partial<Terms>,
    specs: TermSpec[],
    rng: number,
    bonus = 0,
  ): { negotiation: Negotiation; rng: number; rounds: NegotiationRound[] } {
    let done = counter(n, asked, specs, rng, bonus, true);
    const figure = done.round.counter;
    while (!isFinal(done.negotiation)) {
      const again = repeatAsk(latest(done.negotiation), figure, specs);
      if (!again) break;
      done = counter(done.negotiation, again, specs, done.rng, bonus, true);
    }
    return { negotiation: done.negotiation, rng: done.rng, rounds: done.negotiation.rounds.slice(n.rounds.length) };
  }

  return { open, latest, isFinal, countersLeft, odds, counter, repeatAsk, auto };
}

export type Negotiator = ReturnType<typeof createNegotiation>;
