import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/lib/db'
import { users, criteria, listings, sent } from '@/lib/db/schema'
import { dedupeAndUpsertListings } from '@/lib/listings'
import { findMatchingUsers } from '@/inngest/functions/matchingEngine'
import { sql } from 'drizzle-orm'

describe.skipIf(!process.env.DATABASE_URL)('Core Pipeline Integration', () => {
  beforeEach(async () => {
    // Clear all tables before each test
    await db.execute(sql`TRUNCATE TABLE users, listings CASCADE`)
  })

  it('dedupes: same listing from two sources collapses to one canonical row', async () => {
    const res1 = await dedupeAndUpsertListings([{
      source: 'craigslist',
      sourceId: 'cl-1',
      address: '123 Main St, San Francisco, CA',
      lat: 37.7749,
      lng: -122.4194,
      price: 3000,
      beds: 1,
      baths: 1,
      sqft: 700,
      url: 'http://cl',
      postedAt: new Date(),
      raw: {}
    }])

    expect(res1.count).toBe(1)
    expect(res1.canonicalIds).toHaveLength(1)

    const res2 = await dedupeAndUpsertListings([{
      source: 'rentcast',
      sourceId: 'rc-1',
      address: '123 Main Street',
      // exactly the same lat/lng and price
      lat: 37.7749,
      lng: -122.4194,
      price: 3000,
      beds: 1,
      baths: 1,
      sqft: 700,
      url: 'http://rc',
      postedAt: new Date(),
      raw: {}
    }])

    expect(res2.count).toBe(1)
    // Should NOT produce a new canonical id
    expect(res2.canonicalIds).toHaveLength(0)

    const allListings = await db.select().from(listings).orderBy(listings.source)
    expect(allListings).toHaveLength(2)
    const clListing = allListings.find(l => l.source === 'craigslist')
    const rcListing = allListings.find(l => l.source === 'rentcast')
    
    expect(clListing?.isCanonical).toBe(true)
    expect(rcListing?.isCanonical).toBe(false)
    expect(rcListing?.canonicalId).toBe(clListing?.id)
  })

  it('matches active user with matching criteria', async () => {
    const [user] = await db.insert(users).values({
      phone: '+15550000001',
      status: 'active'
    }).returning()

    await db.insert(criteria).values({
      userId: user.id,
      priceMin: 2000,
      priceMax: 4000,
      bedsMin: 1,
      bedsMax: 2
    })

    const [listing] = await db.insert(listings).values({
      source: 'craigslist',
      sourceId: 'match-1',
      address: '123 Main St, San Francisco, CA',
      price: 3000,
      beds: 1,
      isCanonical: true
    }).returning()

    const matches = await findMatchingUsers(listing)
    expect(matches).toHaveLength(1)
    expect(matches[0].user_id).toBe(user.id)
  })

  it('skips expired user', async () => {
    const [user] = await db.insert(users).values({
      phone: '+15550000002',
      status: 'expired'
    }).returning()

    await db.insert(criteria).values({
      userId: user.id,
      priceMax: 4000
    })

    const [listing] = await db.insert(listings).values({
      source: 'craigslist',
      sourceId: 'match-2',
      address: '123 Main St, San Francisco, CA',
      price: 3000,
      isCanonical: true
    }).returning()

    const matches = await findMatchingUsers(listing)
    expect(matches).toHaveLength(0)
  })

  it('skips done status user', async () => {
    const [user] = await db.insert(users).values({
      phone: '+15550000003',
      status: 'done'
    }).returning()

    await db.insert(criteria).values({
      userId: user.id,
      priceMax: 4000
    })

    const [listing] = await db.insert(listings).values({
      source: 'craigslist',
      sourceId: 'match-3',
      address: '123 Main St, San Francisco, CA',
      price: 3000,
      isCanonical: true
    }).returning()

    const matches = await findMatchingUsers(listing)
    expect(matches).toHaveLength(0)
  })

  it('already-sent listing is not re-sent (idempotency)', async () => {
    const [user] = await db.insert(users).values({
      phone: '+15550000004',
      status: 'active'
    }).returning()

    await db.insert(criteria).values({
      userId: user.id,
      priceMax: 4000
    })

    const [listing] = await db.insert(listings).values({
      source: 'craigslist',
      sourceId: 'match-4',
      address: '123 Main St, San Francisco, CA',
      price: 3000,
      isCanonical: true
    }).returning()

    // simulate previously sent
    await db.insert(sent).values({
      userId: user.id,
      listingId: listing.id
    })

    const matches = await findMatchingUsers(listing)
    expect(matches).toHaveLength(0)
  })

  it('non-matching criteria (price out of range)', async () => {
    const [user] = await db.insert(users).values({
      phone: '+15550000005',
      status: 'active'
    }).returning()

    await db.insert(criteria).values({
      userId: user.id,
      priceMax: 2000 // user wants max 2000
    })

    const [listing] = await db.insert(listings).values({
      source: 'craigslist',
      sourceId: 'match-5',
      address: '123 Main St, San Francisco, CA',
      price: 3000, // listing is 3000
      isCanonical: true
    }).returning()

    const matches = await findMatchingUsers(listing)
    expect(matches).toHaveLength(0)
  })

  it('non-matching criteria (wrong neighborhood)', async () => {
    const [user] = await db.insert(users).values({
      phone: '+15550000006',
      status: 'active'
    }).returning()

    await db.insert(criteria).values({
      userId: user.id,
      neighborhoods: ['Marina', 'Cow Hollow']
    })

    const [listing] = await db.insert(listings).values({
      source: 'craigslist',
      sourceId: 'match-6',
      address: '123 Main St, SOMA, CA', // doesn't include Marina
      price: 3000,
      isCanonical: true
    }).returning()

    const matches = await findMatchingUsers(listing)
    expect(matches).toHaveLength(0)
  })

  it('matching criteria (neighborhood match)', async () => {
    const [user] = await db.insert(users).values({
      phone: '+15550000007',
      status: 'active'
    }).returning()

    await db.insert(criteria).values({
      userId: user.id,
      neighborhoods: ['Marina', 'Cow Hollow']
    })

    const [listing] = await db.insert(listings).values({
      source: 'craigslist',
      sourceId: 'match-7',
      address: '123 Marina Blvd, San Francisco, CA', // includes Marina
      price: 3000,
      isCanonical: true
    }).returning()

    const matches = await findMatchingUsers(listing)
    expect(matches).toHaveLength(1)
    expect(matches[0].user_id).toBe(user.id)
  })

  it('AH-018: matches when the listing pets_allowed satisfies the user pets requirement', async () => {
    const [user] = await db.insert(users).values({
      phone: '+15550000008',
      status: 'active'
    }).returning()

    await db.insert(criteria).values({
      userId: user.id,
      pets: 'cats'
    })

    const [listing] = await db.insert(listings).values({
      source: 'craigslist',
      sourceId: 'match-8',
      address: '123 Main St, San Francisco, CA',
      price: 3000,
      isCanonical: true,
      petsAllowed: 'cats_and_dogs'
    }).returning()

    const matches = await findMatchingUsers(listing)
    expect(matches).toHaveLength(1)
    expect(matches[0].user_id).toBe(user.id)
  })

  it('AH-018: does not match when the listing pets_allowed conflicts with the user pets requirement', async () => {
    const [user] = await db.insert(users).values({
      phone: '+15550000009',
      status: 'active'
    }).returning()

    await db.insert(criteria).values({
      userId: user.id,
      pets: 'dogs'
    })

    const [listing] = await db.insert(listings).values({
      source: 'craigslist',
      sourceId: 'match-9',
      address: '123 Main St, San Francisco, CA',
      price: 3000,
      isCanonical: true,
      petsAllowed: 'cats'
    }).returning()

    const matches = await findMatchingUsers(listing)
    expect(matches).toHaveLength(0)
  })

  it('AH-018: an in-unit-laundry listing satisfies a user who only requires on-site laundry', async () => {
    const [user] = await db.insert(users).values({
      phone: '+15550000010',
      status: 'active'
    }).returning()

    await db.insert(criteria).values({
      userId: user.id,
      laundry: 'on_site'
    })

    const [listing] = await db.insert(listings).values({
      source: 'craigslist',
      sourceId: 'match-10',
      address: '123 Main St, San Francisco, CA',
      price: 3000,
      isCanonical: true,
      laundryType: 'in_unit'
    }).returning()

    const matches = await findMatchingUsers(listing)
    expect(matches).toHaveLength(1)
    expect(matches[0].user_id).toBe(user.id)
  })

  it('AH-018: a hookups-only listing does not satisfy a user who requires in-unit laundry', async () => {
    const [user] = await db.insert(users).values({
      phone: '+15550000011',
      status: 'active'
    }).returning()

    await db.insert(criteria).values({
      userId: user.id,
      laundry: 'in_unit'
    })

    const [listing] = await db.insert(listings).values({
      source: 'craigslist',
      sourceId: 'match-11',
      address: '123 Main St, San Francisco, CA',
      price: 3000,
      isCanonical: true,
      laundryType: 'hookups'
    }).returning()

    const matches = await findMatchingUsers(listing)
    expect(matches).toHaveLength(0)
  })

  it('AH-018: unparsed (null) pets/laundry data on a listing never disqualifies an otherwise-matching user', async () => {
    const [user] = await db.insert(users).values({
      phone: '+15550000012',
      status: 'active'
    }).returning()

    await db.insert(criteria).values({
      userId: user.id,
      pets: 'cats_and_dogs',
      laundry: 'in_unit'
    })

    const [listing] = await db.insert(listings).values({
      source: 'rentcast',
      sourceId: 'match-12',
      address: '123 Main St, San Francisco, CA',
      price: 3000,
      isCanonical: true
      // petsAllowed/laundryType intentionally omitted - null, as RentCast
      // listings always are today (see AH-018 checkpoint).
    }).returning()

    const matches = await findMatchingUsers(listing)
    expect(matches).toHaveLength(1)
    expect(matches[0].user_id).toBe(user.id)
  })
})
