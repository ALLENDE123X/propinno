import { inngest } from '../client'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { dedupeAndUpsertListings } from '@/lib/listings'
import { claimDailyBudget } from '@/lib/pollerBudget'
import { parseImagesFromZumper } from '@/lib/listingImages'

// Zumper listings come from an Apify actor
// (benthepythondev/zumper-rental-scraper), chosen after live-testing two
// candidates against a real san-francisco-ca query (2026-07-17):
//   - memo23/zumper-cheerio - same publisher whose Craigslist/Facebook
//     actors this project already uses, so it was the natural first check
//     ("same publisher worked before" is exactly the assumption the AH-014
//     session warned not to make without testing - and here it didn't hold).
//     A live 5-item call took 33s and returned only 4 items, and each item
//     was a raw ~500-field dump of Zumper's internal Next.js page state
//     (hundreds of `entity.data.amenity_groups.<Name>.level/group/parent_display`
//     keys - a static amenity taxonomy, not per-listing data) with core
//     fields frequently null (`pet_policy: null` on 3 of 4 items,
//     `average_price`/`units`/`activeListings` null throughout). Matches its
//     1/5 rating (1 review) and 4 total users - genuinely low quality, not
//     just an unlucky sample.
//   - benthepythondev/zumper-rental-scraper (32 users, 100% success rate) -
//     calls Zumper's own JSON search API directly (no headless browser),
//     explicitly routes through Apify's US residential proxy
//     (`useApifyProxy`, on by default) - the same proxy-routing standard
//     this project already required of the Craigslist/Facebook actors. A
//     live 5-item call against `location: 'san-francisco-ca'` returned in
//     ~4s with clean, fully-populated fields: real SF addresses (94105,
//     94103, 94158, 94107), real lat/lng, price/bed/bath ranges, a
//     structured `pets_allowed` array, and working `url`s - chosen for both
//     the correctness result and the proxy-routing consistency.
//
// One real, documented limitation worth knowing before touching this poller
// again: unlike Craigslist (`postedToday`) and Facebook (`daysSinceListed`),
// this actor's "search" mode has no freshness filter or pagination/offset
// input - every run re-requests (and re-bills for) substantially the same
// top-N results for `san-francisco-ca`, sorted however Zumper's own search
// API defaults to ranking them. This is still useful (keeps price/
// availability current for prominent SF buildings) but doesn't give the
// long-tail "brand new single-unit listing" discovery the other two Apify
// sources do. Re-triggering matching for an unchanged canonical listing on
// every run is safe, not spammy - `matchingEngine.ts`'s `findMatchingUsers`
// LEFT JOINs `sent` and only matches users who haven't already been sent
// that exact listing.
//
// Also unlike RentCast/Craigslist/Facebook, most `search`-mode results here
// are apartment *buildings* with a range of floorplans rather than one
// specific unit (e.g. `beds_min: 0, beds_max: 3`), so `price`/`beds`/`baths`
// below map onto the `_min` (starting/lowest) variant - the single number
// most comparable to how the other sources represent one listing. A
// follow-up "direct_urls" call against one of these same building URLs (to
// try to reach individual-unit/floorplan-level detail) returned 0 dataset
// items, so that finer-grained data isn't available through this actor.
const APIFY_ACTOR = 'benthepythondev~zumper-rental-scraper'

// Zumper's per-result price ($0.015) is roughly 6-10x Craigslist's ($0.0025)
// or Facebook's ($0.0015), so matching their MAX_ITEMS_PER_RUN=80 would blow
// well past this project's ~$1.50/day-per-poller ceiling. Kept low
// deliberately - see the cron/budget cost math below.
const MAX_ITEMS_PER_RUN = 12

// Same chunked-upsert pattern as the other pollers (issue #40/PR #41), kept
// for consistency even though a 12-item run never comes close to triggering
// it - if MAX_ITEMS_PER_RUN ever grows, this is already in place.
const UPSERT_CHUNK_SIZE = 50

interface ApifyZumperItem {
  listing_id: number | string
  url?: string | null
  address?: string | null
  street?: string | null
  city?: string | null
  state?: string | null
  zipcode?: string | null
  latitude?: number | null
  longitude?: number | null
  // Most search-mode results are buildings with a range of floorplans, not
  // one specific unit - see the header comment for why `_min` is used as
  // the single comparable value for each field.
  price_min?: number | null
  price_max?: number | null
  beds_min?: number | null
  beds_max?: number | null
  baths_min?: number | null
  baths_max?: number | null
  // Structured pet-policy array (e.g. ["Cats", "Dogs"]), confirmed present
  // on every live-tested item - unlike RentCast, this data does exist here.
  // Not parsed into `petsAllowed` in this PR to keep scope tight (see
  // lib/listingAttributes.ts's existing per-source parsers); a reasonable
  // follow-up once that shared parsing convention is extended to Zumper's
  // array shape.
  pets_allowed?: string[] | null
  // Opaque numeric photo IDs only, never a resolvable URL - see
  // lib/listingImages.ts's parseImagesFromZumper for the live-tested
  // rationale.
  image_ids?: number[] | null
  [key: string]: unknown
}

function parseNumeric(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export const fetchZumperViaApify = async (): Promise<ApifyZumperItem[]> => {
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
        mode: 'search',
        location: 'san-francisco-ca',
        propertyType: 'apartments-for-rent',
        maxListings: MAX_ITEMS_PER_RUN,
        includePhotos: true,
        useApifyProxy: true,
      }),
    }
  )

  if (!res.ok) {
    throw new Error(`Apify Zumper actor returned ${res.status}: ${await res.text()}`)
  }

  return (await res.json()) as ApifyZumperItem[]
}

export const upsertApifyZumperListings = async (
  items: ApifyZumperItem[]
): Promise<{ count: number; canonicalIds: string[] }> => {
  if (!Array.isArray(items) || items.length === 0) return { count: 0, canonicalIds: [] }

  const values = items.map((item) => {
    const constructedAddress = [item.street, item.city, item.state, item.zipcode]
      .filter(Boolean)
      .join(', ')
    return {
      source: 'zumper' as const,
      sourceId: String(item.listing_id),
      address: item.address || constructedAddress || 'San Francisco, CA',
      lat: parseNumeric(item.latitude),
      lng: parseNumeric(item.longitude),
      price: parseNumeric(item.price_min),
      beds: parseNumeric(item.beds_min),
      baths: parseNumeric(item.baths_min),
      // Not present anywhere in this actor's output (confirmed via two live
      // test calls) - unlike Craigslist's `space`, there's no square-footage
      // field to parse here.
      sqft: null,
      url: item.url || null,
      // No listing-posted-date field exists in this actor's output -
      // `date_available` is move-in availability (and was null across every
      // live-tested item), not a posting timestamp, so it isn't a usable
      // substitute the way Craigslist's `datetime`/Facebook's `timestamp` are.
      postedAt: null,
      raw: item as unknown as Record<string, unknown>,
      // Listing images - see lib/listingImages.ts. Always [] today.
      images: parseImagesFromZumper(item),
    }
  })

  return await dedupeAndUpsertListings(values)
}

// Cron every 6 hours, offset 45 minutes from rentcastPoller's own
// `0 */6 * * *` schedule so the two 6-hourly pollers don't fire in the same
// minute and contend for DB connections (same offset reasoning
// facebookPoller.ts already uses against craigslistPoller.ts). 6 hours
// mirrors rentcastPoller's cadence rather than craigslistPoller/
// facebookPoller's every-2-hours: this actor's "search" mode has no
// freshness filter (see header comment), so polling more often wouldn't
// reliably surface newer data, just re-bill for substantially the same
// top-N results.
//
// Cost math, mirroring the pattern in craigslistPoller.ts's comments:
// actor pricing is $0.015/result-event (+ a negligible ~$0.00005 start
// event). At MAX_ITEMS_PER_RUN=12 and a budget cap of 8 runs/day (2x the 4
// scheduled runs/day, same "headroom for retries" convention as the other
// pollers), worst case is 8 * 12 * $0.015 = $1.44/day (~$43/month) - just
// under this project's ~$1.50/day-per-poller ceiling. Real-world cost at
// the scheduled cadence alone (no retries) is 4 * 12 * $0.015 = $0.72/day
// (~$22/month).
export const zumperPoller = inngest.createFunction(
  {
    id: 'zumper-poller',
    triggers: [{ cron: '45 */6 * * *' }]
  },
  async ({ step }) => {
    const withinBudget = await step.run('check-daily-budget', () =>
      claimDailyBudget('zumper-poller', 8) // 2x the 4 scheduled runs/day, headroom for retries
    )
    if (!withinBudget) {
      logger.warn('Zumper poller skipped - daily run budget already used today')
      return { skipped: true, reason: 'daily-budget-exceeded' }
    }

    try {
      const items = await step.run('fetch-zumper-apify', fetchZumperViaApify)

      let upserted = 0
      const canonicalIds: string[] = []
      for (let i = 0; i < items.length; i += UPSERT_CHUNK_SIZE) {
        const chunk = items.slice(i, i + UPSERT_CHUNK_SIZE)
        const chunkResult = await step.run(`upsert-listings-chunk-${i / UPSERT_CHUNK_SIZE}`, () =>
          upsertApifyZumperListings(chunk)
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
        'Zumper (Apify) poller completed successfully'
      )

      return { fetched: items.length, upserted }
    } catch (error) {
      Sentry.captureException(error)
      logger.error({ err: error }, 'Zumper (Apify) poller failed')
      throw error
    }
  }
)
