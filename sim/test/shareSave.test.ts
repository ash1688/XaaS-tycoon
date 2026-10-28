import { describe, expect, it } from "vitest";
import { runScript } from "../scripts/textPlay.ts";
import { configFields, createSim, defaultConfig, SimError, type GameConfig, type GameState, type SchemeLevels, type Sim } from "../src/index.ts";
import { inPhase } from "./phases.ts";

// Share save, through the sim's public interface: the staff scheme paid for in ownership. Each level added issues new
// shares worth 1% of the company to the staff share scheme, diluting the student; levels only go up; the shares are
// issued only when a deal or the tribunal applies the offer's schemes; and the holder is a pot of its own.

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
/** A new game in Grow from day 16 (#236): reviews' rises start on days 46, 91 and 136. */
const begin = (s: Sim = plain, seed = 42) =>
  inPhase(s.newGame({ companyName: "Acme", productType: "social", model: "saas", seed }), "grow", 16);
const perLevel = plainConfig.payReview.shareSavePerLevel;
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

const inIssue = (state: GameState) => state.shareholders.reduce((sum, h) => sum + h.shares, 0);
const holder = (state: GameState, id: string) => state.shareholders.find((h) => h.id === id)?.shares ?? 0;
const yours = (state: GameState) => holder(state, "student") / inIssue(state);

describe("share save", () => {
  const open = untilReview(plain, begin());

  it("is the fifth scheme: a 0–3 slider worth the most to staff, costing a little admin per person", () => {
    const view = plain.payReview(open)!.schemes.find((s) => s.id === "shareSave")!;
    expect(view).toMatchObject({ name: "Share save", level: 0, maxLevel: 3, toggle: false, sharesPerLevel: 0.01 });
    const others = plain.payReview(open)!.schemes.filter((s) => s.id !== "shareSave");
    expect(view.staffValue).toBeGreaterThan(Math.max(...others.map((s) => s.staffValue)));
    expect(others.every((s) => s.sharesPerLevel === 0)).toBe(true);
    expect(view.wageShare).toBe(0);
    expect(view.perPerson).toBeGreaterThan(0);
  });

  it.each([1, 2, 3])("issues about 1%% new shares a level (%i) to the staff share scheme, diluting you", (level) => {
    const before = inIssue(open);
    const settled = settleWith(plain, open, { shareSave: level });
    const record = settled.pastPayReviews.at(-1)!;
    expect(record.outcome).toBe("offerAccepted");
    expect(record.schemes.shareSave).toBe(level);
    expect(record.shareSaveShares).toBe(Math.round(before * perLevel * level));
    expect(holder(settled, "staffScheme")).toBe(record.shareSaveShares);
    expect(inIssue(settled)).toBe(before + record.shareSaveShares);
    // Your shares are untouched, but you own less of the company.
    expect(holder(settled, "student")).toBe(holder(open, "student"));
    expect(yours(settled)).toBeCloseTo(yours(open) / (1 + perLevel * level), 6);
    // Each level is worth 1% of the company as it stood.
    const row = plain.capTable(settled).rows.find((r) => r.id === "staffScheme")!;
    expect(row).toMatchObject({ name: "Staff share scheme", shares: record.shareSaveShares });
    expect(row.share).toBeCloseTo((perLevel * level) / (1 + perLevel * level), 6);
  });

  it("shows the dilution in the preview before the offer, matching what the deal does", () => {
    const review = plain.payReview(open)!;
    expect(plain.payOfferPreview(open, review.minOffer).dilution).toBeNull();
    expect(plain.payOfferPreview(open, review.minOffer, { pension: 1 }).dilution).toBeNull();
    const preview = plain.payOfferPreview(open, review.minOffer, { shareSave: 2 });
    const settled = settleWith(plain, open, { shareSave: 2 });
    expect(preview.dilution).toEqual({
      newShares: settled.pastPayReviews.at(-1)!.shareSaveShares,
      sharesInIssue: inIssue(open),
      sharesAfter: inIssue(settled),
      yourShareBefore: yours(open),
      yourShareAfter: yours(settled),
      schemeShareAfter: holder(settled, "staffScheme") / inIssue(settled),
    });
    // Its worth to staff: a point a level, at the valuation.
    expect(preview.schemeValue).toBeCloseTo(2 * 0.01 * plainConfig.payReview.peopleLead.none.schemeValuation, 12);
  });

  it("says so in the next day's log, and charges its admin every day as staff spend", () => {
    const settled = settleWith(plain, open, { shareSave: 1 });
    const lines = plain.advance(settled).log[0]!.entries;
    expect(lines.some((e) => e.text.startsWith("Staff schemes from today: Share save to level 1"))).toBe(true);
    expect(lines.find((e) => e.text.startsWith("The staff share scheme has"))!.text).toMatch(/owns 1% of the company\. They dilute every holder: you own 99%/);
    const admin = lines.find((e) => e.text.startsWith("Share save level 1"))!;
    expect(admin.category).toBe("staff");
    expect(admin.cashDelta).toBeLessThan(0);
    expect(plain.staffSchemes(settled).find((s) => s.id === "shareSave")!.costPerDay).toBe(-admin.cashDelta);
  });

  it("follows the config's share per level", () => {
    const twice = createSim({ ...plainConfig, payReview: { ...plainConfig.payReview, shareSavePerLevel: 0.02 } });
    const start = untilReview(twice, begin(twice));
    const settled = settleWith(twice, start, { shareSave: 1 });
    expect(holder(settled, "staffScheme")).toBe(Math.round(inIssue(start) * 0.02));
    expect(configFields().some((f) => f.path === "payReview.shareSavePerLevel")).toBe(true);
  });
});

describe("share save over later reviews", () => {
  const first = untilReview(plain, begin());
  const afterFirst = settleWith(plain, first, { shareSave: 1 });
  const second = untilReview(plain, plain.advance(afterFirst).state);

  it("can't go down, and only the increase counts towards the offer", () => {
    const { minOffer, inflation } = second.payReview!;
    expect(second.staffSchemes.shareSave).toBe(1);
    expect(refusal(() => offer(plain, second, inflation, { shareSave: 0 }))).toBe("scheme_decrease");
    expect(plain.payOfferPreview(second, minOffer, { shareSave: 1 })).toMatchObject({ schemeValue: 0, dilution: null });
    expect(plain.payOfferPreview(second, minOffer, { shareSave: 3 }).schemeValue).toBeCloseTo(2 * 0.01 * 0.7, 12);
  });

  it("adds to the same holder, at 1% of the company as it stands then", () => {
    const held = holder(second, "staffScheme");
    const before = inIssue(second);
    const settled = settleWith(plain, second, { shareSave: 2 });
    expect(settled.shareholders.filter((h) => h.id === "staffScheme")).toHaveLength(1);
    expect(holder(settled, "staffScheme")).toBe(held + Math.round(before * perLevel));
    expect(yours(settled)).toBeLessThan(yours(second));
  });

  it("leaves a review that doesn't raise it alone", () => {
    const settled = settleWith(plain, second, { pension: 1 });
    expect(settled.shareholders).toEqual(second.shareholders);
    expect(settled.pastPayReviews.at(-1)!.shareSaveShares).toBe(0);
  });
});

describe("when share save applies", () => {
  const open = untilReview(plain, begin());
  const { minOffer } = open.payReview!;

  it("not on an offer staff counter, but on accepting their counter, which keeps it", () => {
    const countered = offer(plain, open, minOffer, { shareSave: 1 });
    expect(countered.payReview).not.toBeNull();
    expect(countered.shareholders).toEqual(open.shareholders);
    const accepted = plain.applyAction(countered, { type: "acceptPayCounter" });
    const issued = Math.round(inIssue(countered) * perLevel);
    expect(accepted.pastPayReviews.at(-1)).toMatchObject({ outcome: "counterAccepted", shareSaveShares: issued });
    expect(holder(accepted, "staffScheme")).toBe(issued);
    expect(accepted.staffSchemes.shareSave).toBe(1);
  });

  it("on a tribunal, whatever it picks", () => {
    const atFinal = offer(plain, offer(plain, open, minOffer), minOffer);
    // The least in cash, with share save on top (#293), still short of a deal.
    const levels = { shareSave: 1 };
    const cash = minOffer;
    expect(plain.payOfferPreview(atFinal, cash, levels).dilution!.newShares).toBe(Math.round(inIssue(atFinal) * perLevel));
    const seen = new Set<string>();
    for (let seed = 0; seed < 300 && seen.size < 3; seed++) {
      const settled = offer(plain, { ...atFinal, payReviewRng: seed }, cash, levels);
      const record = settled.pastPayReviews.at(-1)!;
      const pick = record.tribunal!.pick;
      seen.add(pick);
      const issued = Math.round(inIssue(atFinal) * perLevel);
      expect(record.shareSaveShares).toBe(issued);
      expect(holder(settled, "staffScheme")).toBe(issued);
      expect(settled.staffSchemes.shareSave).toBe(1);
    }
    expect([...seen].sort()).toEqual(["middle", "staff", "student"]);
  });
});

describe("the staff share scheme holder", () => {
  const open = untilReview(plain, begin());
  const settled = settleWith(plain, open, { shareSave: 3 });

  it("is a holder of its own, outside the student's stake and any C-suite equity", () => {
    const ids = settled.shareholders.map((h) => h.id);
    expect(ids).toEqual(["student", "staffScheme"]);
    // No C-suite package draws on it: the C-suite get no staff schemes, and its shares are the scheme's alone.
    expect(holder(settled, "staffScheme")).toBe(settled.pastPayReviews.at(-1)!.shareSaveShares);
  });

  it("dilutes what your stake is worth, as a funding round does", () => {
    const table = plain.capTable(settled);
    const before = plain.capTable(open);
    const you = (t: typeof table) => t.rows.find((r) => r.id === "student")!;
    expect(you(table).share).toBeCloseTo(1 / (1 + 3 * perLevel), 6);
    expect(table.sharePrice).toBeLessThan(before.sharePrice);
    expect(table.rows.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(1, 9);
  });
});

describe("text play", () => {
  it("offers share save as shares=N, previews the dilution, and reports it settled", () => {
    const who = { player: "test" };
    const open = untilReview(plain, begin());
    const review = plain.payReview(open)!;
    const pay = runScript(plain, open, "pay", who).lines.join("\n");
    expect(pay).toMatch(/shares: Share save, level 0 of 3 .*new shares worth 1% of the company \(diluting you\)/);
    const odds = runScript(plain, open, `payodds ${(review.minOffer * 100).toFixed(1)} shares=2`, who).lines.join("\n");
    expect(odds).toMatch(/share save issues [\d,]+ new shares to the staff share scheme \(2% of the company after\): you'd own 98%, down from 100%/);
    const cash = ((review.maxAsk - 0.007) * 100).toFixed(1);
    const done = runScript(plain, open, `offer ${cash} shares=1`, who);
    expect(done.lines.join("\n")).toMatch(/share save issued [\d,]+ new shares to the staff share scheme, so you own 99% \(was 100%\)/);
    expect(done.state.staffSchemes.shareSave).toBe(1);
  });
});
