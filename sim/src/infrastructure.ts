import type { EventConfig, GameConfig, ModelId } from "./config.ts";
import type { Customers } from "./customers.ts";
import type { EventToday, Events } from "./events.ts";
import { count, pounds, risen } from "./finance.ts";
import { vary } from "./rng.ts";
import type { GameState, LogEntry } from "./state.ts";

/**
 * Infrastructure: what each model costs to run, the ops it needs, the load the company can serve, and the outages
 * when it can't.
 */
export function createInfrastructure(config: GameConfig, customers: Customers, events: Events) {
  const opsNeeded = (model: ModelId) => config.models[model].opsNeeded;

  function upfrontEntries(modelId: ModelId): LogEntry[] {
    const { name, upfrontCost } = config.models[modelId];
    if (upfrontCost === 0) return [];
    return [{ text: `Upfront cost: ${name}`, cashDelta: -upfrontCost, category: "infrastructure" }];
  }

  /** A model's monthly and per-user prices, after any provider price rises. */
  function modelPrices(state: GameState, modelId: ModelId) {
    const rise = state.priceRises[modelId] ?? 1;
    const { monthlyCost, monthlyCostPerUser } = config.models[modelId];
    return { monthlyCost: risen(monthlyCost, rise), monthlyCostPerUser: risen(monthlyCostPerUser, rise) };
  }

  /**
   * A model's running costs for some days: its monthly cost, plus its per-user cost on the given users, each billed
   * as days ÷ daysPerMonth of a month and rounded to the pound. Advance bills one day at a time; billing part of a
   * month (say when leaving a model) uses the same rule. Prices include any provider price rises.
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
    return entries;
  }

  /** What a day of a model's running costs comes to, on the given users. */
  const dailyInfrastructure = (state: GameState, modelId: ModelId, users: number) =>
    -infrastructureEntries(state, modelId, users).reduce((sum, e) => sum + e.cashDelta, 0);

  function monthlyInfrastructureCost(state: GameState): number {
    const { monthlyCost, monthlyCostPerUser } = modelPrices(state, state.model);
    return Math.round(monthlyCost + state.users * monthlyCostPerUser);
  }

  /**
   * Each factor scales capacity. Models that need ops lose capacity in step with missing ops.
   * Later mechanics (traffic events, scaling up) add their own factors here.
   */
  function capacityFactors(state: GameState): number[] {
    const needed = opsNeeded(state.model);
    const staffed = needed === 0 ? 1 : Math.min(state.ops, needed) / needed;
    const { unstaffedShare } = config.capacity;
    return [unstaffedShare + (1 - unstaffedShare) * staffed];
  }

  /** Capacity with the current model and staff, before any event scales it. */
  function baseCapacity(state: GameState): number {
    const base = config.models[state.model].capacity;
    return Math.round(capacityFactors(state).reduce((c, f) => c * f, base));
  }

  /** As baseCapacity, but on a day an event scaled the company up, capacity met that day's load. */
  function capacity(state: GameState): number {
    return events.scaledUp(state) ? Math.max(baseCapacity(state), state.load) : baseCapacity(state);
  }

  function uptime(state: GameState): number {
    const hoursPlayed = (state.day - 1) * 24;
    return hoursPlayed === 0 ? 100 : (100 * (hoursPlayed - state.downtimeHours)) / hoursPlayed;
  }

  /**
   * A day's load against capacity. Today's load comes from the users at the start of the day, plus any an event
   * brings. A model that scales grows to meet the load, and is charged for it; otherwise the usual capacity rules
   * decide whether there's an outage. Draws once from the RNG.
   */
  function serveLoad(state: GameState, day: number, today: EventToday[]) {
    const profile = config.productTypes[state.productType].growth;
    const [loadVariation, rng] = vary(state.rng, profile.loadNoise);
    let load = Math.round(customers.baseLoad(state.productType, state.users, day) * loadVariation);
    const scaling: { event: EventConfig; extraLoad: number; costPerLoad: number }[] = [];
    for (const { event, outcome } of today) {
      if (!event.load) continue;
      const before = load;
      load = Math.round(load * event.load.multiplier + event.load.extra);
      const costPerLoad = outcome.scaleCostPerLoad;
      if (costPerLoad !== undefined) scaling.push({ event, extraLoad: load - before, costPerLoad });
    }
    const cap = scaling.length ? Math.max(baseCapacity(state), load) : baseCapacity(state);
    const overloaded = load > cap;
    const { baseHours, hoursPerOverload } = config.outage;
    const overloadHours = overloaded ? Math.ceil(baseHours + hoursPerOverload * (load / cap - 1)) : 0;
    const eventHours = today.reduce((sum, t) => sum + (t.outcome.downtimeHours ?? 0), 0);
    const hoursDown = Math.min(24, overloadHours + eventHours);

    // Charges for scaling up to meet an event.
    const charges: LogEntry[] = [];
    for (const { event, extraLoad, costPerLoad } of scaling) {
      const cost = Math.round(extraLoad * costPerLoad);
      if (cost > 0) {
        const text = `${event.name}: scaled up for ${count.format(extraLoad)} extra load`;
        charges.push({ text, cashDelta: -cost, category: "infrastructure" });
      }
    }
    let outage: LogEntry | undefined;
    if (hoursDown > 0) {
      const percent = Math.round((100 * load) / cap);
      const cause = overloaded
        ? `load hit ${percent}% of capacity`
        : today.find((t) => t.outcome.downtimeHours)!.event.name;
      outage = { text: `Outage: ${cause}. Down ${hoursDown} hours; growth slowed.`, cashDelta: 0, kind: "outage" };
    }
    return { load, rng, overloaded, hoursDown, charges, outage };
  }

  return {
    opsNeeded,
    upfrontEntries,
    infrastructureEntries,
    dailyInfrastructure,
    monthlyInfrastructureCost,
    capacity,
    uptime,
    serveLoad,
  };
}

export type Infrastructure = ReturnType<typeof createInfrastructure>;
