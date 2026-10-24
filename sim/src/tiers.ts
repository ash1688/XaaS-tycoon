import { TIER_NUMBERS, type GameConfig, type ModelId, type TierNumber } from "./config.ts";
import { count, pounds } from "./finance.ts";
import type { GameState, LogEntry, TierReached } from "./state.ts";

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
  /** It can be built or bought: for now, whenever its tier is available. */
  unlocked: boolean;
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
  /** Its condition has been met (tier 1 always is): its items are unlocked. */
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
  const feature = config.productTypes[state.productType].features.find((f) => f.id === id);
  if (feature) return featureTier(feature);
  return config.tiers.benefits.find((b) => b.id === id)?.tier;
}

/** Whether a tier's condition has been met: tier 1 always, later tiers once reached (they stay reached). */
export const tierAvailable = (state: Pick<GameState, "tiers">, tier: TierNumber) =>
  tier === 1 || state.tiers.some((t) => t.tier === tier);

/**
 * Whether an item can be built or bought. Today that's whenever its tier is available; research will add a price to
 * each item above tier 1, so this is the one place that needs to learn about it.
 */
export function isUnlocked(config: GameConfig, state: Pick<GameState, "productType" | "tiers">, id: string): boolean {
  const tier = itemTier(config, state, id);
  return tier !== undefined && tierAvailable(state, tier);
}

/** The refusal for an item whose tier isn't available yet: what the student has to do first. */
export function lockedMessage(config: GameConfig, name: string, tier: TierNumber): string {
  return `${name} is in tier ${tier}, which isn't unlocked yet. ${conditionText(config, tier)}`;
}

/** A tier's condition in words, for a refusal or a log line. */
function conditionText(config: GameConfig, tier: TierNumber): string {
  const { tier2, tier3 } = config.tiers;
  switch (tier) {
    case 1:
      return "It's open from the start.";
    case 2:
      return `Tier 2 opens at ${count.format(tier2.users)} users.`;
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
  const { tier2, tier3 } = config.tiers;
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
      return [part("Users", state.users, tier2.users, "users")];
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

/** Tier 4 takes either part; every other tier needs all of its parts. */
const anyPart = (tier: TierNumber) => tier === 4;

const conditionMet = (list: TierConditionView[], tier: TierNumber) =>
  anyPart(tier) ? list.some((c) => c.met) : list.every((c) => c.met);

/** Tiers: which are available, what each holds, and opening them as their conditions are met. */
export function createTiers(config: GameConfig, ctx: TierContext) {
  /** Every item in a tier: the product's features, then each model's benefits. */
  function items(state: GameState, tier: TierNumber): TierItemView[] {
    const unlocked = tierAvailable(state, tier);
    const features = config.productTypes[state.productType].features
      .filter((f) => featureTier(f) === tier)
      .map((f) => ({ id: f.id, kind: "feature" as const, name: f.name, blurb: f.blurb, tier, model: null, unlocked }));
    const benefits = config.tiers.benefits
      .filter((b) => b.tier === tier)
      .map((b) => ({ id: b.id, kind: "benefit" as const, name: b.name, blurb: b.blurb, tier, model: b.model, unlocked }));
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
      const what = names.length ? `: ${names.join(", ")} can now be had` : "";
      entries.push({ text: `Tier ${tier} unlocked${what}.`, cashDelta: 0, kind: "finished" });
    }
    return { tiers: reached, entries };
  }

  return { tiersView, tiersDay };
}

export type Tiers = ReturnType<typeof createTiers>;
