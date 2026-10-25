import { STAFF_GRADES, STAFF_POOLS, type GameConfig } from "./config.ts";
import { gradeDayRate, NO_PAY_RISE } from "./staff.ts";
import { SimError, type GameState, type LogEntry, type Shareholder } from "./state.ts";
import { peopleLead } from "./peopleLead.ts";

/**
 * Staff schemes the student can offer in a pay review alongside a cash rise. Pension top-up, the health cash plan and
 * share save are sliders; death in service and the discount scheme are on or off (their most level is 1). Share save is
 * paid for in ownership: each level added issues new shares to the staff share scheme (see shareSaveIssue).
 */
export const STAFF_SCHEMES = ["pension", "health", "deathInService", "discount", "shareSave"] as const;
export type StaffSchemeId = (typeof STAFF_SCHEMES)[number];
/** The level of each scheme: 0 is none. Levels only go up. */
export type SchemeLevels = Record<StaffSchemeId, number>;

export const noSchemes = (): SchemeLevels => ({ pension: 0, health: 0, deathInService: 0, discount: 0, shareSave: 0 });

/** A staff scheme as the student sees it: its level, what it costs a day now, and what staff make of a level. */
export interface StaffSchemeView {
  id: StaffSchemeId;
  name: string;
  blurb: string;
  level: number;
  maxLevel: number;
  /** On or off rather than a slider: its most level is 1. */
  toggle: boolean;
  /** Each level's cost: a share of the wage bill and £ per member of staff a day. */
  wageShare: number;
  perPerson: number;
  /** A level's worth to staff, as a rise (0.0075 = three quarters of a point), before the valuation. */
  staffValue: number;
  /** Share save: the new shares each level issues, as a share of those in issue then (0.01 = 1%). 0 for the others. */
  sharesPerLevel: number;
  /** What it costs a day at today's team. */
  costPerDay: number;
}

/** How much of a scheme's value staff count in a pay review, from the people-lead modifier: about 0.7 without a head of people. */
export const schemeValuation = (config: GameConfig, state: GameState): number => peopleLead(config, state).schemeValuation;

/**
 * The staff schemes are paid on: permanent staff on the team, not agency staff (the agency's), nor the C-suite (who
 * have their own packages). Their headcount, and their pay a day.
 */
export function schemeBase(config: GameConfig, state: Pick<GameState, "staff" | "payMultiplier">): { headcount: number; wageBill: number } {
  let headcount = 0;
  let wageBill = 0;
  for (const pool of STAFF_POOLS) {
    if (NO_PAY_RISE.includes(pool)) continue;
    for (const g of STAFF_GRADES) {
      const n = state.staff[pool][g];
      headcount += n;
      wageBill += n * gradeDayRate(config, pool, g, false, state.payMultiplier);
    }
  }
  return { headcount, wageBill };
}

/**
 * One scheme's cost a day at `level`, to the pound like pay, rounded up so a scheme held always costs something: cash
 * stays in whole pounds.
 */
export function schemeCost(
  config: GameConfig,
  state: Pick<GameState, "staff" | "payMultiplier">,
  id: StaffSchemeId,
  level: number,
): number {
  if (!level) return 0;
  const s = config.payReview.schemes[id];
  const { headcount, wageBill } = schemeBase(config, state);
  return Math.ceil(Number((level * (s.wageShare * wageBill + s.perPerson * headcount)).toFixed(6)));
}

/** Every scheme's cost a day at `levels`. */
export const schemesCost = (config: GameConfig, state: Pick<GameState, "staff" | "payMultiplier">, levels: SchemeLevels) =>
  STAFF_SCHEMES.reduce((sum, id) => sum + schemeCost(config, state, id, levels[id]), 0);

/** A day's scheme costs, a staff line for each scheme held: charged with the pay, so they show as staff spend. */
export function schemeEntries(config: GameConfig, state: GameState): LogEntry[] {
  const { headcount } = schemeBase(config, state);
  return STAFF_SCHEMES.filter((id) => state.staffSchemes[id] > 0).flatMap((id): LogEntry[] => {
    const cost = schemeCost(config, state, id, state.staffSchemes[id]);
    if (!cost) return [];
    const s = config.payReview.schemes[id];
    const level = s.maxLevel > 1 ? ` level ${state.staffSchemes[id]}` : "";
    return [{ text: `${s.name}${level} (${headcount} staff)`, cashDelta: -cost, category: "staff" }];
  });
}

/**
 * The levels an offer asks for, checked: known schemes, whole levels within each one's range, and none below the level
 * already held, as levels only go up. Schemes left out stay where they are.
 */
export function checkSchemes(config: GameConfig, held: SchemeLevels, asked: Partial<SchemeLevels> | undefined): SchemeLevels {
  const levels = { ...held };
  if (asked === undefined || asked === null) return levels;
  if (typeof asked !== "object") throw new SimError("bad_offer", "Offer schemes as levels by name.");
  for (const [id, level] of Object.entries(asked)) {
    if (!(STAFF_SCHEMES as readonly string[]).includes(id)) throw new SimError("bad_offer", `There's no staff scheme called "${id}".`);
    const s = config.payReview.schemes[id as StaffSchemeId];
    if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > s.maxLevel) {
      throw new SimError("bad_offer", `${s.name} goes from 0 to ${s.maxLevel}.`);
    }
    if (level < held[id as StaffSchemeId]) {
      throw new SimError(
        "scheme_decrease",
        `${s.name} is already at ${s.maxLevel > 1 ? `level ${held[id as StaffSchemeId]}` : "on"}: schemes once given can't be taken away.`,
        { level: held[id as StaffSchemeId] },
      );
    }
    levels[id as StaffSchemeId] = level;
  }
  return levels;
}

/**
 * What raising the schemes from `held` to `levels` is worth to staff, as a rise: each level added × its staff value ×
 * the valuation. Only the increase counts, so past schemes can't be offered again.
 */
export function schemeValue(config: GameConfig, state: GameState, held: SchemeLevels, levels: SchemeLevels): number {
  const raw = STAFF_SCHEMES.reduce((sum, id) => sum + (levels[id] - held[id]) * config.payReview.schemes[id].staffValue, 0);
  // To a millionth, so float noise in the sum doesn't tip an offer either side of staff's figure.
  return Number((raw * schemeValuation(config, state)).toFixed(6));
}

/** Each scheme as the student sees it, at the levels held. */
export function schemeViews(config: GameConfig, state: GameState): StaffSchemeView[] {
  return STAFF_SCHEMES.map((id) => {
    const s = config.payReview.schemes[id];
    return {
      id,
      name: s.name,
      blurb: s.blurb,
      level: state.staffSchemes[id],
      maxLevel: s.maxLevel,
      toggle: s.maxLevel === 1,
      wageShare: s.wageShare,
      perPerson: s.perPerson,
      staffValue: s.staffValue,
      sharesPerLevel: id === "shareSave" ? config.payReview.shareSavePerLevel : 0,
      costPerDay: schemeCost(config, state, id, state.staffSchemes[id]),
    };
  });
}

/** The schemes raised from `held` to `levels`, in words: "Pension top-up to level 2, Death in service". Empty for none. */
export function schemeRaisesText(config: GameConfig, held: SchemeLevels, levels: SchemeLevels): string {
  return STAFF_SCHEMES.filter((id) => levels[id] > held[id])
    .map((id) => {
      const s = config.payReview.schemes[id];
      return s.maxLevel > 1 ? `${s.name} to level ${levels[id]}` : s.name;
    })
    .join(", ");
}

/** What share save raised from `held` to `levels` would issue: new shares, and who'd own what after. */
export interface ShareSaveIssue {
  /** New shares for the staff share scheme: sharesPerLevel of those in issue now, for each level added. */
  newShares: number;
  sharesInIssue: number;
  sharesAfter: number;
  /** The student's share of the company now and after, 0–1. */
  yourShareBefore: number;
  yourShareAfter: number;
  /** The staff share scheme's share after, 0–1: what it held, plus the new shares. */
  schemeShareAfter: number;
}

/**
 * The new shares raising share save from `held` to `levels` issues: each level added is worth shareSavePerLevel of the
 * company at the time, as new shares, so they dilute every holder as a funding round does. Null when it isn't raised.
 */
export function shareSaveIssue(
  config: GameConfig,
  state: Pick<GameState, "shareholders">,
  held: SchemeLevels,
  levels: SchemeLevels,
): ShareSaveIssue | null {
  const added = levels.shareSave - held.shareSave;
  if (added <= 0) return null;
  const shares = state.shareholders.reduce((sum, h) => sum + h.shares, 0);
  const newShares = Math.max(1, Math.round(shares * config.payReview.shareSavePerLevel * added));
  const sharesAfter = shares + newShares;
  const yours = state.shareholders.find((h) => h.id === "student")?.shares ?? 0;
  const theirs = state.shareholders.find((h) => h.id === "staffScheme")?.shares ?? 0;
  return {
    newShares,
    sharesInIssue: shares,
    sharesAfter,
    yourShareBefore: yours / shares,
    yourShareAfter: yours / sharesAfter,
    schemeShareAfter: (theirs + newShares) / sharesAfter,
  };
}

/**
 * The cap table once share save's new shares are issued: they go to the staff share scheme, a holder of its own that
 * later levels add to. It holds them for the staff, so it's no part of any C-suite equity package or its cap.
 */
export function withShareSave(shareholders: Shareholder[], newShares: number, day: number): Shareholder[] {
  if (newShares <= 0) return shareholders;
  return shareholders.some((h) => h.id === "staffScheme")
    ? shareholders.map((h) => (h.id === "staffScheme" ? { ...h, shares: h.shares + newShares } : h))
    : [...shareholders, { id: "staffScheme", shares: newShares, day }];
}
