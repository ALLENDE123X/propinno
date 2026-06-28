"use client"

import { useSearchParams } from "next/navigation"
import { useState, useEffect, Suspense } from "react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { Check, Loader2 } from "lucide-react"
import { getUserStatus, markFoundPlace, createCheckoutSession } from "./actions"

function CheckoutContent() {
  const searchParams = useSearchParams()
  const userId = searchParams.get("userId")
  
  const [loading, setLoading] = useState<string | null>("init")
  const [user, setUser] = useState<any>(null)

  useEffect(() => {
    if (userId) {
      getUserStatus(userId).then(u => {
        setUser(u)
        setLoading(null)
      })
    } else {
      setLoading(null)
    }
  }, [userId])

  if (!userId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black p-6 text-white text-center">
        <div>
          <h1 className="text-2xl font-bold mb-4">Missing User ID</h1>
          <p className="text-zinc-400">Please go back and verify your phone number again.</p>
        </div>
      </div>
    )
  }

  if (loading === "init") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black">
        <Loader2 className="w-8 h-8 text-white animate-spin" />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black text-white text-center">
        <div>
          <h1 className="text-2xl font-bold mb-4">User not found</h1>
        </div>
      </div>
    )
  }

  const handleCheckout = async (plan: "pass_30" | "pass_90") => {
    setLoading(plan)
    try {
      const res = await createCheckoutSession(userId, plan)
      if (res.url) window.location.href = res.url
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      setLoading(null)
    }
  }

  const handleFoundPlace = async () => {
    setLoading("done")
    try {
      await markFoundPlace(userId)
      setUser({ ...user, status: "done" })
      toast.success("Congratulations! We've stopped your texts.")
    } catch (err) {
      toast.error("Failed to update status")
    }
    setLoading(null)
  }

  if (user.status === "active") {
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
              disabled={loading === "done"}
              className="w-full bg-zinc-800 hover:bg-zinc-700 text-white"
            >
              {loading === "done" ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              I found a place (Stop texts)
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (user.status === "done") {
    return (
      <div className="flex min-h-screen w-full flex-col items-center justify-center bg-black p-6">
        <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-2xl max-w-md w-full text-center">
          <h1 className="text-2xl font-bold text-white mb-2">Congratulations! 🎉</h1>
          <p className="text-zinc-400 mb-8">
            We're glad you found a place. Your texts have been paused.
          </p>
          <Button 
            onClick={() => setUser({ ...user, status: "expired" })}
            className="w-full bg-white text-black hover:bg-zinc-200"
          >
            I need to hunt again
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center bg-black p-6 py-20">
      <div className="w-full max-w-4xl">
        <div className="text-center mb-12">
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-4">
            {user.status === "expired" ? "Extend your access" : "Choose your access pass"}
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

export default function CheckoutPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <CheckoutContent />
    </Suspense>
  )
}
