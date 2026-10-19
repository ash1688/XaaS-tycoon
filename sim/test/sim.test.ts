import { describe, expect, it } from "vitest";
import { createSim, defaultConfig, MODEL_IDS, SimError, type Action, type GameConfig } from "../src/index.ts";

const comparison = { upfrontCost: "", monthlyCost: "", opsNeeded: "", control: "" };

const config: GameConfig = {
  startingCash: 1000,
  finalDay: 180,
  maxCompanyNameLength: 20,
  models: {
    onprem: { name: "On-prem", blurb: "", comparison, dailyCost: 10, opsNeeded: 3 },
    iaas: { name: "IaaS", blurb: "", comparison, dailyCost: 20, opsNeeded: 2 },
    paas: { name: "PaaS", blurb: "", comparison, dailyCost: 30, opsNeeded: 1 },
    saas: { name: "SaaS", blurb: "", comparison, dailyCost: 5, opsNeeded: 0 },
  },
  productTypes: {
    ecommerce: { name: "Shop", profile: "" },
    social: { name: "Social", profile: "" },
    video: { name: "Video", profile: "" },
  },
  // No starting staff, so the model's running cost is the only charge unless a test hires someone.
  staff: {
    developers: { name: "Developers", personName: "developer", dayRate: 7, startingCount: 0 },
    ops: { name: "Ops", personName: "ops person", dayRate: 3, startingCount: 0 },
  },
};

const sim = createSim(config);
const start = () => sim.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 42 });

describe("newGame", () => {
  it("starts on day 1 with the configured starting cash", () => {
    const state = start();
    expect(state).toMatchObject({ day: 1, cash: 1000, productType: "ecommerce", model: "iaas", companyName: "Acme" });
  });

  it("trims the company name", () => {
    const state = sim.newGame({ companyName: "  Acme  ", productType: "social", model: "saas", seed: 1 });
    expect(state.companyName).toBe("Acme");
  });

  it.each([
    [{ companyName: "   " }, "name_required"],
    [{ companyName: "x".repeat(21) }, "name_too_long"],
    [{ productType: "crafting" }, "unknown_product_type"],
    [{ model: "faas" }, "unknown_model"],
  ])("rejects bad input %o", (override, code) => {
    const params = { companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1, ...override };
    expect(() => sim.newGame(params)).toThrow(SimError);
    expect(() => sim.newGame(params)).toThrow(expect.objectContaining({ code }));
  });

  it("produces JSON-serialisable state", () => {
    const state = start();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});

describe("advance", () => {
  it("moves exactly one day by default and charges the model's daily cost", () => {
    const { state, log } = sim.advance(start());
    expect(state.day).toBe(2);
    expect(state.cash).toBe(980);
    expect(log).toEqual([{ day: 2, entries: [{ text: "IaaS running costs", cashDelta: -20 }] }]);
  });

  it("advances N days with one log per day", () => {
    const { state, log } = sim.advance(start(), 5);
    expect(state.day).toBe(6);
    expect(state.cash).toBe(900);
    expect(log.map((d) => d.day)).toEqual([2, 3, 4, 5, 6]);
  });

  it("gives the same result as advancing one day at a time", () => {
    let stepwise = start();
    for (let i = 0; i < 7; i++) stepwise = sim.advance(stepwise).state;
    expect(sim.advance(start(), 7).state).toEqual(stepwise);
  });

  it("does not mutate the input state", () => {
    const before = start();
    const copy = structuredClone(before);
    sim.advance(before, 3);
    expect(before).toEqual(copy);
  });

  it("rejects zero or fractional day counts", () => {
    expect(() => sim.advance(start(), 0)).toThrow(SimError);
    expect(() => sim.advance(start(), 1.5)).toThrow(SimError);
  });

  it("is deterministic for the same seed and inputs", () => {
    expect(sim.advance(start(), 30)).toEqual(sim.advance(start(), 30));
  });

  it("resumes identically after a JSON round trip", () => {
    const saved = JSON.parse(JSON.stringify(sim.advance(start(), 10).state));
    expect(sim.advance(saved, 10).state).toEqual(sim.advance(start(), 20).state);
  });

  it("takes its numbers from the config passed in", () => {
    const pricier = createSim({ ...config, models: { ...config.models, iaas: { ...config.models.iaas, dailyCost: 100 } } });
    const state = pricier.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1 });
    expect(pricier.advance(state).state.cash).toBe(900);
  });
});

describe("staff", () => {
  const hire = (pool: "developers" | "ops"): Action => ({ type: "hire", pool });
  const letGo = (pool: "developers" | "ops"): Action => ({ type: "letGo", pool });
  const apply = (state = start(), ...actions: Action[]) => actions.reduce((s, a) => sim.applyAction(s, a), state);

  it("starts with the configured headcount", () => {
    const staffed = createSim({
      ...config,
      staff: {
        developers: { ...config.staff.developers, startingCount: 2 },
        ops: { ...config.staff.ops, startingCount: 1 },
      },
    });
    const state = staffed.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1 });
    expect(state).toMatchObject({ developers: 2, ops: 1 });
  });

  it("hires and lets go each pool separately", () => {
    const state = apply(start(), hire("developers"), hire("developers"), hire("ops"), letGo("developers"));
    expect(state).toMatchObject({ developers: 1, ops: 1 });
  });

  it("does not move time on or touch cash", () => {
    const state = apply(start(), hire("ops"));
    expect(state).toMatchObject({ day: 1, cash: 1000 });
  });

  it.each(["developers", "ops"] as const)("rejects letting go below zero %s", (pool) => {
    expect(() => apply(start(), letGo(pool))).toThrow(expect.objectContaining({ code: "no_staff" }));
    expect(apply(start(), hire(pool), letGo(pool))[pool]).toBe(0);
  });

  it("rejects unknown actions and pools", () => {
    expect(() => sim.applyAction(start(), { type: "promote", pool: "ops" } as unknown as Action)).toThrow(SimError);
    expect(() => sim.applyAction(start(), { type: "hire", pool: "sales" } as unknown as Action)).toThrow(
      expect.objectContaining({ code: "unknown_pool" }),
    );
  });

  it("does not mutate the input state", () => {
    const before = start();
    const copy = structuredClone(before);
    sim.applyAction(before, hire("developers"));
    expect(before).toEqual(copy);
  });

  it("charges headcount × day rate on advance, one log entry per pool", () => {
    const staffed = apply(start(), hire("developers"), hire("developers"), hire("ops"));
    expect(sim.dailyStaffCost(staffed)).toBe(2 * 7 + 3);
    const { state, log } = sim.advance(staffed);
    expect(state.cash).toBe(1000 - 20 - 14 - 3);
    expect(log[0]!.entries).toEqual([
      { text: "IaaS running costs", cashDelta: -20 },
      { text: "Developers pay (2)", cashDelta: -14 },
      { text: "Ops pay (1)", cashDelta: -3 },
    ]);
  });

  it("charges nothing for an empty pool", () => {
    expect(sim.dailyStaffCost(start())).toBe(0);
    expect(sim.advance(apply(start(), hire("ops"))).log[0]!.entries.map((e) => e.text)).toEqual([
      "IaaS running costs",
      "Ops pay (1)",
    ]);
  });

  it("takes day rates from the config passed in", () => {
    const pricier = createSim({ ...config, staff: { ...config.staff, ops: { ...config.staff.ops, dayRate: 50 } } });
    const state = pricier.applyAction(
      pricier.newGame({ companyName: "Acme", productType: "ecommerce", model: "iaas", seed: 1 }),
      hire("ops"),
    );
    expect(pricier.advance(state).state.cash).toBe(1000 - 20 - 50);
  });

  it("reads ops needed per model from config", () => {
    expect(MODEL_IDS.map((m) => sim.opsNeeded(m))).toEqual([3, 2, 1, 0]);
  });

  it("needs fewer ops from on-prem to IaaS to PaaS, and none on SaaS, by default", () => {
    const needed = MODEL_IDS.map((m) => createSim(defaultConfig).opsNeeded(m));
    for (let i = 1; i < needed.length; i++) expect(needed[i]).toBeLessThan(needed[i - 1]!);
    expect(createSim(defaultConfig).opsNeeded("saas")).toBe(0);
  });
});

describe("state saved before staff existed", () => {
  // A version 1 save, exactly as the server stored it before this change.
  const v1 = () =>
    JSON.parse(
      '{"version":1,"companyName":"Acme","productType":"ecommerce","model":"iaas","day":5,"cash":920,"rng":12345}',
    );

  it("loads with no staff and the current version", () => {
    expect(sim.load(v1())).toEqual({ ...v1(), version: 2, developers: 0, ops: 0 });
  });

  it("still advances, charging only the model's running cost", () => {
    const { state } = sim.advance(v1());
    expect(state).toMatchObject({ version: 2, day: 6, cash: 900, developers: 0, ops: 0 });
  });

  it("accepts actions", () => {
    expect(sim.applyAction(v1(), { type: "hire", pool: "developers" })).toMatchObject({ version: 2, developers: 1 });
    expect(() => sim.applyAction(v1(), { type: "letGo", pool: "ops" })).toThrow(SimError);
  });
});
