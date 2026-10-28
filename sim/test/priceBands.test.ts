import { describe, expect, it } from "vitest";
import { inPhase } from "./phases.ts";
import { settlingPay } from "./settlingPay.ts";
import {
  CUSTOMER_TYPE_IDS,
  createSim,
  defaultConfig,
  SimError,
  type GameConfig,
  type GameState,
  type PriceBandsView,
  type Sim,
} from "../src/index.ts";
import { riseBands, riseLost } from "../src/pricing.ts";

// Beta final patch slice 1 (#257) and #251: the opening price, the price locks, the sliding-scale bands, the price
// customers expect, grumbling online and the fair price moving with inflation.

const p = defaultConfig.pricing;
/** No MVP to build, so Launch can be pressed at once. */
const NO_MVP: GameConfig["mvp"] = {
  ...defaultConfig.mvp,
  baseDevDays: { ecommerce: 0, social: 0, video: 0, payments: 0, assistant: 0, games: 0 },
};
// Pay reviews settled as they open, as a bot would.
const sim = settlingPay(createSim({ ...defaultConfig, mvp: NO_MVP }));
/** Launch presses itself, as most tests elsewhere are written for. */
const auto = settlingPay(createSim({ ...defaultConfig, launch: { ...defaultConfig.launch, auto: 1 } }));

const refusal = (attempt: () => unknown) => {
  try {
    attempt();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return null;
};

/** A shop on SaaS in the Launch phase with its MVP done, Launch not pressed. */
const ready = (s: Sim = sim): GameState =>
  inPhase(s.advance(s.newGame({ companyName: "Band Co", productType: "ecommerce", model: "saas", seed: 5 })).state, "launch");

/** A shop on SaaS 40 days after launching itself: users, payers and the price free to change. */
const running = (s: Sim = auto): GameState =>
  s.advance(s.newGame({ companyName: "Band Co", productType: "ecommerce", model: "saas", seed: 5 }), 40).state;

const total = (view: PriceBandsView, id: string) => view.total.find((b) => b.id === id)!.share;
const sum = (bands: { share: number }[]) => bands.reduce((s, b) => s + b.share, 0);

describe("the sliding-scale bands for a rise", () => {
  it("add up to 100% for each customer type, whatever the rise", () => {
    for (const th of [5, 10, 30]) {
      for (const to of [5.5, 7.5, 10, 20, 60, 500]) {
        const lost = riseLost(p, 5, to, th);
        const bands = riseBands(p, lost, 0.4, to - 5, th);
        const shares = Object.values(bands);
        expect(shares.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10);
        for (const x of shares) expect(x).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("is mostly accepted for a small rise, and mostly leaves or drops to free for a large one", () => {
    const at = (to: number) => riseBands(p, riseLost(p, 10, to, 10), 0.6, to - 10, 10);
    const small = at(11);
    expect(small.accept).toBeGreaterThan(0.9);
    const large = at(30);
    expect(large.leave + large.toFree).toBeGreaterThan(0.8);
    expect(large.accept).toBeLessThan(0.05);
    // The bigger the rise, the more grumble online and contact support among those who stay.
    expect(at(13).grumble).toBeGreaterThan(small.grumble);
    expect(at(13).support).toBeGreaterThan(small.support);
  });

  it("show in the preview for every type and in total, and set the wave", () => {
    const state = running();
    const preview = sim.pricePreview(state, state.price * 1.5);
    expect(preview.bands.kind).toBe("rise");
    expect(preview.bands.types.map((t) => t.id)).toEqual([...CUSTOMER_TYPE_IDS]);
    for (const t of preview.bands.types) {
      expect(t.bands.map((b) => b.id)).toEqual(["accept", "grumble", "support", "toFree", "leave"]);
      expect(sum(t.bands)).toBeCloseTo(1, 10);
    }
    expect(sum(preview.bands.total)).toBeCloseTo(1, 10);
    // Those who drop to free or leave are the wave's, and those who contact support raise its tickets.
    const paid = state.paidUsers;
    expect(preview.total.left + preview.total.toFree).toBe(Math.round(paid * (total(preview.bands, "toFree") + total(preview.bands, "leave"))));
    expect(preview.total.tickets).toBe(Math.round(paid * total(preview.bands, "support") * p.backlashTicketsPerUser));
    // A cheaper type's threshold is lower, so more of them go.
    const casual = preview.bands.types.find((t) => t.id === "casual")!;
    const businesses = preview.bands.types.find((t) => t.id === "businesses")!;
    const gone = (t: typeof casual) => sum(t.bands.filter((b) => b.id === "toFree" || b.id === "leave"));
    expect(gone(casual)).toBeGreaterThan(gone(businesses));
  });
});

describe("grumbling online", () => {
  const quiet = (grumble: number) =>
    createSim({ ...defaultConfig, launch: { ...defaultConfig.launch, auto: 1 }, pricing: { ...defaultConfig.pricing, grumbleDivertStrength: grumble } });

  it("sends a share of new users to the rival that's the best value while the backlash lasts", () => {
    const loud = quiet(p.grumbleDivertStrength);
    const silent = quiet(0);
    const state = running(settlingPay(loud));
    const risen = loud.applyAction(state, { type: "setPrice", price: state.price * 1.5 });
    expect(risen.priceWave!.grumblers).toBeGreaterThan(0);
    const divert = (s: Sim, st: GameState) => s.advance(st, 3);
    const withGrumbling = divert(loud, risen);
    const without = divert(silent, risen);
    // Fewer new users for the student, and more for the rivals.
    expect(withGrumbling.state.users).toBeLessThan(without.state.users);
    const rivalUsers = (st: GameState) => st.rivals.reduce((s, r) => s + r.users, 0);
    expect(rivalUsers(withGrumbling.state)).toBeGreaterThan(rivalUsers(without.state));
    const lines = withGrumbling.log.flatMap((d) => d.entries.map((e) => e.text));
    expect(lines.some((t) => /^Complaints about your price rise are spreading online: [\d,]+ new users? went to .+ instead\.$/.test(t))).toBe(true);
    // After the backlash it stops.
    const after = loud.advance(risen, p.waveDays).state;
    expect(loud.advance(after).log.flatMap((d) => d.entries.map((e) => e.text)).some((t) => t.startsWith("Complaints about"))).toBe(false);
  });

  it("starts nothing on a cut", () => {
    const state = running();
    expect(sim.applyAction(state, { type: "setPrice", price: state.price * 0.8 }).priceWave!.grumblers).toBe(0);
  });
});

describe("a cut and the price customers expect", () => {
  it("converts free users and brings new ones below the expected price, in bands that add up", () => {
    const state = running();
    const preview = sim.pricePreview(state, state.price * 0.7);
    expect(preview.bands.kind).toBe("cut");
    for (const t of preview.bands.types) {
      expect(t.bands.map((b) => b.id)).toEqual(["joinPaid", "joinFree", "notJoin"]);
      expect(sum(t.bands)).toBeCloseTo(1, 10);
    }
    expect(preview.total.upgraded).toBeGreaterThan(0);
    expect(preview.total.joined).toBeGreaterThan(0);
    expect(preview.bands.upgrade).toBeGreaterThan(0);
  });
});

describe("the opening price", () => {
  it("is set by Launch, the fair price when none is given", () => {
    const state = ready();
    const fair = sim.fairPrice(state);
    expect(sim.applyAction(state, { type: "launch" })).toMatchObject({ price: fair, launchDay: state.day + 1 });
    expect(sim.applyAction(state, { type: "launch", price: 9.5 })).toMatchObject({ price: 9.5 });
    expect(refusal(() => sim.applyAction(state, { type: "launch", price: -1 }))).toBe("bad_price");
  });

  it("refuses a price change from pressing Launch until go-live, then locks it for the usual days", () => {
    const launched = sim.applyAction(ready(), { type: "launch", price: 8 });
    expect(refusal(() => sim.applyAction(launched, { type: "setPrice", price: 6 }))).toBe("price_launching");
    const live = sim.advance(launched).state;
    expect(live.day).toBe(launched.launchDay);
    expect(sim.priceLockDaysLeft(live)).toBe(p.lockDays);
    expect(refusal(() => sim.applyAction(live, { type: "setPrice", price: 6 }))).toBe("price_locked");
    const free = sim.advance(live, p.lockDays).state;
    expect(sim.applyAction(free, { type: "setPrice", price: 6 }).price).toBe(6);
  });

  it("has launch users react to it through the bands: far above the fair price, most don't join and almost none pay", () => {
    const play = (price: number) => sim.advance(sim.applyAction(ready(), { type: "launch", price }), defaultConfig.launch.rampShares.length).state;
    const fair = play(sim.fairPrice(ready()));
    const dear = play(1_000);
    // The free tier costs nothing, so some still join free; hardly anyone pays £1,000.
    expect(dear.users).toBeLessThan(fair.users / 2);
    expect(dear.paidUsers).toBeLessThan(fair.paidUsers / 50);
    const bands = sim.launchBands(ready(), 1_000);
    expect(bands.kind).toBe("launch");
    expect(total(bands, "notJoin")).toBeGreaterThan(0.5);
    expect(total(bands, "joinPaid")).toBeLessThan(0.01);
    // The launch log says how many stayed away.
    const log = sim.advance(sim.applyAction(ready(), { type: "launch", price: 1_000 }), 3).log.flatMap((d) => d.entries.map((e) => e.text));
    expect(log.some((t) => /^Launch, day 1 of 3: [\d,]+ new users arrived, [\d,]+ of them paying\. [\d,]+ more looked but didn't join at your price\.$/.test(t))).toBe(true);
    for (const t of bands.types) expect(sum(t.bands)).toBeCloseTo(1, 10);
    // At the fair price everyone comes, the product's paid share paying.
    const atFair = sim.launchBands(ready(), sim.fairPrice(ready()));
    expect(total(atFair, "notJoin")).toBe(0);
    expect(total(atFair, "joinPaid")).toBeCloseTo(1 - defaultConfig.productTypes.ecommerce.pricing.freeShare, 10);
  });
});

describe("the IPO price lock", () => {
  it("locks the price from approval until the bell, and not while a cold market has postponed it", () => {
    const state = running();
    const approved = { ...state, ipo: { ...state.ipo, approvedDay: state.day } };
    expect(refusal(() => sim.applyAction(approved, { type: "setPrice", price: state.price + 1 }))).toBe("price_locked_ipo");
    const cold = { ...state, ipo: { ...state.ipo, approvedDay: null, retryDay: state.day + 30 } };
    expect(sim.applyAction(cold, { type: "setPrice", price: state.price + 1 }).price).toBe(state.price + 1);
  });
});

describe("the fair price follows inflation (#251)", () => {
  it("rises by a quarter of each pay review's inflation, compounding, while the student's own price stays put", () => {
    let state = inPhase(running(), "grow");
    const base = defaultConfig.productTypes.ecommerce.pricing.fairPrice;
    const price = state.price;
    while (state.pastPayReviews.length < 2) state = auto.advance(state, 10).state;
    const [first, second] = state.pastPayReviews;
    const lift = (1 + first!.inflation / 4) * (1 + second!.inflation / 4);
    const expected = Math.round(base * lift * 100) / 100;
    expect(auto.fairPrice(state)).toBe(expected);
    expect(auto.fairPriceView(state)).toMatchObject({ fairPrice: expected, baseFairPrice: base, lastInflation: state.pastPayReviews.at(-1)!.inflation });
    expect(auto.fairPriceView(state).rise).toBeCloseTo(lift - 1, 10);
    expect(state.price).toBe(price);
    // The customer types' thresholds move with it.
    expect(auto.customerMix(state).fairPrice).toBe(expected);
  });
});
