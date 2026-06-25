import Link from "next/link";

export const metadata = {
  title: "Privacy Policy — Dealinno",
};

export default function Privacy() {
  return (
    <main className="min-h-screen bg-[#080808] text-white">
      <nav className="flex items-center px-6 py-5 border-b border-white/8">
        <Link href="/" className="text-lg font-semibold tracking-tight">dealinno</Link>
      </nav>
      <div className="max-w-2xl mx-auto px-6 py-20">
        <h1 className="text-4xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-white/40 text-sm mb-12">Last updated: May 26, 2026</p>

        <div className="space-y-10 text-white/70 leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-white mb-4">Overview</h2>
            <p>Dealinno (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) is a sales workflow automation tool. This Privacy Policy explains how we collect, use, and protect your data when you use our service. We take your privacy seriously — especially as it relates to your email and calendar data.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">Gmail and Google Data</h2>
            <p className="mb-4">Dealinno integrates with Gmail and Google Calendar to automate your sales workflow. Specifically, we access your Google account to:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Read incoming emails to detect scheduling intent and sales-related threads</li>
              <li>Create draft replies in your Gmail account on your behalf</li>
              <li>Read your Google Calendar to check your availability when drafting scheduling emails</li>
              <li>Send emails on your behalf only after your explicit approval</li>
            </ul>
            <p className="mt-4"><strong className="text-white">We do not:</strong></p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>Read, store, or process emails unrelated to your sales workflow</li>
              <li>Share your email content with third parties for advertising or any other purpose</li>
              <li>Use your email data to train AI models</li>
              <li>Send emails without your review and explicit approval</li>
            </ul>
            <p className="mt-4">Our use of Gmail data is limited to providing and improving the Dealinno service. We comply with the <a href="https://developers.google.com/terms/api-services-user-data-policy" className="text-white underline hover:text-white/80">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">Meeting Recordings and Transcripts</h2>
            <p>Dealinno captures meeting audio locally on your device using your operating system&apos;s audio APIs. Audio is processed and transcribed using third-party transcription services (Deepgram). Transcripts are stored securely in your account and are never shared with other users or third parties. You can delete your transcripts at any time from your dashboard.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">Data We Collect</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong className="text-white">Account data:</strong> Your name and email address when you sign up</li>
              <li><strong className="text-white">Email metadata:</strong> Sender, subject, and thread IDs of emails we process (not full email bodies beyond what is necessary for scheduling intent detection)</li>
              <li><strong className="text-white">Calendar data:</strong> Your calendar availability windows to generate scheduling suggestions</li>
              <li><strong className="text-white">Meeting transcripts:</strong> Audio transcriptions from sales calls you record with Dealinno</li>
              <li><strong className="text-white">Generated documents:</strong> Proposals, follow-ups, and other documents we generate for you</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">Data Storage and Security</h2>
            <p>Your data is stored in encrypted databases (Supabase/PostgreSQL). All data is encrypted in transit using TLS and at rest using AES-256. We use Supabase for data storage, which is SOC 2 compliant. We retain your data for as long as you have an accive account. You can request deletion of your data at any time.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">Third-Party Services</h2>
            <p>We use the following third-party services to operate Dealinno:</p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li><strong className="text-white">Google APIs</strong> — Gmail and Calendar integration</li>
              <li><strong className="text-white">Deepgram</strong> — Audio transcription</li>
              <li><strong className="text-white">OpenAI</strong> — AI-powered draft and document generation</li>
              <li><strong className="text-white">Supabase</strong> — Database and authentication</li>
              <li><strong className="text-white">Vercel</strong> — Hosting and deployment</li>
              <li><strong className="text-white">Axiom</strong> — Logging and observability</li>
              <li><strong className="text-white">Sentry</strong> — Error tracking</li>
            </ul>
            <p className="mt-4">Each of these services has their own privacy policy and data handling practices. We do not sell your data to any third party.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">Revoking Access</h2>
            <p>You can revoke Dealinno&apos;s access to your Google account at any time by visiting <a href="https://myaccount.google.com/permissions" className="text-white underline hover:text-white/80">Google Account Permissions</a>. You can also delete your Dealinno account and all associated data by contacting us at <a href="mailto:privacy@dealinno.com" className="text-white underline hover:text-white/80">privacy@dealinno.com</a>.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">Contact</h2>
            <p>For any privacy-related questions or data deletion requests, contact us at <a href="mailto:privacy@dealinno.com" className="text-white underline hover:text-white/80">privacy@dealinno.com</a>.</p>
          </section>
        </div>
      </div>
    </main>
  );
}
