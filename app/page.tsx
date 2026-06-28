"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { MapPin, BedDouble, Lock, Loader2, ChevronRight } from "lucide-react";
import * as Sentry from "@sentry/nextjs";

type PreviewListing = {
  id: string;
  neighborhood: string;
  price: number | null;
  beds: number | null;
  baths: number | null;
  source: string;
  postedAt: string | null;
};

function ListingTeaser({ listing, index }: { listing: PreviewListing; index: number }) {
  const bedsLabel = listing.beds !== null ? `${listing.beds} bed` : null;
  const bathsLabel = listing.baths !== null ? `${listing.baths} bath` : null;
  const bedroomStr = [bedsLabel, bathsLabel].filter(Boolean).join(" · ");

  return (
    <div
      className="relative overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 p-4"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      {/* Blur overlay on the "full details" part */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-zinc-400 text-xs mb-1">
            <MapPin className="w-3 h-3 shrink-0" />
            <span className="truncate">{listing.neighborhood || "San Francisco, CA"}</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {listing.price !== null && (
              <span className="text-white font-semibold text-base">
                ${listing.price.toLocaleString()}/mo
              </span>
            )}
            {bedroomStr && (
              <span className="text-zinc-400 text-sm">{bedroomStr}</span>
            )}
          </div>
        </div>

        {/* Lock icon — full address/link gated */}
        <div className="flex items-center gap-1 bg-zinc-800 rounded-lg px-2.5 py-1.5 shrink-0">
          <Lock className="w-3 h-3 text-zinc-500" />
          <span className="text-xs text-zinc-500">Link</span>
        </div>
      </div>

      {/* Blurred full-address hint */}
      <div className="mt-3 flex items-center gap-1.5">
        <div className="h-3 rounded bg-zinc-700 w-32 blur-[3px] opacity-60" />
        <div className="h-3 rounded bg-zinc-700 w-20 blur-[3px] opacity-60" />
      </div>
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const [step, setStep] = useState<"form" | "otp" | "preview">("form");
  const [loading, setLoading] = useState(false);

  const [phone, setPhone] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [bedsMin, setBedsMin] = useState("");
  const [bedsMax, setBedsMax] = useState("");
  const [locations, setLocations] = useState("");
  const [code, setCode] = useState("");
  const [previewListings, setPreviewListings] = useState<PreviewListing[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone || phone.length < 10) {
      toast.error("Please enter a valid phone number");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to send OTP");

      toast.success("Verification code sent");
      setStep("otp");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) {
      toast.error("Please enter a 6-digit code");
      return;
    }

    setLoading(true);
    try {
      const locationList = locations.split(",").map((l) => l.trim()).filter(Boolean);
      const zips = locationList.filter((l) => /^\d{5}$/.test(l));
      const neighborhoods = locationList.filter((l) => !/^\d{5}$/.test(l));

      const criteria = {
        priceMin: priceMin ? Number(priceMin) : undefined,
        priceMax: priceMax ? Number(priceMax) : undefined,
        bedsMin: bedsMin ? Number(bedsMin) : undefined,
        bedsMax: bedsMax ? Number(bedsMax) : undefined,
        zips: zips.length > 0 ? zips : undefined,
        neighborhoods: neighborhoods.length > 0 ? neighborhoods : undefined,
      };

      const res = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code, criteria }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to verify OTP");

      toast.success("Verified!");
      // Fetch live-match preview
      setLoading(false);
      setPreviewLoading(true);
      setStep("preview");
      try {
        const previewRes = await fetch("/api/listings/preview");
        const previewData = await previewRes.json();
        if (previewRes.ok && Array.isArray(previewData.listings)) {
          setPreviewListings(previewData.listings);
        }
      } catch (err) {
        // Non-fatal: preview just shows empty state
        console.error("Failed to load preview:", err);
        Sentry.captureException(err);
      } finally {
        setPreviewLoading(false);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  // ── Preview step ───────────────────────────────────────────────
  if (step === "preview") {
    const hasMatches = previewListings.length > 0;

    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-black p-6">
        <div className="w-full max-w-md">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-white mb-2">
              {previewLoading
                ? "Scanning for matches…"
                : hasMatches
                ? `${previewListings.length} listing${previewListings.length > 1 ? "s" : ""} already match your criteria`
                : "We're scanning for your perfect match"}
            </h1>
            <p className="text-zinc-400 text-sm">
              {hasMatches
                ? "Unlock the full address and listing link when you activate your pass."
                : "New listings drop every 15–30 minutes. Activate your pass and we'll text you the moment one matches."}
            </p>
          </div>

          <div className="space-y-3 mb-6">
            {previewLoading ? (
              <div className="flex flex-col items-center py-10 gap-3">
                <Loader2 className="w-8 h-8 text-white animate-spin" />
                <span className="text-zinc-500 text-sm">Checking listings…</span>
              </div>
            ) : hasMatches ? (
              previewListings.map((l, i) => (
                <ListingTeaser key={l.id} listing={l} index={i} />
              ))
            ) : (
              /* Empty state — pipeline may not have listings yet */
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-center">
                <div className="flex justify-center mb-3">
                  <BedDouble className="w-8 h-8 text-zinc-600" />
                </div>
                <p className="text-zinc-400 text-sm">
                  No listings indexed yet — the scraper is warming up. Once your pass is active you&apos;ll get texts within minutes of new listings matching your criteria.
                </p>
              </div>
            )}
          </div>

          {/* Teaser legend */}
          {hasMatches && (
            <div className="flex items-center gap-2 text-xs text-zinc-500 mb-5">
              <Lock className="w-3 h-3" />
              <span>Full address + listing link unlocked after payment</span>
            </div>
          )}

          {/* Paywall CTA */}
          <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-white font-semibold text-sm">90-Day Pass</p>
                <p className="text-zinc-400 text-xs mt-0.5">Most popular · one-time payment</p>
              </div>
              <div className="text-right">
                <span className="text-white font-bold text-xl">$69</span>
                <span className="text-zinc-500 text-xs ml-1">one-time</span>
              </div>
            </div>
            <Button
              id="preview-cta-90day"
              onClick={() => router.push("/checkout")}
              className="w-full bg-white text-black hover:bg-zinc-200 font-semibold h-11"
            >
              Activate 90-Day Pass
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
            <button
              id="preview-cta-see-plans"
              onClick={() => router.push("/checkout")}
              className="w-full text-zinc-500 text-xs mt-3 hover:text-zinc-300 transition-colors"
            >
              See all plans →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Form & OTP steps ───────────────────────────────────────────
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-black p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">Propinno</h1>
          <p className="text-zinc-400">Fresh SF apartment listings, texted to you the second they drop.</p>
        </div>

        <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
          {step === "form" ? (
            <form onSubmit={handleSendOtp} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">Phone Number</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="(415) 555-0123"
                  className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-1">Min Price</label>
                  <input
                    type="number"
                    value={priceMin}
                    onChange={(e) => setPriceMin(e.target.value)}
                    placeholder="$2,000"
                    className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-1">Max Price</label>
                  <input
                    type="number"
                    value={priceMax}
                    onChange={(e) => setPriceMax(e.target.value)}
                    placeholder="$4,000"
                    className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-1">Min Beds</label>
                  <input
                    type="number"
                    value={bedsMin}
                    onChange={(e) => setBedsMin(e.target.value)}
                    placeholder="1"
                    className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-1">Max Beds</label>
                  <input
                    type="number"
                    value={bedsMax}
                    onChange={(e) => setBedsMax(e.target.value)}
                    placeholder="2"
                    className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">Neighborhoods or Zips (comma separated)</label>
                <input
                  type="text"
                  value={locations}
                  onChange={(e) => setLocations(e.target.value)}
                  placeholder="Marina, 94123, Mission"
                  className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600"
                />
              </div>

              <Button type="submit" className="w-full bg-white text-black hover:bg-zinc-200 mt-2" disabled={loading}>
                {loading ? "Sending..." : "Start matching"}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">Verification Code</label>
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  maxLength={6}
                  className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600 text-center tracking-widest text-lg"
                  required
                />
                <p className="text-xs text-zinc-500 mt-2 text-center">
                  Code sent to {phone}
                </p>
              </div>

              <Button type="submit" className="w-full bg-white text-black hover:bg-zinc-200" disabled={loading}>
                {loading ? "Verifying..." : "Verify & Continue"}
              </Button>

              <button
                type="button"
                onClick={() => setStep("form")}
                className="w-full text-zinc-400 text-sm hover:text-white mt-2"
                disabled={loading}
              >
                Back
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
