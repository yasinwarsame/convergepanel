# CodeCheck Dependency Analysis

> Generated: 2026-02-24
> Purpose: Prepare for extracting CodeCheck into a standalone Next.js app.

## Summary

- **Total files analyzed**: 21
- **Category A (copy directly)**: 12 files
- **Category B (copy and simplify)**: 4 files
- **Category C (shared dependency, needs replacement)**: 5 files
- **Category D (npm packages)**: 8 packages

---

## Category A — Copy Directly

These files are 100% CodeCheck code with no external dependencies beyond npm packages.
They move to the new repo as-is.

| File | Imported by | Notes |
|------|------------|-------|
| `lib/codecheck/types.ts` | orchestrate.ts, route.ts, page.tsx, report/page.tsx, VerificationReportPage.tsx, report.ts, reportStorage.ts, pathValidation.ts | Zero imports. Pure type definitions. Core of the entire system. |
| `lib/codecheck/prompts.ts` | orchestrate.ts | Zero imports. Pure string constants + pure functions (buildPlannerMessage, buildImplementerMessage, buildVerifierMessage, getSystemPrompt). |
| `lib/codecheck/diffEncoding.ts` | orchestrate.ts, diffEncoding.test.ts | Zero imports. Pure utility functions for base64 diff handling. |
| `lib/codecheck/pathValidation.ts` | route.ts, repoContext.ts, pathValidation.test.ts | Only imports types from `./types`. Pure validation logic. |
| `lib/codecheck/patchPolicies.ts` | route.ts | Zero imports. Dependency + sensitive file policy enforcement. |
| `lib/codecheck/evidence.ts` | route.ts | Imports only Node.js builtins (`fs`, `path`, `crypto`, `child_process`). Evidence bundle storage. |
| `lib/codecheck/testFramework.ts` | orchestrate.ts, repoContext.ts | Imports only Node.js builtins (`fs`, `path`). Test framework detection. |
| `lib/codecheck/repoContext.ts` | orchestrate.ts, route.ts | Imports from `./pathValidation` (ALLOWED_TOP_LEVEL_DIRS) and `./testFramework`. Node.js builtins (`fs`, `path`, `child_process`). |
| `lib/codecheck/report.ts` | page.tsx, VerificationReportPage.tsx | Only imports types from `./types`. Pure report generation logic. |
| `lib/codecheck/reportStorage.ts` | page.tsx, report/page.tsx | Only imports types from `./types`. Client-side sessionStorage helpers. |
| `lib/__tests__/diffEncoding.test.ts` | (test file) | Only imports from `@/lib/codecheck/diffEncoding`. Jest test. |
| `lib/__tests__/pathValidation.test.ts` | (test file) | Only imports from `@/lib/codecheck/pathValidation` and `@/lib/codecheck/types`. Jest test. |

---

## Category B — Copy and Simplify

These files are shared ConvergePanel code, but CodeCheck's usage is narrow enough that a minimal standalone replacement is straightforward.

| File | Imported by | What CodeCheck uses | Minimal replacement |
|------|------------|-------------------|-------------------|
| `lib/env.ts` | `app/api/codecheck/route.ts` | `ANTHROPIC_API_KEY` (single export) | A one-liner file: `export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;` — ignore all OpenAI/Grok/Stripe/Gemini/Perplexity env vars. |
| `lib/utils/performance.ts` | `components/AuthProvider.tsx` (transitive) | `perf.mark()` and `perf.measure()` | Only needed if you copy AuthProvider. Can be a no-op stub: `export const perf = { mark() {}, measure() {} };` or omitted entirely if auth is replaced. |
| `scripts/verify-codecheck-hardening.mjs` | (standalone script) | Node.js builtins (`crypto`, `fs`, `path`, `child_process`) | Copy as-is. Uses no ConvergePanel code — all logic is inline reimplementations for testing. |
| `components/codecheck/VerificationReportPage.tsx` | `app/codecheck/report/page.tsx` | Types from `@/lib/codecheck/types`, functions from `@/lib/codecheck/report` | Copy as-is. Only depends on Category A files + `react`, `next/link`. No ConvergePanel shared UI components. |

---

## Category C — Shared Dependency, Needs Replacement

These files are deeply entangled with ConvergePanel's Firebase/auth infrastructure. They cannot be simply copied — they need standalone equivalents.

| File | Imported by | What CodeCheck uses | Replacement strategy |
|------|------------|-------------------|---------------------|
| `lib/firebase/auth.ts` | `app/api/codecheck/route.ts` | `verifyIdToken(token)` — verifies a Firebase ID token and returns `{ uid }`. Also imports `"server-only"`. | **Option A (Firebase standalone):** Copy with a simplified `admin.ts` that only initializes Auth (no Firestore). Needs the same Firebase Admin env vars. **Option B (API key auth):** Replace with a simple API key or JWT verification middleware. CodeCheck only needs a `uid` string for logging/evidence. |
| `lib/firebase/auth-helpers.ts` | `app/api/codecheck/route.ts` | `verifySessionCookie(request)` — extracts session cookie, verifies via Firebase Admin, returns `{ uid, isAdmin }`. Imports `"server-only"` and `./admin`. | Same as above. CodeCheck uses this for cookie-based auth. In a standalone app, replace with your chosen auth strategy (NextAuth, Clerk, simple bearer token, etc.). CodeCheck only needs `uid`. |
| `lib/firebase/admin.ts` | `auth.ts`, `auth-helpers.ts` (transitive) | `adminAuth` (Firebase Admin Auth instance), `FIREBASE_PROJECT_ID`. Also exports `adminDb` (Firestore) which CodeCheck does NOT use. Imports `"server-only"`, `firebase-admin`. | **Simplified version:** Strip out `adminDb`/Firestore. Keep only `adminAuth` initialization. Needs env vars: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (or `FIREBASE_SERVICE_ACCOUNT_BASE64`). |
| `lib/firebase/client.ts` | `components/AuthProvider.tsx` (transitive) | `auth` (Firebase client Auth instance) for `onAuthStateChanged`, `getIdTokenResult`. | Only needed if you keep Firebase Auth on the client side. In a standalone app, replace with your client-side auth provider (NextAuth session, Clerk, etc.). |
| `components/AuthProvider.tsx` | `app/codecheck/page.tsx` | `useAuth()` hook → `{ user, loading }`. CodeCheck uses `user` to get `user.getIdToken()` for API calls and checks `authLoading` for loading state. Also imports `@/lib/firebase/client` and `@/lib/utils/performance`. | **Replacement:** Create a standalone `AuthProvider` that wraps your chosen auth system. CodeCheck only needs: `user` (with `getIdToken()` method), `loading` boolean. If using NextAuth: `useSession()` → map to same interface. If using API keys: no provider needed; hardcode the key in the fetch call. |

---

## Category D — npm Packages

| Package | Used by | Purpose | Required in standalone? |
|---------|---------|---------|----------------------|
| `@anthropic-ai/sdk` | `orchestrate.ts` | Claude API calls (Planner, Implementer, Verifier, Review) | **Yes** — core dependency |
| `next` (14.x) | All route/page files | Framework (App Router, NextRequest/NextResponse, Link, useRouter) | **Yes** — framework |
| `react` / `react-dom` | All client components | UI rendering | **Yes** — framework |
| `firebase` | `AuthProvider.tsx` → `client.ts` | Client-side auth (getIdToken, onAuthStateChanged) | **Conditional** — only if keeping Firebase Auth |
| `firebase-admin` | `admin.ts` → `auth.ts`, `auth-helpers.ts` | Server-side token verification | **Conditional** — only if keeping Firebase Auth |
| `server-only` | `auth.ts`, `auth-helpers.ts`, `admin.ts` | Prevents server modules from being bundled client-side | **Yes** (if copying auth files) |
| `tailwindcss` | All UI components (via classes) | Styling | **Yes** — used extensively in page.tsx, VerificationReportPage.tsx |
| `zod` | NOT directly used by CodeCheck files | Validation (used elsewhere in ConvergePanel, not in CodeCheck modules) | **No** — not a CodeCheck dependency |

---

## Environment Variables Required

CodeCheck requires these environment variables:

| Variable | Used in | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | `route.ts` via `lib/env.ts` | Claude API authentication |
| `NODE_ENV` | `route.ts` | Dev logging toggle |
| `FIREBASE_PROJECT_ID` | `admin.ts` | Firebase project identifier |
| `FIREBASE_CLIENT_EMAIL` | `admin.ts` | Firebase Admin SDK auth |
| `FIREBASE_PRIVATE_KEY` | `admin.ts` | Firebase Admin SDK auth |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | `admin.ts` (alternative) | Base64-encoded service account JSON |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | `client.ts` | Client-side Firebase config |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `client.ts` | Client-side Firebase config |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `client.ts` | Client-side Firebase config |

If Firebase Auth is replaced, only `ANTHROPIC_API_KEY` and `NODE_ENV` are needed.

---

## Configuration Files

| File | CodeCheck-specific? | Notes |
|------|-------------------|-------|
| `middleware.ts` | **No** | Empty matcher `[]`. No CodeCheck-specific routes or logic. |
| `next.config.js` | **No** | No CodeCheck-specific configuration (no rewrites, headers, etc.). |
| `tailwind.config.ts` | **No** | No CodeCheck-specific theme extensions or content paths. Copy standard config. |
| `tsconfig.json` | **No** | Standard Next.js config with `@/` path alias. Copy and ensure `paths` mapping is preserved. |
| `.gitignore` | **Partial** | Contains `.codecheck/` entry for evidence directory. Copy this line. |

---

## Import Dependency Graph

```
app/api/codecheck/route.ts
├── lib/firebase/auth-helpers.ts      [C] → lib/firebase/admin.ts [C]
├── lib/firebase/auth.ts              [C] → lib/firebase/admin.ts [C]
├── lib/env.ts                        [B] (only ANTHROPIC_API_KEY)
├── lib/codecheck/types.ts            [A]
├── lib/codecheck/orchestrate.ts      [A]
│   ├── @anthropic-ai/sdk             [D]
│   ├── lib/codecheck/types.ts        [A]
│   ├── lib/codecheck/prompts.ts      [A]
│   ├── lib/codecheck/diffEncoding.ts [A]
│   ├── lib/codecheck/testFramework.ts[A]
│   └── lib/codecheck/repoContext.ts  [A]
│       ├── lib/codecheck/pathValidation.ts [A]
│       └── lib/codecheck/testFramework.ts  [A]
├── lib/codecheck/pathValidation.ts   [A]
├── lib/codecheck/patchPolicies.ts    [A]
├── lib/codecheck/evidence.ts         [A]
└── lib/codecheck/repoContext.ts      [A]

app/codecheck/page.tsx
├── components/AuthProvider.tsx        [C]
│   ├── lib/firebase/client.ts         [C]
│   └── lib/utils/performance.ts       [B]
├── lib/codecheck/types.ts             [A]
├── lib/codecheck/report.ts            [A]
└── lib/codecheck/reportStorage.ts     [A]

app/codecheck/report/page.tsx
├── lib/codecheck/types.ts             [A]
├── components/codecheck/VerificationReportPage.tsx [B]
│   ├── lib/codecheck/types.ts         [A]
│   └── lib/codecheck/report.ts        [A]
└── lib/codecheck/reportStorage.ts     [A]
```

---

## Potential Issues

1. **Firebase Auth is the only entanglement.** All other CodeCheck code is fully self-contained. The entire `lib/codecheck/` directory (8 files) has zero ConvergePanel-specific imports — it only uses Node.js builtins and `@anthropic-ai/sdk`.

2. **`server-only` package.** The auth files use `import "server-only"` to prevent client bundling. If you copy these files, ensure `server-only` is in your new `package.json`.

3. **Path alias `@/`.** All imports use `@/` which maps to the project root via `tsconfig.json`. The new repo must configure the same alias or rewrite imports.

4. **Tailwind classes are inline.** `page.tsx`, `VerificationReportPage.tsx`, and `report/page.tsx` use Tailwind utility classes extensively. The new repo needs a matching Tailwind setup (standard config, no custom plugins required).

5. **`"use client"` directives.** `page.tsx`, `report/page.tsx`, `VerificationReportPage.tsx`, `reportStorage.ts` use client-side APIs (`useState`, `sessionStorage`). These must remain client components.

6. **No circular dependencies** detected in the CodeCheck module graph.

7. **Evidence directory.** `evidence.ts` writes to `.codecheck/evidence/` on disk. Ensure the deploy target supports filesystem writes (won't work on read-only serverless like Vercel unless switched to a database/blob store).

8. **`repoContext.ts` uses `process.cwd()` and `execSync("git rev-parse HEAD")`.** This is fine for local dev / long-running Node.js but may behave differently in serverless environments where the working directory varies.

---

## Recommended Extraction Order

### Wave 1 — Core library (zero ConvergePanel deps)
Copy these first. They compile and pass tests independently.

1. `lib/codecheck/types.ts`
2. `lib/codecheck/prompts.ts`
3. `lib/codecheck/diffEncoding.ts`
4. `lib/codecheck/pathValidation.ts`
5. `lib/codecheck/patchPolicies.ts`
6. `lib/codecheck/testFramework.ts`
7. `lib/codecheck/repoContext.ts`
8. `lib/codecheck/evidence.ts`
9. `lib/codecheck/orchestrate.ts`
10. `lib/codecheck/report.ts`
11. `lib/codecheck/reportStorage.ts`
12. `lib/__tests__/diffEncoding.test.ts`
13. `lib/__tests__/pathValidation.test.ts`
14. `scripts/verify-codecheck-hardening.mjs`

### Wave 2 — UI components (only need types from Wave 1)
Copy these after Wave 1. They only depend on types + report utilities.

15. `components/codecheck/VerificationReportPage.tsx`
16. `app/codecheck/report/page.tsx`

### Wave 3 — Auth + API route (requires replacement decisions)
These need auth strategy decisions before copying.

17. Create standalone `lib/env.ts` (one-liner: `export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;`)
18. Create standalone auth layer (choose: Firebase Admin, NextAuth, Clerk, or simple API key)
19. Copy `app/api/codecheck/route.ts` and rewire auth imports
20. Create standalone `AuthProvider` or equivalent for client-side auth
21. Copy `app/codecheck/page.tsx` and rewire `useAuth` import

### Wave 4 — Configuration + infrastructure

22. `package.json` with: `next`, `react`, `react-dom`, `@anthropic-ai/sdk`, `tailwindcss`, `server-only`, `typescript`
23. `tsconfig.json` (copy, ensure `@/` path alias)
24. `tailwind.config.ts` (copy standard config)
25. `.gitignore` (include `.codecheck/`)
26. `.env.local` template with required variables

---

## Effort Estimate

| Area | Effort | Notes |
|------|--------|-------|
| Copy Wave 1 (lib/codecheck/*) | ~30 min | Mechanical copy, zero changes needed |
| Copy Wave 2 (UI components) | ~15 min | Mechanical copy |
| Auth replacement | 2-4 hours | Depends on chosen strategy. Firebase Admin is fastest (copy 3 files). API key is simplest (replace with 20-line middleware). |
| Wire up API route | ~30 min | Update 2-3 import paths |
| New project scaffolding | ~1 hour | package.json, configs, env template |
| **Total** | **4-6 hours** | Conservative estimate |

The clean separation of `lib/codecheck/` (12 files, 0 ConvergePanel imports) means ~80% of CodeCheck code can be copied with zero modifications.
