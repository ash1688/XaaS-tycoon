import { MIGRATION_PHASES, type GameConfig, type MigrationPhase, type ModelId } from "./config.ts";
import type { Events } from "./events.ts";
import type { Features } from "./features.ts";
import type { Infrastructure } from "./infrastructure.ts";
import { nextRandom } from "./rng.ts";
import type { Servers } from "./servers.ts";
import { isModelId, SimError, type GameState, type LogEntry, type Migration } from "./state.ts";

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
  /** The new model's upfront cost, with any starter kit it buys, charged on the migration's first day. */
  upfrontCost: number;
  /** The new provider's running costs for every day of the migration, on top of the old one's. */
  doubleBilling: number;
  /** The old provider's running costs from the first day of the migration up to the day you leave. */
  proRata: number;
  /** Charged once by the old provider on the day you leave. */
  exitPenalty: number;
  /** Everything above added up. */
  total: number;
  /** The odds of an overrun and how many extra days it can add. Both providers bill for those days too. */
  overrun: { chance: number; minDays: number; maxDays: number };
  /**
   * Vendor lock-in: the add-ons you'd leave behind with the SaaS provider, in config order, and the developer-days
   * each takes to rebuild. Empty unless leaving SaaS. These are today's; any bought before you leave go too.
   */
  lostAddons: LostAddon[];
}

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
) {
  /**
   * A model's starter setup in words: "1 medium app server, 1 medium database", or on a managed platform "1 app
   * instance, 1 small managed database".
   */
  const modelServersList = (model: ModelId) => {
    const managed = servers.isManaged(model);
    return config.models[model].servers?.starter
      .filter((s) => s.count > 0)
      .map((s) => {
        const plural = s.count === 1 ? "" : "s";
        if (managed && s.type === "app") return `${s.count} app instance${plural}`;
        return `${s.count} ${s.size} ${(managed ? servers.managedName(s.type) : config.servers.types[s.type].name).toLowerCase()}${plural}`;
      });
  };

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

  function startMigration(state: GameState, model: string): GameState {
    const to = migrationTarget(state, model);
    return { ...state, migration: { to, phase: MIGRATION_PHASES[0], phaseDaysDone: 0, overrunDays: 0 } };
  }

  function migrationQuote(state: GameState, target: string): MigrationQuote {
    const to = migrationTarget(state, target);
    const days = MIGRATION_PHASES.reduce((sum, p) => sum + config.migration.phases[p].days, 0);
    // Priced by the same daily rules a day is billed by, so the rounding matches too.
    const upfrontCost = infra.upfrontCost(to);
    const doubleBilling = config.migration.billNewFromStart ? days * infra.dailyInfrastructure(state, to, state.users) : 0;
    const proRata = days * infra.dailyInfrastructure(state, state.model, state.users);
    const exitPenalty = config.models[state.model].exitPenalty;
    const { chance, minDays, maxDays } = config.migration.overrun;
    const lostAddons = features.addonsLeftBehind(state, to).map(({ id, name, devDays }) => ({ id, name, devDays }));
    return {
      from: state.model,
      to,
      days,
      upfrontCost,
      doubleBilling,
      proRata,
      exitPenalty,
      total: upfrontCost + doubleBilling + proRata + exitPenalty,
      overrun: { chance, minDays, maxDays },
      lostAddons,
    };
  }

  /**
   * The migration's own charges for a day, on top of the current model's bill: the new model's upfront cost on the
   * first day, and (if config says so) the new provider's running costs in full from that day to the switch.
   */
  function migrationCharges(state: GameState): LogEntry[] {
    const m = state.migration;
    if (!m) return [];
    const firstDay = m.phase === MIGRATION_PHASES[0] && m.phaseDaysDone === 0;
    const running = config.migration.billNewFromStart
      ? infra.infrastructureEntries(state, m.to, state.users).map((e) => ({ ...e, text: `Double billing: ${e.text}` }))
      : [];
    return [...(firstDay ? infra.upfrontEntries(m.to) : []), ...running];
  }

  /** A seeded roll for whether a migration overruns, and by how many days. Always draws once, then again if so. */
  function rollOverrun(rng: number): [days: number, next: number] {
    const { chance, minDays, maxDays } = config.migration.overrun;
    const [r, afterChance] = nextRandom(rng);
    if (r >= chance) return [0, afterChance];
    const [d, next] = nextRandom(afterChance);
    return [minDays + Math.floor(d * (maxDays - minDays + 1)), next];
  }

  /** How long a phase of this migration takes: the configured days, plus any overrun on the moving phase. */
  function phaseLength(m: Migration, phase: MigrationPhase): number {
    return config.migration.phases[phase].days + (phase === "moving" ? m.overrunDays : 0);
  }

  function migration(state: GameState): MigrationView | null {
    const m = state.migration;
    if (!m) return null;
    const later = MIGRATION_PHASES.slice(MIGRATION_PHASES.indexOf(m.phase) + 1);
    const phaseDaysLeft = phaseLength(m, m.phase) - m.phaseDaysDone;
    const daysLeft = later.reduce((sum, p) => sum + phaseLength(m, p), phaseDaysLeft);
    const totalDays = MIGRATION_PHASES.reduce((sum, p) => sum + phaseLength(m, p), 0);
    const { overrunDays } = m;
    return { from: state.model, to: m.to, phase: m.phase, phaseDaysLeft, daysLeft, totalDays, overrunDays };
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
    if (phaseDaysDone < phaseLength(m, m.phase)) {
      return { state: { ...state, migration: { ...m, phaseDaysDone } }, entries: [] };
    }
    const done = config.migration.phases[m.phase].name;
    const next = MIGRATION_PHASES[MIGRATION_PHASES.indexOf(m.phase) + 1];
    if (next) {
      // Migrations slip while moving: roll for an overrun as that phase starts.
      const [extraDays, rng] = next === "moving" ? rollOverrun(state.rng) : [0, state.rng];
      const moved: Migration = { ...m, phase: next, phaseDaysDone: 0, overrunDays: m.overrunDays + extraDays };
      const days = phaseLength(moved, next);
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
    // Until migration sizes the new setup to demand (#51), the servers go with the model: those on the model being
    // left are dropped, which stops their rent from tomorrow (pro rata, like the model's own bill; on PaaS, instances
    // and managed services too), or for bought kit sells it back at a loss; and a model with servers gets its starter
    // setup, ready for tomorrow and billed from then (on PaaS, its starter instances and managed database). Bought
    // starter kit was paid for on the migration's first day, with the upfront cost, so it has arrived: a migration
    // takes longer than delivery. SaaS has no servers, so moving there drops them all and capacity is the provider's.
    const setup = servers.starter(m.to, state.day, state.nextServerId);
    const switched: GameState = {
      ...state,
      model: m.to,
      migration: null,
      migrations: state.migrations + 1,
      servers: setup.servers,
      nextServerId: setup.nextServerId,
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
    if (setup.servers.length) {
      const list = (modelServersList(m.to) ?? []).join(", ");
      const more = servers.isManaged(m.to)
        ? "Raise your instance count"
        : config.models[m.to].servers?.purchase
          ? "Buy more servers"
          : "Rent more VMs";
      const text = `Your ${toName} starter setup is ready for tomorrow: ${list}. ${more} as you grow.`;
      entries.push({ text, cashDelta: 0, kind: "migration" });
    }
    // Charged once, on the day you leave. The old provider's pro-rata share for today was billed with the rest.
    if (left.exitPenalty > 0) {
      const text = `Exit penalty: leaving ${left.name}`;
      entries.push({ text, cashDelta: -left.exitPenalty, category: "infrastructure" });
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

  return { startMigration, migrationQuote, migrationCharges, migration, migrationDay };
}
