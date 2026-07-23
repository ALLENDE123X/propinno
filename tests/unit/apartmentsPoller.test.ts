import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchApartmentsViaApify,
  flattenApartmentsUnits,
  upsertApifyApartmentsListings,
  apartmentsPoller
} from '@/inngest/functions/apartmentsPoller'
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

// Shape mirrors a real dataset item returned by epctex/apartments-scraper-api
// during a live test call (`search: "San Francisco, CA"`, maxItems: 5) on
// 2026-07-17 - trimmed to the fields this poller actually reads, but every
// value below (address, coordinates, rental prices/beds/baths/sqft,
// unitNumber shapes, lastUpdated string, image URL) is real, not invented.
const SAMPLE_PROPERTY = {
  id: 'bkq1ge9',
  propertyName: '388 Beale',
  url: 'https://www.apartments.com/388-beale/bkq1ge9/',
  lastUpdated: '2 hours ago',
  location: {
    fullAddress: '388 Beale St, San Francisco, CA 94105',
    city: 'San Francisco',
    state: 'CA',
    postalCode: '94105'
  },
  coordinates: { latitude: 37.7875529, longitude: -122.3916794 },
  description: '388 Beale features premier resident services...',
  models: [{ modelId: 'cbffy6g', modelName: 'Plan A1C', image: 'https://images1.apartments.com/i2/model.jpg' }],
  rentals: [
    {
      key: 'gls4r3y',
      unitNumber: 'N/A-1201',
      beds: 1,
      baths: 1,
      basePrice: 6046,
      totalPrice: 6118,
      squareFeet: 825,
      availableDate: '2026-07-17T00:00:00-04:00',
      image: 'https://images1.apartments.com/i2/V-VbAsRDOYIofVoqaxWdzmPNpOpV6DxcHBRYZMO3aqk/105/image.jpg'
    },
    {
      key: '90v0x74',
      unitNumber: 'N/A-1516',
      beds: 1,
      baths: 1,
      basePrice: 6112,
      totalPrice: 6184,
      squareFeet: 825,
      availableDate: '2026-08-06T00:00:00-04:00',
      image: 'https://images1.apartments.com/i2/V-VbAsRDOYIofVoqaxWdzmPNpOpV6DxcHBRYZMO3aqk/105/image.jpg'
    }
  ]
}

// A step.run/step.sleep mock that just executes the callback / resolves
// immediately - runApifyActorAsync's own poll-loop mechanics are covered
// exhaustively in tests/unit/apifyAsync.test.ts; this file only needs to
// confirm fetchApartmentsViaApify wires the right actor ID + input body
// into that shared helper.
function makePassthroughStep() {
  return {
    run: vi.fn((_name: string, fn: () => unknown) => Promise.resolve(fn())),
    sleep: vi.fn().mockResolvedValue(undefined)
  }
}

describe('fetchApartmentsViaApify', () => {
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
    await expect(fetchApartmentsViaApify(makePassthroughStep())).rejects.toThrow('APIFY_API_TOKEN')
  })

  it('throws when starting the Apify run returns a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockResolvedValue('Server error') })
    await expect(fetchApartmentsViaApify(makePassthroughStep())).rejects.toThrow(
      'Apify start-run for epctex~apartments-scraper-api returned 500'
    )
  })

  it('starts the run with the expected actor input, then returns the dataset items once SUCCEEDED', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' } })
      })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([SAMPLE_PROPERTY]) })

    const items = await fetchApartmentsViaApify(makePassthroughStep())
    expect(items).toEqual([SAMPLE_PROPERTY])
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://api.apify.com/v2/acts/epctex~apartments-scraper-api/runs?token=test-token',
      expect.objectContaining({ method: 'POST' })
    )
  })
})

describe('flattenApartmentsUnits', () => {
  it('produces one row per rental, pairing it with its parent property', () => {
    const units = flattenApartmentsUnits([SAMPLE_PROPERTY])
    expect(units).toHaveLength(2)
    expect(units[0].property.id).toBe('bkq1ge9')
    expect(units[0].rental.key).toBe('gls4r3y')
    expect(units[1].rental.key).toBe('90v0x74')
  })

  it('produces zero rows for a property with no rentals (not a guessed placeholder listing)', () => {
    const noRentals = { ...SAMPLE_PROPERTY, id: 'no-rentals', rentals: [] }
    expect(flattenApartmentsUnits([noRentals])).toEqual([])
  })

  it('produces zero rows when rentals is missing entirely', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { rentals: _rentals, ...withoutRentals } = SAMPLE_PROPERTY
    expect(flattenApartmentsUnits([withoutRentals])).toEqual([])
  })

  it('returns [] for non-array input', () => {
    expect(flattenApartmentsUnits(null as unknown as never[])).toEqual([])
  })
})

describe('upsertApifyApartmentsListings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns { count: 0, canonicalIds: [] } for empty array without calling dedupe', async () => {
    expect(await upsertApifyApartmentsListings([])).toEqual({ count: 0, canonicalIds: [] })
    expect(dedupeAndUpsertListings).not.toHaveBeenCalled()
  })

  it('maps a flattened unit onto the shared listing shape (real per-unit numeric fields, not a range string)', async () => {
    const units = flattenApartmentsUnits([SAMPLE_PROPERTY])
    const result = await upsertApifyApartmentsListings([units[0]])
    expect(result).toEqual({ count: 1, canonicalIds: ['1'] })
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({
        source: 'apartments',
        sourceId: 'bkq1ge9-gls4r3y',
        price: 6118,
        beds: 1,
        baths: 1,
        sqft: 825,
        lat: 37.7875529,
        lng: -122.3916794,
        url: SAMPLE_PROPERTY.url
      })
    ])
  })

  it('prefers totalPrice over basePrice, falling back to basePrice when totalPrice is absent', async () => {
    const units = flattenApartmentsUnits([SAMPLE_PROPERTY])
    await upsertApifyApartmentsListings([units[0]])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([expect.objectContaining({ price: 6118 })])

    vi.mocked(dedupeAndUpsertListings).mockClear()
    const noTotalPrice = { ...units[0], rental: { ...units[0].rental, totalPrice: undefined } }
    await upsertApifyApartmentsListings([noTotalPrice])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([expect.objectContaining({ price: 6046 })])
  })

  it('drops a masked "N/A-" unit number from the address but keeps a real one', async () => {
    const units = flattenApartmentsUnits([SAMPLE_PROPERTY])
    await upsertApifyApartmentsListings([units[0]])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ address: '388 Beale St, San Francisco, CA 94105' })
    ])

    vi.mocked(dedupeAndUpsertListings).mockClear()
    const realUnitNumber = { ...units[0], rental: { ...units[0].rental, unitNumber: '1231' } }
    await upsertApifyApartmentsListings([realUnitNumber])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ address: '388 Beale St, San Francisco, CA 94105, Unit 1231' })
    ])
  })

  it('derives postedAt from the property lastUpdated string, never from the future-dated rental availableDate', async () => {
    const units = flattenApartmentsUnits([SAMPLE_PROPERTY])
    await upsertApifyApartmentsListings([units[0]])
    const call = vi.mocked(dedupeAndUpsertListings).mock.calls[0][0][0]
    // "2 hours ago" relative to whenever the test runs, not the far-future
    // availableDate (2026-07-17/2026-08-06) on the sample rentals.
    expect(call.postedAt).toBeInstanceOf(Date)
    expect((call.postedAt as Date).getTime()).toBeLessThan(Date.now())
    expect((call.postedAt as Date).getTime()).toBeGreaterThan(Date.now() - 3 * 60 * 60 * 1000)
  })

  it('leaves postedAt null (not a guess) for an unrecognized lastUpdated format', async () => {
    const property = { ...SAMPLE_PROPERTY, lastUpdated: 'Yesterday' }
    const units = flattenApartmentsUnits([property])
    await upsertApifyApartmentsListings([units[0]])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([expect.objectContaining({ postedAt: null })])
  })

  it('maps images from the per-unit rental.image field (real Apify shape)', async () => {
    const units = flattenApartmentsUnits([SAMPLE_PROPERTY])
    await upsertApifyApartmentsListings(units)
    const calls = vi.mocked(dedupeAndUpsertListings).mock.calls[0][0]
    expect(calls[0].images).toEqual(['https://images1.apartments.com/i2/V-VbAsRDOYIofVoqaxWdzmPNpOpV6DxcHBRYZMO3aqk/105/image.jpg'])
  })

  it('leaves images as [] (not a guess) when a unit has no image field (confirmed real on some live units)', async () => {
    const noImage = { ...SAMPLE_PROPERTY, rentals: [{ ...SAMPLE_PROPERTY.rentals[0], image: undefined }] }
    const units = flattenApartmentsUnits([noImage])
    await upsertApifyApartmentsListings(units)
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([expect.objectContaining({ images: [] })])
  })

  it('strips the models/rentals arrays out of raw but keeps this row\'s specific rental', async () => {
    const units = flattenApartmentsUnits([SAMPLE_PROPERTY])
    await upsertApifyApartmentsListings([units[0]])
    const call = vi.mocked(dedupeAndUpsertListings).mock.calls[0][0][0]
    const raw = call.raw as Record<string, unknown>
    expect(raw.models).toBeUndefined()
    expect(raw.rentals).toBeUndefined()
    expect(raw.propertyName).toBe('388 Beale')
    expect((raw.rental as { key: string }).key).toBe('gls4r3y')
  })
})

describe('apartmentsPoller handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(claimDailyBudget).mockResolvedValue(true)
  })

  // fetchApartmentsViaApify(step) now makes its own step.run calls
  // internally (start-apify-run -> [poll] -> fetch-apify-dataset) rather
  // than being wrapped in a single outer 'fetch-apartments-apify' step -
  // mock the run already terminal (SUCCEEDED) so these handler-level tests
  // don't need to exercise the poll loop itself (see
  // tests/unit/apifyAsync.test.ts).
  function runStep(overrides: { budget?: boolean; canonicalIds?: string[]; properties?: unknown[] } = {}) {
    const properties = overrides.properties ?? [SAMPLE_PROPERTY]
    const step = {
      run: vi.fn().mockImplementation((name: string, fn: () => unknown) => {
        if (name === 'check-daily-budget') return Promise.resolve(overrides.budget ?? true)
        if (name === 'start-apify-run') return Promise.resolve({ id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' })
        if (name === 'fetch-apify-dataset') return Promise.resolve(properties)
        if (name === 'upsert-listings-chunk-0') {
          return Promise.resolve({
            count: (properties[0] as typeof SAMPLE_PROPERTY)?.rentals?.length ?? 0,
            canonicalIds: overrides.canonicalIds ?? ['1']
          })
        }
        return fn()
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      sendEvent: vi.fn().mockResolvedValue(undefined)
    }
    return step
  }

  it('dispatches trigger-matching when canonicalIds are returned', async () => {
    const step = runStep({ canonicalIds: ['1'] })
    const result = await apartmentsPoller['fn']({ step })
    expect(result).toEqual({ fetched: 2, upserted: 2 })
    expect(step.sendEvent).toHaveBeenCalledWith('trigger-matching', {
      name: 'app/listings.upserted',
      data: { listingIds: ['1'] }
    })
  })

  it('skips sendEvent when no canonicalIds are returned', async () => {
    const step = runStep({ canonicalIds: [] })
    await apartmentsPoller['fn']({ step })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('skips the run entirely when the daily budget is exhausted', async () => {
    const step = runStep({ budget: false })
    const result = await apartmentsPoller['fn']({ step })
    expect(result).toEqual({ skipped: true, reason: 'daily-budget-exceeded' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('does not call step.run for chunking when zero units are flattened (no properties fetched)', async () => {
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

    const result = await apartmentsPoller['fn']({ step })
    expect(result).toEqual({ fetched: 0, upserted: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('does not call step.run for chunking when properties are fetched but none have rentals', async () => {
    const step = {
      run: vi.fn().mockImplementation((name: string) => {
        if (name === 'check-daily-budget') return Promise.resolve(true)
        if (name === 'start-apify-run') return Promise.resolve({ id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' })
        if (name === 'fetch-apify-dataset') return Promise.resolve([{ ...SAMPLE_PROPERTY, rentals: [] }])
        throw new Error(`unexpected step.run call: ${name}`)
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      sendEvent: vi.fn()
    }

    const result = await apartmentsPoller['fn']({ step })
    expect(result).toEqual({ fetched: 0, upserted: 0 })
  })

  it('chunks flattened units into multiple step.run calls when above the chunk size', async () => {
    // 3 properties x 40 rentals each = 120 flattened units; at a 50-item
    // chunk size that's 3 chunks: 50, 50, 20.
    const properties = Array.from({ length: 3 }, (_, p) => ({
      ...SAMPLE_PROPERTY,
      id: `property-${p}`,
      rentals: Array.from({ length: 40 }, (_, r) => ({ ...SAMPLE_PROPERTY.rentals[0], key: `p${p}-r${r}` }))
    }))
    const chunkCalls: string[] = []

    const step = {
      run: vi.fn().mockImplementation((name: string, fn: () => unknown) => {
        if (name === 'check-daily-budget') return Promise.resolve(true)
        if (name === 'start-apify-run') return Promise.resolve({ id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' })
        if (name === 'fetch-apify-dataset') return Promise.resolve(properties)
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

    const result = await apartmentsPoller['fn']({ step })

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
    await expect(apartmentsPoller['fn']({ step })).rejects.toThrow('Test error')
    expect(Sentry.captureException).toHaveBeenCalledWith(error)
    expect(logger.error).toHaveBeenCalledWith({ err: error }, 'Apartments.com (Apify) poller failed')
  })
})
