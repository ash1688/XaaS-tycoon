import { describe, expect, it } from "vitest";
import { playDay, STRATEGIES } from "../scripts/harness.ts";
import { createSim, defaultConfig, SimError, type GameConfig, type GameState, type Sim, type Terms } from "../src/index.ts";
import { createNegotiation } from "../src/negotiation.ts";
import { seedRng } from "../src/rng.ts";
import { inPhase } from "./phases.ts";

// Auto-negotiate, through the sim's public interface: the student's opening counter (or pay offer) played on to the
// final offer with the same rolls and rules as countering by hand, repeating it each time. It never accepts an
// investor's offer and never takes a pay review to the tribunal. Over many seeds it does exactly as well as countering
// by hand with the same figure.

const quiet: GameConfig = { ...defaultConfig, events: [] };
const sim = createSim(quiet);
const sensible = STRATEGIES.find((s) => s.id === "sensible")!;
const begin = (s: Sim = sim, seed = 42) => s.newGame({ companyName: "Acme", productType: "social", model: "saas", seed });
const negotiator = createNegotiation(quiet.negotiation);
const SEEDS = 2000;

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return null;
};

function playUntil(s: Sim, state: GameState, done: (s: GameState) => boolean, most = 400) {
  let current = state;
  for (let i = 0; i < most && !done(current) && current.status === "playing"; i++) current = s.tick(playDay(s, current, sensible)).state;
  return current;
}

const ffTalks = (state: GameState) => sim.funding(state).negotiations.friendsAndFamily!;
const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;

/**
 * Countering friends and family by hand with the same figure every time: the student types it again on each offer,
 * or, when they've dug in and it now asks too far, as much as a counter can ask, until the final offer or until
 * there's nothing left to ask.
 */
function byHand(state: GameState, figure: Terms): GameState {
  let current = sim.applyAction(state, { type: "counterFunding", funder: "friendsAndFamily", terms: figure });
  while (!ffTalks(current).final) {
    const talks = ffTalks(current);
    // The figure in full, as the student first typed it.
    const asked = negotiator.repeatAsk(talks.offers.at(-1)!, talks.rounds[0]!.counter, talks.terms);
    if (!asked) break;
    current = sim.applyAction(current, { type: "counterFunding", funder: "friendsAndFamily", terms: asked });
  }
  return current;
}
const auto = (state: GameState, terms: Terms) =>
  sim.applyAction(state, { type: "autoNegotiateFunding", funder: "friendsAndFamily", terms });

describe("auto-negotiating a funder's offer", () => {
  const state = begin();
  const opening = ffTalks(state).offers[0]!;
  const figure = { amount: opening.amount! * 1.15, share: Math.round(opening.share! * 0.85 * 1000) / 1000 };

  it("plays every round from the student's counter to the final offer, which stands until answered", () => {
    const after = auto(state, figure);
    const talks = ffTalks(after);
    expect(talks.final).toBe(true);
    expect(talks.offers).toHaveLength(3);
    expect(talks.rounds).toHaveLength(2);
    expect(talks.rounds.every((r) => r.auto)).toBe(true);
    // The first round is the student's figure in full; the second repeats it, or asks as far towards it as it can.
    expect(talks.rounds[0]!.counter).toEqual(figure);
    expect(talks.rounds[1]!.counter).toEqual(negotiator.repeatAsk(talks.offers[1]!, figure, talks.terms));
    // It never accepts: the offer is still open, and no cash has come in.
    expect(after.funding.friendsAndFamily).toBe(state.funding.friendsAndFamily);
    expect(after.cash).toBe(state.cash);
    expect(sim.funding(after).friendsAndFamilyOffer).not.toBeNull();
  });

  it("does exactly what countering by hand with the same figure does, on every seed", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const seeded = { ...state, negotiationRng: seedRng(seed) };
      const hand = byHand(seeded, figure);
      const played = auto(seeded, figure);
      expect(ffTalks(played).offers).toEqual(ffTalks(hand).offers);
      expect(played.negotiationRng).toBe(hand.negotiationRng);
    }
  });

  it("over many seeds, ends on the same final offer on average as countering by hand", () => {
    // Different seeds for each, so it's the rolls' odds that match, not just the rolls.
    const autoFinals = Array.from({ length: SEEDS }, (_, i) => ffTalks(auto({ ...state, negotiationRng: seedRng(i + 1) }, figure)).offers.at(-1)!);
    const handFinals = Array.from(
      { length: SEEDS },
      (_, i) => ffTalks(byHand({ ...state, negotiationRng: seedRng(SEEDS + i + 1) }, figure)).offers.at(-1)!,
    );
    const spread = figure.amount - opening.amount!;
    expect(Math.abs(mean(autoFinals.map((o) => o.amount!)) - mean(handFinals.map((o) => o.amount!)))).toBeLessThan(spread * 0.05);
    const shareSpread = opening.share! - figure.share;
    expect(Math.abs(mean(autoFinals.map((o) => o.share!)) - mean(handFinals.map((o) => o.share!)))).toBeLessThan(shareSpread * 0.05);
    // A counter is never met in full on average.
    expect(mean(autoFinals.map((o) => o.amount!))).toBeLessThan(figure.amount);
  });

  it("plays only the rounds left after a counter by hand, and is refused on the final offer", () => {
    const once = sim.applyAction(state, { type: "counterFunding", funder: "friendsAndFamily", terms: { amount: opening.amount! * 1.1 } });
    const after = auto(once, { amount: ffTalks(once).offers[1]!.amount! * 1.1 });
    expect(ffTalks(after).rounds.map((r) => r.auto ?? false)).toEqual([false, true]);
    expect(ffTalks(after).final).toBe(true);
    expect(refusal(() => auto(after, { amount: opening.amount! * 2 }))).toBe("final_offer");
  });

  it("refuses an opening counter the way countering by hand does", () => {
    expect(refusal(() => auto(state, { share: opening.share! * 1.1 }))).toBe("worse_counter");
    expect(refusal(() => auto(state, { amount: opening.amount! * 3 }))).toBe("counter_too_far");
    expect(refusal(() => sim.applyAction(state, { type: "autoNegotiateFunding", funder: "grant", terms: { amount: 1 } }))).not.toBeNull();
  });
});

describe("repeating a figure after they dig in", () => {
  const specs = [
    { key: "amount", label: "cash", better: "higher" as const, step: 100 },
    { key: "share", label: "their share", better: "lower" as const, step: 0.001, min: 0.001, max: 0.999 },
  ];

  it("asks the figure while it can, then as far towards it as a counter can ask", () => {
    expect(negotiator.repeatAsk({ amount: 10_000, share: 0.1 }, { amount: 12_000, share: 0.1 }, specs)).toEqual({ amount: 12_000, share: 0.1 });
    // £16,000 on £10,000 asks 60%: it asks the most, 50%, instead.
    expect(negotiator.repeatAsk({ amount: 10_000, share: 0.1 }, { amount: 16_000, share: 0.1 }, specs)).toEqual({ amount: 15_000, share: 0.1 });
    // Scaled back on both terms, each rounded towards the offer.
    const capped = negotiator.repeatAsk({ amount: 10_000, share: 0.1 }, { amount: 14_000, share: 0.07 }, specs)!;
    expect(capped.amount).toBeLessThan(14_000);
    expect(capped.share).toBeGreaterThan(0.07);
    expect((capped.amount! - 10_000) / 10_000 + (0.1 - capped.share!) / 0.1).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it("asks nothing once the offer has reached the figure", () => {
    expect(negotiator.repeatAsk({ amount: 12_000, share: 0.1 }, { amount: 12_000, share: 0.1 }, specs)).toBeNull();
  });
});

describe("auto-negotiating an investor's offer", () => {
  const approached = playUntil(sim, begin(), (s) => sim.investors(s).offer !== null);
  const opening = sim.investors(approached).negotiation!.offers[0]!;
  const figure = { amount: Math.round(opening.amount! * 1.1), share: Math.round(opening.share! * 0.92 * 1000) / 1000 };

  it("ends on the angel's final offer, and never accepts it", () => {
    expect(sim.investors(approached).offer).not.toBeNull();
    const after = sim.applyAction(approached, { type: "autoNegotiateInvestor", terms: figure });
    const talks = sim.investors(after).negotiation!;
    expect(talks).toMatchObject({ final: true, countersLeft: 0 });
    expect(talks.rounds).toHaveLength(2);
    expect(talks.rounds.every((r) => r.auto)).toBe(true);
    expect(after.investors.angel).toBeNull();
    expect(after.cash).toBe(approached.cash);
    expect(sim.investors(after).offer!.amount).toBe(talks.offers[2]!.amount);
    // Accept and decline still answer it.
    expect(sim.applyAction(after, { type: "acceptInvestor" }).investors.angel).not.toBeNull();
    expect(sim.applyAction(after, { type: "declineInvestor" }).investors.approach).toBeNull();
  });

  it("matches countering by hand with the same figure", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const seeded = { ...approached, negotiationRng: seedRng(seed) };
      let hand = sim.applyAction(seeded, { type: "counterInvestor", terms: figure });
      const talks = sim.investors(hand).negotiation!;
      const again = negotiator.repeatAsk(talks.offers[1]!, figure, talks.terms);
      if (again) hand = sim.applyAction(hand, { type: "counterInvestor", terms: again });
      const played = sim.applyAction(seeded, { type: "autoNegotiateInvestor", terms: figure });
      expect(sim.investors(played).negotiation!.offers).toEqual(sim.investors(hand).negotiation!.offers);
    }
  });
});

describe("auto-negotiating a VC's offer", () => {
  const fast: GameConfig = {
    ...quiet,
    payReview: { ...quiet.payReview, on: 0 },
    investors: {
      ...quiet.investors,
      angel: { ...quiet.investors.angel, target: { dailyRevenue: 300, days: 3 } },
      vc: {
        ...quiet.investors.vc,
        gapDays: 5,
        targetDays: 3,
        rounds: { ...quiet.investors.vc.rounds, seriesA: { ...quiet.investors.vc.rounds.seriesA, target: { payingUsers: 0.02, dailyRevenue: 0, minUptime: 0 } } },
      },
    },
  };
  const vcSim = createSim(fast);

  it("needs a VC picked, then ends on their final offer", () => {
    const state = playUntil(vcSim, begin(vcSim), (s) => vcSim.investors(s).vc.approach !== null);
    const approach = vcSim.investors(state).vc.approach!;
    expect(refusal(() => vcSim.applyAction(state, { type: "autoNegotiateInvestor", terms: { amount: approach.offers[0]!.amount + 10_000 } }))).toBe(
      "pick_first",
    );
    const picked = vcSim.applyAction(state, { type: "pickInvestor", investor: approach.offers[0]!.investor });
    const offer = vcSim.investors(picked).vc.negotiation!.offers[0]!;
    const after = vcSim.applyAction(picked, { type: "autoNegotiateInvestor", terms: { amount: Math.round(offer.amount! * 1.1) } });
    const talks = vcSim.investors(after).vc.negotiation!;
    expect(talks.final).toBe(true);
    expect(talks.rounds.every((r) => r.auto)).toBe(true);
    expect(after.investors.vc.deals).toEqual(picked.investors.vc.deals);
  });
});

describe("auto-negotiating a pay review", () => {
  const rich: GameConfig = { ...quiet, startingCash: 10_000_000 };
  const paySim = createSim(rich);
  // Pay reviews start once Grow is open (#236).
  const review = (() => {
    let s = inPhase(begin(paySim), "grow");
    while (s.status === "playing" && !s.payReview) s = paySim.advance(s).state;
    return s;
  })();
  const view = paySim.payReview(review)!;
  const autoPay = (state: GameState, rise: number) => paySim.applyAction(state, { type: "autoNegotiatePay", rise });
  const seeded = (seed: number) => ({ ...review, payReviewRng: seedRng(seed) });

  it("settles if staff accept along the way, or ends on staff's last counter with the tribunal still to come", () => {
    let settled = 0;
    let open = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const after = autoPay(seeded(seed), view.minOffer);
      const now = paySim.payReview(after);
      if (!now) {
        settled++;
        expect(after.pastPayReviews.at(-1)!.outcome).toBe("offerAccepted");
        continue;
      }
      open++;
      // Two offers made, the same each time, and the next is final: Accept or the tribunal, by hand.
      expect(now.studentOffers).toEqual([view.minOffer, view.minOffer]);
      expect(now.rounds.every((r) => r.auto)).toBe(true);
      expect(now).toMatchObject({ final: true, canAcceptCounter: true, offersLeft: 1 });
      expect(after.pastPayReviews).toHaveLength(review.pastPayReviews.length);
      expect(refusal(() => autoPay(after, view.minOffer))).toBe("final_offer");
    }
    // The least offer usually falls short; staff's walk-away is hidden, so some seeds may settle at the ask.
    expect(open).toBeGreaterThan(0);
    expect(settled + open).toBe(200);
  });

  it("settles at once on an offer staff accept, with the schemes as set", () => {
    const after = autoPay(review, view.maxAsk);
    expect(paySim.payReview(after)).toBeNull();
    expect(after.pastPayReviews.at(-1)).toMatchObject({ outcome: "offerAccepted", rise: view.maxAsk });
  });

  /** By hand: the same offer again after staff's counter, while it's below it and the next isn't the final offer. */
  function payByHand(state: GameState, rise: number): GameState {
    let current = paySim.applyAction(state, { type: "offerPayRise", rise });
    const now = paySim.payReview(current);
    if (now && !now.final && rise < now.staffFigure) current = paySim.applyAction(current, { type: "offerPayRise", rise });
    return current;
  }
  /** Where it settles if the student then agrees staff's last counter. */
  const agreed = (state: GameState) =>
    (paySim.payReview(state) ? paySim.applyAction(state, { type: "acceptPayCounter" }) : state).pastPayReviews.at(-1)!.rise;

  it("does exactly what offering the same rise by hand does, and matches it on average over many seeds", () => {
    const rise = view.minOffer;
    for (let seed = 1; seed <= 200; seed++) {
      expect(autoPay(seeded(seed), rise)).toEqual(withAuto(payByHand(seeded(seed), rise)));
    }
    const autoRises = Array.from({ length: SEEDS }, (_, i) => agreed(autoPay(seeded(i + 1), rise)));
    const handRises = Array.from({ length: SEEDS }, (_, i) => agreed(payByHand(seeded(SEEDS + i + 1), rise)));
    expect(Math.abs(mean(autoRises) - mean(handRises))).toBeLessThan((view.maxAsk - rise) * 0.05);
  });
});

/** A state with every negotiation round marked as auto-negotiated, to compare one played by hand with one played by auto. */
function withAuto(state: GameState): GameState {
  if (!state.payReview) return state;
  const n = state.payReview.negotiation;
  return { ...state, payReview: { ...state.payReview, negotiation: { ...n, rounds: n.rounds.map((r) => ({ ...r, auto: true as const })) } } };
}
