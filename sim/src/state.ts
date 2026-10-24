import type { Negotiation, Terms } from "./negotiation.ts";
import {
  DIFFICULTY_IDS,
  GAME_LENGTH_IDS,
  MANAGED_SERVICES,
  type DangerRisk,
  MODEL_IDS,
  PRODUCT_TYPE_IDS,
  RACK_SIZES,
  SERVER_SIZES,
  SERVER_TYPES,
  STAFF_GRADES,
  STAFF_POOLS,
  type CustomerTypeId,
  type DifficultyId,
  type GameLengthId,
  type ManagedService,
  type MigrationPhase,
  type ModelId,
  type ProductTypeId,
  type RackSize,
  type ServerSize,
  type ServerType,
  type SpendCategory,
  type StaffGrade,
  type StaffPool,
} from "./config.ts";

/**
 * The game-state version. Saves from any other version are refused rather than upgraded: round two made a clean
 * break, so bump this whenever the shape of GameState changes.
 */
export const GAME_STATE_VERSION = 38;

/** Headcount in one pool, by grade. */
export type GradeCounts = Record<StaffGrade, number>;

/** People hired together who haven't started yet. */
export interface Hire {
  pool: StaffPool;
  grade: StaffGrade;
  count: number;
  /** Agency staff, rather than permanent. */
  agency: boolean;
  /** The first day they work and are paid: the day hired plus their grade's lead time, or the agency's. */
  arrivesOn: number;
}

/** Money spent in each category. */
export type Spend = Record<SpendCategory, number>;

/** What was spent on one day, for the cost-over-time chart, what came in, and where the customers stood after it. */
export interface DaySpend extends Spend {
  day: number;
  /** Income on the day: what paying users paid. */
  income: number;
  /**
   * Of it on the payments app, the monthly fee paying users paid, and the share of their payments taken (see
   * ProductTransactionsConfig). Both 0 on other products, whose income is all the monthly price and API calls.
   */
  feeIncome: number;
  transactionIncome: number;
  /** Money borrowed on the day: a bank loan, if one was taken then. Not income: it's paid back as debt. */
  borrowed: number;
  /**
   * Money from funders on the day: friends and family's, a grant's and a rescue buyout's, less a withdrawn grant paid
   * back and a buy-back. Not income: shares were bought with it, and a grant is a gift with a condition.
   */
  raised: number;
  /** Of the day's debt, the interest: the only part of a loan repayment that counts against profit. */
  interest: number;
  /** Users at the end of the day, paying or free, for the summary's peak. */
  users: number;
  /** Of them, those paying. */
  paidUsers: number;
  /** Customer satisfaction at the end of the day, 0–100, for the summary's average. */
  satisfaction: number;
  /** Hours the service was down on the day, for the IPO's uptime record. */
  hoursDown: number;
}

/**
 * A bank loan. It's repaid in equal daily repayments (debt) over its fixed term, from the day after it's taken,
 * whatever happens, unless it's paid off early. See LoanConfig for how the rate, term and repayment are set.
 */
export interface Loan {
  amount: number;
  /** The day it was taken: 1 if taken when the game started. */
  day: number;
  /** Interest as a share of the amount (0.1 = 10%), set by the day it was taken. */
  rate: number;
  /** Repayment days: the term, set by the day it was taken. */
  term: number;
  /** The day of the last repayment: day + term. It can be after the game's final day. */
  lastDay: number;
  /** Charged on every day played from the day after `day` to `lastDay`. */
  dailyRepayment: number;
  /** Everything to repay over the term: the amount plus interest, dailyRepayment × term. */
  total: number;
  /** Repaid so far, an early payoff included. */
  repaid: number;
  /** Of what's been repaid, the interest. */
  interestPaid: number;
  /** The day it was paid off early, or null: the interest it would still have charged was saved. */
  paidOffDay: number | null;
}

/**
 * How far a feature has got. Features not started have no entry. A built feature or an add-on is active: its effect
 * applies. Add-ons are bought on SaaS rather than built, and billed per user; leaving SaaS removes them (delete the
 * entry), so the feature is not started again and can be rebuilt in developer-days from zero.
 *
 * Moving onto SaaS keeps built features: they're your own work, and stay active. A build under way pauses, since on
 * SaaS developers configure add-ons rather than build; it keeps its progress and carries on if you leave SaaS.
 */
export interface FeatureProgress {
  status: "building" | "built" | "addon";
  /** Developer-days of work done so far. Equals the feature's cost once built; 0 for an add-on. */
  progress: number;
}

/**
 * A change of deployment model in progress. It moves through the configured phases a day at a time; the company
 * stays on its current model (and is billed for it) until the last phase ends, then switches to the target.
 */
export interface Migration {
  /** The model being moved to. The model being left is still the state's model. */
  to: ModelId;
  phase: MigrationPhase;
  /** Days done in the current phase. */
  phaseDaysDone: number;
  /** Extra days added to the moving phase by an overrun, rolled when that phase starts. 0 until then. */
  overrunDays: number;
  /**
   * The setup being built on the target model, sized to demand when the migration started (see sizeSetupFor). Rented
   * servers are billed from the migration's first day; bought ones are paid for then and on order until they arrive.
   * They serve only once the model switches, when they become the company's servers.
   */
  servers: Server[];
  /** The racks the setup goes in, on a model with racks (see Rack): bought on the first day with the servers. */
  racks: Rack[];
}

/** The funders on the Finance page from day 1, each a fixed offer to accept or decline once. */
export const FUNDER_IDS = ["friendsAndFamily", "grant"] as const;
export type FunderId = (typeof FUNDER_IDS)[number];

/** Someone who owns shares in the company. */
export interface Shareholder {
  /**
   * "student" for the student, who owns every share at the start; otherwise the funder who bought them, "vulture" for
   * a rescue buyout, "angel" for the angel investor, or "public" for the float's new shares, sold at the IPO.
   */
  id: "student" | "friendsAndFamily" | "angel" | "vulture" | "public";
  shares: number;
  /** The day they got their shares: 1 for the student. */
  day: number;
}

/** Friends and family's offer once answered: accepted (with what they paid and got) or declined. */
export interface FriendsAndFamilyFunding {
  status: "accepted" | "declined";
  day: number;
  /** Cash they put in, and the new shares it bought at the share price then. 0 if declined. */
  amount: number;
  shares: number;
  /** The valuation the shares were priced at. */
  valuation: number;
}

/**
 * The grant once answered. Accepted, its uptime condition runs over `days` days played, from the first one after both
 * `day` and the launch ramp, so a launch still settling can't break it: the hours down then must stay at most
 * maxHoursDown. It's then "met", or "withdrawn" the day they go over, when the whole amount is paid back.
 */
export interface GrantFunding {
  status: "accepted" | "declined" | "met" | "withdrawn";
  day: number;
  amount: number;
  /** Days played the condition covers. */
  days: number;
  /** Uptime % the condition asks for on the model it was answered on, and the hours down that allows over its days. */
  minUptime: number;
  maxHoursDown: number;
  /** Hours down so far on the condition's days. */
  hoursDown: number;
}

/** Friends and family and the grant: null until the student accepts or declines each. */
export interface Funding {
  friendsAndFamily: FriendsAndFamilyFunding | null;
  grant: GrantFunding | null;
  /**
   * Each funder's offer once the student has countered it: its offers so far and the rolls between them. Null until
   * then, while the offer is the fixed one, and again once it's answered.
   */
  negotiating: Record<FunderId, Negotiation | null>;
}

/** The rungs of the funding ladder. Only the angel so far: Series A–D will follow. */
export const ROUND_IDS = ["angel"] as const;
export type RoundId = (typeof ROUND_IDS)[number];

/**
 * An investor who approached the student with an offer, still to be answered: cash for a share of the company after,
 * as offers in a negotiation (the first their opening). The business's worth and net cash on the day they approached
 * are what their offer was made on: their terms value the business at a multiple of it.
 */
export interface Approach {
  round: RoundId;
  /** Who they are: "Priya Shah". */
  investor: string;
  day: number;
  business: number;
  netCash: number;
  /** Their offers so far, on `amount` and `share`, and the rolls between them: just the opening until countered. */
  negotiation: Negotiation;
}

/**
 * The angel's deal once accepted: what they put in and got, and their target, income averaged over `days` days
 * reaching dailyRevenue by byDay. "running" until it's "met", or "missed" on byDay, when they took extraShares.
 */
export interface AngelDeal {
  investor: string;
  day: number;
  amount: number;
  shares: number;
  /** Their share of the company then, 0–1, and the valuation it was struck at, their cash included. */
  share: number;
  valuation: number;
  target: { dailyRevenue: number; days: number; byDay: number };
  status: "running" | "met" | "missed";
  /** The day it was met or missed; null while it runs. */
  settledDay: number | null;
  extraShares: number;
}

/**
 * The valuation an investor set: from the day they invested the business is valued at `multiple` × the formula's,
 * cash at face value. Set by the first investor after friends and family: the angel.
 */
export interface InvestorValuation {
  investor: string;
  round: RoundId;
  day: number;
  multiple: number;
}

/**
 * The funding ladder: who approaches next and when, the approach open now, those turned down, the angel's deal, and the
 * valuation an investor set.
 */
export interface Investors {
  /** The day the next investor approaches: set when the hidden target is first hit, and again after a decline. */
  nextApproachDay: number | null;
  approach: Approach | null;
  declined: { round: RoundId; investor: string; day: number }[];
  angel: AngelDeal | null;
  valuation: InvestorValuation | null;
}

/** People of one grade let go from one team in a rescue buyout's cost cuts. */
export interface StaffCut {
  pool: StaffPool;
  grade: StaffGrade;
  count: number;
  /** Agency staff, rather than permanent. */
  agency: boolean;
}

/**
 * The rescue buyout, once it has happened: the first time cash ran out, a vulture VC put in cash for new shares and
 * forced cost cuts (see RescueConfig). Running out again is liquidation.
 */
export interface Rescue {
  day: number;
  /** Cash the vulture VC put in: the losses, plus the breathing space. */
  amount: number;
  /** Of it, what took cash below £0. */
  losses: number;
  /** The new shares it got for it, and its share of the company then, 0–1. */
  shares: number;
  share: number;
  /** Staff let go in the cuts, and hires cancelled before they started. */
  cuts: StaffCut[];
  hiresCancelled: number;
  /** What the cuts save a day in pay. */
  savedPerDay: number;
  /** Severance paid to the permanent staff let go, out of the cash put in. */
  severance: number;
  /** The day the student bought the vulture VC's shares back and what it cost, or null. */
  boughtBack: { day: number; price: number } | null;
}

/** A day an event fires on: a fixed day from config, or the day a random event came up on the encounter list. */
export interface ScheduledEvent {
  /** The event's id in config. */
  event: string;
  day: number;
}

/** A random event on the encounter list, waiting for the danger meter to reach its threshold. */
export interface Encounter {
  /** The event's id in config. */
  event: string;
  threshold: number;
}

/** A scripted event that was on during the day just played, and how it played out. */
export interface EventRecord {
  event: string;
  /** The model it hit: the one the company was running on that day, even if a migration completed that evening. */
  model: ModelId;
  /** Short of the ops staff needed to deal with it. */
  shortOfOps: boolean;
  /** Patches were overdue, which made it worse. Left out in games saved before it was recorded: they weren't. */
  unpatched?: boolean;
  /** It hurt: it caused downtime, a penalty, a price rise or a feature gap. */
  hit: boolean;
  /** New free users it brought. Left out in games saved before it was recorded: none. */
  newUsers?: number;
}

/** A feature the platform can't provide (see EventOutcome.featureGap), slowing growth until the company leaves it. */
export interface FeatureGap {
  /** The event that opened it. */
  event: string;
  /** The model it's tied to: completing a migration off it closes the gap. */
  model: ModelId;
}

/**
 * What a price wave does on one of its days, or over all of them. A rise makes paying users leave or drop to free and
 * raises backlash tickets; a cut brings new users and turns free users into payers.
 */
export interface WaveEffect {
  /** Paying users who leave altogether. */
  left: number;
  /** Paying users who drop to the free tier. */
  toFree: number;
  /** New users who join. */
  joined: number;
  /** Of the new users, those who pay. */
  joinedPaid: number;
  /** Free users who start paying. */
  upgraded: number;
  /** Backlash support tickets. */
  tickets: number;
}

/**
 * A price change's wave of reactions. Planned in full when the price changes, from the users then, so the preview
 * shows exactly what happens if nothing else changes; each day applies its share.
 */
export interface PriceWave {
  direction: "rise" | "cut";
  from: number;
  to: number;
  /** On a product with a transaction rate, the rate before and after: the change is to both together. */
  fromRate?: number;
  toRate?: number;
  /** The first day played at the new price: the wave's day 1. */
  firstDay: number;
  /** The plan: what each day of the wave does, day 1 first. */
  days: WaveEffect[];
  /** What it has done so far. Less than the plan only where users had already gone. */
  done: WaveEffect;
  /**
   * For a rise, who the users it loses are: each customer type's weight among them, its share of users × its reaction
   * × the share of its lost payers who leave rather than go free. Casual users leave first. Null for a cut.
   */
  leftMix: Record<CustomerTypeId, number> | null;
}

/**
 * A server the company has, on a model with servers: a rented VM on IaaS, billed from the first day played after it's
 * added until it's cancelled; or kit bought on-prem, paid for up front and on order until it arrives.
 */
export interface Server {
  /** Unique within the game, for cancelling or selling it. */
  id: number;
  type: ServerType;
  size: ServerSize;
  /** Ready at the end of this day: it serves load on every day played after it. Bought kit arrives on this day. */
  readyDay: number;
  /** What it was bought for, on a model that buys its servers. Selling it back refunds a share of this. */
  paid?: number;
  /** An app server switched from giving CU to giving APIU, for the paid API's calls. Left out while it gives CU. */
  apiu?: boolean;
  /** The rack it's installed in, by id, on a model with racks: it takes its U there from the day it's ordered. */
  rack?: number;
}

/**
 * The company's paid API, once bought. Traffic is the calls a day developers make; each day it moves towards a target
 * set by paying users and features (see ApiConfig).
 */
export interface ApiState {
  /** Calls a day developers make now: what the next day played brings, before any are dropped. */
  calls: number;
  /** Calls served on the day just played: each earned its price. */
  served: number;
  /** Calls dropped on the day just played: beyond the APIU, or while the service was down. */
  dropped: number;
  /** After an outage, API growth is slow until this day has been played. 0 before any outage. */
  slowUntil: number;
}

/**
 * A rack the company has bought, on a model whose servers go in racks (on-prem). It holds servers up to its size in
 * rack units (U), and can be sold back once it's empty.
 */
export interface Rack {
  /** Unique within the game. */
  id: number;
  size: RackSize;
  /** What it was bought for. Selling it back refunds a share of this. */
  paid: number;
}

/** CU and DBU demand on the day just played: what every user needed, before any cache. */
export interface UnitDemand {
  cu: number;
  dbu: number;
  /** APIU the paid API's calls need, when sizing a setup. Left out of the day's demand and with no API. */
  apiu?: number;
}

/** A rival in the market: its price and users now, and what it has gained from the student. See RivalsConfig. */
export interface RivalState {
  /** The rival's id in its product's config. */
  id: string;
  /** Its monthly price. */
  price: number;
  users: number;
  /** Quality points from staff the student let go who joined it. */
  staffQuality: number;
  /** The student's price it last answered: it reacts again once the price it sees differs. */
  reactedTo: number;
}

/** Someone the student let go who joined a rival, logged with the next day played. */
export interface RivalJoin {
  rivalId: string;
  pool: StaffPool;
  grade: StaffGrade;
}

/** A price change, for the summary. */
export interface PriceChange {
  /** The first day played at the new price. */
  day: number;
  from: number;
  to: number;
  /** On a product with a transaction rate, the rate before and after: one change sets both. */
  fromRate?: number;
  toRate?: number;
}

/**
 * A liquidated game is over (cash ran out after a rescue buyout), and so is a finished one: one that has played the
 * configured final day. Either way it accepts no more actions or advances. The final day is the last day played, so a 180-day game plays day 180 in full
 * (billed, with its events) and finishes at the end of it. A game the teacher ends early is finished too.
 */
export type GameStatus = "playing" | "liquidated" | "finished";

/**
 * How a game ended, for the summary: "ended" when the teacher ended it before its final day, "ipo" when the company
 * floated.
 */
export type GameEnding = "completed" | "liquidation" | "ended" | "ipo";

/** One application to float: a cold market postponed it, or it was approved. */
export interface IpoApplication {
  day: number;
  cold: boolean;
}

/** The float and the first day of trading, once the opening bell has been rung. */
export interface IpoResult {
  /** The day the bell was rung: the game's last. */
  day: number;
  /** The float: the new shares' share of the company after the IPO, 0–1. */
  float: number;
  newShares: number;
  sharesBefore: number;
  sharesAfter: number;
  /** The valuation the shares were offered at, before the cash raised. */
  valuation: number;
  /** Valuation ÷ shares in issue before the float. */
  offerPrice: number;
  /** New shares × the offer price: paid to the company. */
  cashRaised: number;
  /** The share price at the open (the offer price) and after each tick of the first day, the close last. */
  prices: number[];
  closePrice: number;
  /** Close price × shares in issue: what the company is worth on the market, the cash raised included. */
  marketValue: number;
  /** The student's shares and share of the company after the float, and what they're worth at the close. */
  studentShares: number;
  studentShare: number;
  studentValue: number;
  /** How ready the company was, 0–1, which set the first day's drift. */
  comfort: number;
  /** Why the price moved as it did, in words. */
  reasons: string[];
}

/** The IPO: applications so far, whether one is approved, and once floated, how it went. */
export interface IpoState {
  applications: IpoApplication[];
  /** The day the IPO was approved: the bell can be rung, and no day can be played until it is. Null until then. */
  approvedDay: number | null;
  /** After a cold market, the first day the company can apply again. 0 before any. */
  retryDay: number;
  result: IpoResult | null;
}

/** Plain, JSON-serialisable game state. The server stores it as-is. */
export interface GameState {
  version: typeof GAME_STATE_VERSION;
  status: GameStatus;
  companyName: string;
  productType: ProductTypeId;
  model: ModelId;
  /** The game length the student picked when starting the company. */
  gameLength: GameLengthId;
  /** The difficulty the student picked when starting the company. The game plays on that difficulty's numbers. */
  difficulty: DifficultyId;
  /**
   * The last day played: the game finishes once it has been played. Set from the game length at the start. Null until
   * IPO: it has no last day.
   */
  finalDay: number | null;
  /** True once the teacher has ended the game, scored as it stood. */
  endedByTeacher: boolean;
  /**
   * The real date of day 1, "YYYY-MM-DD": a random date in the year the game started. Day d is d − 1 days after it.
   * See gameDate for a day's date and year.
   */
  startDate: string;
  day: number;
  cash: number;
  rng: number;
  /**
   * Staff on the team, by pool and grade: developers build features, ops keep the servers running, and support answer
   * customers' tickets on every model. Hires still to start aren't here.
   */
  staff: Record<StaffPool, GradeCounts>;
  /** Agency staff on the team, by pool and grade: apart from the permanent staff above, and doing half their work. */
  agency: Record<StaffPool, GradeCounts>;
  /** Hires waiting to start, in the order they were made. */
  hiring: Hire[];
  /**
   * The day the company launched: its first users arrived at the end of it, the first day of the launch ramp. Null until
   * then, when it has no users (see LaunchConfig).
   */
  launchDay: number | null;
  /**
   * The launch total: users who trickle in over the launch ramp, drawn from the product's range when the game starts.
   * Kept from the student: the screens show only those who have joined.
   */
  launchUsers: number;
  /** Every user, paying or free. Free users add load and per-user fees just like paying ones. */
  users: number;
  /** The users who pay. The rest of `users` are on the free tier. */
  paidUsers: number;
  /**
   * Each customer type's share of the users, adding up to 1: the product's mix to begin with. A price change's reaction
   * is each type's reaction weighted by its share. It shifts as users come and go (see CustomerMix): new users arrive
   * in a mix features and the price tilt, casual users leave first over the price and businesses over downtime.
   */
  customerMix: Record<CustomerTypeId, number>;
  /** The monthly price each paying user pays, a day's share at a time. A change applies from the next day played. */
  price: number;
  /**
   * On a product that takes a share of its users' payments (the payments app), that share (0.02 = 2%), set with the
   * price as one change. Null on other products.
   */
  transactionRate: number | null;
  /** The wave from the last price change, kept after it ends; null before any change. */
  priceWave: PriceWave | null;
  /** The price can't be changed again until this day has been played. 0 before any change. */
  priceLockedUntil: number;
  /** Every price change made, oldest first. */
  priceChanges: PriceChange[];
  /** Everything paying users have paid so far. Not part of spend: profit is income − spend. */
  income: number;
  /** Of it on the payments app, the monthly fee they paid and the rate's share of their payments. 0 on other products. */
  feeIncome: number;
  transactionIncome: number;
  /** Load on the day just played. Over the launch ramp, the usual load of the users there now: what tomorrow brings. */
  load: number;
  /**
   * CU and DBU demand on the day just played, on any model. Only a model with servers serves it in units. Over the
   * launch ramp, the usual demand of the users there now.
   */
  demand: UnitDemand;
  /** The servers the company has, ready or not, oldest first. Empty on a model without servers. */
  servers: Server[];
  /** The id the next server added gets. */
  nextServerId: number;
  /** The racks the company has, on a model with racks, oldest first. Empty on any other model. */
  racks: Rack[];
  /** The id the next rack bought gets. */
  nextRackId: number;
  outageDays: number;
  /** Total hours down across every day played, for uptime. */
  downtimeHours: number;
  /** Running totals of every charge so far, by category. */
  spend: Spend;
  /** Spend and income on each day played, day 1 (upfront costs) first. */
  spendByDay: DaySpend[];
  /** Features started or built, by feature id. */
  features: Record<string, FeatureProgress>;
  /** The migration under way, or null if there isn't one. */
  migration: Migration | null;
  /** Migrations completed, for the end-of-game summary. */
  migrations: number;
  /** The latest bank loan, kept once repaid, or null if none was taken. One at a time. */
  loan: Loan | null;
  /** The cap table: who owns the company's shares, the student first. Their shares added up are the shares in issue. */
  shareholders: Shareholder[];
  /** Friends and family and the grant, once answered. */
  funding: Funding;
  /** The angel and, later, the VCs: who's approached, the deals done and the valuation they set. */
  investors: Investors;
  /** The rescue buyout, once cash has run out once; null before. */
  rescue: Rescue | null;
  /** Applications to float, and the IPO once the bell has been rung. */
  ipo: IpoState;
  /** Loans repaid before the latest was taken, oldest first, for the summary. */
  pastLoans: Loan[];
  /** The interest in every loan repayment so far: of the debt spend, the part that counts against profit. */
  interestPaid: number;
  /**
   * When each event fires, in day order: the fixed days from config, set when the game starts, and each random event
   * added on the day it fires.
   */
  schedule: ScheduledEvent[];
  /** The danger meter: 0 after each random event, rising every day played after launch. See EncounterConfig. */
  dangerMeter: number;
  /** The random events that could fire next, lowest threshold first. Kept from the student. */
  encounterList: Encounter[];
  /** The risks that made the meter climb faster on the day just played. */
  dangerRisks: DangerRisk[];
  /** Its own seeded RNG, so rolling encounters doesn't change the day-to-day randomness of load and growth. */
  encounterRng: number;
  /** The same for negotiation rolls: one a counter. */
  negotiationRng: number;
  /** And for investors: who approaches, and their opening offer. */
  investorRng: number;
  /** Scripted events that were on during the day just played. */
  events: EventRecord[];
  /**
   * What provider price rises have done to each model's charges, as a multiplier (1.2 = 20% dearer). Models with no
   * rise yet are missing. Applies to the model's monthly and per-user costs.
   */
  priceRises: Partial<Record<ModelId, number>>;
  /** The same for SaaS add-on prices. 1 until a price rise covers add-ons. */
  addonPriceRise: number;
  /** Features the platform can't provide, each slowing growth until the company migrates off that model. */
  featureGaps: FeatureGap[];
  /** Tickets raised on the day just played, bursts included. */
  ticketsToday: number;
  /** Of today's tickets, those from bursts (outages, and later price backlash). */
  burstTickets: number;
  /** Tickets support cleared on the day just played, from the backlog and today's. */
  clearedToday: number;
  /** Tickets still unanswered at the end of the day just played. They carry over. */
  backlog: number;
  /**
   * Customer satisfaction, 0–100. Moves a share of the way each day towards a target set by the backlog, and on a
   * product with user content, the reports left unhandled.
   */
  satisfaction: number;
  /** Reports on user content raised on the day just played. Always 0 on a product without user content. */
  reportsToday: number;
  /** Reports moderators handled on the day just played, from the backlog and today's. */
  reportsHandled: number;
  /** Reports still unhandled at the end of the day just played. They carry over. */
  reportBacklog: number;
  /** Hours down on each of the last days played, oldest first, up to conversion.uptimeDays: recent uptime. */
  recentHoursDown: number[];
  /** Free users who started paying on the day just played (not counting a price wave's upgrades). */
  conversionsToday: number;
  /** Free users who have started paying in all, the same way. */
  conversions: number;
  /** The paid API, once bought: null until then, and on a product without one. */
  api: ApiState | null;
  /** The product's rivals, in config order. */
  rivals: RivalState[];
  /** The rivals' own seeded RNG, so their choices don't change the game's other random draws. */
  rivalRng: number;
  /** Staff let go since the last day played who joined a rival. */
  rivalJoins: RivalJoin[];
}

/** Something the player does between days. */
export type Action =
  /**
   * Hires or lets go people of one grade in one pool: `count` of them, one if it's left out, mids if the grade is.
   * Permanent staff unless `agency`. Hires start after their grade's lead time, or agency staff the next day; letting
   * go is at once, and only of those on the team. Letting go permanent staff pays their severance at once.
   */
  | { type: "hire"; pool: StaffPool; grade?: StaffGrade; count?: number; agency?: boolean }
  | { type: "letGo"; pool: StaffPool; grade?: StaffGrade; count?: number; agency?: boolean }
  /** Starts building one of the product's features. One build at a time; not on SaaS. */
  | { type: "buildFeature"; feature: string }
  /** Buys one of the product's features as an add-on, active at once. SaaS only, with a configuration team. */
  | { type: "buyAddon"; feature: string }
  /**
   * Moves one person from one pool into another, keeping their grade. Any time, including during a migration. Without
   * `from`, a move into developers comes from ops and any other move from developers. Without `grade`, a mid moves if
   * there is one, else a junior, else a senior.
   */
  | { type: "moveStaff"; to: StaffPool; from?: StaffPool; grade?: StaffGrade }
  /** Starts a migration to another model. One at a time; it runs in the background. */
  | { type: "startMigration"; model: ModelId }
  /**
   * Sets the monthly price paying users pay, from the next day played. Above 0 and at most the configured maximum. On
   * the payments app, `rate` sets the share of each payment taken in the same change (today's if left out), and the
   * price can be 0 when the rate isn't.
   */
  | { type: "setPrice"; price: number; rate?: number }
  /** Rents a VM of a type and size, on IaaS. Billed monthly from the next day played, and ready the next day. */
  | { type: "rentServer"; server: ServerType; size: ServerSize }
  /** Cancels a rented VM, ready or not. Its rent stops: you pay only for the days you had it. */
  | { type: "cancelServer"; id: number }
  /**
   * Buys a server of a type and size, on-prem. Its price is charged at once (infrastructure), with its cabling. It's on
   * order until it arrives after the delivery time, adding no capacity until then. An order can't be cancelled. It's
   * installed in the rack given, or the first with room for it, taking its U from now; with no room, it's refused.
   */
  | { type: "buyServer"; server: ServerType; size: ServerSize; rack?: number }
  /** Sells back a bought server that has arrived, refunding the configured share of what it cost, at once. */
  | { type: "sellServer"; id: number }
  /** Buys a rack, on-prem: its price and cabling are charged at once, and it's installed at once. */
  | { type: "buyRack"; size: RackSize }
  /** Sells back an empty rack, refunding the configured share of what it cost, at once. */
  | { type: "sellRack"; id: number }
  /**
   * Sets how many app instances run, on PaaS: from 1 to the platform's most. The change is instant, serving from the
   * next day played, and billed monthly a day's share at a time from then.
   */
  | { type: "setInstances"; count: number }
  /**
   * Sets the size of a managed service on PaaS, at once, like an instance count. The cache can be turned off with
   * a null size; the database can't.
   */
  | { type: "setManagedService"; service: ManagedService; size: ServerSize | null }
  /**
   * Takes a bank loan: the money arrives at once, and repayments start the next day played, at today's rate and term.
   * One at a time, so not while one is being repaid, and not in the game's last days.
   */
  | { type: "takeLoan" }
  /**
   * Accepts a funder's fixed offer, at once: friends and family's cash for new shares at today's share price, or the
   * grant's cash on its uptime condition. Once each.
   */
  | { type: "acceptFunding"; funder: FunderId }
  /** Turns a funder's offer down for good. */
  | { type: "declineFunding"; funder: FunderId }
  /**
   * Accepts the open investor approach's offer that stands, at once: their cash for new shares. The first angel closes
   * friends and family and the grant, and sets the valuation.
   */
  | { type: "acceptInvestor" }
  /** Turns the open approach down: a new investor approaches a few days later. */
  | { type: "declineInvestor" }
  /** Counters the open approach's offer on `amount` and `share` (theirs after, 0–1), as counterFunding does. */
  | { type: "counterInvestor"; terms: Partial<Terms> }
  /** Buys all the vulture VC's shares back after a rescue buyout, at its price, at once. Refused without the cash. */
  | { type: "buyBack" }
  /**
   * Counters a funder's offer: friends and family's on `amount` and `share` (theirs after, 0–1), the grant's on
   * `amount` and `days`. A term left out stays as offered. A roll sets the next offer; the third is final.
   */
  | { type: "counterFunding"; funder: FunderId; terms: Partial<Terms> }
  /**
   * Pays off the loan being repaid, at once, with what's left of the money borrowed: the interest still to come is
   * saved. Refused without enough cash.
   */
  | { type: "repayLoan" }
  /**
   * Applies to float, once every readiness condition is met: a hidden roll decides between a cold market, which
   * postpones it, and approval. Not again while one is approved or postponed.
   */
  | { type: "applyForIpo" }
  /**
   * Floats `float` of the company (its share after the IPO, from the configured least to most) in new shares at the
   * offer price, once approved, and rings the opening bell: the first day of trading is played and the game ends.
   */
  | { type: "ringBell"; float: number }
  /** Buys the product's paid API, charged at once. Calls start arriving from the next day played. */
  | { type: "buyApi" }
  /**
   * Switches one of the company's app servers between giving CU and giving APIU, on a model where you add servers one
   * at a time. It serves the other way from the next day played.
   */
  | { type: "switchServer"; id: number; gives: "cu" | "apiu" }
  /** Sets how many API instances run on PaaS, from 0 to the platform's most, like the app instance count. */
  | { type: "setApiInstances"; count: number };

export interface NewGameParams {
  companyName: string;
  productType: string;
  model: string;
  seed: number;
  /** Take the bank loan at the start, on its best terms. */
  takeLoan?: boolean;
  /** Shares in issue at the start, all the student's: a whole number in the configured range. The default if left out. */
  shares?: number;
  /** One of the game lengths the config allows. Left out, the first it allows (180 days by default). */
  gameLength?: string;
  /** One of the difficulties the config allows. Left out, Normal if allowed, otherwise the easiest allowed. */
  difficulty?: string;
  /** The year the game starts in: day 1 is a random date in it, drawn from the seed. Left out, the config's. */
  startYear?: number;
  /** Day 1's date exactly, "YYYY-MM-DD", in place of a random one: for tests and replays. */
  startDate?: string;
}

export interface LogEntry {
  text: string;
  cashDelta: number;
  /** Set on every charge, and only on charges. */
  category?: SpendCategory;
  /** Of a loan repayment (debt), the interest in it. */
  interest?: number;
  /**
   * On the payments app's income, which stream it is, kept apart on Finance: "fees" the monthly fee, "transactions"
   * the share of its users' payments. Other income (other products' price, API calls) has none.
   */
  stream?: "fees" | "transactions";
  /**
   * Set on entries that need to stand out, such as an outage, a rescue buyout, liquidation or the launch. "income" marks money coming in, which the
   * ledger counts as income rather than spend. "loan" marks the bank loan: money coming in with it is borrowed, which
   * is cash but not income. "funding" marks money from friends and family or a grant, and a withdrawn grant paid
   * back or a buy-back; "rescue", the rescue buyout. Either is cash, but neither income nor a charge. "rival" marks
   * what a rival did: answered the price, or took on staff.
   */
  kind?:
    | "outage"
    | "rescue"
    | "liquidation"
    | "finished"
    | "feature"
    | "migration"
    | "event"
    | "income"
    | "support"
    | "price"
    | "conversion"
    | "loan"
    | "funding"
    | "launch"
    | "staff"
    | "api"
    | "danger"
    | "calendar"
    | "ipo"
    | "rival";
}

export interface DayLog {
  day: number;
  entries: LogEntry[];
}

export interface AdvanceResult {
  state: GameState;
  log: DayLog[];
}

/** A player or caller asked for something the rules don't allow. */
export class SimError extends Error {
  readonly code: string;

  /** Numbers that say more, sent with the error: daysLeft on a locked price. */
  readonly details: Record<string, number>;

  constructor(code: string, message: string, details: Record<string, number> = {}) {
    super(message);
    this.name = "SimError";
    this.code = code;
    this.details = details;
  }
}

/** Whether something stored is a game from this version. Anything else is refused, not upgraded. */
export function isCurrentState(saved: unknown): saved is GameState {
  return typeof saved === "object" && saved !== null && (saved as { version?: unknown }).version === GAME_STATE_VERSION;
}

export function isDifficultyId(v: string): v is DifficultyId {
  return (DIFFICULTY_IDS as readonly string[]).includes(v);
}

export function isGameLengthId(v: string): v is GameLengthId {
  return (GAME_LENGTH_IDS as readonly string[]).includes(v);
}

export function isModelId(v: string): v is ModelId {
  return (MODEL_IDS as readonly string[]).includes(v);
}

export function isProductTypeId(v: string): v is ProductTypeId {
  return (PRODUCT_TYPE_IDS as readonly string[]).includes(v);
}

export function isServerType(v: string): v is ServerType {
  return (SERVER_TYPES as readonly string[]).includes(v);
}

export function isServerSize(v: string): v is ServerSize {
  return (SERVER_SIZES as readonly string[]).includes(v);
}

export function isRackSize(v: string): v is RackSize {
  return (RACK_SIZES as readonly string[]).includes(v);
}

export function isManagedService(v: string): v is ManagedService {
  return (MANAGED_SERVICES as readonly string[]).includes(v);
}

export function isFunderId(v: string): v is FunderId {
  return (FUNDER_IDS as readonly string[]).includes(v);
}

export function isStaffPool(v: string): v is StaffPool {
  return (STAFF_POOLS as readonly string[]).includes(v);
}

export function isStaffGrade(v: string): v is StaffGrade {
  return (STAFF_GRADES as readonly string[]).includes(v);
}
