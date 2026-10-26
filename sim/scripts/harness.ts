// The balance harness: plays many seeded games through the sim's public interface with a few scripted strategies,
// and reports how each model and product did. A tool for tuning the defaults, not part of the game. See balance.ts.
import {
  createSim,
  FUNDER_IDS,
  CSUITE_ROLES,
  seriesApproachDay,
  vcLadder,
  type CsuiteRole,
  ROUND_IDS,
  type RoundId,
  profitCosts,
  MODEL_IDS,
  PRODUCT_TYPE_IDS,
  SimError,
  SPEND_CATEGORIES,
  STAFF_SCHEMES,
  type Action,
  type DayLog,
  type GameConfig,
  type GameState,
  type ModelId,
  type SchemeLevels,
  type StaffSchemeId,
  type ProductTypeId,
  type ServerSize,
  type ServerType,
  type Sim,
  type StaffGrade,
  type StaffPool,
  type Spend,
  type UnitsView,
} from "../src/index.ts";

/**
 * A scripted way of playing: a bot, not an AI. Every strategy plays the same sensible game (see playDay) except for
 * the one thing it changes.
 */
export interface Strategy {
  id: string;
  /** One line on what it does differently. */
  description: string;
  /** The price it sets on day 1, as a share of the fair price: 1 keeps the fair price. */
  priceFactor: number;
  /** Hires and lets go support staff to keep up with the tickets, and moderators the reports. Without it, keeps the starting staff. */
  support: boolean;
  /**
   * "ahead" adds servers ahead of demand (and on IaaS and PaaS, drops ones it doesn't need); "reactive" scales the
   * same way, but only once a tier has filled up; "none" keeps its launch setup. Every strategy sets up servers for the
   * launch total on day 1 (see playDay).
   */
  scaling: "ahead" | "reactive" | "none";
  /**
   * Takes the bank loan at the start: on on-prem only, on every model, or never. "late" takes it, on worse terms, on
   * the first day cash falls below a week of running costs.
   */
  loan: "onprem" | "always" | "late" | "never";
  /** Starts a migration on this day, once it can afford the quote, to the model `migrateTo` picks. */
  migrateDay?: number;
  /** Accepts friends and family and the grant on day 1. */
  funding?: boolean;
  /** Accepts the first angel investor's opening offer the day they approach. */
  angel?: boolean;
  /** In every VC round, the day the VCs approach, picks the one offering the most cash and accepts their opening offer. */
  vc?: boolean;
  /**
   * Who builds the MVP. "rush" adds two agency mid developers on day 1 and lets them go once it's done; "lean" builds it
   * with one developer, letting the second go on day 1 and hiring a mid back once it's done. Left out, the starting two.
   */
  mvp?: "rush" | "lean";
  /**
   * The developer slider once the MVP is done: the share on optimisation while there's a feature to build, and whether
   * developers go wholly onto optimisation when there's nothing to build. Left out, 0 and yes.
   */
  slider?: { building: number; idle: boolean };
  /**
   * Researchers: how many mids to keep while a feature whose tier is available is still to unlock, from how many days
   * after the first angel approach. Left out, one from the approach.
   */
  research?: { team: number; from: number };
  /** Marketers: how many mids run Campaigns, from how many days after the first angel approach. Left out, none. */
  marketing?: { team: number; from: number };
  /**
   * Staff schemes it offers in every pay review: the levels wanted, with a cash rise of inflation less what the
   * schemes raised are worth to staff. Left out, none: cash only.
   */
  schemes?: Partial<SchemeLevels>;
  /** How it bargains in pay reviews, in place of the default policy (see settlePay). */
  pay?: PayPolicy;
  /** Who it hires to the C-suite, and how it picks from each shortlist. Left out, the full C-suite the IPO needs (see hireExecutives). */
  csuite?: CsuitePolicy;
}

/**
 * Who a strategy hires to the C-suite: each role in `roles` once it's open (and the company has launched, for any but
 * the head of development), the candidate `pick` prefers. `beforeTrading` holds every hire until that many days before
 * the IPO's trading history is met, and Series A has approached (when the last roles open): the full C-suite the IPO
 * needs, as late as it can be hired in time to float.
 */
export interface CsuitePolicy {
  roles: CsuiteRole[];
  pick: "cheapest" | "strongest";
  beforeTrading?: number;
}

/** The default: every role, as the IPO needs, the cheapest of each, two weeks before it could float. */
const IPO_EXECUTIVES: CsuitePolicy = { roles: [...CSUITE_ROLES], pick: "cheapest", beforeTrading: 14 };

/**
 * A way of bargaining in pay reviews: what it opens with, what it adds in schemes, when it takes staff's counter and
 * how far it comes up when it doesn't. Its offers are judged on their worth to staff, schemes included.
 */
export interface PayPolicy {
  /** The opening offer's worth: inflation plus this many points (0.01 = 1 point), or "min", the least allowed. */
  opening: number | "min";
  /**
   * The staff schemes it raises a level each review (a toggle goes on in the first), offering their worth in place of
   * cash: the cash rise is the offer's worth less what the schemes raised are worth to staff. Left out, cash only.
   */
  schemes?: readonly StaffSchemeId[];
  /**
   * Takes staff's counter when its worth is no more than inflation plus this many points: a counter keeps the schemes
   * offered and asks the rest in cash. Null never takes a counter.
   */
  acceptWithin: number | null;
  /** A counter it doesn't take: its next offer comes this share of the way from its last towards staff's figure. */
  step: number;
  /**
   * Takes staff's counter rather than make a final offer when the tribunal's fee would leave less than this many days
   * of running costs in the bank. Left out, it risks the tribunal whatever its cash.
   */
  feeCushionDays?: number;
}

export const STRATEGIES: Strategy[] = [
  {
    id: "sensible",
    description:
      "Fair price, staff to needs, servers ahead of demand, support to clear the backlog, loan on on-prem; one researcher while there's a feature to unlock, and developers on optimisation when there's nothing to build. Careful play.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
  },
  { id: "over-priced", description: "As sensible, at twice the fair price from day 1.", priceFactor: 2, support: true, scaling: "ahead", loan: "onprem" },
  { id: "under-priced", description: "As sensible, at 60% of the fair price from day 1.", priceFactor: 0.6, support: true, scaling: "ahead", loan: "onprem" },
  { id: "no-support", description: "As sensible, but never hires support or moderators beyond the starting staff.", priceFactor: 1, support: false, scaling: "ahead", loan: "onprem" },
  { id: "no-scaling", description: "As sensible, but never adds servers to its launch setup.", priceFactor: 1, support: true, scaling: "none", loan: "onprem" },
  {
    id: "reactive-scaling",
    description: "As sensible, but scales only once a tier has filled up: after the outage, not before it.",
    priceFactor: 1,
    support: true,
    scaling: "reactive",
    loan: "onprem",
  },
  { id: "no-loan", description: "As sensible, but never takes the bank loan, on-prem included.", priceFactor: 1, support: true, scaling: "ahead", loan: "never" },
  {
    id: "late-loan",
    description: "As sensible, but takes the loan only once cash falls below a week of running costs, on any model.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "late",
  },
  { id: "loan", description: "As sensible, and takes the bank loan at the start on every model.", priceFactor: 1, support: true, scaling: "ahead", loan: "always" },
  {
    id: "funded",
    description: "As no-loan, but accepts friends and family and the grant on day 1 instead.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "never",
    funding: true,
  },
  {
    id: "angel",
    description: "As sensible, and accepts the first angel investor's opening offer the day they approach.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
    angel: true,
  },
  {
    id: "vc",
    description: "As angel, and in every VC round takes the opening offer of the VC offering the most cash, the day they approach.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
    angel: true,
    vc: true,
  },
  {
    id: "migrate",
    description: "As sensible, and migrates on day 60 (on-prem → IaaS → PaaS → SaaS → IaaS).",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
    migrateDay: 60,
  },
  {
    id: "mvp-rush",
    description: "As sensible, and rushes the MVP with two agency mid developers on day 1, let go once it's done.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
    mvp: "rush",
  },
  {
    id: "lean-launch",
    description: "As sensible, but builds the MVP with one developer: lets the second go on day 1 and hires a mid back at launch.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
    mvp: "lean",
  },
  {
    id: "researchers-first",
    description: "As sensible, with two researchers from the angel approach, and one marketer running Campaigns 30 days later.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
    research: { team: 2, from: 0 },
    marketing: { team: 1, from: 30 },
  },
  {
    id: "marketers-first",
    description: "As sensible, with two marketers running Campaigns from the angel approach, and one researcher 30 days later.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
    research: { team: 1, from: 30 },
    marketing: { team: 2, from: 0 },
  },
  {
    id: "slider-high",
    description: "As sensible, with the developer slider at 75% optimisation from launch, even while features are to build.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
    slider: { building: 0.75, idle: true },
  },
  {
    id: "slider-low",
    description: "As sensible, but never optimises: the developer slider stays at 0%, even with nothing to build.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
    slider: { building: 0, idle: false },
  },
  {
    id: "csuite",
    description:
      "As sensible, and hires the strongest candidate to every C-suite role as soon as it opens: the head of development on day 1, the other heads at the launch, legal counsel and the CISO with the rest at Series A.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
    csuite: { roles: [...CSUITE_ROLES], pick: "strongest" },
  },
  {
    id: "cash-only",
    description:
      "As sensible, but bargains in pay reviews with cash alone: opens at inflation, takes a counter up to 1.5 points over it, and otherwise comes halfway to staff's figure, as far as the tribunal unless its fee would leave less than two weeks' running costs.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
    pay: { opening: 0, acceptWithin: 0.015, step: 0.5, feeCushionDays: 14 },
  },
  {
    id: "scheme-heavy",
    description:
      "As sensible, but raises every staff scheme a level each pay review, share save included, for a cash rise of inflation less their worth; comes halfway to staff's figure in cash rather than take a counter, as far as the tribunal unless its fee would leave less than two weeks' running costs.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
    pay: { opening: 0, schemes: STAFF_SCHEMES, acceptWithin: null, step: 0.5, feeCushionDays: 14 },
  },
  {
    id: "tribunal-gambler",
    description: "As sensible, but offers the least allowed three times in every pay review, never takes a counter, and lets the tribunal settle it.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
    pay: { opening: "min", acceptWithin: null, step: 0 },
  },
];

/** Where the migrate strategy moves each model to. */
export const migrateTo: Record<ModelId, ModelId> = { onprem: "iaas", iaas: "paas", paas: "saas", saas: "iaas" };

/** How one game went. */
export interface GameResult {
  model: ModelId;
  productType: ProductTypeId;
  strategy: string;
  seed: number;
  /** "cant-start" when the model costs more up front than the company has (on-prem without the loan). */
  outcome: "finished" | "liquidated" | "cant-start";
  /** The last day played. */
  day: number;
  /** The day it launched: its first users arrived, starting the ramp. Null if it never did. */
  launchDay: number | null;
  cash: number;
  /** The lowest cash at the end of any day. */
  minCash: number;
  income: number;
  profit: number;
  /** The first day profit so far (income less the costs against profit) reached zero: null if it never did. */
  breakEvenDay: number | null;
  peakUsers: number;
  peakPaid: number;
  users: number;
  paidUsers: number;
  satisfaction: number;
  uptime: number;
  outageDays: number;
  /** The first tier load ran over, and the day: null if load never did. */
  firstOverload: { tier: "cu" | "dbu"; day: number } | null;
  /** The day the loan was taken, or null. */
  loanDay: number | null;
  /** The day a vulture VC rescued it, the first time cash ran out, or null. */
  rescueDay: number | null;
  /** The model it ended on, and the day a migration started, if one did. */
  endModel: ModelId;
  migrationDay: number | null;
  /** Spend by category, and staff at the end. */
  spend: Record<string, number>;
  staff: { developers: number; ops: number; support: number; moderators: number };
  /** The pay reviews settled. */
  pay: PayResult;
  /** The day each rung of the funding ladder first approached, or null; and the day the IPO's trading history was met. */
  rounds: Record<RoundId, number | null>;
  /** The day the game's last VC round first approached, or null: Series D, or Series B in a 180-day game's two. */
  lastRound: number | null;
  tradingDay: number | null;
  /**
   * The C-suite: executives hired, the day the last role was filled (the IPO needs the full C-suite), or null, what
   * their salaries came to and the equity they took.
   */
  csuite: { hired: number; ipoDay: number | null; pay: number; equity: number };
}

/** How a game's pay reviews went. */
export interface PayResult {
  reviews: number;
  /** Every cash rise agreed, compounded: pay as a multiple of the day rates at the end, less 1 (0.12 = 12% up). */
  rise: number;
  /** The agreed cash rises less each review's inflation, added up: below 0, pay fell in real terms. */
  realTerms: number;
  /** How each review was settled. */
  outcomes: Record<"offerAccepted" | "counterAccepted" | "tribunal", number>;
  /** What the tribunals picked, and their fees in all. */
  tribunalPicks: Record<"student" | "middle" | "staff", number>;
  tribunalFees: number;
  /** What the staff schemes cost in cash over the game. */
  schemeSpend: number;
  /** The staff share scheme's share of the company at the end, and the student's. */
  staffSchemeShare: number;
  studentShare: number;
  /** The student's shares' worth at the end, at the final share price: their score, short of an IPO. */
  score: number;
  /** What the staff share scheme's shares are worth at the end, at the final share price: what share save cost in ownership. */
  staffSchemeValue: number;
}

/** Applies an action, or leaves the state as it was if the rules refuse it (can't afford it, price locked…). */
function tryAction(sim: Sim, state: GameState, action: Action): GameState {
  try {
    return sim.applyAction(state, action);
  } catch (e) {
    if (e instanceof SimError) return state;
    throw e;
  }
}

/**
 * Adds a server. On-prem, when no rack has room for it, first buys the biggest rack it can afford (bigger racks cost
 * less per U), as a student would on being told to.
 */
function addServer(sim: Sim, state: GameState, action: Action): GameState {
  if (action.type !== "buyServer") return tryAction(sim, state, action);
  const racks = sim.racks(state);
  if (racks && racks.mostFree < racks.serverUnits[action.size]) {
    const withRack = [...racks.options]
      .reverse()
      .map((o) => tryAction(sim, state, { type: "buyRack", size: o.size }))
      .find((s) => s !== state);
    return withRack ? tryAction(sim, withRack, action) : state;
  }
  return tryAction(sim, state, action);
}

/**
 * Brings a pool's work a day (in mids) up to what it needs now and in a week, counting hires still to start. Short now,
 * it hires juniors, the quickest permanent staff to arrive; short of next week's need, mids, who arrive in time for it.
 * A passing surge on top of today's need (a backlog to clear) it covers with agency mids, who start the next day, and
 * lets go with no severance as soon as the rest cover it. Permanent staff over by more than a person's work go juniors
 * first, then mids, then seniors, while there's the cash for their severance.
 */
function staffTo(sim: Sim, state: GameState, pool: "ops" | "support" | "moderators", now: number, nextWeek = now, surge = 0): GameState {
  let s = state;
  const view = () => sim.staff(s).find((p) => p.pool === pool)!;
  const output = (g: StaffGrade, agency = false) => sim.config.staffGrades[g].output * (agency ? sim.config.agency.output : 1);
  const workOf = (grades: { grade: StaffGrade; count: number }[], agency: boolean) =>
    grades.reduce((sum, g) => sum + g.count * output(g.grade, agency), 0);
  // Permanent staff's work once every permanent hire has started.
  const permanent = () => workOf(view().grades, false) + workOf(view().hiring.filter((h) => !h.agency), false);
  // Everyone's work tomorrow, counting the hires who start then.
  const tomorrow = () => view().output + view().hiring.filter((h) => h.daysLeft <= 1).reduce((sum, h) => sum + h.count * output(h.grade, h.agency), 0);
  const hire = (grade: StaffGrade, short: number, agency = false) => {
    const count = Math.ceil(Math.round((short / output(grade, agency)) * 100) / 100);
    if (count > 0) s = sim.applyAction(s, { type: "hire", pool, grade, count, agency });
  };
  // A surge covered with permanent juniors leaves them over once it's past, to keep or pay severance on.
  hire("junior", now - permanent());
  hire("mid", nextWeek - permanent());
  hire("mid", now + surge - tomorrow(), true);
  for (const grade of ["junior", "mid", "senior"] as const) {
    while (view().agency.find((g) => g.grade === grade)!.count > 0 && tomorrow() - output(grade, true) >= now + surge) {
      s = sim.applyAction(s, { type: "letGo", pool, grade, agency: true });
    }
  }
  const target = Math.max(now, nextWeek);
  for (const grade of ["junior", "mid", "senior"] as const) {
    while (view().grades.find((g) => g.grade === grade)!.count > 0 && permanent() - output(grade) >= target) {
      // Only with two weeks' running costs left after their severance: otherwise they stay.
      const severance = view().grades.find((g) => g.grade === grade)!.severance;
      if (severance > 0 && s.cash - severance < 14 * sim.runway(s).dailyCosts) break;
      s = sim.applyAction(s, { type: "letGo", pool, grade });
    }
  }
  return s;
}

/**
 * How far ahead of demand the bot keeps capacity: the growth it has seen over the last week since the launch ramp
 * (before it has seen any, the product's daily growth), compounded over the days until a server added today would
 * serve (4 days for on-prem kit, the next day on IaaS, at once on PaaS), with a margin for the product's day-to-day
 * ups and downs in load.
 */
function ahead(sim: Sim, state: GameState): number {
  const lead = sim.config.models[state.model].servers?.readyDays ?? 0;
  const margin = 1.05 + sim.config.productTypes[state.productType].growth.loadNoise;
  return dailyGrowth(sim, state) ** (lead + 1) * margin;
}

/** Users' growth a day over the last week since the launch ramp, or before any, the product's daily growth. At least 1. */
function dailyGrowth(sim: Sim, state: GameState): number {
  const launch = sim.launch(state);
  const rampOver = state.launchDay === null ? Infinity : state.launchDay + launch.rampDays - 1;
  const week = state.spendByDay.filter((d) => d.day >= rampOver && d.users > 0).slice(-8);
  const daily = week.length > 1 ? (state.users / week[0]!.users) ** (1 / (week.length - 1)) : 1 + sim.config.productTypes[state.productType].growth.dailyGrowth;
  return Math.max(1, daily);
}

/**
 * What holidays multiply the product's load by at their busiest from tomorrow until servers added today would be
 * ready: 1 with none due. Planning ahead, it counts holidays still to start (a student sees them coming on the
 * calendar); reacting, only one already on, as a student sees from the load. On the payments app, planning ahead
 * also covers a payday due in that time.
 */
function peakSoon(sim: Sim, state: GameState, ahead: boolean): number {
  const lead = sim.config.models[state.model].servers?.readyDays ?? 0;
  const last = state.day + lead + 1;
  const { on, upcoming } = sim.calendar(state);
  const due = [...on.filter((h) => h.endDay > state.day), ...(ahead ? upcoming.filter((h) => h.startDay <= last) : [])];
  const holiday = Math.max(1, ...due.map((h) => h.effect?.loadMultiplier ?? 1));
  const payday = sim.config.productTypes[state.productType].transactions?.payday;
  let pay = 1;
  for (let day = state.day + 1; ahead && payday && payday.length > 0 && day <= last; day++) {
    if (day >= payday.firstDay && (day - payday.firstDay) % payday.every < payday.length) pay = Math.max(pay, payday.multiplier);
  }
  return holiday * pay;
}

/**
 * The units view, with demand replaced by what the bot plans for: the users' usual demand (until the launch ramp
 * ends, the launch total's), times how far ahead it plans, and times any holiday peak on now, or when planning ahead,
 * due before new servers would be ready (a shop knows when Black Friday is). So it doesn't buy servers for a two-day traffic spike
 * that triples demand.
 */
function plannedUnits(sim: Sim, state: GameState, strategy: Strategy): UnitsView | null {
  const units = sim.units(state);
  if (!units) return null;
  const product = sim.config.productTypes[state.productType];
  const launch = sim.launch(state);
  // Until all its launch users are in, it plans for the most there might be: like a student, it can't see the total.
  const users = launch.status === "launched" ? state.users : Math.max(state.users, product.growth.launchUsersMax);
  const peak = peakSoon(sim, state, strategy.scaling === "ahead");
  const plan = users * peak * ahead(sim, state);
  const dbu = plan * product.demand.dbuPerUser;
  const cacheable = dbu * sim.config.servers.cacheableShare;
  const absorbed = Math.min(units.ch.capacity, cacheable);
  return {
    ...units,
    cu: { ...units.cu, demand: plan * product.demand.cuPerUser },
    dbu: { ...units.dbu, demand: dbu - absorbed, beforeCache: dbu },
    ch: { ...units.ch, demand: cacheable, absorbed },
  };
}

/**
 * The smallest size of a server type whose units cover `units`, or the biggest. Bigger servers cost less per unit and
 * need fewer ops between them, so the bot grows a tier in big steps: at least half of what it already has.
 */
function sizeFor(sim: Sim, state: GameState, type: ServerType, units: number, has = 0): ServerSize {
  const options = sim.serverOptions(state).filter((o) => o.type === type && o.units > 0);
  const wanted = Math.max(units, has / 2);
  return (options.find((o) => o.units >= wanted) ?? options[options.length - 1]!).size;
}

/**
 * On IaaS and on-prem: adds an app server, database or cache when planned demand passes what the servers give, sized
 * for the gap, and load balancers to cover every app server. Waits for any of the same type still being set up. On
 * IaaS, cancels the smallest server of a type it could do without.
 */
function scaleServers(sim: Sim, state: GameState, strategy: Strategy): GameState {
  const units = plannedUnits(sim, state, strategy);
  if (!units) return state;
  const add = state.model === "onprem" ? "buyServer" : "rentServer";
  const servers = sim.servers(state);
  const pending = (type: ServerType) => servers.some((s) => s.type === type && s.status === "pending");
  const ofType = (type: ServerType) => servers.filter((s) => s.type === type);
  let s = state;

  const cuGap = units.cu.demand - units.cu.capacity;
  if (cuGap > 0 && !pending("app")) s = addServer(sim, s, { type: add, server: "app", size: sizeFor(sim, s, "app", cuGap, units.cu.capacity) });

  const dbuGap = units.dbu.demand - units.dbu.capacity;
  if (dbuGap > 0 && !pending("database") && !pending("cache")) {
    // A cache is the cheap way to take load off the database, while there's cacheable demand it isn't taking; but
    // the first is always a database, since a cache can't serve without one.
    // A cache that can't take the whole gap comes with a database for the rest, ordered the same day: on-prem kit
    // takes days to arrive, so waiting for the cache before ordering the database leaves the database short.
    const cacheRoom = units.ch.demand - units.ch.capacity;
    const cached = cacheRoom > 0 && ofType("database").length > 0 ? Math.min(dbuGap, cacheRoom) : 0;
    if (cached > 0) s = addServer(sim, s, { type: add, server: "cache", size: sizeFor(sim, s, "cache", cached, units.ch.capacity) });
    if (dbuGap > cached) s = addServer(sim, s, { type: add, server: "database", size: sizeFor(sim, s, "database", dbuGap - cached, units.dbu.capacity) });
  }

  // Load balancers for every app server, ready or not: one that covers them all.
  const after = sim.servers(s);
  const apps = after.filter((v) => v.type === "app").length;
  const coverage = after.filter((v) => v.type === "loadBalancer").reduce((sum, v) => sum + v.units, 0);
  if (apps >= sim.config.servers.loadBalancerFrom && coverage < apps && !pending("loadBalancer")) {
    s = addServer(sim, s, { type: add, server: "loadBalancer", size: sizeFor(sim, s, "loadBalancer", apps) });
  }

  // On IaaS, rentals are cancelled pro rata, so on a quiet day drop the smallest server there's plenty of room without:
  // capacity to spare on its tier, cache hits beyond what's cacheable, or load balancers beyond the app servers.
  if (state.model === "iaas" && s === state) {
    const room: Record<ServerType, (units: number) => boolean> = {
      app: (n) => apps > 1 && units.cu.capacity - n >= units.cu.demand * 1.5,
      database: (n) => units.dbu.capacity - n >= units.dbu.demand * 1.5,
      cache: (n) => units.ch.capacity - n >= units.ch.demand && units.dbu.capacity >= (units.dbu.demand + n) * 1.5,
      loadBalancer: (n) => coverage - n >= apps,
      // The harness never buys an API, so has no API servers to drop.
      api: () => false,
    };
    for (const type of ["app", "database", "cache", "loadBalancer"] as const) {
      const ready = ofType(type).filter((v) => v.status === "ready");
      if (!ready.length) continue;
      const smallest = ready.reduce((a, b) => (b.units < a.units ? b : a));
      if (room[type](smallest.units)) return tryAction(sim, s, { type: "cancelServer", id: smallest.id });
    }
  }
  return s;
}

/** On PaaS: instances for planned demand, and the smallest managed database (then cache) that covers its share. */
function scaleManaged(sim: Sim, state: GameState, strategy: Strategy): GameState {
  const managed = sim.managed(state);
  const units = plannedUnits(sim, state, strategy);
  if (!managed || !units) return state;
  const instances = Math.min(managed.maxInstances, Math.max(1, Math.ceil(units.cu.demand / managed.instanceUnits)));
  let s = instances === managed.instances ? state : tryAction(sim, state, { type: "setInstances", count: instances });
  // The database sized for all the database demand before any cache; past the biggest, a cache for the rest.
  const dbu = units.dbu.beforeCache;
  const db = managed.databaseOptions.find((o) => o.units >= dbu) ?? managed.databaseOptions[managed.databaseOptions.length - 1]!;
  if (db.size !== managed.database?.size) s = tryAction(sim, s, { type: "setManagedService", service: "database", size: db.size });
  const rest = dbu - db.units;
  const cache = rest > 0 ? (managed.cacheOptions.find((o) => o.units >= rest) ?? managed.cacheOptions[managed.cacheOptions.length - 1]!).size : null;
  if (cache !== (managed.cache?.size ?? null)) s = tryAction(sim, s, { type: "setManagedService", service: "cache", size: cache });
  return s;
}

/**
 * Features whose tier is unlocked: on SaaS buys add-ons, cheapest set-up first, whenever one leaves a month of running
 * costs in the bank; elsewhere the developers build the product's features one after another, cheapest first.
 */
function buildFeatures(sim: Sim, state: GameState): GameState {
  const features = sim.features(state);
  if (state.model === "saas") {
    const month = sim.dailyStaffCost(state) * 30 + sim.monthlyInfrastructureCost(state) + sim.monthlyAddonCost(state);
    return features
      .filter((f) => f.status === "notStarted" && f.unlocked)
      .sort((a, b) => a.addonSetupFee - b.addonSetupFee)
      .reduce((s, f) => (s.cash - f.addonSetupFee >= month ? tryAction(sim, s, { type: "buyAddon", feature: f.id }) : s), state);
  }
  if (features.some((f) => f.status === "building")) return state;
  const next = features.filter((f) => f.status === "notStarted" && f.unlocked).sort((a, b) => a.devDays - b.devDays)[0];
  return next ? tryAction(sim, state, { type: "buildFeature", feature: next.id }) : state;
}

/** Days since the first angel approach opened researchers and marketers, or null before it. */
function sinceApproach(sim: Sim, state: GameState): number | null {
  const opened = sim.research(state).unlockedDay;
  return opened === null ? null : state.day - opened;
}

/** A pool's headcount, counting hires still to start. */
function teamSize(sim: Sim, state: GameState, pool: StaffPool): number {
  const team = sim.staff(state).find((p) => p.pool === pool);
  return team ? team.headcount + team.hiring.reduce((sum, h) => sum + h.count, 0) : 0;
}

/**
 * Research, once the first angel has approached (and the strategy's wait is over): unlocks the cheapest of the
 * product's features whose tier is available whenever the RP are banked. It keeps the strategy's mids on while the RP
 * banked fall short of those features' prices, and lets them go once they don't, hiring again when a later tier opens.
 * Model benefits are left alone, as the bot never buys them.
 */
function research(sim: Sim, state: GameState, strategy: Strategy): GameState {
  const plan = strategy.research ?? { team: 1, from: 0 };
  const since = sinceApproach(sim, state);
  if (since === null || since < plan.from) return state;
  let s = state;
  const available = () => sim.features(s).filter((f) => !f.unlocked && f.tierAvailable);
  for (const f of available().sort((a, b) => a.rpPrice - b.rpPrice)) {
    if (s.researchPoints >= f.rpPrice) s = tryAction(sim, s, { type: "unlockItem", item: f.id });
  }
  const short = available().reduce((sum, f) => sum + f.rpPrice, 0) - s.researchPoints;
  const people = teamSize(sim, s, "researchers");
  if (short > 0 && people < plan.team) s = tryAction(sim, s, { type: "hire", pool: "researchers", grade: "mid", count: plan.team - people });
  if (short <= 0) {
    while (sim.staff(s).find((p) => p.pool === "researchers")!.headcount > 0) {
      const next = tryAction(sim, s, { type: "letGo", pool: "researchers", grade: "mid" });
      if (next === s) break;
      s = next;
    }
  }
  return s;
}

/** Hires the C-suite roles the strategy wants, each once it's open: see CsuitePolicy. */
function hireExecutives(sim: Sim, state: GameState, strategy: Strategy): GameState {
  const policy = strategy.csuite ?? IPO_EXECUTIVES;
  if (policy.beforeTrading !== undefined) {
    if (state.launchDay === null || seriesApproachDay(state, "seriesA") === null) return state;
    const tradingDay = state.launchDay + sim.config.ipo.minTradingDays - 1;
    if (state.day < tradingDay - policy.beforeTrading) return state;
  }
  let s = state;
  for (const role of policy.roles) {
    const view = sim.csuite(s).roles.find((r) => r.role === role)!;
    if (!view.open || view.executive || (role !== "headOfDevelopment" && s.launchDay === null)) continue;
    const pick = view.shortlist.reduce((a, b) =>
      policy.pick === "cheapest" ? (b.salary < a.salary ? b : a) : b.strength > a.strength ? b : a,
    );
    s = tryAction(sim, s, { type: "hireExecutive", role, candidate: pick.id });
  }
  return s;
}

/** What a user brings in a month at today's price and paying share: what a Campaign's cost per user is weighed against. */
function monthlyValue(state: GameState): number {
  return state.users > 0 ? (state.price * state.paidUsers) / state.users : 0;
}

/**
 * Campaigns, once the first angel has approached (and the strategy's wait is over): keeps the strategy's mid marketers
 * while a Campaign would pay for itself within two months, and has every free one start a 14-day Campaign on the type
 * a pound buys most users of, with what cash it can spare over a month's running costs (up to £5,000). Once
 * Campaigns stop paying (the market fills), it lets free marketers go.
 */
function marketing(sim: Sim, state: GameState, strategy: Strategy): GameState {
  const plan = strategy.marketing;
  const since = sinceApproach(sim, state);
  if (!plan || since === null || since < plan.from || state.launchDay === null) return state;
  let s = state;
  const best = () => sim.campaigns(s).types.reduce((a, b) => (b.usersPerPound > a.usersPerPound ? b : a));
  const pays = () => best().usersPerPound > 0 && 1 / best().usersPerPound <= 2 * monthlyValue(s);
  // A quarter of the last day's income for each of its days, up to £5,000, keeping a week's running costs in the bank.
  const budget = () => {
    const week = 7 * (sim.dailyStaffCost(s) + sim.monthlyInfrastructureCost(s) / 30);
    const income = s.spendByDay.at(-1)?.income ?? 0;
    return Math.floor(Math.min(5_000, 0.25 * income * 14, s.cash - week) / 100) * 100;
  };
  const enough = () => budget() >= Math.max(500, sim.config.campaigns.minBudget);
  const people = teamSize(sim, s, "marketers");
  if (pays() && enough() && people < plan.team) s = tryAction(sim, s, { type: "hire", pool: "marketers", grade: "mid", count: plan.team - people });
  while (sim.campaigns(s).canStart && pays() && enough()) {
    const next = tryAction(sim, s, { type: "startCampaign", customerType: best().id, budget: budget(), days: 14 });
    if (next === s) break;
    s = next;
  }
  if (!pays()) {
    while (sim.campaigns(s).marketers.free > 0) {
      const next = tryAction(sim, s, { type: "letGo", pool: "marketers", grade: "mid" });
      if (next === s) break;
      s = next;
    }
  }
  return s;
}

/**
 * The developer slider once the MVP is done: the strategy's share while there's a feature being built or to build, and
 * with nothing to build (every unlocked feature built, or on SaaS, where features are bought), all on optimisation if
 * the strategy does that.
 */
function optimise(sim: Sim, state: GameState, strategy: Strategy): GameState {
  if (!sim.mvp(state).done) return state;
  const plan = strategy.slider ?? { building: 0, idle: true };
  const toBuild = state.model !== "saas" && sim.features(state).some((f) => f.status === "building" || (f.status === "notStarted" && f.unlocked));
  const share = toBuild || !plan.idle ? plan.building : 1;
  return share === sim.optimisation(state).share ? state : tryAction(sim, state, { type: "setOptimisation", share });
}

/** The MVP rush's agency developers, or the lean launch's single developer (see Strategy.mvp). */
function mvpTeam(sim: Sim, state: GameState, strategy: Strategy): GameState {
  if (!strategy.mvp) return state;
  const done = sim.mvp(state).done;
  const devs = sim.staff(state).find((p) => p.pool === "developers")!;
  const agency = devs.agency.find((g) => g.grade === "mid")!.count;
  if (strategy.mvp === "rush") {
    if (state.day === 1 && !done) return tryAction(sim, state, { type: "hire", pool: "developers", grade: "mid", count: 2, agency: true });
    if (done && agency > 0) return tryAction(sim, state, { type: "letGo", pool: "developers", grade: "mid", agency: true, count: agency });
    return state;
  }
  if (state.day === 1 && !done) return tryAction(sim, state, { type: "letGo", pool: "developers", grade: "mid" });
  if (done && state.launchDay !== null && teamSize(sim, state, "developers") < sim.config.staff.developers.startingCount) {
    return tryAction(sim, state, { type: "hire", pool: "developers", grade: "mid", count: 1 });
  }
  return state;
}

/**
 * The pay review policy every bot plays without a PayPolicy of its own (see bargain), so its games get past the
 * reviews: offer inflation (pay held level in real terms), as cash or, with `schemes`, as those schemes and the rest in
 * cash, and if staff counter, accept their counter (which keeps the schemes, with cash on top).
 */
function settlePay(sim: Sim, state: GameState, strategy: Strategy): GameState {
  const review = sim.payReview(state);
  if (!review) return state;
  if (strategy.pay) return bargain(sim, state, strategy.pay);
  const schemes = strategy.schemes;
  const worth = schemes ? sim.payOfferPreview(state, review.minOffer, schemes).schemeValue : 0;
  const rise = Math.max(0, Math.round((review.inflation - worth) * 1000) / 1000);
  const offered = tryAction(sim, state, schemes ? { type: "offerPayRise", rise, schemes } : { type: "offerPayRise", rise });
  return sim.payReview(offered) ? tryAction(sim, offered, { type: "acceptPayCounter" }) : offered;
}

/** A rise to the tenth of a point, as the sim rounds them. */
const toTenth = (rise: number) => Math.round(rise * 1000) / 1000;

/**
 * Settles an open pay review with a PayPolicy: up to three offers, each worth more than the last by the policy's step
 * towards staff's figure (and less than it, as an offer at their counter is refused), taking a counter within the
 * policy's reach. A failed third offer goes to the tribunal. Should the rules refuse an offer, it takes the counter.
 */
function bargain(sim: Sim, state: GameState, policy: PayPolicy): GameState {
  let s = state;
  const first = sim.payReview(s)!;
  // The scheme levels for this review, the same in every offer it makes.
  const raised = first.schemes.filter((v) => policy.schemes?.includes(v.id));
  const schemes: Partial<SchemeLevels> | undefined = raised.length
    ? Object.fromEntries(raised.map((v) => [v.id, Math.min(v.maxLevel, v.level + 1)]))
    : undefined;
  const schemeWorth = schemes ? sim.payOfferPreview(s, first.minOffer, schemes).schemeValue : 0;
  let worth = policy.opening === "min" ? first.minOffer : toTenth(first.inflation + policy.opening);
  for (;;) {
    const rise = Math.max(0, toTenth(worth - schemeWorth));
    const offered = tryAction(sim, s, schemes ? { type: "offerPayRise", rise, schemes } : { type: "offerPayRise", rise });
    if (offered === s) return tryAction(sim, s, { type: "acceptPayCounter" });
    s = offered;
    const next = sim.payReview(s);
    if (!next) return s;
    if (policy.acceptWithin !== null && next.staffFigure <= toTenth(next.inflation + policy.acceptWithin)) {
      return tryAction(sim, s, { type: "acceptPayCounter" });
    }
    const daily = sim.dailyStaffCost(s) + sim.monthlyInfrastructureCost(s) / 30;
    if (next.final && policy.feeCushionDays !== undefined && s.cash - next.tribunalFee < policy.feeCushionDays * daily) {
      return tryAction(sim, s, { type: "acceptPayCounter" });
    }
    const last = next.studentOffers.at(-1)!;
    worth = Math.max(next.minOffer, Math.min(toTenth(next.staffFigure - 0.001), toTenth(last + policy.step * (next.staffFigure - last))));
  }
}

/**
 * What the bot does before each day: any pay review, price, migration, servers, staff, the MVP team, research,
 * Campaigns, features and the slider.
 */
export function playDay(sim: Sim, state: GameState, strategy: Strategy): GameState {
  let s = settlePay(sim, state, strategy);
  if (s.day === 1 && strategy.priceFactor !== 1) {
    // On the payments app the transaction fee moves with the monthly fee.
    const fairRate = sim.payments(s)?.fairRate;
    const rate = fairRate === undefined ? {} : { rate: Math.round(fairRate * strategy.priceFactor * 10_000) / 10_000 };
    s = tryAction(sim, s, { type: "setPrice", price: Math.round(sim.fairPrice(s) * strategy.priceFactor * 100) / 100, ...rate });
  }
  if (strategy.migrateDay !== undefined && s.day >= strategy.migrateDay && s.migrations === 0 && !s.migration) {
    // Only once the quote leaves a month of running costs in the bank.
    const quote = sim.migrationQuote(s, migrateTo[s.model]);
    const month = sim.dailyStaffCost(s) * 30 + sim.monthlyInfrastructureCost(s);
    if (s.cash > quote.total + month) s = tryAction(sim, s, { type: "startMigration", model: migrateTo[s.model] });
  }
  if (strategy.angel && sim.investors(s).offer) s = tryAction(sim, s, { type: "acceptInvestor" });
  const vcs = sim.investors(s).vc.approach;
  if (strategy.vc && vcs && !vcs.picked) {
    const most = vcs.offers.reduce((a, b) => (b.amount > a.amount ? b : a));
    s = tryAction(sim, tryAction(sim, s, { type: "pickInvestor", investor: most.investor }), { type: "acceptInvestor" });
  }
  if (strategy.loan === "late" && !s.loan && s.cash < 7 * (sim.dailyStaffCost(s) + sim.monthlyInfrastructureCost(s) / 30)) {
    s = tryAction(sim, s, { type: "takeLoan" });
  }
  const units = sim.units(s);
  const full = !!units && (units.cu.demand >= units.cu.capacity || units.dbu.demand >= units.dbu.capacity);
  // Before and over the launch ramp, every strategy sets up servers for the launch total: the first decision.
  const launching = sim.launch(s).status !== "launched";
  if (launching || strategy.scaling === "ahead" || (strategy.scaling === "reactive" && full)) {
    s = s.model === "paas" ? scaleManaged(sim, s, strategy) : scaleServers(sim, s, strategy);
  }
  // The ops its servers need, and enough for any event on its model that costs money without them (a security patch).
  const eventOps = Math.max(0, ...sim.config.events.map((e) => (e.effects[s.model]?.shortOfOps?.cost ? (e.effects[s.model]?.opsNeeded ?? 0) : 0)));
  // Ops for kit on order too, so they've started by the time it arrives. Events only come after the launch, so until
  // then the event ops are next week's need: mids, who arrive in time, not juniors hired at once.
  const eventOpsNow = s.launchDay === null ? 0 : eventOps;
  s = staffTo(sim, s, "ops", Math.max(sim.opsNeededNow(s), eventOpsNow), Math.max(sim.opsNeededOnceReady(s), eventOps));
  if (strategy.support) {
    // Enough to clear today's tickets with a little to spare, and next week's at this growth; and from an agency, a fifth
    // of the backlog.
    const perPerson = sim.config.support.ticketsPerPerson;
    const needed = Math.max(1, (sim.usualTickets(s) * 1.1) / perPerson);
    const weekGrowth = dailyGrowth(sim, s) ** sim.config.staffGrades.mid.leadDays;
    const nextWeek = Math.max(1, (sim.usualTickets(s) * 1.1 * weekGrowth) / perPerson);
    s = staffTo(sim, s, "support", needed, nextWeek, s.backlog / 5 / perPerson);
    // On a product with user content, moderators the same way for the reports, with agency staff for the backlog.
    const moderation = sim.moderation(s);
    if (moderation) {
      const perModerator = sim.config.moderation.reportsPerPerson;
      const reportsNow = (moderation.usualReports * 1.1) / perModerator;
      const reportsNextWeek = (moderation.usualReports * 1.1 * weekGrowth) / perModerator;
      s = staffTo(sim, s, "moderators", reportsNow, reportsNextWeek, moderation.backlog / 5 / perModerator);
    }
  }
  s = mvpTeam(sim, s, strategy);
  s = hireExecutives(sim, s, strategy);
  s = marketing(sim, research(sim, s, strategy), strategy);
  return optimise(sim, buildFeatures(sim, s), strategy);
}

/** The first outage from load on a day, by the tier that ran over: read from the day's log. */
function overloadIn(log: DayLog[]): { tier: "cu" | "dbu"; day: number } | null {
  for (const { day, entries } of log) {
    for (const e of entries) {
      if (e.kind !== "outage") continue;
      if (e.text.includes("(CU)")) return { tier: "cu", day };
      if (e.text.includes("(DBU)")) return { tier: "dbu", day };
    }
  }
  return null;
}

export interface GameSpec {
  model: ModelId;
  productType: ProductTypeId;
  strategy: Strategy;
  seed: number;
}

/** Plays one game to the end with a strategy. */
export function playGame(sim: Sim, { model, productType, strategy, seed }: GameSpec): GameResult {
  const takeLoan = strategy.loan === "always" || (strategy.loan === "onprem" && model === "onprem");
  let state: GameState;
  try {
    state = sim.newGame({ companyName: "Balance Ltd", productType, model, seed, takeLoan });
    if (strategy.funding) {
      for (const funder of FUNDER_IDS) state = sim.applyAction(state, { type: "acceptFunding", funder });
    }
  } catch (e) {
    if (e instanceof SimError && e.code === "cant_afford") {
      return { ...emptyResult(model, productType, strategy.id, seed), outcome: "cant-start" };
    }
    throw e;
  }
  let minCash = state.cash;
  let firstOverload: GameResult["firstOverload"] = null;
  let migrationDay: number | null = null;
  let schemeSpend = 0;
  while (state.status === "playing") {
    state = playDay(sim, state, strategy);
    if (state.migration && migrationDay === null) migrationDay = state.day;
    const { state: next, log } = sim.advance(state);
    state = next;
    minCash = Math.min(minCash, state.cash);
    firstOverload ??= overloadIn(log);
    schemeSpend += schemeSpendIn(sim, log);
  }
  const summary = sim.summarise(state);
  return {
    model,
    productType,
    strategy: strategy.id,
    seed,
    outcome: summary.ending === "liquidation" ? "liquidated" : "finished",
    day: summary.day,
    launchDay: state.launchDay,
    cash: summary.cash,
    minCash,
    income: summary.income,
    profit: summary.profit,
    breakEvenDay: breakEven(state),
    peakUsers: summary.peak.users,
    peakPaid: summary.peak.paidUsers,
    users: summary.users,
    paidUsers: summary.paidUsers,
    satisfaction: summary.satisfaction,
    uptime: summary.uptime,
    outageDays: summary.outageDays,
    firstOverload,
    loanDay: summary.loan?.day ?? null,
    rescueDay: summary.rescue?.day ?? null,
    endModel: summary.model,
    migrationDay,
    spend: { ...summary.spend },
    staff: Object.fromEntries(sim.staff(state).map((p) => [p.pool, p.headcount])) as Record<StaffPool, number>,
    pay: payResult(sim, state, schemeSpend),
    rounds: {
      angel: state.investors.firstApproachDay,
      ...state.investors.vc.firstApproachDay,
    },
    lastRound: state.investors.vc.firstApproachDay[vcLadder(state).at(-1)!.round],
    tradingDay: state.launchDay === null ? null : state.launchDay + sim.config.ipo.minTradingDays - 1,
    csuite: csuiteResult(state),
  };
}

function csuiteResult(state: GameState): GameResult["csuite"] {
  const { hired } = state.csuite;
  const ipo = CSUITE_ROLES.map((role) => hired.find((e) => e.role === role)?.day ?? null);
  return {
    hired: hired.length,
    ipoDay: ipo.every((d) => d !== null) ? Math.max(...(ipo as number[])) : null,
    // Paid from the day after hiring to the last day played.
    pay: hired.reduce((sum, e) => sum + e.salary * Math.max(0, state.day - e.day), 0),
    equity: Math.round(hired.reduce((sum, e) => sum + e.equity, 0) * 10_000) / 10_000,
  };
}

/** What the staff schemes charged in a log: their daily lines, which start with the scheme's name. */
function schemeSpendIn(sim: Sim, log: DayLog[]): number {
  const names = Object.values(sim.config.payReview.schemes).map((s) => s.name);
  let spend = 0;
  for (const { entries } of log) {
    for (const e of entries) if (e.category === "staff" && names.some((n) => e.text.startsWith(n))) spend -= e.cashDelta;
  }
  return spend;
}

function payResult(sim: Sim, state: GameState, schemeSpend: number): PayResult {
  const records = state.pastPayReviews;
  const outcomes = { offerAccepted: 0, counterAccepted: 0, tribunal: 0 };
  const tribunalPicks = { student: 0, middle: 0, staff: 0 };
  for (const r of records) {
    outcomes[r.outcome]++;
    if (r.tribunal) tribunalPicks[r.tribunal.pick]++;
  }
  const rows = sim.capTable(state).rows;
  return {
    reviews: records.length,
    rise: state.payMultiplier - 1,
    realTerms: records.reduce((sum, r) => sum + r.rise - r.inflation, 0),
    outcomes,
    tribunalPicks,
    tribunalFees: records.reduce((sum, r) => sum + (r.tribunal?.fee ?? 0), 0),
    schemeSpend,
    staffSchemeShare: rows.find((r) => r.id === "staffScheme")?.share ?? 0,
    studentShare: rows.find((r) => r.id === "student")?.share ?? 0,
    score: rows.find((r) => r.id === "student")?.value ?? 0,
    staffSchemeValue: rows.find((r) => r.id === "staffScheme")?.value ?? 0,
  };
}

/** The first day profit so far reached zero, counting only the interest in loan repayments, as the summary does. */
function breakEven(state: GameState): number | null {
  const spend = Object.fromEntries(SPEND_CATEGORIES.map((c) => [c, 0])) as Spend;
  let income = 0;
  let interest = 0;
  for (const d of state.spendByDay) {
    for (const c of SPEND_CATEGORIES) spend[c] += d[c];
    income += d.income;
    interest += d.interest;
    if (income > 0 && income >= profitCosts(spend, interest)) return d.day;
  }
  return null;
}

function emptyResult(model: ModelId, productType: ProductTypeId, strategy: string, seed: number): GameResult {
  return {
    model,
    productType,
    strategy,
    seed,
    outcome: "cant-start",
    day: 0,
    launchDay: null,
    cash: 0,
    minCash: 0,
    income: 0,
    profit: 0,
    breakEvenDay: null,
    peakUsers: 0,
    peakPaid: 0,
    users: 0,
    paidUsers: 0,
    satisfaction: 0,
    uptime: 0,
    outageDays: 0,
    firstOverload: null,
    loanDay: null,
    rescueDay: null,
    endModel: model,
    migrationDay: null,
    spend: {},
    staff: { developers: 0, ops: 0, support: 0, moderators: 0 },
    pay: {
      reviews: 0,
      rise: 0,
      realTerms: 0,
      outcomes: { offerAccepted: 0, counterAccepted: 0, tribunal: 0 },
      tribunalPicks: { student: 0, middle: 0, staff: 0 },
      tribunalFees: 0,
      schemeSpend: 0,
      staffSchemeShare: 0,
      studentShare: 0,
      score: 0,
      staffSchemeValue: 0,
    },
    rounds: { angel: null, seriesA: null, seriesB: null, seriesC: null, seriesD: null },
    lastRound: null,
    tradingDay: null,
    csuite: { hired: 0, ipoDay: null, pay: 0, equity: 0 },
  };
}

export interface RunOptions {
  seeds: number[];
  strategies?: Strategy[];
  models?: readonly ModelId[];
  productTypes?: readonly ProductTypeId[];
}

/** Every model × product × strategy × seed. */
export function runAll(config: GameConfig, { seeds, strategies = STRATEGIES, models = MODEL_IDS, productTypes = PRODUCT_TYPE_IDS }: RunOptions): GameResult[] {
  const sim = createSim(config);
  const results: GameResult[] = [];
  for (const strategy of strategies) {
    for (const model of models) {
      for (const productType of productTypes) {
        for (const seed of seeds) results.push(playGame(sim, { model, productType, strategy, seed }));
      }
    }
  }
  return results;
}

// The report.

const money = (n: number) => `${n < 0 ? "-" : ""}£${Math.round(Math.abs(n)).toLocaleString("en-GB")}`;
const whole = (n: number) => Math.round(n).toLocaleString("en-GB");
const mean = (ns: number[]) => (ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0);
const median = (ns: number[]) => {
  if (!ns.length) return 0;
  const sorted = ns.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const SHORT: Record<ModelId, string> = { onprem: "On-prem", iaas: "IaaS", paas: "PaaS", saas: "SaaS" };

/** One model × product × strategy across its seeds. */
export interface Cell {
  model: ModelId;
  productType: ProductTypeId;
  strategy: string;
  games: GameResult[];
}

export function cells(results: GameResult[]): Cell[] {
  const byKey = new Map<string, Cell>();
  for (const r of results) {
    const key = `${r.strategy}|${r.model}|${r.productType}`;
    const cell = byKey.get(key) ?? { model: r.model, productType: r.productType, strategy: r.strategy, games: [] };
    cell.games.push(r);
    byKey.set(key, cell);
  }
  return [...byKey.values()];
}

/** "d84", or "d70–95" for a range of days. */
const daysText = (days: number[]) =>
  Math.min(...days) === Math.max(...days) ? `d${days[0]}` : `d${Math.min(...days)}–${Math.max(...days)}`;

/**
 * "finished", "liquidated d84", "2/5 liquidated d70–d95", or "can't start", then any rescues: "finished, rescued d60",
 * "finished, 1/5 rescued d60".
 */
function outcome(games: GameResult[]): string {
  if (games.every((g) => g.outcome === "cant-start")) return "can't start";
  const bust = games.filter((g) => g.outcome === "liquidated");
  const rescued = games.flatMap((g) => (g.rescueDay === null ? [] : [g.rescueDay]));
  const ended = !bust.length
    ? "finished"
    : `${bust.length === games.length ? "" : `${bust.length}/${games.length} `}liquidated ${daysText(bust.map((g) => g.day))}`;
  if (!rescued.length) return ended;
  return `${ended}, ${rescued.length === games.length ? "" : `${rescued.length}/${games.length} `}rescued ${daysText(rescued)}`;
}

/** "†" if any game was liquidated, else "‡" if any was rescued. */
const endMark = (games: GameResult[]) =>
  games.some((g) => g.outcome === "liquidated") ? " †" : games.some((g) => g.rescueDay !== null) ? " ‡" : "";

/** The tier that ran over first in most games, and the median day: "DBU d31", or "—". */
function firstOverload(games: GameResult[]): string {
  const hits = games.flatMap((g) => (g.firstOverload ? [g.firstOverload] : []));
  if (!hits.length) return "—";
  const cu = hits.filter((h) => h.tier === "cu").length;
  const tier = cu >= hits.length - cu ? "cu" : "dbu";
  const days = hits.filter((h) => h.tier === tier).map((h) => h.day);
  const share = hits.length < games.length ? ` (${hits.length}/${games.length})` : "";
  return `${tier.toUpperCase()} d${whole(median(days))}${share}`;
}

const loanCell = (games: GameResult[]) => {
  const taken = games.filter((g) => g.loanDay !== null);
  return taken.length ? `d${taken[0]!.loanDay}` : "no";
};

/** The median break-even day of the games that broke even, and how many did if not all: "d52", "d60 (3/5)", "never". */
function breakEvenCell(games: GameResult[]): string {
  const days = games.flatMap((g) => (g.breakEvenDay === null ? [] : [g.breakEvenDay]));
  if (!days.length) return "never";
  return `d${whole(median(days))}${days.length < games.length ? ` (${days.length}/${games.length})` : ""}`;
}

/** A row of the strategy tables. Money and users are medians across the seeds; satisfaction and uptime means. */
function row(cell: Cell): string[] {
  const g = cell.games.filter((x) => x.outcome !== "cant-start");
  if (!g.length) return [SHORT[cell.model], cell.productType, "can't start", "", "", "", "", "", "", "", "", "", "", ""];
  const launched = g.flatMap((x) => (x.launchDay === null ? [] : [x.launchDay]));
  const peak = median(g.map((x) => x.peakUsers));
  const paidShare = mean(g.map((x) => (x.peakUsers ? x.peakPaid / x.peakUsers : 0)));
  return [
    SHORT[cell.model],
    cell.productType,
    outcome(cell.games),
    launched.length ? `d${whole(median(launched))}${launched.length < g.length ? ` (${launched.length}/${g.length})` : ""}` : "never",
    money(median(g.map((x) => x.cash))),
    money(median(g.map((x) => x.minCash))),
    money(median(g.map((x) => x.profit))),
    breakEvenCell(g),
    `${whole(peak)} (${Math.round(paidShare * 100)}% paid)`,
    `${Math.round(mean(g.map((x) => x.satisfaction)))}%`,
    `${mean(g.map((x) => x.uptime)).toFixed(1)}%`,
    whole(median(g.map((x) => x.outageDays))),
    firstOverload(g),
    loanCell(g),
  ];
}

const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

/**
 * Median final cash for a strategy on a model and product, or null if it can't start. Compared on cash rather than
 * profit: profit counts every loan repayment as a cost, the amount borrowed included, but not the loan coming in.
 */
function cashOf(all: Cell[], strategy: string, model: ModelId, productType: ProductTypeId): number | null {
  const cell = all.find((c) => c.strategy === strategy && c.model === model && c.productType === productType);
  const g = cell?.games.filter((x) => x.outcome !== "cant-start") ?? [];
  return g.length ? median(g.map((x) => x.cash)) : null;
}

/** A short marker for a model × product: the final cash, with "†" if any game was liquidated, "‡" if rescued. */
function cashMark(all: Cell[], strategy: string, model: ModelId, productType: ProductTypeId): string {
  const cell = all.find((c) => c.strategy === strategy && c.model === model && c.productType === productType);
  const p = cashOf(all, strategy, model, productType);
  if (p === null || !cell) return "can't start";
  return `${money(p)}${endMark(cell.games)}`;
}

export interface ReportOptions {
  title?: string;
  seeds: number[];
  strategies?: Strategy[];
}

/** The Markdown report: headline tables first, then every strategy in full. */
export function renderReport(results: GameResult[], { title = "Balance report", seeds, strategies = STRATEGIES }: ReportOptions): string {
  const all = cells(results);
  const models = MODEL_IDS.filter((m) => results.some((r) => r.model === m));
  const products = PRODUCT_TYPE_IDS.filter((p) => results.some((r) => r.productType === p));
  const used = strategies.filter((s) => results.some((r) => r.strategy === s.id));
  const out: string[] = [`# ${title}`, ""];
  out.push(`${results.length} games: ${models.length} models × ${products.length} products × ${used.length} strategies × ${seeds.length} seeds (${seeds.join(", ")}).`);
  out.push("Money and users are medians across seeds; satisfaction and uptime are means. † = at least one seed was liquidated; ‡ = at least one was rescued by a vulture VC.");
  out.push("Models are compared on final cash: profit counts loan repayments as costs, the amount borrowed included.", "");

  out.push("## Break-even by strategy", "");
  out.push("The day profit so far first reached zero, across every model, product and seed that started. The target for careful play (sensible): an average around day 60–75, and no game later than about day 90.", "");
  out.push(table(["Strategy", "Average", "Median", "Earliest", "Latest", "Later than d90", "Never"], used.map((s) => {
    const started = results.filter((r) => r.strategy === s.id && r.outcome !== "cant-start");
    const days = started.flatMap((r) => (r.breakEvenDay === null ? [] : [r.breakEvenDay]));
    if (!days.length) return [s.id, "never", "", "", "", "", `${started.length}/${started.length}`];
    const late = days.filter((d) => d > 90).length;
    return [s.id, `d${whole(mean(days))}`, `d${whole(median(days))}`, `d${Math.min(...days)}`, `d${Math.max(...days)}`, `${late}/${started.length}`, `${started.length - days.length}/${started.length}`];
  })), "");

  out.push("## Funding rounds by strategy", "");
  out.push(
    "The day the angel and each Series round first approached (declined or not), as medians, across every game that started. The IPO needs Series A to have approached (it opens the last C-suite roles) but no later round. A 180-day game has two rounds, Series A and B, each merging two of the four, so C and D never come. All rounds: games where the last round (Series D, or B in a two-round game) approached. Last by trading: games where it approached by then. Latest last: its latest approach, or how many never had one.",
    "",
  );
  out.push(table(["Strategy", "Angel", "Series A", "Series B", "Series C", "Series D", "All rounds", "Last by trading", "Latest last"], used.map((s) => {
    const g = results.filter((r) => r.strategy === s.id && r.outcome !== "cant-start");
    const dayOf = (round: RoundId) => {
      const days = g.flatMap((r) => (r.rounds[round] === null ? [] : [r.rounds[round]!]));
      return days.length ? `d${whole(median(days))}${days.length < g.length ? ` (${g.length - days.length} never)` : ""}` : "never";
    };
    const d = g.flatMap((r) => (r.lastRound === null ? [] : [r.lastRound]));
    const onTime = g.filter((r) => r.lastRound !== null && r.tradingDay !== null && r.lastRound <= r.tradingDay).length;
    return [
      s.id,
      ...ROUND_IDS.map(dayOf),
      `${d.length}/${g.length}`,
      `${onTime}/${g.length}`,
      d.length ? `d${Math.max(...d)}${d.length < g.length ? ` (${g.length - d.length} never)` : ""}` : "never",
    ];
  })), "");

  out.push("## C-suite by strategy", "");
  out.push(
    "Executives hired, as medians across every game that started. Full C-suite: the day the last of the 11 roles was filled (every one is needed to float), and how many games filled them all. Pay: what their salaries came to over the game. Equity: the share of the company they took, capped at the C-suite's cap.",
    "",
  );
  out.push(table(["Strategy", "Hired", "Full C-suite", "Filled them all", "Pay", "Equity", "Break-even"], used.map((s) => {
    const g = results.filter((r) => r.strategy === s.id && r.outcome !== "cant-start");
    const ipo = g.flatMap((r) => (r.csuite.ipoDay === null ? [] : [r.csuite.ipoDay]));
    const even = g.flatMap((r) => (r.breakEvenDay === null ? [] : [r.breakEvenDay]));
    return [
      s.id,
      `${whole(median(g.map((r) => r.csuite.hired)))}`,
      ipo.length ? `d${whole(median(ipo))}` : "never",
      `${ipo.length}/${g.length}`,
      money(median(g.map((r) => r.csuite.pay))),
      `${Math.round(median(g.map((r) => r.csuite.equity)) * 1000) / 10}%`,
      even.length ? `d${whole(median(even))}${even.length < g.length ? ` (${g.length - even.length} never)` : ""}` : "never",
    ];
  })), "");

  if (used.some((s) => s.id === "sensible")) {
    out.push("## Sensible play: last round's approach day", "");
    out.push("Median day the last VC round (Series D, or B in a 180-day game's two) first approached, and in brackets the day the IPO's trading history was met. – : it never did.", "");
    out.push(table(["Product", ...models.map((m) => SHORT[m])], products.map((p) => [
      p,
      ...models.map((m) => {
        const g = results.filter((r) => r.strategy === "sensible" && r.model === m && r.productType === p && r.outcome !== "cant-start");
        const d = g.flatMap((r) => (r.lastRound === null ? [] : [r.lastRound]));
        const t = g.flatMap((r) => (r.tradingDay === null ? [] : [r.tradingDay]));
        return `${d.length ? `d${whole(median(d))}` : "–"}${t.length ? ` (d${whole(median(t))})` : ""}`;
      }),
    ])), "");
  }

  out.push("## Pay reviews by strategy", "");
  out.push(
    "Across every game that started. Score: the student's shares' worth at the end (their stake × the valuation), a median. Pay rise: every cash rise compounded, and against inflation added up (below 0 is a real-terms cut), as medians. How the reviews were settled: staff took the offer, the student took a counter, or a tribunal (and what it picked: student / middle / staff). Scheme spend: what the staff schemes cost in cash over the game, a median. Stake: the student's median final share of the company, and the staff share scheme's, with what its shares are worth at the final share price (what share save cost in ownership). Rescued / liquidated: games a vulture VC rescued, and games liquidated, of those that started (a tribunal's fee is charged even when it takes cash below zero).",
    "",
  );
  out.push(table(["Strategy", "Final cash", "Score", "Pay rise", "Against inflation", "Offer taken", "Counter taken", "Tribunal (S/M/St)", "Tribunal fees", "Scheme spend", "Your stake", "Staff scheme", "Its shares' worth", "Rescued / liquidated"], used.map((s) => {
    const g = results.filter((r) => r.strategy === s.id && r.outcome !== "cant-start");
    const reviews = g.reduce((sum, r) => sum + r.pay.reviews, 0);
    const count = (k: keyof PayResult["outcomes"]) => g.reduce((sum, r) => sum + r.pay.outcomes[k], 0);
    const picks = (k: keyof PayResult["tribunalPicks"]) => g.reduce((sum, r) => sum + r.pay.tribunalPicks[k], 0);
    const share = (n: number) => `${reviews ? Math.round((n / reviews) * 100) : 0}%`;
    const pct = (n: number) => `${n >= 0 ? "" : "-"}${(Math.abs(n) * 100).toFixed(1)}%`;
    const pts = (n: number) => `${n >= 0 ? "+" : "-"}${(Math.abs(n) * 100).toFixed(1)} pts`;
    return [
      s.id,
      money(median(g.map((r) => r.cash))),
      money(median(g.map((r) => r.pay.score))),
      pct(median(g.map((r) => r.pay.rise))),
      pts(median(g.map((r) => r.pay.realTerms))),
      share(count("offerAccepted")),
      share(count("counterAccepted")),
      `${share(count("tribunal"))} (${picks("student")}/${picks("middle")}/${picks("staff")})`,
      money(median(g.map((r) => r.pay.tribunalFees))),
      money(median(g.map((r) => r.pay.schemeSpend))),
      pct(median(g.map((r) => r.pay.studentShare))),
      pct(median(g.map((r) => r.pay.staffSchemeShare))),
      money(median(g.map((r) => r.pay.staffSchemeValue))),
      `${g.filter((r) => r.rescueDay !== null).length} / ${g.filter((r) => r.outcome === "liquidated").length}`,
    ];
  })), "");

  if (used.some((s) => s.id === "sensible")) {
    out.push("## Sensible play: median final cash", "");
    out.push(table(["Product", ...models.map((m) => SHORT[m]), "Best"], products.map((p) => {
      const cash = models.map((m) => [m, cashOf(all, "sensible", m, p)] as const);
      const best = cash.filter(([, v]) => v !== null).reduce((a, b) => (b[1]! > a[1]! ? b : a));
      return [p, ...models.map((m) => cashMark(all, "sensible", m, p)), SHORT[best[0]]];
    })), "");
  }

  out.push("## Each strategy against sensible: median final cash difference", "");
  const others = used.filter((s) => s.id !== "sensible");
  out.push(table(["Model", "Product", ...others.map((s) => s.id)], models.flatMap((m) => products.map((p) => {
    const base = cashOf(all, "sensible", m, p);
    return [SHORT[m], p, ...others.map((s) => {
      const v = cashOf(all, s.id, m, p);
      if (v === null) return "can't start";
      if (base === null) return money(v);
      const cell = all.find((c) => c.strategy === s.id && c.model === m && c.productType === p)!;
      return `${v - base >= 0 ? "+" : ""}${money(v - base)}${endMark(cell.games)}`;
    })];
  }))), "");

  const head = ["Model", "Product", "Outcome", "Launch", "Final cash", "Lowest cash", "Profit", "Break-even", "Peak users", "Satisfaction", "Uptime", "Outage days", "First over capacity", "Loan"];
  for (const s of used) {
    out.push(`## Strategy: ${s.id}`, "", s.description, "");
    out.push(table(head, all.filter((c) => c.strategy === s.id).map(row)), "");
  }
  return out.join("\n");
}
