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

describe("shares and funding", () => {
  it("reads the funding commands", () => {
    expect(parseCommand("accept ff")).toEqual({ kind: "action", action: { type: "acceptFunding", funder: "friendsAndFamily" }, times: 1 });
    expect(parseCommand("decline grant")).toMatchObject({ action: { type: "declineFunding", funder: "grant" } });
    expect(parseCommand("valuation")).toEqual({ kind: "valuation" });
    expect(parseCommand("funding")).toEqual({ kind: "funding" });
    expect(() => parseCommand("accept angel")).toThrow(/ff \(friends and family\) or grant/);
  });

  it("shows the valuation, cap table and open offers, and the commands to answer them", () => {
    const state = start();
    expect(renderStatus(sim, state)).toMatch(/valuation £[\d,]+ \| share price £[\d.]+ \| you 100% of 10,000 shares/);
    expect(renderStatus(sim, state)).toMatch(/funding: friends and family offer £15,000 for [\d.]+% \| grant offer £10,000/);
    expect(renderCommands(sim, state)).toMatch(/accept <ff\|grant> \| decline <ff\|grant>/);
    const valuation = run(state, "valuation");
    expect(valuation.state).toBe(state);
    expect(valuation.lines.join("\n")).toMatch(/Revenue: .*\n.*Growth: .*\n.*Satisfaction: .*\n.*Uptime: /);
    expect(valuation.lines.join("\n")).toMatch(/You: 10,000 shares, 100%/);
    expect(run(state, "funding").lines.join("\n")).toMatch(/Keep uptime at 99% or more for the 60 days/);
  });

  it("accepts friends and family, diluting the student as the offer said, and logs it", () => {
    const state = start();
    const offer = sim.funding(state).friendsAndFamilyOffer!;
    const turn = run(state, "accept ff");
    expect(turn.rows[0]).toMatchObject({ type: "acceptFunding", ok: true, params: { funder: "friendsAndFamily" } });
    expect(renderStatus(sim, turn.state)).toContain(`you ${Math.round(offer.yourShareAfter * 1000) / 10}%, friends and family`);
    expect(renderCommands(sim, turn.state)).toMatch(/accept <grant> \| decline <grant>/);
    const again = run(turn.state, "accept ff");
    expect(again.lines[0]).toMatch(/refused: .*only be taken once/);
  });

  it("stops time when the grant's condition ends", () => {
    const short = createSim({ ...defaultConfig, finalDay: 40, funding: { ...defaultConfig.funding, grant: { amount: 10_000, days: 5, minUptime: 99 } } });
    const state = short.applyAction(
      short.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3 }),
      { type: "acceptFunding", funder: "grant" },
    );
    let turn = advanceUntil(short, state, 20, who);
    while (turn.state.funding.grant?.status === "accepted") turn = advanceUntil(short, turn.state, 20, who);
    expect(turn.state.day).toBe(6);
    expect(turn.lines.at(-1)).toMatch(/^stopped on day 6: .*grant (met|withdrawn)/);
    expect(turn.lines.join("\n")).toMatch(/day 6: Grant (condition met|withdrawn)/);
  });
});
