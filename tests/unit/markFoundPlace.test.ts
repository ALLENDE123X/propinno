/**
 * The "I found a place (Cancel & stop texts)" server action.
 *
 * Under recurring billing this button is the ONLY self-serve way a subscriber
 * stops being charged, so these tests exist to pin the two properties that
 * actually protect the user's money:
 *   1. it calls Stripe to cancel, not just the DB, and
 *   2. it does NOT record 'done' if that cancellation failed — recording it
 *      would tell the user billing stopped while charges kept going.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const SUB_ID = 'sub_test_123'

const mockCancelStripeSubscription = vi.fn()
vi.mock('@/lib/billing', () => ({
  cancelStripeSubscription: (...args: unknown[]) => mockCancelStripeSubscription(...args),
}))

vi.mock('@/lib/stripe', () => ({ stripe: { checkout: { sessions: { create: vi.fn() } } } }))
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))
vi.mock('@/lib/ratelimit', () => ({ limitRequest: vi.fn().mockResolvedValue({ success: true }) }))

const mockCookieGet = vi.fn(() => ({ value: USER_ID }))
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => '127.0.0.1' }),
  cookies: async () => ({ get: (...args: unknown[]) => mockCookieGet(...(args as [])) }),
}))

const selectRows: unknown[][] = []
const updates: Record<string, unknown>[] = []

const mockSelectWhere = vi.fn(async () => selectRows.shift() ?? [])
const mockFrom = vi.fn(() => ({ where: mockSelectWhere }))
const mockSelect = vi.fn(() => ({ from: mockFrom }))
const mockUpdateWhere = vi.fn(async () => undefined)
const mockSet = vi.fn((values: Record<string, unknown>) => {
  updates.push(values)
  return { where: mockUpdateWhere }
})
const mockUpdate = vi.fn(() => ({ set: mockSet }))

vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...(args as [])),
    update: (...args: unknown[]) => mockUpdate(...(args as [])),
  },
}))

import { markFoundPlace } from '@/app/checkout/actions'

beforeEach(() => {
  vi.clearAllMocks()
  selectRows.length = 0
  updates.length = 0
  mockCookieGet.mockReturnValue({ value: USER_ID })
  mockCancelStripeSubscription.mockResolvedValue(undefined)
})

describe('markFoundPlace', () => {
  it('cancels the Stripe subscription AND marks the user done', async () => {
    selectRows.push([{ id: USER_ID, stripeSubscriptionId: SUB_ID }])

    await expect(markFoundPlace()).resolves.toEqual({ success: true })

    expect(mockCancelStripeSubscription).toHaveBeenCalledWith(SUB_ID)
    expect(updates).toEqual([{ status: 'done', stripeSubscriptionId: null }])
  })

  it('cancels at Stripe BEFORE writing "done" to the database', async () => {
    selectRows.push([{ id: USER_ID, stripeSubscriptionId: SUB_ID }])
    const order: string[] = []
    mockCancelStripeSubscription.mockImplementation(async () => { order.push('stripe') })
    mockSet.mockImplementation((values: Record<string, unknown>) => {
      order.push('db')
      updates.push(values)
      return { where: mockUpdateWhere }
    })

    await markFoundPlace()

    expect(order).toEqual(['stripe', 'db'])
  })

  it('does NOT mark the user done when the cancellation fails', async () => {
    selectRows.push([{ id: USER_ID, stripeSubscriptionId: SUB_ID }])
    mockCancelStripeSubscription.mockRejectedValue(new Error('Stripe is down'))

    await expect(markFoundPlace()).rejects.toThrow(/couldn't cancel your subscription/i)

    // Nothing written: the user stays active and billing is unchanged, so
    // retrying is a clean, consistent recovery rather than a half-applied state.
    expect(updates).toHaveLength(0)
  })

  it('still works for a user with no subscription on file', async () => {
    selectRows.push([{ id: USER_ID, stripeSubscriptionId: null }])

    await expect(markFoundPlace()).resolves.toEqual({ success: true })

    expect(mockCancelStripeSubscription).not.toHaveBeenCalled()
    expect(updates).toEqual([{ status: 'done', stripeSubscriptionId: null }])
  })

  it('rejects an unauthenticated caller without touching Stripe or the DB', async () => {
    mockCookieGet.mockReturnValue(undefined as unknown as { value: string })

    await expect(markFoundPlace()).rejects.toThrow()

    expect(mockCancelStripeSubscription).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })
})
