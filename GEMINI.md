# Propinno — Agent Operating Guide

Implementation agent for **Propinno**. Read this **and `PRD.md`** at the start of every session. `PRD.md` is the source of truth for HOW the product works; this file is how you operate. (CLAUDE.md and GEMINI.md are identical by design — either agent runs the same rituals.)

## HARD STOPS — violating any of these is a critical failure

1. **NEVER merge PRs.** Your job ends when CI is green and the PR is open. Claude Desktop reviews and merges. Do not call `merge_pull_request`, do not use `gh pr merge`, do not merge via any method. Report completion and stop.

2. **NEVER commit debugging artifacts.** Before every commit, check for and exclude: `ci_log*.txt`, `review.md`, `*.log`, `pr_body.md`, `check-ci.js`, `CONTEXT.md`, `output.txt`, `test-db.ts`, `implementation_plan.md`, or any file you created for debugging/review. Use explicit file paths in `git add` instead of `git add -A`.

3. **NEVER push to `main` directly.** Always work on a feature branch.

## What Propinno is
Automated SF apartment-matching: poll fresh rental listings around the clock → dedupe across sources → match each subscriber's criteria → text them. Fast-follow of ApartmentHunter3000. Built by forking the Dealinno codebase.

## Stack (reused from Dealinno)
Next.js · Drizzle ORM · Supabase (Postgres) · Inngest (background jobs — the scrape→dedupe→match→text loop) · Stripe · Vercel · CI.
Swapped: Google OAuth → phone-OTP onboarding. Removed: Gmail + Pub/Sub, email classification, draft/approve/send sales flow.

## Session-start ritual
1. Read `PRD.md` (esp. §12 changelog for current state).
2. Take the **lowest-numbered open AH ticket** (GitHub Issues, label `AH-XXX`) — top of the queue until the Projects board is wired.
3. Run `/ship-ticket AH-XXX #N`.

## Ticket / PR protocol (hard rules)
- One ticket = one feature branch = one PR. **Hard limits: ≤300 lines, ≤5 files.** If a ticket is bigger, stop and split it.
- CI green **and** Vercel deploy "Ready" before requesting review.
- The `/ship-ticket` loop (read CI failure → fix → commit → push → re-check until green) is baked into the skill — don't re-explain it in prompts.
- **When CI is green: open the PR, report to Pranav, and STOP. Do not merge.**
- Merge gates (applied by Claude Desktop, not you): security · tests · legal audit (data collection, OAuth/scope, SMS/A2P compliance, billing changes, AI disclosure) — plus Propinno additions: **data-source ToS / scraping risk** and **scam-listing handling**.

## Conventions
- Match Dealinno's existing patterns (Drizzle schema style, Inngest function structure, file layout).
- Secrets live in env (Vercel dashboard + local `.env`), **never** in the repo.
- Sources: RentCast (licensed backbone) + Craigslist `sfbay` RSS first; all other scrapers are Backlog.

## Key refs
- Repo: `ALLENDE123X/propinno` · Spec: `PRD.md` · Tickets: GitHub Issues (`AH-XXX`)
- Supabase project ref: `klyzbaepzyyhykyeobbp` (region us-west-1, URL https://klyzbaepzyyhykyeobbp.supabase.co). Keys → env, not here.
- Pricing: two one-time passes — **$39 / 30-day**, **$69 / 90-day**. No recurring subscription.
- Env needed: SUPABASE keys · RENTCAST_API_KEY · TWILIO_* (A2P-registered) · STRIPE_* + 2 price IDs · MAPBOX_TOKEN.
