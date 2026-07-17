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

    it('maps images to [] for a real-shaped RentCast item (no image data in this endpoint - confirmed 2026-07-17 against 895 live rows + a fresh live API call)', async () => {
      const data = [
        {
          id: '4',
          formattedAddress: '264 Guerrero St',
          city: 'San Francisco',
          state: 'CA',
          zipCode: '94103',
          latitude: 37.77,
          longitude: -122.42,
          price: 7400,
          bedrooms: 2,
          bathrooms: 1,
          squareFootage: 1464
        }
      ]

      await upsertListings(data)

      expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ images: [] }))
    })

    it('AH-018: maps petsAllowed/laundryType to null for a real-shaped RentCast item (no pet/laundry data in this endpoint)', async () => {
      const data = [
        {
          id: '2',
          formattedAddress: '270 Turk St',
          city: 'San Francisco',
          state: 'CA',
          zipCode: '94102',
          latitude: 37.78,
          longitude: -122.41,
          price: 2092,
          bedrooms: 0,
          bathrooms: 1,
          squareFootage: 0,
          propertyType: 'Apartment'
        }
      ]

      await upsertListings(data)

      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({ petsAllowed: null, laundryType: null })
      )
    })

    it('AH-018: parses petsAllowed/laundryType when a RentCast item happens to include those fields', async () => {
      const data = [
        {
          id: '3',
          formattedAddress: '1 Fake St',
          city: 'San Francisco',
          state: 'CA',
          zipCode: '94102',
          latitude: 37.78,
          longitude: -122.41,
          price: 3000,
          bedrooms: 1,
          bathrooms: 1,
          squareFootage: 500,
          petsAllowed: 'No pets',
          laundryType: 'W/D in unit'
        }
      ]

      await upsertListings(data)

      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({ petsAllowed: 'no', laundryType: 'in_unit' })
      )
    })
  })

  describe('rentcastPoller handler', () => {
    it('dispatches trigger-matching event when canonicalIds are returned', async () => {
      const mockStep = {
        run: vi.fn().mockImplementation((name, fn) => {
          if (name === 'check-daily-budget') return Promise.resolve(true)
          if (name === 'fetch-rentcast') return Promise.resolve([{}])
          if (name === 'upsert-listings-chunk-0') return Promise.resolve({ count: 1, canonicalIds: ['1'] })
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
          if (name === 'upsert-listings-chunk-0') return Promise.resolve({ count: 1, canonicalIds: [] })
          return fn()
        }),
        sendEvent: vi.fn()
      }

      const result = await rentcastPoller['fn']({ step: mockStep })
      expect(result).toEqual({ fetched: 1, upserted: 1 })
      expect(mockStep.sendEvent).not.toHaveBeenCalled()
    })

    it('skips the run entirely when the daily budget is exhausted', async () => {
      const mockStep = {
        run: vi.fn().mockImplementation((name: string) => {
          if (name === 'check-daily-budget') return Promise.resolve(false)
          throw new Error(`unexpected step.run call: ${name}`)
        }),
        sendEvent: vi.fn()
      }

      const result = await rentcastPoller['fn']({ step: mockStep })
      expect(result).toEqual({ skipped: true, reason: 'daily-budget-exceeded' })
      expect(mockStep.sendEvent).not.toHaveBeenCalled()
    })

    it('does not call step.run for chunking when zero listings are fetched', async () => {
      const mockStep = {
        run: vi.fn().mockImplementation((name: string) => {
          if (name === 'check-daily-budget') return Promise.resolve(true)
          if (name === 'fetch-rentcast') return Promise.resolve([])
          throw new Error(`unexpected step.run call: ${name}`)
        }),
        sendEvent: vi.fn()
      }

      const result = await rentcastPoller['fn']({ step: mockStep })
      expect(result).toEqual({ fetched: 0, upserted: 0 })
      expect(mockStep.sendEvent).not.toHaveBeenCalled()
    })

    it('chunks large result sets into multiple step.run calls and accumulates results', async () => {
      // 120 items at a 50-item chunk size should produce 3 chunks: 50, 50, 20.
      const fetched = Array.from({ length: 120 }, (_, i) => ({ id: i }))
      const chunkCalls: string[] = []

      const mockStep = {
        run: vi.fn().mockImplementation((name: string, fn: () => unknown) => {
          if (name === 'check-daily-budget') return Promise.resolve(true)
          if (name === 'fetch-rentcast') return Promise.resolve(fetched)
          if (/^upsert-listings-chunk-\d+$/.test(name)) {
            chunkCalls.push(name)
            const chunkIndex = chunkCalls.length - 1
            return Promise.resolve({ count: 1, canonicalIds: [`canonical-${chunkIndex}`] })
          }
          return fn()
        }),
        sendEvent: vi.fn().mockResolvedValue(undefined)
      }

      const result = await rentcastPoller['fn']({ step: mockStep })

      expect(chunkCalls).toEqual(['upsert-listings-chunk-0', 'upsert-listings-chunk-1', 'upsert-listings-chunk-2'])
      expect(result).toEqual({ fetched: 120, upserted: 3 })
      expect(mockStep.sendEvent).toHaveBeenCalledWith('trigger-matching', {
        name: 'app/listings.upserted',
        data: { listingIds: ['canonical-0', 'canonical-1', 'canonical-2'] }
      })
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
