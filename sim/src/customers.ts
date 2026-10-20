import type { GameConfig, ProductTypeId } from "./config.ts";
import type { Events } from "./events.ts";
import type { Features } from "./features.ts";
import type { Pricing } from "./pricing.ts";
import { vary } from "./rng.ts";
import type { GameState } from "./state.ts";

/**
 * Customers: the product's users, paying and free, how fast they grow, and the load they put on the servers. Every
 * user adds load, free or not.
 */
export function createCustomers(config: GameConfig, features: Features, events: Events, pricing: Pricing) {
  function startingUsers(productType: ProductTypeId, day: number) {
    const users = config.productTypes[productType].growth.startingUsers;
    return {
      users,
      ...pricing.startingPricing(productType, users),
      load: Math.round(baseLoad(productType, users, day)),
      outageDays: 0,
      downtimeHours: 0,
    };
  }

  function inSpike(productType: ProductTypeId, day: number): boolean {
    const spike = config.productTypes[productType].growth.seasonalSpike;
    return !!spike && day >= spike.firstDay && (day - spike.firstDay) % spike.every < spike.length;
  }

  /** Load from a product's users on a given day, before random variation. */
  function baseLoad(productType: ProductTypeId, users: number, day: number): number {
    const { loadPerUser, seasonalSpike } = config.productTypes[productType].growth;
    const spike = seasonalSpike && inSpike(productType, day) ? seasonalSpike.loadMultiplier : 1;
    return users * loadPerUser * spike;
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
    ];
  }

  /**
   * The users at the end of a day, and how many of them pay. Growth slows as the market fills up, on an outage day
   * and at a high price.
   */
  function grow(state: GameState, day: number, outage: boolean, rng: number) {
    const profile = config.productTypes[state.productType].growth;
    const [growthVariation, next] = vary(rng, profile.growthNoise);
    const rate = growthFactors(state, day, outage).reduce(
      (r, f) => r * f,
      profile.dailyGrowth * (1 - state.users / profile.marketSize) * growthVariation,
    );
    const users = Math.max(0, state.users + Math.round(state.users * rate));
    return { users, paidUsers: pricing.paidUsersAfter(state, users), rng: next };
  }

  return { startingUsers, baseLoad, grow };
}

export type Customers = ReturnType<typeof createCustomers>;
