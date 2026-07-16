import { cookies } from 'next/headers'
import { z } from 'zod'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

const userIdSchema = z.string().uuid()

type SessionResult =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403 }

/**
 * Resolves the `session` cookie to an active (paid) user.
 *
 * Mirrors the inline auth-gate pattern used by /dashboard and
 * /api/listings/map (session cookie -> valid UUID -> user exists ->
 * status === 'active'), extracted here since AH-016 added three routes that
 * all need the identical check. Distinguishes 401 (no/invalid session, or no
 * such user) from 403 (real session, not an active paid user) so callers can
 * reproduce the exact status/message those existing routes already use.
 */
export async function getActiveSessionUser(): Promise<SessionResult> {
  const cookieStore = await cookies()
  const session = cookieStore.get('session')?.value
  if (!session) return { ok: false, status: 401 }

  let userId: string
  try {
    userId = userIdSchema.parse(session)
  } catch {
    return { ok: false, status: 401 }
  }

  const [user] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId))
  if (!user) return { ok: false, status: 401 }
  if (user.status !== 'active') return { ok: false, status: 403 }

  return { ok: true, userId }
}

/** Standard error body/status pair for a failed getActiveSessionUser() result. */
export function sessionErrorResponse(status: 401 | 403) {
  return { error: status === 401 ? 'Unauthorized' : 'Access pass required', status }
}
