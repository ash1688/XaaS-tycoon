import { PHASE_IDS, type GameState, type PhaseId } from "../src/index.ts";

/**
 * The state moved on to `phase` (#236), as if its milestone and any before it had come on `day` (today by default), so
 * its jobs are open: for tests about those jobs rather than how the game reaches them. It changes nothing else: an
 * angel or Series A hasn't approached, and Launch hasn't been pressed. A game already further on stays where it is.
 * Pay reviews start growDays after the day Grow opens.
 */
export function inPhase(state: GameState, phase: PhaseId, day = state.day): GameState {
  const target = PHASE_IDS.indexOf(phase);
  if (PHASE_IDS.indexOf(state.phase) >= target) return state;
  const phaseDays = { ...state.phaseDays };
  for (const p of PHASE_IDS.slice(PHASE_IDS.indexOf(state.phase) + 1, target + 1)) phaseDays[p] = day;
  return { ...state, phase, phaseDays };
}

/** Every job open: the state in Scale (see inPhase). */
export const allOpen = (state: GameState, day = state.day) => inPhase(state, "scale", day);
