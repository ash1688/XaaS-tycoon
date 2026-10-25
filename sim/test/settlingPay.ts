import type { DayLog, GameState, Sim } from "../src/index.ts";

/** Settles an open pay review as the harness bots do: an offer of inflation, and staff's counter accepted if they make one. */
export function settlePay(sim: Sim, state: GameState): GameState {
  const review = sim.payReview(state);
  if (!review) return state;
  const offered = sim.applyAction(state, { type: "offerPayRise", rise: review.inflation });
  return sim.payReview(offered) ? sim.applyAction(offered, { type: "acceptPayCounter" }) : offered;
}

/**
 * The sim, but advance and tick settle each pay review as it opens (see settlePay) and play on: for tests of the
 * default game that are about something else, so its quarterly reviews don't hold their clock.
 */
export function settlingPay(sim: Sim): Sim {
  return {
    ...sim,
    advance(state, days = 1) {
      let current = settlePay(sim, state);
      const log: DayLog[] = [];
      while (log.length < days && current.status === "playing") {
        const played = sim.advance(current, days - log.length);
        log.push(...played.log);
        current = settlePay(sim, played.state);
      }
      return { state: current, log };
    },
    tick: (state) => sim.tick(settlePay(sim, state)),
  };
}
