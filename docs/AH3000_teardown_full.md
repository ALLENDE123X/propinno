# ApartmentHunter3000 — Full Competitive Teardown
## vs. Propinno (as of June 28, 2026)

---

## 1. PRODUCT POSITIONING

**AH3000 tagline:** "Finding you *long-term* housing in San Francisco"

**Voice:** Conversational, first-person character ("Hey! I'm ApartmentHunter3000"). Uses a mascot/avatar throughout. Speaks like a friend who's been through SF housing hell.

**Origin story:** "Built by someone who *lost the apartment* to whoever applied first. I spent six weeks hunting in SF. Thirty tours, ten applications, and I still kept losing places to people who simply saw the listing first."

**Social proof stats:** 100+ SF renters on the hunt | ~3 min new listing to your text | ~200/day new SF listings, watched 24/7

---

## 2. LANDING PAGE BEAT STRUCTURE

1. Hero — conversational intro + CTA + 3 quick-start templates
2. Social proof bar — 100+ renters / ~3 min / ~200/day
3. Feature 1 — Zones: "I watch your zones. Round the clock." + neighborhood map
4. Feature 2 — Commute: "I understand your commute." + transit isochrone
5. Feature 3 — Rich listing card with full detail + 3D amenity map
6. Origin story — founder stats (6 weeks / 30 tours / 10 applications)
7. Comparison table — "Everyone else" vs "You, with AH3000"
8. Testimonials — Maya S., Philip D.
9. Final CTA — repeat of hero

---

## 3. USER DASHBOARD (7 sections)

- **Map View** (default): Full-screen 3D Mapbox map, every listing as price+recency pin, pins labeled by source ("Facebook"), FILTER button, "493 fresh listings in 3 days"
- **Inbox**: In-app notification center with badge count
- **Facebook Listings**: Dedicated FB Marketplace section
- **Favourites**: Bookmark/save listings
- **Search Profile**: Edit criteria
- **Notification Settings**: Frequency, channels, quiet hours
- **Access Pass**: Payment/subscription management

---

## 4. SEARCH CRITERIA

| Criterion | AH3000 | Propinno |
|-----------|--------|----------|
| Price range | ✅ | ✅ |
| Bedrooms | ✅ | ✅ |
| Bathrooms | ✅ | ✅ (schema only) |
| Neighborhoods | ✅ (map) | ✅ (text) |
| Commute time | ✅ (isochrone) | ❌ |
| Pets | ✅ | ❌ |
| Laundry | ✅ | ❌ |
| NLP input | ✅ | ❌ |
| Templates | ✅ (3) | ❌ |

---

## 5. LISTING DETAIL

AH3000 shows: address, price, layout, laundry type, pet policy, transit time to BART, 3D amenity map (grocery, gym, laundry, bike share, transit).

Propinno SMS shows: address, price, beds, baths, source link.

---

## 6. DATA SOURCES

- AH3000: All major sites + Facebook Marketplace (dedicated section), ~200/day
- Propinno: RentCast + Craigslist RSS. Backlog: Zillow, Apartments.com, Zumper, FB Marketplace (Apify)

---

## 7. COPY PATTERNS TO REPLICATE

- "SF housing is CRAZY, and the good ones are gone in hours"
- "6 weeks of searching. 30 tours. 10 applications."
- "Everyone else: Refresh Zillow and hope / Apply 50th, get ghosted"
- "You: Every source watched 24/7 / Texted in minutes / First in line"
- Humor: "distance to the gym (even though you won't go)"
- Testimonials with specific details: "texted me 5 minutes after it posted"

---

## 8. PROPINNO ADVANTAGES

1. Live-match preview before payment (AH3000 hides data behind profile)
2. Transparent pricing ($39/$69 shown clearly)
3. One-time pass (no subscription anxiety)
4. Modern stack (faster iteration)
