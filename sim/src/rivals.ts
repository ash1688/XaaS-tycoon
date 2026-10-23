import {
  CUSTOMER_TYPE_IDS,
  type CustomerTypeId,
  type GameConfig,
  type ProductTypeId,
  type RivalConfig,
  type StaffGrade,
  type StaffPool,
} from "./config.ts";
import type { Features } from "./features.ts";
import { pounds } from "./finance.ts";
import { nextRandom, seedRng } from "./rng.ts";
import type { GameState, LogEntry, RivalJoin, RivalState } from "./state.ts";

/** One company in the market, the student's or a rival, for the screens. */
export interface MarketCompanyView {
  /** "you" for the student's company, or the rival's id. */
  id: string;
  name: string;
  /** One line on what it's like. Empty for the student's company. */
  blurb: string;
  you: boolean;
  price: number;
  /** 0–100, from features and uptime (and, for a rival, staff who joined it). */
  quality: number;
  features: number;
  uptime: number;
  users: number;
  /** Its share of every user in the market, 0–1. */
  share: number;
}

/** How one customer type's new users split between the companies today. */
export interface TypeContestView {
  id: CustomerTypeId;
  name: string;
  /** Each company's share of the type's new users, in the order of MarketView.companies, adding up to 1. */
  shares: number[];
  /** The company that wins most of them: the best value for the type. */
  bestId: string;
  bestName: string;
}

/** The market: every company's price, quality and share, and who wins each customer type's new users. */
export interface MarketView {
  /** The student's company first, then the rivals in config order. */
  companies: MarketCompanyView[];
  /** Least willing to pay first. */
  byType: TypeContestView[];
  /** What rivals multiply the student's daily growth by: 1 when the student is as good a deal as them. */
  growth: number;
  /** Days a rival takes to answer the student's price. */
  reactionDays: number;
  /** A price of the student's the rivals haven't answered yet, and the day they will; null when there isn't one. */
  nextReaction: { day: number; price: number } | null;
}

/** Someone in the market for the value sums: a price and a quality. */
interface Contender {
  price: number;
  quality: number;
}

/**
 * Rivals: one or two computer-run companies in the same market, each just a price, a quality and users. New users of
 * each customer type split between the student and the rivals by value, which speeds or slows the student's growth.
 * Rivals answer the student's price after a delay, sometimes undercutting it, and can take on staff the student lets
 * go. They never run out of money.
 */
export function createRivals(config: GameConfig, features: Features) {
  const rivalConfigs = (productType: ProductTypeId): RivalConfig[] => config.productTypes[productType].rivals ?? [];
  const fairPrice = (productType: ProductTypeId) => config.productTypes[productType].pricing.fairPrice;
  const penny = (n: number) => Math.round(n * 100) / 100;
  const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

  /** A rival's price stance applied to a price, kept to the configured band around the fair price. */
  function stancePrice(productType: ProductTypeId, price: number): number {
    const fair = fairPrice(productType);
    return penny(clamp(price, fair * config.rivals.minPriceMultiple, fair * config.rivals.maxPriceMultiple));
  }

  /** A new game's rivals, at their stance against the fair price, with a random stream of their own. */
  function startingRivals(productType: ProductTypeId, seed: number) {
    const fair = fairPrice(productType);
    const rivals: RivalState[] = rivalConfigs(productType).map((r) => ({
      id: r.id,
      price: stancePrice(productType, fair * r.priceStance),
      users: r.startingUsers,
      staffQuality: 0,
      reactedTo: fair,
    }));
    return { rivals, rivalRng: seedRng(seed ^ 0x71a1), rivalJoins: [] as RivalJoin[] };
  }

  /** Quality 0–100 from a share of the product's features and an uptime percentage, plus any bonus. */
  function quality(productType: ProductTypeId, featureCount: number, uptime: number, bonus = 0): number {
    const { qualityFromFeatures, qualityFromUptime, worstUptime } = config.rivals;
    const total = config.productTypes[productType].features.length;
    const featureShare = total > 0 ? Math.min(1, featureCount / total) : 1;
    const uptimeShare = clamp((uptime - worstUptime) / Math.max(0.001, 100 - worstUptime), 0, 1);
    return Math.min(100, qualityFromFeatures * featureShare + qualityFromUptime * uptimeShare + bonus);
  }

  /** The student's uptime across every day played, as Infrastructure works it out. */
  function studentUptime(state: GameState): number {
    const hoursPlayed = (state.day - 1) * 24;
    return hoursPlayed === 0 ? 100 : (100 * (hoursPlayed - state.downtimeHours)) / hoursPlayed;
  }

  /** The uptime quality counts: over at least uptimeDays, the days not yet played as up. */
  function qualityUptime(state: GameState): number {
    const hours = Math.max((state.day - 1) * 24, config.rivals.uptimeDays * 24);
    return hours === 0 ? 100 : (100 * Math.max(0, hours - state.downtimeHours)) / hours;
  }

  /** A rival's features on a day: those it started with, plus one every featureEveryDays, up to the product's list. */
  function rivalFeatures(productType: ProductTypeId, r: RivalConfig, day: number): number {
    const total = config.productTypes[productType].features.length;
    return Math.min(total, r.features + Math.floor((day - 1) / Math.max(1, r.featureEveryDays)));
  }

  const studentQuality = (state: GameState) =>
    quality(state.productType, features.activeCount(state), qualityUptime(state));

  function rivalQuality(state: GameState, r: RivalConfig, rival: RivalState): number {
    return quality(state.productType, rivalFeatures(state.productType, r, state.day), r.uptime, rival.staffQuality);
  }

  /** The student first, then each rival. */
  function contenders(state: GameState): Contender[] {
    const configs = rivalConfigs(state.productType);
    return [
      { price: state.price, quality: studentQuality(state) },
      ...state.rivals.map((rival, i) => ({ price: rival.price, quality: rivalQuality(state, configs[i]!, rival) })),
    ];
  }

  /** Each contender's share of a customer type's new users: in proportion to e^value. */
  function sharesFor(productType: ProductTypeId, type: CustomerTypeId, list: Contender[]): number[] {
    const fair = fairPrice(productType);
    const pw = config.rivals.priceWeight[type];
    const qw = config.rivals.qualityWeight[type];
    const values = list.map((c) => qw * (c.quality / 100) - pw * Math.log(Math.max(0.01, c.price) / fair));
    const top = Math.max(...values);
    const weights = values.map((v) => Math.exp(v - top));
    const sum = weights.reduce((s, w) => s + w, 0);
    return weights.map((w) => w / sum);
  }

  /** Each customer type's split of new users between the contenders. */
  function contest(state: GameState, list = contenders(state)): Record<CustomerTypeId, number[]> {
    return Object.fromEntries(CUSTOMER_TYPE_IDS.map((t) => [t, sharesFor(state.productType, t, list)])) as Record<
      CustomerTypeId,
      number[]
    >;
  }

  /** What winning a share of a type's new users does to growth: (share ÷ an even share)^growthEffect. */
  const weight = (share: number, companies: number) => (share * companies) ** config.rivals.growthEffect;

  /** A mix-weighted growth multiplier for contender i, kept between minGrowth and maxGrowth. */
  function growthFor(split: Record<CustomerTypeId, number[]>, mix: Record<CustomerTypeId, number>, i: number): number {
    const companies = split.casual.length;
    const sum = CUSTOMER_TYPE_IDS.reduce((total, t) => total + mix[t] * weight(split[t][i]!, companies), 0);
    return clamp(sum, config.rivals.minGrowth, config.rivals.maxGrowth);
  }

  /**
   * How much rivals scale each customer type's new users for the student: above 1 for a type the student is the best
   * value for, below 1 where a rival is. 1 for every type with no rivals.
   */
  function newUserWeights(state: GameState): Record<CustomerTypeId, number> {
    const split = contest(state);
    const companies = split.casual.length;
    return Object.fromEntries(CUSTOMER_TYPE_IDS.map((t) => [t, weight(split[t][0]!, companies)])) as Record<
      CustomerTypeId,
      number
    >;
  }

  /** The day's growth is multiplied by this: the student's new-user weights, weighted by their customer mix. */
  function rivalGrowth(state: GameState): number {
    if (!state.rivals.length) return 1;
    return growthFor(contest(state), state.customerMix, 0);
  }

  /** The product's own customer mix, scaled to add up to 1: who rivals' users are. */
  function marketMix(productType: ProductTypeId): Record<CustomerTypeId, number> {
    const mix = config.productTypes[productType].pricing.customerMix;
    const sum = CUSTOMER_TYPE_IDS.reduce((total, t) => total + Math.max(0, mix[t] ?? 0), 0);
    return Object.fromEntries(
      CUSTOMER_TYPE_IDS.map((t) => [t, sum > 0 ? Math.max(0, mix[t] ?? 0) / sum : t === "casual" ? 1 : 0]),
    ) as Record<CustomerTypeId, number>;
  }

  /** The student's price in force on a day: the latest change made by then, or the price before any change. */
  function priceOn(state: GameState, day: number): number {
    let price = state.priceChanges[0]?.from ?? state.price;
    for (const c of state.priceChanges) if (c.day <= day) price = c.to;
    return price;
  }

  const poolPerson = (pool: StaffPool, n: number) => {
    const person = config.staff[pool].personName;
    return n === 1 ? person : person === "ops person" ? "ops staff" : `${person}s`;
  };

  /**
   * A rival's day: it answers the price the student charged reactionDays ago if it hasn't yet, then wins its share of
   * the market's new users. Staff who joined a rival since yesterday are logged first.
   */
  function rivalsDay(state: GameState, day: number) {
    const configs = rivalConfigs(state.productType);
    const entries: LogEntry[] = [];
    for (const j of state.rivalJoins) {
      const name = configs.find((r) => r.id === j.rivalId)?.name ?? j.rivalId;
      const who = `${config.staffGrades[j.grade].name.toLowerCase()} ${poolPerson(j.pool, 1)}`;
      entries.push({ text: `A ${who} you let go joined ${name}, raising its quality.`, cashDelta: 0, kind: "rival" });
    }
    let rng = state.rivalRng;
    const seenDay = day - config.rivals.reactionDays;
    const seen = seenDay >= 1 ? priceOn(state, seenDay) : null;
    const priced = state.rivals.map((rival, i) => {
      const r = configs[i]!;
      if (seen === null || seen === rival.reactedTo) return rival;
      const [roll, next] = nextRandom(rng);
      rng = next;
      const undercut = roll < config.rivals.undercutChance;
      const target = undercut ? Math.min(seen * r.priceStance, seen * (1 - config.rivals.undercutShare)) : seen * r.priceStance;
      const price = stancePrice(state.productType, target);
      if (price !== rival.price) {
        const text = undercut
          ? `${r.name} undercut you: it now charges ${pounds(price)} a month, against your ${pounds(seen)}.`
          : `${r.name} answered your ${pounds(seen)} price: it now charges ${pounds(price)} a month.`;
        entries.push({ text, cashDelta: 0, kind: "rival" });
      }
      return { ...rival, price, reactedTo: seen };
    });
    // Rivals grow from their own users, by the value they offer the product's usual mix of customers.
    const split = contest(state, contenders({ ...state, rivals: priced }));
    const mix = marketMix(state.productType);
    const rivals = priced.map((rival, i) => {
      const r = configs[i]!;
      const room = Math.max(0, 1 - rival.users / Math.max(1, r.maxUsers));
      const gained = Math.round(rival.users * r.dailyGrowth * room * growthFor(split, mix, i + 1));
      return { ...rival, users: rival.users + gained };
    });
    return { rivals, rivalRng: rng, rivalJoins: [] as RivalJoin[], entries };
  }

  /**
   * Staff the student has just let go: each may join a rival (joinChance), raising its quality by qualityPerStaff ×
   * their grade's output, up to maxStaffQuality. Logged with the next day played.
   */
  function staffLeft(state: GameState, pool: StaffPool, grade: StaffGrade, n: number): GameState {
    if (!state.rivals.length) return state;
    let rng = state.rivalRng;
    const rivals = [...state.rivals];
    const joins = [...state.rivalJoins];
    const { joinChance, qualityPerStaff, maxStaffQuality } = config.rivals;
    for (let k = 0; k < n; k++) {
      const [roll, afterRoll] = nextRandom(rng);
      rng = afterRoll;
      if (roll >= joinChance) continue;
      const [pick, afterPick] = nextRandom(rng);
      rng = afterPick;
      const i = Math.min(rivals.length - 1, Math.floor(pick * rivals.length));
      const rival = rivals[i]!;
      const gain = qualityPerStaff * config.staffGrades[grade].output;
      rivals[i] = { ...rival, staffQuality: Math.min(maxStaffQuality, rival.staffQuality + gain) };
      joins.push({ rivalId: rival.id, pool, grade });
    }
    return { ...state, rivals, rivalRng: rng, rivalJoins: joins };
  }

  function market(state: GameState): MarketView {
    const configs = rivalConfigs(state.productType);
    const list = contenders(state);
    const total = state.users + state.rivals.reduce((sum, r) => sum + r.users, 0);
    const share = (users: number) => (total > 0 ? users / total : 0);
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const companies: MarketCompanyView[] = [
      {
        id: "you",
        name: state.companyName,
        blurb: "",
        you: true,
        price: state.price,
        quality: round1(list[0]!.quality),
        features: features.activeCount(state),
        uptime: round1(studentUptime(state)),
        users: state.users,
        share: share(state.users),
      },
      ...state.rivals.map((rival, i) => {
        const r = configs[i]!;
        return {
          id: rival.id,
          name: r.name,
          blurb: r.blurb,
          you: false,
          price: rival.price,
          quality: round1(list[i + 1]!.quality),
          features: rivalFeatures(state.productType, r, state.day),
          uptime: r.uptime,
          users: rival.users,
          share: share(rival.users),
        };
      }),
    ];
    const split = contest(state, list);
    const byType = CUSTOMER_TYPE_IDS.map((id) => {
      const shares = split[id];
      const best = shares.indexOf(Math.max(...shares));
      return { id, name: config.customerTypes[id].name, shares, bestId: companies[best]!.id, bestName: companies[best]!.name };
    });
    // The latest change whose answer is still to come.
    const pending = [...state.priceChanges].reverse().find((c) => c.day + config.rivals.reactionDays > state.day);
    const nextReaction =
      state.rivals.length && pending ? { day: pending.day + config.rivals.reactionDays, price: pending.to } : null;
    return {
      companies,
      byType,
      growth: rivalGrowth(state),
      reactionDays: config.rivals.reactionDays,
      nextReaction,
    };
  }

  return { startingRivals, rivalGrowth, newUserWeights, rivalsDay, staffLeft, market };
}

export type Rivals = ReturnType<typeof createRivals>;
