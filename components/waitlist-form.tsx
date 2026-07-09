"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Zap, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";

export function WaitlistForm() {
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [showCriteria, setShowCriteria] = useState(false);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [bedsMin, setBedsMin] = useState("");
  const [bedsMax, setBedsMax] = useState("");
  const [locations, setLocations] = useState("");
  const fillTemplate = (pMax: string, bMin: string, locs: string) => { setPriceMax(pMax); setBedsMin(bMin); setLocations(locs); setShowCriteria(true); };
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email && !phone) { toast.error("Please enter your email or phone number"); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast.error("Please enter a valid email address"); return; }
    setLoading(true);
    try {
      const locationList = locations.split(",").map((l) => l.trim()).filter(Boolean);
      const zips = locationList.filter((l) => /^\d{5}$/.test(l));
      const neighborhoods = locationList.filter((l) => !/^\d{5}$/.test(l));
      const res = await fetch("/api/waitlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email || undefined, phone: phone || undefined, priceMin: priceMin ? Number(priceMin) : undefined, priceMax: priceMax ? Number(priceMax) : undefined, bedsMin: bedsMin ? Number(bedsMin) : undefined, bedsMax: bedsMax ? Number(bedsMax) : undefined, neighborhoods: neighborhoods.length > 0 ? neighborhoods : undefined, zips: zips.length > 0 ? zips : undefined }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to join waitlist");
      setSubmitted(true); toast.success("You're on the list!");
    } catch (err) { toast.error(err instanceof Error ? err.message : String(err)); } finally { setLoading(false); }
  };
  if (submitted) {
    return (<div className="w-full max-w-md mx-auto"><div className="bg-zinc-900 rounded-xl p-8 border border-zinc-800 shadow-xl shadow-black/50 text-center"><CheckCircle2 className="w-12 h-12 text-white mx-auto mb-4" /><h3 className="text-xl font-bold text-white mb-2">You&apos;re on the list!</h3><p className="text-zinc-400 text-sm">We&apos;re launching soon. You&apos;ll be the first to know when Propinno goes live.</p></div></div>);
  }
  return (
    <div className="w-full max-w-md mx-auto">
      <div className="mb-6 flex flex-wrap gap-2 justify-center">
        <button type="button" onClick={() => fillTemplate("3000","1","Mission")} className="text-xs bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 rounded-full px-3 py-1.5 transition-colors">1BR under $3K in Mission</button>
        <button type="button" onClick={() => fillTemplate("4000","2","Marina")} className="text-xs bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 rounded-full px-3 py-1.5 transition-colors">2BR under $4K in Marina</button>
        <button type="button" onClick={() => fillTemplate("2000","0","SoMa")} className="text-xs bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 rounded-full px-3 py-1.5 transition-colors">Studio under $2K in SoMa</button>
      </div>
      <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800 shadow-xl shadow-black/50">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div><label className="block text-sm font-medium text-zinc-300 mb-1">Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600" /></div>

          <button type="button" onClick={() => setShowCriteria(!showCriteria)} className="flex items-center justify-between w-full text-sm text-zinc-400 hover:text-white transition-colors">
            <span>Add your criteria <span className="text-zinc-600">(optional)</span></span>
            {showCriteria ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {showCriteria && (
            <div className="space-y-4">
              <div><label className="block text-sm font-medium text-zinc-300 mb-1">Phone Number <span className="text-zinc-500">(optional)</span></label><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(415) 555-0123" className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600" /></div>
              <div className="grid grid-cols-2 gap-4"><div><label className="block text-sm font-medium text-zinc-300 mb-1">Min Price</label><input type="number" value={priceMin} onChange={(e) => setPriceMin(e.target.value)} placeholder="$2,000" className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600" /></div><div><label className="block text-sm font-medium text-zinc-300 mb-1">Max Price</label><input type="number" value={priceMax} onChange={(e) => setPriceMax(e.target.value)} placeholder="$4,000" className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600" /></div></div>
              <div className="grid grid-cols-2 gap-4"><div><label className="block text-sm font-medium text-zinc-300 mb-1">Min Beds</label><input type="number" value={bedsMin} onChange={(e) => setBedsMin(e.target.value)} placeholder="1" className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600" /></div><div><label className="block text-sm font-medium text-zinc-300 mb-1">Max Beds</label><input type="number" value={bedsMax} onChange={(e) => setBedsMax(e.target.value)} placeholder="2" className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600" /></div></div>
              <div><label className="block text-sm font-medium text-zinc-300 mb-1">Neighborhoods or Zips (comma separated)</label><input type="text" value={locations} onChange={(e) => setLocations(e.target.value)} placeholder="Marina, 94123, Mission" className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600" /></div>
            </div>
          )}

          <p className="text-xs text-zinc-500 leading-relaxed pt-2">By joining the waitlist, you agree to receive apartment listing alerts via SMS from Propinno if you provide a phone number. Msg frequency varies. Msg &amp; data rates may apply. Reply STOP to unsubscribe or HELP for help. See our{" "}<a href="/terms" className="underline text-zinc-400 hover:text-white">Terms</a>{" "}and{" "}<a href="/privacy" className="underline text-zinc-400 hover:text-white">Privacy Policy</a>.</p>
          <button type="submit" disabled={loading} className="w-full mt-2 py-3 px-4 rounded-md font-semibold text-base transition-opacity flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed" style={{backgroundColor:"#fff",color:"#000"}}>{loading ? "Joining..." : "Join the waitlist"}{!loading && <Zap className="w-4 h-4" />}</button>
        </form>
      </div>
    </div>
  );
}
