import { describe, expect, it } from "vitest";
import { createSim, defaultConfig, SimError, type DayLog, type EventConfig, type GameConfig, type GameState, type Sim } from "../src/index.ts";

// Shares, valuation, the cap table, friends and family and the grant, through the sim's public interface.

/** A provider outage on SaaS on the given days, the only event, so downtime comes exactly when a test wants it. */
const outageOn = (days: number[], hours: number): EventConfig => ({
  id: "providerOutage",
  name: "Provider outage",
  description: "The provider's data centre lost power.",
  layer: "facilities",
  schedule: { type: "fixed", days },
  days: 1,
  effects: { saas: { downtimeHours: hours, detail: "The SaaS platform went down with it." } },
});

const quiet: GameConfig = { ...defaultConfig, events: [] };
const sim = createSim(quiet);
const begin = (s: Sim = sim, shares?: number) =>
  s.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 42, ...(shares && { shares }) });

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return null;
};

/** A company with these paying users at this price and satisfaction, for valuation, as if they'd always had them. */
const trading = (state: GameState, paidUsers: number, price: number, satisfaction = 100): GameState => ({
  ...state,
  users: paidUsers * 2,
  paidUsers,
  price,
  satisfaction,
  spendByDay: state.spendByDay.map((d) => ({ ...d, paidUsers })),
});

describe("shares in issue", () => {
  it("defaults to the configured count, all the student's", () => {
    const state = begin();
    expect(state.shareholders).toEqual([{ id: "student", shares: 10_000, day: 1 }]);
    const table = sim.capTable(state);
    expect(table.sharesInIssue).toBe(10_000);
    expect(table.rows).toEqual([
      { id: "student", name: "You", shares: 10_000, share: 1, value: sim.valuation(state).valuation },
    ]);
  });

  it("can be picked from 10,000 to 100,000 at the start, the student owning 100%", () => {
    for (const shares of [10_000, 25_000, 100_000]) {
      const table = sim.capTable(begin(sim, shares));
      expect(table.sharesInIssue).toBe(shares);
      expect(table.rows).toMatchObject([{ id: "student", shares, share: 1 }]);
    }
  });

  it("refuses a count outside the range or not whole", () => {
    for (const shares of [9_999, 100_001, 12_345.5]) {
      expect(refusal(() => begin(sim, shares))).toBe("bad_shares");
    }
  });

  it("sets the share price: valuation ÷ shares in issue", () => {
    const few = sim.valuation(begin(sim, 10_000));
    const many = sim.valuation(begin(sim, 100_000));
    expect(few.valuation).toBe(many.valuation);
    expect(few.sharePrice).toBe(few.valuation / 10_000);
    expect(many.sharePrice).toBeCloseTo(few.sharePrice / 10, 10);
  });
});

describe("valuation", () => {
  const total = (v: ReturnType<Sim["valuation"]>) => v.drivers.reduce((sum, d) => sum + d.amount, 0);

  it("is the minimum for a company with no revenue, saying so", () => {
    const v = sim.valuation({ ...begin(), paidUsers: 0 });
    expect(v.valuation).toBe(quiet.valuation.minimum);
    expect(v.drivers.at(-1)).toMatchObject({ id: "minimum" });
    expect(total(v)).toBe(v.valuation);
  });

  it("comes from annual revenue × the multiple plus paying users × their value, the drivers adding up to it", () => {
    const state = trading(begin(), 2_000, 10);
    const v = sim.valuation(state);
    const annual = Math.round(sim.dailyIncome(state) * 365);
    expect(v.annualRevenue).toBe(annual);
    expect(v.multiple).toBe(quiet.valuation.revenueMultiple);
    expect(v.valuation).toBe(annual * quiet.valuation.revenueMultiple + 2_000 * quiet.valuation.valuePerPayingUser);
    expect(v.drivers.map((d) => d.id)).toEqual(["revenue", "growth", "satisfaction", "uptime", "payingUsers"]);
    expect(total(v)).toBe(v.valuation);
  });

  it("is pushed down by poor satisfaction and up by growth", () => {
    const state = trading(sim.advance(begin(), 5).state, 2_000, 10);
    const steady = sim.valuation(state);
    const unhappy = sim.valuation({ ...state, satisfaction: 35 });
    expect(unhappy.valuation).toBeLessThan(steady.valuation);
    expect(unhappy.drivers.find((d) => d.id === "satisfaction")!.amount).toBeLessThan(0);
    const growing = sim.valuation({ ...state, paidUsers: 3_000, users: 6_000 });
    expect(growing.drivers.find((d) => d.id === "growth")!.amount).toBeGreaterThan(0);
    expect(total(growing)).toBe(growing.valuation);
  });

  it("doesn't count the launch ramp's users arriving as growth", () => {
    const ramping = begin();
    expect(sim.launch(ramping).status).toBe("launching");
    const v = sim.valuation({ ...ramping, paidUsers: ramping.paidUsers * 5 });
    expect(v.growth).toBe(0);
    // After it, growth counts from the users there at its end.
    const launched = sim.advance(ramping, 5).state;
    expect(sim.launch(launched).status).toBe("launched");
    const grown = sim.valuation({ ...launched, paidUsers: launched.paidUsers * 2 });
    const rampEnd = launched.spendByDay.find((d) => d.day === launched.launchDay! + quiet.launch.rampShares.length - 1)!;
    expect(grown.growth).toBeCloseTo((launched.paidUsers * 2 - rampEnd.paidUsers) / rampEnd.paidUsers, 10);
  });

  it("is pushed down by poor recent uptime", () => {
    const state = trading(begin(), 2_000, 10);
    const down = sim.valuation({ ...state, recentHoursDown: [12, 0, 0, 0] });
    expect(down.recentUptime).toBe(87.5);
    expect(down.drivers.find((d) => d.id === "uptime")!.amount).toBeLessThan(0);
    expect(down.valuation).toBeLessThan(sim.valuation(state).valuation);
  });

  it("counts paying users, so a higher price alone can't inflate it as much as more payers", () => {
    const state = begin();
    const dear = sim.valuation(trading(state, 1_000, 20));
    const many = sim.valuation(trading(state, 2_000, 10));
    expect(many.valuation).toBeGreaterThan(dear.valuation);
  });
});

describe("friends and family", () => {
  it("offers a fixed amount for new shares at today's share price, previewing the dilution", () => {
    const state = begin();
    const offer = sim.funding(state).friendsAndFamilyOffer!;
    const { valuation, sharePrice } = sim.valuation(state);
    const amount = quiet.funding.friendsAndFamily.amount;
    expect(offer).toMatchObject({ amount, valuation, sharePrice, sharesInIssue: 10_000, yourShareBefore: 1 });
    expect(offer.newShares).toBe(Math.round((amount * 10_000) / valuation));
    expect(offer.sharesAfter).toBe(10_000 + offer.newShares);
    expect(offer.theirShare).toBeCloseTo(amount / (valuation + amount), 4);
    expect(offer.yourShareAfter).toBeCloseTo(1 - offer.theirShare, 10);
  });

  it("creates the new shares and dilutes the student, as the preview said, and brings the cash at once", () => {
    const state = begin();
    const offer = sim.funding(state).friendsAndFamilyOffer!;
    const after = sim.applyAction(state, { type: "acceptFunding", funder: "friendsAndFamily" });
    expect(after.cash).toBe(state.cash + offer.amount);
    // Not income: they bought shares with it.
    expect(after.income).toBe(state.income);
    expect(after.spendByDay.at(-1)!.raised).toBe(offer.amount);
    const table = sim.capTable(after);
    expect(table.sharesInIssue).toBe(offer.sharesAfter);
    expect(table.rows).toMatchObject([
      { id: "student", shares: 10_000, share: offer.yourShareAfter },
      { id: "friendsAndFamily", name: "Friends and family", shares: offer.newShares, share: offer.theirShare },
    ]);
    expect(sim.funding(after)).toMatchObject({
      friendsAndFamilyOffer: null,
      friendsAndFamily: { status: "accepted", day: 1, amount: offer.amount, shares: offer.newShares },
    });
  });

  it("can be taken once", () => {
    const after = sim.applyAction(begin(), { type: "acceptFunding", funder: "friendsAndFamily" });
    expect(refusal(() => sim.applyAction(after, { type: "acceptFunding", funder: "friendsAndFamily" }))).toBe(
      "funding_answered",
    );
    expect(refusal(() => sim.applyAction(after, { type: "declineFunding", funder: "friendsAndFamily" }))).toBe(
      "funding_answered",
    );
  });

  it("costs far less of the company once it's worth more", () => {
    const early = sim.funding(begin()).friendsAndFamilyOffer!;
    const later = sim.funding(trading(begin(), 2_000, 10)).friendsAndFamilyOffer!;
    expect(later.theirShare).toBeLessThan(early.theirShare / 5);
  });

  it("can be declined for good, leaving the cap table as it was", () => {
    const state = begin();
    const after = sim.applyAction(state, { type: "declineFunding", funder: "friendsAndFamily" });
    expect(after.cash).toBe(state.cash);
    expect(after.shareholders).toEqual(state.shareholders);
    expect(sim.funding(after)).toMatchObject({ friendsAndFamilyOffer: null, friendsAndFamily: { status: "declined" } });
    expect(refusal(() => sim.applyAction(after, { type: "acceptFunding", funder: "friendsAndFamily" }))).toBe(
      "funding_answered",
    );
  });

  it("refuses a funder it doesn't know", () => {
    // The server checks the funder too: this is for a caller that doesn't.
    const action = { type: "acceptFunding", funder: "angel" } as unknown as Parameters<Sim["applyAction"]>[1];
    expect(refusal(() => sim.applyAction(begin(), action))).toBe("unknown_funder");
  });
});

describe("the grant", () => {
  const { amount, days, minUptime } = quiet.funding.grant;
  const accept = (s: Sim, state: GameState) => s.applyAction(state, { type: "acceptFunding", funder: "grant" });
  const fundingEntries = (log: DayLog[]) =>
    log.flatMap((d) => d.entries).filter((e) => e.kind === "funding");

  it("shows its condition and what happens if it's broken before it's accepted", () => {
    const offer = sim.funding(begin()).grantOffer!;
    expect(offer).toMatchObject({ amount, days, untilDay: 1 + days, minUptime, maxHoursDown: 14.4 });
    expect(offer.condition).toBe(
      `Keep uptime at 99% or more for the ${days} days after you accept it: at most 14.4 hours down in all.`,
    );
    expect(offer.ifMissed).toMatch(/withdrawn: all £10,000 is paid back/);
  });

  it("gives cash and takes no shares", () => {
    const state = begin();
    const after = accept(sim, state);
    expect(after.cash).toBe(state.cash + amount);
    expect(after.shareholders).toEqual(state.shareholders);
    expect(sim.funding(after)).toMatchObject({
      grantOffer: null,
      grant: { status: "accepted", day: 1, untilDay: 1 + days, hoursDown: 0, daysLeft: days, hoursLeft: 14.4 },
    });
  });

  it("is kept when uptime holds over its days, counting the hours down on the way", () => {
    const s = createSim({ ...quiet, events: [outageOn([5], 6)] });
    const { state, log } = s.advance(accept(s, begin(s)), days);
    expect(state.day).toBe(1 + days);
    expect(sim.funding(state).grant).toMatchObject({ status: "met", hoursDown: 6, daysLeft: 0, hoursLeft: 0 });
    expect(fundingEntries(log)).toEqual([
      expect.objectContaining({ cashDelta: 0, text: expect.stringMatching(/^Grant condition met: 6 hours down/) }),
    ]);
  });

  it("is withdrawn and paid back the day hours down go over what its condition allows", () => {
    const s = createSim({ ...quiet, events: [outageOn([5, 9, 14], 6)] });
    const accepted = accept(s, begin(s));
    const before = s.advance(accepted, 12).state;
    expect(s.funding(before).grant).toMatchObject({ status: "accepted", hoursDown: 12, hoursLeft: 2.4 });
    const { state, log } = s.advance(before, 5);
    expect(s.funding(state).grant).toMatchObject({ status: "withdrawn", hoursDown: 18 });
    const [withdrawn] = fundingEntries(log);
    expect(withdrawn).toMatchObject({ cashDelta: -amount });
    expect(withdrawn!.text).toMatch(/^Grant withdrawn: 18 hours down/);
    expect(log.find((d) => d.entries.includes(withdrawn!))!.day).toBe(14);
    // Paid back as money raised in reverse, so the cash chart still adds up.
    expect(state.spendByDay.find((d) => d.day === 14)!.raised).toBe(-amount);
    const days2 = s.summarise(state).days;
    expect(days2.at(-1)!.cash).toBe(state.cash);
    expect(days2[0]!.cash).toBe(accepted.cash);
  });

  it("ignores downtime before it was accepted and after its days", () => {
    const s = createSim({ ...quiet, events: [outageOn([3, 2 + 3 + days], 20)] });
    const late = s.advance(begin(s), 3).state;
    const { state } = s.advance(accept(s, late), days + 2);
    expect(s.funding(state).grant).toMatchObject({ status: "met", hoursDown: 0 });
  });

  it("can be taken once, or declined for good", () => {
    const after = accept(sim, begin());
    expect(refusal(() => accept(sim, after))).toBe("funding_answered");
    const declined = sim.applyAction(begin(), { type: "declineFunding", funder: "grant" });
    expect(sim.funding(declined)).toMatchObject({ grantOffer: null, grant: { status: "declined", daysLeft: 0 } });
    expect(refusal(() => accept(sim, declined))).toBe("funding_answered");
  });

  it("is independent of friends and family: both can be taken", () => {
    const state = begin();
    const both = accept(sim, sim.applyAction(state, { type: "acceptFunding", funder: "friendsAndFamily" }));
    expect(both.cash).toBe(state.cash + amount + quiet.funding.friendsAndFamily.amount);
  });
});
