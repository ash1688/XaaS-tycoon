import type { Calendar } from "./calendar.ts";
import { CUSTOMER_TYPE_IDS, type CustomerTypeId, type GameConfig, type ProductTypeId } from "./config.ts";
import type { Events } from "./events.ts";
import type { Features } from "./features.ts";
import { count } from "./finance.ts";
import type { Pricing } from "./pricing.ts";
import type { Rivals } from "./rivals.ts";
import { nextRandom, seedRng, vary } from "./rng.ts";
import type { GameState, LogEntry, UnitDemand } from "./state.ts";
import type { UsersLost } from "./mix.ts";
import { demandPerUser } from "./optimisation.ts";
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
  calendar: Calendar,
  rivals: Rivals,
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
      ...rivals.startingRivals(productType, seed),
      load: 0,
      demand: { cu: 0, dbu: 0 },
      outageDays: 0,
      downtimeHours: 0,
    };
  }

  /**
   * What the calendar multiplies load and demand by on a day: its holidays, and on the payments app its paydays too, as
   * load follows the day's payments (see Pricing.paymentsMultiplier). 1 on an ordinary day.
   */
  const busyMultiplier = (state: Pick<GameState, "productType" | "startDate">, day: number) =>
    calendar.loadMultiplier(state, day) * pricing.paydayMultiplier(state.productType, day);

  /** Load from a product's users on a given day, before random variation: any holidays on it move it. */
  function baseLoad(state: Pick<GameState, "productType" | "startDate">, users: number, day: number): number {
    return users * config.productTypes[state.productType].growth.loadPerUser * busyMultiplier(state, day);
  }

  /**
   * CU and DBU demand from a product's users on a given day, before random variation, after optimisation on the
   * current model. Holidays move it like load.
   */
  function baseDemand(
    state: Pick<GameState, "productType" | "startDate" | "model" | "optimisationDays" | "benefits">,
    users: number,
    day: number,
  ): UnitDemand {
    const { cuPerUser, dbuPerUser } = demandPerUser(config, state, state.model);
    const busy = busyMultiplier(state, day);
    return { cu: users * cuPerUser * busy, dbu: users * dbuPerUser * busy };
  }

  /** Each factor scales the day's growth. Later mechanics (reputation) add their own here. */
  function growthFactors(state: GameState, day: number, outage: boolean): number[] {
    return [
      // Any holidays on today.
      calendar.growthMultiplier(state, day),
      outage ? config.outage.growthMultiplier : 1,
      // Each feature built before today, and each add-on bought.
      ...features.activeGrowth(state),
      // Each feature the platform can't provide.
      ...events.gapGrowth(state),
      // The price against the product's fair price.
      pricing.priceGrowth(state),
      // Customer satisfaction, from yesterday: low satisfaction slows growth.
      support.satisfactionGrowth(state),
      // Rivals: winning or losing each customer type's new users to them.
      rivals.rivalGrowth(state),
    ];
  }

  /** Each share of users who leave in a day. Added together. Later mechanics (price waves) add their own here. */
  function churnShares(state: GameState, hoursDown: number): number[] {
    return [support.satisfactionChurn(state), outageLeave(state, hoursDown)];
  }

  /** Share of a customer type's users who leave over a day's downtime: businesses go fastest, casual users not at all. */
  const typeOutageLeave = (type: CustomerTypeId, hoursDown: number) =>
    Math.min(1, config.customerTypes[type].outageLeavePerHour * hoursDown);

  /** Share of all users who leave over a day's downtime: each type's share, weighted by its share of users. */
  const outageLeave = (state: GameState, hoursDown: number) =>
    CUSTOMER_TYPE_IDS.reduce((sum, t) => sum + state.customerMix[t] * typeOutageLeave(t, hoursDown), 0);

  /** Who churn takes, by customer type: support takes every type alike, downtime businesses first. */
  function churnMix(state: GameState, hoursDown: number): Record<CustomerTypeId, number> {
    const satisfaction = support.satisfactionChurn(state);
    const weights = CUSTOMER_TYPE_IDS.map((t) => [t, state.customerMix[t] * (satisfaction + typeOutageLeave(t, hoursDown))]);
    return Object.fromEntries(weights) as Record<CustomerTypeId, number>;
  }

  /** Each share of paying users who stop paying in a day, on top of churn, the price's first. Added together. */
  function paidChurnShares(state: GameState, hoursDown: number): number[] {
    return [pricing.priceChurn(state), support.satisfactionPaidChurn(state), config.outage.paidChurnPerHour * hoursDown * (config.productTypes[state.productType].outageChurnMultiple ?? 1)];
  }

  /**
   * Who the paying users who stopped paying and left are, by customer type: each type's share of users × its own
   * share lost, over the price (casual users first), support and downtime (every type alike).
   */
  function leftMix(state: GameState, hoursDown: number): Record<CustomerTypeId, number> {
    const others = support.satisfactionPaidChurn(state) + config.outage.paidChurnPerHour * hoursDown;
    const weights = pricing.priceChurnByType(state).map((p) => [p.id, p.share * (p.reaction + others)]);
    return Object.fromEntries(weights) as Record<CustomerTypeId, number>;
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
    const churnShare = Math.min(1, churnShares(state, hoursDown).reduce((sum, c) => sum + c, 0));
    const churned = Math.round(state.users * churnShare);
    const leftOverDowntime = Math.min(churned, Math.round(state.users * outageLeave(state, hoursDown)));
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
    // For the customer mix: who churn took and who stopped paying and left.
    const lost: UsersLost[] = [
      { users: churned, weights: churnMix(state, hoursDown) },
      { users: leftPaying, weights: leftMix(state, hoursDown) },
    ];
    const entries: LogEntry[] = [
      ...(leftOverDowntime > 0 ? [{ text: downtimeLeaversText(hoursDown, leftOverDowntime), cashDelta: 0 }] : []),
      ...(stoppedPaying > 0 ? [{ text: stoppedPayingText(state, hoursDown, leftPaying, droppedToFree), cashDelta: 0 }] : []),
    ];
    return { users, paidUsers: pricing.paidUsersAfter(kept, users), churned, pricedOut, lost, arrived: users - kept.users, rng: next, entries };
  }

  /** Users who left over the downtime, and who: "Downtime: 40 users left, businesses and professionals who …". */
  function downtimeLeaversText(hoursDown: number, left: number): string {
    const who = CUSTOMER_TYPE_IDS.filter((t) => typeOutageLeave(t, hoursDown) > 0)
      .reverse()
      .map((t) => config.customerTypes[t].name.toLowerCase());
    const names = who.length > 1 ? `${who.slice(0, -1).join(", ")} and ${who.at(-1)}` : who[0];
    return `Downtime: ${count.format(left)} ${left === 1 ? "user" : "users"} left, ${names} who can't run on a service that goes down.`;
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
