// Replays an AI playtest log (<game>.log.json) day by day and prints the valuation every few days, with cash, paying
// users and net cash, so a valuation change can be judged on the same play before and after.
//
//   npx tsx scripts/replayValuation.ts <game.log.json> [every]
import { readFileSync } from "node:fs";
import { createSim, defaultConfig, type Action, type GameState } from "../src/index.ts";
import type { LogRow } from "./textPlay.ts";

const [file, everyArg] = process.argv.slice(2);
const every = Number(everyArg ?? 5);
const WINDOW = 15;
/** The biggest ratio of highest to lowest valuation within any `window` days, from day `from` on. */
export function biggestSwing(daily: number[], window: number, from: number): number {
  let worst = 1;
  for (let a = from; a < daily.length; a++) {
    for (let b = a + 1; b < Math.min(daily.length, a + window + 1); b++) {
      const x = daily[a];
      const y = daily[b];
      if (x && y) worst = Math.max(worst, x / y, y / x);
    }
  }
  return worst;
}
const rows = JSON.parse(readFileSync(file!, "utf8")) as LogRow[];
const sim = createSim(defaultConfig);
const start = rows[0]!.params as { model: string; productType: string; takeLoan: boolean; shares: number; gameLength: string; seed: number };
let state: GameState = sim.newGame({
  companyName: "Replay",
  productType: start.productType,
  model: start.model,
  seed: start.seed,
  takeLoan: start.takeLoan,
  shares: start.shares,
  gameLength: start.gameLength,
});
const line = (s: GameState) => {
  const v = sim.valuation(s);
  const loan = sim.loan(s);
  const student = s.shareholders.find((h) => h.id === "student")!.shares / v.sharesInIssue;
  const net = s.cash - (loan?.payoff ?? 0);
  return `day ${String(s.day).padStart(3)}  valuation £${Math.round(v.valuation).toLocaleString("en-GB").padStart(10)}  you £${Math.round(v.valuation * student).toLocaleString("en-GB").padStart(10)}  cash £${Math.round(s.cash).toLocaleString("en-GB").padStart(8)}  net £${Math.round(net).toLocaleString("en-GB").padStart(8)}  payers ${String(s.paidUsers).padStart(6)}  sat ${Math.round(s.satisfaction)}  rev/yr £${v.annualRevenue.toLocaleString("en-GB")}  ×${v.multiple}`;
};
const daily: number[] = [];
for (const row of rows.slice(1)) {
  if (state.status !== "playing") break;
  if (row.type === "continue") {
    state = sim.advance(state, 1).state;
    daily[state.day] = sim.valuation(state).valuation;
    if (state.day % every === 0 || state.status !== "playing") console.log(line(state));
  } else if (row.type === "end") {
    break;
  } else if (row.ok) {
    try {
      state = sim.applyAction(state, { type: row.type, ...row.params } as Action);
    } catch (e) {
      console.error(`day ${state.day}: ${row.type} refused: ${(e as Error).message}`);
    }
  }
  if (row.type === "continue" && Math.round(state.cash) !== row.cash) console.error(`day ${state.day}: cash ${Math.round(state.cash)} ≠ logged ${row.cash}`);
}
console.log(line(state));
console.log(`biggest swing within ${WINDOW} days, from day 60: ${biggestSwing(daily, WINDOW, 60).toFixed(2)}×`);
