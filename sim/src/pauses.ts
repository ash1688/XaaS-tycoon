import type { GameConfig } from "./config.ts";
import type { EventView } from "./events.ts";
import type { LaunchView } from "./launch.ts";
import type { MigrationView } from "./migration.ts";
import type { ServerView, UnitsView } from "./servers.ts";
import type { FundingView } from "./shares.ts";
import type { DayLog, GameState } from "./state.ts";

/** With this many days of cash left or fewer, time pauses once: a loan or cost cuts can still help. */
export const LOW_CASH_DAYS = 5;

/** What kind of thing stopped the clock: an event that hurt, an alert, an offer, low cash or something finished. */
export type PauseKind = "event" | "alert" | "offer" | "lowCash" | "finished";

/** Why time stopped by itself after a day: shown to the student, who decides what to do before playing on. */
export interface PauseReason {
  kind: PauseKind;
  /** Stable across days, for the screen: "event-ddos", "capacity", "feature-sso". */
  id: string;
  /** "Cash runs out in about 4 days". */
  text: string;
}

/** A tick played: the days it played and, if it stopped early or on its last day, why. */
export interface TickResult {
  state: GameState;
  log: DayLog[];
  /** Days played: the tick's length, or fewer when a pause trigger fired or the game ended. */
  days: number;
  /** Why time stopped after the last day played; empty when nothing needs the student. */
  pauses: PauseReason[];
}

/** The views the pause triggers compare before and after a day: all public, so a trigger sees what the player sees. */
export interface PauseViews {
  events(state: GameState): EventView[];
  units(state: GameState): UnitsView | null;
  capacity(state: GameState): number | null;
  runwayDays(state: GameState): number | null;
  features(state: GameState): { id: string; name: string; status: string }[];
  launch(state: GameState): LaunchView;
  migration(state: GameState): MigrationView | null;
  servers(state: GameState): ServerView[];
  funding(state: GameState): FundingView;
}

export function createPauses(config: GameConfig, views: PauseViews) {
  /** % of capacity in use on the tier that runs out first, or null with no limit (SaaS). */
  function capacityUse(state: GameState): number | null {
    const units = views.units(state);
    if (units) {
      const { demand, capacity } = units[units.binding];
      return capacity > 0 ? Math.round((100 * demand) / capacity) : demand > 0 ? 999 : 0;
    }
    const capacity = views.capacity(state);
    return capacity ? Math.round((100 * state.load) / capacity) : null;
  }

  /**
   * Why the day just played needs the student, comparing the company before and after it. Each trigger fires on the
   * day something changes, not on every day it stays that way, so playing on after a pause doesn't stop again at once.
   */
  function pauseReasons(before: GameState, after: GameState): PauseReason[] {
    const reasons: PauseReason[] = [];
    const add = (kind: PauseKind, id: string, text: string) => reasons.push({ kind, id, text });

    // An event that hurt or found the company short of ops, on its first day only. One with nothing to do is just shown.
    const yesterday = new Set(views.events(before).map((e) => e.id));
    for (const e of views.events(after)) {
      if ((e.hit || e.shortOfOps) && !yesterday.has(e.id)) add("event", `event-${e.id}`, e.name);
    }
    if (after.outageDays > before.outageDays && !reasons.some((r) => r.kind === "event")) {
      add("event", "outage", "Outage: the service went down");
    }

    // Alerts: things getting worse that a decision can fix.
    const use = capacityUse(after);
    const useBefore = capacityUse(before);
    if (use !== null && use > 100 && (useBefore === null || useBefore <= 100)) add("alert", "capacity", `Over capacity: ${use}% in use`);
    const poor = config.support.poorSatisfaction;
    if (after.satisfaction < poor && before.satisfaction >= poor) add("alert", "satisfaction", `Customer satisfaction fell to ${Math.round(after.satisfaction)}%`);
    const grantBefore = before.funding.grant?.status;
    const grantAfter = after.funding.grant?.status;
    if (grantBefore === "accepted" && grantAfter === "withdrawn") add("alert", "grant", "The grant was withdrawn");
    if (grantBefore === "accepted" && grantAfter === "met") add("finished", "grant", "The grant's condition is met: it's yours to keep");
    if ((after.api?.dropped ?? 0) > 0 && (before.api?.dropped ?? 0) === 0) add("alert", "api-dropped", "API calls are being dropped");

    // An offer that wasn't open yesterday.
    const fundingBefore = views.funding(before);
    const fundingAfter = views.funding(after);
    if (fundingAfter.friendsAndFamilyOffer && !fundingBefore.friendsAndFamilyOffer) add("offer", "offer-friendsAndFamily", "Friends and family have an offer");
    if (fundingAfter.grantOffer && !fundingBefore.grantOffer) add("offer", "offer-grant", "A grant is on offer");

    // Low cash: on the day the runway first gets short, and again on the last day before it runs out, as below £0 the
    // game ends.
    const left = views.runwayDays(after);
    const leftBefore = views.runwayDays(before);
    const short = (days: number | null, limit: number) => days !== null && days <= limit;
    if ((short(left, LOW_CASH_DAYS) && !short(leftBefore, LOW_CASH_DAYS)) || (short(left, 0) && !short(leftBefore, 0))) {
      add("lowCash", "low-cash", left === 0 ? "Cash runs out tomorrow" : `Cash runs out in about ${left} day${left === 1 ? "" : "s"}`);
    }

    // Something finished: a feature built, the launch, servers ready, a migration step.
    const building = new Set(views.features(before).filter((f) => f.status === "building").map((f) => f.id));
    for (const f of views.features(after)) {
      if (building.has(f.id) && f.status !== "building") add("finished", `feature-${f.id}`, `${f.name} is built`);
    }
    const launchBefore = views.launch(before).status;
    const launchAfter = views.launch(after).status;
    if (launchAfter !== launchBefore && launchAfter === "launched") add("finished", "launch", "Your launch is over");
    const migBefore = views.migration(before);
    const migAfter = views.migration(after);
    if (migBefore && !migAfter) add("finished", "migration", "Your migration is complete");
    else if (migBefore && migAfter && migAfter.phase !== migBefore.phase) add("finished", "migration", `Migration: ${migAfter.phase} phase started`);
    const pending = (s: GameState) => views.servers(s).filter((x) => x.status === "pending").length;
    if (pending(after) < pending(before)) add("finished", "servers", "New servers are ready");

    return reasons;
  }

  /**
   * Plays one tick: a day, or a week in a career. The sim still plays one day at a time, and the pause triggers are
   * checked after every day, so a crisis on the second day of a week stops the clock there. The state must be one
   * still being played.
   */
  function tick(state: GameState, advanceOne: (s: GameState) => { state: GameState; log: DayLog[] }): TickResult {
    const length = tickDays(state);
    let current = state;
    const log: DayLog[] = [];
    let days = 0;
    let pauses: PauseReason[] = [];
    while (days < length && current.status === "playing" && !pauses.length) {
      const before = current;
      const result = advanceOne(current);
      current = result.state;
      log.push(...result.log);
      days++;
      if (current.status === "playing") pauses = pauseReasons(before, current);
    }
    return { state: current, log, days, pauses };
  }

  /** Days in one tick: 7 in a career, so 47 years is playable, otherwise 1. */
  function tickDays(state: GameState): number {
    return state.gameLength === "career" ? 7 : 1;
  }

  return { pauseReasons, tick, tickDays };
}
