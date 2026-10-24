import { describe, expect, it } from "vitest";
import { createSim, defaultConfig, MODEL_IDS, PRODUCT_TYPE_IDS, type GameConfig, type GameState, type ProductTypeId } from "../src/index.ts";

// The AI assistant and games network (#118), through the sim's public interface on the default config.
/** No MVP to build, so a game launches as soon as it has somewhere to serve users: the MVP has its own tests. */
const NO_MVP: GameConfig["mvp"] = { ...defaultConfig.mvp, baseDevDays: { ecommerce: 0, social: 0, video: 0, payments: 0, assistant: 0, games: 0 } };
const sim = createSim({ ...defaultConfig, mvp: NO_MVP });
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
    // Bar the payments app, whose users are businesses by design.
    for (const p of PRODUCT_TYPE_IDS.filter((p) => p !== "assistant" && p !== "payments")) expect(upmarket("assistant"), p).toBeGreaterThan(upmarket(p));
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
  it("has short, sharp spikes on the calendar: the big game launches", () => {
    const launches = defaultConfig.calendar.holidays.filter((h) => ["springLaunch", "summerShowcase", "autumnLaunch"].includes(h.id));
    expect(launches).toHaveLength(3);
    for (const h of launches) expect(h.days, h.id).toBeLessThanOrEqual(5);
    for (const h of launches) expect(h.effects.games!.loadMultiplier, h.id).toBeGreaterThanOrEqual(2);
    // Without load variation or random events, a day's load is users × load per user, doubled in a launch.
    const steady: GameConfig = {
      ...defaultConfig,
      mvp: NO_MVP,
      events: [],
      productTypes: { ...defaultConfig.productTypes, games: { ...games, growth: { ...games.growth, loadNoise: 0 } } },
    };
    const s = createSim(steady);
    // Day 1 is 1 October 2026, so the autumn launch (6 November, 4 days) is days 37–40.
    let state: GameState = s.newGame({ companyName: "Product Co", productType: "games", model: "saas", seed: 4, startDate: "2026-10-01" });
    const autumn = s.calendar(state).upcoming.find((h) => h.id === "autumnLaunch")!;
    expect([autumn.startDay, autumn.endDay]).toEqual([37, 40]);
    const ratio: Record<number, number> = {};
    // Load is the users at the start of the day × load per user: keyed by the day played, the one after state.day.
    while (state.day <= autumn.endDay + 1) {
      const { day, users } = state;
      state = s.advance(state).state;
      ratio[day + 1] = state.load / users;
    }
    const usual = games.growth.loadPerUser;
    expect(ratio[autumn.startDay - 1]).toBeCloseTo(usual, 5);
    for (let d = autumn.startDay; d <= autumn.endDay; d++) expect(ratio[d], `day ${d}`).toBeCloseTo(usual * autumn.effect!.loadMultiplier, 5);
    expect(ratio[autumn.endDay + 1]).toBeCloseTo(usual, 5);
  });

  it("puts the game launches on a games network's calendar only", () => {
    const on = (productType: ProductTypeId) =>
      sim.calendar(sim.newGame({ companyName: "Product Co", productType, model: "saas", seed: 4, startDate: "2026-10-01" })).upcoming.map((h) => h.id);
    expect(on("games")).toContain("autumnLaunch");
    expect(on("ecommerce")).not.toContain("autumnLaunch");
    expect(on("ecommerce")).toContain("blackFriday");
  });

  it("sells a subscription for online play: about half its users pay", () => {
    const state = sim.advance(start("games"), 5).state;
    expect(state.paidUsers / state.users).toBeGreaterThan(0.4);
    expect(state.paidUsers / state.users).toBeLessThan(0.6);
  });
});

describe("theft or fraud", () => {
  it("says nothing of a checkout, which social, the AI assistant and others don't have", () => {
    const fraud = defaultConfig.events.find((e) => e.id === "fraud")!;
    for (const effect of Object.values(fraud.effects)) {
      expect(effect!.detail).not.toMatch(/checkout/i);
      expect(effect!.detail).toMatch(/payments/);
    }
  });
});
