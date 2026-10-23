import { STAFF_POOLS, type GameConfig, type StaffGrade, type StaffPool } from "./config.ts";
import { count, pounds, type Finance, type RescueHook } from "./finance.ts";
import type { Shares } from "./shares.ts";
import { dailyStaffCost, headcount, severanceFor, staffOutput } from "./staff.ts";
import { SimError, type GameState, type GradeCounts, type LogEntry, type Rescue, type StaffCut } from "./state.ts";

/** The rescue buyout once it has happened, with the vulture VC's stake now and its price to sell it back. */
export interface RescueView extends Rescue {
  /** The vulture VC's shares now, and its share of the company, 0–1: none once bought back. */
  vultureShares: number;
  vultureShare: number;
  /** What it asks for all its shares today: null once they've been bought back. */
  buyBackPrice: number | null;
  /** How the price is set, in words. */
  priceDetail: string;
  /** Whether the company has the cash to buy them back today. */
  canBuyBack: boolean;
}

/** What a usual day does to cash: what the rescue's breathing space is worked out from. */
interface UsualDay {
  dailyCosts: number;
  dailyNet: number;
}

// The dearest first: a vulture VC cuts where it saves most.
const CUT_ORDER: StaffGrade[] = ["senior", "mid", "junior"];
const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;

/**
 * The rescue buyout: the first time cash runs out a vulture VC puts in cash for new shares and forces cost cuts, and
 * the student can later buy its shares back at its price. See RescueConfig. Running out again is liquidation, which
 * the ledger handles.
 */
export function createRescue(
  config: GameConfig,
  finance: Finance,
  shares: Shares,
  usualDay: (state: GameState) => UsualDay,
  opsNeeded: (state: GameState) => number,
) {
  const r = config.rescue;
  /** "2 senior developers", "1 agency mid ops person". */
  const people = ({ pool, grade, count: n, agency }: StaffCut) =>
    `${n} ${agency ? "agency " : ""}${config.staffGrades[grade].name.toLowerCase()} ${n === 1 ? config.staff[pool].personName : config.staff[pool].name.toLowerCase()}`;
  const copy = (counts: Record<StaffPool, GradeCounts>) =>
    Object.fromEntries(STAFF_POOLS.map((p) => [p, { ...counts[p] }])) as Record<StaffPool, GradeCounts>;

  /**
   * The forced cost cuts: hires still to start cancelled, and staffCut of each team let go, to the nearest person:
   * agency staff first, as they go with no severance, then permanent staff, the dearest grades first, paid their
   * severance. Ops are only let go while those left still cover the ops the servers need.
   */
  function cutCosts(state: GameState): { state: GameState; cuts: StaffCut[]; hiresCancelled: number; severance: number } {
    const counts = { staff: copy(state.staff), agency: copy(state.agency) };
    const needed = opsNeeded(state);
    const cuts: StaffCut[] = [];
    let severance = 0;
    for (const pool of STAFF_POOLS) {
      let left = Math.round((headcount(state, pool) + headcount(state, pool, true)) * r.staffCut);
      for (const agency of [true, false]) {
        const team = agency ? counts.agency : counts.staff;
        for (const grade of CUT_ORDER) {
          let n = 0;
          while (left > 0 && team[pool][grade] > 0) {
            if (pool === "ops") {
              team.ops[grade]--;
              const short = staffOutput(config, { ...state, ...counts }, "ops") < needed;
              team.ops[grade]++;
              if (short) break;
            }
            team[pool][grade]--;
            left--;
            n++;
          }
          if (n) cuts.push({ pool, grade, count: n, agency });
          if (n && !agency) severance += n * severanceFor(config, pool, grade);
        }
      }
    }
    const hiresCancelled = state.hiring.reduce((sum, h) => sum + h.count, 0);
    return { state: { ...state, ...counts, hiring: [] }, cuts, hiresCancelled, severance };
  }

  /** The rescue buyout, on the day cash first went below £0: cuts, then cash for new shares. */
  const rescue: RescueHook = (state) => {
    const cut = cutCosts(state);
    const savedPerDay = dailyStaffCost(config, state) - dailyStaffCost(config, cut.state);
    const day = usualDay(cut.state);
    const losses = -state.cash;
    const cover = Math.max(-day.dailyNet, r.minCover * day.dailyCosts);
    // It pays the severance of the permanent staff it lets go, on top of the losses.
    const amount = Math.ceil((losses + cut.severance + r.breathingDays * cover) / 100) * 100;
    const inIssue = state.shareholders.reduce((sum, h) => sum + h.shares, 0);
    const newShares = Math.round((inIssue * r.share) / (1 - r.share));
    const share = newShares / (inIssue + newShares);
    const yours = (state.shareholders.find((h) => h.id === "student")?.shares ?? 0) / (inIssue + newShares);
    const cutWords = [
      ...cut.cuts.map((c) => `let go ${people(c)}`),
      ...(cut.hiresCancelled ? [`cancelled ${cut.hiresCancelled} hire${cut.hiresCancelled === 1 ? "" : "s"} still to start`] : []),
    ];
    const entries: LogEntry[] = [
      {
        text: `Cash ran out, and a vulture VC rescued ${state.companyName}: it put in ${pounds(amount)} (${pounds(losses)} to cover the losses${cut.severance ? `, ${pounds(cut.severance)} for severance` : ""} and about ${r.breathingDays} days of breathing space) for ${count.format(newShares)} new shares, ${percent(share)} of the company. You now own ${percent(yours)}. Run out of cash again and it's liquidation.`,
        cashDelta: amount,
        kind: "rescue",
      },
      {
        text: cutWords.length
          ? `Forced cost cuts: the vulture VC ${cutWords.join(", ")}${savedPerDay ? `, saving ${pounds(savedPerDay)} a day` : ""}.`
          : "Forced cost cuts: the team is already as lean as the vulture VC will go.",
        cashDelta: 0,
        kind: "rescue",
      },
      ...(cut.severance
        ? [{ text: "Severance for the permanent staff let go in the cuts", cashDelta: -cut.severance, category: "staff" as const }]
        : []),
    ];
    const record: Rescue = {
      day: state.day,
      amount,
      losses,
      shares: newShares,
      share,
      cuts: cut.cuts,
      hiresCancelled: cut.hiresCancelled,
      savedPerDay,
      severance: cut.severance,
      boughtBack: null,
    };
    return {
      state: {
        ...finance.chargeNow(cut.state, entries),
        shareholders: [...state.shareholders, { id: "vulture", shares: newShares, day: state.day }],
        rescue: record,
      },
      entries,
    };
  };

  /**
   * The vulture VC's price for all its shares: their part of the business's value today × the premium, but at least
   * minReturn × the cash it put in. The business's value is the valuation's drivers but net cash and the minimum: the
   * company buys them with its cash, so counting it would put the price out of reach whatever it had.
   */
  function buyBackPrice(state: GameState, vultureShares: number): { price: number; detail: string } {
    const { sharesInIssue, drivers } = shares.valuation(state);
    const business = drivers.reduce((sum, d) => sum + (d.id === "netCash" || d.id === "minimum" ? 0 : d.amount), 0);
    const worth = (Math.max(0, business) * vultureShares) / sharesInIssue;
    const floor = r.minReturn * (state.rescue?.amount ?? 0);
    const price = Math.ceil(Math.max(worth * r.buyBackPremium, floor) / 100) * 100;
    const detail =
      worth * r.buyBackPremium >= floor
        ? `${r.buyBackPremium}× its ${percent(vultureShares / sharesInIssue)} of the business, worth ${pounds(Math.round(worth))} at today's valuation leaving out the cash`
        : `${r.minReturn}× the ${pounds(state.rescue?.amount ?? 0)} it put in: it never sells back for less`;
    return { price, detail };
  }

  function rescueView(state: GameState): RescueView | null {
    if (!state.rescue) return null;
    const vultureShares = state.shareholders.find((h) => h.id === "vulture")?.shares ?? 0;
    const inIssue = state.shareholders.reduce((sum, h) => sum + h.shares, 0);
    const quote = vultureShares && state.status === "playing" ? buyBackPrice(state, vultureShares) : null;
    return {
      ...state.rescue,
      vultureShares,
      vultureShare: vultureShares / inIssue,
      buyBackPrice: quote?.price ?? null,
      priceDetail: quote?.detail ?? "",
      canBuyBack: quote !== null && state.cash >= quote.price,
    };
  }

  /** Buys all the vulture VC's shares back at its price, from the company's cash, at once. */
  function buyBack(state: GameState): GameState {
    const vulture = state.shareholders.find((h) => h.id === "vulture");
    if (!state.rescue) throw new SimError("no_rescue", "There's no vulture VC to buy shares back from: the company hasn't been rescued.");
    if (!vulture) {
      throw new SimError("bought_back", `You already bought the vulture VC's shares back, on day ${state.rescue.boughtBack?.day}.`);
    }
    const { price } = buyBackPrice(state, vulture.shares);
    if (state.cash < price) {
      throw new SimError(
        "cant_afford",
        `The vulture VC wants ${pounds(price)} for its shares, and you have ${pounds(state.cash)}.`,
        { cost: price, cash: state.cash },
      );
    }
    const shareholders = state.shareholders.filter((h) => h.id !== "vulture");
    const left = shareholders.reduce((sum, h) => sum + h.shares, 0);
    const yours = (shareholders.find((h) => h.id === "student")?.shares ?? 0) / left;
    const entry: LogEntry = {
      text: `You bought the vulture VC's ${count.format(vulture.shares)} shares back for ${pounds(price)}. You now own ${percent(yours)}.`,
      cashDelta: -price,
      kind: "funding",
    };
    return {
      ...finance.chargeNow(state, [entry]),
      shareholders,
      rescue: { ...state.rescue, boughtBack: { day: state.day, price } },
    };
  }

  return { rescue, rescueView, buyBack };
}
