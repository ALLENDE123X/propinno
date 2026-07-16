"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Inbox } from "lucide-react"

// Small persistent nav affordance (AH-016) surfaced on the dashboard map so
// the in-app inbox is actually discoverable, not just a page that exists
// with no link to it. Fetches only the lightweight /api/inbox/unread-count
// endpoint -- not the full /api/inbox join -- since all this needs is a
// number to badge.
export function InboxNavLink() {
  const [unreadCount, setUnreadCount] = useState<number | null>(null)

  useEffect(() => {
    fetch("/api/inbox/unread-count")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && typeof data.count === "number") setUnreadCount(data.count)
      })
      .catch(() => {
        // Non-fatal: the badge just stays hidden if this fails.
      })
  }, [])

  return (
    <Link href="/dashboard/inbox">
      <Button
        size="sm"
        className="relative bg-zinc-900/90 border border-zinc-800 text-white hover:bg-zinc-800"
      >
        <Inbox className="w-4 h-4 mr-2" /> Inbox
        {!!unreadCount && (
          <span className="absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-semibold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </Button>
    </Link>
  )
}
