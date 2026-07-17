/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET as amenitiesRoute } from '@/app/api/listings/[listingId]/amenities/route'

const VALID_LISTING_ID = '223e4567-e89b-12d3-a456-426614174000'

vi.mock('@/lib/ratelimit', () => ({
  limitRequest: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}))

vi.mock('@/lib/session', () => ({
  getActiveSessionUser: vi.fn().mockResolvedValue({ ok: true, userId: '123e4567-e89b-12d3-a456-426614174000' }),
  sessionErrorResponse: vi.fn((status: 401 | 403) => ({
    error: status === 401 ? 'Unauthorized' : 'Access pass required',
    status,
  })),
}))

const mockClaimDailyBudget = vi.fn().mockResolvedValue(true)
vi.mock('@/lib/pollerBudget', () => ({
  claimDailyBudget: (...args: unknown[]) => mockClaimDailyBudget(...args),
}))

const mockComputeNearbyAmenities = vi.fn()
vi.mock('@/lib/amenities', () => ({
  computeNearbyAmenities: (...args: unknown[]) => mockComputeNearbyAmenities(...args),
}))

// db.select({...}).from(listings).where(...) awaited directly (no .limit()),
// same shape as app/api/favourites/[listingId]/route.ts's existence check,
// which tests/unit/favourites.test.ts already mocks the same way.
const mockSelectWhere = vi.fn()
const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectWhere })
const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom })

// db.update(listings).set({amenities}).where(...) - result isn't read, just awaited.
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined)
const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere })
const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet })

vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}))

function makeRequest(listingId = VALID_LISTING_ID) {
  return new Request(`http://localhost/api/listings/${listingId}/amenities`)
}

function callRoute(listingId = VALID_LISTING_ID) {
  return amenitiesRoute(makeRequest(listingId), { params: Promise.resolve({ listingId }) })
}

const SAMPLE_AMENITY = {
  name: 'Safeway',
  category: 'grocery',
  lat: 37.7676,
  lng: -122.4269,
  walkMeters: 200,
  walkMinutes: 3,
  blocksApprox: 3,
}

describe('GET /api/listings/[listingId]/amenities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClaimDailyBudget.mockResolvedValue(true)
    mockSelectWhere.mockResolvedValue([{ lat: 37.77, lng: -122.42, amenities: null }])
  })

  it('returns 429 when rate limited', async () => {
    const { limitRequest } = await import('@/lib/ratelimit')
    vi.mocked(limitRequest).mockResolvedValueOnce({ success: false, limit: 10, remaining: 0, reset: 0 })

    const res = await callRoute()
    expect(res.status).toBe(429)
  })

  it('returns the session-error status when not an active user', async () => {
    const { getActiveSessionUser } = await import('@/lib/session')
    vi.mocked(getActiveSessionUser).mockResolvedValueOnce({ ok: false, status: 403 } as any)

    const res = await callRoute()
    expect(res.status).toBe(403)
  })

  it('returns 400 for a non-UUID listingId', async () => {
    const res = await callRoute('not-a-uuid')
    expect(res.status).toBe(400)
  })

  it('returns 404 when the listing does not exist', async () => {
    mockSelectWhere.mockResolvedValueOnce([])
    const res = await callRoute()
    expect(res.status).toBe(404)
  })

  it('serves the cached result directly and never calls computeNearbyAmenities or the budget check', async () => {
    const cached = { amenities: [SAMPLE_AMENITY], computedAt: '2026-07-16T00:00:00.000Z' }
    mockSelectWhere.mockResolvedValueOnce([{ lat: 37.77, lng: -122.42, amenities: cached }])

    const res = await callRoute()
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.cached).toBe(true)
    expect(data.amenities).toEqual([SAMPLE_AMENITY])
    expect(mockComputeNearbyAmenities).not.toHaveBeenCalled()
    expect(mockClaimDailyBudget).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('returns a no_coordinates reason without computing or persisting when the listing has no lat/lng', async () => {
    mockSelectWhere.mockResolvedValueOnce([{ lat: null, lng: null, amenities: null }])

    const res = await callRoute()
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.reason).toBe('no_coordinates')
    expect(data.amenities).toEqual([])
    expect(mockComputeNearbyAmenities).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('returns budget_exceeded without computing or persisting when the daily lookup budget is used up', async () => {
    mockClaimDailyBudget.mockResolvedValueOnce(false)

    const res = await callRoute()
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.reason).toBe('budget_exceeded')
    expect(mockComputeNearbyAmenities).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('computes and persists a cache-miss result, returning cached: false', async () => {
    mockComputeNearbyAmenities.mockResolvedValueOnce({
      amenities: [SAMPLE_AMENITY],
      computedAt: '2026-07-16T00:00:00.000Z',
    })

    const res = await callRoute()
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.cached).toBe(false)
    expect(data.amenities).toEqual([SAMPLE_AMENITY])
    expect(mockComputeNearbyAmenities).toHaveBeenCalledWith(37.77, -122.42)
    expect(mockUpdate).toHaveBeenCalled()
    expect(mockUpdateSet).toHaveBeenCalledWith({
      amenities: { amenities: [SAMPLE_AMENITY], computedAt: '2026-07-16T00:00:00.000Z' },
    })
  })

  it('returns computation_failed without persisting when Mapbox computation fails', async () => {
    mockComputeNearbyAmenities.mockResolvedValueOnce(null)

    const res = await callRoute()
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.reason).toBe('computation_failed')
    expect(data.amenities).toEqual([])
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})
