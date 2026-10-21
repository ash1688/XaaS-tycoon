import type { GameConfig } from "./config.ts";
import { count } from "./finance.ts";
import type { Pricing } from "./pricing.ts";
import type { Servers } from "./servers.ts";
import type { GameState, LogEntry } from "./state.ts";

/** Where the company is with its launch, for the Home card. */
export interface LaunchView {
  /**
   * "upcoming" before the earliest launch day has been played; "waiting" once it has, with no users yet: nothing is set
   * up to serve them, or what is hasn't arrived; "launched" once the launch burst has arrived.
   */
  status: "upcoming" | "waiting" | "launched";
  /**
   * The day it launched or, with the setup it has now, will launch: the earliest day, or a later one when the servers
   * aren't ready by then. Null while nothing it has could serve users.
   */
  day: number | null;
  /** Days from the day just played to launch day: null once launched, or with nothing set up. */
  daysLeft: number | null;
  /** The earliest day any company can launch. */
  earliestDay: number;
  /**
   * The launch burst: users who arrive on launch day, and of them those who pay: the product's paid share at the fair
   * price, fewer at a higher one, like any new users.
   */
  users: number;
  paidUsers: number;
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
 * Launch: a new company has no users and no servers. Its users arrive in a burst at the end of launch day, the
 * earliest launch day or the first day after it the company has capacity to serve them (see LaunchConfig). Before
 * that nothing is running, so there are no users, income, tickets or events, but staff, running costs and loan
 * repayments are still charged.
 */
export function createLaunch(config: GameConfig, servers: Servers, pricing: Pricing) {
  const { earliestDay } = config.launch;

  /**
   * The launch burst: the product's launch users, split paid and free by its free share. A price set above the fair
   * price before launch puts more of them on the free tier, as it does any new users (see PricingConfig).
   */
  function burst(state: GameState) {
    const users = config.productTypes[state.productType].growth.launchUsers;
    return { users, paidUsers: Math.round(users * pricing.paidShareOfNew(state)) };
  }

  /**
   * Whether the company could serve users from the day after `day`: on a model with servers, ones ready by the end of
   * it give both compute and a database. A model with no servers is ready unless a test config gives it no capacity.
   */
  function readyBy(state: GameState, day: number): boolean {
    if (!servers.hasServers(state.model)) return (config.models[state.model].capacity ?? Infinity) > 0;
    return servers.usersSupported(servers.capacityOn(state, day + 1, 1), state.productType) > 0;
  }

  /** Whether the company launches at the end of `day`: not yet launched, the earliest day or later, and ready by then. */
  const launchesOn = (state: GameState, day: number) =>
    state.launchDay === null && day >= earliestDay && readyBy(state, day);

  /**
   * The day the company launched or, with the servers it has now, will: the first day from the next one played, and
   * no earlier than the earliest launch day, that it's ready by. Null while nothing it has could serve users.
   */
  function launchDayFor(state: GameState): number | null {
    if (state.launchDay !== null) return state.launchDay;
    const first = Math.max(state.day + 1, earliestDay);
    const days = [first, ...state.servers.map((s) => s.readyDay).filter((d) => d > first)].sort((a, b) => a - b);
    return days.find((d) => readyBy(state, d)) ?? null;
  }

  /** The launch: the burst of users arrives, logged, and the day is kept. */
  function launch(state: GameState, day: number): { state: GameState; entries: LogEntry[] } {
    const { users, paidUsers } = burst(state);
    const text = `Launch day: your first ${count.format(users)} users arrived, ${count.format(paidUsers)} of them paying.`;
    return {
      state: { ...state, launchDay: day, users: state.users + users, paidUsers: state.paidUsers + paidUsers },
      entries: [{ text, cashDelta: 0, kind: "launch" }],
    };
  }

  function launchView(state: GameState): LaunchView {
    const day = launchDayFor(state);
    const launched = state.launchDay !== null;
    return {
      status: launched ? "launched" : state.day >= earliestDay ? "waiting" : "upcoming",
      day,
      daysLeft: launched || day === null ? null : day - state.day,
      earliestDay,
      ...burst(state),
      needsServers: servers.hasServers(state.model),
      setUp: launched || day !== null,
      opsNeeded: servers.opsFor(state.model, state.servers),
    };
  }

  return { launchesOn, launch, launchView };
}

export type Launch = ReturnType<typeof createLaunch>;
