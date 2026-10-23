import { describe, expect, it } from "vitest";
import { createSim, defaultConfig, type Action, type DayLog, type GameConfig, type GameState } from "../src/index.ts";

const sim = createSim();
const product = defaultConfig.productTypes.payments;
const tx = product.transactions!;
const perMonth = defaultConfig.billing.daysPerMonth;

/** The default config with the payments app changed. */
function withPayments(change: (p: typeof product) => typeof product, rest: Partial<GameConfig> = {}): GameConfig {
  return { ...defaultConfig, ...rest, productTypes: { ...defaultConfig.productTypes, payments: change(product) } };
}

/** A payments company on SaaS, 20 days in: launched, with paying businesses. */
const running = (s = sim, model = "saas", days = 20): GameState =>
  s.advance(s.newGame({ companyName: "Pay Co", productType: "payments", model, seed: 7 }), days).state;

const income = (log: DayLog[]) => log.flatMap((d) => d.entries).filter((e) => e.kind === "income");
const stream = (log: DayLog[], name: "fees" | "transactions") => income(log).filter((e) => e.stream === name);
const setPrice = (price: number, rate?: number): Action => ({ type: "setPrice", price, ...(rate === undefined ? {} : { rate }) });

describe("payments app: two prices", () => {
  it("starts at the fair fee and rate, judged together as what a usual month costs a business", () => {
    const state = sim.newGame({ companyName: "Pay Co", productType: "payments", model: "saas", seed: 1 });
    expect(state).toMatchObject({ price: product.pricing.fairPrice, transactionRate: tx.fairRate });
    const pay = sim.payments(state)!;
    const fairMonthly = product.pricing.fairPrice + tx.fairRate * tx.volumePerPaidUser;
    expect(pay).toMatchObject({ fee: 10, rate: 0.02, fairFee: 10, fairRate: 0.02, monthly: fairMonthly, fairMonthly });
    // The customer mix's thresholds are in the same terms.
    const mix = sim.customerMix(state);
    expect(mix).toMatchObject({ price: fairMonthly, fairPrice: fairMonthly, includesRate: true });
    expect(mix.types.at(-1)!.threshold).toBe(fairMonthly * defaultConfig.customerTypes.businesses.thresholdMultiple);
  });

  it("is mostly businesses", () => {
    const mix = sim.customerMix(running());
    const businesses = mix.types.find((t) => t.id === "businesses")!;
    expect(businesses.share).toBeGreaterThanOrEqual(0.5);
  });

  it("has no transaction rate or payments view on other products, and refuses one", () => {
    const shop = sim.newGame({ companyName: "Shop", productType: "ecommerce", model: "saas", seed: 1 });
    expect(shop.transactionRate).toBeNull();
    expect(sim.payments(shop)).toBeNull();
    expect(sim.customerMix(shop).includesRate).toBe(false);
    expect(() => sim.applyAction(shop, setPrice(5, 0.02))).toThrow(expect.objectContaining({ code: "no_transaction_rate" }));
  });

  it("sets both in one change, with one lock", () => {
    const state = running();
    const changed = sim.applyAction(state, setPrice(12, 0.025));
    expect(changed).toMatchObject({ price: 12, transactionRate: 0.025 });
    expect(changed.priceChanges.at(-1)).toEqual({ day: state.day + 1, from: 10, to: 12, fromRate: 0.02, toRate: 0.025 });
    expect(sim.priceLockDaysLeft(changed)).toBe(defaultConfig.pricing.lockDays);
    // Either part alone is locked too.
    expect(() => sim.applyAction(changed, setPrice(12, 0.03))).toThrow(expect.objectContaining({ code: "price_locked" }));
    expect(() => sim.applyAction(changed, setPrice(13))).toThrow(expect.objectContaining({ code: "price_locked" }));
    // The fee alone keeps today's rate.
    expect(sim.applyAction(state, setPrice(11))).toMatchObject({ price: 11, transactionRate: 0.02 });
  });

  it("allows a £0 fee with a rate, but not both at 0, nor a rate over the most", () => {
    const state = running();
    expect(sim.applyAction(state, setPrice(0, 0.03))).toMatchObject({ price: 0, transactionRate: 0.03 });
    expect(() => sim.applyAction(state, setPrice(0, 0))).toThrow(expect.objectContaining({ code: "bad_price" }));
    expect(() => sim.applyAction(state, setPrice(10, tx.maxRate + 0.01))).toThrow(expect.objectContaining({ code: "rate_too_high" }));
    expect(() => sim.applyAction(state, setPrice(10, -0.01))).toThrow(expect.objectContaining({ code: "bad_rate" }));
  });

  it("reacts to a rise in the rate as to the same rise in the fee", () => {
    const state = running();
    // +£5 a usual month either way: £15 + 2%, or £10 + 2.5% of £1,000.
    const byFee = sim.pricePreview(state, 15, 0.02);
    const byRate = sim.pricePreview(state, 10, 0.025);
    expect(byFee.monthly).toBe(35);
    expect(byRate.monthly).toBe(35);
    expect(byRate.direction).toBe("rise");
    expect(byRate.total).toEqual(byFee.total);
    expect(byRate.reaction).toBeCloseTo(byFee.reaction, 12);
    expect(byRate.dailyIncome).toBe(byFee.dailyIncome);
  });

  it("starts no wave when money only moves between the fee and the rate, but still locks the price", () => {
    const state = running();
    const preview = sim.pricePreview(state, 0, 0.03);
    expect(preview).toMatchObject({ direction: "none", monthly: 30, total: { left: 0, toFree: 0, joined: 0, upgraded: 0 } });
    const moved = sim.applyAction(state, setPrice(0, 0.03));
    expect(moved.priceWave).toBe(state.priceWave);
    expect(sim.priceLockDaysLeft(moved)).toBe(defaultConfig.pricing.lockDays);
    const after = sim.advance(moved, 7).state;
    expect(after.paidUsers).toBeGreaterThan(state.paidUsers * 0.95);
  });

  it("counts small rises split between the fee and the rate as one rise to the same usual month", () => {
    const start = running(sim, "saas", 40);
    // The share of paying users a change's wave keeps, as planned from the payers there when it's made.
    const kept = (s: GameState, fee: number, rate: number) => {
      const { total } = sim.pricePreview(s, fee, rate);
      return 1 - (total.left + total.toFree) / s.paidUsers;
    };
    // One rise to £45 a usual month, against three steps: fee, rate, fee.
    const once = kept(start, 25, 0.02);
    let keptSteps = 1;
    let s = start;
    for (const [fee, rate] of [
      [15, 0.02],
      [15, 0.025],
      [20, 0.025],
    ] as const) {
      keptSteps *= kept(s, fee, rate);
      s = sim.advance(sim.applyAction(s, setPrice(fee, rate)), 15).state;
    }
    expect(sim.payments(s)!.monthly).toBe(45);
    expect(once).toBeLessThan(0.97);
    expect(Math.abs(keptSteps - once)).toBeLessThan(0.02);
  });

  it("brings no cut wave for cutting the rate and putting the fee up again within the memory", () => {
    const state = running(sim, "saas", 40);
    const cut = sim.advance(sim.applyAction(state, setPrice(10, 0)), 14).state;
    // Back to £30 a usual month all in the fee: a rise from the £10 customers remember.
    const back = sim.pricePreview(cut, 30, 0);
    expect(back.direction).toBe("rise");
    expect(back.reaction).toBeGreaterThan(0);
    expect(sim.pricePreview(cut, 30, 0).reaction).toBeCloseTo(sim.pricePreview(cut, 10, 0.02).reaction, 12);
  });
});

describe("payments app: income", () => {
  it("earns the fee and a share of each payment, as two streams that add up on Finance", () => {
    const state = running();
    const { state: after, log } = sim.advance(state);
    const [fees] = stream(log, "fees");
    const [transactions] = stream(log, "transactions");
    expect(fees!.cashDelta).toBe(Math.round((state.paidUsers * 10) / perMonth));
    const payments = ((state.paidUsers * tx.volumePerPaidUser) / perMonth) * sim.payments(state)!.nextDay.multiplier;
    expect(transactions!.cashDelta).toBeCloseTo(Math.round(payments * 0.02), -1);
    expect(transactions!.text).toMatch(/^Transaction fees: 2% of £[\d,]+ of payments/);
    expect(after.feeIncome - state.feeIncome).toBe(fees!.cashDelta);
    expect(after.transactionIncome - state.transactionIncome).toBe(transactions!.cashDelta);
    expect(after.spendByDay.at(-1)).toMatchObject({ feeIncome: fees!.cashDelta, transactionIncome: transactions!.cashDelta });
    // Everything coming in is one stream or the other (no API bought).
    expect(after.income).toBe(after.feeIncome + after.transactionIncome);
    expect(sim.payments(after)).toMatchObject({ feeIncome: after.feeIncome, transactionIncome: after.transactionIncome });
  });

  it("takes no fee stream at a £0 fee, and no transaction stream at 0%", () => {
    const state = running();
    const rateOnly = sim.advance(sim.applyAction(state, setPrice(0, 0.03))).log;
    expect(stream(rateOnly, "fees")).toEqual([]);
    expect(stream(rateOnly, "transactions")).toHaveLength(1);
    const feeOnly = sim.advance(sim.applyAction(state, setPrice(30, 0))).log;
    expect(stream(feeOnly, "transactions")).toEqual([]);
    expect(stream(feeOnly, "fees")).toHaveLength(1);
  });

  it("follows payday: busier on payday, quieter between, and a month's payments average out", () => {
    const s = createSim(withPayments((p) => ({ ...p, transactions: { ...tx, payday: { firstDay: 5, every: 10, length: 2, multiplier: 2 } } })));
    const state = s.newGame({ companyName: "Pay Co", productType: "payments", model: "saas", seed: 1 });
    const multipliers = Array.from({ length: 10 }, (_, i) => s.payments({ ...state, day: 14 + i })!.nextDay);
    // Days 15–16 are paydays (5, 15, 25…), at twice a usual day; the rest are quieter.
    expect(multipliers.filter((d) => d.busy === "payday").map((d) => d.day)).toEqual([15, 16]);
    expect(multipliers.find((d) => d.day === 15)!.multiplier).toBe(2);
    expect(multipliers.find((d) => d.day === 17)!.multiplier).toBe(0.75);
    const total = multipliers.reduce((sum, d) => sum + d.multiplier, 0);
    expect(total).toBeCloseTo(10, 6);
    expect(s.payments({ ...state, day: 16 })!.nextPayday).toBe(25);
  });

  it("rushes on Black Friday on the calendar: payments and load jump, and growth too", () => {
    // Day 1 is 1 October 2026, so Black Friday (27 November) is day 58.
    const started = sim.newGame({ companyName: "Pay Co", productType: "payments", model: "saas", seed: 7, startDate: "2026-10-01" });
    const state = sim.advance(started, 20).state;
    const blackFriday = sim.calendar(state).upcoming.find((h) => h.id === "blackFriday")!;
    expect(blackFriday.startDay).toBe(58);
    const effect = blackFriday.effect!;
    expect(effect.loadMultiplier).toBeGreaterThan(2);
    expect(effect.growthMultiplier).toBeGreaterThan(1);
    const quiet = sim.advance({ ...state, day: blackFriday.startDay - 10 });
    const rush = sim.advance({ ...state, day: blackFriday.startDay - 1 });
    const quietIncome = stream(quiet.log, "transactions")[0]!;
    const rushIncome = stream(rush.log, "transactions")[0]!;
    expect(rushIncome.text).toContain("Black Friday rush");
    expect(rushIncome.cashDelta / quietIncome.cashDelta).toBeGreaterThan(effect.loadMultiplier * 0.9);
    expect(sim.payments({ ...state, day: blackFriday.startDay - 1 })!.nextDay).toMatchObject({ busy: "black-friday" });
    expect(sim.payments(state)!.nextBlackFriday).toBe(blackFriday.startDay);
    // None to come once the last Black Friday before the final day has passed.
    expect(sim.payments({ ...state, day: blackFriday.startDay + 10 })!.nextBlackFriday).toBeNull();
  });

  it("takes no payments and no fee for the hours down, and loses payers faster than other products", () => {
    // IaaS with the smallest servers, then far more users than they serve: an outage tomorrow.
    let state = sim.newGame({ companyName: "Pay Co", productType: "payments", model: "iaas", seed: 3 });
    state = sim.applyAction(state, { type: "rentServer", server: "app", size: "small" });
    state = sim.applyAction(state, { type: "rentServer", server: "database", size: "small" });
    state = sim.advance(state, 10).state;
    const crowded = { ...state, users: 20_000, paidUsers: 10_000 };
    const { log } = sim.advance(crowded);
    const outage = log[0]!.entries.find((e) => e.kind === "outage")!;
    expect(outage).toBeDefined();
    const hours = Number(/Down (\d+) hours/.exec(outage.text)![1]);
    const transactions = stream(log, "transactions")[0];
    if (hours >= 24) expect(transactions).toBeUndefined();
    else expect(transactions!.text).toContain(`none taken in the ${hours} hours down`);
    // Businesses aren't charged the fee for the hours down either, so a fee-only price is no shelter from an outage.
    const fees = stream(log, "fees")[0];
    const feeDue = Math.round(((10_000 * 10) / perMonth) * Math.max(0, 1 - hours / 24));
    if (feeDue > 0) expect(fees).toMatchObject({ cashDelta: feeDue, text: expect.stringContaining(`less ${hours} hours down`) });
    else expect(fees).toBeUndefined();

    // The same outage loses twice the payers with outageChurnMultiple 2 as with 1.
    const lostWith = (multiple: number) => {
      const s = createSim(
        withPayments((p) => ({ ...p, outageChurnMultiple: multiple }), { outage: { ...defaultConfig.outage, paidChurnPerHour: 0.01 } }),
      );
      const day = s.advance(crowded).log[0]!;
      const line = day.entries.find((e) => e.text.startsWith("Paying users lost"));
      return line ? Number(/([\d,]+)/.exec(line.text.replace(/,/g, ""))![1]) : 0;
    };
    expect(lostWith(2)).toBeGreaterThan(lostWith(1) * 1.5);
  });

  it("on SaaS, pays the platform a share of every payment, whatever the fee and rate", () => {
    const state = running();
    const charge = (log: DayLog[]) => log.flatMap((d) => d.entries).find((e) => e.text.startsWith("SaaS platform's"));
    const atFair = charge(sim.advance(state).log)!;
    const allFee = charge(sim.advance(sim.applyAction(state, setPrice(30, 0))).log)!;
    expect(atFair.category).toBe("infrastructure");
    expect(allFee.cashDelta).toBe(atFair.cashDelta);
    expect(sim.payments(state)!.usualDaySaasFee).toBe(Math.round(((state.paidUsers * tx.volumePerPaidUser) / perMonth) * tx.saasFeeRate));
    // The runway counts it as a cost.
    expect(sim.runway(state).dailyCosts).toBeGreaterThanOrEqual(sim.payments(state)!.usualDaySaasFee);
    // Off SaaS there's none.
    const paas = running(sim, "paas");
    expect(sim.payments(paas)!.usualDaySaasFee).toBe(0);
  });

  it("counts the rate in a usual day's income and the valuation's fair price", () => {
    const state = running();
    const pay = sim.payments(state)!;
    expect(sim.dailyIncome(state)).toBe(Math.round((state.paidUsers * pay.monthly) / perMonth));
    expect(Math.abs(sim.dailyIncome(state) - (pay.usualDayFees + pay.usualDayTransactionFees))).toBeLessThanOrEqual(1);
    const paying = sim.valuation(state).drivers.find((d) => d.id === "payingUsers")!;
    // Each paying business is measured against a usual month at the fair fee and rate, not the fee alone.
    expect(paying.detail).toContain("at the fair price of £30 a month");
  });
});
