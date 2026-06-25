export default function TermsPage() {
  return (
    <div className="min-h-screen bg-black text-zinc-300 p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold text-white">Terms of Service</h1>
        <p>Last updated: June 25, 2026</p>
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">1. Service Description</h2>
          <p>Propinno provides automated SF apartment-matching SMS alerts.</p>
        </section>
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">2. Pricing & Access</h2>
          <p>We offer two one-time passes: $39 for a 30-day pass, and $69 for a 90-day pass. There are no recurring subscriptions.</p>
        </section>
      </div>
    </div>
  );
}
