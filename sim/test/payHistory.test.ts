import { describe, expect, it } from "vitest";
import { renderCommands, runScript } from "../scripts/textPlay.ts";
import { createSim, defaultConfig, type GameConfig, type GameState, type SchemeLevels, type Sim } from "../src/index.ts";

// The pay history, through the sim's public interface: a read-only view of every settled pay review, the pay multiplier
// so far, the schemes held and their cost, the staff share scheme's stake and the next review.

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
const begin = (s: Sim = plain) => s.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 42 });
const who = { player: "test" };

function untilReview(s: Sim, state: GameState): GameState {
  let current = state;
  while (current.status === "playing" && !current.payReview) current = s.advance(current).state;
  return current;
}
const offer = (state: GameState, rise: number, levels?: Partial<SchemeLevels>) =>
  plain.applyAction(state, levels ? { type: "offerPayRise", rise, schemes: levels } : { type: "offerPayRise", rise });
/** Settles the open review at staff's ask with `levels`: worth at least the ask, they accept. */
const settleWith = (state: GameState, levels: Partial<SchemeLevels>) => {
  const review = plain.payReview(state)!;
  const worth = plain.payOfferPreview(state, review.minOffer, levels).schemeValue;
  return offer(state, Math.max(0, Math.floor((review.maxAsk - worth) * 1000) / 1000), levels);
};

describe("pay history", () => {
  const start = begin();
  const days = plain.payReviewDays(start);
  const open = untilReview(plain, start);

  it("is empty before the first review, with the first to come", () => {
    const h = plain.payHistory(start);
    expect(h).toMatchObject({ reviews: [], payMultiplier: 1, tribunalFees: 0, staffShareScheme: null });
    expect(h.nextReview).toEqual({ quarter: 2, startDay: days[0] });
    expect(h.schemes.every((s) => s.level === 0 && s.costPerDay === 0)).toBe(true);
    expect(h.schemesCostPerDay).toBe(0);
    // While the first is open, it's the current review, not the next.
    expect(plain.payHistory(open).nextReview).toEqual({ quarter: 3, startDay: days[1] });
  });

  it("is empty on a saved game with no reviews yet", () => {
    const saved = JSON.parse(JSON.stringify(start)) as GameState;
    expect(plain.payHistory(saved).reviews).toEqual([]);
  });

  it("records an accepted offer with schemes and share save's shares", () => {
    const settled = settleWith(open, { pension: 2, deathInService: 1, shareSave: 1 });
    const record = settled.pastPayReviews.at(-1)!;
    const h = plain.payHistory(settled);
    expect(h.reviews).toHaveLength(1);
    const r = h.reviews[0]!;
    expect(r).toMatchObject({
      quarter: 2,
      startDay: days[0],
      inflation: open.payReview!.inflation,
      offers: 1,
      outcome: "offerAccepted",
      tribunalPick: null,
      tribunalFee: 0,
      rise: record.rise,
      shareSaveShares: record.shareSaveShares,
      payMultiplier: settled.payMultiplier,
    });
    expect(r.shareSaveShares).toBeGreaterThan(0);
    expect(r.realTerms).toBeCloseTo(record.rise - record.inflation, 6);
    expect(r.date).toBe(plain.calendar({ ...settled, day: days[0]! }).today.text);
    expect(r.schemeRaises.map((s) => [s.id, s.from, s.to, s.toggle])).toEqual([
      ["pension", 0, 2, false],
      ["deathInService", 0, 1, true],
      ["shareSave", 0, 1, false],
    ]);
    expect(h.payMultiplier).toBe(settled.payMultiplier);
    expect(h.schemes.find((s) => s.id === "pension")).toMatchObject({ level: 2 });
    expect(h.schemesCostPerDay).toBeCloseTo(
      plain.staffSchemes(settled).reduce((sum, s) => sum + s.costPerDay, 0),
      6,
    );
    expect(h.schemesCostPerDay).toBeGreaterThan(0);
    const row = plain.capTable(settled).rows.find((x) => x.id === "staffScheme")!;
    expect(h.staffShareScheme).toEqual({ shares: row.shares, share: row.share });
    expect(h.nextReview).toEqual({ quarter: 3, startDay: days[1] });
  });

  it("compounds the multiplier and shows only each review's raises", () => {
    const first = settleWith(open, { pension: 1 });
    const second = settleWith(untilReview(plain, first), { pension: 2 });
    const h = plain.payHistory(second);
    expect(h.reviews.map((r) => r.quarter)).toEqual([2, 3]);
    const [a, b] = h.reviews;
    expect(a!.payMultiplier).toBeCloseTo(1 + a!.rise, 9);
    expect(b!.payMultiplier).toBeCloseTo((1 + a!.rise) * (1 + b!.rise), 9);
    expect(b!.payMultiplier).toBe(second.payMultiplier);
    expect(b!.schemeRaises).toEqual([expect.objectContaining({ id: "pension", from: 1, to: 2 })]);
  });

  it("records a counter accepted, with no schemes", () => {
    const countered = offer(open, open.payReview!.minOffer, { pension: 1 });
    const settled = plain.applyAction(countered, { type: "acceptPayCounter" });
    const r = plain.payHistory(settled).reviews[0]!;
    expect(r).toMatchObject({ outcome: "counterAccepted", offers: 1, tribunalPick: null, tribunalFee: 0, schemeRaises: [] });
    expect(r.staffFigures).toHaveLength(2);
  });

  it("records a tribunal's pick and fee", () => {
    const { minOffer } = open.payReview!;
    const settled = offer(offer(offer(open, minOffer), minOffer), minOffer);
    const record = settled.pastPayReviews.at(-1)!;
    const h = plain.payHistory(settled);
    expect(h.reviews[0]).toMatchObject({
      outcome: "tribunal",
      offers: 3,
      tribunalPick: record.tribunal!.pick,
      tribunalFee: plainConfig.payReview.tribunal.fee,
    });
    expect(h.tribunalFees).toBe(plainConfig.payReview.tribunal.fee);
  });

  it("has no next review once the last has gone by, or with reviews off", () => {
    let state = settleWith(open, {});
    state = settleWith(untilReview(plain, state), {});
    state = settleWith(untilReview(plain, state), {});
    expect(plain.payHistory(state).reviews).toHaveLength(3);
    expect(plain.payHistory(state).nextReview).toBeNull();
    const off = createSim({ ...plainConfig, payReview: { ...plainConfig.payReview, on: 0 } });
    expect(off.payHistory(begin(off)).nextReview).toBeNull();
  });

  it("changes nothing", () => {
    const settled = settleWith(open, { shareSave: 1 });
    const copy = JSON.stringify(settled);
    plain.payHistory(settled);
    expect(JSON.stringify(settled)).toBe(copy);
  });

  it("shows in text play", () => {
    const empty = runScript(plain, start, "payhistory", who).lines.join("\n");
    expect(empty).toContain("no pay reviews yet. The first comes at the start of quarter 2");
    const settled = settleWith(open, { pension: 1, shareSave: 1 });
    const text = runScript(plain, settled, "payhistory", who).lines.join("\n");
    expect(text).toContain(`pay ×${settled.payMultiplier.toFixed(3)} of the day rates`);
    expect(text).toContain("Q2 ");
    expect(text).toContain("staff accepted your first offer");
    expect(text).toContain("Pension top-up 0→1");
    expect(text).toContain("new shares to the staff share scheme");
    expect(text).toContain("staff share scheme:");
    expect(text).toContain("next review: quarter 3");
    expect(renderCommands(plain, start)).toContain("payhistory");
  });
});
