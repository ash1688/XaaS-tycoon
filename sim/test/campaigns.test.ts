import { describe, expect, it } from "vitest";
import {
  configFields,
  createSim,
  CUSTOMER_TYPE_IDS,
  defaultConfig,
  SimError,
  type Action,
  type CustomerTypeId,
  type GameConfig,
  type GameState,
  type StaffGrade,
  type HolidayConfig,
  type Sim,
} from "../src/index.ts";
import { inPhase } from "./phases.ts";

// Campaigns (#115), through the sim's public interface: the student aims one at a customer type with a budget and a
// length; each day it spends its share and adds new users of that type directly, on top of normal growth, at about
// (budget ÷ length) ÷ the type's cost per user, scaled by how full the market is, the overlap with other campaigns on
// the type, and a bonus when started just before a holiday. They open at the first angel approach, never before the
// MVP is done, and show their spend, users brought in and cost per user as they run. Marketers (#180) run them, one
// campaign each, and the marketer's grade scales its users per pound. Each user a campaign brings in also grows the
// product's market for good (#200, brand awareness), up to a cap, so its users are extra and keep paying.

/** No events and no holidays, so the only thing moving a campaign is the campaign. */
// No pay reviews either: they have their own tests (payReview.test.ts).
// Launch presses itself, as Campaigns come after it: Launch has its own tests (mvp.test.ts).
const quiet: GameConfig = { ...defaultConfig, launch: { ...defaultConfig.launch, auto: 1 }, events: [], calendar: { ...defaultConfig.calendar, holidays: [] }, payReview: { ...defaultConfig.payReview, on: 0 } };
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

/**
 * A company the first angel has approached, opening Grow and Campaigns with it, with plenty of cash and the marketers
 * given on the team already: two mids, unless a test says otherwise.
 */
const grownUp = (state: GameState, marketers: Partial<Record<StaffGrade, number>> = { mid: 2 }): GameState => ({
  ...inPhase(state, "grow"),
  cash: 1_000_000,
  investors: { ...state.investors, firstApproachDay: state.day },
  staff: { ...state.staff, marketers: { junior: 0, mid: 0, senior: 0, ...marketers } },
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

/** The share of new users each pound still brings at a company's users, in the market its campaigns have grown. */
const saturation = (state: GameState) => 1 - state.users / (marketSize + state.campaigns.reduce((sum, c) => sum + c.marketAdded, 0));

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
    expect(refusal(() => sim.applyAction(state, start("businesses", 1_000, 10)))).toBe("no_marketer");
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
    expect(full).toBe(Math.floor((1_000 / costPerUser.casual) * 0.25));
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

describe("growing the market (#200)", () => {
  const { marketPerUser, marketGrowthCap } = quiet.campaigns;
  const cap = Math.floor(marketGrowthCap * marketSize);

  /** Plays a campaign to its end. */
  function playOut(state: GameState): GameState {
    let current = state;
    while (sim.campaigns(current).running > 0) current = sim.advance(current).state;
    return current;
  }

  it("adds marketPerUser to the market size for each user a campaign brings in", () => {
    expect(sim.campaigns(ready).market).toEqual({ base: marketSize, added: 0, cap, size: marketSize, perUser: marketPerUser });
    const played = sim.advance(sim.applyAction(ready, start("casual", 7_000, 7))).state;
    const { users, marketAdded } = sim.campaigns(played).campaigns[0]!;
    expect(users).toBeGreaterThan(400);
    expect(marketAdded).toBe(Math.round(users * marketPerUser));
    expect(sim.campaigns(played).market).toMatchObject({ added: marketAdded, size: marketSize + marketAdded });
    // The market page reaches as far.
    expect(sim.market(played).reach.size).toBe(marketSize + marketAdded);
  });

  it("stops growing the market at the cap, however many users campaigns bring", () => {
    const tuned = createSim({ ...quiet, campaigns: { ...quiet.campaigns, marketPerUser: 50 } });
    let state = sim.applyAction(ready, start("casual", 7_000, 7));
    state = tuned.advance(state).state;
    expect(tuned.campaigns(state).market).toMatchObject({ added: cap, size: marketSize + cap });
    // A second campaign still brings users, but adds nothing more to the market.
    state = playOut(state);
    state = tuned.advance(tuned.applyAction(state, start("enthusiasts", 7_000, 7))).state;
    const [second] = tuned.campaigns(state).campaigns;
    expect(second!.users).toBeGreaterThan(0);
    expect(second!.marketAdded).toBe(0);
    expect(tuned.campaigns(state).market.added).toBe(cap);
  });

  it("keeps the grown market after the campaign ends", () => {
    const done = playOut(sim.applyAction(ready, start("casual", 3_500, 7)));
    const { added } = sim.campaigns(done).market;
    expect(sim.campaigns(done).campaigns[0]).toMatchObject({ status: "finished", marketAdded: added });
    expect(added).toBeGreaterThan(1_000);
    expect(sim.campaigns(sim.advance(done, 30).state).market.added).toBe(added);
  });

  it("slows growth and campaigns by how full the grown market is, not the base one", () => {
    const done = playOut(sim.applyAction(ready, start("casual", 3_500, 7)));
    const { size } = sim.campaigns(done).market;
    expect(sim.campaigns(done).saturation).toBe(Math.round((1 - done.users / size) * 1e4) / 1e4);
    // The same company without the market its campaign grew fills up sooner, so gains fewer users the next day.
    const unGrown: GameState = { ...done, campaigns: done.campaigns.map((c) => ({ ...c, marketAdded: 0 })) };
    expect(sim.campaigns(unGrown).saturation).toBeLessThan(sim.campaigns(done).saturation);
    expect(sim.advance(done).state.users).toBeGreaterThan(sim.advance(unGrown).state.users);
  });

  it("is set in the config, with schema entries", () => {
    const paths = configFields().map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["campaigns.marketPerUser", "campaigns.marketGrowthCap"]));
    const off = createSim({ ...quiet, campaigns: { ...quiet.campaigns, marketPerUser: 0 } });
    const played = off.advance(off.applyAction(ready, start("casual", 7_000, 7))).state;
    expect(off.campaigns(played).market.added).toBe(0);
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

describe("marketers (#180)", () => {
  const marketersOf = (state: GameState) => sim.staff(state).find((p) => p.pool === "marketers");
  const hire = (grade: StaffGrade = "mid", agency = false): Action => ({ type: "hire", pool: "marketers", grade, count: 1, agency });
  const letGo = (grade: StaffGrade = "mid", count = 1): Action => ({ type: "letGo", pool: "marketers", grade, count });
  /** A launched company the first angel has approached, with the marketers given and no others. */
  const withMarketers = (marketers: Partial<Record<StaffGrade, number>>) => grownUp(launched(), marketers);

  it("are hidden and refused before the first angel approaches", () => {
    const state = { ...launched(), cash: 1_000_000 };
    expect(marketersOf(state)).toBeUndefined();
    expect(refusal(() => sim.applyAction(state, hire()))).toBe("not_yet");
    expect(refusal(() => sim.applyAction(state, { type: "moveStaff", to: "marketers", from: "developers" }))).toBe("not_yet");
    // None to start, whatever the config says.
    const staffed = createSim({ ...quiet, staff: { ...quiet.staff, marketers: { ...quiet.staff.marketers, startingCount: 3 } } });
    expect(begin(staffed).staff.marketers).toEqual({ junior: 0, mid: 0, senior: 0 });
  });

  it("can be hired once the first angel approaches, as permanent staff only, with the usual grades, lead times and severance", () => {
    const state = withMarketers({});
    const row = marketersOf(state)!;
    expect(row).toMatchObject({ name: "Marketers", headcount: 0, agencyCount: 0, agencyAllowed: false, agency: [] });
    const pay = (g: StaffGrade) => Math.round(110 * quiet.staffGrades[g].payMultiplier);
    expect(row.grades.map((g) => [g.grade, g.dayRate, g.leadDays, g.severance])).toEqual(
      (["junior", "mid", "senior"] as const).map((g) => [g, pay(g), quiet.staffGrades[g].leadDays, pay(g) * quiet.severance.days]),
    );
    for (const grade of ["junior", "mid", "senior"] as const) expect(refusal(() => sim.applyAction(state, hire(grade, true)))).toBe("permanent_only");
    const hired = sim.applyAction(state, hire("senior"));
    const lead = quiet.staffGrades.senior.leadDays;
    expect(marketersOf(hired)!.hiring).toEqual([{ grade: "senior", count: 1, agency: false, arrivesOn: state.day + lead, daysLeft: lead }]);
    expect(sim.advance(hired, lead).state.staff.marketers.senior).toBe(1);
  });

  it("are needed to start a campaign: one free marketer each, busy with it for its length", () => {
    const none = withMarketers({});
    expect(sim.campaigns(none)).toMatchObject({ unlocked: true, canStart: false, capacity: 0, marketers: { count: 0, free: 0, next: null } });
    expect(sim.campaigns(none).why).toBe("Each campaign needs a marketer to run it: hire one on People.");
    expect(refusal(() => sim.applyAction(none, start("casual", 1_000, 7)))).toBe("no_marketer");

    const one = withMarketers({ mid: 1 });
    expect(sim.campaigns(one)).toMatchObject({ canStart: true, capacity: 1, marketers: { count: 1, free: 1, next: "mid" } });
    let state = sim.applyAction(one, start("casual", 1_000, 7));
    expect(sim.campaigns(state)).toMatchObject({ canStart: false, running: 1, marketers: { count: 1, free: 0, next: null } });
    expect(sim.campaigns(state).why).toBe(
      "Your one marketer is running a campaign: hire another, or start one when a campaign finishes or is stopped.",
    );
    expect(refusal(() => sim.applyAction(state, start("enthusiasts", 1_000, 7)))).toBe("no_marketer");
    // Still busy before its last day, and free once it has finished.
    state = sim.advance(state, 6).state;
    expect(sim.campaigns(state).marketers.free).toBe(0);
    state = sim.advance(state).state;
    expect(sim.campaigns(state)).toMatchObject({ canStart: true, marketers: { free: 1 } });
  });

  it("are given to campaigns most senior first, and the grade shows on each", () => {
    let state = withMarketers({ junior: 1, mid: 1, senior: 1 });
    expect(sim.campaigns(state).marketers.next).toBe("senior");
    state = sim.applyAction(state, start("casual", 1_000, 7));
    expect(sim.campaigns(state).marketers.next).toBe("mid");
    state = sim.applyAction(state, start("enthusiasts", 1_000, 7));
    state = sim.applyAction(state, start("professionals", 1_000, 7));
    expect(sim.campaigns(state).campaigns.map((c) => [c.customerType, c.grade, c.gradeName])).toEqual([
      ["professionals", "junior", "Junior"],
      ["enthusiasts", "mid", "Mid"],
      ["casual", "senior", "Senior"],
    ]);
    expect(sim.campaigns(state).marketers.grades.map((g) => [g.grade, g.count, g.free])).toEqual([
      ["junior", 1, 0],
      ["mid", 1, 0],
      ["senior", 1, 0],
    ]);
  });

  it("scale users per pound by their grade's output", () => {
    const run = (grade: StaffGrade) => {
      const state = withMarketers({ [grade]: 1 });
      const played = sim.advance(sim.applyAction(state, start("casual", 7_000, 7))).state;
      return { state, brought: sim.campaigns(played).campaigns[0]!.users };
    };
    for (const grade of ["junior", "mid", "senior"] as const) {
      const { state, brought } = run(grade);
      const output = quiet.staffGrades[grade].output;
      expect(brought).toBe(Math.floor((1_000 / costPerUser.casual) * saturation(state) * output));
      // The estimate on the Marketing page is for the marketer a new campaign would get.
      const casual = sim.campaigns(state).types.find((t) => t.id === "casual")!;
      expect(casual.usersPerPound).toBeCloseTo((saturation(state) / costPerUser.casual) * output, 4);
    }
    expect(run("senior").brought).toBeGreaterThan(run("mid").brought);
    expect(run("mid").brought).toBeGreaterThan(run("junior").brought);
  });

  it("are flagged idle on the staff page while they aren't running a campaign", () => {
    expect(marketersOf(withMarketers({}))!.idle).toBeNull();
    let state = withMarketers({ mid: 2 });
    expect(marketersOf(state)!.idle).toBe("2 marketers aren't running a campaign: start one on Marketing, or let them go to save their pay.");
    state = sim.applyAction(state, start("casual", 1_000, 7));
    expect(marketersOf(state)!.idle).toBe("1 marketer isn't running a campaign: start one on Marketing, or let them go to save their pay.");
    state = sim.applyAction(state, start("enthusiasts", 1_000, 7));
    expect(marketersOf(state)!.idle).toBeNull();
    // Idle again once their campaigns end.
    expect(marketersOf(sim.advance(state, 7).state)!.idle).toMatch(/^2 marketers aren't/);
  });

  it("can't be let go or moved by the student while running a campaign: stop it first, or pick a free one", () => {
    let state = withMarketers({ mid: 2, senior: 1 });
    state = sim.applyAction(state, start("casual", 1_000, 10));
    state = sim.applyAction(state, start("enthusiasts", 1_000, 10));
    state = sim.advance(state, 2).state;
    const byGrade = (g: StaffGrade) => sim.campaigns(state).campaigns.find((c) => c.grade === g)!;
    // The senior is busy, and one of the two mids.
    expect(refusal(() => sim.applyAction(state, letGo("senior")))).toBe("marketer_busy");
    expect(refusal(() => sim.applyAction(state, letGo("mid", 2)))).toBe("marketer_busy");
    const moveSenior: Action = { type: "moveStaff", from: "marketers", to: "developers", grade: "senior" };
    expect(refusal(() => sim.applyAction(state, moveSenior))).toBe("marketer_busy");
    // The free mid can go, or move.
    expect(sim.applyAction(state, letGo("mid")).staff.marketers.mid).toBe(1);
    expect(sim.applyAction(state, { type: "moveStaff", from: "marketers", to: "developers", grade: "mid" }).staff.marketers.mid).toBe(1);
    // Stopping the senior's campaign frees them to go, and the mid's keeps running.
    const stopped = sim.applyAction(state, { type: "stopCampaign", id: byGrade("senior").id });
    const gone = sim.applyAction(stopped, letGo("senior"));
    expect(gone.staff.marketers.senior).toBe(0);
    const mid = byGrade("mid");
    expect(sim.campaigns(sim.advance(gone).state).campaigns.find((c) => c.id === mid.id)).toMatchObject({ status: "running", daysRun: 3 });
  });

  it("stop their campaigns when a rescue's cuts let them go", () => {
    // Little cash and big campaigns, so cash runs out and the vulture VC's cuts take a quarter of each team.
    let state: GameState = { ...withMarketers({ senior: 4 }), cash: 20_000 };
    for (const t of ["casual", "enthusiasts", "professionals", "businesses"] as const) state = sim.applyAction(state, start(t, 5_000, 30));
    const texts: string[] = [];
    for (let i = 0; i < 60 && !state.rescue; i++) {
      const played = sim.advance(state);
      state = played.state;
      texts.push(...played.log.flatMap((d) => d.entries.map((e) => e.text)));
    }
    expect(state.rescue).not.toBeNull();
    expect(state.staff.marketers.senior).toBe(3);
    const ended = sim.campaigns(state).campaigns.filter((c) => c.status === "stopped");
    // The newest of them stops, after the day just played.
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ customerType: "businesses", endDay: state.day });
    expect(texts).toContain("Your campaign for businesses has stopped: its marketer has gone.");
    expect(sim.campaigns(state)).toMatchObject({ running: 3, marketers: { count: 3, free: 0 } });
  });

  it("are paid from the config, with schema entries", () => {
    const tuned = createSim({ ...quiet, staff: { ...quiet.staff, marketers: { ...quiet.staff.marketers, dayRate: 200 } } });
    const state = grownUp(launched(tuned), {});
    expect(tuned.staff(state).find((p) => p.pool === "marketers")!.grades.find((g) => g.grade === "mid")!.dayRate).toBe(200);
    const paths = configFields().map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["staff.marketers.dayRate", ...CUSTOMER_TYPE_IDS.map((t) => `campaigns.costPerUser.${t}`)]));
    expect(paths).not.toContain("campaigns.maxRunning");
  });
});
