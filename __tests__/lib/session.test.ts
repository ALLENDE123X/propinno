/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'
import { getActiveSessionUser, sessionErrorResponse } from '@/lib/session'

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue(undefined),
  }),
}))

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    })),
  },
}))

describe('getActiveSessionUser', () => {
  it('returns 401 when there is no session cookie', async () => {
    const result = await getActiveSessionUser()
    expect(result).toEqual({ ok: false, status: 401 })
  })

  it('returns 401 for a non-UUID session value', async () => {
    const { cookies } = await import('next/headers')
    vi.mocked(cookies).mockResolvedValueOnce({
      get: vi.fn().mockReturnValue({ value: 'not-a-uuid' }),
    } as unknown as Awaited<ReturnType<typeof cookies>>)

    const result = await getActiveSessionUser()
    expect(result).toEqual({ ok: false, status: 401 })
  })

  it('returns 401 when the session user does not exist', async () => {
    const { cookies } = await import('next/headers')
    vi.mocked(cookies).mockResolvedValueOnce({
      get: vi.fn().mockReturnValue({ value: '123e4567-e89b-12d3-a456-426614174000' }),
    } as unknown as Awaited<ReturnType<typeof cookies>>)

    const { db } = await import('@/lib/db')
    vi.mocked(db.select).mockImplementationOnce(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    }) as any)

    const result = await getActiveSessionUser()
    expect(result).toEqual({ ok: false, status: 401 })
  })

  it('returns 403 when the user exists but is not active', async () => {
    const { cookies } = await import('next/headers')
    vi.mocked(cookies).mockResolvedValueOnce({
      get: vi.fn().mockReturnValue({ value: '123e4567-e89b-12d3-a456-426614174000' }),
    } as unknown as Awaited<ReturnType<typeof cookies>>)

    const { db } = await import('@/lib/db')
    vi.mocked(db.select).mockImplementationOnce(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ status: 'expired' }]),
    }) as any)

    const result = await getActiveSessionUser()
    expect(result).toEqual({ ok: false, status: 403 })
  })

  it('returns ok with the userId when the user is active', async () => {
    const { cookies } = await import('next/headers')
    vi.mocked(cookies).mockResolvedValueOnce({
      get: vi.fn().mockReturnValue({ value: '123e4567-e89b-12d3-a456-426614174000' }),
    } as unknown as Awaited<ReturnType<typeof cookies>>)

    const { db } = await import('@/lib/db')
    vi.mocked(db.select).mockImplementationOnce(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ status: 'active' }]),
    }) as any)

    const result = await getActiveSessionUser()
    expect(result).toEqual({ ok: true, userId: '123e4567-e89b-12d3-a456-426614174000' })
  })
})

describe('sessionErrorResponse', () => {
  it('maps 401 to Unauthorized', () => {
    expect(sessionErrorResponse(401)).toEqual({ error: 'Unauthorized', status: 401 })
  })

  it('maps 403 to Access pass required', () => {
    expect(sessionErrorResponse(403)).toEqual({ error: 'Access pass required', status: 403 })
  })
})
