/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'
import { GET as unreadCountRoute } from '@/app/api/inbox/unread-count/route'

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
      where: vi.fn().mockResolvedValue([{ count: 4 }]),
    })),
  },
}))

describe('GET /api/inbox/unread-count', () => {
  it('returns 429 when rate limited', async () => {
    const { limitRequest } = await import('@/lib/ratelimit')
    vi.mocked(limitRequest).mockResolvedValueOnce({ success: false, limit: 10, remaining: 0, reset: 0 })

    const req = new Request('http://localhost/api/inbox/unread-count')
    const res = await unreadCountRoute(req)
    expect(res.status).toBe(429)
  })

  it('returns 401 when unauthenticated', async () => {
    const { getActiveSessionUser } = await import('@/lib/session')
    vi.mocked(getActiveSessionUser).mockResolvedValueOnce({ ok: false, status: 401 } as any)

    const req = new Request('http://localhost/api/inbox/unread-count')
    const res = await unreadCountRoute(req)
    expect(res.status).toBe(401)
  })

  it('returns the unread count on success', async () => {
    const req = new Request('http://localhost/api/inbox/unread-count')
    const res = await unreadCountRoute(req)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.count).toBe(4)
  })

  it('falls back to 0 when no row is returned', async () => {
    const { db } = await import('@/lib/db')
    vi.mocked(db.select).mockImplementationOnce(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    }) as any)

    const req = new Request('http://localhost/api/inbox/unread-count')
    const res = await unreadCountRoute(req)
    const data = await res.json()
    expect(data.count).toBe(0)
  })
})
