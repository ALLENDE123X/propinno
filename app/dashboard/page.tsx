import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"
import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { DashboardMap } from "@/components/dashboard-map"

const userIdSchema = z.string().uuid()

export default async function DashboardPage() {
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

  return <DashboardMap />
}
