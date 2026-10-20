// The game being played: loaded once by the game shell and shared with its pages, cards and modals through
// provide/inject, so switching page never re-fetches the company. Reactive, so templates read its refs unwrapped.
import { computed, inject, onUnmounted, provide, reactive, ref, watch, type InjectionKey } from "vue";
import type { DayLog, EventView, FeatureGapView, LayerId, ModelId, StaffPool, UnitTier } from "@xaas/sim";
import type { ActionBody, CompanyView, MetaView, SummaryView } from "@xaas/server/api-types";
import { api } from "./api";

export const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
export const namesList = (names: string[]) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** Over 100% is an outage (on a cache, full); close to it is a warning that one is coming. */
const levelOf = (percent: number) => (percent > 100 ? "over" : percent >= 80 ? "high" : "ok");

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

  const bankrupt = computed(() => company.value?.status === "bankrupt");
  const finished = computed(() => company.value?.status === "finished");
  const retired = computed(() => company.value?.status === "retired");
  // Once the game is over, bankrupt, played to the end or retired, it's read-only and Home shows its summary.
  const over = computed(() => bankrupt.value || finished.value || retired.value);
  const summary = ref<SummaryView>();

  const understaffed = computed(() => !!company.value && company.value.ops < company.value.opsNeeded);

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
  const configTeamShort = computed(() => (company.value ? Math.max(0, configTeamNeeded.value - company.value.developers) : 0));
  const migration = computed(() => company.value?.migration ?? null);

  // Customer care. Support staff needed to keep up with today's users' usual tickets, before any burst.
  const supportNeeded = computed(() =>
    company.value && meta.value ? Math.ceil(company.value.usualTickets / meta.value.ticketsPerPerson) : 0,
  );
  const supportShort = computed(() => (company.value ? Math.max(0, supportNeeded.value - company.value.support) : 0));
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
      error.value = (e as Error).message;
    } finally {
      busy.value = false;
    }
  }

  async function continueDay() {
    if (over.value) return;
    busy.value = true;
    error.value = "";
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
      if (over.value) await loadSummary();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      busy.value = false;
    }
  }

  // Timed flow, off unless the server turns it on: plays a day every few seconds through the same continue as the
  // button. The next day is only scheduled once the last one has come back, so requests never overlap.
  const timedFlow = computed(() => (meta.value?.timedFlow.enabled ? meta.value.timedFlow : undefined));
  const playing = ref(false);
  const secondsLeft = ref(0);
  let deadline = 0;
  let timer: number | undefined;
  // A timed day's request is in flight.
  let ticking = false;
  // Paused because the tab was hidden, so it carries on when the student comes back.
  let hiddenWhilePlaying = false;

  function schedule() {
    deadline = Date.now() + timedFlow.value!.seconds * 1000;
    secondsLeft.value = Math.ceil(timedFlow.value!.seconds);
    timer = window.setInterval(tick, 250);
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
    // Stops when the game ends or the day failed (its message stays on screen).
    if (over.value || error.value) pause();
    else if (playing.value && !timer) schedule();
  }

  function play() {
    if (!timedFlow.value || over.value) return;
    playing.value = true;
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
  document.addEventListener("visibilitychange", onVisibilityChange);
  onUnmounted(() => {
    pause();
    document.removeEventListener("visibilitychange", onVisibilityChange);
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
    bankrupt,
    finished,
    retired,
    over,
    summary,
    understaffed,
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
    satisfactionLevel,
    events,
    eventsByLayer,
    featureGaps,
    openGaps,
    gapsByLayer,
    load,
    ensureSummary,
    act,
    continueDay,
    timedFlow,
    playing,
    secondsLeft,
    play,
    pause,
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

/** The game the shell loaded. Only for components under the game shell. */
export function useGame(): Game {
  const game = inject(GAME);
  if (!game) throw new Error("useGame() needs the game shell above it.");
  return game;
}
