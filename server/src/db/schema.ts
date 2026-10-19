import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { GameState } from "@xaas/sim";

export const loginCodes = pgTable("login_codes", {
  code: text("code").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  archived: boolean("archived").notNull().default(false),
});

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    loginCode: text("login_code")
      .notNull()
      .references(() => loginCodes.code, { onDelete: "cascade" }),
    name: text("name").notNull(),
    productType: text("product_type").notNull(),
    // "active" while being played, then "retired", "bankrupt" or "finished" (see CompanyStatus). Only active games
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
    // Set when the teacher archives the game, which only moves it from the live dashboard to the Archived tab: the
    // student can keep playing it. Separate from status, which is where the game itself got to.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("companies_login_code_idx").on(t.loginCode), index("companies_updated_at_idx").on(t.updatedAt)],
);
