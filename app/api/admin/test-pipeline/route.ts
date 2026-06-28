import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { users, listings, criteria, sent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { sendSMS } from '@/lib/twilio'
import { findMatchingUsers } from '@/inngest/functions/matchingEngine'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const secret = searchParams.get('secret')

  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const testPhone = '+14044446018'
  const sourceId = `test-${Date.now()}`

  try {
    // 1. Clean up any existing test user to start fresh
    await db.delete(users).where(eq(users.phone, testPhone))

    // 2. Create test user & criteria
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

    // 3. Create test listing
    const [listing] = await db.insert(listings).values({
      source: 'test',
      sourceId,
      address: '123 Test St, San Francisco, CA',
      price: 3000,
      beds: 1,
      isCanonical: true, // Need to be canonical to send? The matching engine doesn't filter on isCanonical in the query, but good practice.
    }).returning()

    // 4. Find matching users
    const matched = await findMatchingUsers(listing)
    const isMatched = matched.some((m) => m.user_id === user.id)

    let smsSid = null
    if (isMatched) {
      // 5. Send SMS
      const body = `Test match! 1 BR at 123 Test St, San Francisco, CA for $3000.`
      smsSid = await sendSMS(testPhone, body)

      // 6. Insert sent row
      await db.insert(sent).values({
        userId: user.id,
        listingId: listing.id,
      })
    }

    // 7. Clean up test data
    await db.delete(listings).where(eq(listings.id, listing.id))
    await db.delete(users).where(eq(users.id, user.id)) // Cascades to criteria & sent

    return NextResponse.json({
      success: true,
      listingId: listing.id,
      matchedUserId: isMatched ? user.id : null,
      smsSid
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
