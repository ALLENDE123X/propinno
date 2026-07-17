import { inngest } from '../client'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { dedupeAndUpsertListings } from '@/lib/listings'
import { claimDailyBudget } from '@/lib/pollerBudget'
import { parseImagesFromSpareRoom } from '@/lib/listingImages'

// SpareRoom is a room-share/roommate-matching site - a listing here is an ad
// for ONE ROOM within a shared house/apartment (or occasionally a whole
// property), unlike the rest of this product's whole-unit apartment sources.
// Intentional addition per Pranav's direct request (2026-07-17), not from
// the AH-XXX backlog - see CLAUDE.md.
//
// Actor: memo23/spareroom-scraper ("Complete SpareRoom Scraper (UK & US) +
// Alerts & Emails"). Chosen over the other ~7 SpareRoom actors on the Apify
// Store for the same reason the Craigslist/Facebook swaps did: it's from the
// same publisher (memo23) whose proxy-routed actors already proved out in
// this codebase, and its input schema explicitly documents built-in
// residential-proxy routing ("Leave empty - the actor already routes all
// traffic through its own built-in residential proxy at no extra cost to
// you"), same standard as craigslistPoller.ts/facebookPoller.ts. 5/5 rating
// (3 reviews) - a small pool, but every competing SpareRoom actor on the
// Store either doesn't mention proxy handling at all (e.g.
// shahidirfan/SpareRoom-Property-Scraper, whose own `proxyConfiguration`
// input defaults to `useApifyProxy: false`) or has no UK+US coverage
// (several are UK-only, no use for this product's SF-only scope).
//
// Live-tested (2026-07-17) and found ONE critical, undocumented gotcha:
// the actor's own README advertises bare-city-name input ("US city names /
// ZIPs... Bare locations are resolved to search results automatically"),
// but a real call with `startUrls: ["San Francisco"], country: "US"`
// returned 5 real (not fabricated) SpareRoom ads from Phoenix AZ, rural
// Louisiana, Flushing NY, Jersey City NJ, and San Bernardino CA - zero from
// the Bay Area. Same failure class the facebookPoller.ts session hit with
// the official Facebook actor: advertised geo-targeting that silently
// doesn't work. Root-caused by reproducing the search on spareroom.com
// directly: a bare `where=San Francisco` query string (without the
// location's internal ID, which SpareRoom's UI only attaches via its
// autocomplete dropdown) redirects to the generic search form instead of
// scoping results - so the actor's "bare location" mode inherits that same
// resolution gap. Fix: perform the location search once for San Francisco
// through the real site/autocomplete, and use the resulting resolved
// `https://www.spareroom.com/roommate/?search_id=...` URL as a fixed
// `startUrls` entry instead of a bare city name. A second live actor call
// with that exact URL correctly returned 5/5 genuine SF listings (Russian
// Hill 94133, Nob Hill 94108, SOMA/South Of Market 94103 x2), each with
// real SF lat/lng, real photos, and real ad text - confirmed via
// `get-dataset-items`, not just the actor's own summary. The search_id URL
// was also confirmed to work from a cookie-less `curl` (no browser session
// carried over) and independently through Apify's own proxy infrastructure,
// so it isn't tied to this session; SpareRoom's own UI treats these URLs as
// stable, shareable links (there's a "Save search for alerts" feature next
// to results), consistent with them being durable rather than short-lived
// tokens. If this ever stops resolving to SF results, redo the search on
// spareroom.com (Search by location -> "San Francisco, CA" -> pick the
// autocomplete suggestion -> Search) and swap in the new `search_id`.
const APIFY_ACTOR = 'memo23~spareroom-scraper'
const SF_SEARCH_URL = 'https://www.spareroom.com/roommate/?search_id=500087007475&'

// SF's entire active SpareRoom inventory was ~65 listings at live-test time
// (2026-07-17, "Showing 1-10 of 65 results" on the real search page) - a
// much smaller, slower-churning pool than Craigslist/Facebook's SF rental
// volume. 40 (roughly 60% of total live inventory) comfortably covers a
// full poll without wastefully re-scraping the same static ~65 ads every
// run; dedupeAndUpsertListings()'s onConflictDoUpdate makes re-fetching the
// same still-live ad on a later run harmless (just a cost inefficiency, not
// a correctness issue) - same tradeoff Craigslist/Facebook accept today.
const MAX_ITEMS_PER_RUN = 40
// Chunked upsert, same pattern as craigslistPoller.ts/facebookPoller.ts
// (issue #40, PR #41) - not currently hit at this item cap, but kept
// consistent so a future cap increase can't silently reproduce the
// RentCast timeout.
const UPSERT_CHUNK_SIZE = 50

interface ApifySpareRoomRoom {
  room_type?: string | null
  ensuite?: string | null
  [key: string]: unknown
}

interface ApifySpareRoomBasicInfo {
  id?: string
  url?: string
  neighbourhood?: string | null
  postcode?: string | null
  daysOld?: string | null
  [key: string]: unknown
}

interface ApifySpareRoomItem {
  advert_id: string
  ad_title?: string | null
  neighbourhood_name?: string | null
  postcode?: string | null
  latitude?: string | null
  longitude?: string | null
  min_rent?: string | null
  available_as_whole_property?: string | null
  rooms_in_property?: string | null
  // Room(s) covered by this specific ad - almost always a single-element
  // array for a "rooms for rent" listing. `ensuite` tells us whether this
  // particular room has its own private bathroom - see parseBaths below.
  rooms?: ApifySpareRoomRoom[] | null
  basicInfo?: ApifySpareRoomBasicInfo | null
  // Photo objects, each with several pre-sized URL variants - see
  // lib/listingImages.ts's parseImagesFromSpareRoom, confirmed against a
  // live 5-item actor call on 2026-07-17.
  photos?: unknown
  [key: string]: unknown
}

function parseRent(value: string | null | undefined): number | null {
  if (!value) return null
  const m = value.match(/([0-9,]+)/)
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null
}

function parseCoord(value: string | null | undefined): number | null {
  if (!value) return null
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : null
}

// Room-vs-unit judgment call (per the ticket): a SpareRoom "rooms for rent"
// ad is almost always for ONE ROOM within a larger shared property, not the
// whole unit - `rooms_in_property` is the total bedroom count of the entire
// shared property, which would overstate what a subscriber is actually
// renting if used directly as `beds`. So: the common case
// (`available_as_whole_property !== 'Y'`) maps to `beds: 1` (the single room
// being advertised), and only the less-common whole-property/SCP ads
// (`available_as_whole_property === 'Y'`) use `rooms_in_property` as `beds`,
// matching how every other source's `beds` represents "bedrooms in the unit
// being offered."
function parseBeds(item: ApifySpareRoomItem): number | null {
  if (item.available_as_whole_property === 'Y') {
    const n = parseInt(item.rooms_in_property ?? '', 10)
    return Number.isFinite(n) ? n : null
  }
  return 1
}

// SpareRoom doesn't expose a total-bathroom-count field for the property at
// all (confirmed absent across the full ~200-field actor output from two
// live test runs). The one bathroom-related signal available is
// `rooms[].ensuite` - whether the specific room being advertised has its
// own private bathroom. Treated as `baths: 1` when true (a real, useful
// signal for matching - "this room has a private bath"); left `null`
// (unknown/shared, not a guessed count) otherwise, same "don't guess"
// convention as every other parser in this codebase.
function parseBaths(item: ApifySpareRoomItem): number | null {
  return item.rooms?.[0]?.ensuite === 'Y' ? 1 : null
}

// SpareRoom doesn't expose an exact street address (standard for
// room-share/roommate sites - the advertiser's home address isn't public
// until contacted), so the address string is built from neighbourhood +
// postcode, same "best available location string" approach
// craigslistPoller.ts takes when Apify doesn't return a full street address.
function buildAddress(item: ApifySpareRoomItem): string {
  // Real live data (2026-07-17) showed some ads' neighbourhood_name is
  // literally "San Francisco" itself (SpareRoom falls back to the city name
  // when no finer neighbourhood is set), which would otherwise duplicate
  // into "San Francisco, ..., San Francisco, CA" - filtered out here.
  const parts = [item.neighbourhood_name, item.postcode].filter(
    (p): p is string => typeof p === 'string' && p.trim().toLowerCase() !== 'san francisco'
  )
  return parts.length > 0 ? `${parts.join(', ')}, San Francisco, CA` : 'San Francisco, CA'
}

// No `date_posted`/`created_at`-shaped field exists on this actor's output
// (confirmed absent across the full field list). `basicInfo.daysOld`
// (integer, e.g. "0", "1") is the closest available proxy - a day-granularity
// "listed N days ago" signal SpareRoom's own site surfaces as "New Today" /
// "New" labels. Converted to an approximate Date; day-granularity only, not
// a precise timestamp - same category of documented approximation as
// AH-017's transit-commute estimate (see lib/commute.ts).
function parsePostedAt(item: ApifySpareRoomItem): Date | null {
  const daysOld = parseInt(item.basicInfo?.daysOld ?? '', 10)
  if (!Number.isFinite(daysOld) || daysOld < 0) return null
  return new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000)
}

export const fetchSpareRoomViaApify = async (): Promise<ApifySpareRoomItem[]> => {
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
        startUrls: [SF_SEARCH_URL],
        maxItems: MAX_ITEMS_PER_RUN,
        monitoringMode: false,
        enrichEmails: false,
      }),
    }
  )

  if (!res.ok) {
    throw new Error(`Apify SpareRoom actor returned ${res.status}: ${await res.text()}`)
  }

  return (await res.json()) as ApifySpareRoomItem[]
}

export const upsertApifySpareRoomListings = async (
  items: ApifySpareRoomItem[]
): Promise<{ count: number; canonicalIds: string[] }> => {
  if (!Array.isArray(items) || items.length === 0) return { count: 0, canonicalIds: [] }

  const values = items.map((item) => ({
    source: 'spareroom' as const,
    sourceId: item.advert_id,
    address: buildAddress(item),
    lat: parseCoord(item.latitude),
    lng: parseCoord(item.longitude),
    price: parseRent(item.min_rent),
    beds: parseBeds(item),
    baths: parseBaths(item),
    sqft: null, // Not exposed anywhere in this actor's output - confirmed across the full field list on two live test runs
    url: item.basicInfo?.url ?? null,
    postedAt: parsePostedAt(item),
    raw: item as unknown as Record<string, unknown>,
    // Listing images - see lib/listingImages.ts.
    images: parseImagesFromSpareRoom(item),
  }))

  return await dedupeAndUpsertListings(values)
}

export const spareroomPoller = inngest.createFunction(
  {
    id: 'spareroom-poller',
    // Offset 50 minutes from craigslistPoller (:00), distinct from
    // facebookPoller (:15), realtorPoller (:30), and apartmentsPoller (:37)
    // so every Apify-backed poller on the every-2-hours cadence fires in its
    // own minute and none contend for the same DB connections (same
    // reasoning as facebookPoller.ts's own offset from craigslistPoller).
    // Originally shipped at :30, which collided with realtorPoller.ts once
    // both merged the same day - moved to :50 during that merge.
    triggers: [{ cron: '50 */2 * * *' }]
  },
  async ({ step }) => {
    const withinBudget = await step.run('check-daily-budget', () =>
      // 2x the 12 scheduled runs/day, same headroom-for-retries pattern as
      // craigslistPoller.ts/facebookPoller.ts. Cost math: memo23/spareroom-scraper
      // bills $0.00095/result + $0.005/actor-start (BRONZE tier). At the
      // scheduled cadence (12 runs/day) and MAX_ITEMS_PER_RUN=40: 12 * (40 *
      // 0.00095 + 0.005) = 12 * $0.043 = ~$0.52/day (~$15/month) - well
      // under this project's ~$1.50/day-per-poller ceiling. Worst case at
      // the full 24-run/day budget cap: 24 * $0.043 = ~$1.03/day (~$31/
      // month) - still under the ceiling.
      claimDailyBudget('spareroom-poller', 24)
    )
    if (!withinBudget) {
      logger.warn('SpareRoom poller skipped - daily run budget already used today')
      return { skipped: true, reason: 'daily-budget-exceeded' }
    }

    try {
      const items = await step.run('fetch-spareroom-apify', fetchSpareRoomViaApify)

      let upserted = 0
      const canonicalIds: string[] = []
      for (let i = 0; i < items.length; i += UPSERT_CHUNK_SIZE) {
        const chunk = items.slice(i, i + UPSERT_CHUNK_SIZE)
        const chunkResult = await step.run(`upsert-listings-chunk-${i / UPSERT_CHUNK_SIZE}`, () =>
          upsertApifySpareRoomListings(chunk)
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
        'SpareRoom (Apify) poller completed successfully'
      )

      return { fetched: items.length, upserted }
    } catch (error) {
      Sentry.captureException(error)
      logger.error({ err: error }, 'SpareRoom (Apify) poller failed')
      throw error
    }
  }
)
