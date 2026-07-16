ALTER TABLE "sent" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sent" ADD COLUMN "dismissed_at" timestamp with time zone;