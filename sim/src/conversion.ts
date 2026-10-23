import type { GameConfig } from "./config.ts";
import type { Features } from "./features.ts";
import { count } from "./finance.ts";
import type { Pricing } from "./pricing.ts";
import type { GameState, LogEntry } from "./state.ts";

export type ConversionDriverId = "features" | "uptime" | "satisfaction" | "price";

/** One thing that raises or lowers the conversion rate, as a multiplier: above 1 it's helping, below 1 hurting. */
export interface ConversionDriver {
  id: ConversionDriverId;
  multiplier: number;
  effect: "helping" | "hurting" | "neutral";
  /** What it's measured on: active features, recent uptime %, satisfaction %, price ÷ fair price. */
  value: number;
}

/** Free-to-paid conversion for the screens: today's conversions and the rate that applies from the next day. */
export interface ConversionView {
  /** Free users who started paying on the day just played, and in all so far. */
  today: number;
  total: number;
  /** The product's base daily rate, and the rate after every driver, as shares of free users (0.004 = 0.4%). */
  baseRate: number;
  rate: number;
  /** Recent uptime % over the configured window, which the uptime driver uses. */
  recentUptime: number;
  /** Features, uptime, satisfaction and price, in that order. */
  drivers: ConversionDriver[];
}

const HOURS_PER_DAY = 24;
const percentFormat = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });

/**
 * Free-to-paid conversion: each day a share of free users start paying. The share is the product's base rate times
 * a multiplier for each of features, recent uptime, satisfaction and price (see ConversionConfig).
 */
export function createConversion(config: GameConfig, features: Features, pricing: Pricing) {
  const c = config.conversion;

  /** Uptime % over the last uptimeDays days played. 100 before the first. */
  function recentUptime(state: GameState): number {
    const days = state.recentHoursDown.length;
    if (days === 0) return 100;
    const down = state.recentHoursDown.reduce((sum, h) => sum + h, 0);
    return 100 * (1 - down / (days * HOURS_PER_DAY));
  }

  /** The hours down kept for recent uptime, with a day just played added and the oldest dropped. */
  const recentHoursDownAfter = (state: GameState, hoursDown: number) =>
    [...state.recentHoursDown, hoursDown].slice(-Math.max(1, c.uptimeDays));

  /** 1 at the neutral line, 1 + effect at 100%, falling at the same rate below the neutral line, never below 0. */
  const around = (value: number, neutral: number, effect: number) =>
    Math.max(0, 1 + (effect * (value - neutral)) / Math.max(1, 100 - neutral));

  const driver = (id: ConversionDriverId, multiplier: number, value: number): ConversionDriver => ({
    id,
    multiplier,
    effect: multiplier > 1.0005 ? "helping" : multiplier < 0.9995 ? "hurting" : "neutral",
    value,
  });

  /** Each driver, from the state at the start of a day: features active, recent uptime, yesterday's satisfaction. */
  function drivers(state: GameState): ConversionDriver[] {
    const active = features.activeCount(state);
    const uptime = recentUptime(state);
    const ratio = state.price / pricing.fairPrice(state.productType);
    return [
      driver("features", 1 + c.perFeature * active, active),
      driver("uptime", around(uptime, c.neutralUptime, c.uptimeEffect), uptime),
      driver("satisfaction", around(state.satisfaction, config.support.goodSatisfaction, c.satisfactionEffect), state.satisfaction),
      // At most 1: a cut's upgrades come from its wave, once, not here every day as well.
      driver("price", Math.min(1, ratio ** -c.priceSensitivity), ratio),
    ];
  }

  const baseRate = (state: GameState) => config.productTypes[state.productType].pricing.conversionRate;

  /** The daily rate: the base rate times every driver, at most maxRate. */
  const rate = (state: GameState, ds = drivers(state)) =>
    Math.min(c.maxRate, ds.reduce((r, d) => r * d.multiplier, baseRate(state)));

  /**
   * A day's conversions, at the rate from the start of the day, applied to the free users left once growth, churn and
   * any price wave are done. Users a wave upgraded today are already paying, so they can't convert too.
   */
  function convertDay(state: GameState, users: number, paidUsers: number) {
    const free = Math.max(0, users - paidUsers);
    const r = rate(state);
    const converted = Math.min(free, Math.round(free * r));
    const percent = percentFormat.format(100 * r);
    const entries: LogEntry[] =
      converted > 0
        ? [
            {
              text: `Free to paid: ${count.format(converted)} of ${count.format(free)} free users started paying (${percent}% a day).`,
              cashDelta: 0,
              kind: "conversion",
            },
          ]
        : [];
    return { paidUsers: paidUsers + converted, conversionsToday: converted, entries };
  }

  /** For the screens: today's conversions, and the rate and drivers that apply from the next day played. */
  function conversion(state: GameState): ConversionView {
    const ds = drivers(state);
    return {
      today: state.conversionsToday,
      total: state.conversions,
      baseRate: baseRate(state),
      rate: rate(state, ds),
      recentUptime: recentUptime(state),
      drivers: ds,
    };
  }

  /** A new company: no conversions yet and no days played. */
  const startingConversion = () => ({ recentHoursDown: [] as number[], conversionsToday: 0, conversions: 0 });

  return { startingConversion, recentHoursDownAfter, recentUptime, convertDay, conversion };
}

export type Conversion = ReturnType<typeof createConversion>;
