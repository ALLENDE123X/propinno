"use server"

import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { stripe } from "@/lib/stripe"
import { cancelStripeSubscription } from "@/lib/billing"
import { headers, cookies } from "next/headers"
import * as Sentry from '@sentry/nextjs'
import { logger } from "@/lib/logger"
import { z } from "zod"
import { limitRequest } from "@/lib/ratelimit"

const userIdSchema = z.string().uuid()
const checkoutSchema = z.object({
  plan: z.enum(['pass_30', 'pass_90'])
})

async function getSessionUserId() {
  const cookieStore = await cookies()
  const session = cookieStore.get('session')?.value
  if (!session) return null
  try {
    return userIdSchema.parse(session)
  } catch {
    return null
  }
}

export async function getUserStatus() {
  try {
    const ip = (await headers()).get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`getUserStatus-${ip}`)
    if (!rateLimit.success) throw new Error("Too many requests")

    const validId = await getSessionUserId()
    if (!validId) return null

    const [user] = await db.select({
      id: users.id,
      status: users.status,
      plan: users.plan,
      accessExpiresAt: users.accessExpiresAt,
      createdAt: users.createdAt
    }).from(users).where(eq(users.id, validId))
    
    return user || null
  } catch (err) {
    logger.error({ err }, 'getUserStatus failed')
    Sentry.captureException(err, { extra: { action: 'getUserStatus' } })
    return null
  }
}

/**
 * "I found a place (Cancel & stop texts)".
 *
 * Under the old one-time-pass model this only had to flip status to 'done' —
 * there were no future charges to stop. Under recurring billing it MUST also
 * cancel the Stripe subscription, or the user keeps getting charged every
 * period after explicitly telling the product they no longer want it.
 *
 * Ordering is deliberate: cancel at Stripe FIRST, mark 'done' only afterwards.
 * If the cancellation fails we surface an error and leave the user 'active'
 * rather than recording a state that claims billing stopped when it didn't —
 * the action is idempotent, so retrying is safe and is the correct recovery.
 */
export async function markFoundPlace() {
  let cancelFailed = false
  try {
    const ip = (await headers()).get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`markFoundPlace-${ip}`)
    if (!rateLimit.success) throw new Error("Too many requests")

    const validId = await getSessionUserId()
    if (!validId) throw new Error("Unauthorized")

    const [user] = await db.select({
      id: users.id,
      stripeSubscriptionId: users.stripeSubscriptionId,
    }).from(users).where(eq(users.id, validId))
    if (!user) throw new Error("Unauthorized")

    if (user.stripeSubscriptionId) {
      try {
        await cancelStripeSubscription(user.stripeSubscriptionId)
        logger.info({ userId: validId, subscriptionId: user.stripeSubscriptionId, action: 'stripe_subscription_canceled' })
      } catch (err) {
        cancelFailed = true
        throw err
      }
    }

    await db.update(users).set({
      status: 'done',
      stripeSubscriptionId: null,
    }).where(eq(users.id, validId))
    logger.info({ userId: validId, action: 'found_place_marked_done' })
    return { success: true }
  } catch (err) {
    logger.error({ err, cancelFailed }, 'markFoundPlace failed')
    Sentry.captureException(err, { extra: { action: 'markFoundPlace', cancelFailed } })
    if (cancelFailed) {
      throw new Error("We couldn't cancel your subscription just now, so we haven't stopped your texts either — nothing has changed. Please try again in a moment, or email propinno.app@gmail.com and we'll cancel it for you.")
    }
    throw new Error("Failed to update status. Please try again later.")
  }
}

export async function createCheckoutSession(plan: 'pass_30' | 'pass_90') {
  let alreadySubscribed = false
  try {
    const ip = (await headers()).get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`checkoutSession-${ip}`)
    if (!rateLimit.success) throw new Error("Too many requests")

    const validId = await getSessionUserId()
    if (!validId) throw new Error("Unauthorized")

    const parsed = checkoutSchema.parse({ plan })
    const priceId = parsed.plan === 'pass_30' ? process.env.STRIPE_PRICE_30DAY : process.env.STRIPE_PRICE_90DAY
    if (!priceId) throw new Error(`Stripe price not configured for plan: ${parsed.plan}`)

    const [user] = await db.select({
      status: users.status,
      stripeCustomerId: users.stripeCustomerId,
      stripeSubscriptionId: users.stripeSubscriptionId,
    }).from(users).where(eq(users.id, validId))
    if (!user) throw new Error("Unauthorized")

    // Refuse to open a second checkout for someone who already has a live
    // subscription. Under one-time passes a duplicate purchase was merely a
    // duplicate charge; under recurring billing it would leave the user paying
    // two subscriptions forever against a single access window, with only one
    // of them cancellable from the UI.
    if (user.status === 'active' && user.stripeSubscriptionId) {
      alreadySubscribed = true
      throw new Error("User already has an active subscription")
    }

    const headersList = await headers()
    const host = headersList.get('host') || 'localhost:3000'
    const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https'
    const origin = `${protocol}://${host}`

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${origin}/checkout?success=true`,
      cancel_url: `${origin}/checkout?canceled=true`,
      client_reference_id: validId,
      metadata: { plan: parsed.plan },
      // Reuse the existing Stripe customer on re-subscribe so one phone number
      // doesn't accumulate a new customer per purchase.
      ...(user.stripeCustomerId ? { customer: user.stripeCustomerId } : {}),
      // Mirror our identifiers onto the subscription itself. Not read by any
      // code path (webhooks resolve the user from our own indexed columns) —
      // this is for tracing a subscription back to a user in the Stripe
      // dashboard when investigating a billing question or dispute.
      subscription_data: { metadata: { userId: validId, plan: parsed.plan } },
    })

    return { url: session.url }
  } catch (err) {
    logger.error({ err, plan, alreadySubscribed }, 'createCheckoutSession failed')
    Sentry.captureException(err, { extra: { action: 'createCheckoutSession', plan, alreadySubscribed } })
    if (alreadySubscribed) {
      throw new Error("You already have an active subscription — refresh this page to see it.")
    }
    throw new Error("Failed to start checkout process. Please check your internet connection or try again.")
  }
}
