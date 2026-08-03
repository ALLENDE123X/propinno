"use client"

import { useSearchParams, useRouter } from "next/navigation"
import { useState, useEffect, Suspense } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { Check, Loader2, Map } from "lucide-react"
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
      toast.success("Congratulations! Your subscription is cancelled and your texts have stopped.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update status")
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
          We are scanning for listings and will text you as soon as matches drop. Your plan renews automatically until you cancel.
        </p>
        <Link href="/dashboard" className="block mb-6">
          <Button className="w-full bg-white text-black hover:bg-zinc-200">
            <Map className="w-4 h-4 mr-2" /> View live map
          </Button>
        </Link>
        <div className="space-y-4 border-t border-zinc-800 pt-6">
          <h3 className="text-white font-medium">No longer looking?</h3>
          <p className="text-zinc-400 text-sm">
            This cancels your subscription immediately — no further charges — and stops your texts.
          </p>
          <Button
            onClick={handleFoundPlace}
            disabled={loading}
            className="w-full bg-zinc-800 hover:bg-zinc-700 text-white"
          >
            {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            I found a place (Cancel & stop texts)
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
          We&apos;re glad you found a place. Your subscription is cancelled — you won&apos;t be charged again — and your texts have stopped.
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

function PassCard({
  title,
  price,
  period,
  features,
  buttonText,
  popular,
  loading,
  onCheckout,
}: {
  title: string
  price: string
  period: string
  features: string[]
  buttonText: string
  popular?: boolean
  loading: boolean
  onCheckout: () => void
}) {
  return (
    <div className={`bg-zinc-900 rounded-2xl p-8 flex flex-col relative ${popular ? 'border-2 border-white transform md:-translate-y-4 shadow-2xl shadow-white/5' : 'border border-zinc-800'}`}>
      {popular && (
        <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-white text-black px-4 py-1 rounded-full text-sm font-bold tracking-wide">
          MOST POPULAR
        </div>
      )}
      <div className="mb-6">
        <h3 className="text-xl font-semibold text-white mb-2">{title}</h3>
        <div className="flex items-baseline gap-2">
          <span className="text-4xl font-bold text-white">${price}</span>
          <span className="text-zinc-400">{period}</span>
        </div>
      </div>
      <ul className="space-y-4 mb-8 flex-1">
        {features.map((f, i) => (
          <li key={i} className="flex items-start gap-3 text-zinc-300">
            <Check className="w-5 h-5 text-white shrink-0" />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <Button 
        onClick={onCheckout}
        disabled={loading}
        className={`w-full h-12 text-lg font-semibold ${popular ? 'bg-white text-black hover:bg-zinc-200' : 'bg-zinc-800 text-white hover:bg-zinc-700'}`}
      >
        {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : buttonText}
      </Button>
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
          <p className="text-zinc-400 text-lg">
            Renews automatically until you cancel. Cancel anytime in one click with &ldquo;I found a place&rdquo;.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8 max-w-3xl mx-auto">
          <PassCard
            title="30-Day Pass"
            price="9"
            period="/month"
            features={[
              "Real-time SMS alerts for new listings",
              "Exact match to your criteria",
              "Deduplicated across sources",
              "Renews monthly · cancel anytime"
            ]}
            buttonText="Subscribe — $9/month"
            loading={loading === "pass_30"}
            onCheckout={() => handleCheckout("pass_30")}
          />
          <PassCard
            title="90-Day Pass"
            price="19"
            period="/3 months"
            features={[
              "Everything in 30-Day Pass",
              "Best value: works out to ~$6.33/month",
              "Recommended: most apartment hunts take 4-8 weeks",
              "Renews every 3 months · cancel anytime"
            ]}
            buttonText="Subscribe — $19/3 months"
            popular={true}
            loading={loading === "pass_90"}
            onCheckout={() => handleCheckout("pass_90")}
          />
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
