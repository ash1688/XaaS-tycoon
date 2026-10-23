// Plays a harness strategy in 1-year games and prints the day each first passes the IPO readiness check, with the
// conditions still unmet on day 180. Not part of the game: a tool for setting the readiness thresholds.
//   npx tsx scripts/ipoSurvey.ts [seeds] [strategy] [product]
import { createSim, defaultConfig, MODEL_IDS, PRODUCT_TYPE_IDS, type GameState } from "../src/index.ts";
import { playDay, STRATEGIES } from "./harness.ts";

const seeds = Number(process.argv[2] ?? 3);
const strategy = STRATEGIES.find((s) => s.id === (process.argv[3] ?? "sensible"))!;
const products = PRODUCT_TYPE_IDS.filter((p) => !process.argv[4] || p === process.argv[4]);
const sim = createSim({ ...defaultConfig, allowedGameLengths: { ...defaultConfig.allowedGameLengths, "1-year": 1 } });

for (const productType of products) {
  for (const model of MODEL_IDS) {
    for (let seed = 1; seed <= seeds; seed++) {
      let s: GameState = sim.newGame({ companyName: "Survey", productType, model, seed, takeLoan: model === "onprem", gameLength: "1-year" });
      let readyDay: number | null = null;
      let at180 = "";
      while (s.status === "playing") {
        s = playDay(sim, s, strategy);
        s = sim.advance(s).state;
        const ipo = sim.ipo(s);
        if (readyDay === null && ipo.ready) readyDay = s.day;
        if (s.day === 180) at180 = ipo.conditions.filter((c) => !c.met).map((c) => c.id).join(",") || "ready";
      }
      console.log(`${productType}/${model}/${seed}: ${s.status} day ${s.day}, first ready ${readyDay ?? "never"}; day 180 unmet: ${at180}`);
    }
  }
}
