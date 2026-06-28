import { inngest } from '../client'
import { db } from '@/lib/db'
import { listings } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { sql } from 'drizzle-orm'

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
    return 0
  }

  const values = data.map((l) => ({
    source: 'rentcast',
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

  let count = 0
  const batchSize = 100
  for (let i = 0; i < values.length; i += batchSize) {
    const batch = values.slice(i, i + batchSize)
    await db.insert(listings).values(batch).onConflictDoUpdate({
      target: [listings.source, listings.sourceId],
      set: {
        price: sql`EXCLUDED.price`,
        raw: sql`EXCLUDED.raw`,
        postedAt: sql`EXCLUDED.posted_at`
      }
    })
    count += batch.length
  }
  return count
}

export const rentcastPoller = inngest.createFunction(
  { 
    id: 'rentcast-poller',
    triggers: [{ cron: '*/15 * * * *' }]
  },
  async ({ step }) => {
    try {
      const data = await step.run('fetch-rentcast', fetchRentcastListings)
      const upsertedCount = await step.run('upsert-listings', async () => upsertListings(data))

      logger.info({ fetched: data.length, upserted: upsertedCount }, 'RentCast poller completed successfully')

      return { fetched: data.length, upserted: upsertedCount }
    } catch (error) {
      Sentry.captureException(error)
      logger.error({ err: error }, 'RentCast poller failed')
      throw error
    }
  }
)
