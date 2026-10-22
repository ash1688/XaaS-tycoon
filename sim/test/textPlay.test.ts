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

describe("the paid API", () => {
  const shop = (model: "iaas" | "paas" | "saas") =>
    sim.newGame({ companyName: "Shop Co", productType: "ecommerce", model, seed: 3, takeLoan: true });

  it("reads its commands", () => {
    expect(parseCommand("buyapi")).toEqual({ kind: "action", action: { type: "buyApi" }, times: 1 });
    expect(parseCommand("switch 3 APIU")).toMatchObject({ action: { type: "switchServer", id: 3, gives: "apiu" } });
    expect(parseCommand("apiinstances 2")).toMatchObject({ action: { type: "setApiInstances", count: 2 } });
    expect(() => parseCommand("switch 3 dbu")).toThrow(/cu, apiu/);
  });

  it("offers it to buy, then shows its calls, APIU and income, and the commands for capacity", () => {
    let state = shop("iaas");
    expect(renderStatus(sim, state)).toMatch(/api: Shop API not bought \(£4,000 once/);
    expect(renderCommands(sim, state)).toMatch(/buyapi/);
    state = run(state, "buyapi").state;
    state = run(state, "rent app large").state;
    expect(renderStatus(sim, state)).toMatch(/api: Shop API 2,000 calls\/day .* \| APIU 2\/0 \|/);
    const commands = renderCommands(sim, state);
    expect(commands).not.toMatch(/buyapi/);
    expect(commands).toMatch(/api: small 6u/);
    expect(commands).toMatch(/switch <app server id> <cu\|apiu>/);
    state = run(state, "switch 1 apiu").state;
    expect(renderStatus(sim, state)).toMatch(/#1 large app 20 APIU \(switched\)/);
    // Ready tomorrow, so its APIU serve from the day after.
    expect(renderStatus(sim, state)).toMatch(/APIU 2\/0 /);
    expect(renderStatus(sim, sim.advance(state).state)).toMatch(/APIU [\d.]+\/20 /);
  });

  it("stops time when calls start being dropped", () => {
    let state = run(shop("iaas"), "rent app large").state;
    state = run(state, "rent database large").state;
    state = run(state, "buyapi").state;
    const turn = run(state, "next 7");
    expect(turn.lines.at(-1)).toMatch(/API calls dropped/);
    expect(turn.lines.some((l) => /Shop API: [\d,]+ calls dropped/.test(l))).toBe(true);
  });

  it("shows API instances on PaaS and the provider's fee on SaaS", () => {
    const paas = run(shop("paas"), "buyapi").state;
    expect(renderCommands(sim, paas)).toMatch(/apiinstances <0–20>/);
    expect(renderStatus(sim, run(paas, "apiinstances 2").state)).toMatch(/2 API instances \(10 APIU each\)/);
    const saas = run(shop("saas"), "buyapi").state;
    expect(renderStatus(sim, saas)).toMatch(/the provider runs it at 0\.40p a call .* fee £8\/day/);
  });
});
