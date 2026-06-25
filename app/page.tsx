import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-[#080808] text-white">
      <nav className="flex items-center justify-between px-6 py-5 border-b border-white/8">
        <div className="text-lg font-semibold tracking-tight">dealinno</div>
        <a href="mailto:hello@dealinno.com" className="text-sm text-white/40 hover:text-white/70 transition-colors">
          Contact
        </a>
      </nav>

      <div className="max-w-2xl mx-auto px-6 pt-28 pb-20 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 bg-white/5 text-xs text-white/50 mb-10">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          Early access — limited spots
        </div>

        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight leading-[1.1] mb-6">
          Close deals<br />while you sleep
        </h1>
        <p className="text-lg text-white/50 max-w-lg mx-auto mb-12 leading-relaxed">
          Dealinno drafts your scheduling emails, records sales calls, and drops a 
          polished proposal into your Gmail drafts 60 seconds after the call ends — 
          without you doing anything.
        </p>

        <form
          action="https://formspree.io/f/placeholder"
          method="POST"
          className="flex flex-col sm:flex-row gap-3 max-w-sm mx-auto"
        >
          <input
            type="email"
            name="email"
            required
            placeholder="your@email.com"
            className="flex-1 px-4 py-3 rounded-xl bg-white/8 border border-white/10 text-white placeholder-white/25 focus:outline-none focus:border-white/25 text-sm"
          />
          <button
            type="submit"
            className="px-6 py-3 rounded-xl bg-white text-black font-semibold text-sm hover:bg-white/90 transition-colors whitespace-nowrap"
          >
            Get early access
          </button>
        </form>
        <p className="text-xs text-white/25 mt-4">No spam. Unsubscribe anytime.</p>
      </div>

      <div className="max-w-4xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[
            {
              icon: "📬",
              title: "Auto-draft scheduling replies",
              desc: "Detects scheduling emails and drafts replies with your Calendly link and availability — before you open the thread.",
            },
            {
              icon: "🎙️",
              title: "Silent meeting capture",
              desc: "Records and transcribes every sales call locally on your device. No visible bots. No awkward consent warnings to prospects.",
            },
            {
              icon: "📄",
              title: "Proposals in 60 seconds",
              desc: "When the call ends, a proposal referencing exactly what the prospect said lands in your Gmail drafts — ready to send.",
            },
          ].map((f) => (
            <div key={f.title} className="p-6 rounded-2xl border border-white/8 bg-white/3 hover:bg-white/5 transition-colors">
              <div className="text-2xl mb-4">{f.icon}</div>
              <h3 className="font-semibold mb-2 text-sm">{f.title}</h3>
              <p className="text-sm text-white/40 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      <footer className="border-t border-white/8 px-6 py-8">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-white/25">
          <div>© 2026 Dealinno. All rights reserved.</div>
          <div className="flex gap-6">
            <Link href="/privacy" className="hover:text-white/50 transition-colors">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-white/50 transition-colors">Terms</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
