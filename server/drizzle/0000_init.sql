CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login_code" text NOT NULL,
	"name" text NOT NULL,
	"product_type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"model" text NOT NULL,
	"day" integer NOT NULL,
	"cash" integer NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_login_code_login_codes_code_fk" FOREIGN KEY ("login_code") REFERENCES "public"."login_codes"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companies_login_code_idx" ON "companies" USING btree ("login_code");--> statement-breakpoint
CREATE INDEX "companies_updated_at_idx" ON "companies" USING btree ("updated_at");