import { NextResponse } from 'next/server'
import twilio from 'twilio'
import { z } from 'zod'
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
    const { phone, code, criteria: userCriteria } = verifyOtpSchema.parse(body)

    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
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

      await tx
        .insert(criteria)
        .values({
          userId: user.id,
          ...userCriteria
        })
        .onConflictDoUpdate({
          target: criteria.userId,
          set: {
            ...userCriteria
          }
        })

      return user
    })

    logger.info({ userId: result.id }, 'User verified via OTP')
    
    return NextResponse.json({ success: true, userId: result.id })
  } catch (error) {
    Sentry.captureException(error)
    logger.error({ error }, 'Failed to verify OTP')
    return NextResponse.json({ error: 'Failed to verify OTP' }, { status: 500 })
  }
}
