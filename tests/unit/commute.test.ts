import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  pointInPolygon,
  isPointWithinCommute,
  computeCommuteIsochrone,
  TRANSIT_TIME_MULTIPLIER,
  type CommuteIsochroneCache,
} from '@/lib/commute'

const mockGeocode = vi.fn()
vi.mock('@/lib/listings', () => ({
  geocode: (...args: unknown[]) => mockGeocode(...args),
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockFetch = vi.fn()
global.fetch = mockFetch

// A simple 1x1-degree square, roughly [lng, lat] = (0,0) to (1,1).
const square: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
}

// Same square but with a smaller square hole cut out of the middle.
const squareWithHole: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
    [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
      [4, 4],
    ],
  ],
}

const twoDisjointSquares: GeoJSON.MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ],
    [
      [
        [10, 10],
        [11, 10],
        [11, 11],
        [10, 11],
        [10, 10],
      ],
    ],
  ],
}

describe('pointInPolygon', () => {
  it('returns true for a point inside a simple polygon', () => {
    expect(pointInPolygon([0.5, 0.5], square)).toBe(true)
  })

  it('returns false for a point outside a simple polygon', () => {
    expect(pointInPolygon([5, 5], square)).toBe(false)
  })

  it('returns false for a point inside the exterior ring but inside a hole', () => {
    expect(pointInPolygon([5, 5], squareWithHole)).toBe(false)
  })

  it('returns true for a point inside the exterior ring but outside the hole', () => {
    expect(pointInPolygon([1, 1], squareWithHole)).toBe(true)
  })

  it('returns true for a point inside either polygon of a MultiPolygon', () => {
    expect(pointInPolygon([0.5, 0.5], twoDisjointSquares)).toBe(true)
    expect(pointInPolygon([10.5, 10.5], twoDisjointSquares)).toBe(true)
  })

  it('returns false for a point inside neither polygon of a MultiPolygon', () => {
    expect(pointInPolygon([5, 5], twoDisjointSquares)).toBe(false)
  })
})

describe('isPointWithinCommute', () => {
  const isochrone: CommuteIsochroneCache = {
    center: { lat: 0.5, lng: 0.5 },
    mode: 'drive',
    maxMinutes: 20,
    mapboxProfile: 'driving',
    effectiveMinutes: 20,
    polygon: square,
    computedAt: '2026-07-16T00:00:00.000Z',
    approximate: false,
  }

  it('passes through (never disqualifies) when there is no isochrone set', () => {
    expect(isPointWithinCommute(5, 5, null)).toBe(true)
    expect(isPointWithinCommute(5, 5, undefined)).toBe(true)
  })

  it('passes through when the listing has no coordinates', () => {
    expect(isPointWithinCommute(null, null, isochrone)).toBe(true)
    expect(isPointWithinCommute(0.5, null, isochrone)).toBe(true)
  })

  it('returns true for a listing inside the cached commute polygon', () => {
    // isPointWithinCommute takes (lat, lng); the polygon is in [lng, lat] order.
    expect(isPointWithinCommute(0.5, 0.5, isochrone)).toBe(true)
  })

  it('returns false for a listing outside the cached commute polygon', () => {
    expect(isPointWithinCommute(5, 5, isochrone)).toBe(false)
  })
})

describe('computeCommuteIsochrone', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MAPBOX_TOKEN = 'test-token'
  })

  it('returns null when MAPBOX_TOKEN is not set', async () => {
    delete process.env.MAPBOX_TOKEN
    const result = await computeCommuteIsochrone({ address: '1 Market St, SF', mode: 'drive', maxMinutes: 30 })
    expect(result).toBeNull()
    expect(mockGeocode).not.toHaveBeenCalled()
  })

  it('returns null when address is empty', async () => {
    const result = await computeCommuteIsochrone({ address: '', mode: 'drive', maxMinutes: 30 })
    expect(result).toBeNull()
  })

  it('returns null when maxMinutes is 0 or negative', async () => {
    expect(await computeCommuteIsochrone({ address: '1 Market St', mode: 'drive', maxMinutes: 0 })).toBeNull()
    expect(await computeCommuteIsochrone({ address: '1 Market St', mode: 'drive', maxMinutes: -5 })).toBeNull()
  })

  it('returns null when geocoding the work address fails', async () => {
    mockGeocode.mockResolvedValueOnce(null)
    const result = await computeCommuteIsochrone({ address: 'nowhere', mode: 'drive', maxMinutes: 30 })
    expect(result).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('calls Mapbox with the driving profile and the raw max-minutes for drive mode', async () => {
    mockGeocode.mockResolvedValueOnce({ lat: 37.7749, lng: -122.4194 })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ features: [{ geometry: square }] }),
    })

    const result = await computeCommuteIsochrone({ address: '1 Market St, SF', mode: 'drive', maxMinutes: 30 })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('/isochrone/v1/mapbox/driving/')
    expect(url).toContain('-122.4194,37.7749')
    expect(url).toContain('contours_minutes=30')
    expect(result).toMatchObject({
      mode: 'drive',
      mapboxProfile: 'driving',
      maxMinutes: 30,
      effectiveMinutes: 30,
      approximate: false,
    })
  })

  it('calls Mapbox with the cycling profile for bike mode', async () => {
    mockGeocode.mockResolvedValueOnce({ lat: 37.7749, lng: -122.4194 })
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ features: [{ geometry: square }] }) })

    const result = await computeCommuteIsochrone({ address: '1 Market St, SF', mode: 'bike', maxMinutes: 20 })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('/isochrone/v1/mapbox/cycling/')
    expect(result?.mapboxProfile).toBe('cycling')
    expect(result?.approximate).toBe(false)
  })

  it('approximates transit via the walking profile with the documented multiplier, flagged as approximate', async () => {
    mockGeocode.mockResolvedValueOnce({ lat: 37.7749, lng: -122.4194 })
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ features: [{ geometry: square }] }) })

    const result = await computeCommuteIsochrone({ address: '1 Market St, SF', mode: 'transit', maxMinutes: 20 })

    const url = mockFetch.mock.calls[0][0] as string
    const expectedMinutes = Math.round(20 * TRANSIT_TIME_MULTIPLIER)
    expect(url).toContain('/isochrone/v1/mapbox/walking/')
    expect(url).toContain(`contours_minutes=${expectedMinutes}`)
    expect(result).toMatchObject({
      mode: 'transit',
      mapboxProfile: 'walking',
      maxMinutes: 20,
      effectiveMinutes: expectedMinutes,
      approximate: true,
    })
  })

  it('caps the transit-multiplied minutes at Mapbox\'s 60-minute contour maximum', async () => {
    mockGeocode.mockResolvedValueOnce({ lat: 37.7749, lng: -122.4194 })
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ features: [{ geometry: square }] }) })

    const result = await computeCommuteIsochrone({ address: '1 Market St, SF', mode: 'transit', maxMinutes: 45 })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('contours_minutes=60')
    expect(result?.effectiveMinutes).toBe(60)
  })

  it('returns null when the Mapbox API responds with a non-ok status', async () => {
    mockGeocode.mockResolvedValueOnce({ lat: 37.7749, lng: -122.4194 })
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422 })

    const result = await computeCommuteIsochrone({ address: '1 Market St, SF', mode: 'drive', maxMinutes: 30 })
    expect(result).toBeNull()
  })

  it('returns null when the response has no usable polygon geometry', async () => {
    mockGeocode.mockResolvedValueOnce({ lat: 37.7749, lng: -122.4194 })
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ features: [] }) })

    const result = await computeCommuteIsochrone({ address: '1 Market St, SF', mode: 'drive', maxMinutes: 30 })
    expect(result).toBeNull()
  })

  it('returns null (never throws) when fetch itself rejects', async () => {
    mockGeocode.mockResolvedValueOnce({ lat: 37.7749, lng: -122.4194 })
    mockFetch.mockRejectedValueOnce(new Error('network error'))

    const result = await computeCommuteIsochrone({ address: '1 Market St, SF', mode: 'drive', maxMinutes: 30 })
    expect(result).toBeNull()
  })
})
