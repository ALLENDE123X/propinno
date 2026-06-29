# ARCHITECTURE.md — Propinno

Living record of the codebase. Updated at the end of every dev session by the implementing agent.
Last updated: 2026-06-28 (AH-010 shipped, pipeline verified end-to-end).

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

**rentcastPoller.ts** — Cron: every 15 min. Calls RentCast API for SF rental listings. Upserts into listings table (source='rentcast'). Emits `listing/new` event for each new listing.

**craigslistPoller.ts** — Cron: every 15 min. Parses Craigslist sfbay RSS feed. Upserts into listings (source='craigslist'). Emits `listing/new` event.

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

---

## 6. Pages (app/)

**/ (page.tsx)** — Landing + onboarding. Phone input → OTP → criteria form → plan selection → Stripe redirect.

**/checkout** — Post-checkout confirmation page.

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

---

## 8. External service map

| Service | Env var(s) | Purpose |
|---------|-----------|----------|
| Supabase | DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY | Postgres DB (via transaction pooler on IPv4) |
| Stripe | STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_PRICE_30DAY, STRIPE_PRICE_90DAY, STRIPE_WEBHOOK_SECRET | One-time checkout payments |
| Twilio | TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, TWILIO_VERIFY_SERVICE_SID | SMS delivery + phone OTP |
| RentCast | RENTCAST_API_KEY | Licensed SF rental listing data |
| Mapbox | MAPBOX_TOKEN | Address geocoding (lat/lng) |
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
| AH-013 | TBD | Landing page conversion copy overhaul | 2026-06-29 |

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
