import type { GameConfig, ProductTypeId } from "./config.ts";
import { count, pounds } from "./finance.ts";
import { SimError, type GameState, type LogEntry, type PriceWave, type WaveEffect } from "./state.ts";
import type { TicketBurst } from "./support.ts";

/** What changing the price would do, before committing: the wave, its day-by-day shape and where income settles. */
export interface PricePreview {
  /** The price previewed, to the penny, and today's. */
  price: number;
  currentPrice: number;
  /** "none" when it's today's price: nothing happens. */
  direction: "rise" | "cut" | "none";
  /** Income a day today, and once the wave has settled if nothing else changes. */
  currentDailyIncome: number;
  dailyIncome: number;
  /** Users and paying users once the wave has settled if nothing else changes. */
  users: number;
  paidUsers: number;
  /** The whole wave added up: paying users leaving and dropping to free, new users, upgrades, backlash tickets. */
  total: WaveEffect;
  /** What each day of the wave does, with the day it lands on. Empty when nothing changes. */
  days: (WaveEffect & { day: number })[];
  /** The price is locked from an earlier change: the preview shows what would happen once it's free. */
  locked: boolean;
  lockDaysLeft: number;
  /** How long the price would be locked after this change. */
  lockDays: number;
}

/** The price wave under way, for the screens: where it's got to and what it has done. */
export interface PriceWaveView {
  direction: "rise" | "cut";
  from: number;
  to: number;
  /** Wave days played so far (0 before its first day), out of length. */
  day: number;
  length: number;
  remaining: number;
  /** What it has done so far, and what it will have done by the end. */
  done: WaveEffect;
  total: WaveEffect;
  /** The plan, each day with the day it lands on. */
  days: (WaveEffect & { day: number })[];
}

const noEffect = (): WaveEffect => ({ left: 0, toFree: 0, joined: 0, joinedPaid: 0, upgraded: 0, tickets: 0 });
const EFFECT_KEYS = Object.keys(noEffect()) as (keyof WaveEffect)[];
function addEffects(a: WaveEffect, b: WaveEffect): WaveEffect {
  const sum = noEffect();
  for (const k of EFFECT_KEYS) sum[k] = a[k] + b[k];
  return sum;
}
const sumEffects = (days: WaveEffect[]) => days.reduce(addEffects, noEffect());
const plural = (n: number, one: string, many: string) => `${count.format(n)} ${n === 1 ? one : many}`;
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Pricing and revenue: the monthly price, the income it brings from paying users, and how it compares with the
 * product's fair price, which sets how fast users grow and how many new users pay.
 */
export function createPricing(config: GameConfig) {
  const fairPrice = (productType: ProductTypeId) => config.productTypes[productType].pricing.fairPrice;

  /** A new company's price and paid users: the fair price, and the product's starting free share. */
  function startingPricing(productType: ProductTypeId, users: number) {
    const { fairPrice, freeShare } = config.productTypes[productType].pricing;
    return {
      price: fairPrice,
      paidUsers: Math.round(users * (1 - freeShare)),
      income: 0,
      priceWave: null,
      priceLockedUntil: 0,
      priceChanges: [],
    };
  }

  /** Checks a price a student could set and rounds it to the penny. */
  function checkedPrice(price: number): number {
    const { maxPrice } = config.pricing;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      throw new SimError("bad_price", "Set a price above £0.");
    }
    if (price > maxPrice) throw new SimError("price_too_high", `The highest price you can set is ${pounds(maxPrice)} a month.`);
    return Math.round(price * 100) / 100;
  }

  /** Days until the price can be changed again: 0 when it can. */
  const lockDaysLeft = (state: GameState) => Math.max(0, state.priceLockedUntil - state.day);

  /**
   * Sets the monthly price, to the penny. Paying users pay it from the next day played, and it starts a wave: a rise
   * loses payers and raises tickets, a cut brings new users and upgrades. The price is then locked for lockDays.
   */
  function setPrice(state: GameState, price: number): GameState {
    const to = checkedPrice(price);
    // Today's price again changes nothing, so it starts no wave and no lock.
    if (to === state.price) return state;
    const left = lockDaysLeft(state);
    if (left > 0) {
      throw new SimError(
        "price_locked",
        `Your price is locked for ${plural(left, "more day", "more days")} after your last change. Customers need time to get used to it.`,
        { daysLeft: left },
      );
    }
    return {
      ...state,
      price: to,
      priceWave: planWave(state, to),
      priceLockedUntil: state.day + config.pricing.lockDays,
      priceChanges: [...state.priceChanges, { day: state.day + 1, from: state.price, to }],
    };
  }

  /**
   * How a wave shares its whole effect across its days: firstDayShare on day 1, the small next-day reaction, and the
   * rest over the remaining days on a sine curve, building to a peak in the middle and fading, like word spreading.
   */
  function waveShape(): number[] {
    const { waveDays, firstDayShare } = config.pricing;
    if (waveDays <= 1) return [1];
    const rest = Array.from({ length: waveDays - 1 }, (_, i) => Math.sin((Math.PI * (i + 1)) / waveDays));
    const sum = rest.reduce((a, b) => a + b, 0);
    return [firstDayShare, ...rest.map((w) => ((1 - firstDayShare) * w) / sum)];
  }

  /** Splits a whole number over the shape so the days add up to it exactly. */
  function spread(total: number, shape: number[]): number[] {
    let cumulative = 0;
    let given = 0;
    return shape.map((w, i) => {
      cumulative += w;
      const upTo = i === shape.length - 1 ? total : Math.round(total * cumulative);
      const today = upTo - given;
      given = upTo;
      return today;
    });
  }

  /**
   * The whole wave a change from today's price to `to` would cause, from today's users. Its size scales with the
   * change against the fair price, raised to waveCurve, so a small tweak barely registers and a big jump hits hard.
   */
  function waveTotal(state: GameState, to: number): WaveEffect {
    const p = config.pricing;
    const fair = fairPrice(state.productType);
    const size = (Math.abs(to - state.price) / fair) ** p.waveCurve;
    const total = noEffect();
    if (to > state.price) {
      const dearer = Math.max(1, to / fair) ** p.dearness;
      const affected = Math.round(state.paidUsers * Math.min(p.maxRiseShare, p.riseStrength * size * dearer));
      total.toFree = Math.round(affected * p.dropToFreeShare);
      total.left = affected - total.toFree;
      total.tickets = Math.round(affected * p.backlashTicketsPerUser);
    } else if (to < state.price) {
      total.joined = Math.round(state.users * Math.min(p.maxCutGain, p.cutGainStrength * size));
      total.joinedPaid = Math.round(total.joined * paidShareOfNew({ ...state, price: to }));
      const free = state.users - state.paidUsers;
      total.upgraded = Math.round(free * Math.min(p.maxCutUpgrade, p.cutUpgradeStrength * size));
    }
    return total;
  }

  /** The wave planned day by day. Each number is spread over the shape on its own, so every total adds up exactly. */
  function planDays(state: GameState, to: number): WaveEffect[] {
    const total = waveTotal(state, to);
    const shape = waveShape();
    const columns = EFFECT_KEYS.map((k) => [k, spread(total[k], shape)] as const);
    return shape.map((_, i) => {
      const day = noEffect();
      for (const [k, values] of columns) day[k] = values[i]!;
      return day;
    });
  }

  function planWave(state: GameState, to: number): PriceWave {
    return {
      direction: to > state.price ? "rise" : "cut",
      from: state.price,
      to,
      firstDay: state.day + 1,
      days: planDays(state, to),
      done: noEffect(),
    };
  }

  const datedDays = (days: WaveEffect[], firstDay: number) => days.map((d, i) => ({ ...d, day: firstDay + i }));

  /**
   * What changing to this price would do if nothing else changed: the same plan setPrice makes, so it matches what
   * actually happens. Works while the price is locked too, and says so.
   */
  function pricePreview(state: GameState, price: number): PricePreview {
    const to = checkedPrice(price);
    const same = to === state.price;
    const days = same ? [] : datedDays(planDays(state, to), state.day + 1);
    const total = sumEffects(days);
    const paidUsers = state.paidUsers - total.left - total.toFree + total.joinedPaid + total.upgraded;
    const users = state.users - total.left + total.joined;
    const left = lockDaysLeft(state);
    return {
      price: to,
      currentPrice: state.price,
      direction: same ? "none" : to > state.price ? "rise" : "cut",
      currentDailyIncome: dailyIncome(state),
      dailyIncome: dailyIncome({ ...state, paidUsers, price: to }),
      users,
      paidUsers,
      total,
      days,
      locked: left > 0,
      lockDaysLeft: left,
      lockDays: config.pricing.lockDays,
    };
  }

  /** The wave still under way after the last day played, or null. One whose first day is tomorrow counts. */
  function priceWave(state: GameState): PriceWaveView | null {
    const wave = state.priceWave;
    if (!wave) return null;
    const day = Math.max(0, state.day - wave.firstDay + 1);
    const length = wave.days.length;
    if (day >= length) return null;
    return {
      direction: wave.direction,
      from: wave.from,
      to: wave.to,
      day,
      length,
      remaining: length - day,
      done: wave.done,
      total: sumEffects(wave.days),
      days: datedDays(wave.days, wave.firstDay),
    };
  }

  /**
   * Today's share of the wave, applied to the users after the day's growth and churn. It never takes more users than
   * are there, so where churn got to some first the wave does less. Its backlash tickets join the day's bursts.
   */
  function waveDay(state: GameState, day: number, users: number, paidUsers: number) {
    const wave = state.priceWave;
    const i = wave ? day - wave.firstDay : -1;
    const plan = wave?.days[i];
    if (!wave || !plan) return { users, paidUsers, priceWave: wave, bursts: [] as TicketBurst[], entries: [] as LogEntry[] };

    const today: WaveEffect = { ...plan };
    today.left = Math.min(plan.left, paidUsers);
    today.toFree = Math.min(plan.toFree, paidUsers - today.left);
    today.upgraded = Math.min(plan.upgraded, users - paidUsers);
    const done = addEffects(wave.done, today);
    const n = wave.days.length;
    const bursts: TicketBurst[] =
      today.tickets > 0 ? [{ cause: `your price rise (backlash day ${i + 1} of ${n})`, tickets: today.tickets }] : [];
    return {
      users: users - today.left + today.joined,
      paidUsers: paidUsers - today.left - today.toFree + today.upgraded + today.joinedPaid,
      priceWave: { ...wave, done },
      bursts,
      entries: waveEntries(wave, i, today, i === n - 1 ? done : null),
    };
  }

  /** The wave's log line for the day, and a round-up on its last day. */
  function waveEntries(wave: PriceWave, i: number, today: WaveEffect, done: WaveEffect | null): LogEntry[] {
    const n = wave.days.length;
    const change = `${pounds(wave.from)} to ${pounds(wave.to)}`;
    const rise = wave.direction === "rise";
    const what = (e: WaveEffect) =>
      rise
        ? `${plural(e.left, "paying user", "paying users")} left and ${count.format(e.toFree)} dropped to free`
        : `${plural(e.joined, "new user", "new users")} joined and ${plural(e.upgraded, "free user", "free users")} started paying`;
    const coming = n > 1 ? (rise ? ` Expect a backlash over the next ${n - 1} days.` : ` Word will spread over the next ${n - 1} days.`) : "";
    const text =
      i === 0
        ? `Customers noticed your price ${rise ? "rise" : "cut"} from ${change}: ${what(today)}.${coming}`
        : rise
          ? `Price backlash, day ${i + 1} of ${n}: complaints are spreading online. ${capitalise(what(today))}.`
          : `Price cut, day ${i + 1} of ${n}: word of mouth is spreading. ${capitalise(what(today))}.`;
    const entries: LogEntry[] = [{ text, cashDelta: 0, kind: "price" }];
    if (done) {
      const over = rise ? "The backlash from your price rise is over" : "The wave from your price cut is over";
      entries.push({ text: `${over}. In all, ${what(done)}.`, cashDelta: 0, kind: "price" });
    }
    return entries;
  }

  /** The price against the fair price: 1 at the fair price, 2 at double it. */
  const priceRatio = (state: GameState) => state.price / fairPrice(state.productType);

  /** The day's growth is multiplied by this: below 1 above the fair price, above 1 (up to the cap) below it. */
  function priceGrowth(state: GameState): number {
    const { growthSensitivity, maxGrowthBoost } = config.pricing;
    return Math.min(maxGrowthBoost, priceRatio(state) ** -growthSensitivity);
  }

  /** Share of the day's new users who pay. The product's paid share at the fair price, less the dearer it is. */
  function paidShareOfNew(state: GameState): number {
    const { freeShare } = config.productTypes[state.productType].pricing;
    return Math.min(1, (1 - freeShare) * priceRatio(state) ** -config.pricing.paidShareSensitivity);
  }

  /**
   * Paid users once the day's users are known. New users split between paid and free by paidShareOfNew; if users
   * fell, paid and free fall in step.
   */
  function paidUsersAfter(state: GameState, users: number): number {
    const change = users - state.users;
    if (change >= 0) return state.paidUsers + Math.round(change * paidShareOfNew(state));
    return state.users === 0 ? 0 : Math.round((state.paidUsers * users) / state.users);
  }

  /** A day's income: paid users × price ÷ daysPerMonth, rounded to the pound, the same rule as monthly costs. */
  const dailyIncome = (state: GameState) => Math.round((state.paidUsers * state.price) / config.billing.daysPerMonth);

  /** The day's income, from the paying users at the start of the day. None when nobody pays. */
  function incomeEntries(state: GameState): LogEntry[] {
    const income = dailyIncome(state);
    if (income <= 0) return [];
    const text = `Income: ${count.format(state.paidUsers)} paying users at ${pounds(state.price)} a month`;
    return [{ text, cashDelta: income, kind: "income" }];
  }

  return {
    fairPrice,
    startingPricing,
    setPrice,
    lockDaysLeft,
    pricePreview,
    priceWave,
    waveDay,
    priceGrowth,
    paidUsersAfter,
    dailyIncome,
    incomeEntries,
  };
}

export type Pricing = ReturnType<typeof createPricing>;
