/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'
import { PATCH as updateRoute } from '@/app/api/inbox/[listingId]/route'

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

vi.mock('@/lib/db', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ listingId: VALID_LISTING_ID }]),
    })),
  },
}))

function makeRequest(body: unknown) {
  return new Request(`http://localhost/api/inbox/${VALID_LISTING_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/inbox/[listingId]', () => {
  it('returns 429 when rate limited', async () => {
    const { limitRequest } = await import('@/lib/ratelimit')
    vi.mocked(limitRequest).mockResolvedValueOnce({ success: false, limit: 10, remaining: 0, reset: 0 })

    const res = await updateRoute(makeRequest({ action: 'read' }), { params: Promise.resolve({ listingId: VALID_LISTING_ID }) })
    expect(res.status).toBe(429)
  })

  it('returns the session-error status when unauthenticated', async () => {
    const { getActiveSessionUser } = await import('@/lib/session')
    vi.mocked(getActiveSessionUser).mockResolvedValueOnce({ ok: false, status: 401 } as any)

    const res = await updateRoute(makeRequest({ action: 'read' }), { params: Promise.resolve({ listingId: VALID_LISTING_ID }) })
    expect(res.status).toBe(401)
  })

  it('returns 400 for a non-UUID listingId', async () => {
    const res = await updateRoute(makeRequest({ action: 'read' }), { params: Promise.resolve({ listingId: 'not-a-uuid' }) })
    expect(res.status).toBe(400)
  })

  it('returns 400 for an invalid action', async () => {
    const res = await updateRoute(makeRequest({ action: 'archive' }), { params: Promise.resolve({ listingId: VALID_LISTING_ID }) })
    expect(res.status).toBe(400)
  })

  it('returns 404 when no matching sent row exists for this user', async () => {
    const { db } = await import('@/lib/db')
    vi.mocked(db.update).mockImplementationOnce(() => ({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    }) as any)

    const res = await updateRoute(makeRequest({ action: 'read' }), { params: Promise.resolve({ listingId: VALID_LISTING_ID }) })
    expect(res.status).toBe(404)
  })

  it('marks an item as read', async () => {
    const res = await updateRoute(makeRequest({ action: 'read' }), { params: Promise.resolve({ listingId: VALID_LISTING_ID }) })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.success).toBe(true)
  })

  it('dismisses an item', async () => {
    const res = await updateRoute(makeRequest({ action: 'dismiss' }), { params: Promise.resolve({ listingId: VALID_LISTING_ID }) })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.success).toBe(true)
  })
})
