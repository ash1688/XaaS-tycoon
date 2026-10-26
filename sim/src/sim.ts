import { createApi, type ApiView } from "./api.ts";
import { createBenefits, managedAutoscaling, type BenefitView } from "./benefits.ts";
import { createCalendar, isIsoDate, type CalendarView } from "./calendar.ts";
import { createCampaigns, type CampaignsView } from "./campaigns.ts";
import {
  allowedDifficulties,
  allowedGameLengths,
  DIFFICULTIES,
  DIFFICULTY_IDS,
  defaultConfig,
  defaultDifficulty,
  gameLengthDays,
  gameLengthName,
  withDifficulty,
  type DifficultyId,
  type GameConfig,
  type ModelId,
  type ServerCount,
} from "./config.ts";
import { createConversion, type ConversionView } from "./conversion.ts";
import { createCsuite, startingCsuite, type CsuiteView } from "./csuite.ts";
import { createCustomers } from "./customers.ts";
import { createEncounters, type DangerView } from "./encounters.ts";
import { createEvents, type EventView, type FeatureGapView } from "./events.ts";
import { createFeatures, type FeatureView } from "./features.ts";
import { createFinance, noSpend, pounds } from "./finance.ts";
import { hardwareDay, setPerformance } from "./hardware.ts";
import { createDrift, type DriftView } from "./drift.ts";
import { createInfrastructure, type ProviderView } from "./infrastructure.ts";
import { createInvestors, type InvestorsView } from "./investors.ts";
import { createIpo, type IpoView } from "./ipo.ts";
import { createLaunch, type LaunchView } from "./launch.ts";
import { createLoan, type LoanQuote, type LoanView } from "./loan.ts";
import { mvpDay, mvpStatus, startingMvp, type MvpView } from "./mvp.ts";
import { researchDay, researchView, type ResearchView } from "./research.ts";
import { createMigration, type MigrationQuote, type MigrationView } from "./migration.ts";
import { optimisationDay, optimisationView, type OptimisationView } from "./optimisation.ts";
import { createCustomerMix } from "./mix.ts";
import { isNameAllowed } from "./nameFilter.ts";
import type { CounterOdds, Terms } from "./negotiation.ts";
import { createPauses, type TickResult } from "./pauses.ts";
import { payHistory, type PayHistoryView } from "./payHistory.ts";
import { createPayReview, type PayOfferPreview, type PayReviewView } from "./payReview.ts";
import { schemeEntries, schemeViews, type SchemeLevels, type StaffSchemeView } from "./staffSchemes.ts";
import { createPricing, type CustomerMixView, type PaymentsView, type PricePreview, type PriceWaveView } from "./pricing.ts";
import { createRacks, type RacksView } from "./racks.ts";
import { createRescue, type RescueView } from "./rescue.ts";
import { createRivals, type MarketView } from "./rivals.ts";
import { seedRng } from "./rng.ts";
import { createShares, type CapTableView, type FundingView, type ValuationView } from "./shares.ts";
import { createServers, type ManagedView, type ServerOption, type ServerView, type UnitsView } from "./servers.ts";
import { createStaff, staffOutput, type StaffPoolView } from "./staff.ts";
import {
  GAME_STATE_VERSION,
  isCurrentState,
  isDifficultyId,
  isGameLengthId,
  isModelId,
  isProductTypeId,
  SimError,
  type Action,
  type AdvanceResult,
  type DayLog,
  type GameState,
  type LogEntry,
  type NewGameParams,
  type UnitDemand,
} from "./state.ts";
import { createSummary, type GameSummary } from "./summary.ts";
import { createTiers, everythingUnlocked, featureTier, isUnlocked, tierAvailable, unlockItem, type TierStatusView } from "./tiers.ts";
import { createModeration, type ModerationView } from "./moderation.ts";
import { createSupport } from "./support.ts";

// The sim's one public interface is createSim. Its modules are internal; only the types and helpers the server and
// web client need are re-exported here.
export type { ApiView } from "./api.ts";
export type { BenefitView } from "./benefits.ts";
export type { HardwareRisk } from "./hardware.ts";
export type { TierConditionView, TierItemKind, TierItemView, TierStatusView } from "./tiers.ts";
export type { CalendarView, GameDate, HolidayView } from "./calendar.ts";
export type { CampaignTypeView, CampaignView, CampaignsView } from "./campaigns.ts";
export { dayOfDate, gameDate } from "./calendar.ts";
export type { ConversionDriver, ConversionDriverId, ConversionView } from "./conversion.ts";
export type { CandidateView, CsuiteRoleView, CsuiteView, ExecutiveEffectView, ExecutiveView } from "./csuite.ts";
export { IPO_ROLES } from "./csuite.ts";
export type { DangerRiskView, DangerView } from "./encounters.ts";
export type { EventView, FeatureGapView } from "./events.ts";
export type { FeatureStatus, FeatureView } from "./features.ts";
export type { ProviderView } from "./infrastructure.ts";
export type { AngelView, InvestorOffer, InvestorsView, VcApproachView, VcOfferView, VcRoundView, VcView } from "./investors.ts";
export { seriesApproachDay } from "./investors.ts";
export type { FloatPreview, IpoCondition, IpoConditionId, IpoOffer, IpoRole, IpoStatus, IpoView } from "./ipo.ts";
export type { LaunchView } from "./launch.ts";
export type { MvpView } from "./mvp.ts";
export type { ResearchView } from "./research.ts";
export type { OptimisationView } from "./optimisation.ts";
export type { LoanQuote, LoanView } from "./loan.ts";
export type { LostAddon, MigrationQuote, MigrationView, SetupRack } from "./migration.ts";
export { LOW_CASH_DAYS, type PauseKind, type PauseReason, type TickResult } from "./pauses.ts";
export type { NewUserFactor } from "./mix.ts";
export type { RackOption, RackView, RacksView } from "./racks.ts";
export type { CounterOdds, NegotiationRound, RollResult, TermSpec, Terms } from "./negotiation.ts";
export { MAX_OFFERS, ROLL_RESULTS } from "./negotiation.ts";
export type { PayOfferPreview, PayReviewView, SchemeOfferPreview, TribunalOdds } from "./payReview.ts";
export type { PayHistoryEntry, PayHistoryView, SchemeRaise, StaffShareSchemeView } from "./payHistory.ts";
export type { SchemeLevels, ShareSaveIssue, StaffSchemeId, StaffSchemeView } from "./staffSchemes.ts";
export { STAFF_SCHEMES } from "./staffSchemes.ts";
export { inflationNow, quarterName, REVIEW_QUARTERS, TRIBUNAL_PICKS, type ReviewSlot } from "./payReview.ts";
export type { DriftView } from "./drift.ts";
export type { RescueView } from "./rescue.ts";
export type { TicketOutlook } from "./support.ts";
export type { MarketCompanyView, MarketView, TypeContestView } from "./rivals.ts";
export type { CustomerMixView, CustomerTypeView, PaymentsView, PricePreview, PriceWaveView, TypeReaction } from "./pricing.ts";
export { percent } from "./pricing.ts";
export { weightedReaction } from "./pricing.ts";
export type {
  LoadBalancerView,
  ManagedOption,
  ManagedServiceView,
  ManagedView,
  ServerOption,
  ServerView,
  SetupItem,
  TierView,
  UnitsView,
} from "./servers.ts";
export type {
  CapTableRow,
  CapTableView,
  FriendsAndFamilyOffer,
  FundingView,
  GrantOffer,
  GrantView,
  NegotiationView,
  ValuationDriver,
  ValuationDriverId,
  ValuationView,
} from "./shares.ts";
export type { GradeView, HireView, StaffPoolView } from "./staff.ts";
export type { ModerationView } from "./moderation.ts";
export { hasContent, lawsuitOdds } from "./moderation.ts";
export type { GameSummary, IncomeCostDay, LoanSummary, PeakUsers, SummaryDay } from "./summary.ts";
export { interestIn, profitCosts } from "./finance.ts";
export {
  FUNDER_IDS,
  GAME_STATE_VERSION,
  isCurrentState,
  isDifficultyId,
  isCsuiteRole,
  isFunderId,
  isGameLengthId,
  isManagedService,
  isModelId,
  isProductTypeId,
  isRackSize,
  isServerSize,
  isServerType,
  isStaffPool,
  ROUND_IDS,
  ROUND_NAMES,
  SimError,
  type Action,
  type AdvanceResult,
  type AngelDeal,
  type AngelTarget,
  type Campaign,
  type Candidate,
  type Csuite,
  type Executive,
  type ApiState,
  type Approach,
  type DayLog,
  type DaySpend,
  type Encounter,
  type EventRecord,
  type FeatureGap,
  type FeatureProgress,
  type FriendsAndFamilyFunding,
  type Funding,
  type FunderId,
  type GameEnding,
  type GameState,
  type GameStatus,
  type GrantFunding,
  type IpoApplication,
  type IpoResult,
  type IpoState,
  type InvestorValuation,
  type Investors,
  type VcApproach,
  type VcDeal,
  type VcPitch,
  type VentureCapital,
  type Loan,
  type LogEntry,
  type Migration,
  type NewGameParams,
  type PriceChange,
  type PriceWave,
  type Rack,
  type Rescue,
  type RivalJoin,
  type RoundId,
  type RivalState,
  type ScheduledEvent,
  type PayReview,
  type PayReviewOutcome,
  type PayReviewRecord,
  type PayOfferTerms,
  type TribunalPick,
  type Server,
  type Shareholder,
  type Spend,
  type StaffCut,
  type TierReached,
  type UnitDemand,
  type WaveEffect,
} from "./state.ts";

/**
 * What a usual day does to cash at today's users, price, API calls, staff, servers and loan, leaving out one-offs such as events
 * and a migration's first-day charges: income, running costs and the difference. days is how many more days cash lasts
 * at that rate before going below £0, or null when the company isn't losing money.
 */
export interface RunwayView {
  dailyIncome: number;
  dailyCosts: number;
  /** dailyIncome − dailyCosts: below 0, the company is burning cash. */
  dailyNet: number;
  days: number | null;
}

export interface Sim {
  readonly config: GameConfig;
  newGame(params: NewGameParams): GameState;
  /**
   * Checks stored state is a game from this version, refusing anything older with an "old_version" SimError, and
   * ends a game that has reached the final day. Every other method loads its state this way first.
   */
  load(saved: unknown): GameState;
  /** Applies a player's action without moving time on. */
  applyAction(state: GameState, action: Action): GameState;
  /** Plays that many days, one at a time, with no pauses: for scripts, tests and the balance harness. */
  advance(state: GameState, days?: number): AdvanceResult;
  /**
   * What Continue and the timed flow play: one tick, a day or, in a career, a week. Pause triggers (an event that hurts,
   * an alert, an offer, low cash or something finished) are checked after every day, and the tick stops on the day one
   * fires, with the reasons.
   */
  tick(state: GameState): TickResult;
  /** Days in one tick for this game: 7 in a career, otherwise 1. */
  tickDays(state: GameState): number;
  /**
   * The teacher ends a game still being played: it finishes where it stands, before its final day, and its summary
   * is how it did. A game that has already ended is returned as it is.
   */
  endGame(state: GameState): GameState;
  /**
   * Ops staff a new company on a model needs: its fixed number (the few on PaaS and SaaS), plus the shares of any
   * servers a config starts it with. The servers a company sets up for itself need theirs on top.
   */
  opsNeeded(model: ModelId): number;
  /**
   * What a new company on a model pays up front: its upfront cost (on-prem, the server room), plus any kit a config
   * starts it with. The servers it buys for itself are charged when it buys them.
   */
  upfrontCost(model: ModelId): number;
  /**
   * The smallest sensible setup on a model for some CU and DBU demand, plus the configured migration headroom: what a
   * migration onto it builds. App servers and databases (and load balancers where needed) on IaaS and on-prem,
   * instances and managed services on PaaS, nothing on SaaS.
   */
  sizeSetupFor(model: ModelId, demand: UnitDemand): ServerCount[];
  /**
   * Ops staff the company needs now: the model's fixed number, plus on a model with servers, the servers' shares.
   * Managed services need none.
   */
  opsNeededNow(state: GameState): number;
  /** Ops staff the company will need once every server it has is in service: on-prem, kit on order included. */
  opsNeededOnceReady(state: GameState): number;
  /** What the staff on the team cost per day. Hires still to start cost nothing. */
  dailyStaffCost(state: GameState): number;
  /**
   * Each pool in config order: its grades with what each costs, does and takes to arrive, the headcount and work
   * a day of everyone on the team, and the hires still to start.
   */
  staff(state: GameState): StaffPoolView[];
  /** What the current model costs per month at today's users. */
  monthlyInfrastructureCost(state: GameState): number;
  /** What the active add-ons cost per month at today's users. */
  monthlyAddonCost(state: GameState): number;
  /**
   * What paying users pay on a usual day at today's paid users and price: paid users × price ÷ daysPerMonth. On the
   * payments app, the price is what a usual month costs them: the fee plus the rate's share of their payments.
   */
  dailyIncome(state: GameState): number;
  /**
   * The monthly price users think the product is worth. Pricing above it slows growth and means fewer new payers. On
   * the payments app, the fair monthly fee: see payments for the fair rate.
   */
  fairPrice(state: GameState): number;
  /**
   * What changing the price would do if nothing else changed: income a day once the wave settles, paying users
   * leaving and dropping to free, new users and upgrades on a cut, and the wave day by day. Changes nothing, and works
   * while the price is locked (saying so). Rejects the prices setPrice does.
   */
  pricePreview(state: GameState, price: number, rate?: number): PricePreview;
  /** The price wave under way, or null. */
  priceWave(state: GameState): PriceWaveView | null;
  /** Days until the price can be changed again: 0 when it can. */
  priceLockDaysLeft(state: GameState): number;
  /**
   * The customer mix: each customer type's share of users, with its price threshold, and its share of new users with
   * what tilts it (features and the price). Least willing to pay first.
   */
  customerMix(state: GameState): CustomerMixView;
  /**
   * The market: the student's company and each rival with its price, quality and market share; who wins each customer
   * type's new users; what that does to the student's growth; and a price change the rivals haven't answered yet.
   */
  market(state: GameState): MarketView;
  /**
   * The payments app's monthly fee and transaction rate, set together as one price change, and the two income
   * streams they bring: payments follow paydays and Black Friday. Null on other products.
   */
  payments(state: GameState): PaymentsView | null;
  /**
   * Load the company can serve in a day with its current model and staff. On a model with servers, the load its ready
   * servers carry at the product's usual demand. Null on SaaS, which has no capacity limit.
   */
  capacity(state: GameState): number | null;
  /**
   * On a model with servers, CU, DBU and CH demand on the day just played against what the ready servers give, the
   * tier that runs out first, and load balancers against app servers. Null on SaaS, which has no servers.
   */
  units(state: GameState): UnitsView | null;
  /** The company's servers, ready or not, oldest first: on PaaS its instances and managed services. Empty on SaaS. */
  servers(state: GameState): ServerView[];
  /**
   * Every server type and size the company can add one at a time on its model, with units and price. Empty on PaaS,
   * which sets instances and service sizes (see managed), and on SaaS.
   */
  serverOptions(state: GameState): ServerOption[];
  /**
   * On PaaS: the instance count, the managed database and cache with the sizes they come in, and what they cost.
   * Null on any other model.
   */
  managed(state: GameState): ManagedView | null;
  /**
   * On-prem: the company's racks, the U each holds and its servers take, and the racks it can buy. Null on IaaS, PaaS
   * and SaaS, which have no racks.
   */
  racks(state: GameState): RacksView | null;
  /** What a model charges a day for power and cooling, whatever the company runs: highest on-prem. */
  powerAndCooling(model: ModelId): number;
  /** On SaaS: capacity is the provider's, so what you pay for it is the per-user bill. Null on any other model. */
  provider(state: GameState): ProviderView | null;
  /** Tickets the support staff can clear in a day: their output in mids × tickets each. */
  dailyClearance(state: GameState): number;
  /** Tickets today's users would raise in a day before any burst: paid and free users × their rates. */
  usualTickets(state: GameState): number;
  /**
   * On a product where users post content: the reports they raise, what the moderators handle, what's left, and what
   * that does to satisfaction and the odds of a lawsuit. Null on a product without user content.
   */
  moderation(state: GameState): ModerationView | null;
  /**
   * Free-to-paid conversion: free users who started paying on the day just played and in all, and the daily rate
   * that applies from the next day, with what's helping or hurting it.
   */
  conversion(state: GameState): ConversionView;
  /** Share of time up across every day played, as a percentage. 100 before the first day. */
  uptime(state: GameState): number;
  /** The product's features, in config order, with each one's progress. */
  features(state: GameState): FeatureView[];
  /**
   * The latest bank loan, kept once repaid, with what's left to repay, the repayments left, and what paying it off
   * now would cost and save. Null if none has been taken.
   */
  loan(state: GameState): LoanView | null;
  /**
   * What taking a bank loan now would cost: amount, rate, interest, total repaid, the daily repayment and the days
   * of its fixed term. Null when one can't be taken: one is being repaid, or the game is in its last days.
   */
  loanQuote(state: GameState): LoanQuote | null;
  /** The terms a new game gets if it takes the loan at the start: the best there are. */
  startLoanQuote(): LoanQuote;
  /** What a usual day does to cash at today's figures, and how many days of cash that leaves. */
  runway(state: GameState): RunwayView;
  /**
   * What the company is worth today by the formula (see ValuationConfig): the valuation, shares in issue, share price,
   * and the drivers pushing it up or down, in pounds, which add up to it.
   */
  valuation(state: GameState): ValuationView;
  /** Who owns the company: each shareholder's shares, share and what they're worth, the student first. */
  capTable(state: GameState): CapTableView;
  /**
   * Friends and family and the grant: each one's open offer, with what accepting it now would do (new shares and
   * dilution; the grant's condition), or how it was answered and, for the grant, how its condition stands.
   */
  funding(state: GameState): FundingView;
  /**
   * The IPO: the readiness checklist, condition by condition, whether the company can apply to float and why not, a
   * cold market's wait, once approved the offer with what each float would do, and once floated the first day of
   * trading.
   */
  ipo(state: GameState): IpoView;
  /**
   * What countering a funder's open offer with `terms` would do, before it's made: how far it asks, the odds of a
   * high, middle or low roll, and the next offer each would bring. Refused as counterFunding would refuse it.
   */
  counterOdds(state: GameState, funder: string, terms: Partial<Terms>): CounterOdds;
  /**
   * The rescue buyout once cash has run out once: the cash the vulture VC put in, its shares and the cost cuts, with
   * its stake now and its price to sell it back. Null before.
   */
  rescue(state: GameState): RescueView | null;
  /**
   * The funding ladder: an investor's open approach with what accepting its offer now would do (the target, what
   * missing it costs, and what else it changes), its negotiation, the angel's deal once accepted with how its target
   * stands, and the valuation an investor set. The hidden targets that bring them stay hidden.
   */
  investors(state: GameState): InvestorsView;
  /** What countering the open approach's offer with `terms` would do, as counterOdds does for a funder. */
  investorCounterOdds(state: GameState, terms: Partial<Terms>): CounterOdds;
  /**
   * The pay review open now, holding the clock, with its inflation, caps, the student's offers and staff's figures and
   * rolls so far. Null between reviews. Staff's walk-away figure stays hidden.
   */
  payReview(state: GameState): PayReviewView | null;
  /**
   * What offering staff a cash `rise` and scheme levels in the open review would do, before it's made: its worth to
   * staff, what it adds to the team's cost a day and a year with each scheme's cost, and
   * the odds of each roll if they counter (or, on the final offer, where it settles if it falls short). Refused as
   * offerPayRise would refuse it.
   */
  payOfferPreview(state: GameState, rise: number, schemes?: Partial<SchemeLevels>): PayOfferPreview;
  /**
   * The staff schemes at the levels held, with what each costs a day at today's team. Agreed in pay reviews: they only
   * go up, and are paid every day as staff spend.
   */
  staffSchemes(state: GameState): StaffSchemeView[];
  /**
   * The days pay reviews start, in order: the first days of quarters 2, 3 and 4, and in a long game's later years of
   * every quarter (listed up to the end of next year until IPO).
   */
  payReviewDays(state: GameState): number[];
  /**
   * Drift in a long game: running prices and new kit's units as multiples of the config's, every year's end so far
   * with the price rise it rolled, and the next year's end, if the game reaches it.
   */
  drift(state: GameState): DriftView;
  /**
   * The pay history: each settled review with its inflation, how it ended, the rise and schemes it agreed, any tribunal
   * fee and share save's new shares; the pay multiplier so far, the schemes held and their cost a day, the staff share
   * scheme's holding, and the next review. Read-only.
   */
  payHistory(state: GameState): PayHistoryView;
  /**
   * Where the company is with its launch: waiting for capacity, its first users due, arriving over the ramp, or
   * launched; the day they started (or will start) arriving, and the launch total.
   */
  launch(state: GameState): LaunchView;
  /**
   * The MVP every game opens with: developer-days done of its total, whether it's done, and the day it will be at
   * today's developers. Users can arrive from the end of that day, once there are servers to serve them (see launch).
   */
  mvp(state: GameState): MvpView;
  /**
   * The developer slider and what it has built up: the share of developer output going into optimisation, its
   * developer-days so far, and the saving on resource need per user out of the current model's cap.
   */
  optimisation(state: GameState): OptimisationView;
  /**
   * Research: whether researchers can be hired yet (from the first angel investor's approach), the research points
   * (RP) banked, and RP a day at today's researchers.
   */
  research(state: GameState): ResearchView;
  /**
   * Tiers 1–4: whether each is available, the condition that opens it with how far the company has got, and the
   * product features and model benefits in it. Tier 1 is open from the start; each later tier opens on its condition,
   * in order, and stays open.
   */
  tiers(state: GameState): TierStatusView[];
  /**
   * Campaigns, for the Marketing page: whether they've opened (from the first angel investor's approach) and one can be
   * started now, with why not, how many can run at once, what a pound buys of each customer type now, any holiday a
   * campaign started now would be timed for, and every campaign started with its spend, users and cost per user.
   */
  campaigns(state: GameState): CampaignsView;
  /**
   * Every model's benefits, in config order: each one's tier, fees and whether it's unlocked, on the company's model
   * and on.
   */
  benefits(state: GameState): BenefitView[];
  /** What the model benefits that are on cost a month. */
  monthlyBenefitCost(state: GameState): number;
  /** The migration under way, or null. */
  migration(state: GameState): MigrationView | null;
  /**
   * What migrating to the target would cost, before starting it. Rejects the same targets startMigration does: an
   * unknown model, the current one, or any while a migration is running.
   */
  migrationQuote(state: GameState, target: string): MigrationQuote;
  /** Scripted events that were on during the day just played, each explained, in config order. */
  events(state: GameState): EventView[];
  /**
   * The real calendar: the date and year of the day just played, the holidays on it, and the next of each holiday to
   * come in the game, with what each does to the company's product.
   */
  calendar(state: GameState): CalendarView;
  /** The danger meter: how fast trouble is building, and why. The encounter list itself stays hidden. */
  danger(state: GameState): DangerView;
  /** Feature gaps still slowing growth, oldest first. Shown every day, not just the day the event fired. */
  featureGaps(state: GameState): FeatureGapView[];
  /**
   * The C-suite, for the C-suite page: every role with when it opens, who fills it, or its shortlist with each
   * candidate's effects, salary and equity ask now; and the equity cap, used and left.
   */
  csuite(state: GameState): CsuiteView;
  /** How the company did: final figures, spend by category, migrations and spend over time. */
  summarise(state: GameState): GameSummary;
  /**
   * The product's paid API: its price before it's bought; once bought, its calls, what they earn, the APIU they need
   * against what the servers give (or on SaaS, the provider's fee per call), and any slowdown after an outage. Null on
   * a product without one.
   */
  api(state: GameState): ApiView | null;
}

/**
 * A sim for a config. Each game plays on its own difficulty's numbers (see withDifficulty), so this keeps a sim per
 * difficulty and hands every call to the one for the game's difficulty. Calls that don't take a game use Normal's.
 * `config` is the preset as given: on Normal, the numbers a game plays on.
 */
export function createSim(config: GameConfig = defaultConfig): Sim {
  type Calls = Record<string, (...args: unknown[]) => unknown>;
  const sims = Object.fromEntries(
    DIFFICULTY_IDS.map((d) => [d, createGameSim(withDifficulty(config, d), d) as unknown as Calls]),
  ) as Record<DifficultyId, Calls>;
  // A call's first argument is the game (or a new game's params) when it has one.
  const simFor = (arg: unknown): Calls => {
    const difficulty = typeof arg === "object" && arg !== null ? (arg as { difficulty?: unknown }).difficulty : undefined;
    return typeof difficulty === "string" && isDifficultyId(difficulty) ? sims[difficulty] : sims.normal;
  };
  const sim = Object.fromEntries(
    Object.entries(sims.normal).map(([key, value]) => [
      key,
      typeof value === "function" ? (...args: unknown[]) => simFor(args[0])[key]!(...args) : value,
    ]),
  ) as unknown as Sim;

  function newGame(params: NewGameParams): GameState {
    const allowed = allowedDifficulties(config);
    const difficulty = params.difficulty ?? defaultDifficulty(config);
    if (!difficulty || !isDifficultyId(difficulty) || !allowed.includes(difficulty)) {
      const names = allowed.map((d) => DIFFICULTIES[d].name).join(", ");
      throw new SimError("difficulty_not_allowed", `Pick a difficulty your teacher allows: ${names}.`);
    }
    return (sims[difficulty] as unknown as Sim).newGame(params);
  }

  return { ...sim, config, newGame };
}

/** A sim for one difficulty, on a config that already has that difficulty's numbers. */
function createGameSim(config: GameConfig, difficulty: DifficultyId): Sim {
  const events = createEvents(config);
  const calendar = createCalendar(config);
  const finance = createFinance(config);
  const features = createFeatures(config, finance);
  const support = createSupport(config);
  const pricing = createPricing(config, calendar, support);
  const moderation = createModeration(config);
  const rivals = createRivals(config, features, pricing);
  const customers = createCustomers(config, features, events, pricing, support, calendar, rivals);
  const mix = createCustomerMix(config, features, pricing, rivals);
  const conversion = createConversion(config, features, pricing);
  const racks = createRacks(config, finance);
  const servers = createServers(config, finance, racks);
  const infra = createInfrastructure(config, customers, events, servers);
  const staff = createStaff(config, finance);
  const benefits = createBenefits(config, finance);
  const migration = createMigration(config, infra, features, events, servers, benefits);
  const summary = createSummary(config, infra);
  const loan = createLoan(config, finance);
  const launch = createLaunch(config, servers, pricing);
  const shares = createShares(config, finance, conversion);
  const api = createApi(config, features, finance, infra.apiuOn);
  const encounters = createEncounters(config, servers);
  const ipo = createIpo(config, finance, shares, servers, (s) => runway(s).dailyNet);
  const tiers = createTiers(config, { ipoReady: (s) => ipo.ipoView(s).ready });
  /** The MVP at today's developers. */
  const mvpView = (state: GameState) => mvpStatus(config, { ...state, output: staffOutput(config, state, "developers") });
  const pauses = createPauses(config, {
    events: events.events,
    units: infra.units,
    capacity: infra.capacity,
    runwayDays: (s) => runway(s).days,
    features: features.features,
    launch: launch.launchView,
    mvp: mvpView,
    migration: migration.migration,
    servers: servers.servers,
    funding: shares.funding,
    investors: (s) => investors.investors(s),
    calendar: calendar.calendar,
    ipo: ipo.ipoView,
    danger: encounters.danger,
  });
  const rescue = createRescue(config, finance, shares, (s) => runway(s), (s) => infra.opsNeededNow(s));
  const investors = createInvestors(config, finance, shares);
  const campaigns = createCampaigns(config, calendar);
  const payReview = createPayReview(config, { runwayDays: (s) => runway(s).days, chargeNow: finance.chargeNow });
  const drift = createDrift(config);
  const csuite = createCsuite(config);

  function newGame({
    companyName,
    productType,
    model,
    seed,
    takeLoan = false,
    gameLength,
    shares: shareCount,
    startYear,
    startDate,
  }: NewGameParams): GameState {
    const name = companyName.trim();
    if (!name) throw new SimError("name_required", "Enter a company name.");
    if (name.length > config.maxCompanyNameLength) {
      throw new SimError("name_too_long", `Company names can be up to ${config.maxCompanyNameLength} characters.`);
    }
    if (!isNameAllowed(name)) {
      throw new SimError("name_not_allowed", "That name isn't allowed here. Please choose another company name.");
    }
    if (!isProductTypeId(productType)) throw new SimError("unknown_product_type", "Pick a product type from the list.");
    if (!isModelId(model)) throw new SimError("unknown_model", "Pick a deployment model from the list.");
    const owned = shares.startingShares(shareCount);
    const allowed = allowedGameLengths(config);
    const length = gameLength ?? allowed[0];
    if (!length || !isGameLengthId(length) || !allowed.includes(length)) {
      const names = allowed.map((l) => gameLengthName(config, l)).join(", ");
      throw new SimError("game_length_not_allowed", `Pick a game length your teacher allows: ${names}.`);
    }
    if (startDate !== undefined && !isIsoDate(startDate)) {
      throw new SimError("bad_start_date", "The start date must be a real date, YYYY-MM-DD.");
    }
    if (startYear !== undefined && (!Number.isInteger(startYear) || startYear < 1 || startYear > 9_000)) {
      throw new SimError("bad_start_year", "The start year must be a whole number of years.");
    }
    const schedule = events.fixedSchedule(1);
    // Encounters have their own random sequence, seeded apart from the game's.
    const starting = encounters.startingEncounters({ model, schedule, featureGaps: [], dangerRisks: [] }, seedRng(seed ^ 0x5eed));
    // A new company has no servers, unless a config starts it with some, ready for the first day played.
    const setup = servers.starter(model, 1);
    const state: GameState = {
      version: GAME_STATE_VERSION,
      status: "playing",
      companyName: name,
      productType,
      model,
      gameLength: length,
      difficulty,
      finalDay: gameLengthDays(config, length),
      endedByTeacher: false,
      startDate: startDate ?? calendar.startDate(seed, startYear),
      day: 1,
      cash: config.startingCash,
      rng: seedRng(seed),
      ...staff.startingStaff({ productType }),
      ...customers.startingCustomers(productType, seed),
      mvp: startingMvp(config, productType, model),
      optimisationShare: 0,
      optimisationDays: 0,
      researchPoints: 0,
      unlocks: [],
      campaigns: [],
      nextCampaignId: 1,
      tiers: [],
      benefits: [],
      // The hardware slider has its own too, so overheating doesn't change the rest of the game.
      hardwareRng: seedRng(seed ^ 0x4a7d),
      ...support.startingSupport(),
      ...moderation.startingModeration(),
      ...conversion.startingConversion(),
      spend: noSpend(),
      spendByDay: [],
      servers: setup.servers,
      nextServerId: setup.nextServerId,
      racks: setup.racks,
      nextRackId: setup.nextRackId,
      features: {},
      migration: null,
      migrations: 0,
      loan: null,
      ...owned,
      investors: investors.startingInvestors(),
      ...ipo.startingIpo(),
      rescue: null,
      pastLoans: [],
      interestPaid: 0,
      schedule,
      ...starting,
      // Negotiation rolls have their own too, so countering an offer doesn't change the rest of the game.
      negotiationRng: seedRng(seed ^ 0xd1ce),
      // And investors theirs, so who approaches doesn't change the rest of the game either.
      investorRng: seedRng(seed ^ 0xa4e1),
      events: [],
      priceRises: {},
      addonPriceRise: 1,
      featureGaps: [],
      api: null,
      ...payReview.startingPayReview(seed),
      ...drift.startingDrift(seed),
      csuite: startingCsuite(config, seed),
    };
    // The loan arrives with the upfront bill. A model that costs more up front than the company has would run it out
    // of cash on day 1, so it's refused instead: on-prem needs the loan.
    const borrowed = takeLoan ? loan.startLoan(state) : { state, entries: [] };
    const upfront = infra.upfrontEntries(model);
    const cost = -upfront.reduce((sum, e) => sum + e.cashDelta, 0);
    const cash = config.startingCash + (borrowed.state.loan?.amount ?? 0);
    if (cost > cash) {
      const advice = `${takeLoan ? "Pick" : "Take the bank loan, or pick"} a model that costs less to start.`;
      throw new SimError(
        "cant_afford",
        `${config.models[model].name} costs ${pounds(cost)} up front, and you'd start with ${pounds(cash)}. ${advice}`,
        { cost, cash },
      );
    }
    // Day 1 is played as the game starts. A company that can serve users already (SaaS, or a config's starter setup)
    // with no MVP to build (a config can make it no size) gets the first of its launch ramp at once, with the load they
    // bring.
    const launched = launch.arrive(borrowed.state, 1);
    const { users } = launched.state;
    const started: GameState = {
      ...launched.state,
      load: Math.round(customers.baseLoad(launched.state, users, 1)),
      demand: customers.baseDemand(launched.state, users, 1),
    };
    return finance.settle(started, 1, [...borrowed.entries, ...upfront, ...launched.entries]).state;
  }

  /** Refuses a game from an older version, then ends one that has played its final day. */
  function load(saved: unknown): GameState {
    if (!isCurrentState(saved)) {
      throw new SimError(
        "old_version",
        "This game is from an older version of XaaS Tycoon, so it can't be played any more. Start a new company to play again.",
      );
    }
    const over = saved.finalDay !== null && saved.day >= saved.finalDay;
    return saved.status === "playing" && over ? { ...saved, status: "finished" } : saved;
  }

  /** Loads saved state and checks the game is still going. */
  function loadPlaying(saved: GameState): GameState {
    const state = load(saved);
    if (state.status === "liquidated") {
      throw new SimError(
        "liquidated",
        `${state.companyName} has gone into liquidation, so this game is over. Start a new company to play again.`,
      );
    }
    if (state.status === "finished") {
      const why = state.ipo.result
        ? `${state.companyName} floated on day ${state.ipo.result.day}`
        : state.endedByTeacher
          ? `Your teacher ended ${state.companyName} early`
          : `${state.companyName} has played all ${state.finalDay} days`;
      throw new SimError("finished", `${why}, so this game is over. Start a new company to play again.`);
    }
    return state;
  }

  function applyAction(saved: GameState, action: Action): GameState {
    const state = loadPlaying(saved);
    switch (action.type) {
      case "hire":
        return staff.changeStaff(state, action.type, action.pool, action.grade, action.count, action.agency);
      case "letGo": {
        const left = staff.changeStaff(state, action.type, action.pool, action.grade, action.count, action.agency);
        // A marketer running a campaign stays until it ends or is stopped.
        if (action.pool === "marketers") campaigns.checkBusyMarketers(left);
        // Some permanent staff let go may join a rival. Agency staff go back to their agency.
        return action.agency ? left : rivals.staffLeft(left, action.pool, action.grade ?? "mid", action.count ?? 1);
      }
      case "buildFeature":
        return features.startBuild(state, action.feature);
      case "buyAddon":
        return features.buyAddon(state, action.feature);
      case "setOptimisation":
        return setOptimisation(state, action.share);
      case "moveStaff": {
        const moved = staff.moveStaff(state, action.to, action.from, action.grade);
        if (action.from === "marketers") campaigns.checkBusyMarketers(moved);
        return moved;
      }
      case "startMigration":
        return migration.startMigration(state, action.model);
      case "setPrice":
        return pricing.setPrice(state, action.price, action.rate);
      case "rentServer":
        return servers.rentServer(state, action.server, action.size);
      case "cancelServer":
        return servers.cancelServer(state, action.id);
      case "buyServer":
        return servers.buyServer(state, action.server, action.size, action.rack);
      case "sellServer":
        return servers.sellServer(state, action.id);
      case "buyRack":
        return racks.buyRack(state, action.size);
      case "sellRack":
        return racks.sellRack(state, action.id);
      case "setInstances":
        return servers.setInstances(state, action.count);
      case "setManagedService":
        return servers.setManagedService(state, action.service, action.size);
      case "takeLoan":
        return loan.takeLoan(state);
      case "acceptFunding":
        return shares.acceptFunding(state, action.funder);
      case "declineFunding":
        return shares.declineFunding(state, action.funder);
      case "applyForIpo":
        return ipo.applyForIpo(state);
      case "ringBell":
        return ipo.ringBell(state, action.float);
      case "counterFunding":
        return shares.counterFunding(state, action.funder, action.terms);
      case "buyBack":
        return rescue.buyBack(state);
      case "acceptInvestor":
        return investors.acceptInvestor(state);
      case "declineInvestor":
        return investors.declineInvestor(state);
      case "counterInvestor":
        return investors.counterInvestor(state, action.terms);
      case "pickInvestor":
        return investors.pickInvestor(state, action.investor);
      case "buyApi":
        return api.buyApi(state);
      case "switchServer":
        return servers.switchServer(state, action.id, action.gives);
      case "setApiInstances":
        return servers.setApiInstances(state, action.count);
      case "repayLoan":
        return loan.repayLoan(state);
      case "buyBenefit":
        return benefits.buyBenefit(state, action.benefit);
      case "cancelBenefit":
        return benefits.cancelBenefit(state, action.benefit);
      case "setPerformance":
        return setPerformance(config, state, action.id, action.performance);
      case "unlockItem":
        return unlockItem(config, state, action.item);
      case "startCampaign":
        return campaigns.startCampaign(state, action.customerType, action.budget, action.days);
      case "stopCampaign":
        return campaigns.stopCampaign(state, action.id);
      case "offerPayRise":
        return payReview.offer(state, action.rise, action.schemes);
      case "acceptPayCounter":
        return payReview.acceptCounter(state);
      case "hireExecutive":
        return csuite.hire(state, action.role, action.candidate);
      default:
        throw new SimError("unknown_action", "That action isn't recognised.");
    }
  }

  function advanceOneDay(yesterday: GameState): AdvanceResult {
    const day = yesterday.day + 1;
    // Hires due today start first, so they work and are paid today.
    const arrivals = staff.arrive(yesterday, day);
    // Until the MVP is done, all of the developers' work goes into it. Done today, users can arrive at the end of it.
    const building = mvpDay(config, { ...arrivals.state, output: staffOutput(config, arrivals.state, "developers"), day });
    const start: GameState = { ...arrivals.state, mvp: building.mvp };

    // Events on today: a random one fires if the danger meter has reached the next threshold on the encounter list.
    // A price rise or feature gap from today counts from today's bill and growth. Before the first users arrive
    // there's nothing running for one to hit.
    const ramping = launch.rampDayOn(start, day) > 0;
    const live = start.launchDay !== null || ramping;
    const check = live ? encounters.checkDay(start, day) : { state: {}, entries: [] };
    const checked: GameState = { ...start, ...check.state };
    const today = live ? events.eventsToday(checked, day) : [];
    const state: GameState = { ...checked, ...events.lastingEffects(checked, day, today) };

    // Today's load against capacity, then growth, which slows on an outage day.
    const served = infra.serveLoad(state, day, today);
    // On-prem, the servers that served today wear with their hardware slider, and any pushed past 100% may overheat
    // or crash from tomorrow.
    const hardware = hardwareDay(config, state, day, (s) => `${s.size} ${config.servers.types[s.type].name.toLowerCase()}`);
    // Over the launch ramp the arriving users are the growth: normal growth takes over after it.
    const organic = customers.grow(state, day, served.hoursDown, served.rng);
    const grown = ramping ? { ...organic, users: state.users, paidUsers: state.paidUsers } : organic;
    // Then any price wave takes its share for the day, planned when the price changed.
    const wave = pricing.waveDay(state, day, grown.users, grown.paidUsers);
    // Then a share of the free users left start paying. A user the wave upgraded is already paying, so can't convert.
    const converted = conversion.convertDay(state, wave.users, wave.paidUsers);
    // On a launch ramp day, its share of the launch users arrives at the end of the day.
    const launched = launch.arrive({ ...state, users: wave.users, paidUsers: converted.paidUsers }, day);
    // Last, any wave of free users from an event that fired today.
    const viral = events.newUsersToday(state, day, today, launched.state.users);
    // And the users campaigns bring, of the types they aim at, on top. As many of them pay as of any new users.
    const marketing = campaigns.campaignsDay(state, day);
    const users = launched.state.users + viral.reduce((sum, n) => sum + n, 0) + marketing.users;
    const paidUsers = launched.state.paidUsers + pricing.paidUsersAfter(state, state.users + marketing.users) - state.paidUsers;
    const { launchDay } = launched.state;
    const rng = grown.rng;
    // The mix shifts with who left and joined: launch users arrive in the product's mix, the rest as newUserMix says.
    const newMix = mix.newUserMix(state);
    const customerMix = mix.mixAfter(
      state,
      [...(ramping ? [] : organic.lost), ...(wave.left ? [wave.left] : [])],
      [
        { users: ramping ? 0 : organic.arrived, weights: newMix },
        { users: wave.joined, weights: newMix },
        { users: users - wave.users - marketing.users, weights: pricing.baseMix(state.productType) },
        ...marketing.joined,
      ],
    );

    // The paid API's calls, served as far as the APIU go. Its traffic for tomorrow follows the users paying tonight.
    const calls = api.apiDay(state, day, served.hoursDown, paidUsers, live);

    // Support answers what it can of today's tickets: the users' usual ones plus every burst, from downtime and from
    // a price rise's backlash. Moderators handle what they can of the reports on user content first, and what they
    // leave pulls satisfaction down too. Satisfaction moves after, and sets tomorrow's growth and churn.
    const moderated = moderation.moderationDay(state);
    const bursts = [...support.outageBursts(state, served.hoursDown), ...wave.bursts];
    const care = support.supportDay(state, bursts, moderated.satisfactionFactor);

    // Rivals answer the student's price from reactionDays ago and win their share of the market's new users.
    const market = rivals.rivalsDay(state, day);

    // Developers work on the current build, and once the MVP was done before today, the slider's share of their output
    // goes into optimisation instead. A feature finished today helps growth from tomorrow, and so does today's
    // optimisation.
    const build = features.buildDay(state);
    const optimisationDays = optimisationDay(state, staffOutput(config, state, "developers"), yesterday.mvp.doneDay !== null);
    // Researchers earn their RP, banked with no cap.
    const researchPoints = researchDay(config, state, staffOutput(config, state, "researchers"));

    // Each event explains itself first, then any outage. Billed on the current model until a migration completes, so
    // the model being left is billed pro rata up to the day you leave. During a migration the new model is billed as
    // well (see migrationCharges).
    const recorded = events.record(state, today, served.overloaded, viral);
    // The loan is repaid every day, whatever else happens.
    const repayment = loan.repaymentDay(state, day);
    // A grant's uptime condition counts today's hours down, and may withdraw it.
    const grant = shares.grantDay(state, day, served.hoursDown);
    // Income comes from the users paying at the start of the day, at today's price, like the per-user fees, less any
    // who stopped paying today over the price: they won't pay it.
    const entries: LogEntry[] = [
      // Holidays starting today, or soon enough to announce. They're on the calendar, outside the danger meter.
      ...calendar.dayEntries(state, day),
      ...check.entries,
      ...arrivals.entries,
      // Executives hired between days start today.
      ...state.csuite.hired.filter((e) => e.day === yesterday.day).map((e) => ({ text: csuite.hiredText(e), cashDelta: 0, kind: "staff" as const })),
      ...building.entries,
      ...launched.entries,
      ...recorded.entries,
      // The outage first, then who it drove away.
      ...(served.outage ? [served.outage] : []),
      ...hardware.entries,
      ...(ramping ? [] : organic.entries),
      ...market.entries,
      ...wave.entries,
      ...converted.entries,
      ...moderated.entries,
      ...care.entries,
      ...build.entries,
      ...marketing.entries,
      ...pricing.incomeEntries(state, wave.refused + (ramping ? 0 : organic.pricedOut), day, served.hoursDown),
      ...calls.entries,
      // Hosting bills start at go-live: before the first users arrive there's nothing running to pay for.
      ...(live ? infra.infrastructureEntries(state, state.model, state.users) : []),
      ...migration.migrationCharges(state),
      ...features.addonEntries(state),
      ...benefits.benefitEntries(state),
      ...staff.staffEntries(state),
      ...csuite.payEntries(state),
      ...schemeEntries(config, state),
      ...served.charges,
      ...events.costEntries(today),
      ...repayment.entries,
      ...grant.entries,
    ];
    const played: GameState = {
      ...state,
      day,
      rng,
      launchDay,
      users,
      paidUsers,
      customerMix,
      priceWave: wave.priceWave,
      // Over the launch ramp the users arriving outgrow the day's load, so the load and demand shown are the usual ones
      // of the users there now: what the servers face from tomorrow.
      ...(ramping
        ? { load: Math.round(customers.baseLoad(state, users, day)), demand: customers.baseDemand(state, users, day) }
        : { load: served.load, demand: served.demand }),
      outageDays: state.outageDays + (served.hoursDown > 0 ? 1 : 0),
      downtimeHours: state.downtimeHours + served.hoursDown,
      features: build.features,
      optimisationDays,
      researchPoints,
      campaigns: marketing.campaigns,
      servers: hardware.servers,
      hardwareRng: hardware.hardwareRng,
      events: recorded.records,
      ticketsToday: care.ticketsToday,
      burstTickets: care.burstTickets,
      clearedToday: care.clearedToday,
      backlog: care.backlog,
      satisfaction: care.satisfaction,
      reportsToday: moderated.reportsToday,
      reportsHandled: moderated.reportsHandled,
      reportBacklog: moderated.reportBacklog,
      recentHoursDown: conversion.recentHoursDownAfter(state, served.hoursDown),
      conversionsToday: converted.conversionsToday,
      conversions: state.conversions + converted.conversionsToday,
      loan: repayment.loan,
      funding: grant.funding,
      api: calls.api,
      rivals: market.rivals,
      rivalRng: market.rivalRng,
      rivalJoins: market.rivalJoins,
    };
    // Managed autoscaling sets tomorrow's instances to today's demand.
    const scaled = autoscaleInstances(played);
    entries.push(...scaled.entries);
    // The danger meter rises with the day's risks, on the model the day was played on.
    const risen: GameState = { ...scaled.state, ...encounters.riseDay(scaled.state, live, served.overloaded) };
    entries.push(...encounters.warningEntries(played, risen));
    // The migration moves on after the day is played and billed, so a model switch takes effect from tomorrow.
    const migrated = migration.migrationDay(risen);
    entries.push(...migrated.entries);
    // The first time cash runs out a vulture VC rescues the company; the second time is liquidation.
    const settled = finance.settle(migrated.state, day, entries, rescue.rescue);
    // A rescue's cuts may let go marketers who were running campaigns: those campaigns stop.
    const released = campaigns.release(settled.state);
    // Last, the funding ladder: an angel's target, and an investor who approaches a company doing well.
    const funded = investors.investorDay(released.state, {
      joined: (ramping ? 0 : organic.arrived) + wave.joined + (users - wave.users),
      left: (ramping ? 0 : organic.lost.reduce((sum, l) => sum + l.users, 0)) + (wave.left?.users ?? 0),
    });
    // Then any tier whose condition is now met opens, for good.
    const opened = tiers.tiersDay(funded.state);
    const tiered: GameState =
      opened.tiers.length > funded.state.tiers.length ? { ...funded.state, tiers: opened.tiers } : funded.state;
    // At a year's end in a long game, running prices rise and new kit gets better, from tomorrow (drift).
    const drifted = drift.yearEnd(tiered, day);
    // Last of all, a pay review if the next day starts a quarter that has one: it holds the clock until it's settled.
    const slot = payReview.reviewDue(drifted.state);
    const reviewed = slot === null ? { state: drifted.state, entries: [] } : payReview.openReview(drifted.state, slot);
    const entriesToday = [
      // First, what a tribunal settled before today.
      ...payReview.tribunalEntries(yesterday, day),
      ...payReview.schemeStartEntries(yesterday, day),
      ...settled.entries, ...released.entries, ...funded.entries, ...opened.entries, ...drifted.entries, ...reviewed.entries,
      // C-suite roles that opened today, with their shortlists.
      ...csuite.openedEntries(yesterday, reviewed.state)];
    // Kit added today (managed autoscaling, a migration's new setup) gives what new kit gives now.
    return { state: drift.stampNewKit(yesterday, reviewed.state), log: [{ day, entries: entriesToday }] };
  }

  /**
   * Managed autoscaling (a PaaS model benefit): after the day, the platform sets the app instance count to the day's
   * CU demand plus its headroom, within the platform's limits, serving from tomorrow.
   */
  function autoscaleInstances(state: GameState): { state: GameState; entries: LogEntry[] } {
    const scaling = managedAutoscaling(config, state, state.model);
    const platform = servers.managed(state);
    if (!scaling || !platform || platform.instanceUnits <= 0) return { state, entries: [] };
    const wanted = Math.ceil((state.demand.cu * (1 + scaling.headroom)) / platform.instanceUnits);
    const target = Math.min(platform.maxInstances, Math.max(1, wanted));
    if (target === platform.instances) return { state, entries: [] };
    const text = `Managed autoscaling: ${platform.instances} → ${target} app instances for tomorrow.`;
    return { state: servers.setInstances(state, target), entries: [{ text, cashDelta: 0 }] };
  }

  function runway(state: GameState): RunwayView {
    // Charged the same way a day played charges them, so the rounding matches.
    const charges = [
      ...(state.launchDay !== null ? infra.infrastructureEntries(state, state.model, state.users) : []),
      ...migration.newSetupEntries(state),
      ...features.addonEntries(state),
      ...benefits.benefitEntries(state),
      ...staff.staffEntries(state),
      ...csuite.payEntries(state),
      ...schemeEntries(config, state),
    ];
    const repayment = loan.dailyRepayment(state);
    const calls = api.usualDay(state);
    const dailyCosts = repayment + calls.fee + pricing.usualSaasFee(state) - charges.reduce((sum, e) => sum + e.cashDelta, 0);
    const dailyIncome = pricing.dailyIncome(state) + calls.income;
    const dailyNet = dailyIncome - dailyCosts;
    const days = dailyNet < 0 ? Math.max(0, Math.floor(state.cash / -dailyNet)) : null;
    return { dailyIncome, dailyCosts, dailyNet, days };
  }

  /**
   * Loads a game still being played that time can move on in: an approved IPO holds it until the bell is rung, and an
   * open pay review until it's settled.
   */
  function loadUnheld(saved: GameState): GameState {
    const state = loadPlaying(saved);
    if (state.ipo.approvedDay !== null) {
      throw new SimError("ring_the_bell", "Your IPO is approved: choose your float and ring the opening bell to go on.");
    }
    if (state.payReview) {
      throw new SimError("pay_review", "Your staff want to talk about pay: settle the pay review to go on.");
    }
    return state;
  }

  function advance(saved: GameState, days = 1): AdvanceResult {
    if (!Number.isInteger(days) || days < 1) {
      throw new SimError("bad_days", "Days to advance must be a whole number of at least 1.");
    }
    let current = loadUnheld(saved);
    const log: DayLog[] = [];
    // Stops early if the game ends part-way through (liquidation, or the final day played), or a pay review opens,
    // which holds the clock.
    for (let i = 0; i < days && current.status === "playing" && !current.payReview; i++) {
      const result = advanceOneDay(current);
      current = result.state;
      log.push(...result.log);
    }
    return { state: current, log };
  }

  function tick(saved: GameState): TickResult {
    return pauses.tick(loadUnheld(saved), advanceOneDay);
  }

  /**
   * Why developers on the team have nothing to do, if they haven't: on SaaS the provider builds the features, so they
   * only set up add-ons; on the other models, nothing is being built. Time the developer slider sends to optimisation
   * is never idle, so with some on it, only the rest is.
   */
  function developersIdle(state: GameState): string | null {
    if (staffOutput(config, state, "developers") <= 0 || state.mvp.doneDay === null) return null;
    if (state.optimisationShare >= 1) return null;
    // Only the features whose tier is unlocked can be built or bought.
    const all = config.productTypes[state.productType].features;
    const list = all.filter((f) => isUnlocked(config, state, f.id));
    const allOn = list.every((f) => ["built", "addon"].includes(state.features[f.id]?.status ?? ""));
    const locked = all.filter((f) => !isUnlocked(config, state, f.id));
    const sofar = locked.length ? "unlocked so far " : "";
    // Locked features either wait for their tier, or for research points to unlock them now it's available.
    const toUnlock = locked.some((f) => tierAvailable(state, featureTier(f)));
    const later = !locked.length
      ? ""
      : toUnlock
        ? " Unlock more with research points."
        : ` The rest open with tier ${Math.min(...locked.map(featureTier))} and above.`;
    const optimising = state.optimisationShare > 0;
    const spare = optimising
      ? `the ${Math.round(100 * (1 - state.optimisationShare))}% of your developers' time not on optimisation goes spare`
      : "your developers have nothing to do";
    const slider = optimising ? "" : " Or move the slider to put them on optimisation.";
    if (state.model === "saas") {
      const needed = config.addons.minConfigDevelopers;
      const setUp = needed > 0 ? ` Setting up an add-on needs the work of ${needed} developer${needed === 1 ? "" : "s"}.` : "";
      return allOn
        ? `On SaaS the provider builds the features, and every add-on ${sofar}is on: ${spare}.${slider}${later}`
        : optimising
          ? `On SaaS the provider builds the features: ${spare} between add-ons.${setUp}`
          : `On SaaS the provider builds the features: your developers only set up add-ons, and sit idle in between.${setUp}${slider}`;
    }
    if (features.currentBuild(state)) return null;
    return allOn
      ? `Every feature ${sofar}is built: ${spare}.${slider}${later}`
      : `Nothing is being built: ${spare} until you start a feature.${slider}`;
  }

  /** Sets the developer slider: the share of developer output going into optimisation, from the next day played. */
  function setOptimisation(state: GameState, share: number): GameState {
    if (typeof share !== "number" || !Number.isFinite(share) || share < 0 || share > 1) {
      throw new SimError("bad_optimisation", "Set the slider between 0% and 100% of developer time on optimisation.");
    }
    return { ...state, optimisationShare: Math.round(share * 100) / 100 };
  }

  /** Why researchers have nothing to do, if they haven't: every item in every tier is unlocked, any model's too. */
  function researchersIdle(state: GameState): string | null {
    if (staffOutput(config, state, "researchers") <= 0 || !everythingUnlocked(config, state)) return null;
    return "Every feature and model benefit in every tier is unlocked: your researchers have nothing left to research. Let them go to save their pay.";
  }

  function staffWithIdle(state: GameState): StaffPoolView[] {
    return staff.staffView(state).map((p) =>
      p.pool === "developers"
        ? { ...p, idle: developersIdle(state) }
        : p.pool === "researchers"
          ? { ...p, idle: researchersIdle(state) }
          : p.pool === "marketers"
            ? { ...p, idle: campaigns.marketersIdle(state) }
            : p,
    );
  }

  function endGame(saved: GameState): GameState {
    const state = load(saved);
    return state.status === "playing" ? { ...state, status: "finished", endedByTeacher: true } : state;
  }

  return {
    config,
    newGame,
    load,
    // Kit added by an action gives what new kit gives now.
    applyAction: (s, action) => drift.stampNewKit(s, applyAction(s, action)),
    advance,
    tick,
    tickDays: (s) => pauses.tickDays(load(s)),
    endGame,
    opsNeeded: infra.opsNeeded,
    upfrontCost: (model) => infra.upfrontCost(model),
    sizeSetupFor: infra.sizeSetupFor,
    opsNeededNow: (s) => infra.opsNeededNow(load(s)),
    opsNeededOnceReady: (s) => servers.opsNeededOnceReady(load(s)),
    dailyStaffCost: (s) => staff.dailyStaffCost(load(s)),
    staff: (s) => staffWithIdle(load(s)),
    monthlyInfrastructureCost: (s) => infra.monthlyInfrastructureCost(load(s)),
    monthlyAddonCost: (s) => features.monthlyAddonCost(load(s)),
    dailyIncome: (s) => pricing.dailyIncome(load(s)),
    fairPrice: (s) => pricing.fairPrice(load(s).productType),
    pricePreview: (s, price, rate) => pricing.pricePreview(load(s), price, rate),
    priceWave: (s) => pricing.priceWave(load(s)),
    priceLockDaysLeft: (s) => pricing.lockDaysLeft(load(s)),
    customerMix: (s) => mix.customerMix(load(s)),
    market: (s) => rivals.market(load(s)),
    payments: (s) => pricing.paymentsView(load(s)),
    capacity: (s) => infra.capacity(load(s)),
    units: (s) => infra.units(load(s)),
    servers: (s) => servers.servers(load(s)),
    serverOptions: (s) => servers.serverOptions(load(s)),
    managed: (s) => servers.managed(load(s)),
    racks: (s) => racks.racks(load(s)),
    powerAndCooling: (model) => config.models[model].powerAndCooling,
    provider: (s) => infra.provider(load(s)),
    dailyClearance: (s) => support.dailyClearance(load(s)),
    usualTickets: (s) => support.usualTickets(load(s)),
    moderation: (s) => moderation.moderationView(load(s)),
    conversion: (s) => conversion.conversion(load(s)),
    uptime: (s) => infra.uptime(load(s)),
    features: (s) => features.features(load(s)),
    loan: (s) => loan.loanView(load(s)),
    loanQuote: (s) => loan.loanQuote(load(s)),
    startLoanQuote: () => loan.termsOn(1),
    runway: (s) => runway(load(s)),
    valuation: (s) => shares.valuation(load(s)),
    capTable: (s) => shares.capTable(load(s)),
    funding: (s) => shares.funding(load(s)),
    ipo: (s) => ipo.ipoView(load(s)),
    counterOdds: (s, funder, terms) => shares.counterOdds(load(s), funder, terms),
    rescue: (s) => rescue.rescueView(load(s)),
    investors: (s) => investors.investors(load(s)),
    investorCounterOdds: (s, terms) => investors.counterOdds(load(s), terms),
    payReview: (s) => payReview.payReviewView(load(s)),
    payOfferPreview: (s, rise, schemes) => payReview.offerPreview(load(s), rise, schemes),
    staffSchemes: (s) => schemeViews(config, load(s)),
    payReviewDays: (s) => payReview.quarterStarts(load(s)),
    payHistory: (s) => {
      const state = load(s);
      return payHistory(config, state, payReview.reviewSlots(state));
    },
    drift: (s) => drift.driftView(load(s)),
    launch: (s) => launch.launchView(load(s)),
    mvp: (s) => mvpView(load(s)),
    optimisation: (s) => {
      const state = load(s);
      return optimisationView(config, state, staffOutput(config, state, "developers"));
    },
    research: (s) => {
      const state = load(s);
      return researchView(config, state, staffOutput(config, state, "researchers"));
    },
    tiers: (s) => tiers.tiersView(load(s)),
    campaigns: (s) => campaigns.campaignsView(load(s)),
    benefits: (s) => benefits.benefits(load(s)),
    monthlyBenefitCost: (s) => benefits.monthlyBenefitCost(load(s)),
    migration: (s) => migration.migration(load(s)),
    migrationQuote: (s, target) => migration.migrationQuote(load(s), target),
    events: (s) => events.events(load(s)),
    calendar: (s) => calendar.calendar(load(s)),
    danger: (s) => encounters.danger(load(s)),
    featureGaps: (s) => events.featureGaps(load(s)),
    csuite: (s) => csuite.csuiteView(load(s)),
    summarise: (s) => summary.summarise(load(s)),
    api: (s) => api.apiView(load(s)),
  };
}
