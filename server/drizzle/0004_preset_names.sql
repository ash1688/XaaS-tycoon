ALTER TABLE "companies" ADD COLUMN "preset" text;--> statement-breakpoint
CREATE UNIQUE INDEX "config_presets_name_lower_idx" ON "config_presets" USING btree (lower("name"));