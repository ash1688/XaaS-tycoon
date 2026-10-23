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
    expect(parseCommand("hire support 5")).toEqual({ kind: "action", action: { type: "hire", pool: "support" }, times: 5 });
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
  });
});

describe("runCommand", () => {
  it("repeats an action and logs a row for each", () => {
    const turn = run(start(), "hire support 3");
    expect(turn.state.support).toBe(4);
    expect(turn.rows).toHaveLength(3);
    expect(turn.rows[0]).toMatchObject({ kind: "game", type: "hire", ok: true, player: "test", params: { pool: "support" } });
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

  it("ends the game as the teacher, logging it like the classroom server", () => {
    const { state } = run(start(), "next 3");
    const ended = run(state, "end");
    expect(ended.state).toMatchObject({ status: "finished", endedByTeacher: true, day: state.day });
    expect(ended.lines).toEqual([`GAME OVER: ended by the teacher on day ${state.day}`]);
    expect(ended.rows).toMatchObject([{ type: "end", params: { status: "finished", endedBy: "teacher" } }]);
    expect(renderStatus(sim, ended.state)).toMatch(/ENDED BY TEACHER/);
    expect(renderSummary(sim, ended.state)).toMatch(/"ending": "ended"/);
  });
});

describe("racks, cabling, power and cooling", () => {
  const onPrem = () => sim.newGame({ companyName: "Test Co", productType: "video", model: "onprem", seed: 3, takeLoan: true });

  it("reads buying a server into a chosen rack, and buying and selling racks", () => {
    expect(parseCommand("buy app large 2")).toMatchObject({ action: { type: "buyServer", server: "app", size: "large", rack: 2 } });
    expect(parseCommand("buy app large")).toEqual({ kind: "action", action: { type: "buyServer", server: "app", size: "large" }, times: 1 });
    expect(parseCommand("rack large")).toMatchObject({ action: { type: "buyRack", size: "large" } });
    expect(parseCommand("sellrack 2")).toMatchObject({ action: { type: "sellRack", id: 2 } });
    expect(() => parseCommand("rack massive")).toThrow(/rack size/);
  });

  it("shows racks, rack space and power and cooling on-prem, and drives them", () => {
    let state = onPrem();
    expect(renderStatus(sim, state)).toMatch(/^racks: #1 medium 0\/24U \| 24U free, most in one rack 24U$/m);
    expect(renderStatus(sim, state)).toMatch(/^power and cooling £25\/day$/m);
    const commands = renderCommands(sim, state);
    expect(commands).toMatch(/^ {2}buy <.+> <.+> \[rack id\]/m);
    expect(commands).toMatch(/rack space: small 1U, medium 2U, large 4U, massive 8U; most free in one rack 24U; £50 cabling on each/);
    expect(commands).toMatch(/^ {2}rack <small\|medium\|large> {3}small 12U £300 \+ £50 cabling/m);
    for (let i = 0; i < 3; i++) state = run(state, "buy app massive").state;
    expect(renderStatus(sim, state)).toMatch(/#1 massive app \d+ CU in rack #1 \(arrives in 7d\)/);
    const full = run(state, "buy database small");
    expect(full.lines[0]).toMatch(/refused.*Buy a rack/);
    expect(full.rows[0]).toMatchObject({ ok: false, type: "buyServer", error: "no_rack_space" });
    state = run(state, "rack small").state;
    expect(renderStatus(sim, state)).toMatch(/racks: #1 medium 24\/24U, #2 small 0\/12U/);
    expect(renderCommands(sim, state)).toMatch(/sellrack <rack id>/);
    state = run(state, "buy database small").state;
    expect(state.servers.at(-1)!.rack).toBe(2);
  });

  it("has no racks off on-prem, but still shows power and cooling", () => {
    const state = start();
    expect(renderStatus(sim, state)).not.toMatch(/^racks:/m);
    expect(renderStatus(sim, state)).toMatch(/^power and cooling £6\/day$/m);
    expect(renderCommands(sim, state)).not.toMatch(/rack/);
  });
});

describe("rendering", () => {
  it("shows a longer game's length and final day", () => {
    const yearly = createSim({ ...defaultConfig, allowedGameLengths: { "180-days": 0, "1-year": 1, career: 1 } });
    const career = yearly.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3, gameLength: "career" });
    expect(renderStatus(yearly, career)).toMatch(/day 1\/17155 \(Career \(47 years, age 18 to 65\)\)/);
  });

  it("shows the company and the commands that work now", () => {
    const state = start();
    expect(renderStatus(sim, state)).toMatch(/day 1\/40 \(40 days\)/);
    expect(renderCommands(sim, state)).toMatch(/^\s+end /m);
    const commands = renderCommands(sim, state);
    expect(commands).toMatch(/instances <1–20>/);
    expect(commands).not.toMatch(/^\s+rent /m);
  });

  it("shows the loan with its payoff, pays it off early, and then offers another", () => {
    const state = run(start(), "next 10").state;
    const loan = sim.loan(state)!;
    expect(renderStatus(sim, state)).toContain(`to day ${loan.lastDay}); paying off now costs £${loan.payoff.toLocaleString("en-GB")}`);
    expect(renderCommands(sim, state)).toMatch(/repayloan {3}\(pay off the loan now: .*, saving .* interest\)/);
    expect(renderCommands(sim, state)).not.toMatch(/^\s+loan /m);
    expect(parseCommand("repayloan")).toEqual({ kind: "action", action: { type: "repayLoan" }, times: 1 });

    const turn = run({ ...state, cash: state.cash + 50_000 }, "repayloan");
    expect(turn.rows[0]).toMatchObject({ type: "repayLoan", ok: true });
    expect(renderStatus(sim, turn.state)).toContain(`loan: repaid early on day ${state.day}`);
    expect(renderCommands(sim, turn.state)).toMatch(/^\s+loan {3}\(£35,000 now at .*, to day \d+: .* interest\)/m);
    expect(renderCommands(sim, turn.state)).not.toMatch(/repayloan/);
  });
});
