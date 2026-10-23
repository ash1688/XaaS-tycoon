// Plays the harness's sensible strategy on every model and product over a few seeds and prints the valuation every
// 30 days next to cash, net cash (cash less the loan still owed) and paying users. A tool for tuning ValuationConfig.
//
//   npx tsx scripts/valuationSurvey.ts [seeds] [strategy]
import { createSim, defaultConfig, MODEL_IDS, PRODUCT_TYPE_IDS, type GameState } from "../src/index.ts";
import { playDay, STRATEGIES } from "./harness.ts";

const seeds = Number(process.argv[2] ?? 3);
const strategy = STRATEGIES.find((s) => s.id === (process.argv[3] ?? "sensible"))!;
const sim = createSim(defaultConfig);
/** The biggest ratio of highest to lowest valuation within any 15 days, from day 60 on. */
function swing(daily: number[]): number {
  let worst = 1;
  for (let a = 60; a < daily.length; a++) {
    for (let b = a + 1; b < Math.min(daily.length, a + 16); b++) worst = Math.max(worst, daily[a]! / daily[b]!, daily[b]! / daily[a]!);
  }
  return worst;
}
const k = (n: number) => `${Math.round(n / 1000)}k`.padStart(6);
for (const model of MODEL_IDS) {
  for (const productType of PRODUCT_TYPE_IDS) {
    for (let seed = 1; seed <= seeds; seed++) {
      const takeLoan = strategy.loan === "always" || (strategy.loan === "onprem" && model === "onprem");
      let state: GameState = sim.newGame({ companyName: "Survey", productType, model, seed, takeLoan });
      const cells: string[] = [];
      const daily: number[] = [];
      while (state.status === "playing") {
        state = sim.advance(playDay(sim, state, strategy)).state;
        const v = sim.valuation(state).valuation;
        daily[state.day] = v;
        if (state.day % 30 === 0 || state.status !== "playing") {
          const net = state.cash - (sim.loan(state)?.remaining ?? 0);
          cells.push(`d${state.day}:${k(v)} (net${k(net)} p${String(state.paidUsers).padStart(5)})`);
        }
      }
      console.log(`${model.padEnd(6)} ${productType.padEnd(10)} s${seed} ${state.status.padEnd(9)} 15-day swing ${swing(daily).toFixed(2)}x  ${cells.join("  ")}`);
    }
  }
}
