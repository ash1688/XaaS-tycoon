import type { GameConfig } from "./config.ts";
import { count, pounds, type Finance } from "./finance.ts";
import { layerOwner } from "./responsibility.ts";
import { nextRandom } from "./rng.ts";
import type { Servers } from "./servers.ts";
import type { Shares } from "./shares.ts";
import { staffOutput } from "./staff.ts";
import { SimError, type DaySpend, type GameState, type IpoApplication, type IpoResult, type LogEntry } from "./state.ts";

export type IpoConditionId =
  | "usersAndRevenue"
  | "uptime"
  | "costs"
  | "security"
  | "profit"
  | "satisfaction"
  | "payingUsers";

/** One condition of the readiness check, for the checklist on the Finance page. */
export interface IpoCondition {
  id: IpoConditionId;
  label: string;
  met: boolean;
  /** What it asks for, in words. */
  needed: string;
  /** Where the company stands, in words. */
  now: string;
  /** How far over it the company is, 0–1: 1 is comfortably. 0 while it isn't met. */
  comfort: number;
}

/** What floating one share of the company would do, at the offer price. */
export interface FloatPreview {
  /** The new shares' share of the company after the IPO, 0–1. */
  float: number;
  newShares: number;
  sharesAfter: number;
  cashRaised: number;
  /** The student's share after, 0–1. */
  studentShareAfter: number;
  /** How far the price might swing on the first day either way, about: 0.1 = 10%. */
  swing: number;
}

/** Once approved: the offer, and what each whole-percent float from the least to the most would do. */
export interface IpoOffer {
  /** The valuation the shares are offered at. */
  valuation: number;
  sharesInIssue: number;
  /** Valuation ÷ shares in issue. */
  offerPrice: number;
  studentShares: number;
  studentShare: number;
  minFloat: number;
  maxFloat: number;
  floats: FloatPreview[];
}

export type IpoStatus = "not-ready" | "ready" | "cold" | "approved" | "floated";

/** The IPO for the Finance page and the opening-bell page. */
export interface IpoView {
  /**
   * "not-ready" until every condition is met, then "ready" to apply; "cold" while a cold market has postponed it,
   * "approved" until the bell is rung, and "floated" after.
   */
  status: IpoStatus;
  conditions: IpoCondition[];
  /** Every condition met. */
  ready: boolean;
  /** The conditions' comfort averaged, 0–1. */
  comfort: number;
  /** Whether applying now is allowed, and if not, why. */
  canApply: boolean;
  refusal: string | null;
  /** After a cold market, the first day the company can apply again; null when it isn't waiting. */
  retryDay: number | null;
  applications: IpoApplication[];
  approvedDay: number | null;
  /** The offer once approved; null otherwise. */
  offer: IpoOffer | null;
  /** The float and the first day of trading, once the bell has been rung. */
  result: IpoResult | null;
}

const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;
const round1 = (n: number) => Math.round(n * 10) / 10;
const pence = (n: number) => Math.round(n * 100) / 100;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const HOURS_PER_DAY = 24;
const MODEL_NAMES = { onprem: "on-prem", iaas: "IaaS", paas: "PaaS", saas: "SaaS" } as const;

/**
 * The IPO: the readiness check on the Finance page, applying (with its hidden cold-market chance), the float and the
 * first day of trading. Ringing the opening bell ends every game. See IpoConfig.
 */
export function createIpo(
  config: GameConfig,
  finance: Finance,
  shares: Shares,
  servers: Servers,
  dailyNet: (state: GameState) => number,
) {
  const c = config.ipo;

  const startingIpo = () => ({ ipo: { applications: [], approvedDay: null, retryDay: 0, result: null } });

  /** The last recordDays days played, from the launch on: before it there's nothing to keep a record of. */
  const record = (state: GameState) =>
    state.launchDay === null
      ? []
      : state.spendByDay.filter((d) => d.day >= state.launchDay! && d.day > state.day - c.recordDays);
  const sum = (days: DaySpend[], value: (d: DaySpend) => number) => days.reduce((s, d) => s + value(d), 0);
  /** A day's running costs: everything charged but a loan's capital, which isn't a cost. */
  const runningCosts = (d: DaySpend) => d.staff + d.infrastructure + d.cabling + d.power + d.addons + d.interest;

  /** Comfort over a "more than" threshold: 1 at comfortMargin over it. */
  const over = (value: number, need: number) => (need <= 0 ? 1 : clamp01((value / need - 1) / c.comfortMargin));
  /** Comfort over a percentage that tops out at 100: 1 a comfortMargin of the way from it to 100. */
  const overPercent = (value: number, need: number) =>
    need >= 100 ? 1 : clamp01((value - need) / (c.comfortMargin * (100 - need)));

  function conditions(state: GameState): IpoCondition[] {
    const product = c.products[state.productType];
    const market = config.productTypes[state.productType].growth.marketSize;
    const days = record(state);
    const n = Math.max(1, days.length);
    const v = shares.valuation(state);

    // A record needs recordDays of trading since the launch: before that there isn't one to judge.
    const traded = state.launchDay === null ? 0 : state.day - state.launchDay + 1;
    const hasRecord = traded >= c.recordDays;
    const recorded = (now: string) => (hasRecord ? now : `${now}, but only ${traded} of the ${c.recordDays} days traded so far`);

    const revenueMet = v.annualRevenue >= product.annualRevenue;
    const usersMet = state.users >= product.users;

    const down = sum(days, (d) => d.hoursDown);
    const uptime = 100 * (1 - down / (n * HOURS_PER_DAY));

    const costs = days.map(runningCosts);
    const mean = sum(days, runningCosts) / n;
    const sd = Math.sqrt(costs.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
    const swing = mean > 0 ? sd / mean : 0;

    const yours = layerOwner(state.model, "os") === "you";
    const opsNeeded = servers.opsNeeded(state);
    const ops = staffOutput(config, state, "ops");
    const patched = !yours || ops >= opsNeeded;

    const income = sum(days, (d) => d.income);
    const profit = income - sum(days, runningCosts);
    const net = dailyNet(state);
    const profitable = hasRecord && profit >= 0 && income > 0;
    const margin = income > 0 ? profit / income : 0;

    const satisfaction = sum(days, (d) => d.satisfaction) / n;
    const payers = state.paidUsers;


    const list: Omit<IpoCondition, "comfort">[] = [];
    const comforts: number[] = [];
    const add = (condition: Omit<IpoCondition, "comfort">, comfort: number) => {
      list.push(condition);
      comforts.push(condition.met ? comfort : 0);
    };
    add(
      {
        id: "usersAndRevenue",
        label: "Users and revenue",
        met: usersMet && revenueMet,
        needed: `${count.format(product.users)} users and ${pounds(product.annualRevenue)} a year of revenue`,
        now: `${count.format(state.users)} users (of a market of about ${count.format(market)}) and ${pounds(v.annualRevenue)} a year`,
      },
      Math.min(over(state.users, product.users), over(v.annualRevenue, product.annualRevenue)),
    );
    add(
      {
        id: "uptime",
        label: "Uptime record",
        met: hasRecord && uptime >= c.minUptime,
        needed: `${c.minUptime}% uptime over the last ${c.recordDays} days`,
        now: recorded(`${round1(uptime)}%: ${round1(down)} hours down`),
      },
      overPercent(uptime, c.minUptime),
    );
    add(
      {
        id: "costs",
        label: "Predictable costs",
        met: hasRecord && swing <= c.maxCostSwing,
        needed: `daily running costs over the last ${c.recordDays} days varying by no more than ${percent(c.maxCostSwing)}: big one-off purchases count against you`,
        now: recorded(`Varying by ${percent(swing)} around ${pounds(mean)} a day`),
      },
      c.maxCostSwing <= 0 ? 1 : clamp01((c.maxCostSwing - swing) / (c.comfortMargin * c.maxCostSwing)),
    );
    add(
      {
        id: "security",
        label: "Security audit",
        met: patched,
        needed: yours
          ? `every server patched: on ${MODEL_NAMES[state.model]} the OS is yours, so you need the ops staff your servers need`
          : `every server patched: on ${MODEL_NAMES[state.model]} the provider patches the OS for you`,
        now: yours
          ? `Ops staff doing ${round1(ops)} of the ${round1(opsNeeded)} needed`
          : "Covered by the provider",
      },
      1,
    );
    add(
      {
        id: "profit",
        label: "Profitability",
        met: profitable || (income > 0 && net >= 0),
        needed: `a profit over the last ${c.recordDays} days, or a clear path to one: making money on a usual day now`,
        now: `${profit >= 0 ? "Profit" : "Loss"} of ${pounds(Math.abs(profit))} over ${c.recordDays} days; ${net >= 0 ? "+" : "−"}${pounds(Math.abs(net))} on a usual day`,
      },
      profitable ? clamp01(margin / c.comfortMargin) : 0,
    );
    add(
      {
        id: "satisfaction",
        label: "Satisfaction record",
        met: hasRecord && satisfaction >= c.minSatisfaction,
        needed: `${c.minSatisfaction}% satisfaction on average over the last ${c.recordDays} days`,
        now: recorded(`${Math.round(satisfaction)}%`),
      },
      overPercent(satisfaction, c.minSatisfaction),
    );
    add(
      {
        id: "payingUsers",
        label: "Paying customer base",
        met: payers >= product.payingUsers,
        needed: `${count.format(product.payingUsers)} paying users`,
        now: `${count.format(payers)}, of ${count.format(state.users)} users in a market of about ${count.format(market)}: more of them paying, not more users, is what grows it once the market is full`,
      },
      over(payers, product.payingUsers),
    );
    return list.map((condition, i) => ({ ...condition, comfort: Math.round(comforts[i]! * 100) / 100 }));
  }

  const comfortOf = (list: IpoCondition[]) => list.reduce((s, x) => s + x.comfort, 0) / list.length;

  /** How far the first day might swing either way at a float: the most at the smallest float. */
  const swingAt = (float: number) =>
    c.swingAtMinFloat +
    (c.swingAtMaxFloat - c.swingAtMinFloat) * clamp01((float - c.minFloat) / Math.max(1e-9, c.maxFloat - c.minFloat));

  const studentShares = (state: GameState) => state.shareholders.find((h) => h.id === "student")?.shares ?? 0;
  const sharesInIssue = (state: GameState) => state.shareholders.reduce((s, h) => s + h.shares, 0);

  function preview(state: GameState, float: number, offerPrice: number): FloatPreview {
    const before = sharesInIssue(state);
    const newShares = Math.round((before * float) / (1 - float));
    const sharesAfter = before + newShares;
    return {
      float,
      newShares,
      sharesAfter,
      cashRaised: Math.round(newShares * offerPrice),
      studentShareAfter: studentShares(state) / sharesAfter,
      swing: Math.round(swingAt(float) * 100) / 100,
    };
  }

  function offer(state: GameState): IpoOffer {
    const v = shares.valuation(state);
    const offerPrice = v.sharePrice;
    const floats: FloatPreview[] = [];
    for (let p = Math.round(c.minFloat * 100); p <= Math.round(c.maxFloat * 100); p++) {
      floats.push(preview(state, p / 100, offerPrice));
    }
    return {
      valuation: v.valuation,
      sharesInIssue: v.sharesInIssue,
      offerPrice,
      studentShares: studentShares(state),
      studentShare: studentShares(state) / v.sharesInIssue,
      minFloat: c.minFloat,
      maxFloat: c.maxFloat,
      floats,
    };
  }

  /** Why applying now isn't allowed, or null if it is. */
  function refusal(state: GameState, list: IpoCondition[]): SimError | null {
    const { ipo } = state;
    if (ipo.result) return new SimError("ipo_floated", `${state.companyName} has already floated.`);
    if (ipo.approvedDay !== null) {
      return new SimError("ipo_approved", "Your IPO is already approved: choose your float and ring the opening bell.");
    }
    if (state.day < ipo.retryDay) {
      const left = ipo.retryDay - state.day;
      return new SimError(
        "ipo_cold",
        `The markets are cold after your last application. You can apply again on day ${ipo.retryDay}, in ${left} day${left === 1 ? "" : "s"}.`,
        { retryDay: ipo.retryDay, daysLeft: left },
      );
    }
    const unmet = list.filter((x) => !x.met);
    if (unmet.length) {
      return new SimError(
        "ipo_not_ready",
        `Not ready to float yet: ${unmet.map((x) => x.label.toLowerCase()).join(", ")} ${unmet.length === 1 ? "is" : "are"} still to meet.`,
      );
    }
    return null;
  }

  function ipoView(state: GameState): IpoView {
    const list = conditions(state);
    const ready = list.every((x) => x.met);
    const why = refusal(state, list);
    const { ipo } = state;
    const status: IpoStatus = ipo.result
      ? "floated"
      : ipo.approvedDay !== null
        ? "approved"
        : state.day < ipo.retryDay
          ? "cold"
          : ready
            ? "ready"
            : "not-ready";
    return {
      status,
      conditions: list,
      ready,
      comfort: Math.round(comfortOf(list) * 100) / 100,
      canApply: why === null,
      refusal: why?.message ?? null,
      retryDay: status === "cold" ? ipo.retryDay : null,
      applications: ipo.applications,
      approvedDay: ipo.approvedDay,
      offer: status === "approved" ? offer(state) : null,
      result: ipo.result,
    };
  }

  /**
   * Applies to float. A hidden roll, less likely the more comfortably the company is over every condition, decides
   * between a cold market (postponed coldDelayDays, and satisfaction lost) and approval.
   */
  function applyForIpo(state: GameState): GameState {
    const list = conditions(state);
    const why = refusal(state, list);
    if (why) throw why;
    const comfort = comfortOf(list);
    const chance = c.coldChance.max - (c.coldChance.max - c.coldChance.min) * comfort;
    const [roll, rng] = nextRandom(state.rng);
    const cold = roll < chance;
    const applications = [...state.ipo.applications, { day: state.day, cold }];
    if (cold) {
      return {
        ...state,
        rng,
        satisfaction: Math.max(0, state.satisfaction - c.coldSatisfactionLoss),
        ipo: { ...state.ipo, applications, retryDay: state.day + c.coldDelayDays },
      };
    }
    return { ...state, rng, ipo: { ...state.ipo, applications, approvedDay: state.day } };
  }

  /** A roughly normal random number with mean 0 and standard deviation 1, and the next RNG state. */
  function normal(rng: number): [value: number, next: number] {
    let total = 0;
    let next = rng;
    for (let i = 0; i < 3; i++) {
      const [r, after] = nextRandom(next);
      total += r;
      next = after;
    }
    return [(total - 1.5) * 2, next];
  }

  /** Why the first day went as it did, in words: what helped and hurt, the float, and luck. */
  function reasons(list: IpoCondition[], growth: number, float: number, drift: number, move: number): string[] {
    const out: string[] = [];
    for (const x of list) {
      if (x.comfort >= 0.75) out.push(`+ ${x.label}: comfortably over (${x.now})`);
      else if (x.comfort <= 0.25) out.push(`− ${x.label}: only just there (${x.now})`);
    }
    if (growth >= 0.1) out.push(`+ Growth: paying users up ${percent(growth)}`);
    else if (growth < 0) out.push(`− Growth: paying users down ${percent(-growth)}`);
    out.push(
      float <= (c.minFloat + c.maxFloat) / 2
        ? `A small float (${percent(float)}): scarce shares swing further`
        : `A large float (${percent(float)}): plenty of shares, so a steadier day`,
    );
    const luck = move - drift;
    if (Math.abs(luck) >= 0.02) out.push(`${luck > 0 ? "+ Luck: buyers were keen" : "− Luck: the market was nervous"}`);
    return out;
  }

  /**
   * Floats `float` of the company in new shares at the offer price and rings the opening bell: the cash raised arrives,
   * everyone is diluted, the first day of trading is played, and the game ends.
   */
  function ringBell(state: GameState, float: number): GameState {
    if (state.ipo.result) throw new SimError("ipo_floated", `${state.companyName} has already floated.`);
    if (state.ipo.approvedDay === null) {
      throw new SimError("ipo_not_approved", "Apply to float first: the bell can only be rung once your IPO is approved.");
    }
    if (typeof float !== "number" || !Number.isFinite(float) || float < c.minFloat - 1e-9 || float > c.maxFloat + 1e-9) {
      throw new SimError(
        "bad_float",
        `Float from ${percent(c.minFloat)} to ${percent(c.maxFloat)} of the company. Floating less would make the IPO fail.`,
        { min: c.minFloat, max: c.maxFloat },
      );
    }
    const list = conditions(state);
    const comfort = comfortOf(list);
    const v = shares.valuation(state);
    const offerPrice = v.sharePrice;
    const p = preview(state, float, offerPrice);
    const growth = Math.max(-1, Math.min(1, v.growth));
    const drift = c.minDrift + (c.maxDrift - c.minDrift) * comfort + c.growthDrift * growth;
    const swing = swingAt(float);
    const ticks = Math.max(1, Math.round(c.ticks));

    let rng = state.rng;
    let price = offerPrice;
    const prices = [pence(offerPrice)];
    for (let i = 0; i < ticks; i++) {
      const [z, next] = normal(rng);
      rng = next;
      price = Math.max(offerPrice * c.lowestClose, price * (1 + drift / ticks + (swing / Math.sqrt(ticks)) * z));
      prices.push(pence(price));
    }
    const closePrice = prices.at(-1)!;
    const marketValue = Math.round(closePrice * p.sharesAfter);
    const yours = studentShares(state);
    const result: IpoResult = {
      day: state.day,
      float,
      newShares: p.newShares,
      sharesBefore: v.sharesInIssue,
      sharesAfter: p.sharesAfter,
      valuation: v.valuation,
      offerPrice,
      cashRaised: p.cashRaised,
      prices,
      closePrice,
      marketValue,
      studentShares: yours,
      studentShare: yours / p.sharesAfter,
      studentValue: Math.round(yours * closePrice),
      comfort: Math.round(comfort * 100) / 100,
      reasons: reasons(list, v.growth, float, drift, closePrice / offerPrice - 1),
    };
    const entry: LogEntry = {
      text: `${state.companyName} floated ${percent(float)}: ${count.format(p.newShares)} new shares at ${pounds(offerPrice)} raised ${pounds(p.cashRaised)}.`,
      cashDelta: p.cashRaised,
      kind: "funding",
    };
    return {
      ...finance.chargeNow(state, [entry]),
      rng,
      status: "finished",
      shareholders: [...state.shareholders, { id: "public", shares: p.newShares, day: state.day }],
      ipo: { ...state.ipo, result },
    };
  }

  return { startingIpo, ipoView, applyForIpo, ringBell };
}

export type Ipo = ReturnType<typeof createIpo>;
