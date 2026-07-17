import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchRealtorViaApify,
  upsertApifyRealtorListings,
  realtorPoller
} from '@/inngest/functions/realtorPoller'
import { dedupeAndUpsertListings } from '@/lib/listings'
import { claimDailyBudget } from '@/lib/pollerBudget'
import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'

vi.mock('@/lib/listings', () => ({
  dedupeAndUpsertListings: vi.fn().mockResolvedValue({ count: 1, canonicalIds: ['1'] })
}))
vi.mock('@/lib/pollerBudget', () => ({
  claimDailyBudget: vi.fn().mockResolvedValue(true)
}))
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const mockFetch = vi.fn()
global.fetch = mockFetch

// Shape mirrors a real dataset item returned by kawsar/realtor-Search during
// a live test call against real SF `status=for_rent` results (2026-07-17) -
// a genuine MLS-sourced listing (source_type: 'mls').
const GENUINE_ITEM = {
  property_id: '1928138171',
  listing_id: '2998607763',
  permalink: 'San-Francisco_CA_94116_M19281-38171',
  status: 'for_rent',
  list_price: 5680,
  beds: 2,
  baths_consolidated: '1.5',
  sqft: 1294,
  type: 'condos',
  address_line: null,
  city: 'San Francisco',
  state_code: 'CA',
  postal_code: '94116',
  latitude: 37.752694,
  longitude: -122.465807,
  list_date: '2026-07-17T12:31:39.000000Z',
  source_name: 'SanFrancisco',
  source_type: 'mls',
  primary_photo_url: 'https://ap.rdcpix.com/2347dc3ea468b7a1c4411b035ef576a8l-m1926513261s.jpg',
  photo_urls: [
    'https://ap.rdcpix.com/2347dc3ea468b7a1c4411b035ef576a8l-m1926513261s.jpg',
    'https://ap.rdcpix.com/2347dc3ea468b7a1c4411b035ef576a8l-m2824488148s.jpg'
  ]
}

// Real shape of the ~80% "community"-sourced placeholder rows found live -
// null price/beds/baths/sqft, Zillow/Appfolio syndication with no usable
// data on Realtor.com's own page.
const GARBAGE_ITEM = {
  property_id: '9367389800',
  listing_id: '2966799554',
  permalink: '1028-Market-St_San-Francisco_CA_94102_M93673-89800',
  status: 'for_rent',
  list_price: null,
  beds: null,
  baths_consolidated: null,
  sqft: null,
  type: 'apartment',
  address_line: '1028 Market St',
  city: 'San Francisco',
  state_code: 'CA',
  postal_code: '94102',
  latitude: 37.781883,
  longitude: -122.411324,
  list_date: '2024-04-26T18:46:28.000000Z',
  source_name: 'Zillow',
  source_type: 'community',
  primary_photo_url: 'https://ar.rdcpix.com/ba8c9f6a8d15fb88d470a8dc2906233ec-f1991732486s.jpg',
  photo_urls: ['https://ar.rdcpix.com/ba8c9f6a8d15fb88d470a8dc2906233ec-f1991732486s.jpg']
}

describe('fetchRealtorViaApify', () => {
  const ORIGINAL_ENV = process.env.APIFY_API_TOKEN

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.APIFY_API_TOKEN = 'test-token'
  })

  afterEach(() => {
    process.env.APIFY_API_TOKEN = ORIGINAL_ENV
  })

  it('throws if APIFY_API_TOKEN is not set', async () => {
    delete process.env.APIFY_API_TOKEN
    await expect(fetchRealtorViaApify()).rejects.toThrow('APIFY_API_TOKEN')
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockResolvedValue('Server error') })
    await expect(fetchRealtorViaApify()).rejects.toThrow('Apify Realtor actor returned 500')
  })

  it('returns parsed items from a successful run', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([GENUINE_ITEM]) })
    const items = await fetchRealtorViaApify()
    expect(items).toEqual([GENUINE_ITEM])
  })
})

describe('upsertApifyRealtorListings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns { count: 0, canonicalIds: [] } for empty array without calling dedupe', async () => {
    expect(await upsertApifyRealtorListings([])).toEqual({ count: 0, canonicalIds: [] })
    expect(dedupeAndUpsertListings).not.toHaveBeenCalled()
  })

  it('maps Apify fields onto the shared listing shape for a genuine (mls-sourced) listing', async () => {
    const result = await upsertApifyRealtorListings([GENUINE_ITEM])
    expect(result).toEqual({ count: 1, canonicalIds: ['1'] })
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({
        source: 'realtor',
        sourceId: GENUINE_ITEM.property_id,
        price: 5680,
        beds: 2,
        baths: 1.5,
        sqft: 1294,
        lat: 37.752694,
        lng: -122.465807,
        url: 'https://www.realtor.com/realestateandhomes-detail/San-Francisco_CA_94116_M19281-38171'
      })
    ])
  })

  it('falls back to city/state/postal_code when address_line is null (real shape - some MLS listings omit it)', async () => {
    await upsertApifyRealtorListings([GENUINE_ITEM])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ address: 'San Francisco, CA 94116' })
    ])
  })

  it('uses address_line directly when present', async () => {
    const item = { ...GENUINE_ITEM, id: 'with-address', address_line: '2650 39th Ave' }
    await upsertApifyRealtorListings([item])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ address: '2650 39th Ave' })
    ])
  })

  it('drops the ~80% "community"-sourced placeholder rows with no real price (real Apify shape)', async () => {
    const result = await upsertApifyRealtorListings([GARBAGE_ITEM])
    expect(result).toEqual({ count: 0, canonicalIds: [] })
    expect(dedupeAndUpsertListings).not.toHaveBeenCalled()
  })

  it('filters out garbage items but still upserts genuine ones from a mixed batch', async () => {
    await upsertApifyRealtorListings([GARBAGE_ITEM, GENUINE_ITEM])
    expect(dedupeAndUpsertListings).toHaveBeenCalledTimes(1)
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ sourceId: GENUINE_ITEM.property_id })
    ])
  })

  it('maps images from the photo_urls gallery (real Apify shape)', async () => {
    await upsertApifyRealtorListings([GENUINE_ITEM])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({
        images: [
          'https://ap.rdcpix.com/2347dc3ea468b7a1c4411b035ef576a8l-m1926513261s.jpg',
          'https://ap.rdcpix.com/2347dc3ea468b7a1c4411b035ef576a8l-m2824488148s.jpg'
        ]
      })
    ])
  })

  it('falls back to primary_photo_url when photo_urls is absent', async () => {
    const item = { ...GENUINE_ITEM, id: 'primary-only', photo_urls: undefined }
    await upsertApifyRealtorListings([item])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ images: [GENUINE_ITEM.primary_photo_url] })
    ])
  })

  it('leaves url null when permalink is absent', async () => {
    const item = { ...GENUINE_ITEM, id: 'no-permalink', permalink: null }
    await upsertApifyRealtorListings([item])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ url: null })
    ])
  })
})

describe('realtorPoller handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(claimDailyBudget).mockResolvedValue(true)
  })

  function runStep(overrides: { budget?: boolean; canonicalIds?: string[]; items?: unknown[] } = {}) {
    const items = overrides.items ?? [GENUINE_ITEM]
    const step = {
      run: vi.fn().mockImplementation((name: string, fn: () => unknown) => {
        if (name === 'check-daily-budget') return Promise.resolve(overrides.budget ?? true)
        if (name === 'fetch-realtor-apify') return Promise.resolve(items)
        if (name === 'upsert-listings-chunk-0') return Promise.resolve({ count: items.length, canonicalIds: overrides.canonicalIds ?? ['1'] })
        return fn()
      }),
      sendEvent: vi.fn().mockResolvedValue(undefined)
    }
    return step
  }

  it('dispatches trigger-matching when canonicalIds are returned', async () => {
    const step = runStep({ canonicalIds: ['1'] })
    const result = await realtorPoller['fn']({ step })
    expect(result).toEqual({ fetched: 1, upserted: 1 })
    expect(step.sendEvent).toHaveBeenCalledWith('trigger-matching', {
      name: 'app/listings.upserted',
      data: { listingIds: ['1'] }
    })
  })

  it('skips sendEvent when no canonicalIds are returned', async () => {
    const step = runStep({ canonicalIds: [] })
    await realtorPoller['fn']({ step })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('skips the run entirely when the daily budget is exhausted', async () => {
    const step = runStep({ budget: false })
    const result = await realtorPoller['fn']({ step })
    expect(result).toEqual({ skipped: true, reason: 'daily-budget-exceeded' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('does not call step.run for chunking when zero listings are fetched', async () => {
    const step = {
      run: vi.fn().mockImplementation((name: string) => {
        if (name === 'check-daily-budget') return Promise.resolve(true)
        if (name === 'fetch-realtor-apify') return Promise.resolve([])
        throw new Error(`unexpected step.run call: ${name}`)
      }),
      sendEvent: vi.fn()
    }

    const result = await realtorPoller['fn']({ step })
    expect(result).toEqual({ fetched: 0, upserted: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('chunks results into multiple step.run calls when above the chunk size', async () => {
    // 120 items at a 50-item chunk size should produce 3 chunks: 50, 50, 20.
    const items = Array.from({ length: 120 }, (_, i) => ({ ...GENUINE_ITEM, property_id: `item-${i}` }))
    const chunkCalls: string[] = []

    const step = {
      run: vi.fn().mockImplementation((name: string, fn: () => unknown) => {
        if (name === 'check-daily-budget') return Promise.resolve(true)
        if (name === 'fetch-realtor-apify') return Promise.resolve(items)
        if (/^upsert-listings-chunk-\d+$/.test(name)) {
          chunkCalls.push(name)
          const chunkIndex = chunkCalls.length - 1
          return Promise.resolve({ count: 1, canonicalIds: [`canonical-${chunkIndex}`] })
        }
        return fn()
      }),
      sendEvent: vi.fn().mockResolvedValue(undefined)
    }

    const result = await realtorPoller['fn']({ step })

    expect(chunkCalls).toEqual(['upsert-listings-chunk-0', 'upsert-listings-chunk-1', 'upsert-listings-chunk-2'])
    expect(result).toEqual({ fetched: 120, upserted: 3 })
    expect(step.sendEvent).toHaveBeenCalledWith('trigger-matching', {
      name: 'app/listings.upserted',
      data: { listingIds: ['canonical-0', 'canonical-1', 'canonical-2'] }
    })
  })

  it('catches and logs errors properly', async () => {
    const error = new Error('Test error')
    const step = {
      run: vi.fn().mockImplementation((name: string) => {
        if (name === 'check-daily-budget') return Promise.resolve(true)
        return Promise.reject(error)
      })
    }
    await expect(realtorPoller['fn']({ step })).rejects.toThrow('Test error')
    expect(Sentry.captureException).toHaveBeenCalledWith(error)
    expect(logger.error).toHaveBeenCalledWith({ err: error }, 'Realtor.com (Apify) poller failed')
  })
})
