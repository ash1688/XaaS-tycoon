import type { GameConfig } from "./config.ts";
import { count } from "./finance.ts";
import type { Pricing } from "./pricing.ts";
import type { Servers } from "./servers.ts";
import type { GameState, LogEntry } from "./state.ts";

/** Where the company is with its launch, for the Home card. */
export interface LaunchView {
  /**
   * "waiting" while nothing it has set up could serve users; "upcoming" once something will, but isn't ready yet (VMs
   * being set up, kit on order); "launching" while its first users trickle in over the ramp; "launched" once the
   * ramp is over and normal growth has taken over.
   */
  status: "waiting" | "upcoming" | "launching" | "launched";
  /**
   * The first day users arrived or, with the setup it has now, will arrive: the first day it's ready by. Null while
   * nothing it has could serve users.
   */
  day: number | null;
  /** Days from the day just played to that day: null once users have started arriving, or with nothing set up. */
  daysLeft: number | null;
  /** Days the ramp lasts. */
  rampDays: number;
  /** Ramp days played so far, from 1 on the first day users arrived to rampDays: 0 before. */
  rampDay: number;
  /** Users who have joined so far over the ramp. The launch total isn't shown: the student sees them as they come. */
  arrived: number;
  /** Whether the model has servers to set up before launch: false on a model with no capacity limit (SaaS). */
  needsServers: boolean;
  /** Whether servers that can serve users are set up, ready or on their way. Always on a model with no capacity limit. */
  setUp: boolean;
  /**
   * Ops staff the company needs once everything it has set up is running: the model's fixed number plus every
   * server's share, bought kit still on order included.
   */
  opsNeeded: number;
}

/**
 * Launch: a new company has no users and no servers. Its first users start arriving at the end of the first day it
 * has capacity to serve them, and trickle in over the launch ramp (see LaunchConfig). Before that nothing is running,
 * so there are no users, income, tickets or events, but staff, running costs and loan repayments are still charged.
 */
export function createLaunch(config: GameConfig, servers: Servers, pricing: Pricing) {
  // A ramp whose shares add up to nothing brings everyone on the first day.
  const raw = config.launch.rampShares;
  const total = raw.reduce((sum, s) => sum + Math.max(0, s), 0);
  const shares = total > 0 ? raw.map((s) => Math.max(0, s) / total) : [1];
  const rampDays = shares.length;
  const launchUsers = (state: GameState) => state.launchUsers;
  /** Users who have arrived by the end of ramp day k (1 = the first), rounded so the days add up to the total. */
  const arrivedBy = (state: GameState, k: number) =>
    Math.round(launchUsers(state) * shares.slice(0, Math.max(0, k)).reduce((sum, s) => sum + s, 0));

  /**
   * Whether the company could serve users from the day after `day`: on a model with servers, ones ready by the end of
   * it give both compute and a database. A model with no servers is ready unless a test config gives it no capacity.
   */
  function readyBy(state: GameState, day: number): boolean {
    if (!servers.hasServers(state.model)) return (config.models[state.model].capacity ?? Infinity) > 0;
    return servers.usersSupported(servers.capacityOn(state, day + 1, 1), state.productType) > 0;
  }

  /** Whether the company's first users arrive at the end of `day`: not launched yet, and ready by then. */
  const launchesOn = (state: GameState, day: number) => state.launchDay === null && readyBy(state, day);

  /** Which ramp day `day` is, from 1, for a company launching on it or already launched; 0 if it isn't one. */
  function rampDayOn(state: GameState, day: number): number {
    const first = state.launchDay ?? (launchesOn(state, day) ? day : null);
    if (first === null) return 0;
    const k = day - first + 1;
    return k >= 1 && k <= rampDays ? k : 0;
  }

  /**
   * The day the company's first users arrived or, with the servers it has now, will: the first day from the next one
   * played that it's ready by. Null while nothing it has could serve users.
   */
  function launchDayFor(state: GameState): number | null {
    if (state.launchDay !== null) return state.launchDay;
    const first = state.day + 1;
    const days = [first, ...state.servers.map((s) => s.readyDay).filter((d) => d > first)].sort((a, b) => a - b);
    return days.find((d) => readyBy(state, d)) ?? null;
  }

  /**
   * A ramp day's arrivals, if `day` is one: its share of the launch total, split paid and free like any new users,
   * logged. The first ramp day is kept as the launch day.
   */
  function arrive(state: GameState, day: number): { state: GameState; entries: LogEntry[] } {
    const k = rampDayOn(state, day);
    if (k === 0) return { state, entries: [] };
    const users = arrivedBy(state, k) - arrivedBy(state, k - 1);
    const paidUsers = Math.round(users * pricing.paidShareOfNew(state));
    const when = rampDays === 1 ? "Launch day" : `Launch, day ${k} of ${rampDays}`;
    const done = k === rampDays && rampDays > 1 ? " That's everyone: normal growth takes over from tomorrow." : "";
    const text = `${when}: ${count.format(users)} new users arrived, ${count.format(paidUsers)} of them paying.${done}`;
    return {
      state: {
        ...state,
        launchDay: state.launchDay ?? day,
        users: state.users + users,
        paidUsers: state.paidUsers + paidUsers,
      },
      entries: [{ text, cashDelta: 0, kind: "launch" }],
    };
  }

  function launchView(state: GameState): LaunchView {
    const day = launchDayFor(state);
    const rampDay = state.launchDay === null ? 0 : Math.min(rampDays, state.day - state.launchDay + 1);
    const status =
      state.launchDay !== null ? (rampDay < rampDays ? "launching" : "launched") : day === null ? "waiting" : "upcoming";
    return {
      status,
      day,
      daysLeft: state.launchDay !== null || day === null ? null : day - state.day,
      rampDays,
      rampDay,
      arrived: arrivedBy(state, rampDay),
      needsServers: servers.hasServers(state.model),
      setUp: state.launchDay !== null || day !== null,
      opsNeeded: servers.opsFor(state.model, state.servers),
    };
  }

  return { launchesOn, rampDayOn, arrive, launchView };
}

export type Launch = ReturnType<typeof createLaunch>;
