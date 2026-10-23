import { describe, expect, it } from "vitest";
import { createSim, defaultConfig, SimError, type GameConfig, type GameState } from "../src/index.ts";
import { createNegotiation } from "../src/negotiation.ts";

// Negotiating friends and family's and the grant's offers, through the sim's public interface: offer 1, a counter and
// a roll, offer 2, another counter and roll, and a final offer 3.

const quiet: GameConfig = { ...defaultConfig, events: [] };
const sim = createSim(quiet);
const begin = (seed = 42) => sim.newGame({ companyName: "Acme", productType: "social", model: "saas", seed });
const { moves } = quiet.negotiation;

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return null;
};

const counterFf = (state: GameState, terms: { amount?: number; share?: number }) =>
  sim.applyAction(state, { type: "counterFunding", funder: "friendsAndFamily", terms });
const counterGrant = (state: GameState, terms: { amount?: number; days?: number }) =>
  sim.applyAction(state, { type: "counterFunding", funder: "grant", terms });
type FfTerms = { amount: number; share: number };
/** Friends and family's negotiation, its offers typed with their terms. */
const ffTalks = (state: GameState) => {
  const talks = sim.funding(state).negotiations.friendsAndFamily!;
  return { ...talks, offers: talks.offers as FfTerms[] };
};

describe("negotiating friends and family's offer", () => {
  it("opens on today's fixed offer, with two counters to come", () => {
    const state = begin();
    const offer = sim.funding(state).friendsAndFamilyOffer!;
    const talks = ffTalks(state);
    expect(talks.offers).toEqual([{ amount: offer.amount, share: offer.theirShare }]);
    expect(talks.rounds).toEqual([]);
    expect(talks.countersLeft).toBe(2);
    expect(talks.final).toBe(false);
  });

  it("answers a counter with a roll that moves the next offer part of the way towards it", () => {
    const state = begin();
    const [opening] = ffTalks(state).offers;
    const ask = { amount: opening!.amount * 1.1, share: opening!.share * 0.9 };
    const after = counterFf(state, ask);
    const talks = ffTalks(after);
    const [round] = talks.rounds;
    expect(talks.offers).toHaveLength(2);
    expect(round!.ask).toBeCloseTo(0.2);
    expect(round!.penalty).toBe(6);
    expect(round!.total).toBe(round!.die - round!.penalty + round!.bonus);
    expect(round!.move).toBe(moves[round!.result]);
    // Offer 2 is that share of the way from offer 1 to the counter, to the nearest £100 and 0.1%.
    const offer2 = talks.offers[1]!;
    expect(offer2.amount).toBeCloseTo(opening!.amount + round!.move * (ask.amount - opening!.amount), -2);
    expect(offer2.share).toBeCloseTo(opening!.share + round!.move * (ask.share - opening!.share), 3);
    expect(offer2.amount).toBeGreaterThan(opening!.amount);
    expect(offer2.share).toBeLessThan(opening!.share);
    // The offer the panel shows is the one that stands.
    expect(sim.funding(after).friendsAndFamilyOffer!.amount).toBe(offer2.amount);
    expect(sim.funding(after).friendsAndFamilyOffer!.theirShare).toBeCloseTo(offer2.share, 3);
  });

  it("makes offer 3 final after a second counter", () => {
    let state = begin();
    state = counterFf(state, { share: ffTalks(state).offers[0]!.share * 0.8 });
    state = counterFf(state, { share: ffTalks(state).offers[1]!.share * 0.8 });
    const talks = ffTalks(state);
    expect(talks.offers).toHaveLength(3);
    expect(talks.final).toBe(true);
    expect(talks.countersLeft).toBe(0);
    const lower = { share: ffTalks(state).offers[2]!.share * 0.9 };
    expect(refusal(() => counterFf(state, lower))).toBe("final_offer");
    expect(refusal(() => sim.counterOdds(state, "friendsAndFamily", lower))).toBe("final_offer");
  });

  it("keeps the latest offer standing until it's answered: days go by and the valuation moves, the offer doesn't", () => {
    let state = counterFf(begin(), { amount: 18_000 });
    const standing = sim.funding(state).friendsAndFamilyOffer!;
    state = sim.advance(state, 20).state;
    expect(sim.valuation(state).valuation).not.toBe(standing.valuation);
    const later = sim.funding(state).friendsAndFamilyOffer!;
    expect(later.amount).toBe(standing.amount);
    expect(later.theirShare).toBe(standing.theirShare);
    expect(later.newShares).toBe(standing.newShares);
  });

  it("never walks away: even a greedy counter rolled low leaves an offer to accept, no worse than before", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const state = begin(seed);
      const [opening] = ffTalks(state).offers;
      const after = counterFf(state, { amount: opening!.amount * 1.5 });
      expect(sim.funding(after).friendsAndFamilyOffer).not.toBeNull();
      expect(ffTalks(after).offers[1]!.amount).toBeGreaterThanOrEqual(opening!.amount);
    }
  });

  it("accepts the offer that stands: the cash, and new shares that leave them the negotiated share", () => {
    let state = begin();
    const shares = sim.capTable(state).sharesInIssue;
    state = counterFf(state, { share: ffTalks(state).offers[0]!.share * 0.7 });
    const standing = sim.funding(state).friendsAndFamilyOffer!;
    const cash = state.cash;
    state = sim.applyAction(state, { type: "acceptFunding", funder: "friendsAndFamily" });
    expect(state.cash).toBe(cash + standing.amount);
    const table = sim.capTable(state);
    expect(table.sharesInIssue).toBe(shares + standing.newShares);
    expect(table.rows[1]!.share).toBeCloseTo(standing.theirShare, 6);
    expect(table.rows[0]!.share).toBeCloseTo(standing.yourShareAfter, 6);
    expect(state.funding.friendsAndFamily).toMatchObject({ status: "accepted", amount: standing.amount, shares: standing.newShares });
    expect(sim.funding(state).negotiations.friendsAndFamily).toBeNull();
    expect(state.funding.negotiating.friendsAndFamily).toBeNull();
  });

  it("can still be declined for good part-way through", () => {
    let state = counterFf(begin(), { amount: 16_000 });
    state = sim.applyAction(state, { type: "declineFunding", funder: "friendsAndFamily" });
    expect(state.funding.friendsAndFamily?.status).toBe("declined");
    expect(sim.funding(state).negotiations.friendsAndFamily).toBeNull();
    expect(refusal(() => counterFf(state, { amount: 17_000 }))).toBe("funding_answered");
  });

  it("refuses counters that ask for worse terms, nothing, too much, or terms the offer doesn't have", () => {
    const state = begin();
    const [opening] = ffTalks(state).offers;
    expect(refusal(() => counterFf(state, { amount: opening!.amount - 1_000 }))).toBe("worse_counter");
    expect(refusal(() => counterFf(state, { share: opening!.share + 0.05 }))).toBe("worse_counter");
    expect(refusal(() => counterFf(state, {}))).toBe("empty_counter");
    expect(refusal(() => counterFf(state, { amount: opening!.amount }))).toBe("empty_counter");
    expect(refusal(() => counterFf(state, { amount: opening!.amount * 1.3, share: opening!.share * 0.7 }))).toBe("counter_too_far");
    expect(refusal(() => sim.applyAction(state, { type: "counterFunding", funder: "friendsAndFamily", terms: { days: 30 } }))).toBe(
      "bad_counter",
    );
    expect(refusal(() => counterFf(state, { amount: Number.NaN }))).toBe("bad_counter");
    // Less than a step on every term would spend a roll on nothing.
    expect(refusal(() => counterFf(state, { amount: opening!.amount + 0.5 }))).toBe("empty_counter");
    // Just over the most is said as such, not rounded down to it.
    expect(() => counterFf(state, { share: opening!.share * 0.498 })).toThrow(/asks for 50.2% better terms in all; the most a counter can ask is 50%/);
  });

  it("doesn't change the rest of the game: the game's own random sequence is untouched", () => {
    const state = begin();
    const after = counterFf(state, { amount: 17_000 });
    expect(after.rng).toBe(state.rng);
    expect(after.negotiationRng).not.toBe(state.negotiationRng);
    // Played on, the company's users are the same as if it had never negotiated.
    expect(sim.advance(after, 15).state.users).toBe(sim.advance(state, 15).state.users);
  });
});

describe("rolls", () => {
  it("are seeded: the same game and counters roll the same, a different seed may not", () => {
    const play = (seed: number) => {
      let state = counterFf(begin(seed), { amount: 17_000 });
      state = counterFf(state, { amount: 18_000 });
      return ffTalks(state).rounds.map((r) => r.die);
    };
    expect(play(42)).toEqual(play(42));
    const all = new Set(Array.from({ length: 10 }, (_, i) => play(i + 1).join(",")));
    expect(all.size).toBeGreaterThan(1);
  });

  it("get worse odds the further a counter is from the offer", () => {
    const state = begin();
    const [opening] = ffTalks(state).offers;
    const modest = sim.counterOdds(state, "friendsAndFamily", { amount: opening!.amount * 1.05 });
    const greedy = sim.counterOdds(state, "friendsAndFamily", { amount: opening!.amount * 1.4 });
    expect(modest.ask).toBeCloseTo(0.05);
    expect(greedy.ask).toBeCloseTo(0.4);
    expect(greedy.penalty).toBeGreaterThan(modest.penalty);
    expect(greedy.chances.high).toBeLessThan(modest.chances.high);
    expect(greedy.chances.low).toBeGreaterThan(modest.chances.low);
    for (const odds of [modest, greedy]) {
      expect(odds.chances.high + odds.chances.middle + odds.chances.low).toBeCloseTo(1);
    }
    // At the defaults (a d20, high from 14, middle from 7, 3 pips off per 10%): 5% asked is 2 pips off.
    expect(modest.chances).toEqual({ high: expect.closeTo(0.25), middle: expect.closeTo(0.35), low: expect.closeTo(0.4) });
    // Each outcome is the offer that kind of roll would bring.
    const { high, middle, low } = modest.outcomes;
    expect(high.amount!).toBeGreaterThan(middle.amount!);
    expect(middle.amount!).toBeGreaterThan(low.amount!);
  });

  it("come out worse for greedy counters over many games, as the odds say", () => {
    const highs = (factor: number) => {
      let n = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const state = begin(seed);
        const after = counterFf(state, { amount: ffTalks(state).offers[0]!.amount * factor });
        if (ffTalks(after).rounds[0]!.result !== "low") n++;
      }
      return n;
    };
    expect(highs(1.4)).toBeLessThan(highs(1.05));
  });

  it("take a bonus on top, which improves the odds", () => {
    const negotiation = createNegotiation(quiet.negotiation);
    const talks = negotiation.open({ amount: 10_000 });
    const terms = [{ key: "amount", label: "the cash", better: "higher" as const, step: 100 }];
    const without = negotiation.odds(talks, { amount: 13_000 }, terms);
    const withBonus = negotiation.odds(talks, { amount: 13_000 }, terms, 4);
    expect(withBonus.chances.high).toBeGreaterThan(without.chances.high);
    const rolled = negotiation.counter(talks, { amount: 13_000 }, terms, 7, 4);
    expect(rolled.round.bonus).toBe(4);
    expect(rolled.round.total).toBe(rolled.round.die - rolled.round.penalty + 4);
  });
});

describe("negotiating the grant", () => {
  it("negotiates its cash and the days its condition runs, and accepting holds it to the offer that stands", () => {
    let state = begin();
    const opening = sim.funding(state).grantOffer!;
    expect(sim.funding(state).negotiations.grant!.offers).toEqual([{ amount: opening.amount, days: opening.days }]);
    state = counterGrant(state, { amount: opening.amount * 1.1, days: Math.round(opening.days * 0.8) });
    const standing = sim.funding(state).grantOffer!;
    const offer2 = sim.funding(state).negotiations.grant!.offers[1] as { amount: number; days: number };
    expect(standing.amount).toBe(offer2.amount);
    expect(standing.days).toBe(offer2.days);
    expect(standing.days).toBeLessThan(opening.days);
    // Fewer days allow fewer hours down in all.
    expect(standing.maxHoursDown).toBeLessThan(opening.maxHoursDown);
    const cash = state.cash;
    state = sim.applyAction(state, { type: "acceptFunding", funder: "grant" });
    expect(state.cash).toBe(cash + standing.amount);
    expect(state.funding.grant).toMatchObject({ amount: standing.amount, days: standing.days, maxHoursDown: standing.maxHoursDown });
  });

  it("negotiates apart from friends and family", () => {
    let state = counterGrant(begin(), { amount: 11_000 });
    expect(sim.funding(state).negotiations.grant!.rounds).toHaveLength(1);
    expect(sim.funding(state).negotiations.friendsAndFamily!.rounds).toHaveLength(0);
    state = counterFf(state, { amount: 16_000 });
    expect(sim.funding(state).negotiations.grant!.countersLeft).toBe(1);
    expect(sim.funding(state).negotiations.friendsAndFamily!.countersLeft).toBe(1);
  });
});
