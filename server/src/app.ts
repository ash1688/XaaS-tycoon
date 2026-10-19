import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import Fastify, { type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { and, asc, count, desc, eq, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  createSim,
  MIGRATION_PHASES,
  MODEL_IDS,
  PRODUCT_TYPE_IDS,
  responsibilityStack,
  SimError,
  STAFF_POOLS,
  type GameState,
  type Sim,
} from "@xaas/sim";
import type { Db } from "./db/client.ts";
import { companies, loginCodes } from "./db/schema.ts";
import { endTeacherSession, isTeacher, passwordMatches, startTeacherSession } from "./teacherAuth.ts";
import type {
  ActionBody,
  ApiError,
  CodeView,
  CompanyStatus,
  CompanyView,
  ContinueResult,
  MetaView,
  MigrationQuoteView,
  NewCompanyBody,
  SummaryView,
  TeacherCodeView,
  TeacherGamesView,
  TeacherGameView,
  TeacherSummaryView,
} from "./api-types.ts";

export interface AppOptions {
  db: Db;
  teacherPassword: string;
  sessionSecret: string;
  sim?: Sim;
  /** Built web client to serve. Skipped if missing (dev uses the Vite server). */
  webDist?: string;
  logger?: boolean;
  /** Companies still being played that one login code can have at once. Defaults to 3. */
  maxActiveCompanies?: number;
  /** How far back, in hours, the teacher's dashboard looks unless the teacher picks another window. Defaults to 3. */
  dashboardHours?: number;
}

export const DEFAULT_MAX_ACTIVE_COMPANIES = 3;
export const DEFAULT_DASHBOARD_HOURS = 3;
/** The widest window the dashboard can ask for: a week. */
export const MAX_DASHBOARD_HOURS = 7 * 24;

const CODE_PATTERN = /^\d{8}$/;

/** SimError codes for a game that has ended, or that the student retired. */
const GAME_OVER = new Set(["bankrupt", "finished", "retired"]);

type CompanyRow = typeof companies.$inferSelect;

function sendError(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message } satisfies ApiError);
}

export async function buildApp(opts: AppOptions) {
  const { db } = opts;
  const sim = opts.sim ?? createSim();
  const maxActiveCompanies = opts.maxActiveCompanies ?? DEFAULT_MAX_ACTIVE_COMPANIES;
  const dashboardHours = opts.dashboardHours ?? DEFAULT_DASHBOARD_HOURS;
  const app = Fastify({ logger: opts.logger ?? false });

  await app.register(cookie, { secret: opts.sessionSecret });

  app.setErrorHandler((err, _req, reply) => {
    // A bankrupt or finished game is over: the request was fine, but the game can't take it any more.
    if (err instanceof SimError) return sendError(reply, GAME_OVER.has(err.code) ? 409 : 400, err.code, err.message);
    const { statusCode, message } = err as { statusCode?: number; message?: string };
    if (statusCode && statusCode < 500) return sendError(reply, statusCode, "bad_request", message ?? "Bad request.");
    app.log.error(err);
    return sendError(reply, 500, "server_error", "Something went wrong.");
  });

  function view(row: CompanyRow): CompanyView {
    const state = sim.load(row.state);
    return {
      id: row.id,
      name: row.name,
      productType: state.productType,
      model: state.model,
      day: state.day,
      finalDay: sim.config.finalDay,
      cash: state.cash,
      status: (state.status === "playing" ? row.status : state.status) as CompanyStatus,
      developers: state.developers,
      ops: state.ops,
      opsNeeded: sim.opsNeeded(state.model),
      dailyStaffCost: sim.dailyStaffCost(state),
      users: state.users,
      load: state.load,
      capacity: sim.capacity(state),
      uptime: sim.uptime(state),
      outageDays: state.outageDays,
      monthlyInfrastructureCost: sim.monthlyInfrastructureCost(state),
      monthlyAddonCost: sim.monthlyAddonCost(state),
      spend: state.spend,
      features: sim.features(state),
      migration: sim.migration(state),
      migrations: state.migrations,
      events: sim.events(state),
      featureGaps: sim.featureGaps(state),
    };
  }

  const columnsFor = (state: GameState) => ({
    model: state.model,
    day: state.day,
    cash: state.cash,
    users: state.users,
    uptime: sim.uptime(state),
    migratingTo: state.migration?.to ?? null,
    // Denormalised for the dashboard, like cash: "bankrupt" or "finished" once the game is over.
    ...(state.status !== "playing" && { status: state.status }),
    state,
  });

  async function findCode(code: string) {
    if (!CODE_PATTERN.test(code)) return undefined;
    const [row] = await db.select().from(loginCodes).where(eq(loginCodes.code, code));
    return row && !row.archived ? row : undefined;
  }

  // --- public ---

  app.get("/api/meta", async (): Promise<MetaView> => {
    const { config } = sim;
    return {
      startingCash: config.startingCash,
      finalDay: config.finalDay,
      maxCompanyNameLength: config.maxCompanyNameLength,
      maxActiveCompanies,
      productTypes: PRODUCT_TYPE_IDS.map((id) => {
        const { name, profile, features } = config.productTypes[id];
        return {
          id,
          name,
          profile,
          features: features.map((f) => ({ id: f.id, name: f.name, addonPricePerUser: f.addonPricePerUser })),
        };
      }),
      models: MODEL_IDS.map((id) => {
        const { name, blurb, comparison, opsNeeded, upfrontCost, monthlyCost, monthlyCostPerUser } = config.models[id];
        const stack = responsibilityStack(id);
        return { id, name, blurb, comparison, stack, opsNeeded, upfrontCost, monthlyCost, monthlyCostPerUser };
      }),
      staff: STAFF_POOLS.map((id) => {
        const { name, personName, dayRate } = config.staff[id];
        return { id, name, personName, dayRate };
      }),
      minConfigDevelopers: config.addons.minConfigDevelopers,
      migrationPhases: MIGRATION_PHASES.map((id) => ({ id, ...config.migration.phases[id] })),
    };
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
    return { code: code.code, companies: rows.map(view) } satisfies CodeView;
  });

  app.post<{ Params: { code: string }; Body: NewCompanyBody }>(
    "/api/codes/:code/companies",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "productType", "model"],
          properties: { name: { type: "string" }, productType: { type: "string" }, model: { type: "string" } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const code = await findCode(req.params.code);
      if (!code) return sendError(reply, 404, "unknown_code", "That code wasn't recognised. Check it with your teacher.");
      const { name, productType, model } = req.body;
      // Locks the code so two creates at once can't both see room under the limit. Only games still being played
      // count: finished, bankrupt and retired ones are history. Archiving is only the teacher's view, so it doesn't
      // change what counts.
      const row = await db.transaction(async (tx) => {
        await tx.select().from(loginCodes).where(eq(loginCodes.code, code.code)).for("update");
        const [counted] = await tx
          .select({ active: count() })
          .from(companies)
          .where(and(eq(companies.loginCode, code.code), eq(companies.status, "active")));
        if (counted!.active >= maxActiveCompanies) return undefined;
        const state = sim.newGame({ companyName: name, productType, model, seed: randomInt(2 ** 31) });
        const [inserted] = await tx
          .insert(companies)
          .values({ loginCode: code.code, name: state.companyName, productType: state.productType, ...columnsFor(state) })
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
      return reply.code(201).send(view(row));
    },
  );

  app.get<{ Params: { code: string; id: string } }>("/api/codes/:code/companies/:id", async (req, reply) => {
    const row = await findCompany(req.params.code, req.params.id);
    if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
    return view(row);
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
      return sim.migrationQuote(row.state, req.query.target) satisfies MigrationQuoteView;
    },
  );

  // How the company did: shown when the game ends, and available any time as a summary so far.
  app.get<{ Params: { code: string; id: string } }>("/api/codes/:code/companies/:id/summary", async (req, reply) => {
    const row = await findCompany(req.params.code, req.params.id);
    if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
    return sim.summarise(row.state) satisfies SummaryView;
  });

  app.post<{ Params: { code: string; id: string } }>("/api/codes/:code/companies/:id/continue", async (req, reply) => {
    const result = await updateCompany(req.params.code, req.params.id, (state) => sim.advance(state, 1));
    if (!result) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
    return { company: result.company, log: result.log } satisfies ContinueResult;
  });

  app.post<{ Params: { code: string; id: string }; Body: ActionBody }>(
    "/api/codes/:code/companies/:id/actions",
    {
      schema: {
        body: {
          type: "object",
          required: ["type"],
          properties: {
            type: { enum: ["hire", "letGo", "buildFeature", "buyAddon", "moveStaff", "startMigration"] },
            pool: { enum: [...STAFF_POOLS] },
            // Checked against the product's list by the sim.
            feature: { type: "string", maxLength: 64 },
            // moveStaff: the pool one person moves into, from the other.
            to: { enum: [...STAFF_POOLS] },
            // startMigration: the model to move to.
            model: { enum: [...MODEL_IDS] },
          },
          allOf: [
            { if: { properties: { type: { enum: ["hire", "letGo"] } } }, then: { required: ["pool"] } },
            { if: { properties: { type: { enum: ["buildFeature", "buyAddon"] } } }, then: { required: ["feature"] } },
            { if: { properties: { type: { const: "moveStaff" } } }, then: { required: ["to"] } },
            { if: { properties: { type: { const: "startMigration" } } }, then: { required: ["model"] } },
          ],
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const result = await updateCompany(req.params.code, req.params.id, (state) => ({
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
    return view(row);
  });

  /**
   * Runs a sim step against a company's saved state and stores the result.
   * Locks the row so two tabs can't both change it from the same starting point.
   * Returns undefined if the company isn't under that code. A SimError rolls back and becomes a 400.
   */
  async function updateCompany<T extends { state: GameState }>(
    code: string,
    id: string,
    step: (state: GameState) => T,
  ): Promise<(T & { company: CompanyView }) | undefined> {
    if (!UUID_PATTERN.test(id) || !(await findCode(code))) return undefined;
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(companies).where(companyWhere(code, id)).for("update");
      if (!row) return undefined;
      if (row.status === "retired") {
        throw new SimError("retired", `${row.name} was retired, so this game is over. Start a new company to play again.`);
      }
      const result = step(sim.load(row.state));
      const [updated] = await tx
        .update(companies)
        .set({ ...columnsFor(result.state), updatedAt: new Date() })
        .where(eq(companies.id, row.id))
        .returning();
      return { ...result, company: view(updated!) };
    });
  }

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function companyWhere(code: string, id: string) {
    return and(eq(companies.id, id), eq(companies.loginCode, code));
  }

  async function findCompany(code: string, id: string) {
    if (!UUID_PATTERN.test(id) || !(await findCode(code))) return undefined;
    const [row] = await db.select().from(companies).where(companyWhere(code, id));
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
            },
          })
          .from(loginCodes)
          .leftJoin(companies, eq(companies.loginCode, loginCodes.code))
          .where(where)
          .orderBy(desc(loginCodes.createdAt), asc(companies.createdAt));
        const codes = new Map<string, TeacherGamesView["codes"][number]>();
        for (const { code, codeArchived, game: g } of rows) {
          if (!codes.has(code)) codes.set(code, { code, archived: codeArchived, companies: [] });
          if (!g) continue;
          codes.get(code)!.companies.push({
            ...g,
            productType: g.productType as TeacherGameView["productType"],
            model: g.model as TeacherGameView["model"],
            migratingTo: g.migratingTo as TeacherGameView["migratingTo"],
            status: g.status as CompanyStatus,
            finalDay: sim.config.finalDay,
            updatedAt: g.updatedAt.toISOString(),
            archivedAt: g.archivedAt?.toISOString() ?? null,
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

    // Any company's summary. The teacher picks it from the dashboard, so it goes by id alone.
    teacher.get<{ Params: { id: string } }>("/api/teacher/companies/:id/summary", async (req, reply) => {
      const { id } = req.params;
      const [row] = UUID_PATTERN.test(id) ? await db.select().from(companies).where(eq(companies.id, id)) : [];
      if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
      const status = row.status as CompanyStatus;
      return { code: row.loginCode, status, summary: sim.summarise(row.state) } satisfies TeacherSummaryView;
    });
  });

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
