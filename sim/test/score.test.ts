import { describe, expect, it } from "vitest";
import { playDay, STRATEGIES } from "../scripts/harness.ts";
import { renderStatus, renderSummary, runScript } from "../scripts/textPlay.ts";
import { createSim, defaultConfig, type GameConfig, type GameState, type IpoResult } from "../src/index.ts";

// The score (#264), through the sim's public interface: the end screen's headline gives the money raised and what the
// company is worth (the market value at the first day's close if it floated, otherwise the valuation, less any debt
// still owed), then each shareholder's part of it. The student's score is the founder row's worth.

const config: GameConfig = { ...defaultConfig, payReview: { ...defaultConfig.payReview, on: 0 } };
const sim = createSim(config);
const begin = () => sim.newGame({ companyName: "Owned Co", productType: "social", model: "paas", seed: 5 });

/** A company with outside shareholders on the cap table, as if each had invested. */
function funded(): GameState {
  const state = begin();
  const student = state.shareholders[0]!;
  return {
    ...state,
    shareholders: [
      student,
      { id: "friendsAndFamily", shares: 1_000, day: 3 },
      { id: "angel", shares: 2_000, day: 20 },
      { id: "vc", investor: "Northgate Ventures", shares: 3_000, day: 40 },
      { id: "staffScheme", shares: 500, day: 50 },
    ],
    funding: { ...state.funding, friendsAndFamily: { status: "accepted", day: 3, amount: 10_000, shares: 1_000, valuation: 100_000 } },
    investors: {
      ...state.investors,
      angel: { ...({} as NonNullable<GameState["investors"]["angel"]>), investor: "Ada Hart", day: 20, amount: 50_000, shares: 2_000 },
      vc: {
        ...state.investors.vc,
        deals: [
          // A merged round's amount is all of it, both tranches: £120,000 on signing and £80,000 once paid.
          { round: "seriesA", investor: "Northgate Ventures", lean: "cash", day: 40, amount: 200_000, shares: 2_000, share: 0.1, valuation: 2_000_000, tranche: { amount: 80_000, target: "seriesB", paidDay: 60 } },
        ] as GameState["investors"]["vc"]["deals"],
      },
    },
  };
}

describe("the score and the shareholder breakdown (#264)", () => {
  it("starts with the founder owning everything, their seed money in, and the score the valuation", () => {
    const state = begin();
    const { capTable, score } = sim.summarise(state);
    expect(capTable).toMatchObject({ raised: 0, debt: 0, worth: sim.valuation(state).valuation });
    expect(capTable.shareholders).toEqual([
      { id: "student", name: "You", putIn: config.startingCash, shares: state.shareholders[0]!.shares, stake: 1, worth: capTable.worth, multiple: Math.round((100 * capTable.worth) / config.startingCash) / 100 },
    ]);
    expect(score).toBe(capTable.worth);
  });

  it("gives each shareholder what they put in, their stake, its worth and their multiple: stakes add to 100%", () => {
    const state = funded();
    const { capTable, score } = sim.summarise(state);
    const rows = Object.fromEntries(capTable.shareholders.map((r) => [r.id, r]));
    expect(rows.friendsAndFamily!.putIn).toBe(10_000);
    expect(rows.angel!.putIn).toBe(50_000);
    // A VC's two tranches, each once (#283).
    expect(rows.vc).toMatchObject({ name: "Northgate Ventures (VC)", putIn: 200_000, multiple: Math.round((100 * rows.vc!.worth) / 200_000) / 100 });
    expect(rows.staffScheme).toMatchObject({ putIn: 0, multiple: null });
    expect(capTable.raised).toBe(260_000);
    expect(capTable.shareholders.reduce((sum, r) => sum + r.stake, 0)).toBeCloseTo(1, 10);
    expect(Math.abs(capTable.shareholders.reduce((sum, r) => sum + r.worth, 0) - capTable.worth)).toBeLessThanOrEqual(capTable.shareholders.length);
    for (const r of capTable.shareholders) expect(r.worth).toBe(Math.round(capTable.worth * r.stake));
    expect(rows.student!.multiple).toBe(Math.round((100 * rows.student!.worth) / config.startingCash) / 100);
    // The score is the founder row's worth: their shares, not the company's cash.
    expect(score).toBe(rows.student!.worth);
    expect(score).toBeLessThan(capTable.worth);
  });

  it("counts a VC's second tranche only once it's paid (#283)", () => {
    const state = funded();
    const deal = state.investors.vc.deals[0]!;
    const unpaid: GameState = {
      ...state,
      investors: { ...state.investors, vc: { ...state.investors.vc, deals: [{ ...deal, tranche: { ...deal.tranche!, paidDay: null } }] } },
    };
    const { capTable } = sim.summarise(unpaid);
    expect(capTable.shareholders.find((r) => r.id === "vc")!.putIn).toBe(120_000);
    expect(capTable.raised).toBe(180_000);
  });

  it("seeds the founder with the difficulty's starting cash, before any loan (#283)", () => {
    const any = createSim({ ...config, allowedDifficulties: { easy: 1, normal: 1, hard: 1 } });
    for (const [difficulty, multiple] of [["easy", 1.5], ["normal", 1], ["hard", 0.8]] as const) {
      const game = any.newGame({ companyName: "Owned Co", productType: "social", model: "paas", seed: 5, difficulty, takeLoan: true });
      expect(any.summarise(game).capTable.shareholders[0]!.putIn).toBe(Math.round(config.startingCash * multiple));
    }
  });

  it("keeps a vulture bought back in the breakdown, holding nothing, with what the buy-back paid it (#283)", () => {
    const state = funded();
    const rescue = { day: 70, amount: 40_000, losses: 30_000, shares: 4_000, share: 0.3, cuts: [], hiresCancelled: 0, savedPerDay: 0, severance: 0 };
    const boughtBack: GameState = { ...state, rescue: { ...rescue, boughtBack: { day: 90, price: 80_000 } } };
    const { capTable } = sim.summarise(boughtBack);
    expect(capTable.shareholders.at(-1)).toEqual({ id: "vulture", name: "Vulture VC (bought back)", putIn: 40_000, shares: 0, stake: 0, worth: 80_000, multiple: 2 });
    expect(capTable.raised).toBe(300_000);
    expect(capTable.shareholders.reduce((sum, r) => sum + r.stake, 0)).toBeCloseTo(1, 10);
    // Still holding its shares, it's on the cap table as any shareholder.
    const holding: GameState = { ...state, shareholders: [...state.shareholders, { id: "vulture", shares: 4_000, day: 70 }], rescue: { ...rescue, boughtBack: null } };
    const rows = sim.summarise(holding).capTable.shareholders.filter((r) => r.id === "vulture");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Vulture VC", putIn: 40_000, shares: 4_000 });
  });

  it("is worth the market value at the close once floated, less any debt settled at the end", () => {
    const state = funded();
    const ipo = { marketValue: 5_000_000, cashRaised: 1_000_000 } as IpoResult;
    const floated: GameState = {
      ...state,
      status: "finished",
      shareholders: [...state.shareholders, { id: "public", shares: 2_000, day: 90 }],
      ipo: { ...state.ipo, result: ipo },
      loan: { ...(state.loan ?? ({} as NonNullable<GameState["loan"]>)), settledAtEnd: 40_000 },
    };
    const { capTable, score } = sim.summarise(floated);
    expect(capTable).toMatchObject({ worth: 4_960_000, debt: 40_000, raised: 1_260_000 });
    expect(capTable.shareholders.at(-1)).toMatchObject({ id: "public", name: "Public shareholders", putIn: 1_000_000 });
    expect(score).toBe(Math.round((4_960_000 * state.shareholders[0]!.shares) / (state.shareholders.reduce((s, h) => s + h.shares, 0) + 2_000)));
  });

  it("values a floated company at the close in the valuation view, as the cap table does, and stops locking the price (#283)", () => {
    const state = funded();
    const inIssue = state.shareholders.reduce((s, h) => s + h.shares, 0) + 2_000;
    const ipo = { day: 90, offerPrice: 40, closePrice: 50, marketValue: 50 * inIssue, cashRaised: 80_000 } as IpoResult;
    const floated: GameState = {
      ...state,
      status: "finished",
      shareholders: [...state.shareholders, { id: "public", shares: 2_000, day: 90 }],
      ipo: { ...state.ipo, approvedDay: 85, result: ipo },
    };
    const lines = runScript(sim, floated, "valuation", "AI").lines.join("\n");
    expect(lines).toContain(`market value £${(50 * inIssue).toLocaleString("en-GB")} at the first day's close; share price £50.00`);
    expect(lines).toContain(`You: ${state.shareholders[0]!.shares.toLocaleString("en-GB")} shares`);
    expect(lines).toContain(`worth £${(50 * state.shareholders[0]!.shares).toLocaleString("en-GB")}`);
    expect(sim.capTable(floated).sharePrice).toBe(50);
    // The status, without the stand-in angel deal the full status can't read.
    const status = renderStatus(sim, { ...floated, investors: begin().investors });
    expect(status).toContain("final: the game is over");
    expect(status).not.toContain("until the bell");
  });

  it("scores £0 for a liquidated company", () => {
    const { capTable, score } = sim.summarise({ ...funded(), status: "liquidated" });
    expect(capTable.worth).toBe(0);
    expect(capTable.shareholders.every((r) => r.worth === 0)).toBe(true);
    expect(score).toBe(0);
  });

  it("adds up over a real game where investors came in, and shows in the text summary", () => {
    const strategy = STRATEGIES.find((s) => s.id === "vc")!;
    let state = sim.newGame({ companyName: "Owned Co", productType: "social", model: "paas", seed: 1, takeLoan: true });
    while (state.status === "playing") state = sim.advance(playDay(sim, state, strategy)).state;
    const { capTable, score } = sim.summarise(state);
    expect(capTable.shareholders.length).toBeGreaterThan(1);
    expect(capTable.shareholders.reduce((sum, r) => sum + r.stake, 0)).toBeCloseTo(1, 10);
    expect(score).toBe(capTable.shareholders.find((r) => r.id === "student")!.worth);
    const text = JSON.parse(renderSummary(sim, state));
    expect(text.headline).toMatch(/^The company raised £[\d,]+ and is now worth £[\d,]+(, after £[\d,]+ of debt)?\.$/);
    expect(text.score).toBe(score);
    expect(text.shareholders[0]).toMatch(/^You \(seed money: your starting cash\): put in £15,000, [\d.]+%, worth £[\d,]+, [\d.]+× their money$/);
  });
});
