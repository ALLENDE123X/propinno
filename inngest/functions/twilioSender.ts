import { inngest } from '../client'
import { db } from '@/lib/db'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { eq } from 'drizzle-orm'
import { sent, users } from '@/lib/db/schema'
import { createTwilioClient } from '@/lib/twilio'
import { isWithinQuietHours, nextQuietHoursEnd } from '@/lib/quietHours'

export const getTwilioClient = () => createTwilioClient()

// AH-028: short human labels for the enum values `lib/db/schema.ts` documents
// on `listings.petsAllowed`/`listings.laundryType` (see that file's header
// comment for the full domain). Deliberately terse - this is going into a
// single extra SMS line alongside baths, not a UI card (that's AH-027,
// unstarted as of this ticket, and free to use fuller wording of its own).
const PETS_SMS_LABELS: Record<string, string> = {
  cats: 'Cats OK',
  dogs: 'Dogs OK',
  cats_and_dogs: 'Cats+dogs OK',
  yes: 'Pets OK',
  no: 'No pets',
}

const LAUNDRY_SMS_LABELS: Record<string, string> = {
  in_unit: 'in-unit laundry',
  hookups: 'laundry hookups',
  on_site: 'on-site laundry',
}

export type SmsListingFields = {
  address: string | null
  price: number | null
  beds: number | null
  baths: number | null
  petsAllowed: string | null
  laundryType: string | null
  url: string | null
}

// Pure and exported so tests/unit/twilioSender.test.ts can assert on every
// present/absent-field combination directly, without mocking Twilio/DB for
// each case. Null-passthrough throughout, same convention as
// matchingEngine.ts's pets/laundry filters and lib/format.ts's formatters:
// a field the pollers couldn't parse is omitted from the message entirely,
// never rendered as "unknown"/"N/A". Baths uses `!= null` (not truthiness)
// so a genuine `0` wouldn't be swallowed, matching components/onboarding-flow.tsx's
// existing `listing.baths !== null` convention rather than components that
// use `??`.
export function buildListingSmsBody(listing: SmsListingFields): string {
  const priceText = listing.price ? `$${listing.price}` : 'Price unlisted'
  const bedsText = listing.beds ? `${listing.beds} bd` : 'Studio/Unlisted'
  const addressText = listing.address || 'Address unlisted'
  const link = listing.url || ''

  const bathsText = listing.baths != null ? `${listing.baths} ba` : null
  const petsText = listing.petsAllowed ? PETS_SMS_LABELS[listing.petsAllowed] ?? null : null
  const laundryText = listing.laundryType ? LAUNDRY_SMS_LABELS[listing.laundryType] ?? null : null

  // Single compact extra line - per the ticket, this should stay a
  // scannable SMS, not grow into one line per field.
  const detailParts = [bathsText, petsText, laundryText].filter((p): p is string => Boolean(p))
  const detailLine = detailParts.length > 0 ? `\n${detailParts.join(' · ')}` : ''

  return `${addressText} · ${priceText} · ${bedsText}${detailLine}\n${link}`
}

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
        const body = buildListingSmsBody({
          address: data.listing?.address ?? null,
          price: data.listing?.price ?? null,
          beds: data.listing?.beds ?? null,
          baths: data.listing?.baths ?? null,
          petsAllowed: data.listing?.petsAllowed ?? null,
          laundryType: data.listing?.laundryType ?? null,
          url: data.listing?.url ?? null,
        })

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
