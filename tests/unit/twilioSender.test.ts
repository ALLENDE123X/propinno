import { describe, it, expect, vi, beforeEach } from 'vitest'
import { twilioSender, getTwilioClient, buildListingSmsBody } from '@/inngest/functions/twilioSender'
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
vi.mock('@/lib/pollerBudget', () => ({
  claimDailyBudget: vi.fn().mockResolvedValue(true)
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
// every step.run just executes its callback (so the real claimDailyBudget
// mock above decides the budget-check result), except when a test overrides
// the daily-budget step to simulate it being exhausted.
function makeMockStep(overrides: { smsBudget?: boolean } = {}) {
  return {
    run: vi.fn((name: string, fn: () => unknown) => {
      if (name === 'check-sms-daily-budget' && overrides.smsBudget !== undefined) {
        return Promise.resolve(overrides.smsBudget)
      }
      return fn()
    }),
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
      body: '123 Fake St - $2500 - 1 bd\nhttp://example.com',
      from: '+1234567890',
      to: '+1987654321'
    })
    expect(mockInsert).toHaveBeenCalledWith(sent)
    expect(mockInsertValues).toHaveBeenCalledWith({ userId: 'u1', listingId: 'l1' })

    vi.useRealTimers()
  })

  it('AH-028: threads listing baths/pets/laundry through into the actual Twilio call body', async () => {
    mockSentFindFirst.mockResolvedValueOnce(null)
    mockUserFindFirst.mockResolvedValueOnce(ACTIVE_USER)
    mockListingFindFirst.mockResolvedValueOnce({
      ...LISTING,
      baths: 1.5,
      petsAllowed: 'cats_and_dogs',
      laundryType: 'in_unit',
    })

    const mockStep = makeMockStep()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T20:00:00Z'))

    const result = await twilioSender['fn']({ event: { data: { userId: 'u1', listingId: 'l1' } }, step: mockStep })

    expect(result).toEqual({ sent: true })
    expect(mockTwilioCreate).toHaveBeenCalledWith({
      body: '123 Fake St - $2500 - 1 bd\n1.5 ba - Cats+dogs OK - in-unit laundry\nhttp://example.com',
      from: '+1234567890',
      to: '+1987654321'
    })

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

  it('skips sending and does not record to sent when the daily SMS budget is exceeded', async () => {
    mockSentFindFirst.mockResolvedValueOnce(null)
    mockUserFindFirst.mockResolvedValueOnce(ACTIVE_USER)
    mockListingFindFirst.mockResolvedValueOnce(LISTING)

    const mockStep = makeMockStep({ smsBudget: false })
    // 2026-07-16T20:00:00Z = 13:00 PDT, outside quiet hours - isolates the
    // budget check from the quiet-hours path.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T20:00:00Z'))

    const result = await twilioSender['fn']({ event: { data: { userId: 'u1', listingId: 'l1' } }, step: mockStep })

    expect(result).toEqual({ sent: false, reason: 'daily_budget_exceeded' })
    expect(mockTwilioCreate).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()

    vi.useRealTimers()
  })
})

describe('getTwilioClient', () => {
  it('returns a client with a messages.create method', () => {
    expect(typeof getTwilioClient().messages.create).toBe('function')
  })
})

// AH-028: baths/pets/laundry summary line. Tested as a pure function
// directly (no DB/Twilio mocking needed) covering every present/absent
// combination the ticket asked for, plus the null-passthrough convention
// (omit rather than show "unknown") this codebase uses everywhere else for
// these same fields (matchingEngine.ts's pets/laundry filters, AH-018).
describe('buildListingSmsBody', () => {
  const BASE = {
    address: '123 Fake St',
    price: 2500,
    beds: 1,
    baths: null,
    petsAllowed: null,
    laundryType: null,
    url: 'http://example.com',
  }

  it('omits the details line entirely when baths/pets/laundry are all absent', () => {
    expect(buildListingSmsBody(BASE)).toBe('123 Fake St - $2500 - 1 bd\nhttp://example.com')
  })

  it('adds a details line with just baths when only baths is present', () => {
    expect(buildListingSmsBody({ ...BASE, baths: 1.5 })).toBe(
      '123 Fake St - $2500 - 1 bd\n1.5 ba\nhttp://example.com'
    )
  })

  it('adds a details line with just a pets summary when only pets is present', () => {
    expect(buildListingSmsBody({ ...BASE, petsAllowed: 'cats_and_dogs' })).toBe(
      '123 Fake St - $2500 - 1 bd\nCats+dogs OK\nhttp://example.com'
    )
  })

  it('adds a details line with just a laundry summary when only laundry is present', () => {
    expect(buildListingSmsBody({ ...BASE, laundryType: 'in_unit' })).toBe(
      '123 Fake St - $2500 - 1 bd\nin-unit laundry\nhttp://example.com'
    )
  })

  it('combines baths + pets + laundry into a single compact line when all are present', () => {
    expect(
      buildListingSmsBody({ ...BASE, baths: 2, petsAllowed: 'dogs', laundryType: 'on_site' })
    ).toBe('123 Fake St - $2500 - 1 bd\n2 ba - Dogs OK - on-site laundry\nhttp://example.com')
  })

  it('renders a genuine 0 baths (falsy but real) rather than treating it as absent', () => {
    expect(buildListingSmsBody({ ...BASE, baths: 0 })).toBe(
      '123 Fake St - $2500 - 1 bd\n0 ba\nhttp://example.com'
    )
  })

  it('renders "No pets" when the listing explicitly has no pets allowed (a real value, not null)', () => {
    expect(buildListingSmsBody({ ...BASE, petsAllowed: 'no' })).toBe(
      '123 Fake St - $2500 - 1 bd\nNo pets\nhttp://example.com'
    )
  })

  it('renders laundry hookups distinctly from in-unit/on-site laundry', () => {
    expect(buildListingSmsBody({ ...BASE, laundryType: 'hookups' })).toBe(
      '123 Fake St - $2500 - 1 bd\nlaundry hookups\nhttp://example.com'
    )
  })
})
