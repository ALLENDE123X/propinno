import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { db } from '@/lib/db'
import { listings, users } from '@/lib/db/schema'
import { eq, and, gte, lte, isNotNull } from 'drizzle-orm'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'

const userIdSchema = z.string().uuid()
const querySchema = z.object({
  minPrice: z.coerce.number().int().positive().optional(),
  maxPrice: z.coerce.number().int().positive().optional(),
  minBeds: z.coerce.number().nonnegative().optional(),
  source: z.string().optional(),
})

// Full-detail listing feed for the paid dashboard map. Unlike the pre-payment
// preview route, this returns exact address/lat/lng/url — only reachable by
// users whose access is currently active.
export async function GET(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`listings-map-${ip}`)
    if (!rateLimit.success) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

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

    const [user] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId))
    if (!user || user.status !== 'active') {
      return NextResponse.json({ error: 'Access pass required' }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)
    const filters = querySchema.parse({
      minPrice: searchParams.get('minPrice') ?? undefined,
      maxPrice: searchParams.get('maxPrice') ?? undefined,
      minBeds: searchParams.get('minBeds') ?? undefined,
      source: searchParams.get('source') ?? undefined,
    })

    const whereClause = and(
      eq(listings.isCanonical, true),
      isNotNull(listings.lat),
      isNotNull(listings.lng),
      filters.minPrice ? gte(listings.price, filters.minPrice) : undefined,
      filters.maxPrice ? lte(listings.price, filters.maxPrice) : undefined,
      filters.minBeds ? gte(listings.beds, filters.minBeds) : undefined,
      filters.source ? eq(listings.source, filters.source) : undefined,
    )

    const matched = await db
      .select({
        id: listings.id,
        address: listings.address,
        lat: listings.lat,
        lng: listings.lng,
        price: listings.price,
        beds: listings.beds,
        baths: listings.baths,
        source: listings.source,
        url: listings.url,
        postedAt: listings.postedAt,
        images: listings.images,
        petsAllowed: listings.petsAllowed,
        laundryType: listings.laundryType,
      })
      .from(listings)
      .where(whereClause)
      .limit(500)

    logger.info({ userId, count: matched.length }, 'Dashboard map listings served')
    return NextResponse.json({ listings: matched })
  } catch (err) {
    Sentry.captureException(err)
    logger.error({ err }, 'Failed to fetch dashboard map listings')
    return NextResponse.json({ error: 'Failed to load listings' }, { status: 500 })
  }
}
