import { SPEND_CATEGORIES, type GameConfig, type ModelId, type ProductTypeId } from "./config.ts";
import { interestIn, profitCosts } from "./finance.ts";
import type { Infrastructure } from "./infrastructure.ts";
import type { DaySpend, GameEnding, GameState, Spend } from "./state.ts";

/** What was spent and earned on one day, and the cash left at the end of it. */
export interface SummaryDay extends DaySpend {
  cash: number;
}

/** Income against costs on one day, and both added up from day 1: the income-against-costs chart. */
export interface IncomeCostDay {
  day: number;
  income: number;
  /**
   * The day's costs against profit: everything spent, but only the interest in any loan repayment, as profitCosts.
   * Cash fell by the whole repayment.
   */
  costs: number;
  totalIncome: number;
  totalCosts: number;
}

/** The users on the day there were most, and how many of them paid. */
export interface PeakUsers {
  /** The first day they reached the peak. */
  day: number;
  users: number;
  paidUsers: number;
}

/** The bank loan, for the summary: null there if it was never taken. */
export interface LoanSummary {
  /** The day it was taken: 1 if at the start. */
  day: number;
  amount: number;
  /** Everything to repay: the amount plus interest. */
  total: number;
  repaid: number;
  /** Of the repaid, the interest: the part that counts against profit. */
  interestPaid: number;
  /** Of the repaid, the amount borrowed being paid back: not a cost, as borrowing it wasn't income. */
  principalRepaid: number;
  /** Repaid in full. False on a game that went bankrupt before the final day. */
  fullyRepaid: boolean;
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
  /** Income − costs: below 0 is a loss. */
  profit: number;
  /** The costs against profit: total spend, but only the interest in the loan repayments (see profitCosts). */
  costs: number;
  /** The most users the company had at the end of a day, with the paid/free split then. */
  peak: PeakUsers;
  /** Satisfaction averaged over every day played after day 1, or today's before any has been. */
  satisfaction: number;
  /** Share of time up across every day played, as a percentage. */
  uptime: number;
  outageDays: number;
  /** Everything spent, by category. */
  spend: Spend;
  /** The categories added up: everything spent, debt included, as cash fell by it. */
  totalSpend: number;
  /** Migrations completed. One still under way at the end doesn't count. */
  migrations: number;
  /** Price changes made. */
  priceChanges: number;
  loan: LoanSummary | null;
  /**
   * Spend and income on each day played and the cash left after it, day 1 (upfront costs) first: the cost-over-time
   * and cash charts.
   */
  days: SummaryDay[];
  /** Income and costs on each day, and added up so far, day 1 first. The last day's totals are income and costs. */
  incomeVsCosts: IncomeCostDay[];
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
    const { loan } = state;
    let totalIncome = 0;
    let totalCosts = 0;
    let repaid = 0;
    const incomeVsCosts = state.spendByDay.map((d): IncomeCostDay => {
      // The day's interest is what the repayments so far hold less what they held yesterday, so the days add up.
      const interest = interestIn(loan, repaid + d.debt) - interestIn(loan, repaid);
      repaid += d.debt;
      const costs = total(d) - d.debt + interest;
      totalIncome += d.income;
      totalCosts += costs;
      return { day: d.day, income: d.income, costs, totalIncome, totalCosts };
    });
    const peak = state.spendByDay.reduce<PeakUsers>(
      (best, d) => (d.users > best.users ? { day: d.day, users: d.users, paidUsers: d.paidUsers } : best),
      { day: 1, users: -1, paidUsers: 0 },
    );
    // Like uptime, over the days played: day 1 is only the setup.
    const played = state.spendByDay.filter((d) => d.day > 1);
    const satisfaction = played.length
      ? played.reduce((sum, d) => sum + d.satisfaction, 0) / played.length
      : state.satisfaction;
    const costs = profitCosts(state.spend, loan);
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
      profit: state.income - costs,
      costs,
      peak,
      satisfaction,
      uptime: infra.uptime(state),
      outageDays: state.outageDays,
      spend: { ...state.spend },
      totalSpend: total(state.spend),
      migrations: state.migrations,
      priceChanges: state.priceChanges.length,
      loan: loan && {
        day: loan.day,
        amount: loan.amount,
        total: loan.total,
        repaid: loan.repaid,
        interestPaid: interestIn(loan, loan.repaid),
        principalRepaid: loan.repaid - interestIn(loan, loan.repaid),
        fullyRepaid: loan.repaid >= loan.total,
      },
      days,
      incomeVsCosts,
    };
  }

  return { summarise };
}
