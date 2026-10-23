import { CUSTOMER_TYPE_IDS, type CustomerTypeId, type GameConfig } from "./config.ts";
import type { Features } from "./features.ts";
import type { CustomerMixView, Pricing } from "./pricing.ts";
import type { GameState } from "./state.ts";

/** Users who left or joined, and how they split by customer type: each type's weight, scaled to add up to them. */
export interface UsersLost {
  users: number;
  weights: Record<CustomerTypeId, number>;
}

/** One reason new users split as they do: each customer type's weight from it, multiplied together over the reasons. */
export interface NewUserFactor {
  why: "product" | "features" | "price";
  weights: Record<CustomerTypeId, number>;
}

const byType = (f: (t: CustomerTypeId) => number) =>
  Object.fromEntries(CUSTOMER_TYPE_IDS.map((t) => [t, f(t)])) as Record<CustomerTypeId, number>;

/** Weights scaled to add up to 1, or the fallback when they add up to nothing. */
function normalise(weights: Record<CustomerTypeId, number>, fallback: Record<CustomerTypeId, number>) {
  const sum = CUSTOMER_TYPE_IDS.reduce((total, t) => total + Math.max(0, weights[t]), 0);
  return sum > 0 ? byType((t) => Math.max(0, weights[t]) / sum) : fallback;
}

/**
 * What shifts the customer mix. New users arrive in the product's mix, tilted by the features (each appeals to a
 * customer type) and the price (above a type's threshold, fewer of that type join). Users who leave go by their own
 * reasons: churn takes every type alike, the price takes casual users first and downtime businesses first.
 *
 * How new users split by type lives here, in newUserFactors, so anything else that steers who joins (rivals) adds a
 * factor there rather than its own split.
 */
export function createCustomerMix(config: GameConfig, features: Features, pricing: Pricing) {
  /**
   * The price's filter on who joins: 1 for a type whose threshold the price isn't over, and (price ÷ threshold) ^ −newUserFilter for
   * one it's over. Twice the casual users' threshold brings a quarter as many of them.
   */
  const priceFilter = (state: GameState) =>
    byType((t) => Math.min(1, (state.price / pricing.threshold(state.productType, t)) ** -config.pricing.newUserFilter));

  /** Each reason new users split as they do. Multiplied together and scaled, they're the mix new users arrive in. */
  function newUserFactors(state: GameState): NewUserFactor[] {
    return [
      { why: "product", weights: pricing.baseMix(state.productType) },
      { why: "features", weights: features.appeal(state) },
      { why: "price", weights: priceFilter(state) },
    ];
  }

  /** Each customer type's share of today's new users, adding up to 1. */
  function newUserMix(state: GameState): Record<CustomerTypeId, number> {
    const weights = newUserFactors(state).reduce((w, f) => byType((t) => w[t] * f.weights[t]), byType(() => 1));
    return normalise(weights, pricing.baseMix(state.productType));
  }

  /**
   * The mix at the end of a day: the users at its start by type, less each group who left split by its weights, plus
   * each group who joined split by theirs. A type can't lose more users than it has. A negative group joining (users
   * fell back from beyond the market) leaves like churn. Unchanged once nobody is left.
   */
  function mixAfter(state: GameState, left: UsersLost[], joined: UsersLost[]): Record<CustomerTypeId, number> {
    const users = byType((t) => state.customerMix[t] * state.users);
    const take = (g: UsersLost) => {
      const split = normalise(g.weights, state.customerMix);
      for (const t of CUSTOMER_TYPE_IDS) users[t] = Math.max(0, users[t] - g.users * split[t]);
    };
    left.filter((g) => g.users > 0).forEach(take);
    for (const g of joined) {
      if (g.users < 0) take({ users: -g.users, weights: state.customerMix });
      else if (g.users > 0) {
        const split = normalise(g.weights, state.customerMix);
        for (const t of CUSTOMER_TYPE_IDS) users[t] += g.users * split[t];
      }
    }
    return normalise(users, state.customerMix);
  }

  /** The customer mix for the screens, with each type's share of new users and what tilts it. */
  function customerMix(state: GameState): CustomerMixView {
    const view = pricing.customerMix(state);
    const newMix = newUserMix(state);
    const appeal = features.appeal(state);
    const filter = priceFilter(state);
    return {
      ...view,
      types: view.types.map((t) => ({ ...t, newShare: newMix[t.id], featureAppeal: appeal[t.id], priceFilter: filter[t.id] })),
    };
  }

  return { newUserFactors, newUserMix, mixAfter, customerMix };
}

export type CustomerMix = ReturnType<typeof createCustomerMix>;
