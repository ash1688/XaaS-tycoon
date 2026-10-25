import { SPEND_CATEGORIES, type GameConfig, type ModelId } from "./config.ts";
import type { GameState, Loan, LogEntry, Spend } from "./state.ts";

export const noSpend = (): Spend => ({ staff: 0, infrastructure: 0, cabling: 0, power: 0, addons: 0, campaigns: 0, debt: 0 });

export const count = new Intl.NumberFormat("en-GB");

// Made once: toLocaleString with options builds a new formatter on every call, which made pounds most of the cost
// of a day's log and of a migration quote.
const wholePounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 0 });
const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2 });

export function pounds(n: number): string {
  return (Number.isInteger(n) ? wholePounds : pence).format(n);
}

/** A price after any provider price rises, to the penny. */
export const risen = (price: number, rise: number) => Math.round(price * rise * 100) / 100;

/**
 * What a model's prices are multiplied by today: any provider price rises on it, and drift's price level from the
 * years' ends so far (#95).
 */
export const priceRiseOn = (state: Pick<GameState, "priceRises" | "priceLevel">, model: ModelId) =>
  (state.priceRises[model] ?? 1) * state.priceLevel;

/**
 * The interest in bank loan repayments adding up to `repaid`. Each repayment is interest and principal in the loan's
 * own proportion, so the interest is all paid when the loan is. Nothing without a loan.
 */
export const interestIn = (loan: Pick<Loan, "amount" | "total"> | null, repaid: number) =>
  loan?.total ? Math.round((repaid * (loan.total - loan.amount)) / loan.total) : 0;

/**
 * The costs that count against profit: every charge, but only the interest in the loan repayments (debt), as
 * GameState.interestPaid. Paying back the principal returns borrowed money, so it isn't a cost, as the money borrowed
 * isn't income. Cash still falls by the whole repayment.
 */
export const profitCosts = (spend: Spend, interestPaid: number) =>
  SPEND_CATEGORIES.reduce((sum, c) => sum + spend[c], 0) - spend.debt + interestPaid;

/** Money borrowed in some entries: the bank loan coming in. Cash, but neither income nor a charge. */
const borrowedIn = (entries: LogEntry[]) =>
  entries.reduce((sum, e) => sum + (e.kind === "loan" && !e.category ? e.cashDelta : 0), 0);

/**
 * Money from funders in some entries, the rescue buyout's included, less a grant paid back or a buy-back. Cash, but
 * neither income nor a charge.
 */
const raisedIn = (entries: LogEntry[]) =>
  entries.reduce((sum, e) => sum + ((e.kind === "funding" || e.kind === "rescue") && !e.category ? e.cashDelta : 0), 0);
/** The interest in some entries' loan repayments. */
const interestOf = (entries: LogEntry[]) => entries.reduce((sum, e) => sum + (e.interest ?? 0), 0);

/**
 * What happens the first time cash runs out, given the state with the day settled: the rescue buyout, with cash back
 * above £0 and its entries.
 */
export type RescueHook = (state: GameState) => { state: GameState; entries: LogEntry[] };

/**
 * Where the customers stood at the end of a day, kept with its spend for the summary, and its hours down (the last of
 * recent uptime's) for the IPO's uptime record.
 */
const customersAt = ({ users, paidUsers, satisfaction, recentHoursDown }: GameState) => ({
  users,
  paidUsers,
  satisfaction,
  hoursDown: recentHoursDown.at(-1) ?? 0,
});

/** Finance and the ledger: where every day's entries land in cash and spend, and where a game ends. */
export function createFinance(config: GameConfig) {
  /**
   * The ledger. Applies a day's entries to cash, adds each charge to its category's running total and the day's
   * spend, and income to its own total, apart from the costs, so profit is income − profitCosts. Money borrowed or
   * raised from funders is cash but neither, kept on the day so the cash chart adds up. If cash has gone below zero,
   * the first time `rescue` rescues the company, and after that it's liquidation and the game ends. Then ends it if
   * this was the final day. Returns the entries with any notice of the rescue or end added. Liquidation on the final
   * day counts as liquidation.
   */
  function settle(
    state: GameState,
    day: number,
    entries: LogEntry[],
    rescue?: RescueHook,
  ): { state: GameState; entries: LogEntry[] } {
    const daySpend = noSpend();
    let dayIncome = 0;
    const streams = { fees: 0, transactions: 0 };
    for (const e of entries) {
      if (e.category) daySpend[e.category] -= e.cashDelta;
      else if (e.kind === "income") {
        dayIncome += e.cashDelta;
        if (e.stream) streams[e.stream] += e.cashDelta;
      }
    }
    const spend = noSpend();
    for (const c of SPEND_CATEGORIES) spend[c] = state.spend[c] + daySpend[c];
    const cash = state.cash + entries.reduce((sum, e) => sum + e.cashDelta, 0);
    let settled: GameState = {
      ...state,
      cash,
      spend,
      income: state.income + dayIncome,
      feeIncome: state.feeIncome + streams.fees,
      transactionIncome: state.transactionIncome + streams.transactions,
      interestPaid: state.interestPaid + interestOf(entries),
      spendByDay: [
        ...state.spendByDay,
        {
          day,
          ...daySpend,
          income: dayIncome,
          feeIncome: streams.fees,
          transactionIncome: streams.transactions,
          borrowed: borrowedIn(entries),
          raised: raisedIn(entries),
          interest: interestOf(entries),
          ...customersAt(state),
        },
      ],
    };
    if (cash < 0 && rescue && !state.rescue) {
      const rescued = rescue(settled);
      settled = rescued.state;
      entries = [...entries, ...rescued.entries];
    } else if (cash < 0) {
      const text = state.rescue
        ? `Cash ran out again, after the rescue buyout on day ${state.rescue.day}: ${state.companyName} goes into liquidation. Game over.`
        : `Cash ran out: ${state.companyName} goes into liquidation. Game over.`;
      return {
        state: { ...settled, status: "liquidated" },
        entries: [...entries, { text, cashDelta: 0, kind: "liquidation" }],
      };
    }
    if (state.finalDay !== null && day >= state.finalDay) {
      const text = `Day ${day} was the last: ${state.companyName} made it to the end. See how you did in the summary.`;
      return { state: { ...settled, status: "finished" }, entries: [...entries, { text, cashDelta: 0, kind: "finished" }] };
    }
    return { state: settled, entries };
  }

  /**
   * Charges (or refunds) made between days, such as buying a server, and money borrowed or raised then: applied to cash and
   * spend at once, and counted in the day just played, so the cost and cash charts still add up. Never ends the game:
   * an action that would leave cash below zero is refused before it gets here.
   */
  function chargeNow(state: GameState, entries: LogEntry[]): GameState {
    const daySpend = noSpend();
    for (const e of entries) if (e.category) daySpend[e.category] -= e.cashDelta;
    const spend = noSpend();
    for (const c of SPEND_CATEGORIES) spend[c] = state.spend[c] + daySpend[c];
    const borrowed = borrowedIn(entries);
    const raised = raisedIn(entries);
    const interest = interestOf(entries);
    const last = state.spendByDay.at(-1);
    const spendByDay =
      last?.day === state.day
        ? [
            ...state.spendByDay.slice(0, -1),
            {
              ...last,
              ...Object.fromEntries(SPEND_CATEGORIES.map((c) => [c, last[c] + daySpend[c]])),
              borrowed: last.borrowed + borrowed,
              raised: last.raised + raised,
              interest: last.interest + interest,
            },
          ]
        : [...state.spendByDay, { day: state.day, ...daySpend, income: 0, feeIncome: 0, transactionIncome: 0, borrowed, raised, interest, ...customersAt(state) }];
    const cash = state.cash + entries.reduce((sum, e) => sum + e.cashDelta, 0);
    return { ...state, cash, spend, spendByDay, interestPaid: state.interestPaid + interest };
  }

  return { settle, chargeNow };
}

export type Finance = ReturnType<typeof createFinance>;
