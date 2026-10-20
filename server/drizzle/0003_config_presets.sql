CREATE TABLE "config_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_presets_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "config" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "config_presets_one_active_idx" ON "config_presets" USING btree ("active") WHERE "config_presets"."active";