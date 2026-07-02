export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-black text-zinc-300 p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold text-white">Privacy Policy</h1>
        <p>Last updated: June 29, 2026</p>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">1. Information We Collect</h2>
          <p>
            When you use Propinno, we collect the following information:
          </p>
          <ul className="list-disc pl-6 space-y-2">
            <li><strong className="text-white">Phone number</strong> — provided during sign-up and verified via a one-time passcode (OTP). Used to send you SMS listing alerts.</li>
            <li><strong className="text-white">Search criteria</strong> — your preferred price range, number of bedrooms, and neighborhoods. Used to match you with relevant apartment listings.</li>
            <li><strong className="text-white">Payment information</strong> — processed securely by Stripe. We do not store your credit card number, CVV, or billing details on our servers.</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">2. How We Use Your Information</h2>
          <p>Your information is used strictly to provide the Propinno service:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li>To verify your identity via phone number OTP</li>
            <li>To match apartment listings against your search criteria</li>
            <li>To send you SMS notifications when matching listings are found</li>
            <li>To process your one-time access pass payment</li>
          </ul>
          <p>
            We do not sell, rent, or share your personal information with third parties for marketing purposes. We do not send promotional or marketing messages. All SMS messages are transactional listing alerts that you opted into.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">3. Third-Party Services</h2>
          <p>We use the following third-party services to operate Propinno:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li><strong className="text-white">Twilio</strong> — for phone number verification (OTP) and SMS delivery</li>
            <li><strong className="text-white">Stripe</strong> — for secure payment processing</li>
            <li><strong className="text-white">Supabase</strong> — for secure data storage</li>
            <li><strong className="text-white">Vercel</strong> — for web application hosting</li>
          </ul>
          <p>Each of these services has their own privacy policy governing how they handle your data.</p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">4. SMS Messaging</h2>
          <p>
            By providing your phone number and purchasing an access pass, you consent to receive automated SMS messages from Propinno containing apartment listing alerts that match your search criteria.
          </p>
          <ul className="list-disc pl-6 space-y-2">
            <li><strong className="text-white">Message frequency:</strong> Varies based on listing availability. You may receive multiple messages per day when matching listings are found.</li>
            <li><strong className="text-white">Message and data rates may apply.</strong> Contact your wireless carrier for details about your messaging plan.</li>
            <li><strong className="text-white">To opt out:</strong> Reply STOP to any message at any time to stop receiving alerts.</li>
            <li><strong className="text-white">To get help:</strong> Reply HELP to any message for support information.</li>
          </ul>
          <p>Your consent to receive SMS messages is not a condition of any purchase, though an active access pass is required for listing alerts to be sent.</p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">5. Data Retention and Deletion</h2>
          <p>
            We retain your phone number and search criteria for the duration of your active access pass. After your pass expires, your data is retained for up to 30 days to allow for reactivation, after which it may be deleted.
          </p>
          <p>
            You may request deletion of your data at any time by contacting us at the email below.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">6. Security</h2>
          <p>
            We use industry-standard security measures to protect your data, including encrypted connections (HTTPS/TLS), secure database hosting, and tokenized payment processing through Stripe.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">7. Changes to This Policy</h2>
          <p>
            We may update this privacy policy from time to time. Changes will be posted on this page with an updated date. Continued use of the service after changes constitutes acceptance of the updated policy.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">8. Contact Us</h2>
          <p>
            If you have questions about this privacy policy or your data, contact us at:
          </p>
          <p className="text-white">propinno.app@gmail.com</p>
        </section>
      </div>
    </div>
  );
}
