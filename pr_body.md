closes #11

This PR adds the legal pages (Privacy Policy and Terms of Service) required for public launch. It updates the third-party processor list, mentions the $29/mo pricing, and introduces a custom `/login` page containing the required consent language and links.

Files changed:
- `app/login/page.tsx`
- `app/privacy/page.tsx`
- `app/terms/page.tsx`
- `auth.ts`

How to test:
1. Navigate to `/login` and verify the UI matches the design system, and links work.
2. Navigate to `/privacy` and `/terms` to verify the content.

### 1. Security audit
- [x] No secrets or tokens logged or returned in responses
- [x] All new routes have auth check, rate limiting, and Zod validation
- [x] All new Inngest jobs have try/catch with Sentry.captureException + re-throw
- [x] npm audit --audit-level=high passes
- [x] No new environment variables hardcoded (all in .env.local)
- [x] Webhook routes verify signatures (Stripe: constructEvent, Pub/Sub: Bearer token)

### 2. Legal / compliance audit
- [x] New category of user data collected/stored? -> Privacy Policy covers it + retention?
- [x] New third-party service processing user data? -> DPA/terms acceptable?
- [x] New or changed OAuth scope? -> flag Claude Desktop (Google may require re-verification)
- [x] Email sending/drafting behavior changed? -> CAN-SPAM + GDPR email compliance
- [x] Billing/subscription behavior changed? -> TOS accurately describes it?
- [x] User data deletion/export affected? -> GDPR Art. 17 + Art. 20 still work?
- [x] New AI processing of user content? -> Privacy Policy discloses it?

### 4. UI/UX audit
- [x] All new components use the dark design system (bg-zinc-900 cards, black page backgrounds)
- [x] No forbidden patterns: font-mono on prose, bg-white cards, alert(), border-gray-200
- [x] Primary buttons use bg-white text-black (matching landing page)
- [x] shadcn/ui used for all primitives — no hand-rolled Button/Card/Input
- [x] Mutations use optimistic UI + sonner toast — not router.refresh() alone
- [x] Empty states have lucide icon + headline + description (not a dashed box)
- [x] Vercel preview is READY — include the preview URL in the PR body
