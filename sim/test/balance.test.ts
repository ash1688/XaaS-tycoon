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
      expect(["finished", "bankrupt", "cant-start"]).toContain(r.outcome);
      if (r.outcome === "finished") expect(r.day).toBe(short.finalDay);
    }
  });

  it("is deterministic: the same seeds give the same results and report", () => {
    const again = runAll(short, { seeds: [1, 2], strategies });
    expect(again).toEqual(results);
    expect(renderReport(again, { seeds: [1, 2], strategies })).toBe(renderReport(results, { seeds: [1, 2], strategies }));
  });

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

  it("renders a Markdown report with the headline tables and a section per strategy", () => {
    const report = renderReport(results, { seeds: [1, 2], strategies, title: "Test report" });
    expect(report).toMatch(/^# Test report\n/);
    expect(report).toContain("## Sensible play: median final cash");
    expect(report).toContain("## Each strategy against sensible: median final cash difference");
    for (const s of strategies) expect(report).toContain(`## Strategy: ${s.id}`);
    for (const p of PRODUCT_TYPE_IDS) expect(report).toContain(`| ${p} |`);
  });
});
