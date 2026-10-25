import type { GameConfig, PeopleLeadConfig } from "./config.ts";
import type { GameState } from "./state.ts";

/**
 * What a head of people does to pay reviews, or what their absence does: the people-lead modifier. Every head-of-people
 * effect on a review reads it, and nothing else does. See PeopleLeadConfig.
 */
export interface PeopleLead extends PeopleLeadConfig {
  /** Whether the company has a head of people. Without one, the student deals with staff directly. */
  headOfPeople: boolean;
}

/**
 * Whether the company has a head of people: always false until the C-suite (#108) is built. The one place it's
 * checked, so #108 fills it in here once a head of people can be hired.
 */
export const hasHeadOfPeople = (_state: GameState): boolean => false;

/** The modifier with or without a head of people, from config's two sets of values. */
export const peopleLeadFor = (config: GameConfig, headOfPeople: boolean): PeopleLead => ({
  headOfPeople,
  ...(headOfPeople ? config.payReview.peopleLead.headOfPeople : config.payReview.peopleLead.none),
});

/** The people-lead modifier for the company as it stands. */
export const peopleLead = (config: GameConfig, state: GameState): PeopleLead => peopleLeadFor(config, hasHeadOfPeople(state));
