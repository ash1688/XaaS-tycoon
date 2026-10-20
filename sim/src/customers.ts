import type { GameConfig, ProductTypeId } from "./config.ts";
import type { Events } from "./events.ts";
import type { Features } from "./features.ts";
import type { Pricing } from "./pricing.ts";
import { vary } from "./rng.ts";
import type { GameState, UnitDemand } from "./state.ts";
import type { Support } from "./support.ts";

/**
 * Customers: the product's users, paying and free, how fast they grow, and the load they put on the servers. Every
 * user adds load, free or not.
 */
export function createCustomers(
  config: GameConfig,
  features: Features,
  events: Events,
  pricing: Pricing,
  support: Support,
) {
  function startingUsers(productType: ProductTypeId, day: number) {
    const users = config.productTypes[productType].growth.startingUsers;
    return {
      users,
      ...pricing.startingPricing(productType, users),
      load: Math.round(baseLoad(productType, users, day)),
      demand: baseDemand(productType, users, day),
      outageDays: 0,
      downtimeHours: 0,
    };
  }

  function inSpike(productType: ProductTypeId, day: number): boolean {
    const spike = config.productTypes[productType].growth.seasonalSpike;
    return !!spike && day >= spike.firstDay && (day - spike.firstDay) % spike.every < spike.length;
  }

  /** What the seasonal spike multiplies load and demand by on a day: 1 outside one. */
  function spikeMultiplier(productType: ProductTypeId, day: number): number {
    const spike = config.productTypes[productType].growth.seasonalSpike;
    return spike && inSpike(productType, day) ? spike.loadMultiplier : 1;
  }

  /** Load from a product's users on a given day, before random variation. */
  function baseLoad(productType: ProductTypeId, users: number, day: number): number {
    return users * config.productTypes[productType].growth.loadPerUser * spikeMultiplier(productType, day);
  }

  /** CU and DBU demand from a product's users on a given day, before random variation. It spikes like load. */
  function baseDemand(productType: ProductTypeId, users: number, day: number): UnitDemand {
    const { cuPerUser, dbuPerUser } = config.productTypes[productType].demand;
    const spike = spikeMultiplier(productType, day);
    return { cu: users * cuPerUser * spike, dbu: users * dbuPerUser * spike };
  }

  /** Each factor scales the day's growth. Later mechanics (reputation) add their own here. */
  function growthFactors(state: GameState, day: number, outage: boolean): number[] {
    const spike = config.productTypes[state.productType].growth.seasonalSpike;
    return [
      spike && inSpike(state.productType, day) ? spike.growthMultiplier : 1,
      outage ? config.outage.growthMultiplier : 1,
      // Each feature built before today, and each add-on bought.
      ...features.activeGrowth(state),
      // Each feature the platform can't provide.
      ...events.gapGrowth(state),
      // The price against the product's fair price.
      pricing.priceGrowth(state),
      // Customer satisfaction, from yesterday: low satisfaction slows growth.
      support.satisfactionGrowth(state),
    ];
  }

  /** Each share of users who leave in a day. Added together. Later mechanics (price waves) add their own here. */
  function churnShares(state: GameState): number[] {
    return [support.satisfactionChurn(state)];
  }

  /**
   * The users at the end of a day, and how many of them pay. Some leave first (churn), paid and free alike; then new
   * users arrive. Growth slows as the market fills up, on an outage day, at a high price and with low satisfaction.
   */
  function grow(state: GameState, day: number, outage: boolean, rng: number) {
    const profile = config.productTypes[state.productType].growth;
    const [growthVariation, next] = vary(rng, profile.growthNoise);
    const rate = growthFactors(state, day, outage).reduce(
      (r, f) => r * f,
      profile.dailyGrowth * (1 - state.users / profile.marketSize) * growthVariation,
    );
    const churnShare = Math.min(1, churnShares(state).reduce((sum, c) => sum + c, 0));
    const churned = Math.round(state.users * churnShare);
    const stayed = state.users - churned;
    const kept: GameState = { ...state, users: stayed, paidUsers: pricing.paidUsersAfter(state, stayed) };
    const users = Math.max(0, stayed + Math.round(state.users * rate));
    return { users, paidUsers: pricing.paidUsersAfter(kept, users), churned, rng: next };
  }

  return { startingUsers, baseLoad, baseDemand, grow };
}

export type Customers = ReturnType<typeof createCustomers>;
