// Plays the harness's sensible bot and its angel bot (which takes the first angel's opening offer) on every model and
// product, and prints when the angel approached, their offer, whether their target was met, and how the game ended
// against the sensible bot's: the valuation and the student's score (their share × the valuation). A tool for tuning
// InvestorsConfig.
//
//   npx tsx scripts/angelSurvey.ts [seeds]
import { createSim, defaultConfig, MODEL_IDS, PRODUCT_TYPE_IDS, type GameState } from "../src/index.ts";
import { playDay, STRATEGIES } from "./harness.ts";

const seeds = Number(process.argv[2] ?? 2);
const sim = createSim(defaultConfig);
const k = (n: number) => `${Math.round(n / 1000)}k`;
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

function play(model: GameState["model"], productType: GameState["productType"], seed: number, id: string) {
  const strategy = STRATEGIES.find((s) => s.id === id)!;
  let state = sim.newGame({ companyName: "Survey", productType, model, seed, takeLoan: model === "onprem" });
  let offer = "";
  while (state.status === "playing") {
    const o = sim.investors(state).offer;
    if (o && !offer) offer = `d${o.day} ${k(o.amount)} for ${pct(o.theirShare)} (×${o.multiple}, val ${k(o.valuation)} vs ${k(o.formulaValuation)}, target £${o.target.dailyRevenue}/d by d${o.target.byDay})`;
    state = sim.advance(playDay(sim, state, strategy)).state;
  }
  const v = sim.valuation(state).valuation;
  const yours = sim.capTable(state).rows.find((r) => r.id === "student")!;
  const angel = sim.investors(state).angel;
  return { state, offer, v, score: yours.value, share: yours.share, angel };
}

for (const model of MODEL_IDS) {
  for (const productType of PRODUCT_TYPE_IDS) {
    for (let seed = 1; seed <= seeds; seed++) {
      const plain = play(model, productType, seed, "sensible");
      const taken = play(model, productType, seed, "angel");
      const a = taken.angel;
      const target = a ? `${a.status}${a.settledDay ? ` d${a.settledDay}` : ""}` : "none";
      console.log(
        `${model.padEnd(6)} ${productType.padEnd(10)} s${seed} ${taken.offer} | ${target.padEnd(10)} | val ${k(plain.v)} → ${k(taken.v)}, score ${k(plain.score)} → ${k(taken.score)} (${pct(taken.share)})`,
      );
    }
  }
}
