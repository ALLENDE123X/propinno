import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET as getCriteria, PATCH as patchCriteria } from '@/app/api/criteria/route'
import { criteria } from '@/lib/db/schema'

const mockGetActiveSessionUser = vi.fn()
vi.mock('@/lib/session', () => ({
  getActiveSessionUser: (...args: unknown[]) => mockGetActiveSessionUser(...args),
  sessionErrorResponse: (status: 401 | 403) => ({
    error: status === 401 ? 'Unauthorized' : 'Access pass required',
    status,
  }),
}))

const mockLimitRequest = vi.fn().mockResolvedValue({ success: true })
vi.mock('@/lib/ratelimit', () => ({
  limitRequest: (...args: unknown[]) => mockLimitRequest(...args),
}))

const mockComputeCommuteIsochrone = vi.fn()
vi.mock('@/lib/commute', () => ({
  computeCommuteIsochrone: (...args: unknown[]) => mockComputeCommuteIsochrone(...args),
}))

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

// Both GET and PATCH read via db.select({...}).from(criteria).where(...),
// awaited directly (no orderBy/limit like GET /api/favourites) - a single
// chainable mock covers both call sites.
const mockWhere = vi.fn()
const mockFrom = vi.fn().mockReturnValue({ where: mockWhere })
const mockSelect = vi.fn().mockReturnValue({ from: mockFrom })

// PATCH writes via db.insert(criteria).values({...}).onConflictDoUpdate({...}).
const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined)
const mockInsertValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate })
const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues })

vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
  },
}))

function makeRequest(method: string, body?: unknown) {
  return new Request('http://localhost/api/criteria', {
    method,
    ...(body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  })
}

describe('GET /api/criteria', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLimitRequest.mockResolvedValue({ success: true })
  })

  it('returns 429 when rate limited', async () => {
    mockLimitRequest.mockResolvedValueOnce({ success: false })
    const res = await getCriteria(makeRequest('GET'))
    expect(res.status).toBe(429)
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetActiveSessionUser.mockResolvedValueOnce({ ok: false, status: 401 })
    const res = await getCriteria(makeRequest('GET'))
    expect(res.status).toBe(401)
  })

  it('returns 403 for a non-active user', async () => {
    mockGetActiveSessionUser.mockResolvedValueOnce({ ok: false, status: 403 })
    const res = await getCriteria(makeRequest('GET'))
    expect(res.status).toBe(403)
  })

  it("returns the current user's saved criteria", async () => {
    mockGetActiveSessionUser.mockResolvedValueOnce({ ok: true, userId: 'u1' })
    const row = {
      priceMin: 2000, priceMax: 4000, bedsMin: 1, bedsMax: 2, bathsMin: 1, bathsMax: 1.5,
      zips: ['94123'], neighborhoods: ['Marina'], pets: 'dogs', laundry: 'in_unit',
      commuteAddress: '1 Ferry Building, San Francisco, CA', commuteMaxMinutes: 30, commuteMode: 'transit',
    }
    mockWhere.mockResolvedValueOnce([row])

    const res = await getCriteria(makeRequest('GET'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.criteria).toEqual(row)
    expect(mockFrom).toHaveBeenCalledWith(criteria)
  })

  it('returns an all-null default shape when no criteria row exists', async () => {
    mockGetActiveSessionUser.mockResolvedValueOnce({ ok: true, userId: 'u1' })
    mockWhere.mockResolvedValueOnce([])

    const res = await getCriteria(makeRequest('GET'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.criteria.priceMin).toBeNull()
    expect(body.criteria.commuteMode).toBeNull()
  })

  it('returns 500 and reports to Sentry when the query throws', async () => {
    mockGetActiveSessionUser.mockResolvedValueOnce({ ok: true, userId: 'u1' })
    mockWhere.mockRejectedValueOnce(new Error('db down'))
    const res = await getCriteria(makeRequest('GET'))
    expect(res.status).toBe(500)
  })
})

describe('PATCH /api/criteria', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLimitRequest.mockResolvedValue({ success: true })
    mockGetActiveSessionUser.mockResolvedValue({ ok: true, userId: 'u1' })
    // Default "no existing commute criteria" row for tests that don't care.
    mockWhere.mockResolvedValue([{ commuteAddress: null, commuteMode: null, commuteMaxMinutes: null }])
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetActiveSessionUser.mockResolvedValueOnce({ ok: false, status: 401 })
    const res = await patchCriteria(makeRequest('PATCH', { priceMax: 4000 }))
    expect(res.status).toBe(401)
  })

  it('returns 400 for an invalid body', async () => {
    const res = await patchCriteria(makeRequest('PATCH', { pets: 'iguanas' }))
    expect(res.status).toBe(400)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('returns 400 when no fields are provided', async () => {
    const res = await patchCriteria(makeRequest('PATCH', {}))
    expect(res.status).toBe(400)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('updates a non-commute field (e.g. price) without touching or recomputing the commute isochrone', async () => {
    const res = await patchCriteria(makeRequest('PATCH', { priceMax: 4500, bathsMin: 1.5 }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, commuteRecomputed: false })
    expect(mockComputeCommuteIsochrone).not.toHaveBeenCalled()
    expect(mockInsertValues).toHaveBeenCalledWith({ userId: 'u1', priceMax: 4500, bathsMin: 1.5 })
    expect(mockInsertValues.mock.calls[0][0]).not.toHaveProperty('commuteIsochrone')
  })

  it('recomputes the commute isochrone when the commute fields actually change', async () => {
    mockWhere.mockResolvedValue([{ commuteAddress: null, commuteMode: null, commuteMaxMinutes: null }])
    const fakeIsochrone = { polygon: { type: 'Polygon', coordinates: [] }, approximate: false }
    mockComputeCommuteIsochrone.mockResolvedValueOnce(fakeIsochrone)

    const res = await patchCriteria(makeRequest('PATCH', {
      commuteAddress: '1 Ferry Building, San Francisco, CA',
      commuteMode: 'transit',
      commuteMaxMinutes: 30,
    }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, commuteRecomputed: true })
    expect(mockComputeCommuteIsochrone).toHaveBeenCalledWith({
      address: '1 Ferry Building, San Francisco, CA',
      mode: 'transit',
      maxMinutes: 30,
    })
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ commuteIsochrone: fakeIsochrone }))
  })

  it('does NOT recompute the commute isochrone when the request re-sends the same, unchanged commute values', async () => {
    mockWhere.mockResolvedValue([{
      commuteAddress: '1 Ferry Building, San Francisco, CA',
      commuteMode: 'transit',
      commuteMaxMinutes: 30,
    }])

    const res = await patchCriteria(makeRequest('PATCH', {
      commuteAddress: '1 Ferry Building, San Francisco, CA',
      commuteMode: 'transit',
      commuteMaxMinutes: 30,
      priceMin: 2500,
    }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, commuteRecomputed: false })
    expect(mockComputeCommuteIsochrone).not.toHaveBeenCalled()
    expect(mockInsertValues.mock.calls[0][0]).not.toHaveProperty('commuteIsochrone')
  })

  it('clears the cached isochrone (without calling Mapbox) when a commute field is cleared to null', async () => {
    mockWhere.mockResolvedValue([{
      commuteAddress: '1 Ferry Building, San Francisco, CA',
      commuteMode: 'transit',
      commuteMaxMinutes: 30,
    }])

    const res = await patchCriteria(makeRequest('PATCH', { commuteAddress: null }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, commuteRecomputed: true })
    expect(mockComputeCommuteIsochrone).not.toHaveBeenCalled()
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ commuteAddress: null, commuteIsochrone: null }))
  })

  it('sets a null isochrone (non-fatal) when computeCommuteIsochrone itself fails', async () => {
    mockWhere.mockResolvedValue([{ commuteAddress: null, commuteMode: null, commuteMaxMinutes: null }])
    mockComputeCommuteIsochrone.mockResolvedValueOnce(null)

    const res = await patchCriteria(makeRequest('PATCH', {
      commuteAddress: 'somewhere unresolvable',
      commuteMode: 'drive',
      commuteMaxMinutes: 20,
    }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, commuteRecomputed: true })
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ commuteIsochrone: null }))
  })

  it('returns 500 and reports to Sentry when the update throws', async () => {
    mockOnConflictDoUpdate.mockRejectedValueOnce(new Error('db down'))
    const res = await patchCriteria(makeRequest('PATCH', { priceMax: 4000 }))
    expect(res.status).toBe(500)
  })
})
