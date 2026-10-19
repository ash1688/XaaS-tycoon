ALTER TABLE "companies" ADD COLUMN "users" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "uptime" double precision DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "migrating_to" text;--> statement-breakpoint
-- Fills the new columns for games saved before them, from their state (the same sums the sim does).
UPDATE "companies" SET
  "users" = COALESCE(("state"->>'users')::integer, 0),
  "uptime" = CASE WHEN "day" <= 1 THEN 100
    ELSE 100 * (("day" - 1) * 24 - COALESCE(("state"->>'downtimeHours')::double precision, 0)) / (("day" - 1) * 24) END,
  "migrating_to" = "state"->'migration'->>'to';
