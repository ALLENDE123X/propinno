import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sent } from '@/lib/db/schema'
import { and, eq, isNull, count } from 'drizzle-orm'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'
import { getActiveSessionUser, sessionErrorResponse } from '@/lib/session'
import * as Sentry from '@sentry/nextjs'

// Lightweight count-only endpoint for the persistent inbox nav badge (see
// components/dashboard-map.tsx) -- avoids the full listings join that
// /api/inbox does for the inbox page itself, since the badge just needs a
// number and gets fetched on every dashboard load.
export async function GET(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`inbox-unread-count-${ip}`)
    if (!rateLimit.success) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

    const auth = await getActiveSessionUser()
    if (!auth.ok) {
      const { error, status } = sessionErrorResponse(auth.status)
      return NextResponse.json({ error }, { status })
    }

    const [row] = await db
      .select({ count: count() })
      .from(sent)
      .where(and(eq(sent.userId, auth.userId), isNull(sent.readAt), isNull(sent.dismissedAt)))

    return NextResponse.json({ count: row?.count ?? 0 })
  } catch (err) {
    Sentry.captureException(err)
    logger.error({ err }, 'Failed to fetch inbox unread count')
    return NextResponse.json({ error: 'Failed to load unread count' }, { status: 500 })
  }
}
