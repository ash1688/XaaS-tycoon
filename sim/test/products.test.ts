import { describe, expect, it } from "vitest";
import { createSim, defaultConfig, MODEL_IDS, PRODUCT_TYPE_IDS, type GameConfig, type GameState, type ProductTypeId } from "../src/index.ts";

// The AI assistant and games network (#118), through the sim's public interface on the default config.
const sim = createSim();
const { assistant, games } = defaultConfig.productTypes;
const start = (productType: ProductTypeId, model = "saas", s = sim) =>
  s.newGame({ companyName: "Product Co", productType, model, seed: 4, takeLoan: model === "onprem" });

describe("new products", () => {
  it("can be picked on every model", () => {
    for (const productType of ["assistant", "games"] as const) {
      for (const model of MODEL_IDS) {
        const state = start(productType, model);
        expect(state, `${productType} ${model}`).toMatchObject({ productType, model, status: "playing" });
      }
    }
  });

  it("each has its own features, SaaS add-ons, paid API and customer mix", () => {
    const mixes = new Set<string>();
    for (const productType of ["assistant", "games"] as const) {
      const state = start(productType);
      const features = sim.features(state);
      expect(features.length, productType).toBeGreaterThanOrEqual(3);
      for (const f of features) expect(f.addonPricePerUser, `${productType} ${f.id}`).toBeGreaterThan(0);
      // Its features are its own: none shares an id with another product's.
      const others = PRODUCT_TYPE_IDS.filter((p) => p !== productType).flatMap((p) => defaultConfig.productTypes[p].features.map((f) => f.id));
      for (const f of features) expect(others, f.id).not.toContain(f.id);
      expect(sim.api(state), productType).toMatchObject({ owned: false });
      const bought = sim.applyAction({ ...state, cash: 100_000 }, { type: "buyApi" });
      expect(sim.api(bought)!.owned).toBe(true);
      mixes.add(JSON.stringify(sim.customerMix(state).types.map((t) => t.share)));
    }
    expect(mixes.size).toBe(2);
  });

  it("only products whose users post content need moderating", () => {
    const moderated = PRODUCT_TYPE_IDS.filter((p) => defaultConfig.productTypes[p].userContent);
    expect(moderated).toEqual(["social", "video", "games"]);
  });
});

describe("AI assistant", () => {
  it("needs the most compute per user of any product, and charges the most", () => {
    for (const p of PRODUCT_TYPE_IDS.filter((p) => p !== "assistant")) {
      expect(assistant.demand.cuPerUser, p).toBeGreaterThan(defaultConfig.productTypes[p].demand.cuPerUser);
      expect(assistant.pricing.fairPrice, p).toBeGreaterThan(defaultConfig.productTypes[p].pricing.fairPrice);
    }
    expect(sim.fairPrice(start("assistant"))).toBe(assistant.pricing.fairPrice);
  });

  it("has the most professionals and businesses in its customer mix", () => {
    const upmarket = (p: ProductTypeId) =>
      sim
        .customerMix(start(p))
        .types.filter((t) => t.id === "professionals" || t.id === "businesses")
        .reduce((sum, t) => sum + t.share, 0);
    for (const p of PRODUCT_TYPE_IDS.filter((p) => p !== "assistant")) expect(upmarket("assistant"), p).toBeGreaterThan(upmarket(p));
  });

  it("costs a SaaS platform more per user: its per-user fee is multiplied, every user billed", () => {
    const fee = defaultConfig.models.saas.monthlyCostPerUser;
    expect(assistant.demand.perUserFeeMultiplier).toBeGreaterThan(1);
    const { state, log } = sim.advance(start("assistant"), 5);
    const provider = sim.provider(state)!;
    expect(provider.perUserFee).toBeCloseTo(fee * assistant.demand.perUserFeeMultiplier, 10);
    expect(provider.monthlyPerUserBill).toBe(Math.round(state.users * provider.perUserFee));
    // The day's bill is a day's share of the month at the multiplied fee, on the day's users.
    const today = log.at(-1)!.entries.find((e) => e.text.includes("per-user fee"))!;
    expect(today.text).toContain("at £2.80 a month");
    const billed = Number(/\(([\d,]+) users/.exec(today.text)![1]!.replaceAll(",", ""));
    expect(today.cashDelta).toBe(-Math.round((billed * provider.perUserFee) / defaultConfig.billing.daysPerMonth));
    // A shop on the same platform pays the platform's own fee.
    expect(sim.provider(sim.advance(start("ecommerce"), 5).state)!.perUserFee).toBe(fee);
  });

  it("serves only a few hundred users from an app server", () => {
    let state = start("assistant", "iaas");
    state = sim.applyAction(state, { type: "rentServer", server: "app", size: "small" });
    state = sim.applyAction(state, { type: "rentServer", server: "database", size: "large" });
    state = sim.advance(state, 2).state;
    expect(sim.units(state)!.usersSupported).toBe(Math.floor(defaultConfig.servers.types.app.units.small / assistant.demand.cuPerUser));
    expect(sim.units(state)!.usersSupported).toBeLessThan(500);
  });
});

describe("games network", () => {
  const spike = games.growth.seasonalSpike!;

  it("has a short, sharp traffic spike: launch day or a holiday", () => {
    expect(spike.loadMultiplier).toBeGreaterThanOrEqual(2);
    expect(spike.length).toBeLessThanOrEqual(5);
    // Without load variation or random events, a day's load is users × load per user, doubled in the spike.
    const steady: GameConfig = {
      ...defaultConfig,
      events: [],
      productTypes: { ...defaultConfig.productTypes, games: { ...games, growth: { ...games.growth, loadNoise: 0 } } },
    };
    const s = createSim(steady);
    let state: GameState = start("games", "saas", s);
    const ratio: Record<number, number> = {};
    // Load is the users at the start of the day × load per user: keyed by the day played, the one after state.day.
    while (state.day <= spike.firstDay + spike.length) {
      const { day, users } = state;
      state = s.advance(state).state;
      ratio[day + 1] = state.load / users;
    }
    const usual = games.growth.loadPerUser;
    expect(ratio[spike.firstDay - 1]).toBeCloseTo(usual, 5);
    for (let d = spike.firstDay; d < spike.firstDay + spike.length; d++) expect(ratio[d], `day ${d}`).toBeCloseTo(usual * spike.loadMultiplier, 5);
    expect(ratio[spike.firstDay + spike.length]).toBeCloseTo(usual, 5);
  });

  it("sells a subscription for online play: about half its users pay", () => {
    const state = sim.advance(start("games"), 5).state;
    expect(state.paidUsers / state.users).toBeGreaterThan(0.4);
    expect(state.paidUsers / state.users).toBeLessThan(0.6);
  });
});
