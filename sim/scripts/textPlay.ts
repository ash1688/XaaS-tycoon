// The AI playtest interface: the game as compact text, for an AI to play through the sim without the web page. It
// renders the company, lists the commands that work right now, runs them, and advances time until something needs a
// decision. Every game writes the same rows as the classroom playtest log, so the same analysis runs on both.
// A tool for testing the game, not part of it. See play.ts for the command line.
import {
  DIFFICULTIES,
  gameLengthName,
  MANAGED_SERVICES,
  MODEL_IDS,
  percent,
  RACK_SIZES,
  SERVER_SIZES,
  SERVER_TYPES,
  SimError,
  STAFF_GRADES,
  STAFF_POOLS,
  type Action,
  type CounterOdds,
  type DayLog,
  type FeatureView,
  type FunderId,
  type GameDate,
  type GameState,
  type IpoResult,
  type NegotiationRound,
  type NegotiationView,
  type HolidayView,
  type ManagedService,
  type ModelId,
  type PauseReason,
  type RackSize,
  type ServerSize,
  type ServerType,
  type Sim,
  type StaffGrade,
  type StaffPool,
  type Terms,
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
const share = (n: number) => `${(100 * n).toFixed(1)}%`;
/** A share of the company, 0–1, to one decimal place of a percent. */
const stake = (share: number) => `${Math.round(share * 1000) / 10}%`;
/** A share price, which can be under a penny with many shares. */
const perShare = (n: number) => `£${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

/** An offer's terms in words: friends and family's cash for their share, the grant's cash for its condition's days. */
const termsText = (funder: FunderId, t: Terms) =>
  funder === "friendsAndFamily" ? `${money(t.amount!)} for ${stake(t.share!)}` : `${money(t.amount!)} for ${t.days} days of uptime`;

/** A roll in words: "rolled 15 −6 for asking 20% = 9: middle, they moved 50% of the way". */
const rollText = (r: NegotiationRound) =>
  `rolled ${r.die}${r.penalty ? ` −${r.penalty} for asking ${pct(r.ask * 100)}` : ""}${r.bonus ? ` +${r.bonus} bonus` : ""} = ${r.total < 0 ? `−${-r.total}` : r.total}: ${r.result}, they moved ${pct(r.move * 100)} of the way`;

/** Where a negotiation stands: offer 2 of 3, with a counter left, or the final offer. */
const standing = (n: NegotiationView) =>
  n.final ? "final offer" : `offer ${n.offers.length} of 3, ${n.countersLeft} counter${n.countersLeft === 1 ? "" : "s"} left`;

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
  const paymentsFee = sim.payments(state)?.usualDaySaasFee ?? 0;
  return (
    sim.dailyStaffCost(state) + (sim.monthlyInfrastructureCost(state) + sim.monthlyAddonCost(state)) / perMonth + repayment + apiFee + paymentsFee
  );
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

/**
 * Each customer type's share of users, to a tenth of a percent so a shift shows, and price threshold, "!" where today's
 * price is over it. On the payments app the thresholds are what a usual month costs a business, fee and transaction
 * fee together.
 */
export function renderMix(sim: Sim, state: GameState): string {
  const mix = sim.customerMix(state);
  const types = mix.types.map((t) => `${t.id} ${share(t.share)} (threshold ${price(t.threshold)}${t.overThreshold ? "!" : ""})`);
  return types.join(", ") + (mix.includesRate ? ` | thresholds are a usual month's cost: yours ${price(mix.price)}` : "");
}

/** The price line: "price £5/month (fair £5)", or on the payments app the fee and transaction fee together. */
function renderPrice(sim: Sim, state: GameState): string {
  const pay = sim.payments(state);
  if (!pay) return `price ${price(state.price)}/month (fair ${price(sim.fairPrice(state))})`;
  return (
    `price ${price(pay.fee)}/month + ${percent(pay.rate)} of payments = ${price(pay.monthly)} a usual month per business ` +
    `(fair ${price(pay.fairFee)} + ${percent(pay.fairRate)} = ${price(pay.fairMonthly)}; a business takes ${money(pay.volumePerPaidUser)} a month)`
  );
}

/** The payments app's two income streams and busy days. */
function renderPayments(sim: Sim, state: GameState): string | null {
  const pay = sim.payments(state);
  if (!pay) return null;
  const { busy, multiplier } = pay.nextDay;
  const tomorrow = busy ? `tomorrow is ${busy === "payday" ? "payday" : "Black Friday"}: payments x${multiplier}` : "tomorrow is a usual day";
  const when = (d: number | null) => (d === null ? "none" : d === pay.nextDay.day ? "tomorrow" : `day ${d}`);
  const saas = pay.usualDaySaasFee
    ? ` | SaaS platform's fee ${money(pay.usualDaySaasFee)}/day`
    : ` | on SaaS the platform would take ${percent(pay.saasFeeRate)} of every payment`;
  return (
    `payments: ${money(pay.usualDayPayments)} on a usual day -> fees ${money(pay.usualDayFees)} + transaction fees ${money(pay.usualDayTransactionFees)}/day${saas} | ` +
    `${tomorrow}; next payday ${when(pay.nextPayday)}, Black Friday ${when(pay.nextBlackFriday)} | so far fees ${money(pay.feeIncome)}, transaction fees ${money(pay.transactionIncome)}`
  );
}

/** Each customer type's share of today's new users, with what tilts it from the product's mix: features, price, rivals. */
export function renderNewUsers(sim: Sim, state: GameState): string {
  return sim
    .customerMix(state)
    .types.map((t) => {
      const why = [
        t.featureAppeal !== 1 ? `features x${+t.featureAppeal.toFixed(2)}` : "",
        t.priceFilter !== 1 ? `price x${+t.priceFilter.toFixed(2)}` : "",
        t.rivalPull !== 1 ? `rivals x${+t.rivalPull.toFixed(2)}` : "",
      ].filter(Boolean);
      return `${t.id} ${share(t.newShare)}${why.length ? ` (${why.join(", ")})` : ""}`;
    })
    .join(", ");
}

/** Who a feature appeals to: " [pulls professionals x1.5]". */
const appeal = (a: FeatureView["appeal"]) => {
  const parts = Object.entries(a ?? {}).map(([t, m]) => `${t} x${m}`);
  return parts.length ? ` [pulls ${parts.join(", ")}]` : "";
};

/**
 * The market in a line: each company's share of users, price and quality, what rivals do to growth, and when they'll
 * answer a price change. Null with no rivals.
 */
export function renderMarket(sim: Sim, state: GameState): string | null {
  const m = sim.market(state);
  if (m.companies.length < 2) return null;
  const companies = m.companies.map((c) => `${c.you ? "you" : c.name} ${pct(100 * c.share)} at ${price(c.price)} q${Math.round(c.quality)}`).join(", ");
  const answer = m.nextReaction ? ` | rivals answer your ${price(m.nextReaction.price)} on day ${m.nextReaction.day}` : "";
  return `market share: ${companies} | ${growthWords(m.growth)}${answer}`;
}

/** What rivals do to growth, in words: "rivals slow your growth to 84%". */
const growthWords = (growth: number) =>
  `rivals ${growth < 0.995 ? "slow" : growth > 1.005 ? "speed up" : "leave"} your growth ${growth < 0.995 || growth > 1.005 ? "to" : "at"} ${pct(100 * growth)}`;

/** The market in full: each company, and how each customer type's new users split today. */
function marketLines(sim: Sim, state: GameState): string[] {
  const m = sim.market(state);
  if (m.companies.length < 2) return ["no rivals in this market"];
  const names = m.companies.map((c) => (c.you ? "you" : c.name));
  return [
    `market (rivals answer a price change ${m.reactionDays} days later, sometimes undercutting it; quality is 0–100 from features and uptime):`,
    ...m.companies.map(
      (c) =>
        `  ${c.you ? `you (${c.name})` : c.name}: ${c.users.toLocaleString("en-GB")} users, ${stake(c.share)} share | ${price(c.price)}/month | quality ${c.quality} (${c.features} features, ${c.uptime}% uptime)${c.blurb ? ` | ${c.blurb}` : ""}`,
    ),
    `new users by customer type (best value wins most):`,
    ...m.byType.map((t) => `  ${t.id}: ${t.shares.map((sh, i) => `${names[i]} ${pct(100 * sh)}`).join(", ")} | best: ${t.bestId === "you" ? "you" : t.bestName}`),
    `${growthWords(m.growth)} (100% when you're as good a deal as them)` +
      (m.nextReaction ? `; they answer your ${price(m.nextReaction.price)} on day ${m.nextReaction.day}` : ""),
  ];
}

/** The company at a glance: everything a player sees on the dashboard, as short lines. */
export function renderStatus(sim: Sim, state: GameState): string {
  const lines: string[] = [];
  const lock = sim.priceLockDaysLeft(state);
  const left = runway(sim, state);
  const daysToPlay = state.finalDay === null ? Infinity : state.finalDay - state.day;
  const lasts = left === null ? "not losing money" : left > daysToPlay ? `lasts past day ${state.finalDay}` : `${left} days`;
  const status = state.ipo.result ? "FLOATED" : state.endedByTeacher ? "ENDED BY TEACHER" : state.status.toUpperCase();
  const calendar = sim.calendar(state);
  lines.push(
    `== ${state.companyName} | ${state.productType} on ${state.model} | day ${state.day}${state.finalDay === null ? "" : `/${state.finalDay}`} ` +
      `(${gameLengthName(sim.config, state.gameLength)}, ${DIFFICULTIES[state.difficulty].name}${sim.tickDays(state) === 7 ? ", a week a tick" : ""}) | ${calendar.today.text} | ${status}`,
  );
  lines.push(
    `cash ${money(state.cash)} | income ${money(dailyIncome(sim, state))}/day | costs ${money(dailyCosts(sim, state))}/day | runway ${lasts}`,
  );
  lines.push(`${renderPrice(sim, state)} | ${lock > 0 ? `locked ${lock} more days` : "can change"}`);
  const payments = renderPayments(sim, state);
  if (payments) lines.push(payments);
  const wave = sim.priceWave(state);
  if (wave) {
    const withRate = (p: number, r?: number) => (r === undefined ? price(p) : `${price(p)} + ${percent(r)}`);
    lines.push(
      `price wave: ${wave.direction} ${withRate(wave.from, wave.fromRate)}→${withRate(wave.to, wave.toRate)}, ${wave.remaining} days left; so far ${wave.done.left} left, ${wave.done.toFree} to free, ${wave.done.joined} joined`,
    );
  }
  lines.push(`customer mix: ${renderMix(sim, state)}`);
  lines.push(`new users join as: ${renderNewUsers(sim, state)}`);
  const market = renderMarket(sim, state);
  if (market) lines.push(market);
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
      .map((f) => `${f.id} ${f.status === "notStarted" ? "not started" : f.status}${f.daysLeft ? ` (${f.daysLeft}d left)` : ""}${appeal(f.appeal)}`)
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
    `${state.ipo.result ? `market value ${money(state.ipo.result.marketValue)} at the first day's close` : `valuation ${money(valuation.valuation)}`} | share price ${perShare(table.sharePrice)} | ${table.rows.map((r) => `${r.name.toLowerCase()} ${stake(r.share)}`).join(", ")} of ${table.sharesInIssue.toLocaleString("en-GB")} shares`,
  );
  lines.push(`funding: ${fundingStatus(sim, state)}`);
  lines.push(`ipo: ${ipoStatus(sim, state)}`);
  const rescue = rescueStatus(sim, state);
  if (rescue) lines.push(`rescue: ${rescue}`);
  const migration = sim.migration(state);
  if (migration) lines.push(`migration: ${migration.from}→${migration.to}, ${migration.phase}, ${migration.daysLeft} days left`);
  const danger = sim.danger(state);
  const risks = danger.risks.map((r) => `${r.label.toLowerCase()} +${r.rise}`).join(", ");
  lines.push(
    `danger meter: ${danger.meter} (no event waits past ${danger.max}) | rose ${danger.rise} today (well-run day +${danger.dailyRise}${risks ? `, ${risks}` : ""})`,
  );
  for (const r of danger.risks) lines.push(`  ${r.label}: ${r.detail}`);
  lines.push(`calendar: ${calendarLine(sim, state)}`);
  for (const e of sim.events(state)) lines.push(`event today: ${e.name}. ${e.responsibility} ${e.outcome}`);
  for (const g of sim.featureGaps(state)) lines.push(`feature gap: ${g.name}. ${g.detail}`);
  return lines.join("\n");
}

/** The IPO in a line: how many readiness conditions are met and what's next. */
function ipoStatus(sim: Sim, state: GameState): string {
  const ipo = sim.ipo(state);
  const met = ipo.conditions.filter((x) => x.met).length;
  const todo = ipo.conditions.filter((x) => !x.met).map((x) => x.label.toLowerCase());
  switch (ipo.status) {
    case "floated": {
      const r = ipo.result!;
      return `floated ${stake(r.float)} on day ${r.day}: raised ${money(r.cashRaised)}, closed at ${perShare(r.closePrice)} (offer ${perShare(r.offerPrice)}), market value ${money(r.marketValue)}; you own ${stake(r.studentShare)}, worth ${money(r.studentValue)}`;
    }
    case "approved":
      return `APPROVED on day ${ipo.approvedDay}: pick a float and ring the bell ("ipo" for the offer)`;
    case "cold":
      return `cold market: can apply again on day ${ipo.retryDay} | ${met}/${ipo.conditions.length} conditions met`;
    case "ready":
      return `READY: all ${met} conditions met, comfort ${Math.round(ipo.comfort * 100)}% ("apply" to float)`;
    default:
      return `${met}/${ipo.conditions.length} readiness conditions met; still to meet: ${todo.join(", ")}`;
  }
}

/** Once approved, the offer and what a float every 5% would do. */
function offerLines(sim: Sim, state: GameState): string[] {
  const o = sim.ipo(state).offer;
  if (!o) return [];
  return [
    `offer: valuation ${money(o.valuation)}, ${o.sharesInIssue.toLocaleString("en-GB")} shares at ${perShare(o.offerPrice)}; you own ${stake(o.studentShare)}. Float ${stake(o.minFloat)}–${stake(o.maxFloat)} ("ring <percent>"):`,
    ...o.floats
      .filter((_, i) => i % 5 === 0 || i === o.floats.length - 1)
      .map(
        (f) =>
          `  ${stake(f.float)}: ${f.newShares.toLocaleString("en-GB")} new shares, raises ${money(f.cashRaised)}, you'd own ${stake(f.studentShareAfter)}, first day swings about ±${Math.round(f.swing * 100)}%`,
      ),
  ];
}

/** The readiness checklist in full, the offer once approved, and the first day of trading once floated. */
function ipoLines(sim: Sim, state: GameState): string[] {
  const ipo = sim.ipo(state);
  const lines = [
    `ipo: ${ipoStatus(sim, state)}`,
    `readiness (comfort ${Math.round(ipo.comfort * 100)}%: the more comfortably ready, the less chance of a cold market):`,
  ];
  for (const x of ipo.conditions) {
    lines.push(`  [${x.met ? "x" : " "}] ${x.label}: ${x.now}. Needs ${x.needed}.${x.met ? ` Comfort ${Math.round(x.comfort * 100)}%.` : ""}`);
  }
  if (ipo.refusal && ipo.status !== "approved" && ipo.status !== "floated") lines.push(`apply: ${ipo.refusal}`);
  for (const a of ipo.applications) lines.push(`  applied day ${a.day}: ${a.cold ? "cold market, postponed" : "approved"}`);
  lines.push(...offerLines(sim, state));
  if (ipo.result) lines.push(...bellLines(ipo.result));
  return lines;
}

/** The opening bell: the first day of trading, half-hour by half-hour, and how it ended. */
function bellLines(r: IpoResult): string[] {
  const time = (i: number) => {
    const minutes = 9 * 60 + 30 + i * 30;
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  };
  const change = r.closePrice / r.offerPrice - 1;
  return [
    `opening bell! floated ${stake(r.float)}: ${r.newShares.toLocaleString("en-GB")} new shares at ${perShare(r.offerPrice)} raised ${money(r.cashRaised)}`,
    `first day: ${r.prices.map((p, i) => `${time(i)} ${perShare(p)}`).join(", ")}`,
    `close ${perShare(r.closePrice)} (${change >= 0 ? "+" : "−"}${pct(Math.abs(change) * 100)} on the offer) | market value ${money(r.marketValue)} (cash raised included) | you own ${stake(r.studentShare)}, worth ${money(r.studentValue)}`,
    ...r.reasons.map((x) => `  ${x}`),
  ];
}

/** What a holiday does to the product: "load ×2.2, growth ×2.5", or "no effect on you". */
const holidayEffect = (h: HolidayView) =>
  h.effect ? `load ×${h.effect.loadMultiplier}, growth ×${h.effect.growthMultiplier}` : "no effect on you";

/** "2 Dec 2026". */
const shortDate = (h: GameDate) => `${h.dayOfMonth} ${h.text.split(" ")[2]!.slice(0, 3)} ${h.year}`;

/** The holidays on now and the next one to come, in a line. */
function calendarLine(sim: Sim, state: GameState): string {
  const { on, upcoming } = sim.calendar(state);
  // A holiday the product doesn't notice is left to the full calendar.
  const now = on.filter((h) => h.effect).map((h) => `${h.name} on now to day ${h.endDay} (${holidayEffect(h)})`);
  const next = upcoming[0];
  const parts = [...now, next ? `next: ${next.name} in ${next.daysUntil} days, day ${next.startDay} (${holidayEffect(next)})` : "no more holidays this game"];
  return `${parts.join(" | ")}   ("calendar" for all)`;
}

/** Every holiday to come in the game, with its dates and what it does to the product. */
function calendarLines(sim: Sim, state: GameState): string[] {
  const { today, startYear, on, upcoming } = sim.calendar(state);
  const line = (h: HolidayView) =>
    `  ${h.name}: ${h.daysUntil > 0 ? `in ${h.daysUntil} days, ` : ""}${shortDate(h.start)}–${shortDate(h.end)} (days ${h.startDay}–${h.endDay}), ${holidayEffect(h)}${h.effect ? `. ${h.effect.detail}` : ""}`;
  return [
    `calendar: ${today.text}, year ${today.year - startYear + 1} of the game (started ${startYear})`,
    ...(on.length ? ["on now:", ...on.map(line)] : []),
    upcoming.length ? "coming up:" : "no more holidays before the game ends",
    ...upcoming.map(line),
  ];
}

/** Friends and family and the grant in a line: each one's offer, or how it stands. */
function fundingStatus(sim: Sim, state: GameState): string {
  const f = sim.funding(state);
  const n = f.negotiations;
  const ff = f.friendsAndFamilyOffer
    ? `${standing(n.friendsAndFamily!)} ${money(f.friendsAndFamilyOffer.amount)} for ${stake(f.friendsAndFamilyOffer.theirShare)}`
    : f.friendsAndFamily!.status;
  const g = f.grant;
  const grant = f.grantOffer
    ? `${standing(n.grant!)} ${money(f.grantOffer.amount)} if uptime ≥ ${f.grantOffer.minUptime}% for ${f.grantOffer.days} days`
    : g!.status === "accepted"
      ? g!.untilDay === null
        ? `${g!.maxHoursDown}h down allowed over ${g!.days} days, starting once the launch is over`
        : `${g!.hoursDown}h of ${g!.maxHoursDown}h down allowed used, ${state.day < g!.fromDay! ? `starting day ${g!.fromDay}, ` : ""}${g!.daysLeft} days left`
      : g!.status;
  return `friends and family ${ff} | grant ${grant}`;
}

/** The rescue buyout in a line, once it has happened: what the vulture VC put in and took, and its buy-back price. */
function rescueStatus(sim: Sim, state: GameState): string | null {
  const r = sim.rescue(state);
  if (!r) return null;
  const terms = `day ${r.day}, a vulture VC put in ${money(r.amount)} for ${stake(r.share)}`;
  if (r.boughtBack) return `${terms}; you bought it back on day ${r.boughtBack.day} for ${money(r.boughtBack.price)}`;
  if (r.buyBackPrice === null) return `${terms}; it owns ${stake(r.vultureShare)}`;
  return `${terms}; it owns ${stake(r.vultureShare)} and sells it back for ${money(r.buyBackPrice)}${r.canBuyBack ? "" : " (more than your cash)"}. Run out of cash again and it's liquidation`;
}

/** The rescue buyout in full: the cash, the share taken, the cuts, and the buy-back. */
function rescueLines(sim: Sim, state: GameState): string[] {
  const r = sim.rescue(state);
  if (!r) return ["no rescue yet: the first time cash runs out, a vulture VC rescues the company; the second time is liquidation"];
  const cuts = [
    ...r.cuts.map((c) => `${c.count} ${c.agency ? "agency " : ""}${c.grade} ${c.pool}`),
    ...(r.hiresCancelled ? [`${r.hiresCancelled} hires cancelled`] : []),
  ];
  return [
    `rescue on day ${r.day}: a vulture VC put in ${money(r.amount)} (${money(r.losses)} of losses${r.severance ? `, ${money(r.severance)} of severance` : ""}, the rest breathing space) for ${r.shares.toLocaleString("en-GB")} new shares, ${stake(r.share)} of the company`,
    `forced cuts: ${cuts.length ? cuts.join(", ") : "none"}${r.savedPerDay ? `, saving ${money(r.savedPerDay)}/day` : ""}${r.severance ? `, paying ${money(r.severance)} severance` : ""}`,
    r.boughtBack
      ? `bought back on day ${r.boughtBack.day} for ${money(r.boughtBack.price)}`
      : r.buyBackPrice === null
        ? `the vulture VC owns ${stake(r.vultureShare)}`
        : `buy-back (buyback): ${money(r.buyBackPrice)} for its ${r.vultureShares.toLocaleString("en-GB")} shares (${stake(r.vultureShare)}), paid from company cash: ${r.priceDetail}. ${r.canBuyBack ? "You can afford it." : `You have ${money(state.cash)}.`}`,
  ];
}

/**
 * Staff by pool: permanent headcount by grade, any agency staff apart, everyone's work a day in mids (what's measured
 * against ops needed, build days and tickets), each grade's pay and severance, agency pay, and hires still to start.
 */
function staffLines(sim: Sim, state: GameState): string[] {
  const g = sim.config.staffGrades;
  const a = sim.config.agency;
  const lines = [
    `staff: cost ${money(sim.dailyStaffCost(state))}/day | grades: ${STAFF_GRADES.map((grade) => `${grade} work ${g[grade].output}, starts ${g[grade].leadDays}d after hiring`).join("; ")}`,
    `  agency staff: ${a.payMultiplier}x the pay and ${a.output}x the work of the same grade, start ${a.leadDays}d after hiring, ` +
      `no severance | letting go permanent staff pays ${sim.config.severance.days} days' pay each in severance, at once`,
  ];
  for (const p of sim.staff(state)) {
    const grades = p.grades.map((x) => `${x.count} ${x.grade}`).join(", ");
    const agency = p.agencyCount
      ? ` + agency ${p.agencyCount} (${p.agency.filter((x) => x.count).map((x) => `${x.count} ${x.grade}`).join(", ")})`
      : "";
    const pay = p.grades.map((x) => money(x.dayRate)).join("/");
    const agencyPay = p.agency.map((x) => money(x.dayRate)).join("/");
    const severance = p.grades.map((x) => money(x.severance)).join("/");
    const need = p.pool === "ops" ? `, need ${sim.opsNeededNow(state)}` : "";
    const hiring = p.hiring.length
      ? ` | hired, not started: ${p.hiring.map((h) => `${h.count} ${h.agency ? "agency " : ""}${h.grade} on day ${h.arrivesOn} (${h.daysLeft}d)`).join(", ")}`
      : "";
    lines.push(
      `  ${p.pool} ${p.headcount} (${grades})${agency} work ${p.output}${need} | pay junior/mid/senior ${pay}/day, ` +
        `agency ${agencyPay}/day | severance ${severance} each${hiring}`,
    );
  }
  return lines;
}

/** Every command that does something right now, with the values it takes. */
export function renderCommands(sim: Sim, state: GameState): string {
  const lines = ["commands (join several with ';'):"];
  // Moderators only on a product with user content.
  const pools = sim.staff(state).map((p) => p.pool).join("|");
  const grades = STAFF_GRADES.join("|");
  lines.push(
    `  hire <${pools}> [agency] [${grades}] [n] | letgo <${pools}> [agency] [${grades}] [n] | move <to> [from] [${grades}]   ` +
      `(grade defaults to mid; permanent staff unless "agency"; move is permanent staff only)`,
  );
  const pay = sim.payments(state);
  if (pay) {
    const both = `<fee 0–${sim.config.pricing.maxPrice}> [transaction fee 0–${percent(pay.maxRate)}, e.g. 2.5%]`;
    if (sim.priceLockDaysLeft(state) === 0) lines.push(`  price ${both}   (one change sets both; the fee alone keeps today's rate)`);
    lines.push(`  preview ${both}   (what they would do; changes nothing)`);
  } else {
    if (sim.priceLockDaysLeft(state) === 0) lines.push(`  price <0.01–${sim.config.pricing.maxPrice}>`);
    lines.push(`  preview <price>   (what a price would do; changes nothing)`);
  }
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
  lines.push(`  market   (rivals' prices, quality and share, and who wins each customer type; changes nothing)`);
  lines.push(`  valuation   (what's pushing the valuation up or down, and who owns what; changes nothing)`);
  const funding = sim.funding(state);
  const open = [funding.friendsAndFamilyOffer && "ff", funding.grantOffer && "grant"].filter(Boolean).join("|");
  if (open) {
    lines.push(`  funding   (each open offer in full: what friends and family get, the grant's condition; changes nothing)`);
    lines.push(`  accept <${open}> | decline <${open}>   (each can be answered once; ff = friends and family)`);
    const countering = [funding.negotiations.friendsAndFamily?.countersLeft && "ff", funding.negotiations.grant?.countersLeft && "grant"];
    const max = pct(sim.config.negotiation.maxAsk * 100);
    if (countering[0]) {
      lines.push(`  counter ff [amount <£>] [share <%>]   (ask for more cash and/or a smaller share for them; up to ${max} better in all; a dice roll sets their next offer, the third is final)`);
    }
    if (countering[1]) lines.push(`  counter grant [amount <£>] [days <n>]   (ask for more cash and/or fewer days of the uptime condition, the same way)`);
    const odds = countering.filter(Boolean).join("|");
    if (odds) lines.push(`  odds <${odds}> ...   (the same terms as counter: the odds on the roll and each offer it could bring; changes nothing)`);
  }
  const rescue = sim.rescue(state);
  if (rescue) lines.push(`  rescue   (the rescue buyout in full: cash, share taken, cuts, the buy-back price; changes nothing)`);
  if (rescue?.buyBackPrice) {
    lines.push(`  buyback   (buy all the vulture VC's shares back from company cash: ${money(rescue.buyBackPrice)}${rescue.canBuyBack ? "" : ", more than your cash"})`);
  }
  const ipo = sim.ipo(state);
  lines.push(`  ipo   (the IPO readiness checklist in full, and once approved the offer; changes nothing)`);
  if (ipo.canApply) lines.push(`  apply   (apply to float: a small hidden chance of a cold market, less the more comfortably ready you are)`);
  if (ipo.offer) {
    const range = `${Math.round(ipo.offer.minFloat * 100)}-${Math.round(ipo.offer.maxFloat * 100)}`;
    lines.push(`  ring <${range}>   (float that % of the company in new shares and ring the opening bell: ENDS THE GAME)`);
  }
  const loan = sim.loan(state);
  if (loan?.remaining) lines.push(`  repayloan   (pay off the loan now: ${money(loan.payoff)}, saving ${money(loan.interestSaved)} interest)`);
  lines.push(`  calendar   (the holidays to come, their dates and what each does to your product)`);
  const tick = sim.tickDays(state) === 7 ? "a week (this is a career)" : "a day";
  lines.push(
    `  next [days]   (play ticks of ${tick} until that many days have gone by, default 7; stops early, on the day, when something needs you)`,
  );
  lines.push(`  end   (as the teacher: end the game now, scored as it stands)`);
  return lines.join("\n");
}

/** A command the player typed, read into a sim action, a read-only request, or an advance. */
export type Command =
  | { kind: "action"; action: Action; times: number }
  | { kind: "preview"; price: number; rate?: number }
  | { kind: "quote"; model: string }
  | { kind: "valuation" }
  | { kind: "market" }
  | { kind: "funding" }
  | { kind: "ipo" }
  | { kind: "odds"; funder: FunderId; terms: Partial<Terms> }
  | { kind: "rescue" }
  | { kind: "calendar" }
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

/** An optional transaction fee as a percentage, "2.5%" or "2.5", as a share (0.025). */
function rateArg(word: string | undefined): { rate?: number } {
  if (word === undefined) return {};
  return { rate: number(word.replace(/%$/, ""), "a transaction fee in %") / 100 };
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
  // Optional "agency", then an optional grade, before the count: "hire support junior 5", "hire support 5" (mids),
  // "hire support agency 2", "letgo ops agency senior".
  const staffArgs = (words: string[]): { grade?: StaffGrade; count: number; agency?: true } => {
    const agency = words[0] === "agency";
    const rest = agency ? words.slice(1) : words;
    const grade = rest[0] !== undefined && /^[a-z]/.test(rest[0]) ? oneOf<StaffGrade>(rest[0], STAFF_GRADES, "a grade") : undefined;
    return { ...(agency ? { agency } : {}), ...(grade ? { grade } : {}), count: count(grade ? rest[1] : rest[0]) };
  };
  const one = (action: Action): Command => ({ kind: "action", action, times: 1 });
  const funder = (w: string | undefined): FunderId => {
    if (w === "ff" || w === "friends" || w === "friendsandfamily") return "friendsAndFamily";
    if (w === "grant") return "grant";
    throw new SimError("bad_command", "Expected a funder: ff (friends and family) or grant.");
  };
  // "amount 18000 share 18", in any order: a share is a percent; days are whole days.
  const terms = (rest: string[]): Partial<Terms> => {
    const out: Partial<Terms> = {};
    for (let i = 0; i < rest.length; i += 2) {
      const key = oneOf(rest[i], ["amount", "share", "days"] as const, "a term");
      const value = number(rest[i + 1]?.replace(/[£%,]/g, ""), `the ${key}`);
      out[key] = key === "share" ? value / 100 : value;
    }
    return out;
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
      return one({ type: "setPrice", price: number(args[0], "a price"), ...rateArg(args[1]) });
    case "preview":
      return { kind: "preview", price: number(args[0], "a price"), ...rateArg(args[1]) };
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
    case "market":
      return { kind: "market" };
    case "funding":
      return { kind: "funding" };
    case "calendar":
      return { kind: "calendar" };
    case "accept":
      return one({ type: "acceptFunding", funder: funder(args[0]) });
    case "decline":
      return one({ type: "declineFunding", funder: funder(args[0]) });
    case "ipo":
      return { kind: "ipo" };
    case "apply":
      return one({ type: "applyForIpo" });
    case "ring":
      return one({ type: "ringBell", float: number(args[0], "a float percentage, 15 to 40") / 100 });
    case "counter":
      return one({ type: "counterFunding", funder: funder(args[0]), terms: terms(args.slice(1)) });
    case "odds":
      return { kind: "odds", funder: funder(args[0]), terms: terms(args.slice(1)) };
    case "buyapi":
      return one({ type: "buyApi" });
    case "switch":
      return one({ type: "switchServer", id: number(args[0], "a server id"), gives: oneOf(args[1], ["cu", "apiu"] as const, "what it gives") });
    case "apiinstances":
      return one({ type: "setApiInstances", count: number(args[0], "an API instance count") });
    case "repayloan":
      return one({ type: "repayLoan" });
    case "rescue":
      return { kind: "rescue" };
    case "buyback":
      return one({ type: "buyBack" });
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
    const p = sim.pricePreview(state, command.price, command.rate);
    const label = (fee: number, r: number | null, m: number) => (r === null ? price(fee) : `${price(fee)} + ${percent(r)} (${price(m)} a usual month)`);
    return {
      state,
      rows: [],
      lines: [
        `preview ${label(p.currentPrice, p.currentRate, p.currentMonthly)}→${label(p.price, p.rate, p.monthly)} (${p.direction}): income ${money(p.currentDailyIncome)}→${money(p.dailyIncome)}/day once settled; ` +
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
  if (command.kind === "market") return { state, rows: [], lines: marketLines(sim, state) };
  if (command.kind === "funding") return { state, rows: [], lines: fundingLines(sim, state) };
  if (command.kind === "ipo") return { state, rows: [], lines: ipoLines(sim, state) };
  if (command.kind === "odds") return { state, rows: [], lines: oddsLines(command.funder, sim.counterOdds(state, command.funder, command.terms)) };
  if (command.kind === "rescue") return { state, rows: [], lines: rescueLines(sim, state) };
  if (command.kind === "calendar") return { state, rows: [], lines: calendarLines(sim, state) };
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
  // Letting go permanent staff pays their severance at once.
  const severance = current.spend.staff - state.spend.staff;
  const paid = severance > 0 ? `, paid ${money(severance)} severance` : "";
  if (command.action.type === "applyForIpo") {
    const ipo = sim.ipo(current);
    const lines =
      ipo.status === "approved"
        ? ["applyForIpo: APPROVED. Pick a float and ring the opening bell.", ...offerLines(sim, current)]
        : [`applyForIpo: COLD MARKET. The IPO is postponed: apply again from day ${ipo.retryDay}. Satisfaction fell to ${pct(current.satisfaction)}.`];
    return { state: current, rows, lines };
  }
  if (command.action.type === "ringBell") {
    // Logged as the classroom server logs a game that ends.
    rows.push(logRow(sim, current, who, "end", { status: current.status, ending: "ipo" }));
    return { state: current, rows, lines: [...bellLines(current.ipo.result!), `GAME OVER: floated on day ${current.day}`] };
  }
  if (command.action.type === "counterFunding") return { state: current, rows, lines: [counterLine(sim, current, command.action.funder)] };
  return { state: current, rows, lines: [`${command.action.type}${command.times > 1 ? ` ×${done}` : ""}: done${paid}`] };
}

/** What a counter's roll did, and the offer that stands now. */
function counterLine(sim: Sim, state: GameState, funder: FunderId): string {
  const n = sim.funding(state).negotiations[funder]!;
  const round = n.rounds.at(-1)!;
  return `counter ${termsText(funder, round.counter)}: ${rollText(round)}. Offer ${n.offers.length}: ${termsText(funder, n.offers.at(-1)!)}${n.final ? " (final: accept or decline)" : ` (${n.countersLeft} counter left)`}`;
}

/** A counter's odds, before it's made. */
function oddsLines(funder: FunderId, o: CounterOdds): string[] {
  const chance = (x: number) => pct(x * 100);
  return [
    `counter ${termsText(funder, o.counter)} asks ${pct(o.ask * 100)} better (most ${pct(o.maxAsk * 100)}): −${o.penalty} on the roll${o.bonus ? `, +${o.bonus} bonus` : ""}`,
    `  high ${chance(o.chances.high)} → ${termsText(funder, o.outcomes.high)}`,
    `  middle ${chance(o.chances.middle)} → ${termsText(funder, o.outcomes.middle)}`,
    `  low ${chance(o.chances.low)} → ${termsText(funder, o.outcomes.low)}`,
  ];
}

/** A negotiation so far, if the student has countered: each offer and the roll that came after it. */
function negotiationLines(funder: FunderId, n: NegotiationView | null): string[] {
  if (!n?.rounds.length) return [];
  return n.rounds.map(
    (r, i) =>
      `  offer ${i + 1} ${termsText(funder, n.offers[i]!)}; you asked ${termsText(funder, r.counter)}, ${rollText(r)} → offer ${i + 2} ${termsText(funder, n.offers[i + 1]!)}`,
  );
}

/** After a refused letgo or move for want of staff, who the team has now, so the player can pick a grade they have. */
function teamNow(sim: Sim, state: GameState, action: Action, err: SimError): string {
  if (err.code !== "no_staff" || (action.type !== "letGo" && action.type !== "moveStaff")) return "";
  const pool = action.type === "letGo" ? action.pool : (action.from ?? (action.to === "developers" ? "ops" : "developers"));
  const team = sim.staff(state).find((p) => p.pool === pool);
  if (!team) return "";
  const agency = action.type === "letGo" && action.agency;
  return ` (${pool} now: ${(agency ? team.agency : team.grades).map((x) => `${x.count} ${agency ? "agency " : ""}${x.grade}`).join(", ")})`;
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
      // Once the game is over, only what changes nothing still works: the valuation, who owns the company, the IPO, the
      // market.
      if (current.status !== "playing" && !["valuation", "funding", "rescue", "ipo", "market"].includes(command.kind)) {
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
      `friends and family (accept ff): ${money(ff.amount)} for ${ff.newShares.toLocaleString("en-GB")} new shares at ${perShare(ff.sharePrice)} (${f.negotiations.friendsAndFamily?.rounds.length ? "the price they're paying values the company at" : "valuation"} ${money(ff.valuation)}). ` +
        `They'd own ${stake(ff.theirShare)}; you'd go from ${stake(ff.yourShareBefore)} to ${stake(ff.yourShareAfter)}. Paid now, no target. ` +
        `Negotiation: ${standing(f.negotiations.friendsAndFamily!)}.`,
      ...negotiationLines("friendsAndFamily", f.negotiations.friendsAndFamily),
    );
  } else {
    const t = f.friendsAndFamily!;
    lines.push(`friends and family: ${t.status} on day ${t.day}${t.status === "accepted" ? `, ${money(t.amount)} for ${t.shares.toLocaleString("en-GB")} shares` : ""}`);
  }
  const g = f.grantOffer;
  if (g) {
    lines.push(
      `grant (accept grant): ${money(g.amount)}, no shares. ${g.condition} ${g.ifMissed} Negotiation: ${standing(f.negotiations.grant!)}.`,
      ...negotiationLines("grant", f.negotiations.grant),
    );
  }
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
const SHOWN_KINDS = new Set(["outage", "event", "rescue", "liquidation", "finished", "support", "price", "launch", "staff", "funding", "danger", "calendar", "rival"]);
const STOPPING_KINDS = new Set(["feature", "migration", "api"]);

/**
 * Stops the text interface makes on top of the sim's own pause triggers, comparing the company before and after a
 * tick: worth a look for a playtester, though the game page plays on through them.
 */
function extraStops(sim: Sim, before: GameState, after: GameState, pauses: PauseReason[]): string[] {
  const reasons: string[] = [];
  // A risk that's new today makes the danger meter climb faster: worth a decision before the next random event.
  const risksBefore = new Set(sim.danger(before).risks.map((r) => r.id));
  const newRisks = sim.danger(after).risks.filter((r) => !risksBefore.has(r.id));
  if (newRisks.length) reasons.push(`danger meter climbing faster: ${newRisks.map((r) => r.label.toLowerCase()).join(", ")}`);
  if (after.hiring.length < before.hiring.length) reasons.push("staff started");
  const fell = after.satisfaction <= before.satisfaction - 15 || (after.satisfaction < 50 && before.satisfaction >= 50);
  if (fell && !pauses.some((p) => p.id === "satisfaction")) reasons.push(`satisfaction fell to ${pct(after.satisfaction)}`);
  // Reports left unhandled long enough to cost satisfaction: the same point the game logs its warning.
  const warnAt = 1 - sim.config.moderation.warnShare;
  const factor = (st: GameState) => sim.moderation(st)?.satisfactionFactor ?? 1;
  if (factor(after) < warnAt && factor(before) >= warnAt) reasons.push(`reports unhandled (${after.reportBacklog})`);
  if (sim.priceLockDaysLeft(before) > 0 && sim.priceLockDaysLeft(after) === 0) reasons.push("price can change again");
  return reasons;
}

/**
 * Plays ticks until at least `days` days have gone by: a tick is a day, or a week in a career, as Continue plays on
 * the game page. Stops early when the sim pauses itself (an event that hurts, an alert, an offer, low cash or something
 * finished), on the day it does, and also when a new risk climbs the danger meter, staff start, satisfaction falls
 * hard, reports go unhandled or the price unlocks. Logs one Continue a tick, as the classroom server does. Returns the
 * notable lines of each day played and why it stopped.
 */
export function advanceUntil(sim: Sim, state: GameState, days: number, who: Player): Turn {
  let current = state;
  const lines: string[] = [];
  const rows: LogRow[] = [];
  let stop: string | null = null;
  for (let played = 0; played < days && current.status === "playing" && !stop; ) {
    const before = current;
    const result = sim.tick(current);
    current = result.state;
    played += result.days;
    rows.push(logRow(sim, current, who, "continue", { events: sim.events(current).map((e) => e.id) }));
    const reasons = current.status === "playing" ? [...result.pauses.map((p) => p.text), ...extraStops(sim, before, current, result.pauses)] : [];
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
  // After an IPO the company is worth its market value at the first day's close, not the formula's valuation.
  const worth = state.ipo.result ? { marketValue: state.ipo.result.marketValue } : { valuation: sim.valuation(state).valuation };
  const valuation = { ...worth, yourShare: stake(yours.share), yourSharesWorth: yours.value };
  return JSON.stringify({ ...summary, ...valuation }, null, 1);
}
