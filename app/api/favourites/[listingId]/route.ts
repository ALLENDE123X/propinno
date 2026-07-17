import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { favourites, listings } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'
import { getActiveSessionUser, sessionErrorResponse } from '@/lib/session'
import * as Sentry from '@sentry/nextjs'

const listingIdSchema = z.string().uuid()

// Save a listing to favourites (AH-022). onConflictDoNothing() makes
// re-saving an already-saved listing idempotent at the DB level (backed by
// the favourites_user_id_listing_id_unique constraint) rather than a
// SELECT-then-INSERT race -- same upsert convention used elsewhere in this
// codebase (see twilioSender.ts's `sent` insert). Checks the listing exists
// first so a bad/stale listingId surfaces as a clean 404 instead of a raw
// FK-violation 500.
export async function POST(req: Request, { params }: { params: Promise<{ listingId: string }> }) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`favourites-save-${ip}`)
    if (!rateLimit.success) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

    const auth = await getActiveSessionUser()
    if (!auth.ok) {
      const { error, status } = sessionErrorResponse(auth.status)
      return NextResponse.json({ error }, { status })
    }

    const { listingId } = await params
    let parsedListingId: string
    try {
      parsedListingId = listingIdSchema.parse(listingId)
    } catch {
      return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
    }

    const [listing] = await db.select({ id: listings.id }).from(listings).where(eq(listings.id, parsedListingId))
    if (!listing) {
      return NextResponse.json({ error: 'Listing not found' }, { status: 404 })
    }

    await db
      .insert(favourites)
      .values({ userId: auth.userId, listingId: parsedListingId })
      .onConflictDoNothing()

    logger.info({ userId: auth.userId, listingId: parsedListingId }, 'Listing saved to favourites')
    return NextResponse.json({ success: true, saved: true })
  } catch (err) {
    Sentry.captureException(err)
    logger.error({ err }, 'Failed to save favourite')
    return NextResponse.json({ error: 'Failed to save favourite' }, { status: 500 })
  }
}

// Unsave a listing (AH-022). Scoped to (session userId, listingId), same
// pattern as PATCH /api/inbox/[listingId] -- 404s if no matching favourites
// row exists for this user so a caller can tell a no-op from a real removal.
export async function DELETE(req: Request, { params }: { params: Promise<{ listingId: string }> }) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`favourites-unsave-${ip}`)
    if (!rateLimit.success) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

    const auth = await getActiveSessionUser()
    if (!auth.ok) {
      const { error, status } = sessionErrorResponse(auth.status)
      return NextResponse.json({ error }, { status })
    }

    const { listingId } = await params
    let parsedListingId: string
    try {
      parsedListingId = listingIdSchema.parse(listingId)
    } catch {
      return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
    }

    const deleted = await db
      .delete(favourites)
      .where(and(eq(favourites.userId, auth.userId), eq(favourites.listingId, parsedListingId)))
      .returning({ listingId: favourites.listingId })

    if (deleted.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    logger.info({ userId: auth.userId, listingId: parsedListingId }, 'Listing removed from favourites')
    return NextResponse.json({ success: true, saved: false })
  } catch (err) {
    Sentry.captureException(err)
    logger.error({ err }, 'Failed to remove favourite')
    return NextResponse.json({ error: 'Failed to remove favourite' }, { status: 500 })
  }
}
