import { describe, it, expect, vi, beforeEach } from 'vitest'
import { matchingEngine } from '@/inngest/functions/matchingEngine'
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

  it('fetches listings and finds matching users', async () => {
    const listingId = '123'
    const userId = '456'

    mockFindMany.mockResolvedValueOnce([{
      id: listingId,
      price: 3000,
      beds: 2
    }])

    mockExecute.mockResolvedValueOnce([
      { user_id: userId }
    ])

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
