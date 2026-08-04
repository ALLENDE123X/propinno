"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { ArrowLeft, Loader2, Moon, Pause, Play, XCircle } from "lucide-react"
import { updateNotificationSettings } from "@/app/dashboard/settings/actions"
import { markFoundPlace } from "@/app/checkout/actions"

type Props = {
  initialQuietStart: string
  initialQuietEnd: string
  initialMaxDailySms: number
  initialNotificationsPaused: boolean
}

export function NotificationSettingsForm({
  initialQuietStart,
  initialQuietEnd,
  initialMaxDailySms,
  initialNotificationsPaused,
}: Props) {
  // Postgres `time` comes back as "HH:MM:SS" (or with fractional seconds);
  // <input type="time"> wants "HH:MM".
  const [quietStart, setQuietStart] = useState(initialQuietStart.slice(0, 5))
  const [quietEnd, setQuietEnd] = useState(initialQuietEnd.slice(0, 5))
  const [maxDailySms, setMaxDailySms] = useState(String(initialMaxDailySms))
  const [paused, setPaused] = useState(initialNotificationsPaused)
  const [saving, setSaving] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const router = useRouter()

  const handleCancel = async () => {
    if (!window.confirm("Cancel your subscription? This stops future charges and texts immediately. The current period isn't refunded.")) {
      return
    }
    setCancelling(true)
    try {
      await markFoundPlace()
      toast.success("Subscription cancelled. You won't be charged again.")
      router.push("/checkout")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel")
      setCancelling(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const parsedMax = Number(maxDailySms)
      if (!Number.isFinite(parsedMax) || parsedMax < 1) {
        throw new Error("Daily text limit must be at least 1")
      }
      await updateNotificationSettings({
        quietStart,
        quietEnd,
        maxDailySms: parsedMax,
        notificationsPaused: paused,
      })
      toast.success("Settings saved")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings")
    }
    setSaving(false)
  }

  return (
    <div className="min-h-screen w-full bg-black p-6 py-12 flex flex-col items-center">
      <div className="w-full max-w-lg">
        <Link href="/dashboard" className="inline-flex items-center gap-2 text-zinc-400 hover:text-white text-sm mb-6 transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back to map
        </Link>

        <h1 className="text-2xl font-bold text-white mb-1">Notification settings</h1>
        <p className="text-zinc-400 mb-8">Control when and how often we text you.</p>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-white font-medium flex items-center gap-2">
                {paused ? <Pause className="w-4 h-4 text-amber-500" /> : <Play className="w-4 h-4 text-green-500" />}
                {paused ? "Notifications paused" : "Notifications active"}
              </h3>
              <p className="text-zinc-400 text-sm mt-1">
                {paused ? "You won't receive any texts until you resume." : "You'll get texted for new matches."}
              </p>
            </div>
            <Button
              type="button"
              onClick={() => setPaused((p) => !p)}
              className={paused ? "bg-white text-black hover:bg-zinc-200 shrink-0" : "bg-zinc-800 text-white hover:bg-zinc-700 shrink-0"}
            >
              {paused ? "Resume" : "Pause"}
            </Button>
          </div>

          <div className="border-t border-zinc-800 pt-6">
            <h3 className="text-white font-medium flex items-center gap-2 mb-1">
              <Moon className="w-4 h-4" /> Quiet hours
            </h3>
            <p className="text-zinc-400 text-sm mb-3">
              We won&apos;t text you during this window (Pacific time). Matches found during quiet hours are sent as soon as it ends.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm text-zinc-400">
                Starts
                <input
                  type="time"
                  value={quietStart}
                  onChange={(e) => setQuietStart(e.target.value)}
                  className="mt-1 bg-zinc-800 rounded-md px-3 py-2 text-white w-full [color-scheme:dark]"
                />
              </label>
              <label className="text-sm text-zinc-400">
                Ends
                <input
                  type="time"
                  value={quietEnd}
                  onChange={(e) => setQuietEnd(e.target.value)}
                  className="mt-1 bg-zinc-800 rounded-md px-3 py-2 text-white w-full [color-scheme:dark]"
                />
              </label>
            </div>
          </div>

          <div className="border-t border-zinc-800 pt-6">
            <h3 className="text-white font-medium mb-1">Daily text limit</h3>
            <p className="text-zinc-400 text-sm mb-3">
              Max number of listing texts per day, even if more matches come in.
            </p>
            <input
              type="number"
              min={1}
              max={100}
              value={maxDailySms}
              onChange={(e) => setMaxDailySms(e.target.value)}
              className="bg-zinc-800 rounded-md px-3 py-2 text-white w-full"
            />
          </div>

          <Button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="w-full h-11 bg-white text-black hover:bg-zinc-200 font-semibold"
          >
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Save settings
          </Button>

          <div className="border-t border-zinc-800 pt-6">
            <h3 className="text-white font-medium flex items-center gap-2 mb-1">
              <XCircle className="w-4 h-4 text-red-500" /> Cancel subscription
            </h3>
            <p className="text-zinc-400 text-sm mb-3">
              Found a place? Cancel anytime — stops future charges and texts immediately. The current period isn&apos;t refunded.
            </p>
            <Button
              type="button"
              onClick={handleCancel}
              disabled={cancelling}
              className="w-full bg-zinc-800 hover:bg-zinc-700 text-white"
            >
              {cancelling ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Cancel subscription
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
