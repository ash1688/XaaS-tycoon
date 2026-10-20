import { SPEND_CATEGORIES, type GameConfig } from "./config.ts";
import type { GameState, LogEntry, Spend } from "./state.ts";

export const noSpend = (): Spend => ({ staff: 0, infrastructure: 0, addons: 0, debt: 0 });

export const count = new Intl.NumberFormat("en-GB");

export function pounds(n: number): string {
  const digits = Number.isInteger(n) ? 0 : 2;
  return n.toLocaleString("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: digits });
}

/** A price after any provider price rises, to the penny. */
export const risen = (price: number, rise: number) => Math.round(price * rise * 100) / 100;

/** Money borrowed in some entries: the bank loan coming in. Cash, but neither income nor a charge. */
const borrowedIn = (entries: LogEntry[]) =>
  entries.reduce((sum, e) => sum + (e.kind === "loan" && !e.category ? e.cashDelta : 0), 0);

/** Where the customers stood at the end of a day, kept with its spend for the summary. */
const customersAt = ({ users, paidUsers, satisfaction }: GameState) => ({ users, paidUsers, satisfaction });

/** Finance and the ledger: where every day's entries land in cash and spend, and where a game ends. */
export function createFinance(config: GameConfig) {
  /**
   * The ledger. Applies a day's entries to cash, adds each charge to its category's running total and the day's
   * spend, and income to its own total, apart from the costs, so profit is income − spend. Money borrowed is cash but
   * neither, kept on the day so the cash chart adds up. Then ends the game if cash has gone below zero or this was the
   * final day. Returns the entries with any notice of the end added. Going bankrupt on the final day counts as
   * bankrupt.
   */
  function settle(state: GameState, day: number, entries: LogEntry[]): { state: GameState; entries: LogEntry[] } {
    const daySpend = noSpend();
    let dayIncome = 0;
    for (const e of entries) {
      if (e.category) daySpend[e.category] -= e.cashDelta;
      else if (e.kind === "income") dayIncome += e.cashDelta;
    }
    const spend = noSpend();
    for (const c of SPEND_CATEGORIES) spend[c] = state.spend[c] + daySpend[c];
    const cash = state.cash + entries.reduce((sum, e) => sum + e.cashDelta, 0);
    const settled: GameState = {
      ...state,
      cash,
      spend,
      income: state.income + dayIncome,
      spendByDay: [
        ...state.spendByDay,
        { day, ...daySpend, income: dayIncome, borrowed: borrowedIn(entries), ...customersAt(state) },
      ],
    };
    if (cash < 0) {
      return {
        state: { ...settled, status: "bankrupt" },
        entries: [
          ...entries,
          { text: `Cash ran out: ${state.companyName} is bankrupt. Game over.`, cashDelta: 0, kind: "bankrupt" },
        ],
      };
    }
    if (day >= config.finalDay) {
      const text = `Day ${day} was the last: ${state.companyName} made it to the end. See how you did in the summary.`;
      return { state: { ...settled, status: "finished" }, entries: [...entries, { text, cashDelta: 0, kind: "finished" }] };
    }
    return { state: settled, entries };
  }

  /**
   * Charges (or refunds) made between days, such as buying a server, and money borrowed then: applied to cash and
   * spend at once, and counted in the day just played, so the cost and cash charts still add up. Never ends the game:
   * an action that would leave cash below zero is refused before it gets here.
   */
  function chargeNow(state: GameState, entries: LogEntry[]): GameState {
    const daySpend = noSpend();
    for (const e of entries) if (e.category) daySpend[e.category] -= e.cashDelta;
    const spend = noSpend();
    for (const c of SPEND_CATEGORIES) spend[c] = state.spend[c] + daySpend[c];
    const borrowed = borrowedIn(entries);
    const last = state.spendByDay.at(-1);
    const spendByDay =
      last?.day === state.day
        ? [
            ...state.spendByDay.slice(0, -1),
            {
              ...last,
              ...Object.fromEntries(SPEND_CATEGORIES.map((c) => [c, last[c] + daySpend[c]])),
              borrowed: last.borrowed + borrowed,
            },
          ]
        : [...state.spendByDay, { day: state.day, ...daySpend, income: 0, borrowed, ...customersAt(state) }];
    return { ...state, cash: state.cash + entries.reduce((sum, e) => sum + e.cashDelta, 0), spend, spendByDay };
  }

  return { settle, chargeNow };
}

export type Finance = ReturnType<typeof createFinance>;
