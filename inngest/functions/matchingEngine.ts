import { inngest } from '../client'
import { db } from '@/lib/db'
import { logger } from '@/lib/logger'
import { sql } from 'drizzle-orm'
import * as Sentry from '@sentry/nextjs'
import { listings } from '@/lib/db/schema'
import { startOfLocalDay } from '@/lib/quietHours'

export async function findMatchingUsers(listing: typeof listings.$inferSelect): Promise<{ user_id: string, max_daily_sms: number }[]> {
  const address = listing.address || ''
  const price = listing.price ?? null
  const beds = listing.beds ?? null
  const petsAllowed = listing.petsAllowed ?? null
  const laundryType = listing.laundryType ?? null

  const matchingUsers = await db.execute(sql`
    SELECT u.id as user_id, u.max_daily_sms as max_daily_sms
    FROM users u
    JOIN criteria c ON c.user_id = u.id
    LEFT JOIN sent s ON s.user_id = u.id AND s.listing_id = ${listing.id}
    WHERE u.status = 'active'
      AND s.listing_id IS NULL
      AND NOT u.notifications_paused
      AND (${price}::int IS NULL OR c.price_min IS NULL OR c.price_min <= ${price}::int)
      AND (${price}::int IS NULL OR c.price_max IS NULL OR c.price_max >= ${price}::int)
      AND (${beds}::real IS NULL OR c.beds_min IS NULL OR c.beds_min <= ${beds}::real)
      AND (${beds}::real IS NULL OR c.beds_max IS NULL OR c.beds_max >= ${beds}::real)
      AND (
        ${petsAllowed}::text IS NULL OR c.pets IS NULL
        OR ${petsAllowed}::text IN ('cats_and_dogs', 'yes')
        OR ${petsAllowed}::text = c.pets
      )
      AND (
        ${laundryType}::text IS NULL OR c.laundry IS NULL
        OR (c.laundry = 'in_unit' AND ${laundryType}::text = 'in_unit')
        OR (c.laundry = 'on_site' AND ${laundryType}::text IN ('in_unit', 'on_site'))
      )
      AND (
        (array_length(c.zips, 1) IS NULL AND array_length(c.neighborhoods, 1) IS NULL)
        OR
        EXISTS (SELECT 1 FROM unnest(c.zips) z WHERE ${address} ILIKE '%' || z || '%')
        OR
        EXISTS (SELECT 1 FROM unnest(c.neighborhoods) n WHERE ${address} ILIKE '%' || n || '%')
      )
  `)

  return matchingUsers as unknown as { user_id: string, max_daily_sms: number }[]
}

/**
 * Count of SMS already recorded as sent to `userId` "today", where "today"
 * is an America/Los_Angeles calendar day (see lib/quietHours.ts) - this is
 * an SF-only product, so a Pacific day boundary matches what "daily limit"
 * means to the user, not an arbitrary UTC midnight.
 */
export async function getTodaysSentCount(userId: string, now: Date = new Date()): Promise<number> {
  const dayStart = startOfLocalDay(now)
  const rows = await db.execute(sql`
    SELECT count(*)::int as count FROM sent WHERE user_id = ${userId} AND sent_at >= ${dayStart}
  `)
  const result = rows as unknown as { count: number }[]
  return result[0]?.count ?? 0
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
        // Tracks sends already counted (recorded today + tentatively
        // dispatched earlier in this same run) per user, so a single run
        // that matches one user against many listings can't blow past their
        // daily cap just because `sent` hasn't been written yet for
        // in-flight dispatches from this same batch.
        const sentTodayByUser = new Map<string, number>()

        for (const listing of foundListings) {
          const matchingUsers = await findMatchingUsers(listing)
          for (const row of matchingUsers) {
            let sentToday = sentTodayByUser.get(row.user_id)
            if (sentToday === undefined) {
              sentToday = await getTodaysSentCount(row.user_id)
            }

            if (sentToday >= row.max_daily_sms) {
              logger.info(
                { userId: row.user_id, listingId: listing.id, sentToday, maxDailySms: row.max_daily_sms },
                'Daily SMS cap reached, skipping dispatch'
              )
              sentTodayByUser.set(row.user_id, sentToday)
              continue
            }

            notifications.push({ userId: row.user_id, listingId: listing.id })
            sentTodayByUser.set(row.user_id, sentToday + 1)
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
