# ARCHITECTURE.md — Propinno

Living record of the codebase. Updated at the end of every dev session by the implementing agent.
Last updated: 2026-07-16 (AH-014 shipped, Facebook Marketplace added as a third listing source).

---

## 1. Product summary

Automated SF apartment-matching service. Polls rental listings from multiple sources around the clock, deduplicates across sources, geocodes addresses, matches each subscriber's saved criteria, and texts matching listings to their phone via SMS. One-time access passes ($39/30-day, $69/90-day); no recurring subscription — the product churns by design when users find an apartment. Fast-follow of ApartmentHunter3000.

---

## 2. Stack

Next.js 15 (App Router) · TypeScript · Drizzle ORM · Supabase (Postgres, us-west-1) · Inngest (background jobs) · Stripe (one-time checkout) · Twilio (SMS + Verify OTP) · Mapbox (geocoding) · RentCast API (licensed listing data) · Craigslist sfbay RSS (real-time free source) · Vercel (hosting) · Sentry (errors) · Axiom/Pino (structured logs) · Upstash Redis (rate limiting).

---

## 3. Data model (lib/db/schema.ts)

**users** — id (uuid PK), phone (unique), status (enum: pending_payment | active | expired | done), plan (enum: pass_30 | pass_90), access_expires_at, created_at.

**listings** — id (uuid PK), source, source_id (unique together), address, lat, lng, price, beds, baths, sqft, url, posted_at, first_seen_at, is_canonical (bool), canonical_id (uuid, points to canonical listing for dedupe), raw (jsonb). Indexes: geo (lat,lng), unique(source, source_id).

**criteria** — user_id (uuid PK, FK → users ON DELETE CASCADE), price_min, price_max, beds_min, beds_max, zips (text[]), neighborhoods (text[]).

**sent** — user_id + listing_id (unique together, both FK with CASCADE), sent_at. Tracks which listings have been texted to which users to prevent duplicates.

---

## 4. Core pipeline (Inngest functions)

All functions in `inngest/functions/`. Registered in `app/api/inngest/route.ts`.

**rentcastPoller.ts** — Cron: every 6h (`0 */6 * * *`), plus a manual `app/rentcast.manual-poll` trigger. Calls RentCast API for SF rental listings (`limit=500`). Budget-capped via `lib/pollerBudget.ts` (`claimDailyBudget`, max 20 req/day, Redis-backed) as an independent safety net on top of the cron schedule itself (see the RentCast cost-bleed incident in the memory checkpoint tree). Upserts into listings table (source='rentcast') via `dedupeAndUpsertListings`, chunked into multiple `step.run()` calls of 50 items each so no single Inngest step invocation exceeds the route's 60s `maxDuration` — up to 500 sequential DB round-trips in one step reliably timed out otherwise (fixed 2026-07-16, issue #40). Emits `app/listings.upserted` for canonical IDs.

**craigslistPoller.ts** — Cron: every 2h (`0 */2 * * *`). Craigslist's own RSS feeds (`?format=rss`) are blocked site-wide as of 2026-07-16 (confirmed independently, not IP/UA-specific) — listings now come from an Apify actor (`memo23/craigslist-scraper`, residential-proxy routed) instead, capped at 80 items/run via `MAX_ITEMS_PER_RUN`. Requires `APIFY_API_TOKEN` in Vercel env vars; fails closed with a clear error if missing. Budget-capped via the same `claimDailyBudget` pattern (max 24 runs/day). Same chunked-upsert fix as rentcastPoller, applied preemptively (not yet triggered at the 80-item cap, but same latent failure mode). Emits `app/listings.upserted`.

**facebookPoller.ts** (AH-014) — Cron: every 2h, offset 15min from craigslistPoller (`15 */2 * * *`), so the two Apify-backed pollers don't contend for DB connections at the same minute. Listings come from an Apify actor (`memo23/facebook-marketplace-scraper-ppe`), chosen over the official `apify/facebook-marketplace-scraper` after live-testing both: the official actor (8.5k users, but only 3.45/5 rating and no documented proxy/compliance approach) returned listings from Rocky Mount, NC for an SF-scoped query — it doesn't reliably honor geographic targeting. `memo23`'s actor explicitly documents built-in residential-proxy routing (same standard as the Craigslist swap) and correctly returned real SF Bay Area listings on every live test. Run with `includeSeller: true` and `daysSinceListed: '1'` — the former returns real per-listing GPS + timestamps at no extra line-item cost (folded into the flat $0.0015/result price), skipping the geocoding fallback for the common case same as craigslistPoller; the latter limits each run to listings from the last day so repeat runs don't re-bill for the same still-live items. Beds/baths aren't structured fields on this actor — parsed via regex from the listing title text (`"3 beds · 2 baths"`), null when absent (e.g. non-apartment "propertyrentals" listings). No square footage available from this source. Capped at 80 items/run, budget-capped via `claimDailyBudget` (max 24 runs/day) — same pattern and caps as craigslistPoller; worst case ~$1.50/day (~$45/month) at the actor's $0.0015/result + $0.005/run pricing. Requires `APIFY_API_TOKEN` (shared with craigslistPoller); fails closed with a clear error if missing. Same chunked-upsert pattern as the other two pollers. Emits `app/listings.upserted`.

**matchingEngine.ts** — Triggered by `listing/new` event. Geocodes via Mapbox if lat/lng missing. Runs cross-source dedupe (sets is_canonical/canonical_id). For canonical listings: queries all active users whose criteria match (price range, beds range, neighborhood/zip overlap), excluding already-sent pairs. Emits `notification/send` for each match.

**twilioSender.ts** — Triggered by `notification/send` event. Sends SMS via Twilio with listing details (address, price, beds, link). Records in sent table.

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

---

## 6. Pages (app/)

**/ (page.tsx)** — Landing + onboarding. Phone input → OTP → criteria form → plan selection → Stripe redirect.

**/checkout** — Post-checkout confirmation page. Active-pass users see a "View live map" link to `/dashboard`.

**/dashboard** — Server Component auth gate (session cookie → `status='active'` only, else redirect to `/checkout`) wrapping the `DashboardMap` client component.

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

**components/dashboard-map.tsx** — Client component: full-screen Mapbox GL JS map centered on SF, one marker per canonical listing (colored by recency: green <24h, yellow <3d, gray older; label shows price + time-since-posted). Click a pin → detail card (address, beds/baths, source, link out). Filter panel (price range, min beds, source) re-fetches `/api/listings/map` on change. Stats bar shows count posted in the last 3 days. Mobile: filter panel and detail card collapse to bottom sheets. Renders a "Mapbox token not configured" message if `NEXT_PUBLIC_MAPBOX_TOKEN` is unset rather than a blank/broken map.

---

## 8. External service map

| Service | Env var(s) | Purpose |
|---------|-----------|----------|
| Supabase | DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY | Postgres DB (via transaction pooler on IPv4) |
| Stripe | STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_PRICE_30DAY, STRIPE_PRICE_90DAY, STRIPE_WEBHOOK_SECRET | One-time checkout payments |
| Twilio | TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, TWILIO_VERIFY_SERVICE_SID | SMS delivery + phone OTP |
| RentCast | RENTCAST_API_KEY | Licensed SF rental listing data |
| Apify | APIFY_API_TOKEN | Craigslist + Facebook Marketplace listing scraping (residential-proxy-routed actors), shared across both pollers |
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
| AH-014 | #42 | Facebook Marketplace listing source (Apify) | 2026-07-16 |

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

## 2026-07-16 — AH-014: Facebook Marketplace listing source
Context: Third listing source alongside RentCast and Craigslist, per the AH3000 competitive teardown (§5) and issue #26. Blocked on "Apify actor selection + ToS/scraping risk review" — same category of blocker the Craigslist RSS→Apify swap had already solved earlier the same day, and issue #26's own comment pointed at that PR as the template.
Decision: Live-tested two Apify actor candidates against real `propertyrentals`-category SF Bay Area queries before picking one — `apify/facebook-marketplace-scraper` (official, 8.5k users) returned listings from Rocky Mount, NC for an SF-scoped `startUrls` query, i.e. it doesn't reliably honor geographic targeting. `memo23/facebook-marketplace-scraper-ppe` (5/5 rating, 99%+ success rate, and the same publisher whose Craigslist actor already proved out this pattern) explicitly documents built-in residential-proxy routing and correctly returned real Bay Area listings (Hayward, South San Francisco, San Ramon, Antioch) on every live test — chosen for both the correctness result and consistency with the project's established proxy-routing/ToS standard for scraping actors.
Route: New `inngest/functions/facebookPoller.ts`, registered in `app/api/inngest/route.ts`. Same shape as `craigslistPoller.ts`: `fetchFacebookViaApify()` calls the actor's `run-sync-get-dataset-items` REST endpoint directly (not the Apify MCP — the deployed app can't use this session's MCP connection), `upsertApifyFacebookListings()` maps fields onto the shared listing shape and calls `dedupeAndUpsertListings()` (now typed to accept `source: 'facebook'` too, in `lib/listings.ts`), chunked into `step.run('upsert-listings-chunk-N', ...)` (50 items/chunk, same pattern as the other two pollers per issue #40/PR #41). Cron `15 */2 * * *` — every 2h like craigslistPoller, offset 15 minutes so the two Apify-backed pollers don't fire in the same minute. Budget-capped via `claimDailyBudget('facebook-poller', 24)`, `MAX_ITEMS_PER_RUN = 80` — same caps as craigslistPoller since the actor's pricing ($0.0015/result) is in the same range and live-test volume (single-digit fresh listings per query) didn't justify differing.
Data quality: run with `includeSeller: true`, which fetches each listing's detail page and returns real per-listing GPS coordinates and real ISO timestamps — at no extra line-item cost on this actor (folded into the flat per-result price, unlike competing actors that bill detail-page fetches separately). Same "skip the geocoding fallback" win the Craigslist swap got. Beds/baths aren't structured output fields on this actor; parsed via regex from the listing title text (e.g. `"3 beds · 2 baths"`), correctly null for listings that don't have them (studios, room shares, non-residential "propertyrentals" listings like standalone commercial suites). No square footage available from this source.
Consequences: `APIFY_API_TOKEN` is now depended on by two pollers, not one — added a missing row for it to the External service map (§8), which had never listed Apify at all despite craigslistPoller depending on it since the previous session. Cost worst case ~$1.50/day (~$45/month) per poller at the scheduled cadence, same ceiling as craigslistPoller; real-world cost should be well under that given FB Marketplace SF rental volume observed live. This PR needs explicit human sign-off before merge given Facebook's history of pursuing scrapers legally more aggressively than most sites — flagged in the PR description, not assumed to auto-merge on green CI.
