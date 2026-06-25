import Link from "next/link";

export const metadata = {
  title: "Terms of Service — Dealinno",
};

export default function Terms() {
  return (
    <main className="min-h-screen bg-[#080808] text-white">
      <nav className="flex items-center px-6 py-5 border-b border-white/8">
        <Link href="/" className="text-lg font-semibold tracking-tight">dealinno</Link>
      </nav>
      <div className="max-w-2xl mx-auto px-6 py-20">
        <h1 className="text-4xl font-bold mb-2">Terms of Service</h1>
        <p className="text-white/40 text-sm mb-12">Last updated: May 26, 2026</p>

        <div className="space-y-10 text-white/70 leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-white mb-4">Acceptance</h2>
            <p>By using Dealinno, you agree to these Terms of Service. If you do not agree, do not use the service.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">Description of Service</h2>
            <p>Dealinno is a sales workflow automation tool that integrates with Gmail, Google Calendar, and other services to help you manage scheduling, meeting capture, and document generation.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">Acceptable Use</h2>
            <p>You agree to use Dealinno only for lawful purposes and in compliance with all applicable laws, including email and recording consent laws in your jurisdiction. You are responsible for obtaining any required consent from meeting participants before recording.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">Billing and Cancellation</h2>
            <p>Dealinno is a paid service with a subscription fee of $29/month. Your subscription will automatically renew each month. You may cancel your subscription at any time from your account settings. Upon cancellation, you will retain access to the service until the end of your current billing period. All fees are non-refundable except where required by law.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibent text-white mb-4">Limitation of Liability</h2>
            <p>Dealinno is provided &quot;as is&quot; without warranty of any kind. We are not liable for any indirect, incidental, or consequential damages arising from your use of the service.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">Contact</h2>
            <p>Questions? Email <a href="mailto:hello@dealinno.com" className="text-white underline hover:text-white/80">hello@dealinno.com</a>.</p>
          </section>
        </div>
      </div>
    </main>
  );
}
