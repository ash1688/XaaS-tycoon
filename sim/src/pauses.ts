import type { CalendarView } from "./calendar.ts";
import type { DangerView } from "./encounters.ts";
import type { GameConfig } from "./config.ts";
import type { EventView } from "./events.ts";
import type { InvestorsView } from "./investors.ts";
import type { IpoView } from "./ipo.ts";
import type { LaunchView } from "./launch.ts";
import type { MvpView } from "./mvp.ts";
import type { MigrationView } from "./migration.ts";
import type { ServerView, UnitsView } from "./servers.ts";
import type { FundingView } from "./shares.ts";
import type { ShortfallView } from "./loan.ts";
import type { OpsShortfallView } from "./infrastructure.ts";
import { pounds } from "./finance.ts";
import { quarterName } from "./payReview.ts";
import type { DayLog, GameState } from "./state.ts";

/** An ops shortfall in a few words: "1 of 2 needed, capacity cut to 70%". */
export const opsShortText = (s: OpsShortfallView) =>
  `${Math.round(s.have * 100) / 100} of ${s.needed} needed, capacity cut to ${Math.round(s.capacityShare * 100)}%`;

/** With this many days of cash left or fewer, time pauses once: a loan or cost cuts can still help. */
export const LOW_CASH_DAYS = 5;

/**
 * What kind of thing stopped the clock: an event that hurt, a holiday that hits the product, an alert, an offer, low
 * cash, something finished or a pay review, which holds the clock until it's settled.
 */
export type PauseKind = "event" | "calendar" | "alert" | "offer" | "lowCash" | "finished" | "payReview";

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
  mvp(state: GameState): MvpView;
  migration(state: GameState): MigrationView | null;
  servers(state: GameState): ServerView[];
  funding(state: GameState): FundingView;
  investors(state: GameState): InvestorsView;
  calendar(state: GameState): CalendarView;
  ipo(state: GameState): IpoView;
  danger(state: GameState): DangerView;
  shortfall(state: GameState): ShortfallView;
  opsShortfall(state: GameState): OpsShortfallView | null;
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

    // A pay review opening: the day can't go on until it's settled.
    if (after.payReview && !before.payReview) {
      add("payReview", "pay-review", `Pay review for ${quarterName(after.payReview)}: your staff want to talk about pay`);
    }

    // The first time cash went below £0: the shortfall went on a loan, with how much further it can go.
    if (after.firstShortfallDay !== null && before.firstShortfallDay === null) {
      const { room } = views.shortfall(after);
      const next = after.rescue ? "the company goes into liquidation" : "a vulture VC steps in";
      add("alert", "shortfall", `Cash went below £0 and the shortfall went on your loan: ${pounds(room)} more and ${next}`);
    }
    // Cash ran out and a vulture VC rescued the company: it now owns most of it, and the next cash-out is liquidation.
    if (after.rescue && !before.rescue) {
      add("alert", "rescue", `Cash ran out: a vulture VC rescued the company for ${Math.round(after.rescue.share * 100)}% of it`);
    }

    // An event that hurt, found the company short of ops or brought a wave of users to carry, on its first day only.
    // One with nothing to do is just shown.
    const yesterday = new Set(views.events(before).map((e) => e.id));
    for (const e of views.events(after)) {
      if ((e.hit || e.shortOfOps || e.newUsers > 0) && !yesterday.has(e.id)) add("event", `event-${e.id}`, e.name);
    }
    if (after.outageDays > before.outageDays && !reasons.some((r) => r.kind === "event")) {
      add("event", "outage", "Outage: the service went down");
    }

    // A holiday that hits the product: announced ahead, so there's time to plan capacity, and again as it starts.
    const { on, upcoming } = views.calendar(after);
    for (const h of on) {
      if (h.effect && h.startDay === after.day) add("calendar", `holiday-${h.id}`, `Holiday started: ${h.name}, for ${h.days} days`);
    }
    for (const h of upcoming) {
      if (h.effect && h.daysUntil === config.calendar.noticeDays) {
        add("calendar", `holiday-${h.id}`, `Holiday coming in ${h.daysUntil} days: ${h.name}, on ${h.start.text}`);
      }
    }

    // A warning about the next random event (a traffic spike's tip-off), on the day it comes: time to get ready.
    const warned = views.danger(after).warning;
    if (warned && views.danger(before).warning?.event !== warned.event) add("alert", `warning-${warned.event}`, `Warning: ${warned.name} may be coming`);

    // Alerts: things getting worse that a decision can fix.
    // Too few ops for the servers running, on the day it starts to cut capacity (#259).
    const opsShort = views.opsShortfall(after);
    if (opsShort && !views.opsShortfall(before)) {
      add("alert", "ops-shortfall", `Short of ops: ${opsShortText(opsShort)}`);
    }
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
    // A year's end in a long game: running prices rose, and new kit is better (drift).
    for (const y of after.yearEnds.slice(before.yearEnds.length)) {
      add("alert", "year-end", `Year ${y.year} is over: running prices rose ${Math.round(y.inflation * 1000) / 10}%`);
    }
    // A server nearly worn out, on the day it's first warned about: time to replace it or ease off its slider.
    const warnedBefore = new Set(views.servers(before).filter((x) => x.wearWarning).map((x) => x.id));
    for (const x of views.servers(after)) {
      if (x.wearWarning && !warnedBefore.has(x.id)) add("alert", `wear-${x.id}`, `Server #${x.id} is nearly worn out`);
    }

    // The IPO: every readiness condition met at last, or a condition lost by a company that was ready.
    const ipoBefore = views.ipo(before);
    const ipoAfter = views.ipo(after);
    if (ipoAfter.status === "ready" && ipoBefore.status !== "ready") add("offer", "ipo-ready", "IPO: ready to apply");
    else if (ipoBefore.ready && !ipoAfter.ready) {
      const lost = ipoAfter.conditions.filter((x) => !x.met && ipoBefore.conditions.find((b) => b.id === x.id)?.met);
      add("alert", "ipo-lost", `IPO: no longer ready (${lost.map((x) => x.label.toLowerCase()).join(", ")})`);
    }

    // An offer that wasn't open yesterday.
    const fundingBefore = views.funding(before);
    const fundingAfter = views.funding(after);
    if (fundingAfter.friendsAndFamilyOffer && !fundingBefore.friendsAndFamilyOffer) add("offer", "offer-friendsAndFamily", "Friends and family have an offer");
    if (fundingAfter.grantOffer && !fundingBefore.grantOffer) add("offer", "offer-grant", "A grant is on offer");
    // An investor approaching, and the angel's target met or missed.
    const investorsBefore = views.investors(before);
    const investorsAfter = views.investors(after);
    const approached = investorsAfter.offer;
    if (approached && (investorsBefore.offer?.investor !== approached.investor || investorsBefore.offer.day !== approached.day)) {
      add("offer", `offer-${approached.round}`, `${approached.investor}, an angel investor, wants to invest: see Finance`);
    }
    const lapsed = investorsAfter.declined.at(-1);
    if (lapsed?.lapsed && investorsAfter.declined.length > investorsBefore.declined.length) {
      add("alert", `lapsed-${lapsed.round}`, `${lapsed.investor}'s offer lapsed unanswered: it counts as declined`);
    }
    // Three VCs approaching for a round, and their offers lapsing.
    const vcAfter = investorsAfter.vc.approach;
    const vcBefore = investorsBefore.vc.approach;
    if (vcAfter && (vcBefore?.round !== vcAfter.round || vcBefore.day !== vcAfter.day)) {
      add("offer", `offer-${vcAfter.round}`, `${vcAfter.name}: three VCs want to invest: see Finance`);
    }
    const vcLapsed = investorsAfter.vc.declined.at(-1);
    if (vcLapsed?.lapsed && investorsAfter.vc.declined.length > investorsBefore.vc.declined.length) {
      add("alert", `lapsed-${vcLapsed.round}`, "The VCs' offers lapsed unanswered: they count as declined");
    }
    const angelBefore = investorsBefore.angel?.status;
    const angelAfter = investorsAfter.angel;
    if (angelBefore === "running" && angelAfter?.status === "met") add("finished", "angel-target", `${angelAfter.investor}'s target is met`);
    if (angelBefore === "running" && angelAfter?.status === "missed") {
      add("alert", "angel-target", `${angelAfter.investor}'s target was missed: they took extra shares`);
    }

    // Low cash: on the day the runway first gets short, and again on the last day before it runs out, as below £0 is a
    // rescue buyout, or liquidation after one.
    const left = views.runwayDays(after);
    const leftBefore = views.runwayDays(before);
    const short = (days: number | null, limit: number) => days !== null && days <= limit;
    if ((short(left, LOW_CASH_DAYS) && !short(leftBefore, LOW_CASH_DAYS)) || (short(left, 0) && !short(leftBefore, 0))) {
      add("lowCash", "low-cash", left === 0 ? "Cash runs out tomorrow" : `Cash runs out in about ${left} day${left === 1 ? "" : "s"}`);
    }

    // Something finished: the MVP, a tier available, a feature built, the launch, servers ready, a migration step.
    for (const t of after.tiers.slice(before.tiers.length)) add("finished", `tier-${t.tier}`, `Tier ${t.tier} available`);
    if (views.mvp(after).done && !views.mvp(before).done) add("finished", "mvp", "Your MVP is ready: press Launch when you're set up");
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
    for (const c of after.campaigns.filter((c) => c.endDay === after.day && !c.stopped && c.endDay > before.day)) {
      add("finished", `campaign-${c.id}`, `Your campaign for ${config.customerTypes[c.customerType].name.toLowerCase()} has finished`);
    }
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
