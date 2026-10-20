import {
  SERVER_SIZES,
  SERVER_TYPES,
  type GameConfig,
  type ModelId,
  type ProductTypeId,
  type ServerSize,
  type ServerType,
} from "./config.ts";
import { count, pounds, risen } from "./finance.ts";
import { isServerSize, isServerType, SimError, type GameState, type LogEntry, type Server, type UnitDemand } from "./state.ts";

/** One of the company's servers, for the screen. */
export interface ServerView {
  id: number;
  type: ServerType;
  size: ServerSize;
  /** "App server". */
  name: string;
  /** Ready ones serve load; pending ones are being set up and serve from the day after their readyDay. */
  status: "ready" | "pending";
  readyDay: number;
  /** CU, DBU or CH; for a load balancer, the app servers it can serve. */
  units: number;
  /** Its monthly price today, after any provider price rises. */
  monthlyCost: number;
}

/** A server the company can add, for the rent modal. */
export interface ServerOption {
  type: ServerType;
  size: ServerSize;
  name: string;
  blurb: string;
  units: number;
  monthlyCost: number;
  /** Ops staff it needs: a share of a person, added up over every server. */
  ops: number;
}

/** Demand against capacity on one tier. Capacity 0 with demand above it is over capacity however small the demand. */
export interface TierView {
  demand: number;
  capacity: number;
}

/** Load balancers against the app servers they serve. */
export interface LoadBalancerView {
  /** Ready app servers. */
  appServers: number;
  /** Ready load balancers. */
  loadBalancers: number;
  /** Whether there are enough app servers to need load balancers. */
  needed: boolean;
  /** App servers the ready load balancers can serve between them. */
  coverage: number;
  /** App servers that count towards CU: all of them when no load balancer is needed. */
  counted: number;
  /** App servers that don't count, for want of load balancers. */
  uncovered: number;
}

/**
 * Units against demand, on a model with servers. Demand is the day just played's; capacity is the ready servers', for
 * the next day. The database's demand is what's left once the cache has taken its share.
 */
export interface UnitsView {
  cu: TierView;
  dbu: TierView & { beforeCache: number };
  /** Cache hits: demand is the share of database demand a cache can take; absorbed is what it took. */
  ch: TierView & { absorbed: number };
  /** The tier that runs out first: it sets capacity. */
  binding: "cu" | "dbu";
  /** Users the ready servers can serve at the product's usual demand, before load variation and spikes. */
  usersSupported: number;
  loadBalancer: LoadBalancerView;
  /** Extra VMs an event rented met the day's demand: capacity shown includes them, for that day only. */
  burst: boolean;
}

/** Units servers give on a day, after any cut for missing ops. */
export interface UnitCapacity {
  cu: number;
  dbu: number;
  ch: number;
  loadBalancer: LoadBalancerView;
}

/** How a day's demand meets the capacity: the cache's share, the database's demand after it, and each tier's load. */
export interface UnitServe {
  /** Cache hits the cache could take: the cacheable share of database demand. */
  cacheable: number;
  absorbed: number;
  dbuAfterCache: number;
  /** Demand ÷ capacity on each tier: over 1 is over capacity. */
  cuRatio: number;
  dbuRatio: number;
  binding: "cu" | "dbu";
  /** The binding tier's ratio. */
  ratio: number;
}

/**
 * Servers in units: the servers a company has on a model that uses them (IaaS rents VMs), what they cost, the ops they
 * need and the CU, DBU and CH they give. A model without servers config keeps its fixed capacity, so has none.
 */
export function createServers(config: GameConfig) {
  const modelServers = (model: ModelId) => config.models[model].servers;
  const hasServers = (model: ModelId) => !!modelServers(model);
  const unitsOf = (s: Pick<Server, "type" | "size">) => config.servers.types[s.type].units[s.size];
  const nameOf = (type: ServerType) => config.servers.types[type].name;

  /** A model's starter setup as servers, numbered from nextId and ready at the end of readyDay. */
  function starter(model: ModelId, readyDay: number, nextId = 1): { servers: Server[]; nextServerId: number } {
    const servers: Server[] = [];
    let id = nextId;
    for (const { type, size, count: n } of modelServers(model)?.starter ?? []) {
      for (let i = 0; i < n; i++) servers.push({ id: id++, type, size, readyDay });
    }
    return { servers, nextServerId: id };
  }

  /** The servers a model has: the company's on its current model, otherwise the starter setup it would get. */
  const serversOn = (state: GameState, model: ModelId) =>
    model === state.model ? state.servers : starter(model, state.day).servers;

  /** A server's monthly price on a model, after the provider's price rises. */
  function monthlyCost(state: GameState, model: ModelId, type: ServerType, size: ServerSize): number {
    const price = modelServers(model)?.monthlyCost[type][size] ?? 0;
    return risen(price, state.priceRises[model] ?? 1);
  }

  /**
   * Rent for some days on a model's servers, one line per type and size, billed as days ÷ daysPerMonth of a month and
   * rounded to the pound, like the model's monthly cost.
   */
  function serverEntries(state: GameState, model: ModelId, days = 1): LogEntry[] {
    const servers = serversOn(state, model);
    const share = days / config.billing.daysPerMonth;
    const entries: LogEntry[] = [];
    for (const type of SERVER_TYPES) {
      for (const size of SERVER_SIZES) {
        const n = servers.filter((s) => s.type === type && s.size === size).length;
        const price = monthlyCost(state, model, type, size);
        if (n === 0 || price === 0) continue;
        entries.push({
          text: `${nameOf(type)} (${size}) rent: ${count.format(n)} × ${pounds(price)} a month`,
          cashDelta: -Math.round(n * price * share),
          category: "infrastructure",
        });
      }
    }
    return entries;
  }

  const monthlyServerCost = (state: GameState) =>
    state.servers.reduce((sum, s) => sum + monthlyCost(state, state.model, s.type, s.size), 0);

  /** Ops staff some servers need on a model: the total of each one's share, rounded up. */
  function opsFor(model: ModelId, servers: Pick<Server, "type">[]): number {
    const perServer = modelServers(model)?.opsPerServer;
    if (!perServer) return 0;
    // Shares like 0.1 don't add up exactly, so the total is rounded to a millionth before rounding up.
    return Math.ceil(Math.round(servers.reduce((sum, s) => sum + perServer[s.type], 0) * 1e6) / 1e6);
  }

  /** Ops the company needs now: from its servers on a model with them, otherwise the model's fixed number. */
  const opsNeeded = (state: GameState) =>
    hasServers(state.model) ? opsFor(state.model, state.servers) : (config.models[state.model].opsNeeded ?? 0);

  /** Ops a model needs to start with: its starter setup's, or its fixed number. */
  const modelOpsNeeded = (model: ModelId) =>
    hasServers(model) ? opsFor(model, starter(model, 0).servers) : (config.models[model].opsNeeded ?? 0);

  function rentServer(state: GameState, type: string, size: string): GameState {
    const servers = modelServers(state.model);
    if (!servers) {
      throw new SimError("no_servers", `You don't rent VMs on ${config.models[state.model].name}.`);
    }
    if (!isServerType(type) || !isServerSize(size)) {
      throw new SimError("unknown_server", "Pick a server type and size from the list.");
    }
    const server: Server = { id: state.nextServerId, type, size, readyDay: state.day + servers.readyDays };
    return { ...state, servers: [...state.servers, server], nextServerId: state.nextServerId + 1 };
  }

  function cancelServer(state: GameState, id: number): GameState {
    if (!state.servers.some((s) => s.id === id)) throw new SimError("unknown_server", "That server isn't one of yours.");
    return { ...state, servers: state.servers.filter((s) => s.id !== id) };
  }

  /**
   * Units the servers serving a day give, each tier scaled by `factor` (the cut for missing ops). Only servers ready
   * before the day count, and of the app servers only those the load balancers cover, biggest first.
   */
  function capacityOn(state: GameState, day: number, factor: number): UnitCapacity {
    const ready = state.servers.filter((s) => s.readyDay < day);
    const of = (type: ServerType) => ready.filter((s) => s.type === type).map(unitsOf);
    const sum = (units: number[]) => units.reduce((a, b) => a + b, 0);
    const apps = of("app").sort((a, b) => b - a);
    const balancers = of("loadBalancer");
    const coverage = sum(balancers);
    const needed = apps.length >= config.servers.loadBalancerFrom;
    // With no load balancer, traffic only reaches one app server.
    const counted = needed ? Math.min(apps.length, Math.max(1, coverage)) : apps.length;
    return {
      cu: sum(apps.slice(0, counted)) * factor,
      dbu: sum(of("database")) * factor,
      ch: sum(of("cache")) * factor,
      loadBalancer: {
        appServers: apps.length,
        loadBalancers: balancers.length,
        needed,
        coverage,
        counted,
        uncovered: apps.length - counted,
      },
    };
  }

  /** Demand against capacity. A tier with no capacity and some demand is infinitely over. */
  function serve(cap: Pick<UnitCapacity, "cu" | "dbu" | "ch">, demand: UnitDemand): UnitServe {
    const cacheable = demand.dbu * config.servers.cacheableShare;
    const absorbed = Math.min(cap.ch, cacheable);
    const dbuAfterCache = demand.dbu - absorbed;
    const ratio = (d: number, c: number) => (d <= 0 ? 0 : c <= 0 ? Infinity : d / c);
    const cuRatio = ratio(demand.cu, cap.cu);
    const dbuRatio = ratio(dbuAfterCache, cap.dbu);
    const binding = cuRatio >= dbuRatio ? "cu" : "dbu";
    return { cacheable, absorbed, dbuAfterCache, cuRatio, dbuRatio, binding, ratio: Math.max(cuRatio, dbuRatio) };
  }

  /**
   * Users the capacity can serve at a product's demand per user. The database serves u users while
   * u × DBU − min(CH, share × u × DBU) is within its DBU, which works out as both of the limits below.
   */
  function usersSupported(cap: Pick<UnitCapacity, "cu" | "dbu" | "ch">, productType: ProductTypeId): number {
    const { cuPerUser, dbuPerUser } = config.productTypes[productType].demand;
    const share = config.servers.cacheableShare;
    const byCu = cuPerUser > 0 ? cap.cu / cuPerUser : Infinity;
    const byDbu =
      dbuPerUser > 0
        ? Math.min((cap.dbu + cap.ch) / dbuPerUser, share < 1 ? cap.dbu / (dbuPerUser * (1 - share)) : Infinity)
        : Infinity;
    return Math.min(byCu, byDbu);
  }

  function servers(state: GameState): ServerView[] {
    return state.servers.map(({ id, type, size, readyDay }) => ({
      id,
      type,
      size,
      name: nameOf(type),
      status: readyDay <= state.day ? "ready" : "pending",
      readyDay,
      units: unitsOf({ type, size }),
      monthlyCost: monthlyCost(state, state.model, type, size),
    }));
  }

  /** Every type and size the company can add on its model, in config order. None on a model without servers. */
  function serverOptions(state: GameState): ServerOption[] {
    if (!hasServers(state.model)) return [];
    return SERVER_TYPES.flatMap((type) =>
      SERVER_SIZES.map((size) => ({
        type,
        size,
        name: nameOf(type),
        blurb: config.servers.types[type].blurb,
        units: unitsOf({ type, size }),
        monthlyCost: monthlyCost(state, state.model, type, size),
        ops: modelServers(state.model)!.opsPerServer[type],
      })),
    );
  }

  return {
    hasServers,
    starter,
    serverEntries,
    monthlyServerCost,
    opsNeeded,
    modelOpsNeeded,
    rentServer,
    cancelServer,
    capacityOn,
    serve,
    usersSupported,
    servers,
    serverOptions,
  };
}

export type Servers = ReturnType<typeof createServers>;
