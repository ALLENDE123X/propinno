import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"
import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { SearchProfileForm } from "@/components/search-profile-form"

const userIdSchema = z.string().uuid()

// AH-026. Same Server Component auth-gate pattern as /dashboard,
// /dashboard/inbox, /dashboard/favourites, and /dashboard/settings (session
// cookie -> valid UUID -> status must be 'active', else redirect to
// /checkout), duplicated inline rather than extracted into a shared
// page-level helper - matches those routes' existing convention (see
// app/dashboard/favourites/page.tsx).
export default async function ProfilePage() {
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

  return <SearchProfileForm />
}
