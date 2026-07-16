// Shared display-formatting helpers for listing data, used by both
// components/dashboard-map.tsx (AH-015) and components/inbox-list.tsx
// (AH-016) so the two paid-dashboard surfaces present prices and recency
// identically.

export function formatPrice(price: number | null) {
  if (!price) return "N/A"
  return price >= 1000 ? `$${(price / 1000).toFixed(1)}k` : `$${price}`
}

// Takes `now` explicitly rather than calling Date.now() internally, since
// callers may use this during render (e.g. a detail card) and React's
// purity rule disallows impure calls in render.
export function timeAgo(dateStr: string | null, now: number) {
  if (!dateStr) return "unknown"
  const ms = now - new Date(dateStr).getTime()
  const hrs = Math.floor(ms / (1000 * 60 * 60))
  if (hrs < 1) return "just now"
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}
