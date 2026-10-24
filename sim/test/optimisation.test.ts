import { describe, expect, it } from "vitest";
import {
  createSim,
  defaultConfig,
  MODEL_IDS,
  SimError,
  type Action,
  type GameConfig,
  type GameState,
  type ModelId,
  type ProductTypeId,
} from "../src/index.ts";

// The developer slider and optimisation (#177), through the sim's public interface: after launch the slider splits
// developer output between features and optimisation, whose developer-days build up into a saving on resource need per
// user that flattens out under each model's cap, cuts CU and DBU, PaaS instances and the SaaS per-user fee, and is kept
// through a migration, capped at the new model's.

/** The default config with no random or scripted events, so days compare exactly. */
const quiet: GameConfig = { ...defaultConfig, events: [] };
/** As quiet, with no MVP to build: the company can launch and build features at once. */
const noMvp: GameConfig = {
  ...quiet,
  mvp: { ...quiet.mvp, baseDevDays: { ecommerce: 0, social: 0, video: 0, payments: 0, assistant: 0, games: 0 } },
};
const sim = createSim(noMvp);
const withMvp = createSim(quiet);

const { k, cap } = defaultConfig.optimisation;

const begin = (model: ModelId = "iaas", productType: ProductTypeId = "ecommerce", s = sim) =>
  s.newGame({ companyName: "Tuned Co", productType, model, seed: 7, takeLoan: model === "onprem" });

const act = (state: GameState, ...actions: Action[]) => actions.reduce((st, a) => sim.applyAction(st, a), state);

/** The same company with some optimisation developer-days already built up. */
const optimised = (state: GameState, days: number): GameState => ({ ...state, optimisationDays: days });

/** A SaaS company 20 days in: launched, with users. */
const runningSaas = () => sim.advance(begin("saas"), 20).state;

/** A company on a model with servers, launched with the users given and servers for them. */
function serving(model: ModelId, users: number, productType: ProductTypeId = "ecommerce"): GameState {
  let state = begin(model, productType);
  if (model === "iaas") state = act(state, { type: "rentServer", server: "app", size: "medium" }, { type: "rentServer", server: "database", size: "medium" });
  return { ...sim.advance(state, 3).state, users, paidUsers: users };
}

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return null;
};

describe("the developer slider", () => {
  it("starts at 0, with nothing optimised", () => {
    for (const model of MODEL_IDS) {
      expect(sim.optimisation(begin(model)), model).toEqual({ share: 0, days: 0, saving: 0, cap: cap[model], output: 0 });
    }
  });

  it("sends all developer output into the MVP before launch, whatever the slider", () => {
    const start = withMvp.applyAction(begin("onprem", "ecommerce", withMvp), { type: "setOptimisation", share: 1 });
    expect(withMvp.optimisation(start)).toMatchObject({ share: 1, output: 0 });
    const day = withMvp.advance(start).state;
    expect(day.optimisationDays).toBe(0);
    expect(withMvp.mvp(day).progress).toBe(2);
  });

  it("starts optimising the day after the MVP is done", () => {
    let state = withMvp.applyAction(begin("saas", "ecommerce", withMvp), { type: "setOptimisation", share: 0.5 });
    while (state.mvp.doneDay === null) state = withMvp.advance(state).state;
    expect(state.optimisationDays).toBe(0);
    expect(withMvp.optimisation(state).output).toBe(1);
    expect(withMvp.advance(state).state.optimisationDays).toBe(1);
  });

  it("splits developer output between the feature build and optimisation after launch", () => {
    const building = act(begin(), { type: "buildFeature", feature: "reviews" });
    const at = (share: number) => {
      const day = sim.advance(act(building, { type: "setOptimisation", share })).state;
      return { feature: day.features.reviews!.progress, optimisation: day.optimisationDays };
    };
    // The starting two developers: two developer-days a day.
    expect(at(0)).toEqual({ feature: 2, optimisation: 0 });
    expect(at(0.25)).toEqual({ feature: 1.5, optimisation: 0.5 });
    expect(at(1)).toEqual({ feature: 0, optimisation: 2 });
    // The days left on the build follow what the slider leaves it.
    const reviews = (s: GameState) => sim.features(s).find((f) => f.id === "reviews")!;
    const { devDays } = reviews(building);
    expect(reviews(building).daysLeft).toBe(Math.ceil(devDays / 2));
    expect(reviews(act(building, { type: "setOptimisation", share: 0.5 })).daysLeft).toBe(devDays);
  });

  it("works on every model, SaaS included, where developers don't build features", () => {
    for (const model of MODEL_IDS) {
      const state = act(begin(model), { type: "setOptimisation", share: 1 });
      expect(sim.advance(state, 5).state.optimisationDays, model).toBe(10);
    }
  });

  it("refuses a share outside 0–100%", () => {
    expect(refusal(() => act(begin(), { type: "setOptimisation", share: 1.5 }))).toBe("bad_optimisation");
    expect(refusal(() => act(begin(), { type: "setOptimisation", share: -0.1 }))).toBe("bad_optimisation");
  });

  it("doesn't count developers on optimisation as idle", () => {
    const idle = (state: GameState) => sim.staff(state).find((p) => p.pool === "developers")!.idle;
    expect(idle(begin())).toMatch(/Or move the slider/);
    expect(idle(act(begin(), { type: "setOptimisation", share: 1 }))).toBeNull();
    expect(idle(act(begin(), { type: "setOptimisation", share: 0.4 }))).toMatch(/the 60% of your developers' time not on optimisation/);
  });
});

describe("the optimisation saving", () => {
  it("is cap × (1 − e^(−days ÷ k)), set in config", () => {
    expect(defaultConfig.optimisation).toEqual({ k: 60, cap: { onprem: 0.5, iaas: 0.35, paas: 0.35, saas: 0.35 } });
    for (const model of MODEL_IDS) {
      for (const days of [0, 10, k, 200]) {
        expect(sim.optimisation(optimised(begin(model), days)).saving, `${model} ${days}`).toBeCloseTo(
          cap[model] * (1 - Math.exp(-days / k)),
          10,
        );
      }
    }
  });

  it("flattens out and never reaches the model's cap", () => {
    for (const model of MODEL_IDS) {
      const savings = [0, 30, 60, 90, 120, 150, 180, 1_000].map((d) => sim.optimisation(optimised(begin(model), d)).saving);
      const gains = savings.slice(1, 7).map((s, i) => s - savings[i]!);
      // Each 30 developer-days gains less than the last.
      for (let i = 1; i < gains.length; i++) expect(gains[i], model).toBeLessThan(gains[i - 1]!);
      for (const s of savings) expect(s, model).toBeLessThan(cap[model]);
    }
  });

  it("has a higher cap on-prem than on the other models", () => {
    for (const model of MODEL_IDS.filter((m) => m !== "onprem")) expect(cap.onprem).toBeGreaterThan(cap[model]);
    expect(sim.optimisation(optimised(begin("onprem"), 120)).saving).toBeGreaterThan(sim.optimisation(optimised(begin("iaas"), 120)).saving);
  });

  it("is permanent: moving the slider back to features keeps it", () => {
    const tuned = sim.advance(act(begin(), { type: "setOptimisation", share: 1 }), 10).state;
    const back = sim.advance(act(tuned, { type: "setOptimisation", share: 0 }), 10).state;
    expect(back.optimisationDays).toBe(20);
    expect(sim.optimisation(back).saving).toBe(sim.optimisation(tuned).saving);
  });
});

describe("what optimisation saves", () => {
  it("cuts CU and DBU per user on on-prem and IaaS, so the same servers serve more users", () => {
    for (const model of ["iaas", "onprem"] as const) {
      const state = model === "onprem" ? sim.advance(begin("onprem"), 1).state : serving("iaas", 1_000);
      const tuned = optimised(state, 120);
      const left = 1 - sim.optimisation(tuned).saving;
      // A day's demand from the same users.
      const day = sim.advance(state).state.demand;
      const tunedDay = sim.advance(tuned).state.demand;
      if (model === "iaas") {
        expect(tunedDay.cu / day.cu, model).toBeCloseTo(left, 2);
        expect(tunedDay.dbu / day.dbu, model).toBeCloseTo(left, 2);
        expect(sim.units(tuned)!.usersSupported / sim.units(state)!.usersSupported, model).toBeCloseTo(1 / left, 2);
      }
      // A migration onto the model sizes its setup to the lower demand.
      const from = model === "onprem" ? serving("iaas", 50_000) : { ...runningSaas(), users: 50_000, paidUsers: 50_000 };
      const sized = (s: GameState) => sim.migrationQuote({ ...s, cash: 10_000_000 }, model).sizedFor;
      expect(sized(optimised(from, 120)).cu / sized(from).cu, model).toBeCloseTo(1 - sim.optimisation(optimised(begin(model), 120)).saving, 2);
    }
  });

  it("cuts the app instances needed on PaaS", () => {
    const from = { ...runningSaas(), users: 30_000, paidUsers: 30_000, cash: 10_000_000 };
    const instances = (s: GameState) =>
      sim.migrationQuote(s, "paas").setup.filter((item) => item.type === "app").reduce((sum, item) => sum + item.count, 0);
    expect(instances(optimised(from, 1_000))).toBeLessThan(instances(from));
    // And the instances running serve more users each.
    const setUp = act(begin("paas"), { type: "setInstances", count: 2 }, { type: "setManagedService", service: "database", size: "small" });
    const paas = sim.advance(setUp, 3).state;
    expect(sim.units(paas)!.usersSupported).toBeGreaterThan(0);
    expect(sim.units(optimised(paas, 120))!.usersSupported).toBeGreaterThan(sim.units(paas)!.usersSupported);
  });

  it("cuts the per-user platform fee on SaaS", () => {
    const state = runningSaas();
    const tuned = optimised(state, 120);
    const left = 1 - sim.optimisation(tuned).saving;
    expect(sim.provider(tuned)!.perUserFee).toBeCloseTo(sim.provider(state)!.perUserFee * left, 2);
    expect(sim.monthlyInfrastructureCost(tuned)).toBeLessThan(sim.monthlyInfrastructureCost(state));
    const fee = (s: GameState) =>
      sim.advance(s).log.flatMap((d) => d.entries).find((e) => /per-user fee/.test(e.text))!.cashDelta;
    expect(fee(tuned)).toBeGreaterThan(fee(state));
  });
});

describe("optimisation through a migration", () => {
  /** Plays on until the migration under way has finished. */
  const finish = (state: GameState) => {
    let st = state;
    while (st.migration) st = sim.advance(st).state;
    return st;
  };

  it("carries the developer-days over, capped at the new model's maximum", () => {
    const onprem = optimised({ ...sim.advance(begin("onprem"), 1).state, cash: 10_000_000 }, 300);
    const before = sim.optimisation(onprem);
    expect(before.saving).toBeGreaterThan(cap.saas);
    const moved = finish(act(onprem, { type: "startMigration", model: "saas" }));
    expect(moved.model).toBe("saas");
    const after = sim.optimisation(moved);
    expect(after.days).toBeGreaterThanOrEqual(300);
    expect(after.cap).toBe(cap.saas);
    expect(after.saving).toBeLessThan(cap.saas);
    expect(after.saving).toBeCloseTo(cap.saas * (1 - Math.exp(-after.days / k)), 10);
  });

  it("gains the higher cap on moving on-prem", () => {
    const iaas = optimised({ ...serving("iaas", 1_000), cash: 10_000_000 }, 300);
    const moved = finish(act(iaas, { type: "startMigration", model: "onprem" }));
    expect(moved.model).toBe("onprem");
    expect(sim.optimisation(moved).saving).toBeGreaterThan(sim.optimisation(iaas).saving);
  });
});
