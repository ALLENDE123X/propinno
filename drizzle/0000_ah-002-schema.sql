CREATE TYPE "public"."user_plan" AS ENUM('pass_30', 'pass_90');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('pending_payment', 'active', 'expired', 'done');--> statement-breakpoint
CREATE TABLE "criteria" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"price_min" integer,
	"price_max" integer,
	"beds_min" real,
	"beds_max" real,
	"zips" text[],
	"neighborhoods" text[]
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"address" text NOT NULL,
	"lat" real,
	"lng" real,
	"price" integer,
	"beds" real,
	"baths" real,
	"sqft" integer,
	"url" text,
	"posted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_canonical" boolean DEFAULT false NOT NULL,
	"canonical_id" uuid,
	"raw" jsonb,
	CONSTRAINT "listings_source_source_id_unique" UNIQUE("source","source_id")
);
--> statement-breakpoint
CREATE TABLE "sent" (
	"user_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sent_user_id_listing_id_unique" UNIQUE("user_id","listing_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"status" "user_status" DEFAULT 'pending_payment' NOT NULL,
	"plan" "user_plan",
	"access_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "criteria" ADD CONSTRAINT "criteria_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent" ADD CONSTRAINT "sent_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent" ADD CONSTRAINT "sent_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listings_geo_idx" ON "listings" USING btree ("lat","lng");