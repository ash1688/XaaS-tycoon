import { RACK_SIZES, type GameConfig, type ModelId, type RackSize, type ServerSize } from "./config.ts";
import { count, pounds, priceRiseOn, risen, type Finance } from "./finance.ts";
import { isRackSize, SimError, type GameState, type LogEntry, type Rack, type Server } from "./state.ts";

/** One of the company's racks, for the screen. */
export interface RackView {
  id: number;
  size: RackSize;
  /** The U it holds. */
  units: number;
  /** U its servers take, on order included. */
  used: number;
  free: number;
  /** The servers installed in it, by id, on order included. */
  servers: number[];
  paid: number;
  /** What selling it back would refund now. Only an empty rack can be sold. */
  sellBack: number;
}

/** A rack the company can buy. */
export interface RackOption {
  size: RackSize;
  units: number;
  /** After any price rises. */
  price: number;
  /** Charged on top of the price. */
  cabling: number;
}

/** The company's racks on a model whose servers go in racks (on-prem): what they hold, and what more would cost. */
export interface RacksView {
  racks: RackView[];
  options: RackOption[];
  /** U across every rack, used and free. */
  units: number;
  used: number;
  free: number;
  /** The most free U in any one rack: a server has to fit in one rack, so this is the biggest that can go in now. */
  mostFree: number;
  /** The U a server of each size takes. */
  serverUnits: Record<ServerSize, number>;
}

/**
 * Racks and cabling, on a model whose servers go in racks (on-prem). Every server is installed in a rack and takes its
 * size's rack units (U) there from the day it's ordered to the day it's sold, so a growing company has to buy racks
 * as well as servers. Racks are bought outright and installed at once; an empty one can be sold back at the model's
 * sell-back share. Every piece of hardware bought, a server or a rack, is charged cabling on top (cabling). IaaS, PaaS
 * and SaaS have no racks: the provider's kit is the provider's.
 */
export function createRacks(config: GameConfig, finance: Finance) {
  const racksOf = (model: ModelId) => config.models[model].servers?.racks;
  const hasRacks = (model: ModelId) => !!racksOf(model);
  /** Cabling on each piece of hardware bought, on a model that buys its servers. */
  const cablingOf = (model: ModelId) => config.models[model].servers?.purchase?.cablingCost ?? 0;
  const sellBackShare = (model: ModelId) => config.models[model].servers?.purchase?.sellBackShare ?? 0;
  /** The U a server of a size takes, on a model with racks; 0 on any other. */
  const serverUnits = (model: ModelId, size: ServerSize) => racksOf(model)?.serverUnits[size] ?? 0;
  const rackUnits = (model: ModelId, size: RackSize) => racksOf(model)?.sizes[size].units ?? 0;
  const basePrice = (model: ModelId, size: RackSize) => racksOf(model)?.sizes[size].price ?? 0;
  /** A rack's price today, after any price rises on the model. */
  const rackPrice = (state: GameState, model: ModelId, size: RackSize) =>
    risen(basePrice(model, size), priceRiseOn(state, model));
  const sellBackValue = (model: ModelId, rack: Rack) => Math.round(rack.paid * sellBackShare(model));
  const racksText = (n: number, size: RackSize) => `${count.format(n)} ${size} rack${n === 1 ? "" : "s"}`;

  const usedIn = (model: ModelId, rack: Rack, servers: Server[]) =>
    servers.reduce((sum, s) => sum + (s.rack === rack.id ? serverUnits(model, s.size) : 0), 0);
  const freeIn = (model: ModelId, rack: Rack, servers: Server[]) => rackUnits(model, rack.size) - usedIn(model, rack, servers);

  /**
   * Racks for a setup on a model with racks: the ones the server room comes with, then each server installed in the
   * first with room, biggest first so they pack. When none has room, it buys the smallest rack that holds every server
   * still to go in, or the biggest. Racks are priced by `price`; servers keep their order. Nothing on another model.
   */
  function install(
    model: ModelId,
    list: Server[],
    nextRackId: number,
    price: (size: RackSize) => number,
  ): { servers: Server[]; racks: Rack[]; nextRackId: number } {
    const setup = racksOf(model);
    if (!setup) return { servers: list, racks: [], nextRackId };
    let id = nextRackId;
    const racks: Rack[] = setup.starter.map((size) => ({ id: id++, size, paid: price(size) }));
    const order = [...list].sort((a, b) => serverUnits(model, b.size) - serverUnits(model, a.size));
    const placed: Server[] = [];
    order.forEach((s, i) => {
      let rack = racks.find((r) => freeIn(model, r, placed) >= serverUnits(model, s.size));
      if (!rack) {
        const left = order.slice(i).reduce((sum, o) => sum + serverUnits(model, o.size), 0);
        const size = RACK_SIZES.find((r) => rackUnits(model, r) >= left) ?? RACK_SIZES[RACK_SIZES.length - 1]!;
        rack = { id: id++, size, paid: price(size) };
        racks.push(rack);
      }
      placed.push({ ...s, rack: rack.id });
    });
    const byId = new Map(placed.map((s) => [s.id, s]));
    return { servers: list.map((s) => byId.get(s.id)!), racks, nextRackId: id };
  }

  /** A model's setup installed in racks at base prices: a new company's (see Servers.starter). */
  const installAtBase = (model: ModelId, list: Server[], nextRackId: number) =>
    install(model, list, nextRackId, (size) => basePrice(model, size));

  /** The same at today's prices: a migration's setup. */
  const installToday = (state: GameState, model: ModelId, list: Server[], nextRackId: number) =>
    install(model, list, nextRackId, (size) => rackPrice(state, model, size));

  /** Buying racks: one line per size and price, labelled ("Starter kit"). */
  function rackEntries(racks: Rack[], label: string): LogEntry[] {
    const groups = new Map<string, { rack: Rack; n: number }>();
    for (const rack of racks) {
      const key = `${rack.size}/${rack.paid}`;
      const group = groups.get(key);
      if (group) group.n++;
      else groups.set(key, { rack, n: 1 });
    }
    return [...groups.values()]
      .filter(({ rack }) => rack.paid > 0)
      .map(({ rack, n }) => ({
        text: `${label}: bought ${racksText(n, rack.size)} at ${pounds(rack.paid)} each`,
        cashDelta: -n * rack.paid,
        category: "infrastructure" as const,
      }));
  }

  /** Cabling for some pieces of hardware bought on a model, as its own charge. None where there's no cabling. */
  function cablingEntries(model: ModelId, pieces: number, label: string): LogEntry[] {
    const each = cablingOf(model);
    if (pieces === 0 || each === 0) return [];
    const text = `${label}: cabling for ${count.format(pieces)} piece${pieces === 1 ? "" : "s"} of kit at ${pounds(each)} each`;
    return [{ text, cashDelta: -pieces * each, category: "cabling" }];
  }

  /** Refuses rack actions on a model without racks. */
  function checkRacks(state: GameState) {
    if (hasRacks(state.model)) return;
    const { name } = config.models[state.model];
    throw new SimError("no_racks", `There are no racks on ${name}: the provider's kit is theirs to rack.`);
  }

  /**
   * The rack a new server of a size goes in: the one asked for if it has room, or the first that does. Refuses when
   * none has room, saying what would.
   */
  function rackFor(state: GameState, size: ServerSize, wanted?: number): number {
    const model = state.model;
    const needs = serverUnits(model, size);
    if (wanted !== undefined) {
      const rack = state.racks.find((r) => r.id === wanted);
      if (!rack) throw new SimError("unknown_rack", "That rack isn't one of yours.");
      const free = freeIn(model, rack, state.servers);
      if (free < needs) {
        throw new SimError("rack_full", `A ${size} server takes ${needs}U and rack #${rack.id} has ${free}U free.`, { needs, free });
      }
      return rack.id;
    }
    const rack = state.racks.find((r) => freeIn(model, r, state.servers) >= needs);
    if (rack) return rack.id;
    const free = Math.max(0, ...state.racks.map((r) => freeIn(model, r, state.servers)));
    throw new SimError(
      "no_rack_space",
      `A ${size} server takes ${needs}U and the most free in any one rack is ${free}U. Buy a rack, or sell a server, to make room.`,
      { needs, free },
    );
  }

  /** Buys a rack: its price and cabling charged at once, and installed at once. */
  function buyRack(state: GameState, size: string): GameState {
    checkRacks(state);
    if (!isRackSize(size)) throw new SimError("unknown_rack_size", "Pick a rack size from the list.");
    const price = rackPrice(state, state.model, size);
    const cabling = cablingOf(state.model);
    if (price + cabling > state.cash) {
      throw new SimError(
        "cant_afford",
        `That costs ${pounds(price + cabling)} with its cabling and you have ${pounds(state.cash)}.`,
      );
    }
    const rack: Rack = { id: state.nextRackId, size, paid: price };
    const bought = { ...state, racks: [...state.racks, rack], nextRackId: state.nextRackId + 1 };
    const units = rackUnits(state.model, size);
    return finance.chargeNow(bought, [
      { text: `Bought a ${size} rack (${units}U), installed now`, cashDelta: -price, category: "infrastructure" },
      ...cablingEntries(state.model, 1, "New rack"),
    ]);
  }

  /** Sells back an empty rack at the model's sell-back share, refunded at once. */
  function sellRack(state: GameState, id: number): GameState {
    checkRacks(state);
    const rack = state.racks.find((r) => r.id === id);
    if (!rack) throw new SimError("unknown_rack", "That rack isn't one of yours.");
    const inIt = state.servers.filter((s) => s.rack === id).length;
    if (inIt > 0) {
      throw new SimError(
        "rack_in_use",
        `Rack #${id} still has ${inIt} server${inIt === 1 ? "" : "s"} in it: sell ${inIt === 1 ? "it" : "them"} first.`,
        { servers: inIt },
      );
    }
    const refund = sellBackValue(state.model, rack);
    const sold = { ...state, racks: state.racks.filter((r) => r.id !== id) };
    return finance.chargeNow(sold, [{ text: `Sold back a ${rack.size} rack for ${pounds(refund)}`, cashDelta: refund, category: "infrastructure" }]);
  }

  /** What selling back every rack the company has would refund. */
  const sellBackTotal = (state: GameState) => state.racks.reduce((sum, r) => sum + sellBackValue(state.model, r), 0);

  function racks(state: GameState): RacksView | null {
    const setup = racksOf(state.model);
    if (!setup) return null;
    const views = state.racks.map((rack): RackView => {
      const units = rackUnits(state.model, rack.size);
      const used = usedIn(state.model, rack, state.servers);
      return {
        id: rack.id,
        size: rack.size,
        units,
        used,
        free: units - used,
        servers: state.servers.filter((s) => s.rack === rack.id).map((s) => s.id),
        paid: rack.paid,
        sellBack: sellBackValue(state.model, rack),
      };
    });
    const sum = (f: (r: RackView) => number) => views.reduce((total, r) => total + f(r), 0);
    return {
      racks: views,
      options: RACK_SIZES.map((size) => ({
        size,
        units: rackUnits(state.model, size),
        price: rackPrice(state, state.model, size),
        cabling: cablingOf(state.model),
      })),
      units: sum((r) => r.units),
      used: sum((r) => r.used),
      free: sum((r) => r.free),
      mostFree: Math.max(0, ...views.map((r) => r.free)),
      serverUnits: { ...setup.serverUnits },
    };
  }

  return {
    hasRacks,
    cablingOf,
    serverUnits,
    installAtBase,
    installToday,
    rackEntries,
    cablingEntries,
    rackFor,
    buyRack,
    sellRack,
    sellBackTotal,
    racks,
  };
}

export type Racks = ReturnType<typeof createRacks>;
