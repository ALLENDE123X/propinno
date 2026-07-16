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
  address: { street: '123 Main St' }
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
})

describe('craigslistPoller handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(claimDailyBudget).mockResolvedValue(true)
  })

  function runStep(overrides: { budget?: boolean; canonicalIds?: string[] } = {}) {
    const step = {
      run: vi.fn().mockImplementation((name: string, fn: () => unknown) => {
        if (name === 'check-daily-budget') return Promise.resolve(overrides.budget ?? true)
        if (name === 'fetch-craigslist-apify') return Promise.resolve([SAMPLE_ITEM])
        if (name === 'upsert-listings') return Promise.resolve({ count: 1, canonicalIds: overrides.canonicalIds ?? ['1'] })
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
