import type { GameConfig } from "./config.ts";
import { count } from "./finance.ts";
import { mvpDoneBy, mvpStatus } from "./mvp.ts";
import type { Pricing } from "./pricing.ts";
import type { Servers, UnitsView } from "./servers.ts";
import { staffOutput } from "./staff.ts";
import { CUSTOMER_TYPE_IDS, type CustomerTypeId } from "./config.ts";
import { SimError, type GameState, type LogEntry } from "./state.ts";

/** Where the company is with its launch, for the Home card. */
export interface LaunchView {
  /**
   * "waiting" while there are no developers to finish the MVP; "upcoming" while it's being built; "ready" once it's
   * done and the company waits for the student to press Launch; "launching" from then while its first users trickle
   * in over the ramp; "launched" once the ramp is over and normal growth has taken over. With launch.auto (tests and
   * demos), never "ready": a done MVP is "waiting" until servers are set up to serve users, then "upcoming".
   */
  status: "waiting" | "upcoming" | "ready" | "launching" | "launched";
  /**
   * Go-live: the day Launch was pressed for (the next day played), the first day of the ramp, its first users arriving
   * at the end of it. Null until Launch is pressed.
   */
  day: number | null;
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
  /**
   * Before go-live, what going live on the next day played would be short of, each in plain words ("No database: no
   * users can be served"), from the same capacity the Infrastructure page shows. Empty once Launch is pressed.
   */
  missing: string[];
}

/**
 * Launch: a new company has no users, no servers and an MVP to build (see Mvp). Once the MVP is done it waits, ready
 * to launch, until the student presses Launch: go-live is the next day played, and its first users arrive at the end
 * of it and trickle in over the launch ramp (see LaunchConfig). Before go-live nothing is running, so there are no
 * users, income, tickets, events or hosting bills, but staff and loan repayments are still charged. The student can
 * launch short of an app server, database or ops: `missing` says what's short, and users who can't be served leave.
 * `units` gives the capacity the Infrastructure page shows, on a model with servers.
 */
export function createLaunch(
  config: GameConfig,
  servers: Servers,
  pricing: Pricing,
  units: (state: GameState) => UnitsView | null,
) {
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
    return servers.usersSupported(servers.capacityOn(state, day + 1, 1), state) > 0;
  }

  /**
   * With launch.auto (tests and demos), whether Launch presses itself at the end of `day`: not launched yet, its MVP
   * done and servers ready by then. Never otherwise: the student presses Launch.
   */
  const autoLaunchesOn = (state: GameState, day: number) =>
    config.launch.auto > 0 && state.launchDay === null && mvpDoneBy(state.mvp, day) && readyBy(state, day);

  /** Which ramp day `day` is, from 1, for a company that has launched or launches on it; 0 if it isn't one. */
  function rampDayOn(state: GameState, day: number): number {
    const first = state.launchDay ?? (autoLaunchesOn(state, day) ? day : null);
    if (first === null) return 0;
    const k = day - first + 1;
    return k >= 1 && k <= rampDays ? k : 0;
  }

  /** Whether servers that can serve users are set up, ready or on their way. Always on a model with no servers. */
  const setUp = (state: GameState) => readyBy(state, Infinity);

  /**
   * What going live on the next day played would be short of: on a model with servers, an app server and a database
   * ready by then, as the Infrastructure page's capacity shows; on any model, the ops it needs now.
   */
  function missing(state: GameState): string[] {
    const list: string[] = [];
    const u = units(state);
    if (u) {
      if (u.cu.capacity <= 0) list.push("No app server: no users can be served");
      if (u.dbu.capacity <= 0) list.push("No database: no users can be served");
    } else if (!setUp(state)) list.push("No capacity: no users can be served");
    const needed = servers.opsNeeded(state);
    const ops = staffOutput(config, state, "ops");
    if (needed > 0 && ops < needed) {
      const who = ops <= 0 ? "No ops" : `Short of ops (${+ops.toFixed(1)} of ${+needed.toFixed(1)} needed)`;
      const cut = u ? Math.round(u.opsCut * 100) : 0;
      list.push(cut > 0 ? `${who}: your servers run at ${100 - cut}% of their capacity` : `${who}: nobody to keep the service running`);
    }
    return list;
  }

  /**
   * Presses Launch with the opening price (the fair price with none): the company goes live on the next day played,
   * its first users arriving at the end of it, and the price holds from now until the usual lock after go-live. Only
   * once the MVP is done, and only once. It can go ahead short of servers or ops (see missing).
   */
  function launch(state: GameState, price?: number, rate?: number): GameState {
    if (state.launchDay !== null) throw new SimError("already_launched", "You've already launched.");
    if (!mvpDoneBy(state.mvp, state.day)) throw new SimError("mvp_first", "Your MVP isn't done yet: you can launch once it is.");
    const launchDay = state.day + 1;
    return { ...pricing.openingPrice(state, launchDay, price, rate), launchDay };
  }

  /**
   * A ramp day's arrivals, if `day` is one: its share of the launch users, each customer type reacting to the opening
   * price through the bands (see Pricing.launchBands): joining paying, joining free or not joining. Logged, with who
   * the joiners were for the customer mix. An auto launch's first ramp day is kept as go-live.
   */
  function arrive(state: GameState, day: number): { state: GameState; entries: LogEntry[]; joined: Record<CustomerTypeId, number> | null } {
    const k = rampDayOn(state, day);
    if (k === 0) return { state, entries: [], joined: null };
    const coming = arrivedBy(state, k) - arrivedBy(state, k - 1);
    const bands = pricing.launchBands(state, state.price, state.transactionRate ?? undefined);
    const share = (t: (typeof bands.types)[number], id: string) => t.bands.find((b) => b.id === id)?.share ?? 0;
    const joined = Object.fromEntries(
      bands.types.map((t) => [t.id, coming * t.share * (1 - share(t, "notJoin"))]),
    ) as Record<CustomerTypeId, number>;
    const users = Math.round(CUSTOMER_TYPE_IDS.reduce((sum, t) => sum + joined[t], 0));
    const paidUsers = Math.min(users, Math.round(bands.types.reduce((sum, t) => sum + coming * t.share * share(t, "joinPaid"), 0)));
    const stayedAway = coming - users;
    const when = rampDays === 1 ? "Launch day" : `Launch, day ${k} of ${rampDays}`;
    const done = k === rampDays && rampDays > 1 ? " That's everyone: normal growth takes over from tomorrow." : "";
    const away = stayedAway > 0 ? ` ${count.format(stayedAway)} more looked but didn't join at your price.` : "";
    const text = `${when}: ${count.format(users)} new users arrived, ${count.format(paidUsers)} of them paying.${away}${done}`;
    return {
      state: { ...state, launchDay: state.launchDay ?? day, users: state.users + users, paidUsers: state.paidUsers + paidUsers },
      entries: [{ text, cashDelta: 0, kind: "launch" }],
      joined,
    };
  }

  /** "waiting" or "upcoming": whether anyone is building the MVP. */
  const building = (state: GameState) =>
    mvpStatus(config, { ...state, output: staffOutput(config, state, "developers") }).launchDay === null ? "waiting" : "upcoming";

  function launchView(state: GameState): LaunchView {
    const rampDay = state.launchDay === null ? 0 : Math.max(0, Math.min(rampDays, state.day - state.launchDay + 1));
    const status =
      state.launchDay !== null
        ? rampDay < rampDays
          ? "launching"
          : "launched"
        : !mvpDoneBy(state.mvp, state.day)
          ? building(state)
          : config.launch.auto > 0
            ? setUp(state) ? "upcoming" : "waiting"
            : "ready";
    return {
      status,
      day: state.launchDay,
      rampDays,
      rampDay,
      arrived: arrivedBy(state, rampDay),
      needsServers: servers.hasServers(state.model),
      setUp: setUp(state),
      opsNeeded: servers.opsFor(state.model, state.servers),
      missing: state.launchDay === null ? missing(state) : [],
    };
  }

  return { rampDayOn, arrive, launch, launchView };
}

export type Launch = ReturnType<typeof createLaunch>;
