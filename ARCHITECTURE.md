# ARCHITECTURE.md — Dealinno
# Non-obvious technical decisions. Add an entry whenever you make a choice that future devs would question.

---

## 2026-05-27 — NextAuth v5 (beta) over v4
Context: Need Google OAuth with refresh tokens for server-side Gmail API calls in Inngest jobs.
Decision: next-auth@beta (v5) with DrizzleAdapter.
Alternatives: v4 with custom adapter, Supabase Auth with Google provider.
Reason: v5 App Router integration is cleaner, DrizzleAdapter is first-class, callback API makes token mirroring straightforward. v4 has known issues with App Router server components.
Consequences: v5 is still beta — API may change. Pin the exact version in package.json.

---

## 2026-05-27 — Token mirroring into users table
Context: Inngest jobs run outside the request cycle and need Google OAuth tokens to call Gmail API.
Decision: On sign-in, copy access_token + refresh_token + expiry into our users table in addition to NextAuth's own adapter tables.
Alternatives: Look up tokens from NextAuth adapter tables directly in Inngest jobs.
Reason: NextAuth adapter table structure is internal and subject to change. Owning the token columns in our users table gives us stable column names and lets us add token refresh logic without touching NextAuth internals.
Consequences: Tokens exist in two places. Must keep them in sync — auth.ts signIn callback handles this.

---

## 2026-05-27 — Inngest over direct Pub/Sub processing
Context: Gmail Pub/Sub webhook fires on every new email. Need to fetch email, classify, draft reply.
Decision: Webhook returns 200 immediately and fires an Inngest event. Inngest job does all the work.
Alternatives: Process everything inline in the webhook handler.
Reason: Pub/Sub retries indefinitely on non-200 responses. If Gmail API or OpenAI is slow/down, inline processing would cause retry storms. Inngest gives us: async execution, automatic retries with backoff, concurrency control per userId (prevents duplicate drafts), step-level observability.
Consequences: There's a delay between email arrival and draft appearing (seconds, not instant). Acceptable for this use case.

---

## 2026-05-27 — GPT-4o mini for email classification + drafting
Context: Need to classify email intent and generate reply drafts. Two separate AI calls per email.
Decision: GPT-4o mini for both classification and draft generation.
Alternatives: Claude Haiku (cheaper but less reliable JSON output), Claude Sonnet (better quality, 5x cost).
Reason: GPT-4o mini is excellent at structured JSON output (classification) and email writing (drafting). Cost is ~$0.60 per 10,000 emails classified — trivially cheap. Sonnet's quality improvement doesn't justify 5x cost for this task.
Consequences: If OpenAI has outages, email drafting stops. Consider Claude Haiku as fallback in future.

---

## 2026-05-27 — Drizzle ORM over Prisma
Context: Need a TypeScript ORM for Supabase/Postgres.
Decision: Drizzle ORM.
Alternatives: Prisma, raw postgres queries.
Reason: Drizzle has no code generation step, works natively in Edge/serverless, schema is plain TypeScript (easier for AI agents to read and write correctly), significantly smaller bundle size. Prisma's generated client is heavy for Vercel serverless.
Consequences: Drizzle's migration tooling (drizzle-kit push) is simpler but less sophisticated than Prisma Migrate. Fine for this stage.

---

## 2026-05-27 — Upstash Redis for rate limiting
Context: Need rate limiting on API routes, especially the Gmail webhook and doc generation.
Decision: Upstash Ratelimit with sliding window algorithm.
Alternatives: Vercel Edge Rate Limiting (paid), in-memory (doesn't work across serverless instances), Cloudflare.
Reason: Upstash is serverless-native, free tier covers beta volume, integrates cleanly with Next.js App Router, library (@upstash/ratelimit) has clean API.
Consequences: Rate limit state lives in Redis — adds ~10ms latency per rate-limited route. Acceptable.

---

## 2026-05-27 — Pino + Axiom for logging
Context: Need structured, searchable logs for debugging email agent in production.
Decision: Pino (logger) + Axiom (log ingestion/storage).
Alternatives: Winston + Logtail, console.log, Datadog (expensive), Sentry alone.
Reason: Pino is the fastest Node.js logger with minimal overhead. Axiom free tier is generous (unlimited ingestion up to 500GB/month retention). Together they give structured JSON logs with a good query UI. Sentry is for errors, Axiom is for operational logs — different jobs.
Consequences: Two observability tools to manage. Sentry for exceptions, Axiom for logs. Don't conflate them.

---

## 2026-05-28 — Testing Stack, Security Audits & PR Gates
Context: Need structured testing and static security checks to ensure code quality and prevent regressions in production without blocking development velocity.
Decision: Use Vitest + JSDOM for unit/component tests, Playwright for E2E browser integration tests, and eslint-plugin-security for static code audits. Enforce checking these rules before PR merges on Git branches.
Alternatives: Jest (heavier config, slower than Vitest), React Testing Library inside Playwright (too heavy for fast component feedback), SonarQube (complex setup for early stage).
Reason: Vitest uses the same config and transforms as Next.js/Webpack/Vite, making it fast and lightweight with alias support. Playwright runs E2E flows against a live local server instance. E2E tests are configured in the E2E directory to separate them from fast unit testing runs.
Consequences: Development requires running validation suites locally. GitHub Actions PR pipeline enforces green checks on the new `feat/testing-framework` branch and all future feature branches.

