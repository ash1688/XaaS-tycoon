import type { GameConfig } from "./config.ts";
import { loanRateShare } from "./executives.ts";
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
const capital = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** Whether a loan is still being repaid. */
export const isOpen = (loan: Loan | null): boolean => !!loan && loan.paidOffDay === null && loan.repaid < loan.total;

/** The money borrowed on a loan not yet paid back: what paying it off costs. */
const principalLeft = (loan: Loan) => loan.amount - (loan.repaid - loan.interestPaid);

/** The money borrowed still to pay back on a loan: what paying it off would cost. 0 with none being repaid. */
export const loanOwed = (loan: Loan | null): number => (loan && isOpen(loan) ? principalLeft(loan) : 0);

/**
 * Of the money still to pay back on a loan, what shortfalls put there: what counts against how far cash can fall
 * before it has run out. Paid back last, so it only falls once the rest is repaid.
 */
export const shortfallOwed = (loan: Loan | null): number => Math.min(loan?.shortfall ?? 0, loanOwed(loan));

/** "emergency loan" or "bank loan": what the log calls it. */
export const loanName = (loan: Loan) => (loan.emergency ? "emergency loan" : "bank loan");

/** How far shortfalls can take cash below £0 before it has run out, and how much of that is left. */
export interface ShortfallView {
  /** Days of daily costs: the limit is this × the daily costs. */
  limitDays: number;
  limit: number;
  /** What shortfalls have put on the loan and is still owed. */
  owed: number;
  /** How much further below £0 cash can go before the vulture VC steps in (or, after a rescue, liquidation). */
  room: number;
}

/**
 * Bank loans: one at a time, taken at the start or later, each repaid daily (debt) over its fixed term whatever
 * happens, or paid off early to save the interest still to come. Once one's repaid, another can be taken.
 */
export function createLoan(config: GameConfig, finance: Finance, dailyCosts: (state: GameState) => number) {
  const { amount, baseRate, ratePerDay, termDays, termPerDay, minTermDays, minDays, emergencyTermDays } = config.loan;

  /**
   * The terms for a loan taken on a day (between days, so repaid from the next one), whether or not it can be. A CFO
   * gets the rate down by their cut: rateShare is what's left of it.
   */
  function termsOn(day: number, rateShare = 1): LoanQuote {
    const rate = Math.round((baseRate + ratePerDay * (day - 1)) * rateShare * 1e6) / 1e6;
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
        `You're still repaying your ${loanName(state.loan!)}. Pay it off first: the bank only lends one at a time.`,
      );
    }
    // A term can run past the final day, but the bank won't lend in a game's last days. Until IPO has none.
    if (state.finalDay === null) return null;
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
    return refusal(state) ? null : termsOn(state.day, loanRateShare(config, state));
  }

  /** A new loan taken today, with any repaid one kept for the summary. */
  function withNewLoan(state: GameState): GameState {
    const { rate, days, lastDay, dailyRepayment, total } = termsOn(state.day, loanRateShare(config, state));
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
    const name = loanName(loan);
    const entries: LogEntry[] = [
      { text: `${capital(name)} paid off early`, cashDelta: -payoff, category: "debt", interest: 0 },
      {
        text: `The ${name} is repaid in full, early: ${pounds(loan.repaid + payoff)}, of which ${pounds(loan.interestPaid)} was interest. Paying it off saved ${pounds(saved)} of interest.`,
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
    // A shortfall added to the loan shifts its share of interest a little: what's paid never goes back down.
    const interestPaid = repaid >= loan.total ? loan.total - loan.amount : Math.max(loan.interestPaid, interestIn(loan, repaid));
    const interest = interestPaid - loan.interestPaid;
    const name = loanName(loan);
    const entries: LogEntry[] = [];
    if (day === loan.day + 1 && !loan.emergency) {
      const when = loan.day === 1 ? "at the start" : `on day ${loan.day}`;
      entries.push({
        text: `You took a ${pounds(loan.amount)} bank loan ${when} at ${percent(loan.rate)} interest: ${pounds(loan.total)} to repay, ${pounds(loan.dailyRepayment)} a day for ${loan.term} days, until day ${loan.lastDay}.`,
        cashDelta: 0,
        kind: "loan",
      });
    }
    entries.push({ text: `${capital(name)} repayment`, cashDelta: -charge, category: "debt", interest });
    if (repaid >= loan.total) {
      entries.push({
        text: `The ${name} is repaid in full: ${pounds(loan.total)}, of which ${pounds(loan.total - loan.amount)} was interest. You can take another.`,
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

  /** How far shortfalls can take cash below £0 before it has run out: limitDays of today's daily costs. */
  function shortfallView(state: GameState): ShortfallView {
    const { limitDays } = config.rescue;
    const limit = Math.round(limitDays * dailyCosts(state));
    const owed = shortfallOwed(state.loan);
    return { limitDays, limit, owed, room: Math.max(0, limit - owed) };
  }

  /**
   * After a day that left cash below £0: the shortfall goes onto the loan being repaid, its daily repayment the same
   * so its term grows, or with none an emergency loan opens for it, at the rate a loan taken today would have over
   * emergencyTermDays. Either way cash is back to £0. Null when it would take what shortfalls owe past the limit: cash
   * has run out, and it's the vulture VC's rescue (or liquidation).
   */
  function coverShortfall(state: GameState): { state: GameState; entries: LogEntry[] } | null {
    const shortfall = -state.cash;
    const view = shortfallView(state);
    if (shortfall <= 0 || shortfall > view.room) return null;
    const open = state.loan && isOpen(state.loan) ? state.loan : null;
    let loan: Loan;
    let text: string;
    if (open) {
      // The shortfall is borrowed at the loan's own rate, repaid at the same amount a day for longer.
      const total = open.total + Math.ceil(shortfall * (1 + open.rate) - 1e-9);
      const lastDay = open.day + Math.ceil(total / open.dailyRepayment - 1e-9);
      loan = { ...open, amount: open.amount + shortfall, total, lastDay, term: lastDay - open.day, shortfall: (open.shortfall ?? 0) + shortfall };
      text = `Cash went ${pounds(shortfall)} below £0: the shortfall went on your ${loanName(open)}, still ${pounds(loan.dailyRepayment)} a day, now until day ${lastDay}.`;
    } else {
      const { rate } = termsOn(state.day, loanRateShare(config, state));
      const days = Math.max(1, Math.round(emergencyTermDays));
      const dailyRepayment = Math.ceil((shortfall * (1 + rate)) / days - 1e-9);
      loan = {
        amount: shortfall,
        day: state.day,
        rate,
        term: days,
        lastDay: state.day + days,
        dailyRepayment,
        total: dailyRepayment * days,
        repaid: 0,
        interestPaid: 0,
        paidOffDay: null,
        emergency: true,
        shortfall,
      };
      text = `Cash went ${pounds(shortfall)} below £0 with no bank loan, so the bank opened an emergency loan for it at ${percent(rate)}: ${pounds(dailyRepayment)} a day for ${days} days, until day ${loan.lastDay}.`;
    }
    const pastLoans = state.loan && !open ? [...state.pastLoans, state.loan] : state.pastLoans;
    // How far it can go now, with the loan's repayment counted in the daily costs.
    const after = shortfallView({ ...state, loan, pastLoans });
    const next = state.rescue ? "the company goes into liquidation" : "a vulture VC steps in to rescue the company, for most of it";
    const entries: LogEntry[] = [
      {
        text: `${text} Shortfalls can go ${pounds(after.room)} further (${after.limitDays} days of costs, ${pounds(after.limit)} in all) before ${next}.`,
        cashDelta: shortfall,
        kind: "loan",
      },
    ];
    const covered = finance.chargeNow({ ...state, loan, pastLoans }, entries);
    return { state: { ...covered, firstShortfallDay: state.firstShortfallDay ?? state.day }, entries };
  }

  /**
   * As the game ends: whatever is still owed on the loan is paid off from cash, the interest still to come waived, so
   * the final figures are net of it. This settles a loan whose term runs past the last day.
   */
  function settleAtEnd(state: GameState): { state: GameState; entries: LogEntry[] } {
    const loan = state.loan;
    if (!loan || !isOpen(loan)) return { state, entries: [] };
    const payoff = principalLeft(loan);
    const entries: LogEntry[] = [
      { text: `The game is over: the ${pounds(payoff)} still owed on your ${loanName(loan)} comes off your cash`, cashDelta: -payoff, category: "debt", interest: 0 },
    ];
    const settled: Loan = { ...loan, repaid: loan.repaid + payoff, paidOffDay: state.day, settledAtEnd: payoff };
    return { state: finance.chargeNow({ ...state, loan: settled }, entries), entries };
  }

  return {
    termsOn,
    loanQuote,
    startLoan,
    takeLoan,
    repayLoan,
    repaymentDay,
    dailyRepayment,
    loanView,
    shortfallView,
    coverShortfall,
    settleAtEnd,
  };
}

export type LoanModule = ReturnType<typeof createLoan>;
