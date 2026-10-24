import { describe, expect, it } from "vitest";
import { playDay, STRATEGIES } from "../scripts/harness.ts";
import { createSim, defaultConfig, SimError, type DayLog, type GameConfig, type GameState, type PauseReason, type Sim } from "../src/index.ts";

// The angel investor, through the sim's public interface: the hidden target, the approach, the offer with its target,
// negotiating, accepting (the valuation it sets, friends and family and the grant closing), declining, and the target
// met or missed.

const quiet: GameConfig = { ...defaultConfig, events: [] };
const sim = createSim(quiet);
const sensible = STRATEGIES.find((s) => s.id === "sensible")!;
const angel = quiet.investors.angel;
const begin = (s: Sim = sim, seed = 42) => s.newGame({ companyName: "Acme", productType: "social", model: "saas", seed });

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return null;
};

/** Income a day over the last `days` days played, as the hidden target averages it. */
const incomeOver = (state: GameState, days: number) =>
  state.spendByDay.filter((d) => d.day > state.day - days).reduce((sum, d) => sum + d.income, 0) / days;

/** Plays the sensible bot a tick at a time until `done`, keeping the log and every pause. */
function playUntil(s: Sim, state: GameState, done: (s: GameState) => boolean, most = 200) {
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

const approached = (s: Sim) => (state: GameState) => s.investors(state).offer !== null;
/** A game played until the first angel approaches. */
const untilApproach = (s: Sim = sim, seed = 42) => playUntil(s, begin(s, seed), approached(s));

/** Users gained a day, net, over the target's days: the pace the angel's users target is set from. */
const pace = (state: GameState) => {
  const then = state.spendByDay.filter((d) => d.day <= state.day - angel.target.days).at(-1)!;
  return Math.max(0, (state.users - then.users) / angel.target.days);
};
/** The users target for `days` of the target's days. */
const usersTarget = (state: GameState, days = angel.targetDays) =>
  Math.ceil((Math.max(angel.minUsersGained, angel.usersPace * pace(state) * angel.targetDays) * days) / angel.targetDays / 10) * 10;

/** The business the formula values: every driver but an investor's, net cash and the minimum. */
const formulaBusiness = (s: Sim, state: GameState) =>
  s
    .valuation(state)
    .drivers.filter((d) => !["investor", "netCash", "minimum", "liquidation"].includes(d.id))
    .reduce((sum, d) => sum + d.amount, 0);
const netCash = (s: Sim, state: GameState) => s.valuation(state).drivers.find((d) => d.id === "netCash")!.amount;

describe("the angel's approach", () => {
  it("comes a few days after income first averages the hidden target, with a notification that pauses time", () => {
    const { state, log, pauses } = untilApproach();
    // The first day income held at the target over its days, after the launch.
    let hit: number | null = null;
    for (let day = 1; day <= state.day && hit === null; day++) {
      const then = { ...state, day, spendByDay: state.spendByDay.filter((d) => d.day <= day) };
      if (state.launchDay! <= day - angel.target.days && incomeOver(then, angel.target.days) >= angel.target.dailyRevenue) hit = day;
    }
    expect(hit).not.toBeNull();
    expect(state.day).toBe(hit! + quiet.investors.approachDays);

    const offer = sim.investors(state).offer!;
    expect(offer).toMatchObject({ round: "angel", day: state.day });
    const entry = log.at(-1)!.entries.find((e) => e.kind === "funding")!;
    expect(entry.text).toMatch(new RegExp(`^An angel investor, ${offer.investor}, likes what Acme is doing and wants to invest`));
    expect(pauses).toContainEqual({ day: state.day, reason: expect.objectContaining({ kind: "offer", id: "offer-angel" }) });
    // Nobody approached before.
    expect(log.slice(0, -1).flatMap((d) => d.entries).some((e) => e.text.includes("angel investor"))).toBe(false);
  });

  it("never comes to a company that hasn't hit the hidden target", () => {
    const s = createSim({ ...quiet, investors: { ...quiet.investors, angel: { ...angel, target: { ...angel.target, dailyRevenue: 1_000_000 } } } });
    const { state } = playUntil(s, begin(s), () => false, 90);
    expect(s.investors(state)).toMatchObject({ offer: null, negotiation: null, angel: null, anotherComing: false });
    expect(refusal(() => s.applyAction(state, { type: "acceptInvestor" }))).toBe("no_approach");
  });

  it("doesn't come with fewer days left in the game than their target runs for", () => {
    // The first angel comes around day 28 on this game: with 40 days in all, too late for a 30-day target.
    const s = createSim({ ...quiet, finalDay: 40 });
    const { state, log } = playUntil(s, begin(s), () => false, 60);
    expect(state.status).toBe("finished");
    expect(log.flatMap((d) => d.entries).some((e) => e.text.includes("angel investor"))).toBe(false);
    expect(s.investors(state)).toMatchObject({ offer: null, angel: null, anotherComing: false });
  });

  it("opens at a premium on the formula's business for a fifth of the company or so, cash counted at face value", () => {
    for (const seed of [1, 2, 3]) {
      const { state } = untilApproach(sim, seed);
      const offer = sim.investors(state).offer!;
      expect(offer.multiple).toBeGreaterThanOrEqual(angel.premium.min - 0.01);
      expect(offer.multiple).toBeLessThanOrEqual(angel.premium.max + 0.01);
      expect(offer.theirShare).toBeGreaterThan(angel.share.min - 0.01);
      expect(offer.theirShare).toBeLessThan(angel.share.max + 0.01);
      expect(offer.amount).toBeGreaterThanOrEqual(angel.minAmount);
      expect(offer.amount).toBeLessThanOrEqual(angel.maxAmount);
      expect(offer.amount % 500).toBe(0);
      expect(offer.preMoney).toBeCloseTo(offer.multiple * formulaBusiness(sim, state) + netCash(sim, state), -3);
      expect(offer.valuation).toBe(offer.preMoney + offer.amount);
      expect(offer.formulaValuation).toBe(sim.valuation(state).valuation);
    }
  });

  it("shows its target, what missing it costs, and what else accepting does, before it's accepted", () => {
    const { state } = untilApproach();
    const offer = sim.investors(state).offer!;
    const expected = Math.ceil((angel.targetGrowth * Math.max(angel.target.dailyRevenue, incomeOver(state, angel.target.days))) / 50) * 50;
    const users = usersTarget(state);
    // Sized from the company's recent growth: its pace of users gained, kept up for the 30 days.
    expect(users).toBeGreaterThan(angel.minUsersGained);
    expect(offer.target).toEqual({ dailyRevenue: expected, days: angel.target.days, netUsers: users, byDay: state.day + angel.targetDays });
    expect(offer.condition).toBe(
      `By day ${state.day + angel.targetDays} (${angel.targetDays} days after you accept), both at once: grow income to £${expected.toLocaleString("en-GB")} a day, averaged over ${angel.target.days} days, and gain ${users.toLocaleString("en-GB")} users net from the day you accept: users who join, free or paying, less users who leave.`,
    );
    expect(offer.ifMissed).toMatch(new RegExp(`^Miss either and ${offer.investor} takes extra equity: new shares raise their share of the company by 5 points`));
    expect(offer.effects.join(" ")).toMatch(/valuation becomes theirs.*moves in step with the formula.*Friends and family and grants close for good: friends and family's offer and the grant's offer will be gone/);
    // Where accepting would leave the student.
    expect(offer.sharesAfter).toBe(offer.sharesInIssue + offer.newShares);
    expect(offer.yourShareBefore).toBe(1);
    expect(offer.yourShareAfter).toBeCloseTo(1 - offer.theirShare, 10);
  });
});

describe("accepting the angel", () => {
  it("puts their cash in for new shares and sets the valuation to their figure", () => {
    const { state } = untilApproach();
    const offer = sim.investors(state).offer!;
    const after = sim.applyAction(state, { type: "acceptInvestor" });
    expect(after.cash).toBe(state.cash + offer.amount);
    expect(sim.capTable(after).rows).toMatchObject([
      { id: "student", shares: 10_000 },
      { id: "angel", name: `${offer.investor} (angel)`, shares: offer.newShares, share: offer.theirShare },
    ]);
    // Their figure, cash included, give or take the rounding of the drivers.
    expect(Math.abs(sim.valuation(after).valuation - offer.valuation)).toBeLessThanOrEqual(2);
    expect(sim.investors(after)).toMatchObject({
      offer: null,
      negotiation: null,
      angel: { investor: offer.investor, day: state.day, amount: offer.amount, shares: offer.newShares, status: "running", target: offer.target },
      valuation: { investor: offer.investor, round: "angel", day: state.day, multiple: expect.closeTo(offer.multiple, 2) },
    });
    // Money raised, not income, so the cash chart still adds up.
    expect(after.spendByDay.at(-1)!.raised).toBe(offer.amount);
    expect(after.income).toBe(state.income);
    expect(refusal(() => sim.applyAction(after, { type: "acceptInvestor" }))).toBe("no_approach");
    expect(refusal(() => sim.applyAction(after, { type: "declineInvestor" }))).toBe("no_approach");
  });

  it("from then on values the business at their multiple of the formula's, so it moves in step, with cash at face value", () => {
    const { state } = untilApproach();
    const after = sim.applyAction(state, { type: "acceptInvestor" });
    const { multiple } = sim.investors(after).valuation!;
    const later = playUntil(sim, after, (s) => s.day >= after.day + 40).state;
    for (const s of [after, later]) {
      const business = formulaBusiness(sim, s);
      const investor = sim.valuation(s).drivers.find((d) => d.id === "investor")!;
      expect(investor.amount).toBe(Math.round((multiple - 1) * business));
      expect(investor.detail).toMatch(/your angel, valued the business at .* the formula's on day \d+: it moves in step with the formula/);
      expect(sim.valuation(s).valuation).toBe(Math.max(quiet.valuation.minimum, Math.round(multiple * business) + netCash(sim, s)));
    }
    // The formula's business grew, and the company's with it, by the same share.
    const grew = formulaBusiness(sim, later) / formulaBusiness(sim, after);
    expect(grew).toBeGreaterThan(1);
    const company = (s: GameState) => sim.valuation(s).valuation - netCash(sim, s);
    expect(company(later) / company(after)).toBeCloseTo(grew, 2);
  });

  it("closes friends and family and the grant for good, while a grant already taken keeps its condition", () => {
    const started = sim.applyAction(begin(), { type: "acceptFunding", funder: "grant" });
    const { state } = playUntil(sim, started, approached(sim));
    expect(sim.funding(state).friendsAndFamilyOffer).not.toBeNull();
    const after = sim.applyAction(state, { type: "acceptInvestor" });
    const funding = sim.funding(after);
    expect(funding).toMatchObject({ friendsAndFamilyOffer: null, grantOffer: null, closedDay: state.day, grant: { status: "accepted" } });
    expect(funding.negotiations).toEqual({ friendsAndFamily: null, grant: null });
    expect(refusal(() => sim.applyAction(after, { type: "acceptFunding", funder: "friendsAndFamily" }))).toBe("funding_closed");
    expect(refusal(() => sim.applyAction(after, { type: "counterFunding", funder: "friendsAndFamily", terms: { amount: 16_000 } }))).toBe(
      "funding_closed",
    );
    expect(refusal(() => sim.applyAction(after, { type: "declineFunding", funder: "friendsAndFamily" }))).toBe("funding_closed");
    // The grant's condition runs on.
    const later = sim.advance(after, 5).state;
    expect(sim.funding(later).grant!.daysLeft).toBe(sim.funding(after).grant!.daysLeft - 5);
  });
});

describe("declining the angel", () => {
  it("brings a new angel a few days later, and leaves friends and family open", () => {
    const { state } = untilApproach();
    const first = sim.investors(state).offer!;
    const declined = sim.applyAction(state, { type: "declineInvestor" });
    expect(sim.investors(declined)).toMatchObject({
      offer: null,
      anotherComing: true,
      declined: [{ round: "angel", investor: first.investor, day: state.day }],
    });
    expect(sim.funding(declined).friendsAndFamilyOffer).not.toBeNull();
    const { state: next, pauses } = playUntil(sim, declined, approached(sim));
    expect(next.day).toBe(state.day + quiet.investors.retryDays);
    const second = sim.investors(next).offer!;
    expect(second.investor).not.toBe(first.investor);
    expect(sim.investors(next).anotherComing).toBe(false);
    expect(pauses.map((p) => p.reason.id)).toContain("offer-angel");
  });
});

describe("declining for a better angel", () => {
  it("doesn't pay: each angel declined makes the next less generous", () => {
    let { state } = untilApproach(sim, 7);
    for (let i = 0; i < 3; i++) {
      state = sim.applyAction(state, { type: "declineInvestor" });
      state = playUntil(sim, state, approached(sim)).state;
    }
    // Three declines: the least premium, for at least a fifth of the company.
    const offer = sim.investors(state).offer!;
    expect(offer.multiple).toBeCloseTo(angel.premium.min, 1);
    expect(offer.theirShare).toBeGreaterThan(angel.share.min + 3 * angel.declineShare - 0.01);
    expect(sim.investors(state).declined).toHaveLength(3);
  });
});

describe("an angel's offer lapsing", () => {
  const OFFER_DAYS = quiet.investors.offerDays;

  it("stands for its days, counting down, and can be accepted on the last", () => {
    const { state } = untilApproach();
    expect(sim.investors(state).offer).toMatchObject({ lastDay: state.day + OFFER_DAYS, daysLeft: OFFER_DAYS });
    const lastDay = sim.advance(state, OFFER_DAYS - 1).state;
    expect(sim.investors(lastDay).offer).toMatchObject({ daysLeft: 1 });
    const after = sim.applyAction(lastDay, { type: "acceptInvestor" });
    expect(sim.investors(after).angel).toMatchObject({ status: "running" });
  });

  it("lapses unanswered at the end of its last day, counting as a decline, with a pause", () => {
    const { state } = untilApproach();
    const offer = sim.investors(state).offer!;
    const { state: lapsed, log, pauses } = playUntil(sim, state, (s) => !sim.investors(s).offer);
    expect(lapsed.day).toBe(offer.lastDay);
    expect(sim.investors(lapsed)).toMatchObject({
      offer: null,
      anotherComing: true,
      declined: [{ round: "angel", investor: offer.investor, day: offer.lastDay, lapsed: true }],
    });
    expect(log.at(-1)!.entries.map((e) => e.text)).toContainEqual(
      `${offer.investor}'s offer lapsed: you didn't accept it within ${OFFER_DAYS} days, so it counts as declined. Another angel investor will approach in a few days, on less generous terms.`,
    );
    expect(pauses).toContainEqual({ day: lapsed.day, reason: expect.objectContaining({ kind: "alert", id: "lapsed-angel" }) });
    expect(refusal(() => sim.applyAction(lapsed, { type: "acceptInvestor" }))).toBe("no_approach");
    // The next comes a few days later, on the decline penalty's terms.
    const next = playUntil(sim, lapsed, approached(sim)).state;
    expect(next.day).toBe(lapsed.day + quiet.investors.retryDays);
    expect(sim.investors(next).offer!.multiple).toBeLessThanOrEqual(angel.premium.max - angel.declinePremium + 0.01);
    expect(sim.investors(next).offer!.theirShare).toBeGreaterThan(angel.share.min + angel.declineShare - 0.01);
  });
});

describe("the angel's offer over time", () => {
  it("prices cash at face value: money raised while it's open doesn't change their multiple", () => {
    const { state } = untilApproach();
    const offer = sim.investors(state).offer!;
    const funded = sim.applyAction(state, { type: "acceptFunding", funder: "grant" });
    const after = sim.investors(funded).offer!;
    expect(after.multiple).toBeCloseTo(offer.multiple, 2);
    expect(after.preMoney - offer.preMoney).toBeCloseTo(quiet.funding.grant.amount, -1);
    expect(after.theirShare).toBeLessThan(offer.theirShare);
  });

  it("sets a target due by the game's last day at the latest, asking for growth in step with the days left", () => {
    const { state } = untilApproach();
    const late: GameState = { ...state, finalDay: state.day + 6 };
    const offer = sim.investors(late).offer!;
    const now = Math.max(angel.target.dailyRevenue, incomeOver(late, angel.target.days));
    const growth = 1 + ((angel.targetGrowth - 1) * 6) / angel.targetDays;
    expect(offer.target).toEqual({
      dailyRevenue: Math.ceil((growth * now) / 50) * 50,
      days: angel.target.days,
      netUsers: usersTarget(late, 6),
      byDay: late.day + 6,
    });
    expect(offer.condition).toMatch(/^By day \d+ \(6 days after you accept, the game's last day\), both at once/);
    // Accepted, it's settled on the last day: met or missed, never left hanging.
    const accepted = sim.applyAction(late, { type: "acceptInvestor" });
    const done = sim.advance(accepted, 6).state;
    expect(sim.investors(done).angel!.status).not.toBe("running");
  });
});

describe("negotiating the angel's offer", () => {
  it("counters on cash and share like any offer, and accepting takes the offer that stands", () => {
    const { state } = untilApproach();
    const opening = sim.investors(state).offer!;
    const terms = { amount: Math.round(opening.amount * 1.1), share: Math.round(opening.theirShare * 0.9 * 1000) / 1000 };
    const odds = sim.investorCounterOdds(state, terms);
    expect(odds.counter).toEqual(terms);
    const countered = sim.applyAction(state, { type: "counterInvestor", terms });
    const talks = sim.investors(countered).negotiation!;
    expect(talks).toMatchObject({ countersLeft: 1, final: false, maxAsk: quiet.negotiation.maxAsk });
    expect(talks.rounds).toHaveLength(1);
    const outcome = odds.outcomes[talks.rounds[0]!.result];
    expect(talks.offers[1]).toEqual(outcome);
    // The offer now stands at the new terms, and that's what accepting takes.
    const offer = sim.investors(countered).offer!;
    expect(offer.amount).toBe(outcome.amount);
    expect(offer.theirShare).toBeCloseTo(outcome.share!, 3);
    const after = sim.applyAction(countered, { type: "acceptInvestor" });
    expect(after.cash).toBe(countered.cash + outcome.amount!);
    // Negotiation rolls have their own RNG: who approaches next, and the rest of the game, don't move.
    expect(countered.rng).toBe(state.rng);
    expect(countered.investorRng).toBe(state.investorRng);
  });

  it("refuses terms that aren't the investor's, and a third counter", () => {
    const { state } = untilApproach();
    expect(refusal(() => sim.applyAction(state, { type: "counterInvestor", terms: { days: 10 } }))).toBe("bad_counter");
    expect(refusal(() => sim.investorCounterOdds(state, { share: 0.9 }))).toBe("worse_counter");
    const amount = sim.investors(state).offer!.amount;
    let s = sim.applyAction(state, { type: "counterInvestor", terms: { amount: amount + 2_000 } });
    s = sim.applyAction(s, { type: "counterInvestor", terms: { amount: sim.investors(s).offer!.amount + 2_000 } });
    expect(sim.investors(s).negotiation).toMatchObject({ final: true, countersLeft: 0 });
    expect(refusal(() => sim.applyAction(s, { type: "counterInvestor", terms: { amount: amount * 2 } }))).toBe("final_offer");
  });

  it("raises their share in step if the business is worth less when it's accepted than when they approached", () => {
    const { state } = untilApproach();
    const offer = sim.investors(state).offer!;
    // The same company with half the paying users and income on every day played.
    const halved: GameState = {
      ...state,
      paidUsers: Math.round(state.paidUsers / 2),
      spendByDay: state.spendByDay.map((d) => ({ ...d, income: d.income / 2, paidUsers: Math.round(d.paidUsers / 2) })),
    };
    const fallen = sim.investors(halved).offer!;
    expect(fallen.amount).toBe(offer.amount);
    expect(fallen.theirShare).toBeGreaterThan(offer.theirShare);
    expect(fallen.multiple).toBeCloseTo(offer.multiple, 1);
    // And a company worth more keeps the terms agreed.
    const doubled: GameState = {
      ...state,
      spendByDay: state.spendByDay.map((d) => ({ ...d, income: d.income * 2, paidUsers: d.paidUsers * 2 })),
      paidUsers: state.paidUsers * 2,
    };
    expect(sim.investors(doubled).offer!.theirShare).toBeCloseTo(offer.theirShare, 3);
  });
});

describe("the angel's target", () => {
  it("counts users, free and paying, gained and lost from the day it's accepted, from nothing", () => {
    const { state } = untilApproach();
    const after = sim.applyAction(state, { type: "acceptInvestor" });
    expect(sim.investors(after).angel).toMatchObject({ usersAtStart: state.users, usersGained: 0, usersLost: 0, netUsers: 0 });
    // A price rise drives some away while new users keep coming.
    const raised = sim.applyAction(after, { type: "setPrice", price: after.price * 1.5 });
    const played = sim.advance(raised, 10).state;
    const deal = sim.investors(played).angel!;
    expect(deal.status).toBe("running");
    expect(deal.usersGained).toBeGreaterThan(0);
    expect(deal.usersLost).toBeGreaterThan(0);
    // Net is every user who joined less every user who left: exactly how far users have moved since.
    expect(deal.netUsers).toBe(deal.usersGained - deal.usersLost);
    expect(deal.netUsers).toBe(played.users - state.users);
  });

  it("is net: with a target of 1,000, gaining 1,200 and losing 100 passes; gaining 1,200 and losing 300 fails", () => {
    const { state } = untilApproach();
    const accepted = sim.applyAction(state, { type: "acceptInvestor" });
    // A target due tomorrow, all users and no income asked for, and the users the day brings measured first.
    const due = (gained: number, lost: number): GameState => ({
      ...accepted,
      investors: {
        ...accepted.investors,
        angel: {
          ...accepted.investors.angel!,
          target: { ...accepted.investors.angel!.target, dailyRevenue: 0, netUsers: 1_000, byDay: accepted.day + 1 },
          usersGained: gained,
          usersLost: lost,
        },
      },
    });
    const day = sim.investors(sim.advance(due(0, 0), 1).state).angel!;
    const ending = (gained: number, lost: number) =>
      sim.investors(sim.advance(due(gained - day.usersGained, lost - day.usersLost), 1).state).angel!;
    expect(ending(1_200, 100)).toMatchObject({ usersGained: 1_200, usersLost: 100, netUsers: 1_100, status: "met" });
    expect(ending(1_200, 300)).toMatchObject({ usersGained: 1_200, usersLost: 300, netUsers: 900, status: "missed" });
  });

  it("isn't met by income alone: the users gained must be there on the same day", () => {
    const s = createSim({ ...quiet, investors: { ...quiet.investors, angel: { ...angel, targetGrowth: 1, minUsersGained: 100_000 } } });
    const { state } = untilApproach(s);
    const after = s.applyAction(state, { type: "acceptInvestor" });
    const { state: done } = playUntil(s, after, (x) => s.investors(x).angel!.status !== "running");
    const deal = s.investors(done).angel!;
    expect(deal.status).toBe("missed");
    expect(incomeOver(done, deal.target.days)).toBeGreaterThanOrEqual(deal.target.dailyRevenue);
  });

  it("is met once income averages what they asked for, with a pause", () => {
    const { state } = untilApproach();
    const after = sim.applyAction(state, { type: "acceptInvestor" });
    const { target } = sim.investors(after).angel!;
    const { state: done, log, pauses } = playUntil(sim, after, (s) => sim.investors(s).angel!.status !== "running");
    const deal = sim.investors(done).angel!;
    expect(deal).toMatchObject({ status: "met", settledDay: done.day, extraShares: 0, daysLeft: 0 });
    expect(done.day).toBeLessThanOrEqual(target.byDay);
    expect(incomeOver(done, target.days)).toBeGreaterThanOrEqual(target.dailyRevenue);
    expect(deal.netUsers).toBeGreaterThanOrEqual(target.netUsers);
    expect(deal.netUsers).toBe(done.users - after.users);
    expect(log.at(-1)!.entries.map((e) => e.text)).toContainEqual(expect.stringMatching(new RegExp(`^${deal.investor}'s target met`)));
    expect(pauses).toContainEqual({ day: done.day, reason: expect.objectContaining({ kind: "finished", id: "angel-target" }) });
    expect(sim.capTable(done).rows.find((r) => r.id === "angel")!.shares).toBe(deal.shares);
  });

  it("missed by its day costs extra equity: new shares raise the angel's share by five points", () => {
    const s = createSim({ ...quiet, investors: { ...quiet.investors, angel: { ...angel, targetGrowth: 100, targetDays: 10 } } });
    const { state } = untilApproach(s);
    const after = s.applyAction(state, { type: "acceptInvestor" });
    const before = s.capTable(after).rows;
    const { state: done, log, pauses } = playUntil(s, after, (x) => s.investors(x).angel!.status !== "running");
    expect(done.day).toBe(after.day + 10);
    const deal = s.investors(done).angel!;
    expect(deal).toMatchObject({ status: "missed", settledDay: done.day });
    const rows = s.capTable(done).rows;
    const theirs = rows.find((r) => r.id === "angel")!;
    expect(theirs.shares).toBe(before[1]!.shares + deal.extraShares);
    expect(theirs.share).toBeCloseTo(before[1]!.share + angel.missShare, 3);
    expect(rows[0]!.shares).toBe(before[0]!.shares);
    expect(log.at(-1)!.entries.map((e) => e.text)).toContainEqual(expect.stringMatching(new RegExp(`^${deal.investor}'s target missed`)));
    expect(pauses).toContainEqual({ day: done.day, reason: expect.objectContaining({ kind: "alert", id: "angel-target" }) });
  });
});
