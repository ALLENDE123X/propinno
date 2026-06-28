import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchRentcastListings, upsertListings } from '@/inngest/functions/rentcastPoller'
import { db } from '@/lib/db'

const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined)
const mockValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate })
const mockInsert = vi.fn().mockReturnValue({ values: mockValues })

vi.mock('@/lib/db', () => ({
  db: {
    insert: (...args: any[]) => mockInsert(...args)
  }
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn()
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
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
    it('returns 0 if data is empty', async () => {
      expect(await upsertListings([])).toBe(0)
    })

    it('upserts mapped data correctly', async () => {
      const data = [
        {
          id: '1',
          formattedAddress: '123 Main St',
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
      expect(mockValues).toHaveBeenCalledWith([
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
      ])
      expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1)
    })
  })
})
