import {
  SERVER_SIZES,
  SERVER_TYPES,
  type GameConfig,
  type ManagedService,
  type ModelId,
  type ProductTypeId,
  type ServerCount,
  type ServerSize,
  type ServerType,
} from "./config.ts";
import { count, pounds, risen, type Finance } from "./finance.ts";
import {
  isManagedService,
  isServerSize,
  isServerType,
  SimError,
  type GameState,
  type LogEntry,
  type Server,
  type UnitDemand,
} from "./state.ts";

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

/**
 * Servers of one type and size in a setup a migration builds, for the quote and the migration panel. All of them were
 * added on the migration's first day.
 */
export interface SetupItem {
  type: ServerType;
  size: ServerSize;
  /** "App server", or on a managed platform "App instance", "Managed database". */
  name: string;
  count: number;
  /** CU, DBU or CH each; for a load balancer, the app servers it can serve. */
  units: number;
  /** What they cost to buy, all together, charged on the migration's first day; 0 where they're rented. */
  upfront: number;
  /** What they cost a month, all together: rent, or bought, power and upkeep once they've arrived. */
  monthly: number;
  /** Days until they're ready or, bought, arrive: 0 once they have. */
  daysLeft: number;
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
  /** The platform's load balancer is built in and free, and serves every instance (PaaS): none are ever needed. */
  builtIn: boolean;
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
  /**
   * Load balancers against app servers once every server the company has is ready, those being set up or on order
   * included: what loadBalancer will be, so a shortfall can be shown before it bites.
   */
  loadBalancerOnceReady: LoadBalancerView;
  /** Extra VMs an event rented met the day's demand: capacity shown includes them, for that day only. */
  burst: boolean;
}

/** One size of a managed service, for the picker. */
export interface ManagedOption {
  size: ServerSize;
  /** DBU for a database, CH for a cache. */
  units: number;
  /** A month, after any provider price rises. */
  monthlyCost: number;
}

/** A managed service the company runs: its size, units and price. */
export interface ManagedServiceView extends ManagedOption {
  /** Every size it comes in, smallest first. */
  options: ManagedOption[];
}

/**
 * The company's setup on a managed platform (PaaS): app instances, all one size, and the managed database and cache
 * the provider runs. Changes are instant, managed services need no ops, and the load balancer is built in and free.
 */
export interface ManagedView {
  instances: number;
  maxInstances: number;
  instanceSize: ServerSize;
  /** CU each instance gives. */
  instanceUnits: number;
  /** One instance a month, after any provider price rises. */
  instanceMonthlyCost: number;
  /**
   * Null with no database: a new company has none until it picks a size, and can't launch without one. Options are
   * on databaseOptions then.
   */
  database: ManagedServiceView | null;
  databaseOptions: ManagedOption[];
  /** Null with no cache, which is allowed: options are on cacheOptions then. */
  cache: ManagedServiceView | null;
  cacheOptions: ManagedOption[];
  /** Instances and managed services a month, after any provider price rises. The platform's own bill is apart. */
  monthlyCost: number;
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
 * Servers in units: the servers a company has on a model that uses them (IaaS rents VMs, on-prem buys kit, PaaS runs
 * app instances and managed services), what they cost, the ops they need and the CU, DBU and CH they give. A model
 * without servers config (SaaS) has none: there's no capacity limit there.
 *
 * Bought kit is paid for the moment it's bought, and is on order until it arrives after the model's readyDays: until
 * then it gives no units, needs no ops and costs nothing to run. An order can't be cancelled, since the kit is yours
 * once it's ordered; once it arrives it can be sold back at the configured share of what it cost.
 *
 * On a managed model (PaaS) the company doesn't rent servers one by one: it sets an instance count and picks the size
 * of each managed service. They're rented in all but name, so billed the same way, but ready at once, needing no ops,
 * and with the load balancer built in.
 */
export function createServers(config: GameConfig, finance: Finance) {
  const modelServers = (model: ModelId) => config.models[model].servers;
  const hasServers = (model: ModelId) => !!modelServers(model);
  const purchaseOf = (model: ModelId) => modelServers(model)?.purchase;
  const managedOf = (model: ModelId) => modelServers(model)?.managed;
  /** Whether a model buys its servers rather than renting them. */
  const buys = (model: ModelId) => !!purchaseOf(model);
  /** Units a server gives on a model: a managed database or cache has the platform's own. */
  const unitsOn = (model: ModelId, s: Pick<Server, "type" | "size">) => {
    const managed = managedOf(model);
    if (managed && isManagedService(s.type)) return managed.units[s.type][s.size];
    return config.servers.types[s.type].units[s.size];
  };
  const readyDaysOf = (model: ModelId) => modelServers(model)?.readyDays ?? 0;
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
   * Counts of servers as servers, numbered from nextId and ready at the end of readyDay. On a model that buys its
   * servers, each is marked as paid for at `price` (see kitEntries).
   */
  function build(
    model: ModelId,
    counts: ServerCount[],
    readyDay: number,
    nextId: number,
    price: (type: ServerType, size: ServerSize) => number,
  ): { servers: Server[]; nextServerId: number } {
    const servers: Server[] = [];
    const bought = buys(model);
    let id = nextId;
    for (const { type, size, count: n } of counts) {
      for (let i = 0; i < n; i++) servers.push({ id: id++, type, size, readyDay, ...(bought && { paid: price(type, size) }) });
    }
    return { servers, nextServerId: id };
  }

  /** A model's starter setup as servers, for a new company: bought ones at their purchase prices (see starterPurchases). */
  const starter = (model: ModelId, readyDay: number, nextId = 1) =>
    build(model, modelServers(model)?.starter ?? [], readyDay, nextId, (type, size) => purchaseOf(model)?.price[type][size] ?? 0);

  /** The cheapest of some choices, by cost then by fewest servers; the first of any that tie. */
  const cheapest = <T extends { cost: number; servers: number }>(choices: T[]) =>
    choices.reduce((best, c) => (c.cost < best.cost || (c.cost === best.cost && c.servers < best.servers) ? c : best));

  /**
   * The smallest sensible setup on a model for some CU and DBU demand, plus the configured headroom: what a migration
   * onto the model builds. Sized at base prices, so price rises don't change it.
   * - IaaS and on-prem: app servers and databases of whichever single size meets the demand most cheaply (rent, or
   *   on-prem the purchase price), at least one of each, and on enough app servers, the cheapest load balancers that
   *   cover them all. No cache: that's for the student to add.
   * - PaaS: ceil(CU ÷ instance CU) instances, up to the most allowed, and the smallest managed database that covers
   *   the DBU; past the biggest, the smallest managed cache that takes the rest.
   * - SaaS (no servers): nothing.
   */
  function sizeSetupFor(model: ModelId, demand: UnitDemand): ServerCount[] {
    const servers = modelServers(model);
    if (!servers) return [];
    const room = 1 + config.migration.setupHeadroom;
    const cu = demand.cu * room;
    const dbu = demand.dbu * room;
    const managed = servers.managed;
    if (managed) {
      const instanceUnits = unitsOn(model, { type: "app", size: managed.instanceSize });
      const instances = instanceUnits > 0 ? Math.ceil(cu / instanceUnits) : 1;
      const smallest = (type: ManagedService, units: number) =>
        SERVER_SIZES.find((size) => managed.units[type][size] >= units) ?? SERVER_SIZES[SERVER_SIZES.length - 1]!;
      const database = smallest("database", dbu);
      const setup: ServerCount[] = [
        { type: "app", size: managed.instanceSize, count: Math.min(managed.maxInstances, Math.max(1, instances)) },
        { type: "database", size: database, count: 1 },
      ];
      const rest = dbu - managed.units.database[database];
      if (rest > 0) setup.push({ type: "cache", size: smallest("cache", rest), count: 1 });
      return setup;
    }
    const price = (type: ServerType, size: ServerSize) =>
      servers.purchase ? servers.purchase.price[type][size] : (servers.monthlyCost[type]?.[size] ?? 0);
    // Of each size, enough of one type for the units, at least one.
    const options = (type: ServerType, units: number) =>
      SERVER_SIZES.filter((size) => unitsOn(model, { type, size }) > 0).map((size) => {
        const n = Math.max(1, Math.ceil(units / unitsOn(model, { type, size })));
        return { size, n, cost: n * price(type, size), servers: n };
      });
    const balancersFor = (apps: number) =>
      apps < config.servers.loadBalancerFrom ? { size: "small" as const, n: 0, cost: 0, servers: 0 } : cheapest(options("loadBalancer", apps));
    const app = cheapest(
      options("app", cu).map((o) => {
        const lb = balancersFor(o.n);
        return { ...o, lb, cost: o.cost + lb.cost, servers: o.n + lb.n };
      }),
    );
    const database = cheapest(options("database", dbu));
    const setup: ServerCount[] = [{ type: "app", size: app.size, count: app.n }];
    if (app.lb.n > 0) setup.push({ type: "loadBalancer", size: app.lb.size, count: app.lb.n });
    setup.push({ type: "database", size: database.size, count: database.n });
    return setup;
  }

  /**
   * The setup a migration onto a model builds for some demand (see sizeSetupFor), numbered from the company's next
   * server id. It's added on the migration's first day: rented servers are ready on the model's usual terms, and
   * bought ones are paid for at today's prices and on order for the delivery time, as if bought one by one.
   */
  function setupFor(state: GameState, model: ModelId, demand: UnitDemand) {
    const readyDay = state.day + readyDaysOf(model);
    const price = (type: ServerType, size: ServerSize) => purchasePrice(state, model, type, size);
    return build(model, sizeSetupFor(model, demand), readyDay, state.nextServerId, price);
  }

  /**
   * Buying kit, on a model that buys its servers: one line per type, size and price, each labelled ("Starter kit").
   * None where servers are rented: those are billed as rent.
   */
  function kitEntries(model: ModelId, list: Server[], label: string): LogEntry[] {
    if (!buys(model)) return [];
    const groups = new Map<string, { s: Server; n: number }>();
    for (const s of list) {
      const key = `${s.type}/${s.size}/${s.paid ?? 0}`;
      const group = groups.get(key);
      if (group) group.n++;
      else groups.set(key, { s, n: 1 });
    }
    return [...groups.values()]
      .filter(({ s }) => (s.paid ?? 0) > 0)
      .map(({ s, n }) => ({
        text: `${label}: bought ${plural(n, s.size, s.type)} at ${pounds(s.paid ?? 0)} each`,
        cashDelta: -n * (s.paid ?? 0),
        category: "infrastructure" as const,
      }));
  }

  /**
   * Buying a model's starter kit, on a model that buys its servers: charged with the model's upfront cost (the server
   * room), one line per type and size.
   */
  const starterPurchases = (model: ModelId) => kitEntries(model, starter(model, 0).servers, "Starter kit");

  /**
   * The servers a model has: the company's on its current model, and on the model a migration is moving to, the
   * setup being built there. None on any other model.
   */
  const serversOn = (state: GameState, model: ModelId) =>
    model === state.model ? state.servers : model === state.migration?.to ? state.migration.servers : [];

  /**
   * Some servers on a model grouped by type and size, in type then size order, with what they give and cost: a
   * migration's new setup, for the quote and the migration panel.
   */
  function setupItems(state: GameState, model: ModelId, list: Server[]): SetupItem[] {
    const managed = !!managedOf(model);
    const items: SetupItem[] = [];
    for (const type of SERVER_TYPES) {
      for (const size of SERVER_SIZES) {
        const of = list.filter((s) => s.type === type && s.size === size);
        if (of.length === 0) continue;
        items.push({
          type,
          size,
          name: managed ? managedName(type) : nameOf(type),
          count: of.length,
          units: unitsOn(model, { type, size }),
          upfront: of.reduce((sum, s) => sum + (s.paid ?? 0), 0),
          monthly: Math.round(of.length * monthlyCost(state, model, type, size) * 100) / 100,
          daysLeft: Math.max(0, ...of.map((s) => s.readyDay - state.day)),
        });
      }
    }
    return items;
  }

  /** A server's monthly price on a model, after the provider's price rises. One the model doesn't price is free. */
  function monthlyCost(state: GameState, model: ModelId, type: ServerType, size: ServerSize): number {
    const price = modelServers(model)?.monthlyCost[type]?.[size] ?? 0;
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
    const managed = !!managedOf(model);
    const entries: LogEntry[] = [];
    for (const type of SERVER_TYPES) {
      for (const size of SERVER_SIZES) {
        const n = servers.filter((s) => s.type === type && s.size === size).length;
        const price = monthlyCost(state, model, type, size);
        if (n === 0 || price === 0) continue;
        const text = managed
          ? `${managedName(type)} (${size}): ${count.format(n)} × ${pounds(price)} a month`
          : `${nameOf(type)} (${size}) ${what}: ${count.format(n)} × ${pounds(price)} a month`;
        entries.push({
          text,
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

  /**
   * Ops staff some servers need on a model: the model's fixed number (the few PaaS and SaaS need to keep the service
   * running), plus the total of each server's share, rounded up. Managed services have no share: the provider runs
   * them.
   */
  function opsFor(model: ModelId, servers: Pick<Server, "type">[]): number {
    const fixed = config.models[model].opsNeeded ?? 0;
    const perServer = modelServers(model)?.opsPerServer;
    if (!perServer) return fixed;
    // Shares like 0.1 don't add up exactly, so the total is rounded to a millionth before rounding up.
    return fixed + Math.ceil(Math.round(servers.reduce((sum, s) => sum + perServer[s.type], 0) * 1e6) / 1e6);
  }

  /**
   * Ops the company needs now: the model's fixed number, plus on a model with servers their shares (rented ones ready
   * or not, bought ones once they've arrived).
   */
  const opsNeeded = (state: GameState) =>
    opsFor(state.model, state.servers.filter((s) => inService(state.model, s, state.day)));

  /** Ops the company will need once every server it has is in service: on-prem, kit on order included. */
  const opsNeededOnceReady = (state: GameState) => opsFor(state.model, state.servers);

  /** Ops a model needs to start with: its fixed number, plus its starter setup's. */
  const modelOpsNeeded = (model: ModelId) => opsFor(model, starter(model, 0).servers);

  /** Refuses renting, cancelling, buying or selling single servers on a managed platform. */
  function refuseManaged(state: GameState) {
    if (!managedOf(state.model)) return;
    const { name } = config.models[state.model];
    throw new SimError(
      "managed",
      `On ${name} the platform runs the servers: set your instance count and managed service sizes instead.`,
    );
  }

  function rentServer(state: GameState, type: string, size: string): GameState {
    const servers = modelServers(state.model);
    const { name } = config.models[state.model];
    if (!servers) throw new SimError("no_servers", `You don't rent VMs on ${name}.`);
    refuseManaged(state);
    if (servers.purchase) throw new SimError("not_for_rent", `On ${name} you buy your servers rather than renting them.`);
    if (!isServerType(type) || !isServerSize(size)) {
      throw new SimError("unknown_server", "Pick a server type and size from the list.");
    }
    const server: Server = { id: state.nextServerId, type, size, readyDay: state.day + readyDaysOf(state.model) };
    return { ...state, servers: [...state.servers, server], nextServerId: state.nextServerId + 1 };
  }

  /** Finds one of the company's servers, or refuses. */
  function ownServer(state: GameState, id: number): Server {
    const server = state.servers.find((s) => s.id === id);
    if (!server) throw new SimError("unknown_server", "That server isn't one of yours.");
    return server;
  }

  function cancelServer(state: GameState, id: number): GameState {
    refuseManaged(state);
    ownServer(state, id);
    if (buys(state.model)) throw new SimError("not_rented", "You own that server, so there's no rent to cancel: sell it back instead.");
    return { ...state, servers: state.servers.filter((s) => s.id !== id) };
  }

  /** Buys a server: charged at once, and on order until it arrives after the model's readyDays. */
  function buyServer(state: GameState, type: string, size: string): GameState {
    const servers = modelServers(state.model);
    const { name } = config.models[state.model];
    if (!servers?.purchase) {
      const why = servers?.managed
        ? `On ${name} the platform runs the servers: set your instance count and managed service sizes instead.`
        : servers
          ? `On ${name} you rent VMs rather than buying servers.`
          : `You don't buy servers on ${name}.`;
      throw new SimError("not_for_sale", why);
    }
    if (!isServerType(type) || !isServerSize(size)) {
      throw new SimError("unknown_server", "Pick a server type and size from the list.");
    }
    const price = purchasePrice(state, state.model, type, size);
    if (price > state.cash) {
      throw new SimError("cant_afford", `That costs ${pounds(price)} up front and you have ${pounds(state.cash)}.`);
    }
    const days = readyDaysOf(state.model);
    const server: Server = { id: state.nextServerId, type, size, readyDay: state.day + days, paid: price };
    const bought = { ...state, servers: [...state.servers, server], nextServerId: state.nextServerId + 1 };
    const text = `Bought ${plural(1, size, type)}, arriving in ${days} days`;
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

  /** The name of a server on a managed platform: "App instance", "Managed database". */
  const managedName = (type: ServerType) =>
    type === "app" ? "App instance" : `Managed ${nameOf(type).toLowerCase()}`;

  /** The company's servers of a type, on its model. */
  const ofType = (state: GameState, type: ServerType) => state.servers.filter((s) => s.type === type);

  /** Checks the company is on a managed platform, and returns its config. */
  function managedConfig(state: GameState) {
    const managed = managedOf(state.model);
    if (!managed) {
      const { name } = config.models[state.model];
      throw new SimError("not_managed", `${name} doesn't run instances and managed services for you.`);
    }
    return managed;
  }

  /**
   * Sets how many app instances run on a managed platform. New ones are ready at once, serving from the next day
   * played; fewer drops the newest first. Billed a day's share at a time like any rent, so a change is pro rata.
   */
  function setInstances(state: GameState, n: number): GameState {
    const managed = managedConfig(state);
    if (!Number.isInteger(n) || n < 1 || n > managed.maxInstances) {
      throw new SimError("bad_instances", `Run between 1 and ${managed.maxInstances} app instances.`);
    }
    const apps = ofType(state, "app");
    if (n <= apps.length) {
      const dropped = new Set(apps.slice(n).map((s) => s.id));
      return { ...state, servers: state.servers.filter((s) => !dropped.has(s.id)) };
    }
    let id = state.nextServerId;
    const added: Server[] = Array.from({ length: n - apps.length }, () => ({
      id: id++,
      type: "app" as const,
      size: managed.instanceSize,
      readyDay: state.day,
    }));
    return { ...state, servers: [...state.servers, ...added], nextServerId: id };
  }

  /**
   * Sets the size of a managed service on a managed platform, ready at once like an instance. The cache can be turned
   * off (a null size); the database can't, since every product stores data.
   */
  function setManagedService(state: GameState, service: string, size: string | null): GameState {
    managedConfig(state);
    if (!isManagedService(service)) throw new SimError("unknown_service", "Pick the database or the cache.");
    if (size !== null && !isServerSize(size)) throw new SimError("unknown_size", "Pick a size from the list.");
    if (size === null && service === "database") {
      throw new SimError("database_required", "Your product needs a database: pick a size rather than turning it off.");
    }
    const current = ofType(state, service);
    if (current.length === (size ? 1 : 0) && current.every((s) => s.size === size)) return state;
    const kept = state.servers.filter((s) => s.type !== service);
    if (!size) return { ...state, servers: kept };
    const server: Server = { id: state.nextServerId, type: service, size, readyDay: state.day };
    return { ...state, servers: [...kept, server], nextServerId: state.nextServerId + 1 };
  }

  /** The company's setup on a managed platform, or null on any other model. */
  function managed(state: GameState): ManagedView | null {
    const platform = managedOf(state.model);
    if (!platform) return null;
    const option = (type: ManagedService, size: ServerSize): ManagedOption => ({
      size,
      units: platform.units[type][size],
      monthlyCost: monthlyCost(state, state.model, type, size),
    });
    const options = (type: ManagedService) => SERVER_SIZES.map((size) => option(type, size));
    const view = (type: ManagedService): ManagedServiceView | null => {
      const s = ofType(state, type)[0];
      return s ? { ...option(type, s.size), options: options(type) } : null;
    };
    return {
      instances: ofType(state, "app").length,
      maxInstances: platform.maxInstances,
      instanceSize: platform.instanceSize,
      instanceUnits: unitsOn(state.model, { type: "app", size: platform.instanceSize }),
      instanceMonthlyCost: monthlyCost(state, state.model, "app", platform.instanceSize),
      database: view("database"),
      databaseOptions: options("database"),
      cache: view("cache"),
      cacheOptions: options("cache"),
      monthlyCost: monthlyServerCost(state),
    };
  }

  /** What selling back all the company's bought kit would refund, on order or not: 0 where servers are rented. */
  const sellBackTotal = (state: GameState) =>
    buys(state.model) ? state.servers.reduce((sum, s) => sum + sellBackValue(state.model, s), 0) : 0;

  /**
   * What happens to the old setup when a migration off its model completes: rented VMs, and a platform's instances
   * and managed services, are cancelled, their rent having been billed up to and including the day you leave, so pro
   * rata; bought kit is sold back at the configured share, kit still on order included (the order goes with the move).
   */
  function leaveEntries(state: GameState): LogEntry[] {
    const n = state.servers.length;
    if (n === 0) return [];
    if (managedOf(state.model)) {
      const text = `Your app instances and managed services were cancelled: you paid for them only for the days you had them.`;
      return [{ text, cashDelta: 0, kind: "migration" }];
    }
    if (!buys(state.model)) {
      const text = `Your ${n} rented VM${n === 1 ? " was" : "s were"} cancelled: you paid rent only for the days you had them.`;
      return [{ text, cashDelta: 0, kind: "migration" }];
    }
    const refund = sellBackTotal(state);
    const paid = state.servers.reduce((sum, s) => sum + (s.paid ?? 0), 0);
    const share = Math.round(100 * (purchaseOf(state.model)?.sellBackShare ?? 0));
    const text = `Your ${n} server${n === 1 ? " was" : "s were"} sold back for ${pounds(refund)}: ${share}% of the ${pounds(paid)} you paid.`;
    return [{ text, cashDelta: refund, category: "infrastructure" }];
  }

  /**
   * Units the servers serving a day give, each tier scaled by `factor` (the cut for missing ops). Only servers ready
   * before the day count, and of the app servers only those the load balancers cover, biggest first. A platform's
   * built-in load balancer covers every instance.
   */
  function capacityOn(state: GameState, day: number, factor: number): UnitCapacity {
    const ready = state.servers.filter((s) => s.readyDay < day);
    const of = (type: ServerType) => ready.filter((s) => s.type === type).map((s) => unitsOn(state.model, s));
    const sum = (units: number[]) => units.reduce((a, b) => a + b, 0);
    const apps = of("app").sort((a, b) => b - a);
    const balancers = of("loadBalancer");
    const coverage = sum(balancers);
    const builtIn = !!managedOf(state.model);
    const needed = !builtIn && apps.length >= config.servers.loadBalancerFrom;
    // With no load balancer, traffic only reaches one app server.
    const counted = needed ? Math.min(apps.length, Math.max(1, coverage)) : apps.length;
    return {
      cu: sum(apps.slice(0, counted)) * factor,
      dbu: sum(of("database")) * factor,
      ch: sum(of("cache")) * factor,
      loadBalancer: {
        builtIn,
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
    const managed = !!managedOf(state.model);
    return state.servers.map((s) => ({
      id: s.id,
      type: s.type,
      size: s.size,
      name: managed ? managedName(s.type) : nameOf(s.type),
      status: s.readyDay <= state.day ? "ready" : "pending",
      readyDay: s.readyDay,
      daysLeft: Math.max(0, s.readyDay - state.day),
      units: unitsOn(state.model, s),
      monthlyCost: monthlyCost(state, state.model, s.type, s.size),
      paid: bought ? (s.paid ?? 0) : null,
      sellBack: bought ? sellBackValue(state.model, s) : null,
    }));
  }

  /**
   * Every type and size the company can add one at a time on its model, in config order. None on a model without
   * servers, or on a managed platform, where it sets instances and service sizes instead (see managed).
   */
  function serverOptions(state: GameState): ServerOption[] {
    const servers = modelServers(state.model);
    if (!servers || servers.managed) return [];
    return SERVER_TYPES.flatMap((type) =>
      SERVER_SIZES.map((size) => ({
        type,
        size,
        name: nameOf(type),
        blurb: config.servers.types[type].blurb,
        units: unitsOn(state.model, { type, size }),
        monthlyCost: monthlyCost(state, state.model, type, size),
        price: servers.purchase ? purchasePrice(state, state.model, type, size) : null,
        sellBackShare: servers.purchase?.sellBackShare ?? null,
        readyDays: readyDaysOf(state.model),
        ops: servers.opsPerServer?.[type] ?? 0,
      })),
    );
  }

  return {
    hasServers,
    isManaged: (model: ModelId) => !!managedOf(model),
    readyDaysOf,
    managedName,
    starter,
    starterPurchases,
    sizeSetupFor,
    setupFor,
    kitEntries,
    setupItems,
    sellBackTotal,
    opsFor,
    serverEntries,
    monthlyServerCost,
    opsNeeded,
    opsNeededOnceReady,
    modelOpsNeeded,
    rentServer,
    cancelServer,
    buyServer,
    sellServer,
    leaveEntries,
    setInstances,
    setManagedService,
    managed,
    capacityOn,
    serve,
    usersSupported,
    servers,
    serverOptions,
  };
}

export type Servers = ReturnType<typeof createServers>;
