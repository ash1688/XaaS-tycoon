import { describe, expect, it } from "vitest";
import { runScript } from "../scripts/textPlay.ts";
import { hasHeadOfPeople, peopleLead, peopleLeadFor } from "../src/peopleLead.ts";
import { createSim, defaultConfig, type GameConfig, type GameState, type PeopleLeadConfig, type Sim } from "../src/index.ts";

// The people-lead seam: one modifier that every head-of-people effect on a pay review reads (the roll bonus or penalty
// on staff counters, walk-away softening, the scheme valuation and the tribunal lean). There's no head of people until
// the C-suite (#108), so it gives the "none" values; a sim whose "none" values are swapped for the head of people's
// stands in for one, and shows each effect moving the student's way.

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
const lead = plainConfig.payReview.peopleLead;
/** A sim whose company is treated as having people-lead values `values` (the stub for a head of people). */
const withLead = (values: PeopleLeadConfig) =>
  createSim({ ...plainConfig, payReview: { ...plainConfig.payReview, peopleLead: { ...lead, none: values } } });
const plain = createSim(plainConfig);
const headed = withLead(lead.headOfPeople);
const begin = (s: Sim, seed = 42) => s.newGame({ companyName: "Acme", productType: "social", model: "saas", seed });

function untilReview(s: Sim, state: GameState): GameState {
  let current = state;
  while (current.status === "playing" && !current.payReview) current = s.advance(current).state;
  return current;
}

const offer = (s: Sim, state: GameState, rise: number) => s.applyAction(state, { type: "offerPayRise", rise });

describe("the modifier", () => {
  it("gives the no-head-of-people values: no head of people can be hired yet", () => {
    const state = begin(plain);
    expect(hasHeadOfPeople(state)).toBe(false);
    expect(peopleLead(plainConfig, state)).toEqual({ headOfPeople: false, ...lead.none });
  });

  it("without a head of people, staff take a roll penalty, don't soften, count schemes at about 70% and lean nowhere", () => {
    expect(defaultConfig.payReview.peopleLead.none).toEqual({ rollBonus: -1, walkAwaySoftening: 0, schemeValuation: 0.7, tribunalLean: 0 });
  });

  it("with one, every value is friendlier to the student", () => {
    const none = peopleLeadFor(defaultConfig, false);
    const head = peopleLeadFor(defaultConfig, true);
    expect(head.headOfPeople).toBe(true);
    expect(head.rollBonus).toBeGreaterThan(0);
    expect(head.rollBonus).toBeGreaterThan(none.rollBonus);
    expect(head.walkAwaySoftening).toBeGreaterThan(none.walkAwaySoftening);
    expect(head.schemeValuation).toBeGreaterThanOrEqual(1);
    expect(head.tribunalLean).toBeGreaterThan(0);
  });
});

describe("without a head of people", () => {
  const open = untilReview(plain, begin(plain));
  const review = plain.payReview(open)!;

  it("the review says the student is dealing with staff directly, with the roll penalty and the valuation", () => {
    expect(review.headOfPeople).toBe(false);
    expect(review.rollBonus).toBe(lead.none.rollBonus);
    expect(review.schemeValuation).toBe(0.7);
    const opened = plain.advance(begin(plain), 100).log;
    expect(opened.at(-1)!.entries.at(-1)!.text).toMatch(/You're dealing with staff directly: with no head of people, they're stricter and want cash\.$/);
    expect(runScript(plain, open, "pay", { player: "test" }).lines.join("\n")).toMatch(/you're dealing with staff directly \(no head of people\): they're stricter, −1 on every counter roll, and want cash, counting schemes at 70%/);
  });

  it("staff counters take the roll penalty, in the odds and on the roll itself", () => {
    const odds = plain.payOfferPreview(open, review.minOffer).odds!;
    expect(odds.bonus).toBe(-1);
    const round = plain.payReview(offer(plain, open, review.minOffer))!.rounds[0]!;
    expect(round.bonus).toBe(-1);
    expect(round.total).toBe(round.die - round.penalty - 1);
  });

  it("matches a sim with the penalty taken out in everything but the roll", () => {
    const neutral = withLead({ ...lead.none, rollBonus: 0 });
    const n = untilReview(neutral, begin(neutral));
    expect(n.payReview).toEqual(open.payReview);
    const preview = (s: Sim, state: GameState) => s.payOfferPreview(state, review.minOffer, { pension: 1 });
    const { odds: a, ...restA } = preview(plain, open);
    const { odds: b, ...restB } = preview(neutral, n);
    expect(restA).toEqual(restB);
    expect(a!.bonus).toBe(b!.bonus - 1);
  });
});

describe("a head of people (stubbed through the config)", () => {
  const open = untilReview(plain, begin(plain));
  const openHeaded = untilReview(headed, begin(headed));
  const review = plain.payReview(open)!;

  it("brings friendlier rolls: a bonus on every counter, and better odds of a high roll", () => {
    const without = plain.payOfferPreview(open, review.minOffer).odds!;
    const withHead = headed.payOfferPreview(openHeaded, review.minOffer).odds!;
    expect(withHead.bonus).toBe(lead.headOfPeople.rollBonus);
    expect(withHead.chances.high).toBeGreaterThan(without.chances.high);
    expect(withHead.chances.low).toBeLessThan(without.chances.low);
    const round = headed.payReview(offer(headed, openHeaded, review.minOffer))!.rounds[0]!;
    expect(round.total).toBe(round.die - round.penalty + lead.headOfPeople.rollBonus);
  });

  it("softens staff's walk-away figure, so an offer just short of where they'd accept is taken", () => {
    expect(openHeaded.payReview!.fairRise).toBe(open.payReview!.fairRise);
    expect(openHeaded.payReview!.walkAway).toBeCloseTo(open.payReview!.walkAway - lead.headOfPeople.walkAwaySoftening, 9);
    const justShort = Math.round((open.payReview!.walkAway - 0.001) * 1000) / 1000;
    expect(offer(plain, open, justShort).payReview).not.toBeNull();
    expect(offer(headed, openHeaded, justShort).payReview).toBeNull();
    expect(offer(headed, openHeaded, justShort).pastPayReviews.at(-1)!.outcome).toBe("offerAccepted");
  });

  it("counts staff schemes at full value", () => {
    const without = plain.payOfferPreview(open, review.minOffer, { pension: 1 });
    const withHead = headed.payOfferPreview(openHeaded, review.minOffer, { pension: 1 });
    expect(headed.payReview(openHeaded)!.schemeValuation).toBe(1);
    expect(withHead.schemeValue).toBeCloseTo(plainConfig.payReview.schemes.pension.staffValue, 12);
    expect(withHead.schemeValue).toBeGreaterThan(without.schemeValue);
  });

  it("leans the tribunal the student's way: their final offer likelier, staff's figure less likely", () => {
    // The same final offer against the same staff figure, with only the lean changed.
    const leaning = withLead({ ...lead.none, tribunalLean: lead.headOfPeople.tribunalLean });
    const start = untilReview(plain, begin(plain));
    const atFinal = (s: Sim) => offer(s, offer(s, start, review.minOffer), review.minOffer);
    const final = atFinal(plain);
    expect(atFinal(leaning).payReview).toEqual(final.payReview);
    const without = plain.payOfferPreview(final, review.minOffer).tribunal!;
    const withLean = leaning.payOfferPreview(final, review.minOffer).tribunal!;
    expect(withLean.rises).toEqual(without.rises);
    expect(withLean.chances.student).toBeGreaterThan(without.chances.student);
    expect(withLean.chances.staff).toBeLessThan(without.chances.staff);
    // A slight lean: it doesn't turn a lowball into the likeliest pick.
    expect(withLean.chances.student).toBeLessThan(withLean.chances.staff + withLean.chances.middle);
    // The tribunal rolls at the odds it shows.
    const record = offer(leaning, final, review.minOffer).pastPayReviews.at(-1)!;
    expect(record.tribunal!.chances).toEqual(withLean.chances);
  });
});
