import { defaultConfig, type GameConfig, type ModelId, type ServerCount } from "./config.ts";
import { createConversion, type ConversionView } from "./conversion.ts";
import { createCustomers } from "./customers.ts";
import { createEvents, type EventView, type FeatureGapView } from "./events.ts";
import { createFeatures, type FeatureView } from "./features.ts";
import { createFinance, noSpend, pounds } from "./finance.ts";
import { createInfrastructure, type ProviderView } from "./infrastructure.ts";
import { createLaunch, type LaunchView } from "./launch.ts";
import { createLoan, type LoanQuote, type LoanView } from "./loan.ts";
import { createMigration, type MigrationQuote, type MigrationView } from "./migration.ts";
import { isNameAllowed } from "./nameFilter.ts";
import { createPricing, type CustomerMixView, type PricePreview, type PriceWaveView } from "./pricing.ts";
import { seedRng } from "./rng.ts";
import { createServers, type ManagedView, type ServerOption, type ServerView, type UnitsView } from "./servers.ts";
import { createStaff } from "./staff.ts";
import {
  GAME_STATE_VERSION,
  isCurrentState,
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
import { createSupport } from "./support.ts";

// The sim's one public interface is createSim. Its modules are internal; only the types and helpers the server and
// web client need are re-exported here.
export type { ConversionDriver, ConversionDriverId, ConversionView } from "./conversion.ts";
export type { EventView, FeatureGapView } from "./events.ts";
export type { FeatureStatus, FeatureView } from "./features.ts";
export type { ProviderView } from "./infrastructure.ts";
export type { LaunchView } from "./launch.ts";
export type { LoanQuote, LoanView } from "./loan.ts";
export type { LostAddon, MigrationQuote, MigrationView } from "./migration.ts";
export type { CustomerMixView, CustomerTypeView, PricePreview, PriceWaveView, TypeReaction } from "./pricing.ts";
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
export type { GameSummary, IncomeCostDay, LoanSummary, PeakUsers, SummaryDay } from "./summary.ts";
export { interestIn, profitCosts } from "./finance.ts";
export {
  GAME_STATE_VERSION,
  isCurrentState,
  isManagedService,
  isModelId,
  isProductTypeId,
  isServerSize,
  isServerType,
  isStaffPool,
  SimError,
  type Action,
  type AdvanceResult,
  type DayLog,
  type DaySpend,
  type EventRecord,
  type FeatureGap,
  type FeatureProgress,
  type GameEnding,
  type GameState,
  type GameStatus,
  type Loan,
  type LogEntry,
  type Migration,
  type NewGameParams,
  type PriceChange,
  type PriceWave,
  type ScheduledEvent,
  type Server,
  type Spend,
  type UnitDemand,
  type WaveEffect,
} from "./state.ts";

/**
 * What a usual day does to cash at today's users, price, staff, servers and loan, leaving out one-offs such as events
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
  /** The only way time moves. Continue calls it with 1. */
  advance(state: GameState, days?: number): AdvanceResult;
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
  /** What the current headcount costs per day. */
  dailyStaffCost(state: GameState): number;
  /** What the current model costs per month at today's users. */
  monthlyInfrastructureCost(state: GameState): number;
  /** What the active add-ons cost per month at today's users. */
  monthlyAddonCost(state: GameState): number;
  /** What paying users pay per day at today's paid users and price: paid users × price ÷ daysPerMonth. */
  dailyIncome(state: GameState): number;
  /** The monthly price users think the product is worth. Pricing above it slows growth and means fewer new payers. */
  fairPrice(state: GameState): number;
  /**
   * What changing the price would do if nothing else changed: income a day once the wave settles, paying users
   * leaving and dropping to free, new users and upgrades on a cut, and the wave day by day. Changes nothing, and works
   * while the price is locked (saying so). Rejects the prices setPrice does.
   */
  pricePreview(state: GameState, price: number): PricePreview;
  /** The price wave under way, or null. */
  priceWave(state: GameState): PriceWaveView | null;
  /** Days until the price can be changed again: 0 when it can. */
  priceLockDaysLeft(state: GameState): number;
  /** The customer mix: each customer type's share of users, with its price threshold. Least willing to pay first. */
  customerMix(state: GameState): CustomerMixView;
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
  /** On SaaS: capacity is the provider's, so what you pay for it is the per-user bill. Null on any other model. */
  provider(state: GameState): ProviderView | null;
  /** Tickets the support staff can clear in a day: support staff × tickets each. */
  dailyClearance(state: GameState): number;
  /** Tickets today's users would raise in a day before any burst: paid and free users × their rates. */
  usualTickets(state: GameState): number;
  /**
   * Free-to-paid conversion: free users who started paying on the day just played and in all, and the daily rate
   * that applies from the next day, with what's helping or hurting it.
   */
  conversion(state: GameState): ConversionView;
  /** Share of time up across every day played, as a percentage. 100 before the first day. */
  uptime(state: GameState): number;
  /** The product's features, in config order, with each one's progress. */
  features(state: GameState): FeatureView[];
  /** The bank loan once taken, with what's left to repay and the repayments left, or null. */
  loan(state: GameState): LoanView | null;
  /**
   * What taking the bank loan now would cost: amount, rate, interest, total repaid, the daily repayment and the days
   * to repay it. Null when it can't be taken: one has been, or there are too few days left.
   */
  loanQuote(state: GameState): LoanQuote | null;
  /** The terms a new game gets if it takes the loan at the start: the best there are. */
  startLoanQuote(): LoanQuote;
  /** What a usual day does to cash at today's figures, and how many days of cash that leaves. */
  runway(state: GameState): RunwayView;
  /**
   * Where the company is with its launch: waiting for capacity, its first users due, arriving over the ramp, or
   * launched; the day they started (or will start) arriving, and the launch total.
   */
  launch(state: GameState): LaunchView;
  /** The migration under way, or null. */
  migration(state: GameState): MigrationView | null;
  /**
   * What migrating to the target would cost, before starting it. Rejects the same targets startMigration does: an
   * unknown model, the current one, or any while a migration is running.
   */
  migrationQuote(state: GameState, target: string): MigrationQuote;
  /** Scripted events that were on during the day just played, each explained, in config order. */
  events(state: GameState): EventView[];
  /** Feature gaps still slowing growth, oldest first. Shown every day, not just the day the event fired. */
  featureGaps(state: GameState): FeatureGapView[];
  /** How the company did: final figures, spend by category, migrations and spend over time. */
  summarise(state: GameState): GameSummary;
}

export function createSim(config: GameConfig = defaultConfig): Sim {
  const events = createEvents(config);
  const finance = createFinance(config);
  const features = createFeatures(config, finance);
  const pricing = createPricing(config);
  const support = createSupport(config);
  const customers = createCustomers(config, features, events, pricing, support);
  const conversion = createConversion(config, features, pricing);
  const servers = createServers(config, finance);
  const infra = createInfrastructure(config, customers, events, servers);
  const staff = createStaff(config);
  const migration = createMigration(config, infra, features, events, servers);
  const summary = createSummary(config, infra);
  const loan = createLoan(config, finance);
  const launch = createLaunch(config, servers, pricing);

  function newGame({ companyName, productType, model, seed, takeLoan = false }: NewGameParams): GameState {
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
    const [schedule, rng] = events.rollSchedule(seedRng(seed), 1);
    // A new company has no servers, unless a config starts it with some, ready for the first day played.
    const setup = servers.starter(model, 1);
    const state: GameState = {
      version: GAME_STATE_VERSION,
      status: "playing",
      companyName: name,
      productType,
      model,
      day: 1,
      cash: config.startingCash,
      rng,
      developers: config.staff.developers.startingCount,
      ops: config.staff.ops.startingCount,
      support: config.staff.support.startingCount,
      ...customers.startingCustomers(productType, seed),
      ...support.startingSupport(),
      ...conversion.startingConversion(),
      spend: noSpend(),
      spendByDay: [],
      servers: setup.servers,
      nextServerId: setup.nextServerId,
      features: {},
      migration: null,
      migrations: 0,
      loan: null,
      schedule,
      events: [],
      priceRises: {},
      addonPriceRise: 1,
      featureGaps: [],
    };
    // The loan arrives with the upfront bill. A model that costs more up front than the company has would bankrupt it
    // on day 1, so it's refused instead: on-prem needs the loan.
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
    // gets the first of its launch ramp at once, with the load they bring.
    const launched = launch.arrive(borrowed.state, 1);
    const { users } = launched.state;
    const started: GameState = {
      ...launched.state,
      load: Math.round(customers.baseLoad(productType, users, 1)),
      demand: customers.baseDemand(productType, users, 1),
    };
    return finance.settle(started, 1, [...borrowed.entries, ...upfront, ...launched.entries]).state;
  }

  /** Refuses a game from an older version, then ends one played under a config with more days than this one has. */
  function load(saved: unknown): GameState {
    if (!isCurrentState(saved)) {
      throw new SimError(
        "old_version",
        "This game is from an older version of XaaS Tycoon, so it can't be played any more. Start a new company to play again.",
      );
    }
    return saved.status === "playing" && saved.day >= config.finalDay ? { ...saved, status: "finished" } : saved;
  }

  /** Loads saved state and checks the game is still going. */
  function loadPlaying(saved: GameState): GameState {
    const state = load(saved);
    if (state.status === "bankrupt") {
      throw new SimError("bankrupt", `${state.companyName} is bankrupt, so this game is over. Start a new company to play again.`);
    }
    if (state.status === "finished") {
      throw new SimError(
        "finished",
        `${state.companyName} has played all ${config.finalDay} days, so this game is over. Start a new company to play again.`,
      );
    }
    return state;
  }

  function applyAction(saved: GameState, action: Action): GameState {
    const state = loadPlaying(saved);
    switch (action.type) {
      case "hire":
      case "letGo":
        return staff.changeStaff(state, action.type, action.pool, action.count);
      case "buildFeature":
        return features.startBuild(state, action.feature);
      case "buyAddon":
        return features.buyAddon(state, action.feature);
      case "moveStaff":
        return staff.moveStaff(state, action.to, action.from);
      case "startMigration":
        return migration.startMigration(state, action.model);
      case "setPrice":
        return pricing.setPrice(state, action.price);
      case "rentServer":
        return servers.rentServer(state, action.server, action.size);
      case "cancelServer":
        return servers.cancelServer(state, action.id);
      case "buyServer":
        return servers.buyServer(state, action.server, action.size);
      case "sellServer":
        return servers.sellServer(state, action.id);
      case "setInstances":
        return servers.setInstances(state, action.count);
      case "setManagedService":
        return servers.setManagedService(state, action.service, action.size);
      case "takeLoan":
        return loan.takeLoan(state);
      default:
        throw new SimError("unknown_action", "That action isn't recognised.");
    }
  }

  function advanceOneDay(start: GameState): AdvanceResult {
    const day = start.day + 1;

    // Scripted events on today. A price rise or feature gap from today counts from today's bill and growth. Before the
    // first users arrive there's nothing running for one to hit.
    const ramping = launch.rampDayOn(start, day) > 0;
    const live = start.launchDay !== null || ramping;
    const today = live ? events.eventsToday(start, day) : [];
    const state: GameState = { ...start, ...events.lastingEffects(start, day, today) };

    // Today's load against capacity, then growth, which slows on an outage day.
    const served = infra.serveLoad(state, day, today);
    // Over the launch ramp the arriving users are the growth: normal growth takes over after it.
    const organic = customers.grow(state, day, served.hoursDown, served.rng);
    const grown = ramping ? { ...organic, users: state.users, paidUsers: state.paidUsers } : organic;
    // Then any price wave takes its share for the day, planned when the price changed.
    const wave = pricing.waveDay(state, day, grown.users, grown.paidUsers);
    // Then a share of the free users left start paying. A user the wave upgraded is already paying, so can't convert.
    const converted = conversion.convertDay(state, wave.users, wave.paidUsers);
    // On a launch ramp day, its share of the launch users arrives at the end of the day.
    const launched = launch.arrive({ ...state, users: wave.users, paidUsers: converted.paidUsers }, day);
    const { users, paidUsers, launchDay } = launched.state;
    const rng = grown.rng;

    // Support answers what it can of today's tickets: the users' usual ones plus every burst, from downtime and from
    // a price rise's backlash. Satisfaction moves after, and sets tomorrow's growth and churn.
    const bursts = [...support.outageBursts(state, served.hoursDown), ...wave.bursts];
    const care = support.supportDay(state, bursts);

    // Developers work on the current build. A feature finished today helps growth from tomorrow.
    const build = features.buildDay(state);

    // Each event explains itself first, then any outage. Billed on the current model until a migration completes, so
    // the model being left is billed pro rata up to the day you leave. During a migration the new model is billed as
    // well (see migrationCharges).
    const recorded = events.record(state, today, served.overloaded);
    // The loan is repaid every day, whatever else happens.
    const repayment = loan.repaymentDay(state, day);
    // Income comes from the users paying at the start of the day, at today's price, like the per-user fees, less any
    // who stopped paying today over the price: they won't pay it.
    const entries: LogEntry[] = [
      ...launched.entries,
      ...recorded.entries,
      ...(ramping ? [] : organic.entries),
      ...(served.outage ? [served.outage] : []),
      ...wave.entries,
      ...converted.entries,
      ...care.entries,
      ...build.entries,
      ...pricing.incomeEntries(state, wave.refused + (ramping ? 0 : organic.pricedOut)),
      ...infra.infrastructureEntries(state, state.model, state.users),
      ...migration.migrationCharges(state),
      ...features.addonEntries(state),
      ...staff.staffEntries(state),
      ...served.charges,
      ...events.costEntries(today),
      ...repayment.entries,
    ];
    const played: GameState = {
      ...state,
      day,
      rng,
      launchDay,
      users,
      paidUsers,
      priceWave: wave.priceWave,
      // Over the launch ramp the users arriving outgrow the day's load, so the load and demand shown are the usual ones
      // of the users there now: what the servers face from tomorrow.
      ...(ramping
        ? { load: Math.round(customers.baseLoad(state.productType, users, day)), demand: customers.baseDemand(state.productType, users, day) }
        : { load: served.load, demand: served.demand }),
      outageDays: state.outageDays + (served.hoursDown > 0 ? 1 : 0),
      downtimeHours: state.downtimeHours + served.hoursDown,
      features: build.features,
      events: recorded.records,
      ticketsToday: care.ticketsToday,
      burstTickets: care.burstTickets,
      clearedToday: care.clearedToday,
      backlog: care.backlog,
      satisfaction: care.satisfaction,
      recentHoursDown: conversion.recentHoursDownAfter(state, served.hoursDown),
      conversionsToday: converted.conversionsToday,
      conversions: state.conversions + converted.conversionsToday,
      loan: repayment.loan,
    };
    // The migration moves on after the day is played and billed, so a model switch takes effect from tomorrow.
    const migrated = migration.migrationDay(played);
    entries.push(...migrated.entries);
    const settled = finance.settle(migrated.state, day, entries);
    return { state: settled.state, log: [{ day, entries: settled.entries }] };
  }

  function runway(state: GameState): RunwayView {
    // Charged the same way a day played charges them, so the rounding matches.
    const charges = [
      ...infra.infrastructureEntries(state, state.model, state.users),
      ...migration.newSetupEntries(state),
      ...features.addonEntries(state),
      ...staff.staffEntries(state),
    ];
    const repayment = state.loan ? Math.min(state.loan.dailyRepayment, state.loan.total - state.loan.repaid) : 0;
    const dailyCosts = repayment - charges.reduce((sum, e) => sum + e.cashDelta, 0);
    const dailyIncome = pricing.dailyIncome(state);
    const dailyNet = dailyIncome - dailyCosts;
    const days = dailyNet < 0 ? Math.max(0, Math.floor(state.cash / -dailyNet)) : null;
    return { dailyIncome, dailyCosts, dailyNet, days };
  }

  function advance(saved: GameState, days = 1): AdvanceResult {
    if (!Number.isInteger(days) || days < 1) {
      throw new SimError("bad_days", "Days to advance must be a whole number of at least 1.");
    }
    let current = loadPlaying(saved);
    const log: DayLog[] = [];
    // Stops early if the game ends part-way through: bankrupt, or the final day played.
    for (let i = 0; i < days && current.status === "playing"; i++) {
      const result = advanceOneDay(current);
      current = result.state;
      log.push(...result.log);
    }
    return { state: current, log };
  }

  return {
    config,
    newGame,
    load,
    applyAction,
    advance,
    opsNeeded: infra.opsNeeded,
    upfrontCost: (model) => infra.upfrontCost(model),
    sizeSetupFor: infra.sizeSetupFor,
    opsNeededNow: (s) => infra.opsNeededNow(load(s)),
    opsNeededOnceReady: (s) => servers.opsNeededOnceReady(load(s)),
    dailyStaffCost: (s) => staff.dailyStaffCost(load(s)),
    monthlyInfrastructureCost: (s) => infra.monthlyInfrastructureCost(load(s)),
    monthlyAddonCost: (s) => features.monthlyAddonCost(load(s)),
    dailyIncome: (s) => pricing.dailyIncome(load(s)),
    fairPrice: (s) => pricing.fairPrice(load(s).productType),
    pricePreview: (s, price) => pricing.pricePreview(load(s), price),
    priceWave: (s) => pricing.priceWave(load(s)),
    priceLockDaysLeft: (s) => pricing.lockDaysLeft(load(s)),
    customerMix: (s) => pricing.customerMix(load(s)),
    capacity: (s) => infra.capacity(load(s)),
    units: (s) => infra.units(load(s)),
    servers: (s) => servers.servers(load(s)),
    serverOptions: (s) => servers.serverOptions(load(s)),
    managed: (s) => servers.managed(load(s)),
    provider: (s) => infra.provider(load(s)),
    dailyClearance: (s) => support.dailyClearance(load(s)),
    usualTickets: (s) => support.usualTickets(load(s)),
    conversion: (s) => conversion.conversion(load(s)),
    uptime: (s) => infra.uptime(load(s)),
    features: (s) => features.features(load(s)),
    loan: (s) => loan.loanView(load(s)),
    loanQuote: (s) => loan.loanQuote(load(s)),
    startLoanQuote: () => loan.termsOn(1),
    runway: (s) => runway(load(s)),
    launch: (s) => launch.launchView(load(s)),
    migration: (s) => migration.migration(load(s)),
    migrationQuote: (s, target) => migration.migrationQuote(load(s), target),
    events: (s) => events.events(load(s)),
    featureGaps: (s) => events.featureGaps(load(s)),
    summarise: (s) => summary.summarise(load(s)),
  };
}
