"use server"

import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { headers, cookies } from "next/headers"
import * as Sentry from '@sentry/nextjs'
import { logger } from "@/lib/logger"
import { z } from "zod"
import { limitRequest } from "@/lib/ratelimit"

const userIdSchema = z.string().uuid()

// Native <input type="time"> gives "HH:MM" (no seconds); the users table
// stores a Postgres `time` column, so we pad to "HH:MM:SS" on the way in.
const timeSchema = z.string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be in HH:MM 24-hour format')
  .transform((v) => `${v}:00`)

const settingsSchema = z.object({
  quietStart: timeSchema,
  quietEnd: timeSchema,
  // 20/day matches the schema default (see lib/db/schema.ts) - generous
  // enough not to surprise existing users, low enough to bound worst case.
  maxDailySms: z.coerce.number().int().min(1, 'Must send at least 1 text/day').max(100, 'Max 100 texts/day'),
  notificationsPaused: z.boolean(),
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

export async function getNotificationSettings() {
  try {
    const ip = (await headers()).get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`getNotificationSettings-${ip}`)
    if (!rateLimit.success) throw new Error("Too many requests")

    const validId = await getSessionUserId()
    if (!validId) return null

    const [user] = await db.select({
      status: users.status,
      quietStart: users.quietStart,
      quietEnd: users.quietEnd,
      maxDailySms: users.maxDailySms,
      notificationsPaused: users.notificationsPaused,
    }).from(users).where(eq(users.id, validId))

    return user || null
  } catch (err) {
    Sentry.captureException(err, { extra: { action: 'getNotificationSettings' } })
    return null
  }
}

export async function updateNotificationSettings(input: {
  quietStart: string
  quietEnd: string
  maxDailySms: number
  notificationsPaused: boolean
}) {
  try {
    const ip = (await headers()).get('x-forwarded-for') || 'anonymous'
    const rateLimit = await limitRequest(`updateNotificationSettings-${ip}`)
    if (!rateLimit.success) throw new Error("Too many requests")

    const validId = await getSessionUserId()
    if (!validId) throw new Error("Unauthorized")

    const parsed = settingsSchema.parse(input)

    await db.update(users).set({
      quietStart: parsed.quietStart,
      quietEnd: parsed.quietEnd,
      maxDailySms: parsed.maxDailySms,
      notificationsPaused: parsed.notificationsPaused,
    }).where(eq(users.id, validId))

    logger.info({ userId: validId, action: 'notification_settings_updated', paused: parsed.notificationsPaused })
    return { success: true }
  } catch (err) {
    Sentry.captureException(err, { extra: { action: 'updateNotificationSettings' } })
    if (err instanceof z.ZodError) {
      throw new Error(err.issues[0]?.message || "Invalid input")
    }
    throw new Error("Failed to update settings. Please try again later.")
  }
}
