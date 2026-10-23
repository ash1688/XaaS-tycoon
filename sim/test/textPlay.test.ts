import { describe, expect, it } from "vitest";
import { createSim, defaultConfig, SimError, type GameState } from "../src/index.ts";
import { advanceUntil, parseCommand, renderCommands, renderStatus, renderSummary, runCommand, runScript } from "../scripts/textPlay.ts";

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

  it("shows the customer mix with thresholds, and a rise's reaction by customer type", () => {
    const state = advanceUntil(sim, run(start(), "instances 2").state, 20, who).state;
    expect(renderStatus(sim, state)).toMatch(
      /customer mix: casual 70% \(threshold £5\), enthusiasts 20% \(threshold £6\.25\), professionals 8% \(threshold £10\), businesses 2% \(threshold £15\)/,
    );
    const line = run(state, "preview 7.5").lines[0]!;
    expect(line).toMatch(/reaction \d+\.\d% of payers = casual \d+\.\d% × 70% \+ enthusiasts .* \+ businesses \d+\.\d% × 2%/);
    const raised = run(state, "price 7.5").state;
    expect(renderStatus(sim, raised)).toMatch(/casual 70% \(threshold £5!\)/);
  });
});

describe("runScript", () => {
  it("says why each refused command in a batch was refused, and goes on with the rest", () => {
    const turn = runScript(sim, start(), "letgo ops senior; letgo support mid 3; dance; letgo support", who);
    expect(turn.lines).toEqual([
      "> letgo ops senior",
      "letGo refused: You have no senior ops staff to let go. (ops now: 0 junior, 1 mid, 0 senior)",
      "> letgo support mid 3",
      "letGo refused: You only have 1 mid support staff to let go. (support now: 0 junior, 1 mid, 0 senior)",
      "> dance",
      expect.stringMatching(/^refused: Unknown command "dance"/),
      "> letgo support",
      "letGo: done",
    ]);
    expect(turn.rows.map((r) => r.ok)).toEqual([false, false, true]);
    expect(turn.state.staff.support).toEqual({ junior: 0, mid: 0, senior: 0 });
  });

  it("says why each command after time stops isn't run", () => {
    const turn = runScript(sim, start(), "instances 2; managed database small; next 30; letgo ops; hire ops 2", who);
    expect(turn.lines.slice(-4)).toEqual([
      "> letgo ops",
      "not run: time stopped on day 4, so look first",
      "> hire ops 2",
      "not run: time stopped on day 4, so look first",
    ]);
    expect(turn.state.staff.ops).toEqual({ junior: 0, mid: 1, senior: 0 });
  });

  it("says why each command after the game ends isn't run", () => {
    const turn = runScript(sim, start(), "end; letgo ops; valuation", who);
    expect(turn.lines).toContain("not run: the game is over");
    expect(turn.lines.indexOf("> letgo ops")).toBeGreaterThan(-1);
    expect(turn.lines.at(-1)).toBe("not run: the game is over");
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

  it("shows the danger meter, and stops when a new risk makes it climb faster", () => {
    let state = run(start(), "instances 2").state;
    state = run(state, "managed database small").state;
    state = run(state, "next 3").state;
    expect(renderStatus(sim, state)).toMatch(/danger meter: \d+(\.\d+)? \(no event waits past 56\) \| rose 1 today \(well-run day \+1\)/);
    // Customers turn unhappy: the meter climbs faster, which stops time and says why.
    const turn = run({ ...state, satisfaction: 10 }, "next 5");
    expect(turn.state.day).toBe(state.day + 1);
    expect(turn.lines.at(-1)).toMatch(/danger meter climbing faster: customers unhappy/);
    expect(renderStatus(sim, turn.state)).toMatch(/rose 1\.5 today \(well-run day \+1, customers unhappy \+0\.5\)/);
    expect(renderStatus(sim, turn.state)).toMatch(/Customers unhappy: Satisfaction is below 40%/);
  });

  it("shows paying users lost each day, and how the users changed, after a price rise", () => {
    let state = runScript(sim, start(), "instances 2; managed database small", who).state;
    while (sim.launch(state).status !== "launched") state = run(state, "next 30").state;
    state = run(state, "price 1000").state;
    const turn = run(state, "next 3");
    expect(turn.lines).toContainEqual(expect.stringMatching(/^  day \d+: Paying users lost: [\d,]+ left and [\d,]+ dropped to free, because your price is above/));
    expect(turn.lines.at(-2)).toMatch(/^  users [\d,]+→[\d,]+ \(paid [\d,]+→[\d,]+, free [\d,]+→[\d,]+\)$/);
    expect(turn.lines.at(-1)).toMatch(/^stopped on day|^advanced to day/);
  });

  it("plays a week a tick in a career, logging one Continue a week, and stops mid-week on the day something needs you", () => {
    const careers = createSim({ ...defaultConfig, allowedGameLengths: { "180-days": 0, "1-year": 0, career: 1 } });
    const career = careers.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3, gameLength: "career" });
    expect(renderCommands(careers, career)).toMatch(/next \[days\]\s+\(play ticks of a week \(this is a career\)/);
    // The launch is over on day 3, two days into the first week: time stops there.
    const launch = advanceUntil(careers, career, 7, who);
    expect(launch.state.day).toBe(3);
    expect(launch.lines.at(-1)).toBe("stopped on day 3: Your launch is over");
    // A quiet stretch then plays whole weeks: "next 10" is two of them, one Continue each.
    const weeks = advanceUntil(careers, launch.state, 10, who);
    expect(weeks.state.day).toBe(17);
    expect(weeks.lines.at(-1)).toBe("advanced to day 17");
    expect(weeks.rows.map((r) => r.type)).toEqual(["continue", "continue"]);
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
    expect(renderStatus(sim, state)).toMatch(/#1 massive app \d+ CU in rack #1 \(arrives in 4d\)/);
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
    expect(renderStatus(yearly, career)).toMatch(/day 1\/17155 \(Career \(47 years, age 18 to 65\), a week a tick\)/);
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
    expect(commands).toMatch(/api: small 6 APIU/);
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
    expect(turn.lines.at(-1)).toMatch(/API calls are being dropped/);
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
    expect(run(state, "funding").lines.join("\n")).toMatch(/Keep uptime at 98.5% or more for the 60 days once your launch is over/);
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
    const short = createSim({ ...defaultConfig, finalDay: 40, funding: { ...defaultConfig.funding, grant: { ...defaultConfig.funding.grant, days: 5 } } });
    const state = short.applyAction(
      short.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3 }),
      { type: "acceptFunding", funder: "grant" },
    );
    let turn = advanceUntil(short, state, 20, who);
    while (turn.state.funding.grant?.status === "accepted") turn = advanceUntil(short, turn.state, 20, who);
    // Launched on day 1, so the condition runs from the end of the ramp: days 4 to 8.
    expect(turn.state.day).toBe(8);
    expect(turn.lines.at(-1)).toMatch(/^stopped on day 8: The grant( was withdrawn|'s condition is met)/);
    expect(turn.lines.join("\n")).toMatch(/day 8: Grant (condition met|withdrawn)/);
  });
});
