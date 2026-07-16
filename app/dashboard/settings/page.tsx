import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"
import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { NotificationSettingsForm } from "@/components/notification-settings-form"

const userIdSchema = z.string().uuid()

export default async function SettingsPage() {
  const cookieStore = await cookies()
  const session = cookieStore.get("session")?.value

  let userId: string
  try {
    userId = userIdSchema.parse(session)
  } catch {
    redirect("/checkout")
  }

  const [user] = await db.select({
    status: users.status,
    quietStart: users.quietStart,
    quietEnd: users.quietEnd,
    maxDailySms: users.maxDailySms,
    notificationsPaused: users.notificationsPaused,
  }).from(users).where(eq(users.id, userId))

  // Same gate as /dashboard: settings is a paid-product surface, not the
  // pre-payment teaser, so expired/done/pending users get sent to /checkout
  // to (re)purchase rather than seeing a settings form for a pass they no
  // longer have.
  if (!user || user.status !== "active") {
    redirect("/checkout")
  }

  return (
    <NotificationSettingsForm
      initialQuietStart={user.quietStart}
      initialQuietEnd={user.quietEnd}
      initialMaxDailySms={user.maxDailySms}
      initialNotificationsPaused={user.notificationsPaused}
    />
  )
}
