import { NextResponse } from 'next/server'
import { z } from 'zod'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { parseCriteriaFromText } from '@/lib/nlpCriteria'

// AH-020. Public (pre-auth) route - called from the onboarding page before a
// user/session exists, same trust tier as /api/auth/send-otp. Rate-limited
// per-IP like the other public onboarding routes to bound cost, since each
// call spends a Claude API request.
const requestSchema = z.object({
  description: z.string().trim().min(3, 'Please describe what you\'re looking for').max(1000),
})

const REASON_STATUS: Record<'not_configured' | 'invalid_response' | 'api_error', number> = {
  not_configured: 503,
  invalid_response: 422,
  api_error: 502,
}

export async function POST(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`parse-criteria-${ip}`)
    if (!rateLimit.success) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

    const body = await req.json()
    const { description } = requestSchema.parse(body)

    const result = await parseCriteriaFromText(description)
    if (!result.success) {
      return NextResponse.json(
        { error: result.message, reason: result.reason },
        { status: REASON_STATUS[result.reason] }
      )
    }

    return NextResponse.json({ criteria: result.data })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message || 'Invalid input' }, { status: 400 })
    }
    Sentry.captureException(error)
    logger.error({ err: error }, 'Failed to handle parse-criteria request')
    return NextResponse.json({ error: 'Failed to parse your description. Please try again.' }, { status: 500 })
  }
}
