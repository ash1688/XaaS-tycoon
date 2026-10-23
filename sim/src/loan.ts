import type { GameConfig } from "./config.ts";
import { interestIn, pounds, type Finance } from "./finance.ts";
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
  /** Repayment days: the loan's fixed term, from tomorrow. */
  days: number;
  /** The day of the last repayment. It can be after the game's final day. */
  lastDay: number;
}

/** The latest loan, as it stands. */
export interface LoanView extends Loan {
  /** Still to repay over the term: total − repaid. 0 once repaid, early or not. */
  remaining: number;
  /** Repayments still to come. 0 once repaid. */
  daysLeft: number;
  /** What paying it off now would cost: the money borrowed not yet paid back. 0 once repaid. */
  payoff: number;
  /** The interest paying it off now would save: remaining − payoff. */
  interestSaved: number;
  /** Repaid in full, early or not: another loan can be taken. */
  repaidInFull: boolean;
}

const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`;

/** Whether a loan is still being repaid. */
export const isOpen = (loan: Loan | null): boolean => !!loan && loan.paidOffDay === null && loan.repaid < loan.total;

/** The money borrowed on a loan not yet paid back: what paying it off costs. */
const principalLeft = (loan: Loan) => loan.amount - (loan.repaid - loan.interestPaid);

/**
 * Bank loans: one at a time, taken at the start or later, each repaid daily (debt) over its fixed term whatever
 * happens, or paid off early to save the interest still to come. Once one's repaid, another can be taken.
 */
export function createLoan(config: GameConfig, finance: Finance) {
  const { amount, baseRate, ratePerDay, termDays, termPerDay, minTermDays, minDays } = config.loan;

  /** The terms for a loan taken on a day (between days, so repaid from the next one), whether or not it can be. */
  function termsOn(day: number): LoanQuote {
    const rate = Math.round((baseRate + ratePerDay * (day - 1)) * 1e6) / 1e6;
    const days = Math.max(minTermDays, Math.round(termDays - termPerDay * (day - 1)));
    // Rounded up to the pound, like every charge, so the repayments add up to at least the amount plus interest.
    const dailyRepayment = Math.ceil((amount * (1 + rate)) / days - 1e-9);
    const total = dailyRepayment * days;
    return { amount, rate, interest: total - amount, total, dailyRepayment, days, lastDay: day + days };
  }

  /** The bank won't lend while a loan is being repaid, or in the game's last days. */
  function refusal(state: GameState): SimError | null {
    if (isOpen(state.loan)) {
      return new SimError(
        "loan_open",
        "You're still repaying your bank loan. Pay it off first: the bank only lends one at a time.",
      );
    }
    // A term can run past the final day, but the bank won't lend in a game's last days.
    const days = Math.max(0, state.finalDay - state.day);
    if (days < minDays) {
      return new SimError(
        "too_late_for_loan",
        `The bank won't lend with fewer than ${minDays} days of the game left, and there ${days === 1 ? "is" : "are"} ${days} left.`,
        { daysLeft: days },
      );
    }
    return null;
  }

  /** What taking a loan now would cost, or null if one can't be taken: one's being repaid, or it's too late. */
  function loanQuote(state: GameState): LoanQuote | null {
    return refusal(state) ? null : termsOn(state.day);
  }

  /** A new loan taken today, with any repaid one kept for the summary. */
  function withNewLoan(state: GameState): GameState {
    const { rate, days, lastDay, dailyRepayment, total } = termsOn(state.day);
    const loan: Loan = {
      amount,
      day: state.day,
      rate,
      term: days,
      lastDay,
      dailyRepayment,
      total,
      repaid: 0,
      interestPaid: 0,
      paidOffDay: null,
    };
    return { ...state, loan, pastLoans: state.loan ? [...state.pastLoans, state.loan] : state.pastLoans };
  }

  /** The money coming in, for the ledger: cash, but not income. */
  function borrowedEntry(loan: Loan): LogEntry {
    return { text: `Bank loan: you borrowed ${pounds(loan.amount)}`, cashDelta: loan.amount, kind: "loan" };
  }

  /** A new game's loan and the money it brings, when the student takes it at the start. */
  function startLoan(state: GameState): { state: GameState; entries: LogEntry[] } {
    const refused = refusal(state);
    if (refused) throw refused;
    const next = withNewLoan(state);
    return { state: next, entries: [borrowedEntry(next.loan!)] };
  }

  /** Takes a loan between days: the money arrives at once, and repayments start tomorrow. */
  function takeLoan(state: GameState): GameState {
    const refused = refusal(state);
    if (refused) throw refused;
    const next = withNewLoan(state);
    return finance.chargeNow(next, [borrowedEntry(next.loan!)]);
  }

  /** Pays off the loan being repaid with the money borrowed not yet paid back, saving the interest still to come. */
  function repayLoan(state: GameState): GameState {
    const loan = state.loan;
    if (!loan || !isOpen(loan)) throw new SimError("no_loan", "There's no bank loan being repaid to pay off.");
    const payoff = principalLeft(loan);
    if (payoff > state.cash) {
      throw new SimError(
        "not_enough_cash",
        `Paying off the loan takes ${pounds(payoff)}, and you have ${pounds(state.cash)}.`,
        { cost: payoff, cash: state.cash },
      );
    }
    const saved = loan.total - loan.repaid - payoff;
    const entries: LogEntry[] = [
      { text: "Bank loan paid off early", cashDelta: -payoff, category: "debt", interest: 0 },
      {
        text: `The bank loan is repaid in full, early: ${pounds(loan.repaid + payoff)}, of which ${pounds(loan.interestPaid)} was interest. Paying it off saved ${pounds(saved)} of interest.`,
        cashDelta: 0,
        kind: "loan",
      },
    ];
    const paidOff: Loan = { ...loan, repaid: loan.repaid + payoff, paidOffDay: state.day };
    return finance.chargeNow({ ...state, loan: paidOff }, entries);
  }

  /**
   * A day's repayment (debt), charged whatever happens, with notes on the first repayment saying the loan was taken
   * and its terms, and on the last saying it's repaid. Nothing once it's repaid, or before one's taken.
   */
  function repaymentDay(state: GameState, day: number): { loan: Loan | null; entries: LogEntry[] } {
    const loan = state.loan;
    if (!loan || !isOpen(loan) || day <= loan.day) return { loan, entries: [] };
    const charge = Math.min(loan.dailyRepayment, loan.total - loan.repaid);
    const repaid = loan.repaid + charge;
    // Each repayment is interest and principal in the loan's own proportion, with the last one taking what's left.
    const interestPaid = repaid >= loan.total ? loan.total - loan.amount : interestIn(loan, repaid);
    const interest = interestPaid - loan.interestPaid;
    const entries: LogEntry[] = [];
    if (day === loan.day + 1) {
      const when = loan.day === 1 ? "at the start" : `on day ${loan.day}`;
      entries.push({
        text: `You took a ${pounds(loan.amount)} bank loan ${when} at ${percent(loan.rate)} interest: ${pounds(loan.total)} to repay, ${pounds(loan.dailyRepayment)} a day for ${loan.term} days, until day ${loan.lastDay}.`,
        cashDelta: 0,
        kind: "loan",
      });
    }
    entries.push({ text: "Bank loan repayment", cashDelta: -charge, category: "debt", interest });
    if (repaid >= loan.total) {
      entries.push({
        text: `The bank loan is repaid in full: ${pounds(loan.total)}, of which ${pounds(loan.total - loan.amount)} was interest. You can take another.`,
        cashDelta: 0,
        kind: "loan",
      });
    }
    return { loan: { ...loan, repaid, interestPaid }, entries };
  }

  /** Today's repayment on the loan being repaid, for forecasts. */
  function dailyRepayment(state: GameState): number {
    const loan = state.loan;
    return loan && isOpen(loan) ? Math.min(loan.dailyRepayment, loan.total - loan.repaid) : 0;
  }

  function loanView(state: GameState): LoanView | null {
    const loan = state.loan;
    if (!loan) return null;
    if (!isOpen(loan)) return { ...loan, remaining: 0, daysLeft: 0, payoff: 0, interestSaved: 0, repaidInFull: true };
    const remaining = loan.total - loan.repaid;
    const payoff = principalLeft(loan);
    return {
      ...loan,
      remaining,
      daysLeft: Math.ceil(remaining / loan.dailyRepayment),
      payoff,
      interestSaved: remaining - payoff,
      repaidInFull: false,
    };
  }

  return { termsOn, loanQuote, startLoan, takeLoan, repayLoan, repaymentDay, dailyRepayment, loanView };
}

export type LoanModule = ReturnType<typeof createLoan>;
