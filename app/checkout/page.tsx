"use client"

import { useSearchParams, useRouter } from "next/navigation"
import { useState, useEffect, Suspense } from "react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { Check, Loader2 } from "lucide-react"
import { getUserStatus, markFoundPlace, createCheckoutSession } from "./actions"

type UserStatus = {
  id: string
  status: "pending_payment" | "active" | "expired" | "done"
  plan: "pass_30" | "pass_90" | null
  accessExpiresAt: Date | null
  createdAt: Date
}

function ActivePassView({ onFoundPlace }: { onFoundPlace: () => void }) {
  const [loading, setLoading] = useState(false)

  const handleFoundPlace = async () => {
    setLoading(true)
    try {
      await markFoundPlace()
      onFoundPlace()
      toast.success("Congratulations! We've stopped your texts.")
    } catch (err) {
      toast.error("Failed to update status")
    }
    setLoading(false)
  }

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center bg-black p-6">
      <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-2xl max-w-md w-full text-center">
        <div className="w-16 h-16 bg-green-500/20 text-green-500 rounded-full flex items-center justify-center mx-auto mb-6">
          <Check className="w-8 h-8" />
        </div>
        <h1 className="text-2xl font-bold text-white mb-2">Your pass is active</h1>
        <p className="text-zinc-400 mb-8">
          We are scanning for listings and will text you as soon as matches drop.
        </p>
        <div className="space-y-4 border-t border-zinc-800 pt-6">
          <h3 className="text-white font-medium">No longer looking?</h3>
          <Button 
            onClick={handleFoundPlace}
            disabled={loading}
            className="w-full bg-zinc-800 hover:bg-zinc-700 text-white"
          >
            {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            I found a place (Stop texts)
          </Button>
        </div>
      </div>
    </div>
  )
}

function FoundPlaceView({ onNeedToHunt }: { onNeedToHunt: () => void }) {
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center bg-black p-6">
      <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-2xl max-w-md w-full text-center">
        <h1 className="text-2xl font-bold text-white mb-2">Congratulations! 🎉</h1>
        <p className="text-zinc-400 mb-8">
          We&apos;re glad you found a place. Your texts have been paused.
        </p>
        <Button 
          onClick={onNeedToHunt}
          className="w-full bg-white text-black hover:bg-zinc-200"
        >
          I need to hunt again
        </Button>
      </div>
    </div>
  )
}

function CheckoutPassesView({ isExpired }: { isExpired: boolean }) {
  const [loading, setLoading] = useState<string | null>(null)

  const handleCheckout = async (plan: "pass_30" | "pass_90") => {
    setLoading(plan)
    try {
      const res = await createCheckoutSession(plan)
      if (res.url) window.location.href = res.url
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      setLoading(null)
    }
  }

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center bg-black p-6 py-20">
      <div className="w-full max-w-4xl">
        <div className="text-center mb-12">
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-4">
            {isExpired ? "Extend your access" : "Choose your access pass"}
          </h1>
          <p className="text-zinc-400 text-lg">One-time payment. No recurring subscription. No auto-renew.</p>
        </div>

        <div className="grid md:grid-cols-2 gap-8 max-w-3xl mx-auto">
          {/* 30 Day Pass */}
          <div className="bg-zinc-900 rounded-2xl p-8 border border-zinc-800 flex flex-col">
            <div className="mb-6">
              <h3 className="text-xl font-semibold text-white mb-2">30-Day Pass</h3>
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-bold text-white">$39</span>
                <span className="text-zinc-400">one-time</span>
              </div>
            </div>
            
            <ul className="space-y-4 mb-8 flex-1">
              <li className="flex items-start gap-3 text-zinc-300">
                <Check className="w-5 h-5 text-white shrink-0" />
                <span>Real-time SMS alerts for new listings</span>
              </li>
              <li className="flex items-start gap-3 text-zinc-300">
                <Check className="w-5 h-5 text-white shrink-0" />
                <span>Exact match to your criteria</span>
              </li>
              <li className="flex items-start gap-3 text-zinc-300">
                <Check className="w-5 h-5 text-white shrink-0" />
                <span>Deduplicated across sources</span>
              </li>
            </ul>

            <Button 
              onClick={() => handleCheckout("pass_30")} 
              disabled={loading !== null}
              className="w-full bg-zinc-800 text-white hover:bg-zinc-700 h-12 text-lg"
            >
              {loading === "pass_30" ? <Loader2 className="w-5 h-5 animate-spin" /> : "Get 30-Day Pass"}
            </Button>
          </div>

          {/* 90 Day Pass */}
          <div className="bg-zinc-900 rounded-2xl p-8 border-2 border-white flex flex-col relative transform md:-translate-y-4 shadow-2xl shadow-white/5">
            <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-white text-black px-4 py-1 rounded-full text-sm font-bold tracking-wide">
              MOST POPULAR
            </div>
            
            <div className="mb-6">
              <h3 className="text-xl font-semibold text-white mb-2">90-Day Pass</h3>
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-bold text-white">$69</span>
                <span className="text-zinc-400">one-time</span>
              </div>
            </div>
            
            <ul className="space-y-4 mb-8 flex-1">
              <li className="flex items-start gap-3 text-zinc-300">
                <Check className="w-5 h-5 text-white shrink-0" />
                <span>Everything in 30-Day Pass</span>
              </li>
              <li className="flex items-start gap-3 text-zinc-300">
                <Check className="w-5 h-5 text-white shrink-0" />
                <span>Extra 60 days of coverage</span>
              </li>
              <li className="flex items-start gap-3 text-zinc-300">
                <Check className="w-5 h-5 text-white shrink-0" />
                <span>Recommended: most apartment hunts take 4-8 weeks</span>
              </li>
            </ul>

            <Button 
              onClick={() => handleCheckout("pass_90")}
              disabled={loading !== null}
              className="w-full bg-white text-black hover:bg-zinc-200 h-12 text-lg font-semibold"
            >
              {loading === "pass_90" ? <Loader2 className="w-5 h-5 animate-spin" /> : "Get 90-Day Pass"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function CheckoutContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const success = searchParams.get("success")
  const canceled = searchParams.get("canceled")
  
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<UserStatus | null>(null)

  useEffect(() => {
    getUserStatus().then((u) => {
      setUser(u as UserStatus | null)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (success) {
      toast.success("Payment successful! Your pass is active.")
      router.replace("/checkout") // Clear query params
    }
    if (canceled) {
      toast.error("Payment canceled.")
      router.replace("/checkout")
    }
  }, [success, canceled, router])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black">
        <Loader2 className="w-8 h-8 text-white animate-spin" />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black text-white text-center p-6">
        <div>
          <h1 className="text-2xl font-bold mb-4">User not found or Session expired</h1>
          <p className="text-zinc-400">Please go back and verify your phone number again.</p>
        </div>
      </div>
    )
  }

  if (user.status === "active") {
    return <ActivePassView onFoundPlace={() => setUser({ ...user, status: "done" })} />
  }

  if (user.status === "done") {
    return <FoundPlaceView onNeedToHunt={() => setUser({ ...user, status: "expired" })} />
  }

  return <CheckoutPassesView isExpired={user.status === "expired"} />
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <CheckoutContent />
    </Suspense>
  )
}
