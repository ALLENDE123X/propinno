import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchApartmentListViaApify,
  flattenApartmentListUnits,
  upsertApifyApartmentListListings,
  apartmentListPoller
} from '@/inngest/functions/apartmentListPoller'
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

// Shape mirrors a real dataset item returned by solidcode/apartmentlist-com-scraper
// during a live test call (includeDetails: true) against San Francisco, CA -
// trimmed to the fields the poller actually reads, but the two real units
// (one live/priced, one unpriced floorplan template) are unmodified from the
// real live response (2026-07-17).
const SAMPLE_ITEM = {
  id: 'p1140681',
  url: 'https://www.apartmentlist.com/ca/san-francisco/the-martin',
  propertyName: 'The Martin',
  formattedAddress: '2051 3rd St, San Francisco, CA 94107',
  latitude: 37.7644814613801,
  longitude: -122.388253123283,
  petPolicy: 'Cats and dogs allowed',
  amenities: ['Dogs allowed', 'Pet friendly', 'On-site laundry'],
  photos: [
    'https://cdn.apartmentlist.com/image/upload/f_auto,q_auto/4f473fa288fd25f953a2fc63e7eaaba8.jpg',
    'https://cdn.apartmentlist.com/image/upload/f_auto,q_auto/c07a51f12f9bdf4c2126bb4656ca2b58.jpg'
  ],
  units: [
    {
      floorplan: '0X1 F-L',
      unitName: '0X1 F-L',
      bedrooms: 0,
      bathrooms: 1,
      sqft: 596,
      price: null,
      availability: null,
      photos: ['https://cdn.apartmentlist.com/image/upload/f_auto,q_auto/dc470f7f32410f783fd11ea065338f7f.jpg']
    },
    {
      floorplan: '0X1 C',
      unitName: '507',
      bedrooms: 0,
      bathrooms: 1,
      sqft: 462,
      price: 3805,
      totalPrice: 3848,
      availability: 'available',
      photos: ['https://cdn.apartmentlist.com/image/upload/f_auto,q_auto/7ee2f85f6a5a3c613023dcfb145550c2.jpg']
    }
  ]
}

// A step.run/step.sleep mock that just executes the callback / resolves
// immediately - runApifyActorAsync's own poll-loop mechanics are covered
// exhaustively in tests/unit/apifyAsync.test.ts; this file only needs to
// confirm fetchApartmentListViaApify wires the right actor ID + input body
// into that shared helper.
function makePassthroughStep() {
  return {
    run: vi.fn((_name: string, fn: () => unknown) => Promise.resolve(fn())),
    sleep: vi.fn().mockResolvedValue(undefined)
  }
}

describe('fetchApartmentListViaApify', () => {
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
    await expect(fetchApartmentListViaApify(makePassthroughStep())).rejects.toThrow('APIFY_API_TOKEN')
  })

  it('throws when starting the Apify run returns a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockResolvedValue('Server error') })
    await expect(fetchApartmentListViaApify(makePassthroughStep())).rejects.toThrow(
      'Apify start-run for solidcode~apartmentlist-com-scraper returned 500'
    )
  })

  it('starts the run with the expected actor input, then returns the dataset items once SUCCEEDED', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' } })
      })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([SAMPLE_ITEM]) })

    const items = await fetchApartmentListViaApify(makePassthroughStep())
    expect(items).toEqual([SAMPLE_ITEM])
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://api.apify.com/v2/acts/solidcode~apartmentlist-com-scraper/runs?token=test-token',
      expect.objectContaining({ method: 'POST' })
    )
  })
})

describe('flattenApartmentListUnits', () => {
  it('produces one row per live unit, pairing it with its parent property, skipping unpriced floorplan templates', () => {
    const units = flattenApartmentListUnits([SAMPLE_ITEM])
    expect(units).toHaveLength(1)
    expect(units[0].property.id).toBe('p1140681')
    expect(units[0].unit.unitName).toBe('507')
  })

  it('produces zero rows for a property whose only units are unpriced templates', () => {
    const item = { ...SAMPLE_ITEM, units: [SAMPLE_ITEM.units[0]] }
    expect(flattenApartmentListUnits([item])).toEqual([])
  })

  it('produces zero rows when units is missing entirely', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { units: _units, ...withoutUnits } = SAMPLE_ITEM
    expect(flattenApartmentListUnits([withoutUnits as typeof SAMPLE_ITEM])).toEqual([])
  })

  it('returns [] for non-array input', () => {
    expect(flattenApartmentListUnits(null as unknown as never[])).toEqual([])
  })

  // This is the regression guard for the production 504 (issue #76): the
  // handler must chunk on flattened units, so a property that fans out to
  // many units contributes all of them to the flat count rather than
  // hiding them behind a single "item".
  it('fans a multi-unit property out to one row per live unit (the real production shape)', () => {
    const item = {
      ...SAMPLE_ITEM,
      units: Array.from({ length: 45 }, (_, i) => ({
        ...SAMPLE_ITEM.units[1],
        unitName: `unit-${i}`
      }))
    }
    expect(flattenApartmentListUnits([item])).toHaveLength(45)
  })
})

describe('upsertApifyApartmentListListings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns { count: 0, canonicalIds: [] } for empty array without calling dedupe', async () => {
    expect(await upsertApifyApartmentListListings([])).toEqual({ count: 0, canonicalIds: [] })
    expect(dedupeAndUpsertListings).not.toHaveBeenCalled()
  })

  it('maps a flattened live unit onto the shared listing shape', async () => {
    const result = await upsertApifyApartmentListListings(flattenApartmentListUnits([SAMPLE_ITEM]))
    expect(result).toEqual({ count: 1, canonicalIds: ['1'] })
    expect(dedupeAndUpsertListings).toHaveBeenCalledTimes(1)
    const values = vi.mocked(dedupeAndUpsertListings).mock.calls[0][0]
    expect(values).toHaveLength(1)
    expect(values[0]).toMatchObject({
      source: 'apartmentlist',
      sourceId: 'p1140681-507',
      price: 3805,
      beds: 0,
      baths: 1,
      sqft: 462,
      lat: 37.7644814613801,
      lng: -122.388253123283,
      url: SAMPLE_ITEM.url,
      address: '2051 3rd St, San Francisco, CA 94107, Unit 507',
      postedAt: null
    })
  })

  it('returns { count: 0, canonicalIds: [] } and skips dedupe when a property has no live units', async () => {
    const item = { ...SAMPLE_ITEM, id: 'no-live-units', units: [SAMPLE_ITEM.units[0]] }
    expect(await upsertApifyApartmentListListings(flattenApartmentListUnits([item]))).toEqual({
      count: 0,
      canonicalIds: []
    })
    expect(dedupeAndUpsertListings).not.toHaveBeenCalled()
  })

  it('falls back to a generic SF address when formattedAddress is absent', async () => {
    const item = { ...SAMPLE_ITEM, id: 'no-address', formattedAddress: undefined }
    await upsertApifyApartmentListListings(flattenApartmentListUnits([item]))
    const values = vi.mocked(dedupeAndUpsertListings).mock.calls[0][0]
    expect(values[0].address).toBe('San Francisco, CA')
  })

  it('strips the sibling units array out of raw but keeps this row\'s specific unit', async () => {
    await upsertApifyApartmentListListings(flattenApartmentListUnits([SAMPLE_ITEM]))
    const values = vi.mocked(dedupeAndUpsertListings).mock.calls[0][0]
    const raw = values[0].raw as { property: Record<string, unknown>; unit: Record<string, unknown> }
    expect(raw.property).not.toHaveProperty('units')
    expect(raw.property.propertyName).toBe('The Martin')
    expect(raw.unit).toMatchObject({ unitName: '507', price: 3805 })
  })

  it('maps images with the specific unit photo first, followed by the property gallery (real Apify shape)', async () => {
    await upsertApifyApartmentListListings(flattenApartmentListUnits([SAMPLE_ITEM]))
    const values = vi.mocked(dedupeAndUpsertListings).mock.calls[0][0]
    expect(values[0].images).toEqual([
      'https://cdn.apartmentlist.com/image/upload/f_auto,q_auto/7ee2f85f6a5a3c613023dcfb145550c2.jpg',
      'https://cdn.apartmentlist.com/image/upload/f_auto,q_auto/4f473fa288fd25f953a2fc63e7eaaba8.jpg',
      'https://cdn.apartmentlist.com/image/upload/f_auto,q_auto/c07a51f12f9bdf4c2126bb4656ca2b58.jpg'
    ])
  })

  it('falls back to the property gallery when a live unit has no photo of its own', async () => {
    const item = {
      ...SAMPLE_ITEM,
      id: 'no-unit-photo',
      units: [{ ...SAMPLE_ITEM.units[1], photos: undefined }]
    }
    await upsertApifyApartmentListListings(flattenApartmentListUnits([item]))
    const values = vi.mocked(dedupeAndUpsertListings).mock.calls[0][0]
    expect(values[0].images).toEqual(SAMPLE_ITEM.photos)
  })

  it('explodes multiple live units on the same property into separate listings', async () => {
    const item = {
      ...SAMPLE_ITEM,
      id: 'multi-unit',
      units: [
        SAMPLE_ITEM.units[1],
        { ...SAMPLE_ITEM.units[1], unitName: '308', price: 4032, availability: 'available' }
      ]
    }
    await upsertApifyApartmentListListings(flattenApartmentListUnits([item]))
    const values = vi.mocked(dedupeAndUpsertListings).mock.calls[0][0]
    expect(values.map((v: { sourceId: string }) => v.sourceId)).toEqual(['multi-unit-507', 'multi-unit-308'])
  })
})

describe('apartmentListPoller handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(claimDailyBudget).mockResolvedValue(true)
  })

  // fetchApartmentListViaApify(step) now makes its own step.run calls
  // internally (start-apify-run -> [poll] -> fetch-apify-dataset) rather
  // than being wrapped in a single outer 'fetch-apartmentlist-apify' step -
  // mock the run already terminal (SUCCEEDED) so these handler-level tests
  // don't need to exercise the poll loop itself (see
  // tests/unit/apifyAsync.test.ts).
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
    const result = await apartmentListPoller['fn']({ step })
    expect(result).toEqual({ fetched: 1, upserted: 1 })
    expect(step.sendEvent).toHaveBeenCalledWith('trigger-matching', {
      name: 'app/listings.upserted',
      data: { listingIds: ['1'] }
    })
  })

  it('skips sendEvent when no canonicalIds are returned', async () => {
    const step = runStep({ canonicalIds: [] })
    await apartmentListPoller['fn']({ step })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('skips the run entirely when the daily budget is exhausted', async () => {
    const step = runStep({ budget: false })
    const result = await apartmentListPoller['fn']({ step })
    expect(result).toEqual({ skipped: true, reason: 'daily-budget-exceeded' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('does not call step.run for chunking when zero properties are fetched', async () => {
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

    const result = await apartmentListPoller['fn']({ step })
    expect(result).toEqual({ fetched: 0, upserted: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  // Regression guard for the production 504 (issue #76). Before the fix the
  // handler chunked on *properties*, so these 2 properties were a single
  // chunk containing 90 listings - ~180 sequential DB round-trips in one
  // 60s Vercel invocation. Chunking on flattened units splits it into 50+40.
  it('chunks on flattened units, not properties, when few properties fan out to many units', async () => {
    const manyUnits = Array.from({ length: 45 }, (_, i) => ({
      ...SAMPLE_ITEM.units[1],
      unitName: `unit-${i}`
    }))
    const items = [
      { ...SAMPLE_ITEM, id: 'prop-a', units: manyUnits },
      { ...SAMPLE_ITEM, id: 'prop-b', units: manyUnits }
    ]
    const chunkSizes: number[] = []

    const step = {
      run: vi.fn().mockImplementation((name: string, fn: () => unknown) => {
        if (name === 'check-daily-budget') return Promise.resolve(true)
        if (name === 'start-apify-run') return Promise.resolve({ id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' })
        if (name === 'fetch-apify-dataset') return Promise.resolve(items)
        if (/^upsert-listings-chunk-\d+$/.test(name)) {
          // Run the real upsert so we can observe the true per-chunk listing count.
          return Promise.resolve(fn()).then(() => {
            const call = vi.mocked(dedupeAndUpsertListings).mock.calls.at(-1)
            chunkSizes.push(call ? call[0].length : 0)
            return { count: 0, canonicalIds: [] }
          })
        }
        return fn()
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      sendEvent: vi.fn().mockResolvedValue(undefined)
    }

    const result = await apartmentListPoller['fn']({ step })

    expect(chunkSizes).toEqual([50, 40])
    expect(chunkSizes.every((n) => n <= 50)).toBe(true)
    expect(result).toEqual({ fetched: 90, upserted: 0 })
  })

  it('chunks results into multiple step.run calls when above the chunk size', async () => {
    // 120 single-live-unit properties => 120 units => 3 chunks: 50, 50, 20.
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

    const result = await apartmentListPoller['fn']({ step })

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
    await expect(apartmentListPoller['fn']({ step })).rejects.toThrow('Test error')
    expect(Sentry.captureException).toHaveBeenCalledWith(error)
    expect(logger.error).toHaveBeenCalledWith({ err: error }, 'Apartment List (Apify) poller failed')
  })
})
