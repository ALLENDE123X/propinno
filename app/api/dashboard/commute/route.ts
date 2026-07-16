import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { criteria } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'
import { getActiveSessionUser, sessionErrorResponse } from '@/lib/session'
import type { CommuteIsochroneCache } from '@/lib/commute'
import * as Sentry from '@sentry/nextjs'

// AH-017. Feeds the dashboard map's isochrone overlay (see
// components/dashboard-map.tsx) with the current user's already-cached
// commute polygon - never recomputes it, never calls Mapbox here. Same
// active-session auth gate as /api/listings/map and /api/inbox (via
// lib/session.ts's getActiveSessionUser(), AH-016).
export async function GET(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`dashboard-commute-${ip}`)
    if (!rateLimit.success) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

    const auth = await getActiveSessionUser()
    if (!auth.ok) {
      const { error, status } = sessionErrorResponse(auth.status)
      return NextResponse.json({ error }, { status })
    }

    const [row] = await db
      .select({
        commuteAddress: criteria.commuteAddress,
        commuteMode: criteria.commuteMode,
        commuteMaxMinutes: criteria.commuteMaxMinutes,
        commuteIsochrone: criteria.commuteIsochrone,
      })
      .from(criteria)
      .where(eq(criteria.userId, auth.userId))

    const isochrone = (row?.commuteIsochrone ?? null) as CommuteIsochroneCache | null

    return NextResponse.json({
      commuteAddress: row?.commuteAddress ?? null,
      commuteMode: row?.commuteMode ?? null,
      commuteMaxMinutes: row?.commuteMaxMinutes ?? null,
      // Only the geometry + approximate flag are needed to draw the overlay
      // and label it honestly - not the full cache object (center/computedAt
      // are internal bookkeeping, not UI-relevant).
      isochrone: isochrone ? { polygon: isochrone.polygon, approximate: isochrone.approximate } : null,
    })
  } catch (err) {
    Sentry.captureException(err)
    logger.error({ err }, 'Failed to fetch dashboard commute isochrone')
    return NextResponse.json({ error: 'Failed to load commute data' }, { status: 500 })
  }
}
