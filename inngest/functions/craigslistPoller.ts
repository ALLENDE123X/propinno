import { inngest } from '../client'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { dedupeAndUpsertListings } from '@/lib/listings'
import { claimDailyBudget } from '@/lib/pollerBudget'

// Craigslist's own RSS feeds (?format=rss) are confirmed blocked outright as
// of July 16, 2026 - "Your request has been blocked" (blockID=39468) on
// every region, every User-Agent, from multiple independent IPs. This isn't
// rate limiting or a Vercel-IP problem, RSS syndication for this site
// appears to be dead entirely. Craigslist listings now come from an Apify
// actor (memo23/craigslist-scraper) instead, which routes through a
// residential proxy and was confirmed working live before this switch.
//
// One call with subdomain=sfbay + category=apa covers the entire Bay Area
// (SF, East Bay, North Bay, Peninsula, South Bay all in one response,
// confirmed from a live test run) - replacing what used to be 5 separate
// per-region RSS feed fetches.
const APIFY_ACTOR = 'memo23~craigslist-scraper'
const MAX_ITEMS_PER_RUN = 80 // hard cap on billed results per run, independent of cron cadence

// Not currently hit (MAX_ITEMS_PER_RUN=80 stays under the 60s route ceiling
// today), but chunked the same way as rentcastPoller.ts for consistency and
// so a future bump to MAX_ITEMS_PER_RUN or the Apify actor's output can't
// silently reproduce the RentCast timeout from issue #40. Each step.run()
// call is a separately checkpointed Inngest invocation with its own fresh
// 60s budget (app/api/inngest/route.ts sets maxDuration=60 for the route).
const UPSERT_CHUNK_SIZE = 50

interface ApifyCraigslistItem {
  id: string
  url: string
  title?: string
  datetime?: string | null
  location?: string | null
  price?: string | null
  longitude?: string | null
  latitude?: string | null
  bedrooms?: string | null
  bathrooms?: string | null
  space?: string | null
  address?: {
    street?: string
    city?: string
    postalCode?: string
    region?: string
    country?: string
  }
  [key: string]: unknown
}

function parseDollarAmount(value: string | null | undefined): number | null {
  if (!value) return null
  const m = value.match(/([0-9,]+)/)
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null
}

function parseSqft(space: string | null | undefined): number | null {
  if (!space) return null
  const m = space.match(/(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

function parseNumeric(value: string | null | undefined): number | null {
  if (!value) return null
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : null
}

export const fetchCraigslistViaApify = async (): Promise<ApifyCraigslistItem[]> => {
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
        subdomain: 'sfbay',
        category: 'apa',
        postedToday: true,
        hideDuplicates: true,
        maxItems: MAX_ITEMS_PER_RUN,
      }),
    }
  )

  if (!res.ok) {
    throw new Error(`Apify Craigslist actor returned ${res.status}: ${await res.text()}`)
  }

  return (await res.json()) as ApifyCraigslistItem[]
}

export const upsertApifyCraigslistListings = async (
  items: ApifyCraigslistItem[]
): Promise<{ count: number; canonicalIds: string[] }> => {
  if (!Array.isArray(items) || items.length === 0) return { count: 0, canonicalIds: [] }

  const values = items.map((item) => {
    const streetAndCity = [item.address?.street, item.location].filter(Boolean).join(', ')
    return {
      source: 'craigslist' as const,
      sourceId: item.id,
      address: streetAndCity || item.location || 'SF Bay Area, CA',
      // Apify gives real per-listing map coordinates, unlike the old RSS
      // feed which never had lat/lng and relied on dedupeAndUpsertListings'
      // Mapbox geocoding fallback for every single row. That fallback still
      // exists for the rare row missing coordinates, but the common case is
      // now a real pin instead of an address-string guess.
      lat: parseNumeric(item.latitude),
      lng: parseNumeric(item.longitude),
      price: parseDollarAmount(item.price),
      beds: parseNumeric(item.bedrooms),
      baths: parseNumeric(item.bathrooms),
      sqft: parseSqft(item.space),
      url: item.url,
      postedAt: item.datetime ? new Date(item.datetime) : null,
      raw: item as unknown as Record<string, unknown>,
    }
  })

  return await dedupeAndUpsertListings(values)
}

export const craigslistPoller = inngest.createFunction(
  {
    id: 'craigslist-poller',
    triggers: [{ cron: '0 */2 * * *' }]
  },
  async ({ step }) => {
    const withinBudget = await step.run('check-daily-budget', () =>
      claimDailyBudget('craigslist-poller', 24) // 2x the 12 scheduled runs/day, headroom for retries
    )
    if (!withinBudget) {
      logger.warn('Craigslist poller skipped - daily run budget already used today')
      return { skipped: true, reason: 'daily-budget-exceeded' }
    }

    try {
      const items = await step.run('fetch-craigslist-apify', fetchCraigslistViaApify)

      let upserted = 0
      const canonicalIds: string[] = []
      for (let i = 0; i < items.length; i += UPSERT_CHUNK_SIZE) {
        const chunk = items.slice(i, i + UPSERT_CHUNK_SIZE)
        const chunkResult = await step.run(`upsert-listings-chunk-${i / UPSERT_CHUNK_SIZE}`, () =>
          upsertApifyCraigslistListings(chunk)
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
        'Craigslist (Apify) poller completed successfully'
      )

      return { fetched: items.length, upserted }
    } catch (error) {
      Sentry.captureException(error)
      logger.error({ err: error }, 'Craigslist (Apify) poller failed')
      throw error
    }
  }
)
