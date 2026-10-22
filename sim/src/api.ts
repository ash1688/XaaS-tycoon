import type { GameConfig } from "./config.ts";
import type { Features } from "./features.ts";
import { count, pounds, type Finance } from "./finance.ts";
import { SimError, type ApiState, type GameState, type LogEntry } from "./state.ts";

/** The product's paid API, for the screen: what it costs to buy, and once bought, its calls and what they earn. */
export interface ApiView {
  /** "Shop API". */
  name: string;
  blurb: string;
  /** What buying it costs, once. */
  price: number;
  owned: boolean;
  /** What each call served earns. */
  pricePerCall: number;
  /** Calls one APIU serves in a day. */
  callsPerApiu: number;
  /** Calls a day developers make now: what the next day played brings. 0 before it's bought. */
  calls: number;
  /** Where the calls are heading at today's paying users and features. */
  target: number;
  /** Calls served and dropped on the day just played. */
  served: number;
  dropped: number;
  /** What the day just played's calls earned, and on SaaS what the provider took for them. */
  income: number;
  fee: number;
  /**
   * What a usual day earns and costs at today's calls and capacity, with no outage: the calls the APIU can serve
   * (all of them on SaaS) at the price, and on SaaS the provider's fee for them.
   */
  dailyIncome: number;
  dailyFee: number;
  /** On SaaS the provider runs the API: it needs no APIU, but takes feePerCall for each call served. */
  providerRuns: boolean;
  /** The provider's fee per call after any price rise, or null where you run the API yourself. */
  feePerCall: number | null;
  /** APIU the calls need against what the ready servers give for the next day; null where the provider runs it. */
  apiu: { demand: number; capacity: number } | null;
  /** Days left of slow API growth after an outage: 0 when it grows normally. */
  slowDaysLeft: number;
}

/** A per-call amount in pence: "1p", "0.4p". */
const pence = (n: number) => `${Math.round(n * 1000) / 10}p`;

/**
 * Paid APIs: buying one, its calls each day against the APIU, the income they earn and, where the provider runs it,
 * the fee per call, and how the calls grow (see ApiConfig). apiuOn gives the APIU the servers give on a day, after any
 * cut for missing ops, or null on a model without servers, where the provider runs the API.
 */
export function createApi(
  config: GameConfig,
  features: Features,
  finance: Finance,
  apiuOn: (state: GameState, day: number) => number | null,
) {
  const productApi = (state: GameState) => config.productTypes[state.productType].api;

  /** Calls a day the traffic heads for: paying users × calls each × (1 + perFeature × active features). */
  function target(state: GameState, paidUsers = state.paidUsers): number {
    const api = productApi(state);
    if (!api) return 0;
    return Math.round(paidUsers * api.callsPerPaidUser * (1 + config.api.perFeature * features.activeCount(state)));
  }

  /**
   * The provider's fee per call after any price rise, or null where the company runs the API on its own servers. To a
   * thousandth of a penny, since it's a fraction of one.
   */
  const feePerCall = (state: GameState, providerRuns: boolean) =>
    providerRuns ? Math.round(config.api.saasFeePerCall * (state.priceRises[state.model] ?? 1) * 1e5) / 1e5 : null;

  /** Calls the APIU can serve on a day: unlimited where the provider runs the API. */
  function callsCapacity(state: GameState, day: number) {
    const apiu = apiuOn(state, day);
    return { apiu, calls: apiu === null ? Infinity : Math.floor(apiu * config.api.callsPerApiu) };
  }

  function buyApi(state: GameState): GameState {
    const api = productApi(state);
    if (!api) throw new SimError("no_api", "Your product has no paid API to buy.");
    if (state.api) throw new SimError("api_owned", `You already have your ${api.name}.`);
    if (api.price > state.cash) {
      throw new SimError("cant_afford", `Your ${api.name} costs ${pounds(api.price)} and you have ${pounds(state.cash)}.`, {
        cost: api.price,
        cash: state.cash,
      });
    }
    const bought: GameState = { ...state, api: { calls: config.api.startingCalls, served: 0, dropped: 0, slowUntil: 0 } };
    return finance.chargeNow(bought, [{ text: `Bought your ${api.name}`, cashDelta: -api.price, category: "infrastructure" }]);
  }

  /**
   * A day of API calls, once the API is bought and the product has launched. Calls arriving while the service is down
   * are dropped, and so are any beyond what the APIU serve; each call served earns its price, less the provider's fee
   * where it runs the API. Then the traffic moves for tomorrow: an outage loses a share of it and slows its growth for
   * a while; otherwise it closes a share of the gap to the target, set by `paidUsers` (the day's end), more slowly
   * the more calls were dropped.
   */
  function apiDay(state: GameState, day: number, hoursDown: number, paidUsers: number, live: boolean) {
    const api = state.api;
    const product = productApi(state);
    if (!api || !product || !live) return { api, entries: [] as LogEntry[] };
    const { outageDrop, slowDays, slowGrowth, dailyGrowth, pricePerCall } = config.api;
    const { calls } = api;
    const reachable = Math.round((calls * (24 - hoursDown)) / 24);
    const capacity = callsCapacity(state, day);
    const providerRuns = capacity.apiu === null;
    const served = Math.min(reachable, capacity.calls);
    const entries: LogEntry[] = [];
    const income = Math.round(served * pricePerCall);
    if (income > 0) {
      const text = `Income: ${product.name}, ${count.format(served)} calls at ${pence(pricePerCall)}`;
      entries.push({ text, cashDelta: income, kind: "income" });
    }
    const fee = feePerCall(state, providerRuns);
    if (fee !== null && served > 0) {
      const text = `${config.models[state.model].name} runs your ${product.name}: ${count.format(served)} calls at ${pence(fee)}`;
      entries.push({ text, cashDelta: -Math.round(served * fee), category: "infrastructure" });
    }
    if (reachable < calls) {
      const text = `${product.name}: ${count.format(calls - reachable)} calls dropped while you were down. Developers trust it less: calls fell and will grow slowly for ${slowDays} days.`;
      entries.push({ text, cashDelta: 0, kind: "api" });
    }
    if (served < reachable) {
      const apiu = Math.round((capacity.apiu ?? 0) * 10) / 10;
      const text = `${product.name}: ${count.format(reachable - served)} calls dropped, and their income. Your ${apiu} APIU serve ${count.format(capacity.calls)} calls a day: add API servers or switch app servers to APIU.`;
      entries.push({ text, cashDelta: 0, kind: "api" });
    }

    let next: number;
    let { slowUntil } = api;
    if (hoursDown > 0) {
      next = calls * (1 - outageDrop);
      slowUntil = day + slowDays;
    } else {
      const goal = target(state, paidUsers);
      // Dropped calls put developers off building on it, in step with the share dropped. Falling traffic isn't slowed.
      const reliability = reachable > 0 ? served / reachable : 1;
      const slow = day <= api.slowUntil ? slowGrowth : 1;
      const rate = goal > calls ? dailyGrowth * reliability * slow : dailyGrowth;
      next = calls + (goal - calls) * rate;
    }
    const after: ApiState = { calls: Math.round(next), served, dropped: calls - served, slowUntil };
    return { api: after, entries };
  }

  /** What a usual day's calls earn at today's traffic and the capacity for the next day, and any provider fee. */
  function usualDay(state: GameState) {
    if (!state.api) return { income: 0, fee: 0 };
    const capacity = callsCapacity(state, state.day + 1);
    const served = Math.min(state.api.calls, capacity.calls);
    const fee = feePerCall(state, capacity.apiu === null);
    return { income: Math.round(served * config.api.pricePerCall), fee: fee === null ? 0 : Math.round(served * fee) };
  }

  /** The product's paid API, bought or not, or null on a product without one. */
  function apiView(state: GameState): ApiView | null {
    const product = productApi(state);
    if (!product) return null;
    const api = state.api;
    const capacity = callsCapacity(state, state.day + 1);
    const providerRuns = capacity.apiu === null;
    const fee = feePerCall(state, providerRuns);
    const usual = usualDay(state);
    const calls = api?.calls ?? 0;
    const round = (n: number) => Math.round(n * 10) / 10;
    return {
      name: product.name,
      blurb: product.blurb,
      price: product.price,
      owned: !!api,
      pricePerCall: config.api.pricePerCall,
      callsPerApiu: config.api.callsPerApiu,
      calls,
      target: api ? target(state) : 0,
      served: api?.served ?? 0,
      dropped: api?.dropped ?? 0,
      income: Math.round((api?.served ?? 0) * config.api.pricePerCall),
      fee: fee === null ? 0 : Math.round((api?.served ?? 0) * fee),
      dailyIncome: usual.income,
      dailyFee: usual.fee,
      providerRuns,
      feePerCall: fee,
      apiu: capacity.apiu === null ? null : { demand: round(calls / config.api.callsPerApiu), capacity: round(capacity.apiu) },
      slowDaysLeft: api ? Math.max(0, api.slowUntil - state.day) : 0,
    };
  }

  return { buyApi, apiDay, usualDay, apiView };
}

export type Api = ReturnType<typeof createApi>;
