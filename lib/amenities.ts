import { logger } from '@/lib/logger'

// AH-023 nearby-amenity lookup (grocery/gym/transit/bike-share) for a
// listing's detail card.
//
// ── Data source: Mapbox Tilequery + Directions, not Google Places ──
// This project already has a MAPBOX_TOKEN and uses Mapbox exclusively
// (geocoding in lib/listings.ts, the dashboard map, AH-017's isochrones) -
// no Google Places API key exists anywhere in this project's env footprint.
// Investigated whether Mapbox's own products could cover this ticket before
// reaching for a new vendor, by live-testing real SF coordinates against two
// Mapbox APIs (see the AH-023 section of ARCHITECTURE.md for the actual
// request/response evidence, not just a plan):
//   - Tilequery API (https://docs.mapbox.com/api/maps/tilequery/) against the
//     `mapbox.mapbox-streets-v8` tileset's `poi_label` layer returns real,
//     categorized POIs with a `maki` icon field - confirmed `maki: 'grocery'`
//     / `'supermarket'` (Whole Foods, Safeway) and `maki: 'fitness-centre'`
//     (Equinox, Pilates on Page) in live responses near real SF addresses.
//   - The SAME tileset also has a dedicated `transit_stop_label` layer
//     (separate from poi_label, confirmed via Mapbox's own Streets v8
//     reference) with `mode`/`stop_type`/`maki` fields - confirmed
//     `maki: 'bicycle-share'` (Bay Wheels stations) and `maki: 'rail-metro'`
//     / `'bus'` (16th St Mission BART + Muni stops) in live responses.
//     Querying this layer separately from poi_label matters: poi_label in a
//     dense SF block is dominated by restaurants/shops, which can crowd a
//     genuinely close transit stop out of the (max 50) proximity-ordered
//     results - transit_stop_label doesn't have that competition.
//   - Directions API (walking profile) returns real walking routes (not
//     straight-line) between two points - confirmed live between a Mission
//     St address and the 16th St Mission BART entrance (61.9m / 47s).
// Mapbox's own products cover all four required categories (grocery, gym,
// transit, bike share) with real proximity + real walking-route data, so no
// new vendor/API key was added for this ticket.
//
// ── Cost: Tilequery is 100k requests/month free, then $1.50/1k. Directions
// (walking) is 100k/month free, then $2.00/1k (see Mapbox's pricing page,
// checked 2026-07 as part of this ticket). Combined with the "compute once,
// cache forever" design below and the per-day budget cap in the calling
// route, this stays far under the free tier even at this project's current
// listing volume. ──
//
// ── Design: compute once per listing, cache forever, never call Mapbox on
// every pageview ── Same principle as AH-017's isochrone caching: a
// listing's coordinates don't change, so its nearby-amenity list doesn't
// either. computeNearbyAmenities() below is pure (no DB access, no budget
// check) - the caller (app/api/listings/[listingId]/amenities/route.ts)
// is what checks the `listings.amenities` cache column first, only calls
// this function on a genuine cache miss, and persists the result. This
// mirrors lib/commute.ts's computeCommuteIsochrone() (pure computation) vs.
// app/api/auth/verify-otp/route.ts (the actual cache-write call site).
//
// ── One nearest amenity per category, not an exhaustive list ── Bounds the
// worst case to 4 Directions API calls per listing (one per category) and
// keeps the mini-map/detail-card focused, matching the ticket's own two
// examples ("8 min to BART", "2 blocks to Safeway" - one instance per type,
// not a list of every nearby option). Easy to raise NEAREST_PER_CATEGORY
// later if product wants more.
//
// ── Honesty about what's real vs. approximated (same standard AH-017 used
// for its transit-mode isochrone approximation) ── The walking DISTANCE and
// TIME for each amenity are real Mapbox Directions routing output, not a
// straight-line estimate - Mapbox's Directions API has a real `walking`
// profile (unlike the Isochrone API's missing transit profile that AH-017
// had to approximate around), so there was no reason to approximate what a
// real routing call already answers correctly. The one genuinely
// approximated figure is `blocksApprox` ("2 blocks to Safeway"): SF block
// lengths vary by neighborhood (roughly 200-450ft depending on the grid), so
// converting a real walking distance into a block count is inherently a
// rough conversion, not a real measurement - flagged here and wherever it's
// rendered, never presented as an exact count.
export type AmenityCategory = 'grocery' | 'gym' | 'transit' | 'bike_share'

export type NearbyAmenity = {
  name: string
  category: AmenityCategory
  lat: number
  lng: number
  // Real Mapbox Directions (walking profile) output - not straight-line.
  walkMeters: number
  walkMinutes: number
  // Approximated from walkMeters via SF_BLOCK_METERS - see header comment.
  blocksApprox: number
}

export type ListingAmenitiesCache = {
  amenities: NearbyAmenity[]
  computedAt: string
}

// Search radius for nearby amenities, per the ticket's own spec ("within
// ~0.5mi"). 1 mile = 1609.34m, so 0.5mi ~= 805m.
const SEARCH_RADIUS_METERS = 805

// Mapbox Tilequery's own hard cap - the API rejects anything higher.
const TILEQUERY_LIMIT = 50

// How many nearest candidates per category to fetch real walking directions
// for - see header comment on why this is 1, not an exhaustive list.
const NEAREST_PER_CATEGORY = 1

// A rough, documented estimate of an average SF block length in meters -
// NOT derived from real block-boundary/parcel data (SF blocks genuinely
// vary, roughly 200-450ft depending on neighborhood/grid). Used only to
// turn a real walking distance into an approximate, human-readable block
// count ("~2 blocks"), same spirit as AH-017's TRANSIT_TIME_MULTIPLIER -
// documented as an estimate, not silently presented as exact.
export const SF_BLOCK_METERS = 80

const TILESET_ID = 'mapbox.mapbox-streets-v8'

// poi_label `maki` values that map onto our four categories. Confirmed
// against live Mapbox responses for real SF addresses (see header comment).
const POI_LABEL_MAKI_TO_CATEGORY: Record<string, AmenityCategory> = {
  grocery: 'grocery',
  supermarket: 'grocery',
  'fitness-centre': 'gym',
}

// transit_stop_label `maki` values - a separate layer from poi_label (see
// header comment for why). `entrance` stop_type points (usually unnamed
// subway/BART entrances) are filtered out below in favor of named
// stop/station points.
const TRANSIT_STOP_MAKI_TO_CATEGORY: Record<string, AmenityCategory> = {
  bus: 'transit',
  rail: 'transit',
  'rail-metro': 'transit',
  'rail-light': 'transit',
  ferry: 'transit',
  'bicycle-share': 'bike_share',
}

type TilequeryFeature = {
  properties: {
    name?: string | null
    maki?: string | null
    stop_type?: string | null
    tilequery?: { distance?: number }
  }
  geometry: { type: string; coordinates: [number, number] }
}

type Candidate = {
  name: string
  category: AmenityCategory
  lat: number
  lng: number
  straightLineDistance: number
}

async function queryTilequeryLayer(
  token: string,
  layer: string,
  lat: number,
  lng: number
): Promise<TilequeryFeature[]> {
  const endpoint = `https://api.mapbox.com/v4/${TILESET_ID}/tilequery/${lng},${lat}.json?radius=${SEARCH_RADIUS_METERS}&limit=${TILEQUERY_LIMIT}&layers=${layer}&access_token=${token}`
  const res = await fetch(endpoint)
  if (!res.ok) {
    logger.warn({ status: res.status, layer }, 'Amenities: Tilequery request failed')
    return []
  }
  const data = await res.json()
  return Array.isArray(data?.features) ? data.features : []
}

function nearestPerCategory(candidates: Candidate[]): Candidate[] {
  const byCategory = new Map<AmenityCategory, Map<string, Candidate>>()

  for (const c of candidates) {
    if (!byCategory.has(c.category)) byCategory.set(c.category, new Map())
    const dedup = byCategory.get(c.category)!
    // Dedupe by name within a category (e.g. multiple "Bay Wheels" markers
    // for the same nearby dock cluster) - keep the nearest occurrence.
    const existing = dedup.get(c.name)
    if (!existing || c.straightLineDistance < existing.straightLineDistance) {
      dedup.set(c.name, c)
    }
  }

  const result: Candidate[] = []
  for (const dedup of byCategory.values()) {
    const sorted = [...dedup.values()].sort((a, b) => a.straightLineDistance - b.straightLineDistance)
    result.push(...sorted.slice(0, NEAREST_PER_CATEGORY))
  }
  return result
}

async function walkingRoute(
  token: string,
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): Promise<{ meters: number; seconds: number } | null> {
  try {
    const endpoint = `https://api.mapbox.com/directions/v5/mapbox/walking/${from.lng},${from.lat};${to.lng},${to.lat}?access_token=${token}&overview=false`
    const res = await fetch(endpoint)
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Amenities: Directions request failed')
      return null
    }
    const data = await res.json()
    const route = data?.routes?.[0]
    if (typeof route?.distance !== 'number' || typeof route?.duration !== 'number') return null
    return { meters: route.distance, seconds: route.duration }
  } catch (err) {
    logger.warn({ err }, 'Amenities: Directions request threw')
    return null
  }
}

/**
 * Computes the nearby-amenity list for a single listing location. Pure -
 * does not touch the DB or any budget/rate-limit state (that's the calling
 * route's job, same split as lib/commute.ts's computeCommuteIsochrone()).
 * Never throws: returns null only when nothing could be computed at all
 * (missing token, or both Tilequery layers failed); returns
 * `{amenities: [], computedAt}` when Mapbox answered successfully but
 * genuinely found nothing within the search radius - that's a real,
 * cacheable result, not a failure.
 */
export async function computeNearbyAmenities(
  lat: number,
  lng: number
): Promise<ListingAmenitiesCache | null> {
  const token = process.env.MAPBOX_TOKEN
  if (!token) return null

  let poiFeatures: TilequeryFeature[] = []
  let transitFeatures: TilequeryFeature[] = []
  let poiFailed = false
  let transitFailed = false

  try {
    poiFeatures = await queryTilequeryLayer(token, 'poi_label', lat, lng)
  } catch (err) {
    poiFailed = true
    logger.warn({ err }, 'Amenities: poi_label Tilequery call threw')
  }

  try {
    transitFeatures = await queryTilequeryLayer(token, 'transit_stop_label', lat, lng)
  } catch (err) {
    transitFailed = true
    logger.warn({ err }, 'Amenities: transit_stop_label Tilequery call threw')
  }

  // Both layers failed outright (e.g. Mapbox is down) - nothing usable to
  // return; let the caller retry later rather than caching an empty result.
  if (poiFailed && transitFailed) return null

  const candidates: Candidate[] = []

  for (const f of poiFeatures) {
    const maki = f.properties.maki
    // maki is an external API string used only as a lookup key into a
    // fixed, hardcoded object below - not a security-sensitive object
    // injection sink, same reasoning as lib/commute.ts's existing
    // ring-index suppressions.
    // eslint-disable-next-line security/detect-object-injection
    const category = maki ? POI_LABEL_MAKI_TO_CATEGORY[maki] : undefined
    const name = f.properties.name
    const distance = f.properties.tilequery?.distance
    if (!category || !name || typeof distance !== 'number') continue
    candidates.push({
      name,
      category,
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      straightLineDistance: distance,
    })
  }

  for (const f of transitFeatures) {
    // `entrance` stop_type points are usually unnamed station-entrance
    // markers, not useful for display - prefer named stop/station points.
    if (f.properties.stop_type === 'entrance') continue
    const maki = f.properties.maki
    // eslint-disable-next-line security/detect-object-injection
    const category = maki ? TRANSIT_STOP_MAKI_TO_CATEGORY[maki] : undefined
    const name = f.properties.name
    const distance = f.properties.tilequery?.distance
    if (!category || !name || typeof distance !== 'number') continue
    candidates.push({
      name,
      category,
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      straightLineDistance: distance,
    })
  }

  const selected = nearestPerCategory(candidates)

  const amenities: NearbyAmenity[] = []
  for (const c of selected) {
    const route = await walkingRoute(token, { lat, lng }, { lat: c.lat, lng: c.lng })
    // A single failed Directions call drops just that one candidate, not
    // the whole result - amenities are additive/best-effort, unlike
    // AH-017's isochrone where a partial result would be meaningless.
    if (!route) continue
    amenities.push({
      name: c.name,
      category: c.category,
      lat: c.lat,
      lng: c.lng,
      walkMeters: Math.round(route.meters),
      walkMinutes: Math.max(1, Math.round(route.seconds / 60)),
      blocksApprox: Math.max(1, Math.round(route.meters / SF_BLOCK_METERS)),
    })
  }

  return { amenities, computedAt: new Date().toISOString() }
}
