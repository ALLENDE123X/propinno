/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'
import { GET as inboxRoute } from '@/app/api/inbox/route'

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
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([
        {
          listingId: 'listing-1',
          address: '123 Main St, Mission, San Francisco, CA',
          price: 2800,
          beds: 1,
          baths: 1,
          source: 'rentcast',
          url: 'https://example.com/listing-1',
          postedAt: null,
          sentAt: new Date().toISOString(),
          readAt: null,
        },
        {
          listingId: 'listing-2',
          address: '456 Oak St, Noe Valley, San Francisco, CA',
          price: 3200,
          beds: 2,
          baths: 1,
          source: 'craigslist',
          url: null,
          postedAt: null,
          sentAt: new Date().toISOString(),
          readAt: new Date().toISOString(),
        },
      ]),
    })),
  },
}))

describe('GET /api/inbox', () => {
  it('returns 429 when rate limited', async () => {
    const { limitRequest } = await import('@/lib/ratelimit')
    vi.mocked(limitRequest).mockResolvedValueOnce({ success: false, limit: 10, remaining: 0, reset: 0 })

    const req = new Request('http://localhost/api/inbox')
    const res = await inboxRoute(req)
    expect(res.status).toBe(429)
  })

  it('returns the session-error status/body when not an active user', async () => {
    const { getActiveSessionUser } = await import('@/lib/session')
    vi.mocked(getActiveSessionUser).mockResolvedValueOnce({ ok: false, status: 403 } as any)

    const req = new Request('http://localhost/api/inbox')
    const res = await inboxRoute(req)
    expect(res.status).toBe(403)
    const data = await res.json()
    expect(data.error).toBe('Access pass required')
  })

  it('returns joined items and a correct unread count', async () => {
    const req = new Request('http://localhost/api/inbox')
    const res = await inboxRoute(req)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.items).toHaveLength(2)
    expect(data.unreadCount).toBe(1)
    expect(data.items[0].listingId).toBe('listing-1')
  })
})
