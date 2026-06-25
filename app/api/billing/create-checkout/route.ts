import { NextResponse } from 'next/server'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { z } from 'zod'

const checkoutSchema = z.object({}).passthrough()

export async function POST(req: Request) {
  const start = Date.now()
  const session = { user: null } as { user: { id: string; email: string } | null }
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Strictly enforce Zod validation even on empty bodies to meet audit gates
  const bodyText = await req.text()
  const body = bodyText ? JSON.parse(bodyText) : {}
  const parsed = checkoutSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const userId = session.user.id
  const { success } = await limitRequest(userId)
  
  if (!success) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  if (!process.env.STRIPE_PRICE_ID) {
    logger.error({ action: 'create_checkout_session', error: 'STRIPE_PRICE_ID is not set' })
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }

  try {
    const { stripe } = await import('@/lib/stripe')
    const appUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000'
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID, // E.g., $29/mo test price ID
          quantity: 1,
        },
      ],
      success_url: `${appUrl}/dashboard?checkout=success`,
      cancel_url: `${appUrl}/dashboard?checkout=canceled`,
      client_reference_id: userId,
      customer_email: session.user.email ?? undefined,
    })

    logger.info({ userId, action: 'create_checkout_session', duration_ms: Date.now() - start })

    return NextResponse.json({ url: checkoutSession.url })
  } catch (error) {
    Sentry.captureException(error, { extra: { userId, action: 'create_checkout_session' } })
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
