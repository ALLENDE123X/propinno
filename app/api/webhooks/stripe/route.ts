import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'

async function handleWebhookEvent(event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      const userId = session.client_reference_id
      if (userId) {
        await db.update(users).set({
          stripeSubscriptionStatus: 'active',
          stripeCustomerId: session.customer as string,
          stripeSubscriptionId: session.subscription as string,
        }).where(eq(users.id, userId))
        logger.info({ userId, action: 'stripe_subscription_active' })
      }
      break
    }
    case 'customer.subscription.created': {
      const subscription = event.data.object as Stripe.Subscription
      await db.update(users).set({
        stripeSubscriptionStatus: subscription.status,
      }).where(eq(users.stripeSubscriptionId, subscription.id))
      logger.info({ action: 'stripe_subscription_created', subscriptionId: subscription.id, status: subscription.status })
      break
    }
    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription
      await db.update(users).set({
        stripeSubscriptionStatus: subscription.status,
      }).where(eq(users.stripeSubscriptionId, subscription.id))
      logger.info({ action: 'stripe_subscription_updated', subscriptionId: subscription.id, status: subscription.status })
      break
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription
      await db.update(users).set({
        stripeSubscriptionStatus: 'canceled',
      }).where(eq(users.stripeSubscriptionId, subscription.id))
      logger.info({ action: 'stripe_subscription_canceled', subscriptionId: subscription.id })
      break
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as unknown as Record<string, unknown>
      const subscription = invoice.subscription as string | { id: string } | null
      const subscriptionId = typeof subscription === 'string' ? subscription : subscription?.id

      if (subscriptionId) {
        await db.update(users).set({
          stripeSubscriptionStatus: 'past_due',
        }).where(eq(users.stripeSubscriptionId, subscriptionId))
        logger.info({ action: 'stripe_payment_failed', subscriptionId })
      }
      break
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

