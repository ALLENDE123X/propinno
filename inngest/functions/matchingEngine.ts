import { inngest } from '../client'
import { db } from '@/lib/db'
import { logger } from '@/lib/logger'
import { sql } from 'drizzle-orm'
import * as Sentry from '@sentry/nextjs'
import { listings } from '@/lib/db/schema'
import { startOfLocalDay } from '@/lib/quietHours'
import { isPointWithinCommute, type CommuteIsochroneCache } from '@/lib/commute'

export async function findMatchingUsers(listing: typeof listings.$inferSelect): Promise<{ user_id: string, max_daily_sms: number }[]> {
  const address = listing.address || ''
  const price = listing.price ?? null
  const beds = listing.beds ?? null
  const baths = listing.baths ?? null
  const petsAllowed = listing.petsAllowed ?? null
  const laundryType = listing.laundryType ?? null

  const matchingUsers = await db.execute(sql`
    SELECT u.id as user_id, u.max_daily_sms as max_daily_sms, c.commute_isochrone as commute_isochrone
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
      AND (${baths}::real IS NULL OR c.baths_min IS NULL OR c.baths_min <= ${baths}::real)
      AND (${baths}::real IS NULL OR c.baths_max IS NULL OR c.baths_max >= ${baths}::real)
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

  const rows = matchingUsers as unknown as {
    user_id: string
    max_daily_sms: number
    commute_isochrone: CommuteIsochroneCache | null
  }[]

  // AH-017: commute-time filtering is a point-in-polygon check against each
  // user's cached isochrone (see lib/commute.ts) - fundamentally different
  // from the pure-SQL comparisons above, so it's applied as a post-processing
  // step in application code rather than another SQL clause. Deliberately NOT
  // a live Mapbox Isochrone API call here - the isochrone was already
  // computed once when the user set/changed their commute criteria (see
  // app/api/auth/verify-otp/route.ts), so this is just a fast local check.
  return rows
    .filter((row) => isPointWithinCommute(listing.lat, listing.lng, row.commute_isochrone))
    .map((row) => ({ user_id: row.user_id, max_daily_sms: row.max_daily_sms }))
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

      // Chunked the same way as the pollers' own upsert step (issue #40, PR
      // #41): a single `app/listings.upserted` event can carry hundreds of
      // listingIds (e.g. RentCast's up-to-500-item runs collect every
      // canonical id into one event) - running findMatchingUsers() +
      // getTodaysSentCount() sequentially for every one of them inside a
      // single unchunked step reliably exceeded the route's 60s maxDuration
      // in production, confirmed via repeated real HTTP 504s on this exact
      // function roughly every 6h - matching RentCast's cron cadence (see
      // issue #67 and ARCHITECTURE.md for the incident writeup). The
      // per-user daily-cap tally has to survive across chunk boundaries so a
      // user matching listings in different chunks still gets capped
      // correctly within one run - carried as a plain
      // `Record<string, number>` returned from each chunk's step (a step
      // result must be independently serializable/memoizable, so the
      // in-progress tally can't just live in a shared outer-scope Map the
      // way the original unchunked version did).
      const MATCH_CHUNK_SIZE = 50
      let sentTodayByUser: Record<string, number> = {}
      const matchedNotifications: { userId: string, listingId: string }[] = []

      for (let i = 0; i < listingIds.length; i += MATCH_CHUNK_SIZE) {
        const chunk = listingIds.slice(i, i + MATCH_CHUNK_SIZE)
        const carriedTally = sentTodayByUser

        const chunkResult = await step.run(`find-matches-chunk-${i / MATCH_CHUNK_SIZE}`, async () => {
          const foundListings = await db.query.listings.findMany({
            where: (listings, { inArray }) => inArray(listings.id, chunk)
          })

          const notifications: { userId: string, listingId: string }[] = []
          // Tracks sends already counted (recorded today + tentatively
          // dispatched earlier in this same run) per user, so a single run
          // that matches one user against many listings can't blow past
          // their daily cap just because `sent` hasn't been written yet for
          // in-flight dispatches from this same batch. Seeded from the
          // previous chunk's tally so the cap is enforced across the whole
          // run, not just within one chunk.
          const tally: Record<string, number> = { ...carriedTally }

          for (const listing of foundListings) {
            const matchingUsers = await findMatchingUsers(listing)
            for (const row of matchingUsers) {
              let sentToday = tally[row.user_id]
              if (sentToday === undefined) {
                sentToday = await getTodaysSentCount(row.user_id)
              }

              if (sentToday >= row.max_daily_sms) {
                logger.info(
                  { userId: row.user_id, listingId: listing.id, sentToday, maxDailySms: row.max_daily_sms },
                  'Daily SMS cap reached, skipping dispatch'
                )
                tally[row.user_id] = sentToday
                continue
              }

              notifications.push({ userId: row.user_id, listingId: listing.id })
              tally[row.user_id] = sentToday + 1
            }
          }

          return { notifications, tally }
        })

        matchedNotifications.push(...chunkResult.notifications)
        sentTodayByUser = chunkResult.tally
      }

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
