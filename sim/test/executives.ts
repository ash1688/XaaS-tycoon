import { IPO_ROLES, type GameState } from "../src/index.ts";

/**
 * The state with a CFO, a CISO and legal counsel already hired, each the first on their shortlist with no equity: the
 * executives an IPO needs. The C-suite has its own tests (csuite.test.ts).
 */
export const withIpoExecutives = (state: GameState): GameState => ({
  ...state,
  csuite: {
    ...state.csuite,
    hired: [
      ...state.csuite.hired,
      ...IPO_ROLES.map((role) => {
        const c = state.csuite.shortlists[role][0]!;
        return { role, name: c.name, strength: c.strength, salary: 0, equity: 0, shares: 0, day: 1 };
      }),
    ],
  },
});
