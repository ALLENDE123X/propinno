# Propinno — Agent Operating Guide

Combined architect + implementer for **Propinno**, as of 2026-07-16. Read this, `PRD.md`, and `ARCHITECTURE.md` at the start of every session — in that order. `PRD.md` is the source of truth for product vision; `ARCHITECTURE.md` is the living record of what's built; this file is how you operate.

**Operating model change (2026-07-16):** Previously this file (and `GEMINI.md`) described an implementer-only role, with Claude Desktop as a separate architect/PM/reviewer. That split is paused for now — Antigravity is not in the loop. Whatever session reads this file (most likely Claude Code) is now both the architect/PM **and** the implementer: it decides what to build next, implements it (directly or via subagents), and opens the PR. `GEMINI.md` is left as-is in case Antigravity resumes later; don't delete it.

## Cross-session context — read this too

This repo's own docs (`PRD.md`, `ARCHITECTURE.md`) cover product and codebase state, but **not** narrative history, decisions-with-rationale, or lessons learned across sessions. That lives outside the repo:

- `/Users/pranavlende/Documents/claude-memory/projects/startup/MEMORY.md` — index of lessons learned + links to every checkpoint
- `/Users/pranavlende/Documents/claude-memory/projects/startup/checkpoints/` — one `.md` per past session, newest first by filename (`YYYY-MM-DD-HHMMSS-topic.md`); read at least the newest one in full at session start
- The newest checkpoint as of this writing is `2026-07-16-230216-ah-017-commute-filtering.md` — read it (and the AH-018/AH-016/AH-019/AH-014 checkpoints before it) before starting AH-020, for the full picture of what just shipped, plus environment gotchas worth knowing before running `npm test` or a schema migration in this repo again: this worktree setup has no separate dev database (a copied-in `.env.local` points at live production), and `drizzle-kit migrate` doesn't work against this Supabase project at all.

If you have local filesystem access (you should, as Claude Code running on Pranav's machine), read these at session start the same way you'd read `PRD.md`. If a session produces meaningful decisions or state changes, write a new checkpoint there before ending (same file format as the existing ones — frontmatter + TL;DR + decisions + next steps, at minimum).

## HARD STOPS — violating any of these is a critical failure

1. **NEVER merge PRs without Pranav's explicit go-ahead.** Open the PR, get CI green, report, and stop. This used to be enforced by a separate tool (Claude Desktop) reviewing an independent implementer (Antigravity) — with one tool now doing both architecture and implementation, that built-in second reviewer is gone, so this rule matters *more*, not less. Do not call `merge_pull_request` or `gh pr merge` on your own authority.

2. **NEVER commit debugging artifacts.** Before every commit, check for and exclude: `ci_log*.txt`, `review.md`, `*.log`, `pr_body.md`, `check-ci.js`, `CONTEXT.md`, `output.txt`, `test-db.ts`, `implementation_plan.md`, or any file created for debugging/review. Use explicit file paths in `git add` instead of `git add -A`.

3. **NEVER push to `main` directly** for feature work. Exception: urgent infra/cost fixes (e.g. a poller burning money) — Pranav has explicitly greenlit direct-to-main pushes for that category before; use judgment, but default to a branch+PR.

4. **Never write literal `*/` inside a `/* */` block comment** (e.g. referencing cron syntax like `*/15 * * * *`). It closes the comment early and silently breaks the build. Describe schedules in words instead. (This actually happened this session — see the newest checkpoint.)

5. **Never run `tests/integration/pipeline.test.ts` (or write anything else that runs `TRUNCATE`) against a real `DATABASE_URL`.** This environment has no separate local/dev Postgres — any worktree's `.env.local` (often copied in from the main checkout, since it's gitignored and a fresh worktree doesn't get it) points at the **live production Supabase project**. That test file's `beforeEach` runs `TRUNCATE TABLE users, listings CASCADE` (CASCADE also takes `criteria`/`sent`). As of 2026-07-16 (AH-018) it's gated behind an explicit `RUN_DESTRUCTIVE_DB_TESTS=true` env var (skipped by default even if `DATABASE_URL` is set, unlike the original `skipIf(!DATABASE_URL)` gate, which made the destructive path this repo's *default* local state) — do not remove or weaken that gate, and do not set that env var against anything but a database you can afford to lose. When writing any other DB-touching script or migration, prefer disposable insert/delete over anything that could wipe a whole table.

## What Propinno is

Automated SF apartment-matching: poll fresh rental listings around the clock → dedupe across sources → match each subscriber's criteria → text them. Fast-follow of ApartmentHunter3000. Built by forking the Dealinno codebase.

## Stack

Next.js · Drizzle ORM · Supabase (Postgres) · Inngest (background jobs — poll→dedupe→match→text) · Stripe · Twilio (Verify OTP + SMS) · Apify (Craigslist listing source, replacing dead RSS scraping) · RentCast (licensed listing source) · Vercel · CI.

## Current data pipeline state (2026-07-16)

- **RentCast poller:** live, cron `0 */6 * * *`, budget-capped at 20 req/day via `lib/pollerBudget.ts`.
- **Craigslist poller:** rewired off dead RSS onto Apify actor `memo23/craigslist-scraper` (residential-proxy routed — plain RSS/datacenter scraping is blocked by Craigslist site-wide, confirmed independently). Cron `0 */2 * * *`, capped at 80 items/run + budget-capped at 24 runs/day. **Requires `APIFY_API_TOKEN` in Vercel env vars — as of 2026-07-16 this was still NOT set, poller failing closed with a clear error. Check it's set before assuming Craigslist data is flowing.**
- **Both pollers' upsert step is chunked** (`step.run('upsert-listings-chunk-N', ...)`, 50 items/chunk) as of 2026-07-16 (issue #40, PR #41) — RentCast's up-to-500-item runs were hitting the route's 60s `maxDuration` doing sequential per-item DB round-trips in one un-chunked step. If either poller's per-run item cap grows a lot, watch for the same failure mode resurfacing; `lib/listings.ts`'s `dedupeAndUpsertListings()` itself is still O(n) sequential round-trips per chunk.
- Verify actual freshness before trusting the pipeline's health: `SELECT source, count(*), max(first_seen_at) FROM listings GROUP BY source;` in Supabase (project ref `klyzbaepzyyhykyeobbp`).

## Ticket priority — do NOT default to "lowest open number"

GitHub Issues `AH-XXX` (labels) are the ticket system. The old convention was "lowest open AH number = top of queue until the Projects board is wired" — that's now explicitly wrong to follow blindly. As of 2026-07-16, in order:

~~AH-015 (dashboard + map, #27)~~ SHIPPED 2026-07-16 (PR #39) → ~~AH-016 (in-app inbox, #28)~~ SHIPPED 2026-07-16 (PR #44) → ~~AH-014 (Facebook Marketplace source, #26)~~ SHIPPED 2026-07-16 (PR #42) → ~~AH-019 (notification settings, #31)~~ SHIPPED 2026-07-16 (PR #43) → ~~AH-018 (pet/laundry filters, #30)~~ SHIPPED 2026-07-16 (PR #45) → ~~AH-017 (commute filtering, #29)~~ SHIPPED 2026-07-16 (PR #46) → ~~AH-020 (NLP input, #32)~~ implemented 2026-07-16 on `feature/ah-020-nlp-search-input`, PR open, **not yet merged ← check PR status before re-implementing** → ~~AH-022 (favourites, #34)~~ implemented 2026-07-17 on `feature/ah-022-favourites`, PR open, **not yet merged ← check PR status before re-implementing** → **AH-023 (amenity map, #35) ← NEXT**

AH-015 went first because most of the others assume or benefit from the dashboard shell existing. Update this list in `CLAUDE.md` itself as tickets complete, so the next session doesn't have to reconstruct priority from scratch. AH-013, AH-015, AH-016, AH-014, AH-019, AH-018, AH-017, and AH-021 are merged and live (AH-021 was done but uncommunicated until 2026-07-16 — check actual code, not just issue state, before assuming a ticket is unstarted). AH-016, AH-014, and AH-019 all landed the same day via parallel worktrees — see the newest checkpoints for the merge-conflict/migration-numbering lessons from that (matters again any time 2+ schema-changing tickets are worked concurrently). AH-020 and AH-022 are both implemented with open PRs but **not yet merged** as of this writing — check actual PR/merge state on GitHub, not just this file, before assuming either is live in production or re-implementing it. AH-020 is the **first Claude/Anthropic API integration** in this codebase (`lib/nlpCriteria.ts`) — `ANTHROPIC_API_KEY` was not provisioned anywhere (not Vercel, not local `.env.local`) as of 2026-07-16, so the feature ships with a tested "not configured" fallback rather than a live-verified happy path; check the key is actually set before assuming natural-language search works in production, and if you're the first session with real key access, a live end-to-end verification (not just the mocked unit tests) is still owed. AH-017 also has a known, deliberate limitation worth knowing about before touching it further: Mapbox's Isochrone API has no real transit/public-transit profile, so `commute_mode='transit'` is an explicitly-labeled approximation (walking profile × a documented multiplier) — see `lib/commute.ts`'s header comment and the AH-017 session's `ARCHITECTURE.md` entry before assuming it's real transit routing or "fixing" it without reading why it's built this way. AH-022 (favourites) added a new `favourites` table (migration `drizzle/0005_ah-022-favourites.sql`) — same shape/conventions as `sent`, unique(userId, listingId) + `onConflictDoNothing()` for idempotent re-saves, real-browser-verified against a disposable test user including a direct DB check that a double-insert of the same pair produces exactly one row.

## Parallel implementation

Multiple tickets can be worked simultaneously using git worktrees (one per ticket/branch) + subagents, so parallel work never edits the same files. Still: **one ticket = one feature branch = one PR.** Don't let a subagent's scope creep across ticket boundaries.

## Session-end ritual (MANDATORY)

1. **Update `ARCHITECTURE.md`** to reflect what you shipped — routes, Inngest functions, schema changes, lib modules, connection notes, ticket log table. Include it in the same PR.
2. If the session produced real decisions, findings, or state changes (not just a small fix), write a checkpoint to the memory tree (see "Cross-session context" above).
3. Not optional — a PR without an `ARCHITECTURE.md` update for a code-changing ticket gets bounced on review.

## Ticket / PR protocol

- One ticket = one feature branch = one PR. **Hard limits: ≤300 lines, ≤5 files.** Split bigger ones.
- CI green **and** Vercel deploy "Ready" before requesting review.
- When CI is green: open the PR, report to Pranav, and **stop. Do not merge** (see Hard Stop #1).
- Review gates before merge: security · tests · legal audit (data collection, OAuth/scope, SMS/A2P compliance, billing changes, AI disclosure) · data-source ToS/scraping risk · scam-listing handling.

## Conventions

- Match existing patterns (Drizzle schema style, Inngest function structure, file layout).
- Secrets live in env (Vercel dashboard + local `.env`), **never** in the repo.
- Listing sources: RentCast (licensed) + Craigslist via Apify (`memo23/craigslist-scraper`) + Facebook Marketplace via Apify (`memo23/facebook-marketplace-scraper-ppe`, AH-014) — all budget-capped via `lib/pollerBudget.ts`.
- Pet-policy/laundry-type parsing (AH-018) lives in `lib/listingAttributes.ts`, shared by all pollers — check real production data (`raw` jsonb column, or a live Apify sample run) before writing a parser for a new field/source rather than guessing at field names; RentCast's rental-listings endpoint was confirmed to have zero pet/laundry data, Craigslist's Apify actor has a structured `amenities` array. `facebookPoller.ts` does not parse pets/laundry yet (landed same day as AH-018 in a separate worktree) — a reasonable follow-up once that actor's field shape is inspected.
- Shared UI components (like `components/ui/button.tsx`) must merge Tailwind classNames via `cn()` (`lib/utils.ts`, clsx + tailwind-merge) — never raw template-string concatenation. See newest checkpoint for why.
- Claude/Anthropic API calls (AH-020, `lib/nlpCriteria.ts`) — `@anthropic-ai/sdk`, forced tool-use for structured extraction, zod-validate every response before trusting it, fail closed with a typed reason when `ANTHROPIC_API_KEY` is unset. Reuse this pattern rather than inventing a new one for any future AI-powered ticket.

## Key refs

- Repo: `ALLENDE123X/propinno` · Spec: `PRD.md` · Architecture: `ARCHITECTURE.md` · Tickets: GitHub Issues (`AH-XXX`, priority order above)
- Memory tree: `/Users/pranavlende/Documents/claude-memory/projects/startup/` (MEMORY.md + checkpoints/)
- Supabase project ref: `klyzbaepzyyhykyeobbp` (region us-west-1). Keys → env, not here.
- Pricing: two one-time passes — **$39 / 30-day**, **$69 / 90-day**. No recurring subscription.
- Env needed: SUPABASE keys · RENTCAST_API_KEY · TWILIO_* (API-key auth preferred over legacy auth token — see `lib/twilio.ts`) · STRIPE_* + 2 price IDs · MAPBOX_TOKEN · APIFY_API_TOKEN (needed, may not be set yet) · ANTHROPIC_API_KEY (AH-020 natural-language search parsing, needed, NOT set anywhere as of 2026-07-16 — feature fails closed with a clear "not configured" message when unset, see `lib/nlpCriteria.ts`) · UPSTASH_REDIS_REST_URL/TOKEN (poller budget caps + failure-alert cooldown).
