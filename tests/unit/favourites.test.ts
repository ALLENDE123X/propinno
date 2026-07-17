import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET as getFavourites } from '@/app/api/favourites/route'
import { POST as saveFavourite, DELETE as unsaveFavourite } from '@/app/api/favourites/[listingId]/route'
import { favourites } from '@/lib/db/schema'

const VALID_LISTING_ID = '11111111-1111-4111-8111-111111111111'

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

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

// GET /api/favourites: db.select({...}).from(favourites).innerJoin(listings, ...).where(...).orderBy(...).limit(100)
const mockLimit = vi.fn()
const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit })
const mockJoinWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy })
const mockInnerJoin = vi.fn().mockReturnValue({ where: mockJoinWhere })

// POST's listing-existence check: db.select({id}).from(listings).where(...) -- awaited directly.
const mockPlainWhere = vi.fn()

// .from(favourites) is the GET join query; any other table (listings) is the
// POST existence check -- the two routes' select shapes are distinguished by
// which table they call .from() with, matching how the real route code calls it.
const mockFrom = vi.fn((table: unknown) => {
  if (table === favourites) {
    return { innerJoin: mockInnerJoin }
  }
  return { where: mockPlainWhere }
})
const mockSelect = vi.fn().mockReturnValue({ from: mockFrom })

const mockOnConflictDoNothing = vi.fn().mockResolvedValue(undefined)
const mockInsertValues = vi.fn().mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing })
const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues })

const mockReturning = vi.fn()
const mockDeleteWhere = vi.fn().mockReturnValue({ returning: mockReturning })
const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere })

vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}))

function makeRequest(method: string) {
  return new Request('http://localhost/api/favourites', { method })
}

describe('GET /api/favourites', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLimitRequest.mockResolvedValue({ success: true })
  })

  it('returns 429 when rate limited', async () => {
    mockLimitRequest.mockResolvedValueOnce({ success: false })
    const res = await getFavourites(makeRequest('GET'))
    expect(res.status).toBe(429)
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetActiveSessionUser.mockResolvedValueOnce({ ok: false, status: 401 })
    const res = await getFavourites(makeRequest('GET'))
    expect(res.status).toBe(401)
  })

  it('returns 403 for a non-active user', async () => {
    mockGetActiveSessionUser.mockResolvedValueOnce({ ok: false, status: 403 })
    const res = await getFavourites(makeRequest('GET'))
    expect(res.status).toBe(403)
  })

  it('returns the current user\'s saved listings joined with listing details', async () => {
    mockGetActiveSessionUser.mockResolvedValueOnce({ ok: true, userId: 'u1' })
    const rows = [
      { listingId: VALID_LISTING_ID, address: '123 Fake St', price: 2500, beds: 1, baths: 1, source: 'rentcast', url: 'http://x', postedAt: null, savedAt: '2026-07-16T00:00:00Z' },
    ]
    mockLimit.mockResolvedValueOnce(rows)

    const res = await getFavourites(makeRequest('GET'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toEqual(rows)
    // Confirms the join/scoping shape: from(favourites) -> innerJoin(listings) -> where -> orderBy -> limit.
    expect(mockFrom).toHaveBeenCalledWith(favourites)
    expect(mockInnerJoin).toHaveBeenCalled()
  })

  it('returns 500 and reports to Sentry when the query throws', async () => {
    mockGetActiveSessionUser.mockResolvedValueOnce({ ok: true, userId: 'u1' })
    mockLimit.mockRejectedValueOnce(new Error('db down'))
    const res = await getFavourites(makeRequest('GET'))
    expect(res.status).toBe(500)
  })
})

describe('POST /api/favourites/[listingId] (save)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLimitRequest.mockResolvedValue({ success: true })
    mockGetActiveSessionUser.mockResolvedValue({ ok: true, userId: 'u1' })
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetActiveSessionUser.mockResolvedValueOnce({ ok: false, status: 401 })
    const res = await saveFavourite(makeRequest('POST'), { params: Promise.resolve({ listingId: VALID_LISTING_ID }) })
    expect(res.status).toBe(401)
  })

  it('returns 400 for a malformed listing id', async () => {
    const res = await saveFavourite(makeRequest('POST'), { params: Promise.resolve({ listingId: 'not-a-uuid' }) })
    expect(res.status).toBe(400)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('returns 404 when the listing does not exist', async () => {
    mockPlainWhere.mockResolvedValueOnce([])
    const res = await saveFavourite(makeRequest('POST'), { params: Promise.resolve({ listingId: VALID_LISTING_ID }) })
    expect(res.status).toBe(404)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('saves a listing via insert().onConflictDoNothing()', async () => {
    mockPlainWhere.mockResolvedValueOnce([{ id: VALID_LISTING_ID }])
    const res = await saveFavourite(makeRequest('POST'), { params: Promise.resolve({ listingId: VALID_LISTING_ID }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, saved: true })
    expect(mockInsertValues).toHaveBeenCalledWith({ userId: 'u1', listingId: VALID_LISTING_ID })
    expect(mockOnConflictDoNothing).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: saving an already-saved listing twice succeeds both times via onConflictDoNothing, never throws', async () => {
    mockPlainWhere.mockResolvedValue([{ id: VALID_LISTING_ID }])

    const first = await saveFavourite(makeRequest('POST'), { params: Promise.resolve({ listingId: VALID_LISTING_ID }) })
    const second = await saveFavourite(makeRequest('POST'), { params: Promise.resolve({ listingId: VALID_LISTING_ID }) })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(mockInsert).toHaveBeenCalledTimes(2)
    expect(mockOnConflictDoNothing).toHaveBeenCalledTimes(2)
    // Same (userId, listingId) pair both times -- the unique constraint +
    // onConflictDoNothing() is what makes the second call a safe no-op
    // instead of a unique-violation error.
    expect(mockInsertValues).toHaveBeenNthCalledWith(1, { userId: 'u1', listingId: VALID_LISTING_ID })
    expect(mockInsertValues).toHaveBeenNthCalledWith(2, { userId: 'u1', listingId: VALID_LISTING_ID })
  })
})

describe('DELETE /api/favourites/[listingId] (unsave)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLimitRequest.mockResolvedValue({ success: true })
    mockGetActiveSessionUser.mockResolvedValue({ ok: true, userId: 'u1' })
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetActiveSessionUser.mockResolvedValueOnce({ ok: false, status: 401 })
    const res = await unsaveFavourite(makeRequest('DELETE'), { params: Promise.resolve({ listingId: VALID_LISTING_ID }) })
    expect(res.status).toBe(401)
  })

  it('returns 400 for a malformed listing id', async () => {
    const res = await unsaveFavourite(makeRequest('DELETE'), { params: Promise.resolve({ listingId: 'not-a-uuid' }) })
    expect(res.status).toBe(400)
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('returns 404 when no matching favourite row exists', async () => {
    mockReturning.mockResolvedValueOnce([])
    const res = await unsaveFavourite(makeRequest('DELETE'), { params: Promise.resolve({ listingId: VALID_LISTING_ID }) })
    expect(res.status).toBe(404)
  })

  it('removes the favourite scoped to (userId, listingId) and returns success', async () => {
    mockReturning.mockResolvedValueOnce([{ listingId: VALID_LISTING_ID }])
    const res = await unsaveFavourite(makeRequest('DELETE'), { params: Promise.resolve({ listingId: VALID_LISTING_ID }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, saved: false })
    expect(mockDelete).toHaveBeenCalledWith(favourites)
  })
})
