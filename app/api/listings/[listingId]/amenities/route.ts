import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { listings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'
import { getActiveSessionUser, sessionErrorResponse } from '@/lib/session'
import { claimDailyBudget } from '@/lib/pollerBudget'
import { computeNearbyAmenities, type ListingAmenitiesCache } from '@/lib/amenities'
import * as Sentry from '@sentry/nextjs'

const listingIdSchema = z.string().uuid()

// AH-023 nearby-amenity cost safety net. This isn't a per-poller-run budget
// (see lib/pollerBudget.ts's header comment for that original incident) -
// it's a cap on how many *new* (cache-miss) listings get amenity data
// computed per day, since the compute-once-cache-forever design (see
// lib/amenities.ts) means cache hits are free regardless of pageview volume.
// 200/day * up to 6 Mapbox calls each (2 Tilequery + up to 4 Directions) is
// well under both APIs' 100k/month free tier even at sustained daily volume.
const MAX_NEW_AMENITY_LOOKUPS_PER_DAY = 200

// Nearby-amenity data for a single listing's detail card (AH-023). Serves
// the already-cached `listings.amenities` column when present; computes and
// persists it lazily on a genuine cache miss (see lib/amenities.ts's header
// comment for the full "compute once" design). Same active-session auth
// gate as /api/listings/map / /api/inbox / /api/dashboard/commute
// (lib/session.ts's getActiveSessionUser()).
export async function GET(req: Request, { params }: { params: Promise<{ listingId: string }> }) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`listing-amenities-${ip}`)
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

    const [listing] = await db
      .select({ lat: listings.lat, lng: listings.lng, amenities: listings.amenities })
      .from(listings)
      .where(eq(listings.id, parsedListingId))

    if (!listing) {
      return NextResponse.json({ error: 'Listing not found' }, { status: 404 })
    }

    const cached = listing.amenities as ListingAmenitiesCache | null
    if (cached) {
      return NextResponse.json({ ...cached, cached: true })
    }

    if (listing.lat === null || listing.lng === null) {
      // Nothing to compute against - not an error, just genuinely no data
      // to base a lookup on. Not persisted, so it's retried if/when this
      // listing later gets real coordinates (e.g. a re-poll/geocode fix).
      return NextResponse.json({ amenities: [], computedAt: null, cached: false, reason: 'no_coordinates' })
    }

    const withinBudget = await claimDailyBudget('amenities-lookup', MAX_NEW_AMENITY_LOOKUPS_PER_DAY)
    if (!withinBudget) {
      logger.warn({ listingId: parsedListingId }, 'Amenities: daily lookup budget exhausted')
      return NextResponse.json({ amenities: [], computedAt: null, cached: false, reason: 'budget_exceeded' })
    }

    const computed = await computeNearbyAmenities(listing.lat, listing.lng)
    if (!computed) {
      // Mapbox itself failed (missing token, both Tilequery layers down,
      // etc.) - not persisted, so a transient outage doesn't permanently
      // blank this listing's amenities.
      return NextResponse.json({ amenities: [], computedAt: null, cached: false, reason: 'computation_failed' })
    }

    await db.update(listings).set({ amenities: computed }).where(eq(listings.id, parsedListingId))

    logger.info(
      { listingId: parsedListingId, count: computed.amenities.length },
      'Amenities computed and cached for listing'
    )
    return NextResponse.json({ ...computed, cached: false })
  } catch (err) {
    Sentry.captureException(err)
    logger.error({ err }, 'Failed to fetch listing amenities')
    return NextResponse.json({ error: 'Failed to load nearby amenities' }, { status: 500 })
  }
}
