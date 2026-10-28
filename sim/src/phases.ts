import type { GameConfig, ModelId } from "./config.ts";
import { PHASE_IDS, SimError, type Action, type GameState, type LogEntry, type PhaseId } from "./state.ts";

/**
 * The student's jobs that open a phase at a time. A job that isn't open yet is hidden in the game and refused by the
 * sim. The C-suite opens role by role (see csuite.ts), on the same milestones.
 */
export const JOBS = [
  "model",
  "funding",
  "developers",
  "servers",
  "price",
  "ops",
  "support",
  "moderators",
  "researchers",
  "marketers",
  "features",
  "research",
  "api",
  "campaigns",
  "ipo",
] as const;
export type Job = (typeof JOBS)[number];

/** The phase each job opens in. */
export const JOB_PHASES: Record<Job, PhaseId> = {
  model: "build",
  funding: "build",
  developers: "build",
  servers: "build",
  price: "launch",
  ops: "launch",
  support: "launch",
  // The designer's call (#236): at Launch, not Grow, so a product with user content can handle its reports from the
  // first users. In Grow, sensible play liquidated 4 social games in 120.
  moderators: "launch",
  researchers: "grow",
  marketers: "grow",
  // The designer's call (#263): tier 1 features at Launch, so developers have work after the MVP. Research, and the
  // tiers above it, wait for Grow.
  features: "launch",
  research: "grow",
  api: "grow",
  campaigns: "grow",
  ipo: "scale",
};

/** Each job in words, as a refusal names it: "Marketers open in Grow …". */
const JOB_NAMES: Record<Job, string> = {
  model: "Changing your deployment model",
  funding: "Funding",
  developers: "Developers",
  servers: "Servers",
  price: "Setting your price",
  ops: "Ops staff",
  support: "Support staff",
  moderators: "Moderators",
  researchers: "Researchers",
  marketers: "Marketers",
  features: "Features",
  research: "Research and the tiers above tier 1",
  api: "The paid API",
  campaigns: "Campaigns",
  ipo: "The IPO",
};

export const PHASE_NAMES: Record<PhaseId, string> = { build: "Build", launch: "Launch", grow: "Grow", scale: "Scale" };

/** The milestone that opens each phase, in words. */
const OPENS_WITH: Record<PhaseId, string> = {
  build: "Day 1",
  launch: "When you press Launch",
  grow: "When your first angel investor approaches",
  scale: "When Series A venture capitalists approach",
};

/** What a company runs its product on, by model, as the Build phase opens it: SaaS has nothing to run. */
const KIT: Record<ModelId, string | null> = { onprem: "Servers and racks", iaas: "Servers", paas: "Instances", saas: null };

/**
 * What opens in each phase, in words, for this company: only the jobs that apply to its product and model (no
 * moderators without user content, no paid API without one, no servers on SaaS). Grow and Scale's C-suite roles open
 * in csuite.ts; the CFO opens early with outside money (`cfoDay`), and is listed with the phase it opened in.
 */
function opensFor(config: GameConfig, state: GameState, phase: PhaseId, cfoDay: number | null): string[] {
  const product = config.productTypes[state.productType];
  const saas = state.model === "saas";
  // The phase the CFO opened in, when outside money opened it before Grow.
  const cfoIn = cfoDay === null || (state.phaseDays.grow !== null && cfoDay >= state.phaseDays.grow) ? null : state.phaseDays.launch !== null && cfoDay >= state.phaseDays.launch ? "launch" : "build";
  const cfo = cfoIn === phase ? [`The CFO (outside money opened it on day ${cfoDay})`] : [];
  switch (phase) {
    case "build":
      return ["Deployment model", "Funding: the bank loan, friends and family and grants", "Developers", ...(KIT[state.model] ? [KIT[state.model]!] : []), ...cfo];
    case "launch":
      return ["Price", "Ops staff", "Support staff", ...(product.moderation ? ["Moderators"] : []), saas ? "Tier 1 add-ons" : "Tier 1 features", ...cfo];
    case "grow":
      return [
        "Researchers",
        "Marketers",
        "Research: tiers 2 to 4",
        ...(product.api ? ["The paid API"] : []),
        "Campaigns",
        cfoIn ? "The CTO and head of people" : "The CFO, CTO and head of people",
      ];
    case "scale":
      return ["The rest of the C-suite", "The IPO"];
  }
}

/** One phase as the student sees it: when it opens, whether and when it did, and what it opens. */
export interface PhaseStepView {
  id: PhaseId;
  name: string;
  opensWith: string;
  /** The day it opened, or null while it's still to come. */
  day: number | null;
  opens: string[];
}

/** The game's phase for the header and pages: where it is, what's next and which jobs are open. */
export interface PhaseView {
  id: PhaseId;
  name: string;
  /** The day the current phase opened. */
  day: number;
  /** The next phase and its milestone, or null in Scale. */
  next: { id: PhaseId; name: string; opensWith: string } | null;
  phases: PhaseStepView[];
  /** Every job, true once it's open. */
  open: Record<Job, boolean>;
}

/** "When you press Launch" as "when you press Launch". */
const lowerFirst = (text: string) => text[0]!.toLowerCase() + text.slice(1);

const rank = (phase: PhaseId) => PHASE_IDS.indexOf(phase);

/** Whether a game has reached a phase: it's in it or a later one. */
export const phaseReached = (state: Pick<GameState, "phase">, phase: PhaseId) => rank(state.phase) >= rank(phase);

/** Whether a job is open in a game. */
export const jobOpen = (state: Pick<GameState, "phase">, job: Job) => phaseReached(state, JOB_PHASES[job]);

/** Refuses a job that isn't open yet, saying when it opens. */
export function checkJobOpen(state: Pick<GameState, "phase">, job: Job) {
  if (jobOpen(state, job)) return;
  const phase = JOB_PHASES[job];
  throw new SimError(
    "not_yet",
    `${JOB_NAMES[job]}: not open until the ${PHASE_NAMES[phase]} phase, ${lowerFirst(OPENS_WITH[phase])}. You're in the ${PHASE_NAMES[state.phase]} phase.`,
  );
}

/** The job an action needs open, or null for one open in every phase (answering an offer, letting staff go …). */
export function actionJob(action: Action): Job | null {
  switch (action.type) {
    case "hire":
    case "cancelHire":
      return action.pool;
    case "moveStaff":
      return action.to;
    case "setOptimisation":
      return "developers";
    case "startMigration":
      return "model";
    case "setPrice":
      return "price";
    case "rentServer":
    case "cancelServer":
    case "buyServer":
    case "sellServer":
    case "buyRack":
    case "sellRack":
    case "setInstances":
    case "setManagedService":
    case "setPerformance":
      return "servers";
    case "takeLoan":
    case "repayLoan":
    case "acceptFunding":
    case "declineFunding":
    case "counterFunding":
    case "autoNegotiateFunding":
      return "funding";
    case "buildFeature":
    case "buyAddon":
      return "features";
    case "unlockItem":
    case "buyBenefit":
      return "research";
    case "buyApi":
    case "switchServer":
    case "setApiInstances":
      return "api";
    case "startCampaign":
      return "campaigns";
    case "applyForIpo":
    case "ringBell":
      return "ipo";
    default:
      return null;
  }
}

/** Build on day 1, the rest to come. */
export const startingPhase = (): Pick<GameState, "phase" | "phaseDays"> => ({
  phase: "build",
  phaseDays: { build: 1, launch: null, grow: null, scale: null },
});

/**
 * The phase a game's milestones have reached: Scale once Series A has approached, Grow once the first angel has,
 * Launch once Launch is pressed (or, with launch.auto, the company launched itself), otherwise Build.
 */
function milestonePhase(state: GameState): PhaseId {
  if (state.investors.vc.firstApproachDay.seriesA !== null) return "scale";
  if (state.investors.firstApproachDay !== null) return "grow";
  if (state.launchDay !== null) return "launch";
  return "build";
}

/**
 * Moves the phase on to the one the milestones have reached, if that's later, opening any skipped on the way on the
 * same day, with a log entry saying what opened. It never goes back.
 */
export function advancePhase(config: GameConfig, state: GameState, cfoDay: number | null): { state: GameState; entries: LogEntry[] } {
  const reached = milestonePhase(state);
  if (rank(reached) <= rank(state.phase)) return { state, entries: [] };
  const opened = PHASE_IDS.slice(rank(state.phase) + 1, rank(reached) + 1);
  const phaseDays = { ...state.phaseDays };
  for (const p of opened) phaseDays[p] = state.day;
  const moved: GameState = { ...state, phase: reached, phaseDays };
  const opens = opened.flatMap((p) => opensFor(config, moved, p, cfoDay).filter((o) => !o.startsWith("The CFO (")));
  const text = `A new phase: ${PHASE_NAMES[reached]}. Now open: ${opens.join(", ")}.`;
  return { state: moved, entries: [{ text, cashDelta: 0, kind: "phase" }] };
}

/** The phase view. `cfoDay` is the day the CFO's role opened, or null while it's shut (see Csuite.openDay). */
export function phaseView(config: GameConfig, state: GameState, cfoDay: number | null): PhaseView {
  const next = PHASE_IDS[rank(state.phase) + 1];
  return {
    id: state.phase,
    name: PHASE_NAMES[state.phase],
    day: state.phaseDays[state.phase] ?? state.day,
    next: next ? { id: next, name: PHASE_NAMES[next], opensWith: OPENS_WITH[next] } : null,
    phases: PHASE_IDS.map((id) => ({ id, name: PHASE_NAMES[id], opensWith: OPENS_WITH[id], day: state.phaseDays[id], opens: opensFor(config, state, id, cfoDay) })),
    open: Object.fromEntries(JOBS.map((job) => [job, jobOpen(state, job)])) as Record<Job, boolean>,
  };
}
