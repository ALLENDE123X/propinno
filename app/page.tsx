"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export default function Home() {
  const router = useRouter();
  const [step, setStep] = useState<"form" | "otp">("form");
  const [loading, setLoading] = useState(false);
  
  const [phone, setPhone] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [bedsMin, setBedsMin] = useState("");
  const [bedsMax, setBedsMax] = useState("");
  const [locations, setLocations] = useState("");
  const [code, setCode] = useState("");

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
      // Parse locations into zips/neighborhoods
      const locationList = locations.split(",").map(l => l.trim()).filter(Boolean);
      // We can just pass them all as neighborhoods for simplicity, 
      // or try to parse numeric ones as zips.
      const zips = locationList.filter(l => /^\d{5}$/.test(l));
      const neighborhoods = locationList.filter(l => !/^\d{5}$/.test(l));

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
      
      toast.success("Verified successfully!");
      // Redirect to payment preview or checkout (AH-004 / AH-011)
      router.push(`/checkout`); 
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

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
