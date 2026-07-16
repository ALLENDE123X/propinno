import { describe, it, expect, vi, beforeEach } from 'vitest'
import { matchingEngine, getTodaysSentCount } from '@/inngest/functions/matchingEngine'
import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'

const mockExecute = vi.fn().mockResolvedValue([])
const mockFindMany = vi.fn().mockResolvedValue([])

vi.mock('@/lib/db', () => ({
  db: {
    execute: (...args: unknown[]) => mockExecute(...args),
    query: {
      listings: {
        findMany: (...args: unknown[]) => mockFindMany(...args)
      }
    }
  }
}))

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() }
}))

describe('Matching Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 0 if no listingIds provided', async () => {
    const result = await matchingEngine['fn']({ event: { data: { listingIds: [] } }, step: {} })
    expect(result).toEqual({ matched: 0 })
  })

  it('does not send event if findMany returns empty array', async () => {
    mockFindMany.mockResolvedValueOnce([])
    const mockStep = {
      run: vi.fn((name, fn) => fn()),
      sendEvent: vi.fn()
    }
    const result = await matchingEngine['fn']({ event: { data: { listingIds: ['123'] } }, step: mockStep })
    expect(result).toEqual({ matched: 0 })
    expect(mockStep.sendEvent).not.toHaveBeenCalled()
  })

  it('does not send event if execute returns empty array', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: '123', price: 3000, beds: 2 }])
    mockExecute.mockResolvedValueOnce([])
    const mockStep = {
      run: vi.fn((name, fn) => fn()),
      sendEvent: vi.fn()
    }
    const result = await matchingEngine['fn']({ event: { data: { listingIds: ['123'] } }, step: mockStep })
    expect(result).toEqual({ matched: 0 })
    expect(mockStep.sendEvent).not.toHaveBeenCalled()
  })

  it('fetches listings, finds matching users, and dispatches when under the daily cap', async () => {
    const listingId = '123'
    const userId = '456'

    mockFindMany.mockResolvedValueOnce([{
      id: listingId,
      price: 3000,
      beds: 2
    }])

    // First execute() call: findMatchingUsers - one match, cap of 20.
    mockExecute.mockResolvedValueOnce([
      { user_id: userId, max_daily_sms: 20 }
    ])
    // Second execute() call: getTodaysSentCount - 3 already sent today.
    mockExecute.mockResolvedValueOnce([{ count: 3 }])

    const mockStep = {
      run: vi.fn((name, fn) => fn()),
      sendEvent: vi.fn().mockResolvedValue(undefined)
    }

    const result = await matchingEngine['fn']({
      event: { data: { listingIds: [listingId] } },
      step: mockStep
    })

    expect(result).toEqual({ matched: 1 })
    expect(mockStep.sendEvent).toHaveBeenCalledWith('enqueue-notifications', [
      { name: 'app/notification.send', data: { userId, listingId } }
    ])
  })

  it('skips dispatch for a user who is already at their daily SMS cap', async () => {
    const listingId = '123'
    const userId = '456'

    mockFindMany.mockResolvedValueOnce([{ id: listingId, price: 3000, beds: 2 }])
    mockExecute.mockResolvedValueOnce([{ user_id: userId, max_daily_sms: 5 }])
    // Already sent 5 today - at the cap, not just over it.
    mockExecute.mockResolvedValueOnce([{ count: 5 }])

    const mockStep = {
      run: vi.fn((name, fn) => fn()),
      sendEvent: vi.fn()
    }

    const result = await matchingEngine['fn']({
      event: { data: { listingIds: [listingId] } },
      step: mockStep
    })

    expect(result).toEqual({ matched: 0 })
    expect(mockStep.sendEvent).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ userId, listingId, sentToday: 5, maxDailySms: 5 }),
      'Daily SMS cap reached, skipping dispatch'
    )
  })

  it('dispatches a user up to their cap across multiple matching listings in one run, then stops', async () => {
    const userId = '456'

    // Two listings both match the same user in this run.
    mockFindMany.mockResolvedValueOnce([
      { id: 'listing-a', price: 3000, beds: 2 },
      { id: 'listing-b', price: 3100, beds: 2 }
    ])

    // findMatchingUsers for listing-a
    mockExecute.mockResolvedValueOnce([{ user_id: userId, max_daily_sms: 2 }])
    // getTodaysSentCount for userId - 1 already sent today (only queried once,
    // then tracked in-memory for the rest of this run).
    mockExecute.mockResolvedValueOnce([{ count: 1 }])
    // findMatchingUsers for listing-b - same user matches again.
    mockExecute.mockResolvedValueOnce([{ user_id: userId, max_daily_sms: 2 }])

    const mockStep = {
      run: vi.fn((name, fn) => fn()),
      sendEvent: vi.fn().mockResolvedValue(undefined)
    }

    const result = await matchingEngine['fn']({
      event: { data: { listingIds: ['listing-a', 'listing-b'] } },
      step: mockStep
    })

    // listing-a dispatch brings the in-run tally to 2 (cap), so listing-b is
    // skipped without a third getTodaysSentCount query.
    expect(result).toEqual({ matched: 1 })
    expect(mockExecute).toHaveBeenCalledTimes(3)
    expect(mockStep.sendEvent).toHaveBeenCalledWith('enqueue-notifications', [
      { name: 'app/notification.send', data: { userId, listingId: 'listing-a' } }
    ])
  })

  it('handles and logs errors properly', async () => {
    const error = new Error('Test error')
    mockFindMany.mockRejectedValueOnce(error)

    const mockStep = {
      run: vi.fn((name, fn) => fn()),
    }

    await expect(matchingEngine['fn']({
      event: { data: { listingIds: ['123'] } },
      step: mockStep
    })).rejects.toThrow('Test error')

    expect(Sentry.captureException).toHaveBeenCalledWith(error)
    expect(logger.error).toHaveBeenCalledWith({ err: error, listingIds: ['123'] }, 'Matching engine failed')
  })
})

describe('getTodaysSentCount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the count from the query result', async () => {
    mockExecute.mockResolvedValueOnce([{ count: 7 }])
    const count = await getTodaysSentCount('user-1', new Date('2026-07-16T20:00:00Z'))
    expect(count).toBe(7)
  })

  it('defaults to 0 when the query returns no rows', async () => {
    mockExecute.mockResolvedValueOnce([])
    const count = await getTodaysSentCount('user-1', new Date('2026-07-16T20:00:00Z'))
    expect(count).toBe(0)
  })
})
