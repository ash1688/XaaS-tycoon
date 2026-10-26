import { describe, expect, it } from "vitest";
import { renderStatus, runScript } from "../scripts/textPlay.ts";
import {
  createSim,
  defaultConfig,
  type Action,
  type DayLog,
  type GameConfig,
  type GameState,
  type ModelId,
  type Sim,
} from "../src/index.ts";
import { inPhase } from "./phases.ts";

// Drift (#95), through the sim's public interface: a fresh random price rise at each year's end of a long game and
// none in a 180-day or 1-year game, the student's price and pay left alone, pay reviews every quarter of a long game's
// year once it's in Grow, more units on kit added after a year's end, and the hardware slider's wear scaled to the game's
// length, with a warning before a server wears out.

/** A rich company with no events or MVP to build, on any game length. Pay reviews are off unless a test turns them on. */
const rich: GameConfig = {
  ...defaultConfig,
  startingCash: 10_000_000,
  events: [],
  mvp: { ...defaultConfig.mvp, baseDevDays: { ecommerce: 0, social: 0, video: 0, payments: 0, assistant: 0, games: 0 } },
  launch: { ...defaultConfig.launch, auto: 1 },
  allowedGameLengths: { "180-days": 1, "until-ipo": 1, "1-year": 1, career: 1 },
  payReview: { ...defaultConfig.payReview, on: 0 },
};
const sim = createSim(rich);
const { drift, hardware } = defaultConfig;

const begin = (model: ModelId = "iaas", gameLength = "until-ipo", seed = 7, s: Sim = sim) =>
  s.newGame({ companyName: "Drifting Co", productType: "ecommerce", model, seed, gameLength, takeLoan: model === "onprem" });
const act = (state: GameState, ...actions: Action[]) => actions.reduce((st, a) => sim.applyAction(st, a), state);
const texts = (log: DayLog[]) => log.flatMap((d) => d.entries.map((e) => e.text));
/** The same company on the eve of `day`, as if it had played up to the day before. */
const eveOf = (state: GameState, day: number): GameState => ({ ...state, day: day - 1 });
/** Plays the year's last day. */
const endYear = (state: GameState, year = 1, s: Sim = sim) => s.advance(eveOf(state, year * drift.yearDays));
const staffCharges = (log: DayLog[]) =>
  log.flatMap((d) => d.entries.filter((e) => e.category === "staff")).reduce((sum, e) => sum + e.cashDelta, 0);
const rented = (state: GameState) => act(state, { type: "rentServer", server: "app", size: "large" });
const newest = (s: Sim, state: GameState) => s.servers(state).at(-1)!;
/** On-prem with an app server and a database bought, arrived and serving, and ops to run them. */
function onpremRunning(length = "until-ipo") {
  const state = act(begin("onprem", length), { type: "buyServer", server: "app", size: "large" }, { type: "buyServer", server: "database", size: "large" });
  return sim.advance({ ...state, staff: { ...state.staff, ops: { junior: 0, mid: 3, senior: 0 } } }, 6).state;
}

describe("price inflation at each year's end", () => {
  it("raises running prices by a fresh random 2–6% at each year's end of a long game, compounding", () => {
    const start = rented(begin());
    const one = endYear(start);
    const [first] = one.state.yearEnds;
    expect(first).toMatchObject({ year: 1, day: 365 });
    expect(first!.inflation).toBeGreaterThanOrEqual(drift.inflation.min);
    expect(first!.inflation).toBeLessThanOrEqual(drift.inflation.max);
    expect(one.state.priceLevel).toBeCloseTo(1 + first!.inflation, 6);
    expect(texts(one.log).some((t) => t.startsWith(`Year 1 is over. Running prices rise ${Math.round(first!.inflation * 1000) / 10}% from tomorrow`))).toBe(true);
    // Rent on a VM and the model's monthly cost rise by it.
    const rent = (s: GameState) => sim.servers(s)[0]!.monthlyCost;
    expect(rent(one.state)).toBeCloseTo(rent(start) * one.state.priceLevel, 1);
    expect(sim.serverOptions(one.state)[0]!.monthlyCost).toBeCloseTo(sim.serverOptions(start)[0]!.monthlyCost * one.state.priceLevel, 1);

    const two = endYear(one.state, 2);
    const second = two.state.yearEnds[1]!;
    expect(second).toMatchObject({ year: 2, day: 730 });
    expect(two.state.priceLevel).toBeCloseTo((1 + first!.inflation) * (1 + second.inflation), 6);
    // Nothing on any other day.
    expect(sim.advance(two.state, 5).state.yearEnds).toHaveLength(2);
  });

  it("rolls each year's rise fresh, within the range, across games", () => {
    const rises = new Set<number>();
    for (let seed = 1; seed <= 30; seed++) {
      const state = endYear(endYear(begin("saas", "until-ipo", seed)).state, 2).state;
      for (const y of state.yearEnds) {
        expect(y.inflation).toBeGreaterThanOrEqual(drift.inflation.min);
        expect(y.inflation).toBeLessThanOrEqual(drift.inflation.max);
        rises.add(y.inflation);
      }
    }
    expect(rises.size).toBeGreaterThan(20);
  });

  it("raises on-prem's kit prices, power and benefit fees, and SaaS's per-user fee", () => {
    const onprem = onpremRunning();
    const risen = endYear(onprem).state;
    const level = risen.priceLevel;
    const price = (s: GameState) => sim.serverOptions(s).find((o) => o.type === "app" && o.size === "large")!.price!;
    expect(price(risen)).toBeCloseTo(price(onprem) * level, 1);
    const fee = (s: GameState) => sim.benefits(s).find((b) => b.id === "hardwareEfficiency1")!.monthlyFee;
    expect(fee(risen)).toBeCloseTo(fee(onprem) * level, 1);
    const power = (log: DayLog[]) => texts(log).find((t) => t.includes("power and cooling ("))!;
    expect(power(sim.advance(risen).log)).toContain(`(£${(Math.round(defaultConfig.models.onprem.powerAndCooling * level * 100) / 100).toFixed(2)} a day)`);

    const saas = begin("saas");
    const perUser = (s: GameState) => sim.provider(s)!.perUserFee;
    expect(perUser(endYear(saas).state)).toBeCloseTo(perUser(saas) * endYear(saas).state.priceLevel, 2);
  });

  it("never drifts in a 180-day or 1-year game, which end before a year's end", () => {
    for (const length of ["180-days", "1-year"]) {
      const state = sim.advance(begin("iaas", length), 400).state;
      expect(state.status).toBe("finished");
      expect(state.yearEnds).toEqual([]);
      expect(state.priceLevel).toBe(1);
      expect(state.newKitUnits).toBe(1);
      expect(sim.drift(state).nextYearEnd).toBeNull();
    }
    expect(sim.drift(begin("iaas", "180-days")).nextYearEnd).toBeNull();
    expect(sim.drift(begin("iaas", "until-ipo")).nextYearEnd).toBe(365);
    expect(sim.drift(begin("iaas", "career")).nextYearEnd).toBe(365);
  });

  it("drifts in a career too", () => {
    expect(endYear(begin("iaas", "career")).state.yearEnds).toHaveLength(1);
  });

  it("leaves the student's own price alone", () => {
    const priced = act(begin("saas"), { type: "setPrice", price: 9 });
    const after = endYear(priced).state;
    expect(after.priceLevel).toBeGreaterThan(1);
    expect(after.price).toBe(priced.price);
  });

  it("never touches pay: a day's staff costs are the same either side of a year's end", () => {
    const staffed = act(begin("saas"), { type: "hire", pool: "support", count: 2 });
    const before = sim.advance(eveOf(staffed, 364));
    const yearEnd = sim.advance(before.state);
    const after = sim.advance(yearEnd.state);
    expect(yearEnd.state.yearEnds).toHaveLength(1);
    expect(staffCharges(before.log)).toBeLessThan(0);
    expect(staffCharges(after.log)).toBe(staffCharges(before.log));
    expect(after.state.payMultiplier).toBe(1);
  });

  it("rolls on its own RNG, so the game's other rolls don't move", () => {
    const off = createSim({ ...rich, drift: { ...drift, on: 0 } });
    const on = endYear(begin("saas")).state;
    const without = endYear(begin("saas", "until-ipo", 7, off), 1, off).state;
    expect(without.yearEnds).toEqual([]);
    expect(on.rng).toBe(without.rng);
    expect(on.hardwareRng).toBe(without.hardwareRng);
    expect(on.payReviewRng).toBe(without.payReviewRng);
    expect(on.driftRng).not.toBe(without.driftRng);
  });
});

describe("pay reviews in long games", () => {
  const reviews = createSim({ ...rich, payReview: { ...rich.payReview, on: 1 } });
  /** Plays to `day`, settling every review at staff's ask, and lists the reviews opened. */
  function reviewsTo(state: GameState, day: number) {
    let current = state;
    while (current.status === "playing" && current.day < day) {
      current = reviews.advance(current, day - current.day).state;
      if (current.payReview) current = reviews.applyAction(current, { type: "offerPayRise", rise: current.payReview.maxAsk });
    }
    return current.pastPayReviews.map((r) => [r.year, r.quarter, r.startDay]);
  }
  /** In Grow from `grow` (#236): the first review's rise starts growDays (30) after it, then one a quarter. */
  const start = (length: string, grow = 16) => inPhase(begin("saas", length, 7, reviews), "grow", grow);

  it("holds a review every quarter of a 365-day year from a month into Grow, until IPO and in a career", () => {
    // Quarters of 91.25 days from day 46, each named for the quarter of the game's year it starts in.
    const expected = [
      [1, 1, 46],
      [1, 2, 137],
      [1, 3, 228],
      [1, 4, 319],
      [2, 1, 411],
      [2, 2, 502],
      [2, 3, 593],
      [2, 4, 684],
    ];
    expect(reviewsTo(start("until-ipo"), 735)).toEqual(expected);
    expect(reviewsTo(start("career"), 735)).toEqual(expected);
  });

  it("has none in a long game before Grow", () => {
    const build = begin("saas", "until-ipo", 7, reviews);
    expect(reviews.payReviewDays(build)).toEqual([]);
    expect(reviews.payHistory(reviews.advance(eveOf(build, 365)).state).nextReview).toBeNull();
  });

  it("keeps a 1-year game to its own year and a 180-day game to its three", () => {
    expect(reviewsTo(start("1-year"), 365)).toEqual([
      [1, 1, 46],
      [1, 2, 137],
      [1, 3, 228],
      [1, 4, 319],
    ]);
    expect(reviewsTo(start("180-days"), 180)).toEqual([
      [1, 2, 46],
      [1, 3, 91],
      [1, 4, 136],
    ]);
  });

  it("names a later year's quarter, and drift leaves the review's inflation to its own roll", () => {
    // In Grow from day 63, the fourth review's rise starts on day 366 (63 + 30 + 273), so it opens on the year's end.
    const late = () => start("until-ipo", 63);
    const eve = reviews.advance(eveOf(late(), 365)).state;
    expect(eve.payReview).toMatchObject({ quarter: 1, year: 2, startDay: 366 });
    expect(eve.yearEnds).toHaveLength(1);
    expect(reviews.payReview(eve)).toMatchObject({ quarter: 1, year: 2 });
    const text = reviews.advance(eveOf(late(), 365)).log.at(-1)!.entries.at(-1)!.text;
    expect(text).toMatch(/^Pay review for quarter 1 of year 2: your staff want to talk about pay, with the rise from day 366/);
    expect(reviews.payHistory(reviews.advance(eveOf(late(), 300)).state).nextReview).toEqual({ quarter: 1, year: 2, startDay: 366 });
  });
});

describe("cheaper hardware", () => {
  it("gives servers and VMs added after a year's end 10% more units, compounding, and kit already there keeps its units", () => {
    const old = rented(begin());
    const units = newest(sim, old).units;
    const one = endYear(old).state;
    expect(one.newKitUnits).toBeCloseTo(1 + drift.newKitUnits, 6);
    // The VM rented before keeps its units; one rented now gives 10% more for the same rent.
    expect(newest(sim, one).units).toBe(units);
    const newer = rented(one);
    expect(newest(sim, newer)).toMatchObject({ units: units * 1.1, unitBoost: 1.1 });
    expect(newest(sim, newer).monthlyCost).toBe(newest(sim, one).monthlyCost);
    expect(sim.serverOptions(one).find((o) => o.type === "app" && o.size === "large")!.units).toBe(units * 1.1);
    // Capacity counts the extra units.
    const dbu = (s: GameState) => sim.units(sim.advance(s, 2).state)!.dbu.capacity;
    const db = (s: GameState) => act(s, { type: "rentServer", server: "database", size: "large" });
    expect(dbu(db(one)) - dbu(one)).toBeCloseTo(defaultConfig.servers.types.database.units.large * 1.1, 6);

    const two = endYear(newer, 2).state;
    const newest2 = rented(two);
    expect(newest(sim, newest2).units).toBeCloseTo(units * 1.21, 6);
    expect(sim.servers(newest2).filter((x) => x.type === "app" && x.size === "large").map((x) => x.unitBoost)).toEqual([1, 1.1, 1.21]);
  });

  it("does the same for bought on-prem kit", () => {
    const one = endYear(onpremRunning()).state;
    const bought = act(one, { type: "buyServer", server: "app", size: "large" });
    expect(newest(sim, bought)).toMatchObject({ units: defaultConfig.servers.types.app.units.large * 1.1, unitBoost: 1.1 });
  });

  it("does the same for a migration's new setup, which serves at the new units once it moves", () => {
    const one = endYear(rented(begin())).state;
    const moving = act(one, { type: "startMigration", model: "onprem" });
    expect(moving.migration!.servers.length).toBeGreaterThan(0);
    expect(moving.migration!.servers.every((s) => s.unitBoost === 1.1)).toBe(true);
    let moved = moving;
    while (moved.migration) moved = sim.advance(moved).state;
    expect(moved.model).toBe("onprem");
    expect(sim.servers(moved).every((s) => s.unitBoost === 1.1)).toBe(true);
  });
});

describe("server wear by game length", () => {
  /** An on-prem company with its app server at the slider, its wear at `wear`. */
  const onprem = (length: string, performance = 1, wear = 0) => {
    const state = onpremRunning(length);
    const app = state.servers.find((x) => x.type === "app")!;
    const set = act(state, { type: "setPerformance", id: app.id, performance });
    return { state: { ...set, servers: set.servers.map((x) => (x.id === app.id ? { ...x, wear } : x)) }, id: app.id };
  };
  const view = (state: GameState, id: number) => sim.servers(state).find((x) => x.id === id)!;

  it("squeezes a server's life into a 180-day game: never worn out at 100%, but in about 100–120 days at 150%", () => {
    const steady = onprem("180-days");
    expect(view(steady.state, steady.id).wearDaysLeft).toBe(hardware.shortGameLifespan);
    expect(hardware.shortGameLifespan).toBeGreaterThan(defaultConfig.finalDay);
    const hard = onprem("180-days", 1.5);
    const days = view(hard.state, hard.id).wearDaysLeft!;
    expect(days).toBeGreaterThanOrEqual(100);
    expect(days).toBeLessThanOrEqual(120);
  });

  it("gives a server about 5 years at 100% in a 1-year, until-IPO or career game", () => {
    for (const length of ["1-year", "until-ipo", "career"]) {
      const { state, id } = onprem(length);
      expect(view(state, id).wearDaysLeft).toBe(1_825);
      expect(view(state, id).wear).toBe(0);
    }
    expect(hardware.lifespan).toBe(1_825);
  });

  it("warns the student before a server wears out, with a pause, then again once it has", () => {
    const life = hardware.shortGameLifespan;
    // At 150% it wears 2.25 a day: one day short of the warning share.
    const { state, id } = onprem("180-days", 1.5, life * hardware.warnAt - 1);
    expect(view(state, id).wearWarning).toBe(false);
    const tick = sim.tick(state);
    expect(view(tick.state, id).wearWarning).toBe(true);
    expect(texts(tick.log).find((t) => t.startsWith(`Wear warning: server #${id}`))).toMatch(/9\d% worn and will be worn out in about \d+ days at 150%/);
    expect(tick.pauses).toContainEqual({ kind: "alert", id: `wear-${id}`, text: `Server #${id} is nearly worn out` });
    // Warned once: the next day says nothing more.
    expect(texts(sim.advance(tick.state).log).some((t) => t.startsWith("Wear warning"))).toBe(false);

    const nearlyGone = onprem("180-days", 1, life - 0.5);
    expect(texts(sim.advance(nearlyGone.state).log).some((t) => t.startsWith(`Worn out: server #${nearlyGone.id}`))).toBe(true);
  });
});

describe("text play and the timed flow", () => {
  const who = { player: "test", playstyle: "average-joe" };

  it("pauses the timed flow at a year's end", () => {
    const tick = sim.tick(eveOf(begin("saas"), 365));
    expect(tick.pauses).toContainEqual({ kind: "alert", id: "year-end", text: expect.stringMatching(/^Year 1 is over: running prices rose \d/) });
  });

  it("shows drift in a long game's status, and the drift command lists each year's end", () => {
    expect(renderStatus(sim, begin("saas", "180-days"))).not.toContain("drift:");
    expect(renderStatus(sim, begin("saas"))).toContain("drift: prices as at the start; next year's end after day 365");
    const after = endYear(begin("saas")).state;
    const y = after.yearEnds[0]!;
    expect(renderStatus(sim, after)).toContain(`drift: running prices +${Math.round(y.inflation * 1000) / 10}% on the start (Y1 +`);
    const turn = runScript(sim, after, "drift", who);
    expect(turn.lines.join("\n")).toMatch(/year 1 \(ended day 365\): prices \+[\d.]+% → ×1\.0\d\d; new kit ×1\.100 units/);
    expect(turn.lines.join("\n")).toContain("next year's end after day 730");
  });

  it("drives a year's end with next, showing it and the newer kit", () => {
    const turn = runScript(sim, eveOf(rented(begin("iaas")), 362), "next 7", who);
    expect(turn.state.day).toBe(365);
    expect(turn.lines.join("\n")).toMatch(/Year 1 is over/);
    const bought = runScript(sim, turn.state, "rent app large", who).state;
    expect(renderStatus(sim, bought)).toContain("(+10% newer kit)");
  });
});
