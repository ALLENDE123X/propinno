import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { users, listings, criteria, sent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { sendSMS } from '@/lib/twilio'
import { findMatchingUsers } from '@/inngest/functions/matchingEngine'
import * as Sentry from '@sentry/nextjs'
import { limitRequest } from '@/lib/ratelimit'

async function setupTestData(testPhone: string, sourceId: string) {
  await db.delete(users).where(eq(users.phone, testPhone))
  
  const [user] = await db.insert(users).values({
    phone: testPhone,
    status: 'active',
  }).returning()

  await db.insert(criteria).values({
    userId: user.id,
    priceMax: 3500,
    bedsMin: 1,
    bedsMax: 1,
  })

  const [listing] = await db.insert(listings).values({
    source: 'test',
    sourceId,
    address: '123 Test St, San Francisco, CA',
    price: 3000,
    beds: 1,
    isCanonical: true,
  }).returning()

  return { user, listing }
}

async function cleanupTestData(userId: string, listingId: string) {
  await db.delete(listings).where(eq(listings.id, listingId))
  await db.delete(users).where(eq(users.id, userId))
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const secret = searchParams.get('secret')

  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ip = request.headers.get('x-forwarded-for') || '127.0.0.1'
  const rateLimit = await limitRequest(ip)
  if (!rateLimit.success) {
    return NextResponse.json({ error: 'Too Many Requests' }, { status: 429 })
  }

  const testPhone = process.env.ADMIN_PHONE || '+14044446018'
  const sourceId = `test-${Date.now()}`

  try {
    const { user, listing } = await setupTestData(testPhone, sourceId)

    const matched = await findMatchingUsers(listing)
    const isMatched = matched.some((m) => m.user_id === user.id)

    let smsSid = null
    if (isMatched) {
      smsSid = await sendSMS(testPhone, `Test match! 1 BR at 123 Test St, San Francisco, CA for $3000.`)
      await db.insert(sent).values({ userId: user.id, listingId: listing.id })
    }

    await cleanupTestData(user.id, listing.id)

    return NextResponse.json({
      success: true,
      listingId: listing.id,
      matchedUserId: isMatched ? user.id : null,
      smsSid
    })
  } catch (error: unknown) {
    Sentry.captureException(error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
