# Propinno — Product Requirements Doc (Master Spec)

This doc defines **HOW Propinno works**. It is the living spec the coding agent reads at session start. Update Section 12 in place at session end — never append duplicate spec sections.

## 1. Overview
Propinno is an automated SF apartment-matching service: it polls fresh rental listings around the clock, dedupes across sources, filters to each subscriber's criteria, and texts matches to their phone. Fast-follow of ApartmentHunter3000 (AH3000). The "holy shit" moment is automation that fires without the user doing anything — a fresh, filtered listing hits their phone the moment it drops.

## 2. Stack & reuse from Dealinno
Built by forking the Dealinno codebase and gutting the sales/email modules.
- **Reused untouched:** Next.js shell, Drizzle ORM + migrations, Supabase (Postgres), Inngest (background jobs), Stripe wiring, Vercel deploy, CI, PR/CI gates.
- **Swapped:** Google OAuth → phone-OTP onboarding.
- **Removed:** Gmail API + Pub/Sub, email classification, draft/approve/send sales flow.
- The scrape→dedupe→match→text loop is the same Inngest background-job pattern as Dealinno's email pipeline.

## 3. Data model
- **listings** — id, source, source_id, address, lat, lng, price, beds, baths, sqft, url, posted_at, first_seen_at, is_canonical, canonical_id, raw(jsonb). Unique(source, source_id); geo index on (lat,lng).
- **users** — id, phone(unique), status(pending_payment|active|expired|done), plan(pass_30|pass_90|null), access_expires_at, created_at.
- **criteria** — user_id, price_min, price_max, beds_min, beds_max, zips[], neighborhoods[].
- **sent** — user_id, listing_id, sent_at. Unique(user_id, listing_id).

## 4. The pipeline
1. **Poll** each source on an Inngest cron (15–30 min) → normalize → upsert into `listings`.
2. **Geocode + dedupe** — geocode address→lat/lng (Mapbox); collapse the same unit across sources by geo-proximity (~50m) + price into one canonical row.
3. **Match** — each new canonical listing → active users whose criteria fit, minus already-`sent`.
4. **Text** — Twilio SMS (address · price · beds · link); record in `sent`; idempotent.

## 5. Data sources
**Sprint (v1):** RentCast API (source #1, licensed backbone) + Craigslist sfbay `apa` RSS (source #2, free/real-time, highest SF volume).
**Backlog (post-v1, via Apify actors into the same pipeline):** Zillow (`maxcopell/zillow-zip-search`), Apartments.com (`one-api/apartments-property-scraper`), Zumper, Apartment List, Realtor.com, SpareRoom, Facebook Marketplace/Groups. Cover one source per non-syndicated segment; more sources = more dedup + more scam noise.
**Legal posture:** scraping sources prohibit it in ToS (Craigslist & CoStar have litigated). RentCast is licensed — keep it as the backbone; treat scrapers as the freshness/coverage layer.

## 6. Onboarding & auth
One public page: phone + criteria → Twilio OTP verify → create user(pending_payment)+criteria → live match preview (AH-011) → payment. No portal, no other auth. The onboarding page is also the landing page.

## 7. Pricing & billing — one-time access passes
The product **churns by design** (people find a place and leave), so there is **no recurring subscription** — auto-renew would generate post-move chargebacks/refunds that poison word-of-mouth. Two one-time passes:
- **30-day pass — $39** (anchor)
- **90-day pass — $69** (hero; labeled **"Most popular"**, pre-selected — hunts run long, most self-select here)

Charge from day one (Stripe one-time Checkout / Payment Links + webhook activation). Access enforced via `access_expires_at`; expired/`done` users stop receiving texts. **"Found a place" button** stops texts early; **expiry → "extend?"** prompt drives re-purchase (no silent auto-renew). Convert via a live 1–3 real-match preview at onboarding (AH-011), **not** a free tier. Prices are a launch point — A/B the price **up**; one-time pricing is easy to raise.

## 8. Monitoring
Failures reach customers instantly with no support buffer, so monitoring is mandatory. Inngest failure → alert; minimal `/admin` with run statuses, listing counts by source, sends/24h, recent failures.

## 9. Dev protocol & gates
- Tickets are GitHub Issues labeled **AH-XXX** on `ALLENDE123X/propinno`. Claude Desktop owns ticket creation; the coding agent runs `/ship-ticket AH-XXX #N`.
- PR workflow: feature branch + mandatory PR; hard limits **300 lines / 5 files**; CI green + Vercel "Ready" before merge.
- Review gates: security, tests, and a **legal audit** (data collection, OAuth/scope, SMS/A2P compliance, billing changes, AI disclosure) — plus Propinno additions: **data-source ToS/scraping risk** and **scam-listing handling**.

## 10. 24h sprint scope vs Backlog
**In sprint (AH-001 → AH-010):** seed/gut repo, schema, onboarding+OTP, Stripe (two one-time passes), RentCast poller, Craigslist RSS poller, geocode+dedupe, matching engine, Twilio sender, monitoring. Sequenced revenue-first: after AH-004 (Stripe), concierge revenue is possible Day 1 while the pipeline finishes.
**Fast-follow:** AH-011 (live-match preview paywall) — top conversion lever once listings flow.
**Out of sprint → Backlog:** additional sources, safety/scam-scoring layer, consumer web portal.

## 11. External provisioning (owner-only — Claude is barred from signups/credentials)
- **Twilio + A2P 10DLC registration — START DAY 0.** Texting US numbers needs carrier brand+campaign approval (1 day–~2 weeks); this is the long pole, like Gmail OAuth was for Dealinno. Low-volume starter tier or a verified toll-free number is faster.
- RentCast API key · Stripe account + two one-time price IDs · fresh Supabase project · Mapbox geocoding token · domain (propinno.com).

## 12. Changelog / session log
- **Session 0 (setup):** Repo `ALLENDE123X/propinno` created (private). AH-001 → AH-010 filed as issues, sequenced revenue-first. PRD committed as `PRD.md`. Pending: owner provisioning (Twilio A2P first), Supabase project, Projects board wiring. Next ticket: **AH-001**.
- **Session 1 (pricing locked):** Pricing model set to **two one-time access passes — $39/30-day, $69/90-day (90 = "Most popular")**; recurring subscription dropped. AH-004 rewritten accordingly; added "found a place" + expiry "extend" lifecycle. Filed **AH-011** (onboarding live-match preview → paywall) as the fast-follow conversion lever. Schema `users.plan` → pass_30|pass_90; status adds `done`.
