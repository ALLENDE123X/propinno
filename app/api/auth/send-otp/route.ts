import { NextResponse } from 'next/server'
import { z } from 'zod'
import { twilioClient } from '@/lib/twilio'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'

const sendOtpSchema = z.object({
  phone: z.string().min(10)
})

export async function POST(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`send-otp-${ip}`)
    if (!rateLimit.success) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

    const body = await req.json()
    const { phone } = sendOtpSchema.parse(body)

    const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID

    if (!twilioClient || !verifyServiceSid) {
      logger.warn('Twilio client or TWILIO_VERIFY_SERVICE_SID missing, skipping actual SMS send (development mode)')
      return NextResponse.json({ success: true, devMode: true })
    }

    await twilioClient.verify.v2
      .services(verifyServiceSid)
      .verifications.create({ to: phone, channel: 'sms' })

    logger.info({ phone }, 'Sent OTP')

    return NextResponse.json({ success: true })
  } catch (error) {
    Sentry.captureException(error)
    logger.error({ error }, 'Failed to send OTP')
    return NextResponse.json({ error: 'Failed to send OTP' }, { status: 500 })
  }
}
