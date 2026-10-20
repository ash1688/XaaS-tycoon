import type { GameConfig } from "./config.ts";
import { pounds, type Finance } from "./finance.ts";
import { SimError, type GameState, type Loan, type LogEntry } from "./state.ts";

/** The terms the bank offers on a day, before accepting. See LoanConfig for how they're set. */
export interface LoanQuote {
  amount: number;
  /** Interest as a share of the amount (0.1 = 10%). */
  rate: number;
  /** total − amount. */
  interest: number;
  /** Everything repaid: dailyRepayment × days. */
  total: number;
  dailyRepayment: number;
  /** Repayment days: every day played from tomorrow to the final day. */
  days: number;
  /** The day of the last repayment: the final day. */
  lastDay: number;
}

/** The loan the company has, as it stands. */
export interface LoanView extends Loan {
  /** total − repaid. */
  remaining: number;
  /** Repayments still to come. 0 once repaid. */
  daysLeft: number;
}

const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`;

/** The bank loan: one per company, at the start or later, repaid daily (debt) by the final day whatever happens. */
export function createLoan(config: GameConfig, finance: Finance) {
  const { amount, baseRate, ratePerDay, minDays } = config.loan;

  /** The terms for a loan taken on a day (between days, so repaid from the next one), whether or not it can be. */
  function termsOn(day: number): LoanQuote {
    const rate = Math.round((baseRate + ratePerDay * (day - 1)) * 1e6) / 1e6;
    const days = Math.max(0, config.finalDay - day);
    // Rounded up to the pound, like every charge, so the repayments add up to at least the amount plus interest.
    const dailyRepayment = days ? Math.ceil((amount * (1 + rate)) / days - 1e-9) : 0;
    const total = dailyRepayment * days;
    return { amount, rate, interest: total - amount, total, dailyRepayment, days, lastDay: config.finalDay };
  }

  /** The bank won't lend twice, or with too few days left to repay. */
  function refusal(state: GameState): SimError | null {
    if (state.loan) {
      return new SimError("loan_taken", "You've already taken the bank loan. Each company can only have one.");
    }
    const days = config.finalDay - state.day;
    if (days < minDays) {
      return new SimError(
        "too_late_for_loan",
        `The bank won't lend with fewer than ${minDays} days left to repay it, and there ${days === 1 ? "is" : "are"} ${days} left.`,
        { daysLeft: days },
      );
    }
    return null;
  }

  /** What taking the loan now would cost, or null if it can't be taken: one's been taken, or it's too late. */
  function loanQuote(state: GameState): LoanQuote | null {
    return refusal(state) ? null : termsOn(state.day);
  }

  function loanFor(state: GameState): Loan {
    const { rate, dailyRepayment, total } = termsOn(state.day);
    return { amount, day: state.day, rate, dailyRepayment, total, repaid: 0 };
  }

  /** The money coming in, for the ledger: cash, but not income. */
  function borrowedEntry(loan: Loan): LogEntry {
    return { text: `Bank loan: you borrowed ${pounds(loan.amount)}`, cashDelta: loan.amount, kind: "loan" };
  }

  /** A new game's loan and the money it brings, when the student takes it at the start. */
  function startLoan(state: GameState): { state: GameState; entries: LogEntry[] } {
    const refused = refusal(state);
    if (refused) throw refused;
    const loan = loanFor(state);
    return { state: { ...state, loan }, entries: [borrowedEntry(loan)] };
  }

  /** Takes the loan between days: the money arrives at once, and repayments start tomorrow. */
  function takeLoan(state: GameState): GameState {
    const refused = refusal(state);
    if (refused) throw refused;
    const loan = loanFor(state);
    return { ...finance.chargeNow(state, [borrowedEntry(loan)]), loan };
  }

  /**
   * A day's repayment (debt), charged whatever happens, with notes on the first repayment saying the loan was taken
   * and its terms, and on the last saying it's repaid. Nothing once it's repaid, or before one's taken.
   */
  function repaymentDay(state: GameState, day: number): { loan: Loan | null; entries: LogEntry[] } {
    const loan = state.loan;
    if (!loan || loan.repaid >= loan.total || day <= loan.day) return { loan, entries: [] };
    const charge = Math.min(loan.dailyRepayment, loan.total - loan.repaid);
    const repaid = loan.repaid + charge;
    const entries: LogEntry[] = [];
    if (day === loan.day + 1) {
      const when = loan.day === 1 ? "at the start" : `on day ${loan.day}`;
      entries.push({
        text: `You took a ${pounds(loan.amount)} bank loan ${when} at ${percent(loan.rate)} interest: ${pounds(loan.total)} to repay, ${pounds(loan.dailyRepayment)} a day until day ${config.finalDay}.`,
        cashDelta: 0,
        kind: "loan",
      });
    }
    entries.push({ text: "Bank loan repayment", cashDelta: -charge, category: "debt" });
    if (repaid >= loan.total) {
      entries.push({
        text: `The bank loan is repaid in full: ${pounds(loan.total)}, of which ${pounds(loan.total - loan.amount)} was interest.`,
        cashDelta: 0,
        kind: "loan",
      });
    }
    return { loan: { ...loan, repaid }, entries };
  }

  function loanView(state: GameState): LoanView | null {
    const loan = state.loan;
    if (!loan) return null;
    const remaining = loan.total - loan.repaid;
    return { ...loan, remaining, daysLeft: remaining > 0 ? Math.ceil(remaining / loan.dailyRepayment) : 0 };
  }

  return { termsOn, loanQuote, startLoan, takeLoan, repaymentDay, loanView };
}

export type LoanModule = ReturnType<typeof createLoan>;
