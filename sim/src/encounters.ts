import { DANGER_RISKS, type DangerRisk, type EventConfig, type GameConfig } from "./config.ts";
import { paasAutoscaling } from "./benefits.ts";
import { breachShare, patchingNeed } from "./executives.ts";
import { layerOwner } from "./responsibility.ts";
import { nextRandom } from "./rng.ts";
import type { Servers } from "./servers.ts";
import { staffOutput } from "./staff.ts";
import type { Encounter, GameState, LogEntry, ScheduledEvent } from "./state.ts";

/** One thing that made the danger meter climb faster on the day just played. */
export interface DangerRiskView {
  id: DangerRisk;
  /** What it was, for the student: "Servers going unpatched". */
  label: string;
  /** Why it counts, and how to stop it. */
  detail: string;
  /** What it added to the day's rise. */
  rise: number;
}

/**
 * The danger meter, for the student. It shows how fast trouble is building and why, but not the encounter list: which
 * event comes next, and when, stays a surprise.
 */
export interface DangerView {
  meter: number;
  /** The top of the meter's scale: no threshold is higher. Reaching it with nothing on the list resets it quietly. */
  max: number;
  /** How much it rose on the day just played: 0 before launch. On a day an event fires, from 0. */
  rise: number;
  /** What a well-run day adds. */
  dailyRise: number;
  /** The risks that made it climb faster on the day just played. */
  risks: DangerRiskView[];
  /**
   * A warning about the next event, when it has one and the meter would reach it within its warning's well-run days:
   * the one time the list shows its hand. Null otherwise.
   */
  warning: { event: string; name: string; text: string } | null;
}

/** The situation an encounter list is rolled in, and the meter checked against: the C-suite too, once there is one. */
type Situation = Pick<GameState, "model" | "schedule" | "featureGaps" | "dangerRisks"> & Partial<Pick<GameState, "csuite" | "benefits">>;

/** The event a CISO makes less likely. */
const BREACH_EVENT = "breach";

/** The danger meter and the encounter list: when random events fire, and which. See EncounterConfig. */
export function createEncounters(config: GameConfig, servers: Servers, spikeDay: (state: GameState, day: number) => boolean) {
  const { encounters } = config;
  const eventConfig = (id: string) => config.events.find((e) => e.id === id);

  /**
   * Whether an event can still hit the company: its model is hit, it hasn't fired its most, what it follows has fired
   * since it last did (recently enough, by the day it would fire), and its gap isn't open.
   */
  function canHit(state: Situation, event: EventConfig, day: number): boolean {
    const effect = event.effects[state.model];
    if (!event.encounter || !effect) return false;
    const { maxTimes, follows, followsWithinDays } = event.encounter;
    if (maxTimes !== undefined && state.schedule.filter((s) => s.event === event.id).length >= maxTimes) return false;
    if (follows) {
      const last = state.schedule.findLastIndex((s) => s.event === event.id);
      const recent = (fired: number) => followsWithinDays === undefined || day - fired <= followsWithinDays;
      if (!state.schedule.slice(last + 1).some((s) => follows.includes(s.event) && recent(s.day))) return false;
    }
    // An autoscaler can only fail for a company whose platform autoscales (#261).
    if (effect.autoscalerFails && !paasAutoscaling(config, { benefits: state.benefits ?? [], model: state.model }, state.model)) return false;
    return !(effect.featureGap && state.featureGaps.some((g) => g.event === event.id && g.model === state.model));
  }

  /** Each event's chance of going on a list rolled in this situation. */
  function chanceOf(state: Situation, event: EventConfig): number {
    const odds = event.encounter!;
    const multiplier = state.dangerRisks.reduce((m, risk) => m * (odds.risks?.[risk] ?? 1), 1);
    const ciso = event.id === BREACH_EVENT && state.csuite ? breachShare(config, { csuite: state.csuite }) : 1;
    return Math.min(1, odds.chance * multiplier * ciso);
  }

  /**
   * A new encounter list, lowest threshold first (config order on a tie). Every event with odds draws once for its
   * chance, whether it can come up or not, and once more for its threshold if it does.
   */
  function roll(state: Situation, day: number, rng: number): [list: Encounter[], next: number] {
    const list: Encounter[] = [];
    const span = encounters.thresholdMax - encounters.thresholdMin;
    for (const event of config.events) {
      if (!event.encounter) continue;
      const [r, afterChance] = nextRandom(rng);
      rng = afterChance;
      const chance = chanceOf(state, event);
      if (!canHit(state, event, day) || day < (event.encounter.fromDay ?? 0) || r >= chance) continue;
      const [u, afterThreshold] = nextRandom(rng);
      rng = afterThreshold;
      list.push({ event: event.id, threshold: Math.round(encounters.thresholdMin + span * u * (1 - chance / 2)) });
    }
    return [list.sort((a, b) => a.threshold - b.threshold), rng];
  }

  /** The first list, rolled as the game starts. */
  function startingEncounters(state: Situation, rng: number) {
    const [encounterList, encounterRng] = roll(state, 1, rng);
    return { dangerMeter: 0, encounterList, dangerRisks: [] as DangerRisk[], encounterRng };
  }

  /**
   * The check, at the start of a day: an event on the list whose threshold the meter has reached fires today. It's
   * added to the schedule for today, the meter goes back to 0 and a new list is rolled. A list emptied by a migration
   * or a roll that came up empty resets the same way, quietly, once the meter reaches the top of its scale.
   */
  function checkDay(state: GameState, day: number) {
    // An event that can no longer hit the company (its model left behind, or taken out of config) is dropped.
    const list = state.encounterList.filter((e) => {
      const event = eventConfig(e.event);
      return !!event && canHit(state, event, day);
    });
    const next = list[0];
    // One weighted towards spike days waits for one, for up to about spikeWaitDays of the meter's rise (#261).
    const wait = next ? (eventConfig(next.event)?.encounter?.spikeWaitDays ?? 0) * encounters.dailyRise : 0;
    const fires = !!next && state.dangerMeter >= next.threshold && (wait <= 0 || spikeDay(state, day) || state.dangerMeter >= next.threshold + wait);
    if (!fires && !(list.length === 0 && state.dangerMeter >= encounters.thresholdMax)) {
      const kept = { schedule: state.schedule, dangerMeter: state.dangerMeter, encounterList: list, encounterRng: state.encounterRng };
      return { state: kept, entries: [] as LogEntry[] };
    }
    const fired: ScheduledEvent[] = fires ? [{ event: next.event, day }] : [];
    // Fixed days still to come stay in order after it.
    const schedule = [...state.schedule, ...fired].sort((a, b) => a.day - b.day);
    const [encounterList, encounterRng] = roll({ ...state, schedule }, day, state.encounterRng);
    // A fired event explains itself; a quiet reset says so, or the meter would drop to 0 with no reason given.
    const entries: LogEntry[] = fires
      ? []
      : [{ text: "Danger meter: it reached the top and nothing went wrong this time. It starts again from 0.", cashDelta: 0, kind: "danger" }];
    return { state: { schedule, dangerMeter: 0, encounterList, encounterRng }, entries };
  }

  /** The risks on a day played: what made it a risky day, worked out at the end of it. */
  function risksOn(state: GameState, overloaded: boolean): DangerRisk[] {
    const on: Record<DangerRisk, boolean> = {
      // Ops still to start after hiring aren't patching yet. A CISO keeps patches up to date with fewer.
      unpatched:
        layerOwner(state.model, "os") === "you" &&
        staffOutput(config, state, "ops") < servers.opsNeeded(state) * patchingNeed(config, state),
      overloaded,
      lowSatisfaction: state.satisfaction < config.support.poorSatisfaction,
    };
    // A risk configured to add nothing doesn't make the meter climb faster, so it isn't one.
    return DANGER_RISKS.filter((r) => on[r] && encounters.riskRise[r] > 0);
  }

  /** How much the meter rises for a day with these risks. */
  const riseFor = (risks: DangerRisk[]) =>
    risks.reduce((sum, r) => sum + encounters.riskRise[r], encounters.dailyRise);

  /** The meter after a day played. It only rises once the company is live: before launch nothing can go wrong. */
  function riseDay(state: GameState, live: boolean, overloaded: boolean) {
    if (!live) return { dangerMeter: state.dangerMeter, dangerRisks: [] as DangerRisk[] };
    const dangerRisks = risksOn(state, overloaded);
    return { dangerMeter: state.dangerMeter + riseFor(dangerRisks), dangerRisks };
  }

  const RISK_TEXT: Record<DangerRisk, { label: string; detail: string }> = {
    unpatched: {
      label: "Servers going unpatched",
      detail: "You have fewer ops staff at work than your setup needs, so patches fall behind. Hire ops to catch up.",
    },
    overloaded: {
      label: "Capacity overloaded",
      detail: "Load went over your capacity. Add capacity to stop running so close to the edge.",
    },
    lowSatisfaction: {
      label: "Customers unhappy",
      detail: `Satisfaction is below ${config.support.poorSatisfaction}%. Answer the support backlog to win them back.`,
    },
  };

  /** The next event's warning, if it has one and the meter is within its days of it. */
  function warning(state: GameState): DangerView["warning"] {
    const next = state.encounterList.find((e) => {
      const event = eventConfig(e.event);
      return !!event && canHit(state, event, state.day + 1);
    });
    const event = next && eventConfig(next.event);
    if (!next || !event?.warning?.days || state.dangerMeter <= 0) return null;
    const within = state.dangerMeter + event.warning.days * encounters.dailyRise >= next.threshold;
    return within ? { event: event.id, name: event.name, text: event.warning.byModel?.[state.model] ?? event.warning.text } : null;
  }

  /** A warning that came on today, for the day's log. */
  function warningEntries(before: GameState, after: GameState): LogEntry[] {
    const now = warning(after);
    if (!now || warning(before)?.event === now.event) return [];
    return [{ text: `Warning: ${now.text}`, cashDelta: 0, kind: "danger" }];
  }

  function danger(state: GameState): DangerView {
    return {
      meter: state.dangerMeter,
      max: encounters.thresholdMax,
      // Nothing rises before launch.
      rise: state.dangerMeter > 0 ? riseFor(state.dangerRisks) : 0,
      dailyRise: encounters.dailyRise,
      risks: state.dangerRisks.map((id) => ({ id, ...RISK_TEXT[id], rise: encounters.riskRise[id] })),
      warning: warning(state),
    };
  }

  return { startingEncounters, checkDay, riseDay, warningEntries, danger };
}

export type Encounters = ReturnType<typeof createEncounters>;
