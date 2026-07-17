import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchZumperViaApify,
  upsertApifyZumperListings,
  zumperPoller
} from '@/inngest/functions/zumperPoller'
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

// Shape mirrors a real dataset item returned by
// benthepythondev/zumper-rental-scraper during a live "search" mode call
// (location: san-francisco-ca, includePhotos: true) on 2026-07-17.
const SAMPLE_ITEM = {
  listing_id: 16556885,
  url: 'https://www.zumper.com/apartment-buildings/p13159/azure-mission-bay-san-francisco-ca',
  name: 'Azure',
  address: '690 Long Bridge St, San Francisco, CA 94158',
  street: '690 Long Bridge St',
  city: 'San Francisco',
  state: 'CA',
  zipcode: '94158',
  neighborhood: 'Mission Bay',
  latitude: 37.772473,
  longitude: -122.393059,
  price_min: 4950,
  price_max: 5414,
  beds_min: 1,
  beds_max: 1,
  baths_min: 1,
  baths_max: 1,
  rating: 9.3,
  property_type: 'Apartment',
  amenities: ['Refrigerator', 'Dishwasher', 'In-Unit Laundry'],
  pets_allowed: ['Cats', 'Dogs'],
  phone: '(925) 800-6132',
  agent_name: 'Azure',
  brokerage_name: 'Equity Residential',
  feed_name: 'equity',
  date_available: null,
  has_fees: true,
  image_ids: [238066372, 901314944, 895186948],
  image_count: 10,
  lead_score: 78
}

describe('fetchZumperViaApify', () => {
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
    await expect(fetchZumperViaApify()).rejects.toThrow('APIFY_API_TOKEN')
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockResolvedValue('Server error') })
    await expect(fetchZumperViaApify()).rejects.toThrow('Apify Zumper actor returned 500')
  })

  it('returns parsed items from a successful run', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([SAMPLE_ITEM]) })
    const items = await fetchZumperViaApify()
    expect(items).toEqual([SAMPLE_ITEM])
  })
})

describe('upsertApifyZumperListings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns { count: 0, canonicalIds: [] } for empty array without calling dedupe', async () => {
    expect(await upsertApifyZumperListings([])).toEqual({ count: 0, canonicalIds: [] })
    expect(dedupeAndUpsertListings).not.toHaveBeenCalled()
  })

  it('maps Apify fields onto the shared listing shape, using the _min variant for price/beds/baths', async () => {
    const result = await upsertApifyZumperListings([SAMPLE_ITEM])
    expect(result).toEqual({ count: 1, canonicalIds: ['1'] })
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({
        source: 'zumper',
        sourceId: '16556885',
        address: '690 Long Bridge St, San Francisco, CA 94158',
        price: 4950,
        beds: 1,
        baths: 1,
        sqft: null,
        lat: 37.772473,
        lng: -122.393059,
        url: SAMPLE_ITEM.url,
        postedAt: null
      })
    ])
  })

  it('falls back to constructing an address from street/city/state/zipcode when the address field is absent', async () => {
    const item = { ...SAMPLE_ITEM, listing_id: 'no-address-item', address: null }
    await upsertApifyZumperListings([item])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ address: '690 Long Bridge St, San Francisco, CA, 94158' })
    ])
  })

  it('falls back to a generic SF address when neither address nor street/city/state/zipcode are present', async () => {
    const item = {
      ...SAMPLE_ITEM,
      listing_id: 'no-signal-item',
      address: null,
      street: null,
      city: null,
      state: null,
      zipcode: null
    }
    await upsertApifyZumperListings([item])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ address: 'San Francisco, CA' })
    ])
  })

  it('leaves images as [] (not a guess) since this actor only exposes opaque photo IDs', async () => {
    await upsertApifyZumperListings([SAMPLE_ITEM])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ images: [] })
    ])
  })

  it('leaves price/beds/baths null when the _min fields are absent, not a guess', async () => {
    const item = {
      ...SAMPLE_ITEM,
      listing_id: 'no-pricing-item',
      price_min: null,
      beds_min: null,
      baths_min: null
    }
    await upsertApifyZumperListings([item])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ price: null, beds: null, baths: null })
    ])
  })
})

describe('zumperPoller handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(claimDailyBudget).mockResolvedValue(true)
  })

  function runStep(overrides: { budget?: boolean; canonicalIds?: string[]; items?: unknown[] } = {}) {
    const items = overrides.items ?? [SAMPLE_ITEM]
    const step = {
      run: vi.fn().mockImplementation((name: string, fn: () => unknown) => {
        if (name === 'check-daily-budget') return Promise.resolve(overrides.budget ?? true)
        if (name === 'fetch-zumper-apify') return Promise.resolve(items)
        if (name === 'upsert-listings-chunk-0') return Promise.resolve({ count: items.length, canonicalIds: overrides.canonicalIds ?? ['1'] })
        return fn()
      }),
      sendEvent: vi.fn().mockResolvedValue(undefined)
    }
    return step
  }

  it('dispatches trigger-matching when canonicalIds are returned', async () => {
    const step = runStep({ canonicalIds: ['1'] })
    const result = await zumperPoller['fn']({ step })
    expect(result).toEqual({ fetched: 1, upserted: 1 })
    expect(step.sendEvent).toHaveBeenCalledWith('trigger-matching', {
      name: 'app/listings.upserted',
      data: { listingIds: ['1'] }
    })
  })

  it('skips sendEvent when no canonicalIds are returned', async () => {
    const step = runStep({ canonicalIds: [] })
    await zumperPoller['fn']({ step })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('skips the run entirely when the daily budget is exhausted', async () => {
    const step = runStep({ budget: false })
    const result = await zumperPoller['fn']({ step })
    expect(result).toEqual({ skipped: true, reason: 'daily-budget-exceeded' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('chunks results into multiple step.run calls when above the chunk size', async () => {
    // 120 items at a 50-item chunk size should produce 3 chunks: 50, 50, 20.
    const items = Array.from({ length: 120 }, (_, i) => ({ ...SAMPLE_ITEM, listing_id: `item-${i}` }))
    const chunkCalls: string[] = []

    const step = {
      run: vi.fn().mockImplementation((name: string, fn: () => unknown) => {
        if (name === 'check-daily-budget') return Promise.resolve(true)
        if (name === 'fetch-zumper-apify') return Promise.resolve(items)
        if (/^upsert-listings-chunk-\d+$/.test(name)) {
          chunkCalls.push(name)
          const chunkIndex = chunkCalls.length - 1
          return Promise.resolve({ count: 1, canonicalIds: [`canonical-${chunkIndex}`] })
        }
        return fn()
      }),
      sendEvent: vi.fn().mockResolvedValue(undefined)
    }

    const result = await zumperPoller['fn']({ step })

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
    await expect(zumperPoller['fn']({ step })).rejects.toThrow('Test error')
    expect(Sentry.captureException).toHaveBeenCalledWith(error)
    expect(logger.error).toHaveBeenCalledWith({ err: error }, 'Zumper (Apify) poller failed')
  })
})
