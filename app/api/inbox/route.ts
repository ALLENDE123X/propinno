import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sent, listings } from '@/lib/db/schema'
import { eq, and, isNull, desc } from 'drizzle-orm'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'
import { getActiveSessionUser, sessionErrorResponse } from '@/lib/session'
import * as Sentry from '@sentry/nextjs'

// In-app inbox feed (AH-016): matched listings already texted to this user,
// joined from `sent` + `listings`. A supplement to SMS, not a replacement --
// lets a user browse everything they've been sent from inside the app.
// dismissedAt IS NULL keeps this a "current" list (dismiss = remove from
// view); readAt drives the unread badge independently of dismissal.
export async function GET(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`inbox-${ip}`)
    if (!rateLimit.success) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

    const auth = await getActiveSessionUser()
    if (!auth.ok) {
      const { error, status } = sessionErrorResponse(auth.status)
      return NextResponse.json({ error }, { status })
    }

    const rows = await db
      .select({
        listingId: listings.id,
        address: listings.address,
        price: listings.price,
        beds: listings.beds,
        baths: listings.baths,
        source: listings.source,
        url: listings.url,
        postedAt: listings.postedAt,
        sentAt: sent.sentAt,
        readAt: sent.readAt,
      })
      .from(sent)
      .innerJoin(listings, eq(sent.listingId, listings.id))
      .where(and(eq(sent.userId, auth.userId), isNull(sent.dismissedAt)))
      .orderBy(desc(sent.sentAt))
      .limit(100)

    const unreadCount = rows.reduce((n, r) => (r.readAt ? n : n + 1), 0)

    logger.info({ userId: auth.userId, count: rows.length, unreadCount }, 'Inbox served')
    return NextResponse.json({ items: rows, unreadCount })
  } catch (err) {
    Sentry.captureException(err)
    logger.error({ err }, 'Failed to fetch inbox')
    return NextResponse.json({ error: 'Failed to load inbox' }, { status: 500 })
  }
}
