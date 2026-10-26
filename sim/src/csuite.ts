import { CSUITE_ROLES, type CsuiteRole, type GameConfig } from "./config.ts";
import { effectAt, executiveIn, withinRange } from "./executives.ts";
import { count, pounds } from "./finance.ts";
import { seriesApproachDay } from "./investors.ts";
import { peopleLeadFor } from "./peopleLead.ts";
import { nextRandom, seedRng } from "./rng.ts";
import { isCsuiteRole, SimError, type Candidate, type Csuite, type Executive, type GameState, type LogEntry } from "./state.ts";

/**
 * When each role opens. Like the angel, a round opens its roles when it approaches, whether the student takes its money
 * or not.
 */
export type CsuiteStage = "start" | "outsideMoney" | "angel" | "seriesA";

const STAGES: Record<CsuiteRole, CsuiteStage> = {
  headOfDevelopment: "start",
  headOfOps: "start",
  headOfSupport: "start",
  cfo: "outsideMoney",
  cto: "angel",
  headOfPeople: "angel",
  cmo: "seriesA",
  coo: "seriesA",
  cio: "seriesA",
  ciso: "seriesA",
  legalCounsel: "seriesA",
};

/** The roles a company must have filled to float. */
export const IPO_ROLES = ["cfo", "ciso", "legalCounsel"] as const satisfies readonly CsuiteRole[];

const STAGE_TEXT: Record<CsuiteStage, string> = {
  start: "Open from the start.",
  outsideMoney:
    "Opens once you take outside money (friends and family, the grant or an investor; the bank loan doesn't count), or when your first angel investor approaches.",
  angel: "Opens when your first angel investor approaches.",
  seriesA: "Opens when Series A venture capitalists approach.",
};

/** What each role does, in a sentence, whoever fills it. */
const ROLE_BLURBS: Record<CsuiteRole, string> = {
  headOfDevelopment: "More developer output on all developer work: the MVP, features and optimisation.",
  headOfOps: "Ops staff cover more servers, and outages are shorter.",
  headOfSupport: "Support staff clear more tickets, and satisfaction recovers faster.",
  cfo: "Better rolls when negotiating with investors and funders, and cheaper bank loans. Required to IPO. No part in pay reviews.",
  cto: "Opens tier 2 straight away, and researchers earn more research points.",
  headOfPeople: "Pay reviews only: a better roll, a softer walk-away figure, schemes valued fully and a slight tribunal lean.",
  cmo: "Campaigns bring more users for each pound.",
  coo: "Cheaper everyday running costs: hosting, rent, power and provider fees, not staff pay.",
  cio: "Migrations are cheaper and quicker.",
  ciso: "Patching needs fewer ops, and a security breach is less likely. Required to IPO: the market wants to see you take cybersecurity seriously.",
  legalCounsel: "No effect on the business: a compliance box to tick. Required to IPO.",
};

const FIRST_NAMES = [
  "Amara", "Ben", "Chloe", "Dev", "Elena", "Femi", "Grace", "Hamza", "Isla", "Jonah", "Kiran", "Leah", "Marcus", "Nadia",
  "Owen", "Priya", "Quinn", "Rosa", "Sami", "Tess", "Usman", "Vera", "Wes", "Yasmin", "Zach", "Aisha", "Callum", "Darcy",
  "Ewan", "Farah", "Gus", "Hana", "Ivan", "Jade", "Kofi", "Lina",
];
const SURNAMES = [
  "Adeyemi", "Barnes", "Chen", "Doyle", "Evans", "Fraser", "Gill", "Hughes", "Iqbal", "Jones", "Khan", "Lowe", "Mensah",
  "Novak", "O'Brien", "Patel", "Reid", "Singh", "Turner", "Usher", "Vance", "Walsh", "Young", "Zhou", "Ahmed", "Byrne",
  "Clarke", "Dunn", "Ellis", "Foster", "Grant", "Hart",
];

/** Strength rounded to the hundredth, so state stays tidy. */
const tidy = (n: number) => Math.round(n * 100) / 100;
const percent = (n: number) => `${Math.round(n * 1000) / 10}%`;
const wholePercent = (n: number) => `${Math.round(n * 100)}%`;

/** One effect of a candidate or an executive, with what it does in words. */
export interface ExecutiveEffectView {
  key: string;
  value: number;
  text: string;
}

/** A candidate on a shortlist, with their effects and what hiring them now would cost. */
export interface CandidateView {
  id: string;
  name: string;
  /** 0 to 1: where their effects sit in the role's ranges. */
  strength: number;
  /** Pay a day. */
  salary: number;
  /** The equity they'd take if hired now, after the cap shrinks their ask (0.01 = 1%), and the new shares it takes. */
  equity: number;
  newShares: number;
  /** Their ask with the cap empty. */
  baseEquity: number;
  effects: ExecutiveEffectView[];
}

export interface ExecutiveView {
  name: string;
  strength: number;
  salary: number;
  equity: number;
  shares: number;
  day: number;
  effects: ExecutiveEffectView[];
}

export interface CsuiteRoleView {
  role: CsuiteRole;
  name: string;
  /** What the role does, whoever fills it. */
  blurb: string;
  /** Whether a company needs it filled to float. */
  requiredToIpo: boolean;
  /** Whether it's open for hiring (or already filled), the day it opened, and when it opens in words. */
  open: boolean;
  openDay: number | null;
  opens: string;
  /** Who fills it, hired for good, or null. */
  executive: ExecutiveView | null;
  /** The candidates to pick from while it's open and unfilled; empty otherwise. */
  shortlist: CandidateView[];
}

/** The C-suite for the C-suite page: every role, and the equity cap. */
export interface CsuiteView {
  roles: CsuiteRoleView[];
  /** The most the C-suite's equity can come to, what it has taken and what's left (0.1 = 10%). */
  equityCap: number;
  equityUsed: number;
  equityLeft: number;
  /** What the executives hired cost a day. */
  dailyPay: number;
}

/** The C-suite's shortlists for a new game: each role's candidates drawn from their ranges on the game's seed. */
export function startingCsuite(config: GameConfig, seed: number): Csuite {
  let rng = seedRng(seed ^ 0xc5e0);
  const draw = () => {
    const [r, next] = nextRandom(rng);
    rng = next;
    return r;
  };
  const { shortlistSize, payLuck } = config.csuite;
  const used = new Set<string>();
  const name = () => {
    for (let tries = 0; ; tries++) {
      const full = `${FIRST_NAMES[Math.floor(draw() * FIRST_NAMES.length)]} ${SURNAMES[Math.floor(draw() * SURNAMES.length)]}`;
      if (!used.has(full) || tries > 50) {
        used.add(full);
        return full;
      }
    }
  };
  const shortlists = Object.fromEntries(
    CSUITE_ROLES.map((role) => {
      const { salary, equity } = config.csuite.roles[role];
      // One candidate from each band of strength, so a shortlist always has a strong one and a cheap one.
      const bands = Array.from({ length: shortlistSize }, (_, i) => i);
      for (let i = bands.length - 1; i > 0; i--) {
        const j = Math.floor(draw() * (i + 1));
        [bands[i], bands[j]] = [bands[j]!, bands[i]!];
      }
      const list = bands.map((band, i): Candidate => {
        const strength = tidy((band + draw()) / shortlistSize);
        // Pay follows strength, with some luck: a strong candidate usually costs more.
        const paid = (luck: number) => (1 - payLuck) * strength + payLuck * luck;
        return {
          id: `${role}-${i + 1}`,
          name: name(),
          strength,
          salary: Math.round(withinRange(salary, paid(draw())) / 5) * 5,
          equity: Math.round(withinRange(equity, paid(draw())) * 10_000) / 10_000,
        };
      });
      return [role, list];
    }),
  ) as Record<CsuiteRole, Candidate[]>;
  return { shortlists, hired: [] };
}

/**
 * The C-suite: roles opening as the company grows, shortlists, hiring for good with equity in new shares under the
 * cap, and executives' pay. Each effect is read where it applies, through executives.ts.
 */
export function createCsuite(config: GameConfig) {
  const roleName = (role: CsuiteRole) => config.csuite.roles[role].name;

  /**
   * The day a role opened, or null while it's shut. The CFO opens on the first outside money taken (friends and
   * family, the grant, or an investor, who has to approach first) or the first angel approach, whichever comes first.
   */
  function openDay(state: GameState, role: CsuiteRole): number | null {
    switch (STAGES[role]) {
      case "start":
        return 1;
      case "outsideMoney": {
        const { friendsAndFamily, grant } = state.funding;
        const days = [
          friendsAndFamily?.status === "accepted" ? friendsAndFamily.day : null,
          grant && grant.status !== "declined" ? grant.day : null,
          state.investors.firstApproachDay,
        ].filter((d): d is number => d !== null);
        return days.length ? Math.min(...days) : null;
      }
      case "angel":
        return state.investors.firstApproachDay;
      case "seriesA":
        return seriesApproachDay(state, "seriesA");
    }
  }

  const isOpen = (state: GameState, role: CsuiteRole) => openDay(state, role) !== null;

  /** The share of the company the C-suite has taken in equity so far, at the shares it took on each hiring day. */
  const equityUsed = (state: GameState) => state.csuite.hired.reduce((sum, e) => sum + e.equity, 0);

  /** A candidate's ask now: their base ask × the share of the cap still unused, to a hundredth of a percent. */
  function askNow(state: GameState, candidate: Candidate): number {
    const { equityCap } = config.csuite;
    if (equityCap <= 0) return 0;
    const left = Math.max(0, equityCap - equityUsed(state)) / equityCap;
    return Math.round(candidate.equity * left * 10_000) / 10_000;
  }

  const sharesInIssue = (state: GameState) => state.shareholders.reduce((sum, h) => sum + h.shares, 0);
  /** New shares for a share of the company after they're issued. */
  const newSharesFor = (state: GameState, equity: number) => Math.round((sharesInIssue(state) * equity) / (1 - equity));

  function effects(role: CsuiteRole, strength: number): ExecutiveEffectView[] {
    const at = (key: string) => effectAt(config, role, key, strength);
    const one = (key: string, text: (v: number) => string): ExecutiveEffectView => ({ key, value: at(key), text: text(at(key)) });
    switch (role) {
      case "headOfDevelopment":
        return [one("output", (v) => `+${wholePercent(v)} developer output: the MVP, features and optimisation`)];
      case "headOfOps":
        return [
          one("output", (v) => `+${wholePercent(v)} ops output: each ops person covers more servers`),
          one("outageCut", (v) => `Outages ${wholePercent(v)} shorter`),
        ];
      case "headOfSupport":
        return [
          one("output", (v) => `+${wholePercent(v)} tickets cleared by support staff`),
          one("recovery", (v) => `Satisfaction recovers ${wholePercent(v)} faster`),
        ];
      case "cfo":
        return [
          one("rollBonus", (v) => `+${Math.round(v)} on every roll negotiating with investors and funders (not pay reviews)`),
          one("loanRateCut", (v) => `Bank loans' interest ${wholePercent(v)} lower`),
        ];
      case "cto":
        return [
          { key: "tier2", value: 1, text: "Opens tier 2 straight away" },
          one("research", (v) => `+${wholePercent(v)} research points`),
        ];
      case "headOfPeople": {
        const lead = peopleLeadFor(config, true, at("strength"));
        const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
        return [
          { key: "rollBonus", value: lead.rollBonus, text: `${sign(lead.rollBonus)} on staff's counter rolls in pay reviews` },
          {
            key: "walkAwaySoftening",
            value: lead.walkAwaySoftening,
            text: `Staff walk away at ${Math.round(lead.walkAwaySoftening * 1000) / 10} points less`,
          },
          { key: "schemeValuation", value: lead.schemeValuation, text: `Staff count schemes at ${wholePercent(lead.schemeValuation)} of their worth` },
          { key: "tribunalLean", value: lead.tribunalLean, text: `The tribunal leans ${wholePercent(lead.tribunalLean)} your way` },
        ];
      }
      case "cmo":
        return [one("campaigns", (v) => `+${wholePercent(v)} campaign effectiveness`)];
      case "coo":
        return [one("runningCostCut", (v) => `Everyday running costs ${wholePercent(v)} lower (not staff pay)`)];
      case "cio":
        return [one("migrationCut", (v) => `Migrations ${wholePercent(v)} cheaper and quicker`)];
      case "ciso":
        return [
          one("patching", (v) => `Keeping patched needs ${wholePercent(v)} fewer ops`),
          one("breachCut", (v) => `A security breach ${wholePercent(v)} less likely`),
        ];
      case "legalCounsel":
        return [];
    }
  }

  function csuiteView(state: GameState): CsuiteView {
    const roles = CSUITE_ROLES.map((role): CsuiteRoleView => {
      const executive = executiveIn(state, role);
      const day = openDay(state, role);
      return {
        role,
        name: roleName(role),
        blurb: ROLE_BLURBS[role],
        requiredToIpo: (IPO_ROLES as readonly CsuiteRole[]).includes(role),
        open: day !== null,
        openDay: day,
        opens: STAGE_TEXT[STAGES[role]],
        executive: executive
          ? { ...executive, effects: effects(role, executive.strength) }
          : null,
        shortlist:
          executive || day === null
            ? []
            : state.csuite.shortlists[role].map((c) => {
                const equity = askNow(state, c);
                return {
                  id: c.id,
                  name: c.name,
                  strength: c.strength,
                  salary: c.salary,
                  equity,
                  newShares: equity > 0 ? newSharesFor(state, equity) : 0,
                  baseEquity: c.equity,
                  effects: effects(role, c.strength),
                };
              }),
      };
    });
    const used = equityUsed(state);
    const { equityCap } = config.csuite;
    return {
      roles,
      equityCap,
      equityUsed: Math.round(used * 10_000) / 10_000,
      equityLeft: Math.round(Math.max(0, equityCap - used) * 10_000) / 10_000,
      dailyPay: dailyPay(state),
    };
  }

  /**
   * Hires a candidate from an open role's shortlist, for good: their pay starts with the next day played, and their
   * equity ask (shrunk by the cap) is paid at once in new shares. A CTO opens tier 2 at once.
   */
  function hire(state: GameState, role: unknown, candidateId: unknown): GameState {
    if (!isCsuiteRole(role)) throw new SimError("unknown_role", "Pick a C-suite role from the list.");
    const filled = executiveIn(state, role);
    if (filled) {
      throw new SimError("role_filled", `${filled.name} is your ${roleName(role)}: the C-suite is hired for good, so the role can't be filled again.`);
    }
    if (!isOpen(state, role)) throw new SimError("role_not_open", `You can't hire a ${roleName(role)} yet. ${STAGE_TEXT[STAGES[role]]}`);
    const candidate = state.csuite.shortlists[role].find((c) => c.id === candidateId);
    if (!candidate) throw new SimError("unknown_candidate", `Pick a candidate from the ${roleName(role)} shortlist.`);
    const equity = askNow(state, candidate);
    const shares = equity > 0 ? newSharesFor(state, equity) : 0;
    const executive: Executive = {
      role,
      name: candidate.name,
      strength: candidate.strength,
      salary: candidate.salary,
      equity: shares > 0 ? equity : 0,
      shares,
      day: state.day,
    };
    const shareholders =
      shares > 0
        ? [...state.shareholders, { id: "executive" as const, investor: candidate.name, role, shares, day: state.day }]
        : state.shareholders;
    // The CTO's alternative route to tier 2: it opens as they're hired, if it isn't open already.
    const tiers =
      role === "cto" && !state.tiers.some((t) => t.tier === 2) ? [...state.tiers, { tier: 2 as const, day: state.day }] : state.tiers;
    return { ...state, shareholders, tiers, csuite: { ...state.csuite, hired: [...state.csuite.hired, executive] } };
  }

  /** What the executives cost a day: their salaries, fixed for good. */
  const dailyPay = (state: GameState) => state.csuite.hired.reduce((sum, e) => sum + e.salary, 0);

  /** A day's pay, a line for each executive. Pay reviews' rises never touch it. */
  const payEntries = (state: GameState): LogEntry[] =>
    state.csuite.hired.map((e) => ({ text: `${roleName(e.role)} pay (${e.name})`, cashDelta: -e.salary, category: "staff" }));

  /** A line for each role that opened over a day: the shortlist is ready. */
  function openedEntries(before: GameState, after: GameState): LogEntry[] {
    return CSUITE_ROLES.filter((role) => !isOpen(before, role) && isOpen(after, role) && !executiveIn(after, role)).map((role) => {
      const n = after.csuite.shortlists[role].length;
      const required = (IPO_ROLES as readonly CsuiteRole[]).includes(role) ? " You'll need one to float." : "";
      return {
        text: `You can hire a ${roleName(role)} now: ${count.format(n)} candidate${n === 1 ? " is" : "s are"} on the shortlist on the C-suite page.${required}`,
        cashDelta: 0,
        kind: "staff",
      };
    });
  }

  /** The line a hire adds to the log of the day they start. */
  const hiredText = (e: Executive) =>
    `${e.name} joined as ${roleName(e.role)} for ${pounds(e.salary)} a day${e.shares ? ` and ${count.format(e.shares)} new shares (${percent(e.equity)})` : ""}.`;

  return { openDay, isOpen, equityUsed, askNow, csuiteView, hire, dailyPay, payEntries, openedEntries, hiredText };
}

export type CsuiteModule = ReturnType<typeof createCsuite>;
