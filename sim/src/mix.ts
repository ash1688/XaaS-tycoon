import { CUSTOMER_TYPE_IDS, type CustomerTypeId, type GameConfig } from "./config.ts";
import type { Features } from "./features.ts";
import type { CustomerMixView, Pricing } from "./pricing.ts";
import type { Rivals } from "./rivals.ts";
import type { GameState } from "./state.ts";

/** Users who left or joined, and how they split by customer type: each type's weight, scaled to add up to them. */
export interface UsersLost {
  users: number;
  weights: Record<CustomerTypeId, number>;
}

/** One reason new users split as they do: each customer type's weight from it, multiplied together over the reasons. */
export interface NewUserFactor {
  why: "product" | "features" | "price" | "rivals";
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
 * customer type), the price (above a type's threshold, fewer of that type join) and the rivals (each takes most of the
 * types it's the best deal for). Users who leave go by their own
 * reasons: churn takes every type alike, the price takes casual users first and downtime businesses first.
 *
 * How new users split by type lives here, in newUserFactors, so anything else that steers who joins (rivals) adds a
 * factor there rather than its own split.
 */
export function createCustomerMix(config: GameConfig, features: Features, pricing: Pricing, rivals: Rivals) {
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
      // Fewer of a type join where a rival is the better deal for it.
      { why: "rivals", weights: rivals.newUserWeights(state) },
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

  /**
   * The features' appeal to each type against the product's mix as a whole: the type's appeal ÷ the base-mix average.
   * Features that pull every type alike cancel out to 1, so only a real tilt shows. Rounded so they do exactly.
   */
  function relativeAppeal(state: GameState): Record<CustomerTypeId, number> {
    const appeal = features.appeal(state);
    const base = pricing.baseMix(state.productType);
    const average = CUSTOMER_TYPE_IDS.reduce((sum, t) => sum + base[t] * appeal[t], 0);
    return byType((t) => (average > 0 ? Math.round((1e9 * appeal[t]) / average) / 1e9 : 1));
  }

  /** Rivals' pull on each type against the product's mix as a whole, as relativeAppeal does for features. */
  function relativeRivalPull(state: GameState): Record<CustomerTypeId, number> {
    const pull = rivals.newUserWeights(state);
    const base = pricing.baseMix(state.productType);
    const average = CUSTOMER_TYPE_IDS.reduce((sum, t) => sum + base[t] * pull[t], 0);
    return byType((t) => (average > 0 ? Math.round((100 * pull[t]) / average) / 100 : 1));
  }

  /** The customer mix for the screens, with each type's share of new users and what tilts it. */
  function customerMix(state: GameState): CustomerMixView {
    const view = pricing.customerMix(state);
    const newMix = newUserMix(state);
    const appeal = relativeAppeal(state);
    const filter = priceFilter(state);
    const pull = relativeRivalPull(state);
    return {
      ...view,
      types: view.types.map((t) => ({ ...t, newShare: newMix[t.id], featureAppeal: appeal[t.id], priceFilter: filter[t.id], rivalPull: pull[t.id] })),
    };
  }

  return { newUserFactors, newUserMix, mixAfter, customerMix };
}

export type CustomerMix = ReturnType<typeof createCustomerMix>;
