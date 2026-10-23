import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ConfigOverrides, GameConfig, GameState } from "@xaas/sim";

/** Numbers each login code's playtest tester ID ("Tester 4"), so a student's games can be grouped without the code. */
export const testerNumbers = pgSequence("tester_numbers");

export const loginCodes = pgTable("login_codes", {
  code: text("code").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  archived: boolean("archived").notNull().default(false),
  // The student's ID in the playtest logs: "Tester 4". Each code is one student's, so every game they start, however
  // often they restart, shares it while each game keeps its own "Player N". Given when the code is made, never changes.
  tester: integer("tester")
    .notNull()
    .default(sql`nextval('tester_numbers')`),
});

/** Numbers each company's playtest pseudonym ("Player 7"), so logs never need its name or code. */
export const playerNumbers = pgSequence("player_numbers");

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    loginCode: text("login_code")
      .notNull()
      .references(() => loginCodes.code, { onDelete: "cascade" }),
    name: text("name").notNull(),
    productType: text("product_type").notNull(),
    // "active" while being played, then "retired", "liquidated" or "finished" (see CompanyStatus). Only active games
    // count towards a code's limit.
    status: text("status").notNull().default("active"),
    // Denormalised from state so the dashboard can list games without parsing JSON.
    model: text("model").notNull(),
    day: integer("day").notNull(),
    cash: integer("cash").notNull(),
    users: integer("users").notNull().default(0),
    // Percentage, as the sim works it out.
    uptime: doublePrecision("uptime").notNull().default(100),
    // The model a migration under way is moving to, or null.
    migratingTo: text("migrating_to"),
    state: jsonb("state").$type<GameState>().notNull(),
    // The full config the game started with: the base config with the teacher's overrides at the time. The sim for
    // this game is made from it, so later changes on the config page never touch a game already started. Null only
    // for games started before configs were snapshotted, which use the base config.
    config: jsonb("config").$type<GameConfig>(),
    // The name of the preset the config came from ("Default" for the built-in one), kept with the snapshot so renaming
    // or deleting the preset later doesn't change it. Null only for games started before presets had names; the app
    // fills those in at start-up.
    preset: text("preset"),
    // Set when the teacher archives the game, which only moves it from the live dashboard to the Archived tab: the
    // student can keep playing it. Separate from status, which is where the game itself got to.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // The company's pseudonym in the playtest logs: "Player 7". Given when the game starts and never changes. Only the
    // server links it back to the game, so an export carries the number alone.
    player: integer("player")
      .notNull()
      .default(sql`nextval('player_numbers')`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("companies_login_code_idx").on(t.loginCode), index("companies_updated_at_idx").on(t.updatedAt)],
);

/**
 * The teacher's named presets: each is overrides on the base config, by path (see configSchema in the sim). The active
 * row is what new games use; with none active, they use the base config ("Default", built in rather than a row).
 */
export const configPresets = pgTable(
  "config_presets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    // Only the numbers that differ from the base config.
    overrides: jsonb("overrides").$type<ConfigOverrides>().notNull().default({}),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one active preset.
    uniqueIndex("config_presets_one_active_idx").on(t.active).where(sql`${t.active}`),
    // Names are unique whatever their case, so "Easy mode" and "easy mode" can't both be listed.
    uniqueIndex("config_presets_name_lower_idx").on(sql`lower(${t.name})`),
  ],
);

/**
 * The playtest log: one row per thing a student did, for the teacher to review how students play and where the game
 * confuses them. Anonymised: a row has the company's id (for its timeline and for deleting with it) but never its name,
 * login code, the student's IP or their browser. Exports name the company by its pseudonym alone.
 */
export const playEvents = pgTable(
  "play_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    // The game day it happened on.
    day: integer("day").notNull(),
    // "game" from the server (actions, Continue, start and end), or "ui" from the student's browser.
    kind: text("kind").notNull(),
    // What happened: an action's type, "continue", "start" or "end"; or a UI event such as "page" or "modal".
    type: text("type").notNull(),
    // A game event's outcome: false with the error code when the game refused it. Null for UI events.
    ok: boolean("ok"),
    error: text("error"),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    // A game event's key numbers just after it. Null for UI events.
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
  },
  (t) => [index("play_events_company_at_idx").on(t.companyId, t.at), index("play_events_at_idx").on(t.at)],
);
