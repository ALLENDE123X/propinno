import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computeNearbyAmenities, SF_BLOCK_METERS } from '@/lib/amenities'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockFetch = vi.fn()
global.fetch = mockFetch

const LISTING_LAT = 37.7648
const LISTING_LNG = -122.4198

// Shapes below mirror real Mapbox Tilequery/Directions responses captured
// live against real SF coordinates during this ticket's research (see
// lib/amenities.ts's header comment + the AH-023 ARCHITECTURE.md section for
// the actual request/response evidence).
function poiFeature(overrides: {
  name?: string | null
  maki?: string | null
  class?: string
  distance?: number
  lat?: number
  lng?: number
}) {
  return {
    type: 'Feature',
    properties: {
      class: overrides.class ?? 'food_and_drink_stores',
      maki: overrides.maki ?? 'grocery',
      name: overrides.name ?? 'Whole Foods Market',
      tilequery: { distance: overrides.distance ?? 128, geometry: 'point', layer: 'poi_label' },
    },
    geometry: { type: 'Point', coordinates: [overrides.lng ?? LISTING_LNG + 0.001, overrides.lat ?? LISTING_LAT + 0.001] },
  }
}

function transitFeature(overrides: {
  name?: string | null
  maki?: string | null
  stop_type?: string
  distance?: number
  lat?: number
  lng?: number
}) {
  return {
    type: 'Feature',
    properties: {
      stop_type: overrides.stop_type ?? 'station',
      maki: overrides.maki ?? 'rail-metro',
      mode: 'metro_rail',
      name: overrides.name ?? '16th Street Mission',
      tilequery: { distance: overrides.distance ?? 32, geometry: 'point', layer: 'transit_stop_label' },
    },
    geometry: { type: 'Point', coordinates: [overrides.lng ?? LISTING_LNG + 0.002, overrides.lat ?? LISTING_LAT + 0.002] },
  }
}

function directionsResponse(distanceMeters: number, durationSeconds: number) {
  return {
    code: 'Ok',
    routes: [{ distance: distanceMeters, duration: durationSeconds }],
  }
}

// Routes calls to the three endpoints computeNearbyAmenities hits, by URL
// substring, so each test only has to describe the Tilequery/Directions
// data it cares about rather than wiring up ordered mock resolutions.
function mockFetchByUrl(handlers: {
  poi?: object[] | 'fail' | 'error'
  transit?: object[] | 'fail' | 'error'
  directions?: (url: string) => { ok: boolean; distance?: number; duration?: number } | 'error'
}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('layers=poi_label')) {
      if (handlers.poi === 'error') throw new Error('network error')
      if (handlers.poi === 'fail') return { ok: false, status: 500 }
      return { ok: true, json: async () => ({ features: handlers.poi ?? [] }) }
    }
    if (url.includes('layers=transit_stop_label')) {
      if (handlers.transit === 'error') throw new Error('network error')
      if (handlers.transit === 'fail') return { ok: false, status: 500 }
      return { ok: true, json: async () => ({ features: handlers.transit ?? [] }) }
    }
    if (url.includes('/directions/v5/')) {
      const result = handlers.directions?.(url)
      if (!result || result === 'error') throw new Error('network error')
      if (!result.ok) return { ok: false, status: 500 }
      return { ok: true, json: async () => directionsResponse(result.distance!, result.duration!) }
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`)
  })
}

describe('computeNearbyAmenities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MAPBOX_TOKEN = 'test-token'
  })

  it('returns null when MAPBOX_TOKEN is not set', async () => {
    delete process.env.MAPBOX_TOKEN
    const result = await computeNearbyAmenities(LISTING_LAT, LISTING_LNG)
    expect(result).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns null when both Tilequery layers fail outright', async () => {
    mockFetchByUrl({ poi: 'error', transit: 'error' })
    const result = await computeNearbyAmenities(LISTING_LAT, LISTING_LNG)
    expect(result).toBeNull()
  })

  it('returns a real (non-null) empty result when Mapbox answers but finds nothing nearby', async () => {
    mockFetchByUrl({ poi: [], transit: [] })
    const result = await computeNearbyAmenities(LISTING_LAT, LISTING_LNG)
    expect(result).not.toBeNull()
    expect(result?.amenities).toEqual([])
    expect(typeof result?.computedAt).toBe('string')
  })

  it('proceeds with partial results when only one Tilequery layer fails', async () => {
    mockFetchByUrl({
      poi: 'error',
      transit: [transitFeature({ maki: 'bicycle-share', name: 'Bay Wheels', distance: 40 })],
      directions: () => ({ ok: true, distance: 45, duration: 40 }),
    })
    const result = await computeNearbyAmenities(LISTING_LAT, LISTING_LNG)
    expect(result).not.toBeNull()
    expect(result?.amenities).toHaveLength(1)
    expect(result?.amenities[0].category).toBe('bike_share')
  })

  it('maps grocery/supermarket poi_label maki values to the grocery category', async () => {
    mockFetchByUrl({
      poi: [
        poiFeature({ maki: 'grocery', name: 'Safeway', distance: 209 }),
        poiFeature({ maki: 'supermarket', name: 'Trader Joe’s', distance: 500 }),
      ],
      transit: [],
      directions: () => ({ ok: true, distance: 200, duration: 150 }),
    })
    const result = await computeNearbyAmenities(LISTING_LAT, LISTING_LNG)
    // Nearest-per-category = 1, so only Safeway (closer) survives.
    expect(result?.amenities).toHaveLength(1)
    expect(result?.amenities[0]).toMatchObject({ name: 'Safeway', category: 'grocery' })
  })

  it('maps fitness-centre poi_label maki to gym, and ignores unrelated classes', async () => {
    mockFetchByUrl({
      poi: [
        poiFeature({ maki: 'fitness-centre', class: 'sport_and_leisure', name: 'Equinox', distance: 172 }),
        poiFeature({ maki: 'restaurant', class: 'food_and_drink', name: 'Nakama Sushi', distance: 50 }),
        poiFeature({ maki: 'theatre', class: 'arts_and_entertainment', name: 'Victoria Theatre', distance: 30 }),
      ],
      transit: [],
      directions: () => ({ ok: true, distance: 180, duration: 140 }),
    })
    const result = await computeNearbyAmenities(LISTING_LAT, LISTING_LNG)
    expect(result?.amenities).toHaveLength(1)
    expect(result?.amenities[0]).toMatchObject({ name: 'Equinox', category: 'gym' })
  })

  it('maps transit_stop_label rail/bus/ferry maki values to transit and bicycle-share to bike_share', async () => {
    mockFetchByUrl({
      poi: [],
      transit: [
        transitFeature({ maki: 'rail-metro', stop_type: 'station', name: '16th Street Mission', distance: 32 }),
        transitFeature({ maki: 'bus', stop_type: 'stop', name: 'Mission Street & 16th Street', distance: 5 }),
        transitFeature({ maki: 'bicycle-share', stop_type: 'stop', name: 'Bay Wheels', distance: 31 }),
      ],
      directions: (url) => {
        if (url.includes('16')) return { ok: true, distance: 62, duration: 47 }
        return { ok: true, distance: 40, duration: 35 }
      },
    })
    const result = await computeNearbyAmenities(LISTING_LAT, LISTING_LNG)
    const categories = result?.amenities.map((a) => a.category).sort()
    // transit: bus (5m) beats rail-metro (32m) for nearest-per-category;
    // bike_share: Bay Wheels.
    expect(categories).toEqual(['bike_share', 'transit'])
  })

  it('filters out transit_stop_label entrance points in favor of named stop/station points', async () => {
    mockFetchByUrl({
      poi: [],
      transit: [
        transitFeature({ maki: 'entrance', stop_type: 'entrance', name: null, distance: 5 }),
        transitFeature({ maki: 'rail-metro', stop_type: 'station', name: '16th Street Mission', distance: 32 }),
      ],
      directions: () => ({ ok: true, distance: 62, duration: 47 }),
    })
    const result = await computeNearbyAmenities(LISTING_LAT, LISTING_LNG)
    expect(result?.amenities).toHaveLength(1)
    expect(result?.amenities[0].name).toBe('16th Street Mission')
  })

  it('dedupes repeated same-name candidates within a category, keeping the nearest', async () => {
    mockFetchByUrl({
      poi: [],
      transit: [
        transitFeature({ maki: 'bicycle-share', name: 'Bay Wheels', distance: 600 }),
        transitFeature({ maki: 'bicycle-share', name: 'Bay Wheels', distance: 31, lat: LISTING_LAT + 0.0005, lng: LISTING_LNG + 0.0005 }),
      ],
      directions: () => ({ ok: true, distance: 35, duration: 30 }),
    })
    const result = await computeNearbyAmenities(LISTING_LAT, LISTING_LNG)
    expect(result?.amenities).toHaveLength(1)
    expect(result?.amenities[0].lat).toBeCloseTo(LISTING_LAT + 0.0005)
  })

  it('calls Mapbox Directions with the walking profile between the listing and the candidate', async () => {
    mockFetchByUrl({
      poi: [poiFeature({ maki: 'grocery', name: 'Safeway', distance: 209, lat: 37.77, lng: -122.42 })],
      transit: [],
      directions: () => ({ ok: true, distance: 200, duration: 150 }),
    })
    await computeNearbyAmenities(LISTING_LAT, LISTING_LNG)

    const directionsCall = mockFetch.mock.calls.find((c) => (c[0] as string).includes('/directions/v5/'))
    expect(directionsCall).toBeDefined()
    const url = directionsCall![0] as string
    expect(url).toContain('/directions/v5/mapbox/walking/')
    expect(url).toContain(`${LISTING_LNG},${LISTING_LAT}`)
    expect(url).toContain('-122.42,37.77')
  })

  it('computes walkMinutes from real route duration (rounded, minimum 1) and blocksApprox from real distance', async () => {
    mockFetchByUrl({
      poi: [poiFeature({ maki: 'grocery', name: 'Safeway', distance: 209 })],
      transit: [],
      directions: () => ({ ok: true, distance: 200, duration: 150 }), // 150s = 2.5min -> rounds to 3
    })
    const result = await computeNearbyAmenities(LISTING_LAT, LISTING_LNG)
    expect(result?.amenities[0].walkMeters).toBe(200)
    expect(result?.amenities[0].walkMinutes).toBe(3)
    expect(result?.amenities[0].blocksApprox).toBe(Math.round(200 / SF_BLOCK_METERS))
  })

  it('floors walkMinutes and blocksApprox at 1 even for a very short real route', async () => {
    mockFetchByUrl({
      poi: [poiFeature({ maki: 'grocery', name: 'Corner Store', distance: 10 })],
      transit: [],
      directions: () => ({ ok: true, distance: 8, duration: 5 }),
    })
    const result = await computeNearbyAmenities(LISTING_LAT, LISTING_LNG)
    expect(result?.amenities[0].walkMinutes).toBeGreaterThanOrEqual(1)
    expect(result?.amenities[0].blocksApprox).toBeGreaterThanOrEqual(1)
  })

  it('drops just the one candidate whose Directions call fails, keeping the rest', async () => {
    mockFetchByUrl({
      poi: [poiFeature({ maki: 'grocery', name: 'Safeway', distance: 209 })],
      transit: [transitFeature({ maki: 'bicycle-share', name: 'Bay Wheels', distance: 31 })],
      directions: (url) => (url.includes('directions') && Math.random() >= 0 ? undefined : undefined) as never,
    })
    // Override with per-call sequencing: first Directions call (grocery) fails, second (bike_share) succeeds.
    let directionsCallCount = 0
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('layers=poi_label')) {
        return { ok: true, json: async () => ({ features: [poiFeature({ maki: 'grocery', name: 'Safeway', distance: 209 })] }) }
      }
      if (url.includes('layers=transit_stop_label')) {
        return { ok: true, json: async () => ({ features: [transitFeature({ maki: 'bicycle-share', name: 'Bay Wheels', distance: 31 })] }) }
      }
      if (url.includes('/directions/v5/')) {
        directionsCallCount++
        if (directionsCallCount === 1) return { ok: false, status: 500 }
        return { ok: true, json: async () => directionsResponse(35, 30) }
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const result = await computeNearbyAmenities(LISTING_LAT, LISTING_LNG)
    expect(result?.amenities).toHaveLength(1)
    expect(result?.amenities[0].category).toBe('bike_share')
  })

  it('never throws (returns null) when a Directions call rejects at the network level', async () => {
    mockFetchByUrl({
      poi: [poiFeature({ maki: 'grocery', name: 'Safeway', distance: 209 })],
      transit: [],
      directions: () => 'error',
    })
    const result = await computeNearbyAmenities(LISTING_LAT, LISTING_LNG)
    // The candidate's Directions call fails -> dropped, but the overall
    // computation still succeeds with an empty (but real) result.
    expect(result).not.toBeNull()
    expect(result?.amenities).toEqual([])
  })
})
