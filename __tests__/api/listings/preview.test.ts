import { describe, it, expect, vi } from 'vitest'
import { GET as previewRoute } from '@/app/api/listings/preview/route'

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue('127.0.0.1'),
  }),
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue({ value: '123e4567-e89b-12d3-a456-426614174000' }),
  }),
}))

vi.mock('@/lib/ratelimit', () => ({
  limitRequest: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}))

vi.mock('@/lib/db', () => {
  let callIdx = 0
  return {
    db: {
      select: vi.fn(() => {
        const idx = callIdx++
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            if (idx === 0) {
              return Promise.resolve([{ id: '123e4567-e89b-12d3-a456-426614174000' }])
            }
            if (idx === 1) {
              return Promise.resolve([{
                userId: '123e4567-e89b-12d3-a456-426614174000',
                priceMin: 2000, priceMax: 4000, bedsMin: 1, bedsMax: null,
              }])
            }
            return {
              limit: vi.fn().mockResolvedValue([{
                id: 'listing-uuid-1',
                address: '123 Main St, Mission, San Francisco, CA',
                price: 2800, beds: 1, baths: 1, source: 'rentcast', postedAt: null,
              }]),
            }
          }),
        }
      }),
    },
  }
})

describe('GET /api/listings/preview', () => {
  it('returns 429 when rate limited', async () => {
    const { limitRequest } = await import('@/lib/ratelimit')
    vi.mocked(limitRequest).mockResolvedValueOnce({ success: false, limit: 10, remaining: 0, reset: 0 })

    const req = new Request('http://localhost/api/listings/preview')
    const res = await previewRoute(req)
    expect(res.status).toBe(429)
    const data = await res.json()
    expect(data.error).toBe('Too many requests')
  })

  it('returns 401 when no session cookie', async () => {
    const { cookies } = await import('next/headers')
    vi.mocked(cookies).mockResolvedValueOnce({
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as Awaited<ReturnType<typeof cookies>>)

    const req = new Request('http://localhost/api/listings/preview')
    const res = await previewRoute(req)
    expect(res.status).toBe(401)
  })

  it('returns 401 for invalid UUID session', async () => {
    const { cookies } = await import('next/headers')
    vi.mocked(cookies).mockResolvedValueOnce({
      get: vi.fn().mockReturnValue({ value: 'not-a-uuid' }),
    } as unknown as Awaited<ReturnType<typeof cookies>>)

    const req = new Request('http://localhost/api/listings/preview')
    const res = await previewRoute(req)
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    const { cookies } = await import('next/headers')
    vi.mocked(cookies).mockImplementation(() => Promise.resolve({
      get: vi.fn().mockReturnValue({ value: '123e4567-e89b-12d3-a456-426614174000' }),
    } as unknown as Awaited<ReturnType<typeof cookies>>))

    const { db } = await import('@/lib/db')
    vi.mocked(db.select).mockImplementationOnce(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    }) as any)

    const req = new Request('http://localhost/api/listings/preview')
    const res = await previewRoute(req)
    if (res.status !== 404) {
      console.log('404 test failed. Response:', await res.clone().json())
    }
    expect(res.status).toBe(404)
  })

  it('returns 200 OK and masked listings on success', async () => {
    const { cookies } = await import('next/headers')
    vi.mocked(cookies).mockImplementation(() => Promise.resolve({
      get: vi.fn().mockReturnValue({ value: '123e4567-e89b-12d3-a456-426614174000' }),
    } as unknown as Awaited<ReturnType<typeof cookies>>))

    const { db } = await import('@/lib/db')
    // Mock user
    vi.mocked(db.select).mockImplementationOnce(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ id: '123e4567-e89b-12d3-a456-426614174000' }]),
    }) as any)
    // Mock criteria
    vi.mocked(db.select).mockImplementationOnce(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ userId: '123e4567-e89b-12d3-a456-426614174000', priceMin: 2000, priceMax: 4000 }]),
    }) as any)
    // Mock listings
    vi.mocked(db.select).mockImplementationOnce(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{
          id: 'listing-1',
          address: '123 Main St, Mission, San Francisco, CA',
          price: 2800,
          beds: 1,
          baths: 1,
          source: 'rentcast',
          postedAt: null,
        }]),
      }),
    }) as any)

    const req = new Request('http://localhost/api/listings/preview')
    const res = await previewRoute(req)
    if (res.status !== 200) {
      console.log('200 test failed. Response:', await res.clone().json())
    }
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.listings).toHaveLength(1)
    expect(data.listings[0].neighborhood).toBe('Mission, San Francisco, CA')
  })
})

describe('maskAddress utility logic', () => {
  function maskAddress(address: string): string {
    const withoutNumber = address.replace(/^\d+[A-Za-z]?\s+/, '')
    const parts = withoutNumber.split(',')
    if (parts.length >= 2) {
      return parts.slice(1).join(',').trim()
    }
    return withoutNumber
  }

  it('strips street number and returns neighborhood portion', () => {
    const result = maskAddress('123 Main St, Mission, San Francisco, CA')
    expect(result).toBe('Mission, San Francisco, CA')
    expect(result).not.toMatch(/\b123\b/)
  })

  it('handles address with letter suffix on street number', () => {
    const result = maskAddress('1A Market St, Downtown, San Francisco, CA')
    expect(result).toBe('Downtown, San Francisco, CA')
  })

  it('handles address with no comma gracefully', () => {
    const result = maskAddress('123 Market Street')
    expect(result).toBe('Market Street')
    expect(result).not.toContain('123')
  })

  it('handles address with no street number', () => {
    const result = maskAddress('Mission District, San Francisco, CA')
    expect(result).toBe('San Francisco, CA')
  })
})
