import {
  MIGRATION_PHASES,
  RACK_SIZES,
  type GameConfig,
  type MigrationPhase,
  type ModelId,
  type RackSize,
} from "./config.ts";
import type { Benefits } from "./benefits.ts";
import type { Events } from "./events.ts";
import type { Features } from "./features.ts";
import type { Infrastructure } from "./infrastructure.ts";
import { migrationShare } from "./executives.ts";
import { pounds } from "./finance.ts";
import { nextRandom } from "./rng.ts";
import type { Servers, SetupItem } from "./servers.ts";
import { dailyStaffCost } from "./staff.ts";
import { isModelId, SimError, type GameState, type LogEntry, type Migration, type Server, type UnitDemand } from "./state.ts";

/** Where a migration has got to, for the screen. */
export interface MigrationView {
  from: ModelId;
  to: ModelId;
  phase: MigrationPhase;
  /** Days left in the current phase. */
  phaseDaysLeft: number;
  /** Days until the model switches. */
  daysLeft: number;
  /** Days the whole migration takes, overrun included. */
  totalDays: number;
  /** Extra days from an overrun, included in the days above. 0 if it hasn't overrun (or not yet). */
  overrunDays: number;
  /**
   * The setup being built on the new model, by type and size: billed alongside the old one until the switch, when it
   * takes over. Empty moving to SaaS, which has no servers.
   */
  setup: SetupItem[];
  /** What the new setup costs a month, after any price rises: rent, or bought kit's power and upkeep. */
  setupMonthly: number;
}

/**
 * What a migration is expected to cost, for the student to see before confirming. Every charge in it is
 * infrastructure. Charges with a per-user part are priced at today's users, as they are billed on each day's users;
 * with no overrun and no per-user fees, the quote is exactly what gets charged.
 */
export interface MigrationQuote {
  from: ModelId;
  to: ModelId;
  /** Days the migration takes if it doesn't overrun. The model switches at the end of the last one. */
  days: number;
  /**
   * The setup the migration builds on the new model, itemised by type and size: sized to today's usual demand plus
   * headroom. Empty moving to SaaS, which has no servers.
   */
  setup: SetupItem[];
  /** The demand the setup is sized for: today's usual CU and DBU, plus the headroom. */
  sizedFor: UnitDemand;
  /** The headroom on top of today's demand (0.25 = 25%). */
  headroom: number;
  /** What buying the setup costs, on a model that buys its servers: part of the upfront cost. 0 where it's rented. */
  setupUpfront: number;
  /**
   * The racks the setup goes in, by size, on a model with racks (on-prem): the server room's own and any more it
   * needs, bought with the upfront cost. Empty on any other model.
   */
  racks: SetupRack[];
  /** Cabling for the setup's servers and racks, part of the upfront cost. 0 where servers are rented. */
  cabling: number;
  /** What the setup costs a month: rent, or bought kit's power and upkeep. Part of the double billing. */
  setupMonthly: number;
  /** Ops staff the new model needs once the setup takes over: its fixed number plus the setup's servers' shares. */
  opsNeeded: number;
  /**
   * Days bought kit takes to arrive, on a model that buys its servers: it's ordered on the first day, so it arrives
   * during the move if this is shorter than it. Null where the setup is rented.
   */
  deliveryDays: number | null;
  /** The new model's upfront cost and the setup's kit, if it buys it, charged on the migration's first day. */
  upfrontCost: number;
  /**
   * The new provider's running costs for every day of the migration, on top of the old one's: its own monthly and
   * per-user fees and the new setup's servers (bought kit from the day after it arrives).
   */
  doubleBilling: number;
  /** The old provider's running costs, its servers included, from the first day of the migration up to the day you leave. */
  proRata: number;
  /** Charged once by the old provider on the day you leave. */
  exitPenalty: number;
  /** What the old setup's bought kit sells back for on the day you leave (a refund): 0 where it's rented. */
  sellBack: number;
  /** Everything above added up, less the sell-back. */
  total: number;
  /** The odds of an overrun and how many extra days it can add. Both providers bill for those days too. */
  overrun: { chance: number; minDays: number; maxDays: number };
  /**
   * Vendor lock-in: the add-ons you'd leave behind with the SaaS provider, in config order, and the developer-days
   * each takes to rebuild. Empty unless leaving SaaS. These are today's; any bought before you leave go too.
   */
  lostAddons: LostAddon[];
  /**
   * The model benefits on now, which a migration loses with no refund: the tiers and unlocks are kept, so the new
   * model's own already unlocked can be bought straight away. These are today's; any bought before you leave go too.
   */
  lostBenefits: { id: string; name: string }[];
  /** Cash left once it's all paid, before any income: today's cash less the total. Below 0, it can't be paid. */
  cashLeft: number;
  /**
   * A warning when the cash left would cover less than lowCashDays of today's running costs (staff and the current
   * bill), or none. Migrating that short of cash is how companies run out of cash mid-move.
   */
  warning: string | null;
}

/** Racks of one size a migration's setup goes in. */
export interface SetupRack {
  size: RackSize;
  count: number;
  /** What they cost to buy, all together. */
  upfront: number;
}

/** Days of running costs a migration should leave in the bank: with less, its quote warns. */
const LOW_CASH_DAYS = 30;

/** An add-on that won't come with you when you leave SaaS. */
export interface LostAddon {
  id: string;
  name: string;
  /** Developer-days to build it yourself on the new model. */
  devDays: number;
}

/** Migration: moving from one deployment model to another through the configured phases, and what it costs. */
export function createMigration(
  config: GameConfig,
  infra: Infrastructure,
  features: Features,
  events: Events,
  servers: Servers,
  benefits: Benefits,
) {
  /**
   * A setup in words: "1 medium app server, 1 medium database", or on a managed platform "2 app instances, 1 small
   * managed database".
   */
  const setupList = (state: GameState, model: ModelId, list: Server[]) =>
    servers
      .setupItems(state, model, list)
      .map((item) => {
        const plural = item.count === 1 ? "" : "s";
        if (servers.isManaged(model) && item.type === "app") return `${item.count} app instance${plural}`;
        if (servers.isManaged(model) && item.type === "api") return `${item.count} API instance${plural}`;
        // "API" keeps its capitals mid-sentence.
        const name = item.type === "api" ? item.name : item.name.toLowerCase();
        return `${item.count} ${item.size} ${name}${plural}`;
      })
      .join(", ");

  /** Checks a migration to this model can start, and returns it as a model id. */
  function migrationTarget(state: GameState, to: string): ModelId {
    if (!isModelId(to)) throw new SimError("unknown_model", "Pick a deployment model from the list.");
    if (state.migration) {
      const { name } = config.models[state.migration.to];
      throw new SimError("migration_running", `You're already migrating to ${name}. Finish that first.`);
    }
    if (to === state.model) throw new SimError("same_model", `You're already on ${config.models[to].name}.`);
    return to;
  }

  /**
   * Starts a migration, building the target model's setup at once, sized to today's usual demand plus headroom (see
   * sizeSetupFor): rented servers on the model's usual terms, bought kit ordered today and paid for on the first day.
   */
  function startMigration(state: GameState, model: string): GameState {
    const started = planMigration(state, model);
    // The upfront bill lands on the first day, so a migration that costs more up front than the company has is
    // refused rather than running it out of cash.
    const upfront = upfrontCostOf(state, started.migration!);
    if (upfront > state.cash) {
      throw new SimError(
        "cant_afford",
        `Moving to ${config.models[started.migration!.to].name} costs ${pounds(upfront)} up front and you have ${pounds(state.cash)}.`,
        { cost: upfront, cash: state.cash },
      );
    }
    return started;
  }

  /** The migration as it would start, without checking it can be paid for. */
  function planMigration(state: GameState, model: string): GameState {
    const to = migrationTarget(state, model);
    const setup = servers.setupFor(state, to, infra.usualDemand(state, to));
    const migration: Migration = {
      to,
      phase: MIGRATION_PHASES[0],
      phaseDaysDone: 0,
      overrunDays: 0,
      servers: setup.servers,
      racks: setup.racks,
    };
    return { ...state, nextServerId: setup.nextServerId, nextRackId: setup.nextRackId, migration };
  }

  /**
   * What a migration costs, worked out by starting it and pricing each of its days by the same rules a day is billed
   * by, so the rounding matches too, and bought kit costs its upkeep only once it has arrived, as it's billed.
   */
  function migrationQuote(state: GameState, target: string): MigrationQuote {
    const started = planMigration(state, target);
    const m = started.migration!;
    const to = m.to;
    const days = MIGRATION_PHASES.reduce((sum, p) => sum + plannedDays(state, p), 0);
    const upfrontCost = upfrontCostOf(state, m);
    let doubleBilling = 0;
    let proRata = 0;
    for (let d = 0; d < days; d++) {
      const day = { ...started, day: state.day + d };
      doubleBilling -= newSetupEntries(day).reduce((sum, e) => sum + e.cashDelta, 0);
      proRata += infra.dailyInfrastructure(day, state.model, state.users);
    }
    const exitPenalty = exitPenaltyOf(state);
    const sellBack = servers.sellBackTotal(state);
    const setup = servers.setupItems(started, to, m.servers);
    const room = config.migration.setupHeadroom;
    const usual = infra.usualDemand(state, to);
    const tidy = (n: number) => Math.round(n * 100) / 100;
    const { chance, minDays, maxDays } = config.migration.overrun;
    const lostAddons = features.addonsLeftBehind(state, to).map(({ id, name, devDays }) => ({ id, name, devDays }));
    const lostBenefits = benefits.benefitsLostTo(state, to).map(({ id, name }) => ({ id, name }));
    const total = upfrontCost + doubleBilling + proRata + exitPenalty - sellBack;
    const cashLeft = state.cash - total;
    const staffDaily = dailyStaffCost(config, state);
    const running = staffDaily + infra.dailyInfrastructure(state, state.model, state.users) + features.dailyAddonCost(state);
    const lowCash = running * LOW_CASH_DAYS;
    const warning =
      cashLeft < 0
        ? `You can't afford this: it costs ${pounds(total)} and you have ${pounds(state.cash)}.`
        : cashLeft < lowCash
          ? `This would leave you ${pounds(cashLeft)}, about ${Math.floor(cashLeft / Math.max(1, running))} days of running costs before any income. ` +
            `Migrating this short of cash is how companies run out of cash mid-move: take the bank loan first, or wait until you have more.`
          : null;
    return {
      from: state.model,
      to,
      days,
      setup,
      sizedFor: {
        cu: tidy(usual.cu * (1 + room)),
        dbu: tidy(usual.dbu * (1 + room)),
        ...(usual.apiu !== undefined && { apiu: tidy(usual.apiu * (1 + room)) }),
      },
      headroom: room,
      setupUpfront: setup.reduce((sum, item) => sum + item.upfront, 0),
      racks: RACK_SIZES.flatMap((size) => {
        const of = m.racks.filter((r) => r.size === size);
        return of.length ? [{ size, count: of.length, upfront: of.reduce((sum, r) => sum + r.paid, 0) }] : [];
      }),
      cabling: infra
        .upfrontEntries(to, m)
        .reduce((sum, e) => sum - (e.category === "cabling" ? e.cashDelta : 0), 0),
      setupMonthly: Math.round(setup.reduce((sum, item) => sum + item.monthly, 0)),
      opsNeeded: servers.opsFor(to, m.servers),
      deliveryDays: config.models[to].servers?.purchase && setup.length ? servers.readyDaysOf(to) : null,
      upfrontCost,
      doubleBilling,
      proRata,
      exitPenalty,
      sellBack,
      total,
      overrun: { chance, minDays, maxDays },
      lostAddons,
      lostBenefits,
      cashLeft,
      warning,
    };
  }

  /**
   * A day's bill for the new model during a migration, on top of the old one's: its own monthly cost and per-user
   * fees (the flat bill a model has had since the alpha), and the servers of the setup being built, one line per type
   * and size like any server bill. The setup's servers are only ever billed here: the model's own monthly cost is
   * the account, not servers, so nothing is counted twice. Rented servers are billed from the first day, bought kit
   * from the day after it arrives.
   */
  const newSetupEntries = (state: GameState): LogEntry[] =>
    state.migration
      ? infra
          .infrastructureEntries(state, state.migration.to, state.users)
          .map((e) => ({ ...e, text: `Double billing: ${e.text}` }))
      : [];

  /**
   * The migration's own charges for a day, on top of the current model's bill: on the first day the new model's
   * upfront cost and any kit the new setup buys, and every day the new model's bill, so you pay for both setups.
   */
  function migrationCharges(state: GameState): LogEntry[] {
    const m = state.migration;
    if (!m) return [];
    const firstDay = m.phase === MIGRATION_PHASES[0] && m.phaseDaysDone === 0;
    return [...(firstDay ? upfrontEntries(state, m) : []), ...newSetupEntries(state)];
  }

  /** A seeded roll for whether a migration overruns, and by how many days. Always draws once, then again if so. */
  function rollOverrun(rng: number): [days: number, next: number] {
    const { chance, minDays, maxDays } = config.migration.overrun;
    const [r, afterChance] = nextRandom(rng);
    if (r >= chance) return [0, afterChance];
    const [d, next] = nextRandom(afterChance);
    return [minDays + Math.floor(d * (maxDays - minDays + 1)), next];
  }

  /** A phase's planned days: the configured days, cut by a CIO's share to the nearest day, but never below 1. */
  const plannedDays = (state: GameState, phase: MigrationPhase) => {
    const days = config.migration.phases[phase].days;
    return days > 0 ? Math.max(1, Math.round(days * migrationShare(config, state))) : 0;
  };

  /** How long a phase of this migration takes: its planned days, plus any overrun on the moving phase. */
  function phaseLength(state: GameState, m: Migration, phase: MigrationPhase): number {
    return plannedDays(state, phase) + (phase === "moving" ? m.overrunDays : 0);
  }

  /** A migration's upfront bill, the new model's own and its setup's kit, cut by a CIO's share. */
  const upfrontEntries = (state: GameState, m: Migration): LogEntry[] => {
    const share = migrationShare(config, state);
    const entries = infra.upfrontEntries(m.to, m);
    return share === 1 ? entries : entries.map((e) => ({ ...e, cashDelta: Math.round(e.cashDelta * share) }));
  };
  const upfrontCostOf = (state: GameState, m: Migration) => -upfrontEntries(state, m).reduce((sum, e) => sum + e.cashDelta, 0);

  /** The exit penalty for leaving the current model, cut by a CIO's share. */
  const exitPenaltyOf = (state: GameState) => Math.round(config.models[state.model].exitPenalty * migrationShare(config, state));

  function migration(state: GameState): MigrationView | null {
    const m = state.migration;
    if (!m) return null;
    const later = MIGRATION_PHASES.slice(MIGRATION_PHASES.indexOf(m.phase) + 1);
    const phaseDaysLeft = phaseLength(state, m, m.phase) - m.phaseDaysDone;
    const daysLeft = later.reduce((sum, p) => sum + phaseLength(state, m, p), phaseDaysLeft);
    const totalDays = MIGRATION_PHASES.reduce((sum, p) => sum + phaseLength(state, m, p), 0);
    const { overrunDays } = m;
    const setup = servers.setupItems(state, m.to, m.servers);
    const setupMonthly = Math.round(setup.reduce((sum, item) => sum + item.monthly, 0));
    return { from: state.model, to: m.to, phase: m.phase, phaseDaysLeft, daysLeft, totalDays, overrunDays, setup, setupMonthly };
  }

  /**
   * A day's work on the migration, after the day has been played and billed on the current model. Moves to the next
   * phase when one ends, logging it, and switches the model when the last one ends.
   */
  function migrationDay(state: GameState): { state: GameState; entries: LogEntry[] } {
    const m = state.migration;
    if (!m) return { state, entries: [] };
    const toName = config.models[m.to].name;
    const phaseDaysDone = m.phaseDaysDone + 1;
    if (phaseDaysDone < phaseLength(state, m, m.phase)) {
      return { state: { ...state, migration: { ...m, phaseDaysDone } }, entries: [] };
    }
    const done = config.migration.phases[m.phase].name;
    const next = MIGRATION_PHASES[MIGRATION_PHASES.indexOf(m.phase) + 1];
    if (next) {
      // Migrations slip while moving: roll for an overrun as that phase starts.
      const [extraDays, rng] = next === "moving" ? rollOverrun(state.rng) : [0, state.rng];
      const moved: Migration = { ...m, phase: next, phaseDaysDone: 0, overrunDays: m.overrunDays + extraDays };
      const days = phaseLength(state, moved, next);
      const nextName = config.migration.phases[next].name;
      const text = `Migration to ${toName}: ${done} done. ${nextName} next, ${days} day${days === 1 ? "" : "s"}.`;
      const entries: LogEntry[] = [{ text, cashDelta: 0, kind: "migration" }];
      if (extraDays > 0) {
        const extra = `${extraDays} extra day${extraDays === 1 ? "" : "s"}`;
        const overrun = `Migration overrun: ${nextName.toLowerCase()} will take ${extra}, billed by both providers.`;
        entries.push({ text: overrun, cashDelta: 0, kind: "migration" });
      }
      return { state: { ...state, rng, migration: moved }, entries };
    }
    // The new setup takes over, serving from tomorrow, and capacity and ops are worked out on it from now. The old
    // setup goes: rented servers are cancelled, having been billed up to and including today (pro rata, like the
    // model's own bill), and bought kit is sold back at a loss. SaaS has no servers, so moving there drops them all
    // and capacity is the provider's. Bought kit for the new setup was ordered on the first day, so with the default
    // 7-day delivery inside a 14-day move it has arrived; an overrun only makes the move longer. If a teacher sets a
    // delivery longer than the move, kit still on order arrives later and serves from then.
    const switched: GameState = {
      ...state,
      model: m.to,
      migration: null,
      migrations: state.migrations + 1,
      servers: m.servers,
      racks: m.racks,
    };
    const needed = infra.opsNeededNow(switched);
    const left = config.models[state.model];
    const entries: LogEntry[] = [
      {
        text: `Migration complete: you're now on ${toName}, which needs ${needed} ops staff.`,
        cashDelta: 0,
        kind: "migration",
      },
    ];
    entries.push(...servers.leaveEntries(state));
    if (m.servers.length) {
      const onOrder = m.servers.filter((s) => s.readyDay > state.day).length;
      const late = onOrder > 0 ? ` ${onOrder} still on order, serving once ${onOrder === 1 ? "it arrives" : "they arrive"}.` : "";
      const text = `Your new ${toName} setup takes over tomorrow: ${setupList(state, m.to, m.servers)}.${late} Fine-tune its sizes on Infrastructure as you grow.`;
      entries.push({ text, cashDelta: 0, kind: "migration" });
    }
    // Charged once, on the day you leave. The old provider's pro-rata share for today was billed with the rest.
    const exitPenalty = exitPenaltyOf(state);
    if (exitPenalty > 0) {
      const text = `Exit penalty: leaving ${left.name}`;
      entries.push({ text, cashDelta: -exitPenalty, category: "infrastructure" });
    }
    // Vendor lock-in. Add-ons belong to the SaaS provider, so they stay active and billed for the whole migration
    // (you're still on SaaS, paying for both setups) and are left behind on the day you leave: billing and their
    // growth effect stop, and they're not started again, ready to rebuild in developer-days from zero.
    const lost = features.addonsLeftBehind(state, m.to);
    if (lost.length) {
      const kept = { ...state.features };
      for (const f of lost) delete kept[f.id];
      switched.features = kept;
      const names = lost.map((f) => f.name).join(", ");
      const devDays = lost.reduce((sum, f) => sum + f.devDays, 0);
      const text =
        `Vendor lock-in: your add-ons stayed with the SaaS provider (${names}). ` +
        `Rebuild them in developer-days to get them back: ${devDays} in all.`;
      entries.push({ text, cashDelta: 0, kind: "migration" });
    }
    // Model benefits belong to the model being left, so they go with it: billing stops, with no refund. The tiers and
    // the unlocks belong to the company, so the new model's benefits already unlocked can be bought straight away.
    const lostBenefits = benefits.benefitsLostTo(state, m.to);
    if (lostBenefits.length) {
      switched.benefits = [];
      const names = lostBenefits.map((b) => b.name).join(", ");
      const text = `Model benefits lost: ${names} stayed with ${left.name}, with no refund. Your unlocks are kept, so any of this model's own benefits you've unlocked can be bought on Infrastructure straight away.`;
      entries.push({ text, cashDelta: 0, kind: "migration" });
    }
    // Off the model a feature gap is tied to, you can build what you like, so the gap closes.
    const closed = state.featureGaps.filter((g) => g.model === state.model);
    if (closed.length) {
      switched.featureGaps = state.featureGaps.filter((g) => g.model !== state.model);
      for (const g of closed) {
        const feature = events.gapFeature(state, g);
        if (feature === undefined) continue;
        const text = `Feature gap closed: off ${left.name}, you're free to build ${feature} yourself. Growth is back to normal.`;
        entries.push({ text, cashDelta: 0, kind: "migration" });
      }
    }
    // Onto SaaS, a build under way pauses: developers there configure add-ons rather than build.
    const paused = m.to === "saas" ? features.currentBuild(state) : undefined;
    if (paused) {
      const text = `${paused.name} build paused: on SaaS you buy features as add-ons. It carries on if you leave SaaS.`;
      entries.push({ text, cashDelta: 0, kind: "feature" });
    }
    return { state: switched, entries };
  }

  return { startMigration, migrationQuote, migrationCharges, newSetupEntries, migration, migrationDay };
}
