import type { GameConfig } from "./config.ts";
import { count } from "./finance.ts";
import type { GameState, LogEntry } from "./state.ts";

/**
 * Extra tickets on top of the day's usual ones, with what caused them. Outages add one; price backlash (#46) adds its
 * own through the same list.
 */
export interface TicketBurst {
  /** What caused it, to finish "Ticket burst: 200 extra tickets after …". */
  cause: string;
  tickets: number;
}

/**
 * Customer care: the tickets users raise, the support staff who clear them, the backlog left over and the
 * satisfaction it sets. The company's job on every model: on SaaS the provider fixes the platform, but your customers
 * are still yours to answer.
 */
export function createSupport(config: GameConfig) {
  /** A new company: no tickets yet, and happy customers. */
  const startingSupport = () => ({ ticketsToday: 0, burstTickets: 0, clearedToday: 0, backlog: 0, satisfaction: 100 });

  /** Tickets the day's users raise before any burst: paid users × their rate plus free users × theirs. */
  function usualTickets(state: GameState): number {
    const { ticketsPerPaidUser, ticketsPerFreeUser } = config.productTypes[state.productType].support;
    return Math.round(state.paidUsers * ticketsPerPaidUser + (state.users - state.paidUsers) * ticketsPerFreeUser);
  }

  /** The burst from a day's downtime, of any kind: every user raises more tickets for each hour down. */
  function outageBursts(state: GameState, hoursDown: number): TicketBurst[] {
    const tickets = Math.round(state.users * config.support.ticketsPerUserPerHourDown * hoursDown);
    return tickets > 0 ? [{ cause: `${hoursDown} hour${hoursDown === 1 ? "" : "s"} down`, tickets }] : [];
  }

  /** Tickets the support staff can clear in a day. */
  const dailyClearance = (state: GameState) => state.support * config.support.ticketsPerPerson;

  /** Where satisfaction is heading: 100% with no backlog, down to 0% at backlogPerUserAtZero tickets per user. */
  function satisfactionTarget(backlog: number, users: number): number {
    if (backlog <= 0) return 100;
    if (users <= 0) return 0;
    return Math.max(0, 100 * (1 - backlog / users / config.support.backlogPerUserAtZero));
  }

  /** How far satisfaction is below good, from 0 (good or better) to 1 (0%). */
  const shortfall = (state: GameState) =>
    Math.max(0, 1 - state.satisfaction / config.support.goodSatisfaction);

  /** The day's growth is multiplied by this: 1 while satisfaction is good, down to growthAtZero at 0%. */
  const satisfactionGrowth = (state: GameState) => 1 - (1 - config.support.growthAtZero) * shortfall(state);

  /** Share of users who leave in a day because of low satisfaction: none while it's good, churnAtZero at 0%. */
  const satisfactionChurn = (state: GameState) => config.support.churnAtZero * shortfall(state);

  /** A log line for each threshold satisfaction crossed today, either way. */
  function thresholdEntries(before: number, after: number): LogEntry[] {
    const { goodSatisfaction: good, poorSatisfaction: poor } = config.support;
    const entries: LogEntry[] = [];
    const crossed = (t: number) => (before >= t && after < t ? "down" : before < t && after >= t ? "up" : null);
    if (crossed(good) === "down") {
      entries.push({
        text: `Customer satisfaction fell below ${good}%: tickets are waiting too long. Growth slows and more users leave.`,
        cashDelta: 0,
        kind: "support",
      });
    }
    if (crossed(poor) === "down") {
      entries.push({
        text: `Customer satisfaction fell below ${poor}%: customers are angry about unanswered tickets. Hire support to clear the backlog.`,
        cashDelta: 0,
        kind: "support",
      });
    }
    if (crossed(poor) === "up") {
      entries.push({ text: `Customer satisfaction is back above ${poor}%.`, cashDelta: 0, kind: "support" });
    }
    if (crossed(good) === "up") {
      entries.push({
        text: `Customer satisfaction is back above ${good}%: customers are happy again.`,
        cashDelta: 0,
        kind: "support",
      });
    }
    return entries;
  }

  /**
   * A day of support. Tickets come from the users at the start of the day plus any bursts; support clears what it
   * can, oldest first, and the rest is the backlog. Satisfaction then moves part of the way towards its target, so it
   * falls while the backlog grows and recovers once it's cleared.
   */
  function supportDay(state: GameState, bursts: TicketBurst[]) {
    const usual = usualTickets(state);
    const burstTickets = bursts.reduce((sum, b) => sum + b.tickets, 0);
    const ticketsToday = usual + burstTickets;
    const open = state.backlog + ticketsToday;
    const clearedToday = Math.min(open, dailyClearance(state));
    const backlog = open - clearedToday;
    const target = satisfactionTarget(backlog, state.users);
    const satisfaction = state.satisfaction + (target - state.satisfaction) * config.support.satisfactionSpeed;

    const entries: LogEntry[] = [];
    for (const b of bursts) {
      if (b.tickets > 0 && b.tickets >= usual * config.support.bigBurstShare) {
        entries.push({
          text: `Ticket burst: ${count.format(b.tickets)} extra tickets after ${b.cause}. ${count.format(backlog)} still waiting.`,
          cashDelta: 0,
          kind: "support",
        });
      }
    }
    entries.push(...thresholdEntries(state.satisfaction, satisfaction));
    return { ticketsToday, burstTickets, clearedToday, backlog, satisfaction, entries };
  }

  return {
    startingSupport,
    usualTickets,
    outageBursts,
    dailyClearance,
    satisfactionGrowth,
    satisfactionChurn,
    supportDay,
  };
}

export type Support = ReturnType<typeof createSupport>;
