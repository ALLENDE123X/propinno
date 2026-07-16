import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createTwilioClient } from '@/lib/twilio'
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

    const twilioClient = createTwilioClient()
    const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID

    if (!verifyServiceSid) {
      logger.warn('TWILIO_VERIFY_SERVICE_SID is missing, skipping actual SMS send (development mode)')
      return NextResponse.json({ success: true, devMode: true })
    }

    await twilioClient.verify.v2
      .services(verifyServiceSid)
      .verifications.create({ to: phone, channel: 'sms' })

    logger.info({ phone }, 'Sent OTP')

    return NextResponse.json({ success: true })
  } catch (error) {
    // Twilio RestException stores status/code/message on non-enumerable
    // props, so a bare {error} logs as {} - pull them out explicitly so we
    // can actually see what's failing.
    const err = error as { message?: string; status?: number; code?: number; moreInfo?: string }
    const details = {
      message: err?.message,
      status: err?.status,
      code: err?.code,
      moreInfo: err?.moreInfo,
      name: (error as Error)?.name,
    }
    Sentry.captureException(error)
    logger.error({ twilioError: details }, 'Failed to send OTP')
    return NextResponse.json({ error: 'Failed to send OTP' }, { status: 500 })
  }
}
