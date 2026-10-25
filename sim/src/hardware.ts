import type { GameConfig, ModelId } from "./config.ts";
import { sliderRisk } from "./benefits.ts";
import { nextRandom } from "./rng.ts";
import { SimError, type GameState, type LogEntry, type Server } from "./state.ts";

/** The hardware slider's risks for one server today, as daily chances. */
export interface HardwareRisk {
  overheat: number;
  crash: number;
}

/**
 * Whether a model has the hardware slider: only one that buys its servers (on-prem), since only there do you have
 * the physical kit.
 */
export const hasSlider = (config: GameConfig, model: ModelId) => !!config.models[model].servers?.purchase;

/** A server's slider: 1 (100%) unless set. */
export const performanceOf = (s: Pick<Server, "performance">) => s.performance ?? 1;

/** Whether a server is down from a crash on a day. */
export const crashedOn = (s: Pick<Server, "crashedUntil">, day: number) => (s.crashedUntil ?? 0) >= day;

/** Whether a server is overheated on a day. */
export const overheatedOn = (s: Pick<Server, "overheatedUntil">, day: number) => (s.overheatedUntil ?? 0) >= day;

/**
 * The share of its normal units a server gives on a day, on a model with the slider: its slider, cut while it's
 * overheated, and nothing while it's crashed. 1 on any other model.
 */
export function unitFactor(config: GameConfig, model: ModelId, s: Server, day: number): number {
  if (!hasSlider(config, model)) return 1;
  if (crashedOn(s, day)) return 0;
  return performanceOf(s) * (overheatedOn(s, day) ? config.hardware.overheat.capacity : 1);
}

/**
 * A server's lifespan in the game: the wear it can build up before it's worn out. A game shorter than a year (180
 * days) counts as one year, so it has the short lifespan; a year or more has the full one (#95).
 */
export const lifespanOf = (config: GameConfig, state: Pick<GameState, "gameLength">) =>
  state.gameLength === "180-days" ? config.hardware.shortGameLifespan : config.hardware.lifespan;

/** Wear as a share of the server's lifespan: 1 when it's used it up. */
export function wearShare(config: GameConfig, state: Pick<GameState, "gameLength">, s: Pick<Server, "wear">): number {
  const life = lifespanOf(config, state);
  return life > 0 ? (s.wear ?? 0) / life : 0;
}

/**
 * Days until a server is worn out at its slider now, counting today's wear as done: 0 once it is, null at 0% (it
 * doesn't wear).
 */
export function wearDaysLeft(config: GameConfig, state: Pick<GameState, "gameLength">, s: Server): number | null {
  const p = performanceOf(s);
  if (p <= 0) return null;
  return Math.max(0, Math.ceil((lifespanOf(config, state) - (s.wear ?? 0)) / (p * p)));
}

/**
 * A server's daily chances of overheating and crashing at its slider: none at 100% or below; above, the configured
 * chance at the top × x², where x runs from 0 at 100% to 1 at the top, × any benefit cutting the risk. Past its
 * lifespan, it has an extra chance of a crash whatever the slider.
 */
export function hardwareRisk(
  config: GameConfig,
  state: Pick<GameState, "benefits" | "model" | "gameLength">,
  s: Server,
): HardwareRisk {
  const { maxPerformance, overheat, crash, wornCrashChance } = config.hardware;
  const over = maxPerformance > 1 ? Math.max(0, (performanceOf(s) - 1) / (maxPerformance - 1)) : 0;
  const risk = sliderRisk(config, state, state.model) * over * over;
  const worn = wornCrashChance * Math.max(0, wearShare(config, state, s) - 1);
  return { overheat: Math.min(1, overheat.chance * risk), crash: Math.min(1, crash.chance * risk + worn) };
}

/** Rounds wear to the hundredth, so state stays tidy. */
const tidy = (n: number) => Math.round(n * 100) / 100;

/**
 * A day on the hardware, on a model with the slider: each server that served today builds up its slider² of wear, then
 * rolls for a crash (no units for the configured days, from tomorrow) and, if it didn't crash, for overheating. One
 * already down from a crash doesn't roll. Draws from the hardware's own RNG only when there's a chance. A server whose
 * wear reaches the warning share of its lifespan today is warned about, once.
 */
export function hardwareDay(
  config: GameConfig,
  state: GameState,
  day: number,
  name: (s: Server) => string,
): { servers: Server[]; hardwareRng: number; entries: LogEntry[] } {
  if (!hasSlider(config, state.model)) return { servers: state.servers, hardwareRng: state.hardwareRng, entries: [] };
  let rng = state.hardwareRng;
  const entries: LogEntry[] = [];
  const roll = (chance: number) => {
    if (chance <= 0) return false;
    const [r, next] = nextRandom(rng);
    rng = next;
    return r < chance;
  };
  const servers = state.servers.map((s) => {
    if (s.readyDay >= day) return s;
    const p = performanceOf(s);
    const worn: Server = { ...s, wear: tidy((s.wear ?? 0) + p * p) };
    const warning = wearWarning(config, state, s, worn, name(s));
    if (warning) entries.push(warning);
    if (crashedOn(s, day + 1)) return worn;
    const risk = hardwareRisk(config, state, worn);
    if (roll(risk.crash)) {
      const { days } = config.hardware.crash;
      const why = p > 1 ? `running at ${Math.round(100 * p)}%` : "worn out";
      entries.push({
        text: `Crash: server #${s.id} (${name(s)}), ${why}, is down for ${days} day${days === 1 ? "" : "s"} while ops fix it.`,
        cashDelta: 0,
        kind: "outage",
      });
      return { ...worn, crashedUntil: day + days };
    }
    if (roll(risk.overheat)) {
      const { days, capacity } = config.hardware.overheat;
      entries.push({
        text: `Overheating: server #${s.id} (${name(s)}) at ${Math.round(100 * p)}% gives ${Math.round(100 * capacity)}% of its capacity for ${days} day${days === 1 ? "" : "s"}.`,
        cashDelta: 0,
        kind: "outage",
      });
      return { ...worn, overheatedUntil: day + days };
    }
    return worn;
  });
  return { servers, hardwareRng: rng, entries };
}

/**
 * The warning on the day a server's wear reaches the warning share of its lifespan, or its lifespan itself: how long
 * it has left at its slider, and what to do. Null on any other day.
 */
function wearWarning(config: GameConfig, state: GameState, before: Server, after: Server, name: string): LogEntry | null {
  const share = (s: Server) => wearShare(config, state, s);
  const { warnAt } = config.hardware;
  if (share(before) < 1 && share(after) >= 1) {
    return {
      text: `Worn out: server #${after.id} (${name}) has reached the end of its life. It may crash on any day now, more often the longer you keep it: sell it and buy a new one.`,
      cashDelta: 0,
      kind: "outage",
    };
  }
  if (warnAt <= 0 || warnAt >= 1 || share(before) >= warnAt || share(after) < warnAt) return null;
  const days = wearDaysLeft(config, state, after)!;
  const p = performanceOf(after);
  return {
    text: `Wear warning: server #${after.id} (${name}) is ${Math.round(100 * share(after))}% worn and will be worn out in about ${days} day${days === 1 ? "" : "s"} at ${Math.round(100 * p)}%. After that it may crash: replace it, or turn its slider down to make it last.`,
    cashDelta: 0,
    kind: "outage",
  };
}

/** Sets a bought server's slider, from the next day played. Kit still on order can be set ready for when it arrives. */
export function setPerformance(config: GameConfig, state: GameState, id: number, performance: number): GameState {
  const { name } = config.models[state.model];
  if (!hasSlider(config, state.model)) {
    throw new SimError("no_slider", `Only on-prem gives you the physical hardware to tune: you can't on ${name}.`);
  }
  const top = config.hardware.maxPerformance;
  if (typeof performance !== "number" || !Number.isFinite(performance) || performance < 0 || performance > top) {
    throw new SimError("bad_performance", `Set a server between 0% and ${Math.round(100 * top)}% of its normal capacity.`);
  }
  const server = state.servers.find((s) => s.id === id);
  if (!server) throw new SimError("unknown_server", "That server isn't one of yours.");
  const set: Server = { ...server, performance: Math.round(performance * 100) / 100 };
  if (set.performance === 1) delete set.performance;
  return { ...state, servers: state.servers.map((s) => (s.id === id ? set : s)) };
}
