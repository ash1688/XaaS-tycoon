import { describe, expect, it } from "vitest";
import { createSim, defaultConfig, SimError, type GameState } from "../src/index.ts";
import { advanceUntil, parseCommand, renderCommands, renderStatus, renderSummary, runCommand } from "../scripts/textPlay.ts";

const sim = createSim({ ...defaultConfig, finalDay: 40 });
const who = { player: "test", playstyle: "average-joe" };
const start = (): GameState =>
  sim.newGame({ companyName: "Test Co", productType: "social", model: "paas", seed: 3, takeLoan: true });

/** Runs one command line against a state, as play.ts does. */
function run(state: GameState, text: string) {
  const command = parseCommand(text);
  return command.kind === "next" ? advanceUntil(sim, state, command.days, who) : runCommand(sim, state, command, who);
}

describe("parseCommand", () => {
  it("reads actions, counts and server types without case", () => {
    expect(parseCommand("hire support 5")).toEqual({ kind: "action", action: { type: "hire", pool: "support", count: 5 }, times: 1 });
    expect(parseCommand("hire ops junior 3")).toMatchObject({ action: { type: "hire", pool: "ops", grade: "junior", count: 3 } });
    expect(parseCommand("letgo developers senior")).toMatchObject({ action: { type: "letGo", pool: "developers", grade: "senior", count: 1 } });
    expect(parseCommand("move ops developers junior")).toMatchObject({ action: { type: "moveStaff", to: "ops", from: "developers", grade: "junior" } });
    expect(parseCommand("Rent LoadBalancer small")).toEqual({
      kind: "action",
      action: { type: "rentServer", server: "loadBalancer", size: "small" },
      times: 1,
    });
    expect(parseCommand("managed cache off")).toMatchObject({ action: { type: "setManagedService", service: "cache", size: null } });
    expect(parseCommand("next")).toEqual({ kind: "next", days: 7 });
  });

  it("explains a command it can't read", () => {
    expect(() => parseCommand("hire suport")).toThrow(SimError);
    expect(() => parseCommand("dance")).toThrow(/Unknown command/);
    expect(() => parseCommand("hire support 0")).toThrow(/1 to 500/);
    expect(() => parseCommand("hire support intern 2")).toThrow(/a grade/);
  });
});

describe("runCommand", () => {
  it("hires a grade in one go, shows them waiting, and stops when they start", () => {
    const turn = run(start(), "hire support junior 3");
    expect(turn.rows).toHaveLength(1);
    expect(turn.rows[0]).toMatchObject({ kind: "game", type: "hire", ok: true, player: "test", params: { pool: "support", grade: "junior", count: 3 } });
    // Juniors start 3 days after hiring: not on the team or paid until then.
    expect(turn.state.staff.support).toEqual({ junior: 0, mid: 1, senior: 0 });
    expect(renderStatus(sim, turn.state)).toMatch(/support 1 \(0 junior, 1 mid, 0 senior\) work 1 .*hired, not started: 3 junior on day 4 \(3d\)/);
    let later = turn;
    while (later.state.day < 4) later = run(later.state, "next 1");
    expect(later.lines.at(-1)).toMatch(/^stopped on day 4: .*staff started/);
    expect(later.lines).toContain("  day 4: 3 junior support staff started work.");
    expect(later.state.staff.support).toEqual({ junior: 3, mid: 1, senior: 0 });
    expect(later.rows.at(-1)).toMatchObject({ support: 4 });
  });

  it("reports a refused action and logs it with its error code, without throwing", () => {
    const turn = run(start(), "instances 999");
    expect(turn.lines[0]).toMatch(/refused/);
    expect(turn.rows[0]).toMatchObject({ ok: false, type: "setInstances" });
    expect(turn.rows[0]!.error).toBeTruthy();
  });

  it("previews a price without changing anything", () => {
    const state = start();
    const turn = run(state, "preview 8");
    expect(turn.state).toBe(state);
    expect(turn.rows).toEqual([]);
  });
});

describe("advanceUntil", () => {
  it("stops early when something needs a decision", () => {
    let state = run(start(), "instances 2").state;
    state = run(state, "managed database small").state;
    const turn = run(state, "next 30");
    expect(turn.state.day).toBeLessThan(31);
    expect(turn.lines.at(-1)).toMatch(/^stopped on day \d+: /);
    expect(turn.rows.every((r) => r.type === "continue")).toBe(true);
  });

  it("doesn't stop for an event that needs nothing from the player", () => {
    let state = run(start(), "instances 3").state;
    state = run(state, "managed database medium").state;
    let quiet = 0;
    for (let i = 0; i < 39 && state.status === "playing"; i++) {
      const turn = run(state, "next 1");
      state = turn.state;
      const today = sim.events(state);
      if (today.length && today.every((e) => !e.hit && !e.shortOfOps)) {
        quiet++;
        expect(turn.lines.at(-1)).not.toMatch(/event:/);
      }
    }
    expect(quiet).toBeGreaterThan(0);
  });

  it("plays to the end and logs the ending", () => {
    let last = run(start(), "next 1");
    for (let i = 0; i < 100 && last.state.status === "playing"; i++) last = run(last.state, "next 40");
    expect(last.rows.at(-1)).toMatchObject({ type: "end", params: { status: last.state.status } });
    const summary = renderSummary(sim, last.state);
    expect(summary).toMatch(/"ending"/);
    expect(summary).not.toMatch(/incomeVsCosts|"days"/);
  });
});

describe("rendering", () => {
  it("shows the company and the commands that work now", () => {
    const state = start();
    expect(renderStatus(sim, state)).toMatch(/day 1\/40/);
    const commands = renderCommands(sim, state);
    expect(commands).toMatch(/instances <1–20>/);
    expect(commands).not.toMatch(/^\s+rent /m);
  });
});
