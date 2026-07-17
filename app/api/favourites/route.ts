import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { favourites, listings } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'
import { getActiveSessionUser, sessionErrorResponse } from '@/lib/session'
import * as Sentry from '@sentry/nextjs'

// Saved/bookmarked listings feed (AH-022): `favourites` inner-joined to
// `listings` for the current user, ordered by savedAt desc, capped at 100 --
// same shape and same active-user auth gate (lib/session.ts's
// getActiveSessionUser(), AH-016) as GET /api/inbox. Backs both the
// /dashboard/favourites page and (via components/use-favourites.ts) the
// heart-icon "is this listing saved" state on the dashboard map and inbox,
// rather than adding a second, separate ids-only endpoint for that.
export async function GET(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`favourites-${ip}`)
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
        savedAt: favourites.savedAt,
      })
      .from(favourites)
      .innerJoin(listings, eq(favourites.listingId, listings.id))
      .where(eq(favourites.userId, auth.userId))
      .orderBy(desc(favourites.savedAt))
      .limit(100)

    logger.info({ userId: auth.userId, count: rows.length }, 'Favourites served')
    return NextResponse.json({ items: rows })
  } catch (err) {
    Sentry.captureException(err)
    logger.error({ err }, 'Failed to fetch favourites')
    return NextResponse.json({ error: 'Failed to load favourites' }, { status: 500 })
  }
}
