import { STAFF_GRADES, STAFF_POOLS, type GameConfig, type StaffGrade, type StaffPool } from "./config.ts";
import { poolBoost } from "./executives.ts";
import { pounds, type createFinance } from "./finance.ts";
import { jobOpen } from "./phases.ts";
import { isStaffGrade, isStaffPool, SimError, type GameState, type GradeCounts, type LogEntry } from "./state.ts";

/** Pools that open once the company grows up, when the first angel investor approaches. */
const GROWN_UP_POOLS: readonly StaffPool[] = ["researchers", "marketers"];
/** Pools with permanent staff only: no agency hires. */
const PERMANENT_ONLY_POOLS: readonly StaffPool[] = ["researchers", "marketers"];

/** Whether a pool takes agency hires: researchers and marketers are permanent only. */
export const agencyAllowed = (pool: StaffPool) => !PERMANENT_ONLY_POOLS.includes(pool);

/** Pools a product can ever staff: every pool, except moderators on a product without user content. */
const productPools = (config: GameConfig, state: Pick<GameState, "productType">) =>
  STAFF_POOLS.filter((pool) => pool !== "moderators" || config.productTypes[state.productType].moderation !== undefined);

/**
 * Pools a company can staff now: every pool, except moderators on a product without user content, and any pool whose
 * phase hasn't opened yet (see phases.ts).
 */
export const poolsFor = (config: GameConfig, state: Pick<GameState, "productType" | "phase">): StaffPool[] =>
  productPools(config, state).filter((pool) => jobOpen(state, pool));

/**
 * One grade in a pool, as permanent or agency staff: how many are on the team, what each costs and does, and how long
 * a new one takes to start.
 */
export interface GradeView {
  grade: StaffGrade;
  name: string;
  count: number;
  /** Pay per person per day. */
  dayRate: number;
  /** Work a day per person, against a permanent mid's 1. */
  output: number;
  leadDays: number;
  /** Paid at once for each one let go: nothing for agency staff. */
  severance: number;
}

/** Hires waiting to start. */
export interface HireView {
  grade: StaffGrade;
  count: number;
  /** Agency staff, rather than permanent. */
  agency: boolean;
  /** The first day they work. */
  arrivesOn: number;
  /** Days still to play before they work: 1 means they start on the next day played. */
  daysLeft: number;
}

/** One pool: its grades, permanent and agency, everyone on the team and their work, and the hires still to start. */
export interface StaffPoolView {
  pool: StaffPool;
  name: string;
  /** Permanent staff on the team, every grade. */
  headcount: number;
  /** Agency staff on the team, every grade. */
  agencyCount: number;
  /**
   * Everyone's work a day in mids, agency staff's included: what's measured against ops needed, a build's
   * developer-days and tickets cleared.
   */
  output: number;
  /** Permanent staff by grade. */
  grades: GradeView[];
  /** Agency staff by grade: none for a pool that's permanent only. */
  agency: GradeView[];
  /** Whether agency staff can be hired: not researchers or marketers, who are permanent only. */
  agencyAllowed: boolean;
  /**
   * Whether the pool's phase has opened, so it can be hired into. A pool not open yet is listed only while someone is
   * in it (the ops and support a company starts with, in Build), and hidden otherwise.
   */
  open: boolean;
  hiring: HireView[];
  /** Why the pool has nothing to do, in a sentence, when it hasn't: developers with nothing to build. Null otherwise. */
  idle: string | null;
}

/**
 * Pay the pay reviews' rises leave alone: the C-suite keeps its own packages (see csuite.ts, whose pay never reads the
 * multiplier). Every staff pool takes the rise.
 */
export const NO_PAY_RISE: readonly string[] = ["csuite"];

/**
 * A grade's pay in a pool, to the pound: permanent, or through an agency, whose premium is on top. `payMultiplier` is
 * the pay reviews' rises so far (see GameState.payMultiplier), which every pool but the C-suite takes.
 */
export const gradeDayRate = (config: GameConfig, pool: StaffPool, grade: StaffGrade, agency = false, payMultiplier = 1) =>
  Math.round(
    config.staff[pool].dayRate *
      config.staffGrades[grade].payMultiplier *
      (agency ? config.agency.payMultiplier : 1) *
      (NO_PAY_RISE.includes(pool) ? 1 : payMultiplier),
  );

/** A grade's work a day against a permanent mid's: permanent, or through an agency. */
const gradeOutput = (config: GameConfig, grade: StaffGrade, agency = false) =>
  config.staffGrades[grade].output * (agency ? config.agency.output : 1);

/** Severance for one permanent member of a grade in a pool: days of their pay. */
export const severanceFor = (config: GameConfig, pool: StaffPool, grade: StaffGrade, payMultiplier = 1) =>
  gradeDayRate(config, pool, grade, false, payMultiplier) * config.severance.days;

/** No one in any grade. */
export const noStaff = (): GradeCounts => ({ junior: 0, mid: 0, senior: 0 });

/** Permanent staff on the team in a pool, every grade; or agency staff. */
export const headcount = (state: GameState, pool: StaffPool, agency = false) =>
  STAFF_GRADES.reduce((sum, g) => sum + (agency ? state.agency : state.staff)[pool][g], 0);

/**
 * A pool's work a day in mids, permanent and agency staff's together, to two decimal places so sums of grades compare
 * cleanly against whole numbers. A head of the pool in the C-suite lifts it (the head of development, ops or support;
 * the CTO for researchers).
 */
export function staffOutput(config: GameConfig, state: GameState, pool: StaffPool): number {
  const work = STAFF_GRADES.reduce(
    (sum, g) => sum + state.staff[pool][g] * gradeOutput(config, g) + state.agency[pool][g] * gradeOutput(config, g, true),
    0,
  );
  return Math.round(work * poolBoost(config, state, pool) * 100) / 100;
}

/** What everyone on the team, permanent and agency, costs a day. Hires still to start cost nothing. */
export function dailyStaffCost(config: GameConfig, state: GameState): number {
  return STAFF_POOLS.reduce(
    (sum, pool) =>
      sum +
      STAFF_GRADES.reduce(
        (s, g) =>
          s +
          state.staff[pool][g] * gradeDayRate(config, pool, g, false, state.payMultiplier) +
          state.agency[pool][g] * gradeDayRate(config, pool, g, true, state.payMultiplier),
        0,
      ),
    0,
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Staff: hiring by grade, permanent or through an agency, the wait before hires start, letting go and severance,
 * moving people between pools, and their pay.
 */
export function createStaff(config: GameConfig, finance: ReturnType<typeof createFinance>) {
  const poolName = (pool: StaffPool) => config.staff[pool].name.toLowerCase();
  /** "2 junior developers", "1 senior ops person", "1 agency mid developer". */
  const people = (n: number, pool: StaffPool, grade: StaffGrade, agency = false) =>
    `${n} ${agency ? "agency " : ""}${config.staffGrades[grade].name.toLowerCase()} ${plural(n, config.staff[pool].personName, poolName(pool))}`;
  const allPools = (make: (pool: StaffPool) => GradeCounts) =>
    Object.fromEntries(STAFF_POOLS.map((pool) => [pool, make(pool)])) as Record<StaffPool, GradeCounts>;

  /**
   * The company's opening team: each pool's starting count, all permanent mids, on the team from day 1. No agency
   * staff, no moderators on a product without user content and no researchers or marketers (not yet open), whatever the
   * config says.
   */
  function startingStaff(product: Pick<GameState, "productType">): Pick<GameState, "staff" | "agency" | "hiring"> {
    const pools = productPools(config, product).filter((pool) => !GROWN_UP_POOLS.includes(pool));
    const staff = allPools((pool) => ({ ...noStaff(), mid: pools.includes(pool) ? config.staff[pool].startingCount : 0 }));
    return { staff, agency: allPools(noStaff), hiring: [] };
  }

  const PICK_POOL = "Pick developers, ops, support, moderators, researchers or marketers.";

  /**
   * Moderators handle reports on user content, so a product without any has none to hire or move. A pool whose phase
   * hasn't opened can't be hired or moved into: applyAction refuses that (see phases.ts).
   */
  function checkContent(state: GameState, pool: StaffPool) {
    if (productPools(config, state).includes(pool)) return;
    const product = config.productTypes[state.productType].name;
    throw new SimError("no_content", `A ${product.toLowerCase()} has no user content to moderate, so it has no moderators.`);
  }

  function checkPoolAndGrade(state: GameState, pool: StaffPool, grade: StaffGrade) {
    if (!isStaffPool(pool)) throw new SimError("unknown_pool", PICK_POOL);
    if (!isStaffGrade(grade)) throw new SimError("unknown_grade", "Pick junior, mid or senior.");
    checkContent(state, pool);
  }

  /** The team with `delta` more of a grade in a pool, permanent or agency. */
  const adjusted = (state: GameState, pool: StaffPool, grade: StaffGrade, agency: boolean, delta: number): GameState => {
    const key = agency ? "agency" : "staff";
    return { ...state, [key]: { ...state[key], [pool]: { ...state[key][pool], [grade]: state[key][pool][grade] + delta } } };
  };

  /**
   * Hires or lets go `count` people of a grade at once, one permanent mid by default, or agency staff. Hires join the
   * wait for their grade's lead time, or the agency's. Letting go is of those on the team, at once; more than the grade
   * has is refused. Permanent staff are paid their severance as they go, refused if there isn't the cash for it.
   */
  function changeStaff(
    state: GameState,
    type: "hire" | "letGo",
    pool: StaffPool,
    grade: StaffGrade = "mid",
    count = 1,
    agency = false,
  ): GameState {
    checkPoolAndGrade(state, pool, grade);
    if (!Number.isInteger(count) || count < 1) throw new SimError("bad_count", "Pick a whole number of people, at least 1.");
    // Anything but true is permanent staff, as an API caller may send anything.
    const isAgency = agency === true;
    if (type === "hire" && isAgency && !agencyAllowed(pool)) {
      throw new SimError("permanent_only", `${config.staff[pool].name} are permanent hires only: an agency can't supply them.`);
    }
    if (type === "hire") {
      const leadDays = isAgency ? config.agency.leadDays : config.staffGrades[grade].leadDays;
      // With no lead time (a teacher's config can set one), they join the team at once.
      if (leadDays === 0) return adjusted(state, pool, grade, isAgency, count);
      // Hires of a grade on the same day start together, so they're one entry.
      const arrivesOn = state.day + leadDays;
      const same = (h: GameState["hiring"][number]) =>
        h.pool === pool && h.grade === grade && h.agency === isAgency && h.arrivesOn === arrivesOn;
      const hiring = state.hiring.some(same)
        ? state.hiring.map((h) => (same(h) ? { ...h, count: h.count + count } : h))
        : [...state.hiring, { pool, grade, count, agency: isAgency, arrivesOn }];
      return { ...state, hiring };
    }
    const have = (isAgency ? state.agency : state.staff)[pool][grade];
    const name = `${isAgency ? "agency " : ""}${config.staffGrades[grade].name.toLowerCase()} ${poolName(pool)}`;
    if (have < 1) throw new SimError("no_staff", `You have no ${name} to let go.`);
    if (have < count) throw new SimError("no_staff", `You only have ${have} ${name} to let go.`);
    const gone = adjusted(state, pool, grade, isAgency, -count);
    const severance = isAgency ? 0 : count * severanceFor(config, pool, grade, state.payMultiplier);
    if (severance === 0) return gone;
    if (severance > state.cash) {
      throw new SimError(
        "cant_afford",
        `Letting go ${people(count, pool, grade)} costs ${pounds(severance)} in severance, and you have ${pounds(state.cash)}.`,
        { cost: severance, cash: state.cash },
      );
    }
    return finance.chargeNow(gone, [{ text: `Severance for ${people(count, pool, grade)}`, cashDelta: -severance, category: "staff" }]);
  }

  /**
   * Cancels `count` hires of a grade still to start, permanent or agency, the latest first. They aren't paid until they
   * start, so it costs nothing. More than are waiting is refused.
   */
  function cancelHire(state: GameState, pool: StaffPool, grade: StaffGrade = "mid", count = 1, agency = false): GameState {
    checkPoolAndGrade(state, pool, grade);
    if (!Number.isInteger(count) || count < 1) throw new SimError("bad_count", "Pick a whole number of people, at least 1.");
    const isAgency = agency === true;
    const same = (h: GameState["hiring"][number]) => h.pool === pool && h.grade === grade && h.agency === isAgency;
    const waiting = state.hiring.filter(same).reduce((sum, h) => sum + h.count, 0);
    const name = `${isAgency ? "agency " : ""}${config.staffGrades[grade].name.toLowerCase()} ${poolName(pool)}`;
    if (waiting < 1) throw new SimError("no_hires", `You have no ${name} still to start.`);
    if (waiting < count) throw new SimError("no_hires", `You only have ${waiting} ${name} still to start.`);
    let left = count;
    const hiring = state.hiring
      .toReversed()
      .map((h) => {
        if (!same(h) || left === 0) return h;
        const cut = Math.min(left, h.count);
        left -= cut;
        return { ...h, count: h.count - cut };
      })
      .filter((h) => h.count > 0)
      .toReversed();
    return { ...state, hiring };
  }

  /**
   * Lets go every agency member of staff in a pool, or in every pool, and cancels agency hires still to start. Agency
   * staff go with no severance, so it costs nothing.
   */
  function letGoAgency(state: GameState, pool?: StaffPool): GameState {
    if (pool !== undefined && !isStaffPool(pool)) throw new SimError("unknown_pool", PICK_POOL);
    const pools = pool ? [pool] : STAFF_POOLS;
    const agency = allPools((p) => (pools.includes(p) ? noStaff() : { ...state.agency[p] }));
    const hiring = state.hiring.filter((h) => !(h.agency && pools.includes(h.pool)));
    return { ...state, agency, hiring };
  }

  /**
   * Moves one permanent member of staff between pools, keeping their grade: a mid if `from` has one, unless a grade is
   * given. Agency staff stay where the agency placed them.
   */
  function moveStaff(
    state: GameState,
    to: StaffPool,
    from: StaffPool = to === "developers" ? "ops" : "developers",
    grade?: StaffGrade,
  ): GameState {
    if (!isStaffPool(to) || !isStaffPool(from)) throw new SimError("unknown_pool", PICK_POOL);
    if (grade !== undefined && !isStaffGrade(grade)) throw new SimError("unknown_grade", "Pick junior, mid or senior.");
    checkContent(state, to);
    checkContent(state, from);
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
    const staff = allPools((p) => ({ ...state.staff[p] }));
    const agency = allPools((p) => ({ ...state.agency[p] }));
    for (const h of due) (h.agency ? agency : staff)[h.pool][h.grade] += h.count;
    const entries: LogEntry[] = due.map((h) => ({
      text: `${people(h.count, h.pool, h.grade, h.agency)} started work.`,
      cashDelta: 0,
      kind: "staff",
    }));
    return { state: { ...state, staff, agency, hiring: state.hiring.filter((h) => h.arrivesOn > day) }, entries };
  }

  /** A day's pay, a line for each grade in each pool: permanent staff, then agency staff. */
  function staffEntries(state: GameState): LogEntry[] {
    return STAFF_POOLS.flatMap((pool) =>
      [false, true].flatMap((agency) => {
        const counts = (agency ? state.agency : state.staff)[pool];
        return STAFF_GRADES.filter((g) => counts[g] > 0).map((g): LogEntry => {
          const n = counts[g];
          const grade = config.staffGrades[g].name.toLowerCase();
          const who = agency ? `Agency ${poolName(pool)}` : config.staff[pool].name;
          return { text: `${who} pay (${n} ${grade}${plural(n, "", "s")})`, cashDelta: -n * gradeDayRate(config, pool, g, agency, state.payMultiplier), category: "staff" };
        });
      }),
    );
  }

  function gradeViews(state: GameState, pool: StaffPool, agency: boolean): GradeView[] {
    return STAFF_GRADES.map((grade) => ({
      grade,
      name: config.staffGrades[grade].name,
      count: (agency ? state.agency : state.staff)[pool][grade],
      dayRate: gradeDayRate(config, pool, grade, agency, state.payMultiplier),
      output: Math.round(gradeOutput(config, grade, agency) * 100) / 100,
      leadDays: agency ? config.agency.leadDays : config.staffGrades[grade].leadDays,
      severance: agency ? 0 : severanceFor(config, pool, grade, state.payMultiplier),
    }));
  }

  /**
   * Pools the company can staff: no moderators on a product without user content, and a pool whose phase hasn't opened
   * only while someone is in it or on their way.
   */
  function staffView(state: GameState): StaffPoolView[] {
    const listed = (pool: StaffPool) =>
      jobOpen(state, pool) || headcount(state, pool) + headcount(state, pool, true) > 0 || state.hiring.some((h) => h.pool === pool);
    return productPools(config, state).filter(listed).map((pool) => ({
      pool,
      name: config.staff[pool].name,
      headcount: headcount(state, pool),
      agencyCount: headcount(state, pool, true),
      output: staffOutput(config, state, pool),
      grades: gradeViews(state, pool, false),
      agency: agencyAllowed(pool) ? gradeViews(state, pool, true) : [],
      agencyAllowed: agencyAllowed(pool),
      open: jobOpen(state, pool),
      hiring: state.hiring
        .filter((h) => h.pool === pool)
        .map(({ grade, count, agency, arrivesOn }) => ({ grade, count, agency, arrivesOn, daysLeft: arrivesOn - state.day })),
      idle: null,
    }));
  }

  return {
    startingStaff,
    changeStaff,
    cancelHire,
    letGoAgency,
    moveStaff,
    arrive,
    staffEntries,
    staffView,
    dailyStaffCost: (state: GameState) => dailyStaffCost(config, state),
  };
}
