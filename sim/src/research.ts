import type { GameConfig } from "./config.ts";
import { phaseReached } from "./phases.ts";
import type { GameState } from "./state.ts";

/** Research's view, for the Research page. */
export interface ResearchView {
  /** Researchers can be hired, and the Research page shows: the game has reached Grow. */
  unlocked: boolean;
  /** The day it unlocked; null until then. */
  unlockedDay: number | null;
  /** Research points (RP) banked, with no cap. */
  points: number;
  /** RP a day at today's researchers: their output in mids × RP per researcher. */
  pointsPerDay: number;
}

/** RP rounded to the hundredth, so state stays tidy. */
const tidy = (n: number) => Math.round(n * 100) / 100;

/**
 * Whether the company has grown up enough for researchers: the game has reached Grow, which the first angel investor's
 * approach opens, whether the student took their money, turned them down or let the offer lapse.
 */
export const researchUnlocked = (state: Pick<GameState, "phase">) => phaseReached(state, "grow");

/** RP researchers earn a day: their output in mids (grade and all) × RP per researcher. */
export const researchPerDay = (config: GameConfig, output: number) => tidy(output * config.research.pointsPerPerson);

/** A day's research: today's RP added to the bank, with no cap. */
export const researchDay = (config: GameConfig, state: Pick<GameState, "researchPoints">, output: number) =>
  tidy(state.researchPoints + researchPerDay(config, output));

export function researchView(
  config: GameConfig,
  state: Pick<GameState, "phase" | "phaseDays" | "researchPoints">,
  output: number,
): ResearchView {
  return {
    unlocked: researchUnlocked(state),
    unlockedDay: state.phaseDays.grow,
    points: state.researchPoints,
    pointsPerDay: researchPerDay(config, output),
  };
}
