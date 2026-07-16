import { inngest } from '../client'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { dedupeAndUpsertListings } from '@/lib/listings'
import { claimDailyBudget } from '@/lib/pollerBudget'

// Facebook Marketplace listings come from an Apify actor
// (memo23/facebook-marketplace-scraper-ppe), following the same pattern as
// the Craigslist swap (issue #26 references it directly as the template).
// Chosen after live-testing two candidates:
//   - apify/facebook-marketplace-scraper (official Apify actor, 8.5k users)
//     - well-used, but its README/input schema say nothing about proxy
//       routing or how it avoids Facebook's anti-bot/legal defenses, and its
//       rating (3.45/5 across 28 reviews) is mediocre.
//   - memo23/facebook-marketplace-scraper-ppe - explicitly documents (in its
//     input schema description for the `proxy` field) that it "already
//     routes all traffic through its own built-in residential proxy at no
//     extra cost" - matching this project's established preference
//     (see the Craigslist/memo23 swap) for proxy-routed, ToS-aware actors
//     over ones that don't say how they collect data. 5/5 rating (10
//     reviews), 99%+ success rate. Live-tested twice (see PR description for
//     real sample output): a base call returned 5 real SF Bay Area rental
//     listings in ~9s, and a follow-up call with `includeSeller: true`
//     returned real per-listing GPS coordinates and real ISO timestamps at
//     no extra line-item cost (the actor's detail-page fetch is folded into
//     the flat $0.0015/result price, unlike most competing actors that
//     charge a separate "detail enrichment" fee).
//
// `includeSeller: true` is used in production specifically for that real
// per-listing lat/lng - same "skip the geocoding fallback" data-quality win
// as the Craigslist/Apify swap got from real coordinates instead of guessing
// from an address string.
const APIFY_ACTOR = 'memo23~facebook-marketplace-scraper-ppe'
const MAX_ITEMS_PER_RUN = 80 // same conservative cap as craigslistPoller.ts, see cost math in the PR description
const UPSERT_CHUNK_SIZE = 50 // same chunked-upsert pattern as rentcastPoller.ts/craigslistPoller.ts (issue #40, PR #41) - avoids the route's 60s maxDuration timing out on sequential per-item DB round-trips

interface ApifyFacebookItem {
  id: string
  itemUrl: string
  listingTitle?: string | null
  customTitle?: string | null
  locationText?: string | null
  street?: string | null
  details?: string[] | null
  timestamp?: string | null
  timestampExact?: string | null
  listingPrice?: {
    amount?: string
    formatted_amount?: string
  } | null
  location?: {
    latitude?: number
    longitude?: number
  } | null
  [key: string]: unknown
}

function parseFacebookPrice(value: string | null | undefined): number | null {
  if (!value) return null
  const n = parseFloat(value)
  return Number.isFinite(n) ? Math.round(n) : null
}

function parseNumeric(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// Beds/baths aren't structured fields on this actor's output - they show up
// as free text in the listing title, e.g. "3 beds · 2 baths" (customTitle)
// or "3 Beds 2 Baths - House" (listingTitle). Concatenate both and regex out
// whichever count is present; many non-apartment "propertyrentals" listings
// (studios, room shares, commercial suites) have neither and correctly
// resolve to null rather than a guessed value.
function parseBeds(text: string): number | null {
  const m = text.match(/(\d+\.?\d*)\s*beds?/i)
  return m ? parseFloat(m[1]) : null
}

function parseBaths(text: string): number | null {
  const m = text.match(/(\d+\.?\d*)\s*baths?/i)
  return m ? parseFloat(m[1]) : null
}

export const fetchFacebookViaApify = async (): Promise<ApifyFacebookItem[]> => {
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
        marketplaceLocation: 'sfbay',
        categories: ['propertyrentals'],
        latitude: 37.7749,
        longitude: -122.4194,
        radiusKm: 40,
        // Mirrors Craigslist's postedToday:true - only fetch listings from
        // the last day so repeat runs bill for new items, not the same
        // still-live listings over and over.
        daysSinceListed: '1',
        sortBy: 'creation_time_descend',
        includeSeller: true,
        maxItems: MAX_ITEMS_PER_RUN,
      }),
    }
  )

  if (!res.ok) {
    throw new Error(`Apify Facebook actor returned ${res.status}: ${await res.text()}`)
  }

  return (await res.json()) as ApifyFacebookItem[]
}

export const upsertApifyFacebookListings = async (
  items: ApifyFacebookItem[]
): Promise<{ count: number; canonicalIds: string[] }> => {
  if (!Array.isArray(items) || items.length === 0) return { count: 0, canonicalIds: [] }

  const values = items.map((item) => {
    const titleText = `${item.listingTitle ?? ''} ${item.customTitle ?? ''}`
    const addressParts = [item.street, ...(item.details ?? [])].filter(Boolean)
    const address =
      addressParts.length > 0 ? addressParts.join(', ') : item.locationText || 'SF Bay Area, CA'

    return {
      source: 'facebook' as const,
      sourceId: item.id,
      address,
      lat: parseNumeric(item.location?.latitude),
      lng: parseNumeric(item.location?.longitude),
      price: parseFacebookPrice(item.listingPrice?.amount),
      beds: parseBeds(titleText),
      baths: parseBaths(titleText),
      sqft: null, // Facebook Marketplace rental listings don't expose square footage
      url: item.itemUrl,
      postedAt: item.timestamp ? new Date(item.timestamp) : null,
      raw: item as unknown as Record<string, unknown>,
    }
  })

  return await dedupeAndUpsertListings(values)
}

export const facebookPoller = inngest.createFunction(
  {
    id: 'facebook-poller',
    // Offset 15 minutes from craigslistPoller's own every-2-hours schedule
    // so the two Apify-backed pollers don't both fire at the top of the
    // hour and contend for the same DB connections.
    triggers: [{ cron: '15 */2 * * *' }]
  },
  async ({ step }) => {
    const withinBudget = await step.run('check-daily-budget', () =>
      claimDailyBudget('facebook-poller', 24) // 2x the 12 scheduled runs/day, same headroom pattern as craigslistPoller.ts
    )
    if (!withinBudget) {
      logger.warn('Facebook poller skipped - daily run budget already used today')
      return { skipped: true, reason: 'daily-budget-exceeded' }
    }

    try {
      const items = await step.run('fetch-facebook-apify', fetchFacebookViaApify)

      let upserted = 0
      const canonicalIds: string[] = []
      for (let i = 0; i < items.length; i += UPSERT_CHUNK_SIZE) {
        const chunk = items.slice(i, i + UPSERT_CHUNK_SIZE)
        const chunkResult = await step.run(`upsert-listings-chunk-${i / UPSERT_CHUNK_SIZE}`, () =>
          upsertApifyFacebookListings(chunk)
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
        'Facebook (Apify) poller completed successfully'
      )

      return { fetched: items.length, upserted }
    } catch (error) {
      Sentry.captureException(error)
      logger.error({ err: error }, 'Facebook (Apify) poller failed')
      throw error
    }
  }
)
