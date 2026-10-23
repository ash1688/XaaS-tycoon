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

/** Days the valuation averages over. */
const AVERAGE = quiet.valuation.averageDays;

/**
 * A company with these paying users at this price and satisfaction, for valuation, as if they'd always had them and
 * paid it: launched and a full averaging window in, every day's income what they pay.
 */
const trading = (state: GameState, paidUsers: number, price: number, satisfaction = 100): GameState => {
  const played = state.day <= AVERAGE ? sim.advance(state, AVERAGE + 1 - state.day).state : state;
  const income = (paidUsers * price) / quiet.billing.daysPerMonth;
  return {
    ...played,
    users: paidUsers * 2,
    paidUsers,
    price,
    satisfaction,
    spendByDay: played.spendByDay.map((d) => ({ ...d, paidUsers, income, satisfaction })),
  };
};

/** The state with each of its last `days` days changed. */
const lastDays = (state: GameState, days: number, change: Partial<GameState["spendByDay"][number]>): GameState => ({
  ...state,
  spendByDay: state.spendByDay.map((d) => (d.day > state.day - days ? { ...d, ...change } : d)),
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
  const driver = (v: ReturnType<Sim["valuation"]>, id: string) => v.drivers.find((d) => d.id === id)?.amount ?? 0;
  const fair = quiet.productTypes.social.pricing.fairPrice;

  it("is the minimum for a company with no revenue and little cash, saying so", () => {
    const v = sim.valuation({ ...begin(), paidUsers: 0 });
    expect(v.valuation).toBe(quiet.valuation.minimum);
    expect(v.drivers.at(-1)).toMatchObject({ id: "minimum" });
    expect(total(v)).toBe(v.valuation);
  });

  it("comes from annual revenue × the multiple, paying users × their value and net cash, the drivers adding up to it", () => {
    const state = trading(begin(), 2_000, 10);
    const v = sim.valuation(state);
    // The income every day of the last 30 earned: 2,000 payers × £10 a month ÷ 30 days.
    const annual = Math.round(((2_000 * 10) / 30) * 365);
    expect(v.annualRevenue).toBe(annual);
    expect(v.multiple).toBe(quiet.valuation.revenueMultiple);
    expect(v.valuation).toBe(
      Math.round(annual * quiet.valuation.revenueMultiple) + 2_000 * quiet.valuation.valuePerPayingUser + Math.round(state.cash),
    );
    expect(v.drivers.map((d) => d.id)).toEqual(["revenue", "growth", "satisfaction", "uptime", "payingUsers", "netCash"]);
    expect(total(v)).toBe(v.valuation);
  });

  it("is nothing once the company is in liquidation, whatever the minimum", () => {
    const v = sim.valuation({ ...trading(begin(), 2_000, 10), status: "liquidated" });
    expect(v.valuation).toBe(0);
    expect(v.sharePrice).toBe(0);
    expect(v.drivers.at(-1)).toMatchObject({ id: "liquidation" });
    expect(total(v)).toBe(0);
  });

  it("counts cash less the money borrowed still to pay back on a loan", () => {
    const loaned = trading(sim.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 42, takeLoan: true }), 2_000, 10);
    const owed = sim.loan(loaned)!.payoff;
    expect(owed).toBeGreaterThan(0);
    expect(driver(sim.valuation(loaned), "netCash")).toBe(Math.round(loaned.cash - owed));
    // £10k more in the bank is £10k more valuation.
    expect(sim.valuation({ ...loaned, cash: loaned.cash + 10_000 }).valuation).toBe(sim.valuation(loaned).valuation + 10_000);
  });

  it("counts income earned, so a price change doesn't move it until the income comes in", () => {
    const state = trading(begin(), 2_000, 10);
    const before = sim.valuation(state);
    const spiked = sim.applyAction(sim.load({ ...state, priceLockedUntil: 0 }), { type: "setPrice", price: 1_000 });
    expect(sim.valuation(spiked).valuation).toBe(before.valuation);
    expect(sim.funding(spiked).friendsAndFamilyOffer!.newShares).toBe(sim.funding(state).friendsAndFamilyOffer!.newShares);
  });

  it("has no revenue before income has come in, and builds it up over the first weeks", () => {
    expect(sim.valuation(begin()).annualRevenue).toBe(0);
    const early = sim.advance(begin(), 5).state;
    const earned = early.spendByDay.reduce((sum, d) => sum + d.income, 0);
    expect(earned).toBeGreaterThan(0);
    // Five days' income over the 30-day window, not five days' average.
    expect(sim.valuation(early).annualRevenue).toBe(Math.round((earned / AVERAGE) * 365));
  });

  it("counts income lost within fallDays, though a rise counts over the whole window", () => {
    const state = trading(begin(), 2_000, 10);
    const steady = sim.valuation(state).annualRevenue;
    const fall = quiet.valuation.fallDays;
    // A week of no income: revenue goes with it, not a week's share of the month.
    expect(sim.valuation(lastDays(state, fall, { income: 0 })).annualRevenue).toBe(0);
    // A week of double income adds only a week's share of it.
    const doubled = sim.valuation(lastDays(state, fall, { income: ((2_000 * 10) / 30) * 2 })).annualRevenue;
    expect(doubled).toBeCloseTo(steady * (1 + fall / AVERAGE), -1);
  });

  it("is pushed down by poor satisfaction over the window, not one day's", () => {
    const state = trading(begin(), 2_000, 10);
    const steady = sim.valuation(state);
    // Today's satisfaction alone doesn't move it.
    expect(sim.valuation({ ...state, satisfaction: 0 }).valuation).toBe(steady.valuation);
    const unhappy = sim.valuation(lastDays(state, AVERAGE, { satisfaction: 35 }));
    expect(unhappy.valuation).toBeLessThan(steady.valuation);
    expect(driver(unhappy, "satisfaction")).toBeLessThan(0);
    // A bad week alone costs nothing: the window's average stays above the line.
    expect(driver(sim.valuation(lastDays(state, 7, { satisfaction: 35 })), "satisfaction")).toBe(0);
  });

  it("is pushed up by growth in average paying users on the window before", () => {
    // Long enough after launch for growth to count in full.
    const state = sim.advance(trading(begin(), 1_000, 10), AVERAGE + 10).state;
    const grown = lastDays(state, AVERAGE, { paidUsers: 1_500 });
    const v = sim.valuation({ ...grown, paidUsers: 1_500 });
    expect(v.growth).toBeGreaterThan(0.3);
    expect(driver(v, "growth")).toBeGreaterThan(0);
    expect(total(v)).toBe(v.valuation);
    // One day's jump in payers isn't growth.
    expect(sim.valuation({ ...state, paidUsers: state.paidUsers * 3 }).growth).toBe(sim.valuation(state).growth);
  });

  it("doesn't count the launch ramp's users arriving as growth", () => {
    const ramping = begin();
    expect(sim.launch(ramping).status).toBe("launching");
    expect(sim.valuation({ ...ramping, paidUsers: ramping.paidUsers * 5 }).growth).toBe(0);
    const launched = sim.advance(ramping, 5).state;
    expect(sim.launch(launched).status).toBe("launched");
    // Nor the weeks after it.
    expect(sim.valuation({ ...launched, paidUsers: launched.paidUsers * 5 }).growth).toBe(0);
    const rampEnd = launched.launchDay! + quiet.launch.rampShares.length - 1;
    // Then it builds up as the days to compare with come after the ramp, from nothing.
    const start = rampEnd + quiet.valuation.growthDays;
    expect(sim.valuation(sim.advance(launched, start - 1 - launched.day).state).growth).toBe(0);
    const firstDay = sim.valuation(sim.advance(launched, start - launched.day).state).growth;
    const whole = sim.valuation(sim.advance(launched, start + AVERAGE - 1 - launched.day).state).growth;
    expect(Math.abs(firstDay)).toBeLessThan(Math.abs(whole) / 5);
  });

  it("is pushed down by poor recent uptime", () => {
    const state = trading(begin(), 2_000, 10);
    const down = sim.valuation({ ...state, recentHoursDown: [12, 0, 0, 0] });
    expect(down.recentUptime).toBe(87.5);
    expect(driver(down, "uptime")).toBeLessThan(0);
    expect(down.valuation).toBeLessThan(sim.valuation(state).valuation);
  });

  it("can't swing several-fold in days: a crash in satisfaction, uptime and payers for a week costs well under half", () => {
    const state = trading(begin(), 2_000, 10);
    const crashed = lastDays(state, 7, { satisfaction: 0, paidUsers: 1_500 });
    const v = sim.valuation({ ...crashed, satisfaction: 0, paidUsers: 1_500, recentHoursDown: [24, 24, 24, 24, 24, 24, 24] });
    expect(v.valuation).toBeGreaterThan(sim.valuation(state).valuation * 0.6);
    expect(total(v)).toBe(v.valuation);
  });

  it("never counts revenue for less than the lowest multiple", () => {
    const state = lastDays(trading(begin(), 2_000, 10), AVERAGE, { satisfaction: 0 });
    const v = sim.valuation({ ...state, satisfaction: 0, recentHoursDown: [24, 24, 24, 24, 24, 24, 24] });
    expect(v.multiple).toBe(quiet.valuation.minMultiple);
    expect(v.drivers.map((d) => d.id)).toContain("multipleFloor");
    const revenueParts = v.drivers.filter((d) => !["payingUsers", "netCash", "minimum"].includes(d.id));
    expect(revenueParts.reduce((sum, d) => sum + d.amount, 0)).toBe(Math.round(v.annualRevenue * quiet.valuation.minMultiple));
  });

  it("counts a rush of paying users slowly but losing them at once", () => {
    const state = trading(begin(), 2_000, 10);
    const each = quiet.valuation.valuePerPayingUser;
    expect(driver(sim.valuation({ ...state, paidUsers: 6_000 }), "payingUsers")).toBe(2_000 * each);
    expect(driver(sim.valuation({ ...state, paidUsers: 500 }), "payingUsers")).toBe(500 * each);
  });

  it("counts paying users, so a higher price alone can't inflate it as much as more payers", () => {
    const state = begin();
    const dear = sim.valuation(trading(state, 1_000, 20));
    const many = sim.valuation(trading(state, 2_000, 10));
    expect(many.valuation).toBeGreaterThan(dear.valuation);
  });

  it("values paying users at what they pay below the fair price, so a give-away price can't inflate it", () => {
    const each = quiet.valuation.valuePerPayingUser;
    const atFair = sim.valuation(trading(begin(), 2_000, fair));
    expect(driver(atFair, "payingUsers")).toBe(2_000 * each);
    const pennies = sim.valuation(trading(begin(), 2_000, fair / 100));
    expect(driver(pennies, "payingUsers")).toBe(Math.round((2_000 * each) / 100));
    expect(pennies.drivers.find((d) => d.id === "payingUsers")!.detail).toMatch(/fair price/);
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
    const later = sim.funding(trading(begin(), 5_000, 10)).friendsAndFamilyOffer!;
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
  const { amount, days } = quiet.funding.grant;
  const accept = (s: Sim, state: GameState) => s.applyAction(state, { type: "acceptFunding", funder: "grant" });
  const fundingEntries = (log: DayLog[]) =>
    log.flatMap((d) => d.entries).filter((e) => e.kind === "funding");
  // SaaS launches on day 1, so its ramp takes days 1 to 3 and a grant taken on day 1 counts from day 4.
  const RAMP = quiet.launch.rampShares.length;
  const FROM = 1 + RAMP;
  const UNTIL = FROM + days - 1;

  it("shows its condition and what happens if it's broken before it's accepted", () => {
    const offer = sim.funding(begin()).grantOffer!;
    expect(offer).toMatchObject({ amount, days, fromDay: FROM, untilDay: UNTIL, minUptime: 99, maxHoursDown: 14.4 });
    expect(offer.condition).toBe(
      `Keep uptime at 99% or more for the ${days} days once your launch is over: at most 14.4 hours down in all.`,
    );
    expect(offer.ifMissed).toMatch(/withdrawn: all £10,000 is paid back/);
  });

  it("asks for the uptime that fits the model: less on-prem, where kit takes a week to arrive", () => {
    const onPrem = sim.newGame({ companyName: "Acme", productType: "social", model: "onprem", seed: 42, takeLoan: true });
    const offer = sim.funding(onPrem).grantOffer!;
    // Not launched yet (the kit is on order), so the condition's days aren't known.
    expect(offer).toMatchObject({ minUptime: 98, maxHoursDown: 28.8, fromDay: null, untilDay: null });
    expect(offer.condition).toMatch(/once your launch is over/);
    const accepted = sim.funding(accept(sim, onPrem)).grant!;
    expect(accepted).toMatchObject({ status: "accepted", fromDay: null, untilDay: null, daysLeft: days });
    const paas = sim.newGame({ companyName: "Acme", productType: "social", model: "paas", seed: 42 });
    expect(sim.funding(paas).grantOffer).toMatchObject({ minUptime: 98.5, maxHoursDown: 21.6 });
  });

  it("gives cash and takes no shares", () => {
    const state = begin();
    const after = accept(sim, state);
    expect(after.cash).toBe(state.cash + amount);
    expect(after.shareholders).toEqual(state.shareholders);
    expect(sim.funding(after)).toMatchObject({
      grantOffer: null,
      grant: { status: "accepted", day: 1, days, fromDay: FROM, untilDay: UNTIL, hoursDown: 0, daysLeft: days, hoursLeft: 14.4 },
    });
  });

  it("is kept when uptime holds over its days, counting the hours down on the way", () => {
    const s = createSim({ ...quiet, events: [outageOn([5], 6)] });
    const { state, log } = s.advance(accept(s, begin(s)), UNTIL - 1);
    expect(state.day).toBe(UNTIL);
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
    expect(withdrawn!.text).toMatch(/^Grant withdrawn: 18 hours down since its condition started on day 4/);
    expect(log.find((d) => d.entries.includes(withdrawn!))!.day).toBe(14);
    // Paid back as money raised in reverse, so the cash chart still adds up.
    expect(state.spendByDay.find((d) => d.day === 14)!.raised).toBe(-amount);
    const days2 = s.summarise(state).days;
    expect(days2.at(-1)!.cash).toBe(state.cash);
    expect(days2[0]!.cash).toBe(accepted.cash);
  });

  it("ignores downtime during the launch ramp, before it was accepted and after its days", () => {
    const s = createSim({ ...quiet, events: [outageOn([RAMP, UNTIL + 1], 20)] });
    const { state } = s.advance(accept(s, begin(s)), UNTIL + 1);
    expect(s.funding(state).grant).toMatchObject({ status: "met", hoursDown: 0 });

    // Accepted once the launch is over, it counts from the next day.
    const s2 = createSim({ ...quiet, events: [outageOn([5, 12 + days], 20)] });
    const late = s2.advance(begin(s2), 10).state;
    expect(s2.funding(late).grantOffer).toMatchObject({ fromDay: 12, untilDay: 11 + days });
    expect(s2.funding(late).grantOffer!.condition).toMatch(/for the 60 days after you accept it/);
    const after = s2.advance(accept(s2, late), days + 2).state;
    expect(s2.funding(after).grant).toMatchObject({ status: "met", hoursDown: 0 });
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
