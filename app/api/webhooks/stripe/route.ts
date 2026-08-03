import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'
import { handleStripeWebhookEvent } from '@/lib/billing'
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
    // Subscription lifecycle (activate / renew / expire) lives in lib/billing.ts
    // so the checkout server actions can share the same cancellation logic.
    await handleStripeWebhookEvent(event)
    return NextResponse.json({ received: true })
  } catch (error) {
    Sentry.captureException(error, { extra: { action: 'stripe_webhook_processing', eventType: event.type } })
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

