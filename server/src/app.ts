import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import Fastify, { type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  allowedDifficulties,
  allowedGameLengths,
  applyOverrides,
  CSUITE_ROLES,
  configFields,
  createSim,
  diffFromDefaults,
  DIFFICULTIES,
  CUSTOMER_TYPE_IDS,
  FUNDER_IDS,
  GAME_STATE_VERSION,
  gameLengthDays,
  gameLengthName,
  interestIn,
  withDifficulty,
  isCurrentState,
  MANAGED_SERVICES,
  MIGRATION_PHASES,
  MODEL_IDS,
  PRODUCT_TYPE_IDS,
  profitCosts,
  responsibilityStack,
  SERVER_SIZES,
  SERVER_TYPES,
  SimError,
  SPEND_CATEGORIES,
  STAFF_GRADES,
  STAFF_POOLS,
  STAFF_SCHEMES,
  validateOverrides,
  type ConfigOverrides,
  type GameConfig,
  type GameState,
  type Loan,
  type SchemeLevels,
  type Sim,
  type FunderId,
  type Spend,
  type StaffPool,
} from "@xaas/sim";
import type { Db } from "./db/client.ts";
import { companies, configPresets, loginCodes, playEvents } from "./db/schema.ts";
import { cleanSnapshot, exportRow, PlayLog, pseudonym, snapshotOf, testerId, toCsv, type PlayEventRow } from "./playLog.ts";
import { FailureLimiter } from "./rateLimit.ts";
import { endTeacherSession, isTeacher, passwordMatches, startTeacherSession } from "./teacherAuth.ts";
import type {
  ActionBody,
  CounterOddsView,
  PayOfferView,
  ApiError,
  CodeView,
  CompanyStatus,
  ConfigErrorView,
  CompanyView,
  EndGamesResult,
  ContinueResult,
  LogDeleteResult,
  LogStatsView,
  MetaView,
  MigrationQuoteView,
  NewCompanyBody,
  PresetCreateBody,
  PresetsView,
  PresetSummaryView,
  PresetUpdateBody,
  PresetView,
  PlayEventKind,
  PlayEventView,
  PlaySnapshot,
  PricePreviewView,
  SummaryView,
  TeacherCodeView,
  TeacherGamesView,
  TeacherGameView,
  TeacherSummaryView,
  TimedFlowSpeedView,
  TimedFlowView,
  TimelineView,
  UiEventsBody,
} from "./api-types.ts";

declare module "fastify" {
  interface FastifyInstance {
    /** The playtest log's writer. Tests flush it before reading the log. */
    playLog: PlayLog;
  }
}

export interface AppOptions {
  db: Db;
  teacherPassword: string;
  sessionSecret: string;
  /**
   * The sim for the base config: the built-in defaults, with any env overrides such as GAME_FINAL_DAY. The teacher's
   * config page overrides numbers on top of it for new games.
   */
  sim?: Sim;
  /** Built web client to serve. Skipped if missing (dev uses the Vite server). */
  webDist?: string;
  logger?: boolean;
  /** Companies still being played that one login code can have at once. Defaults to 3. */
  maxActiveCompanies?: number;
  /**
   * Day 1's date for every new game, "YYYY-MM-DD", in place of a random date this year: for tests and demonstrations.
   * Unset, each game starts on a random date in the current year.
   */
  startDate?: string;
  /** How far back, in hours, the teacher's dashboard looks unless the teacher picks another window. Defaults to 3. */
  dashboardHours?: number;
  /**
   * Timed flow: the game page plays a tick every `seconds` at normal speed on its own, with Pause and speed settings,
   * by calling continue on a timer. On unless set off; the teacher can also switch it off in the active preset.
   */
  timedFlow?: TimedFlowOptions;
  /**
   * Which proxies to trust for the client's IP and protocol (Fastify's `trustProxy`): true, or a comma-separated list
   * of addresses, CIDRs or proxy-addr names such as "uniquelocal". Needed behind Dokploy's Traefik, so the teacher's cookie is marked Secure over HTTPS and rate limits see
   * each client rather than the proxy. Off unless set.
   */
  trustProxy?: boolean | string;
  /** Limits on failed student code lookups and teacher sign-ins per client IP. Defaults to RATE_LIMIT_DEFAULTS. */
  rateLimit?: RateLimitOptions | false;
  /** Batches of UI events one game may send a minute. Defaults to UI_BATCHES_PER_MINUTE. */
  uiBatchesPerMinute?: number;
}

export interface RateLimitOptions {
  /** Failed code lookups (any 404 under /api/codes/:code) an IP may make in a window. */
  codeFailures: number;
  /** Wrong teacher passwords an IP may try in a window. */
  loginFailures: number;
  windowMinutes: number;
}

export const RATE_LIMIT_DEFAULTS: RateLimitOptions = { codeFailures: 100, loginFailures: 10, windowMinutes: 15 };

export const DEFAULT_MAX_ACTIVE_COMPANIES = 3;
export const DEFAULT_DASHBOARD_HOURS = 3;
/** The widest window the dashboard can ask for: a week. */
export const MAX_DASHBOARD_HOURS = 7 * 24;
export const DEFAULT_TIMED_FLOW_SECONDS = 10;

/** Whether the server allows timed flow, and the seconds a tick at normal speed. */
export interface TimedFlowOptions {
  enabled: boolean;
  seconds: number;
}

/** The speeds a student can pick, as multiples of the normal speed's seconds a tick. */
const TIMED_FLOW_SPEEDS: { id: TimedFlowSpeedView["id"]; name: string; times: number }[] = [
  { id: "slow", name: "Slow", times: 2 },
  { id: "normal", name: "Normal", times: 1 },
  { id: "fast", name: "Fast", times: 1 / 3 },
  { id: "fastest", name: "Fastest", times: 1 / 10 },
];

/** Timed flow as a game page sees it: on if both the server and the teacher's active preset allow it. */
export function timedFlowView({ enabled, seconds }: TimedFlowOptions, presetAllows: boolean): TimedFlowView {
  return {
    enabled: enabled && presetAllows,
    seconds,
    speeds: TIMED_FLOW_SPEEDS.map(({ id, name, times }) => ({ id, name, seconds: Math.round(seconds * times * 100) / 100 })),
  };
}

const CODE_PATTERN = /^\d{8}$/;

/** A counter's terms: cash, a share of the company (0 to 1) and a condition's days. Which a funder has is the sim's. */
const COUNTER_TERMS = {
  amount: { type: "number", minimum: 0 },
  share: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
  days: { type: "integer", minimum: 1 },
} as const;

/** Staff scheme levels in a pay offer, by scheme. Which levels each allows, and that none goes down, is the sim's. */
const SCHEME_LEVELS = Object.fromEntries(STAFF_SCHEMES.map((id) => [id, { type: "integer", minimum: 0, maximum: 9 }]));

/** The built-in preset: the base config. Read-only, and not a row, so it always exists. */
export const DEFAULT_PRESET = "Default";
const DEFAULT_PRESET_ID = "default";
/** The one preset the config page saved before presets had names. Games started on it are labelled with it. */
export const CUSTOM_PRESET = "Custom";
export const MAX_PRESET_NAME_LENGTH = 40;

/**
 * The UI event endpoint's limits: events in one batch, the batch's size, and batches one company may send a minute.
 * The browser sends a batch every few seconds at most, so these only stop a runaway or hand-made client.
 */
export const UI_EVENTS_PER_BATCH = 50;
export const UI_BATCH_BYTES = 16 * 1024;
export const UI_BATCHES_PER_MINUTE = 20;
/** The furthest back a UI event can be dated, so a batch held by a sleeping laptop doesn't rewrite history. */
const UI_EVENT_MAX_AGE_MS = 10 * 60 * 1000;
/** The most events a timeline shows: the latest ones. The export has them all. */
export const TIMELINE_MAX_EVENTS = 5000;

/** Sims kept for game configs, most recently used last. Most games in a lesson share a config, so a few is plenty. */
const MAX_CACHED_SIMS = 20;

/**
 * SimError codes that are a 409: a game that has ended or that the student retired, a price still locked after the
 * last change, or a day played while an approved IPO waits for the bell. The request was fine, but the game can't take
 * it now.
 */
const CONFLICT = new Set(["liquidated", "finished", "retired", "price_locked", "ring_the_bell", "pay_review"]);

/** The SimError code for a game saved by an older version of the sim, which can't be loaded any more. */
const OLD_VERSION = "old_version";

type CompanyRow = typeof companies.$inferSelect;
type PresetRow = typeof configPresets.$inferSelect;

function sendError(reply: FastifyReply, status: number, error: string, message: string, details: object = {}) {
  return reply.code(status).send({ ...details, error, message } satisfies ApiError);
}

export async function buildApp(opts: AppOptions) {
  const { db } = opts;
  const baseSim = opts.sim ?? createSim();
  const base = baseSim.config;
  const maxActiveCompanies = opts.maxActiveCompanies ?? DEFAULT_MAX_ACTIVE_COMPANIES;
  const dashboardHours = opts.dashboardHours ?? DEFAULT_DASHBOARD_HOURS;
  const timedFlow = opts.timedFlow ?? { enabled: true, seconds: DEFAULT_TIMED_FLOW_SECONDS };
  // A new game starts on the configured date, or a random one this year.
  const startsOn = () => (opts.startDate ? { startDate: opts.startDate } : { startYear: new Date().getUTCFullYear() });
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? false });

  await app.register(cookie, { secret: opts.sessionSecret });

  const playLog = new PlayLog(db, (err) => app.log.warn({ err }, "Couldn't write to the playtest log."));
  app.decorate("playLog", playLog);
  app.addHook("onClose", () => playLog.flush());

  if (opts.rateLimit !== false) limitFailures(opts.rateLimit ?? RATE_LIMIT_DEFAULTS);

  /**
   * Refuses an IP with a 429 once it has had too many failed code lookups or teacher sign-ins in the window. A failure
   * is a 404 from a code route (an unknown code, or a company not under it) or a 401 from the sign-in.
   */
  function limitFailures({ codeFailures, loginFailures, windowMinutes }: RateLimitOptions) {
    const windowMs = windowMinutes * 60 * 1000;
    const codes = new FailureLimiter(codeFailures, windowMs);
    const logins = new FailureLimiter(loginFailures, windowMs);
    const limited = (url: string | undefined) =>
      url?.startsWith("/api/codes/:code")
        ? { limiter: codes, failure: 404, message: "Too many unrecognised codes from your network." }
        : url === "/api/teacher/login"
          ? { limiter: logins, failure: 401, message: "Too many wrong passwords from your network." }
          : undefined;

    app.addHook("onRequest", async (req, reply) => {
      const limit = limited(req.routeOptions.url);
      const wait = limit?.limiter.retryAfter(req.ip);
      if (!limit || !wait) return;
      reply.header("retry-after", String(wait));
      const minutes = Math.ceil(wait / 60);
      return sendError(
        reply,
        429,
        "rate_limited",
        `${limit.message} Wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`,
      );
    });

    app.addHook("onSend", async (req, reply) => {
      const limit = limited(req.routeOptions.url);
      if (limit && reply.statusCode === limit.failure) limit.limiter.fail(req.ip);
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    // A liquidated or finished game is over: the request was fine, but the game can't take it any more. A game from an
    // older version is gone for good: it can't be loaded, so it can't be shown or played.
    if (err instanceof SimError) {
      const status = CONFLICT.has(err.code) ? 409 : err.code === OLD_VERSION ? 410 : 400;
      return sendError(reply, status, err.code, err.message, err.details);
    }
    const { statusCode, message } = err as { statusCode?: number; message?: string };
    if (statusCode && statusCode < 500) return sendError(reply, statusCode, "bad_request", message ?? "Bad request.");
    app.log.error(err);
    return sendError(reply, 500, "server_error", "Something went wrong.");
  });

  // Each game runs on the config it started with. Making a sim is cheap, but it's kept by config so a busy lesson
  // doesn't make one per request.
  const sims = new Map<string, Sim>();
  function simFor(config: GameConfig | null): Sim {
    if (!config) return baseSim;
    const key = JSON.stringify(config);
    const sim = sims.get(key) ?? createSim(config);
    sims.delete(key);
    sims.set(key, sim);
    if (sims.size > MAX_CACHED_SIMS) sims.delete(sims.keys().next().value!);
    return sim;
  }
  const simOf = (row: CompanyRow) => simFor(row.config);

  /**
   * A preset's overrides that still fit the base config. Any that don't (say a test or env change took a feature away)
   * are skipped rather than breaking new games.
   */
  function usable(overrides: ConfigOverrides): ConfigOverrides {
    const errors = validateOverrides(overrides, base);
    return Object.fromEntries(Object.entries(overrides).filter(([path]) => !errors[path]));
  }

  /** The preset new games use, by name, and the full config it makes. With no active row, that's Default. */
  async function newGameSetup(q: Pick<Db, "select"> = db) {
    const [row] = await q.select().from(configPresets).where(eq(configPresets.active, true));
    return { preset: row?.name ?? DEFAULT_PRESET, config: applyOverrides(usable(row?.overrides ?? {}), base) };
  }

  // Games started before presets had names get one: Default if they started on the base numbers, otherwise the one
  // preset the config page saved then, Custom.
  await nameOldGamesPresets();
  async function nameOldGamesPresets() {
    const rows = await db
      .select({ id: companies.id, config: companies.config })
      .from(companies)
      .where(isNull(companies.preset));
    const onDefaults = (config: GameConfig | null) => {
      try {
        return !config || Object.keys(diffFromDefaults(config, base)).length === 0;
      } catch {
        return false;
      }
    };
    for (const preset of [DEFAULT_PRESET, CUSTOM_PRESET]) {
      const ids = rows.filter((r) => onDefaults(r.config) === (preset === DEFAULT_PRESET)).map((r) => r.id);
      if (ids.length) await db.update(companies).set({ preset }).where(inArray(companies.id, ids));
    }
  }

  /** What the student sees of a company. A caller that already has the row's sim passes it. */
  function view(row: CompanyRow, sim = simOf(row)): CompanyView {
    const state = sim.load(row.state);
    const staff = sim.staff(state);
    // Every pool, 0 for one the company can't staff (moderators without user content).
    const headcounts = Object.fromEntries(
      STAFF_POOLS.map((pool) => [pool, staff.find((p) => p.pool === pool)?.headcount ?? 0]),
    ) as Record<StaffPool, number>;
    return {
      id: row.id,
      name: row.name,
      preset: row.preset ?? DEFAULT_PRESET,
      productType: state.productType,
      model: state.model,
      gameLength: state.gameLength,
      gameLengthName: gameLengthName(sim.config, state.gameLength),
      tickDays: sim.tickDays(state),
      difficulty: state.difficulty,
      difficultyName: DIFFICULTIES[state.difficulty].name,
      day: state.day,
      finalDay: state.finalDay,
      endedByTeacher: state.endedByTeacher,
      cash: state.cash,
      status: (state.status === "playing" ? row.status : state.status) as CompanyStatus,
      ...headcounts,
      staff,
      opsNeeded: sim.opsNeededNow(state),
      opsNeededOnceReady: sim.opsNeededOnceReady(state),
      dailyStaffCost: sim.dailyStaffCost(state),
      launch: sim.launch(state),
      mvp: sim.mvp(state),
      optimisation: sim.optimisation(state),
      research: sim.research(state),
      tiers: sim.tiers(state),
      campaigns: sim.campaigns(state),
      benefits: sim.benefits(state),
      monthlyBenefitCost: sim.monthlyBenefitCost(state),
      users: state.users,
      paidUsers: state.paidUsers,
      freeUsers: state.users - state.paidUsers,
      price: state.price,
      fairPrice: sim.fairPrice(state),
      dailyIncome: sim.dailyIncome(state),
      income: state.income,
      priceWave: sim.priceWave(state),
      priceLockDaysLeft: sim.priceLockDaysLeft(state),
      customerMix: sim.customerMix(state),
      market: sim.market(state),
      payments: sim.payments(state),
      conversion: sim.conversion(state),
      ticketsToday: state.ticketsToday,
      burstTickets: state.burstTickets,
      clearedToday: state.clearedToday,
      backlog: state.backlog,
      satisfaction: Math.round(state.satisfaction),
      usualTickets: sim.usualTickets(state),
      dailyClearance: sim.dailyClearance(state),
      moderation: sim.moderation(state),
      load: state.load,
      capacity: sim.capacity(state),
      units: sim.units(state),
      servers: sim.servers(state),
      serverOptions: sim.serverOptions(state),
      managed: sim.managed(state),
      racks: sim.racks(state),
      powerAndCooling: sim.powerAndCooling(state.model),
      provider: sim.provider(state),
      uptime: sim.uptime(state),
      outageDays: state.outageDays,
      monthlyInfrastructureCost: sim.monthlyInfrastructureCost(state),
      monthlyAddonCost: sim.monthlyAddonCost(state),
      spend: state.spend,
      interestPaid: state.interestPaid,
      loan: sim.loan(state),
      loanQuote: sim.loanQuote(state),
      runway: sim.runway(state),
      valuation: sim.valuation(state),
      capTable: sim.capTable(state),
      funding: sim.funding(state),
      investors: sim.investors(state),
      payReview: sim.payReview(state),
      lastPayReview: state.pastPayReviews.at(-1) ?? null,
      payMultiplier: state.payMultiplier,
      staffSchemes: sim.staffSchemes(state),
      payHistory: sim.payHistory(state),
      csuite: sim.csuite(state),
      drift: sim.drift(state),
      ipo: sim.ipo(state),
      rescue: sim.rescue(state),
      features: sim.features(state),
      migration: sim.migration(state),
      migrations: state.migrations,
      events: sim.events(state),
      danger: sim.danger(state),
      calendar: sim.calendar(state),
      featureGaps: sim.featureGaps(state),
      api: sim.api(state),
    };
  }

  const columnsFor = (sim: Sim, state: GameState) => ({
    model: state.model,
    day: state.day,
    cash: state.cash,
    users: state.users,
    uptime: sim.uptime(state),
    migratingTo: state.migration?.to ?? null,
    // Denormalised for the dashboard, like cash: "liquidated" or "finished" once the game is over.
    ...(state.status !== "playing" && { status: state.status }),
    state,
  });

  /** Only games from this version, which can still be played, count towards a code's limit. */
  const currentVersion = sql`(${companies.state}->>'version')::int = ${GAME_STATE_VERSION}`;

  async function findCode(code: string) {
    if (!CODE_PATTERN.test(code)) return undefined;
    const [row] = await db.select().from(loginCodes).where(eq(loginCodes.code, code));
    return row && !row.archived ? row : undefined;
  }

  // --- public ---

  // For the container's HEALTHCHECK and the deploy smoke check: up, and can reach the database.
  app.get("/api/health", async () => {
    await db.execute(sql`select 1`);
    return { ok: true };
  });

  // The numbers a game shows come from its own config: the current one for a new game, or the one a game started with.
  // Timed flow is how the class plays rather than a game's numbers, so it follows the active preset (`current`): the
  // teacher switching it off reaches games already being played.
  function metaFor(config: GameConfig, current: GameConfig): MetaView {
    const sim = simFor(config);
    return {
      startingCash: config.startingCash,
      finalDay: config.finalDay,
      gameLengths: allowedGameLengths(config).map((id) => ({
        id,
        name: gameLengthName(config, id),
        finalDay: gameLengthDays(config, id),
      })),
      difficulties: allowedDifficulties(config).map((id) => ({
        id,
        name: DIFFICULTIES[id].name,
        blurb: DIFFICULTIES[id].blurb,
        startingCash: withDifficulty(config, id).startingCash,
      })),
      maxCompanyNameLength: config.maxCompanyNameLength,
      maxActiveCompanies,
      timedFlow: timedFlowView(timedFlow, current.timedFlow === 1),
      productTypes: PRODUCT_TYPE_IDS.map((id) => {
        const { name, profile, features, demand } = config.productTypes[id];
        return {
          id,
          name,
          profile,
          perUserFeeMultiplier: demand.perUserFeeMultiplier,
          features: features.map((f) => ({ id: f.id, name: f.name, addonPricePerUser: f.addonPricePerUser })),
        };
      }),
      models: MODEL_IDS.map((id) => {
        const { name, blurb, comparison, monthlyCost, monthlyCostPerUser, powerAndCooling } = config.models[id];
        const stack = responsibilityStack(id);
        const opsNeeded = sim.opsNeeded(id);
        // On-prem's is the server room, with its rack and cabling: the kit is bought on top, one server at a time.
        const upfrontCost = sim.upfrontCost(id);
        return { id, name, blurb, comparison, stack, opsNeeded, upfrontCost, monthlyCost, monthlyCostPerUser, powerAndCooling };
      }),
      staff: STAFF_POOLS.map((id) => {
        const { name, personName, dayRate } = config.staff[id];
        return { id, name, personName, dayRate };
      }),
      grades: STAFF_GRADES.map((id) => ({ id, ...config.staffGrades[id] })),
      agency: config.agency,
      severanceDays: config.severance.days,
      minConfigDevelopers: config.addons.minConfigDevelopers,
      ticketsPerPerson: config.support.ticketsPerPerson,
      reportsPerPerson: config.moderation.reportsPerPerson,
      goodSatisfaction: config.support.goodSatisfaction,
      poorSatisfaction: config.support.poorSatisfaction,
      maxPrice: config.pricing.maxPrice,
      priceWaveDays: config.pricing.waveDays,
      priceLockDays: config.pricing.lockDays,
      conversionUptimeDays: config.conversion.uptimeDays,
      loadBalancerFrom: config.servers.loadBalancerFrom,
      cacheableShare: config.servers.cacheableShare,
      maxPerformance: config.hardware.maxPerformance,
      migrationPhases: MIGRATION_PHASES.map((id) => ({ id, ...config.migration.phases[id] })),
      startLoan: sim.startLoanQuote(),
      shares: { ...config.shares },
    };
  }

  // What a game started now would use.
  app.get("/api/meta", async (): Promise<MetaView> => {
    const { config } = await newGameSetup();
    return metaFor(config, config);
  });

  // --- student (identified by login code) ---

  app.get<{ Params: { code: string } }>("/api/codes/:code", async (req, reply) => {
    const code = await findCode(req.params.code);
    if (!code) return sendError(reply, 404, "unknown_code", "That code wasn't recognised. Check it with your teacher.");
    const rows = await db
      .select()
      .from(companies)
      .where(eq(companies.loginCode, code.code))
      .orderBy(desc(companies.updatedAt));
    // Games from an older version can't be shown, so they're left out rather than breaking the whole list.
    const current = rows.filter((r) => isCurrentState(r.state));
    return { code: code.code, companies: current.map((r) => view(r)) } satisfies CodeView;
  });

  app.post<{ Params: { code: string }; Body: NewCompanyBody }>(
    "/api/codes/:code/companies",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "productType", "model"],
          properties: {
            name: { type: "string" },
            productType: { type: "string" },
            model: { type: "string" },
            takeLoan: { type: "boolean" },
            // Shares in issue at the start. The sim checks it's in the game's range.
            shares: { type: "integer" },
            gameLength: { type: "string" },
            difficulty: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const code = await findCode(req.params.code);
      if (!code) return sendError(reply, 404, "unknown_code", "That code wasn't recognised. Check it with your teacher.");
      const { name, productType, model, takeLoan = false, gameLength, difficulty, shares } = req.body;
      // Locks the code so two creates at once can't both see room under the limit. Only games still being played
      // count: finished, liquidated and retired ones are history. Archiving is only the teacher's view, so it doesn't
      // change what counts.
      const row = await db.transaction(async (tx) => {
        await tx.select().from(loginCodes).where(eq(loginCodes.code, code.code)).for("update");
        const [counted] = await tx
          .select({ active: count() })
          .from(companies)
          .where(and(eq(companies.loginCode, code.code), eq(companies.status, "active"), currentVersion));
        if (counted!.active >= maxActiveCompanies) return undefined;
        // The game keeps the config it starts with, and the name of the preset it came from, whatever the teacher
        // changes later.
        const { preset, config } = await newGameSetup(tx);
        const sim = simFor(config);
        const state = sim.newGame({
          companyName: name,
          productType,
          model,
          seed: randomInt(2 ** 31),
          takeLoan,
          gameLength,
          difficulty,
          shares,
          ...startsOn(),
        });
        const [inserted] = await tx
          .insert(companies)
          .values({
            loginCode: code.code,
            name: state.companyName,
            productType: state.productType,
            config,
            preset,
            ...columnsFor(sim, state),
          })
          .returning();
        return inserted!;
      });
      if (!row) {
        return sendError(
          reply,
          409,
          "too_many_active",
          `You already have ${maxActiveCompanies} active companies, the most you can have at once. Retire one to start another.`,
        );
      }
      const company = view(row);
      const started = {
        productType,
        model,
        takeLoan,
        gameLength: company.gameLength,
        difficulty: company.difficulty,
        shares: company.capTable.sharesInIssue,
        preset: row.preset,
      };
      logGame(row, company.day, "start", started, company);
      return reply.code(201).send(company);
    },
  );

  app.get<{ Params: { code: string; id: string } }>("/api/codes/:code/companies/:id", async (req, reply) => {
    const row = await findCompany(req.params.code, req.params.id);
    if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
    return view(row);
  });

  // The numbers this game shows: from the config it started with.
  app.get<{ Params: { code: string; id: string } }>("/api/codes/:code/companies/:id/meta", async (req, reply) => {
    const row = await findCompany(req.params.code, req.params.id);
    if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
    return metaFor(simOf(row).config, (await newGameSetup()).config) satisfies MetaView;
  });

  // What migrating to the target would cost, for the confirm step. Changes nothing.
  app.get<{ Params: { code: string; id: string }; Querystring: { target: string } }>(
    "/api/codes/:code/companies/:id/migration-quote",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["target"],
          properties: { target: { enum: [...MODEL_IDS] } },
        },
      },
    },
    async (req, reply) => {
      const row = await findCompany(req.params.code, req.params.id);
      if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
      return simOf(row).migrationQuote(row.state, req.query.target) satisfies MigrationQuoteView;
    },
  );

  // What a new price would do, for the price modal's live preview. Changes nothing.
  app.get<{ Params: { code: string; id: string }; Querystring: { price: number; rate?: number } }>(
    "/api/codes/:code/companies/:id/price-preview",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["price"],
          // The sim checks them against the game's highest price and rate. A £0 fee is only allowed with a rate, on
          // the payments app, and only it takes a rate: the sim refuses either elsewhere.
          properties: { price: { type: "number", minimum: 0 }, rate: { type: "number", minimum: 0 } },
        },
      },
    },
    async (req, reply) => {
      const row = await findCompany(req.params.code, req.params.id);
      if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
      return simOf(row).pricePreview(row.state, req.query.price, req.query.rate) satisfies PricePreviewView;
    },
  );

  // What a counter to a funder's offer would do, for the negotiation modal's live odds. Changes nothing.
  app.get<{
    Params: { code: string; id: string };
    Querystring: { funder: FunderId; amount?: number; share?: number; days?: number };
  }>(
    "/api/codes/:code/companies/:id/counter-odds",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["funder"],
          // The sim checks the terms are the funder's, and how far they ask.
          properties: { funder: { enum: [...FUNDER_IDS] }, ...COUNTER_TERMS },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const row = await findCompany(req.params.code, req.params.id);
      if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
      const { funder, ...terms } = req.query;
      return simOf(row).counterOdds(row.state, funder, terms) satisfies CounterOddsView;
    },
  );

  // What a counter to an investor's open approach would do, for the negotiation modal's live odds. Changes nothing.
  app.get<{ Params: { code: string; id: string }; Querystring: { amount?: number; share?: number } }>(
    "/api/codes/:code/companies/:id/investor-odds",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { amount: COUNTER_TERMS.amount, share: COUNTER_TERMS.share },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const row = await findCompany(req.params.code, req.params.id);
      if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
      return simOf(row).investorCounterOdds(row.state, req.query) satisfies CounterOddsView;
    },
  );

  // What offering staff a rise, and any staff scheme levels, in the open pay review would do, for the pay review
  // modal's live cost, worth to staff and odds. Changes nothing.
  app.get<{ Params: { code: string; id: string }; Querystring: { rise: number } & Partial<SchemeLevels> }>(
    "/api/codes/:code/companies/:id/pay-offer",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["rise"],
          properties: { rise: { type: "number", minimum: 0, maximum: 1 }, ...SCHEME_LEVELS },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const row = await findCompany(req.params.code, req.params.id);
      if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
      const { rise, ...schemes } = req.query;
      return simOf(row).payOfferPreview(row.state, rise, schemes) satisfies PayOfferView;
    },
  );

  // How the company did: shown when the game ends, and available any time as a summary so far.
  app.get<{ Params: { code: string; id: string } }>("/api/codes/:code/companies/:id/summary", async (req, reply) => {
    const row = await findCompany(req.params.code, req.params.id);
    if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
    return simOf(row).summarise(row.state) satisfies SummaryView;
  });

  app.post<{ Params: { code: string; id: string } }>("/api/codes/:code/companies/:id/continue", async (req, reply) => {
    // One tick: a day, or a week in a career, stopping on the day something needs the student.
    const result = await updateCompany(req.params.code, req.params.id, "continue", {}, (sim, state) => sim.tick(state));
    if (!result) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
    const { company, log, days, pauses } = result;
    return { company, log, days, pauses } satisfies ContinueResult;
  });

  app.post<{ Params: { code: string; id: string }; Body: ActionBody }>(
    "/api/codes/:code/companies/:id/actions",
    {
      schema: {
        body: {
          type: "object",
          required: ["type"],
          properties: {
            type: {
              enum: [
                "hire",
                "letGo",
                "cancelHire",
                "letGoAgency",
                "buildFeature",
                "buyAddon",
                "setOptimisation",
                "moveStaff",
                "startMigration",
                "setPrice",
                "rentServer",
                "cancelServer",
                "buyServer",
                "sellServer",
                "buyRack",
                "sellRack",
                "setInstances",
                "setManagedService",
                "takeLoan",
                "acceptFunding",
                "declineFunding",
                "counterFunding",
                "autoNegotiateFunding",
                "acceptInvestor",
                "declineInvestor",
                "counterInvestor",
                "autoNegotiateInvestor",
                "pickInvestor",
                "buyBack",
                "launch",
                "buyApi",
                "switchServer",
                "setApiInstances",
                "repayLoan",
                "applyForIpo",
                "ringBell",
                "buyBenefit",
                "cancelBenefit",
                "setPerformance",
                "unlockItem",
                "startCampaign",
                "stopCampaign",
                "offerPayRise",
                "autoNegotiatePay",
                "acceptPayCounter",
                "hireExecutive",
              ],
            },
            // letGoAgency: one pool, or every pool if left out.
            pool: { enum: [...STAFF_POOLS] },
            // hire, letGo, cancelHire and moveStaff: the grade, mid if left out.
            grade: { enum: [...STAFF_GRADES] },
            // hire, letGo and cancelHire: agency staff rather than permanent, false if left out.
            agency: { type: "boolean" },
            // Checked against the product's list by the sim.
            feature: { type: "string", maxLength: 64 },
            // buyBenefit and cancelBenefit: a model benefit, by id. Checked against the config's list by the sim.
            benefit: { type: "string", maxLength: 64 },
            // unlockItem: a feature or model benefit in a tier, by id. Checked against the config's lists by the sim.
            item: { type: "string", maxLength: 64 },
            // startCampaign: the customer type it aims at, its budget in pounds and its length in days. The sim checks
            // them against the config's limits.
            customerType: { enum: [...CUSTOMER_TYPE_IDS] },
            budget: { type: "integer", minimum: 0 },
            days: { type: "integer", minimum: 1, maximum: 3650 },
            // setPerformance: an on-prem server's hardware slider, as a share of its normal capacity. The sim checks
            // it's within the configured top.
            performance: { type: "number", minimum: 0, maximum: 10 },
            // moveStaff: the pool one person moves into, and optionally the one they leave.
            to: { enum: [...STAFF_POOLS] },
            from: { enum: [...STAFF_POOLS] },
            // startMigration: the model to move to.
            model: { enum: [...MODEL_IDS] },
            // setPrice: the monthly price, and on the payments app the share of each payment taken, set together. The
            // sim checks them against the game's highest, refuses a rate on other products, and a £0 price without one.
            price: { type: "number", minimum: 0 },
            rate: { type: "number", minimum: 0 },
            // rentServer and buyServer: the type and size of server. The sim checks the model rents or buys them.
            // setManagedService uses size too, where null turns the cache off; it's refused for the others below.
            server: { enum: [...SERVER_TYPES] },
            size: { enum: [...SERVER_SIZES, null] },
            // buyRack uses size too, for the rack's size: the sim checks it's one racks come in.
            // cancelServer, sellServer and switchServer: one of the company's servers, by id; sellRack, one of its racks.
            // The sim checks it's theirs.
            id: { type: "integer", minimum: 1 },
            // buyServer: the rack to install it in, by id. Left out, it goes in the first with room.
            rack: { type: "integer", minimum: 1 },
            // switchServer: whether the app server gives CU or APIU.
            gives: { enum: ["cu", "apiu"] },
            // setInstances: how many app instances to run on PaaS, and setApiInstances how many API instances (which
            // can be none). The sim checks it against the platform's most.
            // hire, letGo and cancelHire: how many people at once, one if left out. Capped so a typo can't hire thousands.
            count: { type: "integer", minimum: 0, maximum: 999 },
            // setManagedService: a managed service on PaaS and its size, or null to turn the cache off.
            service: { enum: [...MANAGED_SERVICES] },
            // acceptFunding, declineFunding, counterFunding and autoNegotiateFunding: friends and family or the grant.
            funder: { enum: [...FUNDER_IDS] },
            // pickInvestor: the VC to negotiate with, by name. The sim checks they're one of the three who approached.
            investor: { type: "string", minLength: 1, maxLength: 80 },
            // ringBell: the float, as a share of the company after the IPO. The sim checks it's in the allowed range.
            float: { type: "number", minimum: 0, maximum: 1 },
            // setOptimisation: the share of developer output on optimisation rather than features.
            share: { type: "number", minimum: 0, maximum: 1 },
            // offerPayRise and autoNegotiatePay: the rise offered, 0.04 = 4%. The sim checks it against the review's caps.
            rise: { type: "number", minimum: 0, maximum: 1 },
            // offerPayRise and autoNegotiatePay: staff scheme levels offered with it, by scheme. The sim checks none goes down.
            schemes: { type: "object", properties: SCHEME_LEVELS, additionalProperties: false },
            // hireExecutive: the C-suite role, and the candidate from its shortlist by id ("cfo-2"). The sim checks the
            // role is open and unfilled and the candidate is on its shortlist.
            role: { enum: [...CSUITE_ROLES] },
            candidate: { type: "string", minLength: 1, maxLength: 64 },
            // counterFunding, counterInvestor and their auto-negotiate: the terms asked for. The sim checks they're the offer's and how far they ask.
            terms: { type: "object", properties: COUNTER_TERMS, additionalProperties: false },
          },
          allOf: [
            { if: { properties: { type: { enum: ["hire", "letGo", "cancelHire"] } } }, then: { required: ["pool"] } },
            { if: { properties: { type: { enum: ["buildFeature", "buyAddon"] } } }, then: { required: ["feature"] } },
            { if: { properties: { type: { const: "moveStaff" } } }, then: { required: ["to"] } },
            { if: { properties: { type: { const: "startMigration" } } }, then: { required: ["model"] } },
            { if: { properties: { type: { const: "setPrice" } } }, then: { required: ["price"] } },
            { if: { properties: { type: { enum: ["rentServer", "buyServer"] } } }, then: { required: ["server", "size"] } },
            { if: { properties: { type: { enum: ["cancelServer", "sellServer", "sellRack"] } } }, then: { required: ["id"] } },
            { if: { properties: { type: { const: "buyRack" } } }, then: { required: ["size"] } },
            { if: { properties: { type: { const: "setInstances" } } }, then: { required: ["count"] } },
            { if: { properties: { type: { enum: ["acceptFunding", "declineFunding"] } } }, then: { required: ["funder"] } },
            { if: { properties: { type: { enum: ["counterFunding", "autoNegotiateFunding"] } } }, then: { required: ["funder", "terms"] } },
            { if: { properties: { type: { enum: ["counterInvestor", "autoNegotiateInvestor"] } } }, then: { required: ["terms"] } },
            { if: { properties: { type: { const: "pickInvestor" } } }, then: { required: ["investor"] } },
            { if: { properties: { type: { enum: ["hire", "letGo", "cancelHire", "setInstances"] } } }, then: { properties: { count: { type: "integer", minimum: 1 } } } },
            { if: { properties: { type: { const: "setApiInstances" } } }, then: { required: ["count"] } },
            { if: { properties: { type: { const: "switchServer" } } }, then: { required: ["id", "gives"] } },
            { if: { properties: { type: { const: "ringBell" } } }, then: { required: ["float"] } },
            { if: { properties: { type: { const: "setOptimisation" } } }, then: { required: ["share"] } },
            { if: { properties: { type: { enum: ["buyBenefit", "cancelBenefit"] } } }, then: { required: ["benefit"] } },
            { if: { properties: { type: { const: "setPerformance" } } }, then: { required: ["id", "performance"] } },
            { if: { properties: { type: { const: "unlockItem" } } }, then: { required: ["item"] } },
            { if: { properties: { type: { const: "startCampaign" } } }, then: { required: ["customerType", "budget", "days"] } },
            { if: { properties: { type: { const: "stopCampaign" } } }, then: { required: ["id"] } },
            { if: { properties: { type: { enum: ["offerPayRise", "autoNegotiatePay"] } } }, then: { required: ["rise"] } },
            { if: { properties: { type: { const: "hireExecutive" } } }, then: { required: ["role", "candidate"] } },
            {
              if: { properties: { type: { const: "setManagedService" } } },
              then: { required: ["service", "size"] },
              else: { properties: { size: { enum: [...SERVER_SIZES] } } },
            },
          ],
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { type, ...params } = req.body;
      const result = await updateCompany(req.params.code, req.params.id, type, params, (sim, state) => ({
        state: sim.applyAction(state, req.body),
      }));
      if (!result) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
      return result.company;
    },
  );

  // Moves an active company to history: it can still be viewed, with its summary, but not played.
  app.post<{ Params: { code: string; id: string } }>("/api/codes/:code/companies/:id/retire", async (req, reply) => {
    const { code, id } = req.params;
    if (!UUID_PATTERN.test(id) || !(await findCode(code))) {
      return sendError(reply, 404, "unknown_company", "That company wasn't found.");
    }
    // Locks the row so a Continue in another tab can't finish the game while it's being retired.
    const row = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(companies).where(companyWhere(code, id)).for("update");
      if (current?.status !== "active") return current;
      const [updated] = await tx
        .update(companies)
        .set({ status: "retired", updatedAt: new Date() })
        .where(eq(companies.id, current.id))
        .returning();
      return updated;
    });
    if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
    if (row.status !== "retired") {
      return sendError(reply, 409, "not_active", `${row.name} has already ended, so it's in your history.`);
    }
    const company = view(row);
    logGame(row, company.day, "end", { status: "retired" }, company);
    return company;
  });

  // A batch of UI events from the game page: pages visited, modals, previews and quotes, controls used. The browser
  // never waits on the write or shows an error for it.
  // Counts every batch, not only failures: UI_BATCHES_PER_MINUTE per company.
  const uiBatches = new FailureLimiter(opts.uiBatchesPerMinute ?? UI_BATCHES_PER_MINUTE, 60 * 1000);
  app.post<{ Params: { code: string; id: string }; Body: UiEventsBody }>(
    "/api/codes/:code/companies/:id/ui-events",
    {
      bodyLimit: UI_BATCH_BYTES,
      schema: {
        body: {
          type: "object",
          required: ["events"],
          properties: {
            events: {
              type: "array",
              minItems: 1,
              maxItems: UI_EVENTS_PER_BATCH,
              items: {
                type: "object",
                required: ["type", "ago", "day"],
                properties: {
                  type: { enum: ["page", "modal", "pricePreview", "quote", "control"] },
                  ago: { type: "integer", minimum: 0 },
                  day: { type: "integer", minimum: 0 },
                  // Ids from the game's own UI only, so nothing a student typed (but a price) can be stored.
                  params: {
                    type: "object",
                    properties: {
                      page: { type: "string", pattern: "^[a-z][a-z-]{0,23}$" },
                      modal: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,47}$" },
                      ms: { type: "integer", minimum: 0 },
                      prices: { type: "array", maxItems: 20, items: { type: "number", minimum: 0 } },
                      confirmed: { type: "boolean" },
                      kind: { enum: ["migration", "loan", "friendsAndFamily", "grant", "angel", "vc"] },
                      target: { enum: [...MODEL_IDS] },
                      control: { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$" },
                      value: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,23}$" },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { code, id } = req.params;
      if (!CODE_PATTERN.test(code) || !UUID_PATTERN.test(id)) {
        return sendError(reply, 404, "unknown_company", "That company wasn't found.");
      }
      const wait = uiBatches.retryAfter(id);
      if (wait) {
        reply.header("retry-after", String(wait));
        return sendError(reply, 429, "rate_limited", "Too many UI events from this game. Wait a minute.");
      }
      const [row] = await db
        .select({ id: companies.id, day: companies.day })
        .from(companies)
        .innerJoin(loginCodes, eq(loginCodes.code, companies.loginCode))
        .where(and(companyWhere(code, id), eq(loginCodes.archived, false)));
      if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
      uiBatches.fail(id);
      const now = Date.now();
      playLog.record(
        ...req.body.events.map(
          (e): PlayEventRow => ({
            companyId: row.id,
            at: new Date(now - Math.min(e.ago, UI_EVENT_MAX_AGE_MS)),
            day: Math.min(e.day, row.day),
            kind: "ui",
            type: e.type,
            params: { ...e.params },
          }),
        ),
      );
      return reply.code(204).send();
    },
  );

  /** Queues a game event for a company, with its key numbers from the view the request built. Never throws. */
  function logGame(
    row: Pick<CompanyRow, "id">,
    day: number,
    type: string,
    params: object,
    company: CompanyView | undefined,
    error?: string,
  ) {
    try {
      playLog.record({
        companyId: row.id,
        at: new Date(),
        day,
        kind: "game",
        type,
        ok: !error,
        error: error ?? null,
        params: params as Record<string, unknown>,
        snapshot: company ? { ...snapshotOf(company) } : null,
      });
    } catch (err) {
      app.log.warn({ err }, "Couldn't log a game event.");
    }
  }

  /**
   * Runs a sim step against a company's saved state and stores the result.
   * Locks the row so two tabs can't both change it from the same starting point.
   * Returns undefined if the company isn't under that code. A SimError rolls back and becomes a 400.
   * Either way the playtest log gets the step as `type` with its params, written after the response.
   */
  async function updateCompany<T extends { state: GameState }>(
    code: string,
    id: string,
    type: string,
    params: object,
    step: (sim: Sim, state: GameState) => T,
  ): Promise<(T & { company: CompanyView }) | undefined> {
    if (!CODE_PATTERN.test(code) || !UUID_PATTERN.test(id)) return undefined;
    // The row as read, to log a step the game refused.
    const read: { row?: CompanyRow; sim?: Sim } = {};
    try {
      const result = await db.transaction(async (tx) => {
        const [row] = await companyUnderCode(tx, code, id).for("update", { of: companies });
        if (!row) return undefined;
        read.row = row;
        if (row.status === "retired") {
          throw new SimError("retired", `${row.name} was retired, so this game is over. Start a new company to play again.`);
        }
        const sim = (read.sim = simOf(row));
        const before = sim.load(row.state);
        const result = step(sim, before);
        const columns = { ...columnsFor(sim, result.state), updatedAt: new Date() };
        await tx.update(companies).set(columns).where(eq(companies.id, row.id));
        // The row as saved is the one read with these columns changed, so it isn't read back: that would fetch the
        // state and config just written.
        return { result, before, company: view({ ...row, ...columns }, sim) };
      });
      if (!result) return undefined;
      const { before, company } = result;
      // A Continue's params are the scripted events that hit that day, if any.
      const events = company.events.map((e) => e.id);
      logGame(company, before.day, type, type === "continue" && events.length ? { events } : params, company);
      if (before.status === "playing" && result.result.state.status !== "playing") {
        logGame(company, company.day, "end", { status: result.result.state.status }, company);
      }
      return { ...result.result, company };
    } catch (err) {
      // A game too old to load can't be played or shown, so there's nothing useful to log.
      if (err instanceof SimError && err.code !== OLD_VERSION && read.row) {
        logGame(read.row, read.row.day, type, params, viewOrNothing(read.row, read.sim), err.code);
      }
      throw err;
    }
  }

  function viewOrNothing(row: CompanyRow, sim?: Sim) {
    try {
      return view(row, sim);
    } catch {
      return undefined;
    }
  }

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function companyWhere(code: string, id: string) {
    return and(eq(companies.id, id), eq(companies.loginCode, code));
  }

  /**
   * A company under a code that's still in use: as findCode then a select, in one round trip. Every student request
   * starts with it.
   */
  function companyUnderCode(q: Pick<Db, "select">, code: string, id: string) {
    return q
      .select(getTableColumns(companies))
      .from(companies)
      .innerJoin(loginCodes, eq(loginCodes.code, companies.loginCode))
      .where(and(companyWhere(code, id), eq(loginCodes.archived, false)));
  }

  async function findCompany(code: string, id: string) {
    if (!CODE_PATTERN.test(code) || !UUID_PATTERN.test(id)) return undefined;
    const [row] = await companyUnderCode(db, code, id);
    return row;
  }

  // --- teacher ---

  app.post<{ Body: { password: string } }>(
    "/api/teacher/login",
    {
      schema: {
        body: { type: "object", required: ["password"], properties: { password: { type: "string" } } },
      },
    },
    async (req, reply) => {
      if (!passwordMatches(req.body.password, opts.teacherPassword)) {
        return sendError(reply, 401, "wrong_password", "That password isn't right.");
      }
      startTeacherSession(reply);
      return { ok: true };
    },
  );

  app.post("/api/teacher/logout", async (_req, reply) => {
    endTeacherSession(reply);
    return { ok: true };
  });

  app.register(async (teacher) => {
    teacher.addHook("onRequest", async (req, reply) => {
      if (!isTeacher(req)) return sendError(reply, 401, "not_signed_in", "Sign in to the staff dashboard first.");
    });

    teacher.get("/api/teacher/me", async () => ({ ok: true }));

    teacher.get("/api/teacher/codes", async (): Promise<TeacherCodeView[]> => {
      const rows = await db
        .select({ code: loginCodes.code, createdAt: loginCodes.createdAt, companyCount: count(companies.id) })
        .from(loginCodes)
        .leftJoin(companies, eq(companies.loginCode, loginCodes.code))
        .where(eq(loginCodes.archived, false))
        .groupBy(loginCodes.code)
        .orderBy(desc(loginCodes.createdAt));
      return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    });

    teacher.post("/api/teacher/codes", async (_req, reply) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const code = String(randomInt(10_000_000, 100_000_000));
        const [row] = await db.insert(loginCodes).values({ code }).onConflictDoNothing().returning();
        if (row) {
          return reply
            .code(201)
            .send({ code: row.code, createdAt: row.createdAt.toISOString(), companyCount: 0 } satisfies TeacherCodeView);
        }
      }
      return sendError(reply, 500, "code_generation_failed", "Couldn't create a unique code. Try again.");
    });

    // The live dashboard: recent games grouped by code, read from the denormalised columns rather than each state. With
    // archived=true, every archived game and code instead, however old.
    teacher.get<{ Querystring: { hours?: number; archived?: boolean } }>(
      "/api/teacher/games",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              hours: { type: "integer", minimum: 1, maximum: MAX_DASHBOARD_HOURS },
              archived: { type: "boolean" },
            },
          },
        },
      },
      async (req): Promise<TeacherGamesView> => {
        const hours = req.query.archived ? null : (req.query.hours ?? dashboardHours);
        const where = hours
          ? and(
              gte(companies.updatedAt, new Date(Date.now() - hours * 3600 * 1000)),
              isNull(companies.archivedAt),
              eq(loginCodes.archived, false),
            )
          : or(isNotNull(companies.archivedAt), eq(loginCodes.archived, true));
        // From the codes, so an archived code with no games still shows in the archived view.
        const rows = await db
          .select({
            code: loginCodes.code,
            codeArchived: loginCodes.archived,
            game: {
              id: companies.id,
              name: companies.name,
              productType: companies.productType,
              model: companies.model,
              migratingTo: companies.migratingTo,
              day: companies.day,
              cash: companies.cash,
              users: companies.users,
              uptime: companies.uptime,
              status: companies.status,
              updatedAt: companies.updatedAt,
              archivedAt: companies.archivedAt,
              // The game's own, so a game keeps the length it started with: null until IPO. A game from before game
              // lengths has its config's.
              finalDay: sql<number | null>`case when ${companies.state}->>'gameLength' = 'until-ipo' then null else coalesce((${companies.state}->>'finalDay')::int, (${companies.config}->>'finalDay')::int, ${base.finalDay}) end`,
              endedByTeacher: sql<boolean | null>`(${companies.state}->>'endedByTeacher')::boolean`,
              preset: companies.preset,
              player: companies.player,
            },
            // The money and customer figures, read from small parts of the state rather than all of it.
            money: {
              income: sql<number | null>`(${companies.state}->>'income')::double precision`,
              spend: sql<Partial<Spend> | null>`${companies.state}->'spend'`,
              lastDayIncome: sql<number | null>`(${companies.state}->'spendByDay'->-1->>'income')::double precision`,
              paidUsers: sql<number | null>`(${companies.state}->>'paidUsers')::int`,
              satisfaction: sql<number | null>`(${companies.state}->>'satisfaction')::double precision`,
              loan: sql<Loan | null>`${companies.state}->'loan'`,
              interestPaid: sql<number | null>`(${companies.state}->>'interestPaid')::double precision`,
            },
          })
          .from(loginCodes)
          .leftJoin(companies, eq(companies.loginCode, loginCodes.code))
          .where(where)
          .orderBy(desc(loginCodes.createdAt), asc(companies.createdAt));
        const codes = new Map<string, TeacherGamesView["codes"][number]>();
        for (const { code, codeArchived, game: g, money: m } of rows) {
          if (!codes.has(code)) codes.set(code, { code, archived: codeArchived, companies: [] });
          if (!g) continue;
          const income = m.income ?? 0;
          const spend = Object.fromEntries(SPEND_CATEGORIES.map((c) => [c, m.spend?.[c] ?? 0])) as Spend;
          const paidUsers = m.paidUsers ?? 0;
          codes.get(code)!.companies.push({
            ...g,
            productType: g.productType as TeacherGameView["productType"],
            model: g.model as TeacherGameView["model"],
            migratingTo: g.migratingTo as TeacherGameView["migratingTo"],
            status: g.status as CompanyStatus,
            finalDay: g.finalDay,
            endedByTeacher: g.endedByTeacher ?? false,
            updatedAt: g.updatedAt.toISOString(),
            archivedAt: g.archivedAt?.toISOString() ?? null,
            preset: g.preset ?? DEFAULT_PRESET,
            player: pseudonym(g.player),
            paidUsers,
            freeUsers: Math.max(0, g.users - paidUsers),
            lastDayIncome: m.lastDayIncome ?? 0,
            // As the summary's: only the loans' interest counts against profit. A game from before it was kept had
            // one loan, whose repayments were all debt.
            profit: income - profitCosts(spend, m.interestPaid ?? interestIn(m.loan, spend.debt)),
            satisfaction: Math.round(m.satisfaction ?? 100),
            loanRemaining: m.loan ? (m.loan.paidOffDay ? 0 : m.loan.total - m.loan.repaid) : null,
          });
        }
        return { hours, codes: [...codes.values()] };
      },
    );

    // Archiving only tidies the teacher's view: the game leaves the live dashboard for the Archived tab. The student
    // sees no change and can keep playing it, and it still counts towards the code's limit.
    teacher.post<{ Params: { id: string } }>("/api/teacher/companies/:id/archive", async (req, reply) => {
      if (!(await setGameArchived(req.params.id, true))) {
        return sendError(reply, 404, "unknown_company", "That company wasn't found.");
      }
      return { ok: true };
    });

    // Back to the live dashboard. A game under an archived code stays in the Archived tab until the code comes back.
    teacher.post<{ Params: { id: string } }>("/api/teacher/companies/:id/unarchive", async (req, reply) => {
      if (!(await setGameArchived(req.params.id, false))) {
        return sendError(reply, 404, "unknown_company", "That company wasn't found.");
      }
      return { ok: true };
    });

    teacher.delete<{ Params: { id: string } }>("/api/teacher/companies/:id", async (req, reply) => {
      const { id } = req.params;
      const [row] = UUID_PATTERN.test(id)
        ? await db.delete(companies).where(eq(companies.id, id)).returning({ id: companies.id })
        : [];
      if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
      return { ok: true };
    });

    // Archiving a code stops students using it, and takes it and all its games off the live dashboard. It leaves each
    // game's own archived flag alone, so unarchiving the code brings back the games that weren't archived on their own.
    teacher.post<{ Params: { code: string } }>("/api/teacher/codes/:code/archive", async (req, reply) => {
      if (!(await setCodeArchived(req.params.code, true))) {
        return sendError(reply, 404, "unknown_code", "That code wasn't found.");
      }
      return { ok: true };
    });

    teacher.post<{ Params: { code: string } }>("/api/teacher/codes/:code/unarchive", async (req, reply) => {
      if (!(await setCodeArchived(req.params.code, false))) {
        return sendError(reply, 404, "unknown_code", "That code wasn't found.");
      }
      return { ok: true };
    });

    // Deletes the code and, through the foreign key, every game under it.
    teacher.delete<{ Params: { code: string } }>("/api/teacher/codes/:code", async (req, reply) => {
      const { code } = req.params;
      const [row] = CODE_PATTERN.test(code)
        ? await db.delete(loginCodes).where(eq(loginCodes.code, code)).returning({ code: loginCodes.code })
        : [];
      if (!row) return sendError(reply, 404, "unknown_code", "That code wasn't found.");
      return { ok: true };
    });

    // Ends a game still being played, scored as it stands: it shows its summary from then on, to the student too.
    teacher.post<{ Params: { id: string } }>("/api/teacher/companies/:id/end", async (req, reply) => {
      const { id } = req.params;
      const [row] = UUID_PATTERN.test(id) ? await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id)) : [];
      if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
      return { ended: await endGames(eq(companies.id, id)) } satisfies EndGamesResult;
    });

    // Ends every game still being played under a code, such as at the end of a unit or before showing the leaderboard.
    teacher.post<{ Params: { code: string } }>("/api/teacher/codes/:code/end", async (req, reply) => {
      const { code } = req.params;
      const [row] = CODE_PATTERN.test(code)
        ? await db.select({ code: loginCodes.code }).from(loginCodes).where(eq(loginCodes.code, code))
        : [];
      if (!row) return sendError(reply, 404, "unknown_code", "That code wasn't found.");
      return { ended: await endGames(eq(companies.loginCode, code)) } satisfies EndGamesResult;
    });

    // Any company's summary. The teacher picks it from the dashboard, so it goes by id alone.
    teacher.get<{ Params: { id: string } }>("/api/teacher/companies/:id/summary", async (req, reply) => {
      const { id } = req.params;
      const [row] = UUID_PATTERN.test(id) ? await db.select().from(companies).where(eq(companies.id, id)) : [];
      if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
      const status = row.status as CompanyStatus;
      return {
        code: row.loginCode,
        status,
        preset: row.preset ?? DEFAULT_PRESET,
        player: pseudonym(row.player),
        summary: simOf(row).summarise(row.state),
      } satisfies TeacherSummaryView;
    });

    // --- playtest log ---

    // A company's events, oldest first, from its dashboard row or summary. kind narrows it to game or UI events.
    teacher.get<{ Params: { id: string }; Querystring: { kind?: PlayEventKind } }>(
      "/api/teacher/companies/:id/timeline",
      { schema: { querystring: { type: "object", properties: { kind: { enum: ["game", "ui"] } } } } },
      async (req, reply) => {
        const { id } = req.params;
        const [row] = UUID_PATTERN.test(id)
          ? await db
              .select({
                id: companies.id,
                name: companies.name,
                code: companies.loginCode,
                player: companies.player,
                tester: loginCodes.tester,
                preset: companies.preset,
                productType: companies.productType,
                status: companies.status,
              })
              .from(companies)
              .innerJoin(loginCodes, eq(loginCodes.code, companies.loginCode))
              .where(eq(companies.id, id))
          : [];
        if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
        await playLog.flush();
        const { kind } = req.query;
        const latest = await db
          .select()
          .from(playEvents)
          .where(and(eq(playEvents.companyId, row.id), kind ? eq(playEvents.kind, kind) : undefined))
          .orderBy(desc(playEvents.at), desc(playEvents.id))
          .limit(TIMELINE_MAX_EVENTS + 1);
        return {
          id: row.id,
          player: pseudonym(row.player),
          tester: testerId(row.tester),
          name: row.name,
          code: row.code,
          preset: row.preset ?? DEFAULT_PRESET,
          productType: row.productType as TimelineView["productType"],
          status: row.status as CompanyStatus,
          truncated: latest.length > TIMELINE_MAX_EVENTS,
          events: latest
            .slice(0, TIMELINE_MAX_EVENTS)
            .reverse()
            .map(
              (e): PlayEventView => ({
                id: e.id,
                at: e.at.toISOString(),
                day: e.day,
                kind: e.kind as PlayEventKind,
                type: e.type,
                ok: e.ok,
                error: e.error,
                params: e.params,
                snapshot: cleanSnapshot(e.snapshot as PlaySnapshot | null),
              }),
            ),
        } satisfies TimelineView;
      },
    );

    // Every event, or those of one code, preset, kind or time range, one row per event: CSV for a spreadsheet, JSON for
    // analysis. Companies appear by pseudonym alone: no names or codes.
    teacher.get<{
      Querystring: { format?: "csv" | "json"; code?: string; preset?: string; kind?: PlayEventKind; from?: string; to?: string };
    }>(
      "/api/teacher/logs/export",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              format: { enum: ["csv", "json"] },
              code: { type: "string", pattern: "^\\d{8}$" },
              preset: { type: "string", maxLength: MAX_PRESET_NAME_LENGTH },
              kind: { enum: ["game", "ui"] },
              // Instants, as ISO 8601: the page sends the start of the first day and the end of the last in the
              // teacher's own time zone.
              from: { type: "string", maxLength: 40 },
              to: { type: "string", maxLength: 40 },
            },
            additionalProperties: false,
          },
        },
      },
      async (req, reply) => {
        const { format = "csv", code, preset, kind } = req.query;
        const [from, to] = [req.query.from, req.query.to].map((t) => (t === undefined ? undefined : new Date(t)));
        if ([from, to].some((d) => d && Number.isNaN(d.getTime()))) {
          return sendError(reply, 400, "bad_request", "Give the dates as ISO 8601, such as 2026-10-21T00:00:00Z.");
        }
        await playLog.flush();
        const rows = await db
          .select({
            event: playEvents,
            company: {
              tester: loginCodes.tester,
              player: companies.player,
              preset: companies.preset,
              productType: companies.productType,
            },
          })
          .from(playEvents)
          .innerJoin(companies, eq(companies.id, playEvents.companyId))
          .innerJoin(loginCodes, eq(loginCodes.code, companies.loginCode))
          .where(
            and(
              code ? eq(companies.loginCode, code) : undefined,
              preset ? sql`coalesce(${companies.preset}, ${DEFAULT_PRESET}) = ${preset}` : undefined,
              kind ? eq(playEvents.kind, kind) : undefined,
              from ? gte(playEvents.at, from) : undefined,
              to ? lte(playEvents.at, to) : undefined,
            ),
          )
          .orderBy(asc(playEvents.at), asc(playEvents.id));
        const out = rows.map(({ event: e, company: c }) =>
          exportRow(e, e.params, e.snapshot as Partial<PlaySnapshot> | null, {
            tester: c.tester,
            player: c.player,
            preset: c.preset ?? DEFAULT_PRESET,
            productType: c.productType,
          }),
        );
        if (kind !== "ui") out.push(...(await inferredEnds([...new Set(rows.map((r) => r.event.companyId))], to)));
        // Stable, so an inferred end follows the game's last event even at the same instant.
        out.sort((a, b) => a.at.localeCompare(b.at));
        const name = `playtest-log-${new Date().toISOString().slice(0, 10)}.${format}`;
        reply.header("content-disposition", `attachment; filename="${name}"`);
        if (format === "json") return reply.type("application/json; charset=utf-8").send(JSON.stringify(out));
        return reply.type("text/csv; charset=utf-8").send(toCsv(out));
      },
    );

    /**
     * An end row for each of these games that never logged one: mostly games the student just stopped playing without
     * retiring, which are "abandoned". Worked out at export, not stored, since the game could still be picked up again.
     * Each is at the game's last event, with its numbers as they are now, and is marked inferred. None after `to`.
     */
    async function inferredEnds(ids: string[], to: Date | undefined) {
      if (!ids.length) return [];
      const lastAt = sql<string>`(select max(${playEvents.at}) from ${playEvents} where ${playEvents.companyId} = ${companies.id})`;
      const unended = await db
        .select({ row: companies, tester: loginCodes.tester, lastAt })
        .from(companies)
        .innerJoin(loginCodes, eq(loginCodes.code, companies.loginCode))
        .where(
          and(
            inArray(companies.id, ids),
            sql`not exists (select 1 from ${playEvents} where ${playEvents.companyId} = ${companies.id} and ${playEvents.kind} = 'game' and ${playEvents.type} = 'end')`,
          ),
        );
      return unended
        .map(({ row, tester, lastAt }) => ({ row, tester, at: new Date(lastAt) }))
        .filter(({ at }) => !to || at <= to)
        .map(({ row, tester, at }) => {
          const company = isCurrentState(row.state) ? viewOrNothing(row) : undefined;
          return exportRow(
            { at, kind: "game", type: "end", ok: true, error: null, day: row.day },
            { status: row.status === "active" ? "abandoned" : row.status, inferred: true },
            company ? snapshotOf(company) : null,
            { tester, player: row.player, preset: row.preset ?? DEFAULT_PRESET, productType: row.productType },
          );
        });
    }

    // How much there is, for the logs panel.
    teacher.get("/api/teacher/logs", async (): Promise<LogStatsView> => {
      await playLog.flush();
      const [row] = await db
        .select({ events: count(), companies: sql<number>`count(distinct ${playEvents.companyId})::int` })
        .from(playEvents);
      return row!;
    });

    // Deleting logs leaves the games, and their pseudonyms, alone: only the events go.
    teacher.delete<{ Params: { id: string } }>("/api/teacher/companies/:id/logs", async (req, reply) => {
      const { id } = req.params;
      const [row] = UUID_PATTERN.test(id)
        ? await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id))
        : [];
      if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
      return deleteLogs(eq(playEvents.companyId, row.id));
    });

    teacher.delete<{ Params: { code: string } }>("/api/teacher/codes/:code/logs", async (req, reply) => {
      const { code } = req.params;
      const [row] = CODE_PATTERN.test(code)
        ? await db.select({ code: loginCodes.code }).from(loginCodes).where(eq(loginCodes.code, code))
        : [];
      if (!row) return sendError(reply, 404, "unknown_code", "That code wasn't found.");
      return deleteLogs(
        inArray(playEvents.companyId, db.select({ id: companies.id }).from(companies).where(eq(companies.loginCode, code))),
      );
    });

    teacher.delete("/api/teacher/logs", async () => deleteLogs(undefined));

    // Config presets: named sets of numbers for the game, each stored as the numbers that differ from the defaults.
    // Default is built in and read-only. The active preset is what games started from then on use; each game keeps
    // the config it started with, so changing or deleting a preset never touches a game already started.
    const READ_ONLY = "Default is built in and can't be changed. Save it as a new preset to make changes.";

    teacher.get("/api/teacher/presets", presetsView);

    teacher.get<{ Params: { id: string } }>("/api/teacher/presets/:id", async (req, reply) => {
      const row = await findPreset(req.params.id);
      if (row === undefined) return unknownPreset(reply);
      return presetView(row);
    });

    // A new preset: the overrides sent (the config page's current values), or a copy of another preset ("save as").
    teacher.post<{ Body: PresetCreateBody }>(
      "/api/teacher/presets",
      {
        schema: {
          // Values are checked by validateOverrides, for an error per field rather than the first one AJV finds.
          body: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" }, from: { type: "string" }, overrides: { type: "object" } },
            additionalProperties: false,
          },
        },
      },
      async (req, reply) => {
        const name = await checkName(reply, req.body.name);
        if (name === undefined) return reply;
        let overrides = req.body.overrides;
        if (overrides) {
          if (invalidConfig(reply, overrides)) return reply;
        } else {
          const from = await findPreset(req.body.from ?? DEFAULT_PRESET_ID);
          if (from === undefined) return unknownPreset(reply);
          overrides = from?.overrides ?? {};
        }
        const row = await db
          .insert(configPresets)
          .values({ name, overrides: cleaned(overrides) })
          .returning()
          .catch(nameTaken);
        if (!row) return sendError(reply, 409, "name_taken", takenMessage(name));
        return reply.code(201).send(await presetView(row[0]!));
      },
    );

    // Renames a preset, replaces its numbers, or both. Values equal to the default are dropped.
    teacher.patch<{ Params: { id: string }; Body: PresetUpdateBody }>(
      "/api/teacher/presets/:id",
      {
        schema: {
          body: {
            type: "object",
            properties: { name: { type: "string" }, overrides: { type: "object" } },
            additionalProperties: false,
            minProperties: 1,
          },
        },
      },
      async (req, reply) => {
        const row = await findPreset(req.params.id);
        if (row === undefined) return unknownPreset(reply);
        if (row === null) return sendError(reply, 403, "read_only", READ_ONLY);
        const { overrides } = req.body;
        const name = req.body.name === undefined ? row.name : await checkName(reply, req.body.name, row.id);
        if (name === undefined || (overrides && invalidConfig(reply, overrides))) return reply;
        const updated = await db
          .update(configPresets)
          .set({ name, ...(overrides && { overrides: cleaned(overrides) }), updatedAt: new Date() })
          .where(eq(configPresets.id, row.id))
          .returning()
          .catch(nameTaken);
        if (!updated) return sendError(reply, 409, "name_taken", takenMessage(name));
        return presetView(updated[0]!);
      },
    );

    // Neither Default nor the active preset can go: new games always have a preset to use.
    teacher.delete<{ Params: { id: string } }>("/api/teacher/presets/:id", async (req, reply) => {
      const row = await findPreset(req.params.id);
      if (row === undefined) return unknownPreset(reply);
      if (row === null) return sendError(reply, 403, "read_only", READ_ONLY);
      const [deleted] = await db
        .delete(configPresets)
        .where(and(eq(configPresets.id, row.id), eq(configPresets.active, false)))
        .returning({ id: configPresets.id });
      if (!deleted) {
        return sendError(
          reply,
          409,
          "preset_active",
          `New games use “${row.name}”. Make another preset active before deleting it.`,
        );
      }
      return presetsView();
    });

    // New games use this preset from now on. Making Default active leaves no row active.
    teacher.post<{ Params: { id: string } }>("/api/teacher/presets/:id/activate", async (req, reply) => {
      const row = await findPreset(req.params.id);
      if (row === undefined) return unknownPreset(reply);
      await db.transaction(async (tx) => {
        await tx.update(configPresets).set({ active: false }).where(eq(configPresets.active, true));
        if (row) await tx.update(configPresets).set({ active: true }).where(eq(configPresets.id, row.id));
      });
      return presetsView();
    });
  });

  /** Deletes the playtest events that match (all of them with no condition), after any still being written. */
  async function deleteLogs(where: SQL | undefined): Promise<LogDeleteResult> {
    await playLog.flush();
    const deleted = await db.delete(playEvents).where(where).returning({ id: playEvents.id });
    return { deleted: deleted.length };
  }

  /** A preset by id: its row, null for Default, or undefined if there's no such preset. */
  async function findPreset(id: string): Promise<PresetRow | null | undefined> {
    if (id === DEFAULT_PRESET_ID) return null;
    if (!UUID_PATTERN.test(id)) return undefined;
    const [row] = await db.select().from(configPresets).where(eq(configPresets.id, id));
    return row;
  }

  const unknownPreset = (reply: FastifyReply) => sendError(reply, 404, "unknown_preset", "That preset wasn't found.");

  function presetSummary(row: PresetRow | null, anyActive: boolean): PresetSummaryView {
    if (!row) {
      return { id: DEFAULT_PRESET_ID, name: DEFAULT_PRESET, builtIn: true, active: !anyActive, changed: 0, updatedAt: null };
    }
    return {
      id: row.id,
      name: row.name,
      builtIn: false,
      active: row.active,
      changed: Object.keys(usable(row.overrides)).length,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function presetsView(): Promise<PresetsView> {
    const rows = await db.select().from(configPresets).orderBy(sql`lower(${configPresets.name})`);
    const active = rows.find((r) => r.active);
    return {
      active: active?.id ?? DEFAULT_PRESET_ID,
      presets: [null, ...rows].map((r) => presetSummary(r, !!active)),
      maxNameLength: MAX_PRESET_NAME_LENGTH,
    };
  }

  async function presetView(row: PresetRow | null): Promise<PresetView> {
    const anyActive = row?.active || (await db.$count(configPresets, eq(configPresets.active, true))) > 0;
    const overrides = usable(row?.overrides ?? {});
    const fields = configFields(base);
    const values = Object.fromEntries(fields.map((f) => [f.path, overrides[f.path] ?? f.default]));
    return { ...presetSummary(row, anyActive), fields, overrides, values };
  }

  /**
   * A preset's name, trimmed, or undefined once a 400 or 409 has been sent: it must have something in it, fit the
   * limit, not be Default, and not be another preset's name in any case.
   */
  async function checkName(reply: FastifyReply, raw: string, ownId?: string) {
    const name = raw.trim().replace(/\s+/g, " ");
    const problem = !name
      ? "Give the preset a name."
      : name.length > MAX_PRESET_NAME_LENGTH
        ? `Keep the name to ${MAX_PRESET_NAME_LENGTH} characters or fewer.`
        : name.toLowerCase() === DEFAULT_PRESET.toLowerCase()
          ? "Default is the built-in preset's name. Pick another."
          : undefined;
    if (problem) {
      sendError(reply, 400, "invalid_name", problem);
      return undefined;
    }
    const [taken] = await db
      .select({ id: configPresets.id })
      .from(configPresets)
      .where(
        and(
          sql`lower(${configPresets.name}) = ${name.toLowerCase()}`,
          ownId ? ne(configPresets.id, ownId) : undefined,
        ),
      );
    if (taken) {
      sendError(reply, 409, "name_taken", takenMessage(name));
      return undefined;
    }
    return name;
  }

  const takenMessage = (name: string) => `There's already a preset called “${name}”. Pick another name.`;

  /** Undefined for a unique-name clash that got past checkName (two saves at once); anything else is rethrown. */
  function nameTaken(err: unknown): undefined {
    const code = (e: unknown) => (e as { code?: string } | undefined)?.code;
    if (code(err) === "23505" || code((err as { cause?: unknown }).cause) === "23505") return undefined;
    throw err;
  }

  /** Sends a 400 with an error per field if any override is invalid. True if it did. */
  function invalidConfig(reply: FastifyReply, overrides: ConfigOverrides) {
    const fields = validateOverrides(overrides, base);
    const count = Object.keys(fields).length;
    if (!count) return false;
    reply.code(400).send({
      error: "invalid_config",
      message: `${count} setting${count === 1 ? " needs" : "s need"} fixing before saving.`,
      fields,
    } satisfies ConfigErrorView);
    return true;
  }

  /** Only the numbers that differ from the defaults. */
  const cleaned = (overrides: ConfigOverrides) => diffFromDefaults(applyOverrides(usable(overrides), base), base);

  /**
   * The teacher ends the games still being played among those matching: each finishes as it stands. Locks the rows so
   * a Continue can't play a day while they're ended. Returns how many it ended.
   */
  async function endGames(which: SQL) {
    const ended = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(companies)
        .where(and(which, eq(companies.status, "active"), currentVersion))
        .for("update");
      const out: CompanyRow[] = [];
      for (const row of rows) {
        const sim = simOf(row);
        const columns = { ...columnsFor(sim, sim.endGame(row.state)), updatedAt: new Date() };
        await tx.update(companies).set(columns).where(eq(companies.id, row.id));
        out.push({ ...row, ...columns });
      }
      return out;
    });
    for (const row of ended) {
      const company = view(row);
      logGame(row, company.day, "end", { status: company.status, endedBy: "teacher" }, company);
    }
    return ended.length;
  }

  /** Archives or unarchives one game in the teacher's view. False if there's no such game. */
  async function setGameArchived(id: string, archived: boolean) {
    if (!UUID_PATTERN.test(id)) return false;
    // Keeps the first archive time if it's archived twice.
    const [row] = await db
      .update(companies)
      .set({ archivedAt: archived ? sql`coalesce(${companies.archivedAt}, now())` : null })
      .where(eq(companies.id, id))
      .returning({ id: companies.id });
    return !!row;
  }

  /** Archives or unarchives a code. False if there's no such code. */
  async function setCodeArchived(code: string, archived: boolean) {
    if (!CODE_PATTERN.test(code)) return false;
    const [row] = await db
      .update(loginCodes)
      .set({ archived })
      .where(eq(loginCodes.code, code))
      .returning({ code: loginCodes.code });
    return !!row;
  }

  // --- web client ---

  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return sendError(reply, 404, "not_found", "Not found.");
    });
  }

  return app;
}
