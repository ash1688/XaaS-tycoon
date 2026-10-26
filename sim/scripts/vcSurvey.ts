// Plays a harness strategy and prints the day the angel and each Series round first approached, the day a 180-day
// game's merged rounds would pay their second tranche, and the day the IPO's trading history is met, with medians at the
// end. Not part of the game: a tool for setting the VC rounds' hidden targets. The length is 180 days by default, which
// has two rounds (Series A and B, each merging two of the four); other lengths have all four.
//   npx tsx scripts/vcSurvey.ts [seeds] [strategy] [product] [length]
import { createSim, defaultConfig, MODEL_IDS, PRODUCT_TYPE_IDS, vcLadder, type GameLengthId, type GameState, type SeriesId } from "../src/index.ts";
import { playDay, STRATEGIES } from "./harness.ts";

const seeds = Number(process.argv[2] ?? 3);
const strategy = STRATEGIES.find((s) => s.id === (process.argv[3] ?? "sensible"))!;
const products = PRODUCT_TYPE_IDS.filter((p) => !process.argv[4] || p === process.argv[4]);
const gameLength = (process.argv[5] ?? "180-days") as GameLengthId;
const sim = createSim({ ...defaultConfig, allowedGameLengths: { ...defaultConfig.allowedGameLengths, [gameLength]: 1 } });

/** The days each column was reached, across every game, for the medians. */
const seen = new Map<string, number[]>();
let games = 0;
const note = (column: string, day: number | null) => {
  if (day !== null) seen.set(column, [...(seen.get(column) ?? []), day]);
  return day ?? "-";
};
/** The first day a merged round's second tranche's target held: when it would be paid had the round been taken. */
const trancheTargets = new Map<string, number>();

for (const productType of products) {
  for (const model of MODEL_IDS) {
    for (let seed = 1; seed <= seeds; seed++) {
      let s: GameState = sim.newGame({ companyName: "Survey", productType, model, seed, takeLoan: model === "onprem", gameLength });
      trancheTargets.clear();
      while (s.status === "playing") {
        s = playDay(sim, s, strategy);
        // The harness answers no investor, so a merged round's second tranche is never paid: take the first VC in each
        // approach on a copy and see whether that day would pay it.
        for (const rung of vcLadder(s).filter((r) => r.parts.length > 1 && s.investors.vc.firstApproachDay[r.round] !== null)) {
          const later = rung.parts[1]!;
          if (trancheTargets.has(later)) continue;
          const paid = trancheDay(s, rung.round);
          if (paid !== null) trancheTargets.set(later, paid);
        }
        s = sim.advance(s).state;
      }
      games++;
      const angel = note("angel", s.investors.firstApproachDay);
      const rounds = vcLadder(s)
        .map((r) => {
          const name = sim.investors(s).vc.rounds.find((x) => x.round === r.round)!.name;
          const day = note(name, s.investors.vc.firstApproachDay[r.round]);
          const tranche = r.parts.length > 1 ? `, tranche 2 ${note(`${name} tranche 2`, trancheTargets.get(r.parts[1]!) ?? null)}` : "";
          return `${r.round.slice(-1)} ${day}${tranche}`;
        })
        .join("; ");
      const traded = s.launchDay === null ? null : s.launchDay + defaultConfig.ipo.minTradingDays - 1;
      console.log(`${productType}/${model}/${seed}: ${s.status} day ${s.day}; angel ${angel}; ${rounds}; trading history met day ${note("trading", traded)}`);
    }
  }
}
const median = (days: number[]) => [...days].sort((a, b) => a - b)[Math.floor((days.length - 1) / 2)];
console.log(
  `medians over ${games} games: ${[...seen].map(([column, days]) => `${column} d${median(days)}${days.length < games ? ` (${games - days.length} never)` : ""}`).join(", ")}`,
);

/**
 * The day a merged round's second tranche would be paid if it would be on the next day played, had the round been
 * taken, or null: the next day played on a copy with a deal standing whose tranche is still to come.
 */
function trancheDay(state: GameState, round: SeriesId): number | null {
  const rung = vcLadder(state).find((r) => r.round === round)!;
  const deal = {
    round,
    investor: "Survey Capital",
    lean: "conditions" as const,
    day: state.investors.vc.firstApproachDay[round]!,
    amount: 0,
    shares: 0,
    share: 0,
    valuation: 0,
    tranche: { amount: 1, target: rung.parts[1]!, paidDay: null },
  };
  const copy: GameState = {
    ...state,
    investors: { ...state.investors, vc: { ...state.investors.vc, approach: null, next: null, deals: [deal] } },
  };
  const after = sim.advance(copy).state;
  return after.investors.vc.deals[0]?.tranche?.paidDay ?? null;
}
