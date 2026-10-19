import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import Fastify, { type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { and, count, desc, eq } from "drizzle-orm";
import { createSim, MODEL_IDS, PRODUCT_TYPE_IDS, SimError, type GameState, type Sim } from "@xaas/sim";
import type { Db } from "./db/client.ts";
import { companies, loginCodes } from "./db/schema.ts";
import { endTeacherSession, isTeacher, passwordMatches, startTeacherSession } from "./teacherAuth.ts";
import type {
  ApiError,
  CodeView,
  CompanyView,
  ContinueResult,
  MetaView,
  NewCompanyBody,
  TeacherCodeView,
} from "./api-types.ts";

export interface AppOptions {
  db: Db;
  teacherPassword: string;
  sessionSecret: string;
  sim?: Sim;
  /** Built web client to serve. Skipped if missing (dev uses the Vite server). */
  webDist?: string;
  logger?: boolean;
}

const CODE_PATTERN = /^\d{8}$/;

type CompanyRow = typeof companies.$inferSelect;

function sendError(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message } satisfies ApiError);
}

export async function buildApp(opts: AppOptions) {
  const { db } = opts;
  const sim = opts.sim ?? createSim();
  const app = Fastify({ logger: opts.logger ?? false });

  await app.register(cookie, { secret: opts.sessionSecret });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof SimError) return sendError(reply, 400, err.code, err.message);
    const { statusCode, message } = err as { statusCode?: number; message?: string };
    if (statusCode && statusCode < 500) return sendError(reply, statusCode, "bad_request", message ?? "Bad request.");
    app.log.error(err);
    return sendError(reply, 500, "server_error", "Something went wrong.");
  });

  const view = (row: CompanyRow): CompanyView => ({
    id: row.id,
    name: row.name,
    productType: row.state.productType,
    model: row.state.model,
    day: row.state.day,
    finalDay: sim.config.finalDay,
    cash: row.state.cash,
    status: row.status,
  });

  const columnsFor = (state: GameState) => ({ model: state.model, day: state.day, cash: state.cash, state });

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
      productTypes: PRODUCT_TYPE_IDS.map((id) => ({ id, ...config.productTypes[id] })),
      models: MODEL_IDS.map((id) => ({ id, name: config.models[id].name, blurb: config.models[id].blurb })),
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
      const state = sim.newGame({ companyName: name, productType, model, seed: randomInt(2 ** 31) });
      const [row] = await db
        .insert(companies)
        .values({ loginCode: code.code, name: state.companyName, productType: state.productType, ...columnsFor(state) })
        .returning();
      return reply.code(201).send(view(row!));
    },
  );

  app.get<{ Params: { code: string; id: string } }>("/api/codes/:code/companies/:id", async (req, reply) => {
    const row = await findCompany(req.params.code, req.params.id);
    if (!row) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
    return view(row);
  });

  app.post<{ Params: { code: string; id: string } }>("/api/codes/:code/companies/:id/continue", async (req, reply) => {
    if (!(await findCode(req.params.code))) {
      return sendError(reply, 404, "unknown_company", "That company wasn't found.");
    }
    // Lock the row so two tabs pressing Continue can't both advance from the same day.
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(companies)
        .where(companyWhere(req.params.code, req.params.id))
        .for("update");
      if (!row) return undefined;
      const { state, log } = sim.advance(row.state, 1);
      const [updated] = await tx
        .update(companies)
        .set({ ...columnsFor(state), updatedAt: new Date() })
        .where(eq(companies.id, row.id))
        .returning();
      return { company: view(updated!), log } satisfies ContinueResult;
    });
    if (!result) return sendError(reply, 404, "unknown_company", "That company wasn't found.");
    return result;
  });

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
  });

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
