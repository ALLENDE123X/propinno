ALTER TABLE "users" ADD COLUMN "quiet_start" time DEFAULT '21:00:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "quiet_end" time DEFAULT '08:00:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "max_daily_sms" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notifications_paused" boolean DEFAULT false NOT NULL;