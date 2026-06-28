import { inngest } from '../client'

import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { dedupeAndUpsertListings } from '@/lib/listings'

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

export const rentcastPoller = inngest.createFunction(
  { 
    id: 'rentcast-poller',
    triggers: [{ cron: '*/15 * * * *' }]
  },
  async ({ step }) => {
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
