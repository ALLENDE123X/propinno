# ARCHITECTURE.md — Propinno

Living record of the codebase. Updated at the end of every dev session by the implementing agent.
Last updated: 2026-07-16 (AH-019 shipped, notification settings).

---

## 1. Product summary

Automated SF apartment-matching service. Polls rental listings from multiple sources around the clock, deduplicates across sources, geocodes addresses, matches each subscriber's saved criteria, and texts matching listings to their phone via SMS. One-time access passes ($39/30-day, $69/90-day); no recurring subscription — the product churns by design when users find an apartment. Fast-follow of ApartmentHunter3000.

---

## 2. Stack

Next.js 15 (App Router) · TypeScript · Drizzle ORM · Supabase (Postgres, us-west-1) · Inngest (background jobs) · Stripe (one-time checkout) · Twilio (SMS + Verify OTP) · Mapbox (geocoding) · RentCast API (licensed listing data) · Craigslist sfbay RSS (real-time free source) · Vercel (hosting) · Sentry (errors) · Axiom/Pino (structured logs) · Upstash Redis (rate limiting).

---

## 3. Data model (lib/db/schema.ts)

**users** — id (uuid PK), phone (unique), status (enum: pending_payment | active | expired | done), plan (enum: pass_30 | pass_90), access_expires_at, created_at, quiet_start (time, default 21:00:00), quiet_end (time, default 08:00:00), max_daily_sms (int, default 20), notifications_paused (bool, default false). The four notification-preference columns were added in AH-019 (migration `drizzle/0001_ah-019-notification-settings.sql`) — see §4/§7 for how they're enforced.

**listings** — id (uuid PK), source, source_id (unique together), address, lat, lng, price, beds, baths, sqft, url, posted_at, first_seen_at, is_canonical (bool), canonical_id (uuid, points to canonical listing for dedupe), raw (jsonb). Indexes: geo (lat,lng), unique(source, source_id).

**criteria** — user_id (uuid PK, FK → users ON DELETE CASCADE), price_min, price_max, beds_min, beds_max, zips (text[]), neighborhoods (text[]).

**sent** — user_id + listing_id (unique together, both FK with CASCADE), sent_at. Tracks which listings have been texted to which users to prevent duplicates.

---

## 4. Core pipeline (Inngest functions)

All functions in `inngest/functions/`. Registered in `app/api/inngest/route.ts`.

**rentcastPoller.ts** — Cron: every 6h (`0 */6 * * *`), plus a manual `app/rentcast.manual-poll` trigger. Calls RentCast API for SF rental listings (`limit=500`). Budget-capped via `lib/pollerBudget.ts` (`claimDailyBudget`, max 20 req/day, Redis-backed) as an independent safety net on top of the cron schedule itself (see the RentCast cost-bleed incident in the memory checkpoint tree). Upserts into listings table (source='rentcast') via `dedupeAndUpsertListings`, chunked into multiple `step.run()` calls of 50 items each so no single Inngest step invocation exceeds the route's 60s `maxDuration` — up to 500 sequential DB round-trips in one step reliably timed out otherwise (fixed 2026-07-16, issue #40). Emits `app/listings.upserted` for canonical IDs.

**craigslistPoller.ts** — Cron: every 2h (`0 */2 * * *`). Craigslist's own RSS feeds (`?format=rss`) are blocked site-wide as of 2026-07-16 (confirmed independently, not IP/UA-specific) — listings now come from an Apify actor (`memo23/craigslist-scraper`, residential-proxy routed) instead, capped at 80 items/run via `MAX_ITEMS_PER_RUN`. Requires `APIFY_API_TOKEN` in Vercel env vars; fails closed with a clear error if missing. Budget-capped via the same `claimDailyBudget` pattern (max 24 runs/day). Same chunked-upsert fix as rentcastPoller, applied preemptively (not yet triggered at the 80-item cap, but same latent failure mode). Emits `app/listings.upserted`.

**matchingEngine.ts** — Triggered by `listing/new` event. Geocodes via Mapbox if lat/lng missing. Runs cross-source dedupe (sets is_canonical/canonical_id). For canonical listings: queries all active, non-paused users whose criteria match (price range, beds range, neighborhood/zip overlap), excluding already-sent pairs. **AH-019: enforces the per-user daily SMS cap** (`users.max_daily_sms`) before dispatch — `getTodaysSentCount()` counts today's `sent` rows for the user (America/Los_Angeles calendar day, see `lib/quietHours.ts`), and a match is skipped (not queued for later — a cap-skipped match just doesn't send that day) once the user is at/over their cap. An in-run `Map` tracks tentative dispatches so one run matching a user against many listings can't blow past the cap before `sent` rows exist for the earlier ones. `findMatchingUsers()`'s SQL also filters `NOT u.notifications_paused`. Emits `notification/send` for each match still under cap.

**twilioSender.ts** — Triggered by `notification/send` event. **AH-019: respects quiet hours** — if the receiving user's current local time (hardcoded `America/Los_Angeles`, see `lib/quietHours.ts` for why) falls within `[quiet_start, quiet_end)`, the function calls `step.sleepUntil()` until `quiet_end` instead of sending immediately or dropping the notification; re-checks `notifications_paused` both before queuing the wait and again after waking (the wait can span up to ~24h, long enough for the user to pause in the meantime). Sends SMS via Twilio with listing details (address, price, beds, link). Records in sent table.

**failureAlert.ts** — Triggered by `inngest/function.failed` event. Sends admin SMS alert via Twilio when any background job fails. Stores recent failures in Upstash Redis.

---

## 5. API routes (app/api/)

**POST /api/auth/send-otp** — Sends phone OTP via Twilio Verify. Rate limited.

**POST /api/auth/verify-otp** — Verifies OTP, creates user if new, sets auth cookie.

**POST /api/billing/create-checkout** — Creates Stripe Checkout Session for selected plan. Redirects to Stripe.

**POST /api/webhooks/stripe** — Stripe webhook (checkout.session.completed). Activates user, sets plan + expiry, saves criteria.

**GET /api/health** — Basic health check.

**POST /api/inngest** — Inngest serve handler. Registers all background functions.

**GET /api/admin/test-pipeline?secret=ADMIN_SECRET** — End-to-end smoke test. Inserts test listing → creates temp user with matching criteria → runs matching engine → sends SMS to ADMIN_PHONE → cleans up. Returns {success, listingId, matchedUserId, smsSid}.

**GET /api/admin/status?secret=ADMIN_SECRET** — Returns system health: DB connectivity, user/listing counts, recent Inngest failures from Redis.

**GET /api/listings/map** — Full-detail listing feed for the dashboard map. Session cookie auth + requires `status='active'` (paid, not just verified) — unlike `/api/listings/preview`, returns exact address/lat/lng/url. Query params `minPrice`/`maxPrice`/`minBeds`/`source` filter canonical listings with non-null lat/lng, capped at 500 results.

**AH-019 — `app/dashboard/settings/actions.ts`** (server actions, not a route handler — same pattern as `app/checkout/actions.ts`): `getNotificationSettings()` and `updateNotificationSettings(input)`. Session-cookie auth + `limitRequest()` rate limiting, same as `checkout/actions.ts`. `updateNotificationSettings` validates with zod (`HH:MM` time strings padded to `HH:MM:SS`, `maxDailySms` clamped 1-100) before writing to `users`.

---

## 6. Pages (app/)

**/ (page.tsx)** — Landing + onboarding. Phone input → OTP → criteria form → plan selection → Stripe redirect.

**/checkout** — Post-checkout confirmation page. Active-pass users see a "View live map" link to `/dashboard`.

**/dashboard** — Server Component auth gate (session cookie → `status='active'` only, else redirect to `/checkout`) wrapping the `DashboardMap` client component. Top bar has a gear-icon link to `/dashboard/settings` (AH-019).

**/dashboard/settings** (AH-019) — Same auth gate pattern as `/dashboard` (session cookie → `status='active'`, else redirect to `/checkout`). Server Component fetches the user's current `quietStart`/`quietEnd`/`maxDailySms`/`notificationsPaused` and passes them as initial props to `NotificationSettingsForm`.

**/privacy** — Privacy policy.

**/terms** — Terms of service.

---

## 7. Lib modules

**lib/db/index.ts** — Drizzle postgres client. Uses Proxy pattern for build-time safety when DATABASE_URL absent. `prepare: false` for Supabase transaction pooler compatibility.

**lib/db/schema.ts** — Drizzle schema (see §3).

**lib/listings.ts** — Listing upsert, dedupe, and geocode helpers.

**lib/twilio.ts** — Twilio client, sendSMS helper, OTP send/verify.

**lib/stripe.ts** — Stripe client initialization.

**lib/ratelimit.ts** — Upstash Redis rate limiter (sliding window).

**lib/logger.ts** — Pino + Axiom structured logging.

**lib/supabase/** — Supabase client helpers (server/browser).

**lib/quietHours.ts** (AH-019) — Notification-scheduling helpers shared by `twilioSender.ts` and `matchingEngine.ts`: `isWithinQuietHours(now, quietStart, quietEnd, timeZone?)`, `nextQuietHoursEnd(now, quietEnd, timeZone?)`, `startOfLocalDay(now, timeZone?)`. All hardcode `America/Los_Angeles` by default (`DEFAULT_TIME_ZONE`) — Propinno has no stored per-user timezone and is SF-only, so a real IANA zone (not a fixed UTC offset) is used specifically so quiet-hours/day-boundary math stays correct across the twice-yearly PDT/PST DST transition rather than drifting an hour for half the year. Every function takes `now` as an explicit `Date` parameter (never reads `Date.now()` internally) so callers — and tests — can use fixed instants instead of mocking global time.

**components/dashboard-map.tsx** — Client component: full-screen Mapbox GL JS map centered on SF, one marker per canonical listing (colored by recency: green <24h, yellow <3d, gray older; label shows price + time-since-posted). Click a pin → detail card (address, beds/baths, source, link out). Filter panel (price range, min beds, source) re-fetches `/api/listings/map` on change. Stats bar shows count posted in the last 3 days. Mobile: filter panel and detail card collapse to bottom sheets. Renders a "Mapbox token not configured" message if `NEXT_PUBLIC_MAPBOX_TOKEN` is unset rather than a blank/broken map. Top-right bar also links to `/dashboard/settings` (AH-019).

**components/notification-settings-form.tsx** (AH-019) — Client component for `/dashboard/settings`: pause/resume toggle, quiet-hours start/end (`<input type="time">`), daily text limit (number input), save button wired to the `updateNotificationSettings` server action with a `sonner` toast on success/failure. Same dark-theme visual pattern as `dashboard-map.tsx`/`checkout/page.tsx`.

---

## 8. External service map

| Service | Env var(s) | Purpose |
|---------|-----------|----------|
| Supabase | DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY | Postgres DB (via transaction pooler on IPv4) |
| Stripe | STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_PRICE_30DAY, STRIPE_PRICE_90DAY, STRIPE_WEBHOOK_SECRET | One-time checkout payments |
| Twilio | TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, TWILIO_VERIFY_SERVICE_SID | SMS delivery + phone OTP |
| RentCast | RENTCAST_API_KEY | Licensed SF rental listing data |
| Mapbox | MAPBOX_TOKEN | Address geocoding (lat/lng), server-side only |
| Mapbox | NEXT_PUBLIC_MAPBOX_TOKEN | Client-side Mapbox GL JS map on `/dashboard`. Mapbox tokens prefixed `pk.` are already public-scoped — if `MAPBOX_TOKEN` is a `pk.` token (it is, as of AH-015), the same value can be reused here; never expose an `sk.` (secret) token this way |
| Inngest | INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY | Background job orchestration |
| Sentry | SENTRY_DSN | Error tracking |
| Axiom | AXIOM_TOKEN, AXIOM_DATASET | Structured log ingestion |
| Upstash | UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN | Rate limiting + failure cache |

Admin-only: ADMIN_SECRET (protects /api/admin/*), ADMIN_PHONE (receives test + alert SMS).

---

## 9. Connection notes

**DATABASE_URL must use the transaction pooler** (`aws-1-us-west-1.pooler.supabase.com:6543`) with `?sslmode=require`. The direct host (`db.*.supabase.co`) is IPv6-only; Vercel serverless is IPv4-only. The pooler hostname generation matters: this project uses `aws-1`, not `aws-0`.

**Inngest** must be connected to the Vercel deployment for cron jobs to fire. Check at app.inngest.com.

**Twilio A2P 10DLC** — Brand registered, campaign NOT YET submitted (step 3 incomplete). Until the campaign is approved and the number is linked, US carrier delivery is blocked. Test SMS to your own number works regardless.

---

## 10. Ticket log

| Ticket | PR | What | Shipped |
|--------|-----|------|---------|
| AH-001 | #1 | Seed from Dealinno + strip | 2026-06-28 |
| AH-002 | #2 | Core schema (users, listings, criteria, sent) | 2026-06-28 |
| AH-003 | #3 | Onboarding page + phone OTP | 2026-06-28 |
| AH-004 | #4 | Stripe checkout + cookie auth (IDOR fix) | 2026-06-28 |
| AH-005 | #5 | RentCast poller (every 15min) | 2026-06-28 |
| AH-006 | #6 | Craigslist sfbay RSS poller | 2026-06-28 |
| AH-007 | #7 | Geocode (Mapbox) + cross-source dedupe | 2026-06-28 |
| AH-008 | #20 | Matching engine (criteria → users) | 2026-06-28 |
| AH-009 | #23 | Twilio SMS sender | 2026-06-28 |
| AH-010 | #22 | Failure alerts + admin endpoints + test pipeline | 2026-06-28 |
| AH-012 | #21 | Integration tests for core pipeline | 2026-06-28 |
| AH-011 | #11 | Live-match preview paywall step (onboarding) | 2026-06-28 |
| AH-013 | #36 | Landing page conversion copy overhaul | 2026-06-29 |
| AH-015 | #39 | Dashboard with interactive listing map | 2026-07-16 |
| AH-019 | TBD | Notification settings (quiet hours, daily cap, pause/resume) | 2026-07-16 |

---

## 2026-06-28 — AH-011: Live-match preview → paywall (onboarding conversion)
Context: Convert with proof, not a free tier. Showing real matching listings before asking for payment converts better.
Decision: Third onboarding step ("preview") shown after OTP. Fetches `GET /api/listings/preview` → up to 3 canonical listings matching user's saved criteria, addresses masked to neighborhood level (street number stripped). Full address + URL never returned pre-payment.
Route: `GET /api/listings/preview` — session cookie auth → UUID parse, rate limit, Drizzle query `listings` table (`is_canonical=true` + criteria price/beds filters) with `.limit(3)`. Drizzle `and()` with optional `gte/lte` clauses (Drizzle accepts `undefined` in `and()` and silently drops those conditions).
UI: Inline `ListingTeaser` in `app/page.tsx`. Blurred placeholder rows hint at hidden address. Lock icon + "Link" badge makes gating explicit. Empty state handles case where scraper hasn't run yet. Failure is non-fatal (shows empty state, CTA still goes to /checkout).
Consequences: Preview is useful only after AH-005/AH-008 populate `listings`. Until then, empty state shows. Session cookie from verify-otp reused — no new auth mechanism. maskAddress regex strips leading `\d+[A-Za-z]?\s+` then returns everything after the first comma.

---

## 2026-06-29 — AH-013: Landing page conversion copy overhaul
Context: Bare minimum requirement before marketing launch. The landing page needs to match AH3000's proven conversion structure.
Decision: Refactored `app/page.tsx` from a Client Component to a Server Component to directly query `listings` and `users` tables for dynamic social proof stats. Extracted the interactive OTP onboarding form into a new Client Component `components/onboarding-flow.tsx`.
UI: Added 7 sections to the landing page: Hero with quick-start criteria, Social Proof Bar (live stats), How It Works, Comparison Table, Origin Story, Pricing Section, and Final CTA.
Consequences: `app/page.tsx` now hits the DB on page load (with a 10-minute cache via `revalidate`). Onboarding form is rendered twice (Hero and Final CTA) which required updating E2E test locators with `.first()` to avoid strict mode violations.

---

## 2026-07-16 — AH-015: Dashboard with interactive listing map
Context: AH3000's core UX per the competitive teardown (§4a) — top-priority fast-follow, sequenced first because most remaining backlog tickets (inbox, favorites, amenity map) assume the dashboard shell exists.
Decision: New `/dashboard` route, gated to `status='active'` users only (not just any verified session) — expired/done/pending users are redirected to `/checkout` to (re)purchase, since this is the paid product surface, not the pre-payment teaser.
Route: `GET /api/listings/map` — same session-cookie auth pattern as `/api/listings/preview`, but requires active status and returns full untruncated listing data (exact address, lat/lng, url) instead of the masked/limited preview. Supports `minPrice`/`maxPrice`/`minBeds`/`source` query filters, capped at 500 results.
UI: `components/dashboard-map.tsx` — Mapbox GL JS (new dependency), full-screen dark-themed map centered on SF. Custom marker per listing (not Mapbox's default pin) showing price + relative time-since-posted, color-coded green/yellow/gray by recency. Click → bottom-sheet/side-panel detail card. Collapsible filter panel and stats bar ("X fresh listings in the last 3 days"), both responsive down to mobile widths.
Consequences: Requires a new env var `NEXT_PUBLIC_MAPBOX_TOKEN` (client-exposed, so intentionally separate from the server-only `MAPBOX_TOKEN` geocoding key — use a public-scoped Mapbox token, not the secret one) added to Vercel before the map renders; falls back to a clear "not configured" message rather than a blank map if missing. Map is only as useful as the pipeline's freshness — see the poller budget/health notes above.

**Follow-up real-browser fix (same day, still on the AH-015 PR):** initial real-Chrome verification (not just the sandboxed preview browser) found the map rendering as a solid black div with zero tiles. Root cause: `mapbox-gl.css` (imported by the component) loads as a separate stylesheet *after* Tailwind's compiled CSS, and `.mapboxgl-map { position: relative }` in that file beats Tailwind's `.absolute` utility at equal specificity — silently flipping the map container from `position: absolute` to `relative` and collapsing it to 0 height. Fixed by having the container fill its parent via `h-full w-full` instead of `absolute inset-0`, so it no longer depends on winning that cascade fight. Separately, the custom stats/filters bar and Mapbox's default `NavigationControl` both anchored to the top-right corner with no clearance (confirmed by measuring overlapping DOM rects at mobile and desktop widths) — moved the control to `bottom-right`. General lesson: any component that imports a third-party library's own CSS alongside Tailwind should assume that library's class-selector rules can silently win the cascade on shared class names (here, `position` on an element the library itself tags with its own class) — verify in a real browser, not just a typecheck/build pass.

---

## 2026-07-16 — Fix: poller upsert step timing out (issue #40, PR #41)
Context: Every RentCast poller run on 2026-07-16 failed with `FUNCTION_INVOCATION_TIMEOUT` (Vercel's 60s ceiling on `app/api/inngest/route.ts`, added the same week for the Craigslist/Apify call). Zero new listings ingested from any source that day — Craigslist was separately blocked on a missing `APIFY_API_TOKEN` at the same time.
Root cause: `dedupeAndUpsertListings()` (`lib/listings.ts`) processes its input sequentially, 2 blocking DB round-trips per item (dedupe `SELECT` + `INSERT ... ON CONFLICT`), all inside one un-chunked `step.run()` call. RentCast requests up to 500 listings/run; at 500 × 2 sequential round-trips with real Vercel(iad1)↔Supabase(us-west-1) latency, this reliably exceeded 60s. Craigslist's 80-item cap kept it under the same ceiling — latent, not yet triggered.
Fix: Both pollers now chunk the upsert into multiple `step.run('upsert-listings-chunk-N', ...)` calls (50 items/chunk), accumulating results before the `trigger-matching` event dispatch. Each `step.run()` is a separately checkpointed Inngest invocation with its own fresh `maxDuration` budget, so this fixes the timeout without changing `dedupeAndUpsertListings()` itself or fighting Inngest's execution model.
Consequences: `tests/unit/rentcastPoller.test.ts` and `tests/unit/craigslistPoller.test.ts` now mock chunked step names (`upsert-listings-chunk-0`, etc.) instead of a single `upsert-listings` step — any future poller changes touching the upsert step need to match this pattern. `dedupeAndUpsertListings()`'s underlying per-item sequential-round-trip cost is still there per chunk; if a poller's per-run item count or the chunk size grows significantly, the same failure mode could resurface — a batched (single multi-row `SELECT`/`INSERT`) rewrite of `dedupeAndUpsertListings()` itself would be the more durable fix if that happens.

---

## 2026-07-16 — AH-019: Notification settings (quiet hours, daily cap, pause/resume)
Context: AH3000 fast-follow ticket — user-configurable notification preferences. Worked in parallel with AH-016 (in-app inbox) in a separate worktree; no file overlap.
Schema: `users` gained `quiet_start`/`quiet_end` (time, default `21:00:00`/`08:00:00`), `max_daily_sms` (int, default `20`), `notifications_paused` (bool, default `false`). Migration `drizzle/0001_ah-019-notification-settings.sql`, applied directly to the `klyzbaepzyyhykyeobbp` Supabase project via MCP `apply_migration` (confirmed landed in `public.users`, not `auth.users`, which also has a same-named `users` table in this project — schema-qualify any ad hoc query against this DB from now on to avoid ambiguity). Defaults were chosen deliberately, not left at framework defaults: 21:00-08:00 quiet hours changes behavior for all existing users (no one is texted overnight going forward) but errs toward what users almost certainly want from an "apartment alert" product; `max_daily_sms=20` is generous enough not to silently throttle a real subscriber (RentCast alone can produce many matches per run) while still bounding worst-case Twilio spend per user per day; `notifications_paused` defaults `false` so existing active subscribers keep receiving texts exactly as before until they opt to pause.
Decision — quiet hours enforcement uses `step.sleepUntil()`, not a queue table or cron sweep: `inngest/functions/twilioSender.ts` checks `lib/quietHours.ts`'s `isWithinQuietHours()` against the receiving user's `quiet_start`/`quiet_end` at send time; if within the window, computes the next `quiet_end` instant via `nextQuietHoursEnd()` and calls `step.sleepUntil('wait-for-quiet-hours-end', ...)`. This durably suspends that one Inngest function invocation (Inngest persists step state, so it survives deploys/restarts) rather than requiring a separate poller to periodically re-check a "pending notifications" table — matches the pattern the ticket's implementation notes explicitly asked for.
Decision — hardcoded `America/Los_Angeles`, not UTC, and not a fixed offset: Propinno has no stored per-user timezone field and is an SF-only product, so every user's quiet hours are meant to be interpreted in Pacific time regardless of where the request happens to be served from. A fixed UTC offset (e.g. always -7 or -8) would be wrong for half the year across the March/November DST transitions; `lib/quietHours.ts` instead resolves the real IANA-zone offset at the specific instant in question via `Intl.DateTimeFormat`, verified correct across both 2026 DST transition dates in `tests/unit/quietHours.test.ts`. This is called out explicitly (not silently assumed) per the ticket's instructions, and documented in the module's own header comment.
Decision — daily cap enforced in `matchingEngine.ts`, not `twilioSender.ts`: a cap-skipped match is dropped for the day, not queued for later (quiet hours and the cap are different concerns — quiet hours delay a send, the cap prevents one). `findMatchingUsers()`'s SQL filters `NOT u.notifications_paused` and returns `max_daily_sms`; a new `getTodaysSentCount()` counts today's `sent` rows for the user using the same Pacific-day boundary as quiet hours (`lib/quietHours.ts`'s `startOfLocalDay()`, exported for reuse). An in-run `Map` tracks tentative dispatches within a single matching-engine invocation so one run matching a user against several listings can't blow past the cap before any of that run's `sent` rows actually exist (they're written later, asynchronously, once each `twilioSender` invocation completes — including after a quiet-hours wait).
Decision — defensive pause re-check after the quiet-hours wait: since a delayed send can wait up to ~24h (worst case: quiet hours cover nearly the full day), `twilioSender.ts` re-checks `notifications_paused` immediately after waking, in addition to the pre-wait check — a user who pauses mid-wait shouldn't still get texted once the window ends. This is a small addition beyond the ticket's literal checklist, justified because "pause/resume" needs a real enforcement point somewhere for the feature to functionally exist, and the quiet-hours delay is exactly where a stale pre-wait snapshot would otherwise cause a wrong send.
UI: New `/dashboard/settings` route (Server Component auth gate, same `status='active'`-only pattern as `/dashboard`) wrapping client component `components/notification-settings-form.tsx` — pause/resume toggle, quiet-hours start/end (`<input type="time">`), daily text limit, save button via new server actions `app/dashboard/settings/actions.ts` (`getNotificationSettings`, `updateNotificationSettings`; session-cookie auth + rate-limited, same pattern as `checkout/actions.ts`). `components/dashboard-map.tsx` gained a gear-icon link to the new settings page next to the existing Filters button.
Tests: `tests/unit/quietHours.test.ts` (new) covers `isWithinQuietHours`/`nextQuietHoursEnd`/`startOfLocalDay` directly, including both 2026 DST transition dates. `tests/unit/twilioSender.test.ts` extended with fake-timer-based cases for immediate-send-outside-quiet-hours, paused-skips-without-sleeping, delayed-send-then-sends, and delayed-then-paused-during-wait-skips. `tests/unit/matchingEngine.test.ts` extended with cases for under-cap dispatch, at-cap skip, and the in-run multi-listing tally.
Verified in a real browser (not just the sandboxed preview): started a second dev server on port 3010 from this worktree specifically (the shared preview-pane server was bound to the main repo checkout, not this branch, and lacked the new route — confirmed via a 404 before switching), created a disposable test user through the real onboarding + dev-mode OTP (`000000`) flow, flipped `status` to `active` via Supabase `execute_sql`, confirmed the settings page loads with the correct schema defaults, saved changed values (quiet hours, cap, pause) and confirmed both the immediate UI state and a full page reload reflect the persisted DB row, then flipped status back to `pending_payment` and confirmed `/dashboard/settings` redirects to `/checkout` instead of rendering. Test user and its cascade-deleted `criteria`/`sent` rows were removed afterward.
Consequences: `NOT u.notifications_paused` and the per-row `getTodaysSentCount()` query add a small amount of per-match overhead to `matchingEngine.ts` (one extra `db.execute` call per distinct matched user per run, not per listing) — acceptable at current volume, worth revisiting if matched-user counts grow much larger. Row Level Security is disabled on all `public` tables in the `klyzbaepzyyhykyeobbp` Supabase project, `public.users` included (pre-existing, unrelated to this ticket — flagged here because it surfaced while inspecting the `users` table schema; not fixed as part of this PR).
