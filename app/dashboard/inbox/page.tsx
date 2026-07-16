import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"
import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { InboxList } from "@/components/inbox-list"

const userIdSchema = z.string().uuid()

// Same auth gate as /dashboard (app/dashboard/page.tsx): session cookie ->
// valid UUID -> status must be 'active', else back to /checkout. The inbox
// is part of the paid product surface, not the pre-payment teaser.
export default async function InboxPage() {
  const cookieStore = await cookies()
  const session = cookieStore.get("session")?.value

  let userId: string
  try {
    userId = userIdSchema.parse(session)
  } catch {
    redirect("/checkout")
  }

  const [user] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId))
  if (!user || user.status !== "active") {
    redirect("/checkout")
  }

  return <InboxList />
}
