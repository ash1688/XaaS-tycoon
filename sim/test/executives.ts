import { CSUITE_ROLES, type GameState } from "../src/index.ts";

/**
 * The state with every C-suite role filled, each by the first on their shortlist with no equity: the full C-suite an
 * IPO needs. The C-suite has its own tests (csuite.test.ts).
 */
export const withFullCsuite = (state: GameState): GameState => ({
  ...state,
  // A CTO opens tier 2 on joining, as hiring one does.
  tiers: state.tiers.some((t) => t.tier === 2) ? state.tiers : [...state.tiers, { tier: 2, day: state.day }],
  csuite: {
    ...state.csuite,
    hired: [
      ...state.csuite.hired,
      ...CSUITE_ROLES.filter((role) => !state.csuite.hired.some((e) => e.role === role)).map((role) => {
        const c = state.csuite.shortlists[role][0]!;
        return { role, name: c.name, strength: c.strength, salary: 0, equity: 0, shares: 0, day: 1 };
      }),
    ],
  },
});
