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

  it("hires agency staff for the next day, shows them apart, and lets them go with no severance", () => {
    expect(parseCommand("hire support agency junior 2")).toMatchObject({
      action: { type: "hire", pool: "support", agency: true, grade: "junior", count: 2 },
    });
    expect(parseCommand("letgo ops agency")).toMatchObject({ action: { type: "letGo", pool: "ops", agency: true, count: 1 } });
    const hired = run(start(), "hire support agency 2");
    expect(renderStatus(sim, hired.state)).toMatch(/hired, not started: 2 agency mid on day 2 \(1d\)/);
    expect(renderStatus(sim, hired.state)).toMatch(/agency staff: 1\.25x the pay and 0\.5x the work .*start 1d after hiring/);
    const started = run(hired.state, "next 1");
    expect(started.lines).toContain("  day 2: 2 agency mid support staff started work.");
    // One permanent mid's work, and two agency mids' at half each.
    expect(renderStatus(sim, started.state)).toMatch(/support 1 \(0 junior, 1 mid, 0 senior\) \+ agency 2 \(2 mid\) work 2 /);
    const gone = run(started.state, "letgo support agency 2");
    expect(gone.lines).toEqual(["letGo: done"]);
    expect(gone.state.cash).toBe(started.state.cash);
  });

  it("shows severance for each grade, and pays it when permanent staff go", () => {
    // Support are £100 a day for a mid by default: 14 days' pay is £1,400.
    const state = start();
    expect(renderStatus(sim, state)).toMatch(/support 1 .*\| severance £1,050\/£1,400\/£1,820 each/);
    const gone = run(state, "letgo support");
    expect(gone.lines).toEqual(["letGo: done, paid £1,400 severance"]);
    expect(gone.state.cash).toBe(state.cash - 1_400);
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
      /customer mix: casual 70\.\d% \(threshold £5\), enthusiasts 20\.\d% \(threshold £6\.25\), professionals \d\.\d% \(threshold £10\), businesses \d\.\d% \(threshold £15\)/,
    );
    const line = run(state, "preview 7.5").lines[0]!;
    expect(line).toMatch(/reaction \d+\.\d% of payers = casual \d+\.\d% × 70% \+ enthusiasts .* \+ businesses \d+\.\d% × 2%/);
    const raised = run(state, "price 7.5").state;
    expect(renderStatus(sim, raised)).toMatch(/casual 70\.\d% \(threshold £5!\)/);
  });

  it("shows who new users join as, and what features and the price pull in", () => {
    const state = advanceUntil(sim, run(start(), "instances 2").state, 20, who).state;
    expect(renderStatus(sim, state)).toMatch(
      // The product's mix, tilted a little by the rivals.
      /new users join as: casual \d+\.\d% \(rivals x[\d.]+\), enthusiasts \d+\.\d% \(rivals x[\d.]+\), professionals \d+\.\d% \(rivals x[\d.]+\), businesses \d+\.\d% \(rivals x[\d.]+\)\n/,
    );
    expect(renderStatus(sim, state)).toMatch(/groups not started \[pulls professionals x1\.5\]/);
    // Twice the fair price: a quarter as many casual users join.
    const dear = run(state, "price 10").state;
    expect(renderStatus(sim, dear)).toMatch(/new users join as: casual \d+\.\d% \(price x0\.25, rivals x[\d.]+\), enthusiasts \d+\.\d% \(price x0\.39, rivals x[\d.]+\), professionals/);
    const grouped: GameState = { ...state, features: { groups: { status: "built", progress: 0 } } };
    expect(renderStatus(sim, grouped)).toMatch(/professionals \d+\.\d% \(features x1\.44, rivals x[\d.]+\)/);
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
      "letGo: done, paid £1,400 severance",
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

  it("stops for viral growth, and shows whose job it is to carry the new users", () => {
    const viral = defaultConfig.events.find((e) => e.id === "viralGrowth")!;
    const s = createSim({ ...defaultConfig, finalDay: 40, events: [{ ...viral, encounter: undefined, schedule: { type: "fixed", days: [10] } }] });
    const begun = s.newGame({ companyName: "Test Co", productType: "social", model: "paas", seed: 3, takeLoan: true });
    let state = runCommand(s, begun, parseCommand("instances 3"), who).state;
    state = runCommand(s, state, parseCommand("managed database medium"), who).state;
    // Time stops for other things on the way, such as the launch.
    let turn = advanceUntil(s, state, 30, who);
    while (turn.state.day < 10) turn = advanceUntil(s, turn.state, 30, who);
    expect(turn.lines.at(-1)).toBe("stopped on day 10: Viral growth");
    expect(turn.lines.join("\n")).toMatch(/day 10: Viral growth: Runtime and scaling is the provider's job on PaaS\. [\d,]+ new free users signed up\./);
    expect(renderStatus(s, turn.state)).toMatch(
      /event today: Viral growth\. Runtime and scaling is the provider's job on PaaS\. [\d,]+ new free users signed up\. They're staying\./,
    );
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
    // No moderation, as on main before moderators: this is about something else.
    const careers = createSim({
      ...defaultConfig,
      allowedGameLengths: { "180-days": 0, "until-ipo": 0, "1-year": 0, career: 1 },
      productTypes: { ...defaultConfig.productTypes, social: { ...defaultConfig.productTypes.social, moderation: undefined } },
    });
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
    const yearly = createSim({ ...defaultConfig, allowedGameLengths: { "180-days": 0, "until-ipo": 0, "1-year": 1, career: 1 } });
    const career = yearly.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3, gameLength: "career" });
    expect(renderStatus(yearly, career)).toMatch(/day 1\/17155 \(Career \(47 years, age 18 to 65\), Normal, a week a tick\)/);
  });

  it("shows the game's difficulty", () => {
    const any = createSim({ ...defaultConfig, allowedDifficulties: { easy: 1, normal: 1, hard: 1 } });
    const hard = any.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3, difficulty: "hard" });
    expect(renderStatus(any, hard)).toMatch(/day 1\/180 \(180 days, Hard\)/);
    expect(renderSummary(any, hard)).toMatch(/"difficulty": "hard"/);
  });

  it("shows the company and the commands that work now", () => {
    const state = start();
    expect(renderStatus(sim, state)).toMatch(/day 1\/40 \(40 days, Normal\)/);
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
    expect(renderStatus(sim, state)).toMatch(/funding: friends and family offer 1 of 3, 2 counters left £15,000 for [\d.]+% \| grant offer 1 of 3, 2 counters left £10,000/);
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

  it("reads counters and odds: a share as a percent, terms in any order", () => {
    expect(parseCommand("counter ff amount 18000 share 18")).toEqual({
      kind: "action",
      action: { type: "counterFunding", funder: "friendsAndFamily", terms: { amount: 18_000, share: 0.18 } },
      times: 1,
    });
    expect(parseCommand("counter grant days 45 amount £11,000")).toMatchObject({
      action: { type: "counterFunding", funder: "grant", terms: { days: 45, amount: 11_000 } },
    });
    expect(parseCommand("odds ff share 20%")).toEqual({ kind: "odds", funder: "friendsAndFamily", terms: { share: 0.2 } });
    expect(() => parseCommand("counter ff price 5")).toThrow(/Expected a term/);
    expect(() => parseCommand("counter ff amount")).toThrow(/the amount as a number/);
  });

  it("negotiates: shows the odds, then each roll and the offer that stands, to the final offer", () => {
    const state = start();
    expect(renderCommands(sim, state)).toMatch(/counter ff \[amount <£>\] \[share <%>\]/);
    const odds = run(state, "odds ff amount 18000");
    expect(odds.state).toBe(state);
    expect(odds.lines.join("\n")).toMatch(/asks 20% better \(most 50%\): −6 on the roll\n  high 5% → £17,400 .*\n  middle 35% → £16,500 .*\n  low 60% → £15,300/);
    let turn = run(state, "counter ff amount 18000");
    expect(turn.rows[0]).toMatchObject({ type: "counterFunding", ok: true, params: { funder: "friendsAndFamily", terms: { amount: 18_000 } } });
    expect(turn.lines[0]).toMatch(/^counter £18,000 for [\d.]+%: rolled \d+ −6 for asking 20% = −?\d+: (high|middle|low), they moved \d+% of the way\. Offer 2: .*\(1 counter left\)/);
    expect(renderStatus(sim, turn.state)).toMatch(/friends and family offer 2 of 3, 1 counter left/);
    expect(run(turn.state, "funding").lines.join("\n")).toMatch(/offer 1 £15,000 .*; you asked £18,000 .*, rolled .* → offer 2 /);
    turn = run(turn.state, "counter ff share 20");
    expect(turn.lines[0]).toMatch(/Offer 3: .* \(final: accept or decline\)/);
    expect(renderStatus(sim, turn.state)).toMatch(/friends and family final offer/);
    expect(renderCommands(sim, turn.state)).not.toMatch(/counter ff/);
    expect(renderCommands(sim, turn.state)).toMatch(/odds <grant>/);
    expect(run(turn.state, "counter ff amount 20000").lines[0]).toMatch(/refused: This is the final offer/);
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

describe("the IPO", () => {
  const ipoSim = (cold: number) =>
    createSim({
      ...defaultConfig,
      events: [],
      allowedGameLengths: { "180-days": 1, "until-ipo": 1, "1-year": 0, career: 0 },
      ipo: {
        ...defaultConfig.ipo,
        coldChance: { min: cold, max: cold },
        products: { ...defaultConfig.ipo.products, social: { users: 1_000, annualRevenue: 100_000, payingUsers: 500 } },
      },
    });
  /** A SaaS company 40 days in, made comfortably over every condition. */
  const ready = (s: ReturnType<typeof createSim>): GameState => {
    const played = s.advance(s.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3 }), 40).state;
    return {
      ...played,
      users: 2_000,
      paidUsers: 1_000,
      price: 60,
      satisfaction: 90,
      spendByDay: played.spendByDay.map((d) => ({
        ...d,
        ...{ staff: 100, infrastructure: 50, cabling: 0, power: 10, addons: 0, debt: 0, interest: 0 },
        ...{ income: 1_000, users: 2_000, paidUsers: 1_000, satisfaction: 90, hoursDown: 0 },
      })),
    };
  };
  const play = (s: ReturnType<typeof createSim>, state: GameState, script: string) => runScript(s, state, script, who);

  it("reads the IPO commands", () => {
    expect(parseCommand("ipo")).toEqual({ kind: "ipo" });
    expect(parseCommand("apply")).toEqual({ kind: "action", action: { type: "applyForIpo" }, times: 1 });
    expect(parseCommand("ring 25")).toEqual({ kind: "action", action: { type: "ringBell", float: 0.25 }, times: 1 });
    expect(() => parseCommand("ring")).toThrow(/float percentage/);
  });

  it("shows the checklist, and offers apply only once every condition is met", () => {
    const s = ipoSim(0);
    const state = start();
    expect(renderStatus(sim, state)).toMatch(/ipo: 1\/7 readiness conditions met; still to meet: users and revenue, uptime record, predictable costs, profitability, satisfaction record, paying customer base$/m);
    expect(renderCommands(sim, state)).toMatch(/ipo {3}\(the IPO readiness checklist/);
    expect(renderCommands(sim, state)).not.toMatch(/apply/);
    expect(run(state, "ipo").lines.join("\n")).toMatch(/\[ \] Users and revenue: .*\n.*\[ \] Uptime record: /);
    const r = ready(s);
    expect(renderStatus(s, r)).toMatch(/ipo: READY: all 7 conditions met, comfort \d+% \("apply" to float\)/);
    expect(renderCommands(s, r)).toMatch(/apply {3}\(apply to float/);
    expect(play(s, r, "ipo").lines.join("\n")).toMatch(/\[x\] Paying customer base: 1,000, of 2,000 users in a market of about 40,000: .*\. Needs 500 paying users\. Comfort 100%\./);
  });

  it("says when a cold market postpones the IPO", () => {
    const s = ipoSim(1);
    const turn = play(s, ready(s), "apply; apply");
    expect(turn.lines.join("\n")).toMatch(/COLD MARKET\. The IPO is postponed: apply again from day 71\. Satisfaction fell to 80%/);
    expect(turn.lines.at(-1)).toMatch(/refused: The markets are cold .* day 71, in 30 days/);
    expect(renderStatus(s, turn.state)).toMatch(/ipo: cold market: can apply again on day 71/);
  });

  it("applies, shows the offer, rings the bell and ends the game", () => {
    const s = ipoSim(0);
    const approved = play(s, ready(s), "apply");
    expect(approved.lines.join("\n")).toMatch(/APPROVED\. Pick a float.*\noffer: valuation £[\d,]+, 10,000 shares at £[\d.]+; you own 100%/);
    expect(approved.lines.join("\n")).toMatch(/ {2}15%: 1,765 new shares, raises £[\d,]+, you'd own 85%, first day swings about ±20%/);
    expect(renderCommands(s, approved.state)).toMatch(/ring <15-40> {3}\(float that % .*ENDS THE GAME/);
    expect(play(s, approved.state, "ring 50").lines.at(-1)).toMatch(/refused: Float from 15% to 40%/);
    expect(play(s, approved.state, "next").lines.at(-1)).toMatch(/refused: Your IPO is approved: choose your float and ring/);

    const rung = play(s, approved.state, "ring 25; next");
    const text = rung.lines.join("\n");
    expect(text).toMatch(/opening bell! floated 25%: 3,333 new shares at £[\d.]+ raised £[\d,]+/);
    expect(text).toMatch(/first day: 09:30 £[\d.]+, 10:00 £[\d.]+, .* 16:00 £[\d.]+/);
    expect(text).toMatch(/close £[\d.]+ \([+−][\d.]+% on the offer\) \| market value £[\d,]+ \(cash raised included\) \| you own 75%, worth £[\d,]+/);
    expect(text).toMatch(/GAME OVER: floated on day 41\n> next\nnot run: the game is over/);
    expect(rung.rows.map((r) => r.type)).toEqual(["ringBell", "end"]);
    expect(rung.rows.at(-1)).toMatchObject({ params: { status: "finished", ending: "ipo" } });
    expect(renderStatus(s, rung.state)).toMatch(/\| FLOATED\n[^]*ipo: floated 25% on day 41: raised £[\d,]+/);
    const r = rung.state.ipo.result!;
    expect(renderStatus(s, rung.state)).toContain(`market value £${r.marketValue.toLocaleString("en-GB")} at the first day's close`);
    expect(JSON.parse(renderSummary(s, rung.state))).toMatchObject({ marketValue: r.marketValue, yourSharesWorth: r.studentValue });
    expect(play(s, rung.state, "ipo").lines.join("\n")).toMatch(/opening bell!/);
    expect(JSON.parse(renderSummary(s, rung.state))).toMatchObject({ ending: "ipo", ipo: { float: 0.25 } });
  });

  it("shows an until-IPO game with no last day", () => {
    const s = ipoSim(0);
    const state = s.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3, gameLength: "until-ipo" });
    expect(renderStatus(s, state)).toMatch(/\| day 1 \(Until IPO, Normal\) \| .* \| PLAYING/);
  });
});

describe("the IPO checklist over time", () => {
  it("stops time when the company is no longer ready", () => {
    const s = createSim({
      ...defaultConfig,
      // No moderation, as on main before moderators: this is about something else.
      productTypes: { ...defaultConfig.productTypes, social: { ...defaultConfig.productTypes.social, moderation: undefined } },
      // A provider outage on day 30 is the only event: it breaks the uptime record.
      events: [
        {
          id: "providerOutage",
          name: "Provider outage",
          description: "The provider's data centre lost power.",
          layer: "facilities",
          schedule: { type: "fixed", days: [30] },
          days: 1,
          effects: { saas: { downtimeHours: 6, detail: "The SaaS platform went down with it." } },
        },
      ],
      ipo: {
        ...defaultConfig.ipo,
        recordDays: 2,
        minSatisfaction: 0,
        maxCostSwing: 5,
        products: { ...defaultConfig.ipo.products, social: { users: 0, annualRevenue: 0, payingUsers: 0 } },
      },
    });
    let state = s.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3 });
    state = s.advance(state, 25).state;
    expect(s.ipo(state).ready).toBe(true);
    const turn = advanceUntil(s, state, 10, who);
    expect(turn.state.day).toBe(30);
    expect(turn.lines.at(-1)).toMatch(/stopped on day 30: .*IPO: no longer ready \(uptime record\)/);
  });
});

describe("rescue buyout and liquidation", () => {
  // Far more developers than the company can pay for: cash runs out within the 40 days.
  const broke = (): GameState => sim.applyAction(start(), { type: "hire", pool: "developers", grade: "senior", count: 40 });

  it("reads the rescue commands", () => {
    expect(parseCommand("rescue")).toEqual({ kind: "rescue" });
    expect(parseCommand("buyback")).toEqual({ kind: "action", action: { type: "buyBack" }, times: 1 });
  });

  it("stops time on the rescue, shows the cash, share taken and cuts, and offers the buy-back at its price", () => {
    expect(run(start(), "rescue").lines[0]).toMatch(/no rescue yet/);
    let turn = advanceUntil(sim, broke(), 40, who);
    while (!turn.state.rescue) turn = advanceUntil(sim, turn.state, 40, who);
    const { rescue } = turn.state;
    expect(turn.lines.at(-1)).toMatch(new RegExp(`^stopped on day ${rescue.day}: Cash ran out: a vulture VC rescued the company for 75% of it`));
    expect(turn.lines.join("\n")).toMatch(/vulture VC rescued Test Co: it put in £[\d,]+ .* 75% of the company/);
    expect(turn.lines.join("\n")).toMatch(/Forced cost cuts: the vulture VC let go 11 senior developers/);
    const view = sim.rescue(turn.state)!;
    expect(renderStatus(sim, turn.state)).toMatch(/rescue: day \d+, a vulture VC put in £[\d,]+ for 75%; it owns 75% and sells it back for £[\d,]+/);
    expect(renderStatus(sim, turn.state)).toMatch(/you 25%, vulture vc 75%/);
    expect(renderCommands(sim, turn.state)).toContain(`buyback   (buy all the vulture VC's shares back from company cash: £${view.buyBackPrice!.toLocaleString("en-GB")}`);
    const terms = run(turn.state, "rescue").lines.join("\n");
    expect(terms).toMatch(/forced cuts: 11 senior developers/);
    expect(terms).toMatch(/buy-back \(buyback\): £[\d,]+ for its 30,000 shares \(75%\)/);
    const refused = run(turn.state, "buyback");
    expect(refused.lines[0]).toMatch(/buyBack refused: The vulture VC wants £[\d,]+ for its shares/);
    expect(refused.rows[0]).toMatchObject({ type: "buyBack", ok: false, error: "cant_afford" });
    const rich = { ...turn.state, cash: view.buyBackPrice! };
    const bought = run(rich, "buyback");
    expect(bought.rows[0]).toMatchObject({ type: "buyBack", ok: true });
    expect(renderStatus(sim, bought.state)).toMatch(/you bought it back on day \d+ for £/);
  });

  it("ends in liquidation the second time, and still shows the rescue after", () => {
    const long = createSim({ ...defaultConfig, finalDay: 120 });
    const begun = long.newGame({ companyName: "Test Co", productType: "social", model: "paas", seed: 3, takeLoan: true });
    let turn = advanceUntil(long, long.applyAction(begun, { type: "hire", pool: "developers", grade: "senior", count: 40 }), 120, who);
    while (turn.state.status === "playing") turn = advanceUntil(long, turn.state, 120, who);
    expect(turn.state.status).toBe("liquidated");
    expect(turn.lines.join("\n")).toMatch(/Cash ran out again, after the rescue buyout on day \d+: Test Co goes into liquidation/);
    expect(turn.lines.at(-1)).toMatch(/^GAME OVER: liquidated on day \d+/);
    expect(turn.rows.at(-1)).toMatchObject({ type: "end", params: { status: "liquidated" } });
    const after = runScript(long, turn.state, "rescue; buyback", who).lines;
    expect(after[1]).toMatch(/^rescue on day/);
    expect(after.at(-1)).toBe("not run: the game is over");
    expect(JSON.parse(renderSummary(long, turn.state))).toMatchObject({ ending: "liquidation", valuation: 0, rescue: { share: 0.75 } });
  });
});

describe("the calendar", () => {
  const full = createSim(defaultConfig);
  const shop = (startDate: string) =>
    full.newGame({ companyName: "Test Co", productType: "ecommerce", model: "saas", seed: 3, startDate });
  /** Plays on until time stops for a holiday. */
  const toHoliday = (state: GameState) => {
    let turn = advanceUntil(full, state, 60, who);
    while (!/holiday/i.test(turn.lines.at(-1)!)) turn = advanceUntil(full, turn.state, 60, who);
    return turn;
  };

  it("reads the calendar command", () => {
    expect(parseCommand("calendar")).toEqual({ kind: "calendar" });
    expect(renderCommands(sim, start())).toContain("calendar");
  });

  it("shows the date and the next holiday in the status, and every holiday to come on asking", () => {
    const state = shop("2026-11-01");
    const status = renderStatus(full, state);
    expect(status).toContain("| Sunday 1 November 2026 |");
    expect(status).toContain("calendar: next: Black Friday in 26 days, day 27 (load ×2.2, growth ×2.5)");
    const { lines } = runCommand(full, state, parseCommand("calendar"), who);
    expect(lines[0]).toBe("calendar: Sunday 1 November 2026, year 1 of the game (started 2026)");
    expect(lines).toContain("  Christmas: in 47 days, 18 Dec 2026–1 Jan 2027 (days 48–62), load ×1.5, growth ×1.4. Last-minute gifts, then the Boxing Day sales.");
  });

  it("stops time when a holiday that hits the product is announced, and when it starts", () => {
    const announced = toHoliday(shop("2026-11-01"));
    expect(announced.state.day).toBe(13);
    expect(announced.lines.at(-1)).toContain("Holiday coming in 14 days: Black Friday, on Friday 27 November 2026");
    expect(announced.lines.some((l) => l.includes("day 13: Black Friday is coming in 14 days"))).toBe(true);
    const started = toHoliday(announced.state);
    expect(started.state.day).toBe(27);
    expect(started.lines.at(-1)).toContain("Holiday started: Black Friday, for 4 days");
    expect(renderStatus(full, started.state)).toContain("Black Friday on now to day 30 (load ×2.2, growth ×2.5)");
  });
});

describe("moderators", () => {
  const shop = () => sim.newGame({ companyName: "Test Co", productType: "ecommerce", model: "paas", seed: 3 });
  const launchedSocial = () => {
    let state = run(start(), "instances 2").state;
    state = run(state, "managed database small").state;
    while (sim.launch(state).status !== "launched") state = run(state, "next 1").state;
    return state;
  };

  it("shows reports and hires moderators on a content product, and neither on a shop", () => {
    const state = launchedSocial();
    const status = renderStatus(sim, state);
    expect(status).toMatch(/reports \d+\/day \| moderators can handle 0\/day \(a mid 60\), handled 0 yesterday \| unhandled \d+ \| satisfaction target ×[\d.]+ \| lawsuit odds ×[\d.]+/);
    expect(renderCommands(sim, state)).toContain("hire <developers|ops|support|moderators>");
    const hired = run(state, "hire moderators junior 2");
    expect(hired.rows[0]).toMatchObject({ ok: true, params: { pool: "moderators", grade: "junior", count: 2 } });
    expect(renderStatus(sim, hired.state)).toMatch(/moderators 0 .*hired, not started: 2 junior/);

    expect(renderStatus(sim, shop())).not.toMatch(/reports|moderators/);
    expect(renderCommands(sim, shop())).toContain("hire <developers|ops|support>");
    const refused = run(shop(), "hire moderators");
    expect(refused.lines[0]).toMatch(/refused: .*no user content to moderate/);
    expect(refused.rows[0]).toMatchObject({ ok: false, error: "no_content", moderators: 0 });
  });

  it("stops time when reports go unhandled, and logs moderators in each row", () => {
    let turn = run(launchedSocial(), "next 30");
    while (!/reports unhandled/.test(turn.lines.at(-1)!) && turn.state.day < 30) turn = run(turn.state, "next 30");
    expect(turn.lines.at(-1)).toMatch(/^stopped on day \d+: .*reports unhandled \(\d+\)/);
    expect(turn.lines.some((l) => /reports on user content are waiting for a moderator/.test(l))).toBe(true);
    const staffed = run(turn.state, "move moderators developers");
    expect(staffed.rows[0]).toMatchObject({ ok: true, moderators: 1 });
  });
});

describe("rivals", () => {
  it("shows market share in the status and the market in full, changing nothing", () => {
    const state = start();
    expect(parseCommand("market")).toEqual({ kind: "market" });
    expect(renderStatus(sim, state)).toMatch(/market share: you \d+% at £5 q\d+, Natterly \d+% at £4 q\d+, GatherHub \d+% at £6\.25 q\d+ \| rivals (slow|speed up|leave) your growth (to|at) \d+%/);
    expect(renderCommands(sim, state)).toMatch(/market {3}\(rivals' prices, quality and share/);
    const market = run(state, "market");
    expect(market.state).toBe(state);
    expect(market.lines.join("\n")).toMatch(/Natterly: [\d,]+ users, [\d.]+% share \| £4\/month \| quality [\d.]+ \(0 features, 98\.5% uptime\)/);
    expect(market.lines.join("\n")).toMatch(/casual: you \d+%, Natterly \d+%, GatherHub \d+% \| best: Natterly/);
  });

  it("drives the rivals with a price change: they answer it two weeks on, and the log says so", () => {
    const priced = run(run(start(), "next 10").state, "price 6").state;
    expect(renderStatus(sim, priced)).toMatch(new RegExp(`rivals answer your £6 on day ${priced.day + 15}`));
    // Advances stop early when something needs the player, so keep going past the day the rivals answer.
    let state = priced;
    const all: string[] = [];
    while (state.day < priced.day + 15 && state.status === "playing") {
      const turn = run(state, "next 15");
      state = turn.state;
      all.push(...turn.lines);
    }
    const lines = all.join("\n");
    expect(lines).toMatch(/day \d+: (Natterly|GatherHub) (answered your £6 price|undercut you)/);
  });
});

describe("the payments app", () => {
  const full = createSim();
  const pay = (): GameState =>
    full.advance(full.newGame({ companyName: "Pay Co", productType: "payments", model: "saas", seed: 3 }), 20).state;
  const runFull = (state: GameState, text: string) => {
    const command = parseCommand(text);
    return command.kind === "next" ? advanceUntil(full, state, command.days, who) : runCommand(full, state, command, who);
  };

  it("reads a fee with an optional transaction fee in %", () => {
    expect(parseCommand("price 12 2.5%")).toEqual({ kind: "action", action: { type: "setPrice", price: 12, rate: 0.025 }, times: 1 });
    expect(parseCommand("price 0 3")).toMatchObject({ action: { type: "setPrice", price: 0, rate: 0.03 } });
    expect(parseCommand("price 12")).toEqual({ kind: "action", action: { type: "setPrice", price: 12 }, times: 1 });
    expect(parseCommand("preview 12 2.5%")).toEqual({ kind: "preview", price: 12, rate: 0.025 });
    expect(() => parseCommand("price 12 lots")).toThrow(/transaction fee/);
  });

  it("shows both prices, both income streams and the busy days, and the commands that set them", () => {
    const state = pay();
    const status = renderStatus(full, state);
    expect(status).toMatch(/price £10\/month \+ 2% of payments = £30 a usual month per business \(fair £10 \+ 2% = £30/);
    expect(status).toMatch(/payments: £[\d,]+ on a usual day -> fees £[\d,]+ \+ transaction fees £[\d,]+\/day \| SaaS platform's fee £[\d,]+\/day/);
    expect(status).toMatch(/next payday day 28, Black Friday (day \d+|none) \| so far fees £[\d,]+, transaction fees £[\d,]+/);
    expect(status).toMatch(/thresholds are a usual month's cost: yours £30/);
    expect(renderCommands(full, state)).toMatch(/price <fee 0–1000> \[transaction fee 0–20%, e\.g\. 2\.5%\]/);
    // Other products show one price, as before.
    expect(renderStatus(sim, start())).toMatch(/price £5\/month \(fair £5\)/);
    expect(renderStatus(sim, start())).not.toMatch(/payments:/);
  });

  it("previews and sets both in one change, with one lock", () => {
    const state = pay();
    const preview = runFull(state, "preview 12 2.5%");
    expect(preview.state).toBe(state);
    expect(preview.lines[0]).toMatch(/^preview £10 \+ 2% \(£30 a usual month\)→£12 \+ 2\.5% \(£37 a usual month\) \(rise\)/);
    const changed = runFull(state, "price 12 2.5%").state;
    expect(changed).toMatchObject({ price: 12, transactionRate: 0.025 });
    expect(renderStatus(full, changed)).toMatch(/price £12\/month \+ 2\.5% of payments = £37 .* locked 14 more days/);
    expect(renderStatus(full, changed)).toMatch(/price wave: rise £10 \+ 2%→£12 \+ 2\.5%/);
    expect(renderCommands(full, changed)).not.toMatch(/^ {2}price </m);
  });

  it("announces Black Friday on the calendar, and stops time for it", () => {
    // Day 1 is 1 October 2026: Black Friday (day 58) is announced 14 days before, on day 44.
    const started = full.newGame({ companyName: "Pay Co", productType: "payments", model: "saas", seed: 3, startDate: "2026-10-01" });
    const state = full.advance(started, 40).state;
    expect(renderStatus(full, state)).toMatch(/Black Friday day 58/);
    const turn = runFull(state, "next 7");
    expect(turn.state.day).toBe(44);
    expect(turn.lines.join("\n")).toMatch(/day 44: Black Friday is coming in 14 days/);
  });
});

describe("the new products (#118)", () => {
  it("names the product and shows its SaaS per-user fee", () => {
    const state = sim.advance(sim.newGame({ companyName: "Test Co", productType: "assistant", model: "saas", seed: 3 }), 3).state;
    const status = renderStatus(sim, state);
    expect(status).toContain("== Test Co | AI assistant (assistant) on saas |");
    expect(status).toMatch(/capacity: the provider's \(no limit\) \| £2\.80\/user\/month on [\d,]+ users = £[\d,]+\/month, plus £900\/month/);
    expect(status).toContain("api: Assistant API not bought");
  });

  it("plays a games network: its features and paid API are commands", () => {
    let state = sim.newGame({ companyName: "Test Co", productType: "games", model: "saas", seed: 3 });
    expect(renderStatus(sim, state)).toContain("Games network (games) on saas");
    const turn = runScript(sim, { ...state, cash: 50_000 }, "addon achievements; buyapi", who);
    state = turn.state;
    expect(sim.features(state).find((f) => f.id === "achievements")?.status).not.toBe("notStarted");
    expect(sim.api(state)?.owned).toBe(true);
  });
});
