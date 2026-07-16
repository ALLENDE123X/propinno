import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchRentcastListings, upsertListings, rentcastPoller } from '@/inngest/functions/rentcastPoller'
import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'

const mockReturning = vi.fn().mockResolvedValue([{ id: '1', isCanonical: true }])
const mockOnConflictDoUpdate = vi.fn().mockReturnValue({ returning: mockReturning })
const mockValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate })
const mockInsert = vi.fn().mockReturnValue({ values: mockValues })

vi.mock('@/lib/db', () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    execute: vi.fn().mockResolvedValue([])
  }
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn()
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

const mockFetch = vi.fn()
global.fetch = mockFetch

describe('RentCast Poller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RENTCAST_API_KEY = 'test_key'
  })

  describe('fetchRentcastListings', () => {
    it('throws if API key is missing', async () => {
      delete process.env.RENTCAST_API_KEY
      await expect(fetchRentcastListings()).rejects.toThrow('RENTCAST_API_KEY is not set')
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: vi.fn().mockResolvedValue('Unauthorized')
      })
      await expect(fetchRentcastListings()).rejects.toThrow('RentCast API returned 401: Unauthorized')
    })

    it('returns parsed json on success', async () => {
      const mockData = [{ id: '123' }]
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(mockData)
      })
      const data = await fetchRentcastListings()
      expect(data).toEqual(mockData)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('api.rentcast.io'),
        expect.objectContaining({ headers: expect.objectContaining({ 'X-Api-Key': 'test_key' }) })
      )
    })
  })

  describe('upsertListings', () => {
    it('returns { count: 0, canonicalIds: [] } if data is empty', async () => {
      expect(await upsertListings([])).toEqual({ count: 0, canonicalIds: [] })
    })

    it('upserts mapped data correctly', async () => {
      const data = [
        {
          id: '1',
          formattedAddress: '123 Main St',
          city: 'San Francisco',
          state: 'CA',
          zipCode: '94105',
          latitude: 37,
          longitude: -122,
          price: 3000,
          bedrooms: 2,
          bathrooms: 1,
          squareFootage: 1000,
          listedDate: '2023-01-01T00:00:00.000Z'
        }
      ]

      await upsertListings(data)

      expect(mockInsert).toHaveBeenCalledTimes(1)
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'rentcast',
          sourceId: '1',
          address: '123 Main St',
          lat: 37,
          lng: -122,
          price: 3000,
          beds: 2,
          baths: 1,
          sqft: 1000,
          url: null,
          postedAt: new Date('2023-01-01T00:00:00.000Z'),
          raw: data[0]
        })
      )
      expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1)
    })
  })

  describe('rentcastPoller handler', () => {
    it('dispatches trigger-matching event when canonicalIds are returned', async () => {
      const mockStep = {
        run: vi.fn().mockImplementation((name, fn) => {
          if (name === 'check-daily-budget') return Promise.resolve(true)
          if (name === 'fetch-rentcast') return Promise.resolve([{}])
          if (name === 'upsert-listings') return Promise.resolve({ count: 1, canonicalIds: ['1'] })
          return fn()
        }),
        sendEvent: vi.fn().mockResolvedValue(undefined)
      }

      const result = await rentcastPoller['fn']({ step: mockStep })
      expect(result).toEqual({ fetched: 1, upserted: 1 })
      expect(mockStep.sendEvent).toHaveBeenCalledWith('trigger-matching', {
        name: 'app/listings.upserted',
        data: { listingIds: ['1'] }
      })
    })

    it('skips sendEvent when no canonicalIds are returned', async () => {
      const mockStep = {
        run: vi.fn().mockImplementation((name, fn) => {
          if (name === 'check-daily-budget') return Promise.resolve(true)
          if (name === 'fetch-rentcast') return Promise.resolve([{}])
          if (name === 'upsert-listings') return Promise.resolve({ count: 1, canonicalIds: [] })
          return fn()
        }),
        sendEvent: vi.fn()
      }

      const result = await rentcastPoller['fn']({ step: mockStep })
      expect(result).toEqual({ fetched: 1, upserted: 1 })
      expect(mockStep.sendEvent).not.toHaveBeenCalled()
    })

    it('catches and logs errors properly', async () => {
      const error = new Error('Test run error')
      const mockStep = {
        run: vi.fn().mockImplementation((name: string) => {
          if (name === 'check-daily-budget') return Promise.resolve(true)
          return Promise.reject(error)
        })
      }

      await expect(rentcastPoller['fn']({ step: mockStep })).rejects.toThrow('Test run error')
      expect(Sentry.captureException).toHaveBeenCalledWith(error)
      expect(logger.error).toHaveBeenCalledWith({ err: error }, 'RentCast poller failed')
    })
  })
})
