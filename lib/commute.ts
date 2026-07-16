import { geocode } from '@/lib/listings'
import { logger } from '@/lib/logger'

// AH-017 commute-time filtering.
//
// ── Design: compute once, filter locally, never call the Isochrone API in
// the matching engine's hot path ──
// computeCommuteIsochrone() is called exactly once per user, at the moment
// their commute criteria is set or changed (onboarding submit today - see
// app/api/auth/verify-otp/route.ts; any future "edit criteria" UI must call
// it the same way). It geocodes the work address (reusing lib/listings.ts's
// geocode(), same helper the listing pollers already use) and calls the
// Mapbox Isochrone API exactly once, caching the resulting polygon + metadata
// as `criteria.commute_isochrone` (jsonb). The matching engine's per-listing
// check (isPointWithinCommute, below) is then a fast local point-in-polygon
// test against that cached polygon - no live API call per match. Calling the
// Isochrone API once per listing×user check would be slow, cost real money at
// volume, and risk Mapbox's rate limit (300 req/min) once there's real
// listing/subscriber traffic - this cache is what avoids that.
//
// ── Known limitation: no real transit profile ──
// Mapbox's Isochrone API supports exactly four profiles: driving-traffic,
// driving, walking, cycling (confirmed against Mapbox's own API docs,
// 2026-07). There is no transit/public-transit profile on this API, or on any
// other Mapbox product - Mapbox does not offer public-transit routing at all.
// Propinno has no other transit-capable routing API in its dependency/env
// footprint (see ARCHITECTURE.md's external service map), and adding a new
// paid third-party transit API as a dependency of this one ticket is out of
// scope.
//
// 'drive' -> Mapbox `driving` profile (real routing).
// 'bike'  -> Mapbox `cycling` profile (real routing).
// 'transit' -> APPROXIMATED via the `walking` profile, with the user's
//   requested max-minutes multiplied by TRANSIT_TIME_MULTIPLIER before being
//   sent to the Isochrone API. Rationale: a real transit trip's effective
//   door-to-door speed (walk-to-stop + wait + ride + walk-from-stop) in a
//   dense urban grid like SF is meaningfully faster than walking the whole
//   distance, but nowhere near "as the crow flies" rail line-haul speed once
//   stops/transfers/waiting are counted. 2.5x is a rough, documented estimate
//   - it is NOT derived from real Muni/BART schedule or GTFS data. This also
//   produces an isotropic (roughly circular) polygon, which is a materially
//   wrong shape for real transit reach (which is corridor-shaped, elongated
//   along rail/bus lines) - it will overestimate reach perpendicular to
//   transit corridors and underestimate reach along fast lines like BART.
// This approximation is surfaced everywhere it's user-visible (this comment,
// the `approximate` flag on the cached result, the dashboard map overlay
// label, and the onboarding form copy) rather than silently presented as real
// transit accuracy.
export const TRANSIT_TIME_MULTIPLIER = 2.5

// Mapbox's Isochrone API caps a single contour at 60 minutes.
const MAPBOX_MAX_CONTOUR_MINUTES = 60

export type CommuteMode = 'transit' | 'bike' | 'drive'

const MODE_TO_MAPBOX_PROFILE: Record<CommuteMode, 'driving' | 'walking' | 'cycling'> = {
  drive: 'driving',
  bike: 'cycling',
  transit: 'walking',
}

export type CommuteIsochroneCache = {
  center: { lat: number; lng: number }
  mode: CommuteMode
  maxMinutes: number
  mapboxProfile: 'driving' | 'walking' | 'cycling'
  // The minutes value actually sent to the Isochrone API - equals maxMinutes
  // for bike/drive, and the multiplied+capped value for transit.
  effectiveMinutes: number
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon
  computedAt: string
  // True for 'transit' mode - flags that this polygon is an approximation,
  // not real transit routing. See header comment.
  approximate: boolean
}

/**
 * Geocodes `address` and calls the Mapbox Isochrone API once, returning a
 * cacheable polygon + metadata. Returns null (never throws) on any failure -
 * missing token, geocode failure, API error, or malformed response - so a
 * Mapbox outage never blocks onboarding; a null result just means the commute
 * filter won't be applied for that user until it's recomputed successfully
 * (matches this schema's existing "null = unknown, don't filter on it"
 * convention - see matchingEngine.ts / lib/listingAttributes.ts).
 */
export async function computeCommuteIsochrone(input: {
  address: string
  mode: CommuteMode
  maxMinutes: number
}): Promise<CommuteIsochroneCache | null> {
  const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN
  if (!MAPBOX_TOKEN || !input.address || !input.maxMinutes || input.maxMinutes <= 0) {
    return null
  }

  const geo = await geocode(input.address)
  if (!geo) {
    logger.warn({ address: input.address }, 'Commute isochrone: failed to geocode work address')
    return null
  }

  const mapboxProfile = MODE_TO_MAPBOX_PROFILE[input.mode]
  const approximate = input.mode === 'transit'
  const effectiveMinutes = Math.min(
    MAPBOX_MAX_CONTOUR_MINUTES,
    Math.round(approximate ? input.maxMinutes * TRANSIT_TIME_MULTIPLIER : input.maxMinutes)
  )

  try {
    const endpoint = `https://api.mapbox.com/isochrone/v1/mapbox/${mapboxProfile}/${geo.lng},${geo.lat}?contours_minutes=${effectiveMinutes}&polygons=true&access_token=${MAPBOX_TOKEN}`
    const res = await fetch(endpoint)
    if (!res.ok) {
      logger.warn(
        { status: res.status, address: input.address, mode: input.mode },
        'Commute isochrone: Mapbox Isochrone API request failed'
      )
      return null
    }

    const data = await res.json()
    const feature = data?.features?.[0]
    const geometry = feature?.geometry
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
      logger.warn({ address: input.address }, 'Commute isochrone: unexpected Mapbox response shape')
      return null
    }

    return {
      center: { lat: geo.lat, lng: geo.lng },
      mode: input.mode,
      maxMinutes: input.maxMinutes,
      mapboxProfile,
      effectiveMinutes,
      polygon: geometry,
      computedAt: new Date().toISOString(),
      approximate,
    }
  } catch (err) {
    logger.error({ err, address: input.address, mode: input.mode }, 'Commute isochrone computation failed')
    return null
  }
}

type Ring = [number, number][]

// Standard ray-casting (even-odd rule) point-in-polygon test. Hand-rolled
// rather than pulling in a geometry library (e.g. @turf/boolean-point-in-polygon)
// since no geometry dependency exists in this project yet and the algorithm
// itself is a well-established handful of lines, directly unit-tested below
// in tests/unit/commute.test.ts - not proportionate to add a new dependency
// for this one check.
function pointInRing(point: [number, number], ring: Ring): boolean {
  const [x, y] = point
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    // i/j are numeric loop counters bounded by ring.length, not user input.
    // eslint-disable-next-line security/detect-object-injection
    const [xi, yi] = ring[i]
    // eslint-disable-next-line security/detect-object-injection
    const [xj, yj] = ring[j]
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/**
 * Point-in-polygon test against a GeoJSON Polygon or MultiPolygon geometry.
 * `point` is [lng, lat] to match GeoJSON's own coordinate order (not [lat,
 * lng]). Handles polygon holes (a point inside the exterior ring but also
 * inside any interior/hole ring is NOT considered inside) and MultiPolygon's
 * multiple disjoint polygons (a point inside any one of them counts).
 */
export function pointInPolygon(
  point: [number, number],
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
): boolean {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  for (const rings of polygons) {
    const [exterior, ...holes] = rings
    if (!exterior || !pointInRing(point, exterior as Ring)) continue
    const inHole = holes.some((hole) => pointInRing(point, hole as Ring))
    if (!inHole) return true
  }
  return false
}

/**
 * The matching engine's actual per-listing commute check - a fast local
 * point-in-polygon test against an already-cached isochrone, never a live API
 * call (see header comment). Null-passthrough, matching the price/beds/
 * pets/laundry filters' existing convention (see matchingEngine.ts): no
 * commute filter set (isochrone null) or a listing with no coordinates never
 * disqualifies a match.
 */
export function isPointWithinCommute(
  lat: number | null,
  lng: number | null,
  isochrone: CommuteIsochroneCache | null | undefined
): boolean {
  if (!isochrone) return true
  if (lat === null || lat === undefined || lng === null || lng === undefined) return true
  return pointInPolygon([lng, lat], isochrone.polygon)
}
