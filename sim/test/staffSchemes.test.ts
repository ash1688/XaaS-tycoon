import { describe, expect, it } from "vitest";
import { playGame, STRATEGIES } from "../scripts/harness.ts";
import { renderCommands, renderStatus, runScript } from "../scripts/textPlay.ts";
import { createSim, defaultConfig, SimError, STAFF_SCHEMES, type GameConfig, type GameState, type SchemeLevels, type Sim } from "../src/index.ts";

// Staff schemes in pay reviews, through the sim's public interface: an offer mixing a cash rise with scheme levels,
// worth the rise plus only the levels added (valued at the scheme valuation), levels that only go up, schemes paid
// every day with the staff, growing with headcount or the wage bill, and what a tribunal's pick applies.

/** A rich company with no events, where the fair rise is inflation and staff walk away there. */
const plainConfig: GameConfig = {
  ...defaultConfig,
  startingCash: 10_000_000,
  events: [],
  payReview: {
    ...defaultConfig.payReview,
    fairRise: { ...defaultConfig.payReview.fairRise, growthWeight: 0, profitBonus: 0, tightCashCut: 0 },
    walkAwaySpread: 0,
  },
};
const plain = createSim(plainConfig);
const withValuation = (schemeValuation: number) => createSim({ ...plainConfig, payReview: { ...plainConfig.payReview, schemeValuation } });
const begin = (s: Sim = plain, seed = 42) => s.newGame({ companyName: "Acme", productType: "social", model: "saas", seed });
const schemes = plainConfig.payReview.schemes;
const round = (n: number) => Math.round(n * 1000) / 1000;

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return null;
};

function untilReview(s: Sim, state: GameState): GameState {
  let current = state;
  while (current.status === "playing" && !current.payReview) current = s.advance(current).state;
  return current;
}

const offer = (s: Sim, state: GameState, rise: number, levels?: Partial<SchemeLevels>) =>
  s.applyAction(state, levels ? { type: "offerPayRise", rise, schemes: levels } : { type: "offerPayRise", rise });
/** Settles the open review at staff's ask in cash with `levels`: worth at least the ask, they accept. */
const settleWith = (s: Sim, state: GameState, levels: Partial<SchemeLevels>) => {
  const review = s.payReview(state)!;
  const worth = s.payOfferPreview(state, review.minOffer, levels).schemeValue;
  return offer(s, state, Math.max(0, Math.floor((review.maxAsk - worth) * 1000) / 1000), levels);
};

/** The permanent staff's headcount and pay a day: what schemes are paid on. */
function base(s: Sim, state: GameState) {
  let headcount = 0;
  let wageBill = 0;
  for (const pool of s.staff(state)) {
    for (const g of pool.grades) {
      headcount += g.count;
      wageBill += g.count * g.dayRate;
    }
  }
  return { headcount, wageBill };
}
const expectedCost = (s: Sim, state: GameState, id: (typeof STAFF_SCHEMES)[number], level: number) => {
  const { headcount, wageBill } = base(s, state);
  const c = s.config.payReview.schemes[id];
  // To the pound, rounded up, like pay.
  return Math.ceil(Number((level * (c.wageShare * wageBill + c.perPerson * headcount)).toFixed(6)));
};

describe("an offer with schemes", () => {
  const open = untilReview(plain, begin());
  const review = plain.payReview(open)!;

  it("starts with no schemes, and the review shows each one at the level held", () => {
    expect(open.staffSchemes).toEqual({ pension: 0, health: 0, deathInService: 0, discount: 0, shareSave: 0 });
    expect(review.schemeValuation).toBe(0.7);
    expect(review.schemes.map((s) => [s.id, s.level, s.maxLevel, s.toggle])).toEqual([
      ["pension", 0, 3, false],
      ["health", 0, 3, false],
      ["deathInService", 0, 1, true],
      ["discount", 0, 1, true],
      ["shareSave", 0, 3, false],
    ]);
  });

  it("is worth the cash rise plus each level added × its worth to staff × the valuation", () => {
    const levels = { pension: 2, health: 1, deathInService: 1, discount: 1 };
    const worth =
      (2 * schemes.pension.staffValue + schemes.health.staffValue + schemes.deathInService.staffValue + schemes.discount.staffValue) * 0.7;
    const preview = plain.payOfferPreview(open, review.minOffer, levels);
    expect(preview.rise).toBe(review.minOffer);
    expect(preview.schemeValue).toBeCloseTo(worth, 12);
    // To a tenth of a point, like every rise.
    expect(Math.abs(preview.value - (review.minOffer + worth))).toBeLessThanOrEqual(0.0005 + 1e-9);
    expect(Math.round(preview.value * 1000)).toBe(preview.value * 1000);
    expect(preview.schemeCosts.find((s) => s.id === "pension")).toMatchObject({ held: 0, level: 2 });
    expect(preview.schemeCosts.find((s) => s.id === "pension")!.value).toBeCloseTo(2 * schemes.pension.staffValue * 0.7, 12);
    // Cash alone is worth itself.
    expect(plain.payOfferPreview(open, review.minOffer)).toMatchObject({ schemeValue: 0, value: review.minOffer });
  });

  it("is accepted when its worth reaches staff's walk-away figure, though the cash is short of it", () => {
    // Staff walk away at inflation: less in cash, and a pension worth the rest.
    const levels = { pension: 1 };
    const worth = plain.payOfferPreview(open, review.minOffer, levels).schemeValue;
    const cash = round(review.inflation - worth + 0.0005);
    expect(cash).toBeLessThan(open.payReview!.walkAway);
    const settled = offer(plain, open, cash, levels);
    expect(plain.payReview(settled)).toBeNull();
    const record = settled.pastPayReviews.at(-1)!;
    expect(record).toMatchObject({ outcome: "offerAccepted", rise: cash, schemes: { pension: 1, health: 0, deathInService: 0, discount: 0, shareSave: 0 } });
    expect(Math.abs(record.studentOffers[0]! - (cash + worth))).toBeLessThanOrEqual(0.0005 + 1e-9);
    expect(record.offerTerms).toEqual([{ rise: cash, schemes: { pension: 1, health: 0, deathInService: 0, discount: 0, shareSave: 0 } }]);
    expect(settled.staffSchemes).toEqual({ pension: 1, health: 0, deathInService: 0, discount: 0, shareSave: 0 });
    // Only the cash multiplies pay.
    expect(settled.payMultiplier).toBeCloseTo(1 + cash, 9);
    // The same cash alone falls short, and staff counter.
    expect(plain.payReview(offer(plain, open, cash))).not.toBeNull();
  });

  it("can be all schemes and no cash, but its worth is held within the caps", () => {
    const all = { pension: 3, health: 3, deathInService: 1, discount: 1 };
    const worth = plain.payOfferPreview(open, review.minOffer, all).schemeValue;
    // With no cash, schemes alone have to reach the least offer.
    if (worth < review.minOffer) expect(refusal(() => offer(plain, open, 0, all))).toBe("offer_too_low");
    else expect(refusal(() => offer(plain, open, 0, all))).toBeNull();
    expect(refusal(() => offer(plain, open, review.maxAsk, { pension: 1 }))).toBe("offer_too_high");
    expect(refusal(() => offer(plain, open, -0.01, all))).toBe("bad_offer");
  });

  it("refuses levels that aren't whole, out of range, or a scheme that doesn't exist", () => {
    const at = review.inflation;
    expect(refusal(() => offer(plain, open, at, { pension: 4 }))).toBe("bad_offer");
    expect(refusal(() => offer(plain, open, at, { health: 1.5 }))).toBe("bad_offer");
    expect(refusal(() => offer(plain, open, at, { deathInService: 2 }))).toBe("bad_offer");
    expect(refusal(() => offer(plain, open, at, { bonus: 1 } as Partial<SchemeLevels>))).toBe("bad_offer");
    expect(refusal(() => plain.payOfferPreview(open, at, { pension: -1 }))).toBe("bad_offer");
  });

  it("counts schemes at the configured valuation", () => {
    for (const valuation of [0, 0.7, 1, 1.5]) {
      const s = withValuation(valuation);
      const state = untilReview(s, begin(s));
      expect(s.payReview(state)!.schemeValuation).toBe(valuation);
      expect(s.payOfferPreview(state, s.payReview(state)!.minOffer, { pension: 1 }).schemeValue).toBeCloseTo(
        schemes.pension.staffValue * valuation,
        12,
      );
    }
  });

  it("is worth a tenth of a point at a time, so staff can counter an offer just short of their figure", () => {
    // 2 pension levels and death in service are worth 1.225 points: offered with a cash rise 0.075 points short of
    // staff's ask, it rounds to a tenth below it, and staff counter.
    const levels = { pension: 2, deathInService: 1 };
    const cash = round(review.maxAsk - 0.013);
    const preview = plain.payOfferPreview(open, cash, levels);
    expect(preview.value).toBe(round(review.maxAsk - 0.001));
    expect(preview.meetsAsk).toBe(false);
    expect(preview.odds).not.toBeNull();
    expect(refusal(() => offer(plain, open, cash, levels))).toBeNull();
  });

  it("counts against staff's counter by its worth", () => {
    const levels = { pension: 1 };
    const countered = offer(plain, open, review.minOffer, levels);
    const after = plain.payReview(countered)!;
    expect(after.studentOffers).toEqual([plain.payOfferPreview(open, review.minOffer, levels).value]);
    expect(after.offerTerms[0]!.schemes.pension).toBe(1);
    // Their counter answered the offer's worth, not its cash.
    const cashOnly = plain.payReview(offer(plain, open, review.minOffer))!;
    expect(after.rounds[0]!.ask).toBeLessThan(cashOnly.rounds[0]!.ask);
    // An offer worth as much as their counter is accepting it: two health levels are worth 0.7 points.
    expect(refusal(() => offer(plain, countered, round(after.staffFigure - 0.007), { health: 2 }))).toBe("above_counter");
    expect(refusal(() => offer(plain, countered, round(after.staffFigure - 0.008), { health: 2 }))).toBeNull();
  });
});

describe("only the increase", () => {
  it("counts towards a later review's offer: schemes held are worth nothing again", () => {
    const first = untilReview(plain, begin());
    const held = untilReview(plain, plain.advance(settleWith(plain, first, { pension: 2, deathInService: 1 })).state);
    expect(held.staffSchemes).toMatchObject({ pension: 2, deathInService: 1 });
    const { minOffer } = plain.payReview(held)!;
    // Offering what's held is worth nothing more.
    expect(plain.payOfferPreview(held, minOffer, { pension: 2, deathInService: 1 }).schemeValue).toBe(0);
    // A level more counts for one level.
    expect(plain.payOfferPreview(held, minOffer, { pension: 3 }).schemeValue).toBeCloseTo(schemes.pension.staffValue * 0.7, 12);
    // The review's sliders start at the levels held.
    expect(plain.payReview(held)!.schemes.find((s) => s.id === "pension")!.level).toBe(2);
  });
});

describe("levels only go up", () => {
  const first = untilReview(plain, begin());
  const held = untilReview(plain, plain.advance(settleWith(plain, first, { pension: 2, deathInService: 1 })).state);
  const { inflation } = held.payReview!;

  it("refuses lowering a slider or turning off a toggle in a later review", () => {
    expect(refusal(() => offer(plain, held, inflation, { pension: 1 }))).toBe("scheme_decrease");
    expect(refusal(() => offer(plain, held, inflation, { deathInService: 0 }))).toBe("scheme_decrease");
    expect(refusal(() => plain.payOfferPreview(held, inflation, { pension: 0 }))).toBe("scheme_decrease");
  });

  it("keeps the levels held when an offer leaves them out", () => {
    const settled = offer(plain, held, plain.payReview(held)!.maxAsk);
    expect(settled.staffSchemes).toEqual({ pension: 2, health: 0, deathInService: 1, discount: 0, shareSave: 0 });
  });

  it("refuses lowering below the held level within the review as well", () => {
    const countered = offer(plain, held, plain.payReview(held)!.minOffer, { pension: 3 });
    expect(plain.payReview(countered)).not.toBeNull();
    // Offered 3 but not yet agreed: 2 is still held, so going back to it is fine, and below it isn't.
    expect(refusal(() => plain.payOfferPreview(countered, plain.payReview(countered)!.minOffer, { pension: 2 }))).toBeNull();
    expect(refusal(() => plain.payOfferPreview(countered, plain.payReview(countered)!.minOffer, { pension: 1 }))).toBe("scheme_decrease");
  });
});

describe("accepting staff's counter", () => {
  it("is a cash rise only: the offer's schemes aren't raised", () => {
    const open = untilReview(plain, begin());
    const countered = offer(plain, open, plain.payReview(open)!.minOffer, { pension: 1, discount: 1 });
    const settled = plain.applyAction(countered, { type: "acceptPayCounter" });
    const record = settled.pastPayReviews.at(-1)!;
    expect(record.outcome).toBe("counterAccepted");
    expect(record.rise).toBe(plain.payReview(countered)!.staffFigure);
    expect(settled.staffSchemes).toEqual(open.staffSchemes);
    expect(record.schemes).toEqual(open.staffSchemes);
  });
});

describe("ongoing costs", () => {
  const open = untilReview(plain, begin());
  const levels = { pension: 2, health: 3, deathInService: 1, discount: 1, shareSave: 1 };
  const settled = settleWith(plain, open, levels);

  it("are charged every day from the next, as staff spend, at each scheme's cost model", () => {
    // Nothing on the day the review opened.
    expect(open.spendByDay.at(-1)!.staff).toBe(settled.spendByDay.at(-1)!.staff);
    const next = plain.advance(settled);
    const lines = next.log[0]!.entries;
    for (const id of STAFF_SCHEMES) {
      const cost = expectedCost(plain, settled, id, levels[id]);
      expect(cost).toBeGreaterThan(0);
      const line = lines.find((e) => e.text.startsWith(schemes[id].name));
      expect(line).toMatchObject({ cashDelta: -cost, category: "staff" });
    }
    const pay = lines.filter((e) => e.category === "staff").reduce((sum, e) => sum - e.cashDelta, 0);
    expect(next.state.spendByDay.at(-1)!.staff).toBeCloseTo(pay, 6);
    expect(plain.staffSchemes(next.state).map((s) => s.costPerDay)).toEqual(STAFF_SCHEMES.map((id) => expectedCost(plain, next.state, id, levels[id])));
    // The first day says which schemes started.
    expect(lines.some((e) => e.text.startsWith("Staff schemes from today: Pension top-up to level 2, Health cash plan to level 3, Death in service, Discount scheme"))).toBe(true);
    // And they're counted in the running costs.
    expect(plain.runway(settled).dailyCosts).toBeCloseTo(
      plain.runway({ ...settled, staffSchemes: open.staffSchemes }).dailyCosts + STAFF_SCHEMES.reduce((sum, id) => sum + expectedCost(plain, settled, id, levels[id]), 0),
      6,
    );
  });

  it("grow with permanent headcount (per person) and the wage bill (a share of pay), but not agency staff", () => {
    const before = Object.fromEntries(plain.staffSchemes(settled).map((s) => [s.id, s.costPerDay]));
    // Two more permanent mid developers, once they start.
    let hired = plain.applyAction(settled, { type: "hire", pool: "developers", count: 2 });
    while (hired.hiring.length) hired = plain.advance(hired).state;
    const after = Object.fromEntries(plain.staffSchemes(hired).map((s) => [s.id, s.costPerDay]));
    const devRate = plain.staff(hired).find((p) => p.pool === "developers")!.grades.find((g) => g.grade === "mid")!.dayRate;
    // Each is to the pound, rounded up, so within a pound of the exact rise.
    const near = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThanOrEqual(1);
    near(after.health! - before.health!, 3 * schemes.health.perPerson * 2);
    near(after.discount! - before.discount!, schemes.discount.perPerson * 2);
    near(after.pension! - before.pension!, 2 * schemes.pension.wageShare * 2 * devRate);
    near(after.deathInService! - before.deathInService!, schemes.deathInService.wageShare * 2 * devRate);
    expect(after.health! + after.pension!).toBeGreaterThan(before.health! + before.pension!);
    for (const id of STAFF_SCHEMES) expect(after[id]).toBe(expectedCost(plain, hired, id, levels[id]));
    // Agency staff don't get them.
    const agency = plain.advance(plain.applyAction(hired, { type: "hire", pool: "developers", agency: true, count: 3 })).state;
    expect(plain.staffSchemes(agency).map((s) => s.costPerDay)).toEqual(plain.staffSchemes(hired).map((s) => s.costPerDay));
  });

  it("rise with a later pay rise where they're a share of pay", () => {
    const later = untilReview(plain, settled);
    const before = plain.staffSchemes(later);
    const risen = offer(plain, later, plain.payReview(later)!.maxAsk);
    const after = plain.staffSchemes(risen);
    const cost = (views: typeof before, id: string) => views.find((s) => s.id === id)!.costPerDay;
    expect(cost(after, "pension")).toBeGreaterThan(cost(before, "pension"));
    // Death in service too, though at a pound a day on a small team the rise may round away.
    expect(cost(after, "deathInService")).toBe(expectedCost(plain, risen, "deathInService", 1));
    expect(cost(after, "health")).toBe(cost(before, "health"));
    expect(cost(after, "discount")).toBe(cost(before, "discount"));
  });

  it("are in an offer's preview: each scheme's cost a day, and what it all adds", () => {
    const preview = plain.payOfferPreview(open, open.payReview!.minOffer, levels);
    for (const id of STAFF_SCHEMES) {
      const s = preview.schemeCosts.find((c) => c.id === id)!;
      const after = { ...open, payMultiplier: 1 + preview.rise };
      expect(s.costPerDay).toBe(expectedCost(plain, after, id, levels[id]));
      expect(s.extraPerDay).toBe(s.costPerDay);
    }
    const schemesPerDay = preview.schemeCosts.reduce((sum, s) => sum + s.costPerDay, 0);
    const cashOnly = plain.payOfferPreview(open, open.payReview!.minOffer);
    expect(preview.extraPerDay).toBeCloseTo(cashOnly.extraPerDay + schemesPerDay, 6);
  });
});

describe("the tribunal", () => {
  // Two low offers, then a final offer with schemes, short of a deal.
  const open = untilReview(plain, begin());
  const { minOffer } = open.payReview!;
  const atFinal = offer(plain, offer(plain, open, minOffer), minOffer);
  const levels = { pension: 1, deathInService: 1 };
  const worth = plain.payOfferPreview(atFinal, minOffer, levels).schemeValue;
  const cash = Math.max(0, round(minOffer - worth));

  it("applies the offer's schemes on the student's figure or the middle, and only cash on staff's", () => {
    const odds = plain.payOfferPreview(atFinal, cash, levels).tribunal!;
    expect(odds.cash.student).toBe(cash);
    expect(odds.cash.staff).toBe(odds.rises.staff);
    expect(odds.cash.middle).toBe(round(odds.rises.middle - (odds.rises.student - cash)));
    const seen = new Set<string>();
    for (let seed = 0; seed < 300 && seen.size < 3; seed++) {
      const settled = offer(plain, { ...atFinal, payReviewRng: seed }, cash, levels);
      const record = settled.pastPayReviews.at(-1)!;
      const pick = record.tribunal!.pick;
      seen.add(pick);
      expect(record.rise).toBe(odds.cash[pick]);
      expect(settled.staffSchemes).toEqual(
        pick === "staff" ? atFinal.staffSchemes : { pension: 1, health: 0, deathInService: 1, discount: 0, shareSave: 0 },
      );
      expect(record.schemes).toEqual(settled.staffSchemes);
    }
    expect([...seen].sort()).toEqual(["middle", "staff", "student"]);
  });
});

describe("text play and the bots", () => {
  it("offers schemes in text play, shows them, and lists the schemes held", () => {
    const who = { player: "test" };
    const open = untilReview(plain, begin());
    const { minOffer } = open.payReview!;
    const pct = (n: number) => (n * 100).toFixed(1);
    expect(renderCommands(plain, open)).toMatch(/\[pension=0-3\] \[health=0-3\] \[death=on\] \[discount=on\]/);
    const pay = runScript(plain, open, "pay", who).lines.join("\n");
    expect(pay).toMatch(/staff schemes \(levels only go up; staff count 70% of a scheme's worth\)/);
    expect(pay).toMatch(/pension: Pension top-up, level 0 of 3 \(£0\/day now\); each level costs 0\.4% of pay and is worth 0\.53% to staff/);
    expect(pay).toMatch(/death: Death in service, off/);
    const odds = runScript(plain, open, `payodds ${pct(minOffer)} pension=2 death=on`, who).lines.join("\n");
    expect(odds).toMatch(/worth [\d.]+% to staff: the cash \+ [\d.]+% for the schemes raised/);
    expect(odds).toMatch(/Pension top-up 0 → 2: worth [\d.]+% to staff, costs £[\d.,]+\/day/);
    expect(runScript(plain, open, `offer ${pct(minOffer)} pension=9`, who).lines.at(-1)).toMatch(/refused: Pension top-up goes from 0 to 3/);
    expect(runScript(plain, open, `offer ${pct(minOffer)} bonus=1`, who).lines.at(-1)).toMatch(/Expected a scheme and its level/);
    const settled = runScript(plain, open, `offer ${pct(open.payReview!.maxAsk - 0.02)} pension=2 death=on`, who);
    expect(settled.lines[1]).toMatch(/^pay review settled: staff accepted your offer of [\d.]+% cash \+ Pension top-up to level 2, Death in service = [\d.]+% to staff/);
    expect(settled.lines[1]).toMatch(/schemes held: Pension top-up 2 \(£[\d.,]+\/day\), Death in service \(£[\d.,]+\/day\)/);
    expect(renderStatus(plain, settled.state)).toMatch(/schemes: Pension top-up 2/);
    // In a later review, lowering one is refused.
    const later = untilReview(plain, settled.state);
    expect(runScript(plain, later, `offer ${pct(later.payReview!.maxAsk)} pension=1`, who).lines.at(-1)).toMatch(/can't be taken away/);
  });

  it("gives the bots no schemes by default, and a scheme policy plays a full game", () => {
    const real = createSim(defaultConfig);
    const sensible = STRATEGIES[0]!;
    expect(STRATEGIES.every((s) => !s.schemes)).toBe(true);
    const result = playGame(real, { model: "saas", productType: "social", strategy: { ...sensible, schemes: { pension: 1, discount: 1 } }, seed: 7 });
    expect(result.outcome).not.toBe("cant-start");
    expect(result.day).toBeGreaterThan(135);
  });
});
