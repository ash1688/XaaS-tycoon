import { describe, expect, it } from "vitest";
import {
  createSim,
  CUSTOMER_TYPE_IDS,
  defaultConfig,
  PRODUCT_TYPE_IDS,
  weightedReaction,
  type CustomerTypeId,
  type GameConfig,
  type GameState,
  type ProductTypeId,
} from "../src/index.ts";

const sim = createSim();

/** A SaaS company 20 days in: launched, with paying users to react to a price change. */
const running = (s = sim, productType: ProductTypeId = "social"): GameState =>
  s.advance(s.newGame({ companyName: "Mix Co", productType, model: "saas", seed: 7 }), 20).state;

/** The default config with one product's customer mix replaced. */
function withMix(productType: ProductTypeId, customerMix: Record<CustomerTypeId, number>): GameConfig {
  const product = defaultConfig.productTypes[productType];
  return {
    ...defaultConfig,
    productTypes: { ...defaultConfig.productTypes, [productType]: { ...product, pricing: { ...product.pricing, customerMix } } },
  };
}
const only = (type: CustomerTypeId) =>
  Object.fromEntries(CUSTOMER_TYPE_IDS.map((t) => [t, t === type ? 1 : 0])) as Record<CustomerTypeId, number>;

describe("customer types", () => {
  it("starts each product with its own mix, adding up to 100%", () => {
    const mixes = PRODUCT_TYPE_IDS.map((productType) => {
      const state = sim.newGame({ companyName: "Mix Co", productType, model: "saas", seed: 1 });
      const mix = sim.customerMix(state);
      expect(mix.types.map((t) => t.id)).toEqual([...CUSTOMER_TYPE_IDS]);
      expect(mix.types.reduce((sum, t) => sum + t.share, 0)).toBeCloseTo(1, 10);
      for (const t of mix.types) expect(t.share).toBeCloseTo(defaultConfig.productTypes[productType].pricing.customerMix[t.id], 10);
      return JSON.stringify(mix.types.map((t) => t.share));
    });
    expect(new Set(mixes).size).toBe(PRODUCT_TYPE_IDS.length);
  });

  it("scales a mix that doesn't add up to 1", () => {
    const s = createSim(withMix("social", { casual: 50, enthusiasts: 30, professionals: 15, businesses: 5 }));
    const mix = s.customerMix(s.newGame({ companyName: "Mix Co", productType: "social", model: "saas", seed: 1 }));
    expect(mix.types.map((t) => t.share)).toEqual([0.5, 0.3, 0.15, 0.05]);
  });

  it("marks each type's price threshold, from the fair price, and which the price is over", () => {
    const state = running();
    const fair = sim.fairPrice(state);
    const mix = sim.customerMix(state);
    for (const t of mix.types) expect(t.threshold).toBeCloseTo(fair * defaultConfig.customerTypes[t.id].thresholdMultiple, 2);
    expect(mix.types.every((t) => !t.overThreshold)).toBe(true);
    expect(mix.types.reduce((sum, t) => sum + t.users, 0)).toBeCloseTo(state.users, -1);

    const dear = { ...state, price: mix.types[1]!.threshold + 1 };
    expect(sim.customerMix(dear).types.map((t) => t.overThreshold)).toEqual([true, true, false, false]);
  });

  it("weights each type's reaction by its share of users, as in the design's worked example", () => {
    // 70% casual users (30% leave), 20% enthusiasts (10%), 8% professionals (2%) and 2% businesses (1%): about 23%.
    const reaction = weightedReaction([
      { share: 0.7, reaction: 0.3 },
      { share: 0.2, reaction: 0.1 },
      { share: 0.08, reaction: 0.02 },
      { share: 0.02, reaction: 0.01 },
    ]);
    expect(reaction).toBeCloseTo(0.2318, 10);
  });

  it("loses the weighted reaction's share of paying users on a rise", () => {
    const state = running();
    expect(state.paidUsers).toBeGreaterThan(500);
    const preview = sim.pricePreview(state, sim.fairPrice(state) * 1.5);
    expect(preview.reactions.map((r) => r.share)).toEqual(sim.customerMix(state).types.map((t) => t.share));
    expect(preview.reaction).toBeCloseTo(weightedReaction(preview.reactions), 12);
    expect(preview.total.left + preview.total.toFree).toBe(Math.round(state.paidUsers * preview.reaction));
    // The least willing to pay react most.
    const byType = preview.reactions.map((r) => r.reaction);
    expect([...byType].sort((a, b) => b - a)).toEqual(byType);
    expect(byType[0]).toBeGreaterThan(byType[3]! * 5);

    // And the wave played out does what the preview said.
    const after = sim.advance(sim.applyAction(state, { type: "setPrice", price: preview.price }), 1).state;
    expect(sim.priceWave(after)!.total).toEqual(preview.total);
  });

  it("makes the same rise land softer on a more professional mix", () => {
    const rise = (type: CustomerTypeId) => {
      const s = createSim(withMix("social", only(type)));
      const state = running(s);
      return s.pricePreview(state, s.fairPrice(state) * 1.5).reaction;
    };
    const reactions = CUSTOMER_TYPE_IDS.map(rise);
    expect(reactions[0]).toBeGreaterThan(reactions[1]!);
    expect(reactions[1]).toBeGreaterThan(reactions[2]!);
    expect(reactions[2]).toBeGreaterThan(reactions[3]!);
  });

  it("makes the same cut draw less from a more professional mix: a bargain draws bargain hunters", () => {
    const cut = (type: CustomerTypeId) => {
      const s = createSim(withMix("social", only(type)));
      const state = running(s);
      const preview = s.pricePreview(state, s.fairPrice(state) * 0.5);
      // The day after the cut: growth and the paid share of new users, as well as the wave.
      const after = s.applyAction(state, { type: "setPrice", price: s.fairPrice(state) * 0.5 });
      return { joined: preview.total.joined / state.users, upgraded: preview.total.upgraded, grown: s.advance(after).state.users - state.users };
    };
    const [casual, enthusiasts, professionals, businesses] = CUSTOMER_TYPE_IDS.map(cut);
    expect(casual!.joined).toBeGreaterThan(enthusiasts!.joined);
    expect(enthusiasts!.joined).toBeGreaterThan(professionals!.joined);
    expect(professionals!.joined).toBeGreaterThan(businesses!.joined);
    expect(casual!.grown).toBeGreaterThan(businesses!.grown);
    // All casual is the alpha's cut: measured against the fair price, with growth at most doubled.
    expect(casual!.joined).toBeCloseTo(
      Math.min(defaultConfig.pricing.maxCutGain, defaultConfig.pricing.cutGainStrength * 0.5 ** defaultConfig.pricing.waveCurve),
      2,
    );
  });

  it("has no reaction to a cut", () => {
    const state = running();
    const preview = sim.pricePreview(state, sim.fairPrice(state) * 0.8);
    expect(preview.reaction).toBe(0);
    expect(preview.reactions.every((r) => r.reaction === 0)).toBe(true);
  });

  it("loses payers to a dear price each day only from the types it's over the threshold for", () => {
    const lostToPrice = (type: CustomerTypeId) => {
      const s = createSim(withMix("ecommerce", only(type)));
      const state = running(s, "ecommerce");
      // Between the enthusiasts' and professionals' thresholds, with the price lock and wave out of the way.
      const price = s.fairPrice(state) * 2;
      const dear = s.advance(s.applyAction(state, { type: "setPrice", price }), 20).state;
      const log = s.advance(dear, 5).log;
      return log.flatMap((d) => d.entries).filter((e) => /above what they think it's worth/.test(e.text)).length;
    };
    expect(lostToPrice("casual")).toBeGreaterThan(0);
    expect(lostToPrice("enthusiasts")).toBeGreaterThan(0);
    expect(lostToPrice("professionals")).toBe(0);
    expect(lostToPrice("businesses")).toBe(0);
  });
});
