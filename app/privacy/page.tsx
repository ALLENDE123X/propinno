export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-black text-zinc-300 p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold text-white">Privacy Policy</h1>
        <p>Last updated: June 25, 2026</p>
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">1. Information We Collect</h2>
          <p>We collect your phone number and search criteria to provide SMS listing alerts.</p>
        </section>
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">2. How We Use Information</h2>
          <p>Your information is used strictly to poll rental-listing data sources and text you matches.</p>
        </section>
      </div>
    </div>
  );
}
