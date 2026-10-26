import type { GameConfig, PeopleLeadConfig } from "./config.ts";
import { hasExecutive, headOfPeopleStrength } from "./executives.ts";
import type { GameState } from "./state.ts";

/**
 * What a head of people does to pay reviews, or what their absence does: the people-lead modifier. Every head-of-people
 * effect on a review reads it, and nothing else does. See PeopleLeadConfig.
 */
export interface PeopleLead extends PeopleLeadConfig {
  /** Whether the company has a head of people. Without one, the student deals with staff directly. */
  headOfPeople: boolean;
}

/** Whether the company has a head of people (a C-suite role). The one place it's checked. */
export const hasHeadOfPeople = (state: GameState): boolean => hasExecutive(state, "headOfPeople");

/**
 * The modifier with or without a head of people. With one, `strength` sets how far they move each figure from the
 * none values: 1 (the default) gives config's headOfPeople values, 1.5 half as far again. The roll bonus stays a whole
 * number of pips.
 */
export function peopleLeadFor(config: GameConfig, headOfPeople: boolean, strength = 1): PeopleLead {
  const { none, headOfPeople: head } = config.payReview.peopleLead;
  if (!headOfPeople) return { headOfPeople, ...none };
  const at = (key: keyof PeopleLeadConfig) => none[key] + (head[key] - none[key]) * strength;
  return {
    headOfPeople,
    rollBonus: Math.round(at("rollBonus")),
    walkAwaySoftening: at("walkAwaySoftening"),
    schemeValuation: at("schemeValuation"),
    tribunalLean: at("tribunalLean"),
  };
}

/** The people-lead modifier for the company as it stands: the head of people hired, at their strength. */
export const peopleLead = (config: GameConfig, state: GameState): PeopleLead =>
  peopleLeadFor(config, hasHeadOfPeople(state), headOfPeopleStrength(config, state));
