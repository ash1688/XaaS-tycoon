import { describe, expect, it } from "vitest";
import { createSim, CSUITE_ROLES, defaultConfig, SimError, type CsuiteRole, type GameConfig, type GameState, type Sim } from "../src/index.ts";
import { withFullCsuite } from "./executives.ts";

// The IPO through the sim's public interface: the readiness checklist, the cold market, the float, the first day of
// trading, and the until-IPO game length. Anything random is tested on fixed RNG states, so results repeat.

const quiet: GameConfig = {
  ...defaultConfig,
  events: [],
  // No pay reviews: they have their own tests (payReview.test.ts).
  payReview: { ...defaultConfig.payReview, on: 0 },
  allowedGameLengths: { "180-days": 1, "until-ipo": 1, "1-year": 0, career: 0 },
  // Small thresholds and a short trading history, so a company made ready below clears them comfortably.
  ipo: {
    ...defaultConfig.ipo,
    minTradingDays: 20,
    products: {
      ...defaultConfig.ipo.products,
      social: { users: 1_000, annualRevenue: 100_000, payingUsers: 500 },
    },
  },
};
const sim = createSim(quiet);
const RECORD = quiet.ipo.recordDays;

const begin = (s: Sim = sim, model = "saas", gameLength?: string) =>
  s.newGame({ companyName: "Acme", productType: "social", model, seed: 42, gameLength });

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return null;
};

/**
 * The company made comfortably over every condition: 2,000 users (1,000 paying £60 a month), 90% satisfaction, and on
 * every day played no downtime, steady costs and £1,000 of income.
 */
const makeReady = (played: GameState): GameState => ({
  // The full C-suite is hired.
  ...withFullCsuite(played),
  users: 2_000,
  paidUsers: 1_000,
  price: 60,
  satisfaction: 90,
  spendByDay: played.spendByDay.map((d) => ({
    ...d,
    staff: 100,
    infrastructure: 50,
    cabling: 0,
    power: 10,
    addons: 0,
    debt: 0,
    interest: 0,
    income: 1_000,
    users: 2_000,
    paidUsers: 1_000,
    satisfaction: 90,
    hoursDown: 0,
  })),
});

/** A company well past launch, made ready: on IaaS with an app server, which its ops staff must patch. */
function ready(s: Sim = sim, model = "saas"): GameState {
  const start = begin(s, model);
  const setUp = model === "iaas" ? s.applyAction(start, { type: "rentServer", server: "app", size: "small" }) : start;
  return makeReady(s.advance(setUp, RECORD + 10).state);
}

/** The state with each of its last `days` days changed. */
const lastDays = (state: GameState, days: number, change: Partial<GameState["spendByDay"][number]>): GameState => ({
  ...state,
  spendByDay: state.spendByDay.map((d) => (d.day > state.day - days ? { ...d, ...change } : d)),
});

/** The state without the executive in one C-suite role. */
const withoutRole = (state: GameState, role: CsuiteRole): GameState => ({
  ...state,
  csuite: { ...state.csuite, hired: state.csuite.hired.filter((e) => e.role !== role) },
});

const met = (s: Sim, state: GameState) => Object.fromEntries(s.ipo(state).conditions.map((c) => [c.id, c.met]));

/** A sim whose cold-market chance is always this. */
const coldAt = (chance: number) => createSim({ ...quiet, ipo: { ...quiet.ipo, coldChance: { min: chance, max: chance } } });

describe("the readiness checklist", () => {
  it("lists the six conditions, none met by a new company, and refuses to apply", () => {
    const state = begin();
    const ipo = sim.ipo(state);
    expect(ipo.conditions.map((c) => c.id)).toEqual(["trading", "usersAndRevenue", "uptime", "costs", "security", "csuite"]);
    expect(ipo).toMatchObject({ status: "not-ready", ready: false, canApply: false, offer: null, result: null });
    expect(ipo.refusal).toMatch(/Not ready to float yet: trading history, users and revenue/);
    expect(refusal(() => sim.applyAction(state, { type: "applyForIpo" }))).toBe("ipo_not_ready");
  });

  it("turns green condition by condition, and allows applying only once all are", () => {
    const state = ready();
    expect(sim.ipo(state)).toMatchObject({ status: "ready", ready: true, canApply: true, refusal: null });
    expect(Object.values(met(sim, state)).every(Boolean)).toBe(true);

    const broken: [string, GameState][] = [
      ["usersAndRevenue", { ...state, users: 999 }],
      ["usersAndRevenue", lastDays(state, 60, { income: 200 })],
      // The minimum paying customer base is part of users and revenue.
      ["usersAndRevenue", { ...state, paidUsers: 499 }],
      ["uptime", lastDays(state, 3, { hoursDown: 3 })],
      ["costs", lastDays(state, 2, { infrastructure: 5_000 })],
      ...CSUITE_ROLES.map((role): [string, GameState] => ["csuite", withoutRole(state, role)]),
    ];
    for (const [id, s] of broken) {
      const conditions = met(sim, s);
      expect(conditions[id], id).toBe(false);
      expect(Object.entries(conditions).filter(([, ok]) => !ok).map(([k]) => k), id).toEqual([id]);
      expect(sim.ipo(s)).toMatchObject({ status: "not-ready", canApply: false });
      expect(refusal(() => sim.applyAction(s, { type: "applyForIpo" }))).toBe("ipo_not_ready");
    }
  });

  it("isn't held back by satisfaction, profitability or the Series rounds approaching", () => {
    const state = ready();
    const cut: GameState[] = [
      lastDays(state, RECORD, { satisfaction: 40 }),
      { ...lastDays(state, RECORD, { staff: 2_000 }), price: 0.01, users: 2_000_000, paidUsers: 1_000_000 },
      {
        ...state,
        investors: {
          ...state.investors,
          vc: { ...state.investors.vc, firstApproachDay: { seriesA: null, seriesB: null, seriesC: null, seriesD: null } },
        },
      },
    ];
    for (const s of cut) {
      expect(sim.ipo(s)).toMatchObject({ status: "ready", canApply: true });
      expect(sim.ipo(s).comfort).toBeLessThanOrEqual(sim.ipo(state).comfort);
    }
  });

  it("needs the full C-suite: shows how many of the 11 are hired, and turns green at 11", () => {
    const state = ready();
    const line = (s: GameState) => sim.ipo(s).conditions.find((c) => c.id === "csuite")!;
    expect(CSUITE_ROLES).toHaveLength(11);
    expect(line(state)).toMatchObject({ label: "The full C-suite", met: true, now: "All 11 hired", comfort: 1 });
    const noLegal = withoutRole(state, "legalCounsel");
    expect(line(noLegal)).toMatchObject({ met: false, now: "10 of 11 hired; still to hire: Legal counsel", comfort: 0 });
    const none = { ...state, csuite: { ...state.csuite, hired: [] } };
    expect(line(none).now).toMatch(/^0 of 11 hired; still to hire: /);
    expect(line(none).needed).toMatch(/all 11 beyond you as CEO/);
  });

  it("needs a trading history: days traded since the launch, however good the record", () => {
    const state = ready();
    const traded = state.day - state.launchDay! + 1;
    const longer = createSim({ ...quiet, ipo: { ...quiet.ipo, minTradingDays: traded + 1 } });
    expect(Object.entries(met(longer, state)).filter(([, ok]) => !ok).map(([k]) => k)).toEqual(["trading"]);
    expect(longer.ipo(state).conditions[0]).toMatchObject({ met: false, now: `${traded} days traded`, comfort: 0 });
    expect(refusal(() => longer.applyAction(state, { type: "applyForIpo" }))).toBe("ipo_not_ready");
    const later = { ...state, day: state.day + 1, spendByDay: [...state.spendByDay, { ...state.spendByDay.at(-1)!, day: state.day + 1 }] };
    expect(met(longer, later).trading).toBe(true);
    expect(sim.ipo(state).conditions[0]!.comfort).toBe(1);
  });

  it("sets aside the costliest day, so a single one-off charge doesn't spoil predictable costs", () => {
    const state = ready();
    // A fraud bill (charged as infrastructure) and a severance payment (staff), each one day of the record.
    for (const spike of [{ infrastructure: 4_000 }, { staff: 6_000 }]) {
      const once = lastDays(state, 1, spike);
      expect(met(sim, once).costs).toBe(true);
      expect(sim.ipo(once).conditions.find((c) => c.id === "costs")!.needed).toMatch(/your costliest day set aside/);
      const twice = { ...once, spendByDay: once.spendByDay.map((d) => (d.day === state.day - 10 ? { ...d, ...spike } : d)) };
      expect(met(sim, twice).costs).toBe(false);
    }
    const strict = createSim({ ...quiet, ipo: { ...quiet.ipo, costDaysSetAside: 0 } });
    expect(met(strict, lastDays(state, 1, { infrastructure: 4_000 })).costs).toBe(false);
  });

  it("audits security: on IaaS the OS is yours to patch, on SaaS the provider's", () => {
    const iaas = ready(sim, "iaas");
    const ops = iaas.staff.ops;
    const noOps = { ...iaas, staff: { ...iaas.staff, ops: { junior: 0, mid: 0, senior: 0 } } };
    expect(sim.opsNeededNow(noOps)).toBeGreaterThan(0);
    expect(met(sim, noOps).security).toBe(false);
    expect(sim.ipo(noOps).conditions.find((c) => c.id === "security")!.now).toMatch(/Ops staff doing 0 of/);
    expect(met(sim, { ...noOps, staff: { ...iaas.staff, ops: { ...ops, senior: 20 } } }).security).toBe(true);

    const saas = ready();
    const none = { ...saas, staff: { ...saas.staff, ops: { junior: 0, mid: 0, senior: 0 } } };
    expect(sim.ipo(none).conditions.find((c) => c.id === "security")).toMatchObject({ met: true, now: "Covered by the provider" });
  });

  it("is comfortable well over every condition, and less so only just over", () => {
    const comfy = sim.ipo(ready());
    const scraping = sim.ipo({ ...lastDays(ready(), RECORD, { satisfaction: 71 }), users: 1_010, paidUsers: 505 });
    expect(scraping.ready).toBe(true);
    expect(comfy.comfort).toBeGreaterThan(scraping.comfort);
    expect(scraping.conditions.find((c) => c.id === "usersAndRevenue")!.comfort).toBeLessThan(0.2);
    // Satisfaction isn't a condition, but the market still weighs it.
    const unhappy = sim.ipo(lastDays(ready(), RECORD, { satisfaction: 71 }));
    expect(unhappy.ready).toBe(true);
    expect(unhappy.comfort).toBeLessThan(comfy.comfort);
    // The full C-suite is yes or no: met, it shows as comfortable but plays no part in the average.
    expect(comfy.conditions.find((c) => c.id === "csuite")!.comfort).toBe(1);
  });
});

describe("applying and the cold market", () => {
  it("approves an application when the market isn't cold, and won't take another", () => {
    const s = coldAt(0);
    const approved = s.applyAction(ready(s), { type: "applyForIpo" });
    const ipo = s.ipo(approved);
    expect(ipo).toMatchObject({ status: "approved", approvedDay: approved.day, canApply: false });
    expect(ipo.applications).toEqual([{ day: approved.day, cold: false }]);
    expect(ipo.offer).toMatchObject({ minFloat: 0.15, maxFloat: 0.4, sharesInIssue: 10_000, studentShare: 1 });
    expect(refusal(() => s.applyAction(approved, { type: "applyForIpo" }))).toBe("ipo_approved");
    // The game holds at the offer until the bell is rung.
    expect(refusal(() => s.advance(approved))).toBe("ring_the_bell");
    expect(refusal(() => s.tick(approved))).toBe("ring_the_bell");
  });

  it("postpones a cold market by about 30 days, with satisfaction lost, then lets the company try again", () => {
    const s = coldAt(1);
    const state = ready(s);
    const cold = s.applyAction(state, { type: "applyForIpo" });
    expect(cold.satisfaction).toBe(state.satisfaction - quiet.ipo.coldSatisfactionLoss);
    expect(s.ipo(cold)).toMatchObject({
      status: "cold",
      retryDay: state.day + 30,
      canApply: false,
      approvedDay: null,
      applications: [{ day: state.day, cold: true }],
    });
    expect(s.ipo(cold).refusal).toMatch(new RegExp(`apply again on day ${state.day + 30}, in 30 days`));
    expect(refusal(() => s.applyAction(cold, { type: "applyForIpo" }))).toBe("ipo_cold");
    // Still cold the day before; free to apply again from the retry day (made ready again after the days played).
    const nearly = s.advance(cold, 29).state;
    expect(s.ipo(nearly).status).toBe("cold");
    const again = makeReady(s.advance(cold, 30).state);
    expect(again.day).toBe(cold.ipo.retryDay);
    expect(s.ipo(again)).toMatchObject({ status: "ready", canApply: true });
  });

  it("is a hidden roll, less likely the more comfortably ready the company is", () => {
    const comfy = ready();
    const scraping = { ...lastDays(comfy, RECORD, { satisfaction: 71 }), users: 1_010, paidUsers: 505 };
    const colds = (state: GameState) => {
      let n = 0;
      for (let rng = 0; rng < 400; rng++) {
        const applied = sim.applyAction({ ...state, rng: rng * 7_919 }, { type: "applyForIpo" });
        if (applied.ipo.applications.at(-1)!.cold) n++;
      }
      return n / 400;
    };
    const { min, max } = quiet.ipo.coldChance;
    const comfyRate = colds(comfy);
    const scrapingRate = colds(scraping);
    expect(comfyRate).toBeLessThan(scrapingRate);
    expect(comfyRate).toBeGreaterThanOrEqual(min - 0.05);
    expect(scrapingRate).toBeLessThanOrEqual(max + 0.05);
    // The same RNG state always rolls the same way.
    const state = { ...scraping, rng: 1_234 };
    expect(sim.applyAction(state, { type: "applyForIpo" })).toEqual(sim.applyAction(state, { type: "applyForIpo" }));
  });
});

describe("the float and the opening bell", () => {
  const s = coldAt(0);
  const approved = () => s.applyAction(ready(s), { type: "applyForIpo" });
  const ring = (state: GameState, float: number, sim: Sim = s) => sim.applyAction(state, { type: "ringBell", float });

  it("can only be rung once approved, for a float of 15% to 40%", () => {
    expect(refusal(() => ring(ready(s), 0.25))).toBe("ipo_not_approved");
    for (const float of [0.14, 0.41, Number.NaN]) expect(refusal(() => ring(approved(), float))).toBe("bad_float");
    for (const float of [0.15, 0.4]) expect(ring(approved(), float).ipo.result!.float).toBe(float);
  });

  it("sells new shares at the offer price, diluting everyone, and the cash raised goes to the company", () => {
    const state = s.applyAction(s.applyAction(ready(s), { type: "acceptFunding", funder: "friendsAndFamily" }), { type: "applyForIpo" });
    const before = s.capTable(state);
    const offer = s.ipo(state).offer!;
    const quarter = offer.floats.find((f) => f.float === 0.25)!;
    const floated = ring(state, 0.25);
    const r = floated.ipo.result!;
    expect(r).toMatchObject({
      float: 0.25,
      sharesBefore: before.sharesInIssue,
      newShares: Math.round(before.sharesInIssue / 3),
      offerPrice: offer.offerPrice,
      valuation: offer.valuation,
      cashRaised: quarter.cashRaised,
    });
    expect(r.cashRaised).toBe(Math.round(r.newShares * r.offerPrice));
    expect(floated.cash).toBe(state.cash + r.cashRaised);
    // The public own the float; everyone else keeps their shares and owns a quarter less of the company.
    const after = s.capTable(floated);
    expect(after.rows.at(-1)).toMatchObject({ id: "public", name: "Public shareholders", shares: r.newShares });
    expect(after.rows.at(-1)!.share).toBeCloseTo(0.25, 3);
    for (const row of before.rows) {
      const now = after.rows.find((x) => x.id === row.id)!;
      expect(now.shares).toBe(row.shares);
      expect(now.share).toBeCloseTo(row.share * 0.75, 3);
    }
    expect(r.studentShare).toBeCloseTo(before.rows[0]!.share * 0.75, 3);
    // After the IPO the cap table prices the shares at the close, adding up to the market value.
    expect(after).toMatchObject({ sharePrice: r.closePrice, sharesInIssue: r.sharesAfter });
    expect(after.rows[0]!.value).toBe(r.studentValue);
    // Cash raised isn't income: it's money from shareholders.
    expect(floated.spendByDay.at(-1)!.raised - state.spendByDay.at(-1)!.raised).toBe(r.cashRaised);
    expect(floated.income).toBe(state.income);
  });

  it("values the company at the close including the cash raised, and the student's stake at the close price", () => {
    const flat = createSim({
      ...quiet,
      ipo: { ...quiet.ipo, coldChance: { min: 0, max: 0 }, minDrift: 0, maxDrift: 0, growthDrift: 0, swingAtMinFloat: 0, swingAtMaxFloat: 0 },
    });
    const state = flat.applyAction(ready(flat), { type: "applyForIpo" });
    const r = ring(state, 0.3, flat).ipo.result!;
    expect(r.prices.every((p) => p === r.prices[0])).toBe(true);
    expect(r.closePrice).toBe(Math.round(r.offerPrice * 100) / 100);
    expect(r.marketValue).toBe(Math.round(r.closePrice * r.sharesAfter));
    // At an unmoved price, the market value is the valuation plus the cash raised.
    expect(Math.abs(r.marketValue - (r.valuation + r.cashRaised))).toBeLessThan(r.sharesAfter * 0.01);
    expect(r.studentValue).toBe(Math.round(r.studentShares * r.closePrice));
  });

  it("plays the first day half-hour by half-hour, the same way every time from the same state", () => {
    const state = approved();
    const r = ring(state, 0.2).ipo.result!;
    expect(r.prices).toHaveLength(quiet.ipo.ticks + 1);
    expect(r.prices[0]).toBe(Math.round(r.offerPrice * 100) / 100);
    expect(r.closePrice).toBe(r.prices.at(-1));
    expect(r.closePrice).toBeGreaterThanOrEqual(r.offerPrice * quiet.ipo.lowestClose - 0.01);
    expect(r.reasons.some((x) => /small float/.test(x))).toBe(true);
    expect(ring(state, 0.2)).toEqual(ring(state, 0.2));
  });

  it("swings further on a small float than a large one, and rises more for a comfortably ready company", () => {
    const comfy = approved();
    const moves = (state: GameState, float: number) =>
      Array.from({ length: 300 }, (_, i) => {
        const r = ring({ ...state, rng: i * 104_729 }, float).ipo.result!;
        return r.closePrice / r.offerPrice - 1;
      });
    const spread = (xs: number[]) => {
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    };
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(spread(moves(comfy, 0.15))).toBeGreaterThan(2 * spread(moves(comfy, 0.4)));

    const scraping = s.applyAction(
      { ...lastDays(ready(s), RECORD, { satisfaction: 71 }), users: 1_010, paidUsers: 505 },
      { type: "applyForIpo" },
    );
    expect(mean(moves(comfy, 0.3))).toBeGreaterThan(mean(moves(scraping, 0.3)));
  });

  it("ends the game, with the IPO in the summary", () => {
    const floated = ring(approved(), 0.25);
    expect(floated.status).toBe("finished");
    expect(s.ipo(floated)).toMatchObject({ status: "floated", canApply: false });
    expect(s.summarise(floated)).toMatchObject({ ending: "ipo", ipo: floated.ipo.result });
    expect(() => s.advance(floated)).toThrow(new RegExp(`Acme floated on day ${floated.day}`));
    expect(refusal(() => ring(floated, 0.25))).toBe("finished");
    expect(refusal(() => s.applyAction(floated, { type: "hire", pool: "ops" }))).toBe("finished");
  });
});

describe("until IPO", () => {
  it("is a game length with no last day, ending only when the company floats", () => {
    const rich = createSim({ ...quiet, startingCash: 50_000_000, ipo: { ...quiet.ipo, coldChance: { min: 0, max: 0 } } });
    const state = begin(rich, "saas", "until-ipo");
    expect(state).toMatchObject({ gameLength: "until-ipo", finalDay: null });
    expect(rich.loanQuote(state)).not.toBeNull();
    const later = rich.advance(state, 400).state;
    expect(later).toMatchObject({ day: 401, status: "playing" });
    expect(rich.summarise(later)).toMatchObject({ ending: null, finalDay: null });
    const floated = rich.applyAction(rich.applyAction(ready(rich), { type: "applyForIpo" }), { type: "ringBell", float: 0.2 });
    expect(rich.summarise({ ...floated, gameLength: "until-ipo", finalDay: null })).toMatchObject({ ending: "ipo" });
  });

  it("isn't allowed by default", () => {
    expect(createSim().config.allowedGameLengths["until-ipo"]).toBe(0);
    expect(refusal(() => createSim().newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 1, gameLength: "until-ipo" }))).toBe(
      "game_length_not_allowed",
    );
  });
});
