import { inngest } from '../client'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { dedupeAndUpsertListings } from '@/lib/listings'
import { claimDailyBudget } from '@/lib/pollerBudget'
import { parseImagesFromApartmentList } from '@/lib/listingImages'

// Apartment List listings come from an Apify actor
// (solidcode/apartmentlist-com-scraper), following the same
// research-then-live-test pattern as the Craigslist/Facebook Apify swaps.
// Two ApartmentList-specific candidates existed on the Apify Store (neither
// from memo23 - that publisher's Craigslist/Facebook Marketplace/Realtor.com
// actors don't extend to this site); both were live-tested against a real
// San Francisco query before picking one:
//   - jongoose/apartment-list-scraper ($0.001/result, cheapest, city-wide
//     single-request design) - crashed on every live test call
//     (`pydantic_core.ValidationError` inside the actor's own charging code,
//     unrelated to input) - a real, reproduced failure, not a guess, and a
//     sign of an immature/fragile actor (2 total users, last modified 4 days
//     before this test). Its own input schema also states it "works fine
//     through Apify's default (datacenter) proxy - no residential proxy
//     needed" - the opposite of this project's established proxy-routing
//     preference for scraping actors.
//   - solidcode/apartmentlist-com-scraper ($0.00225/result + $0.005/run,
//     BRONZE tier) - succeeded cleanly on every live test call against a
//     real `["San Francisco, CA"]` query, returning real SF properties (e.g.
//     "2051 3rd St, San Francisco, CA 94107" / "973 Market Street, San
//     Francisco, CA 94103", real lat/lng inside SF bounds, real
//     cdn.apartmentlist.com photo URLs, real per-unit floorplan pricing).
//     Chosen for actually working correctly over the cheaper option that
//     didn't, matching this project's established "live-test before
//     committing, don't assume the popular/cheap option is right" standard.
//
// Run with includeDetails:true - the actor's own pricing only bills two
// event types ("Actor Start" and "result", no separate "detail fetch"
// charge), so the fuller per-property page fetch (real unit-level
// floorplans/prices/availability/photos instead of just the search-card
// summary) costs nothing extra, same "flag that unlocks real per-listing
// data at no marginal cost" pattern as Facebook's `includeSeller:true`.
//
// One real, load-bearing shape finding from the live test that this
// mapping depends on: a "property" record bundles many floorplans under
// `units[]`, but most have `price: null` (unpriced/unavailable floorplan
// templates, not real listings) - only units with `availability ===
// 'available'` AND a real numeric `price` are genuine, currently-listed
// units (confirmed: of 27 units on one live property, exactly 2 matched
// this; of 11 units on another, exactly 1 did). upsertApifyApartmentListListings
// explodes each property into one Propinno listing per such live unit,
// matching the "one listing = one rentable unit" granularity every other
// source already has, rather than one blurry multi-unit-range row per
// property.
const APIFY_ACTOR = 'solidcode~apartmentlist-com-scraper'

// Apartment List's inventory (professional property managers on
// month-to-month-updated floorplans) moves slower than individual
// Craigslist/Facebook posts, so this poller runs on RentCast's 6h cadence
// rather than the 2h Craigslist/Facebook cadence - see the cron below.
// MAX_ITEMS_PER_RUN counts properties (Apify's billed "result" unit), not
// the exploded per-unit listings that come out of upsert.
const MAX_ITEMS_PER_RUN = 80
const UPSERT_CHUNK_SIZE = 50 // same chunked-upsert pattern as the other three pollers (issue #40, PR #41) - avoids the route's 60s maxDuration timing out on sequential per-item DB round-trips

interface ApifyApartmentListUnit {
  floorplan?: string | null
  unitName?: string | null
  bedrooms?: number | null
  bathrooms?: number | null
  sqft?: number | null
  price?: number | null
  totalPrice?: number | null
  availability?: string | null
  photos?: string[] | null
  [key: string]: unknown
}

interface ApifyApartmentListItem {
  id: string
  url: string
  propertyName?: string | null
  formattedAddress?: string | null
  latitude?: number | null
  longitude?: number | null
  petPolicy?: string | null
  amenities?: string[] | null
  photos?: string[] | null
  units?: ApifyApartmentListUnit[] | null
  [key: string]: unknown
}

function parseNumeric(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// Only units with a confirmed availability status AND a real advertised
// price are genuine, currently-listed units - see the header comment above
// for the live-data finding behind this filter (most `units[]` entries are
// unpriced floorplan templates, not real listings).
function isLiveUnit(unit: ApifyApartmentListUnit): boolean {
  return unit.availability === 'available' && typeof unit.price === 'number' && Number.isFinite(unit.price)
}

export const fetchApartmentListViaApify = async (): Promise<ApifyApartmentListItem[]> => {
  const apifyToken = process.env.APIFY_API_TOKEN
  if (!apifyToken) {
    throw new Error('APIFY_API_TOKEN is not set')
  }

  const res = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${apifyToken}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: ['San Francisco, CA'],
        maxResults: MAX_ITEMS_PER_RUN,
        includeDetails: true,
        petPolicy: 'any',
      }),
    }
  )

  if (!res.ok) {
    throw new Error(`Apify Apartment List actor returned ${res.status}: ${await res.text()}`)
  }

  return (await res.json()) as ApifyApartmentListItem[]
}

export const upsertApifyApartmentListListings = async (
  items: ApifyApartmentListItem[]
): Promise<{ count: number; canonicalIds: string[] }> => {
  if (!Array.isArray(items) || items.length === 0) return { count: 0, canonicalIds: [] }

  const values = items.flatMap((item) => {
    const liveUnits = (item.units ?? []).filter(isLiveUnit)

    return liveUnits.map((unit) => {
      const unitLabel = unit.unitName || unit.floorplan || 'unit'
      const address = item.formattedAddress
        ? `${item.formattedAddress}, Unit ${unitLabel}`
        : 'San Francisco, CA'

      return {
        source: 'apartmentlist' as const,
        sourceId: `${item.id}-${unitLabel}`,
        address,
        // One lat/lng per property - every unit inside the same building
        // shares it, same as a single geocoded street address would.
        lat: parseNumeric(item.latitude),
        lng: parseNumeric(item.longitude),
        price: parseNumeric(unit.price),
        beds: parseNumeric(unit.bedrooms),
        baths: parseNumeric(unit.bathrooms),
        sqft: parseNumeric(unit.sqft),
        // No per-unit URL on this actor's output (units[].applyUrl was null
        // on every live-tested unit) - every unit at a property links to
        // that property's own canonical listing page.
        url: item.url,
        // No genuine "date first listed" field anywhere in this actor's
        // output (availabilityLastChecked/updatedAt/scrapedAt all describe
        // when Apify's own scrape ran, not when the unit was listed) - null
        // rather than a guess, same "don't fabricate a missing field"
        // precedent as Facebook's sqft:null and RentCast's pet/laundry
        // nulls elsewhere in this codebase.
        postedAt: null,
        raw: { property: item, unit } as unknown as Record<string, unknown>,
        // Listing images - see lib/listingImages.ts.
        images: parseImagesFromApartmentList({
          unitPhotos: unit.photos,
          propertyPhotos: item.photos,
        }),
      }
    })
  })

  if (values.length === 0) return { count: 0, canonicalIds: [] }

  return await dedupeAndUpsertListings(values)
}

export const apartmentListPoller = inngest.createFunction(
  {
    id: 'apartment-list-poller',
    // Every 6h like rentcastPoller (Apartment List's professionally-managed
    // inventory changes slower than Craigslist/Facebook's individual posts),
    // offset 30 minutes so it never fires in the same minute as rentcastPoller
    // (`0 */6 * * *`) or contends for DB connections with it.
    triggers: [{ cron: '30 */6 * * *' }]
  },
  async ({ step }) => {
    // 4 scheduled runs/day, 2x headroom for retries - same ratio as
    // craigslistPoller/facebookPoller's 24-cap-on-12-scheduled-runs. Worst
    // case cost: 8 runs/day * (80 items * $0.00225/result + $0.005/run
    // start) = 8 * $0.185 = ~$1.48/day (~$44/month), just under this
    // project's established ~$1.50/day-per-poller ceiling (see
    // craigslistPoller.ts's cost-math comment for the pattern this copies).
    const withinBudget = await step.run('check-daily-budget', () =>
      claimDailyBudget('apartment-list-poller', 8)
    )
    if (!withinBudget) {
      logger.warn('Apartment List poller skipped - daily run budget already used today')
      return { skipped: true, reason: 'daily-budget-exceeded' }
    }

    try {
      const items = await step.run('fetch-apartmentlist-apify', fetchApartmentListViaApify)

      let upserted = 0
      const canonicalIds: string[] = []
      for (let i = 0; i < items.length; i += UPSERT_CHUNK_SIZE) {
        const chunk = items.slice(i, i + UPSERT_CHUNK_SIZE)
        const chunkResult = await step.run(`upsert-listings-chunk-${i / UPSERT_CHUNK_SIZE}`, () =>
          upsertApifyApartmentListListings(chunk)
        )
        upserted += chunkResult.count
        canonicalIds.push(...chunkResult.canonicalIds)
      }

      if (canonicalIds.length > 0) {
        await step.sendEvent('trigger-matching', {
          name: 'app/listings.upserted',
          data: { listingIds: canonicalIds }
        })
      }

      logger.info(
        { fetched: items.length, upserted },
        'Apartment List (Apify) poller completed successfully'
      )

      return { fetched: items.length, upserted }
    } catch (error) {
      Sentry.captureException(error)
      logger.error({ err: error }, 'Apartment List (Apify) poller failed')
      throw error
    }
  }
)
