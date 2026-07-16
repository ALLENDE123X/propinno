ALTER TABLE "criteria" ADD COLUMN "commute_address" text;--> statement-breakpoint
ALTER TABLE "criteria" ADD COLUMN "commute_max_minutes" integer;--> statement-breakpoint
ALTER TABLE "criteria" ADD COLUMN "commute_mode" text;--> statement-breakpoint
ALTER TABLE "criteria" ADD COLUMN "commute_isochrone" jsonb;