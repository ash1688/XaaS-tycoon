import { SPEND_CATEGORIES, type GameConfig } from "./config.ts";
import type { GameState, LogEntry, Spend } from "./state.ts";

export const noSpend = (): Spend => ({ staff: 0, infrastructure: 0, addons: 0 });

export const count = new Intl.NumberFormat("en-GB");

export function pounds(n: number): string {
  const digits = Number.isInteger(n) ? 0 : 2;
  return n.toLocaleString("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: digits });
}

/** A price after any provider price rises, to the penny. */
export const risen = (price: number, rise: number) => Math.round(price * rise * 100) / 100;

/** Finance and the ledger: where every day's entries land in cash and spend, and where a game ends. */
export function createFinance(config: GameConfig) {
  /**
   * The ledger. Applies a day's entries to cash, adds each charge to its category's running total and the day's
   * spend, and ends the game if cash has gone below zero or this was the final day. Returns the entries with any
   * notice of the end added. Going bankrupt on the final day counts as bankrupt.
   */
  function settle(state: GameState, day: number, entries: LogEntry[]): { state: GameState; entries: LogEntry[] } {
    const daySpend = noSpend();
    for (const e of entries) if (e.category) daySpend[e.category] -= e.cashDelta;
    const spend = noSpend();
    for (const c of SPEND_CATEGORIES) spend[c] = state.spend[c] + daySpend[c];
    const cash = state.cash + entries.reduce((sum, e) => sum + e.cashDelta, 0);
    const settled: GameState = { ...state, cash, spend, spendByDay: [...state.spendByDay, { day, ...daySpend }] };
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

  return { settle };
}
