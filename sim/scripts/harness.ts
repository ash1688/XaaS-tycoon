// The balance harness: plays many seeded games through the sim's public interface with a few scripted strategies,
// and reports how each model and product did. A tool for tuning the defaults, not part of the game. See balance.ts.
import {
  createSim,
  managedServicesFor,
  MANAGED_SERVICES,
  MODEL_IDS,
  PRODUCT_TYPE_IDS,
  SERVER_SIZES,
  SimError,
  type Action,
  type DayLog,
  type GameConfig,
  type GameState,
  type ModelId,
  type ProductTypeId,
  type ServerSize,
  type ServerType,
  type Sim,
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
  /** Hires and lets go support staff to keep up with the tickets. Without it, keeps the starting staff. */
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
}

export const STRATEGIES: Strategy[] = [
  {
    id: "sensible",
    description: "Fair price, staff to needs, servers ahead of demand, support to clear the backlog, loan on on-prem.",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
  },
  { id: "over-priced", description: "As sensible, at twice the fair price from day 1.", priceFactor: 2, support: true, scaling: "ahead", loan: "onprem" },
  { id: "under-priced", description: "As sensible, at 60% of the fair price from day 1.", priceFactor: 0.6, support: true, scaling: "ahead", loan: "onprem" },
  { id: "no-support", description: "As sensible, but never hires support beyond the starting staff.", priceFactor: 1, support: false, scaling: "ahead", loan: "onprem" },
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
    id: "migrate",
    description: "As sensible, and migrates on day 60 (on-prem → IaaS → PaaS → SaaS → IaaS).",
    priceFactor: 1,
    support: true,
    scaling: "ahead",
    loan: "onprem",
    migrateDay: 60,
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
  outcome: "finished" | "bankrupt" | "cant-start";
  /** The last day played. */
  day: number;
  /** The day it launched: its first users arrived, starting the ramp. Null if it never did. */
  launchDay: number | null;
  cash: number;
  /** The lowest cash at the end of any day. */
  minCash: number;
  income: number;
  profit: number;
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
  /** The model it ended on, and the day a migration started, if one did. */
  endModel: ModelId;
  migrationDay: number | null;
  /** Spend by category, and staff at the end. */
  spend: Record<string, number>;
  staff: { developers: number; ops: number; support: number };
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

/** Hires or lets go one at a time until a pool has `target` people. */
function staffTo(sim: Sim, state: GameState, pool: "ops" | "support", target: number): GameState {
  let s = state;
  while (s[pool] < target) s = sim.applyAction(s, { type: "hire", pool });
  while (s[pool] > target) s = sim.applyAction(s, { type: "letGo", pool });
  return s;
}

/**
 * How far ahead of demand the bot keeps capacity: the growth it has seen over the last week since the launch ramp
 * (before it has seen any, the product's daily growth), compounded over the days until a server added today would
 * serve (10 days for on-prem kit, the next day on IaaS, at once on PaaS), with a margin for the product's day-to-day
 * ups and downs in load.
 */
function ahead(sim: Sim, state: GameState): number {
  const lead = sim.config.models[state.model].servers?.readyDays ?? 0;
  const { growth } = sim.config.productTypes[state.productType];
  const launch = sim.launch(state);
  const rampOver = state.launchDay === null ? Infinity : state.launchDay + launch.rampDays - 1;
  const week = state.spendByDay.filter((d) => d.day >= rampOver && d.users > 0).slice(-8);
  const daily = week.length > 1 ? (state.users / week[0]!.users) ** (1 / (week.length - 1)) : 1 + growth.dailyGrowth;
  const margin = 1.05 + growth.loadNoise;
  return Math.max(1, daily) ** (lead + 1) * margin;
}

/** Whether the product's seasonal peak is on any day from tomorrow until servers added today would be ready. */
function peakSoon(sim: Sim, state: GameState): boolean {
  const spike = sim.config.productTypes[state.productType].growth.seasonalSpike;
  if (!spike) return false;
  const lead = sim.config.models[state.model].servers?.readyDays ?? 0;
  for (let day = state.day + 1; day <= state.day + lead + 1; day++) {
    if (day >= spike.firstDay && (day - spike.firstDay) % spike.every < spike.length) return true;
  }
  return false;
}

/**
 * The units view, with demand replaced by what the bot plans for: the users' usual demand (until the launch ramp
 * ends, the launch total's), times how far ahead it plans, and times the product's seasonal peak when one is due before
 * new servers would be ready (a shop knows when its sales are). So it doesn't buy servers for a two-day traffic spike
 * that triples demand.
 */
function plannedUnits(sim: Sim, state: GameState, strategy: Strategy): UnitsView | null {
  const units = sim.units(state);
  if (!units) return null;
  const product = sim.config.productTypes[state.productType];
  const launch = sim.launch(state);
  // Until all its launch users are in, it plans for the most there might be: like a student, it can't see the total.
  const users = launch.status === "launched" ? state.users : Math.max(state.users, product.growth.launchUsersMax);
  const peak = strategy.scaling === "ahead" && peakSoon(sim, state) ? (product.growth.seasonalSpike?.loadMultiplier ?? 1) : 1;
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
  if (cuGap > 0 && !pending("app")) s = tryAction(sim, s, { type: add, server: "app", size: sizeFor(sim, s, "app", cuGap, units.cu.capacity) });

  const dbuGap = units.dbu.demand - units.dbu.capacity;
  if (dbuGap > 0 && !pending("database") && !pending("cache")) {
    // A cache is the cheap way to take load off the database, while there's cacheable demand it isn't taking; but
    // the first is always a database, since a cache can't serve without one.
    const cacheRoom = units.ch.demand - units.ch.capacity;
    s =
      cacheRoom > 0 && ofType("database").length > 0
        ? tryAction(sim, s, { type: add, server: "cache", size: sizeFor(sim, s, "cache", Math.min(dbuGap, cacheRoom), units.ch.capacity) })
        : tryAction(sim, s, { type: add, server: "database", size: sizeFor(sim, s, "database", dbuGap, units.dbu.capacity) });
  }

  // Load balancers for every app server, ready or not: one that covers them all.
  const after = sim.servers(s);
  const apps = after.filter((v) => v.type === "app").length;
  const coverage = after.filter((v) => v.type === "loadBalancer").reduce((sum, v) => sum + v.units, 0);
  if (apps >= sim.config.servers.loadBalancerFrom && coverage < apps && !pending("loadBalancer")) {
    s = tryAction(sim, s, { type: add, server: "loadBalancer", size: sizeFor(sim, s, "loadBalancer", apps) });
  }

  // On IaaS, rentals are cancelled pro rata, so on a quiet day drop the smallest server there's plenty of room without:
  // capacity to spare on its tier, cache hits beyond what's cacheable, or load balancers beyond the app servers.
  if (state.model === "iaas" && s === state) {
    const room: Record<ServerType, (units: number) => boolean> = {
      app: (n) => apps > 1 && units.cu.capacity - n >= units.cu.demand * 1.5,
      database: (n) => units.dbu.capacity - n >= units.dbu.demand * 1.5,
      cache: (n) => units.ch.capacity - n >= units.ch.demand && units.dbu.capacity >= (units.dbu.demand + n) * 1.5,
      loadBalancer: (n) => coverage - n >= apps,
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

/**
 * On PaaS: instances for planned demand, and the managed databases and caches that cover all the database demand
 * before any cache (see managedServicesFor): one database of the smallest size that does; past the biggest, caches and
 * then more databases. It adds what's missing before removing what's not needed, so it never runs out of databases.
 */
function scaleManaged(sim: Sim, state: GameState, strategy: Strategy): GameState {
  const managed = sim.managed(state);
  const platform = sim.config.models.paas.servers?.managed;
  const units = plannedUnits(sim, state, strategy);
  if (!managed || !platform || !units) return state;
  const instances = Math.min(managed.maxInstances, Math.max(1, Math.ceil(units.cu.demand / managed.instanceUnits)));
  let s = instances === managed.instances ? state : tryAction(sim, state, { type: "setInstances", count: instances });
  const target = managedServicesFor(platform, sim.config.servers.cacheableShare, units.dbu.beforeCache);
  for (const service of MANAGED_SERVICES) {
    const running = managed[service]?.running ?? [];
    const has = (size: ServerSize) => running.find((r) => r.size === size)?.count ?? 0;
    const wants = (size: ServerSize) => target.find((t) => t.type === service && t.size === size)?.count ?? 0;
    for (const size of SERVER_SIZES) {
      for (let i = has(size); i < wants(size); i++) s = tryAction(sim, s, { type: "addManagedService", service, size });
    }
    for (const size of SERVER_SIZES) {
      for (let i = wants(size); i < has(size); i++) s = tryAction(sim, s, { type: "removeManagedService", service, size });
    }
  }
  return s;
}

/**
 * Features: on SaaS buys every add-on on day 1; elsewhere the developers build the product's features one after
 * another, cheapest first.
 */
function buildFeatures(sim: Sim, state: GameState): GameState {
  const features = sim.features(state);
  if (state.model === "saas") {
    return features.filter((f) => f.status === "notStarted").reduce((s, f) => tryAction(sim, s, { type: "buyAddon", feature: f.id }), state);
  }
  if (features.some((f) => f.status === "building")) return state;
  const next = features.filter((f) => f.status === "notStarted").sort((a, b) => a.devDays - b.devDays)[0];
  return next ? tryAction(sim, state, { type: "buildFeature", feature: next.id }) : state;
}

/** What the bot does before each day: price, migration, servers, staff and features. */
export function playDay(sim: Sim, state: GameState, strategy: Strategy): GameState {
  let s = state;
  if (s.day === 1 && strategy.priceFactor !== 1) {
    s = tryAction(sim, s, { type: "setPrice", price: Math.round(sim.fairPrice(s) * strategy.priceFactor * 100) / 100 });
  }
  if (strategy.migrateDay !== undefined && s.day >= strategy.migrateDay && s.migrations === 0 && !s.migration) {
    // Only once the quote leaves a month of running costs in the bank.
    const quote = sim.migrationQuote(s, migrateTo[s.model]);
    const month = sim.dailyStaffCost(s) * 30 + sim.monthlyInfrastructureCost(s);
    if (s.cash > quote.total + month) s = tryAction(sim, s, { type: "startMigration", model: migrateTo[s.model] });
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
  s = staffTo(sim, s, "ops", Math.max(sim.opsNeededNow(s), eventOps));
  if (strategy.support) {
    // Enough to clear today's tickets with a little to spare, and a fifth of the backlog.
    const needed = Math.max(1, Math.ceil((sim.usualTickets(s) * 1.1 + s.backlog / 5) / sim.config.support.ticketsPerPerson));
    s = staffTo(sim, s, "support", needed);
  }
  return buildFeatures(sim, s);
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
  } catch (e) {
    if (e instanceof SimError && e.code === "cant_afford") {
      return { ...emptyResult(model, productType, strategy.id, seed), outcome: "cant-start" };
    }
    throw e;
  }
  let minCash = state.cash;
  let firstOverload: GameResult["firstOverload"] = null;
  let migrationDay: number | null = null;
  while (state.status === "playing") {
    state = playDay(sim, state, strategy);
    if (state.migration && migrationDay === null) migrationDay = state.day;
    const { state: next, log } = sim.advance(state);
    state = next;
    minCash = Math.min(minCash, state.cash);
    firstOverload ??= overloadIn(log);
  }
  const summary = sim.summarise(state);
  return {
    model,
    productType,
    strategy: strategy.id,
    seed,
    outcome: summary.ending === "bankrupt" ? "bankrupt" : "finished",
    day: summary.day,
    launchDay: state.launchDay,
    cash: summary.cash,
    minCash,
    income: summary.income,
    profit: summary.profit,
    peakUsers: summary.peak.users,
    peakPaid: summary.peak.paidUsers,
    users: summary.users,
    paidUsers: summary.paidUsers,
    satisfaction: summary.satisfaction,
    uptime: summary.uptime,
    outageDays: summary.outageDays,
    firstOverload,
    loanDay: summary.loan?.day ?? null,
    endModel: summary.model,
    migrationDay,
    spend: { ...summary.spend },
    staff: { developers: state.developers, ops: state.ops, support: state.support },
  };
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
    peakUsers: 0,
    peakPaid: 0,
    users: 0,
    paidUsers: 0,
    satisfaction: 0,
    uptime: 0,
    outageDays: 0,
    firstOverload: null,
    loanDay: null,
    endModel: model,
    migrationDay: null,
    spend: {},
    staff: { developers: 0, ops: 0, support: 0 },
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

/** "finished", "bankrupt d84" (median day), "2/5 bankrupt d70–d95", or "can't start". */
function outcome(games: GameResult[]): string {
  if (games.every((g) => g.outcome === "cant-start")) return "can't start";
  const bust = games.filter((g) => g.outcome === "bankrupt");
  if (!bust.length) return "finished";
  const days = bust.map((g) => g.day);
  const when = Math.min(...days) === Math.max(...days) ? `d${days[0]}` : `d${Math.min(...days)}–${Math.max(...days)}`;
  return bust.length === games.length ? `bankrupt ${when}` : `${bust.length}/${games.length} bankrupt ${when}`;
}

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

/** A row of the strategy tables. Money and users are medians across the seeds; satisfaction and uptime means. */
function row(cell: Cell): string[] {
  const g = cell.games.filter((x) => x.outcome !== "cant-start");
  if (!g.length) return [SHORT[cell.model], cell.productType, "can't start", "", "", "", "", "", "", "", "", "", ""];
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

/** A short marker for a model × product: the final cash, with "†" if any game went bankrupt. */
function cashMark(all: Cell[], strategy: string, model: ModelId, productType: ProductTypeId): string {
  const cell = all.find((c) => c.strategy === strategy && c.model === model && c.productType === productType);
  const p = cashOf(all, strategy, model, productType);
  if (p === null || !cell) return "can't start";
  return `${money(p)}${cell.games.some((g) => g.outcome === "bankrupt") ? " †" : ""}`;
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
  out.push("Money and users are medians across seeds; satisfaction and uptime are means. † = at least one seed went bankrupt.");
  out.push("Models are compared on final cash: profit counts loan repayments as costs, the amount borrowed included.", "");

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
      return `${v - base >= 0 ? "+" : ""}${money(v - base)}${cell.games.some((g) => g.outcome === "bankrupt") ? " †" : ""}`;
    })];
  }))), "");

  const head = ["Model", "Product", "Outcome", "Launch", "Final cash", "Lowest cash", "Profit", "Peak users", "Satisfaction", "Uptime", "Outage days", "First over capacity", "Loan"];
  for (const s of used) {
    out.push(`## Strategy: ${s.id}`, "", s.description, "");
    out.push(table(head, all.filter((c) => c.strategy === s.id).map(row)), "");
  }
  return out.join("\n");
}
