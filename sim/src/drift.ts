import type { GameConfig } from "./config.ts";
import { nextRandom, seedRng } from "./rng.ts";
import type { GameState, LogEntry, Server, YearEndRecord } from "./state.ts";

/** Drift as the student sees it: where prices and new kit stand, the years' ends so far, and the next. */
export interface DriftView {
  /** Whether drift is on in this config. */
  on: boolean;
  yearDays: number;
  /** Running prices as a multiple of the config's: 1.04 after a 4% rise. */
  priceLevel: number;
  /** Units servers and VMs added now give, as a multiple of the config's: 1.1 after one year's end at 10%. */
  newKitUnits: number;
  /** Oldest first. */
  yearEnds: YearEndRecord[];
  /** The last day of the year now being played, when it's a year's end: null when the game ends first, or drift is off. */
  nextYearEnd: number | null;
}

/** Rises are kept to a tenth of a point, like pay reviews': 0.034 is 3.4%. */
const roundRise = (n: number) => Number((Math.round(n * 1000) / 1000).toFixed(3));
/** Multipliers are kept to six places, so compounding stays tidy in state. */
const tidy = (n: number) => Number(n.toFixed(6));
const percent = (n: number) => `${Math.round(n * 1000) / 10}%`;

/**
 * Drift (#95): long games change slowly. At the end of each year that isn't the game's last day, running prices rise by
 * a fresh random inflation on drift's own RNG, and servers and VMs added from then on give more units for the money.
 * Pay never drifts (pay reviews raise it), nor does the student's own price.
 */
export function createDrift(config: GameConfig) {
  const c = config.drift;

  /** Prices and kit as the config has them, and drift's own RNG, seeded apart from the game's. */
  const startingDrift = (seed: number): Pick<GameState, "priceLevel" | "newKitUnits" | "yearEnds" | "driftRng"> => ({
    priceLevel: 1,
    newKitUnits: 1,
    yearEnds: [],
    driftRng: seedRng(seed ^ 0xd71f),
  });

  /** Whether `day` ends a year with drift: a whole number of years in, and not the game's last day. */
  const endsYear = (state: Pick<GameState, "finalDay">, day: number) =>
    c.on === 1 && c.yearDays > 0 && day > 0 && day % c.yearDays === 0 && (state.finalDay === null || day < state.finalDay);

  /**
   * After the last day of a year: rolls the year's price rise and raises running prices and new kit's units, from
   * tomorrow. Nothing on any other day.
   */
  function yearEnd(state: GameState, day: number): { state: GameState; entries: LogEntry[] } {
    if (!endsYear(state, day)) return { state, entries: [] };
    const [r, driftRng] = nextRandom(state.driftRng);
    const inflation = roundRise(c.inflation.min + r * (c.inflation.max - c.inflation.min));
    const priceLevel = tidy(state.priceLevel * (1 + inflation));
    const newKitUnits = tidy(state.newKitUnits * (1 + c.newKitUnits));
    const year = day / c.yearDays;
    const record: YearEndRecord = { year, day, inflation, priceLevel, newKitUnits };
    const kit =
      c.newKitUnits > 0
        ? ` New servers and VMs give ${percent(c.newKitUnits)} more capacity for the money (${percent(newKitUnits - 1)} more than at the start); the kit you have keeps its units.`
        : "";
    const text =
      `Year ${year} is over. Running prices rise ${percent(inflation)} from tomorrow: servers, VMs, rent, fees and power, ` +
      `now ${percent(priceLevel - 1)} above the start.${kit} Your own price doesn't change unless you change it.`;
    return {
      state: { ...state, priceLevel, newKitUnits, driftRng, yearEnds: [...state.yearEnds, record] },
      entries: [{ text, cashDelta: 0, kind: "drift" }],
    };
  }

  /**
   * Kit added between `before` and `after` (servers with an id from before's next id, the company's own or a
   * migration's new setup), marked with the units new kit gives now. Nothing changes until a year's end has made new
   * kit better.
   */
  function stampNewKit(before: Pick<GameState, "nextServerId">, after: GameState): GameState {
    const boost = after.newKitUnits;
    if (boost === 1 || after.nextServerId === before.nextServerId) return after;
    const stamp = (list: Server[]) =>
      list.map((s) => (s.id >= before.nextServerId && s.unitBoost === undefined ? { ...s, unitBoost: boost } : s));
    const { migration } = after;
    return { ...after, servers: stamp(after.servers), ...(migration && { migration: { ...migration, servers: stamp(migration.servers) } }) };
  }

  function driftView(state: GameState): DriftView {
    let nextYearEnd: number | null = null;
    if (c.on === 1 && c.yearDays > 0) {
      const day = (Math.floor(state.day / c.yearDays) + 1) * c.yearDays;
      if (endsYear(state, day)) nextYearEnd = day;
    }
    return {
      on: c.on === 1,
      yearDays: c.yearDays,
      priceLevel: state.priceLevel,
      newKitUnits: state.newKitUnits,
      yearEnds: state.yearEnds,
      nextYearEnd,
    };
  }

  return { startingDrift, yearEnd, stampNewKit, driftView };
}
