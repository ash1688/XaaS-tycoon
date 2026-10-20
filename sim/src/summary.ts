import { SPEND_CATEGORIES, type GameConfig, type ModelId, type ProductTypeId } from "./config.ts";
import type { Infrastructure } from "./infrastructure.ts";
import type { DaySpend, GameEnding, GameState, Spend } from "./state.ts";

/** What was spent and earned on one day, and the cash left at the end of it. */
export interface SummaryDay extends DaySpend {
  cash: number;
}

/**
 * How a company did, for the end-of-game summary and the teacher's dashboard. Plain and JSON-serialisable, like state.
 * Works on a game still being played too, as a summary so far.
 */
export interface GameSummary {
  companyName: string;
  productType: ProductTypeId;
  /** The model the company ended on. */
  model: ModelId;
  /** How the game ended, or null while it's still being played. */
  ending: GameEnding | null;
  /** The last day played. */
  day: number;
  finalDay: number;
  cash: number;
  users: number;
  /** Of the users, those paying. The rest are free. */
  paidUsers: number;
  /** Everything paying users paid. */
  income: number;
  /** Income − total spend: below 0 is a loss. */
  profit: number;
  /** Share of time up across every day played, as a percentage. */
  uptime: number;
  outageDays: number;
  /** Everything spent, by category. */
  spend: Spend;
  /** The categories added up. */
  totalSpend: number;
  /** Migrations completed. One still under way at the end doesn't count. */
  migrations: number;
  /**
   * Spend and income on each day played and the cash left after it, day 1 (upfront costs) first: the cost-over-time
   * and cash charts.
   */
  days: SummaryDay[];
}

/** The end-of-game summary, also shown as a summary so far. */
export function createSummary(config: GameConfig, infra: Infrastructure) {
  function summarise(state: GameState): GameSummary {
    const total = (s: Spend) => SPEND_CATEGORIES.reduce((sum, c) => sum + s[c], 0);
    // Only charges, income and borrowing move cash, so the cash after each day is today's cash plus everything spent
    // since, less everything earned and borrowed since.
    let cash = state.cash;
    const days: SummaryDay[] = [];
    for (let i = state.spendByDay.length - 1; i >= 0; i--) {
      const d = state.spendByDay[i]!;
      days.unshift({ ...d, cash });
      cash += total(d) - d.income - d.borrowed;
    }
    const ending = state.status === "playing" ? null : state.status === "bankrupt" ? "bankrupt" : "completed";
    return {
      companyName: state.companyName,
      productType: state.productType,
      model: state.model,
      ending,
      day: state.day,
      finalDay: config.finalDay,
      cash: state.cash,
      users: state.users,
      paidUsers: state.paidUsers,
      income: state.income,
      profit: state.income - total(state.spend),
      uptime: infra.uptime(state),
      outageDays: state.outageDays,
      spend: { ...state.spend },
      totalSpend: total(state.spend),
      migrations: state.migrations,
      days,
    };
  }

  return { summarise };
}
