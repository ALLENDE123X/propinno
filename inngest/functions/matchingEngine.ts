import { inngest } from '../client'
import { db } from '@/lib/db'
import { users, criteria, sent, listings } from '@/lib/db/schema'
import { eq, and, gt, inArray, isNull, sql } from 'drizzle-orm'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'

export const matchingEngine = inngest.createFunction(
  { id: 'matching-engine', event: 'app/listings.upserted' },
  async ({ event, step }) => {
    try {
      const listingIds = event.data.listingIds as string[]
      if (!listingIds || listingIds.length === 0) return { matched: 0 }

      const matchedNotifications = await step.run('match-users', async () => {
        // Fetch all these listings
        const currentListings = await db.query.listings.findMany({
          where: inArray(listings.id, listingIds)
        })

        const notifications: { userId: string, listingId: string }[] = []

        for (const listing of currentListings) {
          // Find matching users who haven't already received this listing
          const matchingUsers = await db.execute(sql`
            SELECT u.id as user_id 
            FROM users u
            JOIN criteria c ON c.user_id = u.id
            WHERE u.status = 'active'
              AND (u.access_expires_at IS NULL OR u.access_expires_at > NOW())
              AND (c.price_min IS NULL OR ${listing.price === null ? sql`NULL` : listing.price} >= c.price_min)
              AND (c.price_max IS NULL OR ${listing.price === null ? sql`NULL` : listing.price} <= c.price_max)
              AND (c.beds_min IS NULL OR ${listing.beds === null ? sql`NULL` : listing.beds} >= c.beds_min)
              AND (c.beds_max IS NULL OR ${listing.beds === null ? sql`NULL` : listing.beds} <= c.beds_max)
              AND NOT EXISTS (
                SELECT 1 FROM sent s WHERE s.user_id = u.id AND s.listing_id = ${listing.id}
              )
          `) as { user_id: string }[]

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
      logger.error({ err: error }, 'Matching engine failed')
      throw error
    }
  }
)
