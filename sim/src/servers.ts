import {
  SERVER_SIZES,
  SERVER_TYPES,
  type GameConfig,
  type ModelId,
  type ProductTypeId,
  type ServerSize,
  type ServerType,
} from "./config.ts";
import { count, pounds, risen, type Finance } from "./finance.ts";
import { isServerSize, isServerType, SimError, type GameState, type LogEntry, type Server, type UnitDemand } from "./state.ts";

/** One of the company's servers, for the screen. */
export interface ServerView {
  id: number;
  type: ServerType;
  size: ServerSize;
  /** "App server". */
  name: string;
  /**
   * Ready ones serve load; pending ones are being set up (or, bought, are on order) and serve from the day after
   * their readyDay.
   */
  status: "ready" | "pending";
  readyDay: number;
  /** Days until it's ready or, bought, arrives: 0 once it has. */
  daysLeft: number;
  /** CU, DBU or CH; for a load balancer, the app servers it can serve. */
  units: number;
  /** Its monthly price today, after any provider price rises: rent, or for a bought one, power and upkeep. */
  monthlyCost: number;
  /** What it was bought for, or null for a rented one. */
  paid: number | null;
  /** What selling it back would refund now, or null for a rented one. */
  sellBack: number | null;
}

/** A server the company can add, for the rent or buy modal. */
export interface ServerOption {
  type: ServerType;
  size: ServerSize;
  name: string;
  blurb: string;
  units: number;
  /** Rent a month, or on a model that buys its servers, power and upkeep a month. */
  monthlyCost: number;
  /** The purchase price, charged at once, on a model that buys its servers; null where they're rented. */
  price: number | null;
  /** Share of the purchase price selling it back refunds, or null where servers are rented. */
  sellBackShare: number | null;
  /** Days until it's ready (rented) or arrives (bought). */
  readyDays: number;
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
 * Servers in units: the servers a company has on a model that uses them (IaaS rents VMs, on-prem buys kit), what they
 * cost, the ops they need and the CU, DBU and CH they give. A model without servers config keeps its fixed capacity,
 * so has none.
 *
 * Bought kit is paid for the moment it's bought, and is on order until it arrives after the model's readyDays: until
 * then it gives no units, needs no ops and costs nothing to run. An order can't be cancelled, since the kit is yours
 * once it's ordered; once it arrives it can be sold back at the configured share of what it cost.
 */
export function createServers(config: GameConfig, finance: Finance) {
  const modelServers = (model: ModelId) => config.models[model].servers;
  const hasServers = (model: ModelId) => !!modelServers(model);
  const purchaseOf = (model: ModelId) => modelServers(model)?.purchase;
  /** Whether a model buys its servers rather than renting them. */
  const buys = (model: ModelId) => !!purchaseOf(model);
  const unitsOf = (s: Pick<Server, "type" | "size">) => config.servers.types[s.type].units[s.size];
  const nameOf = (type: ServerType) => config.servers.types[type].name;
  const plural = (n: number, size: ServerSize, type: ServerType) =>
    `${count.format(n)} ${size} ${nameOf(type).toLowerCase()}${n === 1 ? "" : "s"}`;

  /**
   * Whether a server is in service at the end of `day`: billed, and needing ops. A rented VM is from the moment it's
   * added; bought kit once it has arrived.
   */
  const inService = (model: ModelId, s: Server, day: number) => !buys(model) || s.readyDay <= day;

  /** A server's purchase price on a model that buys them, after any price rises; 0 where they're rented. */
  function purchasePrice(state: GameState, model: ModelId, type: ServerType, size: ServerSize): number {
    const price = purchaseOf(model)?.price[type][size] ?? 0;
    return risen(price, state.priceRises[model] ?? 1);
  }

  /** What selling a bought server back refunds: the configured share of what it cost, to the pound. */
  const sellBackValue = (model: ModelId, s: Server) => Math.round((s.paid ?? 0) * (purchaseOf(model)?.sellBackShare ?? 0));

  /**
   * A model's starter setup as servers, numbered from nextId and ready at the end of readyDay. On a model that buys
   * its servers, each is marked as paid for at its purchase price (see starterPurchases).
   */
  function starter(model: ModelId, readyDay: number, nextId = 1): { servers: Server[]; nextServerId: number } {
    const servers: Server[] = [];
    const purchase = purchaseOf(model);
    let id = nextId;
    for (const { type, size, count: n } of modelServers(model)?.starter ?? []) {
      for (let i = 0; i < n; i++) {
        servers.push({ id: id++, type, size, readyDay, ...(purchase && { paid: purchase.price[type][size] }) });
      }
    }
    return { servers, nextServerId: id };
  }

  /**
   * Buying a model's starter kit, on a model that buys its servers: charged with the model's upfront cost (the server
   * room), one line per type and size. None where servers are rented: those are billed as rent.
   */
  function starterPurchases(model: ModelId): LogEntry[] {
    const purchase = purchaseOf(model);
    if (!purchase) return [];
    return (modelServers(model)?.starter ?? [])
      .filter((s) => s.count > 0 && purchase.price[s.type][s.size] > 0)
      .map(({ type, size, count: n }) => ({
        text: `Starter kit: bought ${plural(n, size, type)} at ${pounds(purchase.price[type][size])} each`,
        cashDelta: -n * purchase.price[type][size],
        category: "infrastructure" as const,
      }));
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
   * Rent for some days on a model's servers (or on one that buys them, power and upkeep on the kit that has arrived),
   * one line per type and size, billed as days ÷ daysPerMonth of a month and rounded to the pound, like the model's
   * monthly cost.
   */
  function serverEntries(state: GameState, model: ModelId, days = 1): LogEntry[] {
    const servers = serversOn(state, model).filter((s) => inService(model, s, state.day));
    const share = days / config.billing.daysPerMonth;
    const what = buys(model) ? "power and upkeep" : "rent";
    const entries: LogEntry[] = [];
    for (const type of SERVER_TYPES) {
      for (const size of SERVER_SIZES) {
        const n = servers.filter((s) => s.type === type && s.size === size).length;
        const price = monthlyCost(state, model, type, size);
        if (n === 0 || price === 0) continue;
        entries.push({
          text: `${nameOf(type)} (${size}) ${what}: ${count.format(n)} × ${pounds(price)} a month`,
          cashDelta: -Math.round(n * price * share),
          category: "infrastructure",
        });
      }
    }
    return entries;
  }

  const monthlyServerCost = (state: GameState) =>
    state.servers
      .filter((s) => inService(state.model, s, state.day))
      .reduce((sum, s) => sum + monthlyCost(state, state.model, s.type, s.size), 0);

  /** Ops staff some servers need on a model: the total of each one's share, rounded up. */
  function opsFor(model: ModelId, servers: Pick<Server, "type">[]): number {
    const perServer = modelServers(model)?.opsPerServer;
    if (!perServer) return 0;
    // Shares like 0.1 don't add up exactly, so the total is rounded to a millionth before rounding up.
    return Math.ceil(Math.round(servers.reduce((sum, s) => sum + perServer[s.type], 0) * 1e6) / 1e6);
  }

  /**
   * Ops the company needs now: from its servers on a model with them (rented ones ready or not, bought ones once
   * they've arrived), otherwise the model's fixed number.
   */
  const opsNeeded = (state: GameState) =>
    hasServers(state.model)
      ? opsFor(state.model, state.servers.filter((s) => inService(state.model, s, state.day)))
      : (config.models[state.model].opsNeeded ?? 0);

  /** Ops a model needs to start with: its starter setup's, or its fixed number. */
  const modelOpsNeeded = (model: ModelId) =>
    hasServers(model) ? opsFor(model, starter(model, 0).servers) : (config.models[model].opsNeeded ?? 0);

  function rentServer(state: GameState, type: string, size: string): GameState {
    const servers = modelServers(state.model);
    const { name } = config.models[state.model];
    if (!servers) throw new SimError("no_servers", `You don't rent VMs on ${name}.`);
    if (servers.purchase) throw new SimError("not_for_rent", `On ${name} you buy your servers rather than renting them.`);
    if (!isServerType(type) || !isServerSize(size)) {
      throw new SimError("unknown_server", "Pick a server type and size from the list.");
    }
    const server: Server = { id: state.nextServerId, type, size, readyDay: state.day + servers.readyDays };
    return { ...state, servers: [...state.servers, server], nextServerId: state.nextServerId + 1 };
  }

  /** Finds one of the company's servers, or refuses. */
  function ownServer(state: GameState, id: number): Server {
    const server = state.servers.find((s) => s.id === id);
    if (!server) throw new SimError("unknown_server", "That server isn't one of yours.");
    return server;
  }

  function cancelServer(state: GameState, id: number): GameState {
    ownServer(state, id);
    if (buys(state.model)) throw new SimError("not_rented", "You own that server, so there's no rent to cancel: sell it back instead.");
    return { ...state, servers: state.servers.filter((s) => s.id !== id) };
  }

  /** Buys a server: charged at once, and on order until it arrives after the model's readyDays. */
  function buyServer(state: GameState, type: string, size: string): GameState {
    const servers = modelServers(state.model);
    const { name } = config.models[state.model];
    if (!servers?.purchase) {
      throw new SimError("not_for_sale", servers ? `On ${name} you rent VMs rather than buying servers.` : `You don't buy servers on ${name}.`);
    }
    if (!isServerType(type) || !isServerSize(size)) {
      throw new SimError("unknown_server", "Pick a server type and size from the list.");
    }
    const price = purchasePrice(state, state.model, type, size);
    if (price > state.cash) {
      throw new SimError("cant_afford", `That costs ${pounds(price)} up front and you have ${pounds(state.cash)}.`);
    }
    const server: Server = { id: state.nextServerId, type, size, readyDay: state.day + servers.readyDays, paid: price };
    const bought = { ...state, servers: [...state.servers, server], nextServerId: state.nextServerId + 1 };
    const text = `Bought ${plural(1, size, type)}, arriving in ${servers.readyDays} days`;
    return finance.chargeNow(bought, [{ text, cashDelta: -price, category: "infrastructure" }]);
  }

  /**
   * Sells a bought server back at the configured share of what it cost, refunded at once. Kit still on order can't
   * be: an order can't be cancelled, so it has to arrive first.
   */
  function sellServer(state: GameState, id: number): GameState {
    if (!buys(state.model)) {
      throw new SimError("not_for_sale", `You don't own servers on ${config.models[state.model].name}, so there's nothing to sell.`);
    }
    const server = ownServer(state, id);
    const daysLeft = server.readyDay - state.day;
    if (daysLeft > 0) {
      throw new SimError(
        "on_order",
        `That server is still on order, and orders can't be cancelled. You can sell it once it arrives in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`,
        { daysLeft },
      );
    }
    const refund = sellBackValue(state.model, server);
    const sold = { ...state, servers: state.servers.filter((s) => s.id !== id) };
    const text = `Sold back ${plural(1, server.size, server.type)} for ${pounds(refund)}`;
    return finance.chargeNow(sold, [{ text, cashDelta: refund, category: "infrastructure" }]);
  }

  /**
   * What happens to the company's servers when a migration off its model completes, until migration sizes the new
   * setup (#51): rented VMs are cancelled, their rent having been billed up to the day you leave; bought kit is sold
   * back at the configured share, kit still on order included (the order goes with the move).
   */
  function leaveEntries(state: GameState): LogEntry[] {
    const n = state.servers.length;
    if (n === 0) return [];
    if (!buys(state.model)) {
      const text = `Your ${n} rented VM${n === 1 ? " was" : "s were"} cancelled: you paid rent only for the days you had them.`;
      return [{ text, cashDelta: 0, kind: "migration" }];
    }
    const refund = state.servers.reduce((sum, s) => sum + sellBackValue(state.model, s), 0);
    const paid = state.servers.reduce((sum, s) => sum + (s.paid ?? 0), 0);
    const share = Math.round(100 * (purchaseOf(state.model)?.sellBackShare ?? 0));
    const text = `Your ${n} server${n === 1 ? " was" : "s were"} sold back for ${pounds(refund)}: ${share}% of the ${pounds(paid)} you paid.`;
    return [{ text, cashDelta: refund, category: "infrastructure" }];
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
    const bought = buys(state.model);
    return state.servers.map((s) => ({
      id: s.id,
      type: s.type,
      size: s.size,
      name: nameOf(s.type),
      status: s.readyDay <= state.day ? "ready" : "pending",
      readyDay: s.readyDay,
      daysLeft: Math.max(0, s.readyDay - state.day),
      units: unitsOf(s),
      monthlyCost: monthlyCost(state, state.model, s.type, s.size),
      paid: bought ? (s.paid ?? 0) : null,
      sellBack: bought ? sellBackValue(state.model, s) : null,
    }));
  }

  /** Every type and size the company can add on its model, in config order. None on a model without servers. */
  function serverOptions(state: GameState): ServerOption[] {
    const servers = modelServers(state.model);
    if (!servers) return [];
    return SERVER_TYPES.flatMap((type) =>
      SERVER_SIZES.map((size) => ({
        type,
        size,
        name: nameOf(type),
        blurb: config.servers.types[type].blurb,
        units: unitsOf({ type, size }),
        monthlyCost: monthlyCost(state, state.model, type, size),
        price: servers.purchase ? purchasePrice(state, state.model, type, size) : null,
        sellBackShare: servers.purchase?.sellBackShare ?? null,
        readyDays: servers.readyDays,
        ops: servers.opsPerServer[type],
      })),
    );
  }

  return {
    hasServers,
    starter,
    starterPurchases,
    serverEntries,
    monthlyServerCost,
    opsNeeded,
    modelOpsNeeded,
    rentServer,
    cancelServer,
    buyServer,
    sellServer,
    leaveEntries,
    capacityOn,
    serve,
    usersSupported,
    servers,
    serverOptions,
  };
}

export type Servers = ReturnType<typeof createServers>;
