// Plays a harness strategy and prints the day each game first passes the IPO readiness check, with the conditions
// still unmet on day 180. Not part of the game: a tool for setting the readiness thresholds. The length is 1-year by
// default; until-ipo plays until the company is first ready (or day 730), as the harness never applies to float.
//   npx tsx scripts/ipoSurvey.ts [seeds] [strategy] [product] [length]
import { createSim, defaultConfig, MODEL_IDS, PRODUCT_TYPE_IDS, type GameLengthId, type GameState } from "../src/index.ts";
import { playDay, STRATEGIES } from "./harness.ts";

const seeds = Number(process.argv[2] ?? 3);
const strategy = STRATEGIES.find((s) => s.id === (process.argv[3] ?? "sensible"))!;
const products = PRODUCT_TYPE_IDS.filter((p) => !process.argv[4] || p === process.argv[4]);
const gameLength = (process.argv[5] ?? "1-year") as GameLengthId;
const untilIpo = gameLength === "until-ipo";
const sim = createSim({ ...defaultConfig, allowedGameLengths: { ...defaultConfig.allowedGameLengths, [gameLength]: 1 } });

const readyDays: number[] = [];
for (const productType of products) {
  for (const model of MODEL_IDS) {
    for (let seed = 1; seed <= seeds; seed++) {
      let s: GameState = sim.newGame({ companyName: "Survey", productType, model, seed, takeLoan: model === "onprem", gameLength });
      let readyDay: number | null = null;
      let at180 = "";
      while (s.status === "playing" && !(untilIpo && (readyDay !== null || s.day >= 730))) {
        s = playDay(sim, s, strategy);
        s = sim.advance(s).state;
        const ipo = sim.ipo(s);
        if (readyDay === null && ipo.ready) readyDay = s.day;
        if (s.day === 180) at180 = ipo.conditions.filter((c) => !c.met).map((c) => c.id).join(",") || "ready";
      }
      if (readyDay !== null) readyDays.push(readyDay);
      console.log(`${productType}/${model}/${seed}: ${s.status} day ${s.day}, first ready ${readyDay ?? "never"}; day 180 unmet: ${at180 || "-"}`);
    }
  }
}
const sorted = [...readyDays].sort((a, b) => a - b);
const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
console.log(`ready in ${readyDays.length} games; earliest ${sorted[0] ?? "-"}, median ${median ?? "-"}, latest ${sorted.at(-1) ?? "-"}`);
