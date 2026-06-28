import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { db } from '@/lib/db'
import { listings, criteria, users } from '@/lib/db/schema'
import { eq, and, gte, lte, isNotNull } from 'drizzle-orm'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'

const userIdSchema = z.string().uuid()

export async function GET(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`listings-preview-${ip}`)
    if (!rateLimit.success) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

    // Auth: require session cookie
    const cookieStore = await cookies()
    const session = cookieStore.get('session')?.value
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let userId: string
    try {
      userId = userIdSchema.parse(session)
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Verify user exists
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId))
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Load this user's criteria
    const [userCriteria] = await db.select().from(criteria).where(eq(criteria.userId, userId))

    // Build listing filters based on criteria
    // Build filter conditions
    const whereClause = and(
      eq(listings.isCanonical, true),
      isNotNull(listings.price),
      userCriteria?.priceMin ? gte(listings.price, userCriteria.priceMin) : undefined,
      userCriteria?.priceMax ? lte(listings.price, userCriteria.priceMax) : undefined,
      userCriteria?.bedsMin ? gte(listings.beds, userCriteria.bedsMin) : undefined,
      userCriteria?.bedsMax ? lte(listings.beds, userCriteria.bedsMax) : undefined,
    )

    const matched = await db
      .select({
        id: listings.id,
        address: listings.address,
        price: listings.price,
        beds: listings.beds,
        baths: listings.baths,
        source: listings.source,
        postedAt: listings.postedAt,
      })
      .from(listings)
      .where(whereClause)
      .limit(3)

    // Neighborhood-level tease: strip street number, keep cross-street/area
    const teased = matched.map((l) => ({
      id: l.id,
      neighborhood: maskAddress(l.address),
      price: l.price,
      beds: l.beds,
      baths: l.baths,
      source: l.source,
      postedAt: l.postedAt,
    }))

    logger.info({ userId, count: teased.length }, 'Listing preview served')
    return NextResponse.json({ listings: teased })
  } catch (err) {
    Sentry.captureException(err)
    logger.error({ err }, 'Failed to fetch listing preview')
    return NextResponse.json({ error: 'Failed to load preview' }, { status: 500 })
  }
}

/**
 * Returns a neighborhood-level label from a full address.
 * Strips the street number so the exact unit is not revealed before payment.
 * e.g. "123 Main St, Mission, San Francisco, CA" → "Mission, San Francisco, CA"
 */
function maskAddress(address: string): string {
  // Remove leading street number (e.g., "123 " or "1B ")
  const withoutNumber = address.replace(/^\d+[A-Za-z]?\s+/, '')
  // Take everything after the first comma (cross-street / neighborhood / city)
  const parts = withoutNumber.split(',')
  if (parts.length >= 2) {
    return parts.slice(1).join(',').trim()
  }
  // Fallback: return as-is without street number
  return withoutNumber
}
