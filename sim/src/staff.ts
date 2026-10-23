import { STAFF_GRADES, STAFF_POOLS, type GameConfig, type StaffGrade, type StaffPool } from "./config.ts";
import { isStaffGrade, isStaffPool, SimError, type GameState, type GradeCounts, type LogEntry } from "./state.ts";

/** One grade in a pool: how many are on the team, what each costs and does, and how long a new one takes to start. */
export interface GradeView {
  grade: StaffGrade;
  name: string;
  count: number;
  /** Pay per person per day. */
  dayRate: number;
  /** Work a day per person, against a mid's 1. */
  output: number;
  leadDays: number;
}

/** Hires waiting to start. */
export interface HireView {
  grade: StaffGrade;
  count: number;
  /** The first day they work. */
  arrivesOn: number;
  /** Days still to play before they work: 1 means they start on the next day played. */
  daysLeft: number;
}

/** One pool: its grades, everyone on the team and their work, and the hires still to start. */
export interface StaffPoolView {
  pool: StaffPool;
  name: string;
  /** People on the team, every grade. */
  headcount: number;
  /** Their work a day in mids: what's measured against ops needed, a build's developer-days and tickets cleared. */
  output: number;
  grades: GradeView[];
  hiring: HireView[];
}

/** A grade's pay in a pool, to the pound. */
export const gradeDayRate = (config: GameConfig, pool: StaffPool, grade: StaffGrade) =>
  Math.round(config.staff[pool].dayRate * config.staffGrades[grade].payMultiplier);

/** No one in any grade. */
export const noStaff = (): GradeCounts => ({ junior: 0, mid: 0, senior: 0 });

/** People on the team in a pool, every grade. */
export const headcount = (state: GameState, pool: StaffPool) => STAFF_GRADES.reduce((sum, g) => sum + state.staff[pool][g], 0);

/** A pool's work a day in mids, to two decimal places so sums of grades compare cleanly against whole numbers. */
export function staffOutput(config: GameConfig, state: GameState, pool: StaffPool): number {
  const work = STAFF_GRADES.reduce((sum, g) => sum + state.staff[pool][g] * config.staffGrades[g].output, 0);
  return Math.round(work * 100) / 100;
}

/** What everyone on the team costs a day. Hires still to start cost nothing. */
export function dailyStaffCost(config: GameConfig, state: GameState): number {
  return STAFF_POOLS.reduce(
    (sum, pool) => sum + STAFF_GRADES.reduce((s, g) => s + state.staff[pool][g] * gradeDayRate(config, pool, g), 0),
    0,
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Staff: hiring by grade, the wait before hires start, letting go, moving people between pools, and their pay. */
export function createStaff(config: GameConfig) {
  const poolName = (pool: StaffPool) => config.staff[pool].name.toLowerCase();
  /** "2 junior developers", "1 senior ops person". */
  const people = (n: number, pool: StaffPool, grade: StaffGrade) =>
    `${n} ${config.staffGrades[grade].name.toLowerCase()} ${plural(n, config.staff[pool].personName, poolName(pool))}`;

  /** The company's opening team: each pool's starting count, all mids, on the team from day 1. */
  function startingStaff(): Pick<GameState, "staff" | "hiring"> {
    const staff = Object.fromEntries(
      STAFF_POOLS.map((pool) => [pool, { ...noStaff(), mid: config.staff[pool].startingCount }]),
    ) as Record<StaffPool, GradeCounts>;
    return { staff, hiring: [] };
  }

  function checkPoolAndGrade(pool: StaffPool, grade: StaffGrade) {
    if (!isStaffPool(pool)) throw new SimError("unknown_pool", "Pick developers, ops or support.");
    if (!isStaffGrade(grade)) throw new SimError("unknown_grade", "Pick junior, mid or senior.");
  }

  /**
   * Hires or lets go `count` people of a grade at once, one mid by default. Hires join the wait for their grade's lead
   * time. Letting go is of those on the team, at once; more than the grade has is refused.
   */
  function changeStaff(state: GameState, type: "hire" | "letGo", pool: StaffPool, grade: StaffGrade = "mid", count = 1): GameState {
    checkPoolAndGrade(pool, grade);
    if (!Number.isInteger(count) || count < 1) throw new SimError("bad_count", "Pick a whole number of people, at least 1.");
    if (type === "hire") {
      const { leadDays } = config.staffGrades[grade];
      // With no lead time (a teacher's config can set one), they join the team at once.
      if (leadDays === 0) return { ...state, staff: { ...state.staff, [pool]: { ...state.staff[pool], [grade]: state.staff[pool][grade] + count } } };
      // Hires of a grade on the same day start together, so they're one entry.
      const arrivesOn = state.day + leadDays;
      const same = (h: GameState["hiring"][number]) => h.pool === pool && h.grade === grade && h.arrivesOn === arrivesOn;
      const hiring = state.hiring.some(same)
        ? state.hiring.map((h) => (same(h) ? { ...h, count: h.count + count } : h))
        : [...state.hiring, { pool, grade, count, arrivesOn }];
      return { ...state, hiring };
    }
    const have = state.staff[pool][grade];
    const name = `${config.staffGrades[grade].name.toLowerCase()} ${poolName(pool)}`;
    if (have < 1) throw new SimError("no_staff", `You have no ${name} to let go.`);
    if (have < count) throw new SimError("no_staff", `You only have ${have} ${name} to let go.`);
    return { ...state, staff: { ...state.staff, [pool]: { ...state.staff[pool], [grade]: have - count } } };
  }

  /** Moves one person between pools, keeping their grade: a mid if `from` has one, unless a grade is given. */
  function moveStaff(
    state: GameState,
    to: StaffPool,
    from: StaffPool = to === "developers" ? "ops" : "developers",
    grade?: StaffGrade,
  ): GameState {
    if (!isStaffPool(to) || !isStaffPool(from)) throw new SimError("unknown_pool", "Pick developers, ops or support.");
    if (grade !== undefined && !isStaffGrade(grade)) throw new SimError("unknown_grade", "Pick junior, mid or senior.");
    if (from === to) throw new SimError("same_pool", "Pick two different teams to move someone between.");
    const moving = grade ?? (["mid", "junior", "senior"] as const).find((g) => state.staff[from][g] > 0);
    if (!moving || state.staff[from][moving] < 1) {
      const who = grade ? `${config.staffGrades[grade].name.toLowerCase()} ${poolName(from)}` : poolName(from);
      throw new SimError("no_staff", `You have no ${who} to move.`);
    }
    const fromCounts = { ...state.staff[from], [moving]: state.staff[from][moving] - 1 };
    const toCounts = { ...state.staff[to], [moving]: state.staff[to][moving] + 1 };
    return { ...state, staff: { ...state.staff, [from]: fromCounts, [to]: toCounts } };
  }

  /** Hires due by `day` join the team at the start of it, so they work and are paid that day. */
  function arrive(state: GameState, day: number): { state: GameState; entries: LogEntry[] } {
    const due = state.hiring.filter((h) => h.arrivesOn <= day);
    if (!due.length) return { state, entries: [] };
    const staff = Object.fromEntries(STAFF_POOLS.map((p) => [p, { ...state.staff[p] }])) as Record<StaffPool, GradeCounts>;
    for (const h of due) staff[h.pool][h.grade] += h.count;
    const entries: LogEntry[] = due.map((h) => ({
      text: `${people(h.count, h.pool, h.grade)} started work.`,
      cashDelta: 0,
      kind: "staff",
    }));
    return { state: { ...state, staff, hiring: state.hiring.filter((h) => h.arrivesOn > day) }, entries };
  }

  function staffEntries(state: GameState): LogEntry[] {
    return STAFF_POOLS.flatMap((pool) =>
      STAFF_GRADES.filter((g) => state.staff[pool][g] > 0).map((g): LogEntry => {
        const n = state.staff[pool][g];
        const grade = config.staffGrades[g].name.toLowerCase();
        return { text: `${config.staff[pool].name} pay (${n} ${grade}${plural(n, "", "s")})`, cashDelta: -n * gradeDayRate(config, pool, g), category: "staff" };
      }),
    );
  }

  function staffView(state: GameState): StaffPoolView[] {
    return STAFF_POOLS.map((pool) => ({
      pool,
      name: config.staff[pool].name,
      headcount: headcount(state, pool),
      output: staffOutput(config, state, pool),
      grades: STAFF_GRADES.map((grade) => {
        const { name, output, leadDays } = config.staffGrades[grade];
        return { grade, name, count: state.staff[pool][grade], dayRate: gradeDayRate(config, pool, grade), output, leadDays };
      }),
      hiring: state.hiring
        .filter((h) => h.pool === pool)
        .map(({ grade, count, arrivesOn }) => ({ grade, count, arrivesOn, daysLeft: arrivesOn - state.day })),
    }));
  }

  return {
    startingStaff,
    changeStaff,
    moveStaff,
    arrive,
    staffEntries,
    staffView,
    dailyStaffCost: (state: GameState) => dailyStaffCost(config, state),
  };
}
