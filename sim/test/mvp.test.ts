import { describe, expect, it } from "vitest";
import {
  createSim,
  defaultConfig,
  MODEL_IDS,
  SimError,
  type Action,
  type DayLog,
  type GameConfig,
  type GameState,
  type ModelId,
  type ProductTypeId,
  type Sim,
} from "../src/index.ts";

// The MVP every game opens with (#176), through the sim's public interface: no users until it's done, the launch ramp
// after it, its size by model and product, more developers finishing it sooner, and hosting bills from go-live.

/** The default config with no random or scripted events, so a launch's numbers come out exactly. */
const quiet: GameConfig = { ...defaultConfig, events: [] };
const sim = createSim(quiet);

const begin = (model: ModelId = "saas", productType: ProductTypeId = "ecommerce", s: Sim = sim) =>
  s.newGame({ companyName: "MVP Co", productType, model, seed: 7, takeLoan: model === "onprem" });

const act = (state: GameState, ...actions: Action[]) => actions.reduce((st, a) => sim.applyAction(st, a), state);

/** Plays a day at a time until `last` has been played. */
const playTo = (state: GameState, last: number, s: Sim = sim) => {
  let st = state;
  while (st.day < last) st = s.advance(st).state;
  return st;
};

/** Days in a log that charged anything in a spending category. */
const chargedDays = (log: DayLog[], category: string) =>
  log.filter((d) => d.entries.some((e) => e.category === category && e.cashDelta < 0)).map((d) => d.day);

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return null;
};

const { baseDevDays, modelShare } = defaultConfig.mvp;
/** The starting developers' output a day: two mids, a developer-day each. */
const STARTING_OUTPUT = 2;

describe("the MVP", () => {
  it("opens every game with an MVP of the product's base developer-days × the model's share, and no users", () => {
    for (const model of MODEL_IDS) {
      const state = begin(model);
      expect(sim.mvp(state), model).toMatchObject({
        progress: 0,
        total: Math.round(baseDevDays.ecommerce * modelShare[model] * 100) / 100,
        done: false,
        doneDay: null,
        output: STARTING_OUTPUT,
      });
      expect(state, model).toMatchObject({ users: 0, paidUsers: 0, launchDay: null });
    }
  });

  it("is longest on-prem and shortest on SaaS, and differs by product", () => {
    const totals = MODEL_IDS.map((m) => sim.mvp(begin(m)).total);
    expect(MODEL_IDS).toEqual(["onprem", "iaas", "paas", "saas"]);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    expect(new Set(totals).size).toBe(MODEL_IDS.length);
    expect(modelShare).toEqual({ onprem: 1, iaas: 0.85, paas: 0.65, saas: 0.4 });
    // A social network takes longer than a shop.
    expect(sim.mvp(begin("onprem", "social")).total).toBeGreaterThan(sim.mvp(begin("onprem", "ecommerce")).total);
  });

  it("takes the starting two developers about 8–11 days on-prem, inside the design's 10–15 day most", () => {
    for (const productType of Object.keys(baseDevDays) as ProductTypeId[]) {
      const days = sim.mvp(begin("onprem", productType)).daysLeft!;
      expect(days, productType).toBeGreaterThanOrEqual(8);
      expect(days, productType).toBeLessThanOrEqual(11);
    }
  });

  it("has no users and no growth until it's done, while salaries are paid every day", () => {
    // A shop on SaaS: 6.4 developer-days at 2 a day, so done on day 5, the fourth day played.
    const state = begin("saas");
    expect(sim.mvp(state)).toMatchObject({ total: 6.4, daysLeft: 4, launchDay: 5 });
    const { state: before, log } = sim.advance(state, 3);
    expect(before).toMatchObject({ day: 4, users: 0, paidUsers: 0, launchDay: null, income: 0 });
    expect(log.every((d) => d.entries.every((e) => e.kind !== "income"))).toBe(true);
    expect(sim.mvp(before)).toMatchObject({ progress: 6, done: false, daysLeft: 1, launchDay: 5 });
    expect(sim.launch(before)).toMatchObject({ status: "upcoming", day: 5, daysLeft: 1 });
    expect(chargedDays(log, "staff")).toEqual([2, 3, 4]);
    expect(log[0]!.entries.map((e) => e.text)).toContain("Building the MVP: 2 of 6.4 developer-days done.");
    expect(before.cash).toBeLessThan(state.cash);
  });

  it("starts the launch ramp the day it's done: 20%, 30% then 50% of the launch users", () => {
    const state = playTo(begin("saas"), 4);
    const { state: launched, log } = sim.advance(state);
    expect(sim.mvp(launched)).toMatchObject({ progress: 6.4, done: true, doneDay: 5, daysLeft: 0, launchDay: 5 });
    const total = state.launchUsers;
    const arrived = (k: number) => Math.round(total * [0.2, 0.5, 1][k - 1]!);
    expect(launched).toMatchObject({ launchDay: 5, users: arrived(1) });
    expect(log[0]!.entries.map((e) => e.text)).toContain(
      "MVP done: your first users arrive once you have somewhere to serve them. Developers can build features now.",
    );
    expect(sim.launch(launched)).toMatchObject({ status: "launching", day: 5, rampDay: 1 });
    expect(playTo(launched, 6).users).toBe(arrived(2));
    const over = playTo(launched, 7);
    expect(over.users).toBe(arrived(3));
    expect(sim.launch(over)).toMatchObject({ status: "launched", rampDay: 3 });
  });

  it("finishes sooner with more developers, agency developers counting at their usual output", () => {
    const alone = playTo(begin("onprem"), 30);
    // Four agency mids start tomorrow, each doing half a mid's work: 4 developer-days a day from day 2.
    const rushed = playTo(act(begin("onprem"), { type: "hire", pool: "developers", grade: "mid", count: 4, agency: true }), 30);
    expect(alone.mvp.doneDay).toBe(9);
    expect(rushed.mvp.doneDay).toBe(5);
    // Today's developers set the estimate; ones still to start don't count until they do.
    const hired = act(begin("onprem"), { type: "hire", pool: "developers", grade: "mid", count: 4, agency: true });
    expect(sim.mvp(hired).launchDay).toBe(9);
    expect(sim.mvp(sim.advance(hired).state)).toMatchObject({ output: 4, launchDay: 5 });
  });

  it("can't be finished with no developers, and says so", () => {
    const none = act(begin("saas"), { type: "letGo", pool: "developers", grade: "mid", count: 2 });
    expect(sim.mvp(none)).toMatchObject({ output: 0, daysLeft: null, launchDay: null });
    expect(sim.launch(none)).toMatchObject({ status: "waiting", day: null });
    const { state, log } = sim.advance(none, 10);
    expect(state).toMatchObject({ users: 0, launchDay: null, mvp: { progress: 0, doneDay: null } });
    expect(log[0]!.entries.map((e) => e.text)).toContain("MVP: no developers, so no progress today.");
  });

  it("is the developers' only job until it's done: features wait, and they're never idle", () => {
    const state = begin("iaas");
    // A tier 1 feature, open from the start, so only the MVP holds it up.
    const feature = defaultConfig.productTypes.ecommerce.features.find((f) => (f.tier ?? 1) === 1)!.id;
    expect(refusal(() => act(state, { type: "buildFeature", feature }))).toBe("mvp_first");
    expect(sim.staff(state).find((p) => p.pool === "developers")!.idle).toBeNull();
    const done = playTo(state, 8);
    expect(done.mvp.doneDay).toBe(8);
    expect(sim.staff(done).find((p) => p.pool === "developers")!.idle).toMatch(/nothing to do/);
    expect(act(done, { type: "buildFeature", feature }).features[feature]).toEqual({ status: "building", progress: 0 });
  });

  it("stops time when it's done", () => {
    let turn = sim.tick(begin("saas"));
    while (turn.state.mvp.doneDay === null) turn = sim.tick(turn.state);
    expect(turn.state.day).toBe(5);
    expect(turn.pauses).toContainEqual({ kind: "finished", id: "mvp", text: "Your MVP is done" });
  });

  it("starts hosting bills at go-live, not when servers are rented", () => {
    // VMs rented on day 1 are ready by day 2, but the MVP isn't done until day 8 (13.6 developer-days at 2 a day).
    const rented = act(
      begin("iaas"),
      { type: "rentServer", server: "app", size: "medium" },
      { type: "rentServer", server: "database", size: "medium" },
    );
    expect(sim.launch(rented)).toMatchObject({ status: "upcoming", day: 8, daysLeft: 7 });
    const { state, log } = sim.advance(rented, 9);
    expect(state.launchDay).toBe(8);
    expect(chargedDays(log, "infrastructure")).toEqual([8, 9, 10]);
    expect(chargedDays(log, "power")).toEqual([8, 9, 10]);
    expect(log.find((d) => d.day === 8)!.entries.map((e) => e.text)).toEqual(
      expect.arrayContaining(["Rent VMs (IaaS) running costs (£700 a month)", "App server (medium) rent: 1 × £450 a month"]),
    );
    // Nor does the runway count them before then: only the staff are costing money.
    const waiting = playTo(rented, 5);
    expect(sim.runway(waiting).dailyCosts).toBe(sim.dailyStaffCost(waiting));
    expect(sim.runway(playTo(rented, 8)).dailyCosts).toBeGreaterThan(sim.dailyStaffCost(waiting));
  });

  it("lets on-prem kit be ordered and arrive during the MVP, so delivery overlaps the build", () => {
    // Kit bought on day 1 arrives on day 5; the MVP (16 developer-days) is done on day 9.
    const ordered = act(
      begin("onprem"),
      { type: "buyServer", server: "app", size: "large" },
      { type: "buyServer", server: "database", size: "large" },
    );
    expect(sim.launch(ordered)).toMatchObject({ status: "upcoming", day: 9 });
    const arrived = playTo(ordered, 5);
    expect(sim.servers(arrived).every((s) => s.status === "ready")).toBe(true);
    expect(arrived).toMatchObject({ users: 0, launchDay: null });
    const { state, log } = sim.advance(arrived, 4);
    expect(state.launchDay).toBe(9);
    expect(state.users).toBeGreaterThan(0);
    // Its power and upkeep, like every hosting bill, start at go-live.
    expect(chargedDays(log, "infrastructure")).toEqual([9]);
  });

  it("can be configured away: an MVP of no size launches SaaS as the game starts, as before", () => {
    const none = createSim({
      ...quiet,
      mvp: { ...quiet.mvp, baseDevDays: { ...quiet.mvp.baseDevDays, ecommerce: 0 } },
    });
    const state = begin("saas", "ecommerce", none);
    expect(none.mvp(state)).toMatchObject({ total: 0, done: true, doneDay: 1 });
    expect(state.launchDay).toBe(1);
    expect(state.users).toBe(Math.round(state.launchUsers * 0.2));
  });
});
