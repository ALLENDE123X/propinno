import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { users, listings, sent } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const secret = searchParams.get('secret')

  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const [activeUsers] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.status, 'active'))

    const [totalSent] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sent)

    const listingCountsBySource = await db
      .select({
        source: listings.source,
        count: sql<number>`count(*)::int`,
        lastPoll: sql<Date>`max(${listings.firstSeenAt})`
      })
      .from(listings)
      .groupBy(listings.source)

    return NextResponse.json({
      success: true,
      activeUsers: activeUsers.count,
      totalSent: totalSent.count,
      listings: listingCountsBySource,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
