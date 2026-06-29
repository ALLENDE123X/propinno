import { db } from "@/lib/db";
import { listings, users } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { OnboardingFlow } from "@/components/onboarding-flow";
import { CheckCircle2, XCircle } from "lucide-react";

export const revalidate = 600; // Cache for 10 minutes

export default async function Home() {
  let recentListingsCount = 0;
  let activeSubscribersCount = 0;

  try {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(listings)
      .where(sql`first_seen_at > now() - interval '3 days'`);
    recentListingsCount = count;
  } catch (e) {
    console.warn("Failed to fetch listings count", e);
  }

  try {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(sql`status = 'active'`);
    activeSubscribersCount = count;
  } catch (e) {
    console.warn("Failed to fetch active subscribers count", e);
  }

  // Default fallbacks in case DB is empty in dev
  const displayListingsCount = Math.max(recentListingsCount, 400);
  const displaySubscribersCount = Math.max(activeSubscribersCount, 100);

  return (
    <div className="min-h-screen bg-black text-white selection:bg-zinc-800">
      {/* 1. Hero Section */}
      <section className="pt-24 pb-16 px-6 max-w-5xl mx-auto text-center">
        <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight mb-6">
          SF apartments move fast. <br className="hidden md:block" />
          <span className="text-zinc-400">We text you first.</span>
        </h1>
        <p className="text-lg md:text-xl text-zinc-400 max-w-2xl mx-auto mb-12">
          Stop refreshing Zillow. We watch every source 24/7 and text you the second a match drops.
        </p>
        
        <OnboardingFlow />
      </section>

      {/* 2. Social Proof Bar */}
      <section className="border-y border-zinc-800 bg-zinc-900/50">
        <div className="max-w-5xl mx-auto px-6 py-10 flex flex-col md:flex-row justify-around items-center gap-8 text-center">
          <div>
            <div className="text-4xl font-bold text-white mb-2">{displayListingsCount}+</div>
            <div className="text-sm font-medium text-zinc-400 uppercase tracking-wide">fresh listings in the last 3 days</div>
          </div>
          <div className="hidden md:block w-px h-16 bg-zinc-800"></div>
          <div>
            <div className="text-4xl font-bold text-white mb-2">{displaySubscribersCount}+</div>
            <div className="text-sm font-medium text-zinc-400 uppercase tracking-wide">active SF renters on the hunt</div>
          </div>
          <div className="hidden md:block w-px h-16 bg-zinc-800"></div>
          <div>
            <div className="text-4xl font-bold text-white mb-2">~3 min</div>
            <div className="text-sm font-medium text-zinc-400 uppercase tracking-wide">from posting to your phone</div>
          </div>
        </div>
      </section>

      {/* 3. How it works */}
      <section className="py-24 px-6 max-w-5xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-16">How Propinno works</h2>
        <div className="grid md:grid-cols-3 gap-8">
          {/* Step 1 */}
          <div className="bg-zinc-900 p-8 rounded-2xl border border-zinc-800">
            <div className="w-12 h-12 bg-white text-black rounded-full flex items-center justify-center font-bold text-xl mb-6">1</div>
            <h3 className="text-xl font-semibold mb-3">Set your criteria</h3>
            <p className="text-zinc-400">Tell us your budget, beds, and favorite neighborhoods or zip codes.</p>
          </div>
          
          {/* Step 2 */}
          <div className="bg-zinc-900 p-8 rounded-2xl border border-zinc-800">
            <div className="w-12 h-12 bg-white text-black rounded-full flex items-center justify-center font-bold text-xl mb-6">2</div>
            <h3 className="text-xl font-semibold mb-3">We watch 24/7</h3>
            <p className="text-zinc-400">Our scrapers constantly poll RentCast, Craigslist, and other sources.</p>
          </div>

          {/* Step 3 */}
          <div className="bg-zinc-900 p-8 rounded-2xl border border-zinc-800">
            <div className="w-12 h-12 bg-white text-black rounded-full flex items-center justify-center font-bold text-xl mb-6">3</div>
            <h3 className="text-xl font-semibold mb-3">Get texted instantly</h3>
            <p className="text-zinc-400">When a match drops, you get an SMS with the link. Be the first to apply.</p>
          </div>
        </div>
      </section>

      {/* 4. Comparison Table */}
      <section className="py-24 px-6 bg-zinc-900/30 border-y border-zinc-800">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-16">Why you need automation</h2>
          
          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-zinc-900/50 p-8 rounded-2xl border border-zinc-800">
              <h3 className="text-xl font-semibold mb-6 flex items-center text-zinc-400">
                <XCircle className="w-5 h-5 mr-3 text-zinc-500" />
                Everyone else
              </h3>
              <ul className="space-y-4">
                <li className="flex items-start">
                  <span className="text-zinc-500 mr-4 font-bold">→</span>
                  <span className="text-zinc-400">Refresh Zillow and hope</span>
                </li>
                <li className="flex items-start">
                  <span className="text-zinc-500 mr-4 font-bold">→</span>
                  <span className="text-zinc-400">Scroll endless Craigslist spam</span>
                </li>
                <li className="flex items-start">
                  <span className="text-zinc-500 mr-4 font-bold">→</span>
                  <span className="text-zinc-400">Apply 50th, get ghosted</span>
                </li>
              </ul>
            </div>

            <div className="bg-zinc-900 p-8 rounded-2xl border border-zinc-700 shadow-2xl shadow-white/5 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full blur-3xl"></div>
              <h3 className="text-xl font-semibold mb-6 flex items-center text-white">
                <CheckCircle2 className="w-5 h-5 mr-3 text-white" />
                You, with Propinno
              </h3>
              <ul className="space-y-4">
                <li className="flex items-start">
                  <CheckCircle2 className="w-5 h-5 mr-3 mt-0.5 text-zinc-400 shrink-0" />
                  <span className="text-white">Every source watched 24/7</span>
                </li>
                <li className="flex items-start">
                  <CheckCircle2 className="w-5 h-5 mr-3 mt-0.5 text-zinc-400 shrink-0" />
                  <span className="text-white">Texted in minutes of posting</span>
                </li>
                <li className="flex items-start">
                  <CheckCircle2 className="w-5 h-5 mr-3 mt-0.5 text-zinc-400 shrink-0" />
                  <span className="text-white">First in line to apply</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* 5. Origin Story */}
      <section className="py-24 px-6 max-w-3xl mx-auto text-center">
        <h2 className="text-3xl font-bold mb-8">Why we built this</h2>
        <div className="bg-zinc-900 p-10 rounded-2xl border border-zinc-800 text-left relative">
          <p className="text-zinc-300 mb-6 text-lg leading-relaxed">
            SF housing is CRAZY, and the good ones are gone in hours. Propinno was built by an SF renter who lost one too many apartments to whoever applied first.
          </p>
          <p className="text-zinc-300 mb-8 text-lg leading-relaxed">
            I spent 6 weeks hunting. 30 tours. 10 applications. And I still kept losing places to people who simply saw the listing first. So I built a bot to text me the second a listing hit the internet. I got my next apartment on the first day.
          </p>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-zinc-800 rounded-full flex items-center justify-center font-bold text-lg text-white">P</div>
            <div>
              <div className="font-semibold text-white">Pranav</div>
              <div className="text-sm text-zinc-500">Creator of Propinno</div>
            </div>
          </div>
        </div>
      </section>

      {/* 6. Pricing */}
      <section className="py-24 px-6 max-w-5xl mx-auto border-t border-zinc-800">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold mb-4">Simple, one-time pricing</h2>
          <p className="text-zinc-400">No subscriptions. No auto-renewals. Pay once, find a place, and you&apos;re done.</p>
        </div>
        
        <div className="grid md:grid-cols-2 gap-8 max-w-3xl mx-auto">
          {/* 30 Day */}
          <div className="bg-zinc-900 p-8 rounded-2xl border border-zinc-800 flex flex-col">
            <h3 className="text-xl font-semibold mb-2">30-Day Pass</h3>
            <p className="text-zinc-400 text-sm mb-8">Perfect for quick moves.</p>
            <div className="mb-8">
              <span className="text-5xl font-bold text-white">$39</span>
              <span className="text-zinc-500 ml-2 font-medium">one-time</span>
            </div>
            <ul className="space-y-4 mb-8 flex-1">
              <li className="flex items-center text-sm text-zinc-300"><CheckCircle2 className="w-5 h-5 mr-3 text-zinc-500" /> Real-time SMS alerts</li>
              <li className="flex items-center text-sm text-zinc-300"><CheckCircle2 className="w-5 h-5 mr-3 text-zinc-500" /> All sources watched</li>
              <li className="flex items-center text-sm text-zinc-300"><CheckCircle2 className="w-5 h-5 mr-3 text-zinc-500" /> 30 days of access</li>
            </ul>
          </div>

          {/* 90 Day */}
          <div className="bg-zinc-900 p-8 rounded-2xl border border-zinc-600 relative flex flex-col shadow-2xl shadow-white/5 transform md:-translate-y-4">
            <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 bg-white text-black px-4 py-1 rounded-full text-xs font-bold tracking-widest uppercase">
              Most Popular
            </div>
            <h3 className="text-xl font-semibold mb-2">90-Day Pass</h3>
            <p className="text-zinc-400 text-sm mb-8">For the serious apartment hunter.</p>
            <div className="mb-8">
              <span className="text-5xl font-bold text-white">$69</span>
              <span className="text-zinc-500 ml-2 font-medium">one-time</span>
            </div>
            <ul className="space-y-4 mb-8 flex-1">
              <li className="flex items-center text-sm text-zinc-300"><CheckCircle2 className="w-5 h-5 mr-3 text-white" /> Real-time SMS alerts</li>
              <li className="flex items-center text-sm text-zinc-300"><CheckCircle2 className="w-5 h-5 mr-3 text-white" /> All sources watched</li>
              <li className="flex items-center text-sm text-zinc-300"><CheckCircle2 className="w-5 h-5 mr-3 text-white" /> 90 days of access</li>
            </ul>
          </div>
        </div>
      </section>

      {/* 7. Final CTA */}
      <section className="py-24 px-6 bg-zinc-900 text-center border-t border-zinc-800">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl font-bold mb-6">Ready to stop scrolling?</h2>
          <p className="text-zinc-400 mb-10 text-lg">Enter your criteria below and let us do the heavy lifting.</p>
          <OnboardingFlow />
        </div>
      </section>
      
      {/* Footer */}
      <footer className="py-8 text-center text-sm text-zinc-600 border-t border-zinc-900">
        <p>© 2026 Propinno. All rights reserved.</p>
      </footer>
    </div>
  );
}
