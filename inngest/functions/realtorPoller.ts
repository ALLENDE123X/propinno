import { inngest } from '../client'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { dedupeAndUpsertListings } from '@/lib/listings'
import { claimDailyBudget } from '@/lib/pollerBudget'
import { parseImagesFromRealtor } from '@/lib/listingImages'

// Realtor.com listings come from an Apify actor (kawsar/realtor-Search),
// chosen after live-testing three real candidates against real SF
// `status=for_rent` searches (2026-07-17), following the same "test before
// trusting a README" discipline as the Craigslist/Facebook Apify swaps:
//   - memo23 (this project's preferred publisher for Craigslist/Facebook)
//     has NO Realtor.com rental actor - their only Realtor.com actor
//     (realtor-search-cheerio) is agent-lead-gen/for-sale focused, with only
//     `for_sale`/`sold` search modes and no rental option at all. Confirmed
//     via fetch-actor-details before ruling it out, not assumed from the
//     title alone.
//   - solidcode/realtorcom-scraper (cheapest, $0.0008/result) FAILED outright
//     on a live test call ("Collecting session cookies", exit code 91) -
//     an anti-bot/session wall it couldn't get past. Ruled out on hard
//     evidence, not preference.
//   - automation-lab/realtor-scraper (explicit `listingType: for_rent`,
//     residential+datacenter proxy rotation per its README) succeeded live
//     but only exposes a single `photoUrl` per listing (no gallery).
//   - kawsar/realtor-Search (chosen) succeeded on every live test (3 runs,
//     100% success), is the cheapest of the working candidates
//     ($0.00167/result + a negligible $0.00005 actor-start fee), and is the
//     only one exposing a real photo gallery (`photo_urls`, a flat array -
//     one live SF listing had 49 photos) rather than a single cover image -
//     see lib/listingImages.ts's parseImagesFromRealtor.
//
// Live-tested finding worth knowing before touching this poller further:
// Realtor.com's own `status=for_rent` results for SF are real but noisy -
// a live 20-item sample (2026-07-17) found only 4/20 (20%) were genuine
// listings with a real price/beds/baths (`source_type` `mls`, e.g. real SF
// MLS agent listings, or `unit_rental`, e.g. direct property-management
// software like Innago). The other 16/20 (80%) were `source_type:
// "community"` syndicated placeholder rows (`source_name` "Zillow" or
// "Appfolio") with `list_price: null` and no beds/baths/sqft at all -
// Realtor.com itself has no usable data for these, only a photo count and
// coordinates. upsertApifyRealtorListings filters these out before mapping
// (see below) rather than upserting listings with no usable price. This
// matches the ticket's own hypothesis that Realtor.com's genuine long-term-
// rental inventory is real but meaningfully thinner than Craigslist/
// Facebook Marketplace for this specific product - worth knowing before
// raising MAX_ITEMS_PER_RUN expecting proportionally more real listings.
//
// Scope is deliberately narrower than the other two Apify pollers: this
// actor's `status`+`city`+`state_code` input only searches one city per
// call (no sfbay-wide subdomain like Craigslist, no lat/lng+radius like
// Facebook), so this poller covers San Francisco proper only, not the
// wider Bay Area. A reasonable future follow-up (looping over a few more
// Bay Area city names) if this source proves valuable enough to extend.
const APIFY_ACTOR = 'kawsar~realtor-Search'

// 35 items/run keeps the worst-case daily cost (see claimDailyBudget call
// below) under this project's ~$1.50/day-per-poller ceiling convention even
// with full retry headroom used, while still being enough to net a
// reasonable handful of genuine listings/run given the ~20% genuine-listing
// rate found live above.
const MAX_ITEMS_PER_RUN = 35

// Same chunked-upsert pattern as rentcastPoller.ts/craigslistPoller.ts
// (issue #40, PR #41) - not currently hit at this item cap, applied
// preemptively for consistency and future-proofing, same as craigslistPoller.
const UPSERT_CHUNK_SIZE = 50

interface ApifyRealtorItem {
  property_id: string
  listing_id?: string | null
  permalink?: string | null
  status?: string | null
  list_price?: number | null
  beds?: number | null
  baths_consolidated?: string | null
  sqft?: number | null
  type?: string | null
  address_line?: string | null
  city?: string | null
  state_code?: string | null
  postal_code?: string | null
  latitude?: number | null
  longitude?: number | null
  list_date?: string | null
  source_name?: string | null
  source_type?: string | null
  // Image fields - see lib/listingImages.ts's parseImagesFromRealtor,
  // confirmed against a live 20-item sample run on 2026-07-17. photo_urls
  // is the full gallery (flat array of rdcpix.com CDN URLs); primary_photo_url
  // is a single cover photo, present on every real listing.
  photo_urls?: string[] | null
  primary_photo_url?: string | null
  [key: string]: unknown
}

function parseNumeric(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// baths_consolidated is a string on this actor's output (e.g. "1.5", "2"),
// unlike beds which is already a real number - confirmed via live sample.
function parseBaths(value: string | null | undefined): number | null {
  if (!value) return null
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : null
}

// Used only when address_line is null (confirmed live: some genuine MLS
// listings omit it despite having real city/state/postal_code/coordinates,
// e.g. a condo listing keyed only by unit within a building) - same
// "fall back to what's known rather than a flat generic string" preference
// craigslistPoller.ts's streetAndCity join already established.
function buildFallbackAddress(item: {
  city?: string | null
  state_code?: string | null
  postal_code?: string | null
}): string {
  const cityState = [item.city, item.state_code].filter(Boolean).join(', ')
  const withZip = item.postal_code ? [cityState, item.postal_code].filter(Boolean).join(' ') : cityState
  return withZip || 'San Francisco, CA'
}

export const fetchRealtorViaApify = async (): Promise<ApifyRealtorItem[]> => {
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
        status: ['for_rent'],
        city: 'San Francisco',
        state_code: 'CA',
        maxItems: MAX_ITEMS_PER_RUN,
      }),
    }
  )

  if (!res.ok) {
    throw new Error(`Apify Realtor actor returned ${res.status}: ${await res.text()}`)
  }

  return (await res.json()) as ApifyRealtorItem[]
}

export const upsertApifyRealtorListings = async (
  items: ApifyRealtorItem[]
): Promise<{ count: number; canonicalIds: string[] }> => {
  if (!Array.isArray(items) || items.length === 0) return { count: 0, canonicalIds: [] }

  // Drop the syndicated "community" placeholder rows before ever mapping
  // them - see this file's header comment for the live-tested 80% noise
  // rate. A genuine listing always has a real list_price; upserting a
  // listing with no price would be unmatchable (subscribers filter by
  // price range) and useless in an SMS - same "drop rather than guess"
  // convention every other parser in this codebase already follows.
  const genuine = items.filter(
    (item): item is ApifyRealtorItem & { list_price: number } =>
      typeof item.list_price === 'number' && item.list_price > 0
  )
  if (genuine.length === 0) return { count: 0, canonicalIds: [] }

  const values = genuine.map((item) => ({
    source: 'realtor' as const,
    sourceId: item.property_id,
    address: item.address_line || buildFallbackAddress(item),
    lat: parseNumeric(item.latitude),
    lng: parseNumeric(item.longitude),
    price: item.list_price,
    beds: parseNumeric(item.beds),
    baths: parseBaths(item.baths_consolidated),
    sqft: typeof item.sqft === 'number' ? item.sqft : null,
    // This actor's dataset schema exposes `permalink` (the URL slug), not a
    // ready-made `url` field - confirmed live against realtor.com's own
    // detail-page URL format (/realestateandhomes-detail/{permalink}).
    url: item.permalink ? `https://www.realtor.com/realestateandhomes-detail/${item.permalink}` : null,
    postedAt: item.list_date ? new Date(item.list_date) : null,
    raw: item as unknown as Record<string, unknown>,
    // Listing images - see lib/listingImages.ts.
    images: parseImagesFromRealtor(item),
  }))

  return await dedupeAndUpsertListings(values)
}

export const realtorPoller = inngest.createFunction(
  {
    id: 'realtor-poller',
    // Offset 30 minutes so this doesn't collide with rentcastPoller (minute
    // 0), craigslistPoller (minute 0) or facebookPoller (minute 15) - all
    // three run every 2h; this poller does too, at minute 30, so no two
    // Apify-backed (or RentCast) pollers ever fire in the same minute.
    triggers: [{ cron: '30 */2 * * *' }]
  },
  async ({ step }) => {
    const withinBudget = await step.run('check-daily-budget', () =>
      // 2x the 12 scheduled runs/day, same headroom convention as
      // craigslistPoller.ts/facebookPoller.ts. Worst case (budget fully
      // consumed via retries): 24 runs x 35 items x $0.00167/result =
      // ~$1.40/day (~$42/month) at kawsar/realtor-Search's pricing - under
      // this project's ~$1.50/day-per-poller ceiling. Normal-case cost
      // (12 real scheduled runs/day, no retries) is about half that,
      // ~$0.70/day (~$21/month).
      claimDailyBudget('realtor-poller', 24)
    )
    if (!withinBudget) {
      logger.warn('Realtor poller skipped - daily run budget already used today')
      return { skipped: true, reason: 'daily-budget-exceeded' }
    }

    try {
      const items = await step.run('fetch-realtor-apify', fetchRealtorViaApify)

      let upserted = 0
      const canonicalIds: string[] = []
      for (let i = 0; i < items.length; i += UPSERT_CHUNK_SIZE) {
        const chunk = items.slice(i, i + UPSERT_CHUNK_SIZE)
        const chunkResult = await step.run(`upsert-listings-chunk-${i / UPSERT_CHUNK_SIZE}`, () =>
          upsertApifyRealtorListings(chunk)
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
        'Realtor.com (Apify) poller completed successfully'
      )

      return { fetched: items.length, upserted }
    } catch (error) {
      Sentry.captureException(error)
      logger.error({ err: error }, 'Realtor.com (Apify) poller failed')
      throw error
    }
  }
)
