import { describe, expect, it } from "vitest";
import { playDay, STRATEGIES } from "../scripts/harness.ts";
import {
  configFields,
  createSim,
  defaultConfig,
  SimError,
  type Action,
  type DayLog,
  type GameConfig,
  type GameState,
  type ModelId,
  type ProductTypeId,
  type Sim,
  type TierNumber,
} from "../src/index.ts";

// Tiers, model benefits and the hardware slider (#123), through the sim's public interface. Tier 1 is open from the
// start; tiers 2–4 open on their conditions, in order, and stay open. Each holds product features and model benefits:
// a feature or benefit can only be had once its tier is unlocked. Model benefits are bought on their own model, billed
// monthly and lost on a migration; product features and the tiers themselves are kept. On-prem, each server's hardware
// slider trades capacity against heat, crashes and wear.

/** The default config with no random or scripted events, and no MVP to build, so days compare exactly. */
const quiet: GameConfig = {
  ...defaultConfig,
  events: [],
  startingCash: 250_000,
  mvp: { ...defaultConfig.mvp, baseDevDays: { ecommerce: 0, social: 0, video: 0, payments: 0, assistant: 0, games: 0 } },
};
const sim = createSim(quiet);
const { tiers: tierConfig, hardware } = defaultConfig;
const benefit = (id: string) => tierConfig.benefits.find((b) => b.id === id)!;

const begin = (model: ModelId = "iaas", productType: ProductTypeId = "ecommerce", s: Sim = sim) =>
  s.newGame({ companyName: "Tiered Co", productType, model, seed: 7, takeLoan: model === "onprem" });

const act = (state: GameState, ...actions: Action[]) => actions.reduce((st, a) => sim.applyAction(st, a), state);

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return null;
};

const texts = (log: DayLog[]) => log.flatMap((d) => d.entries.map((e) => e.text));

/** The same company with tiers up to `tier` already open, as if their conditions had been met on day 1. */
const opened = (state: GameState, tier: TierNumber): GameState => ({
  ...state,
  tiers: ([2, 3, 4] as const).filter((t) => t <= tier).map((t) => ({ tier: t, day: 1 })),
});

/** The last `days` days played made to have this income and these hours down each, for tier 3's averages. */
function withHistory(state: GameState, days: number, income: number, hoursDown = 0): GameState {
  const last = state.spendByDay.at(-1)!;
  const history = Array.from({ length: days }, (_, i) => ({ ...last, day: state.day - days + i + 1, income, hoursDown }));
  return { ...state, spendByDay: [...state.spendByDay, ...history] };
}

const tier = (state: GameState, n: TierNumber, s: Sim = sim) => s.tiers(state).find((t) => t.tier === n)!;

/** A first setup on IaaS: a medium app server and database, ready the next day. */
const iaasSetup = (state: GameState) =>
  act(state, { type: "rentServer", server: "app", size: "medium" }, { type: "rentServer", server: "database", size: "large" });

/** On-prem with a large app server and database, played until they've arrived and are serving. */
function onpremRunning(s: Sim = sim) {
  let state = begin("onprem", "ecommerce", s);
  state = s.applyAction(state, { type: "buyServer", server: "app", size: "large" });
  state = s.applyAction(state, { type: "buyServer", server: "database", size: "large" });
  state = { ...state, staff: { ...state.staff, ops: { junior: 0, mid: 3, senior: 0 } } };
  return s.advance(state, 6).state;
}
const appServer = (state: GameState) => state.servers.find((x) => x.type === "app")!;

describe("tiers", () => {
  it("open tier 1 from the start and keep the rest locked, each with its condition", () => {
    const state = begin();
    const view = sim.tiers(state);
    expect(view.map((t) => [t.tier, t.available, t.day])).toEqual([
      [1, true, 1],
      [2, false, null],
      [3, false, null],
      [4, false, null],
    ]);
    expect(tier(state, 2).conditions).toEqual([{ label: "Users", value: 0, target: 5_000, unit: "users", met: false }]);
    expect(tier(state, 3).conditions.map((c) => c.label)).toEqual(["Income a day, last 30 days", "Uptime, last 30 days"]);
    expect(tier(state, 4)).toMatchObject({ any: true });
    expect(tier(state, 4).conditions.map((c) => c.label)).toEqual(["An angel investor's money taken", "Every IPO condition met"]);
  });

  it("hold each product's features one a tier, cheapest first, and every model's benefits", () => {
    const state = begin();
    const items = (n: TierNumber) => tier(state, n).items.map((i) => `${i.kind}:${i.id}`);
    expect(items(1)).toEqual(["feature:wishlists"]);
    expect(items(2)).toEqual(["feature:reviews", "benefit:hardwareEfficiency1", "benefit:reservedInstances", "benefit:managedMonitoring"]);
    expect(items(3)).toEqual(["feature:checkout", "benefit:iaasAutoscaling", "benefit:paasAutoscaling", "benefit:premiumSupport"]);
    expect(items(4)).toEqual(["feature:recommendations", "benefit:hardwareEfficiency2", "benefit:cdn"]);
    // Every item has a stable id, unique across features and benefits, for research to price later.
    for (const product of Object.values(defaultConfig.productTypes)) {
      const ids = [...product.features.map((f) => f.id), ...tierConfig.benefits.map((b) => b.id)];
      expect(new Set(ids).size).toBe(ids.length);
      const devDays = [...product.features].sort((a, b) => (a.tier ?? 1) - (b.tier ?? 1)).map((f) => f.devDays);
      expect(devDays).toEqual([...devDays].sort((a, b) => a - b));
    }
  });

  it("refuse a feature or add-on from a locked tier, and allow tier 1's", () => {
    const state = begin();
    expect(sim.features(state).map((f) => [f.id, f.tier, f.unlocked])).toEqual([
      ["checkout", 3, false],
      ["reviews", 2, false],
      ["recommendations", 4, false],
      ["wishlists", 1, true],
    ]);
    expect(refusal(() => act(state, { type: "buildFeature", feature: "reviews" }))).toBe("locked");
    expect(() => act(state, { type: "buildFeature", feature: "reviews" })).toThrow(/tier 2.*5,000 users/);
    expect(act(state, { type: "buildFeature", feature: "wishlists" }).features.wishlists?.status).toBe("building");
    const saas = begin("saas");
    expect(refusal(() => act(saas, { type: "buyAddon", feature: "checkout" }))).toBe("locked");
    expect(act(saas, { type: "buyAddon", feature: "wishlists" }).features.wishlists?.status).toBe("addon");
  });

  it("open tier 2 at 5,000 users, for good, with a log line and a pause", () => {
    const state = { ...sim.advance(begin("saas"), 3).state, users: 5_000, paidUsers: 1_000 };
    expect(tier(state, 2).conditions[0]).toMatchObject({ value: 5_000, met: true });
    const turn = sim.tick(state);
    expect(tier(turn.state, 2)).toMatchObject({ available: true, day: 5 });
    expect(turn.state.tiers).toEqual([{ tier: 2, day: 5 }]);
    expect(texts(turn.log)).toContain("Tier 2 unlocked: Product reviews can now be had.");
    expect(turn.pauses).toContainEqual({ kind: "finished", id: "tier-2", text: "Tier 2 unlocked" });
    expect(sim.features(turn.state).find((f) => f.id === "reviews")!.unlocked).toBe(true);
    // Losing the users doesn't close it again.
    const fewer = sim.advance({ ...turn.state, users: 100, paidUsers: 10 }).state;
    expect(tier(fewer, 2).available).toBe(true);
  });

  it("open tier 3 on income and uptime over the last 30 days, and only once tier 2 is open", () => {
    const base = sim.advance(begin("saas"), 3).state;
    // £2,500 a day for 30 days at 100% uptime, but too few users for tier 2: tier 3 waits.
    const rich = withHistory(base, 30, 2_500);
    expect(tier(rich, 3).conditions.every((c) => c.met)).toBe(true);
    expect(tier(sim.advance(rich).state, 3).available).toBe(false);
    // With the users too, both open on the same day.
    const both = sim.advance({ ...rich, users: 6_000, paidUsers: 1_000 });
    expect(both.state.tiers.map((t) => t.tier)).toEqual([2, 3]);
    expect(texts(both.log)).toContain("Tier 3 unlocked: One-click checkout, Premium support plan can now be had.");
    // Too little income, or more than 1% of the hours down, and tier 3 stays shut.
    const poor = withHistory({ ...base, users: 6_000 }, 30, 1_500);
    expect(sim.advance(poor).state.tiers.map((t) => t.tier)).toEqual([2]);
    const flaky = withHistory({ ...base, users: 6_000 }, 30, 2_500, 1);
    expect(tier(flaky, 3).conditions[1]).toMatchObject({ value: 95.83, met: false });
    expect(sim.advance(flaky).state.tiers.map((t) => t.tier)).toEqual([2]);
  });

  it("open tier 4 once an angel investor's money is taken, after tiers 2 and 3", () => {
    const sensible = STRATEGIES.find((s) => s.id === "sensible")!;
    let state = begin("saas", "social");
    for (let i = 0; i < 200 && !sim.investors(state).offer; i++) state = sim.tick(playDay(sim, state, sensible)).state;
    state = act(state, { type: "acceptInvestor" });
    expect(tier(state, 4).conditions[0]).toMatchObject({ met: true });
    const ready = withHistory({ ...state, users: 6_000 }, 30, 3_000);
    expect(sim.advance(ready).state.tiers.map((t) => t.tier)).toEqual([2, 3, 4]);
  });

  it("are kept through a migration, with the product features built", () => {
    let state = opened(iaasSetup(begin()), 2);
    state = { ...state, features: { wishlists: { status: "built", progress: 10 } } };
    state = act(state, { type: "startMigration", model: "paas" });
    while (state.migration) state = sim.advance(state).state;
    expect(state.model).toBe("paas");
    expect(tier(state, 2).available).toBe(true);
    expect(state.features.wishlists?.status).toBe("built");
  });
});

describe("model benefits", () => {
  it("are listed for every model, unlocked with their tier", () => {
    const state = begin();
    expect(sim.benefits(state).find((b) => b.id === "reservedInstances")).toEqual({
      id: "reservedInstances",
      name: "Reserved instances",
      blurb: benefit("reservedInstances").blurb,
      model: "iaas",
      tier: 2,
      setupFee: 2_000,
      monthlyFee: 0,
      unlocked: false,
      onModel: true,
      active: false,
    });
    expect(sim.benefits(opened(state, 2)).find((b) => b.id === "reservedInstances")!.unlocked).toBe(true);
    expect(sim.benefits(state).find((b) => b.id === "cdn")).toMatchObject({ onModel: false, unlocked: false });
  });

  it("are refused before their tier, off their model, already on, or without the cash", () => {
    const state = begin();
    expect(refusal(() => act(state, { type: "buyBenefit", benefit: "reservedInstances" }))).toBe("locked");
    expect(refusal(() => act(opened(state, 4), { type: "buyBenefit", benefit: "cdn" }))).toBe("wrong_model");
    expect(refusal(() => act(state, { type: "buyBenefit", benefit: "teleport" }))).toBe("unknown_benefit");
    const on = act(opened(state, 2), { type: "buyBenefit", benefit: "reservedInstances" });
    expect(refusal(() => act(on, { type: "buyBenefit", benefit: "reservedInstances" }))).toBe("benefit_active");
    expect(refusal(() => act({ ...opened(state, 2), cash: 100 }, { type: "buyBenefit", benefit: "reservedInstances" }))).toBe(
      "cant_afford",
    );
    expect(refusal(() => act(state, { type: "cancelBenefit", benefit: "reservedInstances" }))).toBe("benefit_not_active");
  });

  it("charge the set-up fee at once and the monthly fee each day, until cancelled", () => {
    const state = opened(sim.advance(begin("paas"), 3).state, 2);
    const on = act(state, { type: "buyBenefit", benefit: "managedMonitoring" });
    expect(on.cash).toBe(state.cash - 500);
    expect(on.benefits).toEqual(["managedMonitoring"]);
    expect(sim.monthlyBenefitCost(on)).toBe(300);
    expect(sim.runway(on).dailyCosts).toBe(sim.runway(state).dailyCosts + 10);
    const day = sim.advance(on);
    expect(day.log[0]!.entries).toContainEqual({ text: "Model benefit: Managed monitoring (£300 a month)", cashDelta: -10, category: "infrastructure" });
    const off = act(day.state, { type: "cancelBenefit", benefit: "managedMonitoring" });
    expect(off.benefits).toEqual([]);
    expect(texts(sim.advance(off).log).some((t) => t.startsWith("Model benefit:"))).toBe(false);
  });

  it("are lost on a migration with no refund, while the tiers stay unlocked for the new model's", () => {
    let state = act(opened(iaasSetup(begin()), 2), { type: "buyBenefit", benefit: "reservedInstances" });
    expect(sim.migrationQuote(state, "paas").lostBenefits).toEqual([{ id: "reservedInstances", name: "Reserved instances" }]);
    expect(sim.migrationQuote(begin(), "paas").lostBenefits).toEqual([]);
    state = act(state, { type: "startMigration", model: "paas" });
    // Still on IaaS mid-move, so still on.
    expect(sim.advance(state).state.benefits).toEqual(["reservedInstances"]);
    const log: DayLog[] = [];
    while (state.migration) {
      const day = sim.advance(state);
      state = day.state;
      log.push(...day.log);
    }
    expect(state.benefits).toEqual([]);
    expect(texts(log)).toContain(
      "Model benefits lost: Reserved instances stayed with Rent VMs (IaaS), with no refund. Your tiers are still unlocked, so this model's own benefits can be bought on Infrastructure straight away.",
    );
    expect(act(state, { type: "buyBenefit", benefit: "managedMonitoring" }).benefits).toEqual(["managedMonitoring"]);
  });

  it("reserved instances take 30% off IaaS rent", () => {
    const state = opened(iaasSetup(begin()), 2);
    const on = act(state, { type: "buyBenefit", benefit: "reservedInstances" });
    expect(sim.servers(on).map((x) => x.monthlyCost)).toEqual(sim.servers(state).map((x) => x.monthlyCost * 0.7));
    expect(sim.monthlyInfrastructureCost(on)).toBeLessThan(sim.monthlyInfrastructureCost(state));
  });

  it("hardware efficiency takes 20% off on-prem power and upkeep, and II another 20% and half the slider's risk", () => {
    const state = opened(onpremRunning(), 4);
    const one = act(state, { type: "buyBenefit", benefit: "hardwareEfficiency1" });
    const both = act(one, { type: "buyBenefit", benefit: "hardwareEfficiency2" });
    const upkeep = (s: GameState) => sim.servers(s).find((x) => x.type === "app")!.monthlyCost;
    expect(upkeep(one)).toBeCloseTo(upkeep(state) * 0.8, 6);
    expect(upkeep(both)).toBeCloseTo(upkeep(state) * 0.6, 6);
    const power = (s: GameState) => sim.advance(s).log[0]!.entries.find((e) => e.category === "power")!;
    expect(power(state)).toMatchObject({ text: "Own servers (on-prem) power and cooling (£25 a day)", cashDelta: -25 });
    expect(power(one)).toMatchObject({ text: "Own servers (on-prem) power and cooling (£20 a day)", cashDelta: -20 });
    const pushed = (s: GameState) => act(s, { type: "setPerformance", id: appServer(s).id, performance: 1.5 });
    const risk = (s: GameState) => sim.servers(s).find((x) => x.type === "app")!.risk!;
    expect(risk(pushed(both)).crash).toBeCloseTo(risk(pushed(one)).crash / 2, 9);
    expect(risk(pushed(both)).overheat).toBeCloseTo(risk(pushed(one)).overheat / 2, 9);
  });

  it("IaaS autoscaling covers a spike over capacity with extra VMs, paid by the unit, up to half as much again", () => {
    const state = opened(sim.advance(iaasSetup(begin()), 2).state, 3);
    const units = sim.units(state)!;
    // About 30% over compute capacity (the database is far bigger).
    const users = Math.round((units.cu.capacity * 1.3) / defaultConfig.productTypes.ecommerce.demand.cuPerUser);
    const busy = { ...state, users, paidUsers: Math.round(users / 5) };
    const without = sim.advance(busy);
    expect(without.state.downtimeHours).toBeGreaterThan(busy.downtimeHours);
    const scaled = sim.advance(act(busy, { type: "buyBenefit", benefit: "iaasAutoscaling" }));
    expect(scaled.state.downtimeHours).toBe(busy.downtimeHours);
    expect(texts(scaled.log).some((t) => /^Autoscaling: extra VMs for [\d,]+ CU over capacity$/.test(t))).toBe(true);
    // Twice capacity is more than it can cover: still an outage.
    const swamped = { ...busy, users: users * 2 };
    const over = sim.advance(act(swamped, { type: "buyBenefit", benefit: "iaasAutoscaling" }));
    expect(over.state.downtimeHours).toBeGreaterThan(busy.downtimeHours);
    expect(texts(over.log).some((t) => t.includes("even with autoscaling"))).toBe(true);
  });

  /** A PaaS company with one instance and a big database, launched, then given `users`. */
  const paasWith = (users: number) => {
    const state = opened(
      sim.advance(act(begin("paas"), { type: "setInstances", count: 1 }, { type: "setManagedService", service: "database", size: "massive" }), 3)
        .state,
      4,
    );
    return { ...state, users, paidUsers: Math.round(users / 5) };
  };

  it("managed monitoring halves PaaS outages", () => {
    const busy = paasWith(Math.round((sim.managed(paasWith(0))!.instanceUnits * 1.5) / defaultConfig.productTypes.ecommerce.demand.cuPerUser));
    const hours = sim.advance(busy).state.downtimeHours - busy.downtimeHours;
    expect(hours).toBeGreaterThan(1);
    const watched = act(busy, { type: "buyBenefit", benefit: "managedMonitoring" });
    expect(sim.advance(watched).state.downtimeHours - busy.downtimeHours).toBe(Math.ceil(hours / 2));
  });

  it("managed autoscaling sets tomorrow's PaaS instances to the day's demand plus a quarter", () => {
    const { instanceUnits } = sim.managed(paasWith(0))!;
    const busy = paasWith(Math.round((instanceUnits * 3) / defaultConfig.productTypes.ecommerce.demand.cuPerUser));
    const day = sim.advance(act(busy, { type: "buyBenefit", benefit: "paasAutoscaling" }));
    const wanted = Math.ceil((day.state.demand.cu * 1.25) / instanceUnits);
    expect(sim.managed(day.state)!.instances).toBe(wanted);
    expect(texts(day.log)).toContain(`Managed autoscaling: 1 → ${wanted} app instances for tomorrow.`);
    // Without it, the count stays where the student set it.
    expect(sim.managed(sim.advance(busy).state)!.instances).toBe(1);
  });

  it("a CDN takes a quarter off PaaS CU demand", () => {
    const busy = paasWith(2_000);
    const plain = sim.advance(busy).state.demand;
    const cdn = sim.advance(act(busy, { type: "buyBenefit", benefit: "cdn" })).state.demand;
    expect(cdn.cu / plain.cu).toBeCloseTo(0.75, 2);
    expect(cdn.dbu).toBe(plain.dbu);
  });

  it("a premium support plan halves the SaaS provider's outages", () => {
    const outage = defaultConfig.events.find((e) => e.id === "providerOutage")!;
    const s = createSim({ ...quiet, events: [{ ...outage, encounter: undefined, schedule: { type: "fixed", days: [5] } }] });
    const state = opened(s.advance(begin("saas", "ecommerce", s), 2).state, 3);
    const down = (st: GameState) => s.advance(st, 3).state.downtimeHours - st.downtimeHours;
    expect(down(state)).toBe(6);
    expect(down(s.applyAction(state, { type: "buyBenefit", benefit: "premiumSupport" }))).toBe(3);
  });
});

describe("the hardware slider", () => {
  const running = onpremRunning();
  const set = (state: GameState, performance: number, id = appServer(state).id) =>
    act(state, { type: "setPerformance", id, performance });
  const app = (state: GameState) => sim.servers(state).find((x) => x.type === "app")!;

  it("is on-prem only, from 0% to 150%, on the company's own servers", () => {
    expect(refusal(() => set(iaasSetup(begin()), 1.2, 1))).toBe("no_slider");
    expect(refusal(() => set(running, 1.6))).toBe("bad_performance");
    expect(refusal(() => set(running, -0.1))).toBe("bad_performance");
    expect(refusal(() => set(running, 1.2, 999))).toBe("unknown_server");
    expect(app(running)).toMatchObject({ performance: 1, wear: expect.any(Number), risk: { overheat: 0, crash: 0 } });
    expect(app(set(running, 1.25)).performance).toBe(1.25);
    expect(app(iaasSetup(begin()))).toMatchObject({ performance: null, wear: null, risk: null });
  });

  it("scales the server's capacity and its power and upkeep", () => {
    const cu = (s: GameState) => sim.units(s)!.cu.capacity;
    expect(cu(set(running, 1.5))).toBeCloseTo(cu(running) * 1.5, 1);
    expect(cu(set(running, 0.5))).toBeCloseTo(cu(running) * 0.5, 1);
    expect(app(set(running, 0.5)).monthlyCost).toBeCloseTo(app(running).monthlyCost * 0.5, 6);
    expect(app(set(running, 1.5)).monthlyCost).toBeCloseTo(app(running).monthlyCost * 1.5, 6);
    expect(texts(sim.advance(set(running, 1.5)).log).some((t) => t.startsWith("App server (large at 150%) power and upkeep"))).toBe(true);
  });

  it("carries no risk at 100% or below, and a risk that climbs with the square above it", () => {
    const risk = (p: number) => app(set(running, p)).risk!;
    expect(risk(0.5)).toEqual({ overheat: 0, crash: 0 });
    expect(risk(1)).toEqual({ overheat: 0, crash: 0 });
    expect(risk(1.1).overheat).toBeCloseTo(hardware.overheat.chance * 0.04, 9);
    expect(risk(1.25).overheat).toBeCloseTo(hardware.overheat.chance * 0.25, 9);
    expect(risk(1.25).crash).toBeCloseTo(hardware.crash.chance * 0.25, 9);
    expect(risk(1.5)).toEqual({ overheat: hardware.overheat.chance, crash: hardware.crash.chance });
  });

  it("wears a server by the slider squared each day, slower below 100% and faster above", () => {
    const wearAfter = (p: number) => app(sim.advance(set({ ...running, servers: running.servers.map((x) => ({ ...x, wear: 0 })) }, p), 10).state).wear!;
    expect(wearAfter(1)).toBeCloseTo(10 / hardware.lifespan, 3);
    expect(wearAfter(0.5)).toBeCloseTo((10 * 0.25) / hardware.lifespan, 3);
    // Pushed hard, it may also crash or overheat on the way, but it wears all the same.
    expect(wearAfter(1.5)).toBeCloseTo((10 * 2.25) / hardware.lifespan, 3);
  });

  it("gives a worn-out server a chance of crashing even at 100%", () => {
    const worn = { ...running, servers: running.servers.map((x) => ({ ...x, wear: hardware.lifespan * 1.5 })) };
    expect(app(worn).risk).toEqual({ overheat: 0, crash: hardware.wornCrashChance * 0.5 });
  });

  it("crashes a server for days with no capacity, or overheats it with less, when the roll comes up", () => {
    const crashes = createSim({ ...quiet, hardware: { ...hardware, crash: { chance: 1, days: 2 } } });
    const crashing = onpremRunning(crashes);
    const id = appServer(crashing).id;
    const pushed = crashes.applyAction(crashing, { type: "setPerformance", id, performance: 1.5 });
    const day = crashes.advance(pushed);
    expect(texts(day.log)).toContain(`Crash: server #${id} (large app server), running at 150%, is down for 2 days while ops fix it.`);
    expect(crashes.servers(day.state).find((x) => x.id === id)!.crashedDays).toBe(2);
    expect(crashes.units(day.state)!.cu.capacity).toBe(0);

    const heats = createSim({ ...quiet, hardware: { ...hardware, crash: { chance: 0, days: 2 }, overheat: { chance: 1, days: 3, capacity: 0.5 } } });
    const heating = onpremRunning(heats);
    const before = heats.units(heats.applyAction(heating, { type: "setPerformance", id, performance: 1.5 }))!.cu.capacity;
    const hot = heats.advance(heats.applyAction(heating, { type: "setPerformance", id, performance: 1.5 }));
    expect(texts(hot.log)).toContain(`Overheating: server #${id} (large app server) at 150% gives 50% of its capacity for 3 days.`);
    expect(heats.servers(hot.state).find((x) => x.id === id)!.overheatedDays).toBe(3);
    expect(heats.units(hot.state)!.cu.capacity).toBeCloseTo(before / 2, 1);
  });

  it("left at 150% for weeks, crashes and overheats; at 100%, never", () => {
    const incidents = (p: number) =>
      texts(sim.advance(set(running, p), 60).log).filter((t) => t.startsWith("Crash:") || t.startsWith("Overheating:")).length;
    expect(incidents(1)).toBe(0);
    expect(incidents(1.5)).toBeGreaterThan(3);
  });
});

describe("config", () => {
  it("puts every tier condition, benefit number and hardware number on the config page", () => {
    const paths = new Set(configFields().map((f) => f.path));
    for (const p of [
      "tiers.tier2.users",
      "tiers.tier3.dailyIncome",
      "tiers.tier3.uptime",
      "tiers.tier3.days",
      "tiers.benefits.cdn.tier",
      "tiers.benefits.cdn.monthlyFee",
      "tiers.benefits.cdn.effects.cuDemand",
      "tiers.benefits.iaasAutoscaling.effects.autoscaling.most",
      "tiers.benefits.premiumSupport.effects.eventHours.multiplier",
      "productTypes.ecommerce.features.checkout.tier",
      "hardware.maxPerformance",
      "hardware.crash.chance",
      "hardware.lifespan",
    ]) {
      expect(paths).toContain(p);
    }
  });
});
