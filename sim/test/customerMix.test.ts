import { describe, expect, it } from "vitest";
import {
  createSim,
  CUSTOMER_TYPE_IDS,
  defaultConfig,
  weightedReaction,
  type CustomerTypeId,
  type EventConfig,
  type GameConfig,
  type GameState,
  type ProductTypeId,
  type Sim,
} from "../src/index.ts";

// No random events and no rivals, so only what a test sets up shifts the mix. Rivals' tilt is tested in rivals.test.ts.
const quiet: GameConfig = {
  ...defaultConfig,
  events: [],
  productTypes: Object.fromEntries(
    Object.entries(defaultConfig.productTypes).map(([id, p]) => [id, { ...p, rivals: [] }]),
  ) as GameConfig["productTypes"],
};

/** A SaaS company 20 days in: launched, with users in the product's mix. */
const running = (s: Sim, productType: ProductTypeId = "social"): GameState =>
  s.advance(s.newGame({ companyName: "Mix Co", productType, model: "saas", seed: 7 }), 20).state;

const shares = (s: Sim, state: GameState) =>
  Object.fromEntries(s.customerMix(state).types.map((t) => [t.id, t.share])) as Record<CustomerTypeId, number>;
const newShares = (s: Sim, state: GameState) =>
  Object.fromEntries(s.customerMix(state).types.map((t) => [t.id, t.newShare])) as Record<CustomerTypeId, number>;
const base = (productType: ProductTypeId) => defaultConfig.productTypes[productType].pricing.customerMix;
const upmarket = (mix: Record<CustomerTypeId, number>) => mix.professionals + mix.businesses;

/** A provider outage on SaaS on each of the given days. */
const outages = (days: number[]): EventConfig => ({
  id: "providerOutage",
  name: "Provider outage",
  description: "The provider's data centre lost power.",
  layer: "facilities",
  schedule: { type: "fixed", days },
  days: 1,
  effects: { saas: { downtimeHours: 6, detail: "Down." } },
});

describe("what shifts the customer mix", () => {
  const sim = createSim(quiet);

  it("brings new users in the product's mix, so it stays put at the fair price with nothing tilting it", () => {
    for (const productType of ["social", "ecommerce", "video"] as const) {
      // Started all casual, it moves back towards the product's mix as users come and go.
      const casual = { casual: 1, enthusiasts: 0, professionals: 0, businesses: 0 };
      const shifted = sim.advance({ ...running(sim, productType), customerMix: casual }, 60).state;
      expect(shares(sim, shifted).casual).toBeLessThan(0.99);
      expect(newShares(sim, shifted)).toEqual(newShares(sim, running(sim, productType)));

      const state = sim.advance(running(sim, productType), 60).state;
      for (const t of CUSTOMER_TYPE_IDS) {
        expect(shares(sim, state)[t], `${productType} ${t}`).toBeCloseTo(base(productType)[t], 10);
        expect(newShares(sim, state)[t], `${productType} ${t}`).toBeCloseTo(base(productType)[t], 10);
      }
      const view = sim.customerMix(state).types;
      expect(view.every((t) => t.featureAppeal === 1 && t.priceFilter === 1)).toBe(true);
    }
  });

  it("brings more of the type a feature appeals to", () => {
    const state = running(sim);
    const groups = defaultConfig.productTypes.social.features.find((f) => f.id === "groups")!;
    expect(groups.appeal).toEqual({ professionals: 1.5 });
    const withGroups: GameState = { ...state, features: { groups: { status: "addon", progress: 0 } } };

    const view = sim.customerMix(withGroups).types.find((t) => t.id === "professionals")!;
    // Half as many again, against a mix that grew by 4% overall.
    expect(view.featureAppeal).toBeCloseTo(1.5 / 1.04, 9);
    // 8% professionals weighted half as much again: 12 in 104.
    expect(view.newShare).toBeCloseTo(0.12 / 1.04, 10);

    const after = sim.advance(withGroups, 60).state;
    const without = sim.advance(state, 60).state;
    expect(shares(sim, without).professionals).toBeCloseTo(0.08, 10);
    expect(shares(sim, after).professionals).toBeGreaterThan(0.085);
    expect(shares(sim, after).casual).toBeLessThan(shares(sim, without).casual);

    // Every feature built pulls every type alike: no tilt, and new users join in the product's mix.
    const all = Object.fromEntries(defaultConfig.productTypes.social.features.map((f) => [f.id, { status: "addon" as const, progress: 0 }]));
    const everything = sim.customerMix({ ...state, features: all }).types;
    expect(everything.every((t) => t.featureAppeal === 1)).toBe(true);
    for (const t of everything) expect(t.newShare).toBeCloseTo(base("social")[t.id], 10);
  });

  it("filters new users by the price: above a type's threshold, fewer of them join", () => {
    const state = running(sim);
    const fair = sim.fairPrice(state);
    // Twice the fair price: twice the casual threshold (a quarter as many), 1.6× the enthusiasts' (0.39 as many),
    // under the professionals' and businesses'.
    const dear = sim.customerMix({ ...state, price: fair * 2 }).types;
    expect(dear.map((t) => t.priceFilter)).toEqual([0.25, 1 / 1.6 ** 2, 1, 1]);
    const newMix = Object.fromEntries(dear.map((t) => [t.id, t.newShare]));
    expect(newMix.casual).toBeLessThan(0.5);
    expect(newMix.professionals).toBeGreaterThan(0.2);
    expect(Object.values(newMix).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    // A cut brings no tilt: every type is under its threshold.
    expect(sim.customerMix({ ...state, price: fair * 0.5 }).types.every((t) => t.priceFilter === 1)).toBe(true);
  });

  it("loses casual users first on a rise", () => {
    const state = running(sim);
    const risen = sim.applyAction(state, { type: "setPrice", price: sim.fairPrice(state) * 1.5 });
    expect(risen.priceWave!.leftMix!.casual).toBeGreaterThan(risen.priceWave!.leftMix!.businesses * 100);
    // Over the wave, before new users at the higher price add much.
    const after = sim.advance(risen, 7).state;
    expect(sim.priceWave(after)).toBeNull();
    expect(shares(sim, after).casual).toBeLessThan(0.69);
    expect(shares(sim, after).professionals).toBeGreaterThan(0.08);
    // A cut loses nobody, so it has no leavers' mix.
    expect(sim.applyAction(state, { type: "setPrice", price: sim.fairPrice(state) * 0.8 }).priceWave!.leftMix).toBeNull();
  });

  it("ends a pricier company with a more professional mix, so the next rise hurts less", () => {
    const at = (multiple: number) => {
      const state = running(sim);
      const priced = multiple === 1 ? state : sim.applyAction(state, { type: "setPrice", price: sim.fairPrice(state) * multiple });
      return sim.advance(priced, 90).state;
    };
    const [fair, dearer, dearest] = [at(1), at(1.5), at(2)];
    expect(upmarket(shares(sim, fair))).toBeCloseTo(0.1, 10);
    expect(upmarket(shares(sim, dearer))).toBeGreaterThan(upmarket(shares(sim, fair)) + 0.02);
    expect(upmarket(shares(sim, dearest))).toBeGreaterThan(upmarket(shares(sim, dearer)));

    // The next rise is weighted by the shifted mix: less than it would be in the product's mix.
    const next = sim.pricePreview(dearer, dearer.price * 1.2);
    const inBaseMix = weightedReaction(next.reactions.map((r) => ({ share: base("social")[r.id], reaction: r.reaction })));
    expect(next.reaction).toBeGreaterThan(0);
    expect(next.reaction).toBeLessThan(inBaseMix * 0.95);
  });

  it("drives businesses out faster when uptime is poor", () => {
    const days = Array.from({ length: 12 }, (_, i) => 25 + 5 * i);
    const down = (config: GameConfig) => {
      const s = createSim({ ...config, events: [outages(days)] });
      return s.advance(running(s), 70).state;
    };
    const poor = down(quiet);
    expect(poor.outageDays).toBe(12);
    const mix = shares(sim, poor);
    // 72 hours down over 70 days: about a third of the businesses gone, and some professionals.
    expect(mix.businesses).toBeLessThan(0.015);
    expect(mix.professionals).toBeLessThan(0.08);
    expect(mix.casual).toBeGreaterThan(0.7);

    // With no type leaving over downtime, the mix holds.
    const even = Object.fromEntries(
      CUSTOMER_TYPE_IDS.map((t) => [t, { ...defaultConfig.customerTypes[t], outageLeavePerHour: 0 }]),
    ) as GameConfig["customerTypes"];
    const flat = shares(sim, down({ ...quiet, customerTypes: even }));
    for (const t of CUSTOMER_TYPE_IDS) expect(flat[t]).toBeCloseTo(base("social")[t], 10);
  });
});
