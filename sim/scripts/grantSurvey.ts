// Plays the harness's funded strategy (friends and family and the grant on day 1) on every model and product over a
// few seeds, and prints how the grant ended: met or withdrawn, the day, and its hours down against those allowed,
// with the launch day and the hours down before, during and after the launch ramp. A tool for tuning the grant.
//
//   npx tsx scripts/grantSurvey.ts [seeds] [strategy]
import { createSim, defaultConfig, MODEL_IDS, PRODUCT_TYPE_IDS, type GameState } from "../src/index.ts";
import { playDay, STRATEGIES } from "./harness.ts";

const seeds = Number(process.argv[2] ?? 5);
const strategy = STRATEGIES.find((s) => s.id === (process.argv[3] ?? "funded"))!;
const sim = createSim(defaultConfig);
const rampDays = defaultConfig.launch.rampShares.length;
for (const model of MODEL_IDS) {
  let kept = 0;
  let games = 0;
  for (const productType of PRODUCT_TYPE_IDS) {
    for (let seed = 1; seed <= seeds; seed++) {
      const takeLoan = strategy.loan === "always" || (strategy.loan === "onprem" && model === "onprem");
      let state: GameState;
      try {
        state = sim.newGame({ companyName: "Survey", productType, model, seed, takeLoan });
        state = sim.applyAction(state, { type: "acceptFunding", funder: "friendsAndFamily" });
        state = sim.applyAction(state, { type: "acceptFunding", funder: "grant" });
      } catch {
        console.log(`${model} ${productType} ${seed}: can't start`);
        continue;
      }
      const down = { before: 0, ramp: 0, after: 0 };
      let ended = "";
      while (state.status === "playing") {
        const before = state.downtimeHours;
        state = sim.advance(playDay(sim, state, strategy)).state;
        const hours = state.downtimeHours - before;
        const launch = state.launchDay;
        const phase = launch === null || state.day < launch ? "before" : state.day < launch + rampDays ? "ramp" : "after";
        down[phase] += hours;
        const g = state.funding.grant!;
        if (!ended && g.status !== "accepted") ended = `${g.status} day ${state.day} (${g.hoursDown}/${g.maxHoursDown}h)`;
      }
      games++;
      if (state.funding.grant!.status === "met") kept++;
      const { fromDay, untilDay } = sim.funding(state).grant!;
      const until = `${fromDay}–${untilDay}`;
      console.log(
        `${model.padEnd(6)} ${productType.padEnd(9)} ${seed}: launch ${state.launchDay ?? "-"}, grant ${until}, ${ended || state.funding.grant!.status}` +
          ` | down before ${down.before} ramp ${down.ramp} after ${down.after} (whole game)`,
      );
    }
  }
  console.log(`${model}: kept ${kept}/${games}\n`);
}
