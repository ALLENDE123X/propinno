import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchFacebookViaApify,
  upsertApifyFacebookListings,
  facebookPoller
} from '@/inngest/functions/facebookPoller'
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

// Shape mirrors a real dataset item returned by memo23/facebook-marketplace-scraper-ppe
// during a live test call (includeSeller: true) against SF Bay Area propertyrentals.
const SAMPLE_ITEM = {
  id: '1036344722472860',
  itemUrl: 'https://www.facebook.com/marketplace/item/1036344722472860',
  listingTitle: '2 Beds 1 Bath - Apartment',
  customTitle: '2 beds · 1 bath',
  locationText: 'South San Francisco, CA',
  street: null,
  details: [],
  timestamp: '2026-07-16T18:25:28.000Z',
  timestampExact: '2026-07-16T18:25:28.000Z',
  listingPrice: { amount: '2000.00', formatted_amount: '$2,000' },
  location: { latitude: 37.658386230469, longitude: -122.42614746094 },
  primary_listing_photo: {
    photo_image_url: 'https://scontent.fhex1-1.fna.fbcdn.net/primary.jpg'
  },
  moreDetails: {
    listing_photos: [
      { image: { uri: 'https://scontent-bos5-1.xx.fbcdn.net/gallery-1.jpg' } },
      { image: { uri: 'https://scontent-bos5-1.xx.fbcdn.net/gallery-2.jpg' } }
    ]
  }
}

// A step.run/step.sleep mock that just executes the callback / resolves
// immediately - runApifyActorAsync's own poll-loop mechanics are covered
// exhaustively in tests/unit/apifyAsync.test.ts; this file only needs to
// confirm fetchFacebookViaApify wires the right actor ID + input body into
// that shared helper.
function makePassthroughStep() {
  return {
    run: vi.fn((_name: string, fn: () => unknown) => Promise.resolve(fn())),
    sleep: vi.fn().mockResolvedValue(undefined)
  }
}

describe('fetchFacebookViaApify', () => {
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
    await expect(fetchFacebookViaApify(makePassthroughStep())).rejects.toThrow('APIFY_API_TOKEN')
  })

  it('throws when starting the Apify run returns a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockResolvedValue('Server error') })
    await expect(fetchFacebookViaApify(makePassthroughStep())).rejects.toThrow(
      'Apify start-run for memo23~facebook-marketplace-scraper-ppe returned 500'
    )
  })

  it('starts the run with the expected actor input, then returns the dataset items once SUCCEEDED', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' } })
      })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([SAMPLE_ITEM]) })

    const items = await fetchFacebookViaApify(makePassthroughStep())
    expect(items).toEqual([SAMPLE_ITEM])
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://api.apify.com/v2/acts/memo23~facebook-marketplace-scraper-ppe/runs?token=test-token',
      expect.objectContaining({ method: 'POST' })
    )
  })
})

describe('upsertApifyFacebookListings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns { count: 0, canonicalIds: [] } for empty array without calling dedupe', async () => {
    expect(await upsertApifyFacebookListings([])).toEqual({ count: 0, canonicalIds: [] })
    expect(dedupeAndUpsertListings).not.toHaveBeenCalled()
  })

  it('maps Apify fields onto the shared listing shape', async () => {
    const result = await upsertApifyFacebookListings([SAMPLE_ITEM])
    expect(result).toEqual({ count: 1, canonicalIds: ['1'] })
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({
        source: 'facebook',
        sourceId: SAMPLE_ITEM.id,
        price: 2000,
        beds: 2,
        baths: 1,
        lat: 37.658386230469,
        lng: -122.42614746094,
        url: SAMPLE_ITEM.itemUrl,
        address: 'South San Francisco, CA'
      })
    ])
  })

  it('falls back to street/details when present and leaves beds/baths null when absent from the title', async () => {
    const item = {
      ...SAMPLE_ITEM,
      id: 'no-bedbath',
      listingTitle: 'Beauty suite in Hayward',
      customTitle: '',
      street: '452 Cherry Way',
      details: ['452 Cherry Way', 'Hayward, CA']
    }
    await upsertApifyFacebookListings([item])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({
        beds: null,
        baths: null,
        address: '452 Cherry Way, 452 Cherry Way, Hayward, CA'
      })
    ])
  })

  it('maps images from moreDetails.listing_photos (the full gallery, real Apify shape)', async () => {
    await upsertApifyFacebookListings([SAMPLE_ITEM])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({
        images: [
          'https://scontent-bos5-1.xx.fbcdn.net/gallery-1.jpg',
          'https://scontent-bos5-1.xx.fbcdn.net/gallery-2.jpg'
        ]
      })
    ])
  })

  it('falls back to primary_listing_photo when moreDetails is absent, and to [] when neither is present', async () => {
    const withPrimaryOnly = {
      ...SAMPLE_ITEM,
      id: 'primary-only',
      moreDetails: undefined
    }
    const withNeither = {
      ...SAMPLE_ITEM,
      id: 'no-images',
      primary_listing_photo: undefined,
      moreDetails: undefined
    }
    await upsertApifyFacebookListings([withPrimaryOnly, withNeither])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ images: ['https://scontent.fhex1-1.fna.fbcdn.net/primary.jpg'] }),
      expect.objectContaining({ images: [] })
    ])
  })
})

describe('facebookPoller handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(claimDailyBudget).mockResolvedValue(true)
  })

  // fetchFacebookViaApify(step) now makes its own step.run calls internally
  // (start-apify-run -> [poll] -> fetch-apify-dataset) rather than being
  // wrapped in a single outer 'fetch-facebook-apify' step - mock the run
  // already terminal (SUCCEEDED) so these handler-level tests don't need to
  // exercise the poll loop itself (see tests/unit/apifyAsync.test.ts).
  function runStep(overrides: { budget?: boolean; canonicalIds?: string[]; items?: unknown[] } = {}) {
    const items = overrides.items ?? [SAMPLE_ITEM]
    const step = {
      run: vi.fn().mockImplementation((name: string, fn: () => unknown) => {
        if (name === 'check-daily-budget') return Promise.resolve(overrides.budget ?? true)
        if (name === 'start-apify-run') return Promise.resolve({ id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' })
        if (name === 'fetch-apify-dataset') return Promise.resolve(items)
        if (name === 'upsert-listings-chunk-0') return Promise.resolve({ count: items.length, canonicalIds: overrides.canonicalIds ?? ['1'] })
        return fn()
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      sendEvent: vi.fn().mockResolvedValue(undefined)
    }
    return step
  }

  it('dispatches trigger-matching when canonicalIds are returned', async () => {
    const step = runStep({ canonicalIds: ['1'] })
    const result = await facebookPoller['fn']({ step })
    expect(result).toEqual({ fetched: 1, upserted: 1 })
    expect(step.sendEvent).toHaveBeenCalledWith('trigger-matching', {
      name: 'app/listings.upserted',
      data: { listingIds: ['1'] }
    })
  })

  it('skips sendEvent when no canonicalIds are returned', async () => {
    const step = runStep({ canonicalIds: [] })
    await facebookPoller['fn']({ step })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('skips the run entirely when the daily budget is exhausted', async () => {
    const step = runStep({ budget: false })
    const result = await facebookPoller['fn']({ step })
    expect(result).toEqual({ skipped: true, reason: 'daily-budget-exceeded' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('does not call step.run for chunking when zero listings are fetched', async () => {
    const step = {
      run: vi.fn().mockImplementation((name: string) => {
        if (name === 'check-daily-budget') return Promise.resolve(true)
        if (name === 'start-apify-run') return Promise.resolve({ id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' })
        if (name === 'fetch-apify-dataset') return Promise.resolve([])
        throw new Error(`unexpected step.run call: ${name}`)
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      sendEvent: vi.fn()
    }

    const result = await facebookPoller['fn']({ step })
    expect(result).toEqual({ fetched: 0, upserted: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('chunks results into multiple step.run calls when above the chunk size', async () => {
    // 120 items at a 50-item chunk size should produce 3 chunks: 50, 50, 20.
    const items = Array.from({ length: 120 }, (_, i) => ({ ...SAMPLE_ITEM, id: `item-${i}` }))
    const chunkCalls: string[] = []

    const step = {
      run: vi.fn().mockImplementation((name: string, fn: () => unknown) => {
        if (name === 'check-daily-budget') return Promise.resolve(true)
        if (name === 'start-apify-run') return Promise.resolve({ id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' })
        if (name === 'fetch-apify-dataset') return Promise.resolve(items)
        if (/^upsert-listings-chunk-\d+$/.test(name)) {
          chunkCalls.push(name)
          const chunkIndex = chunkCalls.length - 1
          return Promise.resolve({ count: 1, canonicalIds: [`canonical-${chunkIndex}`] })
        }
        return fn()
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      sendEvent: vi.fn().mockResolvedValue(undefined)
    }

    const result = await facebookPoller['fn']({ step })

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
      }),
      sleep: vi.fn().mockResolvedValue(undefined)
    }
    await expect(facebookPoller['fn']({ step })).rejects.toThrow('Test error')
    expect(Sentry.captureException).toHaveBeenCalledWith(error)
    expect(logger.error).toHaveBeenCalledWith({ err: error }, 'Facebook (Apify) poller failed')
  })
})
