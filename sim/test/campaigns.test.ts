import { describe, expect, it } from "vitest";
import {
  createSim,
  defaultConfig,
  SimError,
  type Action,
  type CustomerTypeId,
  type GameConfig,
  type GameState,
  type HolidayConfig,
  type Sim,
} from "../src/index.ts";

// Campaigns (#115), through the sim's public interface: the student aims one at a customer type with a budget and a
// length; each day it spends its share and adds new users of that type directly, on top of normal growth, at about
// (budget ÷ length) ÷ the type's cost per user, scaled by how full the market is, the overlap with other campaigns on
// the type, and a bonus when started just before a holiday. They open at the first angel approach, never before the
// MVP is done, and show their spend, users brought in and cost per user as they run.

/** No events and no holidays, so the only thing moving a campaign is the campaign. */
const quiet: GameConfig = { ...defaultConfig, events: [], calendar: { ...defaultConfig.calendar, holidays: [] } };
const sim = createSim(quiet);
const { costPerUser } = quiet.campaigns;
const marketSize = quiet.productTypes.social.growth.marketSize;

const begin = (s: Sim = sim, startDate?: string) =>
  s.newGame({ companyName: "Reach Co", productType: "social", model: "saas", seed: 42, ...(startDate ? { startDate } : {}) });

/** Plays on until the launch ramp is over. */
function launched(s: Sim = sim, state = begin(s)): GameState {
  let current = state;
  while (s.launch(current).status !== "launched") current = s.advance(current).state;
  return current;
}

/** A company the first angel has approached, as Campaigns open, with plenty of cash. */
const grownUp = (state: GameState): GameState => ({
  ...state,
  cash: 1_000_000,
  investors: { ...state.investors, firstApproachDay: state.day },
});
const ready = grownUp(launched());

const start = (customerType: CustomerTypeId, budget: number, days: number): Action => ({ type: "startCampaign", customerType, budget, days });

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return null;
};

/** Users of one customer type. */
const ofType = (state: GameState, t: CustomerTypeId) => state.customerMix[t] * state.users;

/** The share of new users each pound still brings at a company's users. */
const saturation = (state: GameState) => 1 - state.users / marketSize;

describe("before Campaigns open", () => {
  it("are locked and refused until the first angel approaches", () => {
    const state = launched();
    expect(sim.campaigns(state)).toMatchObject({ unlocked: false, canStart: false, running: 0, campaigns: [] });
    expect(sim.campaigns(state).why).toMatch(/angel investor approaches/);
    expect(refusal(() => sim.applyAction(state, start("casual", 1_000, 7)))).toBe("not_yet");
  });

  it("are refused before the MVP is done, even once an angel has approached", () => {
    const state = grownUp(begin());
    expect(sim.mvp(state).done).toBe(false);
    expect(sim.campaigns(state)).toMatchObject({ unlocked: true, canStart: false });
    expect(sim.campaigns(state).why).toMatch(/MVP is done/);
    expect(refusal(() => sim.applyAction(state, start("casual", 1_000, 7)))).toBe("mvp_first");
  });

  it("open once launched and an angel has approached", () => {
    expect(sim.campaigns(ready)).toMatchObject({ unlocked: true, canStart: true, why: null, capacity: 2, running: 0 });
  });
});

describe("starting a campaign", () => {
  it("refuses an unknown type, a budget or length out of range, and a budget over the cash", () => {
    const { minBudget, maxBudget, minDays, maxDays } = quiet.campaigns;
    expect(refusal(() => sim.applyAction(ready, start("pensioners" as CustomerTypeId, 1_000, 7)))).toBe("unknown_customer_type");
    for (const budget of [minBudget - 1, maxBudget + 1, 1_000.5]) {
      expect(refusal(() => sim.applyAction(ready, start("casual", budget, 7)))).toBe("bad_budget");
    }
    for (const days of [minDays - 1, maxDays + 1, 7.5]) {
      expect(refusal(() => sim.applyAction(ready, start("casual", 1_000, days)))).toBe("bad_length");
    }
    expect(refusal(() => sim.applyAction({ ...ready, cash: 999 }, start("casual", 1_000, 7)))).toBe("cant_afford");
  });

  it("runs from the next day played, and spends nothing until then", () => {
    const state = sim.applyAction(ready, start("professionals", 7_000, 7));
    expect(state.cash).toBe(ready.cash);
    expect(sim.campaigns(state).campaigns).toEqual([
      expect.objectContaining({ customerType: "professionals", customerTypeName: "Professionals", budget: 7_000, days: 7, startDay: ready.day + 1, endDay: ready.day + 7, status: "starting", spent: 0, users: 0, costPerUser: null }),
    ]);
  });

  it("runs only as many at once as there's capacity for, and stopping one makes room", () => {
    let state = sim.applyAction(ready, start("casual", 1_000, 10));
    state = sim.applyAction(state, start("enthusiasts", 1_000, 10));
    expect(sim.campaigns(state)).toMatchObject({ running: 2, canStart: false });
    expect(refusal(() => sim.applyAction(state, start("businesses", 1_000, 10)))).toBe("campaigns_full");
    state = sim.advance(state, 2).state;
    const [, first] = sim.campaigns(state).campaigns;
    state = sim.applyAction(state, { type: "stopCampaign", id: first!.id });
    expect(sim.campaigns(state).campaigns[1]).toMatchObject({ status: "stopped", endDay: state.day, spent: 200 });
    expect(sim.applyAction(state, start("businesses", 1_000, 10)).campaigns).toHaveLength(3);
    // A stopped campaign spends no more.
    const after = sim.advance(state, 3).state;
    expect(sim.campaigns(after).campaigns.find((c) => c.id === first!.id)!.spent).toBe(200);
  });
});

describe("a running campaign", () => {
  it("adds users directly at about (budget ÷ length) ÷ cost per user, on top of normal growth", () => {
    const withCampaign = sim.applyAction(ready, start("casual", 7_000, 7));
    const played = sim.advance(withCampaign).state;
    const without = sim.advance(ready).state;
    const brought = Math.floor((1_000 / costPerUser.casual) * saturation(ready));
    expect(brought).toBeGreaterThan(400);
    expect(sim.campaigns(played).campaigns[0]).toMatchObject({ status: "running", daysRun: 1, spent: 1_000, users: brought });
    // Normal growth is the same either way: the campaign's users come on top.
    expect(played.users - without.users).toBe(brought);
    expect(without.cash - played.cash).toBe(1_000);
  });

  it("brings its users in as the targeted customer type", () => {
    const withCampaign = sim.applyAction(ready, start("businesses", 16_000, 10));
    const played = sim.advance(withCampaign).state;
    const without = sim.advance(ready).state;
    const brought = played.users - without.users;
    expect(brought).toBeGreaterThan(80);
    expect(ofType(played, "businesses") - ofType(without, "businesses")).toBeCloseTo(brought, 6);
    for (const t of ["casual", "enthusiasts", "professionals"] as const) expect(ofType(played, t)).toBeCloseTo(ofType(without, t), 6);
    expect(played.customerMix.businesses).toBeGreaterThan(without.customerMix.businesses);
  });

  it("costs more per user for the dearer customer types", () => {
    const users = (t: CustomerTypeId) => sim.advance(sim.applyAction(ready, start(t, 7_000, 7))).state.users - sim.advance(ready).state.users;
    expect(users("casual")).toBeGreaterThan(users("enthusiasts"));
    expect(users("enthusiasts")).toBeGreaterThan(users("professionals"));
    expect(users("professionals")).toBeGreaterThan(users("businesses"));
  });

  it("shows diminishing returns for two campaigns on the same type at once, but not on different types", () => {
    const alone = sim.advance(sim.applyAction(ready, start("enthusiasts", 7_000, 7))).state;
    const one = sim.campaigns(alone).campaigns[0]!.users;
    const twice = sim.advance(sim.applyAction(sim.applyAction(ready, start("enthusiasts", 7_000, 7)), start("enthusiasts", 7_000, 7))).state;
    const each = sim.campaigns(twice).campaigns.map((c) => c.users);
    for (const users of each) expect(users).toBe(Math.floor(((1_000 / costPerUser.enthusiasts) * saturation(ready)) * quiet.campaigns.overlapMultiplier));
    expect(each[0]! + each[1]!).toBeLessThan(2 * one);
    // The view says so before the second starts: a pound buys fewer of the type already being targeted.
    const firstOn = sim.advance(sim.applyAction(ready, start("enthusiasts", 7_000, 7))).state;
    const types = Object.fromEntries(sim.campaigns(firstOn).types.map((t) => [t.id, t]));
    expect(types.enthusiasts!.running).toBe(1);
    expect(types.enthusiasts!.usersPerPound).toBeCloseTo((saturation(firstOn) / costPerUser.enthusiasts) * quiet.campaigns.overlapMultiplier, 4);
    // Different types don't get in each other's way.
    const mixed = sim.advance(sim.applyAction(sim.applyAction(ready, start("enthusiasts", 7_000, 7)), start("professionals", 7_000, 7))).state;
    expect(sim.campaigns(mixed).campaigns.find((c) => c.customerType === "enthusiasts")!.users).toBe(one);
  });

  it("brings fewer users per pound as the market fills up", () => {
    const busy: GameState = { ...ready, users: 30_000, paidUsers: 3_000 };
    const empty = sim.campaigns(sim.advance(sim.applyAction(ready, start("casual", 7_000, 7))).state).campaigns[0]!.users;
    const full = sim.campaigns(sim.advance(sim.applyAction(busy, start("casual", 7_000, 7))).state).campaigns[0]!.users;
    expect(sim.campaigns(busy).saturation).toBe(0.25);
    expect(full).toBe(Math.floor(500 * 0.25));
    expect(full).toBeLessThan(empty / 3);
  });

  it("reports its spend, users brought in and cost per user, and finishes spending exactly its budget", () => {
    let state = sim.applyAction(ready, start("professionals", 1_000, 7));
    state = sim.advance(state, 3).state;
    const midway = sim.campaigns(state).campaigns[0]!;
    expect(midway).toMatchObject({ status: "running", daysRun: 3, spent: 429 });
    expect(midway.costPerUser).toBe(Math.round((100 * midway.spent) / midway.users) / 100);
    // It plays to the end, with a pause and a log line as it finishes.
    let finished = false;
    let line = "";
    while (!finished) {
      const t = sim.tick(state);
      state = t.state;
      finished = t.pauses.some((p) => p.id === `campaign-${midway.id}`);
      line = t.log.flatMap((d) => d.entries).find((e) => e.kind === "campaign")?.text ?? line;
    }
    const done = sim.campaigns(state).campaigns[0]!;
    expect(done).toMatchObject({ status: "finished", daysRun: 7, spent: 1_000 });
    expect(done.users).toBeGreaterThan(100);
    expect(line).toBe(`Your campaign for professionals has finished: £1,000 spent, ${done.users} users brought in, £${done.costPerUser!.toFixed(2)} a user.`);
    expect(sim.summarise(state).spend.campaigns).toBe(1_000);
    expect(sim.campaigns(state)).toMatchObject({ running: 0, canStart: true });
    // Finished, it spends nothing more.
    expect(sim.campaigns(sim.advance(state, 2).state).campaigns[0]!.spent).toBe(1_000);
  });
});

describe("timing a campaign before a holiday", () => {
  const springBreak: HolidayConfig = {
    id: "springBreak",
    name: "Spring break",
    description: "Students are off.",
    start: { anchor: "date", month: 3, day: 1 },
    days: 7,
    effects: { social: { loadMultiplier: 1.2, growthMultiplier: 1.25, detail: "Students post all day." } },
  };
  const holidays = createSim({ ...quiet, calendar: { ...quiet.calendar, holidays: [springBreak] } });
  /** A game from 1 January, grown up, played to `day`: the holiday starts on day 60. */
  function on(s: Sim, day: number) {
    let state = grownUp(launched(s, begin(s, "2026-01-01")));
    state = s.advance(state, day - state.day).state;
    return grownUp(state);
  }

  it("gives a bonus to one started within the window before it", () => {
    const before = on(holidays, 50);
    expect(holidays.campaigns(before).holiday).toMatchObject({ name: "Spring break", startDay: 60, daysUntil: 10, bonus: quiet.campaigns.holidayBonus });
    const timed = holidays.advance(holidays.applyAction(before, start("businesses", 16_000, 10))).state;
    const plain = on(sim, 50);
    expect(saturation(plain)).toBe(saturation(before));
    const untimed = sim.advance(sim.applyAction(plain, start("businesses", 16_000, 10))).state;
    const [withBonus] = holidays.campaigns(timed).campaigns;
    const [without] = sim.campaigns(untimed).campaigns;
    expect(withBonus).toMatchObject({ holiday: "Spring break" });
    expect(without!.holiday).toBeNull();
    expect(withBonus!.users).toBe(Math.floor((1_600 / costPerUser.businesses) * saturation(before) * quiet.campaigns.holidayBonus));
    expect(withBonus!.users).toBeGreaterThan(without!.users);
  });

  it("gives none to one started too long before it, or once it has started", () => {
    const early = on(holidays, 30);
    expect(holidays.campaigns(early).holiday).toBeNull();
    expect(holidays.applyAction(early, start("businesses", 1_000, 10)).campaigns[0]!.holiday).toBeNull();
    const during = on(holidays, 61);
    expect(holidays.campaigns(during).holiday).toBeNull();
  });
});
