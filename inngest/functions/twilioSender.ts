import { inngest } from '../client'
import { db } from '@/lib/db'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { eq } from 'drizzle-orm'
import { sent, users } from '@/lib/db/schema'
import { createTwilioClient } from '@/lib/twilio'
import { isWithinQuietHours, nextQuietHoursEnd } from '@/lib/quietHours'

export const getTwilioClient = () => createTwilioClient()

export const twilioSender = inngest.createFunction(
  { id: 'twilio-sender', triggers: [{ event: 'app/notification.send' }] },
  async ({ event, step }) => {
    try {
      const { userId, listingId } = event.data

      // Step 1: Check existing
      const existing = await step.run('check-existing', async () => {
        return await db.query.sent.findFirst({
          where: (s, { eq, and }) => and(eq(s.userId, userId), eq(s.listingId, listingId))
        })
      })

      if (existing) {
        logger.info({ userId, listingId }, 'Already sent, skipping')
        return { sent: false, reason: 'already_sent' }
      }

      // Step 2: Fetch data
      const data = await step.run('fetch-data', async () => {
        const user = await db.query.users.findFirst({
          where: (u, { eq }) => eq(u.id, userId)
        })
        const listing = await db.query.listings.findFirst({
          where: (l, { eq }) => eq(l.id, listingId)
        })
        return { user, listing }
      })

      if (!data.user || !data.user.phone || !data.listing) {
        logger.warn({ userId, listingId }, 'User or listing not found, or missing phone')
        return { sent: false, reason: 'missing_data' }
      }

      if (data.user.notificationsPaused) {
        logger.info({ userId, listingId }, 'Notifications paused for user, skipping')
        return { sent: false, reason: 'paused' }
      }

      // Step 3: Respect quiet hours (AH-019) - queue and send at quiet_end
      // rather than sending immediately or silently dropping the match.
      // America/Los_Angeles is hardcoded (see lib/quietHours.ts) since this
      // is an SF-only product with no stored per-user timezone.
      const quietUntilIso = await step.run('check-quiet-hours', async () => {
        const now = new Date()
        if (!isWithinQuietHours(now, data.user!.quietStart, data.user!.quietEnd)) {
          return null
        }
        return nextQuietHoursEnd(now, data.user!.quietEnd).toISOString()
      })

      if (quietUntilIso) {
        logger.info({ userId, listingId, quietUntilIso }, 'Within quiet hours, delaying send')
        await step.sleepUntil('wait-for-quiet-hours-end', quietUntilIso)

        // Quiet hours can span up to ~24h in the worst case, and the user
        // can pause notifications at any point during that wait - re-check
        // rather than send on a stale pre-sleep snapshot.
        const stillActive = await step.run('recheck-pause-after-wait', async () => {
          const [freshUser] = await db
            .select({ notificationsPaused: users.notificationsPaused })
            .from(users)
            .where(eq(users.id, userId))
          return !freshUser?.notificationsPaused
        })

        if (!stillActive) {
          logger.info({ userId, listingId }, 'Notifications paused during quiet-hours wait, skipping')
          return { sent: false, reason: 'paused' }
        }
      }

      // Step 4: Send SMS
      await step.run('send-sms', async () => {
        const priceText = data.listing?.price ? `$${data.listing.price}` : 'Price unlisted'
        const bedsText = data.listing?.beds ? `${data.listing.beds} bd` : 'Studio/Unlisted'
        const addressText = data.listing?.address || 'Address unlisted'
        const link = data.listing?.url || ''
        
        const body = `${addressText} · ${priceText} · ${bedsText}\n${link}`

        const client = getTwilioClient()
        await client.messages.create({
          body,
          from: process.env.TWILIO_FROM,
          to: data.user!.phone
        })
      })

      // Step 5: Record in sent
      await step.run('record-sent', async () => {
        await db.insert(sent).values({ userId, listingId }).onConflictDoNothing()
      })

      logger.info({ userId, listingId }, 'SMS sent successfully')
      return { sent: true }
    } catch (error) {
      Sentry.captureException(error)
      logger.error({ err: error, data: event.data }, 'Twilio sender failed')
      throw error
    }
  }
)
