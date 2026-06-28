import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'

async function handleWebhookEvent(event: Stripe.Event) {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session
    const userId = session.client_reference_id
    if (userId) {
      const plan = session.metadata?.plan as 'pass_30' | 'pass_90' | undefined
      const days = plan === 'pass_90' ? 90 : 30
      
      const accessExpiresAt = new Date()
      accessExpiresAt.setDate(accessExpiresAt.getDate() + days)

      await db.update(users).set({
        status: 'active',
        plan: plan || 'pass_30',
        accessExpiresAt,
      }).where(eq(users.id, userId))
      logger.info({ userId, plan, action: 'stripe_checkout_completed' })
    }
  }
}

import { limitRequest } from '@/lib/ratelimit'

export async function POST(req: Request) {
  const { success } = await limitRequest('stripe-webhook')
  if (!success) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  const body = await req.text()
  const signature = req.headers.get('stripe-signature')

  if (!signature || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Missing signature or secret' }, { status: 400 })
  }

  let event: Stripe.Event

  try {
    const { stripe } = await import('@/lib/stripe')
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err: unknown) {
    const error = err as Error
    Sentry.captureException(error, { extra: { action: 'stripe_webhook_verification' } })
    logger.error({ action: 'stripe_webhook_error', error: error.message })
    return NextResponse.json({ error: `Webhook Error: ${error.message}` }, { status: 400 })
  }

  try {
    await handleWebhookEvent(event)
    return NextResponse.json({ received: true })
  } catch (error) {
    Sentry.captureException(error, { extra: { action: 'stripe_webhook_processing', eventType: event.type } })
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

