import { describe, it, expect, vi, beforeEach } from 'vitest'
import { matchingEngine, getTodaysSentCount, findMatchingUsers } from '@/inngest/functions/matchingEngine'
import { listings } from '@/lib/db/schema'
import { StringChunk } from 'drizzle-orm'
import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'

const mockExecute = vi.fn().mockResolvedValue([])
const mockFindMany = vi.fn().mockResolvedValue([])

vi.mock('@/lib/db', () => ({
  db: {
    execute: (...args: unknown[]) => mockExecute(...args),
    query: {
      listings: {
        findMany: (...args: unknown[]) => mockFindMany(...args)
      }
    }
  }
}))

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() }
}))

describe('Matching Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 0 if no listingIds provided', async () => {
    const result = await matchingEngine['fn']({ event: { data: { listingIds: [] } }, step: {} })
    expect(result).toEqual({ matched: 0 })
  })

  it('does not send event if findMany returns empty array', async () => {
    mockFindMany.mockResolvedValueOnce([])
    const mockStep = {
      run: vi.fn((name, fn) => fn()),
      sendEvent: vi.fn()
    }
    const result = await matchingEngine['fn']({ event: { data: { listingIds: ['123'] } }, step: mockStep })
    expect(result).toEqual({ matched: 0 })
    expect(mockStep.sendEvent).not.toHaveBeenCalled()
  })

  it('does not send event if execute returns empty array', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: '123', price: 3000, beds: 2 }])
    mockExecute.mockResolvedValueOnce([])
    const mockStep = {
      run: vi.fn((name, fn) => fn()),
      sendEvent: vi.fn()
    }
    const result = await matchingEngine['fn']({ event: { data: { listingIds: ['123'] } }, step: mockStep })
    expect(result).toEqual({ matched: 0 })
    expect(mockStep.sendEvent).not.toHaveBeenCalled()
  })

  it('fetches listings, finds matching users, and dispatches when under the daily cap', async () => {
    const listingId = '123'
    const userId = '456'

    mockFindMany.mockResolvedValueOnce([{
      id: listingId,
      price: 3000,
      beds: 2
    }])

    // First execute() call: findMatchingUsers - one match, cap of 20.
    mockExecute.mockResolvedValueOnce([
      { user_id: userId, max_daily_sms: 20 }
    ])
    // Second execute() call: getTodaysSentCount - 3 already sent today.
    mockExecute.mockResolvedValueOnce([{ count: 3 }])

    const mockStep = {
      run: vi.fn((name, fn) => fn()),
      sendEvent: vi.fn().mockResolvedValue(undefined)
    }

    const result = await matchingEngine['fn']({
      event: { data: { listingIds: [listingId] } },
      step: mockStep
    })

    expect(result).toEqual({ matched: 1 })
    expect(mockStep.sendEvent).toHaveBeenCalledWith('enqueue-notifications', [
      { name: 'app/notification.send', data: { userId, listingId } }
    ])
  })

  it('skips dispatch for a user who is already at their daily SMS cap', async () => {
    const listingId = '123'
    const userId = '456'

    mockFindMany.mockResolvedValueOnce([{ id: listingId, price: 3000, beds: 2 }])
    mockExecute.mockResolvedValueOnce([{ user_id: userId, max_daily_sms: 5 }])
    // Already sent 5 today - at the cap, not just over it.
    mockExecute.mockResolvedValueOnce([{ count: 5 }])

    const mockStep = {
      run: vi.fn((name, fn) => fn()),
      sendEvent: vi.fn()
    }

    const result = await matchingEngine['fn']({
      event: { data: { listingIds: [listingId] } },
      step: mockStep
    })

    expect(result).toEqual({ matched: 0 })
    expect(mockStep.sendEvent).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ userId, listingId, sentToday: 5, maxDailySms: 5 }),
      'Daily SMS cap reached, skipping dispatch'
    )
  })

  it('dispatches a user up to their cap across multiple matching listings in one run, then stops', async () => {
    const userId = '456'

    // Two listings both match the same user in this run.
    mockFindMany.mockResolvedValueOnce([
      { id: 'listing-a', price: 3000, beds: 2 },
      { id: 'listing-b', price: 3100, beds: 2 }
    ])

    // findMatchingUsers for listing-a
    mockExecute.mockResolvedValueOnce([{ user_id: userId, max_daily_sms: 2 }])
    // getTodaysSentCount for userId - 1 already sent today (only queried once,
    // then tracked in-memory for the rest of this run).
    mockExecute.mockResolvedValueOnce([{ count: 1 }])
    // findMatchingUsers for listing-b - same user matches again.
    mockExecute.mockResolvedValueOnce([{ user_id: userId, max_daily_sms: 2 }])

    const mockStep = {
      run: vi.fn((name, fn) => fn()),
      sendEvent: vi.fn().mockResolvedValue(undefined)
    }

    const result = await matchingEngine['fn']({
      event: { data: { listingIds: ['listing-a', 'listing-b'] } },
      step: mockStep
    })

    // listing-a dispatch brings the in-run tally to 2 (cap), so listing-b is
    // skipped without a third getTodaysSentCount query.
    expect(result).toEqual({ matched: 1 })
    expect(mockExecute).toHaveBeenCalledTimes(3)
    expect(mockStep.sendEvent).toHaveBeenCalledWith('enqueue-notifications', [
      { name: 'app/notification.send', data: { userId, listingId: 'listing-a' } }
    ])
  })

  it('handles and logs errors properly', async () => {
    const error = new Error('Test error')
    mockFindMany.mockRejectedValueOnce(error)

    const mockStep = {
      run: vi.fn((name, fn) => fn()),
    }

    await expect(matchingEngine['fn']({
      event: { data: { listingIds: ['123'] } },
      step: mockStep
    })).rejects.toThrow('Test error')

    expect(Sentry.captureException).toHaveBeenCalledWith(error)
    expect(logger.error).toHaveBeenCalledWith({ err: error, listingIds: ['123'] }, 'Matching engine failed')
  })
})

describe('findMatchingUsers - AH-018 pets/laundry filter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function buildListing(overrides: Partial<typeof listings.$inferSelect> = {}): typeof listings.$inferSelect {
    return {
      id: 'listing-1',
      source: 'craigslist',
      sourceId: 'src-1',
      address: '123 Main St, San Francisco, CA',
      lat: 37.77,
      lng: -122.41,
      price: 3000,
      beds: 2,
      baths: 1,
      sqft: 900,
      url: null,
      postedAt: null,
      firstSeenAt: new Date('2026-07-16T00:00:00Z'),
      isCanonical: true,
      canonicalId: null,
      raw: null,
      petsAllowed: null,
      laundryType: null,
      amenities: null,
      images: null,
      ...overrides
    }
  }

  // The `SQL` object drizzle-orm's `sql` tagged template produces stores its
  // template-literal parts as `StringChunk` instances and every interpolated
  // JS value inline (in order) in `.queryChunks`. Filtering out the
  // StringChunks leaves exactly the bound values, in the exact order they
  // were interpolated - which lets these tests assert the real query the
  // matching engine builds, not just that db.execute() was called.
  function extractInterpolatedValues(sqlObj: unknown): unknown[] {
    const chunks = (sqlObj as { queryChunks: unknown[] }).queryChunks
    return chunks.filter((c) => !(c instanceof StringChunk))
  }

  it('threads listing.petsAllowed and listing.laundryType into the query as bound params, in order', async () => {
    mockExecute.mockResolvedValueOnce([])
    const listing = buildListing({ petsAllowed: 'cats_and_dogs', laundryType: 'in_unit' })

    await findMatchingUsers(listing)

    expect(mockExecute).toHaveBeenCalledTimes(1)
    const values = extractInterpolatedValues(mockExecute.mock.calls[0][0])
    // Order per the query in matchingEngine.ts: listing.id, price (x4 - the
    // min and max checks each interpolate it twice), beds (x4, same
    // reason), petsAllowed (x3), laundryType (x3), address (x2).
    expect(values).toEqual([
      'listing-1',
      3000, 3000, 3000, 3000,
      2, 2, 2, 2,
      'cats_and_dogs', 'cats_and_dogs', 'cats_and_dogs',
      'in_unit', 'in_unit', 'in_unit',
      '123 Main St, San Francisco, CA', '123 Main St, San Francisco, CA'
    ])
  })

  it('threads null petsAllowed/laundryType through when the listing has no parsed value', async () => {
    mockExecute.mockResolvedValueOnce([])
    const listing = buildListing({ petsAllowed: null, laundryType: null })

    await findMatchingUsers(listing)

    const values = extractInterpolatedValues(mockExecute.mock.calls[0][0])
    // Index 9,10,11 = petsAllowed (x3); 12,13,14 = laundryType (x3) - see
    // the index layout asserted explicitly in the previous test.
    expect(values[9]).toBeNull()
    expect(values[10]).toBeNull()
    expect(values[11]).toBeNull()
    expect(values[12]).toBeNull()
    expect(values[13]).toBeNull()
    expect(values[14]).toBeNull()
  })

  it('returns rows from db.execute unchanged regardless of pets/laundry values (filtering itself happens in Postgres, not JS)', async () => {
    mockExecute.mockResolvedValueOnce([{ user_id: 'u1', max_daily_sms: 20 }])
    const listing = buildListing({ petsAllowed: 'dogs', laundryType: 'on_site' })

    const result = await findMatchingUsers(listing)

    expect(result).toEqual([{ user_id: 'u1', max_daily_sms: 20 }])
  })
})

describe('findMatchingUsers - AH-017 commute filter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function buildListing(overrides: Partial<typeof listings.$inferSelect> = {}): typeof listings.$inferSelect {
    return {
      id: 'listing-1',
      source: 'craigslist',
      sourceId: 'src-1',
      address: '123 Main St, San Francisco, CA',
      lat: 37.77,
      lng: -122.41,
      price: 3000,
      beds: 2,
      baths: 1,
      sqft: 900,
      url: null,
      postedAt: null,
      firstSeenAt: new Date('2026-07-16T00:00:00Z'),
      isCanonical: true,
      canonicalId: null,
      raw: null,
      petsAllowed: null,
      laundryType: null,
      amenities: null,
      images: null,
      ...overrides
    }
  }

  // A polygon that covers the buildListing() default coordinates (lat 37.77,
  // lng -122.41) but not a point far outside SF.
  const coveringIsochrone = {
    center: { lat: 37.77, lng: -122.41 },
    mode: 'drive',
    maxMinutes: 30,
    mapboxProfile: 'driving',
    effectiveMinutes: 30,
    computedAt: '2026-07-16T00:00:00.000Z',
    approximate: false,
    polygon: {
      type: 'Polygon',
      coordinates: [[[-123, 37], [-121, 37], [-121, 38], [-123, 38], [-123, 37]]]
    }
  }

  const nonCoveringIsochrone = {
    ...coveringIsochrone,
    polygon: {
      type: 'Polygon',
      coordinates: [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]]
    }
  }

  it('includes a user with no commute isochrone set (null passthrough)', async () => {
    mockExecute.mockResolvedValueOnce([{ user_id: 'u1', max_daily_sms: 20, commute_isochrone: null }])
    const result = await findMatchingUsers(buildListing())
    expect(result).toEqual([{ user_id: 'u1', max_daily_sms: 20 }])
  })

  it('includes a user whose cached isochrone covers the listing coordinates', async () => {
    mockExecute.mockResolvedValueOnce([{ user_id: 'u1', max_daily_sms: 20, commute_isochrone: coveringIsochrone }])
    const result = await findMatchingUsers(buildListing({ lat: 37.77, lng: -122.41 }))
    expect(result).toEqual([{ user_id: 'u1', max_daily_sms: 20 }])
  })

  it('excludes a user whose cached isochrone does not cover the listing coordinates', async () => {
    mockExecute.mockResolvedValueOnce([{ user_id: 'u1', max_daily_sms: 20, commute_isochrone: nonCoveringIsochrone }])
    const result = await findMatchingUsers(buildListing({ lat: 37.77, lng: -122.41 }))
    expect(result).toEqual([])
  })

  it('does not exclude a user with a commute isochrone when the listing has no coordinates', async () => {
    mockExecute.mockResolvedValueOnce([{ user_id: 'u1', max_daily_sms: 20, commute_isochrone: nonCoveringIsochrone }])
    const result = await findMatchingUsers(buildListing({ lat: null, lng: null }))
    expect(result).toEqual([{ user_id: 'u1', max_daily_sms: 20 }])
  })

  it('applies the commute filter independently per candidate row in the same query result', async () => {
    mockExecute.mockResolvedValueOnce([
      { user_id: 'in-zone', max_daily_sms: 20, commute_isochrone: coveringIsochrone },
      { user_id: 'out-of-zone', max_daily_sms: 20, commute_isochrone: nonCoveringIsochrone },
      { user_id: 'no-commute-filter', max_daily_sms: 20, commute_isochrone: null }
    ])
    const result = await findMatchingUsers(buildListing({ lat: 37.77, lng: -122.41 }))
    expect(result.map((r) => r.user_id).sort()).toEqual(['in-zone', 'no-commute-filter'])
  })
})

describe('getTodaysSentCount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the count from the query result', async () => {
    mockExecute.mockResolvedValueOnce([{ count: 7 }])
    const count = await getTodaysSentCount('user-1', new Date('2026-07-16T20:00:00Z'))
    expect(count).toBe(7)
  })

  it('defaults to 0 when the query returns no rows', async () => {
    mockExecute.mockResolvedValueOnce([])
    const count = await getTodaysSentCount('user-1', new Date('2026-07-16T20:00:00Z'))
    expect(count).toBe(0)
  })
})
