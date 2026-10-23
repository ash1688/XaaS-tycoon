import type { GameConfig } from "./config.ts";
import { count } from "./finance.ts";
import { staffOutput } from "./staff.ts";
import type { GameState, LogEntry } from "./state.ts";

/** Reports on user content and the moderators handling them, on a product where users post it. */
export interface ModerationView {
  /** Reports today's users would raise in a day. */
  usualReports: number;
  /** Reports raised on the day just played. */
  reportsToday: number;
  /** Reports the moderators handled on the day just played, from the backlog and today's. */
  handledToday: number;
  /** Reports still unhandled at the end of the day just played. */
  backlog: number;
  /** Reports the moderators can handle in a day: their output in mids × reports each. */
  dailyClearance: number;
  /** The satisfaction target is multiplied by this: 1 with nothing unhandled, down to 0. */
  satisfactionFactor: number;
  /** Lawsuit odds are multiplied by this: 1 with nothing unhandled, up to moderation.lawsuitOddsAtZero. */
  lawsuitOdds: number;
}

/** Whether a product's users post content: the only products with reports and moderators. */
export const hasContent = (config: GameConfig, state: Pick<GameState, "productType">) =>
  config.productTypes[state.productType].moderation !== undefined;

/** How far the unhandled reports are towards the worst, from 0 (none) to 1 (backlogPerUserAtZero per user or more). */
function backlogShare(config: GameConfig, backlog: number, users: number): number {
  if (backlog <= 0) return 0;
  if (users <= 0) return 1;
  return Math.min(1, backlog / users / config.moderation.backlogPerUserAtZero);
}

/**
 * What unhandled reports do to the odds of a lawsuit over content left up, as a multiplier: 1 with none, rising in a
 * straight line to moderation.lawsuitOddsAtZero. Always 1 on a product without user content. For the lawsuit event.
 */
export function lawsuitOdds(config: GameConfig, state: GameState): number {
  if (!hasContent(config, state)) return 1;
  return 1 + (config.moderation.lawsuitOddsAtZero - 1) * backlogShare(config, state.reportBacklog, state.users);
}

/**
 * Moderation: the reports users raise on each other's content, the moderators who handle them, and what's left
 * unhandled. Like support's tickets, but only on a product with user content, and the backlog costs satisfaction and
 * raises the odds of a lawsuit rather than setting satisfaction alone.
 */
export function createModeration(config: GameConfig) {
  /** A new company: no reports yet. */
  const startingModeration = () => ({ reportsToday: 0, reportsHandled: 0, reportBacklog: 0 });

  /** Reports today's users raise in a day: every user, paying or free, × the product's rate. None without content. */
  function usualReports(state: GameState): number {
    const moderation = config.productTypes[state.productType].moderation;
    return moderation ? Math.round(state.users * moderation.reportsPerUser) : 0;
  }

  /** Reports the moderators can handle in a day. */
  const dailyClearance = (state: GameState) => staffOutput(config, state, "moderators") * config.moderation.reportsPerPerson;

  /** The satisfaction target is multiplied by this: 1 with nothing unhandled, falling in a straight line to 0. */
  const satisfactionFactor = (backlog: number, users: number) => 1 - backlogShare(config, backlog, users);

  /**
   * A day of moderation. Reports come from the users at the start of the day; moderators handle what they can, oldest
   * first, and the rest waits. The satisfaction factor for the day's support target comes from what's left.
   */
  function moderationDay(state: GameState) {
    const reportsToday = usualReports(state);
    const open = state.reportBacklog + reportsToday;
    const reportsHandled = Math.min(open, dailyClearance(state));
    const reportBacklog = open - reportsHandled;
    const before = satisfactionFactor(state.reportBacklog, state.users);
    const factor = satisfactionFactor(reportBacklog, state.users);

    const entries: LogEntry[] = [];
    const warnAt = 1 - config.moderation.warnShare;
    if (before >= warnAt && factor < warnAt) {
      entries.push({
        text: `${count.format(reportBacklog)} reports on user content are waiting for a moderator: users are unhappy, and a lawsuit is more likely. Hire moderators.`,
        cashDelta: 0,
        kind: "support",
      });
    } else if (state.reportBacklog > 0 && reportBacklog === 0 && before < warnAt) {
      entries.push({ text: "Moderators have caught up with the reports on user content.", cashDelta: 0, kind: "support" });
    }
    return { reportsToday, reportsHandled, reportBacklog, satisfactionFactor: factor, entries };
  }

  function moderationView(state: GameState): ModerationView | null {
    if (!hasContent(config, state)) return null;
    return {
      usualReports: usualReports(state),
      reportsToday: state.reportsToday,
      handledToday: state.reportsHandled,
      backlog: state.reportBacklog,
      dailyClearance: dailyClearance(state),
      satisfactionFactor: satisfactionFactor(state.reportBacklog, state.users),
      lawsuitOdds: lawsuitOdds(config, state),
    };
  }

  return { startingModeration, usualReports, dailyClearance, moderationDay, moderationView };
}
