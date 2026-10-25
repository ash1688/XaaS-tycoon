import { describe, expect, it } from "vitest";
import { playDay, playGame, STRATEGIES } from "../scripts/harness.ts";
import { advanceUntil, renderCommands, renderStatus, runScript } from "../scripts/textPlay.ts";
import {
  createSim,
  defaultConfig,
  inflationNow,
  SimError,
  STAFF_GRADES,
  type GameConfig,
  type GameState,
  type Sim,
} from "../src/index.ts";

// Pay reviews, through the sim's public interface: the schedule (quarters 2, 3 and 4 of any game length), the clock
// held until a review is settled, inflation on its own RNG, the caps, staff accepting or countering an offer with the
// negotiation roll the other way round, the student accepting a counter, the final offer's midpoint, and the agreed
// rise lifting every pool's pay, new hires and agency staff included.

/** A rich company with no events, on any game length, so it plays a whole year without running out of cash. */
const rich: GameConfig = {
  ...defaultConfig,
  startingCash: 10_000_000,
  events: [],
  allowedGameLengths: { "180-days": 1, "until-ipo": 1, "1-year": 1, career: 1 },
};
const sim = createSim(rich);
/** The fair rise is inflation exactly, and staff walk away there: for tests that need to know where they accept. */
const plain = createSim({
  ...rich,
  payReview: {
    ...rich.payReview,
    fairRise: { ...rich.payReview.fairRise, growthWeight: 0, profitBonus: 0, tightCashCut: 0 },
    walkAwaySpread: 0,
  },
});
const begin = (s: Sim = sim, seed = 42, gameLength?: string) =>
  s.newGame({ companyName: "Acme", productType: "social", model: "saas", seed, gameLength });

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SimError) return e.code;
    throw e;
  }
  return null;
};

/** Plays a day at a time until a review opens (or the game ends). */
function untilReview(s: Sim, state: GameState): GameState {
  let current = state;
  while (current.status === "playing" && !current.payReview) current = s.advance(current).state;
  return current;
}

const offer = (s: Sim, state: GameState, rise: number) => s.applyAction(state, { type: "offerPayRise", rise });
const acceptCounter = (s: Sim, state: GameState) => s.applyAction(state, { type: "acceptPayCounter" });
/** Settles the open review on the most staff ask, which they always accept. */
const settleAtAsk = (s: Sim, state: GameState) => offer(s, state, s.payReview(state)!.maxAsk);

describe("the schedule", () => {
  it("opens a review before the first day of quarters 2, 3 and 4 of each game length, and never in quarter 1", () => {
    const short = createSim({ ...rich, finalDay: 100 });
    for (const [s, gameLength, finalDay] of [
      [sim, "180-days", 180],
      [short, "180-days", 100],
      [sim, "1-year", 365],
    ] as const) {
      const quarter = finalDay / 4;
      const starts = [1, 2, 3].map((q) => Math.floor(q * quarter) + 1);
      expect(s.payReviewDays(begin(s, 42, gameLength))).toEqual(starts);
      let state = begin(s, 42, gameLength);
      const opened: { day: number; quarter: number; startDay: number }[] = [];
      while (state.status === "playing") {
        state = s.advance(state).state;
        const review = s.payReview(state);
        if (review) {
          opened.push({ day: state.day, quarter: review.quarter, startDay: review.startDay });
          state = settleAtAsk(s, state);
        }
      }
      // The day before each quarter starts, so the quarter is played at the agreed rise; none in the first quarter.
      expect(opened).toEqual(starts.map((startDay, i) => ({ day: startDay - 1, quarter: i + 2, startDay })));
      expect(opened.every((o) => o.startDay > quarter)).toBe(true);
      expect(state.pastPayReviews).toHaveLength(3);
    }
  });

  it("splits a career into quarters of its 47 years, and a game until IPO into a year's", () => {
    const career = begin(sim, 42, "career");
    // 47 years of 365 days is 17,155 days: quarters of 4,288.75.
    expect(sim.payReviewDays(career)).toEqual([4289, 8578, 12867]);
    expect(sim.payReviewDays(begin(sim, 42, "until-ipo"))).toEqual([92, 183, 274]);
  });

  it("opens none with pay reviews turned off", () => {
    const off = createSim({ ...rich, payReview: { ...rich.payReview, on: 0 } });
    const state = off.advance(begin(off), 179).state;
    expect(state.status).toBe("finished");
    expect(state.pastPayReviews).toEqual([]);
    expect(state.payMultiplier).toBe(1);
  });
});

describe("holding the clock", () => {
  it("stops an advance on the day a review opens, and refuses another day until it's settled", () => {
    const { state, log } = sim.advance(begin(), 100);
    expect(state.day).toBe(45);
    expect(log).toHaveLength(44);
    expect(log.at(-1)!.entries.at(-1)!.text).toMatch(/^Pay review: quarter 2 starts on day 46, and your staff want to talk about pay\./);
    expect(refusal(() => sim.advance(state))).toBe("pay_review");
    expect(refusal(() => sim.tick(state))).toBe("pay_review");
    // Other decisions can still be made while it's open.
    expect(sim.applyAction(state, { type: "hire", pool: "support" }).hiring).toHaveLength(1);
    const settled = settleAtAsk(sim, state);
    expect(sim.advance(settled).state.day).toBe(46);
  });

  it("pauses the timed flow with a pay review reason", () => {
    let state = sim.advance(begin(), 43).state;
    expect(state.day).toBe(44);
    const tick = sim.tick(state);
    expect(tick.days).toBe(1);
    expect(tick.pauses).toContainEqual({ kind: "payReview", id: "pay-review", text: expect.stringMatching(/^Pay review: your staff want to talk about pay/) });
    state = tick.state;
    expect(refusal(() => sim.tick(state))).toBe("pay_review");
  });

  it("stops a career's week-long tick on the day the review opens", () => {
    const careers = createSim({ ...rich, payReview: { ...rich.payReview, openEndedYearDays: 365 } });
    let state = begin(careers, 42, "career");
    let tick = careers.tick(state);
    while (!tick.pauses.some((p) => p.kind === "payReview")) {
      state = tick.state;
      tick = careers.tick(state);
    }
    expect(tick.state.day).toBe(4288);
    expect(tick.days).toBeLessThanOrEqual(7);
  });
});

describe("inflation", () => {
  it("is rolled for each review from 2% to 6%, and sets the caps", () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 20; seed++) {
      const review = sim.payReview(untilReview(sim, begin(sim, seed)))!;
      expect(review.inflation).toBeGreaterThanOrEqual(0.02);
      expect(review.inflation).toBeLessThanOrEqual(0.06);
      expect(review.minOffer).toBeCloseTo(review.inflation - 0.01, 9);
      expect(review.maxAsk).toBeCloseTo(review.inflation + 0.04, 9);
      // Staff open at their ask.
      expect(review.staffFigure).toBe(review.maxAsk);
      expect(review.staffFigures).toEqual([review.maxAsk]);
      seen.add(review.inflation);
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  it("comes from the reviews' own RNG: changing it changes nothing else in the game", () => {
    const before = sim.advance(begin(), 43).state;
    const other = { ...before, payReviewRng: before.payReviewRng ^ 0x1234 };
    const a = sim.advance(before).state;
    const b = sim.advance(other).state;
    expect(a.payReview!.inflation).not.toBe(b.payReview!.inflation);
    const rest = ({ payReview: _, payReviewRng: __, ...s }: GameState) => s;
    expect(rest(b)).toEqual(rest(a));
    expect(b.rng).toBe(a.rng);
    expect(b.negotiationRng).toBe(a.negotiationRng);
  });

  it("is readable as the game's inflation once the first review opens", () => {
    const start = begin();
    expect(inflationNow(start)).toBeNull();
    const open = untilReview(sim, start);
    expect(inflationNow(open)).toBe(open.payReview!.inflation);
    expect(inflationNow(settleAtAsk(sim, open))).toBe(open.payReview!.inflation);
  });

  it("never lets the least offer go below 0%", () => {
    const low = createSim({ ...rich, payReview: { ...rich.payReview, inflation: { min: 0.005, max: 0.005 } } });
    const review = low.payReview(untilReview(low, begin(low)))!;
    expect(review).toMatchObject({ inflation: 0.005, minOffer: 0, maxAsk: 0.045 });
  });
});

describe("offers", () => {
  const open = untilReview(plain, begin(plain));
  const review = plain.payReview(open)!;

  it("are refused outside the caps", () => {
    expect(refusal(() => offer(plain, open, review.minOffer - 0.001))).toBe("offer_too_low");
    expect(refusal(() => offer(plain, open, review.maxAsk + 0.001))).toBe("offer_too_high");
    expect(refusal(() => offer(plain, open, Number.NaN))).toBe("bad_offer");
    expect(refusal(() => plain.payOfferPreview(open, review.minOffer - 0.001))).toBe("offer_too_low");
    // Staff's whole ask is no counter: nothing to roll for.
    expect(plain.payOfferPreview(open, review.maxAsk)).toMatchObject({ meetsAsk: true, odds: null, midpoint: null });
    expect(plain.payOfferPreview(open, review.minOffer)).toMatchObject({ meetsAsk: false });
    // And with no review open.
    expect(refusal(() => offer(plain, begin(plain), 0.03))).toBe("no_pay_review");
    expect(refusal(() => acceptCounter(plain, begin(plain)))).toBe("no_pay_review");
  });

  it("are accepted at or above staff's walk-away figure, settling the review on the offer", () => {
    // Here staff walk away at inflation exactly.
    expect(open.payReview!.walkAway).toBe(review.inflation);
    const settled = offer(plain, open, review.inflation);
    expect(plain.payReview(settled)).toBeNull();
    expect(settled.pastPayReviews).toEqual([
      expect.objectContaining({ quarter: 2, startDay: 46, settledDay: 45, outcome: "offerAccepted", rise: review.inflation, studentOffers: [review.inflation] }),
    ]);
    expect(settled.payMultiplier).toBeCloseTo(1 + review.inflation, 9);
  });

  it("below it are countered, the roll deciding how far staff come down from their ask towards the offer", () => {
    const low = review.minOffer;
    const preview = plain.payOfferPreview(open, low);
    expect(preview.odds).not.toBeNull();
    const countered = offer(plain, open, low);
    const talks = plain.payReview(countered)!;
    const [round] = talks.rounds;
    expect(talks.studentOffers).toEqual([low]);
    expect(round!.counter).toEqual({ rise: low });
    expect(round!.move).toBe(plain.config.payReview.negotiation.moves[round!.result]);
    // The preview's odds said what each roll would bring.
    expect(talks.staffFigure).toBe(preview.odds!.outcomes[round!.result].rise);
    expect(talks.staffFigures).toEqual([review.maxAsk, talks.staffFigure]);
    expect(talks).toMatchObject({ offersLeft: 2, final: false, canAcceptCounter: true });
    // The counter uses the reviews' RNG, not the negotiation one investors and funders roll on.
    expect(countered.negotiationRng).toBe(open.negotiationRng);
    expect(countered.payReviewRng).not.toBe(open.payReviewRng);
  });

  it("never brings a counter above staff's ask, or below the least offer, whatever the roll", () => {
    for (let seed = 1; seed <= 30; seed++) {
      let state = untilReview(plain, begin(plain, seed));
      const { minOffer, maxAsk } = state.payReview!;
      for (let i = 0; i < 2; i++) {
        state = offer(plain, state, minOffer);
        const figure = plain.payReview(state)!.staffFigure;
        expect(figure).toBeLessThanOrEqual(maxAsk);
        expect(figure).toBeGreaterThan(minOffer);
      }
    }
  });

  it("can't match or beat staff's counter: that's accepting it", () => {
    const countered = offer(plain, open, review.minOffer);
    const figure = plain.payReview(countered)!.staffFigure;
    expect(refusal(() => offer(plain, countered, figure))).toBe("above_counter");
  });
});

describe("accepting a counter", () => {
  const open = untilReview(plain, begin(plain));
  const review = plain.payReview(open)!;

  it("is refused before staff have countered", () => {
    expect(refusal(() => acceptCounter(plain, open))).toBe("no_counter");
  });

  it("settles on staff's figure, after any counter", () => {
    const once = offer(plain, open, review.minOffer);
    const figure = plain.payReview(once)!.staffFigure;
    const settled = acceptCounter(plain, once);
    expect(settled.payReview).toBeNull();
    expect(settled.pastPayReviews.at(-1)).toMatchObject({ outcome: "counterAccepted", rise: figure, staffFigures: [review.maxAsk, figure] });
    const twice = offer(plain, once, review.minOffer);
    expect(acceptCounter(plain, twice).pastPayReviews.at(-1)).toMatchObject({ outcome: "counterAccepted", rise: plain.payReview(twice)!.staffFigure });
  });
});

describe("the final offer", () => {
  it("is the third: short of a deal, the review settles midway between it and staff's last counter", () => {
    let state = untilReview(plain, begin(plain));
    const { minOffer } = state.payReview!;
    state = offer(plain, state, minOffer);
    state = offer(plain, state, minOffer);
    const talks = plain.payReview(state)!;
    expect(talks).toMatchObject({ offersLeft: 1, final: true });
    const last = talks.staffFigure;
    const midpoint = Math.round(((minOffer + last) / 2) * 1000) / 1000;
    // The preview says so, and has no roll to show.
    expect(plain.payOfferPreview(state, minOffer)).toMatchObject({ odds: null, midpoint });
    const settled = offer(plain, state, minOffer);
    expect(settled.payReview).toBeNull();
    expect(settled.pastPayReviews.at(-1)).toMatchObject({ outcome: "midpoint", rise: midpoint, studentOffers: [minOffer, minOffer, minOffer] });
  });

  it("is still accepted if it reaches the walk-away figure", () => {
    let state = untilReview(plain, begin(plain));
    // Offers just short of inflation, so staff's counters stay above it.
    const { inflation } = state.payReview!;
    state = offer(plain, offer(plain, state, inflation - 0.001), inflation - 0.001);
    const settled = offer(plain, state, inflation);
    expect(settled.pastPayReviews.at(-1)).toMatchObject({ outcome: "offerAccepted", rise: inflation });
  });
});

describe("the rise", () => {
  const rates = (s: Sim, state: GameState) =>
    s.staff(state).flatMap((p) => [...p.grades, ...p.agency].map((g) => `${p.pool} ${g.grade} ${g.dayRate}`));
  const expected = (s: Sim, state: GameState, multiplier: number) =>
    s.staff(state).flatMap((p) =>
      [false, true]
        .filter((agency) => !agency || p.agencyAllowed)
        .flatMap((agency) =>
          STAFF_GRADES.map((grade) => {
            const base = s.config.staff[p.pool].dayRate * s.config.staffGrades[grade].payMultiplier * (agency ? s.config.agency.payMultiplier : 1);
            return `${p.pool} ${grade} ${Math.round(base * multiplier)}`;
          }),
        ),
    );

  it("lifts every pool's day rate, permanent and agency, and compounds across reviews", () => {
    let state = untilReview(sim, begin());
    expect(rates(sim, state)).toEqual(expected(sim, state, 1));
    const first = state.payReview!.maxAsk;
    state = settleAtAsk(sim, state);
    expect(rates(sim, state)).toEqual(expected(sim, state, 1 + first));
    state = untilReview(sim, state);
    const second = state.payReview!.maxAsk;
    state = settleAtAsk(sim, state);
    expect(state.payMultiplier).toBeCloseTo((1 + first) * (1 + second), 9);
    expect(rates(sim, state)).toEqual(expected(sim, state, (1 + first) * (1 + second)));
  });

  it("is paid from the next day, to staff already there, new hires and agency staff alike", () => {
    const open = untilReview(sim, begin());
    const rise = open.payReview!.maxAsk;
    // An agency developer and a permanent ops hire, hired before the review and still to start.
    const hired = sim.applyAction(sim.applyAction(open, { type: "hire", pool: "developers", agency: true }), { type: "hire", pool: "ops" });
    const unsettled = sim.dailyStaffCost(hired);
    const settled = settleAtAsk(sim, hired);
    // The day the review opened was paid at the old rates.
    expect(open.spend.staff).toBe(sim.advance(sim.advance(begin(), 43).state).state.spend.staff);
    const next = sim.advance(settled);
    const pay = next.log[0]!.entries.filter((e) => e.category === "staff");
    const support = sim.staff(next.state).find((p) => p.pool === "support")!;
    const supportRate = support.grades.find((g) => g.grade === "mid")!.dayRate;
    expect(supportRate).toBe(Math.round(sim.config.staff.support.dayRate * (1 + rise)));
    expect(pay.find((e) => e.text.startsWith(`${sim.config.staff.support.name} pay`))!.cashDelta).toBe(-support.grades.find((g) => g.grade === "mid")!.count * supportRate);
    expect(sim.dailyStaffCost(settled)).toBeGreaterThan(unsettled);
    // Agency pricing keeps its premium on top of the risen rate.
    const devs = sim.staff(settled).find((p) => p.pool === "developers")!;
    expect(devs.agency.find((g) => g.grade === "mid")!.dayRate).toBe(
      Math.round(sim.config.staff.developers.dayRate * sim.config.agency.payMultiplier * (1 + rise)),
    );
    // Once they start, the new hires are paid the risen rates too.
    let later = next.state;
    while (later.hiring.length) later = sim.advance(later).state;
    const ops = sim.staff(later).find((p) => p.pool === "ops")!;
    expect(ops.grades.find((g) => g.grade === "mid")!.dayRate).toBe(Math.round(sim.config.staff.ops.dayRate * (1 + rise)));
    // And severance follows their pay.
    expect(ops.grades.find((g) => g.grade === "mid")!.severance).toBe(
      Math.round(sim.config.staff.ops.dayRate * (1 + rise)) * sim.config.severance.days,
    );
  });

  it("shows its cost before it's offered: what it adds a day and a year at today's team", () => {
    const open = untilReview(sim, begin());
    const { inflation } = open.payReview!;
    const preview = sim.payOfferPreview(open, inflation);
    const settled = offer(sim, open, inflation);
    const after = settled.payReview ? acceptCounter(sim, settled) : settled;
    expect(preview.rise).toBe(inflation);
    expect(preview.realTerms).toBe(0);
    if (after.pastPayReviews.at(-1)!.rise === inflation) {
      expect(sim.dailyStaffCost(after) - sim.dailyStaffCost(open)).toBe(preview.extraPerDay);
    }
    expect(preview.extraPerYear).toBe(preview.extraPerDay * 365);
    expect(sim.payOfferPreview(open, open.payReview!.minOffer).realTerms).toBeCloseTo(-0.01, 9);
  });
});

describe("the fair rise", () => {
  it("is inflation plus a little for a growing, profitable company, with staff's walk-away figure near it", () => {
    const bot = STRATEGIES.find((s) => s.id === "sensible")!;
    let state = begin(sim);
    while (!state.payReview) state = sim.advance(playDay(sim, state, bot)).state;
    const review = state.payReview!;
    expect(sim.runway(state).dailyNet).toBeGreaterThan(0);
    expect(review.fairRise).toBeGreaterThan(review.inflation);
    expect(review.fairRise).toBeLessThanOrEqual(review.maxAsk);
    expect(Math.abs(review.walkAway - review.fairRise)).toBeLessThanOrEqual(sim.config.payReview.walkAwaySpread + 1e-9);
    // Kept from the student.
    expect(sim.payReview(state)).not.toHaveProperty("fairRise");
    expect(sim.payReview(state)).not.toHaveProperty("walkAway");
  });

  it("is a point less when cash is tight, never below the least offer", () => {
    // Inflation alone, less the cut when cash is tight.
    const tight = createSim({
      ...rich,
      payReview: { ...rich.payReview, fairRise: { ...rich.payReview.fairRise, growthWeight: 0, profitBonus: 0 }, walkAwaySpread: 0 },
    });
    // A company paying far more staff than it earns, the day before the review opens.
    const burning = tight.advance(tight.applyAction(begin(tight), { type: "hire", pool: "developers", count: 30 }), 43).state;
    const burn = -tight.runway(burning).dailyNet;
    expect(burn).toBeGreaterThan(0);
    const flush = tight.advance(burning).state.payReview!;
    const short = tight.advance({ ...burning, cash: burn * 10 }).state.payReview!;
    expect(flush.fairRise).toBe(flush.inflation);
    expect(short.fairRise).toBe(Math.max(short.minOffer, Math.round((short.inflation - tight.config.payReview.fairRise.tightCashCut) * 1000) / 1000));
  });
});

describe("the bots and text play", () => {
  it("get the harness bots through a full game with three reviews", () => {
    const real = createSim(defaultConfig);
    for (const strategy of STRATEGIES.slice(0, 3)) {
      const result = playGame(real, { model: "saas", productType: "social", strategy, seed: 7 });
      expect(result.outcome).not.toBe("cant-start");
      expect(result.day).toBeGreaterThan(45);
    }
    let state = real.newGame({ companyName: "Bot Ltd", productType: "social", model: "saas", seed: 7 });
    const sensible = STRATEGIES[0]!;
    while (state.status === "playing") state = real.advance(playDay(real, state, sensible)).state;
    expect(state.pastPayReviews.length).toBe(state.status === "finished" ? 3 : state.pastPayReviews.length);
    expect(state.status).toBe("finished");
  });

  it("stops text play for a review, shows it, and settles it with offer and accept pay", () => {
    const who = { player: "test" };
    // Time stops for other things on the way, such as the launch.
    let turn = advanceUntil(plain, begin(plain), 60, who);
    while (!turn.state.payReview) turn = advanceUntil(plain, turn.state, 60, who);
    expect(turn.state.day).toBe(45);
    expect(turn.lines.at(-1)).toMatch(/^stopped on day 45: Pay review: your staff want to talk about pay before quarter 2 starts/);
    const review = plain.payReview(turn.state)!;
    expect(renderStatus(plain, turn.state)).toMatch(/pay: PAY REVIEW OPEN for quarter 2 \(from day 46\): inflation [\d.]+%, offer [\d.]+%–[\d.]+%, staff asking [\d.]+%; 3 offers left/);
    expect(renderCommands(plain, turn.state)).toMatch(/offer <[\d.]+%–[\d.]+%>/);
    expect(renderCommands(plain, turn.state)).not.toMatch(/accept pay/);
    const pct = (n: number) => (n * 100).toFixed(1);
    const blocked = runScript(plain, turn.state, "next", who);
    expect(blocked.lines.at(-1)).toMatch(/^refused: Your staff want to talk about pay/);
    const odds = runScript(plain, turn.state, `payodds ${pct(review.minOffer)}`, who);
    expect(odds.lines[1]).toMatch(/^offer [\d.]+% \(1\.0% below inflation: a real-terms pay cut\): \+£[\d,]+\/day, \+£[\d,]+ a year/);
    expect(odds.lines.join("\n")).toMatch(/high \d+% → [\d.]+%/);
    const countered = runScript(plain, turn.state, `offer ${pct(review.minOffer)}`, who);
    expect(countered.lines[1]).toMatch(/: staff counter, rolled \d+/);
    expect(countered.rows[0]).toMatchObject({ type: "offerPayRise", ok: true });
    expect(renderCommands(plain, countered.state)).toMatch(/accept pay/);
    const settled = runScript(plain, countered.state, "accept pay; pay; next 1", who);
    expect(settled.lines[1]).toMatch(/^pay review settled: you accepted staff's counter of [\d.]+%\. Pay ×1\.0\d\d of the day rates from day 46/);
    expect(settled.lines.join("\n")).toMatch(/pay: pay ×1\.0\d\d of the day rates \(rises: Q2 [\d.]+%\); next review before day 91/);
    expect(settled.state.day).toBe(46);
  });
});
