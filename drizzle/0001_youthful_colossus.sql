CREATE TYPE "public"."email_draft_status" AS ENUM('pending_review', 'approved', 'rejected', 'sent');
ALTER TABLE "email_drafts" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "email_drafts" ALTER COLUMN "status" TYPE "public"."email_draft_status" USING "status"::"public"."email_draft_status";
ALTER TABLE "email_drafts" ALTER COLUMN "status" SET DEFAULT 'pending_review';