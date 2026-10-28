// The AI playtest interface: the game as compact text, for an AI to play through the sim without the web page. It
// renders the company, lists the commands that work right now, runs them, and advances time until something needs a
// decision. Every game writes the same rows as the classroom playtest log, so the same analysis runs on both.
// A tool for testing the game, not part of it. See play.ts for the command line.
import {
  CSUITE_ROLES,
  CUSTOMER_TYPE_IDS,
  defaultConfig,
  DIFFICULTIES,
  gameLengthName,
  MANAGED_SERVICES,
  MODEL_IDS,
  ROUND_NAMES,
  percent,
  quarterName,
  RACK_SIZES,
  SERVER_SIZES,
  SERVER_TYPES,
  SimError,
  STAFF_GRADES,
  STAFF_POOLS,
  type Action,
  type CounterOdds,
  type CustomerTypeId,
  type DayLog,
  type FeatureView,
  type FunderId,
  type GameDate,
  type GameState,
  type VcTranche,
  type IpoResult,
  type NegotiationRound,
  type NegotiationView,
  type HolidayView,
  type PayHistoryEntry,
  type PayOfferPreview,
  type PayOfferTerms,
  type SchemeLevels,
  type StaffSchemeId,
  type StaffSchemeView,
  STAFF_SCHEMES,
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
  type TicketOutlook,
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

/** Who an offer is from: friends and family or the grant, or an investor who approached (the angel, or the VC picked). */
type Party = FunderId | "angel" | "vc";
/** The investors who approach: their offers are answered with the investor actions. */
const isInvestor = (party: Party): party is "angel" | "vc" => party === "angel" || party === "vc";

/** An offer's terms in words: cash for their share, or the grant's cash for its condition's days. */
const termsText = (party: Party, t: Terms) =>
  party === "grant" ? `${money(t.amount!)} for ${t.days} days of uptime` : `${money(t.amount!)} for ${stake(t.share!)}`;

/** A roll's bonus in words: "+2 bonus", or below 0 (staff dealt with directly) "−1 penalty". */
const bonusText = (bonus: number) => (bonus > 0 ? ` +${bonus} bonus` : bonus < 0 ? ` −${-bonus} penalty` : "");

/** A roll in words: "rolled 15 −6 for asking 20% = 9: middle, they moved 50% of the way". */
const rollText = (r: NegotiationRound) =>
  `rolled ${r.die}${r.penalty ? ` −${r.penalty} for asking ${pct(r.ask * 100)}` : ""}${bonusText(r.bonus)} = ${r.total < 0 ? `−${-r.total}` : r.total}: ${r.result}, ${r.move < 0 ? `they dug in: the offer got worse by ${pct(-r.move * 100)} of what you asked` : `they moved ${pct(r.move * 100)} of the way`}`;

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

/** Every daily outgoing at today's numbers: the sim's one costs figure (see RunwayView). */
export const dailyCosts = (sim: Sim, state: GameState): number => sim.runway(state).dailyCosts;

/** Income averaged over the last 7 days played. */
export const dailyIncome = (sim: Sim, state: GameState): number => sim.runway(state).dailyIncome;

/** Days of cash left at today's costs against the last 7 days' income, or null while that income covers them. */
export const runway = (sim: Sim, state: GameState): number | null => sim.runway(state).days;

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

/** How full the market is: "market 82% full (of 20,000 users it can reach): growth runs at 18% of an empty market's". */
export const reachText = (reach: { size: number; filled: number }) =>
  `market ${pct(100 * reach.filled)} full (of ${reach.size.toLocaleString("en-GB")} users it can reach): growth runs at ${pct(100 * (1 - reach.filled))} of an empty market's`;

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

/**
 * The items research can unlock now, in tier order: their tier is available and they aren't unlocked yet. The
 * product's features and the company's model's benefits first, then other models' benefits, ready for a migration.
 */
function unlockable(sim: Sim, state: GameState) {
  const items = sim.tiers(state).flatMap((t) => t.items).filter((i) => i.unlockable);
  const here = (i: (typeof items)[number]) => i.kind === "feature" || i.model === state.model;
  return [...items.filter(here), ...items.filter((i) => !here(i))];
}

/**
 * Campaigns once they've opened: how many run of how many, any holiday a new one would be timed for, and each one
 * still to run or running, with its spend, users and cost per user so far, then the last few finished.
 */
function campaignLines(sim: Sim, state: GameState): string[] {
  const view = sim.campaigns(state);
  if (!view.unlocked) return [];
  const holiday = view.holiday ? `; one started now is timed for ${view.holiday.name} in ${view.holiday.daysUntil}d (×${view.holiday.bonus})` : "";
  const one = (c: (typeof view.campaigns)[number]) =>
    `#${c.id} ${c.customerType} (${c.grade} marketer) £${c.spent}/£${c.budget}, day ${c.daysRun}/${c.days}, ${c.users} users${c.costPerUser !== null ? ` at £${c.costPerUser.toFixed(2)}` : ""}${c.holiday ? ` (${c.holiday} bonus)` : ""} ${c.status}`;
  const on = view.campaigns.filter((c) => c.status === "starting" || c.status === "running");
  const done = view.campaigns.filter((c) => c.status === "finished" || c.status === "stopped").slice(0, 3);
  const m = view.marketers;
  const free = m.grades.filter((x) => x.free).map((x) => `${x.free} ${x.grade}`).join(", ");
  return [
    `marketers: ${m.count}, ${m.free} free${free ? ` (${free}; a new campaign gets the ${m.next})` : ""} | a campaign needs a free marketer, whose grade work multiplies its users per pound`,
    `campaigns: ${view.running}/${view.capacity} running, market ${Math.round(100 * (1 - view.saturation))}% full${holiday}`,
    ...[...on, ...done].map((c) => `  ${one(c)}`),
  ];
}

/** The company at a glance: everything a player sees on the dashboard, as short lines. */
/** Tiers in a line: those open, and for the next one, its condition and how far the company has got. */
function tiersLine(sim: Sim, state: GameState): string {
  const view = sim.tiers(state);
  const open = view.filter((t) => t.available).map((t) => t.tier);
  const next = view.find((t) => !t.available);
  if (!next) return `all open (${open.join(", ")})`;
  // "A CTO hired" reads "a CTO hired" mid-line.
  const part = (c: (typeof next.conditions)[number]) =>
    c.unit === "yes"
      ? `${c.label[0]!.toLowerCase()}${c.label.slice(1)}${c.met ? " (yes)" : ""}`
      : `${c.label.toLowerCase()} ${c.unit === "pounds" ? money(c.value) : c.unit === "percent" ? `${c.value}%` : c.value.toLocaleString("en-GB")}/${c.unit === "pounds" ? money(c.target) : c.unit === "percent" ? `${c.target}%` : c.target.toLocaleString("en-GB")}${c.met ? " (met)" : ""}`;
  const items = next.items.filter((i) => i.kind === "feature" || i.model === state.model).map((i) => i.id);
  return `open ${open.join(", ")} | tier ${next.tier} needs ${next.conditions.map(part).join(next.any ? " OR " : " AND ")}${items.length ? ` (unlocks ${items.join(", ")})` : ""}`;
}

/** On-prem, a server's slider, wear and any trouble: empty at 100% with no wear to speak of on any other model. */
function hardwareText(s: ReturnType<Sim["servers"]>[number]): string {
  if (s.performance === null) return "";
  const parts = [`at ${Math.round(100 * s.performance)}%`, `wear ${Math.round(100 * (s.wear ?? 0))}%`];
  if (s.wearWarning) parts.push(s.wearDaysLeft === 0 ? "WORN OUT: replace it" : `NEARLY WORN OUT in ~${s.wearDaysLeft}d at this slider`);
  if (s.risk && (s.risk.crash > 0 || s.risk.overheat > 0)) {
    parts.push(`risk ${(100 * s.risk.overheat).toFixed(1)}% overheat/${(100 * s.risk.crash).toFixed(1)}% crash a day`);
  }
  if (s.crashedDays) parts.push(`CRASHED ${s.crashedDays}d`);
  if (s.overheatedDays) parts.push(`OVERHEATED ${s.overheatedDays}d`);
  return ` [${parts.join(", ")}]`;
}

/** The phase (#236): which it is and since when, and the milestone that opens the next. */
function phaseLine(sim: Sim, state: GameState): string {
  const phase = sim.phase(state);
  const next = phase.next ? ` | next: ${phase.next.name}, ${phase.next.opensWith[0]!.toLowerCase()}${phase.next.opensWith.slice(1)}` : "";
  const opens = phase.phases.filter((p) => p.day !== null).flatMap((p) => p.opens);
  return `phase: ${phase.name} (from day ${phase.day})${next} | open: ${opens.join(", ")}`;
}

export function renderStatus(sim: Sim, state: GameState): string {
  const lines: string[] = [];
  const lock = sim.priceLockDaysLeft(state);
  const left = runway(sim, state);
  const daysToPlay = state.finalDay === null ? Infinity : state.finalDay - state.day;
  const lasts = left === null ? "not losing money" : left > daysToPlay ? `lasts past day ${state.finalDay}` : `${left} days`;
  const status = state.ipo.result ? "FLOATED" : state.endedByTeacher ? "ENDED BY TEACHER" : state.status.toUpperCase();
  const calendar = sim.calendar(state);
  lines.push(
    `== ${state.companyName} | ${sim.config.productTypes[state.productType].name} (${state.productType}) on ${state.model} | day ${state.day}${state.finalDay === null ? "" : `/${state.finalDay}`} ` +
      `(${gameLengthName(sim.config, state.gameLength)}, ${DIFFICULTIES[state.difficulty].name}${sim.tickDays(state) === 7 ? ", a week a tick" : ""}) | ${calendar.today.text} | ${status}`,
  );
  lines.push(phaseLine(sim, state));
  lines.push(
    `cash ${money(state.cash)} | income ${money(dailyIncome(sim, state))}/day (last 7 days) | costs ${money(dailyCosts(sim, state))}/day | runway ${lasts}`,
  );
  const { oneOffsThisWeek } = sim.runway(state);
  if (oneOffsThisWeek > 0) lines.push(`one-offs this week ${money(oneOffsThisWeek)} (not in costs: see \`costs\`)`);
  const priceOpen = sim.phase(state).open.price;
  lines.push(`${renderPrice(sim, state)} | ${!priceOpen ? "set from Launch" : lock > 0 ? `locked ${lock} more days` : "can change"}`);
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
  const { reach } = sim.market(state);
  lines.push(
    `users ${state.users.toLocaleString("en-GB")} (paid ${state.paidUsers.toLocaleString("en-GB")}, free ${(state.users - state.paidUsers).toLocaleString("en-GB")}) | converting ${(conversion.rate * 100).toFixed(2)}%/day | ${reachText(reach)}`,
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

  const mvp = sim.mvp(state);
  if (!mvp.done) {
    const due = mvp.launchDay === null ? "no developers to finish it" : `done by the end of day ${mvp.launchDay}`;
    lines.push(`MVP: ${+mvp.progress.toFixed(1)}/${mvp.total} developer-days (${due}); no users until it's done and you launch`);
  } else {
    const o = sim.optimisation(state);
    lines.push(
      `optimisation: ${Math.round(100 * o.share)}% of developer time, ${+o.days.toFixed(1)} dev-days built up, ` +
        `saving ${(100 * o.saving).toFixed(1)}% of resource need per user (most ${Math.round(100 * o.cap)}% on this model)`,
    );
  }
  const research = sim.research(state);
  if (research.unlocked) {
    const left = unlockable(sim, state);
    const spend = left.length
      ? `can unlock ${left.map((i) => `${i.id} ${i.rpPrice} RP`).join(", ")}`
      : sim.tiers(state).some((t) => t.items.some((i) => !i.unlocked))
        ? "nothing to unlock until the next tier is available"
        : "everything is unlocked";
    lines.push(`research: ${+research.points.toFixed(1)} RP banked, ${research.pointsPerDay} RP a day; ${spend}`);
  }
  lines.push(...campaignLines(sim, state));
  lines.push(csuiteLine(sim, state));
  lines.push(`tiers: ${tiersLine(sim, state)}`);
  const benefitsOn = sim.benefits(state).filter((b) => b.active);
  if (benefitsOn.length) {
    lines.push(`model benefits on: ${benefitsOn.map((b) => `${b.id} (${money(b.monthlyFee)}/month)`).join(", ")} (lost if you migrate)`);
  }
  const launch = sim.launch(state);
  if (launch.status !== "launched") {
    const when = launch.day !== null ? `, go-live day ${launch.day}` : launch.status === "ready" ? " (ready: type launch)" : "";
    const short = launch.missing.length ? `; launching now would be short: ${launch.missing.join("; ")}` : "";
    lines.push(`launch: ${launch.status}${when}${short}`);
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
    if (provider) {
      lines.push(
        `capacity: the provider's (no limit) | ${price(provider.perUserFee)}/user/month on ${provider.users.toLocaleString("en-GB")} users = ${money(provider.monthlyPerUserBill)}/month, plus ${money(provider.monthlyCost)}/month`,
      );
    }
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
            `#${s.id} ${s.size} ${s.type} ${s.units} ${s.apiu ? "APIU (switched)" : UNIT[s.type]}${s.unitBoost > 1 && s.type !== "loadBalancer" ? ` (+${percent(s.unitBoost - 1)} newer kit)` : ""}${s.rack !== null ? ` in rack #${s.rack}` : ""}${s.status === "pending" ? ` (arrives in ${s.daysLeft}d)` : ""}${hardwareText(s)}`,
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
    // The paid API opens in Grow (#236).
    if (sim.phase(state).open.api) {
      lines.push(`api: ${api.name} not bought (${money(api.price)} once; about ${Math.round(api.pricePerCall * 100)}p a call)`);
    }
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
      .map((f) => `${f.id} ${f.status === "notStarted" ? (f.unlocked ? "not started" : f.tierAvailable ? `locked (unlock for ${f.rpPrice} RP)` : `locked (tier ${f.tier})`) : f.status}${f.daysLeft ? ` (${f.daysLeft}d left)` : ""}${appeal(f.appeal)}`)
      .join(", ")}`,
  );

  const loan = sim.loan(state);
  const loanLabel = loan?.emergency ? "loan (emergency)" : "loan";
  if (loan?.remaining) {
    lines.push(
      `${loanLabel}: ${money(loan.remaining)} left, ${money(loan.dailyRepayment)}/day for ${loan.daysLeft} more days (to day ${loan.lastDay}); paying off now costs ${money(loan.payoff)}, saving ${money(loan.interestSaved)} interest`,
    );
  } else if (loan) lines.push(`${loanLabel}: repaid${loan.paidOffDay !== null ? ` early on day ${loan.paidOffDay}` : ""}`);
  // Once cash has gone below £0: how much further shortfalls can go on the loan before cash has run out.
  if (state.firstShortfallDay !== null && state.status === "playing") {
    const short = sim.shortfall(state);
    const next = state.rescue ? "liquidation" : "the vulture VC steps in";
    lines.push(`below £0: ${money(short.owed)} of shortfalls on the loan; ${money(short.room)} more (of ${short.limitDays} days of costs, ${money(short.limit)}) and ${next}`);
  }
  const valuation = sim.valuation(state);
  const table = sim.capTable(state);
  lines.push(
    `${state.ipo.result ? `market value ${money(state.ipo.result.marketValue)} at the first day's close` : `valuation ${money(valuation.valuation)}`} | share price ${perShare(table.sharePrice)} | ${table.rows.map((r) => `${r.id === "angel" || r.id === "vc" ? r.name : r.name.toLowerCase()} ${stake(r.share)}`).join(", ")} of ${table.sharesInIssue.toLocaleString("en-GB")} shares`,
  );
  lines.push(`pay: ${payStatus(sim, state)}`);
  const drift = driftStatus(sim, state);
  if (drift) lines.push(`drift: ${drift}`);
  lines.push(`funding: ${fundingStatus(sim, state)}`);
  const investors = investorsStatus(sim, state);
  if (investors) lines.push(`investors: ${investors}`);
  const vc = vcStatus(sim, state);
  if (vc) lines.push(`vc: ${vc}`);
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
  if (danger.warning) lines.push(`  WARNING: ${danger.warning.text}`);
  lines.push(`calendar: ${calendarLine(sim, state)}`);
  for (const e of sim.events(state)) lines.push(`event today: ${e.name}. ${e.responsibility} ${e.outcome}`);
  for (const g of sim.featureGaps(state)) lines.push(`feature gap: ${g.name}. ${g.detail}`);
  return lines.join("\n");
}

/** A pay rise as a percent, to a tenth: 3.4%. */
const rise = (n: number) => `${(Math.round(n * 1000) / 10).toFixed(1)}%`;

/** "Q3", or in a long game's later years "Y2Q1". */
const quarterTag = (r: { quarter: number; year: number }) => `${r.year > 1 ? `Y${r.year}` : ""}Q${r.quarter}`;

/** A price rise as a percent, to a tenth: 4.2%. */
const tenth = (n: number) => `${Math.round(n * 1000) / 10}%`;

/**
 * Drift in a line: prices and new kit against the start, the years' rises so far and the next year's end. Empty in a
 * game that never reaches a year's end and hasn't.
 */
function driftStatus(sim: Sim, state: GameState): string {
  const d = sim.drift(state);
  if (!d.yearEnds.length && d.nextYearEnd === null) return "";
  const rises = d.yearEnds.map((y) => `Y${y.year} +${tenth(y.inflation)}`).join(", ");
  const prices = d.yearEnds.length ? `running prices +${tenth(d.priceLevel - 1)} on the start (${rises}); new kit +${tenth(d.newKitUnits - 1)} units` : "prices as at the start";
  const next = d.nextYearEnd !== null ? `; next year's end after day ${d.nextYearEnd}: prices +${tenth(sim.config.drift.inflation.min)}–${tenth(sim.config.drift.inflation.max)}, new kit +${tenth(sim.config.drift.newKitUnits)} units` : "";
  return `${prices}${next}`;
}

/** Drift in full: every year's end, and what the next will do. */
/** The C-suite in a line: who's hired, and the roles open to hire. */
function csuiteLine(sim: Sim, state: GameState): string {
  const view = sim.csuite(state);
  const hired = view.roles.filter((r) => r.executive).map((r) => `${r.name} ${r.executive!.name}`);
  const open = view.roles.filter((r) => r.open && !r.executive).map((r) => r.name);
  const pay = view.payHoliday.since !== null ? `PAY HOLIDAY since day ${view.payHoliday.since} (${money(view.dailyPay)}/day forgone)` : `${money(view.dailyPay)}/day`;
  return `c-suite: ${hired.length ? `${hired.join(", ")}; ${pay}` : "nobody hired"} (${hired.length} of ${view.roles.length}, all needed to IPO) | ${open.length ? `can hire: ${open.join(", ")} ("csuite" for shortlists)` : "no role open to hire"} | equity cap ${tenth(view.equityCap)}, ${tenth(view.equityLeft)} left`;
}

/** The board's pay holiday in a line: on now, or when it would start. */
function payHolidayLine(h: ReturnType<Sim["csuite"]>["payHoliday"]): string {
  if (h.startDays <= 0) return "pay holiday: off";
  return h.since !== null
    ? `pay holiday: since day ${h.since}, cash is low, so no executive is paid until cash is back above ${h.endDays} days of running costs`
    : `pay holiday: if cash falls below ${h.startDays} days of running costs, every executive forgoes their pay until it's back above ${h.endDays} days`;
}

/** The C-suite in full: every role with when it opens, who fills it, or its shortlist. */
function csuiteLines(sim: Sim, state: GameState): string[] {
  const view = sim.csuite(state);
  const lines = [
    `c-suite: hired for good, no pay reviews; equity asks paid in new shares, shrinking as the ${tenth(view.equityCap)} cap fills (${tenth(view.equityUsed)} used, ${tenth(view.equityLeft)} left; the staff share scheme doesn't count). Every role must be filled to IPO: ${view.roles.filter((r) => r.executive).length} of ${view.roles.length} hired`,
    payHolidayLine(view.payHoliday),
  ];
  for (const r of view.roles) {
    if (r.executive) {
      const e = r.executive;
      const effects = e.effects.length ? e.effects.map((x) => x.text).join("; ") : "no effect";
      lines.push(`  ${r.name}: ${e.name} (hired day ${e.day}, ${money(e.salary)}/day, ${tenth(e.equity)} equity): ${effects}`);
    } else if (!r.open) {
      lines.push(`  ${r.name} (shut): ${r.opens}`);
    } else {
      lines.push(`  ${r.name} (open): ${r.blurb}`);
      for (const c of r.shortlist) {
        const effects = c.effects.length ? c.effects.map((x) => x.text).join("; ") : "no effect";
        lines.push(`    ${c.id}  ${c.name}: strength ${Math.round(c.strength * 100)}%, ${money(c.salary)}/day, ${tenth(c.equity)} equity (${c.newShares.toLocaleString("en-GB")} new shares) | ${effects}`);
      }
    }
  }
  return lines;
}

/** The costs line broken down by heading, then the one-offs kept apart from it. */
function costsLines(sim: Sim, state: GameState): string[] {
  const r = sim.runway(state);
  const lines = [`== Daily costs: ${money(r.dailyCosts)} a day`];
  for (const h of r.costs) {
    const holiday = h.id === "executives" && r.payHoliday ? " (the board's pay holiday: none while it lasts)" : "";
    lines.push(`  ${h.label}: ${money(h.amount)}${holiday}`);
  }
  lines.push(`Income averaged over the last 7 days: ${money(r.dailyIncome)} a day.`);
  lines.push(
    r.days === null
      ? `Not losing money: ${money(r.dailyNet)} a day to spare.`
      : `Losing ${money(-r.dailyNet)} a day: cash lasts about ${r.days} day${r.days === 1 ? "" : "s"}.`,
  );
  lines.push(`One-offs this week (kit bought, severance, fees, events; not in daily costs): ${money(r.oneOffsThisWeek)}.`);
  return lines;
}

function driftLines(sim: Sim, state: GameState): string[] {
  const d = sim.drift(state);
  if (!d.on) return ["drift: off in this game's config"];
  const lines = [`drift: years of ${d.yearDays} days; your own price and pay never drift (pay rises only in pay reviews)`];
  for (const y of d.yearEnds) {
    lines.push(`  year ${y.year} (ended day ${y.day}): prices +${tenth(y.inflation)} → ×${y.priceLevel.toFixed(3)}; new kit ×${y.newKitUnits.toFixed(3)} units`);
  }
  if (!d.yearEnds.length) lines.push("  no year's end yet");
  lines.push(
    d.nextYearEnd !== null
      ? `  next year's end after day ${d.nextYearEnd} (${d.nextYearEnd - state.day} days): running prices rise ${tenth(sim.config.drift.inflation.min)}–${tenth(sim.config.drift.inflation.max)} at random, and servers and VMs added after it give ${tenth(sim.config.drift.newKitUnits)} more units for the money (kit you have keeps its units)`
      : "  this game ends before another year's end",
  );
  return lines;
}

/** Pay in a line: the open review, or the rises agreed so far and the next review's day. */
function payStatus(sim: Sim, state: GameState): string {
  const review = sim.payReview(state);
  if (review) {
    return `PAY REVIEW OPEN for ${quarterName(review)} (from day ${review.startDay}): inflation ${rise(review.inflation)}, offer ${rise(review.minOffer)}–${rise(review.maxAsk)}, staff asking ${rise(review.staffFigure)}; ${review.offersLeft} offer${review.offersLeft === 1 ? " left (final)" : "s left"}. The day can't go on until it's settled ("pay" for the review)`;
  }
  const rises = state.pastPayReviews.map((r) => `${quarterTag(r)} ${rise(r.rise)}`).join(", ");
  const next = sim.config.payReview.on === 1 ? sim.payReviewDays(state).find((d) => d > state.day + 1) : undefined;
  const multiple = `pay ×${state.payMultiplier.toFixed(3)} of the day rates`;
  const schemes = schemesText(sim.staffSchemes(state));
  return `${rises ? `${multiple} (rises: ${rises})` : "no pay reviews yet"}${schemes ? `; schemes: ${schemes}` : ""}${next ? `; next review before day ${next}` : ""}`;
}

/** A scheme's worth to staff, to a hundredth of a point: 0.53%. */
const fineRise = (n: number) => `${(Math.round(Math.round(n * 1e6) / 100) / 100).toFixed(2)}%`;

/** The text play name of each staff scheme, as typed in an offer: "death=on". */
const SCHEME_WORDS: Record<StaffSchemeId, string> = {
  pension: "pension",
  health: "health",
  deathInService: "death",
  discount: "discount",
  shareSave: "shares",
};

/** The schemes held, with their cost a day: "Pension top-up 2 (£3.84/day), Death in service (£0.96/day)". Empty for none. */
function schemesText(schemes: StaffSchemeView[]): string {
  return schemes
    .filter((s) => s.level > 0)
    .map((s) => `${s.name}${s.toggle ? "" : ` ${s.level}`} (${money(s.costPerDay)}/day)`)
    .join(", ");
}

/** Each scheme for an open review: held level, its range, its cost model and worth to staff. */
function schemeLines(schemes: StaffSchemeView[], valuation: number): string[] {
  return [
    `  staff schemes (levels only go up; staff count ${pct(valuation * 100)} of a scheme's worth): add them to an offer, e.g. offer 2.5 pension=1 death=on`,
    ...schemes.map((s) => {
      const cost = [
        s.wageShare ? `${(s.wageShare * 100).toFixed(1)}% of pay` : "",
        s.perPerson ? `£${s.perPerson.toFixed(2)}/person/day` : "",
        s.sharesPerLevel ? `new shares worth ${pct(s.sharesPerLevel * 100)} of the company (diluting you)` : "",
      ]
        .filter(Boolean)
        .join(" + ");
      const held = s.toggle ? (s.level ? "on" : "off") : `level ${s.level} of ${s.maxLevel}`;
      return `    ${SCHEME_WORDS[s.id]}: ${s.name}, ${held} (${money(s.costPerDay)}/day now); ${s.toggle ? "it" : "each level"} costs ${cost} and is worth ${fineRise(s.staffValue * valuation)} to staff`;
    }),
  ];
}

/** The open pay review in full: the caps, the offers and counters so far, and what's next. */
function payLines(sim: Sim, state: GameState): string[] {
  const review = sim.payReview(state);
  if (!review) return [`pay: ${payStatus(sim, state)}`];
  const lines = [
    `pay review, ${quarterName(review)} (the rise applies from day ${review.startDay}): inflation ${rise(review.inflation)}. ` +
      `You can offer from ${rise(review.minOffer)} (inflation less a point); staff ask ${rise(review.maxAsk)} at most. A rise below inflation is a pay cut in real terms.`,
    `  the team costs ${money(review.dailyStaffCost)}/day now, pay and staff schemes`,
    ...schemeLines(review.schemes, review.schemeValuation),
  ];
  if (!review.headOfPeople) {
    lines.push(
      `  you're dealing with staff directly (no head of people): they're stricter, ${review.rollBonus < 0 ? `−${-review.rollBonus}` : `+${review.rollBonus}`} on every counter roll, and want cash, counting schemes at ${pct(review.schemeValuation * 100)}`,
    );
  }
  review.rounds.forEach((r, i) => {
    lines.push(`  offer ${i + 1}: you offered ${offerText(sim, state, review.offerTerms[i]!, review.studentOffers[i]!)}, ${rollText(r)} → staff counter ${rise(review.staffFigures[i + 1]!)}`);
  });
  lines.push(
    review.canAcceptCounter
      ? review.counter?.schemesText
        ? `  staff are asking ${rise(review.counter.cash)} cash plus your schemes (${review.counter.schemesText}): "accept pay" to agree it, or offer again`
        : `  staff are asking ${rise(review.staffFigure)} in cash: "accept pay" to agree it, or offer again`
      : `  staff open at ${rise(review.staffFigure)}: make the first offer`,
  );
  if (review.final) {
    lines.push(
      `  your next offer is FINAL: if staff don't accept it, it goes to a TRIBUNAL, which charges ${money(review.tribunalFee)} and picks your figure, theirs or the middle, ` +
        `favouring whichever is closest to a fair rise ("payodds <rise %> [schemes]" for its odds). Your schemes apply whichever it picks`,
    );
  }
  return lines;
}

/** An offer in words: "3.0% cash" or "2.0% cash + Pension top-up to level 1 = 2.5% to staff". */
function offerText(sim: Sim, state: GameState, terms: PayOfferTerms, value: number): string {
  const held = sim.staffSchemes(state);
  const raised = held
    .filter((s) => terms.schemes[s.id] > s.level)
    .map((s) => (s.toggle ? s.name : `${s.name} to level ${terms.schemes[s.id]}`));
  return raised.length ? `${rise(terms.rise)} cash + ${raised.join(", ")} = ${rise(value)} to staff` : `${rise(terms.rise)} cash`;
}

/** What offering a rise and schemes would cost and, if staff counter, the odds on their roll. */
function payOddsLines(p: PayOfferPreview): string[] {
  const chance = (x: number) => pct(x * 100);
  const real = p.realTerms < 0 ? `${rise(-p.realTerms)} below inflation: a real-terms pay cut` : `${rise(p.realTerms)} above inflation`;
  const lines = [`offer ${rise(p.rise)} cash (${real}): +${money(p.extraPerDay)}/day, +${money(p.extraPerYear)} a year at today's team, schemes included`];
  const raised = p.schemeCosts.filter((s) => s.level > s.held);
  if (raised.length) {
    lines.push(`  worth ${rise(p.value)} to staff: the cash + ${fineRise(p.schemeValue)} for the schemes raised`);
    for (const s of raised) {
      lines.push(`    ${s.name} ${s.held} → ${s.level}: worth ${fineRise(s.value)} to staff, costs ${money(s.costPerDay)}/day (+${money(s.extraPerDay)})`);
    }
  }
  if (p.dilution) {
    const d = p.dilution;
    lines.push(
      `  share save issues ${d.newShares.toLocaleString("en-GB")} new shares to the staff share scheme (${stake(d.schemeShareAfter)} of the company after): you'd own ${stake(d.yourShareAfter)}, down from ${stake(d.yourShareBefore)}`,
    );
  }
  if (p.meetsAsk) lines.push("  that's what staff are asking: they take it");
  if (p.tribunal) {
    const t = p.tribunal;
    lines.push(
      `  final offer: if staff don't accept it, the tribunal sits for ${money(t.fee)} and picks:`,
      `    your offer ${chance(t.chances.student)} → ${rise(t.cash.student)} cash${raised.length ? " + your schemes" : ""}`,
      `    the middle ${chance(t.chances.middle)} → ${rise(t.cash.middle)} cash${raised.length ? " + your schemes" : ""}`,
      `    staff's figure ${chance(t.chances.staff)} → ${rise(t.cash.staff)} cash${raised.length ? " + your schemes" : ""}`,
    );
  }
  if (p.odds) {
    const o = p.odds;
    lines.push(
      `  if staff don't accept it, they counter: it asks them ${pct(o.ask * 100)} lower, −${o.penalty} on the roll${o.bonus ? `,${bonusText(o.bonus)}` : ""}`,
      `    high ${chance(o.chances.high)} → ${rise(o.outcomes.high.rise!)}`,
      `    middle ${chance(o.chances.middle)} → ${rise(o.outcomes.middle.rise!)}`,
      `    low ${chance(o.chances.low)} → ${rise(o.outcomes.low.rise!)}`,
    );
  }
  return lines;
}

/** The student's share of the company, 0–1, from the cap table. */
const yourShare = (sim: Sim, state: GameState) => sim.capTable(state).rows.find((r) => r.id === "student")?.share ?? 0;

const tribunalPickText = { student: "your final offer", middle: "the middle", staff: "staff's figure" } as const;

/** How an offer or an accepted counter left the review: settled on a rise, or staff's counter standing. */
function payResultLine(sim: Sim, before: GameState, after: GameState): string {
  const review = sim.payReview(after);
  if (review) {
    const r = review.rounds.at(-1)!;
    const left = `${review.offersLeft} offer${review.offersLeft === 1 ? " left, final" : "s left"}`;
    return `offer ${offerText(sim, before, review.offerTerms.at(-1)!, review.studentOffers.at(-1)!)}: staff counter, ${rollText(r)} → they ask ${rise(review.staffFigure)} (${left}; "accept pay" agrees it)`;
  }
  const settled = after.pastPayReviews.at(-1)!;
  const how =
    settled.outcome === "offerAccepted"
      ? `staff accepted your offer of ${offerText(sim, before, settled.offerTerms.at(-1)!, settled.studentOffers.at(-1)!)}`
      : settled.outcome === "counterAccepted"
        ? `you accepted staff's counter of ${rise(settled.rise)}`
        : `no deal on the final offer, so the tribunal sat (fee ${money(settled.tribunal!.fee)}) and picked ${tribunalPickText[settled.tribunal!.pick]}, ${rise(settled.rise)}`;
  const schemes = schemesText(sim.staffSchemes(after));
  const shares = settled.shareSaveShares
    ? `; share save issued ${settled.shareSaveShares.toLocaleString("en-GB")} new shares to the staff share scheme, so you own ${stake(yourShare(sim, after))} (was ${stake(yourShare(sim, before))})`
    : "";
  return `pay review settled: ${how}. Pay ×${after.payMultiplier.toFixed(3)} of the day rates from day ${settled.startDay}: the team costs ${money(sim.dailyStaffCost(after))}/day (was ${money(sim.dailyStaffCost(before))})${schemes ? `; schemes held: ${schemes}` : ""}${shares}`;
}

const endedText = (r: PayHistoryEntry) =>
  r.outcome === "offerAccepted"
    ? `staff accepted your ${["first", "second", "final"][r.offers - 1] ?? ""} offer`
    : r.outcome === "counterAccepted"
      ? "you accepted staff's counter"
      : `tribunal picked ${tribunalPickText[r.tribunalPick!]} (fee ${money(r.tribunalFee)})`;

/** The pay history in full: each settled review, the multiplier so far, the schemes held and the next review. */
function payHistoryLines(sim: Sim, state: GameState): string[] {
  const h = sim.payHistory(state);
  const next = h.nextReview ? `${quarterName(h.nextReview)}, from day ${h.nextReview.startDay}` : null;
  if (!h.reviews.length) return [`pay history: no pay reviews yet${next ? `. The first comes at the start of ${next}` : ""}`];
  const lines = [
    `pay history: pay ×${h.payMultiplier.toFixed(3)} of the day rates (+${rise(h.payMultiplier - 1)} compounded)${h.tribunalFees ? `; tribunal fees ${money(h.tribunalFees)}` : ""}`,
  ];
  for (const r of h.reviews) {
    const raised = r.schemeRaises.map((x) => (x.toggle ? x.name : `${x.name} ${x.from}→${x.to}`)).join(", ");
    const real = `${r.realTerms < 0 ? "" : "+"}${rise(r.realTerms)} on inflation`;
    lines.push(
      `  ${quarterTag(r)} ${r.date} (day ${r.startDay}): inflation ${rise(r.inflation)}; staff opened at ${rise(r.staffFigures[0]!)}; ` +
        `${endedText(r)}: ${rise(r.rise)} cash (${real})${raised ? ` + ${raised}` : ""}` +
        `${r.shareSaveShares ? `; ${r.shareSaveShares.toLocaleString("en-GB")} new shares to the staff share scheme` : ""} → pay ×${r.payMultiplier.toFixed(3)}`,
    );
  }
  const schemes = schemesText(h.schemes);
  lines.push(`  schemes held: ${schemes ? `${schemes}; ${money(h.schemesCostPerDay)}/day in all` : "none"}`);
  if (h.staffShareScheme) {
    lines.push(`  staff share scheme: ${h.staffShareScheme.shares.toLocaleString("en-GB")} shares, ${stake(h.staffShareScheme.share)} of the company`);
  }
  if (next) lines.push(`  next review: ${next}`);
  return lines;
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
  const closed = `closed on day ${f.closedDay} (you took ${closedBy(state)})`;
  const ff = f.friendsAndFamilyOffer
    ? `${standing(n.friendsAndFamily!)} ${money(f.friendsAndFamilyOffer.amount)} for ${stake(f.friendsAndFamilyOffer.theirShare)}`
    : (f.friendsAndFamily?.status ?? closed);
  const g = f.grant;
  const grant = f.grantOffer
    ? `${standing(n.grant!)} ${money(f.grantOffer.amount)} if uptime ≥ ${f.grantOffer.minUptime}% for ${f.grantOffer.days} days`
    : !g
      ? closed
      : g.status === "accepted"
      ? g!.untilDay === null
        ? `${g!.maxHoursDown}h down allowed over ${g!.days} days, starting once the launch is over`
        : `${g!.hoursDown}h of ${g!.maxHoursDown}h down allowed used, ${state.day < g!.fromDay! ? `starting day ${g!.fromDay}, ` : ""}${g!.daysLeft} days left`
      : g.status;
  return `friends and family ${ff} | grant ${grant}`;
}

/** The angel in a line: an open approach, their deal and its target, or a new one coming. Null before any approach. */
function investorsStatus(sim: Sim, state: GameState): string | null {
  const i = sim.investors(state);
  if (i.offer) {
    const o = i.offer;
    return `ANGEL ${o.investor} approached on day ${o.day}: ${standing(i.negotiation!)} ${money(o.amount)} for ${stake(o.theirShare)}, valuing the company at ${money(o.valuation)} with their cash; ${standsText(o.daysLeft, o.lastDay)} ("angel" for the offer in full)`;
  }
  const a = i.angel;
  if (a) {
    const target = `${money(a.target.dailyRevenue)}/day over ${a.target.days} days and +${a.target.netUsers.toLocaleString("en-GB")} net users by day ${a.target.byDay}`;
    const how =
      a.status === "running"
        ? `target ${target}: ${money(a.dailyRevenue)}/day over the last ${a.target.days} days, and users +${a.usersGained.toLocaleString("en-GB")} gained −${a.usersLost.toLocaleString("en-GB")} lost = ${a.netUsers.toLocaleString("en-GB")} net of ${a.target.netUsers.toLocaleString("en-GB")}, ${a.daysLeft} days left`
        : a.status === "met"
          ? `target ${target} met on day ${a.settledDay}`
          : `target ${target} missed on day ${a.settledDay}: they took ${a.extraShares.toLocaleString("en-GB")} extra shares`;
    return `angel ${a.investor} put in ${money(a.amount)} on day ${a.day} for ${stake(a.share)}; ${how}`;
  }
  if (i.anotherComing) {
    const last = i.declined.at(-1)!;
    return `${last.lapsed ? `${last.investor}'s offer lapsed unanswered` : `you declined ${last.investor}`}: another angel approaches in a few days`;
  }
  return null;
}

/** How long an investor's offer stands: "answer by day 35 (2 days left) or it lapses". */
const standsText = (daysLeft: number, lastDay: number) =>
  `answer by day ${lastDay} (${daysLeft === 1 ? "today is the last day" : `${daysLeft} days left`}) or it lapses, counting as a decline`;

/** The angel's open offer in full, or their deal. */
function angelLines(sim: Sim, state: GameState): string[] {
  const i = sim.investors(state);
  const o = i.offer;
  if (!o) {
    const status = investorsStatus(sim, state);
    return [status ? `angel: ${status}` : "no angel investor has approached: they come to companies doing well"];
  }
  return [
    `angel ${o.investor} (accept angel | decline angel): ${money(o.amount)} for ${o.newShares.toLocaleString("en-GB")} new shares at ${perShare(o.sharePrice)}. ` +
      `They value the company at ${money(o.preMoney)} before their cash (${o.multiple}× the formula's business, cash at face value; today's valuation is ${money(o.formulaValuation)}), ${money(o.valuation)} with it. ` +
      `They'd own ${stake(o.theirShare)}; you'd go from ${stake(o.yourShareBefore)} to ${stake(o.yourShareAfter)}. Paid now, all of it.`,
    `  target: ${o.condition}`,
    `  if missed: ${o.ifMissed}`,
    ...o.effects.map((e) => `  accepting: ${e}`),
    `  offer: ${standsText(o.daysLeft, o.lastDay)}`,
    `  negotiation: ${standing(i.negotiation!)}. If their offer stands while the business is worth less than when they approached, their share rises in step.`,
    ...negotiationLines("angel", i.negotiation),
  ];
}

/** A merged round's second tranche in a few words: paid, or still to come. */
const trancheText = (t: VcTranche | null) =>
  t === null ? "" : t.paidDay === null ? `, ${money(t.amount)} of it to come once you hit their growth target` : `, the last ${money(t.amount)} paid day ${t.paidDay}`;

/**
 * Each Series round in a few words: the day it first approached, and the deal if one was done. A 180-day game has two,
 * each merging two rounds.
 */
function roundsText(sim: Sim, state: GameState): string {
  const rounds = sim.investors(state).vc.rounds;
  const text = rounds
    .map((r) =>
      r.firstApproachDay === null
        ? `${r.name} not yet`
        : `${r.name} approached day ${r.firstApproachDay}${r.deal ? ` (${r.deal.investor} put in ${money(r.deal.amount)} for ${stake(r.deal.share)}${trancheText(r.deal.tranche)})` : ""}`,
    )
    .join(", ");
  return rounds.length === 2 ? `${text} (a 180-day game has two VC rounds, each merging two)` : text;
}

/** Who closed friends and family and the grant: "an angel", or the first VC taken ("a Series A VC"). */
const closedBy = (state: GameState) =>
  state.investors.angel ? "an angel" : `a ${ROUND_NAMES[state.investors.vc.deals[0]?.round ?? "seriesA"]} VC`;

/** Venture capital in a line: an open approach and its three offers, or the rounds so far. Null before Series A. */
function vcStatus(sim: Sim, state: GameState): string | null {
  const v = sim.investors(state).vc;
  const a = v.approach;
  if (a) {
    const offers = a.offers
      .map((o, i) => `${i + 1}) ${o.investor}${o.lead ? " (lead VC)" : ""}, ${o.leanLabel.toLowerCase()}: ${money(o.amount)} for ${stake(o.theirShare)}${o.status === "closed" ? " CLOSED" : o.status === "picked" ? " PICKED" : ""}`)
      .join("; ");
    const next = a.picked ? `negotiating with ${a.picked}: ${standing(v.negotiation!)}` : "pick one to negotiate with";
    return `${a.name.toUpperCase()}: three VCs approached on day ${a.day}: ${offers}. ${next}; ${standsText(a.daysLeft, a.lastDay)} ("vc" for the offers in full)`;
  }
  if (v.rounds[0]!.firstApproachDay === null) return null;
  const coming = v.anotherComing ? `; you turned down the ${ROUND_NAMES[v.declined.at(-1)!.round]} VCs: three new ones approach in a few days` : "";
  return `${roundsText(sim, state)}${v.lead ? `; lead VC ${v.lead.investor}` : ""}${coming}`;
}

/** Venture capital in full: each round, and the open approach's three offers and the negotiation with the one picked. */
function vcLines(sim: Sim, state: GameState): string[] {
  const v = sim.investors(state).vc;
  const a = v.approach;
  const rounds = `rounds: ${roundsText(sim, state)}. The IPO needs none of them: Series A approaching opens the last C-suite roles, whether or not you take its money.`;
  if (!a) {
    return [
      v.rounds[0]!.firstApproachDay === null ? "no VCs have approached: they come to companies that grow, after the angel" : (vcStatus(sim, state) ?? ""),
      rounds,
    ];
  }
  const picking = a.picked
    ? `negotiating with ${a.picked} (accept vc | decline vc | counter vc ...): the other two have closed`
    : "pick <1-3 or name> to negotiate with one alone, which closes the other two; decline vc turns all three down";
  return [
    `${a.name}: three VCs approached on day ${a.day}. ${picking}.`,
    ...a.offers.map(
      (o, i) =>
        `  ${i + 1}) ${o.investor}${o.lead ? ", your lead VC," : ""} leans to ${o.leanLabel.toLowerCase()} [${o.status}]: ${money(o.amount)} for ${o.newShares.toLocaleString("en-GB")} new shares at ${perShare(o.sharePrice)}. ` +
        `They value the company at ${money(o.preMoney)} before their cash (${o.multiple}× the formula's business; today's valuation is ${money(a.formulaValuation)}), ${money(o.valuation)} with it. ` +
        `They'd own ${stake(o.theirShare)}; you'd go from ${stake(a.yourShareBefore)} to ${stake(o.yourShareAfter)}.` +
        (o.secondTranche === null ? "" : ` ${money(o.amount - o.secondTranche)} on signing, ${money(o.secondTranche)} once you hit their growth target.`),
    ),
    ...a.effects.map((e) => `  accepting: ${e}`),
    `  offers: ${standsText(a.daysLeft, a.lastDay)}; turned down, three new VCs approach in a few days, on less generous terms`,
    ...(v.negotiation ? [`  negotiation: ${standing(v.negotiation)}`, ...negotiationLines("vc", v.negotiation)] : []),
    rounds,
  ];
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
        `agency ${agencyPay}/day | severance ${severance} each${hiring}${p.idle ? ` | IDLE: ${p.idle}` : ""}`,
    );
  }
  return lines;
}

/** Every command that does something right now, with the values it takes. */
export function renderCommands(sim: Sim, state: GameState): string {
  const lines = ["commands (join several with ';'):"];
  const review = sim.payReview(state);
  if (review) {
    lines.push(
      `  pay   (the pay review in full; changes nothing)`,
      `  offer <${rise(review.minOffer)}–${rise(review.maxAsk)}> [pension=0-3] [health=0-3] [death=on] [discount=on] [shares=0-3]   (offer staff a pay rise, e.g. offer 3.5, or cash with schemes, e.g. offer 2.5 pension=1 death=on: the offer's worth to staff is within the range; they accept or counter with a roll; the third offer is final, and short of a deal goes to a tribunal)`,
      `  payodds <rise %> [schemes]   (what an offer would cost, its worth to staff, and the odds on staff's counter; changes nothing)`,
    );
    if (!review.final) {
      lines.push(
        `  autopay <rise %> [schemes]   (Auto-negotiate: the same offer as "offer", made again after each counter with the same rolls, until staff accept or only the final offer is left; it never goes to the tribunal)`,
      );
    }
    if (review.canAcceptCounter) lines.push(`  accept pay   (agree staff's counter of ${rise(review.staffFigure)})`);
  }
  // Moderators only on a product with user content. Only pools whose phase has opened can be hired into (#236).
  const jobs = sim.phase(state).open;
  const hirable = sim.staff(state).filter((p) => p.open).map((p) => p.pool).join("|");
  const pools = sim.staff(state).map((p) => p.pool).join("|");
  const grades = STAFF_GRADES.join("|");
  lines.push(
    `  hire <${hirable}> [agency] [${grades}] [n] | letgo <${pools}> [agency] [${grades}] [n] | move <to> [from] [${grades}]   ` +
      `(grade defaults to mid; permanent staff unless "agency"; move is permanent staff only)`,
  );
  const pay = sim.payments(state);
  if (!jobs.price) {
    // Hidden until Launch: the price is the fair price till then.
  } else if (pay) {
    const both = `<fee 0–${sim.config.pricing.maxPrice}> [transaction fee 0–${percent(pay.maxRate)}, e.g. 2.5%]`;
    if (sim.priceLockDaysLeft(state) === 0) lines.push(`  price ${both}   (one change sets both; the fee alone keeps today's rate)`);
    lines.push(`  preview ${both}   (what they would do; changes nothing)`);
  } else {
    if (sim.priceLockDaysLeft(state) === 0) lines.push(`  price <0.01–${sim.config.pricing.maxPrice}>`);
    lines.push(`  preview <price>   (what a price would do; changes nothing)`);
  }
  const notStarted = sim.features(state).filter((f) => f.status === "notStarted" && f.unlocked);
  if (jobs.features && notStarted.length) {
    const verb = state.model === "saas" ? "addon" : "build";
    lines.push(
      `  ${verb} <${notStarted.map((f) => f.id).join("|")}>   ${notStarted
        .map((f) => (state.model === "saas" ? `${f.id} ${money(f.addonSetupFee)} + ${price(f.addonPricePerUser)}/user/month` : `${f.id} ${f.devDays} dev-days`))
        .join(", ")}`,
    );
  }
  if (sim.launch(state).status === "ready") {
    lines.push(`  launch   (go live: your first users arrive at the end of the next day played; hosting bills start then)`);
  }
  lines.push(`  optimise <0–100>   (% of developer time on optimisation rather than features, once the MVP is done)`);
  const toUnlock = unlockable(sim, state);
  if (toUnlock.length) {
    const what = (i: (typeof toUnlock)[number]) =>
      `${i.id} ${i.rpPrice} RP (${i.kind === "feature" ? "feature" : i.model === state.model ? "model benefit" : `${sim.config.models[i.model!].name} benefit`})`;
    lines.push(
      `  unlock <${toUnlock.map((i) => i.id).join("|")}>   (research points; you have ${+state.researchPoints.toFixed(1)}) ${toUnlock.map(what).join(", ")}`,
    );
  }
  const campaigns = sim.campaigns(state);
  if (campaigns.canStart) {
    const each = campaigns.types.map((t) => `${t.id} £${t.usersPerPound > 0 ? (1 / t.usersPerPound).toFixed(2) : "∞"} a user now${t.running ? ` (${t.running} on it already)` : ""}`).join(", ");
    lines.push(
      `  campaign <${campaigns.types.map((t) => t.id).join("|")}> <budget £${campaigns.minBudget}–${campaigns.maxBudget}> <days ${campaigns.minDays}–${campaigns.maxDays}>   (spent evenly from tomorrow; brings users of that type: ${each})`,
    );
  } else if (campaigns.unlocked && campaigns.why) {
    lines.push(`  (no new campaign: ${campaigns.why})`);
  }
  const stoppable = campaigns.campaigns.filter((c) => c.status === "starting" || c.status === "running");
  if (stoppable.length) lines.push(`  stopcampaign <${stoppable.map((c) => c.id).join("|")}>   (stops it after today: the rest of its budget isn't spent)`);
  const buyable = sim.benefits(state).filter((b) => b.onModel && b.unlocked && !b.active);
  if (jobs.features && buyable.length) {
    lines.push(
      `  benefit <${buyable.map((b) => b.id).join("|")}>   ${buyable.map((b) => `${b.id} ${money(b.setupFee)} + ${money(b.monthlyFee)}/month: ${b.blurb}`).join("; ")}`,
    );
  }
  const active = sim.benefits(state).filter((b) => b.active);
  if (active.length) lines.push(`  dropbenefit <${active.map((b) => b.id).join("|")}>   (stops its monthly fee; no refund)`);
  if (sim.servers(state).some((x) => x.performance !== null)) {
    lines.push(
      `  slider <server id> <0–${Math.round(100 * sim.config.hardware.maxPerformance)}>   (% of normal capacity; power and upkeep follow it; above 100% risks overheating and crashes and wears it faster)`,
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
  if (jobs.api && api && !api.owned) {
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
    if (odds) lines.push(`  auto <${odds}> ...   (Auto-negotiate: the same terms as counter, repeated on each offer with the same rolls, to the final offer; it never accepts)`);
    if (odds) lines.push(`  odds <${odds}> ...   (the same terms as counter: the odds on the roll and each offer it could bring; changes nothing)`);
  }
  const investors = sim.investors(state);
  if (investors.offer) {
    const max = pct(sim.config.negotiation.maxAsk * 100);
    lines.push(`  angel   (the angel's offer in full: the valuation it sets, its target and what missing it costs; changes nothing)`);
    lines.push(`  accept angel | decline angel   (declining brings a new angel in a few days; accepting closes friends and family and grants)`);
    if (investors.negotiation?.countersLeft) {
      lines.push(`  counter angel [amount <£>] [share <%>]   (ask for more cash and/or a smaller share for them; up to ${max} better in all; the third offer is final)`);
      lines.push(`  odds angel ...   (the same terms as counter: the odds on the roll and each offer it could bring; changes nothing)`);
      lines.push(`  auto angel ...   (Auto-negotiate: the same terms as counter, repeated on each offer with the same rolls, to the final offer; it never accepts)`);
    }
  } else if (investors.angel) lines.push(`  angel   (your angel's deal and how their target stands; changes nothing)`);
  const vcApproach = investors.vc.approach;
  if (vcApproach) {
    const max = pct(sim.config.negotiation.maxAsk * 100);
    lines.push(`  vc   (the ${vcApproach.name} VCs' offers in full, and each round so far; changes nothing)`);
    if (!vcApproach.picked) {
      lines.push(`  pick <1-3|name>   (negotiate with one VC alone: the other two close)`);
      lines.push(`  decline vc   (turn all three down: three new VCs approach in a few days, on less generous terms)`);
    } else {
      lines.push(`  accept vc | decline vc   (accepting sets the valuation and makes them your lead VC; declining brings three new VCs in a few days)`);
      if (investors.vc.negotiation?.countersLeft) {
        lines.push(`  counter vc [amount <£>] [share <%>]   (ask for more cash and/or a smaller share for them; up to ${max} better in all; the third offer is final)`);
        lines.push(`  odds vc ...   (the same terms as counter: the odds on the roll and each offer it could bring; changes nothing)`);
        lines.push(`  auto vc ...   (Auto-negotiate: the same terms as counter, repeated on each offer with the same rolls, to the final offer; it never accepts)`);
      }
    }
  } else if (investors.vc.rounds[0]!.firstApproachDay !== null) lines.push(`  vc   (each Series round so far, and your lead VC; changes nothing)`);
  const rescue = sim.rescue(state);
  if (rescue) lines.push(`  rescue   (the rescue buyout in full: cash, share taken, cuts, the buy-back price; changes nothing)`);
  if (rescue?.buyBackPrice) {
    lines.push(`  buyback   (buy all the vulture VC's shares back from company cash: ${money(rescue.buyBackPrice)}${rescue.canBuyBack ? "" : ", more than your cash"})`);
  }
  const ipo = sim.ipo(state);
  if (jobs.ipo) lines.push(`  ipo   (the IPO readiness checklist in full, and once approved the offer; changes nothing)`);
  if (jobs.ipo && ipo.canApply) lines.push(`  apply   (apply to float: a small hidden chance of a cold market, less the more comfortably ready you are)`);
  if (ipo.offer) {
    const range = `${Math.round(ipo.offer.minFloat * 100)}-${Math.round(ipo.offer.maxFloat * 100)}`;
    lines.push(`  ring <${range}>   (float that % of the company in new shares and ring the opening bell: ENDS THE GAME)`);
  }
  const loan = sim.loan(state);
  if (loan?.remaining) lines.push(`  repayloan   (pay off the loan now: ${money(loan.payoff)}, saving ${money(loan.interestSaved)} interest)`);
  lines.push(`  costs   (the daily costs by heading, income over the last 7 days, and this week's one-offs; changes nothing)`);
  lines.push(`  calendar   (the holidays to come, their dates and what each does to your product)`);
  lines.push(`  payhistory   (every pay review settled: inflation, how it ended, the rise and schemes; changes nothing)`);
  lines.push(`  drift   (each year's end in a long game: running prices' rise and new kit's units; changes nothing)`);
  lines.push(`  csuite   (every C-suite role: when it opens, who's hired, and each open role's shortlist; changes nothing)`);
  if (sim.csuite(state).roles.some((r) => r.open && !r.executive)) {
    lines.push(`  appoint <candidate id>   (hire a candidate from an open role's shortlist, for good: their salary a day and equity in new shares)`);
  }
  const tick = sim.tickDays(state) === 7 ? "a week (this is a career)" : "a day";
  lines.push(
    `  next [days]   (play ticks of ${tick} until that many days have gone by, default 7; stops early, on the day, when something needs you)`,
  );
  lines.push(`  end   (as the teacher: end the game now, scored as it stands)`);
  return lines.join("\n");
}

/** A command the player typed, read into a sim action, a read-only request, or an advance. */
export type Command =
  /** `party`, for an investor's offer: the angel or the VC picked, checked against which is open. */
  | { kind: "action"; action: Action; times: number; party?: "angel" | "vc" }
  | { kind: "preview"; price: number; rate?: number }
  | { kind: "quote"; model: string }
  | { kind: "valuation" }
  | { kind: "market" }
  | { kind: "funding" }
  | { kind: "ipo" }
  | { kind: "odds"; funder: Party; terms: Partial<Terms> }
  | { kind: "angel" }
  | { kind: "vc" }
  | { kind: "pick"; which: string }
  | { kind: "rescue" }
  | { kind: "calendar" }
  | { kind: "pay" }
  | { kind: "payHistory" }
  | { kind: "drift" }
  | { kind: "costs" }
  | { kind: "csuite" }
  | { kind: "payOdds"; rise: number; schemes: Partial<SchemeLevels> }
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

/** A pay rise typed as a percent, "3.5%" or "3.5", as a share (0.035). */
const risePercent = (word: string | undefined) => number(word?.replace(/%$/, ""), "a pay rise in %") / 100;

/** Scheme levels in an offer: "pension=2 health=1 death=on discount=on"; "off" is 0. */
function schemeArgs(words: string[]): Partial<SchemeLevels> {
  const levels: Partial<SchemeLevels> = {};
  for (const word of words) {
    const [name, value] = word.split("=");
    const id = STAFF_SCHEMES.find((s) => SCHEME_WORDS[s] === name);
    if (!id || value === undefined) {
      throw new SimError("bad_command", `Expected a scheme and its level, such as pension=2 or death=on: one of ${STAFF_SCHEMES.map((s) => SCHEME_WORDS[s]).join(", ")}.`);
    }
    levels[id] = value === "on" ? 1 : value === "off" ? 0 : number(value, `a level for ${name}`);
  }
  return levels;
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
  // Commands are lower-cased, so a benefit's id is matched without case ("cdn", "reservedinstances").
  const benefitId = (w: string | undefined) => defaultConfig.tiers.benefits.find((b) => b.id.toLowerCase() === w)?.id ?? w ?? "";
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
  /** An answer to an investor's offer, checked against which is open when it runs. */
  const answer = (action: Action, party: "angel" | "vc"): Command => ({ kind: "action", action, times: 1, party });
  const funder = (w: string | undefined): Party => {
    if (w === "ff" || w === "friends" || w === "friendsandfamily") return "friendsAndFamily";
    if (w === "grant") return "grant";
    if (w === "angel") return "angel";
    if (w === "vc") return "vc";
    throw new SimError("bad_command", "Expected who the offer is from: ff (friends and family), grant, angel or vc.");
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
    case "optimise":
      return one({ type: "setOptimisation", share: number(args[0], "a percent") / 100 });
    case "benefit":
      return one({ type: "buyBenefit", benefit: benefitId(args[0]) });
    case "unlock":
      return one({ type: "unlockItem", item: benefitId(args[0]) });
    case "campaign":
      return one({
        type: "startCampaign",
        customerType: oneOf<CustomerTypeId>(args[0], CUSTOMER_TYPE_IDS, "a customer type"),
        budget: number(args[1]?.replace(/^£/, "").replace(/,/g, ""), "a budget"),
        days: number(args[2], "a length in days"),
      });
    case "stopcampaign":
      return one({ type: "stopCampaign", id: number(args[0], "a campaign id") });
    case "dropbenefit":
      return one({ type: "cancelBenefit", benefit: benefitId(args[0]) });
    case "slider":
      return one({ type: "setPerformance", id: number(args[0], "a server id"), performance: number(args[1], "a percent") / 100 });
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
    case "pay":
      return { kind: "pay" };
    case "payhistory":
      return { kind: "payHistory" };
    case "drift":
      return { kind: "drift" };
    case "costs":
      return { kind: "costs" };
    case "csuite":
      return { kind: "csuite" };
    case "appoint": {
      // Ids are typed lower-case: "headofops-2" is headOfOps-2.
      const [roleWord, place] = (args[0] ?? "").split("-");
      const role = CSUITE_ROLES.find((r) => r.toLowerCase() === roleWord);
      if (!role || !place) throw new SimError("bad_command", `Expected a candidate's id, such as cfo-2: see "csuite".`);
      return { kind: "action", action: { type: "hireExecutive", role, candidate: `${role}-${place}` }, times: 1 };
    }
    case "offer":
      return args.length > 1
        ? one({ type: "offerPayRise", rise: risePercent(args[0]), schemes: schemeArgs(args.slice(1)) })
        : one({ type: "offerPayRise", rise: risePercent(args[0]) });
    case "autopay":
      return args.length > 1
        ? one({ type: "autoNegotiatePay", rise: risePercent(args[0]), schemes: schemeArgs(args.slice(1)) })
        : one({ type: "autoNegotiatePay", rise: risePercent(args[0]) });
    case "payodds":
      return { kind: "payOdds", rise: risePercent(args[0]), schemes: schemeArgs(args.slice(1)) };
    case "accept": {
      if (args[0] === "pay") return one({ type: "acceptPayCounter" });
      const from = funder(args[0]);
      return isInvestor(from) ? answer({ type: "acceptInvestor" }, from) : one({ type: "acceptFunding", funder: from });
    }
    case "decline": {
      const from = funder(args[0]);
      return isInvestor(from) ? answer({ type: "declineInvestor" }, from) : one({ type: "declineFunding", funder: from });
    }
    case "angel":
      return { kind: "angel" };
    case "vc":
      return { kind: "vc" };
    case "pick":
      if (!args.length) throw new SimError("bad_command", "Expected which VC to pick: 1, 2 or 3, or their name.");
      return { kind: "pick", which: args.join(" ") };
    case "ipo":
      return { kind: "ipo" };
    case "apply":
      return one({ type: "applyForIpo" });
    case "ring":
      return one({ type: "ringBell", float: number(args[0], "a float percentage, 15 to 40") / 100 });
    case "counter": {
      const from = funder(args[0]);
      const asked = terms(args.slice(1));
      return isInvestor(from) ? answer({ type: "counterInvestor", terms: asked }, from) : one({ type: "counterFunding", funder: from, terms: asked });
    }
    case "auto": {
      const from = funder(args[0]);
      const asked = terms(args.slice(1));
      return isInvestor(from)
        ? answer({ type: "autoNegotiateInvestor", terms: asked }, from)
        : one({ type: "autoNegotiateFunding", funder: from, terms: asked });
    }
    case "odds":
      return { kind: "odds", funder: funder(args[0]), terms: terms(args.slice(1)) };
    case "launch":
      return one({ type: "launch" });
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

/**
 * The preview's ticket burst against today's support (#163): what the extra tickets come to and whether support clears
 * them. Empty when the change brings none and nothing waits.
 */
function ticketsLine(t: TicketOutlook): string {
  if (t.tickets === 0 && t.canClear) return "";
  const support = `support clears ${t.clearance}/day, usual ${t.usualTickets}/day`;
  const verdict = t.canClear
    ? "support clears them as they come"
    : t.waitingAfter === 0
      ? `support falls behind: up to ${t.peakWaiting} extra waiting, cleared by the end`
      : `support can't keep up: up to ${t.peakWaiting} extra waiting, ${t.waitingAfter} still waiting after`;
  return `; +${t.tickets} tickets (busiest day +${t.peakDay}; ${support}): ${verdict}`;
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
          ticketsLine(p.tickets) +
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
  if (command.kind === "odds") {
    const odds =
      isInvestor(command.funder) ? sim.investorCounterOdds(state, checkParty(sim, state, command.funder, command.terms)) : sim.counterOdds(state, command.funder, command.terms);
    return { state, rows: [], lines: oddsLines(command.funder, odds) };
  }
  if (command.kind === "angel") return { state, rows: [], lines: angelLines(sim, state) };
  if (command.kind === "vc") return { state, rows: [], lines: vcLines(sim, state) };
  if (command.kind === "pick") return runCommand(sim, state, { kind: "action", action: { type: "pickInvestor", investor: vcNamed(sim, state, command.which) }, times: 1 }, who);
  if (command.kind === "rescue") return { state, rows: [], lines: rescueLines(sim, state) };
  if (command.kind === "calendar") return { state, rows: [], lines: calendarLines(sim, state) };
  if (command.kind === "pay") return { state, rows: [], lines: payLines(sim, state) };
  if (command.kind === "payHistory") return { state, rows: [], lines: payHistoryLines(sim, state) };
  if (command.kind === "drift") return { state, rows: [], lines: driftLines(sim, state) };
  if (command.kind === "costs") return { state, rows: [], lines: costsLines(sim, state) };
  if (command.kind === "csuite") return { state, rows: [], lines: csuiteLines(sim, state) };
  if (command.kind === "payOdds") return { state, rows: [], lines: payOddsLines(sim.payOfferPreview(state, command.rise, command.schemes)) };
  if (command.kind === "end") {
    const ended = sim.endGame(state);
    // Logged as the classroom server logs a game the teacher ends.
    const row = logRow(sim, ended, who, "end", { status: ended.status, endedBy: "teacher" });
    return { state: ended, rows: [row], lines: [`GAME OVER: ended by the teacher on day ${ended.day}`] };
  }
  if (command.kind !== "action") throw new Error("Advance with advanceUntil.");
  if (command.party) {
    try {
      checkParty(sim, state, command.party);
    } catch (err) {
      if (!(err instanceof SimError)) throw err;
      const row = logRow(sim, state, who, command.action.type, actionParams(command.action), err.code);
      return { state, rows: [row], lines: [`${command.action.type} refused: ${err.message}`] };
    }
  }
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
  if (command.action.type === "counterInvestor") return { state: current, rows, lines: [counterLine(sim, current, command.party ?? "angel")] };
  if (command.action.type === "autoNegotiateFunding") return { state: current, rows, lines: autoLines(sim, state, current, command.action.funder) };
  if (command.action.type === "autoNegotiateInvestor") return { state: current, rows, lines: autoLines(sim, state, current, command.party ?? "angel") };
  if (command.action.type === "autoNegotiatePay") return { state: current, rows, lines: autoPayLines(sim, state, current) };
  if (command.action.type === "pickInvestor") {
    return { state: current, rows, lines: [`pickInvestor: negotiating with ${command.action.investor}; the other two VCs have closed. "vc" for their offer in full.`] };
  }
  if (command.action.type === "acceptInvestor" && state.investors.vc.approach) {
    const deal = sim.investors(current).vc.rounds.find((r) => r.round === state.investors.vc.approach!.round)!.deal!;
    return {
      state: current,
      rows,
      lines: [
        `acceptInvestor: done. ${deal.investor} put in ${money(deal.amount)} for ${stake(deal.share)} in your ${ROUND_NAMES[deal.round]}${trancheText(deal.tranche)}; valuation now ${money(sim.valuation(current).valuation)}. They're your lead VC.`,
      ],
    };
  }
  if (command.action.type === "offerPayRise" || command.action.type === "acceptPayCounter") {
    return { state: current, rows, lines: [payResultLine(sim, state, current)] };
  }
  if (command.action.type === "acceptInvestor") {
    const a = sim.investors(current).angel!;
    return {
      state: current,
      rows,
      lines: [
        `acceptInvestor: done. ${a.investor} put in ${money(a.amount)} for ${stake(a.share)}; valuation now ${money(sim.valuation(current).valuation)}. Target, both by day ${a.target.byDay}: ${money(a.target.dailyRevenue)}/day over ${a.target.days} days, and ${a.target.netUsers.toLocaleString("en-GB")} users net (gained less lost) from today.`,
      ],
    };
  }
  return { state: current, rows, lines: [`${command.action.type}${command.times > 1 ? ` ×${done}` : ""}: done${paid}`] };
}

/**
 * Refuses an answer to the angel while VCs are waiting, or to a VC while none is: the sim's investor actions answer
 * whichever is open. Returns the terms unchanged, for odds.
 */
function checkParty<T>(sim: Sim, state: GameState, party: "angel" | "vc", passed?: T): T {
  const vcOpen = sim.investors(state).vc.approach !== null;
  if (party === "vc" && !vcOpen) throw new SimError("no_approach", "No VCs are waiting on an answer: they come to companies that grow.");
  if (party === "angel" && vcOpen) throw new SimError("no_approach", "It's VCs who are waiting on an answer, not an angel: use vc.");
  return passed as T;
}

/** A VC in the open approach, by number (1–3) or the start of their name. */
function vcNamed(sim: Sim, state: GameState, which: string): string {
  const offers = sim.investors(state).vc.approach?.offers ?? [];
  const n = Number(which);
  const found = Number.isInteger(n) ? offers[n - 1] : offers.find((o) => o.investor.toLowerCase().startsWith(which.toLowerCase()));
  if (!found) {
    throw new SimError("bad_command", offers.length ? `Expected 1-${offers.length} or the name of one of: ${offers.map((o) => o.investor).join(", ")}.` : "No VCs are waiting on an answer.");
  }
  return found.investor;
}

/** What a counter's roll did, and the offer that stands now. */
function counterLine(sim: Sim, state: GameState, funder: Party): string {
  const n = isInvestor(funder) ? (funder === "vc" ? sim.investors(state).vc.negotiation! : sim.investors(state).negotiation!) : sim.funding(state).negotiations[funder]!;
  const round = n.rounds.at(-1)!;
  return `counter ${termsText(funder, round.counter)}: ${rollText(round)}. Offer ${n.offers.length}: ${termsText(funder, n.offers.at(-1)!)}${n.final ? " (final: accept or decline)" : ` (${n.countersLeft} counter left)`}`;
}

const negotiationOf = (sim: Sim, state: GameState, party: Party) =>
  isInvestor(party) ? (party === "vc" ? sim.investors(state).vc.negotiation! : sim.investors(state).negotiation!) : sim.funding(state).negotiations[party]!;

/** What Auto-negotiate played: each round's roll and the offer it brought, ending on the offer that stands. */
function autoLines(sim: Sim, before: GameState, after: GameState, party: Party): string[] {
  const n = negotiationOf(sim, after, party);
  const from = negotiationOf(sim, before, party).rounds.length;
  const rounds = n.rounds.slice(from).map(
    (r, k) => `  offer ${from + k + 2}: you asked ${termsText(party, r.counter)}, ${rollText(r)} → ${termsText(party, n.offers[from + k + 1]!)}`,
  );
  const end = n.final
    ? `their FINAL offer stands: ${termsText(party, n.offers.at(-1)!)} (accept or decline it; auto-negotiate never accepts)`
    : `they've met your figure: ${termsText(party, n.offers.at(-1)!)} stands (accept, decline, or counter again)`;
  return [`auto-negotiated ${rounds.length} round${rounds.length === 1 ? "" : "s"}:`, ...rounds, `  ${end}`];
}

/** What Auto-negotiate did in a pay review: each offer and staff's answer, then settled or staff's last counter. */
function autoPayLines(sim: Sim, before: GameState, after: GameState): string[] {
  const from = before.payReview!.studentOffers.length;
  const review = sim.payReview(after);
  const record = review ? null : after.pastPayReviews.at(-1)!;
  const offers = review?.studentOffers ?? record!.studentOffers;
  const terms = review?.offerTerms ?? record!.offerTerms;
  const figures = review?.staffFigures ?? record!.staffFigures;
  const lines = ["auto-negotiated the pay review:"];
  for (let i = from; i < offers.length; i++) {
    const answer = figures[i + 1] === undefined ? "staff accepted" : `staff counter ${rise(figures[i + 1]!)}${review ? `, ${rollText(review.rounds[i]!)}` : ""}`;
    lines.push(`  offer ${i + 1}: ${offerText(sim, before, terms[i]!, offers[i]!)} → ${answer}`);
  }
  if (!review) return [...lines, `  ${payResultLine(sim, before, after)}`];
  lines.push(
    `  it stops on staff's last counter of ${rise(review.staffFigure)}: "accept pay" to agree it, or make your FINAL offer ("offer ...") ` +
      `and short of a deal it goes to a TRIBUNAL for ${money(review.tribunalFee)}. Auto-negotiate never goes to the tribunal`,
  );
  return lines;
}

/** A counter's odds, before it's made. */
function oddsLines(funder: Party, o: CounterOdds): string[] {
  const chance = (x: number) => pct(x * 100);
  return [
    `counter ${termsText(funder, o.counter)} asks ${pct(o.ask * 100)} better (most ${pct(o.maxAsk * 100)}): −${o.penalty} on the roll${o.bonus ? `, +${o.bonus} bonus` : ""}`,
    `  high ${chance(o.chances.high)} → ${termsText(funder, o.outcomes.high)}`,
    `  middle ${chance(o.chances.middle)} → ${termsText(funder, o.outcomes.middle)}`,
    `  low ${chance(o.chances.low)} → ${termsText(funder, o.outcomes.low)}`,
  ];
}

/** A negotiation so far, if the student has countered: each offer and the roll that came after it. */
function negotiationLines(funder: Party, n: NegotiationView | null): string[] {
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
      if (current.status !== "playing" && !["valuation", "funding", "rescue", "ipo", "market", "costs"].includes(command.kind)) {
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
  } else if (!f.friendsAndFamily) {
    lines.push(`friends and family: closed on day ${f.closedDay}, when you took on your ${closedBy(state).replace(/^an? /, "")}`);
  } else {
    const t = f.friendsAndFamily;
    lines.push(`friends and family: ${t.status} on day ${t.day}${t.status === "accepted" ? `, ${money(t.amount)} for ${t.shares.toLocaleString("en-GB")} shares` : ""}`);
  }
  const g = f.grantOffer;
  if (g) {
    lines.push(
      `grant (accept grant): ${money(g.amount)}, no shares. ${g.condition} ${g.ifMissed} Negotiation: ${standing(f.negotiations.grant!)}.`,
      ...negotiationLines("grant", f.negotiations.grant),
    );
  }
  else if (!f.grant) lines.push(`grant: closed on day ${f.closedDay}, when you took on your ${closedBy(state).replace(/^an? /, "")}`);
  else {
    const t = f.grant;
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
 * Log entry kinds worth showing every day they appear, loan notes included (a loan taken, a shortfall put on it, a
 * loan repaid). Feature, migration and API entries show only on days they stop time.
 */
const SHOWN_KINDS = new Set(["outage", "event", "rescue", "liquidation", "finished", "support", "price", "launch", "staff", "funding", "danger", "calendar", "rival", "drift", "loan"]);
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
