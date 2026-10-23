import type { EventConfig, EventEffect, EventOutcome, GameConfig, ModelId, ProductTypeId } from "./config.ts";
import { layerOwner, layerResponsibility, type LayerId, type Owner } from "./responsibility.ts";
import { count } from "./finance.ts";
import { staffOutput } from "./staff.ts";
import type { EventRecord, FeatureGap, GameState, LogEntry, ScheduledEvent } from "./state.ts";

/** A scripted event that was on during the day just played, explained for the student. */
export interface EventView {
  id: string;
  name: string;
  /** What happened, the same on every model. */
  description: string;
  /** The model it hit. */
  model: ModelId;
  /** The layer of the responsibility stack that decided how it played out, and who owns it on that model. */
  layer: LayerId;
  owner: Owner;
  /** Names the responsible layer and who looks after it: "OS and patching is your job on IaaS." */
  responsibility: string;
  /** How it played out on that model, and why. */
  outcome: string;
  /** Short of the ops staff needed to deal with it. */
  shortOfOps: boolean;
  /** Patches were overdue, which made it worse (see EventEffect.unpatched). */
  unpatched: boolean;
  /** It hurt: it caused downtime, a penalty, a price rise or a feature gap. */
  hit: boolean;
  /** New free users it brought (see EventOutcome.freeUsers): 0 for most events. */
  newUsers: number;
}

/** A feature gap still slowing growth, for the screen to show every day until it closes. */
export interface FeatureGapView {
  /** The event that opened it. */
  id: string;
  name: string;
  /** The feature the company needs and can't have. */
  feature: string;
  /** The model it's tied to: migrating off it closes the gap. */
  model: ModelId;
  /** The layer of the responsibility stack it's about, and who owns it on that model. */
  layer: LayerId;
  owner: Owner;
  /** Growth is multiplied by this every day while it's open. */
  growthMultiplier: number;
  /** Why, and how it ends: the event's explanation on that model. */
  detail: string;
}

/** A scripted event on today, and how it plays out on the current model with today's ops. */
export interface EventToday {
  event: EventConfig;
  shortOfOps: boolean;
  unpatched: boolean;
  outcome: EventOutcome;
  /** Capacity grows to meet the event's load today (see EventOutcome.scaleCostPerLoad and scaleCostPerUnit). */
  scales: boolean;
}

const NO_EFFECT: EventEffect = { detail: "" };

/**
 * Events: how each plays out on each model, and what lasts after the day. Random ones fire from the encounter list
 * (see encounters.ts); either way, a day an event fires on is in the state's schedule.
 */
export function createEvents(config: GameConfig) {
  const eventConfig = (id: string) => config.events.find((e) => e.id === id);

  /** The fixed days events fire on, outside the encounter system, in day order. Only days after afterDay are kept. */
  function fixedSchedule(afterDay: number): ScheduledEvent[] {
    const schedule = config.events.flatMap((event) =>
      (event.schedule?.days ?? []).filter((day) => day > afterDay).map((day) => ({ event: event.id, day })),
    );
    // A stable sort, so events on the same day keep config order.
    return schedule.sort((a, b) => a.day - b.day);
  }

  /**
   * Events on during a day for a company on this model: each one that fired that day or recently enough to last until
   * it, and has an effect on the model. In config order.
   */
  function eventsOn(state: GameState, day: number, model: ModelId): EventConfig[] {
    return config.events.filter(
      (e) => e.effects[model] && state.schedule.some((s) => s.event === e.id && day >= s.day && day < s.day + e.days),
    );
  }

  /** Events on today, and how each plays out on the current model with today's ops. */
  function eventsToday(state: GameState, day: number): EventToday[] {
    return eventsOn(state, day, state.model).map((event) => {
      const needed = event.effects[state.model]?.opsNeeded;
      const shortOfOps = needed !== undefined && staffOutput(config, state, "ops") < needed;
      // Patches were overdue if yesterday had the unpatched risk: today's isn't known until the day is played.
      const unpatched = !shortOfOps && !!event.effects[state.model]?.unpatched && state.dangerRisks.includes("unpatched");
      const outcome = outcomeFor(event, state.model, shortOfOps, unpatched);
      return { event, shortOfOps, unpatched, outcome, scales: scales(state, event, outcome, state.model, day) };
    });
  }

  /** Days since an event that's on during a day fired: 0 on the day it fires. */
  function dayOfEvent(state: GameState, id: string, day: number): number {
    const fired = state.schedule.filter((s) => s.event === id && s.day <= day).at(-1);
    return fired ? day - fired.day : 0;
  }

  /**
   * Whether capacity grows to meet an event's load on a day. The extra servers take the model's readyDays to arrive,
   * so not until that many days into the event: at once on PaaS. Only a model with servers scales: on SaaS there's
   * no capacity limit to grow.
   */
  function scales(state: GameState, event: EventConfig, outcome: EventOutcome, model: ModelId, day: number): boolean {
    if (!event.load) return false;
    const servers = config.models[model].servers;
    if (!servers) return false;
    return outcome.scaleCostPerUnit !== undefined && dayOfEvent(state, event.id, day) >= (servers.readyDays ?? 0);
  }

  /** How an event plays out on a model, short of ops or not, with patches overdue or not. */
  function outcomeFor(event: EventConfig, model: ModelId, shortOfOps: boolean, unpatched = false): EventOutcome {
    const effect = event.effects[model] ?? NO_EFFECT;
    if (shortOfOps && effect.shortOfOps) return effect.shortOfOps;
    return unpatched && effect.unpatched ? effect.unpatched : effect;
  }

  /** On a day an event scaled the company up to meet its load. */
  const scaledUp = (state: GameState) =>
    state.events.some((r) => {
      const event = eventConfig(r.event);
      return !!event && scales(state, event, outcomeFor(event, r.model, r.shortOfOps, r.unpatched), r.model, state.day);
    });

  /** The outcome that opened a feature gap, if its event is still in config. */
  function gapOutcome(gap: FeatureGap): EventOutcome | undefined {
    const event = eventConfig(gap.event);
    return event && outcomeFor(event, gap.model, false);
  }

  /** The feature a gap is about, for this company's product. */
  const gapFeature = (state: GameState, gap: FeatureGap) => gapOutcome(gap)?.featureGap?.features[state.productType];

  /** Growth multipliers from each feature the platform can't provide. */
  const gapGrowth = (state: GameState) => state.featureGaps.map((g) => gapOutcome(g)?.featureGap?.growthMultiplier ?? 1);

  /** What an outcome does that lasts beyond the day, put first in its explanation. */
  function lastingNote(outcome: EventOutcome, productType: ProductTypeId): string {
    const notes: string[] = [];
    if (outcome.priceRise) {
      const { percent, addons } = outcome.priceRise;
      notes.push(`Its prices are up ${percent}% from today${addons ? ", add-ons included" : ""}.`);
    }
    if (outcome.featureGap) {
      const feature = outcome.featureGap.features[productType];
      const slower = Math.round(100 * (1 - outcome.featureGap.growthMultiplier));
      notes.push(`Your customers want ${feature}, and no add-on offers it. Growth is ${slower}% slower without it.`);
    }
    return notes.map((n) => `${n} `).join("");
  }

  function explain(event: EventConfig, record: Omit<EventRecord, "event">, productType: ProductTypeId): EventView {
    const { model, shortOfOps, hit } = record;
    const unpatched = record.unpatched ?? false;
    const newUsers = record.newUsers ?? 0;
    const { id, name, description, layer } = event;
    const needed = event.effects[model]?.opsNeeded;
    const result = outcomeFor(event, model, shortOfOps, unpatched);
    const wave = result.freeUsers ? `${count.format(newUsers)} new free users signed up. ` : "";
    const detail = wave + lastingNote(result, productType) + result.detail;
    const outcome = shortOfOps ? `${detail} You needed ${needed} ops staff.` : detail;
    const owner = layerOwner(model, layer);
    const responsibility = layerResponsibility(model, layer);
    return { id, name, description, model, layer, owner, responsibility, outcome, shortOfOps, unpatched, hit, newUsers };
  }

  function events(state: GameState): EventView[] {
    // An event taken out of config since the day was played has nothing left to explain it.
    return state.events.flatMap((r) => {
      const event = eventConfig(r.event);
      return event ? [explain(event, r, state.productType)] : [];
    });
  }

  function featureGaps(state: GameState): FeatureGapView[] {
    // A gap whose event was taken out of config no longer slows growth either, so there's nothing to show.
    return state.featureGaps.flatMap((g) => {
      const event = eventConfig(g.event);
      const gap = gapOutcome(g)?.featureGap;
      if (!event || !gap) return [];
      const feature = gap.features[state.productType];
      const { id, name, layer } = event;
      const { detail } = outcomeFor(event, g.model, false);
      const owner = layerOwner(g.model, layer);
      return [{ id, name, feature, model: g.model, layer, owner, growthMultiplier: gap.growthMultiplier, detail }];
    });
  }

  /**
   * Price rises and feature gaps from events that fire today. They last: they apply from today's bill and growth on,
   * so they're applied before the day is played. Each applies once, on the day its event fires.
   */
  function lastingEffects(state: GameState, day: number, today: EventToday[]) {
    let { priceRises, addonPriceRise, featureGaps } = state;
    for (const { event, outcome } of today) {
      if (!state.schedule.some((s) => s.event === event.id && s.day === day)) continue;
      if (outcome.priceRise) {
        const rise = 1 + outcome.priceRise.percent / 100;
        priceRises = { ...priceRises, [state.model]: (priceRises[state.model] ?? 1) * rise };
        if (outcome.priceRise.addons) addonPriceRise *= rise;
      }
      if (outcome.featureGap && !featureGaps.some((g) => g.event === event.id && g.model === state.model)) {
        featureGaps = [...featureGaps, { event: event.id, model: state.model }];
      }
    }
    return { priceRises, addonPriceRise, featureGaps };
  }

  /**
   * The wave of free users each of today's events brings (see EventOutcome.freeUsers), on the day it fires, as far as
   * the market has room. They arrive at the end of the day, after growth.
   */
  function newUsersToday(state: GameState, day: number, today: EventToday[], users: number): number[] {
    const { marketSize } = config.productTypes[state.productType].growth;
    let room = Math.max(0, marketSize - users);
    return today.map(({ event, outcome }) => {
      if (!outcome.freeUsers || !state.schedule.some((s) => s.event === event.id && s.day === day)) return 0;
      const wave = Math.min(room, Math.max(outcome.freeUsers.min, Math.round(users * outcome.freeUsers.share)));
      room -= wave;
      return wave;
    });
  }

  /** Charges for the damage today's events did. */
  function costEntries(today: EventToday[]): LogEntry[] {
    return today.flatMap(({ event, outcome }): LogEntry[] =>
      outcome.cost
        ? [{ text: `${event.name}: ${outcome.cost.text}`, cashDelta: -outcome.cost.amount, category: "infrastructure" }]
        : [],
    );
  }

  /**
   * How each of today's events played out, to keep in state, and each one explaining itself for the log: what
   * happened, whose job it is on this model, and how it played out.
   */
  function record(state: GameState, today: EventToday[], overloaded: boolean, newUsers: number[]) {
    const records: EventRecord[] = today.map(({ event, shortOfOps, unpatched, outcome }, i) => ({
      event: event.id,
      model: state.model,
      shortOfOps,
      unpatched,
      newUsers: newUsers[i] ?? 0,
      hit:
        !!outcome.downtimeHours ||
        !!outcome.cost ||
        !!outcome.priceRise ||
        !!outcome.featureGap ||
        (overloaded && !!event.load),
    }));
    const entries = today.map(({ event }, i): LogEntry => {
      const { name, responsibility, outcome } = explain(event, records[i]!, state.productType);
      return { text: `${name}: ${responsibility} ${outcome}`, cashDelta: 0, kind: "event" };
    });
    return { records, entries };
  }

  return {
    fixedSchedule,
    eventsToday,
    scaledUp,
    gapFeature,
    gapGrowth,
    events,
    featureGaps,
    lastingEffects,
    newUsersToday,
    costEntries,
    record,
  };
}

export type Events = ReturnType<typeof createEvents>;
