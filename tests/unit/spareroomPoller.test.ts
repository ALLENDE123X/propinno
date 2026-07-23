import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchSpareRoomViaApify,
  upsertApifySpareRoomListings,
  spareroomPoller
} from '@/inngest/functions/spareroomPoller'
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

// Shape mirrors a real dataset item returned by memo23/spareroom-scraper
// during a live test call against a real, pre-resolved San Francisco search
// URL (2026-07-17) - a single-room "rooms for rent" ad, the common case.
const SAMPLE_ITEM = {
  advert_id: '103147980',
  ad_title: 'Room with Ensuite Full Bathroom in 908 Coliving',
  neighbourhood_name: 'Russian Hill',
  postcode: '94133',
  latitude: '37.7973831',
  longitude: '-122.4125481',
  min_rent: '4300',
  available_as_whole_property: 'N',
  rooms_in_property: '12',
  rooms: [
    { room_status: 'available', room_type: 'double', room_price: '4300', ensuite: 'Y' }
  ],
  basicInfo: {
    id: '103147980',
    url: 'https://www.spareroom.com/roommate/room_for_rent.pl?flatshare_id=103147980&search_id=500087007475&',
    neighbourhood: 'Russian Hill',
    postcode: '94133',
    daysOld: '1'
  },
  photos: [
    { large_url: 'https://photos.spareroom.com/images/flatshare/listings/large/21/10/211079791.jpg' },
    { large_url: 'https://photos.spareroom.com/images/flatshare/listings/large/21/10/211079801.jpg' }
  ]
}

// A step.run/step.sleep mock that just executes the callback / resolves
// immediately - runApifyActorAsync's own poll-loop mechanics are covered
// exhaustively in tests/unit/apifyAsync.test.ts; this file only needs to
// confirm fetchSpareRoomViaApify wires the right actor ID + input body into
// that shared helper.
function makePassthroughStep() {
  return {
    run: vi.fn((_name: string, fn: () => unknown) => Promise.resolve(fn())),
    sleep: vi.fn().mockResolvedValue(undefined)
  }
}

describe('fetchSpareRoomViaApify', () => {
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
    await expect(fetchSpareRoomViaApify(makePassthroughStep())).rejects.toThrow('APIFY_API_TOKEN')
  })

  it('throws when starting the Apify run returns a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockResolvedValue('Server error') })
    await expect(fetchSpareRoomViaApify(makePassthroughStep())).rejects.toThrow(
      'Apify start-run for memo23~spareroom-scraper returned 500'
    )
  })

  it('starts the run with a pre-resolved SF search URL (not a bare city name), then returns the dataset items once SUCCEEDED', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1' } })
      })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([SAMPLE_ITEM]) })

    const items = await fetchSpareRoomViaApify(makePassthroughStep())
    expect(items).toEqual([SAMPLE_ITEM])

    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.apify.com/v2/acts/memo23~spareroom-scraper/runs?token=test-token')
    const body = JSON.parse(options.body)
    expect(body.startUrls).toEqual(['https://www.spareroom.com/roommate/?search_id=500087007475&'])
  })
})

describe('upsertApifySpareRoomListings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns { count: 0, canonicalIds: [] } for empty array without calling dedupe', async () => {
    expect(await upsertApifySpareRoomListings([])).toEqual({ count: 0, canonicalIds: [] })
    expect(dedupeAndUpsertListings).not.toHaveBeenCalled()
  })

  it('maps Apify fields onto the shared listing shape', async () => {
    const result = await upsertApifySpareRoomListings([SAMPLE_ITEM])
    expect(result).toEqual({ count: 1, canonicalIds: ['1'] })
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({
        source: 'spareroom',
        sourceId: '103147980',
        price: 4300,
        lat: 37.7973831,
        lng: -122.4125481,
        sqft: null,
        url: SAMPLE_ITEM.basicInfo.url,
        address: 'Russian Hill, 94133, San Francisco, CA'
      })
    ])
  })

  it('maps beds to 1 (the single room being rented, not rooms_in_property) for a single-room ad', async () => {
    await upsertApifySpareRoomListings([SAMPLE_ITEM])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ beds: 1 })
    ])
  })

  it('maps beds to rooms_in_property for a whole-property ad', async () => {
    const item = { ...SAMPLE_ITEM, id: 'whole-property', available_as_whole_property: 'Y', rooms_in_property: '3' }
    await upsertApifySpareRoomListings([item])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ beds: 3 })
    ])
  })

  it('maps baths to 1 when the room has an ensuite, null otherwise (not a guessed total)', async () => {
    await upsertApifySpareRoomListings([SAMPLE_ITEM])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ baths: 1 })
    ])

    const noEnsuite = { ...SAMPLE_ITEM, rooms: [{ ...SAMPLE_ITEM.rooms[0], ensuite: 'N' }] }
    await upsertApifySpareRoomListings([noEnsuite])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ baths: null })
    ])
  })

  it('derives postedAt from basicInfo.daysOld (day-granularity approximation)', async () => {
    const before = Date.now()
    await upsertApifySpareRoomListings([SAMPLE_ITEM])
    const call = vi.mocked(dedupeAndUpsertListings).mock.calls[0][0][0]
    expect(call.postedAt).toBeInstanceOf(Date)
    const expectedMs = before - 1 * 24 * 60 * 60 * 1000
    expect(Math.abs((call.postedAt as Date).getTime() - expectedMs)).toBeLessThan(5000)
  })

  it('leaves postedAt null when daysOld is absent', async () => {
    const item = { ...SAMPLE_ITEM, basicInfo: { ...SAMPLE_ITEM.basicInfo, daysOld: undefined } }
    await upsertApifySpareRoomListings([item])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ postedAt: null })
    ])
  })

  it('maps images from photos[].large_url (real Apify shape)', async () => {
    await upsertApifySpareRoomListings([SAMPLE_ITEM])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({
        images: [
          'https://photos.spareroom.com/images/flatshare/listings/large/21/10/211079791.jpg',
          'https://photos.spareroom.com/images/flatshare/listings/large/21/10/211079801.jpg'
        ]
      })
    ])
  })

  it('leaves images as [] (not a guess) when photos is absent', async () => {
    const item = { ...SAMPLE_ITEM, photos: undefined }
    await upsertApifySpareRoomListings([item])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ images: [] })
    ])
  })

  it('falls back to a bare San Francisco, CA address when neighbourhood/postcode are both absent', async () => {
    const item = { ...SAMPLE_ITEM, neighbourhood_name: null, postcode: null }
    await upsertApifySpareRoomListings([item])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ address: 'San Francisco, CA' })
    ])
  })

  it('does not duplicate "San Francisco" when neighbourhood_name is literally the city name (real Apify quirk)', async () => {
    const item = { ...SAMPLE_ITEM, neighbourhood_name: 'San Francisco', postcode: '94103' }
    await upsertApifySpareRoomListings([item])
    expect(dedupeAndUpsertListings).toHaveBeenCalledWith([
      expect.objectContaining({ address: '94103, San Francisco, CA' })
    ])
  })
})

describe('spareroomPoller handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(claimDailyBudget).mockResolvedValue(true)
  })

  // fetchSpareRoomViaApify(step) now makes its own step.run calls
  // internally (start-apify-run -> [poll] -> fetch-apify-dataset) rather
  // than being wrapped in a single outer 'fetch-spareroom-apify' step -
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
    const result = await spareroomPoller['fn']({ step })
    expect(result).toEqual({ fetched: 1, upserted: 1 })
    expect(step.sendEvent).toHaveBeenCalledWith('trigger-matching', {
      name: 'app/listings.upserted',
      data: { listingIds: ['1'] }
    })
  })

  it('skips sendEvent when no canonicalIds are returned', async () => {
    const step = runStep({ canonicalIds: [] })
    await spareroomPoller['fn']({ step })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('skips the run entirely when the daily budget is exhausted', async () => {
    const step = runStep({ budget: false })
    const result = await spareroomPoller['fn']({ step })
    expect(result).toEqual({ skipped: true, reason: 'daily-budget-exceeded' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('chunks results into multiple step.run calls when above the chunk size', async () => {
    // 120 items at a 50-item chunk size should produce 3 chunks: 50, 50, 20.
    const items = Array.from({ length: 120 }, (_, i) => ({ ...SAMPLE_ITEM, advert_id: `item-${i}` }))
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

    const result = await spareroomPoller['fn']({ step })

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
    await expect(spareroomPoller['fn']({ step })).rejects.toThrow('Test error')
    expect(Sentry.captureException).toHaveBeenCalledWith(error)
    expect(logger.error).toHaveBeenCalledWith({ err: error }, 'SpareRoom (Apify) poller failed')
  })
})
