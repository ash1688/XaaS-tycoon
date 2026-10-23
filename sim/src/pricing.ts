import { CUSTOMER_TYPE_IDS, type CustomerTypeId, type GameConfig, type ProductTypeId } from "./config.ts";
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
  price: number;
  fairPrice: number;
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

  /** A product's customer mix, its shares scaled to add up to 1. All casual if they add up to nothing. */
  function baseMix(productType: ProductTypeId): Record<CustomerTypeId, number> {
    const mix = config.productTypes[productType].pricing.customerMix;
    const sum = CUSTOMER_TYPE_IDS.reduce((total, t) => total + Math.max(0, mix[t] ?? 0), 0);
    const shares = CUSTOMER_TYPE_IDS.map((t) => [t, sum > 0 ? Math.max(0, mix[t] ?? 0) / sum : t === "casual" ? 1 : 0]);
    return Object.fromEntries(shares) as Record<CustomerTypeId, number>;
  }

  /** A customer type's price threshold for a product: the fair price times the type's multiple. */
  const threshold = (productType: ProductTypeId, type: CustomerTypeId) =>
    fairPrice(productType) * config.customerTypes[type].thresholdMultiple;

  /** Each customer type with its share of users and its reaction, worked out from its threshold. */
  const byType = (state: GameState, reaction: (threshold: number) => number): TypeReaction[] =>
    CUSTOMER_TYPE_IDS.map((id) => ({ id, share: state.customerMix[id], reaction: reaction(threshold(state.productType, id)) }));

  /** A new company's price, paid users and customer mix: the fair price, and the product's free share and mix. */
  function startingPricing(productType: ProductTypeId, users: number) {
    const { fairPrice, freeShare } = config.productTypes[productType].pricing;
    return {
      price: fairPrice,
      paidUsers: Math.round(users * (1 - freeShare)),
      customerMix: baseMix(productType),
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
    if (to <= state.price) return firstDayShare;
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
    return byType(state, (th) => {
      if (to <= state.price) return 0;
      // Of the payers still here at today's price, the share the whole rise to `to` would have lost on top.
      const already = lost(state.price, th);
      return (Math.max(0, lost(to, th) - already) / (1 - already)) * times(th);
    });
  }

  /**
   * The lowest price customers remember: the lowest in effect over the last priceMemoryDays, today's included. A rise
   * is measured from it, and a cut only counts below it.
   */
  function rememberedPrice(state: GameState): number {
    const since = state.day - config.pricing.priceMemoryDays;
    return state.priceChanges.reduce((low, c) => (c.day > since ? Math.min(low, c.from) : low), state.price);
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
   * each type drops to free by its own share. A cut's size scales with the cut against the fair price, raised to
   * waveCurve, so a small tweak barely registers and a big jump hits hard. A cut counts only below both the fair
   * price and the lowest price customers remember: coming back down to the fair price is no bargain, however long the
   * price was dear, and a cut from £300 to £295 is still £295 to them.
   */
  function waveTotal(state: GameState, to: number): WaveEffect {
    const p = config.pricing;
    const fair = fairPrice(state.productType);
    const total = noEffect();
    if (to > state.price) {
      const reactions = riseReactions(state, to);
      const affected = Math.round(state.paidUsers * weightedReaction(reactions));
      const toFree = reactions.map((r) => ({ ...r, reaction: r.reaction * config.customerTypes[r.id].toFreeShare }));
      total.toFree = Math.min(affected, Math.round(state.paidUsers * weightedReaction(toFree)));
      total.left = affected - total.toFree;
      total.tickets = Math.round(affected * p.backlashTicketsPerUser);
    } else if (to < state.price) {
      const size = (Math.max(0, Math.min(rememberedPrice(state), fair) - to) / fair) ** p.waveCurve;
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
    const shape = waveShape(firstDayShare(state, to));
    const columns = EFFECT_KEYS.map((k) => [k, spread(total[k], shape)] as const);
    return shape.map((_, i) => {
      const day = noEffect();
      for (const [k, values] of columns) day[k] = values[i]!;
      return day;
    });
  }

  function planWave(state: GameState, to: number): PriceWave {
    const rise = to > state.price;
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
  function pricePreview(state: GameState, price: number): PricePreview {
    const to = checkedPrice(price);
    const same = to === state.price;
    const days = same ? [] : datedDays(planDays(state, to), state.day + 1);
    const total = sumEffects(days);
    const paidUsers = state.paidUsers - total.left - total.toFree + total.joinedPaid + total.upgraded;
    const users = state.users - total.left + total.joined;
    const left = lockDaysLeft(state);
    const reactions = riseReactions(state, to);
    return {
      price: to,
      currentPrice: state.price,
      direction: same ? "none" : to > state.price ? "rise" : "cut",
      currentDailyIncome: dailyIncome(state),
      dailyIncome: dailyIncome({ ...state, paidUsers, price: to }),
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

  /**
   * The day's income, from the paying users at the start of the day, less any a price rise lost today: they refused
   * the new price rather than pay it. None when nobody pays.
   */
  function incomeEntries(state: GameState, refused = 0): LogEntry[] {
    const paidUsers = Math.max(0, state.paidUsers - refused);
    const income = dailyIncome({ ...state, paidUsers });
    if (income <= 0) return [];
    const text = `Income: ${count.format(paidUsers)} paying users at ${pounds(state.price)} a month`;
    return [{ text, cashDelta: income, kind: "income" }];
  }

  /**
   * Share of paying users who stop paying in a day because the price is above what they think it's worth: for each
   * customer type, priceChurn times (price / its threshold - 1)^2, at most maxPriceChurn, weighted by its share of
   * users. None at or below every threshold.
   */
  function priceChurn(state: GameState): number {
    return weightedReaction(priceChurnByType(state));
  }

  /** Each customer type's share of users and the share of its paying users the price loses each day: see priceChurn. */
  function priceChurnByType(state: GameState): TypeReaction[] {
    const { priceChurn, maxPriceChurn } = config.pricing;
    return byType(state, (th) => Math.min(maxPriceChurn, priceChurn * Math.max(0, state.price / th - 1) ** 2));
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
        return { id, name, blurb, share, users: Math.round(state.users * share), threshold: th, overThreshold: state.price > th };
      }),
      price: state.price,
      fairPrice: fairPrice(state.productType),
    };
  }

  return {
    fairPrice,
    baseMix,
    threshold,
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
