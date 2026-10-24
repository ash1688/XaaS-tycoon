import { describe, expect, it } from "vitest";
import { createSim, defaultConfig, type GameConfig, type GameState, type ProductTypeId } from "../src/index.ts";

const sim = createSim();

/** The default config with the rivals' settings changed. */
function withRivals(rivals: Partial<GameConfig["rivals"]>): GameConfig {
  return { ...defaultConfig, rivals: { ...defaultConfig.rivals, ...rivals } };
}

/** The default config with no rivals in one product's market. */
function withoutRivals(productType: ProductTypeId): GameConfig {
  const product = defaultConfig.productTypes[productType];
  return { ...defaultConfig, productTypes: { ...defaultConfig.productTypes, [productType]: { ...product, rivals: [] } } };
}

const start = (s = sim, productType: ProductTypeId = "ecommerce"): GameState =>
  s.newGame({ companyName: "Rival Co", productType, model: "saas", seed: 4 });

/** A SaaS company 20 days in: launched and growing. */
const running = (s = sim, productType: ProductTypeId = "ecommerce") => s.advance(start(s, productType), 20).state;

/** A price to the penny, as the rivals' prices are stored. */
const pennies = (price: number) => Math.round(price * 100) / 100;

const texts = (log: { entries: { text: string }[] }[]) => log.flatMap((d) => d.entries.map((e) => e.text));

describe("rivals and market share", () => {
  it("starts each product's rivals at their price stance, with the student first in the market", () => {
    const state = start();
    const market = sim.market(state);
    const fair = sim.fairPrice(state);
    const rivals = defaultConfig.productTypes.ecommerce.rivals;
    expect(market.companies.map((c) => c.id)).toEqual(["you", ...rivals.map((r) => r.id)]);
    expect(market.companies[0]).toMatchObject({ you: true, name: "Rival Co", price: fair });
    rivals.forEach((r, i) => expect(market.companies[i + 1]).toMatchObject({ name: r.name, price: pennies(fair * r.priceStance) }));
    expect(market.companies.reduce((sum, c) => sum + c.share, 0)).toBeCloseTo(1, 10);
    expect(market.reactionDays).toBe(defaultConfig.rivals.reactionDays);
    expect(market.nextReaction).toBeNull();
  });

  it("splits each customer type's new users by value: a cheap rival wins casual users, a polished one businesses", () => {
    const market = sim.market(running());
    const best = Object.fromEntries(market.byType.map((t) => [t.id, t.bestId]));
    expect(best.casual).toBe("cartcraft");
    expect(best.businesses).toBe("tillbox");
    for (const t of market.byType) expect(t.shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("wins more of each type's new users with a lower price, most of all the casual users", () => {
    const state = running();
    const before = sim.market(state).byType;
    const cheap = sim.market({ ...state, price: sim.fairPrice(state) * 0.7 }).byType;
    for (let i = 0; i < before.length; i++) expect(cheap[i]!.shares[0]).toBeGreaterThan(before[i]!.shares[0]!);
    const gain = (i: number) => cheap[i]!.shares[0]! / before[i]!.shares[0]!;
    expect(gain(0)).toBeGreaterThan(gain(3));
  });

  it("wins more professionals and businesses with more features", () => {
    const state = running();
    const before = sim.market(state);
    const built = Object.fromEntries(sim.features(state).map((f) => [f.id, { status: "addon" as const, progress: 0, startedDay: 1 }]));
    const after = sim.market({ ...state, features: built });
    expect(after.companies[0]!.quality).toBeGreaterThan(before.companies[0]!.quality);
    expect(after.byType.find((t) => t.id === "businesses")!.shares[0]).toBeGreaterThan(
      before.byType.find((t) => t.id === "businesses")!.shares[0]!,
    );
    expect(after.growth).toBeGreaterThan(before.growth);
  });

  it("tilts the student's new users away from the types a rival is the best deal for", () => {
    const lone = createSim(withoutRivals("ecommerce"));
    const state = running();
    const newShare = (s: typeof sim, st: GameState, id: string) => s.customerMix(st).types.find((t) => t.id === id)!.newShare;
    const tilted = sim.customerMix(state).types.map((t) => t.newShare);
    const plain = lone.customerMix({ ...state, rivals: [] }).types.map((t) => t.newShare);
    expect(tilted).not.toEqual(plain);
    expect(tilted.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(lone.customerMix({ ...state, rivals: [] }).types.every((t) => t.rivalPull === 1)).toBe(true);
    // Cutting the price wins back casual users from the cheap rival.
    const cheap = { ...state, price: sim.fairPrice(state) * 0.7 };
    expect(newShare(sim, cheap, "casual")).toBeGreaterThan(newShare(sim, state, "casual") - 1e-9);
  });

  it("slows the student's growth when the rivals are the better deal", () => {
    const lone = createSim(withoutRivals("ecommerce"));
    const state = running();
    expect(sim.market(state).growth).toBeLessThan(1);
    expect(lone.market(running(lone)).growth).toBe(1);
    // The same game with and without rivals: rivals take new users the student would have won.
    expect(sim.advance(state, 30).state.users).toBeLessThan(lone.advance({ ...state, rivals: [] }, 30).state.users);
  });

  it("keeps the growth multiplier within its limits", () => {
    const s = createSim(withRivals({ growthEffect: 2, minGrowth: 0.9, maxGrowth: 1.1 }));
    const state = running(s);
    expect(s.market({ ...state, price: 1000 }).growth).toBe(0.9);
    expect(s.market({ ...state, price: 0.5 }).growth).toBe(1.1);
  });

  it("answers the student's price only after the reaction delay", () => {
    const s = createSim(withRivals({ undercutChance: 0 }));
    const state = running(s);
    const fair = s.fairPrice(state);
    const priced = s.applyAction(state, { type: "setPrice", price: 7 });
    const reactsOn = state.day + 1 + defaultConfig.rivals.reactionDays;
    expect(s.market(priced).nextReaction).toEqual({ day: reactsOn, price: 7 });

    const waiting = s.advance(priced, reactsOn - priced.day - 1);
    expect(s.market(waiting.state).companies.slice(1).map((c) => c.price)).toEqual(
      defaultConfig.productTypes.ecommerce.rivals.map((r) => pennies(fair * r.priceStance)),
    );
    expect(texts(waiting.log).some((t) => /answered your/.test(t))).toBe(false);

    const answered = s.advance(waiting.state, 1);
    expect(answered.state.day).toBe(reactsOn);
    const prices = s.market(answered.state).companies.slice(1).map((c) => c.price);
    expect(prices).toEqual(defaultConfig.productTypes.ecommerce.rivals.map((r) => pennies(7 * r.priceStance)));
    expect(texts(answered.log)).toContain("CartCraft answered your £7 price: it now charges £5.95 a month.");
    expect(s.market(answered.state).nextReaction).toBeNull();
  });

  it("sometimes undercuts the student when it answers", () => {
    const s = createSim(withRivals({ undercutChance: 1, undercutShare: 0.2 }));
    const state = s.applyAction(running(s), { type: "setPrice", price: 7 });
    const answered = s.advance(state, defaultConfig.rivals.reactionDays + 1);
    // Every rival prices 20% under the student's £7, or lower if its stance is cheaper still.
    for (const c of s.market(answered.state).companies.slice(1)) expect(c.price).toBeLessThanOrEqual(5.6);
    expect(texts(answered.log)).toContain("Tillbox undercut you: it now charges £5.60 a month, against your £7.");
  });

  it("keeps a rival's price within its band, however far the student goes", () => {
    const s = createSim(withRivals({ undercutChance: 0 }));
    const state = s.applyAction(running(s), { type: "setPrice", price: 500 });
    const answered = s.advance(state, defaultConfig.rivals.reactionDays + 1).state;
    const fair = s.fairPrice(state);
    for (const c of s.market(answered).companies.slice(1)) expect(c.price).toBe(fair * defaultConfig.rivals.maxPriceMultiple);
  });

  it("sends staff the student lets go to a rival sometimes, raising its quality", () => {
    const s = createSim(withRivals({ joinChance: 1 }));
    const state = running(s);
    const before = s.market(state).companies.slice(1).map((c) => c.quality);
    const lettingGo = s.applyAction(state, { type: "letGo", pool: "support", count: 1 });
    const after = s.market(lettingGo).companies.slice(1).map((c) => c.quality);
    const gain = after.reduce((a, b) => a + b, 0) - before.reduce((a, b) => a + b, 0);
    expect(gain).toBeCloseTo(defaultConfig.rivals.qualityPerStaff, 6);
    expect(texts(s.advance(lettingGo, 1).log).some((t) => /^A mid support person you let go joined (CartCraft|Tillbox)/.test(t))).toBe(true);

    const never = createSim(withRivals({ joinChance: 0 }));
    const kept = never.applyAction(running(never), { type: "letGo", pool: "support", count: 1 });
    expect(never.market(kept).companies.slice(1).map((c) => c.quality)).toEqual(before);
  });

  it("grows rivals' users towards their most, and never ends a rival, over a whole game", () => {
    let state = start(sim, "social");
    const rivals = defaultConfig.productTypes.social.rivals;
    let previous = sim.market(state).companies.slice(1).map((c) => c.users);
    while (state.status === "playing") {
      state = sim.advance(state, 30).state;
      const users = sim.market(state).companies.slice(1).map((c) => c.users);
      users.forEach((u, i) => {
        expect(u).toBeGreaterThanOrEqual(previous[i]!);
        expect(u).toBeLessThanOrEqual(rivals[i]!.maxUsers);
      });
      previous = users;
    }
    expect(previous.every((u, i) => u > rivals[i]!.startingUsers)).toBe(true);
  });

  it("leaves a market without rivals to the student", () => {
    const lone = createSim(withoutRivals("video"));
    const state = running(lone, "video");
    const market = lone.market(state);
    expect(market.companies).toHaveLength(1);
    expect(market.companies[0]!.share).toBe(1);
    expect(market.byType.every((t) => t.bestId === "you")).toBe(true);
    expect(market.growth).toBe(1);
  });
});

describe("the market's size", () => {
  it("shows how much of the users the product can reach the company has, even with no rivals", () => {
    const { marketSize } = defaultConfig.productTypes.ecommerce.growth;
    const state = running();
    expect(sim.market(state).reach).toEqual({ size: marketSize, filled: state.users / marketSize });
    const alone = createSim(withoutRivals("ecommerce"));
    expect(alone.market(running(alone)).reach.size).toBe(marketSize);
    // Never shown past full, whatever a migration or wave of users leaves.
    expect(sim.market({ ...state, users: marketSize * 2 }).reach.filled).toBe(1);
  });

  it("fills up as users grow, and growth slows in step", () => {
    const early = sim.market(running()).reach.filled;
    const later = sim.market(sim.advance(running(), 60).state).reach.filled;
    expect(later).toBeGreaterThan(early);
  });
});
