import { describe, expect, it } from "vitest";
import { createSim, defaultConfig, SimError, type GameConfig, type GameState } from "../src/index.ts";
import { advanceUntil, parseCommand, renderCommands, renderStatus, renderSummary, runCommand, runScript } from "../scripts/textPlay.ts";
import { withFullCsuite } from "./executives.ts";
import { allOpen, inPhase } from "./phases.ts";

/** No MVP to build: the MVP has its own tests. */
const NO_MVP: GameConfig["mvp"] = { ...defaultConfig.mvp, baseDevDays: { ecommerce: 0, social: 0, video: 0, payments: 0, assistant: 0, games: 0 } };
/** Launch presses itself once there is somewhere to serve users, as the tests here were written for: Launch has its own test. */
const AUTO_LAUNCH: GameConfig["launch"] = { ...defaultConfig.launch, auto: 1 };
// No pay reviews, which would hold the clock every ten days of a 40-day game: they have their own tests below.
const sim = createSim({ ...defaultConfig, mvp: NO_MVP, launch: AUTO_LAUNCH, finalDay: 40, payReview: { ...defaultConfig.payReview, on: 0 } });
const who = { player: "test", playstyle: "average-joe" };
const start = (): GameState =>
  sim.newGame({ companyName: "Test Co", productType: "social", model: "paas", seed: 3, takeLoan: true });
/** The same, in the Launch phase (#236): price, ops, support and moderators open. */
const launchPhase = (): GameState => inPhase(start(), "launch");

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
    const turn = run(launchPhase(), "hire support junior 3");
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
    const hired = run(launchPhase(), "hire support agency 2");
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

  it("previews a rise's ticket burst and whether support clears it (#163)", () => {
    // A company with users to react: 400 of 1,000 paying.
    const state: GameState = { ...start(), users: 1000, paidUsers: 400 };
    const p = sim.pricePreview(state, state.price * 2);
    expect(p.tickets.tickets).toBeGreaterThan(0);
    const line = run(state, `preview ${state.price * 2}`).lines[0]!;
    expect(line).toContain(`; +${p.tickets.tickets} tickets (busiest day +${p.tickets.peakDay}; support clears ${p.tickets.clearance}/day`);
    expect(line).toMatch(/: support (clears them as they come|falls behind: up to \d+ extra waiting, cleared by the end|can't keep up: up to \d+ extra waiting, \d+ still waiting after)/);
    // A cut brings no burst, so says nothing about tickets.
    expect(run(state, `preview ${state.price / 2}`).lines[0]).not.toContain("tickets");
  });

  it("shows the customer mix with thresholds, and a rise's reaction by customer type", () => {
    const state = advanceUntil(sim, run(launchPhase(), "instances 2").state, 20, who).state;
    expect(renderStatus(sim, state)).toMatch(
      /customer mix: casual 70\.\d% \(threshold £5\), enthusiasts 20\.\d% \(threshold £6\.25\), professionals \d\.\d% \(threshold £10\), businesses \d\.\d% \(threshold £15\)/,
    );
    const line = run(state, "preview 7.5").lines[0]!;
    expect(line).toMatch(/reaction \d+\.\d% of payers = casual \d+\.\d% × 70% \+ enthusiasts .* \+ businesses \d+\.\d% × 2%/);
    const raised = run(state, "price 7.5").state;
    expect(renderStatus(sim, raised)).toMatch(/casual 70\.\d% \(threshold £5!\)/);
  });

  it("shows who new users join as, and what features and the price pull in", () => {
    const state = advanceUntil(sim, run(launchPhase(), "instances 2").state, 20, who).state;
    expect(renderStatus(sim, state)).toMatch(
      // The product's mix, tilted a little by the rivals.
      /new users join as: casual \d+\.\d%( \(rivals x[\d.]+\))?, enthusiasts \d+\.\d%( \(rivals x[\d.]+\))?, professionals \d+\.\d%( \(rivals x[\d.]+\))?, businesses \d+\.\d%( \(rivals x[\d.]+\))?\n/,
    );
    expect(renderStatus(sim, state)).toMatch(/groups locked \(tier 4\) \[pulls professionals x1\.5\]/);
    // Twice the fair price: a quarter as many casual users join.
    const dear = run(state, "price 10").state;
    expect(renderStatus(sim, dear)).toMatch(/new users join as: casual \d+\.\d% \(price x0\.25(, rivals x[\d.]+)?\), enthusiasts \d+\.\d% \(price x0\.39(, rivals x[\d.]+)?\), professionals/);
    const grouped: GameState = { ...state, features: { groups: { status: "built", progress: 0 } } };
    expect(renderStatus(sim, grouped)).toMatch(/professionals \d+\.\d% \(features x1\.44(, rivals x[\d.]+)?\)/);
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

  it("says why each command after the game ends isn't run, and still shows what changes nothing", () => {
    const turn = runScript(sim, start(), "end; letgo ops; valuation; payhistory; look", who);
    expect(turn.lines[turn.lines.indexOf("> letgo ops") + 1]).toBe("not run: the game is over");
    // Read-only views still work once it's over (#266): the brief asks for payhistory at the end.
    expect(turn.lines[turn.lines.indexOf("> valuation") + 1]).toMatch(/^valuation £/);
    expect(turn.lines[turn.lines.indexOf("> payhistory") + 1]).toMatch(/^pay history|no pay reviews/);
    expect(turn.lines[turn.lines.indexOf("> look") + 1]).toMatch(/^== Test Co .*ENDED BY TEACHER/);
  });

  it("runs look inside a batch (#266)", () => {
    const turn = runScript(sim, start(), "look", who);
    expect(turn.lines[0]).toBe("> look");
    expect(turn.lines[1]).toMatch(/^== Test Co /);
    expect(turn.lines.join("\n")).toMatch(/^commands \(join several with ';'\):/m);
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
    const s = createSim({ ...defaultConfig, mvp: NO_MVP, launch: AUTO_LAUNCH, finalDay: 40, payReview: { ...defaultConfig.payReview, on: 0 }, events: [{ ...viral, encounter: undefined, schedule: { type: "fixed", days: [10] } }] });
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
      mvp: NO_MVP, launch: AUTO_LAUNCH,
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
    const yearly = createSim({ ...defaultConfig, launch: AUTO_LAUNCH, allowedGameLengths: { "180-days": 0, "until-ipo": 0, "1-year": 1, career: 1 } });
    const career = yearly.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3, gameLength: "career" });
    expect(renderStatus(yearly, career)).toMatch(/day 1\/17155 \(Career \(47 years, age 18 to 65\), Normal, a week a tick\)/);
  });

  it("shows the game's difficulty", () => {
    const any = createSim({ ...defaultConfig, launch: AUTO_LAUNCH, allowedDifficulties: { easy: 1, normal: 1, hard: 1 } });
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

  it("shows the phase, hides the commands for jobs not open yet, and says why one is refused (#236)", () => {
    const build = start();
    const status = renderStatus(sim, build).split("\n");
    expect(status[1]).toBe(
      "phase: Build (from day 1) | next: Launch, when you press Launch | open: Deployment model, Funding: the bank loan, friends and family and grants, Developers, Instances" +
        " | the CFO opens early once you take outside money (friends and family, or a grant)",
    );
    expect(renderStatus(sim, build)).toMatch(/^price £5\/month \(fair £5\) \| set at Launch$/m);
    const commands = renderCommands(sim, build);
    expect(commands).toMatch(/^ {2}hire <developers> /m);
    expect(commands).not.toMatch(/^ {2}(price|preview|build|addon|benefit|buyapi|ipo|apply) /m);
    const refused = run(build, "hire support");
    expect(refused.lines[0]).toBe(
      "hire refused: Support staff: not open until the Launch phase, when you press Launch. You're in the Build phase.",
    );
    expect(refused.rows[0]).toMatchObject({ type: "hire", ok: false, error: "not_yet" });

    const launch = inPhase(build, "launch", 5);
    expect(renderStatus(sim, launch).split("\n")[1]).toMatch(/^phase: Launch \(from day 5\) \| next: Grow, when your first angel investor approaches \| open: .*, Price, Ops staff, Support staff, Moderators, Tier 1 features \| the CFO opens early/);
    expect(renderStatus(sim, launch)).toMatch(/^price £5\/month \(fair £5\) \| can change$/m);
    expect(renderCommands(sim, launch)).toMatch(/^ {2}hire <developers\|ops\|support\|moderators> /m);
    expect(renderCommands(sim, launch)).toMatch(/^ {2}price </m);
    // Tier 1 features open at Launch (#263); research, benefits, the API and the IPO wait.
    expect(renderCommands(sim, launch)).toMatch(/^ {2}build <notifications> /m);
    expect(renderCommands(sim, launch)).not.toMatch(/^ {2}(unlock|benefit|buyapi|ipo) /m);

    const grow = inPhase(build, "grow");
    expect(renderCommands(sim, grow)).toMatch(/^ {2}hire <developers\|ops\|support\|moderators\|researchers\|marketers> /m);
    expect(renderCommands(sim, grow)).toMatch(/^ {2}build </m);
    expect(renderCommands(sim, grow)).not.toMatch(/^ {2}ipo /m);

    const scale = allOpen(build);
    expect(renderStatus(sim, scale).split("\n")[1]).toMatch(/^phase: Scale \(from day 1\) \| open: .*, The IPO$/);
    expect(renderCommands(sim, scale)).toMatch(/^ {2}ipo /m);
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
  /** In the Grow phase, where the paid API opens (#236). */
  const shop = (model: "iaas" | "paas" | "saas") =>
    inPhase(sim.newGame({ companyName: "Shop Co", productType: "ecommerce", model, seed: 3, takeLoan: true }), "grow");

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

  it("warns an order will need more ops, and shows an ops shortfall once it bites (#259)", () => {
    // An IaaS shop with no servers yet, and no ops: its first server will need one.
    const noOps = shop("iaas");
    const ordered = run({ ...noOps, staff: { ...noOps.staff, ops: { junior: 0, mid: 0, senior: 0 } } }, "rent app large");
    expect(ordered.lines[0]).toBe("rentServer: done. OPS: once it's ready you'll need 1 ops staff, and yours do the work of 0: hire ops (or retrain someone) before then, or capacity is cut.");
    // Not short today: the server isn't running yet.
    expect(renderStatus(sim, ordered.state)).not.toMatch(/^ops: /m);
    const turn = run(ordered.state, "next 7");
    expect(turn.lines.at(-1)).toMatch(/Short of ops: \d+ of \d+ needed, capacity cut to \d+%/);
    const status = renderStatus(sim, turn.state);
    expect(status).toMatch(/^ops: \d+ of \d+ needed, capacity cut to \d+% \(hire ops, or retrain someone into ops\)$/m);
    expect(status).toMatch(/^capacity: .* \| every tier CUT to \d+% for missing ops$/m);
  });

  it("cancels with `cancel N now` on Hard only, and shows a cancel waiting for its replacement (#260)", () => {
    expect(parseCommand("cancel 3 now")).toMatchObject({ action: { type: "cancelServer", id: 3, now: true } });
    expect(parseCommand("sell 3")).toMatchObject({ action: { type: "sellServer", id: 3 } });
    expect(() => parseCommand("cancel 3 later")).toThrow(/cancel <server id> now/);
    const anyLevel = createSim({ ...defaultConfig, mvp: NO_MVP, launch: AUTO_LAUNCH, allowedDifficulties: { easy: 1, normal: 1, hard: 1 } });
    const go = (s: GameState, text: string) => runCommand(anyLevel, s, parseCommand(text), who);
    const setUp = (difficulty: string) => {
      const state = inPhase(anyLevel.newGame({ companyName: "Shop Co", productType: "ecommerce", model: "iaas", seed: 3, takeLoan: true, difficulty }), "grow");
      const rented = go(go(state, "rent app large").state, "rent database large").state;
      // Live, with users on the servers.
      return advanceUntil(anyLevel, rented, 5, who).state;
    };
    const normal = setUp("normal");
    const app = normal.servers.find((s) => s.type === "app")!.id;
    expect(go(normal, `cancel ${app}`).lines[0]).toMatch(/^cancelServer refused: You can't cancel that server: it would leave no compute \(CU\) for today's load/);
    expect(go(normal, `cancel ${app} now`).lines[0]).toMatch(/^cancelServer refused: You can't cancel/);
    // With a replacement on order it waits, and the status says so.
    const waiting = go(go(normal, "rent app large").state, `cancel ${app}`).state;
    expect(renderStatus(anyLevel, waiting)).toMatch(new RegExp(`#${app} large app .*\\(CANCELLING: goes at the end of day \\d+, when its replacement is ready; still serving and billed\\)`));
    expect(renderCommands(anyLevel, waiting)).toMatch(/cancel <server id> \[now\]/);

    const hard = setUp("hard");
    expect(go(hard, `cancel ${app}`).lines[0]).toMatch(new RegExp(`cancelServer refused: Cancelling that server would .*: expect an outage\\. To go ahead anyway, confirm it \\(\`cancel ${app} now\`\\)\\.`));
    const gone = go(hard, `cancel ${app} now`);
    expect(gone.lines[0]).toBe("cancelServer: done");
    expect(gone.state.servers.map((s) => s.id)).not.toContain(app);
  });

  it("stops time when calls start being dropped", () => {
    let state = run(shop("iaas"), "rent app large").state;
    state = run(state, "rent database large").state;
    state = run(state, "buyapi").state;
    const turn = run(state, "next 7");
    expect(turn.lines.at(-1)).toMatch(/API calls are being dropped/);
    expect(turn.lines.some((l) => /Shop API: [\d,]+ calls dropped/.test(l))).toBe(true);
  });

  it("shows PaaS autoscaling's instances, minimum and maximum, and sets the maximum (#261)", () => {
    expect(parseCommand("autoscale max 30")).toMatchObject({ action: { type: "setAutoscaleMax", max: 30 } });
    expect(() => parseCommand("autoscale 30")).toThrow(/autoscale max <n>/);
    const paas = run(shop("paas"), "instances 15").state;
    expect(renderStatus(sim, paas)).toMatch(/^basic autoscaling: instances 15 \(min 15, max 20, following today's instances until you set it\) \| baseline 1\.25× yesterday's demand/m);
    const scaling = { ...paas, benefits: [...paas.benefits, "paasAutoscaling"] };
    expect(renderStatus(sim, scaling)).toMatch(/^managed autoscaling: instances 15 \(min 15, max 20, following today's instances until you set it\) \| baseline 1\.5× yesterday's demand/m);
    expect(renderCommands(sim, scaling)).toMatch(/autoscale max <n>/);
    const capped = run(scaling, "autoscale max 18");
    expect(capped.lines[0]).toBe("setAutoscaleMax: done");
    expect(renderStatus(sim, capped.state)).toMatch(/^managed autoscaling: instances 15 \(min 15, max 18\)/m);
    expect(run(scaling, "autoscale max 10").lines[0]).toMatch(/^setAutoscaleMax refused: Set a maximum between your minimum of 15/);
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
    expect(() => parseCommand("accept bank")).toThrow(/ff \(friends and family\), grant, angel or vc/);
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
    expect(odds.lines.join("\n")).toMatch(/asks 20% better \(most 50%\): −6 on the roll\n  high 5% → £17,400 .*\n  middle 35% → £16,500 .*\n  low 60% → £14,400/);
    let turn = run(state, "counter ff amount 18000");
    expect(turn.rows[0]).toMatchObject({ type: "counterFunding", ok: true, params: { funder: "friendsAndFamily", terms: { amount: 18_000 } } });
    expect(turn.lines[0]).toMatch(/^counter £18,000 for [\d.]+%: rolled \d+ −6 for asking 20% = −?\d+: ((high|middle), they moved \d+% of the way|low, they dug in: the offer got worse by 20% of what you asked)\. Offer 2: .*\(1 counter left\)/);
    expect(renderStatus(sim, turn.state)).toMatch(/friends and family offer 2 of 3, 1 counter left/);
    expect(run(turn.state, "funding").lines.join("\n")).toMatch(/offer 1 £15,000 .*; you asked £18,000 .*, rolled .* → offer 2 /);
    turn = run(turn.state, "counter ff share 20");
    expect(turn.lines[0]).toMatch(/Offer 3: .* \(final: accept or decline\)/);
    expect(renderStatus(sim, turn.state)).toMatch(/friends and family final offer/);
    expect(renderCommands(sim, turn.state)).not.toMatch(/counter ff/);
    expect(renderCommands(sim, turn.state)).toMatch(/odds <grant>/);
    expect(run(turn.state, "counter ff amount 20000").lines[0]).toMatch(/refused: This is the final offer/);
  });

  it("auto-negotiates: one command plays each round to the final offer, and leaves accepting to the player", () => {
    const state = start();
    expect(renderCommands(sim, state)).toMatch(/auto <ff\|grant> \.\.\./);
    expect(parseCommand("auto ff amount 18000")).toEqual({
      kind: "action",
      action: { type: "autoNegotiateFunding", funder: "friendsAndFamily", terms: { amount: 18_000 } },
      times: 1,
    });
    expect(parseCommand("auto angel share 9")).toMatchObject({ action: { type: "autoNegotiateInvestor", terms: { share: 0.09 } }, party: "angel" });
    const turn = run(state, "auto ff amount 18000");
    expect(turn.rows[0]).toMatchObject({ type: "autoNegotiateFunding", ok: true });
    expect(turn.lines.join("\n")).toMatch(
      /^auto-negotiated 2 rounds:\n {2}offer 2: you asked £18,000 for [\d.]+%, rolled .* → £[\d,]+ for [\d.]+%\n {2}offer 3: you asked £[\d,]+ for [\d.]+%, rolled .*\n {2}their FINAL offer stands: .* \(accept or decline it; auto-negotiate never accepts\)$/,
    );
    expect(turn.state.funding.friendsAndFamily).toBeNull();
    expect(renderStatus(sim, turn.state)).toMatch(/friends and family final offer/);
    expect(run(turn.state, "auto ff amount 20000").lines[0]).toMatch(/refused: This is the final offer/);
  });

  it("stops time when the grant's condition ends", () => {
    const short = createSim({ ...defaultConfig, mvp: NO_MVP, launch: AUTO_LAUNCH, finalDay: 40, funding: { ...defaultConfig.funding, grant: { ...defaultConfig.funding.grant, days: 5 } } });
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

describe("the angel investor", () => {
  // A low hidden target, so an angel approaches within days of the launch.
  const early = createSim({
    ...defaultConfig,
    launch: AUTO_LAUNCH,
    payReview: { ...defaultConfig.payReview, on: 0 },
    finalDay: 60,
    investors: { ...defaultConfig.investors, angel: { ...defaultConfig.investors.angel, target: { dailyRevenue: 300, days: 3 } } },
  });
  const begin = () => early.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3 });
  const play = (state: GameState, text: string) => {
    const command = parseCommand(text);
    return command.kind === "next" ? advanceUntil(early, state, command.days, who) : runCommand(early, state, command, who);
  };
  /** Plays on until an angel approaches. */
  const untilApproach = () => {
    let turn = play(begin(), "next 30");
    while (!early.investors(turn.state).offer) turn = play(turn.state, "next 30");
    return turn;
  };

  it("reads the angel's commands", () => {
    expect(parseCommand("angel")).toEqual({ kind: "angel" });
    expect(parseCommand("accept angel")).toEqual({ kind: "action", action: { type: "acceptInvestor" }, times: 1, party: "angel" });
    expect(parseCommand("decline angel")).toMatchObject({ action: { type: "declineInvestor" } });
    expect(parseCommand("counter angel amount 30000 share 15")).toMatchObject({
      action: { type: "counterInvestor", terms: { amount: 30_000, share: 0.15 } },
    });
    expect(parseCommand("odds angel share 15")).toEqual({ kind: "odds", funder: "angel", terms: { share: 0.15 } });
  });

  it("stops time when an angel approaches, and shows the offer with its target before it's accepted", () => {
    expect(run(start(), "angel").lines).toEqual(["no angel investor has approached: they come to companies doing well"]);
    const turn = untilApproach();
    const offer = early.investors(turn.state).offer!;
    expect(turn.lines.at(-1)).toMatch(new RegExp(`^stopped on day ${turn.state.day}: ${offer.investor}, an angel investor, wants to invest`));
    expect(turn.lines.join("\n")).toMatch(new RegExp(`day ${turn.state.day}: An angel investor, ${offer.investor}, likes what Test Co is doing`));
    expect(renderStatus(early, turn.state)).toMatch(new RegExp(`investors: ANGEL ${offer.investor} approached on day ${turn.state.day}: offer 1 of 3`));
    expect(renderCommands(early, turn.state)).toMatch(/accept angel \| decline angel/);
    expect(renderCommands(early, turn.state)).toMatch(/counter angel \[amount <£>\] \[share <%>\]/);
    const shown = play(turn.state, "angel").lines.join("\n");
    expect(shown).toContain(`target: ${offer.condition}`);
    expect(shown).toContain(`if missed: ${offer.ifMissed}`);
    expect(shown).toMatch(/accepting: Friends and family and grants close for good/);
    expect(shown).toContain(`offer: answer by day ${offer.lastDay} (${offer.daysLeft} days left) or it lapses, counting as a decline`);
    expect(renderStatus(early, turn.state)).toContain(`answer by day ${turn.state.day + 2} (3 days left) or it lapses`);
  });

  it("negotiates and accepts the angel, closing friends and family and the grant", () => {
    const turn = untilApproach();
    const offer = early.investors(turn.state).offer!;
    const share = Math.round(offer.theirShare * 900) / 10;
    expect(play(turn.state, `odds angel share ${share}`).lines[0]).toMatch(/^counter £[\d,]+ for [\d.]+% asks 10% better/);
    const countered = play(turn.state, `counter angel share ${share}`);
    expect(countered.rows[0]).toMatchObject({ type: "counterInvestor", ok: true });
    expect(countered.lines[0]).toMatch(/Offer 2: .*\(1 counter left\)/);
    const accepted = play(countered.state, "accept angel");
    expect(accepted.rows[0]).toMatchObject({ type: "acceptInvestor", ok: true });
    expect(accepted.lines[0]).toMatch(new RegExp(`^acceptInvestor: done. ${offer.investor} put in £[\\d,]+ for [\\d.]+%; valuation now £`));
    const status = renderStatus(early, accepted.state);
    expect(status).toMatch(/funding: friends and family closed on day \d+ \(you took an angel\) \| grant closed on day/);
    expect(status).toMatch(new RegExp(`investors: angel ${offer.investor} put in .* target £[\\d,]+/day over 3 days and \\+[\\d,]+ net users by day \\d+: £[\\d,]+/day over the last 3 days, and users \\+[\\d,]+ gained −[\\d,]+ lost = -?[\\d,]+ net of [\\d,]+, \\d+ days left`));
    expect(status).toMatch(/\(angel\) [\d.]+%/);
    expect(play(accepted.state, "funding").lines).toEqual([
      `friends and family: closed on day ${accepted.state.day}, when you took on your angel`,
      `grant: closed on day ${accepted.state.day}, when you took on your angel`,
    ]);
    expect(play(accepted.state, "accept ff").lines[0]).toMatch(/refused: Friends and family's offer closed when you took on your angel/);
  });

  it("declines the angel, and another approaches a few days later", () => {
    const turn = untilApproach();
    const declined = play(turn.state, "decline angel");
    expect(renderStatus(early, declined.state)).toMatch(/investors: you declined .*: another angel approaches in a few days/);
    const next = play(declined.state, "next 30");
    expect(next.state.day).toBe(turn.state.day + defaultConfig.investors.retryDays);
    expect(next.lines.at(-1)).toMatch(/an angel investor, wants to invest/);
  });
});

/** The state as if every Series round had approached on day 1 and been declined: no more VCs come, and the IPO's lines are met. */
const allRoundsApproached = (state: GameState): GameState => ({
  ...state,
  investors: {
    ...state.investors,
    vc: { ...state.investors.vc, firstApproachDay: { seriesA: 1, seriesB: 1, seriesC: 1, seriesD: 1 }, approach: null, next: null },
  },
});

describe("venture capital", () => {
  // An early angel, then each round soon after the one before.
  const vc = defaultConfig.investors.vc;
  const early = createSim({
    ...defaultConfig,
    launch: AUTO_LAUNCH,
    payReview: { ...defaultConfig.payReview, on: 0 },
    finalDay: 60,
    investors: {
      ...defaultConfig.investors,
      angel: { ...defaultConfig.investors.angel, target: { dailyRevenue: 300, days: 3 } },
      vc: {
        ...vc,
        gapDays: 2,
        targetDays: 1,
        rounds: {
          ...vc.rounds,
          seriesA: { ...vc.rounds.seriesA, target: { payingUsers: 0.01, dailyRevenue: 0, minUptime: 0 } },
          seriesB: { ...vc.rounds.seriesB, target: { payingUsers: 0.01, dailyRevenue: 0, minUptime: 0 } },
          // A 180-day game's Series B comes at Series C's target.
          seriesC: { ...vc.rounds.seriesC, target: { payingUsers: 0.01, dailyRevenue: 0, minUptime: 0 } },
        },
      },
    },
  });
  const play = (state: GameState, text: string) => {
    const command = parseCommand(text);
    return command.kind === "next" ? advanceUntil(early, state, command.days, who) : runCommand(early, state, command, who);
  };
  /** Plays on, leaving angels to lapse, until `round`'s VCs approach. */
  const until = (round: string, state = early.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3 })) => {
    let turn = play(state, "next 30");
    while (early.investors(turn.state).vc.approach?.round !== round) turn = play(turn.state, "next 30");
    return turn;
  };

  it("reads the VC commands", () => {
    expect(parseCommand("vc")).toEqual({ kind: "vc" });
    expect(parseCommand("pick 2")).toEqual({ kind: "pick", which: "2" });
    expect(parseCommand("accept vc")).toEqual({ kind: "action", action: { type: "acceptInvestor" }, times: 1, party: "vc" });
    expect(parseCommand("decline vc")).toMatchObject({ action: { type: "declineInvestor" }, party: "vc" });
    expect(parseCommand("counter vc share 15")).toMatchObject({ action: { type: "counterInvestor", terms: { share: 0.15 } }, party: "vc" });
    expect(parseCommand("odds vc share 15")).toEqual({ kind: "odds", funder: "vc", terms: { share: 0.15 } });
    expect(() => parseCommand("pick")).toThrow(/which VC to pick/);
  });

  it("stops time when Series A's VCs approach, and shows their three offers and the rounds", () => {
    const turn = until("seriesA");
    const a = early.investors(turn.state).vc.approach!;
    expect(turn.lines.at(-1)).toMatch(new RegExp(`^stopped on day ${turn.state.day}: Series A: three VCs want to invest`));
    const status = renderStatus(early, turn.state);
    expect(status).toMatch(new RegExp(`vc: SERIES A: three VCs approached on day ${turn.state.day}: 1\\) ${a.offers[0]!.investor}, (most cash|fewest conditions|least ownership): £`));
    expect(status).toMatch(/pick one to negotiate with; answer by day \d+ \(3 days left\)/);
    expect(renderCommands(early, turn.state)).toMatch(/pick <1-3\|name>/);
    expect(renderCommands(early, turn.state)).toMatch(/decline vc {3}\(turn all three down/);
    const shown = play(turn.state, "vc").lines.join("\n");
    expect(shown).toMatch(/^Series A: three VCs approached on day \d+\. pick <1-3 or name>/);
    for (const o of a.offers) expect(shown).toContain(`${o.investor} leans to ${o.leanLabel.toLowerCase()} [open]`);
    expect(shown).toContain(`rounds: Series A approached day ${turn.state.day}, Series B not yet (a 180-day game has two VC rounds, each merging two).`);
    for (const o of a.offers) expect(shown).toMatch(new RegExp(`£[\\d,]+ on signing, £${o.secondTranche!.toLocaleString("en-GB")} once you hit their growth target\\.`));
    expect(play(turn.state, "accept angel").lines[0]).toMatch(/refused: It's VCs who are waiting on an answer/);
    expect(play(turn.state, "accept vc").lines[0]).toMatch(/refused: Pick one of the three VCs to negotiate with first/);
  });

  it("picks a VC by number or name, negotiates, accepts, and the lead VC returns for Series B", () => {
    const turn = until("seriesA");
    const a = early.investors(turn.state).vc.approach!;
    expect(() => play(turn.state, "pick 4")).toThrow(/^Expected 1-3 or the name of one of/);
    const picked = play(turn.state, `pick ${a.offers[1]!.investor.split(" ")[0]!.toLowerCase()}`);
    expect(picked.lines[0]).toBe(`pickInvestor: negotiating with ${a.offers[1]!.investor}; the other two VCs have closed. "vc" for their offer in full.`);
    expect(renderStatus(early, picked.state)).toMatch(/ CLOSED; 2\) .* PICKED; 3\) .* CLOSED\. negotiating with/);
    const share = Math.round(a.offers[1]!.theirShare * 900) / 10;
    expect(play(picked.state, `odds vc share ${share}`).lines[0]).toMatch(/^counter £[\d,]+ for [\d.]+% asks 10% better/);
    const countered = play(picked.state, `counter vc share ${share}`);
    expect(countered.lines[0]).toMatch(/Offer 2: .*\(1 counter left\)/);
    const accepted = play(countered.state, "accept vc");
    expect(accepted.lines[0]).toMatch(new RegExp(`^acceptInvestor: done\\. ${a.offers[1]!.investor} put in £[\\d,]+ for [\\d.]+% in your Series A, £[\\d,]+ of it to come once you hit their growth target; valuation now £[\\d,]+\\. They're your lead VC\\.`));
    expect(renderStatus(early, accepted.state)).toMatch(new RegExp(`vc: Series A approached day \\d+ \\(${a.offers[1]!.investor} put in £[\\d,]+ for [\\d.]+%, £[\\d,]+ of it to come once you hit their growth target\\), Series B not yet.*; lead VC ${a.offers[1]!.investor}`));
    expect(renderStatus(early, accepted.state)).toContain(`${a.offers[1]!.investor} (VC) `);
    expect(play(accepted.state, "funding").lines[0]).toBe(`friends and family: closed on day ${accepted.state.day}, when you took on your Series A VC`);

    const b = until("seriesB", accepted.state);
    expect(renderStatus(early, b.state)).toMatch(new RegExp(`SERIES B: three VCs approached on day \\d+: 1\\) ${a.offers[1]!.investor} \\(lead VC\\)`));
    const declined = play(b.state, "decline vc");
    expect(renderStatus(early, declined.state)).toMatch(/you turned down the Series B VCs: three new ones approach in a few days/);
  });
});

describe("the IPO", () => {
  const ipoSim = (cold: number) =>
    createSim({
      ...defaultConfig,
      launch: AUTO_LAUNCH,
      events: [],
      allowedGameLengths: { "180-days": 1, "until-ipo": 1, "1-year": 0, career: 0 },
      ipo: {
        ...defaultConfig.ipo,
        minTradingDays: 20,
        coldChance: { min: cold, max: cold },
        products: { ...defaultConfig.ipo.products, social: { users: 1_000, annualRevenue: 100_000, payingUsers: 500 } },
      },
    });
  /** A SaaS company 40 days in, made comfortably over every condition. */
  const ready = (s: ReturnType<typeof createSim>): GameState => {
    const played = s.advance(s.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3 }), 40).state;
    return {
      // The full C-suite is hired.
      ...withFullCsuite(played),
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
    // The IPO opens in Scale (#236).
    expect(renderCommands(sim, start())).not.toMatch(/^ {2}ipo /m);
    const state = allOpen(start());
    expect(renderStatus(sim, state)).toMatch(/ipo: 1\/6 readiness conditions met; still to meet: trading history, users and revenue, uptime record, predictable costs, the full c-suite$/m);
    expect(renderCommands(sim, state)).toMatch(/ipo {3}\(the IPO readiness checklist/);
    expect(renderCommands(sim, state)).not.toMatch(/apply/);
    expect(run(state, "ipo").lines.join("\n")).toMatch(/\[ \] Trading history: .*\n.*\[ \] Users and revenue: .*\n.*\[ \] Uptime record: /);
    const r = ready(s);
    expect(renderStatus(s, r)).toMatch(/ipo: READY: all 6 conditions met, comfort \d+% \("apply" to float\)/);
    expect(renderCommands(s, r)).toMatch(/apply {3}\(apply to float/);
    expect(play(s, r, "ipo").lines.join("\n")).toMatch(/\[x\] Users and revenue: 2,000 users \(of a market of about 40,000\), 1,000 paying, .*\. Needs 1,000 users, 500 of them paying, .*\. Comfort 100%\./);
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
      launch: AUTO_LAUNCH,
      // No moderation, as on main before moderators, no angel, whose offer lapsing stops time, and no tier 2 opening,
      // which stops it too: this is about something else.
      productTypes: { ...defaultConfig.productTypes, social: { ...defaultConfig.productTypes.social, moderation: undefined } },
      tiers: { ...defaultConfig.tiers, tier2: { marketShare: 1 } },
      investors: {
        ...defaultConfig.investors,
        angel: { ...defaultConfig.investors.angel, target: { ...defaultConfig.investors.angel.target, dailyRevenue: 1_000_000 } },
      },
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
        minTradingDays: 0,
        recordDays: 2,
        minSatisfaction: 0,
        maxCostSwing: 5,
        products: { ...defaultConfig.ipo.products, social: { users: 0, annualRevenue: 0, payingUsers: 0 } },
      },
    });
    let state = s.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3 });
    state = withFullCsuite(allRoundsApproached(s.advance(state, 25).state));
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

  it("stops time the first time cash goes below £0, with the shortfall on the loan and the room left", () => {
    let turn = advanceUntil(sim, broke(), 40, who);
    while (turn.state.firstShortfallDay === null) turn = advanceUntil(sim, turn.state, 40, who);
    const day = turn.state.firstShortfallDay;
    const short = sim.shortfall(turn.state);
    expect(turn.state).toMatchObject({ day, cash: 0, rescue: null });
    expect(turn.lines.at(-1)).toBe(
      `stopped on day ${day}: Cash went below £0 and the shortfall went on your loan: £${short.room.toLocaleString("en-GB")} more and a vulture VC steps in`,
    );
    expect(turn.lines.join("\n")).toMatch(/the shortfall went on your bank loan, still £[\d,]+ a day, now until day \d+/);
    expect(renderStatus(sim, turn.state)).toContain(
      `below £0: £${short.owed.toLocaleString("en-GB")} of shortfalls on your bank loan; the next goes on your bank loan, £${short.room.toLocaleString("en-GB")} more (of 7 days of costs, £${short.limit.toLocaleString("en-GB")}) and the vulture VC steps in`,
    );
    // Once the loan's repaid, the next shortfall opens an emergency loan (#288).
    const repaid = { ...turn.state, loan: { ...turn.state.loan!, paidOffDay: day } };
    expect(renderStatus(sim, repaid)).toMatch(/^below £0: no shortfalls owed; the next goes on a new emergency loan, £[\d,]+ more \(of 7 days of costs, £[\d,]+\) and the vulture VC steps in$/m);
    // An emergency loan says so.
    const emergency = { ...turn.state, loan: { ...turn.state.loan!, emergency: true as const } };
    expect(renderStatus(sim, emergency)).toMatch(/^loan \(emergency\): £[\d,]+ left/m);
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
    const long = createSim({ ...defaultConfig, launch: AUTO_LAUNCH, finalDay: 120, payReview: { ...defaultConfig.payReview, on: 0 } });
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
  const full = createSim({ ...defaultConfig, launch: AUTO_LAUNCH });
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
  /** Both in the Launch phase, where moderators open (#236). */
  const shop = () => inPhase(sim.newGame({ companyName: "Test Co", productType: "ecommerce", model: "paas", seed: 3 }), "launch");
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
    // A move retrains: they join the moderators after a mid's lead time, shown under staff with their start day.
    const staffed = run(turn.state, "move moderators developers");
    expect(staffed.rows[0]).toMatchObject({ ok: true, moderators: 0 });
    expect(renderStatus(sim, staffed.state)).toMatch(/moderators 0 .*\| retraining, paid already: 1 mid start day \d+ \(7d\)/);
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
    const priced = run(run(launchPhase(), "next 10").state, "price 6").state;
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
  const full = createSim({ ...defaultConfig, mvp: NO_MVP, launch: AUTO_LAUNCH });
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
    // Every Series round long since approached, so no VCs stop time: this is about the calendar.
    const state = allRoundsApproached(full.advance(started, 40).state);
    expect(renderStatus(full, state)).toMatch(/Black Friday day 58/);
    const turn = runFull(state, "next 7");
    expect(turn.state.day).toBe(44);
    expect(turn.lines.join("\n")).toMatch(/day 44: Black Friday is coming in 14 days/);
  });
});

describe("the new products (#118)", () => {
  it("names the product and shows its SaaS per-user fee", () => {
    // In Grow, where the paid API opens (#236).
    const state = inPhase(sim.advance(sim.newGame({ companyName: "Test Co", productType: "assistant", model: "saas", seed: 3 }), 3).state, "grow");
    const status = renderStatus(sim, state);
    expect(status).toContain("== Test Co | AI assistant (assistant) on saas |");
    expect(status).toMatch(/capacity: the provider's \(no limit\) \| £2\.80\/user\/month on [\d,]+ users = £[\d,]+\/month, plus £900\/month/);
    expect(status).toContain("api: Assistant API not bought");
  });

  it("plays a games network: its features and paid API are commands", () => {
    let state = inPhase(sim.newGame({ companyName: "Test Co", productType: "games", model: "saas", seed: 3 }), "grow");
    expect(renderStatus(sim, state)).toContain("Games network (games) on saas");
    const turn = runScript(sim, { ...state, cash: 50_000 }, "addon achievements; buyapi", who);
    state = turn.state;
    expect(sim.features(state).find((f) => f.id === "achievements")?.status).not.toBe("notStarted");
    expect(sim.api(state)?.owned).toBe(true);
  });
});

describe("playtest polish (#164)", () => {
  it("shows how full the market is, and when developers have nothing to do", () => {
    const state = sim.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3 });
    const status = renderStatus(sim, sim.advance(state, 10).state);
    expect(status).toMatch(/market \d+% full \(of 40,000 users it can reach\): growth runs at \d+% of an empty market's/);
    expect(status).toMatch(/developers .* \| IDLE: On SaaS the provider builds the features/);
  });

  it("shows a traffic spike's warning while it stands", () => {
    const spike = defaultConfig.events.find((e) => e.id === "trafficSpike")!;
    const warned = createSim({
      ...defaultConfig,
      launch: AUTO_LAUNCH,
      encounters: { ...defaultConfig.encounters, thresholdMin: 10, thresholdMax: 10 },
      events: [{ ...spike, encounter: { chance: 1 } }],
    });
    let state = warned.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3 });
    while (!warned.danger(state).warning && state.day < 30) state = warned.advance(state).state;
    expect(warned.danger(state).warning?.event).toBe("trafficSpike");
    expect(renderStatus(warned, state)).toMatch(/WARNING: A big news site has been asking about your product/);
  });
});

describe("tiers, model benefits and the hardware slider (#123)", () => {
  it("reads buying and dropping a benefit, and setting a server's slider", () => {
    expect(parseCommand("benefit reservedinstances")).toEqual({ kind: "action", action: { type: "buyBenefit", benefit: "reservedInstances" }, times: 1 });
    expect(parseCommand("dropbenefit cdn")).toMatchObject({ action: { type: "cancelBenefit", benefit: "cdn" } });
    expect(parseCommand("slider 3 125")).toMatchObject({ action: { type: "setPerformance", id: 3, performance: 1.25 } });
    expect(parseCommand("unlock managedmonitoring")).toMatchObject({ action: { type: "unlockItem", item: "managedMonitoring" } });
    expect(parseCommand("unlock photos")).toMatchObject({ action: { type: "unlockItem", item: "photos" } });
  });

  it("shows the tiers, locked features and the next tier's condition, and offers unlocks then benefits once their tier is open", () => {
    // Features, unlocks and benefits open in Grow (#236).
    const state = inPhase(start(), "grow");
    expect(renderStatus(sim, state)).toMatch(/^tiers: open 1 \| tier 2 needs users 0\/14,000 OR a CTO hired \(unlocks photos, managedMonitoring\)$/m);
    expect(renderStatus(sim, state)).toMatch(/messaging locked \(tier 3\)/);
    expect(renderCommands(sim, state)).not.toMatch(/^ {2}benefit /m);
    expect(renderCommands(sim, state)).toMatch(/^ {2}build <notifications> /m);
    // Tier 2 available: its items are unlocked with research points (#179) before they can be had.
    const available = { ...state, tiers: [{ tier: 2 as const, day: 1 }], researchPoints: 20 };
    expect(renderStatus(sim, available)).toMatch(/photos locked \(unlock for 15 RP\)/);
    expect(renderCommands(sim, available)).not.toMatch(/^ {2}benefit /m);
    expect(renderCommands(sim, available)).toMatch(
      /^ {2}unlock <photos\|managedMonitoring\|hardwareEfficiency1\|reservedInstances> {3}\(research points; you have 20\) photos 15 RP \(feature\), managedMonitoring 15 RP \(PaaS benefit\), hardwareEfficiency1 15 RP \(on-prem benefit, not your model\), /m,
    );
    const open = run(available, "unlock managedmonitoring").state;
    expect(open.researchPoints).toBe(5);
    expect(renderCommands(sim, open)).toMatch(/^ {2}benefit <managedMonitoring> {3}managedMonitoring £500 \+ £300\/month: /m);
    const bought = run(open, "benefit managedmonitoring").state;
    expect(renderStatus(sim, bought)).toMatch(/^model benefits on: managedMonitoring \(£300\/month\) \(lost if you migrate\)$/m);
    expect(renderCommands(sim, bought)).toMatch(/^ {2}dropbenefit <managedMonitoring>/m);
  });

  it("shows each on-prem server's slider, wear and risk, and drives it", () => {
    let state = sim.newGame({ companyName: "Test Co", productType: "video", model: "onprem", seed: 3, takeLoan: true });
    state = run(state, "buy app massive").state;
    expect(renderCommands(sim, state)).toMatch(/^ {2}slider <server id> <0–150> /m);
    state = run(state, "slider 1 150").state;
    expect(renderStatus(sim, state)).toMatch(/#1 massive app \d+ CU in rack #1 \(arrives in 4d\) \[at 150%, wear 0%, risk 12\.0% overheat\/4\.0% crash a day\]/);
    expect(renderCommands(sim, start())).not.toMatch(/slider/);
  });
});

describe("campaigns (#115) and marketers (#180)", () => {
  /** Launched, with the first angel's approach behind it, so campaigns are open. */
  function grownUp() {
    let state = sim.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3 });
    while (sim.launch(state).status !== "launched") state = sim.advance(state).state;
    return inPhase({ ...state, cash: 100_000, investors: { ...state.investors, firstApproachDay: state.day } }, "grow");
  }

  it("reads starting and stopping a campaign", () => {
    expect(parseCommand("campaign professionals £5,000 30")).toEqual({
      kind: "action",
      action: { type: "startCampaign", customerType: "professionals", budget: 5_000, days: 30 },
      times: 1,
    });
    expect(parseCommand("stopcampaign 2")).toMatchObject({ action: { type: "stopCampaign", id: 2 } });
    expect(() => parseCommand("campaign pensioners 5000 30")).toThrow(/a customer type/);
  });

  it("shows nothing of campaigns until they open, then offers one, runs it and shows its results", () => {
    expect(renderStatus(sim, start())).not.toMatch(/^campaigns:/m);
    expect(renderCommands(sim, start())).not.toMatch(/campaign/);
    // With no marketers, there's no campaign to start, and the commands say why.
    const unstaffed = grownUp();
    expect(renderStatus(sim, unstaffed)).toMatch(/^marketers: 0, 0 free \| a campaign needs a free marketer/m);
    expect(renderStatus(sim, unstaffed)).toMatch(/^campaigns: 0\/0 running, market \d+% full$/m);
    expect(renderCommands(sim, unstaffed)).toMatch(/^ {2}\(no new campaign: Each campaign needs a marketer to run it: hire one on People\.\)$/m);
    expect(run(unstaffed, "hire marketers").rows[0]).toMatchObject({ type: "hire", ok: true });
    expect(run(unstaffed, "hire marketers agency").rows[0]).toMatchObject({ type: "hire", ok: false });
    const state = { ...unstaffed, staff: { ...unstaffed.staff, marketers: { junior: 0, mid: 1, senior: 1 } } };
    expect(renderStatus(sim, state)).toMatch(/^marketers: 2, 2 free \(1 mid, 1 senior; a new campaign gets the senior\)/m);
    expect(renderStatus(sim, state)).toMatch(/^campaigns: 0\/2 running, market \d+% full$/m);
    expect(renderCommands(sim, state)).toMatch(/^ {2}campaign <casual\|enthusiasts\|professionals\|businesses> <budget £100–1000000> <days 7–90> {3}\(spent evenly from tomorrow; brings users of that type\. £1,000 over 14 days: casual £\d\.\d\d–£\d\.\d\d a user \([\d,]+–[\d,]+ users\), /m);
    expect(renderCommands(sim, state)).not.toMatch(/∞/);
    const started = run(state, "campaign businesses 1600 10");
    expect(started.rows[0]).toMatchObject({ type: "startCampaign", ok: true });
    expect(renderCommands(sim, started.state)).toMatch(/^ {2}stopcampaign <1> /m);
    const played = run(started.state, "next 2").state;
    const users = sim.campaigns(played).campaigns[0]!.users;
    expect(users).toBeGreaterThan(0);
    expect(renderStatus(sim, played)).toMatch(new RegExp(String.raw`^ {2}#1 businesses \(senior marketer\) £\d+/£1600, day \d+/10, ${users} users at £\d+\.\d\d, quoted £\d+\.\d\d–£\d+\.\d\d running$`, "m"));
    expect(run(played, "campaigns").lines).toEqual(["campaigns: 1 started", expect.stringMatching(/^ {2}#1 businesses .* quoted £[\d.]+–£[\d.]+ running$/)]);
  });

  it("quotes a campaign over its whole run, and lists every campaign past and present", () => {
    const base = grownUp();
    const state = { ...base, staff: { ...base.staff, marketers: { junior: 0, mid: 4, senior: 0 } } };
    expect(parseCommand("campaignquote casual £2,000 14")).toEqual({ kind: "campaignQuote", customerType: "casual", budget: 2_000, days: 14 });
    expect(run(state, "campaignquote casual 2000 14").lines).toEqual([
      expect.stringMatching(/^campaign quote: casual, £2,000 over 14 days: £\d\.\d\d–£\d\.\d\d a user \([\d,]+–[\d,]+ users\)$/),
    ]);
    expect(run(state, "campaigns").lines).toEqual(["campaigns: none started yet."]);
    let played = state;
    for (const t of ["casual", "enthusiasts", "professionals", "businesses"]) played = run(played, `campaign ${t} 500 7`).state;
    played = sim.advance(played, 8).state;
    played = run(played, "campaign casual 500 7").state;
    // Look shows the last three finished; "campaigns" lists all five, first to last.
    expect(renderStatus(sim, played)).toMatch(/^ {2}\(1 older: "campaigns" lists them all\)$/m);
    const lines = run(played, "campaigns").lines;
    expect(lines[0]).toBe("campaigns: 5 started");
    expect(lines.slice(1).map((l) => l.match(/#(\d) (\w+)/)!.slice(1).join(" "))).toEqual(["1 casual", "2 enthusiasts", "3 professionals", "4 businesses", "5 casual"]);
    expect(lines[1]).toMatch(/finished$/);
    // A market almost full says so, with an estimate, not a cost per user.
    const full = { ...played, users: Math.round(sim.campaigns(played).market.size * 0.95) };
    expect(run(full, "campaignquote casual 1000 14").lines[0]).toMatch(/^campaign quote: casual, £1,000 over 14 days: market almost full: about [\d,]+ users? for £1,000$/);
  });
});

describe("launch", () => {
  // The real game: an MVP to build, and Launch to press once it's done.
  const button = createSim({ ...defaultConfig, finalDay: 40, payReview: { ...defaultConfig.payReview, on: 0 } });
  const play = (state: GameState, text: string) => {
    const command = parseCommand(text);
    return command.kind === "next" ? advanceUntil(button, state, command.days, who) : runCommand(button, state, command, who);
  };

  it("reads launch", () => {
    expect(parseCommand("launch")).toEqual({ kind: "action", action: { type: "launch" }, times: 1 });
  });

  it("offers launch once the MVP is done, says what's missing, and goes live the next day", () => {
    const state = button.newGame({ companyName: "Test Co", productType: "ecommerce", model: "iaas", seed: 3, takeLoan: true });
    expect(renderCommands(button, state)).not.toMatch(/^ {2}launch /m);
    let done = state;
    while (!done.mvp.doneDay) done = play(done, "next 1").state;
    expect(renderCommands(button, done)).toMatch(/^ {2}launch \[price\] {3}\(go live/m);
    expect(renderStatus(button, done)).toMatch(
      /launch: ready \(type launch\); launching now would be short: No app server: no users can be served; No database: no users can be served/,
    );
    const launched = play(done, "launch").state;
    expect(launched.launchDay).toBe(done.day + 1);
    expect(renderStatus(button, launched)).toMatch(new RegExp(`launch: launching, go-live day ${done.day + 1}`));
    expect(play(launched, "next 1").state.users).toBeGreaterThan(0);
  });
});

describe("costs", () => {
  it("shows the status line's costs by heading, the last 7 days' income and runway", () => {
    const state = sim.advance(launchPhase(), 5).state;
    const r = sim.runway(state);
    const money = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;
    expect(renderStatus(sim, state)).toContain(`income ${money(r.dailyIncome)}/day (last 7 days) | costs ${money(r.dailyCosts)}/day`);
    const lines = run(state, "costs").lines;
    expect(lines[0]).toBe(`== Daily costs: ${money(r.dailyCosts)} a day`);
    for (const h of r.costs) expect(lines).toContain(`  ${h.label}: ${money(h.amount)}`);
    // The loan taken at the start is one of them.
    expect(lines).toContain(`  Loan repayments: ${money(sim.loan(state)!.dailyRepayment)}`);
    expect(lines).toContain(`Income averaged over the last 7 days: ${money(r.dailyIncome)} a day.`);
    expect(lines.join("\n")).toMatch(r.days === null ? /Not losing money/ : new RegExp(`cash lasts about ${r.days} days?`));
    expect(renderCommands(sim, state)).toMatch(/ {2}costs {3}\(the daily costs by heading/);
  });

  it("shows the executives' pay, and notes the board's pay holiday", () => {
    const state = sim.advance(launchPhase(), 2).state;
    const c = state.csuite.shortlists.cto[0]!;
    const hired = { ...state, csuite: { ...state.csuite, hired: [{ role: "cto" as const, name: c.name, strength: c.strength, salary: 300, equity: 0, shares: 0, day: 1 }] } };
    expect(run(hired, "costs").lines).toContain("  Executive pay: £300");
    expect(sim.runway(hired).dailyCosts - sim.runway(state).dailyCosts).toBe(300);
    const holiday = { ...hired, csuite: { ...hired.csuite, payHolidaySince: 2 } };
    expect(run(holiday, "costs").lines).toContain("  Executive pay: £0 (the board's pay holiday: none while it lasts)");
  });

  it("puts one-offs on their own line, not in costs", () => {
    // Over a week on, the upfront bill of day 1 is no longer this week's.
    const state = sim.advance(launchPhase(), 8).state;
    expect(sim.runway(state).oneOffsThisWeek).toBe(0);
    expect(renderStatus(sim, state)).not.toMatch(/one-offs this week/);
    // A day's record with a one-off on it: it shows apart, and the costs don't change.
    const last = state.spendByDay.at(-1)!;
    const charged = { ...state, spendByDay: [...state.spendByDay.slice(0, -1), { ...last, oneOffs: 2_500 }] };
    expect(sim.runway(charged).dailyCosts).toBe(sim.runway(state).dailyCosts);
    expect(renderStatus(sim, charged)).toContain("one-offs this week £2,500 (not in costs: see `costs`)");
    expect(run(charged, "costs").lines.at(-1)).toBe("One-offs this week (kit bought, severance, fees, events; not in daily costs): £2,500.");
  });
});

describe("prices: the opening price and the bands", () => {
  // A game whose MVP is done, waiting for Launch to be pressed.
  const manual = createSim({ ...defaultConfig, mvp: NO_MVP, finalDay: 40, payReview: { ...defaultConfig.payReview, on: 0 } });
  const waiting = () =>
    inPhase(manual.advance(manual.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3 })).state, "launch");
  const play = (state: GameState, text: string) => {
    const command = parseCommand(text);
    return command.kind === "next" ? advanceUntil(manual, state, command.days, who) : runCommand(manual, state, command, who);
  };

  it("reads launch with an opening price, and launchpreview", () => {
    expect(parseCommand("launch")).toMatchObject({ action: { type: "launch" } });
    expect(parseCommand("launch 7.5")).toMatchObject({ action: { type: "launch", price: 7.5 } });
    expect(parseCommand("launchpreview 7.5")).toEqual({ kind: "launchPreview", price: 7.5 });
  });

  it("launches at the opening price, then refuses a price change until go-live and locks it after", () => {
    const state = waiting();
    expect(renderCommands(manual, state)).toMatch(/ {2}launch \[price\] {3}\(go live at an opening price, the fair £5 if none/);
    const preview = play(state, "launchpreview 12").lines.join("\n");
    expect(preview).toMatch(/^bands \(of launch users\):/);
    expect(preview).toMatch(/ {2}casual \(\d+(\.\d)?%\): join paying [\d.]+%, join free [\d.]+%, don't join [\d.]+%/);
    const launched = play(state, "launch 6").state;
    expect(launched.price).toBe(6);
    expect(renderStatus(manual, launched)).toMatch(/price £6\/month \(fair £5\) \| opening price, holds until go-live and 14 days after/);
    expect(play(launched, "price 7").lines[0]).toMatch(/setPrice refused: Your opening price of £6 holds until go-live on day \d+, and for 14 days after\./);
  });

  it("prints a preview's bands per customer type and in all, and what customers expect and remember", () => {
    let state = sim.advance(launchPhase(), 15).state;
    state = { ...state, priceLockedUntil: 0 };
    const rise = run(state, `preview ${state.price * 1.4}`).lines.join("\n");
    expect(rise).toMatch(/customers expect £[\d.]+ \(a cut counts from it\) and remember £[\d.]+ \(a rise counts from it\)/);
    expect(rise).toMatch(/bands \(of paying users\):\n {2}casual \([\d.]+%\): accept [\d.]+%, grumble online [\d.]+%, contact support [\d.]+%, drop to free [\d.]+%, leave [\d.]+%/);
    expect(rise).toMatch(/\n {2}all: accept [\d.]+%/);
    const cut = run(state, `preview ${state.price * 0.6}`).lines.join("\n");
    expect(cut).toMatch(/bands \(of the new users it could bring\):/);
    expect(cut).toMatch(/% of free users start paying/);
  });
});

describe("text sweep (#266)", () => {
  it("shows no blank agency rate for researchers and marketers, who are permanent hires only", () => {
    const text = renderStatus(sim, allOpen(start()));
    expect(text).toMatch(/^ {2}researchers 0 .*\/day, no agency \| severance/m);
    expect(text).toMatch(/^ {2}marketers 0 .*\/day, no agency \| severance/m);
    expect(text).not.toMatch(/agency \/day/);
  });

  it("names the model each benefit to unlock is for", () => {
    const state = { ...allOpen(start()), tiers: [{ tier: 2 as const, day: 1 }], researchPoints: 20 };
    expect(renderStatus(sim, state)).toMatch(/research: .*can unlock photos 15 RP \(feature\), managedMonitoring 15 RP \(PaaS benefit\), .*\(on-prem benefit, not your model\)/);
  });

  it("points a model benefit's id at benefit rather than asking for a feature", () => {
    const saas = inPhase(sim.newGame({ companyName: "Test Co", productType: "social", model: "saas", seed: 3 }), "launch");
    expect(run(saas, "addon premiumSupport").lines).toEqual([
      "buyAddon refused: Premium support plan is a SaaS model benefit, not a feature: buy it as a benefit.",
    ]);
  });

  it("shows the uptime the IPO judges: the last 30 days since launch", () => {
    const state = run(start(), "next 1").state;
    const down = { ...state, downtimeHours: 50, spendByDay: state.spendByDay.map((d) => ({ ...d, hoursDown: 0 })) };
    expect(renderStatus(sim, down)).toMatch(/uptime 100\.0% over the last 30 days \(what the IPO judges\)/);
  });
});
