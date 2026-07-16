import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createTwilioClient } from '@/lib/twilio'
import { normalizePhoneE164 } from '@/lib/phone'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { db } from '@/lib/db'
import { users, criteria } from '@/lib/db/schema'

const verifyOtpSchema = z.object({
  phone: z.string().min(10),
  code: z.string().length(6),
  criteria: z.object({
    priceMin: z.coerce.number().optional(),
    priceMax: z.coerce.number().optional(),
    bedsMin: z.coerce.number().optional(),
    bedsMax: z.coerce.number().optional(),
    zips: z.array(z.string()).optional(),
    neighborhoods: z.array(z.string()).optional(),
  })
})

export async function POST(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`verify-otp-${ip}`)
    if (!rateLimit.success) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

    const body = await req.json()
    const { phone: rawPhone, code, criteria: userCriteria } = verifyOtpSchema.parse(body)
    // Must match the exact E.164 string send-otp texted the code to, and is
    // also what we persist on the user record for future SMS listing alerts.
    const phone = normalizePhoneE164(rawPhone)

    const twilioClient = createTwilioClient()
    const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID

    if (!verifyServiceSid) {
      logger.warn('TWILIO_VERIFY_SERVICE_SID is missing, accepting any code in dev mode')
      if (code !== '000000') { // Let's use 000000 as a dev override code
        return NextResponse.json({ error: 'Invalid OTP code (dev mode expects 000000)' }, { status: 400 })
      }
    } else {
      const verification = await twilioClient.verify.v2
        .services(verifyServiceSid)
        .verificationChecks.create({ to: phone, code })

      if (verification.status !== 'approved') {
        return NextResponse.json({ error: 'Invalid OTP code' }, { status: 400 })
      }
    }

    // Only include criteria keys that were actually provided. An empty object
    // would make the ON CONFLICT DO UPDATE below a `SET` with no assignments,
    // which Postgres rejects with a syntax error.
    const criteriaValues = Object.fromEntries(
      Object.entries(userCriteria).filter(([, v]) => v !== undefined)
    )

    // Insert user and criteria inside a transaction
    const result = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          phone,
          status: 'pending_payment',
        })
        .onConflictDoUpdate({
          target: users.phone,
          set: {
            status: 'pending_payment'
          }
        })
        .returning()

      if (Object.keys(criteriaValues).length > 0) {
        await tx
          .insert(criteria)
          .values({
            userId: user.id,
            ...criteriaValues
          })
          .onConflictDoUpdate({
            target: criteria.userId,
            set: criteriaValues
          })
      } else {
        // No criteria provided (e.g. user only entered a phone). Ensure a
        // criteria row exists but don't attempt an empty UPDATE.
        await tx
          .insert(criteria)
          .values({ userId: user.id })
          .onConflictDoNothing()
      }

      return user
    })

    logger.info({ userId: result.id }, 'User verified via OTP')
    
    // Set secure session cookie
    const cookieStore = await cookies()
    cookieStore.set('session', result.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30 // 30 days
    })
    
    return NextResponse.json({ success: true, userId: result.id })
  } catch (error) {
    const err = error as { message?: string; code?: string | number; detail?: string; status?: number }
    Sentry.captureException(error)
    logger.error(
      {
        verifyError: {
          message: err?.message,
          code: err?.code,
          detail: err?.detail,
          status: err?.status,
          name: (error as Error)?.name,
        },
      },
      'Failed to verify OTP'
    )
    return NextResponse.json({ error: 'Failed to verify OTP' }, { status: 500 })
  }
}
