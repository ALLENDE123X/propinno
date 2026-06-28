import { inngest } from '../client'
import { db } from '@/lib/db'
import { logger } from '@/lib/logger'
import { sql } from 'drizzle-orm'
import * as Sentry from '@sentry/nextjs'
import { listings } from '@/lib/db/schema'

export async function findMatchingUsers(listing: typeof listings.$inferSelect): Promise<{ user_id: string }[]> {
  const address = listing.address || ''
  const price = listing.price ?? null
  const beds = listing.beds ?? null

  const matchingUsers = await db.execute(sql`
    SELECT u.id as user_id 
    FROM users u
    JOIN criteria c ON c.user_id = u.id
    LEFT JOIN sent s ON s.user_id = u.id AND s.listing_id = ${listing.id}
    WHERE u.status = 'active'
      AND s.listing_id IS NULL
      AND (${price}::int IS NULL OR c.price_min IS NULL OR c.price_min <= ${price}::int)
      AND (${price}::int IS NULL OR c.price_max IS NULL OR c.price_max >= ${price}::int)
      AND (${beds}::real IS NULL OR c.beds_min IS NULL OR c.beds_min <= ${beds}::real)
      AND (${beds}::real IS NULL OR c.beds_max IS NULL OR c.beds_max >= ${beds}::real)
      AND (
        (array_length(c.zips, 1) IS NULL AND array_length(c.neighborhoods, 1) IS NULL)
        OR
        EXISTS (SELECT 1 FROM unnest(c.zips) z WHERE ${address} ILIKE '%' || z || '%')
        OR
        EXISTS (SELECT 1 FROM unnest(c.neighborhoods) n WHERE ${address} ILIKE '%' || n || '%')
      )
  `)

  return matchingUsers as { user_id: string }[]
}

export const matchingEngine = inngest.createFunction(
  { id: 'matching-engine', triggers: [{ event: 'app/listings.upserted' }] },
  async ({ event, step }) => {
    try {
      const { listingIds } = event.data

      if (!listingIds || listingIds.length === 0) {
        return { matched: 0 }
      }

      const matchedNotifications = await step.run('find-matches', async () => {
        const foundListings = await db.query.listings.findMany({
          where: (listings, { inArray }) => inArray(listings.id, listingIds)
        })

        const notifications: { userId: string, listingId: string }[] = []

        for (const listing of foundListings) {
          const matchingUsers = await findMatchingUsers(listing)
          for (const row of matchingUsers) {
            notifications.push({ userId: row.user_id, listingId: listing.id })
          }
        }
        
        return notifications
      })

      if (matchedNotifications.length > 0) {
        await step.sendEvent('enqueue-notifications', matchedNotifications.map(n => ({
          name: 'app/notification.send',
          data: { userId: n.userId, listingId: n.listingId }
        })))
      }

      logger.info({ notifications: matchedNotifications.length }, 'Matching engine completed')
      return { matched: matchedNotifications.length }
    } catch (error) {
      Sentry.captureException(error)
      logger.error({ err: error, listingIds: event.data?.listingIds }, 'Matching engine failed')
      throw error
    }
  }
)
