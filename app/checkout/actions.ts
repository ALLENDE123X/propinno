"use server"

import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { stripe } from "@/lib/stripe"
import { headers } from "next/headers"
import * as Sentry from '@sentry/nextjs'
import { logger } from "@/lib/logger"
import { z } from "zod"
import { limitRequest } from "@/lib/ratelimit"

const userIdSchema = z.string().uuid()
const checkoutSchema = z.object({
  userId: z.string().uuid(),
  plan: z.enum(['pass_30', 'pass_90'])
})

export async function getUserStatus(userId: string) {
  try {
    const ip = (await headers()).get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`getUserStatus-${ip}`)
    if (!rateLimit.success) throw new Error("Too many requests")

    const validId = userIdSchema.parse(userId)
    const [user] = await db.select().from(users).where(eq(users.id, validId))
    return user || null
  } catch (err) {
    Sentry.captureException(err, { extra: { action: 'getUserStatus', userId } })
    return null
  }
}

export async function markFoundPlace(userId: string) {
  try {
    const ip = (await headers()).get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`markFoundPlace-${ip}`)
    if (!rateLimit.success) throw new Error("Too many requests")

    const validId = userIdSchema.parse(userId)
    await db.update(users).set({ status: 'done' }).where(eq(users.id, validId))
    logger.info({ userId: validId, action: 'found_place_marked_done' })
    return { success: true }
  } catch (err) {
    Sentry.captureException(err, { extra: { action: 'markFoundPlace', userId } })
    throw new Error(`Failed to update status for user: ${userId}`)
  }
}

export async function createCheckoutSession(userId: string, plan: 'pass_30' | 'pass_90') {
  try {
    const ip = (await headers()).get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`checkoutSession-${ip}`)
    if (!rateLimit.success) throw new Error("Too many requests")

    const parsed = checkoutSchema.parse({ userId, plan })
    const priceId = parsed.plan === 'pass_30' ? process.env.STRIPE_PRICE_30DAY : process.env.STRIPE_PRICE_90DAY
    if (!priceId) throw new Error(`Stripe price not configured for plan: ${parsed.plan}`)
    
    const headersList = await headers()
    const origin = headersList.get('origin') || 'http://localhost:3000'
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'payment',
      success_url: `${origin}/checkout?userId=${parsed.userId}&success=true`,
      cancel_url: `${origin}/checkout?userId=${parsed.userId}`,
      client_reference_id: parsed.userId,
      metadata: { plan: parsed.plan }
    })
    
    return { url: session.url }
  } catch (err) {
    Sentry.captureException(err, { extra: { action: 'createCheckoutSession', userId, plan } })
    throw new Error(`Failed to create checkout session for plan ${plan}`)
  }
}
