# AGENTS.md — Dealinno
# Read this before every task. These rules are non-negotiable.

## What This Project Is
Dealinno is an autonomous sales workflow tool. When a sales meeting ends, it auto-drafts
follow-up emails, proposals, SOWs, and decks and drops them into Gmail drafts.
Repo: github.com/ALLENDE123X/dealinno | Live: dealinno.vercel.app

---

## How AI Agents Collaborate on This Project

This project is worked on by AI agents. There are two roles:

**Claude Desktop (claude.ai)**
Role: architect, browser agent, spec manager, ticket manager, debugger.
What it does: research, architecture decisions, browser automation (navigating logged-in
sessions like Supabase/Sentry/Upstash/Google Cloud/GitHub), maintaining the PRD Google Doc,
creating and prioritizing GitHub Issues (tickets), writing/refining AI prompts in lib/ai/,
debugging logic errors. Claude Desktop owns the ticket backlog — coders never create tickets.

**The Coder (Antigravity IDE OR Claude Code)**
Role: coder, terminal runner, file editor. Either agent can fill this role interchangeably.
What it does: picks up tickets from GitHub Issues, writes and edits code files, runs terminal
commands (npm, drizzle-kit, git), installs packages, manages git commits/pushes, opens PRs.
Both read the same PRD, follow the same standards, use the same ticket board.

---

## Ticket System — GitHub Issues (source of truth for WHAT to build)

All work is tracked as GitHub Issues in github.com/ALLENDE123X/dealinno, organized on a
GitHub Projects board ("Dealinno Roadmap") with columns: Backlog -> Ready -> In Progress -> In Review -> Done.

**Rules for the coder (Antigravity or Claude Code):**
- At session start, read the PRD Google Doc, then look at the Project board
- Pick up the TOP issue in the "Ready" column. Do not pick from Backlog — only Claude Desktop promotes Backlog -> Ready
- Assign the issue to yourself and move it to "In Progress"
- Build exactly what the issue describes — nothing more
- In your PR body, include `closes #N` (the issue number) so the ticket auto-moves to Done on merge
- If you discover new work, do NOT create a ticket yourself — tell the user, who relays to Claude Desktop

**Claude Desktop owns:** creating issues, writing acceptance criteria, setting labels/priority,
promoting Backlog -> Ready, and keeping the board accurate.

Issue labels: `phase-1`, `phase-2`, `ready`, `blocked`, `needs-legal-review`, `bug`, `feature`, `infra`, `security`

---

## PRD — The Master Google Doc (source of truth for HOW it works)

https://docs.google.com/document/d/1iBMTWul12JbRf4mM5LFnFoyD9DsYkczJZZYkJbaDDo0/edit

The Google Doc is the Product Requirements Doc: product vision, architecture, DB schema,
data flows, code standards, and roadmap. It does NOT contain the live task list anymore —
tickets live in GitHub Issues. Read these PRD sections before writing feature code:
Section 4 (schema), Section 5 (file structure), Section 8 (data flows), Section 14 (standards).

---

## Tech Stack
- Framework: Next.js 16 (App Router) + Vercel
- Auth: NextAuth v5 beta + @auth/drizzle-adapter
- DB: Supabase (Postgres) via Drizzle ORM
- Background jobs: Inngest (functions in /inngest/functions/)
- Billing: Stripe
- Email/Calendar: Gmail API + Google Calendar API (googleapis)
- AI classify/draft: GPT-4o mini (OpenAI)
- AI doc generation: Gemini 2.0 Flash (@google/generative-ai)
- Transcription: Deepgram
- Logging: Pino + Axiom (lib/logger.ts)
- Rate limiting: Upstash Redis (lib/ratelimit.ts)
- Error tracking: Sentry (@sentry/nextjs)
- Styling: Tailwind CSS + shadcn/ui
- UI components: 21st.dev Magic MCP (query before writing any component from scratch)

## MCP Stack — Available to All Agents

Both Claude Desktop and Antigravity have access to these MCP servers. Use them actively.

| MCP | What to use it for |
|-----|--------------------|
| github | Read/write repo files, open PRs, manage issues |
| google-docs | Read/update the PRD Google Doc |
| context7 | Look up live docs for any library before using its API |
| magicuidesign-mcp | Get animated React components (marquee, bento grid, animated list, etc.) — query before writing animation/effects code from scratch |
| shadcn | Browse, search, and install shadcn/ui components — use this to get the exact install command and confirm a component exists before adding it |
| 21st.dev (free tier) | Semantic search across thousands of real component patterns + SVG icon search |

### How to use them in practice
- Before writing any new component: check magicuidesign-mcp and shadcn first
- Before using any library API: use context7 to pull current docs
- When adding a UI element that needs an icon: use 21st.dev SVG icon search

---

## Design System — NON-NEGOTIABLE

The landing page (app/page.tsx) is the design authority. All new UI must match it exactly.
The app is dark-first. No white backgrounds anywhere in authenticated views.

### Colors
- Page background: bg-black or bg-zinc-950
- Cards: bg-zinc-900 border border-zinc-800 rounded-2xl
- Primary text: text-white
- Secondary/muted text: text-zinc-400
- Primary CTA button: bg-white text-black hover:bg-zinc-100 (matches landing "Get early access")
- Ghost/secondary action: text-zinc-400 hover:text-white, no background
- Borders: border-zinc-800 only — NEVER border-gray-200

### Typography
- Headings: font-bold text-white tracking-tight
- Body/prose: text-zinc-300 or text-zinc-400, leading-relaxed
- NEVER font-mono for email body, prose, or any non-code content
- Badges: rounded-full bg-zinc-800 text-zinc-300 text-xs px-3 py-1

### Components
- ALWAYS query 21st.dev Magic MCP before writing a new component from scratch
- ALWAYS use shadcn/ui primitives — never hand-roll Button, Card, Input, Dialog
- Cards: bg-zinc-900 border border-zinc-800 rounded-2xl — NEVER bg-white or bg-gray-50
- Primary button: bg-white text-black rounded-lg — NEVER bg-black as primary

### Interactions
- NEVER use alert() or confirm() — use sonner toasts with theme="dark"
- Optimistic UI on all mutations: update local state immediately, sync in background
- Loading state: Loader2 icon from lucide-react spinning — never just a disabled button
- List animations: framer-motion AnimatePresence, fade + y:-8, duration 0.2
- Empty states: lucide-react icon (text-zinc-700 w-12 h-12) + headline + 1-line description. No dashed boxes.

### Layout
- Authenticated pages: two-column layout — fixed left sidebar (w-56, bg-zinc-950, border-r border-zinc-800) + main content
- Page header: title (text-2xl font-bold text-white) + optional count badge
- NEVER: floating max-w-2xl div centered on a blank page

### Forbidden patterns — any PR with these will be rejected
- font-mono on email/prose content
- bg-white or bg-gray-50 on dashboard pages or cards
- border-gray-200 on any card or container
- alert() or confirm() for any feedback
- router.refresh() as the sole feedback after a mutation
- Hand-rolled Button/Card when shadcn/ui exists

---

## File Structure Rules
- DB schema: lib/db/schema.ts (source of truth — never deviate from column names here)
- DB client: lib/db/index.ts
- Inngest client: inngest/client.ts
- Inngest jobs: inngest/functions/*.ts
- AI prompts: lib/ai/*.ts
- Gmail helpers: lib/gmail.ts
- Google token refresh: lib/google.ts
- Logger: lib/logger.ts (always import this, never use console.log)
- Rate limiter: lib/ratelimit.ts
- API routes: app/api/*/route.ts

---

## Code Standards (Section 14 of PRD — mandatory)

### Every API route MUST have:
1. Auth check: `const session = await auth(); if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })`
2. Rate limiting: `const { success } = await limitRequest(userId); if (!success) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })`
3. Zod validation on request body
4. Structured logging: `logger.info({ userId, action: 'action_name', duration_ms })`
5. Sentry error capture in catch blocks: `Sentry.captureException(error, { extra: { userId, action } })`

### Every Inngest job MUST have:
1. try/catch wrapping all logic
2. Sentry.captureException + re-throw on error (so Inngest marks failed and retries)
3. logger.info at start, each step, and completion with jobId + userId
4. Never log: tokens, email bodies, transcripts, API keys

### Never:
- Use console.log (use logger)
- Write raw SQL (use Drizzle)
- Skip Zod validation on external input
- Commit broken or untested code
- Create new DB columns not in lib/db/schema.ts without updating the PRD first

---

## Git & PR Rules
- Main branch is PROTECTED. Never commit directly to main.
- Every feature or fix gets its own branch: `feature/scope-description` or `fix/scope-description`
- One ticket = one branch = one PR. Keep PRs small and focused.
- PR body MUST include `closes #N` referencing the GitHub Issue it resolves
- PRs cannot be merged to main until ALL tests pass in CI (GitHub Actions)

## PR Audit Gates (ALL must pass before a PR is marked ready for review)

### 1. Security audit
- [ ] No secrets or tokens logged or returned in responses
- [ ] All new routes have auth check, rate limiting, and Zod validation
- [ ] All new Inngest jobs have try/catch with Sentry.captureException + re-throw
- [ ] npm audit --audit-level=high passes
- [ ] No new environment variables hardcoded (all in .env.local)
- [ ] Webhook routes verify signatures (Stripe: constructEvent, Pub/Sub: Bearer token)

### 2. Legal / compliance audit
Run this checklist on all new code. If ANY item is "yes" with an unresolved action,
add the `needs-legal-review` label and flag the user — do NOT mark ready for review.

- [ ] New category of user data collected/stored? -> Privacy Policy covers it + retention?
- [ ] New third-party service processing user data? -> DPA/terms acceptable?
- [ ] New or changed OAuth scope? -> flag Claude Desktop (Google may require re-verification)
- [ ] Email sending/drafting behavior changed? -> CAN-SPAM + GDPR email compliance
- [ ] Billing/subscription behavior changed? -> TOS accurately describes it?
- [ ] User data deletion/export affected? -> GDPR Art. 17 + Art. 20 still work?
- [ ] New AI processing of user content? -> Privacy Policy discloses it?

### 3. Tests (enforced in CI — PR will not merge without these)

| Change type | Required test |
|---|---|
| New API route | Vitest integration test hitting the route with mock auth |
| New Inngest job | Vitest unit test for each step function |
| UI component or page | Playwright E2E test asserting key elements and interactions |
| New lib/ utility | Vitest unit test |
| Config / chore / deps | No test required |

Test locations: unit in `tests/unit/`, E2E in `tests/e2e/`
Test command: `npm test` | E2E: `npx playwright test`

### 4. UI/UX audit (required on any PR touching .tsx files in app/ or components/)
- [ ] All new components use the dark design system (bg-zinc-900 cards, black page backgrounds)
- [ ] No forbidden patterns: font-mono on prose, bg-white cards, alert(), border-gray-200
- [ ] Primary buttons use bg-white text-black (matching landing page)
- [ ] shadcn/ui used for all primitives — no hand-rolled Button/Card/Input
- [ ] Mutations use optimistic UI + sonner toast — not router.refresh() alone
- [ ] Empty states have lucide icon + headline + description (not a dashed box)
- [ ] Vercel preview is READY — include the preview URL in the PR body

## Commit message format
`type(scope): description` e.g. `feat(inngest): add classify step to process-email job`

## PR title format
`[Phase 1] feat: short description`

---

## Visual Review Protocol (Claude Desktop)

When the coder hands off a UI/UX review request, Claude Desktop:

1. Receives the Vercel preview URL from the handoff prompt
2. Navigates to the URL using the Chrome extension browser tools
3. If auth redirects to the landing page:
   - Reply: "Sign in to [preview URL] in your browser first, then tell me and I'll navigate to [path]"
   - Once the user confirms they've signed in (session is now in their browser), navigate to the path
4. Screenshots the page and evaluates against the design system in this file
5. If approved: "UI looks good — you can merge PR #N"
6. If changes needed: outputs a specific, paste-ready prompt the user can give directly to Antigravity

## Import Aliases
- `@/` maps to project root
- `@/lib/db` -> lib/db/index.ts
- `@/lib/logger` -> lib/logger.ts
- `@/lib/ratelimit` -> lib/ratelimit.ts
- `@/inngest/client` -> inngest/client.ts
