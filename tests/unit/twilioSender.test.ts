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

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      sent: { findFirst: (...args: unknown[]) => mockSentFindFirst(...args) },
      users: { findFirst: (...args: unknown[]) => mockUserFindFirst(...args) },
      listings: { findFirst: (...args: unknown[]) => mockListingFindFirst(...args) }
    },
    insert: (...args: unknown[]) => mockInsert(...args)
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

describe('Twilio Sender Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.TWILIO_FROM = '+1234567890'
  })

  it('skips if already sent', async () => {
    mockSentFindFirst.mockResolvedValueOnce({ userId: 'u1', listingId: 'l1' })
    
    const mockStep = { run: vi.fn((name, fn) => fn()) }
    const result = await twilioSender['fn']({ event: { data: { userId: 'u1', listingId: 'l1' } }, step: mockStep })

    expect(result).toEqual({ sent: false, reason: 'already_sent' })
    expect(mockTwilioCreate).not.toHaveBeenCalled()
  })

  it('fails if user not found', async () => {
    mockSentFindFirst.mockResolvedValueOnce(null)
    mockUserFindFirst.mockResolvedValueOnce(null)
    mockListingFindFirst.mockResolvedValueOnce({ id: 'l1' })
    
    const mockStep = { run: vi.fn((name, fn) => fn()) }
    const result = await twilioSender['fn']({ event: { data: { userId: 'u1', listingId: 'l1' } }, step: mockStep })

    expect(result).toEqual({ sent: false, reason: 'missing_data' })
  })

  it('sends SMS and records to db', async () => {
    mockSentFindFirst.mockResolvedValueOnce(null)
    mockUserFindFirst.mockResolvedValueOnce({ id: 'u1', phone: '+1987654321' })
    mockListingFindFirst.mockResolvedValueOnce({ 
      id: 'l1', 
      price: 2500, 
      beds: 1, 
      address: '123 Fake St', 
      url: 'http://example.com' 
    })
    
    const mockStep = { run: vi.fn((name, fn) => fn()) }
    const result = await twilioSender['fn']({ event: { data: { userId: 'u1', listingId: 'l1' } }, step: mockStep })

    expect(result).toEqual({ sent: true })
    expect(mockTwilioCreate).toHaveBeenCalledWith({
      body: '123 Fake St · $2500 · 1 bd\nhttp://example.com',
      from: '+1234567890',
      to: '+1987654321'
    })
    expect(mockInsert).toHaveBeenCalledWith(sent)
    expect(mockInsertValues).toHaveBeenCalledWith({ userId: 'u1', listingId: 'l1' })
  })

  it('handles and logs errors properly', async () => {
    const error = new Error('Test error')
    mockSentFindFirst.mockRejectedValueOnce(error)
    
    const mockStep = { run: vi.fn((name, fn) => fn()) }

    await expect(twilioSender['fn']({ 
      event: { data: { userId: 'u1', listingId: 'l1' } }, 
      step: mockStep 
    })).rejects.toThrow('Test error')

    expect(Sentry.captureException).toHaveBeenCalledWith(error)
    expect(logger.error).toHaveBeenCalledWith({ err: error, data: { userId: 'u1', listingId: 'l1' } }, 'Twilio sender failed')
  })
})
