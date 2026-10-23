import type { GameConfig, ProductTypeId } from "./config.ts";
import type { Events } from "./events.ts";
import type { Features } from "./features.ts";
import { count } from "./finance.ts";
import type { Pricing } from "./pricing.ts";
import { nextRandom, seedRng, vary } from "./rng.ts";
import type { GameState, LogEntry, UnitDemand } from "./state.ts";
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
  /**
   * A new company: no users until it launches (see Launch), so no load. Its launch total is drawn evenly from the
   * product's range, from a stream of its own seeded by the game's seed, so the game's other draws don't shift.
   */
  function startingCustomers(productType: ProductTypeId, seed: number) {
    const { launchUsersMin: min, launchUsersMax: max } = config.productTypes[productType].growth;
    const [r] = nextRandom(seedRng(seed ^ 0x1a0c4));
    return {
      launchDay: null,
      launchUsers: Math.round(min + (Math.max(min, max) - min) * r),
      users: 0,
      ...pricing.startingPricing(productType, 0),
      load: 0,
      demand: { cu: 0, dbu: 0 },
      outageDays: 0,
      downtimeHours: 0,
    };
  }

  function inSpike(productType: ProductTypeId, day: number): boolean {
    const spike = config.productTypes[productType].growth.seasonalSpike;
    return !!spike && day >= spike.firstDay && (day - spike.firstDay) % spike.every < spike.length;
  }

  /**
   * What the seasonal spike multiplies load and demand by on a day: 1 outside one. On the payments app load follows
   * the day's payments, which also rise on paydays (see Pricing.paymentsMultiplier).
   */
  function spikeMultiplier(productType: ProductTypeId, day: number): number {
    if (config.productTypes[productType].transactions) return pricing.paymentsMultiplier(productType, day);
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

  /** Each share of paying users who stop paying in a day, on top of churn, the price's first. Added together. */
  function paidChurnShares(state: GameState, hoursDown: number): number[] {
    return [pricing.priceChurn(state), support.satisfactionPaidChurn(state), config.outage.paidChurnPerHour * hoursDown * (config.productTypes[state.productType].outageChurnMultiple ?? 1)];
  }

  /**
   * The users at the end of a day, and how many of them pay. Some leave first (churn), paid and free alike; then
   * paying users stop paying at a price well above the fair one, with low satisfaction and for each hour down, some
   * dropping to free and the rest leaving; then new users arrive. Growth slows as the market fills up, on an outage
   * day, at a high price and with low satisfaction.
   */
  function grow(state: GameState, day: number, hoursDown: number, rng: number) {
    const profile = config.productTypes[state.productType].growth;
    const [growthVariation, next] = vary(rng, profile.growthNoise);
    const rate = growthFactors(state, day, hoursDown > 0).reduce(
      (r, f) => r * f,
      profile.dailyGrowth * (1 - state.users / profile.marketSize) * growthVariation,
    );
    const churnShare = Math.min(1, churnShares(state).reduce((sum, c) => sum + c, 0));
    const churned = Math.round(state.users * churnShare);
    const stayed = state.users - churned;
    const stayedPaid = pricing.paidUsersAfter(state, stayed);
    const shares = paidChurnShares(state, hoursDown);
    const allShares = shares.reduce((sum, c) => sum + c, 0);
    const stoppedPaying = Math.round(stayedPaid * Math.min(1, allShares));
    // Those who stopped over the price wouldn't pay it today: income leaves them out.
    const pricedOut = allShares > 0 ? Math.round((stoppedPaying * shares[0]!) / allShares) : 0;
    const droppedToFree = Math.round(stoppedPaying * config.pricing.dropToFreeShare);
    const leftPaying = stoppedPaying - droppedToFree;
    const kept: GameState = { ...state, users: stayed - leftPaying, paidUsers: stayedPaid - stoppedPaying };
    const users = Math.max(0, kept.users + Math.round(state.users * rate));
    const entries: LogEntry[] =
      stoppedPaying > 0
        ? [{ text: stoppedPayingText(state, hoursDown, leftPaying, droppedToFree), cashDelta: 0 }]
        : [];
    return { users, paidUsers: pricing.paidUsersAfter(kept, users), churned, pricedOut, rng: next, entries };
  }

  /** How many paying users stopped paying today, and why: "Paying users lost: 12 left and 8 dropped to free, because …". */
  function stoppedPayingText(state: GameState, hoursDown: number, left: number, toFree: number): string {
    const why = [
      pricing.priceChurn(state) > 0 ? "your price is above what they think it's worth" : "",
      support.satisfactionPaidChurn(state) > 0 ? "they're unhappy with support" : "",
      hoursDown > 0 ? "the service was down" : "",
    ].filter(Boolean);
    return `Paying users lost: ${count.format(left)} left and ${count.format(toFree)} dropped to free, because ${why.join(" and ")}.`;
  }

  return { startingCustomers, baseLoad, baseDemand, grow };
}

export type Customers = ReturnType<typeof createCustomers>;
