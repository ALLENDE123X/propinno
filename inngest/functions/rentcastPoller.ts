import { inngest } from '../client'

import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { dedupeAndUpsertListings } from '@/lib/listings'
import { claimDailyBudget } from '@/lib/pollerBudget'

interface RentCastListing {
  id: string | number
  formattedAddress?: string
  addressLine1?: string
  addressLine2?: string
  city: string
  state: string
  zipCode: string
  latitude: number
  longitude: number
  price: number
  bedrooms: number
  bathrooms: number
  squareFootage: number
  listedDate?: string
  [key: string]: unknown
}

export const fetchRentcastListings = async () => {
  const apiKey = process.env.RENTCAST_API_KEY
  if (!apiKey) {
    throw new Error('RENTCAST_API_KEY is not set')
  }

  const res = await fetch(
    'https://api.rentcast.io/v1/listings/rental/long-term?city=San%20Francisco&state=CA&status=Active&limit=500',
    {
      headers: {
        'X-Api-Key': apiKey,
        'Accept': 'application/json'
      }
    }
  )

  if (!res.ok) {
    throw new Error(`RentCast API returned ${res.status}: ${await res.text()}`)
  }

  return (await res.json()) as RentCastListing[]
}

export const upsertListings = async (data: RentCastListing[]) => {
  if (!Array.isArray(data) || data.length === 0) {
    return { count: 0, canonicalIds: [] }
  }

  const values = data.map((l) => ({
    source: 'rentcast' as const,
    sourceId: String(l.id),
    address: l.formattedAddress || `${l.addressLine1}${l.addressLine2 ? ' ' + l.addressLine2 : ''}, ${l.city}, ${l.state} ${l.zipCode}`,
    lat: l.latitude,
    lng: l.longitude,
    price: l.price,
    beds: l.bedrooms,
    baths: l.bathrooms,
    sqft: l.squareFootage,
    url: null,
    postedAt: l.listedDate ? new Date(l.listedDate) : null,
    raw: l
  }))

  return await dedupeAndUpsertListings(values)
}

// Re-enabled on a 6-hour cron (2026-07-16). Was fully disabled after burning
// ~$19/day on `*/15 * * * *` with zero subscribers (see git history). A2P is
// now approved and the app is live/monetized, which justifies the API cost
// again - but starting conservative at 6h, not back to 15min. Manual-trigger
// event kept alongside the cron for on-demand testing without waiting for
// the schedule. Plan is to ramp toward hourly as paying subscriber volume
// grows and can absorb the higher RentCast request cost.
//
// claimDailyBudget is a second, independent safety net on top of the cron
// schedule itself (max 20 req/day, ~5x the 4/day this schedule should
// actually produce) - so a future schedule edit or an Inngest retry storm
// can't reproduce the original cost-bleed incident even if the cron itself
// is ever misconfigured.
export const rentcastPoller = inngest.createFunction(
  { 
    id: 'rentcast-poller',
    triggers: [
      { event: 'app/rentcast.manual-poll' },
      { cron: '0 */6 * * *' }
    ]
  },
  async ({ step }) => {
    const withinBudget = await step.run('check-daily-budget', () =>
      claimDailyBudget('rentcast-poller', 20)
    )
    if (!withinBudget) {
      logger.warn('RentCast poller skipped - daily request budget (20) already used today')
      return { skipped: true, reason: 'daily-budget-exceeded' }
    }

    try {
      const data = await step.run('fetch-rentcast', fetchRentcastListings)
      const result = await step.run('upsert-listings', async () => upsertListings(data))

      if (result.canonicalIds && result.canonicalIds.length > 0) {
        await step.sendEvent('trigger-matching', {
          name: 'app/listings.upserted',
          data: { listingIds: result.canonicalIds }
        })
      }

      logger.info({ fetched: data.length, upserted: result.count }, 'RentCast poller completed successfully')

      return { fetched: data.length, upserted: result.count }
    } catch (error) {
      Sentry.captureException(error)
      logger.error({ err: error }, 'RentCast poller failed')
      throw error
    }
  }
)
