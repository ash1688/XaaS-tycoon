// The AI playtest interface: the game as compact text, for an AI to play through the sim without the web page. It
// renders the company, lists the commands that work right now, runs them, and advances time until something needs a
// decision. Every game writes the same rows as the classroom playtest log, so the same analysis runs on both.
// A tool for testing the game, not part of it. See play.ts for the command line.
import {
  gameLengthName,
  MANAGED_SERVICES,
  MODEL_IDS,
  RACK_SIZES,
  SERVER_SIZES,
  SERVER_TYPES,
  SimError,
  STAFF_GRADES,
  STAFF_POOLS,
  type Action,
  type DayLog,
  type FunderId,
  type GameState,
  type ManagedService,
  type ModelId,
  type RackSize,
  type ServerSize,
  type ServerType,
  type Sim,
  type StaffGrade,
  type StaffPool,
} from "../src/index.ts";

/** One row of the playtest log, as the staff dashboard exports it, so the classroom analysis runs on AI games too. */
export interface LogRow {
  at: string;
  player: string;
  preset: string;
  productType: string;
  kind: "game";
  type: string;
  ok: boolean;
  error: string | null;
  day: number;
  cash: number;
  paidUsers: number;
  freeUsers: number;
  dailyIncome: number;
  satisfaction: number;
  uptime: number;
  tier: string | null;
  tierUse: number | null;
  model: string;
  developers: number;
  ops: number;
  support: number;
  /** Moderators: 0 on a product without user content. */
  moderators: number;
  loan: string;
  loanRemaining: number | null;
  params: Record<string, unknown>;
}

/** Who is playing: the log's player column, and the playstyle written into each start row. */
export interface Player {
  player: string;
  playstyle?: string;
}

/** What each server type's units are, so they don't read as rack units (U). */
const UNIT: Record<ServerType, string> = { app: "CU", database: "DBU", cache: "CH", loadBalancer: "apps", api: "APIU" };

const money = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;
/** A price, to the penny when it has pence: £7.50, £5. */
const price = (n: number) => (Number.isInteger(n) ? money(n) : `£${n.toFixed(2)}`);
const pct = (n: number) => `${Math.round(n)}%`;
/** A share of the company, 0–1, to one decimal place of a percent. */
const stake = (share: number) => `${Math.round(share * 1000) / 10}%`;
/** A share price, which can be under a penny with many shares. */
const perShare = (n: number) => `£${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

/** The tier that runs out first, and how full it is: 999 with demand and no capacity, as the classroom log does. */
function tierUse(sim: Sim, state: GameState): { tier: string | null; use: number | null } {
  const units = sim.units(state);
  if (units) {
    const { demand, capacity } = units[units.binding];
    return { tier: units.binding, use: capacity > 0 ? Math.round((100 * demand) / capacity) : demand > 0 ? 999 : 0 };
  }
  const capacity = sim.capacity(state);
  return { tier: null, use: capacity ? Math.round((100 * state.load) / capacity) : null };
}

/**
 * What the company spends a day at today's numbers: staff, the model's bill, add-ons, the loan repayment and, on SaaS,
 * the provider's fee for the paid API's calls.
 */
export function dailyCosts(sim: Sim, state: GameState): number {
  const perMonth = sim.config.billing.daysPerMonth;
  const loan = sim.loan(state);
  const repayment = loan && loan.remaining > 0 ? loan.dailyRepayment : 0;
  const apiFee = sim.api(state)?.dailyFee ?? 0;
  return sim.dailyStaffCost(state) + (sim.monthlyInfrastructureCost(state) + sim.monthlyAddonCost(state)) / perMonth + repayment + apiFee;
}

/** What comes in a day at today's numbers: paying users, and the paid API's calls the APIU can serve. */
export function dailyIncome(sim: Sim, state: GameState): number {
  return sim.dailyIncome(state) + (sim.api(state)?.dailyIncome ?? 0);
}

/** Days of cash left at today's income and costs, or null while the company isn't losing money. */
export function runway(sim: Sim, state: GameState): number | null {
  const burn = dailyCosts(sim, state) - dailyIncome(sim, state);
  return burn > 0 ? Math.floor(Math.max(0, state.cash) / burn) : null;
}

export function logRow(sim: Sim, state: GameState, who: Player, type: string, params: Record<string, unknown>, error: string | null = null): LogRow {
  const { tier, use } = tierUse(sim, state);
  const loan = sim.loan(state);
  const heads = (pool: StaffPool) => sim.staff(state).find((p) => p.pool === pool)?.headcount ?? 0;
  return {
    at: new Date().toISOString(),
    player: who.player,
    preset: "Default",
    productType: state.productType,
    kind: "game",
    type,
    ok: error === null,
    error,
    day: state.day,
    cash: Math.round(state.cash),
    paidUsers: state.paidUsers,
    freeUsers: state.users - state.paidUsers,
    dailyIncome: Math.round(sim.dailyIncome(state)),
    satisfaction: Math.round(state.satisfaction),
    uptime: Math.round(sim.uptime(state) * 10) / 10,
    tier,
    tierUse: use,
    model: state.model,
    developers: heads("developers"),
    ops: heads("ops"),
    support: heads("support"),
    moderators: heads("moderators"),
    loan: !loan ? "none" : loan.remaining > 0 ? "repaying" : "repaid",
    loanRemaining: loan ? Math.round(loan.remaining) : null,
    params,
  };
}

/** Each customer type's share of users and price threshold, "!" where today's price is over it. */
export function renderMix(sim: Sim, state: GameState): string {
  return sim
    .customerMix(state)
    .types.map((t) => `${t.id} ${pct(100 * t.share)} (threshold ${price(t.threshold)}${t.overThreshold ? "!" : ""})`)
    .join(", ");
}

/** The company at a glance: everything a player sees on the dashboard, as short lines. */
export function renderStatus(sim: Sim, state: GameState): string {
  const lines: string[] = [];
  const fair = sim.fairPrice(state);
  const lock = sim.priceLockDaysLeft(state);
  const left = runway(sim, state);
  const daysToPlay = state.finalDay - state.day;
  const lasts = left === null ? "not losing money" : left > daysToPlay ? `lasts past day ${state.finalDay}` : `${left} days`;
  const status = state.endedByTeacher ? "ENDED BY TEACHER" : state.status.toUpperCase();
  lines.push(
    `== ${state.companyName} | ${state.productType} on ${state.model} | day ${state.day}/${state.finalDay} ` +
      `(${gameLengthName(sim.config, state.gameLength)}) | ${status}`,
  );
  lines.push(
    `cash ${money(state.cash)} | income ${money(dailyIncome(sim, state))}/day | costs ${money(dailyCosts(sim, state))}/day | runway ${lasts}`,
  );
  lines.push(`price ${price(state.price)}/month (fair ${price(fair)}) | ${lock > 0 ? `locked ${lock} more days` : "can change"}`);
  const wave = sim.priceWave(state);
  if (wave) {
    lines.push(
      `price wave: ${wave.direction} ${price(wave.from)}→${price(wave.to)}, ${wave.remaining} days left; so far ${wave.done.left} left, ${wave.done.toFree} to free, ${wave.done.joined} joined`,
    );
  }
  lines.push(`customer mix: ${renderMix(sim, state)}`);
  const conversion = sim.conversion(state);
  lines.push(
    `users ${state.users.toLocaleString("en-GB")} (paid ${state.paidUsers.toLocaleString("en-GB")}, free ${(state.users - state.paidUsers).toLocaleString("en-GB")}) | converting ${(conversion.rate * 100).toFixed(2)}%/day`,
  );
  lines.push(
    `satisfaction ${pct(state.satisfaction)} | uptime ${sim.uptime(state).toFixed(1)}% | tickets ${Math.round(sim.usualTickets(state))}/day vs ${Math.round(sim.dailyClearance(state))} cleared, backlog ${Math.round(state.backlog)}`,
  );
  const moderation = sim.moderation(state);
  if (moderation) {
    lines.push(
      `reports ${moderation.usualReports}/day | moderators can handle ${Math.round(moderation.dailyClearance)}/day (a mid ${sim.config.moderation.reportsPerPerson}), handled ${moderation.handledToday} yesterday | unhandled ${moderation.backlog}` +
        ` | satisfaction target ×${moderation.satisfactionFactor.toFixed(2)} | lawsuit odds ×${moderation.lawsuitOdds.toFixed(2)}`,
    );
  }
  lines.push(`power and cooling ${money(sim.powerAndCooling(state.model))}/day`);
  lines.push(...staffLines(sim, state));

  const launch = sim.launch(state);
  if (launch.status !== "launched") {
    lines.push(
      `launch: ${launch.status}${launch.daysLeft !== null ? `, ${launch.daysLeft} days to go` : ""}${launch.status === "waiting" && !launch.setUp ? " (set up servers first)" : ""}`,
    );
  }

  const units = sim.units(state);
  if (units) {
    const tier = (name: string, t: { demand: number; capacity: number }) =>
      `${name} ${Math.round(t.demand)}/${Math.round(t.capacity)}${t.capacity > 0 ? ` (${pct((100 * t.demand) / t.capacity)})` : ""}`;
    lines.push(`capacity: ${tier("CU", units.cu)} | ${tier("DBU", units.dbu)} | ${tier("CH", units.ch)} | runs out first: ${units.binding.toUpperCase()}`);
    if (units.loadBalancer.needed && units.loadBalancer.uncovered > 0) {
      lines.push(`  load balancers don't cover ${units.loadBalancer.uncovered} app servers: they add no capacity`);
    }
  } else if (state.model === "saas") {
    const provider = sim.provider(state);
    if (provider) lines.push(`capacity: the provider's (no limit) | per-user bill ${money(provider.monthlyCost)}/month`);
  }

  const managed = sim.managed(state);
  if (managed) {
    const svc = (name: string, v: typeof managed.database) =>
      v ? `${name} ${v.size} (${v.units} units)` : `${name} none`;
    const apiInstances = state.api ? ` | ${managed.apiInstances} API instances (${managed.apiInstanceUnits} APIU each)` : "";
    lines.push(
      `paas: ${managed.instances}/${managed.maxInstances} instances (${managed.instanceUnits} CU each)${apiInstances} | ${svc("database", managed.database)} | ${svc("cache", managed.cache)} | ${money(managed.monthlyCost)}/month`,
    );
  }
  const servers = sim.servers(state).filter(() => state.model !== "paas");
  if (servers.length) {
    lines.push(
      `servers: ${servers
        .map(
          (s) =>
            `#${s.id} ${s.size} ${s.type} ${s.units} ${s.apiu ? "APIU (switched)" : UNIT[s.type]}${s.rack !== null ? ` in rack #${s.rack}` : ""}${s.status === "pending" ? ` (arrives in ${s.daysLeft}d)` : ""}`,
        )
        .join(", ")}`,
    );
  }
  const racks = sim.racks(state);
  if (racks) {
    const list = racks.racks.map((r) => `#${r.id} ${r.size} ${r.used}/${r.units}U`).join(", ");
    lines.push(`racks: ${list || "none"} | ${racks.free}U free, most in one rack ${racks.mostFree}U`);
  }

  const api = sim.api(state);
  if (api && !api.owned) {
    lines.push(`api: ${api.name} not bought (${money(api.price)} once; about ${Math.round(api.pricePerCall * 100)}p a call)`);
  } else if (api) {
    const n = (x: number) => Math.round(x).toLocaleString("en-GB");
    const capacity = api.apiu
      ? `APIU ${api.apiu.demand}/${api.apiu.capacity}${api.apiu.capacity > 0 ? ` (${pct((100 * api.apiu.demand) / api.apiu.capacity)})` : ""}`
      : `the provider runs it at ${((api.feePerCall ?? 0) * 100).toFixed(2)}p a call`;
    lines.push(
      `api: ${api.name} ${n(api.calls)} calls/day (heading for ${n(api.target)}) | ${capacity} | yesterday ${n(api.served)} served, ${n(api.dropped)} dropped | earns ${money(api.dailyIncome)}/day${api.dailyFee ? `, fee ${money(api.dailyFee)}/day` : ""}${api.slowDaysLeft ? ` | slow growth ${api.slowDaysLeft} more days after an outage` : ""}`,
    );
  }

  const features = sim.features(state);
  lines.push(
    `features: ${features
      .map((f) => `${f.id} ${f.status === "notStarted" ? "not started" : f.status}${f.daysLeft ? ` (${f.daysLeft}d left)` : ""}`)
      .join(", ")}`,
  );

  const loan = sim.loan(state);
  if (loan?.remaining) {
    lines.push(
      `loan: ${money(loan.remaining)} left, ${money(loan.dailyRepayment)}/day for ${loan.daysLeft} more days (to day ${loan.lastDay}); paying off now costs ${money(loan.payoff)}, saving ${money(loan.interestSaved)} interest`,
    );
  } else if (loan) lines.push(`loan: repaid${loan.paidOffDay !== null ? ` early on day ${loan.paidOffDay}` : ""}`);
  const valuation = sim.valuation(state);
  const table = sim.capTable(state);
  lines.push(
    `valuation ${money(valuation.valuation)} | share price ${perShare(valuation.sharePrice)} | ${table.rows.map((r) => `${r.name.toLowerCase()} ${stake(r.share)}`).join(", ")} of ${table.sharesInIssue.toLocaleString("en-GB")} shares`,
  );
  lines.push(`funding: ${fundingStatus(sim, state)}`);
  const migration = sim.migration(state);
  if (migration) lines.push(`migration: ${migration.from}→${migration.to}, ${migration.phase}, ${migration.daysLeft} days left`);
  const danger = sim.danger(state);
  const risks = danger.risks.map((r) => `${r.label.toLowerCase()} +${r.rise}`).join(", ");
  lines.push(
    `danger meter: ${danger.meter} (no event waits past ${danger.max}) | rose ${danger.rise} today (well-run day +${danger.dailyRise}${risks ? `, ${risks}` : ""})`,
  );
  for (const r of danger.risks) lines.push(`  ${r.label}: ${r.detail}`);
  for (const e of sim.events(state)) lines.push(`event today: ${e.name}. ${e.outcome}`);
  for (const g of sim.featureGaps(state)) lines.push(`feature gap: ${g.name}. ${g.detail}`);
  return lines.join("\n");
}

/** Friends and family and the grant in a line: each one's offer, or how it stands. */
function fundingStatus(sim: Sim, state: GameState): string {
  const f = sim.funding(state);
  const ff = f.friendsAndFamilyOffer
    ? `offer ${money(f.friendsAndFamilyOffer.amount)} for ${stake(f.friendsAndFamilyOffer.theirShare)}`
    : f.friendsAndFamily!.status;
  const g = f.grant;
  const grant = f.grantOffer
    ? `offer ${money(f.grantOffer.amount)} if uptime ≥ ${f.grantOffer.minUptime}% for ${f.grantOffer.days} days`
    : g!.status === "accepted"
      ? g!.untilDay === null
        ? `${g!.maxHoursDown}h down allowed over ${g!.days} days, starting once the launch is over`
        : `${g!.hoursDown}h of ${g!.maxHoursDown}h down allowed used, ${state.day < g!.fromDay! ? `starting day ${g!.fromDay}, ` : ""}${g!.daysLeft} days left`
      : g!.status;
  return `friends and family ${ff} | grant ${grant}`;
}

/**
 * Staff by pool: headcount by grade, their work a day in mids (what's measured against ops needed, build days and
 * tickets), each grade's pay, and hires still to start.
 */
function staffLines(sim: Sim, state: GameState): string[] {
  const g = sim.config.staffGrades;
  const lines = [
    `staff: cost ${money(sim.dailyStaffCost(state))}/day | grades: ${STAFF_GRADES.map((grade) => `${grade} work ${g[grade].output}, starts ${g[grade].leadDays}d after hiring`).join("; ")}`,
  ];
  for (const p of sim.staff(state)) {
    const grades = p.grades.map((x) => `${x.count} ${x.grade}`).join(", ");
    const pay = p.grades.map((x) => money(x.dayRate)).join("/");
    const need = p.pool === "ops" ? `, need ${sim.opsNeededNow(state)}` : "";
    const hiring = p.hiring.length
      ? ` | hired, not started: ${p.hiring.map((h) => `${h.count} ${h.grade} on day ${h.arrivesOn} (${h.daysLeft}d)`).join(", ")}`
      : "";
    lines.push(`  ${p.pool} ${p.headcount} (${grades}) work ${p.output}${need} | pay junior/mid/senior ${pay}/day${hiring}`);
  }
  return lines;
}

/** Every command that does something right now, with the values it takes. */
export function renderCommands(sim: Sim, state: GameState): string {
  const lines = ["commands (join several with ';'):"];
  // Moderators only on a product with user content.
  const pools = sim.staff(state).map((p) => p.pool).join("|");
  const grades = STAFF_GRADES.join("|");
  lines.push(`  hire <${pools}> [${grades}] [n] | letgo <${pools}> [${grades}] [n] | move <to> [from] [${grades}]   (grade defaults to mid)`);
  if (sim.priceLockDaysLeft(state) === 0) lines.push(`  price <0.01–${sim.config.pricing.maxPrice}>`);
  lines.push(`  preview <price>   (what a price would do; changes nothing)`);
  const notStarted = sim.features(state).filter((f) => f.status === "notStarted");
  if (notStarted.length) {
    const verb = state.model === "saas" ? "addon" : "build";
    lines.push(
      `  ${verb} <${notStarted.map((f) => f.id).join("|")}>   ${notStarted
        .map((f) => (state.model === "saas" ? `${f.id} ${money(f.addonSetupFee)} + ${money(f.addonPricePerUser)}/user/month` : `${f.id} ${f.devDays} dev-days`))
        .join(", ")}`,
    );
  }
  const options = sim.serverOptions(state);
  const racks = sim.racks(state);
  if (options.length) {
    const verb = state.model === "onprem" ? "buy" : "rent";
    lines.push(`  ${verb} <${SERVER_TYPES.filter((t) => options.some((o) => o.type === t)).join("|")}> <${SERVER_SIZES.join("|")}>${racks ? " [rack id]   (goes in the first rack with room unless you pick one)" : ""}`);
    if (racks) {
      lines.push(
        `    rack space: ${SERVER_SIZES.map((size) => `${size} ${racks.serverUnits[size]}U`).join(", ")}; most free in one rack ${racks.mostFree}U` +
          `${options[0]!.cabling > 0 ? `; ${money(options[0]!.cabling)} cabling on each` : ""}`,
      );
    }
    for (const type of SERVER_TYPES) {
      const sizes = options.filter((o) => o.type === type);
      if (sizes.length) {
        lines.push(
          `    ${type}: ${sizes
            .map((o) => `${o.size} ${o.units} ${UNIT[o.type]} ${o.price !== null ? `${money(o.price)} once` : `${money(o.monthlyCost)}/month`}`)
            .join(", ")}`,
        );
      }
    }
    lines.push(`  ${state.model === "onprem" ? "sell" : "cancel"} <server id>`);
    if (state.api && sim.servers(state).some((s) => s.type === "app")) {
      lines.push(`  switch <app server id> <cu|apiu>   (an app server gives CU or APIU, as many of either)`);
    }
  }
  if (racks) {
    lines.push(
      `  rack <${RACK_SIZES.join("|")}>   ${racks.options.map((o) => `${o.size} ${o.units}U ${money(o.price)} + ${money(o.cabling)} cabling`).join(", ")}`,
    );
    if (racks.racks.some((r) => r.servers.length === 0)) lines.push(`  sellrack <rack id>   (empty racks only)`);
  }
  const managed = sim.managed(state);
  if (managed) {
    lines.push(`  instances <1–${managed.maxInstances}>   (${money(managed.instanceMonthlyCost)}/month each)`);
    lines.push(`  managed <${MANAGED_SERVICES.join("|")}> <${SERVER_SIZES.join("|")}|off>   (the cache can be off; the database can't)`);
    lines.push(
      `    database: ${managed.databaseOptions.map((o) => `${o.size} ${o.units} DBU ${money(o.monthlyCost)}/month`).join(", ")}`,
    );
    lines.push(`    cache: ${managed.cacheOptions.map((o) => `${o.size} ${o.units} CH ${money(o.monthlyCost)}/month`).join(", ")}`);
    if (state.api) {
      lines.push(
        `  apiinstances <0–${managed.maxInstances}>   (${managed.apiInstanceUnits} APIU, ${money(managed.apiInstanceMonthlyCost)}/month each)`,
      );
    }
  }
  const api = sim.api(state);
  if (api && !api.owned) {
    lines.push(`  buyapi   (${api.name}: ${money(api.price)} once; ${api.blurb})`);
  }
  if (!sim.migration(state)) lines.push(`  quote <${MODEL_IDS.filter((m) => m !== state.model).join("|")}> | migrate <model>`);
  const loanQuote = sim.loanQuote(state);
  if (loanQuote) {
    lines.push(
      `  loan   (${money(loanQuote.amount)} now at ${Math.round(loanQuote.rate * 1000) / 10}%, ${money(loanQuote.dailyRepayment)}/day for ${loanQuote.days} days, to day ${loanQuote.lastDay}: ${money(loanQuote.interest)} interest)`,
    );
  }
  lines.push(`  valuation   (what's pushing the valuation up or down, and who owns what; changes nothing)`);
  const funding = sim.funding(state);
  const open = [funding.friendsAndFamilyOffer && "ff", funding.grantOffer && "grant"].filter(Boolean).join("|");
  if (open) {
    lines.push(`  funding   (each open offer in full: what friends and family get, the grant's condition; changes nothing)`);
    lines.push(`  accept <${open}> | decline <${open}>   (each can be answered once; ff = friends and family)`);
  }
  const loan = sim.loan(state);
  if (loan?.remaining) lines.push(`  repayloan   (pay off the loan now: ${money(loan.payoff)}, saving ${money(loan.interestSaved)} interest)`);
  lines.push(`  next [days]   (advance up to that many days, default 7; stops early when something needs you)`);
  lines.push(`  end   (as the teacher: end the game now, scored as it stands)`);
  return lines.join("\n");
}

/** A command the player typed, read into a sim action, a read-only request, or an advance. */
export type Command =
  | { kind: "action"; action: Action; times: number }
  | { kind: "preview"; price: number }
  | { kind: "quote"; model: string }
  | { kind: "valuation" }
  | { kind: "funding" }
  | { kind: "next"; days: number }
  /** The teacher ends the game, as from the staff panel. */
  | { kind: "end" };

function oneOf<T extends string>(word: string | undefined, values: readonly T[], what: string): T {
  if (word && (values as readonly string[]).includes(word)) return word as T;
  throw new SimError("bad_command", `Expected ${what}: one of ${values.join(", ")}.`);
}

function number(word: string | undefined, what: string): number {
  const n = Number(word);
  if (word === undefined || !Number.isFinite(n)) throw new SimError("bad_command", `Expected ${what} as a number.`);
  return n;
}

function count(word: string | undefined): number {
  if (word === undefined) return 1;
  const n = number(word, "how many");
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new SimError("bad_command", "How many must be a whole number from 1 to 500.");
  return n;
}

/** Reads one command, such as "hire support 5" or "rent app medium". Throws a SimError explaining what's wrong. */
export function parseCommand(text: string): Command {
  const [verb, ...args] = text.trim().toLowerCase().split(/\s+/);
  const size = (w: string | undefined) => oneOf<ServerSize>(w, SERVER_SIZES, "a size");
  // Commands are lower-cased, so the server type is matched without case ("loadbalancer" is loadBalancer).
  const type = (w: string | undefined): ServerType => {
    const found = SERVER_TYPES.find((t) => t.toLowerCase() === w);
    if (!found) throw new SimError("bad_command", `Expected a server type: one of ${SERVER_TYPES.join(", ")}.`);
    return found;
  };
  const service = (w: string | undefined) => oneOf<ManagedService>(w, MANAGED_SERVICES, "a managed service");
  const pool = (w: string | undefined) => oneOf<StaffPool>(w, STAFF_POOLS, "a staff pool");
  // An optional grade before the count: "hire support junior 5", "hire support 5" (mids).
  const staffArgs = (rest: string[]): { grade?: StaffGrade; count: number } => {
    const grade = rest[0] !== undefined && /^[a-z]/.test(rest[0]) ? oneOf<StaffGrade>(rest[0], STAFF_GRADES, "a grade") : undefined;
    return { ...(grade ? { grade } : {}), count: count(grade ? rest[1] : rest[0]) };
  };
  const one = (action: Action): Command => ({ kind: "action", action, times: 1 });
  const funder = (w: string | undefined): FunderId => {
    if (w === "ff" || w === "friends" || w === "friendsandfamily") return "friendsAndFamily";
    if (w === "grant") return "grant";
    throw new SimError("bad_command", "Expected a funder: ff (friends and family) or grant.");
  };
  switch (verb) {
    case "hire":
      return one({ type: "hire", pool: pool(args[0]), ...staffArgs(args.slice(1)) });
    case "letgo":
      return one({ type: "letGo", pool: pool(args[0]), ...staffArgs(args.slice(1)) });
    case "move": {
      // "move ops", "move ops developers", "move ops developers senior".
      const grade = args[2] ? { grade: oneOf<StaffGrade>(args[2], STAFF_GRADES, "a grade") } : {};
      return one({ type: "moveStaff", to: pool(args[0]), ...(args[1] ? { from: pool(args[1]) } : {}), ...grade });
    }
    case "price":
      return one({ type: "setPrice", price: number(args[0], "a price") });
    case "preview":
      return { kind: "preview", price: number(args[0], "a price") };
    case "build":
      return one({ type: "buildFeature", feature: args[0] ?? "" });
    case "addon":
      return one({ type: "buyAddon", feature: args[0] ?? "" });
    case "buy":
      return one({
        type: "buyServer",
        server: type(args[0]),
        size: size(args[1]),
        ...(args[2] !== undefined && { rack: number(args[2], "a rack id") }),
      });
    case "rack":
      return one({ type: "buyRack", size: oneOf<RackSize>(args[0], RACK_SIZES, "a rack size") });
    case "sellrack":
      return one({ type: "sellRack", id: number(args[0], "a rack id") });
    case "rent":
      return one({ type: "rentServer", server: type(args[0]), size: size(args[1]) });
    case "sell":
      return one({ type: "sellServer", id: number(args[0], "a server id") });
    case "cancel":
      return one({ type: "cancelServer", id: number(args[0], "a server id") });
    case "instances":
      return one({ type: "setInstances", count: number(args[0], "an instance count") });
    case "managed":
      return one({ type: "setManagedService", service: service(args[0]), size: args[1] === "off" ? null : size(args[1]) });
    case "quote":
      return { kind: "quote", model: oneOf<ModelId>(args[0], MODEL_IDS, "a model") };
    case "migrate":
      return one({ type: "startMigration", model: oneOf<ModelId>(args[0], MODEL_IDS, "a model") });
    case "loan":
      return one({ type: "takeLoan" });
    case "valuation":
      return { kind: "valuation" };
    case "funding":
      return { kind: "funding" };
    case "accept":
      return one({ type: "acceptFunding", funder: funder(args[0]) });
    case "decline":
      return one({ type: "declineFunding", funder: funder(args[0]) });
    case "buyapi":
      return one({ type: "buyApi" });
    case "switch":
      return one({ type: "switchServer", id: number(args[0], "a server id"), gives: oneOf(args[1], ["cu", "apiu"] as const, "what it gives") });
    case "apiinstances":
      return one({ type: "setApiInstances", count: number(args[0], "an API instance count") });
    case "repayloan":
      return one({ type: "repayLoan" });
    case "next":
      return { kind: "next", days: args[0] === undefined ? 7 : count(args[0]) };
    case "end":
      return { kind: "end" };
    default:
      throw new SimError("bad_command", `Unknown command "${verb ?? ""}". Run "look" for the commands that work now.`);
  }
}

/** The log row parameters for an action, matching what the classroom server records. */
function actionParams(action: Action): Record<string, unknown> {
  const { type: _type, ...params } = action;
  return params;
}

export interface Turn {
  state: GameState;
  /** What happened, as lines to show the player. */
  lines: string[];
  rows: LogRow[];
}

/** Runs one parsed command that isn't an advance. A refused action is reported and logged, not thrown. */
export function runCommand(sim: Sim, state: GameState, command: Command, who: Player): Turn {
  if (command.kind === "preview") {
    const p = sim.pricePreview(state, command.price);
    return {
      state,
      rows: [],
      lines: [
        `preview ${price(p.currentPrice)}→${price(p.price)} (${p.direction}): income ${money(p.currentDailyIncome)}→${money(p.dailyIncome)}/day once settled; ` +
          `${p.total.left} paying users leave, ${p.total.toFree} drop to free, ${p.total.joined} join (${p.total.joinedPaid} paying)` +
          (p.direction === "rise"
            ? `; reaction ${(100 * p.reaction).toFixed(1)}% of payers = ` +
              p.reactions.map((t) => `${t.id} ${(100 * t.reaction).toFixed(1)}% × ${pct(100 * t.share)}`).join(" + ")
            : "") +
          (p.locked ? `; price locked ${p.lockDaysLeft} more days` : ""),
      ],
    };
  }
  if (command.kind === "quote") {
    const q = sim.migrationQuote(state, command.model);
    return {
      state,
      rows: [],
      lines: [
        `quote ${q.from}→${q.to}: ${q.days} days, ${money(q.total)} in all (upfront ${money(q.upfrontCost)}, double billing ${money(q.doubleBilling)}, ` +
          `exit ${money(q.exitPenalty)}, sell back ${money(q.sellBack)}); new setup ${money(q.setupMonthly)}/month, ops needed ${q.opsNeeded}` +
          (q.lostAddons.length ? `; loses add-ons: ${q.lostAddons.map((a) => a.name).join(", ")}` : "") +
          (q.warning ? `. Warning: ${q.warning}` : ""),
      ],
    };
  }
  if (command.kind === "valuation") return { state, rows: [], lines: valuationLines(sim, state) };
  if (command.kind === "funding") return { state, rows: [], lines: fundingLines(sim, state) };
  if (command.kind === "end") {
    const ended = sim.endGame(state);
    // Logged as the classroom server logs a game the teacher ends.
    const row = logRow(sim, ended, who, "end", { status: ended.status, endedBy: "teacher" });
    return { state: ended, rows: [row], lines: [`GAME OVER: ended by the teacher on day ${ended.day}`] };
  }
  if (command.kind !== "action") throw new Error("Advance with advanceUntil.");
  let current = state;
  const rows: LogRow[] = [];
  let done = 0;
  for (let i = 0; i < command.times; i++) {
    try {
      current = sim.applyAction(current, command.action);
      rows.push(logRow(sim, current, who, command.action.type, actionParams(command.action)));
      done++;
    } catch (err) {
      if (!(err instanceof SimError)) throw err;
      rows.push(logRow(sim, current, who, command.action.type, actionParams(command.action), err.code));
      const what = command.times > 1 ? `${command.action.type}: ${done} of ${command.times} done, then refused: ` : `${command.action.type} refused: `;
      return { state: current, rows, lines: [what + err.message + teamNow(sim, current, command.action, err)] };
    }
  }
  return { state: current, rows, lines: [`${command.action.type}${command.times > 1 ? ` ×${done}` : ""}: done`] };
}

/** After a refused letgo or move for want of staff, who the team has now, so the player can pick a grade they have. */
function teamNow(sim: Sim, state: GameState, action: Action, err: SimError): string {
  if (err.code !== "no_staff" || (action.type !== "letGo" && action.type !== "moveStaff")) return "";
  const pool = action.type === "letGo" ? action.pool : (action.from ?? (action.to === "developers" ? "ops" : "developers"));
  const team = sim.staff(state).find((p) => p.pool === pool);
  return team ? ` (${pool} now: ${team.grades.map((x) => `${x.count} ${x.grade}`).join(", ")})` : "";
}

/**
 * Runs a script of commands joined with ';', as a playtester's "do" does. Each command's result follows it. A command
 * that is refused, or never runs because time stopped or the game ended, says why, and the rest still say so.
 */
export function runScript(sim: Sim, state: GameState, script: string, who: Player): Turn {
  let current = state;
  const rows: LogRow[] = [];
  const lines: string[] = [];
  let skipped: string | null = null;
  for (const text of script.split(";").map((t) => t.trim()).filter(Boolean)) {
    if (skipped) {
      lines.push(`> ${text}`, `not run: ${skipped}`);
      continue;
    }
    try {
      const command = parseCommand(text);
      // Once the game is over, only what changes nothing still works: the valuation and who owns the company.
      if (current.status !== "playing" && command.kind !== "valuation" && command.kind !== "funding") {
        skipped = "the game is over";
        lines.push(`> ${text}`, `not run: ${skipped}`);
        continue;
      }
      const turn = command.kind === "next" ? advanceUntil(sim, current, command.days, who) : runCommand(sim, current, command, who);
      current = turn.state;
      rows.push(...turn.rows);
      lines.push(`> ${text}`, ...turn.lines);
      // An advance that stopped early leaves the rest of the script unplayed: the player should look first.
      if (command.kind === "next" && turn.lines.at(-1)?.startsWith("stopped")) skipped = `time stopped on day ${current.day}, so look first`;
      else if (current.status !== "playing") skipped = "the game is over";
    } catch (err) {
      if (!(err instanceof SimError)) throw err;
      lines.push(`> ${text}`, `refused: ${err.message}`);
    }
  }
  return { state: current, rows, lines };
}

/** The valuation's drivers, in pounds, and the cap table. */
function valuationLines(sim: Sim, state: GameState): string[] {
  const v = sim.valuation(state);
  const table = sim.capTable(state);
  const signed = (n: number) => `${n < 0 ? "−" : "+"}${money(Math.abs(n))}`;
  return [
    `valuation ${money(v.valuation)}: annual revenue ${money(v.annualRevenue)} × ${v.multiple}, plus paying users; share price ${perShare(v.sharePrice)}`,
    ...v.drivers.map((d) => `  ${d.label}: ${signed(d.amount)} (${d.detail})`),
    `cap table (${table.sharesInIssue.toLocaleString("en-GB")} shares):`,
    ...table.rows.map((r) => `  ${r.name}: ${r.shares.toLocaleString("en-GB")} shares, ${stake(r.share)}, worth ${money(r.value)}`),
  ];
}

/** Each funder's open offer in full, or how it was answered. */
function fundingLines(sim: Sim, state: GameState): string[] {
  const f = sim.funding(state);
  const lines: string[] = [];
  const ff = f.friendsAndFamilyOffer;
  if (ff) {
    lines.push(
      `friends and family (accept ff): ${money(ff.amount)} for ${ff.newShares.toLocaleString("en-GB")} new shares at ${perShare(ff.sharePrice)} (valuation ${money(ff.valuation)}). ` +
        `They'd own ${stake(ff.theirShare)}; you'd go from ${stake(ff.yourShareBefore)} to ${stake(ff.yourShareAfter)}. Paid now, no target.`,
    );
  } else {
    const t = f.friendsAndFamily!;
    lines.push(`friends and family: ${t.status} on day ${t.day}${t.status === "accepted" ? `, ${money(t.amount)} for ${t.shares.toLocaleString("en-GB")} shares` : ""}`);
  }
  const g = f.grantOffer;
  if (g) lines.push(`grant (accept grant): ${money(g.amount)}, no shares. ${g.condition} ${g.ifMissed}`);
  else {
    const t = f.grant!;
    lines.push(
      `grant: ${t.status === "declined" ? "declined" : "accepted"} on day ${t.day}` +
        (t.status === "met" ? `; condition met on day ${t.untilDay}` : "") +
        (t.status === "withdrawn" ? `; withdrawn, ${t.hoursDown}h down of ${t.maxHoursDown}h allowed` : "") +
        (t.status !== "accepted"
          ? ""
          : t.untilDay === null
            ? `; ${t.maxHoursDown}h down allowed over ${t.days} days, starting once the launch is over`
            : `; ${t.hoursDown}h down of ${t.maxHoursDown}h allowed, ${t.hoursLeft}h left, day ${t.fromDay} to day ${t.untilDay}`),
    );
  }
  return lines;
}

/**
 * Log entry kinds worth showing every day they appear. Feature, migration and API entries show only on days they stop
 * time.
 */
const SHOWN_KINDS = new Set(["outage", "event", "bankrupt", "finished", "support", "price", "launch", "staff", "funding", "danger"]);
const STOPPING_KINDS = new Set(["feature", "migration", "api"]);

const builtCount = (state: GameState) => Object.values(state.features).filter((f) => f.status !== "building").length;

/** Why the day just played needs a decision, if it does: compares the company before and after the day. */
function stopReasons(sim: Sim, before: GameState, after: GameState): string[] {
  const reasons: string[] = [];
  // Only events that need the player stop time: ones that hurt or found the company short of ops. A provider patch
  // with nothing to do is just shown. An event lasting several days stops on its first day only.
  const yesterday = new Set(sim.events(before).map((e) => e.id));
  const events = sim.events(after).filter((e) => (e.hit || e.shortOfOps) && !yesterday.has(e.id));
  if (events.length) reasons.push(`event: ${events.map((e) => e.name).join(", ")}`);
  if (after.outageDays > before.outageDays) reasons.push("outage");
  // A risk that's new today makes the danger meter climb faster: worth a decision before the next random event.
  const risksBefore = new Set(sim.danger(before).risks.map((r) => r.id));
  const newRisks = sim.danger(after).risks.filter((r) => !risksBefore.has(r.id));
  if (newRisks.length) reasons.push(`danger meter climbing faster: ${newRisks.map((r) => r.label.toLowerCase()).join(", ")}`);
  if (builtCount(after) > builtCount(before)) reasons.push("feature built");
  const launchBefore = sim.launch(before).status;
  const launchAfter = sim.launch(after).status;
  if (launchAfter !== launchBefore && (launchAfter === "launching" || launchAfter === "launched")) reasons.push(`launch ${launchAfter}`);
  const migBefore = sim.migration(before);
  const migAfter = sim.migration(after);
  if (migBefore && !migAfter) reasons.push("migration complete");
  else if (migBefore && migAfter && migAfter.phase !== migBefore.phase) reasons.push(`migration now ${migAfter.phase}`);
  const pending = (st: GameState) => sim.servers(st).filter((x) => x.status === "pending").length;
  if (pending(after) < pending(before)) reasons.push("server arrived");
  if (after.hiring.length < before.hiring.length) reasons.push("staff started");
  const { use } = tierUse(sim, after);
  const { use: useBefore } = tierUse(sim, before);
  if (use !== null && use > 100 && (useBefore === null || useBefore <= 100)) reasons.push(`capacity over 100% (${use}%)`);
  if (after.satisfaction <= before.satisfaction - 15 || (after.satisfaction < 50 && before.satisfaction >= 50)) {
    reasons.push(`satisfaction fell to ${pct(after.satisfaction)}`);
  }
  // Reports left unhandled long enough to cost satisfaction: the same point the game logs its warning.
  const warnAt = 1 - sim.config.moderation.warnShare;
  const factor = (st: GameState) => sim.moderation(st)?.satisfactionFactor ?? 1;
  if (factor(after) < warnAt && factor(before) >= warnAt) reasons.push(`reports unhandled (${after.reportBacklog})`);
  const left = runway(sim, after);
  const leftBefore = runway(sim, before);
  if (left !== null && left <= 7 && (leftBefore === null || leftBefore > 7)) reasons.push(`cash runs out in ${left} days`);
  if (sim.priceLockDaysLeft(before) > 0 && sim.priceLockDaysLeft(after) === 0) reasons.push("price can change again");
  const grantBefore = before.funding.grant?.status;
  const grantAfter = after.funding.grant?.status;
  if (grantBefore === "accepted" && grantAfter !== "accepted") reasons.push(`grant ${grantAfter}`);
  const dropped = (st: GameState) => st.api?.dropped ?? 0;
  if (dropped(after) > 0 && dropped(before) === 0) reasons.push(`API calls dropped (${dropped(after).toLocaleString("en-GB")})`);
  return reasons;
}

/**
 * Plays up to `days` days, one at a time, and stops early when something needs a decision: an event, outage, a new
 * risk on the danger meter, built feature, migration step, the launch, a server arriving, staff starting, capacity
 * running out, satisfaction falling hard, reports going unhandled, cash about to run out, the price unlocking, or API
 * calls starting to be dropped. Returns the notable lines of each day played and why it stopped.
 */
export function advanceUntil(sim: Sim, state: GameState, days: number, who: Player): Turn {
  let current = state;
  const lines: string[] = [];
  const rows: LogRow[] = [];
  let stop: string | null = null;
  for (let i = 0; i < days && current.status === "playing" && !stop; i++) {
    const before = current;
    const result = sim.advance(current, 1);
    current = result.state;
    rows.push(logRow(sim, current, who, "continue", { events: sim.events(current).map((e) => e.id) }));
    const reasons = stopReasons(sim, before, current);
    lines.push(...dayLines(result.log, reasons.length > 0));
    if (reasons.length) stop = `stopped on day ${current.day}: ${reasons.join("; ")}`;
  }
  if (current.status !== "playing") {
    rows.push(logRow(sim, current, who, "end", { status: current.status }));
    lines.push(`GAME OVER: ${current.status} on day ${current.day}`);
  } else {
    lines.push(stop ?? `advanced to day ${current.day}`);
  }
  const users = usersChange(state, current);
  if (users) lines.splice(lines.length - 1, 0, users);
  return { state: current, lines, rows };
}

/** How the users changed over the days just played, if they did: "users 1,200→1,150 (paid 300→250, free 900→900)". */
function usersChange(before: GameState, after: GameState): string | null {
  if (after.users === before.users && after.paidUsers === before.paidUsers) return null;
  const n = (x: number) => x.toLocaleString("en-GB");
  const free = (st: GameState) => st.users - st.paidUsers;
  return `  users ${n(before.users)}→${n(after.users)} (paid ${n(before.paidUsers)}→${n(after.paidUsers)}, free ${n(free(before))}→${n(free(after))})`;
}

/** The sim logs payers lost each day to a dear price, unhappy support or downtime with no kind: shown every day too. */
const shown = (e: DayLog["entries"][number], stopping: boolean) =>
  e.kind ? SHOWN_KINDS.has(e.kind) || (stopping && STOPPING_KINDS.has(e.kind)) : e.text.startsWith("Paying users lost");

/** The day's log, keeping the lines worth reading. On a day that stops time, feature and migration lines too. */
function dayLines(log: DayLog[], stopping: boolean): string[] {
  return log.flatMap(({ day, entries }) =>
    entries
      .filter((e) => shown(e, stopping))
      .map((e) => `  day ${day}: ${e.text}${e.cashDelta ? ` (${e.cashDelta > 0 ? "+" : ""}${money(e.cashDelta)})` : ""}`),
  );
}

/** The end-of-game summary as text: how it ended, final figures and where the money went. */
export function renderSummary(sim: Sim, state: GameState): string {
  // The day-by-day series are for charts; the player only needs the totals.
  const { days: _days, incomeVsCosts: _incomeVsCosts, ...summary } = sim.summarise(state);
  const yours = sim.capTable(state).rows.find((r) => r.id === "student")!;
  const valuation = { valuation: sim.valuation(state).valuation, yourShare: stake(yours.share), yourSharesWorth: yours.value };
  return JSON.stringify({ ...summary, ...valuation }, null, 1);
}
