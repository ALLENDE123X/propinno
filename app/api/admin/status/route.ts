import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { users, listings, sent } from '@/lib/db/schema'
import { eq, sql, gte } from 'drizzle-orm'
import * as Sentry from '@sentry/nextjs'
import { limitRequest } from '@/lib/ratelimit'
import { Redis } from '@upstash/redis'

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN ? Redis.fromEnv() : null

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const secret = searchParams.get('secret')

  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ip = request.headers.get('x-forwarded-for') || '127.0.0.1'
  const rateLimit = await limitRequest(ip)
  if (!rateLimit.success) {
    return NextResponse.json({ error: 'Too Many Requests' }, { status: 429 })
  }

  try {
    const [activeUsers] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.status, 'active'))

    const [totalSent] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sent)

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const [sends24h] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sent)
      .where(gte(sent.sentAt, twentyFourHoursAgo))

    const listingCountsBySource = await db
      .select({
        source: listings.source,
        count: sql<number>`count(*)::int`,
        lastPoll: sql<Date>`max(${listings.firstSeenAt})`
      })
      .from(listings)
      .groupBy(listings.source)

    let recentFailures = []
    if (redis) {
      try {
        recentFailures = await redis.lrange('recent_failures', 0, 9)
      } catch (e) {
        // Ignore redis errors on read
      }
    }

    return NextResponse.json({
      success: true,
      activeUsers: activeUsers.count,
      totalSent: totalSent.count,
      sends24h: sends24h.count,
      recentFailures,
      listings: listingCountsBySource,
    })
  } catch (error: unknown) {
    Sentry.captureException(error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
