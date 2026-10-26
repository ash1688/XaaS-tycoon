import { describe, expect, it } from "vitest";
import { playDay, STRATEGIES } from "../scripts/harness.ts";
import {
  createSim,
  defaultConfig,
  SERIES_IDS,
  SimError,
  VC_LEANS,
  type DayLog,
  type GameConfig,
  type GameLengthId,
  type GameState,
  type PauseReason,
  type SeriesId,
  type Sim,
} from "../src/index.ts";

// Venture capital, Series A–D, through the sim's public interface: each round approaching at its hidden target with
// three offers, their leans, picking one (which closes the others), declining or failing (three new VCs), accepting
// (the valuation follows the chosen VC), the lead VC returning, and the IPO needing
// only Series A to have approached (when the last C-suite roles open). Played as 1-year games, which have all four
// rounds; a 180-day game's two merged rounds are at the end.

const vc = defaultConfig.investors.vc;
/** Low targets, a short gap and an early angel, so every round comes within a game. */
const fast: GameConfig = {
  ...defaultConfig,
  allowedGameLengths: { ...defaultConfig.allowedGameLengths, "1-year": 1, "until-ipo": 1, career: 1 },
  events: [],
  payReview: { ...defaultConfig.payReview, on: 0 },
  investors: {
    ...defaultConfig.investors,
    angel: { ...defaultConfig.investors.angel, target: { dailyRevenue: 300, days: 3 } },
    vc: {
      ...vc,
      gapDays: 5,
      targetDays: 3,
      rounds: {
        seriesA: { ...vc.rounds.seriesA, target: { payingUsers: 0.02, dailyRevenue: 0, minUptime: 0 } },
        seriesB: { ...vc.rounds.seriesB, target: { payingUsers: 0, dailyRevenue: 0.05, minUptime: 0 } },
        seriesC: { ...vc.rounds.seriesC, target: { payingUsers: 0.04, dailyRevenue: 0, minUptime: 95 } },
        seriesD: { ...vc.rounds.seriesD, target: { payingUsers: 0.05, dailyRevenue: 0.07, minUptime: 0 } },
      },
    },
  },
};
const sim = createSim(fast);
/** As `fast`, but no round after `last` ever comes, so nothing cuts short its retries. */
function stopAfter(last: SeriesId): Sim {
  const rounds = { ...fast.investors.vc.rounds };
  for (const round of SERIES_IDS.slice(SERIES_IDS.indexOf(last) + 1)) {
    rounds[round] = { ...rounds[round], target: { payingUsers: 1, dailyRevenue: 1, minUptime: 0 } };
  }
  return createSim({ ...fast, investors: { ...fast.investors, vc: { ...fast.investors.vc, rounds } } });
}
const onlyA = stopAfter("seriesA");
const sensible = STRATEGIES.find((s) => s.id === "sensible")!;
const begin = (s: Sim = sim, seed = 42, gameLength: GameLengthId = "1-year") =>
  s.newGame({ companyName: "Acme", productType: "social", model: "saas", seed, gameLength });

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return null;
};

/** Plays the sensible bot (which answers no investor) a tick at a time until `done`, keeping the log and every pause. */
function playUntil(s: Sim, state: GameState, done: (s: GameState) => boolean, most = 250) {
  const log: DayLog[] = [];
  const pauses: { day: number; reason: PauseReason }[] = [];
  let current = state;
  for (let i = 0; i < most && !done(current) && current.status === "playing"; i++) {
    const t = s.tick(playDay(s, current, sensible));
    current = t.state;
    log.push(...t.log);
    pauses.push(...t.pauses.map((reason) => ({ day: current.day, reason })));
  }
  return { state: current, log, pauses };
}

/** VCs waiting on an answer for `round`. */
const vcsFor = (s: Sim, round: SeriesId) => (state: GameState) => s.investors(state).vc.approach?.round === round;
/** A game played until `round`'s VCs approach. */
const until = (round: SeriesId, s: Sim = sim, state: GameState = begin(s)) => playUntil(s, state, vcsFor(s, round));

/** The day, by the record of days played, a round's hidden target first held on or after `from`. */
function targetDay(config: GameConfig, state: GameState, round: SeriesId, from: number): number {
  const t = config.investors.vc.rounds[round].target;
  const bar = config.ipo.products[state.productType];
  const days = config.investors.vc.targetDays;
  for (const d of state.spendByDay) {
    if (d.day < from || d.day - state.launchDay! < days) continue;
    const recent = state.spendByDay.filter((x) => x.day > d.day - days && x.day <= d.day);
    const income = recent.reduce((sum, x) => sum + x.income, 0) / days;
    const uptime = 100 * (1 - recent.reduce((sum, x) => sum + x.hoursDown, 0) / (recent.length * 24));
    if (t.payingUsers && d.paidUsers < t.payingUsers * bar.payingUsers) continue;
    if (t.dailyRevenue && income < (t.dailyRevenue * bar.annualRevenue) / 365) continue;
    if (t.minUptime && uptime < t.minUptime) continue;
    return d.day;
  }
  throw new Error(`${round}'s target never held`);
}

/**
 * A sim where every IPO condition but the C-suite is easy, otherwise playing as `fast`. The rounds' targets are shares of
 * the IPO bar it zeroes, so each round comes as soon as the round before allows.
 */
const easyIpo = createSim({
  ...fast,
  ipo: {
    ...fast.ipo,
    minTradingDays: 0,
    recordDays: 2,
    minUptime: 0,
    minSatisfaction: 0,
    maxCostSwing: 100,
    products: { ...fast.ipo.products, social: { ...fast.ipo.products.social, users: 0, annualRevenue: 0, payingUsers: 0 } },
  },
});

describe("the rounds approaching", () => {
  it("brings no VCs before the angel, then Series A's three, a few days after its target is hit", () => {
    const { state, log, pauses } = until("seriesA");
    const angelDay = state.investors.firstApproachDay!;
    const a = sim.investors(state).vc.approach!;
    expect(a).toMatchObject({ round: "seriesA", name: "Series A", day: state.day, picked: null, lastDay: state.day + 2, daysLeft: 3 });
    // The target counts from gapDays after the angel's approach, and they come approachDays after it holds.
    expect(state.day).toBe(targetDay(fast, state, "seriesA", angelDay + fast.investors.vc.gapDays) + fast.investors.approachDays);
    expect(sim.investors(state).vc.rounds.map((r) => r.firstApproachDay)).toEqual([state.day, null, null, null]);
    expect(a.offers).toHaveLength(3);
    expect(new Set(a.offers.map((o) => o.investor)).size).toBe(3);
    for (const o of a.offers) {
      expect(VC_LEANS).toContain(o.lean);
      expect(o).toMatchObject({ status: "open", lead: false });
      expect(o.amount).toBeGreaterThanOrEqual(vc.rounds.seriesA.minAmount);
      expect(o.amount).toBeLessThanOrEqual(vc.rounds.seriesA.maxAmount);
      expect(o.yourShareAfter).toBeCloseTo(a.yourShareBefore * (1 - o.theirShare), 5);
    }
    expect(pauses.at(-1)).toMatchObject({ day: state.day, reason: { kind: "offer", id: "offer-seriesA" } });
    // Last but for the C-suite roles Series A opens.
    expect(log.at(-1)!.entries.filter((e) => !e.text.startsWith("You can hire a")).at(-1)!.text).toMatch(
      /^Series A: three venture capitalists want to invest in Acme\./,
    );
  });

  it("leans each VC's offer: most cash asks the most, least ownership the least and values the company highest", () => {
    // Fixed ranges, so only the lean moves an offer.
    const fixed = createSim({
      ...fast,
      investors: {
        ...fast.investors,
        vc: {
          ...fast.investors.vc,
          rounds: { ...fast.investors.vc.rounds, seriesA: { ...fast.investors.vc.rounds.seriesA, premium: { min: 1.5, max: 1.5 }, share: { min: 0.2, max: 0.2 }, minAmount: 0, maxAmount: 1e9 } },
        },
      },
    });
    const seen = new Map<string, { share: number; multiple: number }>();
    for (let seed = 1; seed <= 12 && seen.size < 3; seed++) {
      const state = until("seriesA", fixed, begin(fixed, seed)).state;
      for (const o of fixed.investors(state).vc.approach!.offers) {
        // Their opening asks the round's share times the lean's, and values the business at its premium plus the lean's.
        expect(o.multiple).toBeCloseTo(1.5 + vc.leans[o.lean].premium, 2);
        expect(o.theirShare).toBeCloseTo(0.2 * vc.leans[o.lean].share, 2);
        seen.set(o.lean, { share: o.theirShare, multiple: o.multiple });
      }
    }
    expect([...seen.keys()].sort()).toEqual([...VC_LEANS].sort());
    expect(seen.get("cash")!.share).toBeGreaterThan(seen.get("conditions")!.share);
    expect(seen.get("conditions")!.share).toBeGreaterThan(seen.get("ownership")!.share);
    expect(seen.get("ownership")!.multiple).toBeGreaterThan(seen.get("cash")!.multiple);
  });

  it("rolls each VC's lean on its own, so two can share one", () => {
    const shared = [1, 2, 3, 4, 5, 6, 7, 8].some((seed) => {
      const leans = sim.investors(until("seriesA", sim, begin(sim, seed)).state).vc.approach!.offers.map((o) => o.lean);
      return new Set(leans).size < 3;
    });
    expect(shared).toBe(true);
  });

  it("brings each round at its target in turn, B to D after the round before, and stops the angels", () => {
    let state = begin();
    for (const round of SERIES_IDS) {
      state = until(round, sim, state).state;
      const rounds = sim.investors(state).vc.rounds;
      const at = SERIES_IDS.indexOf(round);
      if (at > 0) {
        const before = rounds[at - 1]!.firstApproachDay!;
        expect(state.day).toBeGreaterThanOrEqual(before + fast.investors.vc.gapDays + fast.investors.approachDays);
        expect(state.day).toBeGreaterThanOrEqual(targetDay(fast, state, round, before + fast.investors.vc.gapDays) + fast.investors.approachDays);
      }
      expect(rounds[at]!.firstApproachDay).toBe(state.day);
      expect(sim.investors(state).vc.approach!.offers).toHaveLength(3);
    }
    // No angel approached after Series A.
    const seriesA = sim.investors(state).vc.rounds[0]!.firstApproachDay!;
    expect(sim.investors(state).declined.every((d) => d.day <= seriesA + fast.investors.offerDays)).toBe(true);
    expect(sim.investors(state).offer).toBeNull();
    expect(sim.investors(state).anotherComing).toBe(false);
  });
});

describe("picking, declining and accepting", () => {
  it("negotiates with the VC picked alone, closing the other two", () => {
    const state = until("seriesA").state;
    const [first, second] = sim.investors(state).vc.approach!.offers;
    expect(refusal(() => sim.applyAction(state, { type: "counterInvestor", terms: { share: first!.theirShare * 0.9 } }))).toBe("pick_first");
    expect(refusal(() => sim.applyAction(state, { type: "acceptInvestor" }))).toBe("pick_first");
    expect(refusal(() => sim.applyAction(state, { type: "pickInvestor", investor: "Nobody Capital" }))).toBe("unknown_investor");
    const picked = sim.applyAction(state, { type: "pickInvestor", investor: second!.investor });
    const v = sim.investors(picked).vc;
    expect(v.approach!.picked).toBe(second!.investor);
    expect(v.approach!.offers.map((o) => o.status)).toEqual(["closed", "picked", "closed"]);
    expect(v.negotiation).toMatchObject({ countersLeft: 2, final: false });
    expect(refusal(() => sim.applyAction(picked, { type: "pickInvestor", investor: first!.investor }))).toBe("already_picked");
    // The three-offer negotiation, with the picked VC.
    const odds = sim.investorCounterOdds(picked, { share: second!.theirShare * 0.9 });
    expect(odds.chances.high + odds.chances.middle + odds.chances.low).toBeCloseTo(1, 9);
    const countered = sim.applyAction(picked, { type: "counterInvestor", terms: { share: second!.theirShare * 0.9 } });
    expect(sim.investors(countered).vc.negotiation).toMatchObject({ countersLeft: 1 });
    expect(sim.investors(countered).vc.negotiation!.offers).toHaveLength(2);
  });

  it("brings three new VCs a few days after all three are declined, for the same round, on less generous terms", () => {
    const state = until("seriesA", onlyA).state;
    const first = onlyA.investors(state).vc.approach!;
    const declined = onlyA.applyAction(state, { type: "declineInvestor" });
    expect(onlyA.investors(declined).vc).toMatchObject({ approach: null, anotherComing: true });
    expect(onlyA.investors(declined).vc.declined).toEqual([
      { round: "seriesA", investors: first.offers.map((o) => o.investor), day: state.day, lapsed: false },
    ]);
    const again = playUntil(onlyA, declined, vcsFor(onlyA, "seriesA")).state;
    const next = onlyA.investors(again).vc.approach!;
    expect(again.day).toBe(state.day + fast.investors.retryDays);
    expect(next.offers).toHaveLength(3);
    expect(next.offers.some((o) => first.offers.some((f) => f.investor === o.investor))).toBe(false);
    // A round counts from its first approach.
    expect(onlyA.investors(again).vc.rounds[0]!.firstApproachDay).toBe(state.day);
  });

  it("brings three new VCs when no deal is reached with the one picked, or the offers lapse", () => {
    const state = until("seriesA", onlyA).state;
    const first = onlyA.investors(state).vc.approach!;
    const picked = onlyA.applyAction(state, { type: "pickInvestor", investor: first.offers[0]!.investor });
    const failed = onlyA.applyAction(picked, { type: "declineInvestor" });
    const again = playUntil(onlyA, failed, vcsFor(onlyA, "seriesA")).state;
    expect(onlyA.investors(again).vc.approach!.offers.map((o) => o.investor)).not.toContain(first.offers[0]!.investor);

    // Left unanswered, they lapse at the end of their last day.
    const { state: lapsed, pauses } = playUntil(onlyA, state, (s) => onlyA.investors(s).vc.approach === null);
    expect(lapsed.day).toBe(state.day + fast.investors.offerDays);
    expect(onlyA.investors(lapsed).vc.declined.at(-1)).toMatchObject({ round: "seriesA", lapsed: true });
    expect(pauses.some((p) => p.reason.id === "lapsed-seriesA")).toBe(true);
  });

  it("takes the picked VC's offer: their cash for new shares, the valuation theirs, and friends and family closed", () => {
    const state = until("seriesA").state;
    const offer = sim.investors(state).vc.approach!.offers[2]!;
    const picked = sim.applyAction(state, { type: "pickInvestor", investor: offer.investor });
    const accepted = sim.applyAction(picked, { type: "acceptInvestor" });
    const i = sim.investors(accepted);
    expect(accepted.cash).toBeCloseTo(state.cash + offer.amount, 6);
    expect(i.vc.approach).toBeNull();
    expect(i.vc.rounds[0]!.deal).toMatchObject({ round: "seriesA", investor: offer.investor, lean: offer.lean, amount: offer.amount, shares: offer.newShares, valuation: offer.valuation });
    expect(i.vc.lead).toEqual({ investor: offer.investor, lean: offer.lean });
    // The valuation follows the chosen VC's figure.
    expect(i.valuation).toMatchObject({ investor: offer.investor, round: "seriesA", day: state.day });
    expect(sim.valuation(accepted).valuation).toBeCloseTo(offer.valuation, -1);
    expect(sim.valuation(accepted).drivers.find((d) => d.id === "investor")!.detail).toMatch(new RegExp(`^${offer.investor}, your Series A VC, valued`));
    const row = sim.capTable(accepted).rows.find((r) => r.id === "vc")!;
    expect(row).toMatchObject({ name: `${offer.investor} (VC)`, shares: offer.newShares });
    expect(row.share).toBeCloseTo(offer.theirShare, 6);
    expect(sim.funding(accepted)).toMatchObject({ friendsAndFamilyOffer: null, grantOffer: null, closedDay: state.day });
    expect(refusal(() => sim.applyAction(accepted, { type: "acceptFunding", funder: "friendsAndFamily" }))).toBe("funding_closed");
    // Each VC's figure, not the first's: another VC chosen sets another valuation.
    const other = sim.investors(state).vc.approach!.offers[0]!;
    const otherAccepted = sim.applyAction(sim.applyAction(state, { type: "pickInvestor", investor: other.investor }), { type: "acceptInvestor" });
    expect(sim.valuation(otherAccepted).valuation).toBeCloseTo(other.valuation, -1);
  });

  it("brings the lead VC back for the next round alongside two new VCs, and adds to their holding", () => {
    const state = until("seriesA").state;
    const offer = sim.investors(state).vc.approach!.offers[0]!;
    const accepted = sim.applyAction(sim.applyAction(state, { type: "pickInvestor", investor: offer.investor }), { type: "acceptInvestor" });
    const atB = until("seriesB", sim, accepted).state;
    const b = sim.investors(atB).vc.approach!;
    expect(b.offers[0]).toMatchObject({ investor: offer.investor, lean: offer.lean, lead: true });
    expect(b.offers.slice(1).map((o) => o.lead)).toEqual([false, false]);
    expect(b.offers.slice(1).map((o) => o.investor)).not.toContain(offer.investor);
    const again = sim.applyAction(sim.applyAction(atB, { type: "pickInvestor", investor: offer.investor }), { type: "acceptInvestor" });
    const rows = sim.capTable(again).rows.filter((r) => r.id === "vc");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shares).toBe(offer.newShares + b.offers[0]!.newShares);
    // A retry after declining brings three new VCs: the lead comes back only on a round's first approach.
    const upToB = stopAfter("seriesB");
    const declined = upToB.applyAction(atB, { type: "declineInvestor" });
    const retry = playUntil(upToB, declined, vcsFor(upToB, "seriesB")).state;
    expect(upToB.investors(retry).vc.approach!.offers.every((o) => !o.lead)).toBe(true);
  });

  it("brings no lead for Series B when Series A was declined", () => {
    const state = until("seriesB").state;
    expect(sim.investors(state).vc.lead).toBeNull();
    expect(sim.investors(state).vc.approach!.offers.every((o) => !o.lead)).toBe(true);
  });
});

describe("the IPO gate", () => {
  it("waits for Series A to approach, as the last C-suite roles open then, but for no later round", () => {
    let state = begin(easyIpo);
    // Profit is left to the record: making money on every day of it, so only the C-suite can hold the IPO back.
    const profitable = (s: GameState): GameState => ({ ...s, spendByDay: s.spendByDay.map((d) => ({ ...d, income: 1_000_000 })) });
    const unmet = (s: GameState) => easyIpo.ipo(profitable(s)).conditions.filter((c) => !c.met).map((c) => c.id);
    /** Hires the first candidate on every open, unfilled role's shortlist. */
    const hireOpen = (s: GameState): GameState =>
      easyIpo
        .csuite(s)
        .roles.filter((r) => r.open && !r.executive)
        .reduce((next, r) => easyIpo.applyAction(next, { type: "hireExecutive", role: r.role, candidate: r.shortlist[0]!.id }), s);
    state = playUntil(easyIpo, state, (s) => s.launchDay !== null && s.day > s.launchDay + 3).state;
    // Before Series A, the CISO and the others it opens can't be hired.
    expect(unmet(hireOpen(state))).toEqual(["csuite"]);
    // Series A approaches and is turned down: every role can be filled, and the company floats without B, C or D.
    state = easyIpo.applyAction(until("seriesA", easyIpo, state).state, { type: "declineInvestor" });
    expect(unmet(state)).toEqual(["csuite"]);
    const hired = hireOpen(state);
    expect(SERIES_IDS.slice(1).map((r) => hired.investors.vc.firstApproachDay[r])).toEqual([null, null, null]);
    expect(easyIpo.ipo(profitable(hired))).toMatchObject({ ready: true, canApply: true });
  });

  it("puts no Series round on the checklist", () => {
    const state = until("seriesB").state;
    expect(sim.ipo(state).conditions.filter((c) => c.id.startsWith("series"))).toEqual([]);
  });
});

describe("a 180-day game's two rounds", () => {
  const short = (s: Sim = sim, seed = 42) => begin(s, seed, "180-days");

  it("has two rounds, Series A and B: Series A approaches at old Series A's target, for A and B's offers together", () => {
    const { state } = until("seriesA", sim, short());
    const angelDay = state.investors.firstApproachDay!;
    expect(state.day).toBe(targetDay(fast, state, "seriesA", angelDay + fast.investors.vc.gapDays) + fast.investors.approachDays);
    const v = sim.investors(state).vc;
    expect(v.rounds.map((r) => r.name)).toEqual(["Series A", "Series B"]);
    expect(v.approach!.effects).toContain(
      "Their cash comes in two tranches: the first on signing, the second once the company hits their growth target, which stays hidden as the rounds' targets do. Until it's paid, the valuation counts only the cash you have.",
    );
    for (const p of state.investors.vc.approach!.vcs) {
      expect(p.parts!.map((x) => x.round)).toEqual(["seriesA", "seriesB"]);
      for (const part of p.parts!) {
        expect(part.amount).toBeGreaterThanOrEqual(vc.rounds[part.round].minAmount);
        expect(part.amount).toBeLessThanOrEqual(vc.rounds[part.round].maxAmount);
      }
      // Their share added together too, but never more than 90% of the company, as any offer.
      const share = Math.min(0.9, p.parts![0]!.share + p.parts![1]!.share);
      expect(p.negotiation.offers[0]).toEqual({ amount: p.parts![0]!.amount + p.parts![1]!.amount, share });
    }
  });

  it("takes the cash and share of the two rounds added together", () => {
    // Fixed ranges, so a merged offer's share is the two rounds' shares, as the lean asks, added together.
    const rounds = fast.investors.vc.rounds;
    const fixed = createSim({
      ...fast,
      investors: {
        ...fast.investors,
        vc: {
          ...fast.investors.vc,
          rounds: {
            ...rounds,
            seriesA: { ...rounds.seriesA, premium: { min: 1.5, max: 1.5 }, share: { min: 0.2, max: 0.2 }, minAmount: 0, maxAmount: 1e9 },
            seriesB: { ...rounds.seriesB, premium: { min: 1.5, max: 1.5 }, share: { min: 0.15, max: 0.15 }, minAmount: 0, maxAmount: 1e9 },
          },
        },
      },
    });
    const state = until("seriesA", fixed, short(fixed)).state;
    const a = state.investors.vc.approach!;
    const worth = a.business * 1.5 + a.netCash;
    for (const o of fixed.investors(state).vc.approach!.offers) {
      const lean = vc.leans[o.lean];
      const premium = worth + a.business * lean.premium;
      // Each round's cash buys its share at the same valuation: added together, as the four-round game's two would.
      const cashFor = (share: number) => Math.round((share * lean.share * premium) / (1 - share * lean.share) / 1000) * 1000;
      expect(o.amount).toBe(cashFor(0.2) + cashFor(0.15));
      expect(o.theirShare).toBeCloseTo(0.2 * lean.share + 0.15 * lean.share, 2);
    }
  });

  it("pays the first tranche on signing, and the second once old Series B's target is hit", () => {
    const state = until("seriesA", sim, short()).state;
    const offer = sim.investors(state).vc.approach!.offers[0]!;
    expect(offer.secondTranche).toBeGreaterThan(0);
    const first = offer.amount - offer.secondTranche!;
    const accepted = sim.applyAction(sim.applyAction(state, { type: "pickInvestor", investor: offer.investor }), { type: "acceptInvestor" });
    expect(accepted.cash).toBeCloseTo(state.cash + first, 6);
    const deal = sim.investors(accepted).vc.rounds[0]!.deal!;
    expect(deal).toMatchObject({ amount: offer.amount, shares: offer.newShares, tranche: { amount: offer.secondTranche, target: "seriesB", paidDay: null } });
    expect(sim.capTable(accepted).rows.find((r) => r.id === "vc")!.share).toBeCloseTo(offer.theirShare, 6);

    const paid = (s: GameState) => s.investors.vc.deals[0]!.tranche!.paidDay !== null;
    const { state: after, log } = playUntil(sim, accepted, paid);
    expect(after.day).toBe(targetDay(fast, after, "seriesB", state.day + fast.investors.vc.gapDays));
    const entry = log.at(-1)!.entries.find((e) => e.text.includes("second tranche"))!;
    expect(entry).toMatchObject({ cashDelta: offer.secondTranche, kind: "funding" });
    expect(entry.text).toBe(`${offer.investor} paid the second tranche of your Series A: £${offer.secondTranche!.toLocaleString("en-GB")}, now that Acme has hit their growth target.`);
    expect(after.spendByDay.at(-1)!.raised).toBe(offer.secondTranche);
  });

  it("sets the valuation to their figure when the 90% cap prices the offer, as after a refused counter", () => {
    const state = until("seriesA", sim, short()).state;
    const offer = sim.investors(state).vc.approach!.offers[0]!;
    const picked = sim.applyAction(state, { type: "pickInvestor", investor: offer.investor });
    // A refused counter's penalty can ask past 90%: the offer is priced at the cap, above the multiple their ask implies.
    const a = picked.investors.vc.approach!;
    const vcs = a.vcs.map((p) =>
      p.investor === offer.investor ? { ...p, negotiation: { ...p.negotiation, offers: [...p.negotiation.offers, { amount: offer.amount, share: 0.95 }] } } : p,
    );
    const pushed = { ...picked, investors: { ...picked.investors, vc: { ...picked.investors.vc, approach: { ...a, vcs } } } };
    const standing = sim.investors(pushed).vc.approach!.offers[0]!;
    expect(standing.theirShare).toBeCloseTo(0.9, 4);
    const accepted = sim.applyAction(pushed, { type: "acceptInvestor" });
    // Their figure, less the second tranche still to come.
    expect(Math.abs(sim.valuation(accepted).valuation - (standing.valuation - standing.secondTranche!))).toBeLessThanOrEqual(2);
  });

  it("brings Series B at old Series C's target, for C and D's offers together, with the lead VC back", () => {
    const state = until("seriesA", sim, short()).state;
    const offer = sim.investors(state).vc.approach!.offers[1]!;
    const accepted = sim.applyAction(sim.applyAction(state, { type: "pickInvestor", investor: offer.investor }), { type: "acceptInvestor" });
    const atB = until("seriesB", sim, accepted).state;
    expect(atB.day).toBe(targetDay(fast, atB, "seriesC", state.day + fast.investors.vc.gapDays) + fast.investors.approachDays);
    const b = sim.investors(atB).vc.approach!;
    expect(b).toMatchObject({ round: "seriesB", name: "Series B" });
    expect(b.offers[0]).toMatchObject({ investor: offer.investor, lead: true });
    expect(atB.investors.vc.approach!.vcs.every((p) => p.parts!.map((x) => x.round).join() === "seriesC,seriesD")).toBe(true);
    // The last round: no lead to come back for.
    expect(b.effects.some((e) => e.includes("lead VC"))).toBe(false);
  });

  it("sees at most two rounds in the whole game, and its summary says so", () => {
    let state = short();
    // Declines every approach, so the game runs to its last day.
    while (state.status === "playing") {
      if (state.investors.vc.approach || state.investors.approach) state = sim.applyAction(state, { type: "declineInvestor" });
      state = sim.tick(playDay(sim, state, sensible)).state;
    }
    expect(state.investors.vc.firstApproachDay).toMatchObject({ seriesC: null, seriesD: null });
    expect(state.investors.vc.firstApproachDay.seriesB).not.toBeNull();
    expect(new Set(state.investors.vc.declined.map((d) => d.round))).toEqual(new Set(["seriesA", "seriesB"]));
    expect(sim.summarise(state).vcRounds).toBe(2);
  });

  it("leaves every other length's four rounds as they were, all cash paid on signing", () => {
    for (const length of ["1-year", "until-ipo", "career"] as const) {
      const state = until("seriesA", sim, begin(sim, 42, length)).state;
      expect(sim.investors(state).vc.rounds.map((r) => r.name)).toEqual(["Series A", "Series B", "Series C", "Series D"]);
      expect(sim.summarise(state).vcRounds).toBe(4);
      expect(state.investors.vc.approach!.vcs.every((p) => p.parts === null)).toBe(true);
      const offer = sim.investors(state).vc.approach!.offers[0]!;
      expect(offer.secondTranche).toBeNull();
      const accepted = sim.applyAction(sim.applyAction(state, { type: "pickInvestor", investor: offer.investor }), { type: "acceptInvestor" });
      expect(accepted.cash).toBeCloseTo(state.cash + offer.amount, 6);
      expect(accepted.investors.vc.deals[0]!.tranche).toBeNull();
    }
  });
});
