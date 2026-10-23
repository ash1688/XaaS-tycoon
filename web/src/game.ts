// The game being played: loaded once by the game shell and shared with its pages, cards and modals through
// provide/inject, so switching page never re-fetches the company. Reactive, so templates read its refs unwrapped.
import { computed, inject, onUnmounted, provide, reactive, ref, watch, type InjectionKey } from "vue";
import type { DayLog, EventView, FeatureGapView, LayerId, ModelId, PauseReason, StaffGrade, StaffPool, UnitTier } from "@xaas/sim";
import type { ActionBody, CompanyView, MetaView, SummaryView, TimedFlowSpeedView } from "@xaas/server/api-types";
import { api, RequestError } from "./api";
import { createUiLog } from "./playLog";

/** Where the student's timed flow speed is kept, in their browser. */
const SPEED_KEY = "xaas-timed-speed";

export const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** "day 40 of 180", or "day 40" in a game with no last day (until IPO). */
export const dayOf = (day: number, finalDay: number | null) => (finalDay === null ? `day ${day}` : `day ${day} of ${finalDay}`);
export const namesList = (names: string[]) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** Over 100% is an outage (on a cache, full); close to it is a warning that one is coming. */
const levelOf = (percent: number) => (percent > 100 ? "over" : percent >= 80 ? "high" : "ok");

/** With this many days of cash left or fewer, every page warns, while a loan or cost cuts can still help. */
export const LOW_CASH_DAYS = 5;

export const TIER_INFO = [
  { id: "cu", unit: "CU", name: "Compute", servers: "app servers" },
  { id: "dbu", unit: "DBU", name: "Database", servers: "databases" },
  { id: "ch", unit: "CH", name: "Cache hits", servers: "caches" },
] as const;

/** One capacity tier, for its bar. */
export interface Tier {
  id: UnitTier;
  unit: string;
  name: string;
  servers: string;
  demand: number;
  capacity: number;
  percent: number;
  level: "ok" | "high" | "over";
  /** The tier that runs out first: it sets capacity. */
  binding: boolean;
}

export function createGame(code: string, id: string) {
  const meta = ref<MetaView>();
  const company = ref<CompanyView>();
  const loadError = ref("");
  const error = ref("");
  const busy = ref(false);
  // Every day played since the page opened, oldest first. The server keeps the game, not its log.
  const dayLogs = ref<DayLog[]>([]);
  const lastDay = computed(() => dayLogs.value.at(-1));
  // Users and satisfaction before the last day played, for the change it made.
  const previousUsers = ref<number>();
  const previousSatisfaction = ref<number>();
  // Where each page lives: /play/:code/:id is Home.
  const base = `/play/${code}/${id}`;
  // The playtest log of what the student does on the game's pages, sent in batches.
  const uiLog = createUiLog(code, id, () => company.value?.day);

  const productName = (id: string) => meta.value?.productTypes.find((p) => p.id === id)?.name ?? id;
  const modelName = (id: string) => meta.value?.models.find((m) => m.id === id)?.name ?? id;
  const personName = (pool: StaffPool) => meta.value?.staff.find((s) => s.id === pool)?.personName ?? pool;
  // Top layer first, so the stack reads like the diagram: your data on top, the building at the bottom.
  const stackFor = (id: ModelId | undefined) => meta.value?.models.find((m) => m.id === id)?.stack.toReversed() ?? [];
  const stack = computed(() => stackFor(company.value?.model));
  const layerName = (id: LayerId) => stack.value.find((l) => l.id === id)?.name ?? id;
  const currentModel = computed(() => meta.value?.models.find((m) => m.id === company.value?.model));
  // After a migration completes, the layers whose owner changed are highlighted until the next day.
  const previousModel = ref<ModelId>();
  // The add-ons left behind by a migration that completed today, shown with the features until the next day.
  const leftBehind = ref<string[]>([]);

  const liquidated = computed(() => company.value?.status === "liquidated");
  const finished = computed(() => company.value?.status === "finished");
  const retired = computed(() => company.value?.status === "retired");
  // The IPO: approved, the game holds until the opening bell is rung; floated, the game is over.
  const ipoApproved = computed(() => company.value?.ipo.status === "approved");
  const floated = computed(() => company.value?.ipo.status === "floated");
  // Once the game is over, liquidated, played to the end, floated or retired, it's read-only and Home shows its summary.
  const over = computed(() => liquidated.value || finished.value || retired.value);
  const summary = ref<SummaryView>();

  // Staff by grade. Needs (ops needed, the configuration team, support to keep up) count work in mids, so a team of
  // juniors covers less than its headcount and seniors more.
  const staffPool = (pool: StaffPool) => company.value?.staff.find((p) => p.pool === pool);
  const grade = (id: StaffGrade) => meta.value?.grades.find((g) => g.id === id);
  const work = (pool: StaffPool) => staffPool(pool)?.output ?? 0;
  // Work hired but not started yet: it counts once they start. Agency staff do a share of their grade's.
  const workComing = (pool: StaffPool) =>
    staffPool(pool)?.hiring.reduce(
      (sum, h) => sum + h.count * (grade(h.grade)?.output ?? 1) * (h.agency ? (meta.value?.agency.output ?? 1) : 1),
      0,
    ) ?? 0;
  // Mids it takes to make up a shortfall in work: 0.35 short is one more.
  const midsShort = (needed: number, have: number) => Math.max(0, Math.ceil(Math.round((needed - have) * 100) / 100));
  const opsWork = computed(() => work("ops"));
  const understaffed = computed(() => !!company.value && opsWork.value < company.value.opsNeeded);
  const opsShort = computed(() => (company.value ? midsShort(company.value.opsNeeded, opsWork.value) : 0));
  // Ops that kit on order will need once it arrives, beyond those on the team: a shortfall coming, not here yet.
  const opsShortSoon = computed(() =>
    company.value && !understaffed.value ? midsShort(company.value.opsNeededOnceReady, opsWork.value) : 0,
  );

  // Cash: what a usual day does to it, and how many days it lasts at that rate (null when not losing money).
  const runway = computed(() => company.value?.runway ?? null);
  const lowCash = computed(() => !over.value && runway.value?.days != null && runway.value.days <= LOW_CASH_DAYS);

  // Servers in units, on a model with them (on-prem, IaaS and PaaS): CU, DBU and CH demand against capacity. Over 100%
  // on CU or DBU is an outage; the cache just takes what it can. A tier with no capacity and some demand shows as 999%,
  // bar the cache: with none, nothing is waiting on it.
  const units = computed(() => company.value?.units ?? null);
  // PaaS: an instance count and managed services the provider runs. SaaS: no servers and no limit, billed per user.
  const managed = computed(() => company.value?.managed ?? null);
  const provider = computed(() => company.value?.provider ?? null);
  const tiers = computed((): Tier[] => {
    const u = units.value;
    if (!u) return [];
    return TIER_INFO.map((info) => {
      const { demand, capacity } = u[info.id];
      const percent = capacity > 0 ? Math.round((100 * demand) / capacity) : demand > 0 && info.id !== "ch" ? 999 : 0;
      return { ...info, demand, capacity, percent, level: levelOf(percent), binding: u.binding === info.id };
    });
  });
  // The tier that runs out first sets capacity: the one to watch.
  const tightest = computed(() => tiers.value.find((t) => t.binding));
  // App servers that won't get traffic once the servers being set up or on order are ready, beyond today's: the load
  // balancer shortfall coming.
  const lbShortSoon = computed(() => {
    const u = units.value;
    return u ? Math.max(0, u.loadBalancerOnceReady.uncovered - u.loadBalancer.uncovered) : 0;
  });
  // On-prem buys its servers rather than renting them: they're on order, adding nothing, until they arrive.
  const buysServers = computed(() => company.value?.serverOptions[0]?.price != null);
  const addVerb = computed(() => (buysServers.value ? "buy" : "rent"));
  // What to do about a tier running short: on PaaS, scale the platform; elsewhere, rent or buy more servers.
  const tierFix = (tier: UnitTier) => {
    if (managed.value) {
      return tier === "cu" ? "raise your instance count" : "pick a bigger managed database, or add a cache";
    }
    return `${addVerb.value} more ${TIER_INFO.find((t) => t.id === tier)?.servers ?? "servers"}`;
  };
  const onOrder = computed(() => (buysServers.value ? (company.value?.servers ?? []).filter((s) => s.status === "pending") : []));
  // With no capacity limit (SaaS), load never comes close.
  const loadPercent = computed(() => {
    if (tightest.value) return tightest.value.percent;
    const c = company.value;
    return c && c.capacity ? Math.round((100 * c.load) / c.capacity) : 0;
  });
  // Over 100% is an outage; close to it is a warning that one is coming.
  const loadLevel = computed(() => levelOf(loadPercent.value));
  const onSaas = computed(() => company.value?.model === "saas");
  const building = computed(() => company.value?.features.find((f) => f.status === "building"));
  // SaaS still needs a few developers to configure add-ons; without them, add-ons can't be bought.
  const configTeamNeeded = computed(() => meta.value?.minConfigDevelopers ?? 0);
  const configTeamShort = computed(() => midsShort(configTeamNeeded.value, work("developers")));
  const migration = computed(() => company.value?.migration ?? null);

  // Customer care. Support staff needed to keep up with today's users' usual tickets, before any burst.
  const supportNeeded = computed(() =>
    company.value && meta.value ? Math.ceil(company.value.usualTickets / meta.value.ticketsPerPerson) : 0,
  );
  const supportShort = computed(() => midsShort(supportNeeded.value, work("support")));
  // On a product with user content: moderators needed to keep up with today's users' usual reports.
  const moderation = computed(() => company.value?.moderation ?? null);
  const moderatorsNeeded = computed(() =>
    moderation.value && meta.value ? Math.ceil(moderation.value.usualReports / meta.value.reportsPerPerson) : 0,
  );
  // Good: no effect. Below good: growth slows and users leave. Below poor: angry customers.
  const satisfactionLevel = computed(() => {
    const c = company.value;
    const m = meta.value;
    if (!c || !m) return "ok";
    return c.satisfaction >= m.goodSatisfaction ? "ok" : c.satisfaction >= m.poorSatisfaction ? "high" : "over";
  });

  // Scripted events on the day just played. Each names the layer of the stack that decided how it hit this model.
  const events = computed(() => company.value?.events ?? []);
  const eventsByLayer = computed(() => {
    const byLayer = new Map<LayerId, EventView[]>();
    for (const e of events.value) byLayer.set(e.layer, [...(byLayer.get(e.layer) ?? []), e]);
    return byLayer;
  });
  // Features the platform can't provide keep slowing growth until the company migrates off that model, so they're
  // shown every day. On the day one opens, its event card says it instead.
  const featureGaps = computed(() => company.value?.featureGaps ?? []);
  const openGaps = computed(() => featureGaps.value.filter((g) => !events.value.some((e) => e.id === g.id)));
  const gapsByLayer = computed(() => {
    const byLayer = new Map<LayerId, FeatureGapView[]>();
    for (const g of featureGaps.value) byLayer.set(g.layer, [...(byLayer.get(g.layer) ?? []), g]);
    return byLayer;
  });

  async function load() {
    try {
      [meta.value, company.value] = await Promise.all([api.companyMeta(code, id), api.company(code, id)]);
      if (over.value) await loadSummary();
    } catch (e) {
      loadError.value = (e as Error).message;
    }
  }

  /**
   * After an error: a game the teacher ended (or that ended in another tab) refuses everything with "finished", so
   * the page reloads it to show its summary instead of the error.
   */
  async function showError(e: unknown) {
    if (e instanceof RequestError && e.code === "finished") return load();
    error.value = (e as Error).message;
  }

  async function loadSummary() {
    summary.value = await api.summary(code, id);
  }

  // The summary so far, for the cash chart. It only changes when a day is played.
  async function ensureSummary() {
    if (!company.value || summary.value?.day === company.value.day) return;
    try {
      await loadSummary();
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function act(action: ActionBody) {
    busy.value = true;
    error.value = "";
    try {
      company.value = await api.act(code, id, action);
    } catch (e) {
      await showError(e);
    } finally {
      busy.value = false;
    }
  }

  // An action from a control on the page, such as a staff + or −: logged as used, then taken. The server logs the
  // action itself and how it went.
  function actFrom(control: string, action: ActionBody) {
    uiLog.track("control", { control, value: action.type });
    return act(action);
  }

  // Why time last stopped by itself, and the day it stopped on: shown until the next tick is played.
  const pauses = ref<PauseReason[]>([]);
  const pausedOnDay = ref(0);

  /** Plays one tick: a day, or a week in a career, which stops early on the day something needs the student. */
  async function continueDay() {
    if (over.value || ipoApproved.value) return;
    busy.value = true;
    error.value = "";
    pauses.value = [];
    try {
      const before = company.value?.model;
      const users = company.value?.users;
      const satisfaction = company.value?.satisfaction;
      const addons = company.value?.features.filter((f) => f.status === "addon") ?? [];
      const result = await api.continueDay(code, id);
      previousModel.value = before !== result.company.model ? before : undefined;
      leftBehind.value = addons
        .filter((a) => result.company.features.find((f) => f.id === a.id)?.status === "notStarted")
        .map((a) => a.name);
      previousUsers.value = users;
      previousSatisfaction.value = satisfaction;
      company.value = result.company;
      dayLogs.value = [...dayLogs.value, ...result.log];
      pauses.value = result.pauses;
      pausedOnDay.value = result.company.day;
      if (over.value) await loadSummary();
    } catch (e) {
      await showError(e);
    } finally {
      busy.value = false;
    }
  }

  // Timed flow, on unless the server or teacher switches it off: plays a tick every few seconds through the same
  // continue as the button, and pauses itself when the sim says something needs the student. The next tick is only
  // scheduled once the last one has come back, so requests never overlap.
  const timedFlow = computed(() => (meta.value?.timedFlow.enabled ? meta.value.timedFlow : undefined));
  const playing = ref(false);
  const secondsLeft = ref(0);
  const speedId = ref<TimedFlowSpeedView["id"]>(storedSpeed());
  const speed = computed(() => timedFlow.value?.speeds.find((s) => s.id === speedId.value) ?? timedFlow.value?.speeds[1]);
  /** "day", or "week" in a career: what one tick plays. */
  const tickName = computed(() => (company.value?.tickDays === 7 ? "week" : "day"));
  let deadline = 0;
  let timer: number | undefined;
  // A timed tick's request is in flight.
  let ticking = false;
  // Paused because the tab was hidden, so it carries on when the student comes back.
  let hiddenWhilePlaying = false;

  function storedSpeed(): TimedFlowSpeedView["id"] {
    try {
      const stored = localStorage.getItem(SPEED_KEY);
      if (stored === "slow" || stored === "normal" || stored === "fast" || stored === "fastest") return stored;
    } catch {
      // Storage blocked: the normal speed.
    }
    return "normal";
  }

  /** Changes the speed, from the next tick on (the countdown restarts at the new speed). */
  function setSpeed(id: TimedFlowSpeedView["id"]) {
    speedId.value = id;
    try {
      localStorage.setItem(SPEED_KEY, id);
    } catch {
      // Kept for this page only.
    }
    if (timer) {
      clearTimer();
      schedule();
    }
  }

  function schedule() {
    const seconds = speed.value!.seconds;
    deadline = Date.now() + seconds * 1000;
    secondsLeft.value = Math.ceil(seconds);
    timer = window.setInterval(tick, 100);
  }

  function clearTimer() {
    window.clearInterval(timer);
    timer = undefined;
  }

  async function tick() {
    const left = deadline - Date.now();
    secondsLeft.value = Math.max(0, Math.ceil(left / 1000));
    // Waits for any action still in flight, such as a hire, rather than overlapping it.
    if (left > 0 || busy.value) return;
    clearTimer();
    ticking = true;
    try {
      await continueDay();
    } finally {
      ticking = false;
    }
    // Stops when the game ends, the tick failed (its message stays on screen) or something needs the student.
    if (over.value || error.value || pauses.value.length) pause();
    else if (playing.value && !timer) schedule();
  }

  function play() {
    if (!timedFlow.value || over.value || ipoApproved.value) return;
    playing.value = true;
    pauses.value = [];
    if (!timer && !ticking) schedule();
  }

  function pause() {
    playing.value = false;
    clearTimer();
  }

  function onVisibilityChange() {
    if (document.hidden && playing.value) {
      hiddenWhilePlaying = true;
      pause();
    } else if (!document.hidden && hiddenWhilePlaying) {
      hiddenWhilePlaying = false;
      play();
    }
  }

  watch(over, (isOver) => isOver && pause());
  watch(ipoApproved, (approved) => approved && pause());
  document.addEventListener("visibilitychange", onVisibilityChange);
  onUnmounted(() => {
    pause();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    uiLog.stop();
  });

  return reactive({
    code,
    id,
    base,
    meta,
    company,
    loadError,
    error,
    busy,
    dayLogs,
    lastDay,
    previousUsers,
    previousSatisfaction,
    productName,
    modelName,
    personName,
    stackFor,
    stack,
    layerName,
    currentModel,
    previousModel,
    leftBehind,
    liquidated,
    finished,
    retired,
    ipoApproved,
    floated,
    over,
    summary,
    staffPool,
    grade,
    work,
    workComing,
    midsShort,
    opsWork,
    understaffed,
    opsShort,
    opsShortSoon,
    runway,
    lowCash,
    lbShortSoon,
    units,
    managed,
    provider,
    tiers,
    tightest,
    buysServers,
    addVerb,
    tierFix,
    onOrder,
    loadPercent,
    loadLevel,
    onSaas,
    building,
    configTeamNeeded,
    configTeamShort,
    migration,
    supportNeeded,
    supportShort,
    moderation,
    moderatorsNeeded,
    satisfactionLevel,
    events,
    eventsByLayer,
    featureGaps,
    openGaps,
    gapsByLayer,
    load,
    ensureSummary,
    loadSummary,
    act,
    actFrom,
    continueDay,
    timedFlow,
    playing,
    secondsLeft,
    speed,
    tickName,
    setSpeed,
    pauses,
    pausedOnDay,
    play,
    pause,
    track: uiLog.track,
  });
}

export type Game = ReturnType<typeof createGame>;

const GAME: InjectionKey<Game> = Symbol("game");

/** Creates the game and shares it with everything under the calling component. */
export function provideGame(code: string, id: string): Game {
  const game = createGame(code, id);
  provide(GAME, game);
  return game;
}

/** The game the shell loaded, or undefined outside the game shell: for shared components such as the modal. */
export const useGameIfAny = (): Game | undefined => inject(GAME, undefined);

/** The game the shell loaded. Only for components under the game shell. */
export function useGame(): Game {
  const game = inject(GAME);
  if (!game) throw new Error("useGame() needs the game shell above it.");
  return game;
}
