"use server"

import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { stripe } from "@/lib/stripe"
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

export async function markFoundPlace() {
  try {
    const ip = (await headers()).get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`markFoundPlace-${ip}`)
    if (!rateLimit.success) throw new Error("Too many requests")

    const validId = await getSessionUserId()
    if (!validId) throw new Error("Unauthorized")

    await db.update(users).set({ status: 'done' }).where(eq(users.id, validId))
    logger.info({ userId: validId, action: 'found_place_marked_done' })
    return { success: true }
  } catch (err) {
    logger.error({ err }, 'markFoundPlace failed')
    Sentry.captureException(err, { extra: { action: 'markFoundPlace' } })
    throw new Error("Failed to update status. Please try again later.")
  }
}

export async function createCheckoutSession(plan: 'pass_30' | 'pass_90') {
  try {
    const ip = (await headers()).get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`checkoutSession-${ip}`)
    if (!rateLimit.success) throw new Error("Too many requests")

    const validId = await getSessionUserId()
    if (!validId) throw new Error("Unauthorized")

    const parsed = checkoutSchema.parse({ plan })
    const priceId = parsed.plan === 'pass_30' ? process.env.STRIPE_PRICE_30DAY : process.env.STRIPE_PRICE_90DAY
    if (!priceId) throw new Error(`Stripe price not configured for plan: ${parsed.plan}`)
    
    const headersList = await headers()
    const host = headersList.get('host') || 'localhost:3000'
    const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https'
    const origin = `${protocol}://${host}`
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'payment',
      success_url: `${origin}/checkout?success=true`,
      cancel_url: `${origin}/checkout?canceled=true`,
      client_reference_id: validId,
      metadata: { plan: parsed.plan }
    })
    
    return { url: session.url }
  } catch (err) {
    logger.error({ err, plan }, 'createCheckoutSession failed')
    Sentry.captureException(err, { extra: { action: 'createCheckoutSession', plan } })
    throw new Error("Failed to start checkout process. Please check your internet connection or try again.")
  }
}
