import { TIER_NUMBERS, type GameConfig, type ModelId, type ProductTypeId, type TierNumber } from "./config.ts";
import { hasExecutive } from "./executives.ts";
import { count, pounds } from "./finance.ts";
import { SimError, type GameState, type LogEntry, type TierReached } from "./state.ts";

/** What an item in a tier is: a product feature (kept through a migration) or a model benefit (lost on one). */
export type TierItemKind = "feature" | "benefit";

/** One item in a tier, for the screen. */
export interface TierItemView {
  /** The feature's or benefit's id: stable, so later unlocks can name it. */
  id: string;
  kind: TierItemKind;
  name: string;
  blurb: string;
  tier: TierNumber;
  /** The model a benefit belongs to; null for a product feature, which works on any model. */
  model: ModelId | null;
  /** Research points (RP) to unlock it: 0 in tier 1. */
  rpPrice: number;
  /** Unlocked: in tier 1, or unlocked with RP. It can be built or bought, at its own cost. */
  unlocked: boolean;
  /** Its tier is available and it isn't unlocked yet, so RP can unlock it now (if there are enough banked). */
  unlockable: boolean;
}

/** One part of a tier's condition, with how far the company has got. */
export interface TierConditionView {
  label: string;
  /** Where the company is now, in `unit`. */
  value: number;
  target: number;
  unit: "users" | "pounds" | "percent" | "yes";
  met: boolean;
}

export interface TierStatusView {
  tier: TierNumber;
  /** Its condition has been met (tier 1 always is): its items can be unlocked with RP (tier 1's already are). */
  available: boolean;
  /** The day it became available: 1 for tier 1, null until then. */
  day: number | null;
  /** True when meeting any one part of the condition is enough; false when every part is needed. */
  any: boolean;
  /** The condition's parts; empty for tier 1, which has none. */
  conditions: TierConditionView[];
  /** The product's features in it, then the model benefits for every model, in config order. */
  items: TierItemView[];
}

/** Anything a condition needs that the tiers can't work out from state alone. */
export interface TierContext {
  /** Every IPO readiness condition is met today. */
  ipoReady(state: GameState): boolean;
}

/** A feature's tier: 1 when its config leaves it out. */
export const featureTier = (f: { tier?: TierNumber }): TierNumber => f.tier ?? 1;

/**
 * The tier an item is in, by id: one of the product's features or a model benefit. Undefined for an id that's
 * neither.
 */
export function itemTier(config: GameConfig, state: Pick<GameState, "productType">, id: string): TierNumber | undefined {
  return findItem(config, state, id)?.tier;
}

/** An item by id, one of the product's features or a model benefit: its name, tier and RP price. */
function findItem(config: GameConfig, state: Pick<GameState, "productType">, id: string) {
  const feature = config.productTypes[state.productType].features.find((f) => f.id === id);
  const item = feature ?? config.tiers.benefits.find((b) => b.id === id);
  if (!item) return undefined;
  const tier = featureTier(item);
  return { name: item.name, tier, rpPrice: rpPrice(item, tier) };
}

/** An item's RP price by id: 0 in tier 1, or for an id that's in no tier. */
export const itemRpPrice = (config: GameConfig, state: Pick<GameState, "productType">, id: string) =>
  findItem(config, state, id)?.rpPrice ?? 0;

/** An item's RP price: none in tier 1, which is unlocked from the start. */
const rpPrice = (item: { rpPrice?: number }, tier: TierNumber) => (tier === 1 ? 0 : (item.rpPrice ?? 0));

/** The state unlocking reads: the product, the tiers reached and the items unlocked. */
type UnlockState = Pick<GameState, "productType" | "tiers" | "unlocks">;

/** Whether a tier's condition has been met: tier 1 always, later tiers once reached (they stay reached). */
export const tierAvailable = (state: Pick<GameState, "tiers">, tier: TierNumber) =>
  tier === 1 || state.tiers.some((t) => t.tier === tier);

/**
 * Whether an item can be built or bought: every tier 1 item, and above tier 1 once it's been unlocked with research
 * points (which needs its tier available first). Unlocks belong to the company, so they hold on any model.
 */
export function isUnlocked(config: GameConfig, state: UnlockState, id: string): boolean {
  const tier = itemTier(config, state, id);
  return tier === 1 || (tier !== undefined && state.unlocks.includes(id));
}

/**
 * The refusal for an item that isn't unlocked: what the student has to do first. Either its tier isn't available
 * yet, or it is and the item needs unlocking with research points.
 */
export function lockedMessage(config: GameConfig, state: UnlockState & Pick<GameState, "phase">, id: string): string {
  const item = findItem(config, state, id);
  if (!item) return "That isn't in any tier.";
  if (!tierAvailable(state, item.tier)) {
    return `${item.name} is in tier ${item.tier}, which isn't available yet. ${conditionText(config, state, item.tier)}`;
  }
  // Features and benefits open in Grow, with researchers (#236), so research is always open by now.
  return `${item.name} needs unlocking first: ${count.format(item.rpPrice)} RP on the Research page.`;
}

/**
 * Unlocks an item above tier 1 with research points, once its tier is available: its RP price comes off the bank.
 * Items in a tier can be unlocked in any order, and any model's benefits can be, ready for a migration.
 */
export function unlockItem(config: GameConfig, state: GameState, id: string): GameState {
  const item = findItem(config, state, id);
  if (!item) throw new SimError("unknown_item", "Pick a feature or model benefit from a tier.");
  if (isUnlocked(config, state, id)) {
    const why = item.tier === 1 ? "it's in tier 1, open from the start" : "you've unlocked it already";
    throw new SimError("already_unlocked", `${item.name} needs no unlocking: ${why}.`);
  }
  if (!tierAvailable(state, item.tier)) {
    throw new SimError("tier_unavailable", `${item.name} is in tier ${item.tier}, which isn't available yet. ${conditionText(config, state, item.tier)}`);
  }
  if (item.rpPrice > state.researchPoints) {
    throw new SimError(
      "not_enough_rp",
      `Unlocking ${item.name} takes ${count.format(item.rpPrice)} RP and you have ${count.format(state.researchPoints)}.`,
      { cost: item.rpPrice, points: state.researchPoints },
    );
  }
  const points = Math.round((state.researchPoints - item.rpPrice) * 100) / 100;
  return { ...state, researchPoints: points, unlocks: [...state.unlocks, id] };
}

/** Every item in every tier, the product's features and every model's benefits: their ids. */
const allItems = (config: GameConfig, state: Pick<GameState, "productType">) => [
  ...config.productTypes[state.productType].features.map((f) => f.id),
  ...config.tiers.benefits.map((b) => b.id),
];

/** Every item in every tier is unlocked, so research has nothing left to spend RP on. */
export const everythingUnlocked = (config: GameConfig, state: UnlockState) =>
  allItems(config, state).every((id) => isUnlocked(config, state, id));

/** The users tier 2 needs on a product: its share of the product's market, to the nearest 100. */
export const tier2Users = (config: GameConfig, productType: ProductTypeId) =>
  Math.round((config.tiers.tier2.marketShare * config.productTypes[productType].growth.marketSize) / 100) * 100;

/** A tier's condition in words, for a refusal or a log line. */
function conditionText(config: GameConfig, state: Pick<GameState, "productType">, tier: TierNumber): string {
  const { tier3 } = config.tiers;
  switch (tier) {
    case 1:
      return "It's open from the start.";
    case 2:
      return `Tier 2 opens at ${count.format(tier2Users(config, state.productType))} users, or with a CTO.`;
    case 3:
      return `Tier 3 opens once your last ${tier3.days} days average ${pounds(tier3.dailyIncome)} a day in income and ${tier3.uptime}% uptime.`;
    case 4:
      return "Tier 4 opens with an angel investor's money, or once you're ready for an IPO.";
  }
}

/** The last `days` days played, newest last: income and hours down on each. */
const lastDays = (state: Pick<GameState, "spendByDay">, days: number) => state.spendByDay.slice(-days);

/** Each part of a tier's condition today. */
function conditions(config: GameConfig, state: GameState, tier: TierNumber, ctx: TierContext): TierConditionView[] {
  const { tier3 } = config.tiers;
  const part = (label: string, value: number, target: number, unit: TierConditionView["unit"]) => ({
    label,
    value,
    target,
    unit,
    met: value >= target,
  });
  switch (tier) {
    case 1:
      return [];
    case 2:
      return [
        part("Users", state.users, tier2Users(config, state.productType), "users"),
        part("A CTO hired", hasExecutive(state, "cto") ? 1 : 0, 1, "yes"),
      ];
    case 3: {
      // Averaged over the whole window, so a company that hasn't played that many days yet can't meet it.
      const window = lastDays(state, tier3.days);
      const full = window.length >= tier3.days;
      const income = window.reduce((sum, d) => sum + d.income, 0) / Math.max(1, tier3.days);
      const down = window.reduce((sum, d) => sum + d.hoursDown, 0);
      const uptime = full ? 100 * (1 - down / (24 * tier3.days)) : 0;
      return [
        part(`Income a day, last ${tier3.days} days`, Math.round(income), tier3.dailyIncome, "pounds"),
        part(`Uptime, last ${tier3.days} days`, Math.round(uptime * 100) / 100, tier3.uptime, "percent"),
      ];
    }
    case 4:
      return [
        part("An angel investor's money taken", state.investors.angel ? 1 : 0, 1, "yes"),
        part("Every IPO condition met", ctx.ipoReady(state) ? 1 : 0, 1, "yes"),
      ];
  }
}

/** Tiers 2 (the users, or a CTO) and 4 take either part; tier 3 needs both of its parts. */
const anyPart = (tier: TierNumber) => tier === 2 || tier === 4;

const conditionMet = (list: TierConditionView[], tier: TierNumber) =>
  anyPart(tier) ? list.some((c) => c.met) : list.every((c) => c.met);

/** Tiers: which are available, what each holds, and opening them as their conditions are met. */
export function createTiers(config: GameConfig, ctx: TierContext) {
  /** Every item in a tier: the product's features, then each model's benefits. */
  function items(state: GameState, tier: TierNumber): TierItemView[] {
    const available = tierAvailable(state, tier);
    const view = (i: { id: string; name: string; blurb: string; rpPrice?: number }, kind: TierItemKind, model: ModelId | null) => {
      const unlocked = isUnlocked(config, state, i.id);
      return { id: i.id, kind, name: i.name, blurb: i.blurb, tier, model, rpPrice: rpPrice(i, tier), unlocked, unlockable: available && !unlocked };
    };
    const features = config.productTypes[state.productType].features
      .filter((f) => featureTier(f) === tier)
      .map((f) => view(f, "feature", null));
    const benefits = config.tiers.benefits.filter((b) => b.tier === tier).map((b) => view(b, "benefit", b.model));
    return [...features, ...benefits];
  }

  function tiersView(state: GameState): TierStatusView[] {
    return TIER_NUMBERS.map((tier) => ({
      tier,
      available: tierAvailable(state, tier),
      day: tier === 1 ? 1 : (state.tiers.find((t) => t.tier === tier)?.day ?? null),
      any: anyPart(tier),
      conditions: conditions(config, state, tier, ctx),
      items: items(state, tier),
    }));
  }

  /**
   * After a day is played: each tier whose condition is met becomes available, in order, so a tier never opens
   * before the one below it. Several can open on one day. Once open, a tier stays open.
   */
  function tiersDay(state: GameState): { tiers: TierReached[]; entries: LogEntry[] } {
    const reached = [...state.tiers];
    const entries: LogEntry[] = [];
    for (const tier of TIER_NUMBERS) {
      if (tierAvailable({ tiers: reached }, tier)) continue;
      if (!conditionMet(conditions(config, state, tier, ctx), tier)) break;
      reached.push({ tier, day: state.day });
      const names = items({ ...state, tiers: reached }, tier)
        .filter((i) => i.kind === "feature" || i.model === state.model)
        .map((i) => i.name);
      const what = names.length ? `: ${names.join(", ")} can now be unlocked with research points` : "";
      entries.push({ text: `Tier ${tier} available${what}.`, cashDelta: 0, kind: "finished" });
    }
    return { tiers: reached, entries };
  }

  return { tiersView, tiersDay };
}

export type Tiers = ReturnType<typeof createTiers>;
