import { describe, expect, it } from "vitest";
import { createSim, defaultConfig, SimError, type DayLog, type GameConfig, type GameState, type ModelId } from "../src/index.ts";

// Paid APIs (#117), through the sim's public interface on the default config: buying one, calls against APIU, the
// income they earn and lose, traffic growth, app servers switched to APIU, PaaS API instances and the SaaS fee.
const sim = createSim();
const { pricePerCall, callsPerApiu, startingCalls, outageDrop, slowDays, saasFeePerCall } = defaultConfig.api;
const shopApi = defaultConfig.productTypes.ecommerce.api!;

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return "no error";
};
const act = (s: GameState, ...actions: Parameters<typeof sim.applyAction>[1][]) =>
  actions.reduce((state, action) => sim.applyAction(state, action), s);
const entries = (log: DayLog[]) => log.flatMap((d) => d.entries);
const apiLines = (log: DayLog[]) => entries(log).filter((e) => e.kind === "api");
const apiIncome = (log: DayLog[]) =>
  entries(log)
    .filter((e) => e.kind === "income" && e.text.startsWith(`Income: ${shopApi.name}`))
    .reduce((sum, e) => sum + e.cashDelta, 0);

/** A launched shop with plenty of cash and room for its users, on a model with or without servers. */
function shop(model: ModelId = "iaas", s: typeof sim = sim): GameState {
  let state = s.newGame({ companyName: "Shop Ltd", productType: "ecommerce", model, seed: 3 });
  state = { ...state, cash: 1_000_000, ops: 3 };
  if (model === "iaas") {
    state = act(state, { type: "rentServer", server: "app", size: "massive" }, { type: "rentServer", server: "database", size: "massive" });
  } else if (model === "paas") {
    state = act(state, { type: "setInstances", count: 3 }, { type: "setManagedService", service: "database", size: "large" });
  }
  // Past the launch ramp, and before the first scripted outage can come.
  return s.advance(state, 5).state;
}

describe("buying a paid API", () => {
  it("is offered on e-commerce with its price, and not on a product without one", () => {
    const view = sim.api(shop());
    expect(view).toMatchObject({ name: "Shop API", price: shopApi.price, owned: false, calls: 0, pricePerCall: 0.01 });
    const social = sim.newGame({ companyName: "Friends", productType: "social", model: "saas", seed: 1 });
    expect(sim.api(social)).toBeNull();
    expect(code(() => sim.applyAction(social, { type: "buyApi" }))).toBe("no_api");
  });

  it("charges its price at once, and starts the calls", () => {
    const before = shop();
    const after = act(before, { type: "buyApi" });
    expect(after.cash).toBe(before.cash - shopApi.price);
    expect(after.spend.infrastructure).toBe(before.spend.infrastructure + shopApi.price);
    expect(sim.api(after)).toMatchObject({ owned: true, calls: startingCalls, served: 0, dropped: 0 });
    expect(code(() => sim.applyAction(after, { type: "buyApi" }))).toBe("api_owned");
    expect(code(() => sim.applyAction({ ...before, cash: shopApi.price - 1 }, { type: "buyApi" }))).toBe("cant_afford");
  });

  it("offers API servers only once it's bought", () => {
    const state = shop();
    expect(sim.serverOptions(state).some((o) => o.type === "api")).toBe(false);
    expect(code(() => sim.applyAction(state, { type: "rentServer", server: "api", size: "small" }))).toBe("no_api");
    const bought = act(state, { type: "buyApi" });
    expect(sim.serverOptions(bought).filter((o) => o.type === "api").map((o) => o.units)).toEqual([6, 10, 20, 30]);
  });
});

describe("calls against APIU", () => {
  it("drops every call with no APIU, and their income, saying why", () => {
    const state = act(shop(), { type: "buyApi" });
    const { state: next, log } = sim.advance(state);
    expect(apiIncome(log)).toBe(0);
    expect(sim.api(next)).toMatchObject({ served: 0, dropped: startingCalls, income: 0, apiu: { capacity: 0 } });
    expect(apiLines(log).map((e) => e.text)).toEqual([
      `Shop API: ${startingCalls.toLocaleString("en-GB")} calls dropped, and their income. Your 0 APIU serve 0 calls a day: add API servers or switch app servers to APIU.`,
    ]);
  });

  it("serves calls up to the APIU, at about 1p each, and drops the rest", () => {
    // A small API server: 6 APIU, 6,000 calls a day. Ready tomorrow, serving the day after.
    let state = act(shop(), { type: "buyApi" }, { type: "rentServer", server: "api", size: "small" });
    state = sim.advance(state).state;
    // Plenty of calls: more than one small server serves.
    state = { ...state, api: { ...state.api!, calls: 10_000 } };
    expect(sim.api(state)).toMatchObject({ apiu: { demand: 10, capacity: 6 }, dailyIncome: 60 });
    const { state: next, log } = sim.advance(state);
    expect(apiIncome(log)).toBe(6_000 * pricePerCall);
    expect(sim.api(next)).toMatchObject({ served: 6_000, dropped: 4_000, income: 60 });
    expect(apiLines(log)).toHaveLength(1);
    expect(next.income - state.income).toBe(entries(log).filter((e) => e.kind === "income").reduce((sum, e) => sum + e.cashDelta, 0));
  });

  it("serves every call with APIU to spare, and counts them in the runway", () => {
    let state = act(shop(), { type: "buyApi" }, { type: "rentServer", server: "api", size: "large" });
    state = sim.advance(state).state;
    const calls = state.api!.calls;
    const runway = sim.runway(state);
    expect(runway.dailyIncome).toBe(sim.dailyIncome(state) + Math.round(calls * pricePerCall));
    const { state: next, log } = sim.advance(state);
    expect(sim.api(next)).toMatchObject({ served: calls, dropped: 0 });
    expect(apiIncome(log)).toBe(Math.round(calls * pricePerCall));
    expect(apiLines(log)).toEqual([]);
  });

  it("loses capacity with ops short, like every other tier", () => {
    let state = act(shop(), { type: "buyApi" }, { type: "rentServer", server: "api", size: "large" });
    state = sim.advance(state).state;
    expect(sim.api(state)!.apiu!.capacity).toBe(20);
    expect(sim.api({ ...state, ops: 0 })!.apiu!.capacity).toBe(20 * defaultConfig.capacity.unstaffedShare);
  });
});

describe("API traffic", () => {
  /** A shop with an API and APIU to spare, so no call is dropped. */
  const roomy = () => sim.advance(act(shop(), { type: "buyApi" }, { type: "rentServer", server: "api", size: "massive" })).state;

  it("grows towards paying users × calls each, a tenth of the gap a day", () => {
    const state = roomy();
    const target = state.paidUsers * shopApi.callsPerPaidUser;
    expect(sim.api(state)!.target).toBe(target);
    const calls = state.api!.calls;
    const next = sim.advance(state).state;
    // The target follows the users paying at the end of the day.
    const goal = next.paidUsers * shopApi.callsPerPaidUser;
    expect(next.api!.calls).toBe(Math.round(calls + (goal - calls) * defaultConfig.api.dailyGrowth));
  });

  it("aims higher with features built", () => {
    const state = roomy();
    const built: GameState = { ...state, features: { checkout: { status: "built", progress: 20 }, reviews: { status: "built", progress: 12 } } };
    expect(sim.api(built)!.target).toBe(Math.round(state.paidUsers * shopApi.callsPerPaidUser * (1 + 2 * defaultConfig.api.perFeature)));
  });

  it("grows more slowly while calls are dropped", () => {
    const state = roomy();
    const starved: GameState = { ...state, servers: state.servers.filter((s) => s.type !== "api") };
    const grown = sim.advance(state).state.api!.calls;
    // With no APIU every call is dropped, so traffic doesn't grow at all.
    expect(sim.advance(starved).state.api!.calls).toBe(state.api!.calls);
    expect(grown).toBeGreaterThan(state.api!.calls);
  });

  it("falls on an outage, and grows slowly for a while after it", () => {
    const state = roomy();
    // Not enough database for the users: an outage from load.
    const down: GameState = {
      ...state,
      servers: state.servers.map((s) => (s.type === "database" ? { ...s, size: "small" as const } : s)),
      api: { ...state.api!, calls: 5_000 },
    };
    const { state: after, log } = sim.advance(down);
    expect(after.outageDays).toBe(down.outageDays + 1);
    expect(after.api!.calls).toBe(Math.round(5_000 * (1 - outageDrop)));
    expect(sim.api(after)!.slowDaysLeft).toBe(slowDays);
    expect(apiLines(log).some((e) => e.text.includes("calls dropped while you were down"))).toBe(true);
    // Served only for the hours it was up.
    expect(after.api!.served).toBeLessThan(5_000);

    // Back up, growth is slowGrowth of the usual.
    const fixed: GameState = { ...after, servers: state.servers };
    const calls = fixed.api!.calls;
    const next = sim.advance(fixed).state;
    const goal = next.paidUsers * shopApi.callsPerPaidUser;
    const rate = defaultConfig.api.dailyGrowth * defaultConfig.api.slowGrowth;
    expect(next.api!.calls).toBe(Math.round(calls + (goal - calls) * rate));
  });
});

describe("app servers switched between CU and APIU", () => {
  it("trades CU for APIU, and back", () => {
    // A load balancer, so both app servers count.
    let state = act(
      shop(),
      { type: "buyApi" },
      { type: "rentServer", server: "app", size: "large" },
      { type: "rentServer", server: "loadBalancer", size: "small" },
    );
    state = sim.advance(state).state;
    const before = sim.units(state)!;
    expect(before.cu.capacity).toBe(50);
    const id = state.servers.find((s) => s.type === "app" && s.size === "large")!.id;
    const switched = act(state, { type: "switchServer", id, gives: "apiu" });
    expect(sim.servers(switched).find((s) => s.id === id)).toMatchObject({ apiu: true, units: 20 });
    expect(sim.units(switched)!.cu.capacity).toBe(before.cu.capacity - 20);
    expect(sim.api(switched)!.apiu!.capacity).toBe(20);
    // Switched app servers don't need load balancers: the massive one is the only app server left.
    expect(sim.units(switched)!.loadBalancer).toMatchObject({ appServers: 1, needed: false });
    const back = act(switched, { type: "switchServer", id, gives: "cu" });
    expect(sim.units(back)!.cu.capacity).toBe(before.cu.capacity);
    expect(sim.api(back)!.apiu!.capacity).toBe(0);
    expect(back.servers.find((s) => s.id === id)).not.toHaveProperty("apiu");
  });

  it("serves calls from a switched app server", () => {
    let state = act(shop(), { type: "buyApi" }, { type: "rentServer", server: "app", size: "small" });
    state = sim.advance(state).state;
    const id = state.servers.find((s) => s.type === "app" && s.size === "small")!.id;
    state = act(state, { type: "switchServer", id, gives: "apiu" });
    state = { ...state, api: { ...state.api!, calls: 8_000 } };
    expect(sim.advance(state).state.api).toMatchObject({ served: 6_000, dropped: 2_000 });
  });

  it("refuses what can't switch", () => {
    const state = shop();
    const app = state.servers.find((s) => s.type === "app")!.id;
    const db = state.servers.find((s) => s.type === "database")!.id;
    expect(code(() => sim.applyAction(state, { type: "switchServer", id: app, gives: "apiu" }))).toBe("no_api");
    const bought = act(state, { type: "buyApi" });
    expect(code(() => sim.applyAction(bought, { type: "switchServer", id: db, gives: "apiu" }))).toBe("not_app_server");
    expect(code(() => sim.applyAction(bought, { type: "switchServer", id: app, gives: "cu" }))).toBe("already_switched");
    expect(code(() => sim.applyAction(bought, { type: "switchServer", id: 999, gives: "apiu" }))).toBe("unknown_server");
    const paas = act(shop("paas"), { type: "buyApi" });
    const instance = paas.servers.find((s) => s.type === "app")!.id;
    expect(code(() => sim.applyAction(paas, { type: "switchServer", id: instance, gives: "apiu" }))).toBe("managed");
  });
});

describe("API instances on PaaS", () => {
  it("sets an API instance count, each giving the instance size's APIU", () => {
    const state = act(shop("paas"), { type: "buyApi" });
    expect(sim.managed(state)).toMatchObject({ apiInstances: 0, apiInstanceUnits: 10, apiInstanceMonthlyCost: 900 });
    expect(code(() => sim.applyAction(shop("paas"), { type: "setApiInstances", count: 1 }))).toBe("no_api");
    const two = act(state, { type: "setApiInstances", count: 2 });
    expect(sim.managed(two)!.apiInstances).toBe(2);
    expect(sim.api(two)!.apiu!.capacity).toBe(20);
    expect(sim.servers(two).filter((s) => s.type === "api").map((s) => s.name)).toEqual(["API instance", "API instance"]);
    expect(sim.managed(act(two, { type: "setApiInstances", count: 0 }))!.apiInstances).toBe(0);
    expect(code(() => sim.applyAction(state, { type: "setApiInstances", count: 21 }))).toBe("bad_instances");
    // Billed like app instances.
    const { log } = sim.advance(two);
    expect(entries(log).some((e) => e.text === "API instance (medium): 2 × £900 a month" && e.cashDelta === -60)).toBe(true);
  });
});

describe("the API on SaaS", () => {
  it("needs no APIU: the provider serves every call and takes its fee", () => {
    const state = act(shop("saas"), { type: "buyApi" });
    const view = sim.api(state)!;
    expect(view).toMatchObject({ providerRuns: true, apiu: null, feePerCall: saasFeePerCall });
    expect(view.dailyFee).toBe(Math.round(startingCalls * saasFeePerCall));
    expect(sim.runway(state).dailyCosts - sim.runway(shop("saas")).dailyCosts).toBe(view.dailyFee);
    const { state: next, log } = sim.advance(state);
    if (next.outageDays > state.outageDays) throw new Error("This seed should have no outage on the day played.");
    expect(next.api).toMatchObject({ served: startingCalls, dropped: 0 });
    expect(apiIncome(log)).toBe(Math.round(startingCalls * pricePerCall));
    const fee = entries(log).find((e) => e.text.startsWith("Build on a SaaS platform (SaaS) runs your Shop API"));
    expect(fee).toMatchObject({ cashDelta: -Math.round(startingCalls * saasFeePerCall), category: "infrastructure" });
  });

  it("puts the fee up with the provider's prices", () => {
    const state = act(shop("saas"), { type: "buyApi" });
    expect(sim.api({ ...state, priceRises: { saas: 1.25 } })!.feePerCall).toBe(0.005);
  });
});

describe("the API across a migration", () => {
  it("sizes API servers into the new setup for today's calls", () => {
    let state = act(shop("saas"), { type: "buyApi" });
    state = { ...state, api: { ...state.api!, calls: 15_000 } };
    const quote = sim.migrationQuote(state, "iaas");
    // 15 APIU plus a quarter: 18.75, met most cheaply by one massive API server.
    expect(quote.sizedFor.apiu).toBe(18.75);
    expect(quote.setup.find((i) => i.type === "api")).toMatchObject({ name: "API server", count: 1, size: "large", units: 20 });
    const paas = sim.migrationQuote(state, "paas");
    expect(paas.setup.find((i) => i.type === "api")).toMatchObject({ name: "API instance", count: 2, units: 10 });
    // Without an API, no API servers.
    expect(sim.migrationQuote(shop("saas"), "iaas").setup.some((i) => i.type === "api")).toBe(false);
  });
});

describe("a product's API is data-driven", () => {
  it("can be switched on for another product in config", () => {
    const config: GameConfig = {
      ...defaultConfig,
      productTypes: {
        ...defaultConfig.productTypes,
        social: { ...defaultConfig.productTypes.social, api: { name: "Social API", blurb: "Apps post for users.", price: 1_000, callsPerPaidUser: 1 } },
      },
    };
    const own = createSim(config);
    const state = own.newGame({ companyName: "Friends", productType: "social", model: "saas", seed: 1 });
    expect(own.api(state)).toMatchObject({ name: "Social API", price: 1_000 });
    expect(own.api(own.applyAction(state, { type: "buyApi" }))!.owned).toBe(true);
  });
});
