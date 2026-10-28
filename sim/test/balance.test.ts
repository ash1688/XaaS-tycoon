import { describe, expect, it } from "vitest";
import { defaultConfig, MODEL_IDS, PRODUCT_TYPE_IDS, type GameConfig } from "../src/index.ts";
import { cells, playGame, renderReport, runAll, STRATEGIES } from "../scripts/harness.ts";
import { createSim } from "../src/index.ts";

// The balance harness is a tuning tool, so these only check it runs and is repeatable: no balance assertions, which
// would break whenever the numbers are tuned.
const short: GameConfig = { ...defaultConfig, finalDay: 30 };
const strategies = STRATEGIES.filter((s) => ["sensible", "no-scaling", "migrate"].includes(s.id)).map((s) =>
  s.migrateDay ? { ...s, migrateDay: 10 } : s,
);

describe("balance harness", () => {
  const results = runAll(short, { seeds: [1, 2], strategies });

  it("plays every model × product × strategy × seed to an ending", () => {
    expect(results).toHaveLength(MODEL_IDS.length * PRODUCT_TYPE_IDS.length * strategies.length * 2);
    expect(cells(results)).toHaveLength(MODEL_IDS.length * PRODUCT_TYPE_IDS.length * strategies.length);
    for (const r of results) {
      expect(["finished", "liquidated", "cant-start"]).toContain(r.outcome);
      if (r.outcome === "finished") expect(r.day).toBe(short.finalDay);
    }
  });

  it("is deterministic: the same seeds give the same results and report", () => {
    const again = runAll(short, { seeds: [1, 2], strategies });
    expect(again).toEqual(results);
    expect(renderReport(again, { seeds: [1, 2], strategies })).toBe(renderReport(results, { seeds: [1, 2], strategies }));
    // A whole run of the harness again: near vitest's default 5s when the suite runs in parallel.
  }, 20_000);

  it("gives different games for different seeds", () => {
    const sim = createSim(short);
    const play = (seed: number) => playGame(sim, { model: "iaas", productType: "social", strategy: STRATEGIES[0]!, seed });
    expect(play(1)).not.toEqual(play(2));
  });

  it("reports a can't-start game rather than throwing", () => {
    const sim = createSim({ ...short, startingCash: 0 });
    const noLoan = STRATEGIES.find((s) => s.id === "no-loan")!;
    expect(playGame(sim, { model: "onprem", productType: "video", strategy: noLoan, seed: 1 }).outcome).toBe("cant-start");
  });

  it("plays the pay review strategies to an ending, settling every review their way", () => {
    const pay = STRATEGIES.filter((s) => ["cash-only", "scheme-heavy", "tribunal-gambler"].includes(s.id));
    expect(pay).toHaveLength(3);
    // Reviews start growDays into Grow, which opens at the angel's approach (#236): a game long enough for a few.
    const long: GameConfig = { ...short, finalDay: 120, payReview: { ...short.payReview, growDays: 10 } };
    const played = runAll(long, { seeds: [1], strategies: pay });
    expect(played).toHaveLength(MODEL_IDS.length * PRODUCT_TYPE_IDS.length * 3);
    /** The reviews a game finished after the angel approached on `angel` has: growDays on, then a quarter apart. */
    const reviewsAfter = (angel: number | null) => {
      if (angel === null) return 0;
      let n = 0;
      while (angel + long.payReview.growDays + Math.floor((n * long.finalDay) / 4) <= long.finalDay) n++;
      return n;
    };
    for (const r of played.filter((x) => x.outcome !== "cant-start")) {
      if (r.outcome === "finished") expect(r.pay.reviews).toBe(reviewsAfter(r.rounds.angel));
      if (r.strategy === "tribunal-gambler") {
        // It never takes a counter: staff take the least allowed (when cash is tight, it can be fair) or a tribunal sits.
        expect(r.pay.outcomes.counterAccepted).toBe(0);
        expect(r.pay.tribunalFees).toBe(r.pay.outcomes.tribunal * long.payReview.tribunal.fee);
      }
      if (r.strategy !== "scheme-heavy") expect(r.pay.schemeSpend).toBe(0);
    }
    const gambler = played.filter((r) => r.strategy === "tribunal-gambler");
    expect(gambler.reduce((sum, r) => sum + r.pay.outcomes.tribunal, 0)).toBeGreaterThan(0);
    // Share save dilutes the student whenever a scheme-heavy offer or a tribunal pick of it or the middle stands.
    const heavy = played.filter((r) => r.strategy === "scheme-heavy" && r.pay.outcomes.offerAccepted > 0);
    expect(heavy.length).toBeGreaterThan(0);
    for (const r of heavy) {
      expect(r.pay.staffSchemeShare).toBeGreaterThan(0);
      expect(r.pay.studentShare).toBeLessThan(1);
    }
    expect(renderReport(played, { seeds: [1], strategies: pay })).toContain("## Pay reviews by strategy");
    // Every model and product three times over a 120-day game: about 5s on a busy machine, past vitest's default.
  }, 20_000);

  it("renders a Markdown report with the headline tables and a section per strategy", () => {
    const report = renderReport(results, { seeds: [1, 2], strategies, title: "Test report" });
    expect(report).toMatch(/^# Test report\n/);
    expect(report).toContain("## Sensible play: median final cash");
    expect(report).toContain("## Each strategy against sensible: median final cash difference");
    for (const s of strategies) expect(report).toContain(`## Strategy: ${s.id}`);
    for (const p of PRODUCT_TYPE_IDS) expect(report).toContain(`| ${p} |`);
  });
});
