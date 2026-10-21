CREATE SEQUENCE "public"."player_numbers" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "play_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "play_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"day" integer NOT NULL,
	"kind" text NOT NULL,
	"type" text NOT NULL,
	"ok" boolean,
	"error" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot" jsonb
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "player" integer DEFAULT nextval('player_numbers') NOT NULL;--> statement-breakpoint
ALTER TABLE "play_events" ADD CONSTRAINT "play_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "play_events_company_at_idx" ON "play_events" USING btree ("company_id","at");--> statement-breakpoint
CREATE INDEX "play_events_at_idx" ON "play_events" USING btree ("at");