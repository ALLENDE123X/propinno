import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { sent } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'
import { getActiveSessionUser, sessionErrorResponse } from '@/lib/session'
import * as Sentry from '@sentry/nextjs'

const listingIdSchema = z.string().uuid()
const bodySchema = z.object({ action: z.enum(['read', 'dismiss']) })

// Mark-as-read / dismiss for a single inbox item (AH-016). Scoped to
// (session userId, listingId) -- the same pair the `sent` table's unique
// constraint is built on -- so a user can only ever touch their own rows.
export async function PATCH(req: Request, { params }: { params: Promise<{ listingId: string }> }) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`inbox-update-${ip}`)
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

    const body = await req.json().catch(() => null)
    const parsedBody = bodySchema.safeParse(body)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const now = new Date()
    // Dismissing also marks read: a dismissed item should never contribute
    // to the unread badge again, regardless of whether it was read first.
    const updates = parsedBody.data.action === 'dismiss'
      ? { dismissedAt: now, readAt: now }
      : { readAt: now }

    const updated = await db
      .update(sent)
      .set(updates)
      .where(and(eq(sent.userId, auth.userId), eq(sent.listingId, parsedListingId)))
      .returning({ listingId: sent.listingId })

    if (updated.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    logger.info({ userId: auth.userId, listingId: parsedListingId, action: parsedBody.data.action }, 'Inbox item updated')
    return NextResponse.json({ success: true })
  } catch (err) {
    Sentry.captureException(err)
    logger.error({ err }, 'Failed to update inbox item')
    return NextResponse.json({ error: 'Failed to update inbox item' }, { status: 500 })
  }
}
