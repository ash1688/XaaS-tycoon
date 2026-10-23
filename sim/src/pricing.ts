import type { Calendar } from "./calendar.ts";
import { CUSTOMER_TYPE_IDS, type CustomerTypeId, type GameConfig, type ProductTypeId } from "./config.ts";
import { count, pounds } from "./finance.ts";
import { SimError, type GameState, type LogEntry, type PriceChange, type PriceWave, type WaveEffect } from "./state.ts";
import type { TicketBurst } from "./support.ts";

/** What changing the price would do, before committing: the wave, its day-by-day shape and where income settles. */
export interface PricePreview {
  /** The price previewed, to the penny, and today's. */
  price: number;
  currentPrice: number;
  /**
   * On a product with a transaction rate, the rate previewed and today's. Null on other products. With them, what a
   * usual month costs a paying user at each: the price customers react to (the price itself on other products).
   */
  rate: number | null;
  currentRate: number | null;
  monthly: number;
  currentMonthly: number;
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
  /**
   * The price reaction to a rise: the share of paying users it loses, each customer type's reaction weighted by its
   * share of users. 0 for a cut or no change.
   */
  reaction: number;
  /** Each customer type's share of users and its own reaction to the change, which make up the reaction. */
  reactions: TypeReaction[];
  /** What each day of the wave does, with the day it lands on. Empty when nothing changes. */
  days: (WaveEffect & { day: number })[];
  /** The price is locked from an earlier change: the preview shows what would happen once it's free. */
  locked: boolean;
  lockDaysLeft: number;
  /** How long the price would be locked after this change. */
  lockDays: number;
}

/**
 * The payments app's two prices and two income streams, for the screens: the monthly fee and the share of each
 * payment, set together as one price change, and what each brings in.
 */
export interface PaymentsView {
  /** The monthly fee each paying business pays, and the fair one a new company starts at. */
  fee: number;
  fairFee: number;
  /** The share of each payment taken (0.02 = 2%), the fair one, and the highest that can be set. */
  rate: number;
  fairRate: number;
  maxRate: number;
  /** What a paying business takes in payments in a usual month. */
  volumePerPaidUser: number;
  /** What a usual month costs a paying business, fee + rate × its payments: what customers react to. And the fair one. */
  monthly: number;
  fairMonthly: number;
  /** On a usual day at today's paying users: their payments, and what the fee and the rate bring in. */
  usualDayPayments: number;
  usualDayFees: number;
  usualDayTransactionFees: number;
  /** On SaaS, the platform's fee on a usual day's payments (a cost): 0 on other models. */
  usualDaySaasFee: number;
  /** The SaaS platform's fee on every payment (0.009 = 0.9%), on any model: what SaaS would charge. */
  saasFeeRate: number;
  /** The next day to play: its payments as a multiple of a usual day's, and why ("payday", "black-friday" or null). */
  nextDay: { day: number; multiplier: number; busy: "payday" | "black-friday" | null };
  /** The next payday and Black Friday to come, from the next day to play: their first days. Null if none comes. */
  nextPayday: number | null;
  nextBlackFriday: number | null;
  /** Income so far from each stream. */
  feeIncome: number;
  transactionIncome: number;
}

/** One customer type's part in a price reaction: its share of users and the share of its paying users lost. */
export interface TypeReaction {
  id: CustomerTypeId;
  share: number;
  reaction: number;
}

/** One customer type in the customer mix, for the screens. */
export interface CustomerTypeView {
  id: CustomerTypeId;
  name: string;
  blurb: string;
  /** The type's share of users (0.7 = 70%), and about how many users that is. */
  share: number;
  users: number;
  /** The price at which this type starts to react badly, to the penny. */
  threshold: number;
  /** Today's price is above the type's threshold: it loses payers to the price each day, and reacts more to a rise. */
  overThreshold: boolean;
  /** The type's share of today's new users (see CustomerMix), and what tilts it from the product's mix. */
  newShare: number;
  /**
   * How much the active features tilt new users towards the type, against the product's mix: 1.44 = 44% more of them.
   * Features that pull every type alike cancel out to 1.
   */
  featureAppeal: number;
  /** The price's filter on the type: 1 at or below its threshold, less above it. */
  priceFilter: number;
  /**
   * How much rivals tilt new users towards the type (above 1) or away from it (below 1), against the product's mix: a
   * cheap rival takes casual users, so more of the student's new users are businesses. 1 with no rivals.
   */
  rivalPull: number;
}

type MixShift = "newShare" | "featureAppeal" | "priceFilter" | "rivalPull";

/** The customer mix, for the screens: each type's share, with its price threshold to mark on the bar. */
export interface CustomerMixView {
  /** Least willing to pay first. */
  types: CustomerTypeView[];
  /**
   * The price customers react to, and the fair one: the monthly price, or on a product with a transaction rate, what
   * a usual month costs a paying user (fee + rate × usual payments). The thresholds are in the same terms.
   */
  price: number;
  fairPrice: number;
  /** The price above includes the transaction rate: it's a usual month's cost, not the monthly fee. */
  includesRate: boolean;
}

/**
 * The price reaction: each customer type's reaction weighted by its share of users. A social network of 70% casual
 * users (30% leave), 20% enthusiasts (10%), 8% professionals (2%) and 2% businesses (1%) loses 23.18%.
 */
export function weightedReaction(parts: { share: number; reaction: number }[]): number {
  return parts.reduce((sum, p) => sum + p.share * p.reaction, 0);
}

/** The price wave under way, for the screens: where it's got to and what it has done. */
export interface PriceWaveView {
  direction: "rise" | "cut";
  from: number;
  to: number;
  /** On a product with a transaction rate, the rate before and after. */
  fromRate?: number;
  toRate?: number;
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
/** A rate as a percentage, to at most two places: 0.025 is "2.5%". */
export const percent = (rate: number) => `${Math.round(rate * 10_000) / 100}%`;

/**
 * Pricing and revenue: the monthly price, the income it brings from paying users, and how it compares with the
 * product's fair price, which sets how fast users grow and how many new users pay.
 */
export function createPricing(config: GameConfig, calendar: Calendar) {
  /** The fair monthly price: on the payments app, the fair monthly fee. */
  const fairPrice = (productType: ProductTypeId) => config.productTypes[productType].pricing.fairPrice;
  const transactionsOf = (productType: ProductTypeId) => config.productTypes[productType].transactions;

  /**
   * What a usual month costs a paying user at a price and rate: the price, plus on a product with a transaction rate,
   * the rate's share of a usual month's payments. Every price reaction is to this, so a rise in either is a rise.
   */
  function monthly(productType: ProductTypeId, price: number, rate: number | null): number {
    const tx = transactionsOf(productType);
    return price + (tx && rate ? rate * tx.volumePerPaidUser : 0);
  }
  /** The fair price customers react against: the fair price, plus the fair rate's share on the payments app. */
  const fairMonthly = (productType: ProductTypeId) =>
    monthly(productType, fairPrice(productType), transactionsOf(productType)?.fairRate ?? null);
  /** What a usual month costs a paying user today. */
  const monthlyNow = (state: GameState) => monthly(state.productType, state.price, state.transactionRate);

  /** A product's customer mix, its shares scaled to add up to 1. All casual if they add up to nothing. */
  function baseMix(productType: ProductTypeId): Record<CustomerTypeId, number> {
    const mix = config.productTypes[productType].pricing.customerMix;
    const sum = CUSTOMER_TYPE_IDS.reduce((total, t) => total + Math.max(0, mix[t] ?? 0), 0);
    const shares = CUSTOMER_TYPE_IDS.map((t) => [t, sum > 0 ? Math.max(0, mix[t] ?? 0) / sum : t === "casual" ? 1 : 0]);
    return Object.fromEntries(shares) as Record<CustomerTypeId, number>;
  }

  /** A customer type's price threshold for a product: the fair price times the type's multiple. */
  const threshold = (productType: ProductTypeId, type: CustomerTypeId) =>
    fairMonthly(productType) * config.customerTypes[type].thresholdMultiple;

  /** Each customer type with its share of users and its reaction, worked out from its threshold. */
  const byType = (state: GameState, reaction: (threshold: number) => number): TypeReaction[] =>
    CUSTOMER_TYPE_IDS.map((id) => ({ id, share: state.customerMix[id], reaction: reaction(threshold(state.productType, id)) }));

  /** A new company's price, paid users and customer mix: the fair price, and the product's free share and mix. */
  function startingPricing(productType: ProductTypeId, users: number) {
    const { fairPrice, freeShare } = config.productTypes[productType].pricing;
    return {
      price: fairPrice,
      transactionRate: transactionsOf(productType)?.fairRate ?? null,
      paidUsers: Math.round(users * (1 - freeShare)),
      customerMix: baseMix(productType),
      income: 0,
      feeIncome: 0,
      transactionIncome: 0,
      priceWave: null,
      priceLockedUntil: 0,
      priceChanges: [],
    };
  }

  /**
   * Checks a price and rate a student could set: the price rounded to the penny and, on a product with a transaction
   * rate, the rate to a hundredth of a percent (today's if left out). There the price can be £0 if the rate isn't.
   */
  function checkedPrice(state: GameState, price: number, rate?: number): { price: number; rate: number | null } {
    const { maxPrice } = config.pricing;
    const tx = transactionsOf(state.productType);
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0 || (!tx && price === 0)) {
      throw new SimError("bad_price", tx ? "Set a monthly fee of £0 or more." : "Set a price above £0.");
    }
    if (price > maxPrice) throw new SimError("price_too_high", `The highest price you can set is ${pounds(maxPrice)} a month.`);
    const fee = Math.round(price * 100) / 100;
    if (!tx) {
      if (rate !== undefined) throw new SimError("no_transaction_rate", "Only the payments app takes a share of each payment.");
      return { price: fee, rate: null };
    }
    const r = rate ?? state.transactionRate ?? tx.fairRate;
    if (typeof r !== "number" || !Number.isFinite(r) || r < 0) throw new SimError("bad_rate", "Set a transaction fee of 0% or more.");
    if (r > tx.maxRate) throw new SimError("rate_too_high", `The highest transaction fee you can set is ${percent(tx.maxRate)}.`);
    const checked = Math.round(r * 10_000) / 10_000;
    if (fee === 0 && checked === 0) throw new SimError("bad_price", "Charge a monthly fee, a transaction fee or both.");
    return { price: fee, rate: checked };
  }

  /** Days until the price can be changed again: 0 when it can. */
  const lockDaysLeft = (state: GameState) => Math.max(0, state.priceLockedUntil - state.day);

  /**
   * Sets the monthly price, to the penny. Paying users pay it from the next day played, and it starts a wave: a rise
   * loses payers and raises tickets, a cut brings new users and upgrades. The price is then locked for lockDays.
   */
  function setPrice(state: GameState, price: number, rate?: number): GameState {
    const { price: to, rate: toRate } = checkedPrice(state, price, rate);
    // Today's price again changes nothing, so it starts no wave and no lock.
    if (to === state.price && toRate === state.transactionRate) return state;
    const left = lockDaysLeft(state);
    if (left > 0) {
      throw new SimError(
        "price_locked",
        `Your price is locked for ${plural(left, "more day", "more days")} after your last change. Customers need time to get used to it.`,
        { daysLeft: left },
      );
    }
    const rates = toRate === null ? {} : { fromRate: state.transactionRate ?? 0, toRate };
    const toMonthly = monthly(state.productType, to, toRate);
    // Moving money between the fee and the rate costs customers nothing in a usual month: no wave, but it's a change.
    const wave = toMonthly === monthlyNow(state) ? state.priceWave : { ...planWave(state, toMonthly), from: state.price, to, ...rates };
    return {
      ...state,
      price: to,
      transactionRate: toRate,
      priceWave: wave,
      priceLockedUntil: state.day + config.pricing.lockDays,
      priceChanges: [...state.priceChanges, { day: state.day + 1, from: state.price, to, ...rates }],
    };
  }

  /**
   * How a wave shares its whole effect across its days: a first-day share, the quick reaction, and the rest over the
   * remaining days on a sine curve, building to a peak in the middle and fading, like word spreading.
   */
  function waveShape(first: number): number[] {
    const { waveDays } = config.pricing;
    if (waveDays <= 1) return [1];
    const rest = Array.from({ length: waveDays - 1 }, (_, i) => Math.sin((Math.PI * (i + 1)) / waveDays));
    const sum = rest.reduce((a, b) => a + b, 0);
    return [first, ...rest.map((w) => ((1 - first) * w) / sum)];
  }

  /**
   * The share of a wave that lands on its first day: firstDayShare, except for sticker shock. A rise to a price dear
   * to a customer type loses (1 - its threshold / new price)^3 of the type's lost payers at once, before they pay it:
   * an eighth on doubling its threshold, half at five times it and nearly all at many times it. Weighted by how many
   * payers each type loses.
   */
  function firstDayShare(state: GameState, to: number): number {
    const { firstDayShare } = config.pricing;
    if (to <= monthlyNow(state)) return firstDayShare;
    const lost = weightedReaction(riseReactions(state, to));
    if (lost <= 0) return firstDayShare;
    const shock = (th: number) => Math.max(0, 1 - th / to) ** 3;
    const shocked = weightedReaction(riseReactions(state, to, shock));
    return Math.max(firstDayShare, shocked / lost);
  }

  /**
   * Each customer type's reaction to a rise from today's price to `to`: the share of its paying users lost, worked out
   * as the alpha did for everyone but against the type's price threshold in place of the fair price. It scales with
   * the rise against the threshold, raised to waveCurve, times how dear the new price is to the type, and the dearer
   * it is, the fewer can stay. 0 for a cut. Each is multiplied by `times`, given the threshold, when there is one.
   *
   * The rise is measured from the lowest price customers remember, less what the rises since have already lost, so a
   * run of small rises loses as many payers as one rise to the same price: £20 to £30 in five steps is £20 to £30.
   */
  function riseReactions(state: GameState, to: number, times = (_threshold: number) => 1): TypeReaction[] {
    const p = config.pricing;
    const from = rememberedPrice(state);
    // The share of the type's payers a rise from the remembered price to `price` loses in all.
    const lost = (price: number, th: number) => {
      if (price <= from) return 0;
      const size = ((price - from) / th) ** p.waveCurve;
      const dearer = Math.max(1, price / th) ** p.dearness;
      const most = 1 - (1 - p.maxRiseShare) / dearer;
      return Math.min(most, p.riseStrength * size * dearer);
    };
    const now = monthlyNow(state);
    return byType(state, (th) => {
      if (to <= now) return 0;
      // Of the payers still here at today's price, the share the whole rise to `to` would have lost on top.
      const already = lost(now, th);
      return (Math.max(0, lost(to, th) - already) / (1 - already)) * times(th);
    });
  }

  /**
   * The lowest price customers remember: the lowest in effect over the last priceMemoryDays, today's included. A rise
   * is measured from it, and a cut only counts below it.
   */
  function rememberedPrice(state: GameState): number {
    const since = state.day - config.pricing.priceMemoryDays;
    const was = (c: PriceChange) => monthly(state.productType, c.from, c.fromRate ?? null);
    return state.priceChanges.reduce((low, c) => (c.day > since ? Math.min(low, was(c)) : low), monthlyNow(state));
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
   * The whole wave a change from today's price to `to` would cause, from today's users. A rise loses the price
   * reaction's share of paying users, each customer type's reaction weighted by its share (see riseReactions), and
   * each type drops to free by its own share. A cut's size scales with the cut against each customer type's
   * threshold, raised to waveCurve and weighted by the type's share, so a small tweak barely registers and a big jump
   * hits hard. A cut counts only below both the fair
   * price and the lowest price customers remember: coming back down to the fair price is no bargain, however long the
   * price was dear, and a cut from £300 to £295 is still £295 to them.
   */
  function waveTotal(state: GameState, to: number): WaveEffect {
    const p = config.pricing;
    const fair = fairMonthly(state.productType);
    const now = monthlyNow(state);
    const total = noEffect();
    if (to > now) {
      const reactions = riseReactions(state, to);
      const affected = Math.round(state.paidUsers * weightedReaction(reactions));
      const toFree = reactions.map((r) => ({ ...r, reaction: r.reaction * config.customerTypes[r.id].toFreeShare }));
      total.toFree = Math.min(affected, Math.round(state.paidUsers * weightedReaction(toFree)));
      total.left = affected - total.toFree;
      total.tickets = Math.round(affected * p.backlashTicketsPerUser);
    } else if (to < now) {
      // Each customer type feels a cut against its own threshold, as it does a rise: a bargain to casual users is small
      // change to a business. So cutting to convert, then rising back, doesn't pay for an upmarket mix either.
      const below = Math.max(0, Math.min(rememberedPrice(state), fair) - to);
      const size = weightedReaction(byType(state, (th) => (below / th) ** p.waveCurve));
      total.joined = Math.round(state.users * Math.min(p.maxCutGain, p.cutGainStrength * size));
      total.joinedPaid = Math.round(total.joined * paidShareAt(state, to));
      const free = state.users - state.paidUsers;
      total.upgraded = Math.round(free * Math.min(p.maxCutUpgrade, p.cutUpgradeStrength * size));
    }
    return total;
  }

  /** The wave planned day by day. Each number is spread over the shape on its own, so every total adds up exactly. */
  function planDays(state: GameState, to: number): WaveEffect[] {
    const total = waveTotal(state, to);
    const shape = waveShape(firstDayShare(state, to));
    const columns = EFFECT_KEYS.map((k) => [k, spread(total[k], shape)] as const);
    return shape.map((_, i) => {
      const day = noEffect();
      for (const [k, values] of columns) day[k] = values[i]!;
      return day;
    });
  }

  function planWave(state: GameState, to: number): PriceWave {
    // On the payments app `to` is a usual month's cost, fee and transaction fee together.
    const rise = to > monthlyNow(state);
    return {
      direction: rise ? "rise" : "cut",
      from: state.price,
      to,
      firstDay: state.day + 1,
      days: planDays(state, to),
      done: noEffect(),
      leftMix: rise ? leftMix(state, to) : null,
    };
  }

  /**
   * Who a rise loses for good: each customer type's share of users × its reaction × the share of its lost payers who
   * leave rather than go free. Those who go free stay users, so only the leavers shift the mix.
   */
  function leftMix(state: GameState, to: number): Record<CustomerTypeId, number> {
    const weights = riseReactions(state, to).map((r) => [r.id, r.share * r.reaction * (1 - config.customerTypes[r.id].toFreeShare)]);
    return Object.fromEntries(weights) as Record<CustomerTypeId, number>;
  }

  const datedDays = (days: WaveEffect[], firstDay: number) => days.map((d, i) => ({ ...d, day: firstDay + i }));

  /**
   * What changing to this price would do if nothing else changed: the same plan setPrice makes, so it matches what
   * actually happens. Works while the price is locked too, and says so.
   */
  function pricePreview(state: GameState, price: number, rate?: number): PricePreview {
    const { price: to, rate: toRate } = checkedPrice(state, price, rate);
    const now = monthlyNow(state);
    const toMonthly = monthly(state.productType, to, toRate);
    const same = toMonthly === now;
    const days = same ? [] : datedDays(planDays(state, toMonthly), state.day + 1);
    const total = sumEffects(days);
    const paidUsers = state.paidUsers - total.left - total.toFree + total.joinedPaid + total.upgraded;
    const users = state.users - total.left + total.joined;
    const left = lockDaysLeft(state);
    const reactions = riseReactions(state, toMonthly);
    return {
      price: to,
      currentPrice: state.price,
      rate: toRate,
      currentRate: state.transactionRate,
      monthly: Math.round(toMonthly * 100) / 100,
      currentMonthly: Math.round(now * 100) / 100,
      direction: same ? "none" : toMonthly > now ? "rise" : "cut",
      currentDailyIncome: dailyIncome(state),
      dailyIncome: dailyIncome({ ...state, paidUsers, price: to, transactionRate: toRate }),
      users,
      paidUsers,
      total,
      reaction: weightedReaction(reactions),
      reactions,
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
      ...(wave.toRate === undefined ? {} : { fromRate: wave.fromRate, toRate: wave.toRate }),
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
    if (!wave || !plan) {
      return { users, paidUsers, priceWave: wave, refused: 0, left: null, joined: 0, bursts: [] as TicketBurst[], entries: [] as LogEntry[] };
    }

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
      // Paying users a rise lost today refused the new price, so they don't pay it today either.
      refused: wave.direction === "rise" ? today.left + today.toFree : 0,
      // Who left and joined today, for the customer mix: leavers split by the wave's leftMix.
      left: today.left > 0 ? { users: today.left, weights: wave.leftMix ?? state.customerMix } : null,
      joined: today.joined,
      bursts,
      entries: waveEntries(wave, i, today, i === n - 1 ? done : null),
    };
  }

  /** The wave's log line for the day, and a round-up on its last day. */
  function waveEntries(wave: PriceWave, i: number, today: WaveEffect, done: WaveEffect | null): LogEntry[] {
    const n = wave.days.length;
    const change = `${priceText(wave.from, wave.fromRate)} to ${priceText(wave.to, wave.toRate)}`;
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

  /** A price for the log: "£5.00", or with a transaction rate "£10.00 + 2%". */
  const priceText = (price: number, rate?: number | null) =>
    rate === undefined || rate === null ? pounds(price) : `${pounds(price)} + ${percent(rate)}`;

  /** The price against the fair price, in what a usual month costs: 1 at the fair price, 2 at double it. */
  const priceRatio = (state: GameState) => monthlyNow(state) / fairMonthly(state.productType);

  /**
   * A price's pull, ratio ^ −sensitivity for a ratio to the fair price. Below the fair price each customer type feels
   * it in step with how close its threshold is to the fair price, weighted by its share: casual users (threshold the
   * fair price) in full, businesses (three times it) a third as strongly. A bargain draws bargain hunters, not
   * businesses, so a cheap spell doesn't stock an upmarket product with payers to keep after rising back.
   */
  function pull(state: GameState, ratio: number, sensitivity: number): number {
    if (ratio >= 1) return ratio ** -sensitivity;
    const fair = fairMonthly(state.productType);
    return weightedReaction(byType(state, (th) => ratio ** ((-sensitivity * fair) / th)));
  }

  /** The day's growth is multiplied by this: below 1 above the fair price, above 1 (up to the cap) below it. */
  function priceGrowth(state: GameState): number {
    const { growthSensitivity, maxGrowthBoost } = config.pricing;
    return Math.min(maxGrowthBoost, pull(state, priceRatio(state), growthSensitivity));
  }

  /** Share of the day's new users who pay. The product's paid share at the fair price, less the dearer it is. */
  function paidShareOfNew(state: GameState): number {
    return paidShareAt(state, monthlyNow(state));
  }
  /** The same at a price customers would react to: what a usual month would cost. */
  function paidShareAt(state: GameState, monthlyPrice: number): number {
    const { freeShare } = config.productTypes[state.productType].pricing;
    const ratio = monthlyPrice / fairMonthly(state.productType);
    return Math.min(1, (1 - freeShare) * pull(state, ratio, config.pricing.paidShareSensitivity));
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

  /**
   * A usual day's income: paid users × price ÷ daysPerMonth, rounded to the pound, the same rule as monthly costs. On
   * the payments app the rate's share of a usual day's payments is in it too: paid users × what a usual month costs
   * them ÷ daysPerMonth.
   */
  const dailyIncome = (state: GameState) => Math.round((state.paidUsers * monthlyNow(state)) / config.billing.daysPerMonth);

  /** A day is in Black Friday on the calendar, for a product that feels it: the payments app's rush. */
  const isBlackFriday = (state: Pick<GameState, "startDate" | "productType">, day: number) =>
    calendar.holidaysOn(state, day).some((h) => h.id === "blackFriday" && !!h.effects[state.productType]);

  /** Whether a day is a payday on the payments app. */
  function isPayday(productType: ProductTypeId, day: number): boolean {
    const tx = transactionsOf(productType);
    if (!tx) return false;
    const { firstDay, every, length } = tx.payday;
    return length > 0 && length < every && day >= firstDay && (day - firstDay) % every < length;
  }

  /**
   * The payments app's payments on a day from paydays alone, as a multiple of a usual day's: busier on paydays and
   * quieter between them, so a month averages out. Its load follows them. 1 on products without a rate.
   */
  function paydayMultiplier(productType: ProductTypeId, day: number): number {
    const tx = transactionsOf(productType);
    if (!tx) return 1;
    const { every, length, multiplier } = tx.payday;
    const quiet = length > 0 && length < every ? Math.max(0, (every - length * multiplier) / (every - length)) : 1;
    return isPayday(productType, day) ? multiplier : quiet;
  }

  /** The payments app's payments on a day: paydays, times the holidays on the calendar (the Black Friday rush). */
  const paymentsMultiplier = (state: Pick<GameState, "startDate" | "productType">, day: number) =>
    transactionsOf(state.productType) ? paydayMultiplier(state.productType, day) * calendar.loadMultiplier(state, day) : 1;

  /**
   * The day's income, from the paying users at the start of the day, less any a price rise lost today: they refused
   * the new price rather than pay it. None when nobody pays. On the payments app the rate's share of the day's
   * payments comes in apart: payments follow the day (paydays, Black Friday), and none are taken for the hours down.
   */
  function incomeEntries(state: GameState, refused = 0, day = state.day + 1, hoursDown = 0): LogEntry[] {
    const paidUsers = Math.max(0, state.paidUsers - refused);
    const entries: LogEntry[] = [];
    // On the payments app businesses aren't charged the fee for the hours it's down, as they take no payments then:
    // so an outage costs the fee and the rate alike, and a fee-only price is no shelter from one.
    const tx = transactionsOf(state.productType);
    const up = Math.max(0, 1 - hoursDown / 24);
    const fees = Math.round(((paidUsers * state.price) / config.billing.daysPerMonth) * (tx ? up : 1));
    if (fees > 0) {
      const text = `Income: ${count.format(paidUsers)} paying users at ${pounds(state.price)} a month`;
      // Only the payments app has two streams to tell apart.
      if (state.transactionRate === null) entries.push({ text, cashDelta: fees, kind: "income" });
      else {
        const credit = hoursDown > 0 ? `, less ${hoursDown} hours down` : "";
        entries.push({ text: `${text} fee${credit}`, cashDelta: fees, kind: "income", stream: "fees" });
      }
    }
    if (!tx) return entries;
    const rate = state.transactionRate ?? 0;
    const usual = (paidUsers * tx.volumePerPaidUser) / config.billing.daysPerMonth;
    const payments = usual * paymentsMultiplier(state, day) * up;
    const income = Math.round(payments * rate);
    if (income > 0) {
      const busy = isBlackFriday(state, day) ? " (Black Friday rush)" : isPayday(state.productType, day) ? " (payday)" : "";
      const down = hoursDown > 0 ? `, none taken in the ${hoursDown} hours down` : "";
      const text = `Transaction fees: ${percent(rate)} of ${pounds(Math.round(payments))} of payments${busy}${down}`;
      entries.push({ text, cashDelta: income, kind: "income", stream: "transactions" });
    }
    const fee = saasFeeOn(state, payments);
    if (fee > 0) {
      const text = `SaaS platform's ${percent(tx.saasFeeRate)} fee on ${pounds(Math.round(payments))} of payments: it takes them for you`;
      entries.push({ text, cashDelta: -fee, category: "infrastructure" });
    }
    return entries;
  }

  /** The SaaS platform's fee on some payments: none off SaaS. */
  function saasFeeOn(state: GameState, payments: number): number {
    const tx = transactionsOf(state.productType);
    return tx && state.model === "saas" ? Math.round(payments * tx.saasFeeRate) : 0;
  }

  /** The SaaS platform's fee on a usual day's payments, for the runway: none off SaaS. */
  function usualSaasFee(state: GameState): number {
    const tx = transactionsOf(state.productType);
    return tx ? saasFeeOn(state, (state.paidUsers * tx.volumePerPaidUser) / config.billing.daysPerMonth) : 0;
  }

  /**
   * Share of paying users who stop paying in a day because the price is above what they think it's worth: for each
   * customer type, priceChurn times (price / its threshold - 1)^2, at most maxPriceChurn, weighted by its share of
   * users. None at or below every threshold.
   */
  function priceChurn(state: GameState): number {
    return weightedReaction(priceChurnByType(state));
  }

  /** The first day from `from` on that `on` holds, looking a year ahead: null if none does. */
  function nextDayWhen(from: number, on: (day: number) => boolean): number | null {
    for (let d = from; d < from + 366; d++) if (on(d)) return d;
    return null;
  }

  /** The payments app's prices and income streams, for the screens. Null on other products. */
  function paymentsView(state: GameState): PaymentsView | null {
    const tx = transactionsOf(state.productType);
    if (!tx) return null;
    const p = state.productType;
    const rate = state.transactionRate ?? 0;
    const usualDayPayments = Math.round((state.paidUsers * tx.volumePerPaidUser) / config.billing.daysPerMonth);
    const day = state.day + 1;
    const multiplier = paymentsMultiplier(state, day);
    // A rush already under way isn't "to come": the next one starts after it.
    const startOf = (on: (d: number) => boolean) => nextDayWhen(day, (d) => on(d) && !on(d - 1));
    // One after the game's final day won't come.
    const inGame = (d: number | null) => (d !== null && (state.finalDay === null || d <= state.finalDay) ? d : null);
    return {
      fee: state.price,
      fairFee: fairPrice(p),
      rate,
      fairRate: tx.fairRate,
      maxRate: tx.maxRate,
      volumePerPaidUser: tx.volumePerPaidUser,
      monthly: Math.round(monthlyNow(state) * 100) / 100,
      fairMonthly: Math.round(fairMonthly(p) * 100) / 100,
      usualDayPayments,
      usualDayFees: Math.round((state.paidUsers * state.price) / config.billing.daysPerMonth),
      usualDayTransactionFees: Math.round(usualDayPayments * rate),
      usualDaySaasFee: usualSaasFee(state),
      saasFeeRate: tx.saasFeeRate,
      nextDay: {
        day,
        multiplier: Math.round(multiplier * 100) / 100,
        busy: isBlackFriday(state, day) ? "black-friday" : isPayday(p, day) ? "payday" : null,
      },
      nextPayday: inGame(startOf((d) => isPayday(p, d))),
      nextBlackFriday: inGame(calendar.calendar(state).upcoming.find((h) => h.id === "blackFriday" && h.effect)?.startDay ?? null),
      feeIncome: state.feeIncome,
      transactionIncome: state.transactionIncome,
    };
  }

  /** Each customer type's share of users and the share of its paying users the price loses each day: see priceChurn. */
  function priceChurnByType(state: GameState): TypeReaction[] {
    const { priceChurn, maxPriceChurn } = config.pricing;
    const now = monthlyNow(state);
    return byType(state, (th) => Math.min(maxPriceChurn, priceChurn * Math.max(0, now / th - 1) ** 2));
  }

  /**
   * The customer mix for the screens: each type's share and users, and its price threshold to mark on the bar.
   * CustomerMix adds what new users would be.
   */
  function customerMix(state: GameState): Omit<CustomerMixView, "types"> & { types: Omit<CustomerTypeView, MixShift>[] } {
    return {
      types: CUSTOMER_TYPE_IDS.map((id) => {
        const { name, blurb } = config.customerTypes[id];
        const share = state.customerMix[id];
        const th = Math.round(threshold(state.productType, id) * 100) / 100;
        return { id, name, blurb, share, users: Math.round(state.users * share), threshold: th, overThreshold: monthlyNow(state) > th };
      }),
      price: Math.round(monthlyNow(state) * 100) / 100,
      fairPrice: Math.round(fairMonthly(state.productType) * 100) / 100,
      includesRate: state.transactionRate !== null,
    };
  }

  return {
    fairPrice,
    baseMix,
    threshold,
    fairMonthly,
    monthlyNow,
    isBlackFriday,
    monthly,
    isPayday,
    paydayMultiplier,
    paymentsMultiplier,
    paymentsView,
    usualSaasFee,
    startingPricing,
    setPrice,
    lockDaysLeft,
    pricePreview,
    priceWave,
    waveDay,
    priceGrowth,
    paidUsersAfter,
    paidShareOfNew,
    priceChurn,
    priceChurnByType,
    customerMix,
    dailyIncome,
    incomeEntries,
  };
}

export type Pricing = ReturnType<typeof createPricing>;
