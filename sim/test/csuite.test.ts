import { describe, expect, it } from "vitest";
import { runScript } from "../scripts/textPlay.ts";
import {
  createSim,
  CSUITE_ROLES,
  defaultConfig,
  SimError,
  type CsuiteRole,
  type GameConfig,
  type GameState,
  type Sim,
} from "../src/index.ts";
import { allOpen, inPhase } from "./phases.ts";

// The C-suite through the sim's public interface: roles opening as the company grows, shortlists, hiring for good with
// equity under the cap, each role's effect through the seam it plugs into, and executives' pay, with the board's pay
// holiday when cash runs low. The IPO's full C-suite line is in ipo.test.ts's checklist.

const quiet: GameConfig = {
  ...defaultConfig,
  startingCash: 1_000_000,
  events: [],
  // No pay reviews, which hold the clock: the head of people's tests turn them back on.
  payReview: { ...defaultConfig.payReview, on: 0 },
};
const sim = createSim(quiet);
/** No MVP to build, so a company launches (and runs servers, bills and outages) from day 1. */
const NO_MVP = { ...quiet.mvp, baseDevDays: { ecommerce: 0, social: 0, video: 0, payments: 0, assistant: 0, games: 0 } };
const begin = (s: Sim = sim, model = "saas", seed = 42) => s.newGame({ companyName: "Acme", productType: "social", model, seed });
/** A new game with every role open: in Scale (#236), for tests about an executive rather than when their role opens. */
const opened = (s: Sim = sim) => allOpen(begin(s));

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return null;
};

const roleView = (s: Sim, state: GameState, role: CsuiteRole) => s.csuite(state).roles.find((r) => r.role === role)!;

/** The state as if the first angel investor had approached today, opening Grow: the CFO, CTO and head of people open. */
const angelApproached = (state: GameState): GameState =>
  inPhase({ ...state, investors: { ...state.investors, firstApproachDay: state.day } }, "grow");
/** The state as if Series A had approached today (and the angel before it), opening Scale: every role is open. */
const seriesAApproached = (state: GameState): GameState => {
  const angel = angelApproached(state);
  return inPhase(
    {
      ...angel,
      investors: { ...angel.investors, vc: { ...angel.investors.vc, firstApproachDay: { ...angel.investors.vc.firstApproachDay, seriesA: state.day } } },
    },
    "scale",
  );
};

/** Hires a role's candidate, the strongest unless another place on the shortlist is given (0 = first listed). */
function hire(s: Sim, state: GameState, role: CsuiteRole, which: "strongest" | "weakest" | number = "strongest"): GameState {
  const list = state.csuite.shortlists[role];
  const byStrength = [...list].sort((a, b) => a.strength - b.strength);
  const candidate = which === "strongest" ? byStrength.at(-1)! : which === "weakest" ? byStrength[0]! : list[which]!;
  return s.applyAction(state, { type: "hireExecutive", role, candidate: candidate.id });
}

/** The state with a small app server and database rented, so a company on IaaS can launch. */
const withServers = (s: Sim, state: GameState) =>
  s.applyAction(s.applyAction(state, { type: "rentServer", server: "app", size: "small" }), { type: "rentServer", server: "database", size: "small" });

/** The hired executive's figure for one of their effects. */
const effect = (s: Sim, state: GameState, role: CsuiteRole, key: string) =>
  roleView(s, state, role).executive!.effects.find((e) => e.key === key)!.value;

describe("roles and shortlists", () => {
  it("opens no role on day 1, the heads of development, ops and support only in Scale, each with three candidates who vary", () => {
    const state = begin();
    const view = sim.csuite(state);
    expect(view.roles.map((r) => r.role)).toEqual([...CSUITE_ROLES]);
    // The heads opened from day 1 until the phases (#236): now they open with the rest in Scale.
    expect(view.roles.filter((r) => r.open).map((r) => r.role)).toEqual([]);
    expect(roleView(sim, state, "headOfOps").opens).toBe("Opens in the Scale phase, when Series A venture capitalists approach.");
    expect(refusal(() => hire(sim, state, "headOfOps"))).toBe("role_not_open");
    // In Scale every role is open, its shortlist showing.
    for (const r of sim.csuite(opened()).roles) expect(r).toMatchObject({ open: true, openDay: 1, shortlist: state.csuite.shortlists[r.role] });
    for (const r of view.roles) {
      const list = state.csuite.shortlists[r.role];
      expect(list).toHaveLength(3);
      // One from each band of strength, so a shortlist always has a strong candidate and a cheap one.
      expect([...list.map((c) => Math.floor(c.strength * 3 - 1e-9))].sort()).toEqual([0, 1, 2]);
      expect(new Set(list.map((c) => c.salary)).size).toBeGreaterThan(1);
      const { salary, equity } = quiet.csuite.roles[r.role];
      for (const c of list) {
        expect(c.salary).toBeGreaterThanOrEqual(salary.min);
        expect(c.salary).toBeLessThanOrEqual(salary.max);
        expect(c.equity).toBeGreaterThanOrEqual(equity.min);
        expect(c.equity).toBeLessThanOrEqual(equity.max);
      }
      // The shortlist shows while the role is open and unfilled.
      expect(r.shortlist).toHaveLength(r.open ? 3 : 0);
    }
    // Every candidate in the game has a name of their own.
    const names = Object.values(state.csuite.shortlists).flat().map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    // The same seed draws the same shortlists.
    expect(begin().csuite).toEqual(state.csuite);
    expect(begin(sim, "saas", 7).csuite).not.toEqual(state.csuite);
  });

  it("opens the CFO on outside money, friends and family or the grant, but not the bank loan", () => {
    const state = begin();
    expect(roleView(sim, state, "cfo")).toMatchObject({ open: false, openDay: null });
    expect(refusal(() => hire(sim, state, "cfo"))).toBe("role_not_open");
    const borrowed = sim.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 42, takeLoan: true });
    expect(roleView(sim, borrowed, "cfo").open).toBe(false);
    for (const funder of ["friendsAndFamily", "grant"] as const) {
      const funded = sim.applyAction(state, { type: "acceptFunding", funder });
      expect(roleView(sim, funded, "cfo")).toMatchObject({ open: true, openDay: 1 });
      expect(roleView(sim, funded, "cto").open).toBe(false);
    }
    const declined = sim.applyAction(state, { type: "declineFunding", funder: "grant" });
    expect(roleView(sim, declined, "cfo").open).toBe(false);
  });

  it("opens the CFO, CTO and head of people when the first angel approaches, saying so in the log", () => {
    const early = createSim({
      ...quiet,
      launch: { ...quiet.launch, auto: 1 },
      investors: { ...quiet.investors, angel: { ...quiet.investors.angel, target: { dailyRevenue: 300, days: 3 } } },
    });
    let state = begin(early);
    const lines: string[] = [];
    while (state.investors.firstApproachDay === null && state.day < 150) {
      const played = early.advance(state);
      state = played.state;
      lines.push(...played.log.flatMap((d) => d.entries.map((e) => e.text)));
    }
    expect(state.investors.firstApproachDay).toBe(state.day);
    // The angel's approach opens Grow (#236), and with it these three: the heads wait for Scale.
    expect(state).toMatchObject({ phase: "grow", phaseDays: { grow: state.day } });
    const open = early.csuite(state).roles.filter((r) => r.open);
    expect(open.map((r) => r.role)).toEqual(["cfo", "cto", "headOfPeople"]);
    expect(open.filter((r) => r.openDay === state.day).map((r) => r.role)).toEqual(["cfo", "cto", "headOfPeople"]);
    expect(lines.filter((l) => l.startsWith("You can hire a"))).toEqual([
      "You can hire a CFO now: 3 candidates are on the shortlist on the C-suite page.",
      "You can hire a CTO now: 3 candidates are on the shortlist on the C-suite page.",
      "You can hire a Head of people now: 3 candidates are on the shortlist on the C-suite page.",
    ]);
  });

  it("opens the heads, COO, CIO, CMO, CISO and legal counsel when Series A approaches, taken or not", () => {
    const state = angelApproached(begin());
    expect(sim.csuite(state).roles.filter((r) => !r.open).map((r) => r.role)).toEqual([
      "headOfDevelopment",
      "headOfOps",
      "headOfSupport",
      "cmo",
      "coo",
      "cio",
      "ciso",
      "legalCounsel",
    ]);
    const approached = seriesAApproached(begin());
    expect(sim.csuite(approached).roles.every((r) => r.open)).toBe(true);
    expect(roleView(sim, approached, "ciso")).toMatchObject({ opens: "Opens in the Scale phase, when Series A venture capitalists approach." });
    // Every role is needed to float, so no role's blurb singles itself out.
    expect(sim.csuite(approached).roles.filter((r) => /IPO|float/.test(r.blurb))).toEqual([]);
  });

  it("refuses an unknown role or candidate, and a role already filled", () => {
    const state = opened();
    expect(refusal(() => sim.applyAction(state, { type: "hireExecutive", role: "ceo" as CsuiteRole, candidate: "ceo-1" }))).toBe("unknown_role");
    expect(refusal(() => sim.applyAction(state, { type: "hireExecutive", role: "headOfOps", candidate: "cfo-1" }))).toBe("unknown_candidate");
    const hired = hire(sim, state, "headOfOps", 0);
    expect(refusal(() => hire(sim, hired, "headOfOps", 1))).toBe("role_filled");
    expect(roleView(sim, hired, "headOfOps")).toMatchObject({ shortlist: [], executive: { name: state.csuite.shortlists.headOfOps[0]!.name } });
  });
});

describe("pay and equity", () => {
  it("pays a salary a day from the next day played, and the equity ask at once in new shares", () => {
    const state = opened();
    const candidate = state.csuite.shortlists.headOfDevelopment[0]!;
    const before = sim.capTable(state);
    const hired = hire(sim, state, "headOfDevelopment", 0);
    const executive = hired.csuite.hired[0]!;
    expect(executive).toMatchObject({ role: "headOfDevelopment", name: candidate.name, salary: candidate.salary, equity: candidate.equity, day: 1 });
    expect(executive.shares).toBe(Math.round((before.sharesInIssue * candidate.equity) / (1 - candidate.equity)));
    const row = sim.capTable(hired).rows.find((r) => r.id === "executive")!;
    expect(row).toMatchObject({ name: `${candidate.name} (Head of development)`, shares: executive.shares });
    expect(row.share).toBeCloseTo(candidate.equity, 4);
    expect(hired.cash).toBe(state.cash);
    expect(sim.runway(hired).dailyCosts - sim.runway(state).dailyCosts).toBe(candidate.salary);
    const day = sim.advance(hired).log[0]!.entries;
    expect(day.find((e) => e.text === `Head of development pay (${candidate.name})`)).toMatchObject({ cashDelta: -candidate.salary, category: "staff" });
    expect(day.map((e) => e.text)).toContain(
      `${candidate.name} joined as Head of development for £${candidate.salary} a day and ${executive.shares.toLocaleString("en-GB")} new shares (${Math.round(candidate.equity * 1000) / 10}%).`,
    );
    expect(sim.csuite(hired).dailyPay).toBe(candidate.salary);
  });

  it("shrinks every ask as the 10% cap fills, so the C-suite's equity never passes it", () => {
    let state = seriesAApproached(begin());
    expect(sim.csuite(state)).toMatchObject({ equityCap: 0.1, equityUsed: 0, equityLeft: 0.1 });
    for (const role of CSUITE_ROLES) {
      const view = sim.csuite(state);
      const shortlist = roleView(sim, state, role).shortlist;
      for (const c of shortlist) expect(c.equity).toBeCloseTo((c.baseEquity * view.equityLeft) / 0.1, 4);
      state = hire(sim, state, role);
      const after = sim.csuite(state);
      expect(after.equityUsed).toBeGreaterThan(view.equityUsed - 1e-9);
      expect(after.equityUsed).toBeLessThanOrEqual(0.1);
    }
    // The asks added up to more than the cap, but what was taken stayed under it.
    const asked = CSUITE_ROLES.reduce((sum, role) => sum + Math.max(...state.csuite.shortlists[role].map((c) => c.equity)), 0);
    expect(asked).toBeGreaterThan(0.1);
    expect(sim.csuite(state).equityUsed).toBeLessThan(0.1);
  });

  it("leaves the staff share scheme out of the cap", () => {
    const state = opened();
    const withScheme: GameState = { ...state, shareholders: [...state.shareholders, { id: "staffScheme", shares: 5_000, day: 1 }] };
    const asks = (s: GameState) => roleView(sim, s, "headOfOps").shortlist.map((c) => c.equity);
    expect(asks(withScheme)).toEqual(asks(state));
    expect(sim.csuite(withScheme).equityLeft).toBe(0.1);
    // The new shares still make up the same share of a company with the scheme's shares in it.
    const hired = hire(sim, withScheme, "headOfOps", 0);
    expect(sim.capTable(hired).rows.find((r) => r.id === "executive")!.share).toBeCloseTo(state.csuite.shortlists.headOfOps[0]!.equity, 4);
  });

  it("has no let-go action, and pay review rises leave executives' pay alone", () => {
    const hired = hire(sim, opened(), "headOfSupport", 0);
    const salary = hired.csuite.hired[0]!.salary;
    expect(refusal(() => sim.applyAction(hired, { type: "letGo", pool: "csuite" as never }))).toBe("unknown_pool");
    // After rises that put staff pay up 50%, the executive is still paid their own package.
    const risen = { ...hired, payMultiplier: 1.5 };
    const day = sim.advance(risen).log[0]!.entries;
    expect(day.find((e) => e.text.startsWith("Head of support pay"))!.cashDelta).toBe(-salary);
    expect(sim.runway(risen).dailyCosts - sim.runway({ ...opened(), payMultiplier: 1.5 }).dailyCosts).toBe(salary);
  });

  it("keeps executives through a rescue buyout's cost cuts", () => {
    const hired = hire(sim, opened(), "headOfOps", 0);
    const broke = { ...hired, cash: 10 };
    let state = broke;
    while (state.rescue === null && state.day < 30) state = sim.advance(state).state;
    expect(state.rescue).not.toBeNull();
    expect(state.csuite.hired.map((e) => e.role)).toEqual(["headOfOps"]);
    // Still on the payroll: paid again once the board's pay holiday ends with cash back.
    const recovered = sim.advance({ ...state, cash: 100_000 }).state;
    expect(sim.advance(recovered).log[0]!.entries.some((e) => e.text.startsWith("Head of ops pay"))).toBe(true);
  });
});

describe("the board's pay holiday", () => {
  /** Two executives hired, and cash set to this many days of running costs (their pay included). */
  const withCash = (days: number, s: Sim = sim): GameState => {
    const hired = hire(s, hire(s, opened(s), "headOfOps", 0), "headOfSupport", 0);
    return { ...hired, cash: Math.round(days * s.runway(hired).dailyCosts) };
  };
  const pay = (state: GameState) => state.csuite.hired.reduce((sum, e) => sum + e.salary, 0);
  const payLines = (log: { entries: { text: string; cashDelta: number }[] }[]) =>
    log[0]!.entries.filter((e) => /^Head of (ops|support) pay \(/.test(e.text));

  it("starts when cash falls below 7 days of running costs: no executive is paid from the next day", () => {
    const low = withCash(5);
    const first = sim.advance(low);
    // The day it starts, executives are still paid; the board decides at the day's end.
    expect(payLines(first.log)).toHaveLength(2);
    expect(first.state.csuite.payHolidaySince).toBe(first.state.day);
    expect(first.log[0]!.entries.map((e) => e.text)).toContain(
      `Cash is low: your C-suite will forgo their £${pay(low).toLocaleString("en-GB")} a day of pay from tomorrow until the company has 21 days of running costs in the bank. What they forgo is owed, and paid back once cash recovers.`,
    );
    expect(sim.csuite(first.state).payHoliday).toEqual({ since: first.state.day, startDays: 7, endDays: 21, backPayDays: 14, walkoutDays: 30, walkoutEvery: 7, owed: 0 });
    expect(sim.runway(first.state).dailyCosts).toBe(sim.runway(low).dailyCosts - pay(low));
    const next = sim.advance(first.state);
    expect(payLines(next.log)).toEqual([]);
    expect(next.state.csuite.payHolidaySince).toBe(first.state.day);
    // The day's skipped pay is owed (#290).
    expect(sim.csuite(next.state).payHoliday.owed).toBe(pay(low));
  });

  it("ends once cash is back above 21 days, then pays back pay in instalments as cash recovers, never under the 7-day line", () => {
    const on = sim.advance(withCash(5)).state;
    const costs = sim.runway(withCash(0)).dailyCosts;
    // Between the two thresholds the holiday goes on, the pay skipped is owed, and no back pay is paid.
    const between = sim.advance({ ...on, cash: Math.round(14 * costs) });
    expect(between.state.csuite.payHolidaySince).toBe(on.csuite.payHolidaySince);
    expect(between.state.csuite.payOwed).toBe(pay(on));
    expect(between.log[0]!.entries.some((e) => e.text.startsWith("Back pay"))).toBe(false);
    // A long holiday's worth owed, and cash back above 21 days: it ends, and pays a fourteenth of the cash above 7 days.
    const owedBefore = 60 * pay(on);
    const recovered = sim.advance({ ...between.state, cash: Math.round(25 * costs), csuite: { ...between.state.csuite, payOwed: owedBefore } });
    expect(recovered.state.csuite.payHolidaySince).toBeNull();
    const texts = recovered.log[0]!.entries.map((e) => e.text);
    expect(texts).toContain(`Cash has recovered: your C-suite's £${pay(on).toLocaleString("en-GB")} a day of pay starts again tomorrow.`);
    const instalment = (log: typeof recovered.log) => -(log[0]!.entries.find((e) => e.text.startsWith("Back pay: paid "))?.cashDelta ?? 0);
    const first = instalment(recovered.log);
    const line = 7 * sim.runway(recovered.state).dailyCosts;
    expect(first).toBeGreaterThan(0);
    expect(first).toBe(Math.floor((recovered.state.cash + first - line) / 14));
    expect(recovered.log[0]!.entries.find((e) => e.text.startsWith("Back pay: paid "))).toMatchObject({
      text: `Back pay: paid £${first.toLocaleString("en-GB")} to the C-suite, £${(owedBefore + pay(on) - first).toLocaleString("en-GB")} still owed`,
      category: "staff",
    });
    expect(sim.csuite(recovered.state).payHoliday.owed).toBe(owedBefore + pay(on) - first);
    // Day after day it pays down what's owed, never taking cash under the 7-day line or starting another holiday. The
    // company makes what a day costs, so only the back pay moves cash.
    let state = recovered.state;
    for (let i = 0; i < 20; i++) {
      const day = sim.advance({ ...state, cash: state.cash + sim.runway(state).dailyCosts });
      const paid = instalment(day.log);
      expect(day.state.cash).toBeGreaterThanOrEqual(7 * sim.runway(day.state).dailyCosts - 1);
      expect(day.state.csuite.payHolidaySince ?? null).toBeNull();
      expect(day.state.csuite.payOwed).toBe(state.csuite.payOwed! - paid);
      state = day.state;
    }
    expect(state.csuite.payOwed).toBeLessThan(recovered.state.csuite.payOwed!);
    // With plenty of cash it's all paid, and the line says so.
    const rich = sim.advance({ ...state, cash: 10_000 * costs });
    expect(rich.log[0]!.entries.map((e) => e.text)).toContain(`Back pay: paid £${state.csuite.payOwed!.toLocaleString("en-GB")} to the C-suite, all of it now`);
    expect(rich.state.csuite.payOwed).toBe(0);
  });

  it("takes the back pay still owed off the cash when the game ends, so a pay holiday saves nothing (#290)", () => {
    const on = sim.advance(withCash(5)).state;
    const later = sim.advance(on, 3).state;
    const owed = later.csuite.payOwed!;
    expect(owed).toBe(3 * pay(on));
    const ended = sim.endGame(later);
    expect(ended.cash).toBe(later.cash - owed);
    expect(ended.csuite.payOwed).toBe(0);
  });

  it("doesn't start between the thresholds, without executives, or when turned off", () => {
    expect(sim.advance(withCash(14)).state.csuite.payHolidaySince ?? null).toBeNull();
    const nobody = { ...begin(), cash: 100 };
    expect(sim.advance(nobody).state.csuite.payHolidaySince ?? null).toBeNull();
    const off = createSim({ ...quiet, csuite: { ...quiet.csuite, payHoliday: { startDays: 0, endDays: 0, backPayDays: 14, walkoutDays: 30, walkoutEvery: 7 } } });
    expect(off.advance(withCash(5, off)).state.csuite.payHolidaySince ?? null).toBeNull();
    expect(off.csuite(begin(off)).payHoliday).toEqual({ since: null, startDays: 0, endDays: 0, backPayDays: 14, walkoutDays: 30, walkoutEvery: 7, owed: 0 });
  });

  it("shows in text play", () => {
    const who = { player: "test" };
    const on = sim.advance(withCash(5)).state;
    expect(runScript(sim, on, "csuite", who).lines.join("\n")).toMatch(
      new RegExp(`pay holiday: since day ${on.day}, cash is low, so no executive is paid until cash is back above 21 days`),
    );
    expect(runScript(sim, begin(), "csuite", who).lines.join("\n")).toMatch(/pay holiday: if cash falls below 7 days of running costs/);
  });
});

describe("walkouts on a long pay holiday", () => {
  /** Two executives, the head of ops hired a day before the head of support, with cash this many days of costs. */
  const board = (days: number): GameState => {
    const hired = hire(sim, hire(sim, opened(), "headOfOps", 0), "headOfSupport", 0);
    const staggered = { ...hired, csuite: { ...hired.csuite, hired: hired.csuite.hired.map((e, i) => (i === 0 ? { ...e, day: e.day - 1 } : e)) } };
    return { ...staggered, cash: Math.round(days * sim.runway(staggered).dailyCosts) };
  };
  const costs = sim.runway(board(0)).dailyCosts;
  /** Plays days on the holiday, cash held at 10 days of costs so it neither ends nor runs out. */
  const onHoliday = (state: GameState, days: number) => {
    const logs: { day: number; unpaid: number; texts: string[]; state: GameState }[] = [];
    for (let i = 0; i < days; i++) {
      const { state: next, log } = sim.advance({ ...state, cash: Math.round(10 * costs) });
      logs.push({ day: next.day, unpaid: next.day - (next.csuite.payHolidaySince ?? next.day), texts: log[0]!.entries.map((e) => e.text), state: next });
      state = next;
    }
    return logs;
  };
  const resignedOn = (logs: ReturnType<typeof onHoliday>) => logs.filter((l) => l.texts.some((t) => / has resigned after /.test(t)));

  it("warns at 25 days unpaid, then from the 31st the most recent hire resigns, and one more every 7 days", () => {
    const start = sim.advance(board(5)).state;
    expect(start.csuite.payHolidaySince).toBe(start.day);
    const logs = onHoliday(start, 40);
    // No walkout up to 30 days unpaid.
    expect(resignedOn(logs).map((l) => l.unpaid)).toEqual([31, 38]);
    expect(logs.find((l) => l.unpaid === 25)!.texts).toContain(
      "The C-suite has gone 25 days unpaid; from day 30 one will resign each week until they're paid.",
    );
    // The head of support, hired last, goes first; then the head of ops.
    const first = resignedOn(logs)[0]!;
    const support = start.csuite.hired.find((e) => e.role === "headOfSupport")!;
    expect(first.texts.find((t) => t.includes("has resigned"))).toMatch(
      new RegExp(`^${support.name}, your head of support, has resigned after 31 days without pay\\. £[\\d,]+ back pay is now owed to the bank\\.$`),
    );
    expect(first.state.csuite.hired.map((e) => e.role)).toEqual(["headOfOps"]);
    expect(resignedOn(logs)[1]!.state.csuite.hired).toEqual([]);
    // Their shares stay on the cap table, and the role opens again with its shortlist, so it can be filled again.
    expect(first.state.shareholders.filter((h) => h.id === "executive")).toEqual(start.shareholders.filter((h) => h.id === "executive"));
    const role = sim.csuite(first.state).roles.find((r) => r.role === "headOfSupport")!;
    expect(role.executive).toBeNull();
    expect(role.shortlist.length).toBe(start.csuite.shortlists.headOfSupport.length);
    // Their equity still counts against the cap.
    expect(sim.csuite(first.state).equityUsed).toBe(sim.csuite(start).equityUsed);
  });

  it("moves the resigner's back pay onto the loan, not out of cash, and off what's owed", () => {
    const start = sim.advance(board(5)).state;
    const logs = onHoliday(start, 31);
    const before = logs.at(-2)!.state;
    const after = logs.at(-1)!;
    const left = after.state.csuite.resigned!.at(-1)!;
    const owedBefore = before.csuite.payOwed! + sim.csuite(before).dailyPay;
    // Their share of what's owed, by salary.
    expect(left.backPay).toBe(Math.round((owedBefore * left.salary) / sim.csuite(before).dailyPay));
    expect(after.state.csuite.payOwed).toBe(owedBefore - left.backPay);
    // No loan before: the bank opened an emergency loan for it, on its 30-day term. It isn't a shortfall.
    expect(after.state.loan).toMatchObject({ amount: left.backPay, emergency: true, term: 30 });
    expect(sim.shortfall(after.state).owed).toBe(0);
    expect(after.texts).toContain(`Back pay to ${left.name} on resigning`);
    expect(after.texts.some((t) => t.startsWith(`The bank paid it: £${left.backPay.toLocaleString("en-GB")} went on a new emergency loan`))).toBe(true);
    // Cash moved only by the day itself: the bank's money paid the back pay.
    const { log } = sim.advance({ ...before, cash: Math.round(10 * costs) });
    const walkoutCash = log[0]!.entries.filter((e) => e.text.startsWith("Back pay to") || e.text.startsWith("The bank paid it")).reduce((sum, e) => sum + e.cashDelta, 0);
    expect(walkoutCash).toBe(0);
  });

  it("stops once the holiday ends, and counts afresh from the next one", () => {
    const start = sim.advance(board(5)).state;
    const logs = onHoliday(start, 28);
    // Cash back: the holiday ends before anyone resigns, and stays ended.
    let state = sim.advance({ ...logs.at(-1)!.state, cash: Math.round(100 * costs) }).state;
    expect(state.csuite.payHolidaySince ?? null).toBeNull();
    for (let i = 0; i < 20; i++) state = sim.advance({ ...state, cash: Math.round(100 * costs) }).state;
    expect(state.csuite.resigned ?? []).toEqual([]);
    // A new holiday starts its own count: nobody resigns until it too has gone 31 days.
    const again = sim.advance({ ...state, cash: Math.round(5 * costs) }).state;
    expect(again.csuite.payHolidaySince).toBe(again.day);
    expect(resignedOn(onHoliday(again, 30))).toEqual([]);
  });
});

describe("appointing an executive", () => {
  it("shows what their pay does to the runway, and says the pay holiday will start when it puts cash under the line", () => {
    const state = { ...opened(), cash: 500 };
    const role = sim.csuite(state).roles.find((r) => r.role === "headOfOps")!;
    const c = role.shortlist[0]!;
    expect(c.runway).toMatch(new RegExp(`^With their pay \\(£${c.salary.toLocaleString("en-GB")} a day\\), runway falls to \\d+ days?, and the pay holiday will start: cash is under 7 days of running costs\\.$`));
    // Plenty of cash: just the runway.
    const rich = sim.csuite({ ...state, cash: 1_000_000 }).roles.find((r) => r.role === "headOfOps")!.shortlist[0]!;
    expect(rich.runway).toMatch(/^With their pay \(£[\d,]+ a day\), (runway falls to \d+ days|cash still grows)\.$/);
    // Advisory only: the hire goes ahead, and text play says so.
    const turn = runScript(sim, state, `appoint ${c.id.toLowerCase()}`, { player: "test" });
    expect(turn.lines).toContain(`hireExecutive: done. ${c.runway}`);
    expect(turn.state.csuite.hired.map((e) => e.role)).toEqual(["headOfOps"]);
  });
});

describe("each role's effect, through its seam", () => {
  /** No MVP to build, so developers' work goes into features and the slider from day 1. */
  const built = createSim({ ...quiet, mvp: NO_MVP, launch: { ...quiet.launch, auto: 1 } });

  it("head of development: more developer output on the MVP, features and optimisation", () => {
    const state = opened();
    const hired = hire(sim, state, "headOfDevelopment");
    const boost = 1 + effect(sim, hired, "headOfDevelopment", "output");
    expect(boost).toBeGreaterThan(1.1);
    expect(sim.mvp(hired).output).toBeCloseTo(sim.mvp(state).output * boost, 2);
    expect(sim.advance(hired).state.mvp.progress).toBeCloseTo(sim.advance(state).state.mvp.progress * boost, 1);
    const devs = (s: Sim, st: GameState) => s.staff(st).find((p) => p.pool === "developers")!.output;
    expect(devs(sim, hired)).toBeCloseTo(devs(sim, state) * boost, 2);
    const sliding = built.applyAction(opened(built), { type: "setOptimisation", share: 0.5 });
    const slidingHired = hire(built, sliding, "headOfDevelopment");
    expect(built.optimisation(slidingHired).output).toBeCloseTo(built.optimisation(sliding).output * boost, 2);
  });

  it("head of ops: ops cover more servers, and outages are shorter", () => {
    const outage: GameConfig = {
      ...quiet,
      mvp: NO_MVP, launch: { ...quiet.launch, auto: 1 },
      events: [
        {
          id: "providerOutage",
          name: "Provider outage",
          description: "The provider's data centre lost power.",
          layer: "facilities",
          schedule: { type: "fixed", days: [3] },
          days: 1,
          effects: { saas: { downtimeHours: 10, detail: "The SaaS platform went down with it." } },
        },
      ],
    };
    const s = createSim(outage);
    const state = opened(s);
    const hired = hire(s, state, "headOfOps");
    const ops = (st: GameState) => s.staff(st).find((p) => p.pool === "ops")!.output;
    expect(ops(hired)).toBeCloseTo(ops(state) * (1 + effect(s, hired, "headOfOps", "output")), 2);
    const cut = effect(s, hired, "headOfOps", "outageCut");
    expect(s.advance(state, 5).state.downtimeHours).toBe(10);
    expect(s.advance(hired, 5).state.downtimeHours).toBe(Math.ceil(10 * (1 - cut)));
  });

  it("head of support: more tickets cleared, and satisfaction recovers faster but falls no faster", () => {
    const state = opened();
    const hired = hire(sim, state, "headOfSupport");
    expect(sim.dailyClearance(hired)).toBeCloseTo(sim.dailyClearance(state) * (1 + effect(sim, hired, "headOfSupport", "output")), 0);
    const low = (s: GameState): GameState => ({ ...s, satisfaction: 40 });
    const rise = (s: GameState) => sim.advance(low(s)).state.satisfaction - 40;
    const speed = quiet.support.satisfactionSpeed;
    expect(rise(state)).toBeGreaterThan(0);
    expect(rise(hired) / rise(state)).toBeCloseTo(Math.min(1, speed * (1 + effect(sim, hired, "headOfSupport", "recovery"))) / speed, 1);
  });

  it("CFO: a bonus on funder and investor negotiation rolls, and cheaper loans, but nothing on pay reviews", () => {
    const state = sim.applyAction(begin(), { type: "acceptFunding", funder: "grant" });
    const ask = { amount: Math.round(sim.funding(state).friendsAndFamilyOffer!.amount * 1.05) };
    expect(sim.counterOdds(state, "friendsAndFamily", ask).bonus).toBe(0);
    const hired = hire(sim, state, "cfo");
    const bonus = Math.round(effect(sim, hired, "cfo", "rollBonus"));
    expect(bonus).toBeGreaterThanOrEqual(1);
    expect(sim.counterOdds(hired, "friendsAndFamily", ask).bonus).toBe(bonus);
    const countered = sim.applyAction(hired, { type: "counterFunding", funder: "friendsAndFamily", terms: ask });
    expect(countered.funding.negotiating.friendsAndFamily!.rounds[0]!.bonus).toBe(bonus);
    // An investor's offer: an angel approaching.
    const angel = angelApproached(hired);
    const early = createSim({
      ...quiet,
      launch: { ...quiet.launch, auto: 1 },
      investors: { ...quiet.investors, angel: { ...quiet.investors.angel, target: { dailyRevenue: 300, days: 3 } } },
    });
    let approached = begin(early);
    while (early.investors(approached).offer === null && approached.day < 150) approached = early.advance(approached).state;
    const offer = early.investors(approached).offer!;
    const terms = { amount: Math.round(offer.amount * 1.05) };
    expect(early.investorCounterOdds(approached, terms).bonus).toBe(0);
    const withCfo = hire(early, approached, "cfo");
    const cfoBonus = Math.round(effect(early, withCfo, "cfo", "rollBonus"));
    expect(early.investorCounterOdds(withCfo, terms).bonus).toBe(cfoBonus);
    expect(early.investors(withCfo).negotiation?.bonus ?? cfoBonus).toBe(cfoBonus);
    // Loans: the rate comes down by the CFO's cut.
    const cut = effect(sim, angel, "cfo", "loanRateCut");
    expect(sim.loanQuote(hired)!.rate).toBeCloseTo(sim.loanQuote(state)!.rate * (1 - cut), 5);
    // Pay reviews: the CFO plays no part, so staff counters keep the no-head-of-people penalty. Reviews start in Grow.
    const reviews = createSim({ ...quiet, payReview: defaultConfig.payReview });
    let open = inPhase(hire(reviews, reviews.applyAction(begin(reviews), { type: "acceptFunding", funder: "grant" }), "cfo"), "grow");
    while (!open.payReview) open = reviews.advance(open).state;
    const review = reviews.payReview(open)!;
    expect(review).toMatchObject({ headOfPeople: false, rollBonus: quiet.payReview.peopleLead.none.rollBonus });
    expect(reviews.payOfferPreview(open, review.minOffer).odds!.bonus).toBe(quiet.payReview.peopleLead.none.rollBonus);
  });

  it("CTO: opens tier 2 at once, and more research points", () => {
    const state = angelApproached(begin());
    expect(sim.tiers(state)[1]).toMatchObject({ available: false, any: true });
    const hired = hire(sim, state, "cto");
    expect(sim.tiers(hired)[1]).toMatchObject({ available: true, day: state.day });
    expect(sim.tiers(hired)[1]!.conditions.find((c) => c.label === "A CTO hired")).toMatchObject({ met: true });
    const researching = (s: GameState) => sim.applyAction(s, { type: "hire", pool: "researchers", count: 2 });
    const rp = (s: GameState) => sim.advance(researching(s), 20).state.researchPoints;
    expect(rp(state)).toBeGreaterThan(0);
    expect(rp(hired)).toBeCloseTo(rp(state) * (1 + effect(sim, hired, "cto", "research")), 0);
  });

  it("head of people: fills in the people-lead modifier, varied by the candidate", () => {
    const reviews = createSim({ ...quiet, payReview: defaultConfig.payReview });
    const open = (s: GameState) => {
      let current = s;
      while (!current.payReview) current = reviews.advance(current).state;
      return reviews.payReview(current)!;
    };
    const state = angelApproached(begin(reviews));
    const { none, headOfPeople } = quiet.payReview.peopleLead;
    expect(open(state)).toMatchObject({ headOfPeople: false, rollBonus: none.rollBonus, schemeValuation: none.schemeValuation });
    const weakest = open(hire(reviews, state, "headOfPeople", "weakest"));
    const strongest = open(hire(reviews, state, "headOfPeople", "strongest"));
    for (const review of [weakest, strongest]) {
      expect(review.headOfPeople).toBe(true);
      expect(review.rollBonus).toBeGreaterThanOrEqual(headOfPeople.rollBonus);
      expect(review.schemeValuation).toBeGreaterThanOrEqual(1);
    }
    expect(strongest.schemeValuation).toBeGreaterThan(weakest.schemeValuation);
    const shown = roleView(reviews, hire(reviews, state, "headOfPeople", "strongest"), "headOfPeople").executive!.effects;
    expect(shown.find((e) => e.key === "schemeValuation")!.value).toBeCloseTo(strongest.schemeValuation, 5);
  });

  it("CMO: campaigns bring more users for each pound", () => {
    const state = seriesAApproached(begin());
    const marketing = sim.applyAction(state, { type: "hire", pool: "marketers" });
    const hired = hire(sim, marketing, "cmo");
    const perPound = (s: GameState) => sim.campaigns(s).types.find((t) => t.id === "casual")!.usersPerPound;
    expect(perPound(hired)).toBeCloseTo(perPound(marketing) * (1 + effect(sim, hired, "cmo", "campaigns")), 6);
  });

  it("COO: everyday running costs come down, but not staff pay", () => {
    const s = built;
    const iaas = withServers(s, seriesAApproached(begin(s, "iaas")));
    const state = s.advance(iaas, 10).state;
    const hired = hire(s, state, "coo", 0);
    const cut = effect(s, hired, "coo", "runningCostCut");
    expect(s.monthlyInfrastructureCost(hired)).toBe(Math.round(s.monthlyInfrastructureCost(state) * (1 - cut)));
    expect(s.dailyStaffCost(hired)).toBe(s.dailyStaffCost(state));
    const bill = (st: GameState) =>
      s.advance(st).log[0]!.entries.filter((e) => e.category === "infrastructure" || e.category === "power").reduce((sum, e) => sum - e.cashDelta, 0);
    expect(bill(hired)).toBeLessThan(bill(state));
    expect(bill(hired)).toBeCloseTo(bill(state) * (1 - cut), -1);
  });

  it("CIO: migrations are cheaper and quicker", () => {
    const state = seriesAApproached(begin(sim, "iaas"));
    const hired = hire(sim, state, "cio");
    const cut = effect(sim, hired, "cio", "migrationCut");
    const plain = sim.migrationQuote(state, "onprem");
    const quick = sim.migrationQuote(hired, "onprem");
    expect(quick.days).toBeLessThan(plain.days);
    expect(quick.upfrontCost).toBeCloseTo(plain.upfrontCost * (1 - cut), -1);
    expect(quick.exitPenalty).toBe(Math.round(plain.exitPenalty * (1 - cut)));
    const moving = sim.applyAction(hired, { type: "startMigration", model: "paas" });
    expect(sim.migration(moving)!.totalDays).toBe(sim.migrationQuote(hired, "paas").days);
  });

  it("CISO: keeping patched needs fewer ops, and a breach is less likely", () => {
    // A CISO who halves the ops patching needs and takes a breach's whole chance away, so each shows plainly.
    const s = createSim({
      ...quiet,
      // The real events, breaches among them.
      events: defaultConfig.events,
      mvp: NO_MVP, launch: { ...quiet.launch, auto: 1 },
      csuite: {
        ...quiet.csuite,
        roles: { ...quiet.csuite.roles, ciso: { ...quiet.csuite.roles.ciso, effects: { patching: { min: 0.5, max: 0.5 }, breachCut: { min: 1, max: 1 } } } },
      },
    });
    // On IaaS with more servers than one ops person can patch alone.
    let state = withServers(s, seriesAApproached(begin(s, "iaas")));
    // Servers on order need no ops until they're ready (#259), so they're rented, then a day is played.
    while (s.opsNeededOnceReady(state) <= 1) state = s.applyAction(state, { type: "rentServer", server: "app", size: "small" });
    state = s.advance(state).state;
    const ops = s.staff(state).find((p) => p.pool === "ops")!.output;
    expect(ops).toBeLessThan(s.opsNeededNow(state));
    expect(ops).toBeGreaterThanOrEqual(s.opsNeededNow(state) * 0.5);
    const risks = (st: GameState) => s.danger(s.advance(st, 2).state).risks.map((r) => r.id);
    expect(risks(state)).toContain("unpatched");
    const hired = hire(s, state, "ciso");
    expect(effect(s, hired, "ciso", "patching")).toBe(0.5);
    expect(risks(hired)).not.toContain("unpatched");
    expect(s.ipo(s.advance(hired, 2).state).conditions.find((c) => c.id === "security")!.met).toBe(true);
    // No breach on any encounter list rolled after the CISO is hired.
    const breaches = (withCiso: boolean) =>
      [1, 2, 3, 4, 5, 6].reduce((n, seed) => {
        const start = seriesAApproached(s.newGame({ companyName: "Acme", productType: "social", model: "iaas", seed }));
        const kitted = withServers(s, withCiso ? hire(s, start, "ciso") : start);
        // The list rolled at the start came before any CISO, so only what's rolled later counts.
        const first = kitted.encounterList.some((e) => e.event === "breach") ? 1 : 0;
        const played = s.advance(kitted, 300).state;
        const later = played.schedule.filter((e) => e.event === "breach").length - first;
        return n + Math.max(0, later) + played.encounterList.filter((e) => e.event === "breach").length;
      }, 0);
    expect(breaches(false)).toBeGreaterThan(0);
    expect(breaches(true)).toBe(0);
  });

  it("legal counsel: no effect on the business, only their pay and shares", () => {
    const state = seriesAApproached(begin());
    const hired = hire(sim, state, "legalCounsel");
    expect(roleView(sim, hired, "legalCounsel").executive!.effects).toEqual([]);
    const salary = hired.csuite.hired[0]!.salary;
    const a = sim.advance(state, 30).state;
    const b = sim.advance(hired, 30).state;
    expect(b.cash).toBe(a.cash - 30 * salary);
    const strip = (st: GameState) => {
      const { cash: _c, csuite: _s, shareholders: _h, spendByDay: _d, spend: _p, ...rest } = st;
      return rest;
    };
    expect(strip(b)).toEqual(strip(a));
  });
});

describe("text play", () => {
  it("shows the C-suite and hires from a shortlist", () => {
    const who = { player: "test" };
    const shut = runScript(sim, begin(), "csuite", who).lines.join("\n");
    expect(shut).toMatch(/Head of development \(shut\): Opens in the Scale phase/);
    expect(shut).toMatch(/CFO \(shut\): Opens once you take outside money/);
    const state = opened();
    const shown = runScript(sim, state, "csuite", who).lines.join("\n");
    expect(shown).toMatch(/Head of development \(open\)/);
    const id = state.csuite.shortlists.headOfOps[1]!.id;
    expect(shown).toContain(id);
    const turn = runScript(sim, state, `appoint ${id}`, who);
    expect(turn.state.csuite.hired.map((e) => e.name)).toEqual([state.csuite.shortlists.headOfOps[1]!.name]);
    expect(runScript(sim, turn.state, "csuite", who).lines.join("\n")).toMatch(/Head of ops: .* \(hired day 1/);
  });
});
