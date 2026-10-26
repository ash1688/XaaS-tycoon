import type { CsuiteRange, CsuiteRole, GameConfig, StaffPool } from "./config.ts";
import type { Executive, GameState } from "./state.ts";

/**
 * The executives' effects, read by the seams they plug into: one lookup each, with no knowledge of how roles open or
 * are hired (see csuite.ts). Every effect is 0 until the role is filled.
 */

/** The executive in a role, if one's been hired. */
export const executiveIn = (state: Pick<GameState, "csuite">, role: CsuiteRole): Executive | undefined =>
  state.csuite.hired.find((e) => e.role === role);

export const hasExecutive = (state: Pick<GameState, "csuite">, role: CsuiteRole) => executiveIn(state, role) !== undefined;

/** A figure within its range for a strength from 0 (min) to 1 (max). */
export const withinRange = (range: CsuiteRange, strength: number) => range.min + (range.max - range.min) * strength;

/** One of a role's effects at a strength: 0 for an effect the role doesn't have. */
export const effectAt = (config: GameConfig, role: CsuiteRole, key: string, strength: number): number => {
  const range = config.csuite.roles[role].effects[key];
  return range ? withinRange(range, strength) : 0;
};

/** One of a role's effects for the company: the hired executive's, or 0 with the role unfilled. */
export function effectOf(config: GameConfig, state: Pick<GameState, "csuite">, role: CsuiteRole, key: string): number {
  const executive = executiveIn(state, role);
  return executive ? effectAt(config, role, key, executive.strength) : 0;
}

/** The head of each staff pool that has one: their output effect lifts the whole pool's work. */
const POOL_HEADS: Partial<Record<StaffPool, CsuiteRole>> = {
  developers: "headOfDevelopment",
  ops: "headOfOps",
  support: "headOfSupport",
  // The CTO's research bonus: research points are researchers' output × RP each.
  researchers: "cto",
};
const POOL_EFFECT: Partial<Record<StaffPool, string>> = {
  developers: "output",
  ops: "output",
  support: "output",
  researchers: "research",
};

/**
 * What a pool's work a day is multiplied by: 1 + its head's output bonus (the CTO's research bonus for researchers), or
 * 1 without one.
 */
export function poolBoost(config: GameConfig, state: Pick<GameState, "csuite">, pool: StaffPool): number {
  const role = POOL_HEADS[pool];
  return role ? 1 + effectOf(config, state, role, POOL_EFFECT[pool]!) : 1;
}

/** Pips the CFO adds to investor, funder and deal negotiation rolls: a whole number, 0 without one. Never pay reviews. */
export const cfoRollBonus = (config: GameConfig, state: Pick<GameState, "csuite">) =>
  Math.round(effectOf(config, state, "cfo", "rollBonus"));

/** What a bank loan's interest rate is multiplied by: less with a CFO. */
export const loanRateShare = (config: GameConfig, state: Pick<GameState, "csuite">) =>
  1 - effectOf(config, state, "cfo", "loanRateCut");

/** What everyday running costs (hosting, rent, power, provider fees; not staff pay) are multiplied by: less with a COO. */
export const runningCostShare = (config: GameConfig, state: Pick<GameState, "csuite">) =>
  1 - effectOf(config, state, "coo", "runningCostCut");

/** What a migration's days and its upfront bill are multiplied by: less with a CIO. */
export const migrationShare = (config: GameConfig, state: Pick<GameState, "csuite">) =>
  1 - effectOf(config, state, "cio", "migrationCut");

/** What every outage's hours are multiplied by: fewer with a head of ops. */
export const outageShare = (config: GameConfig, state: Pick<GameState, "csuite">) =>
  1 - effectOf(config, state, "headOfOps", "outageCut");

/** What satisfaction's speed of recovery is multiplied by, when it's rising: faster with a head of support. */
export const recoveryBoost = (config: GameConfig, state: Pick<GameState, "csuite">) =>
  1 + effectOf(config, state, "headOfSupport", "recovery");

/** The share of the ops a setup needs that keeps patches up to date: less with a CISO, who runs patching. */
export const patchingNeed = (config: GameConfig, state: Pick<GameState, "csuite">) =>
  1 - effectOf(config, state, "ciso", "patching");

/** What a security breach's chance of coming up is multiplied by: lower with a CISO. */
export const breachShare = (config: GameConfig, state: Pick<GameState, "csuite">) =>
  1 - effectOf(config, state, "ciso", "breachCut");

/** What campaigns' users per pound are multiplied by: more with a CMO (the cmoBonus hook). */
export const cmoBoost = (config: GameConfig, state: Pick<GameState, "csuite">) => 1 + effectOf(config, state, "cmo", "campaigns");

/** How strong the head of people is, 0 without one: 1 is the config's headOfPeople figures, more is better. */
export const headOfPeopleStrength = (config: GameConfig, state: Pick<GameState, "csuite">) =>
  effectOf(config, state, "headOfPeople", "strength");
