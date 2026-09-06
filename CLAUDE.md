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

Middleware (`middleware.ts`) only checks cookie *presence* to gate `/admin/*` — real auth (token validity + custom claims) happens inside each API route. Administrator authority has THREE human tiers plus ONE bootstrap mechanism — see
`docs/operations/admin-authority-tiers.md`. Human tiers: `ADMIN_PORTAL` (verified
`ADMIN_EMAILS` member or the `admin` claim), `SYSTEM_ADMIN` (the `admin` custom claim
ONLY — credentials, claim minting, purge, destructive user/billing mutation), and
`GOVERNANCE_ADMIN` (verified `GOVERNANCE_ADMIN_EMAILS` member only). `ADMIN_EMAILS`
does NOT grant SYSTEM_ADMIN or governance authority.
Separately, `BOOTSTRAP_SECRET` (`ADMIN_SECRET` on `/api/admin/set-admin`) can mint the
first `admin` claim. It authenticates no identity at all — it is a deployment-time
bootstrap, not a role, and it fails closed when the variable is empty or unset.

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

### Light theme — always use cp tokens

The app uses a **light theme globally** (`body { background: #F6F6F3 }`, Hanken Grotesk font). This replaced an earlier dark theme in July 2026 — if you see references to a forced-dark app elsewhere (old comments, docs), they're stale.

**Use these tokens — defined in `tailwind.config.ts` and `globals.css`:**

| Token | Value | Use for |
|-------|-------|---------|
| `text-cp-text` | `#18181B` | Headings, primary body text |
| `text-cp-muted` | `#65656E` | Secondary text, labels, descriptions |
| `text-cp-faint` | `#9A9AA2` | Tertiary/disabled text |
| `text-cp-accent` / `text-cp-primary` | `#2563EB` | Accent / highlight text, links |
| `bg-cp-bg` | `#F6F6F3` | Page background (body default) |
| `bg-cp-surface` | `#FFFFFF` | Cards, panels |
| `bg-cp-raised` | `#FBFBF9` | Elevated surfaces, callout boxes |
| `bg-cp-primary-soft` | `#EEF3FE` | Subtle accent-tinted backgrounds |
| `bg-cp-primary-tint` | `#F5F8FF` | Very subtle accent-tinted backgrounds |
| `bg-cp-orange` / `bg-cp-orange-soft` | `#E67824` / `#FCF0E6` | Secondary accent (warnings, highlights) |
| `border-cp-border` | `#E4E3DD` | All borders |
| `border-cp-border-soft` | `#EFEEE9` | Subtle/low-contrast borders |

**Text on cp-token backgrounds:** since `cp-text` is now dark, never pair `text-white` with `bg-cp-*` surfaces (they're all light) — use `text-cp-text`. Reserve `text-white` for genuinely dark, hardcoded backgrounds (e.g. `bg-sky-600`, `bg-blue-600` solid CTA buttons).

**No `dark:` Tailwind variants** — the app has no dark-mode toggle and no `darkMode` config in `tailwind.config.ts`, so `dark:` classes are dead weight that only fire on OS `prefers-color-scheme` and cause patchwork rendering. Don't add them.

**Known inconsistency:** `app/page.tsx` (the main Research/Verify Claim/Verify Video dashboard) does **not** use `cp-*` tokens — it's built entirely with hardcoded Tailwind classes (`bg-white`, `text-slate-900`, `bg-sky-50`, etc.) that predate the token system. It happens to already look light/consistent with the current theme, but it won't pick up future token changes automatically. Treat it as a separate legacy surface, not an oversight to "fix" on sight.

**Category/badge backgrounds** (`lib/pseo/pages.ts` CATEGORIES, page-level HUB_GROUPS): use `bg-cp-raised` + `border-cp-border` + `text-*-600`/`text-*-700` (readable on light backgrounds) — not the old dark-theme `text-*-400` variants.

**Page wrapper pattern** — do not wrap pages in a white card. Use the bare layout:
```tsx
<main className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
  {/* content directly on dark body */}
</main>
```

### Key structural conventions

- `lib/panel/` — panel-specific utilities (schemas, normalization, sanitization)
- `lib/firestore/` — all Firestore read/write helpers (runs, verifications, userTokens)
- `lib/verification/` — claim verification pipeline (prompts, parsing, scoring, audit)
- `lib/governance/` — team governance evaluation and storage
- `lib/billing/` — plan configuration helpers (imports from `lib/plans.ts`)
- `components/` — client-only UI; heavy components are `dynamic()`-imported from pages
- `hooks/` — all `"use client"` React hooks
