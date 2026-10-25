import { describe, expect, it } from "vitest";
import { playDay, STRATEGIES } from "../scripts/harness.ts";
import {
  configFields,
  createSim,
  defaultConfig,
  SimError,
  type Action,
  type DayLog,
  type GameConfig,
  type GameState,
  type Sim,
  type StaffGrade,
} from "../src/index.ts";

// Researchers and research points (#178), through the sim's public interface: researchers are hidden and refused until
// the first angel investor approaches, then open whatever the student makes of the angel; they're permanent hires only;
// and each day they earn research points (RP), by output and grade, banked with no cap.

const quiet: GameConfig = { ...defaultConfig, events: [] };
const sim = createSim(quiet);
const sensible = STRATEGIES.find((s) => s.id === "sensible")!;
const begin = (s: Sim = sim) => s.newGame({ companyName: "Lab Co", productType: "social", model: "saas", seed: 42 });

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return null;
};

/** Plays the sensible bot a tick at a time until `done`, keeping the log. */
function playUntil(s: Sim, state: GameState, done: (s: GameState) => boolean, most = 200) {
  const log: DayLog[] = [];
  let current = state;
  for (let i = 0; i < most && !done(current) && current.status === "playing"; i++) {
    const t = s.tick(playDay(s, current, sensible));
    current = t.state;
    log.push(...t.log);
  }
  return { state: current, log };
}

const approached = (s: Sim) => (state: GameState) => s.investors(state).offer !== null;
/** A game played until the first angel approaches, and the day before. */
function untilApproach(s: Sim = sim) {
  const { state, log } = playUntil(s, begin(s), approached(s));
  expect(approached(s)(state)).toBe(true);
  return { state, log };
}
const approach = untilApproach();

const hire = (grade: StaffGrade = "mid", count = 1, agency = false): Action => ({ type: "hire", pool: "researchers", grade, count, agency });
const researchers = (s: Sim, state: GameState) => s.staff(state).find((p) => p.pool === "researchers");

/** A grown-up company with the researchers given on the team already, and no RP yet. */
function withResearchers(counts: Partial<Record<StaffGrade, number>>, state = approach.state): GameState {
  return { ...state, researchPoints: 0, staff: { ...state.staff, researchers: { junior: 0, mid: 0, senior: 0, ...counts } } };
}

describe("researchers before the first angel approach", () => {
  it("are hidden, and research is locked", () => {
    let state = begin();
    for (let day = 0; day < 3; day++) {
      expect(researchers(sim, state)).toBeUndefined();
      expect(sim.research(state)).toEqual({ unlocked: false, unlockedDay: null, points: 0, pointsPerDay: 0 });
      state = sim.advance(state).state;
    }
  });

  it("are refused, permanent or agency, right up to the day before the approach", () => {
    const dayBefore = playUntil(sim, begin(), (s) => s.day === approach.state.day - 1).state;
    expect(sim.research(dayBefore).unlocked).toBe(false);
    expect(refusal(() => sim.applyAction(dayBefore, hire()))).toBe("not_yet");
    expect(refusal(() => sim.applyAction(dayBefore, hire("mid", 1, true)))).toBe("not_yet");
    expect(refusal(() => sim.applyAction(dayBefore, { type: "moveStaff", to: "researchers", from: "developers" }))).toBe("not_yet");
  });

  it("aren't on the starting team, whatever the config says", () => {
    const staffed = createSim({ ...quiet, staff: { ...quiet.staff, researchers: { ...quiet.staff.researchers, startingCount: 3 } } });
    const state = begin(staffed);
    expect(state.staff.researchers).toEqual({ junior: 0, mid: 0, senior: 0 });
    expect(staffed.dailyStaffCost(state)).toBe(sim.dailyStaffCost(begin()));
  });
});

describe("researchers once the first angel approaches", () => {
  it("open on the day of the approach, with a researchers row of 0 and no agency option, and say so in the log", () => {
    const { state, log } = approach;
    expect(sim.research(state)).toEqual({ unlocked: true, unlockedDay: state.day, points: 0, pointsPerDay: 0 });
    const row = researchers(sim, state)!;
    expect(row).toMatchObject({ name: "Researchers", headcount: 0, agencyCount: 0, output: 0, agencyAllowed: false, agency: [] });
    expect(row.grades.find((g) => g.grade === "mid")!.dayRate).toBe(80);
    // Every other pool but marketers (#180) still takes agency staff.
    expect(sim.staff(state).filter((p) => p.pool !== "researchers" && p.pool !== "marketers").every((p) => p.agencyAllowed)).toBe(true);
    const today = log.filter((d) => d.day === state.day).flatMap((d) => d.entries);
    expect(today.some((e) => e.text.includes("hire researchers"))).toBe(true);
    // Only the first approach says so.
    expect(log.flatMap((d) => d.entries).filter((e) => e.text.includes("hire researchers"))).toHaveLength(1);
  });

  it("can be hired with the usual grades, lead times and pay", () => {
    const hired = sim.applyAction(approach.state, hire("senior"));
    const lead = quiet.staffGrades.senior.leadDays;
    expect(researchers(sim, hired)!.hiring).toEqual([
      { grade: "senior", count: 1, agency: false, arrivesOn: approach.state.day + lead, daysLeft: lead },
    ]);
    const before = sim.dailyStaffCost(hired);
    const arrived = sim.advance(hired, lead).state;
    expect(arrived.staff.researchers.senior).toBe(1);
    expect(sim.dailyStaffCost(arrived) - before).toBe(Math.round(80 * quiet.staffGrades.senior.payMultiplier));
  });

  it("are let go with the usual severance", () => {
    const state = withResearchers({ mid: 2 });
    const after = sim.applyAction(state, { type: "letGo", pool: "researchers", grade: "mid" });
    expect(after.staff.researchers.mid).toBe(1);
    expect(state.cash - after.cash).toBe(80 * quiet.severance.days);
  });

  it("stay open when the angel is declined, and after", () => {
    const declined = sim.applyAction(approach.state, { type: "declineInvestor" });
    expect(sim.research(declined)).toMatchObject({ unlocked: true, unlockedDay: approach.state.day });
    const later = sim.advance(declined, 5).state;
    expect(researchers(sim, later)).toBeDefined();
    expect(sim.applyAction(later, hire()).hiring.at(-1)).toMatchObject({ pool: "researchers", grade: "mid" });
  });

  it("stay open when the angel is accepted", () => {
    const accepted = sim.applyAction(approach.state, { type: "acceptInvestor" });
    expect(sim.research(accepted).unlocked).toBe(true);
    expect(refusal(() => sim.applyAction(accepted, hire()))).toBeNull();
  });

  it("refuse agency hires of every grade", () => {
    for (const grade of ["junior", "mid", "senior"] as const) {
      expect(refusal(() => sim.applyAction(approach.state, hire(grade, 1, true))), grade).toBe("permanent_only");
    }
  });
});

describe("research points", () => {
  it("are earned each day from researcher output, 4 a mid", () => {
    const state = withResearchers({ mid: 3 });
    expect(sim.research(state).pointsPerDay).toBe(12);
    const after = sim.advance(state, 10).state;
    expect(after.researchPoints).toBe(120);
    expect(sim.research(after).points).toBe(120);
  });

  it("scale with grade output", () => {
    const { staffGrades } = quiet;
    for (const grade of ["junior", "mid", "senior"] as const) {
      const state = withResearchers({ [grade]: 1 });
      const perDay = Math.round(4 * staffGrades[grade].output * 100) / 100;
      expect(sim.research(state).pointsPerDay, grade).toBe(perDay);
      expect(sim.advance(state).state.researchPoints, grade).toBe(perDay);
    }
    const mixed = withResearchers({ junior: 2, mid: 1, senior: 1 });
    const output = 2 * staffGrades.junior.output + staffGrades.mid.output + staffGrades.senior.output;
    expect(sim.research(mixed).pointsPerDay).toBe(Math.round(4 * output * 100) / 100);
  });

  it("count researchers only once they start work", () => {
    const hired = sim.applyAction({ ...approach.state, researchPoints: 0 }, hire("mid"));
    const lead = quiet.staffGrades.mid.leadDays;
    expect(sim.advance(hired, lead - 1).state.researchPoints).toBe(0);
    expect(sim.advance(hired, lead).state.researchPoints).toBe(4);
  });

  it("bank with no cap", () => {
    const rich = { ...withResearchers({ senior: 5 }), researchPoints: 1_000_000, cash: 1_000_000 };
    const perDay = sim.research(rich).pointsPerDay;
    const after = sim.advance(rich, 30).state;
    expect(after.staff.researchers.senior).toBe(5);
    expect(after.researchPoints).toBeCloseTo(1_000_000 + 30 * perDay, 6);
  });

  it("aren't earned with no researchers", () => {
    expect(sim.advance(withResearchers({}), 10).state.researchPoints).toBe(0);
  });

  it("come from the config: RP per researcher and researcher pay", () => {
    const tuned = createSim({
      ...quiet,
      research: { pointsPerPerson: 5 },
      staff: { ...quiet.staff, researchers: { ...quiet.staff.researchers, dayRate: 200 } },
    });
    const state = withResearchers({ mid: 2 });
    expect(tuned.research(state).pointsPerDay).toBe(10);
    expect(tuned.advance(state, 3).state.researchPoints).toBe(30);
    expect(researchers(tuned, state)!.grades.find((g) => g.grade === "mid")!.dayRate).toBe(200);
    const paths = configFields().map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["research.pointsPerPerson", "staff.researchers.dayRate"]));
  });
});
