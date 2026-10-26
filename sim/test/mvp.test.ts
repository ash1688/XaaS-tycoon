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

// The MVP every game opens with (#176), through the sim's public interface: no users until it's done and Launch is
// pressed (#235), the launch ramp after it, its size by model and product, more developers finishing it sooner, and
// hosting bills from go-live.

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
    expect(sim.launch(before)).toMatchObject({ status: "upcoming", day: null });
    expect(chargedDays(log, "staff")).toEqual([2, 3, 4]);
    expect(log[0]!.entries.map((e) => e.text)).toContain("Building the MVP: 2 of 6.4 developer-days done.");
    expect(before.cash).toBeLessThan(state.cash);
  });

  it("waits, ready to launch, once it's done: no users arrive until Launch is pressed", () => {
    const state = playTo(begin("saas"), 4);
    const { state: done, log } = sim.advance(state);
    expect(sim.mvp(done)).toMatchObject({ progress: 6.4, done: true, doneDay: 5, daysLeft: 0, launchDay: 5 });
    expect(log[0]!.entries.map((e) => e.text)).toContain(
      "MVP done: press Launch when you're set up, and your first users start arriving. Developers can build features now.",
    );
    expect(sim.launch(done)).toMatchObject({ status: "ready", day: null, rampDay: 0, missing: [] });
    const waited = playTo(done, 12);
    expect(waited).toMatchObject({ users: 0, paidUsers: 0, launchDay: null });
    expect(sim.launch(waited).status).toBe("ready");
  });

  it("starts the launch ramp on go-live, the day after Launch is pressed: 20%, 30% then 50% of the launch users", () => {
    const done = playTo(begin("saas"), 8);
    const pressed = act(done, { type: "launch" });
    expect(pressed).toMatchObject({ launchDay: 9, users: 0 });
    expect(sim.launch(pressed)).toMatchObject({ status: "launching", day: 9, rampDay: 0, arrived: 0, missing: [] });
    const total = done.launchUsers;
    const arrived = (k: number) => Math.round(total * [0.2, 0.5, 1][k - 1]!);
    const { state: launched, log } = sim.advance(pressed);
    expect(launched).toMatchObject({ day: 9, launchDay: 9, users: arrived(1) });
    expect(log[0]!.entries.map((e) => e.text).find((t) => t.startsWith("Launch, day 1 of 3"))).toMatch(
      /^Launch, day 1 of 3: [\d,]+ new users arrived, [\d,]+ of them paying\.$/,
    );
    expect(sim.launch(launched)).toMatchObject({ status: "launching", day: 9, rampDay: 1 });
    expect(playTo(launched, 10).users).toBe(arrived(2));
    const over = playTo(launched, 11);
    expect(over.users).toBe(arrived(3));
    expect(sim.launch(over)).toMatchObject({ status: "launched", rampDay: 3 });
  });

  it("can only be launched once it's done, and only once", () => {
    expect(refusal(() => act(begin("saas"), { type: "launch" }))).toBe("mvp_first");
    const launched = act(playTo(begin("saas"), 5), { type: "launch" });
    expect(refusal(() => act(launched, { type: "launch" }))).toBe("already_launched");
    expect(refusal(() => act(sim.advance(launched, 3).state, { type: "launch" }))).toBe("already_launched");
  });

  it("warns what launching short of servers or ops would miss, from the Infrastructure page's capacity, and lets it go ahead", () => {
    // IaaS starts with no servers: no app server, no database.
    const bare = playTo(begin("iaas"), 8);
    expect(sim.launch(bare)).toMatchObject({
      status: "ready",
      missing: ["No app server: no users can be served", "No database: no users can be served"],
    });
    // A database only: the app server is still missing, as the Infrastructure page's CU capacity shows.
    const dbOnly = playTo(act(begin("iaas"), { type: "rentServer", server: "database", size: "medium" }), 8);
    expect(sim.units(dbOnly)!.cu.capacity).toBe(0);
    expect(sim.launch(dbOnly).missing).toEqual(["No app server: no users can be served"]);
    // Both, but no ops for the servers' share: capacity is cut, as the page's ops cut says.
    const servers = act(
      begin("iaas"),
      { type: "rentServer", server: "app", size: "medium" },
      { type: "rentServer", server: "database", size: "medium" },
    );
    const ops = sim.staff(servers).find((p) => p.pool === "ops")!.grades.filter((g) => g.count > 0);
    const noOps = playTo(act(servers, ...ops.map((g): Action => ({ type: "letGo", pool: "ops", grade: g.grade, count: g.count }))), 8);
    const cut = Math.round(sim.units(noOps)!.opsCut * 100);
    expect(cut).toBeGreaterThan(0);
    expect(sim.launch(noOps).missing).toEqual([`No ops: your servers run at ${100 - cut}% of their capacity`]);
    // Set up in full, with an ops mid hired, nothing is missing.
    const full = playTo(act(servers, { type: "hire", pool: "ops", grade: "mid", count: 2, agency: true }), 8);
    expect(sim.launch(full).missing).toEqual([]);
    // Launching bare still goes ahead: users arrive, but none can be served.
    const short = act(bare, { type: "launch" });
    expect(sim.launch(short)).toMatchObject({ status: "launching", day: 9, missing: [] });
    const after = sim.advance(short).state;
    expect(after.launchDay).toBe(9);
    expect(after.users).toBeGreaterThan(0);
    expect(sim.units(after)!.usersSupported).toBe(0);
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
    expect(refusal(() => act(none, { type: "launch" }))).toBe("mvp_first");
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
    expect(turn.pauses).toContainEqual({ kind: "finished", id: "mvp", text: "Your MVP is ready: press Launch when you're set up" });
    // Waiting to launch doesn't stop it again.
    expect(sim.tick(turn.state).pauses.find((p) => p.id === "mvp")).toBeUndefined();
  });

  it("starts hosting bills at go-live, the day Launch is pressed for, not when servers are rented or the MVP is done", () => {
    // VMs rented on day 1 are ready by day 2, and the MVP is done on day 8 (13.6 developer-days at 2 a day). The
    // student waits until after day 11 to press Launch, so go-live is day 12.
    const rented = act(
      begin("iaas"),
      { type: "rentServer", server: "app", size: "medium" },
      { type: "rentServer", server: "database", size: "medium" },
    );
    expect(sim.launch(rented)).toMatchObject({ status: "upcoming", day: null });
    const { state: waited, log: before } = sim.advance(rented, 10);
    expect(waited).toMatchObject({ day: 11, launchDay: null, users: 0 });
    expect(chargedDays(before, "infrastructure")).toEqual([]);
    expect(chargedDays(before, "power")).toEqual([]);
    // Nor does the runway count them while waiting: only the staff are costing money.
    expect(sim.runway(waited).dailyCosts).toBe(sim.dailyStaffCost(waited));
    const pressed = act(waited, { type: "launch" });
    expect(sim.runway(pressed).dailyCosts).toBeGreaterThan(sim.dailyStaffCost(pressed));
    const { state, log } = sim.advance(pressed, 3);
    expect(state.launchDay).toBe(12);
    expect(chargedDays(log, "infrastructure")).toEqual([12, 13, 14]);
    expect(chargedDays(log, "power")).toEqual([12, 13, 14]);
    expect(log.find((d) => d.day === 12)!.entries.map((e) => e.text)).toEqual(
      expect.arrayContaining(["Rent VMs (IaaS) running costs (£700 a month)", "App server (medium) rent: 1 × £450 a month"]),
    );
    // Staff were paid every day, waiting or not.
    expect(chargedDays([...before, ...log], "staff")).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("lets on-prem kit be ordered and arrive during the MVP, so delivery overlaps the build", () => {
    // Kit bought on day 1 arrives on day 5; the MVP (16 developer-days) is done on day 9.
    const ordered = act(
      begin("onprem"),
      { type: "buyServer", server: "app", size: "large" },
      { type: "buyServer", server: "database", size: "large" },
    );
    expect(sim.launch(ordered)).toMatchObject({ status: "upcoming", day: null });
    const arrived = playTo(ordered, 5);
    expect(sim.servers(arrived).every((s) => s.status === "ready")).toBe(true);
    expect(arrived).toMatchObject({ users: 0, launchDay: null });
    const done = playTo(arrived, 9);
    expect(sim.launch(done).status).toBe("ready");
    const { state, log } = sim.advance(act(done, { type: "launch" }), 1);
    expect(state.launchDay).toBe(10);
    expect(state.users).toBeGreaterThan(0);
    // Its power and upkeep, like every hosting bill, start at go-live.
    expect(chargedDays(log, "infrastructure")).toEqual([10]);
  });

  it("can be configured away: an MVP of no size is ready to launch as the game starts", () => {
    const none = createSim({
      ...quiet,
      mvp: { ...quiet.mvp, baseDevDays: { ...quiet.mvp.baseDevDays, ecommerce: 0 } },
    });
    const state = begin("saas", "ecommerce", none);
    expect(none.mvp(state)).toMatchObject({ total: 0, done: true, doneDay: 1 });
    expect(state).toMatchObject({ launchDay: null, users: 0 });
    expect(none.launch(state).status).toBe("ready");
  });

  it("with launch.auto (tests and demos), launches by itself as the game starts, as before Launch was a button", () => {
    const auto = createSim({
      ...quiet,
      launch: { ...quiet.launch, auto: 1 },
      mvp: { ...quiet.mvp, baseDevDays: { ...quiet.mvp.baseDevDays, ecommerce: 0 } },
    });
    const state = begin("saas", "ecommerce", auto);
    expect(state.launchDay).toBe(1);
    expect(state.users).toBe(Math.round(state.launchUsers * 0.2));
  });
});
