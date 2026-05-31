# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server (http://localhost:3000)
npm run build        # prisma generate + next build
npm run lint         # ESLint
npm test             # Run all Jest tests
npx jest path/to/file.spec.ts   # Run a single test file
npx jest --testNamePattern "name"  # Run tests matching a name pattern
```

Test files live in `lib/__tests__/` and match `**/__tests__/**/*.spec.ts` or `*.test.ts`. The `@/` alias maps to the repo root.

Dev verification scripts (do not ship):
```bash
npm run verify:claims     # Claim verification smoke test
npm run verify:video      # Video processing smoke test
npm run verify:consensus  # Consensus scoring smoke test
```

## Architecture

### Request flow

The main page (`app/page.tsx`) is a single client component with three tabs — **Deep Research** (multi-LLM panel), **Claim Verification**, and **Video Verification** — all managed by local state. Each tab submits to a dedicated API route:

| Tab | API Route | Core lib |
|-----|-----------|----------|
| Deep Research | `/api/run-panel` | `lib/panel.ts` → `CONNECTOR_MAP` |
| Claim Verification | `/api/verify-claim` | `lib/verification/runClaimVerificationPanel.ts` |
| Video Verification | `/api/verify-video` | `lib/video/` |
| Synthesis | `/api/synthesize-panel` | `lib/synthesis/` |

All API routes set `export const runtime = "nodejs"` (Firebase Admin SDK requires Node.js).

### Authentication

Two paths accepted in every API route:
1. Session cookie `__session` → `verifySessionCookie()` from `lib/firebase/auth-helpers.ts`
2. `Authorization: Bearer <token>` fallback → `verifyIdToken()` from `lib/firebase/auth.ts`

Middleware (`middleware.ts`) only checks cookie *presence* to gate `/admin/*` — real auth (token validity + custom claims) happens inside each API route. Admin status is a Firebase custom claim `admin: true`, not a database field. Admin email list is driven by the `ADMIN_EMAILS` env var.

### Connectors

Every LLM is a plain function in `lib/connectors/<model>.ts` with signature:

```ts
(question: string, context?: string | null, apiKey?: string, opts?: ConnectorCallOptions) => Promise<ModelResult>
```

All connectors are registered in `CONNECTOR_MAP` (`lib/connectors/index.ts`). **Connectors must never throw** — they always return a `ModelResult` with `status: "ok" | "error" | "timeout" | "refused" | "rate_limited" | "substituted"`. The panel runner uses `Promise.allSettled` over the map.

DeepSeek is a fallback provider (not in CONNECTOR_MAP directly) — enabled via `PANEL_DEEPSEEK_FALLBACK_FOR` env var.

### Environment variables

`lib/env.ts` is the **single source of truth** for all server-side env vars. Import from there; never access `process.env` directly in connectors or lib code. Firebase Admin supports three credential formats tried in order: `FIREBASE_SERVICE_ACCOUNT_BASE64` (recommended for Vercel), `FIREBASE_SERVICE_ACCOUNT_JSON`, or individual `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`.

### Data persistence

- **Firestore** is the primary database (user profiles, runs, verifications, API keys)
- **Firestore Admin SDK** (`lib/firebase/admin.ts`) is server-only; import with `"server-only"`
- **Prisma/PostgreSQL** exists in `prisma/` but is secondary — used for specific features, not user auth or billing
- API keys stored in `appConfig/modelKeys` Firestore document; runtime falls back to env vars if missing
- User quota tracked in `users/{uid}` with `runsThisMonth` + `usageMonth` (YYYY-MM); `FieldValue.increment` for atomic updates

### Billing

Stripe subscription state is synced to `users/{uid}` via webhooks (`lib/stripe/webhookHelpers.ts`). Plan enforcement goes through `lib/stripe/usageCheck.ts` → `checkAndIncrementUsageForRun()`. Plan configs live in `lib/plans.ts` (single source of truth for limits).

### Logging

Always use `logger` from `@/lib/logger` for server-side logging. Never use `console.log/warn/error` in `lib/` or `app/api/` code.

### CSP

Content-Security-Policy headers are defined in `next.config.js`. When adding calls to new external domains (new AI providers, analytics, etc.) the `connect-src` directive must be updated.

### Key structural conventions

- `lib/panel/` — panel-specific utilities (schemas, normalization, sanitization)
- `lib/firestore/` — all Firestore read/write helpers (runs, verifications, userTokens)
- `lib/verification/` — claim verification pipeline (prompts, parsing, scoring, audit)
- `lib/governance/` — team governance evaluation and storage
- `lib/billing/` — plan configuration helpers (imports from `lib/plans.ts`)
- `components/` — client-only UI; heavy components are `dynamic()`-imported from pages
- `hooks/` — all `"use client"` React hooks
