import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    state: jsonb("state").$type<GameState>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("companies_login_code_idx").on(t.loginCode), index("companies_updated_at_idx").on(t.updatedAt)],
);
