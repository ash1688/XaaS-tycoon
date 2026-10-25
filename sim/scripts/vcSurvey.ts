// Plays a harness strategy in 180-day games and prints the day the angel and each Series round first approached, and
// the day the IPO's trading history is met. Not part of the game: a tool for setting the VC rounds' hidden targets.
//   npx tsx scripts/vcSurvey.ts [seeds] [strategy] [product]
import { createSim, defaultConfig, MODEL_IDS, PRODUCT_TYPE_IDS, SERIES_IDS, type GameState } from "../src/index.ts";
import { playDay, STRATEGIES } from "./harness.ts";

const seeds = Number(process.argv[2] ?? 3);
const strategy = STRATEGIES.find((s) => s.id === (process.argv[3] ?? "sensible"))!;
const products = PRODUCT_TYPE_IDS.filter((p) => !process.argv[4] || p === process.argv[4]);
const sim = createSim(defaultConfig);

for (const productType of products) {
  for (const model of MODEL_IDS) {
    for (let seed = 1; seed <= seeds; seed++) {
      let s: GameState = sim.newGame({ companyName: "Survey", productType, model, seed, takeLoan: model === "onprem" });
      while (s.status === "playing") {
        s = playDay(sim, s, strategy);
        s = sim.advance(s).state;
      }
      const days = SERIES_IDS.map((r) => `${r.slice(-1)} ${s.investors.vc.firstApproachDay[r] ?? "-"}`).join(", ");
      const traded = s.launchDay === null ? "-" : s.launchDay + defaultConfig.ipo.minTradingDays - 1;
      console.log(`${productType}/${model}/${seed}: ${s.status} day ${s.day}; angel ${s.investors.firstApproachDay ?? "-"}, ${days}; trading history met day ${traded}`);
    }
  }
}
