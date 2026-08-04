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

## 7. Pricing & billing — recurring subscriptions (changed 2026-08-02)
Two **recurring, auto-renewing subscriptions**:
- **30-day pass — $9/month** (anchor)
- **90-day pass — $19/every 3 months** (hero; labeled **"Most popular"**, pre-selected — hunts run long, most self-select here)

Charge from day one (Stripe Checkout in `mode: 'subscription'` + webhook activation/renewal). Access enforced via `access_expires_at`, extended on each successful renewal invoice; expired/`done` users stop receiving texts. Convert via a live 1–3 real-match preview at onboarding (AH-011), **not** a free tier. Prices are a launch point — A/B the price **up**.

**This reverses the original decision, deliberately.** Sessions 1–N specified one-time passes on the reasoning that the product **churns by design** (people find a place and leave), and that auto-renew would generate post-move chargebacks/refunds that poison word-of-mouth. That churn dynamic has not gone away — it is now mitigated by product design rather than by pricing: a genuine one-click **"Cancel subscription"** action immediately terminates the Stripe subscription (not merely stopping texts, and not merely at period end), auto-renewal is disclosed in the Terms and at the point of purchase, and cancellation requires no email or support contact. (As of 2026-08-04 this action lives on `/dashboard/settings` rather than the immediate post-purchase success screen — a founder call not to show a cancel affordance the moment someone finishes paying, resolved after an independent review confirmed *some* self-serve path had to remain, per California's Automatic Renewal Law; see `ARCHITECTURE.md`'s 2026-08-04 session note.) The old **expiry → "extend?"** re-purchase prompt is obsolete under this model — renewal is now the default path and cancellation is the explicit user action. If post-move chargebacks do show up in practice, that is the signal the original reasoning was right, and this is the section to revisit first.

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
- RentCast API key · Stripe account + two **recurring** price IDs (live-mode; see `ARCHITECTURE.md` §9's "Stripe live-mode cutover" — the live secret key and webhook endpoint are still owner-only pending work) · fresh Supabase project · Mapbox geocoding token · domain (propinno.com).

## 12. Changelog / session log
- **Session 0 (setup):** Repo `ALLENDE123X/propinno` created (private). AH-001 → AH-010 filed as issues, sequenced revenue-first. PRD committed as `PRD.md`. Pending: owner provisioning (Twilio A2P first), Supabase project, Projects board wiring. Next ticket: **AH-001**.
- **Session 1 (pricing locked):** Pricing model set to **two one-time access passes — $39/30-day, $69/90-day (90 = "Most popular")**; recurring subscription dropped. AH-004 rewritten accordingly; added "found a place" + expiry "extend" lifecycle. Filed **AH-011** (onboarding live-match preview → paywall) as the fast-follow conversion lever. Schema `users.plan` → pass_30|pass_90; status adds `done`.
- **Session 2026-08-02 (pricing model reversed → recurring):** Session 1's one-time-pass decision **reversed by Pranav**. Now **two recurring auto-renewing subscriptions — $9/month, $19/every 3 months** (90 remains "Most popular"), replacing $39/$69 one-time. §7 rewritten with both the new model and the original anti-recurring rationale preserved, since the churn-by-design dynamic that motivated it still holds and is now mitigated by one-click genuine cancellation rather than by pricing. Implementation: `mode: 'subscription'` checkout, `users.stripe_customer_id`/`stripe_subscription_id`, `lib/billing.ts` renewal/cancellation lifecycle, "I found a place" upgraded from a status flip into a real Stripe cancellation, and every "one-time / no auto-renew" claim on the site corrected (Terms §4 rewritten with explicit auto-renewal + cancellation disclosure). `users.plan`'s `pass_30`/`pass_90` values kept as the billing-interval discriminator. **Live-mode Stripe cutover still outstanding** — see `ARCHITECTURE.md` §9.
