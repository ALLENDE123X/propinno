"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { formatPrice, timeAgo } from "@/lib/format"
import { ArrowLeft, ExternalLink, X, Check, Loader2, Inbox as InboxIcon } from "lucide-react"

type InboxItem = {
  listingId: string
  address: string
  price: number | null
  beds: number | null
  baths: number | null
  source: string
  url: string | null
  postedAt: string | null
  sentAt: string
  readAt: string | null
}

// Client component for /dashboard/inbox (AH-016). Fetches inline (rather
// than via a useCallback'd helper) and sets state only inside the
// .then()/.catch()/.finally() callbacks, matching components/dashboard-map.tsx's
// established pattern for the same lint reason documented there.
export function InboxList() {
  const [items, setItems] = useState<InboxItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // listingIds currently mid-request, so buttons disable individually rather
  // than the whole list locking up on one action.
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    fetch("/api/inbox")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load inbox")
        return res.json()
      })
      .then((data) => {
        setItems(data.items || [])
        setError(null)
      })
      .catch(() => {
        setError("Couldn't load your inbox. Try again shortly.")
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const unreadCount = items.reduce((n, item) => (item.readAt ? n : n + 1), 0)

  async function updateItem(listingId: string, action: "read" | "dismiss") {
    setPending((prev) => new Set(prev).add(listingId))
    try {
      const res = await fetch(`/api/inbox/${listingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) throw new Error("Failed to update")

      if (action === "dismiss") {
        setItems((prev) => prev.filter((item) => item.listingId !== listingId))
      } else {
        setItems((prev) =>
          prev.map((item) =>
            item.listingId === listingId ? { ...item, readAt: new Date().toISOString() } : item
          )
        )
      }
    } catch {
      setError("Couldn't update that listing. Try again.")
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(listingId)
        return next
      })
    }
  }

  return (
    <div className="min-h-screen w-full bg-black p-4 md:p-8">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <Link
              href="/dashboard"
              className="mb-2 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-white"
            >
              <ArrowLeft className="w-4 h-4" /> Back to map
            </Link>
            <h1 className="text-2xl font-bold text-white">Inbox</h1>
            <p className="text-sm text-zinc-400">
              {loading
                ? "Loading…"
                : unreadCount > 0
                  ? `${unreadCount} unread`
                  : "You're all caught up"}
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-900/90 p-3 text-center text-sm text-white">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-white" />
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-8 text-center">
            <InboxIcon className="mx-auto mb-3 w-8 h-8 text-zinc-600" />
            <h2 className="text-lg font-semibold text-white">Nothing here yet</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Matched listings we text you will also show up here.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => {
              const isPending = pending.has(item.listingId)
              const isUnread = !item.readAt
              return (
                <li
                  key={item.listingId}
                  className={`rounded-xl border p-4 ${
                    isUnread ? "border-zinc-700 bg-zinc-900" : "border-zinc-800 bg-zinc-950"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <span
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                          isUnread ? "bg-white" : "bg-transparent"
                        }`}
                        aria-hidden
                      />
                      <div className="min-w-0">
                        <p className={`truncate ${isUnread ? "font-semibold text-white" : "text-zinc-300"}`}>
                          {item.address}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-zinc-400">
                          <span>{formatPrice(item.price)}/mo</span>
                          <span>{item.beds ?? "?"} bd</span>
                          <span>{item.baths ?? "?"} ba</span>
                          <span className="capitalize">{item.source}</span>
                          <span>Sent {timeAgo(item.sentAt, now)} ago</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {item.url && (
                      <a href={item.url} target="_blank" rel="noopener noreferrer">
                        <Button
                          size="sm"
                          className="bg-white text-black hover:bg-zinc-200"
                          disabled={isPending}
                        >
                          View listing <ExternalLink className="ml-1.5 w-3.5 h-3.5" />
                        </Button>
                      </a>
                    )}
                    {isUnread && (
                      <Button
                        size="sm"
                        className="bg-zinc-800 text-white hover:bg-zinc-700"
                        disabled={isPending}
                        onClick={() => updateItem(item.listingId, "read")}
                      >
                        <Check className="mr-1.5 w-3.5 h-3.5" /> Mark read
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-zinc-400 hover:bg-zinc-800 hover:text-white"
                      disabled={isPending}
                      onClick={() => updateItem(item.listingId, "dismiss")}
                    >
                      <X className="mr-1.5 w-3.5 h-3.5" /> Dismiss
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
