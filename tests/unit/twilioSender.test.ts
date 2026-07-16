import { describe, it, expect, vi, beforeEach } from 'vitest'
import { twilioSender, getTwilioClient } from '@/inngest/functions/twilioSender'
import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'
import { sent } from '@/lib/db/schema'

const mockSentFindFirst = vi.fn()
const mockUserFindFirst = vi.fn()
const mockListingFindFirst = vi.fn()
const mockInsertValues = vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn() })
const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues })
const mockSelectWhere = vi.fn()
const mockSelectFrom = vi.fn().mockReturnValue({ where: (...args: unknown[]) => mockSelectWhere(...args) })
const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom })

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      sent: { findFirst: (...args: unknown[]) => mockSentFindFirst(...args) },
      users: { findFirst: (...args: unknown[]) => mockUserFindFirst(...args) },
      listings: { findFirst: (...args: unknown[]) => mockListingFindFirst(...args) }
    },
    insert: (...args: unknown[]) => mockInsert(...args),
    select: (...args: unknown[]) => mockSelect(...args)
  }
}))

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}))

const mockTwilioCreate = vi.fn().mockResolvedValue({})
vi.mock('twilio', () => ({
  default: () => ({
    messages: {
      create: mockTwilioCreate
    }
  })
}))

// A step.run mock that also records step.sleepUntil calls, matching how
// tests/unit/rentcastPoller.test.ts switches step.run behavior by name -
// here every step.run just executes its callback since twilioSender's step
// names aren't branched on by the caller, but sleepUntil needs its own spy.
function makeMockStep() {
  return {
    run: vi.fn((_name: string, fn: () => unknown) => fn()),
    sleepUntil: vi.fn().mockResolvedValue(undefined)
  }
}

const ACTIVE_USER = { id: 'u1', phone: '+1987654321', notificationsPaused: false, quietStart: '21:00:00', quietEnd: '08:00:00' }
const LISTING = { id: 'l1', price: 2500, beds: 1, address: '123 Fake St', url: 'http://example.com' }

describe('Twilio Sender Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    process.env.TWILIO_FROM = '+1234567890'
    mockInsertValues.mockReturnValue({ onConflictDoNothing: vi.fn() })
    mockInsert.mockReturnValue({ values: mockInsertValues })
    mockSelectFrom.mockReturnValue({ where: (...args: unknown[]) => mockSelectWhere(...args) })
    mockSelect.mockReturnValue({ from: mockSelectFrom })
  })

  it('skips if already sent', async () => {
    mockSentFindFirst.mockResolvedValueOnce({ userId: 'u1', listingId: 'l1' })

    const mockStep = makeMockStep()
    const result = await twilioSender['fn']({ event: { data: { userId: 'u1', listingId: 'l1' } }, step: mockStep })

    expect(result).toEqual({ sent: false, reason: 'already_sent' })
    expect(mockTwilioCreate).not.toHaveBeenCalled()
  })

  it('fails if user not found', async () => {
    mockSentFindFirst.mockResolvedValueOnce(null)
    mockUserFindFirst.mockResolvedValueOnce(null)
    mockListingFindFirst.mockResolvedValueOnce({ id: 'l1' })

    const mockStep = makeMockStep()
    const result = await twilioSender['fn']({ event: { data: { userId: 'u1', listingId: 'l1' } }, step: mockStep })

    expect(result).toEqual({ sent: false, reason: 'missing_data' })
  })

  it('sends SMS immediately and records to db when outside quiet hours', async () => {
    mockSentFindFirst.mockResolvedValueOnce(null)
    mockUserFindFirst.mockResolvedValueOnce(ACTIVE_USER)
    mockListingFindFirst.mockResolvedValueOnce(LISTING)

    const mockStep = makeMockStep()
    // 2026-07-16T20:00:00Z = 13:00 PDT, well outside a 21:00-08:00 window.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T20:00:00Z'))

    const result = await twilioSender['fn']({ event: { data: { userId: 'u1', listingId: 'l1' } }, step: mockStep })

    expect(result).toEqual({ sent: true })
    expect(mockStep.sleepUntil).not.toHaveBeenCalled()
    expect(mockTwilioCreate).toHaveBeenCalledWith({
      body: '123 Fake St · $2500 · 1 bd\nhttp://example.com',
      from: '+1234567890',
      to: '+1987654321'
    })
    expect(mockInsert).toHaveBeenCalledWith(sent)
    expect(mockInsertValues).toHaveBeenCalledWith({ userId: 'u1', listingId: 'l1' })

    vi.useRealTimers()
  })

  it('skips immediately without sleeping if notifications are paused', async () => {
    mockSentFindFirst.mockResolvedValueOnce(null)
    mockUserFindFirst.mockResolvedValueOnce({ ...ACTIVE_USER, notificationsPaused: true })
    mockListingFindFirst.mockResolvedValueOnce(LISTING)

    const mockStep = makeMockStep()
    const result = await twilioSender['fn']({ event: { data: { userId: 'u1', listingId: 'l1' } }, step: mockStep })

    expect(result).toEqual({ sent: false, reason: 'paused' })
    expect(mockStep.sleepUntil).not.toHaveBeenCalled()
    expect(mockTwilioCreate).not.toHaveBeenCalled()
  })

  it('delays until quiet_end via step.sleepUntil when within quiet hours, then sends', async () => {
    mockSentFindFirst.mockResolvedValueOnce(null)
    mockUserFindFirst.mockResolvedValueOnce(ACTIVE_USER)
    mockListingFindFirst.mockResolvedValueOnce(LISTING)
    // Post-wait pause re-check: still not paused.
    mockSelectWhere.mockResolvedValueOnce([{ notificationsPaused: false }])

    const mockStep = makeMockStep()
    // 2026-07-17T04:00:00Z = 2026-07-16 21:00 PDT, right at quiet_start.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T04:00:00Z'))

    const result = await twilioSender['fn']({ event: { data: { userId: 'u1', listingId: 'l1' } }, step: mockStep })

    expect(mockStep.sleepUntil).toHaveBeenCalledWith('wait-for-quiet-hours-end', '2026-07-17T15:00:00.000Z')
    expect(result).toEqual({ sent: true })
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it('re-checks pause after the quiet-hours wait and skips if paused in the meantime', async () => {
    mockSentFindFirst.mockResolvedValueOnce(null)
    mockUserFindFirst.mockResolvedValueOnce(ACTIVE_USER)
    mockListingFindFirst.mockResolvedValueOnce(LISTING)
    // User paused notifications sometime during the sleep.
    mockSelectWhere.mockResolvedValueOnce([{ notificationsPaused: true }])

    const mockStep = makeMockStep()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T04:00:00Z'))

    const result = await twilioSender['fn']({ event: { data: { userId: 'u1', listingId: 'l1' } }, step: mockStep })

    expect(mockStep.sleepUntil).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ sent: false, reason: 'paused' })
    expect(mockTwilioCreate).not.toHaveBeenCalled()

    vi.useRealTimers()
  })

  it('handles and logs errors properly', async () => {
    const error = new Error('Test error')
    mockSentFindFirst.mockRejectedValueOnce(error)

    const mockStep = makeMockStep()

    await expect(twilioSender['fn']({
      event: { data: { userId: 'u1', listingId: 'l1' } },
      step: mockStep
    })).rejects.toThrow('Test error')

    expect(Sentry.captureException).toHaveBeenCalledWith(error)
    expect(logger.error).toHaveBeenCalledWith({ err: error, data: { userId: 'u1', listingId: 'l1' } }, 'Twilio sender failed')
  })
})

describe('getTwilioClient', () => {
  it('returns a client with a messages.create method', () => {
    expect(typeof getTwilioClient().messages.create).toBe('function')
  })
})
