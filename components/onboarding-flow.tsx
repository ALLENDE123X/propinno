"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { MapPin, BedDouble, Lock, Loader2, ChevronRight, Zap, Sparkles } from "lucide-react";
import * as Sentry from "@sentry/nextjs";
import { CriteriaFormFields, type CriteriaFormValues } from "@/components/criteria-form-fields";

// AH-020. Mirrors the validated shape lib/nlpCriteria.ts's parsedCriteriaSchema
// returns from POST /api/onboarding/parse-criteria - defined locally rather
// than imported from that lib module so this client component never pulls in
// its server-only dependencies (the Anthropic SDK) into the client bundle.
type ParsedCriteriaResponse = {
  priceMin?: number;
  priceMax?: number;
  bedsMin?: number;
  bedsMax?: number;
  bathsMin?: number;
  bathsMax?: number;
  neighborhoods?: string[];
  zips?: string[];
  pets?: string;
  laundry?: string;
  commuteAddress?: string;
  commuteMaxMinutes?: number;
  commuteMode?: string;
};

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

        <div className="flex items-center gap-1 bg-zinc-800 rounded-lg px-2.5 py-1.5 shrink-0">
          <Lock className="w-3 h-3 text-zinc-500" />
          <span className="text-xs text-zinc-500">Link</span>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1.5">
        <div className="h-3 rounded bg-zinc-700 w-32 blur-[3px] opacity-60" />
        <div className="h-3 rounded bg-zinc-700 w-20 blur-[3px] opacity-60" />
      </div>
    </div>
  );
}

export function OnboardingFlow() {
  const router = useRouter();
  const [step, setStep] = useState<"form" | "otp" | "preview">("form");
  const [loading, setLoading] = useState(false);

  const [phone, setPhone] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [bedsMin, setBedsMin] = useState("");
  const [bedsMax, setBedsMax] = useState("");
  const [bathsMin, setBathsMin] = useState("");
  const [bathsMax, setBathsMax] = useState("");
  const [pets, setPets] = useState("");
  const [laundry, setLaundry] = useState("");
  const [commuteAddress, setCommuteAddress] = useState("");
  const [commuteMaxMinutes, setCommuteMaxMinutes] = useState("");
  const [commuteMode, setCommuteMode] = useState("");
  const [locations, setLocations] = useState("");
  const [nlpDescription, setNlpDescription] = useState("");
  const [nlpLoading, setNlpLoading] = useState(false);
  const [code, setCode] = useState("");
  const [previewListings, setPreviewListings] = useState<PreviewListing[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resending, setResending] = useState(false);

  // Ticks the resend cooldown down to 0 once a second.
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [resendCooldown]);

  const fillTemplate = (pMax: string, bMin: string, locs: string) => {
    setPriceMax(pMax);
    setBedsMin(bMin);
    setLocations(locs);
  };

  // AH-026. Bundles the criteria-field state above into the value-bag shape
  // components/criteria-form-fields.tsx expects, so this form and
  // components/search-profile-form.tsx (the post-signup "edit your search
  // profile" page) can share the same field markup without either owning the
  // other's state shape.
  const criteriaFormValues: CriteriaFormValues = {
    priceMin, priceMax, bedsMin, bedsMax, bathsMin, bathsMax,
    pets, laundry, commuteAddress, commuteMaxMinutes, commuteMode, locations,
  };
  const CRITERIA_FIELD_SETTERS: Record<keyof CriteriaFormValues, (value: string) => void> = {
    priceMin: setPriceMin,
    priceMax: setPriceMax,
    bedsMin: setBedsMin,
    bedsMax: setBedsMax,
    bathsMin: setBathsMin,
    bathsMax: setBathsMax,
    pets: setPets,
    laundry: setLaundry,
    commuteAddress: setCommuteAddress,
    commuteMaxMinutes: setCommuteMaxMinutes,
    commuteMode: setCommuteMode,
    locations: setLocations,
  };
  const handleCriteriaFieldChange = (key: keyof CriteriaFormValues, value: string) => {
    // key is constrained to keyof CriteriaFormValues by CriteriaFormFields'
    // own onChange prop type, not arbitrary user input.
    // eslint-disable-next-line security/detect-object-injection
    CRITERIA_FIELD_SETTERS[key](value);
  };

  // AH-020. Populates the structured fields below from a free-text
  // description via Claude tool-use extraction (server-side, see
  // app/api/onboarding/parse-criteria/route.ts + lib/nlpCriteria.ts). Never
  // submits on the user's behalf - it only fills in form state the user
  // still reviews/edits before tapping "Start matching", same as the
  // quick-template pills above. A 503 with reason "not_configured" means the
  // ANTHROPIC_API_KEY isn't set in this environment; other failures are
  // parsing/validation misses - either way this falls back to manual entry
  // rather than blocking the rest of onboarding.
  const handleParseDescription = async () => {
    if (!nlpDescription.trim()) {
      toast.error("Describe what you're looking for first");
      return;
    }

    setNlpLoading(true);
    try {
      const res = await fetch("/api/onboarding/parse-criteria", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: nlpDescription }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Couldn't parse that description");
        return;
      }

      const c: ParsedCriteriaResponse = data.criteria || {};
      if (c.priceMin !== undefined) setPriceMin(String(c.priceMin));
      if (c.priceMax !== undefined) setPriceMax(String(c.priceMax));
      if (c.bedsMin !== undefined) setBedsMin(String(c.bedsMin));
      if (c.bedsMax !== undefined) setBedsMax(String(c.bedsMax));
      if (c.bathsMin !== undefined) setBathsMin(String(c.bathsMin));
      if (c.bathsMax !== undefined) setBathsMax(String(c.bathsMax));
      if (c.pets) setPets(c.pets);
      if (c.laundry) setLaundry(c.laundry);
      if (c.commuteAddress) setCommuteAddress(c.commuteAddress);
      if (c.commuteMaxMinutes !== undefined) setCommuteMaxMinutes(String(c.commuteMaxMinutes));
      if (c.commuteMode) setCommuteMode(c.commuteMode);

      const combinedLocations = [...(c.neighborhoods || []), ...(c.zips || [])];
      if (combinedLocations.length > 0) setLocations(combinedLocations.join(", "));

      // neighborhoods/zips are always present in the response (possibly as
      // empty arrays - see lib/nlpCriteria.ts), so a plain Object.keys(c)
      // check would report "found something" even when nothing meaningful
      // was extracted. Check the actual scalar/array fields instead.
      const foundAnything =
        c.priceMin !== undefined ||
        c.priceMax !== undefined ||
        c.bedsMin !== undefined ||
        c.bedsMax !== undefined ||
        c.bathsMin !== undefined ||
        c.bathsMax !== undefined ||
        Boolean(c.pets) ||
        Boolean(c.laundry) ||
        Boolean(c.commuteAddress) ||
        c.commuteMaxMinutes !== undefined ||
        Boolean(c.commuteMode) ||
        combinedLocations.length > 0;

      if (foundAnything) {
        toast.success("Parsed — review the fields below before continuing");
      } else {
        toast("Didn't find specific criteria in that description — fill in the fields below");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setNlpLoading(false);
    }
  };

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
      setResendCooldown(30);
      setStep("otp");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleResendOtp = async () => {
    if (resendCooldown > 0 || resending || loading) return;

    setResending(true);
    try {
      const res = await fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to resend code");

      toast.success("New code sent");
      setCode("");
      setResendCooldown(30);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setResending(false);
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
        bathsMin: bathsMin ? Number(bathsMin) : undefined,
        bathsMax: bathsMax ? Number(bathsMax) : undefined,
        zips: zips.length > 0 ? zips : undefined,
        neighborhoods: neighborhoods.length > 0 ? neighborhoods : undefined,
        pets: pets || undefined,
        laundry: laundry || undefined,
        // AH-017. All three left empty = no commute filter. The API only
        // computes an isochrone when all three are present together (see
        // app/api/auth/verify-otp/route.ts), so send them as a group.
        commuteAddress: commuteAddress || undefined,
        commuteMaxMinutes: commuteMaxMinutes ? Number(commuteMaxMinutes) : undefined,
        commuteMode: commuteMode || undefined,
      };

      const res = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code, criteria }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to verify OTP");

      toast.success("Verified!");
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

  if (step === "preview") {
    const hasMatches = previewListings.length > 0;

    return (
      <div className="w-full max-w-md mx-auto">
        <div className="text-center mb-6">
          <h2 className="text-2xl font-bold text-white mb-2">
            {previewLoading
              ? "Scanning for matches…"
              : hasMatches
              ? `${previewListings.length} listing${previewListings.length > 1 ? "s" : ""} already match your criteria`
              : "We're scanning for your perfect match"}
          </h2>
          <p className="text-zinc-400 text-sm">
            {hasMatches
              ? "Unlock the full address and listing link when you activate your pass."
              : "We watch 8 listing sources around the clock. Activate your pass and we'll text you the matches as we find them."}
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
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-center">
              <div className="flex justify-center mb-3">
                <BedDouble className="w-8 h-8 text-zinc-600" />
              </div>
              <p className="text-zinc-400 text-sm">
                Activate your pass so future matches on this search get sent to you. You control how many alerts a day and when we&apos;re allowed to text.
              </p>
            </div>
          )}
        </div>

        {hasMatches && (
          <div className="flex items-center gap-2 text-xs text-zinc-500 mb-5">
            <Lock className="w-3 h-3" />
            <span>Full address + listing link unlocked after payment</span>
          </div>
        )}

        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-white font-semibold text-sm">90-Day Pass</p>
              <p className="text-zinc-400 text-xs mt-0.5">Most popular · renews every 3 months, cancel anytime</p>
            </div>
            <div className="text-right">
              <span className="text-white font-bold text-xl">$19</span>
              <span className="text-zinc-500 text-xs ml-1">/3 months</span>
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
    );
  }

  return (
    <div className="w-full max-w-md mx-auto">
      {step === "form" && (
        <div className="mb-6 flex flex-wrap gap-2 justify-center">
          <button 
            type="button" 
            onClick={() => fillTemplate("3000", "1", "Mission")}
            className="text-xs bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 rounded-full px-3 py-1.5 transition-colors"
          >
            1BR under $3K in Mission
          </button>
          <button 
            type="button" 
            onClick={() => fillTemplate("4000", "2", "Marina")}
            className="text-xs bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 rounded-full px-3 py-1.5 transition-colors"
          >
            2BR under $4K in Marina
          </button>
          <button 
            type="button" 
            onClick={() => fillTemplate("2000", "0", "SoMa")}
            className="text-xs bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 rounded-full px-3 py-1.5 transition-colors"
          >
            Studio under $2K in SoMa
          </button>
        </div>
      )}

      <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800 shadow-xl shadow-black/50">
        {step === "form" ? (
          <form onSubmit={handleSendOtp} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">
                Describe what you&apos;re looking for
              </label>
              <textarea
                value={nlpDescription}
                onChange={(e) => setNlpDescription(e.target.value)}
                placeholder="e.g. 2BR under $4500 in the Mission or Hayes Valley, dog friendly, in-unit laundry"
                rows={2}
                className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600 resize-none"
              />
              <div className="flex items-center justify-between gap-2 mt-1.5">
                <p className="text-xs text-zinc-500">
                  Parsed automatically — review before submitting.
                </p>
                <button
                  type="button"
                  onClick={handleParseDescription}
                  disabled={nlpLoading}
                  className="text-xs bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-full px-3 py-1.5 transition-colors shrink-0 flex items-center gap-1"
                >
                  {nlpLoading ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" /> Parsing...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3 h-3" /> Fill in for me
                    </>
                  )}
                </button>
              </div>
            </div>

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

            <CriteriaFormFields values={criteriaFormValues} onChange={handleCriteriaFieldChange} />

            <p className="text-xs text-zinc-500 leading-relaxed pt-2">
              By tapping Start matching, you agree to receive automated SMS from Propinno with matching apartment listings. Msg frequency varies. Msg &amp; data rates may apply. Reply STOP to unsubscribe or HELP for help. See our{" "}
              <a href="/terms" className="underline text-zinc-400 hover:text-white">Terms</a>
              {" "}and{" "}
              <a href="/privacy" className="underline text-zinc-400 hover:text-white">Privacy Policy</a>.
            </p>

            <Button type="submit" className="w-full bg-white text-black hover:bg-zinc-200 mt-2 font-semibold" disabled={loading}>
              {loading ? "Sending..." : "Start matching"}
              {!loading && <Zap className="w-4 h-4 ml-1.5" />}
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
              <div className="text-center mt-2">
                <p className="text-xs text-zinc-500">
                  Code sent to {phone}
                </p>
                <button
                  type="button"
                  onClick={handleResendOtp}
                  disabled={resendCooldown > 0 || resending || loading}
                  className="text-xs text-zinc-400 hover:text-white disabled:text-zinc-600 disabled:hover:text-zinc-600 disabled:cursor-not-allowed transition-colors mt-1"
                >
                  {resending
                    ? "Sending..."
                    : resendCooldown > 0
                    ? `Resend code in ${resendCooldown}s`
                    : "Resend code"}
                </button>
              </div>
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
  );
}
