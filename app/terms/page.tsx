export default function TermsPage() {
  return (
    <div className="min-h-screen bg-black text-zinc-300 p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold text-white">Terms of Service</h1>
        <p>Last updated: June 29, 2026</p>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">1. Service Description</h2>
          <p>
            Propinno is an automated apartment-matching SMS alert service for San Francisco renters. We monitor multiple rental listing sources, match new listings against your saved search criteria, and send you text message notifications when we find a match.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">2. Eligibility</h2>
          <p>
            You must be at least 18 years old and have a valid US phone number to use Propinno. By signing up, you represent that you meet these requirements.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">3. Account and Phone Verification</h2>
          <p>
            To use Propinno, you must provide a valid phone number and verify it using a one-time passcode (OTP) sent via SMS. This verified phone number is used to deliver your listing alerts.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">4. Pricing and Payment</h2>
          <p>Propinno offers two one-time access passes:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li><strong className="text-white">30-Day Pass:</strong> $39 (one-time payment)</li>
            <li><strong className="text-white">90-Day Pass:</strong> $69 (one-time payment)</li>
          </ul>
          <p>
            There are no recurring subscriptions or automatic renewals. Your pass expires at the end of the purchased period. Payments are processed securely by Stripe.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">5. SMS Messaging Terms</h2>
          <p>
            By verifying your phone number and purchasing an access pass on Propinno, you expressly consent to receive automated SMS text messages from Propinno at the phone number you provided. These messages will contain apartment listing alerts matching your search criteria.
          </p>
          <ul className="list-disc pl-6 space-y-2">
            <li><strong className="text-white">Program name:</strong> Propinno Apartment Alerts</li>
            <li><strong className="text-white">Message frequency:</strong> Message frequency varies. You may receive multiple messages per day depending on listing availability in your selected neighborhoods and price range.</li>
            <li><strong className="text-white">Message and data rates may apply.</strong> Check with your wireless carrier for details.</li>
            <li><strong className="text-white">To opt out:</strong> Text STOP to any Propinno message to unsubscribe from all future alerts.</li>
            <li><strong className="text-white">To get help:</strong> Text HELP to any Propinno message for support, or email propinno.app@gmail.com.</li>
          </ul>
          <p>
            Consent to receive SMS messages is not required as a condition of purchasing any goods or services, though an active access pass is required for listing alerts to be delivered.
          </p>
          <p>
            Carriers are not liable for delayed or undelivered messages.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">6. Listing Data</h2>
          <p>
            Propinno aggregates publicly available rental listing data from third-party sources. We do not guarantee the accuracy, availability, or completeness of any listing information. Listings may be removed or rented before you are able to respond. Propinno is not a real estate broker and does not participate in rental transactions.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">7. Refund Policy</h2>
          <p>
            Access passes are non-refundable once purchased. If you experience a technical issue that prevents the service from functioning, contact us at propinno.app@gmail.com and we will work to resolve the issue or provide a credit at our discretion.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">8. Limitation of Liability</h2>
          <p>
            Propinno is provided &quot;as is&quot; without warranties of any kind. We are not responsible for missed listings, inaccurate listing data, SMS delivery delays, or any decisions you make based on the information we provide. Our total liability is limited to the amount you paid for your access pass.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">9. Modifications</h2>
          <p>
            We may update these terms at any time. Changes will be posted on this page with an updated date. Continued use of the service after changes constitutes acceptance.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-white">10. Contact</h2>
          <p>
            For questions about these terms or the Propinno service, contact us at:
          </p>
          <p className="text-white">propinno.app@gmail.com</p>
        </section>
      </div>
    </div>
  );
}
