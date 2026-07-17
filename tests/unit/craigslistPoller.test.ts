import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchCraigslistViaApify,
  upsertApifyCraigslistListings,
  craigslistPoller
} from '@/inngest/functions/craigslistPoller'
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

const SAMPLE_ITEM = {
  id: 'https://sfbay.craigslist.org/sfc/apa/1234567890.html',
  url: 'https://sfbay.craigslist.org/sfc/apa/1234567890.html',
  title: 'Nice flat in Mission',
  datetime: '2026-07-16T08:00:00.000Z',
  location: 'Mission, San Francisco',
  price: '$3,200',
  longitude: '-122.4194',
  latitude: '37.7599',
  bedrooms: '2',
  bathrooms: '1',
  space: '850 sqft',
  address: { street: '123 Main St' },
  amenities: ['monthly', 'cats are OK - purrr', 'apartment', 'dogs are OK - wooof', 'w/d in unit', 'no smoking'],
  post: 'Beautiful 2BR flat, freshly painted.',
  pics: [
    'https://images.craigslist.org/00O0O_7jErhjDdqjs_0sX0CI_600x450.jpg',
    'https://images.craigslist.org/00i0i_86uqQ11WUAd_0t20CI_600x450.jpg'
  ]
}

describe('fetchCraigslistViaApify', () => {
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
    await expect(fetchCraigslistViaApify()).rejects.toThrow('APIFY_API_TOKEN')
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockResolvedValue('Server error') })
    await expect(fetchCraigslistViaApify()).rejects.toThrow('Apify Craigslist actor returned 500')
  })

  it('returns parsed items from a successful run', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([SAMPLE_ITEM]) })
    const items = await fetchCraigslistViaApify()
    expect(items).toEqual([SAMPLE_ITEM])
  })
})

describe('upsertApifyCraigslistListings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns { count: 0, canonicalIds: [] } for empty array without calling dedupe', async () => {
    expect(await upsertApifyCraigslistListings([])).toEqual({ count: 0, canonicalIds: [] })
    expect(dedupeAndUpsertListings).not.toHaveBeenCalled()
  })

  it('maps Apify fields onto the shared listing shape', async () => {
    const result = await upsertApifyCraigslistListings([SAMPLE_ITEM])
    expect(result).toEqual({ count: 1, canonicalIds: ['1'] })
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({
        source: 'craigslist',
        sourceId: SAMPLE_ITEM.id,
        price: 3200,
        beds: 2,
        baths: 1,
        sqft: 850,
        lat: 37.7599,
        lng: -122.4194,
        url: SAMPLE_ITEM.url
      })
    ])
  })

  it('AH-018: parses petsAllowed/laundryType from the amenities array (real Apify shape)', async () => {
    await upsertApifyCraigslistListings([SAMPLE_ITEM])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ petsAllowed: 'cats_and_dogs', laundryType: 'in_unit' })
    ])
  })

  it('AH-018: leaves petsAllowed/laundryType null (not a guess) when nothing in amenities or free text mentions them', async () => {
    const item = {
      ...SAMPLE_ITEM,
      id: 'no-signal-item',
      amenities: ['apartment', 'no smoking'],
      post: 'Sunny room with hardwood floors and great views.'
    }
    await upsertApifyCraigslistListings([item])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ petsAllowed: null, laundryType: null })
    ])
  })

  it('maps images from the pics array (real Apify shape)', async () => {
    await upsertApifyCraigslistListings([SAMPLE_ITEM])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({
        images: [
          'https://images.craigslist.org/00O0O_7jErhjDdqjs_0sX0CI_600x450.jpg',
          'https://images.craigslist.org/00i0i_86uqQ11WUAd_0t20CI_600x450.jpg'
        ]
      })
    ])
  })

  it('leaves images as [] (not a guess) when pics is absent', async () => {
    const item = { ...SAMPLE_ITEM, id: 'no-pics-item', pics: undefined }
    await upsertApifyCraigslistListings([item])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ images: [] })
    ])
  })
})

describe('craigslistPoller handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(claimDailyBudget).mockResolvedValue(true)
  })

  function runStep(overrides: { budget?: boolean; canonicalIds?: string[]; items?: unknown[] } = {}) {
    const items = overrides.items ?? [SAMPLE_ITEM]
    const step = {
      run: vi.fn().mockImplementation((name: string, fn: () => unknown) => {
        if (name === 'check-daily-budget') return Promise.resolve(overrides.budget ?? true)
        if (name === 'fetch-craigslist-apify') return Promise.resolve(items)
        if (name === 'upsert-listings-chunk-0') return Promise.resolve({ count: items.length, canonicalIds: overrides.canonicalIds ?? ['1'] })
        return fn()
      }),
      sendEvent: vi.fn().mockResolvedValue(undefined)
    }
    return step
  }

  it('dispatches trigger-matching when canonicalIds are returned', async () => {
    const step = runStep({ canonicalIds: ['1'] })
    const result = await craigslistPoller['fn']({ step })
    expect(result).toEqual({ fetched: 1, upserted: 1 })
    expect(step.sendEvent).toHaveBeenCalledWith('trigger-matching', {
      name: 'app/listings.upserted',
      data: { listingIds: ['1'] }
    })
  })

  it('skips sendEvent when no canonicalIds are returned', async () => {
    const step = runStep({ canonicalIds: [] })
    await craigslistPoller['fn']({ step })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('skips the run entirely when the daily budget is exhausted', async () => {
    const step = runStep({ budget: false })
    const result = await craigslistPoller['fn']({ step })
    expect(result).toEqual({ skipped: true, reason: 'daily-budget-exceeded' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('chunks results into multiple step.run calls when above the chunk size', async () => {
    // 120 items at a 50-item chunk size should produce 3 chunks: 50, 50, 20.
    const items = Array.from({ length: 120 }, (_, i) => ({ ...SAMPLE_ITEM, id: `item-${i}` }))
    const chunkCalls: string[] = []

    const step = {
      run: vi.fn().mockImplementation((name: string, fn: () => unknown) => {
        if (name === 'check-daily-budget') return Promise.resolve(true)
        if (name === 'fetch-craigslist-apify') return Promise.resolve(items)
        if (/^upsert-listings-chunk-\d+$/.test(name)) {
          chunkCalls.push(name)
          const chunkIndex = chunkCalls.length - 1
          return Promise.resolve({ count: 1, canonicalIds: [`canonical-${chunkIndex}`] })
        }
        return fn()
      }),
      sendEvent: vi.fn().mockResolvedValue(undefined)
    }

    const result = await craigslistPoller['fn']({ step })

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
    await expect(craigslistPoller['fn']({ step })).rejects.toThrow('Test error')
    expect(Sentry.captureException).toHaveBeenCalledWith(error)
    expect(logger.error).toHaveBeenCalledWith({ err: error }, 'Craigslist (Apify) poller failed')
  })
})
