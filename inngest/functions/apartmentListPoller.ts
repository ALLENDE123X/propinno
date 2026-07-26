import { inngest } from '../client'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { dedupeAndUpsertListings } from '@/lib/listings'
import { claimDailyBudget } from '@/lib/pollerBudget'
import { parseImagesFromApartmentList } from '@/lib/listingImages'
import { runApifyActorAsync, type ApifyStepTools } from '@/lib/apifyAsync'

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
// this; of 11 units on another, exactly 1 did). flattenApartmentListUnits
// explodes each property into one Propinno listing per such live unit,
// matching the "one listing = one rentable unit" granularity every other
// source already has, rather than one blurry multi-unit-range row per
// property.
//
// IMPORTANT, and the reason this poller broke in production: those two
// live-test properties (2-of-27 and 1-of-11) badly understated the real
// fan-out. Measured against real production rows on 2026-07-26, this
// source averages **7.55 live units per property, max 45** - so 80
// properties is ~600 listings, not ~80. Anything sized "per item" here
// must be sized against flattened units, not properties; see
// UPSERT_CHUNK_SIZE below.
const APIFY_ACTOR = 'solidcode~apartmentlist-com-scraper'

// Apartment List's inventory (professional property managers on
// month-to-month-updated floorplans) moves slower than individual
// Craigslist/Facebook posts, so this poller runs on RentCast's 6h cadence
// rather than the 2h Craigslist/Facebook cadence - see the cron below.
// MAX_ITEMS_PER_RUN counts properties (Apify's billed "result" unit), not
// the exploded per-unit listings that come out of upsert.
const MAX_ITEMS_PER_RUN = 80
// Counts *flattened units* (= one Propinno listing each), NOT properties.
// This distinction is load-bearing and was the cause of a real production
// incident: this poller used to chunk on `items` (properties) while the
// per-property fan-out happened inside the step, so a nominally "50-item"
// chunk was really ~377 listings on average (live production data:
// 7.55 live units per property, max 45 on a single property) - i.e. ~750
// sequential dedupe-SELECT + INSERT round-trips inside one 60s Vercel
// invocation, which blew `maxDuration` and returned a 504 to Inngest on
// every single 6h cron tick. Every other poller is 1 input item -> 1
// listing so 50 genuinely meant 50; apartmentsPoller.ts is the other
// fan-out source and already flattened before chunking - this poller now
// matches it. See issue #76.
const UPSERT_CHUNK_SIZE = 50

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

// Async run+poll+dataset-fetch via lib/apifyAsync.ts, not the old blocking
// run-sync-get-dataset-items endpoint - see that file's header comment for
// why (this poller hit the real production 504 timeout that motivated the
// fix, on 2026-07-22). `step` must be the calling Inngest function's own
// step object - the helper makes its own step.run/step.sleep calls
// internally, so this can't be called from inside another step.run()
// (Inngest doesn't support nesting steps).
export const fetchApartmentListViaApify = (step: ApifyStepTools): Promise<ApifyApartmentListItem[]> =>
  runApifyActorAsync<ApifyApartmentListItem>(step, APIFY_ACTOR, {
    location: ['San Francisco, CA'],
    maxResults: MAX_ITEMS_PER_RUN,
    includeDetails: true,
    petPolicy: 'any',
  })

export interface FlattenedApartmentListUnit {
  property: ApifyApartmentListItem
  unit: ApifyApartmentListUnit
}

// Pure, synchronous fan-out (one property -> N live-unit rows) - not wrapped
// in its own step.run since it does no I/O and is cheap/deterministic, same
// reasoning as apartmentsPoller.ts's flattenApartmentsUnits. Exported for
// direct unit testing.
//
// Doing this in the handler *before* chunking (rather than inside the upsert
// step, as this poller originally did) is the whole point: it makes
// UPSERT_CHUNK_SIZE mean "50 listings" instead of "50 properties, which is
// really ~377 listings" - see that constant's comment for the production
// 504 this caused.
export function flattenApartmentListUnits(
  properties: ApifyApartmentListItem[]
): FlattenedApartmentListUnit[] {
  if (!Array.isArray(properties)) return []
  const units: FlattenedApartmentListUnit[] = []
  for (const property of properties) {
    for (const unit of (property.units ?? []).filter(isLiveUnit)) {
      units.push({ property, unit })
    }
  }
  return units
}

export const upsertApifyApartmentListListings = async (
  units: FlattenedApartmentListUnit[]
): Promise<{ count: number; canonicalIds: string[] }> => {
  if (!Array.isArray(units) || units.length === 0) return { count: 0, canonicalIds: [] }

  const values = units.map(({ property, unit }) => {
    const unitLabel = unit.unitName || unit.floorplan || 'unit'
    const address = property.formattedAddress
      ? `${property.formattedAddress}, Unit ${unitLabel}`
      : 'San Francisco, CA'

    // Full property record minus the per-unit `units` array (this unit's
    // siblings) - kept lean so `raw` doesn't redundantly store the same
    // multi-KB property blob, including every sibling unit, once per
    // flattened unit row. Same trimming rationale (and same measured
    // problem) as apartmentsPoller.ts stripping models/rentals: before this,
    // apartmentlist rows averaged 9.2KB of `raw` each, the largest of any
    // source and 2x Apartments.com's, which is per-row INSERT payload paid
    // inside the very step that was timing out.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { units: _units, ...propertyRest } = property

    return {
      source: 'apartmentlist' as const,
      sourceId: `${property.id}-${unitLabel}`,
      address,
      // One lat/lng per property - every unit inside the same building
      // shares it, same as a single geocoded street address would.
      lat: parseNumeric(property.latitude),
      lng: parseNumeric(property.longitude),
      price: parseNumeric(unit.price),
      beds: parseNumeric(unit.bedrooms),
      baths: parseNumeric(unit.bathrooms),
      sqft: parseNumeric(unit.sqft),
      // No per-unit URL on this actor's output (units[].applyUrl was null
      // on every live-tested unit) - every unit at a property links to
      // that property's own canonical listing page.
      url: property.url,
      // No genuine "date first listed" field anywhere in this actor's
      // output (availabilityLastChecked/updatedAt/scrapedAt all describe
      // when Apify's own scrape ran, not when the unit was listed) - null
      // rather than a guess, same "don't fabricate a missing field"
      // precedent as Facebook's sqft:null and RentCast's pet/laundry
      // nulls elsewhere in this codebase.
      postedAt: null,
      raw: { property: propertyRest, unit } as unknown as Record<string, unknown>,
      // Listing images - see lib/listingImages.ts.
      images: parseImagesFromApartmentList({
        unitPhotos: unit.photos,
        propertyPhotos: property.photos,
      }),
    }
  })

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
      const properties = await fetchApartmentListViaApify(step)
      const units = flattenApartmentListUnits(properties)

      let upserted = 0
      const canonicalIds: string[] = []
      for (let i = 0; i < units.length; i += UPSERT_CHUNK_SIZE) {
        const chunk = units.slice(i, i + UPSERT_CHUNK_SIZE)
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
        { fetchedProperties: properties.length, flattenedUnits: units.length, upserted },
        'Apartment List (Apify) poller completed successfully'
      )

      return { fetched: units.length, upserted }
    } catch (error) {
      Sentry.captureException(error)
      logger.error({ err: error }, 'Apartment List (Apify) poller failed')
      throw error
    }
  }
)
