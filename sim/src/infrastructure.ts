import type { GameConfig, ModelId } from "./config.ts";
import type { Customers } from "./customers.ts";
import type { EventToday, Events } from "./events.ts";
import { count, pounds, risen } from "./finance.ts";
import { vary } from "./rng.ts";
import type { Servers, UnitCapacity, UnitsView } from "./servers.ts";
import type { GameState, LogEntry, UnitDemand } from "./state.ts";

/** Demand rounded to the hundredth of a unit, so state stays tidy. */
const tidy = (n: number) => Math.round(n * 100) / 100;

/**
 * Capacity on a model with no servers and no capacity limit (SaaS): the provider scales, and you pay per user, free
 * users included.
 */
export interface ProviderView {
  /** Every user, free ones included: each is billed. */
  users: number;
  freeUsers: number;
  /** The provider's monthly fee per user, after any price rises. */
  perUserFee: number;
  /** What today's users cost a month at that fee. */
  monthlyPerUserBill: number;
  /** The provider's flat monthly bill, after any price rises. */
  monthlyCost: number;
}

/**
 * Infrastructure: what each model costs to run, the ops it needs, the load the company can serve, and the outages
 * when it can't. A model with servers serves CU and DBU demand with them (see Servers). A model without them has no
 * capacity limit (SaaS), unless a test config gives it a fixed capacity for load.
 */
export function createInfrastructure(config: GameConfig, customers: Customers, events: Events, servers: Servers) {
  /** No servers and no fixed capacity: the provider scales, so capacity is never the constraint. */
  const unlimited = (model: ModelId) => !servers.hasServers(model) && config.models[model].capacity === undefined;

  /** Ops staff a model needs to start with: on a model with servers, for its starter setup. */
  const opsNeeded = (model: ModelId) => servers.modelOpsNeeded(model);

  /**
   * What adopting a model costs up front: its upfront cost and, on a model that buys its servers, the starter kit at
   * its purchase prices. The model's upfront cost is the rest of the setup (the server room), so nothing is charged
   * twice.
   */
  function upfrontEntries(modelId: ModelId): LogEntry[] {
    const { name, upfrontCost } = config.models[modelId];
    const model: LogEntry[] =
      upfrontCost === 0 ? [] : [{ text: `Upfront cost: ${name}`, cashDelta: -upfrontCost, category: "infrastructure" }];
    return [...model, ...servers.starterPurchases(modelId)];
  }

  /** Everything adopting a model costs up front. */
  const upfrontCost = (modelId: ModelId) => -upfrontEntries(modelId).reduce((sum, e) => sum + e.cashDelta, 0);

  /** A model's monthly and per-user prices, after any provider price rises. */
  function modelPrices(state: GameState, modelId: ModelId) {
    const rise = state.priceRises[modelId] ?? 1;
    const { monthlyCost, monthlyCostPerUser } = config.models[modelId];
    return { monthlyCost: risen(monthlyCost, rise), monthlyCostPerUser: risen(monthlyCostPerUser, rise) };
  }

  /**
   * A model's running costs for some days: its monthly cost, plus its per-user cost on the given users, plus the rent
   * on its servers, each billed as days ÷ daysPerMonth of a month and rounded to the pound. Advance bills one day at a
   * time; billing part of a month (say when leaving a model) uses the same rule. Prices include any provider price
   * rises. A model the company isn't on is priced with the starter setup it would get.
   */
  function infrastructureEntries(state: GameState, modelId: ModelId, users: number, days = 1): LogEntry[] {
    const { name } = config.models[modelId];
    const { monthlyCost, monthlyCostPerUser } = modelPrices(state, modelId);
    const share = days / config.billing.daysPerMonth;
    const entries: LogEntry[] = [];
    if (monthlyCost > 0) {
      entries.push({
        text: `${name} running costs (${pounds(monthlyCost)} a month)`,
        cashDelta: -Math.round(monthlyCost * share),
        category: "infrastructure",
      });
    }
    if (monthlyCostPerUser > 0 && users > 0) {
      entries.push({
        text: `${name} per-user fee (${count.format(users)} users at ${pounds(monthlyCostPerUser)} a month)`,
        cashDelta: -Math.round(users * monthlyCostPerUser * share),
        category: "infrastructure",
      });
    }
    return [...entries, ...servers.serverEntries(state, modelId, days)];
  }

  /** What a day of a model's running costs comes to, on the given users. */
  const dailyInfrastructure = (state: GameState, modelId: ModelId, users: number) =>
    -infrastructureEntries(state, modelId, users).reduce((sum, e) => sum + e.cashDelta, 0);

  function monthlyInfrastructureCost(state: GameState): number {
    const { monthlyCost, monthlyCostPerUser } = modelPrices(state, state.model);
    return Math.round(monthlyCost + state.users * monthlyCostPerUser + servers.monthlyServerCost(state));
  }

  /**
   * Each factor scales capacity. Models that need ops lose capacity in step with missing ops: on a model with servers,
   * every tier does. Later mechanics add their own factors here.
   */
  function capacityFactors(state: GameState): number[] {
    const needed = servers.opsNeeded(state);
    const staffed = needed === 0 ? 1 : Math.min(state.ops, needed) / needed;
    const { unstaffedShare } = config.capacity;
    return [unstaffedShare + (1 - unstaffedShare) * staffed];
  }

  const capacityFactor = (state: GameState) => capacityFactors(state).reduce((c, f) => c * f, 1);

  /** Units the servers give on a day, after any cut for missing ops. */
  const unitCapacity = (state: GameState, day: number) => servers.capacityOn(state, day, capacityFactor(state));

  /**
   * Capacity with the current model and staff, before any event scales it. On a model with servers, the load its
   * ready servers can carry at the product's usual mix of demand: the users they serve × load per user. Unlimited
   * (Infinity) on a model with no capacity limit.
   */
  function baseCapacity(state: GameState): number {
    if (unlimited(state.model)) return Infinity;
    if (servers.hasServers(state.model)) {
      const users = servers.usersSupported(unitCapacity(state, state.day + 1), state.productType);
      const load = users * config.productTypes[state.productType].growth.loadPerUser;
      return Number.isFinite(load) ? Math.round(load) : Number.MAX_SAFE_INTEGER;
    }
    return Math.round(capacityFactor(state) * (config.models[state.model].capacity ?? 0));
  }

  /**
   * As baseCapacity, but on a day an event scaled the company up, capacity met that day's load. Null on a model with
   * no capacity limit.
   */
  function capacity(state: GameState): number | null {
    if (unlimited(state.model)) return null;
    return events.scaledUp(state) ? Math.max(baseCapacity(state), state.load) : baseCapacity(state);
  }

  /** On a model with no capacity limit (SaaS), what the provider bills for the users it scales to; otherwise null. */
  function provider(state: GameState): ProviderView | null {
    if (!unlimited(state.model)) return null;
    const { monthlyCost, monthlyCostPerUser } = modelPrices(state, state.model);
    return {
      users: state.users,
      freeUsers: state.users - state.paidUsers,
      perUserFee: monthlyCostPerUser,
      monthlyPerUserBill: Math.round(state.users * monthlyCostPerUser),
      monthlyCost,
    };
  }

  /**
   * CU, DBU and CH against demand on a model with servers, or null on one without. Demand is the day just played's,
   * against what the ready servers give for the next day. On a day an event's extra VMs met the demand, capacity
   * shown includes them.
   */
  function units(state: GameState): UnitsView | null {
    if (!servers.hasServers(state.model)) return null;
    const cap = unitCapacity(state, state.day + 1);
    const burst = events.scaledUp(state);
    const served = servers.serve(cap, state.demand);
    const round = (n: number) => Math.round(n * 10) / 10;
    const cu = burst ? Math.max(cap.cu, state.demand.cu) : cap.cu;
    const dbu = burst ? Math.max(cap.dbu, served.dbuAfterCache) : cap.dbu;
    const users = servers.usersSupported(cap, state.productType);
    return {
      cu: { demand: round(state.demand.cu), capacity: round(cu) },
      dbu: { demand: round(served.dbuAfterCache), capacity: round(dbu), beforeCache: round(state.demand.dbu) },
      ch: { demand: round(served.cacheable), capacity: round(cap.ch), absorbed: round(served.absorbed) },
      binding: served.binding,
      usersSupported: Number.isFinite(users) ? Math.floor(users) : Number.MAX_SAFE_INTEGER,
      loadBalancer: cap.loadBalancer,
      burst,
    };
  }

  function uptime(state: GameState): number {
    const hoursPlayed = (state.day - 1) * 24;
    return hoursPlayed === 0 ? 100 : (100 * (hoursPlayed - state.downtimeHours)) / hoursPlayed;
  }

  /** Hours down on a day over capacity, the further over the longer: ratio is load ÷ capacity. */
  function overloadHours(ratio: number): number {
    const { baseHours, hoursPerOverload } = config.outage;
    return ratio > 1 ? Math.ceil(baseHours + hoursPerOverload * (ratio - 1)) : 0;
  }

  /**
   * A day's load against capacity. Today's load and CU and DBU demand come from the users at the start of the day,
   * plus any an event brings. On a model with servers, the weakest tier decides whether there's an outage, unless an
   * event scales it up (charged for); a model with no capacity limit never runs out, so only events take it down.
   * Draws once from the RNG.
   */
  function serveLoad(state: GameState, day: number, today: EventToday[]) {
    const profile = config.productTypes[state.productType].growth;
    const [loadVariation, rng] = vary(state.rng, profile.loadNoise);
    let load = Math.round(customers.baseLoad(state.productType, state.users, day) * loadVariation);
    const base = customers.baseDemand(state.productType, state.users, day);
    let unitMultiplier = loadVariation;
    for (const { event } of today) {
      if (!event.load) continue;
      load = Math.round(load * event.load.multiplier + event.load.extra);
      unitMultiplier *= event.load.unitMultiplier ?? event.load.multiplier;
    }
    const demand: UnitDemand = { cu: tidy(base.cu * unitMultiplier), dbu: tidy(base.dbu * unitMultiplier) };
    const eventHours = today.reduce((sum, t) => sum + (t.outcome.downtimeHours ?? 0), 0);
    const eventCause = () => today.find((t) => t.outcome.downtimeHours)!.event.name;

    if (servers.hasServers(state.model)) {
      const served = serveUnits(state, day, demand, today);
      const hoursDown = Math.min(24, overloadHours(served.ratio) + eventHours);
      let outage: LogEntry | undefined;
      if (hoursDown > 0) {
        const cause = served.overloaded ? served.cause : eventCause();
        outage = { text: `Outage: ${cause}. Down ${hoursDown} hours; growth slowed.`, cashDelta: 0, kind: "outage" };
      }
      return { load, demand, rng, overloaded: served.overloaded, hoursDown, charges: served.charges, outage };
    }

    // With no capacity limit, the load always fits: only an event takes the service down.
    const cap = baseCapacity(state);
    const overloaded = load > cap;
    const hoursDown = Math.min(24, (overloaded ? overloadHours(load / cap) : 0) + eventHours);
    const charges: LogEntry[] = [];
    let outage: LogEntry | undefined;
    if (hoursDown > 0) {
      const percent = Math.round((100 * load) / cap);
      const cause = overloaded ? `load hit ${percent}% of capacity` : eventCause();
      outage = { text: `Outage: ${cause}. Down ${hoursDown} hours; growth slowed.`, cashDelta: 0, kind: "outage" };
    }
    return { load, demand, rng, overloaded, hoursDown, charges, outage };
  }

  /**
   * A day's CU and DBU demand against the servers. An event that scales rents extra VMs (or on a managed platform,
   * the platform scales itself) for whatever is over capacity, charged per unit, so there's no overload; otherwise the
   * binding tier's ratio sets any outage.
   */
  function serveUnits(state: GameState, day: number, demand: UnitDemand, today: EventToday[]) {
    const cap: UnitCapacity = unitCapacity(state, day);
    const served = servers.serve(cap, demand);
    const scaler = today.find((t) => t.scales);
    const charges: LogEntry[] = [];
    if (scaler) {
      const cu = Math.max(0, demand.cu - cap.cu);
      const dbu = Math.max(0, served.dbuAfterCache - cap.dbu);
      const cost = Math.round((cu + dbu) * (scaler.outcome.scaleCostPerUnit ?? 0));
      if (cost > 0) {
        const extra = [cu > 0 && `${count.format(Math.ceil(cu))} CU`, dbu > 0 && `${count.format(Math.ceil(dbu))} DBU`];
        const what = extra.filter(Boolean).join(" and ");
        const text = servers.isManaged(state.model)
          ? `${scaler.event.name}: the platform scaled up for ${what} over your setup`
          : `${scaler.event.name}: extra VMs for ${what} over capacity`;
        charges.push({ text, cashDelta: -cost, category: "infrastructure" });
      }
      return { ratio: 0, overloaded: false, charges, cause: "" };
    }
    const tier = served.binding === "cu" ? "compute (CU)" : "the database (DBU)";
    const cause = Number.isFinite(served.ratio)
      ? `${tier} hit ${Math.round(100 * served.ratio)}% of capacity`
      : `${tier} had no capacity`;
    return { ratio: served.ratio, overloaded: served.ratio > 1, charges, cause };
  }

  return {
    opsNeeded,
    opsNeededNow: servers.opsNeeded,
    upfrontEntries,
    upfrontCost,
    infrastructureEntries,
    dailyInfrastructure,
    monthlyInfrastructureCost,
    capacity,
    provider,
    units,
    uptime,
    serveLoad,
  };
}

export type Infrastructure = ReturnType<typeof createInfrastructure>;
