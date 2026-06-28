"use server"

import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { stripe } from "@/lib/stripe"
import { headers } from "next/headers"
import * as Sentry from '@sentry/nextjs'
import { logger } from "@/lib/logger"

export async function getUserStatus(userId: string) {
  try {
    const [user] = await db.select().from(users).where(eq(users.id, userId))
    return user || null
  } catch (err) {
    Sentry.captureException(err)
    return null
  }
}

export async function markFoundPlace(userId: string) {
  try {
    await db.update(users).set({ status: 'done' }).where(eq(users.id, userId))
    logger.info({ userId, action: 'found_place_marked_done' })
    return { success: true }
  } catch (err) {
    Sentry.captureException(err)
    throw new Error("Failed to update status")
  }
}

export async function createCheckoutSession(userId: string, plan: 'pass_30' | 'pass_90') {
  try {
    const priceId = plan === 'pass_30' ? process.env.STRIPE_PRICE_30DAY : process.env.STRIPE_PRICE_90DAY
    if (!priceId) throw new Error("Price not configured")
    
    const headersList = await headers()
    const origin = headersList.get('origin') || 'http://localhost:3000'
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'payment',
      success_url: `${origin}/checkout?userId=${userId}&success=true`,
      cancel_url: `${origin}/checkout?userId=${userId}`,
      client_reference_id: userId,
      metadata: { plan }
    })
    
    return { url: session.url }
  } catch (err) {
    Sentry.captureException(err)
    throw new Error("Failed to create checkout session")
  }
}
