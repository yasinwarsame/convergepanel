# ConvergePanel — Technical Documentation

## Overview

ConvergePanel is a multi-LLM research and verification platform built on Next.js 14 (App Router). It runs five AI models in parallel to produce cross-model analysis, detect disagreement, and create auditable records for high-stakes decisions. The platform has three core operating modes — Deep Research, Claim Verification, and Video Verification — plus an automated Synthesis layer and, on the Full plan, a team Governance system.

**Tech stack:** Next.js 14 App Router · Firebase Auth + Firestore · Stripe billing · Node.js runtime (all API routes use `export const runtime = "nodejs"`)

---

## Application Architecture

```
app/
  page.tsx               ← Single client component; 4 tabs: research / verify / video / history
  use-cases/[slug]/      ← pSEO pages (234 live pages, all from lib/pseo/pages.ts)
  admin/                 ← Admin dashboard (Firebase custom claim gated)
  api/
    run-panel/           ← Deep Research
    verify-claim/        ← Claim Verification
    verify-video/        ← Video Verification
    synthesize-panel/    ← Synthesis generation
    governance/          ← Team governance routes
    stripe/              ← Billing webhooks + checkout
    admin/               ← Admin management routes
    user/                ← User profile routes
lib/
  connectors/            ← One file per LLM; all registered in CONNECTOR_MAP
  verification/          ← Claim verification pipeline
  video/                 ← Video verification pipeline
  synthesis/             ← Synthesis schemas + input builder
  governance/            ← Policy engine, audit log, team types
  firestore/             ← All Firestore read/write helpers
  billing/               ← Plan config helpers
  panel.ts               ← Panel orchestration (runPanel)
  panelModels.ts         ← Display model names and metadata
  modelConfig.ts         ← Token limits and timeouts per model
  plans.ts               ← Plan limits (single source of truth)
  types.ts               ← Core TypeScript interfaces
  env.ts                 ← All env var exports (never use process.env directly)
  logger.ts              ← Server-side logger (never use console.log in lib/ or api/)
  security/rateLimit.ts  ← Firestore-based per-user rate limiting (atomic, no Redis required)
```

---

## Authentication

Two credential paths are accepted by every API route:

1. **Session cookie** `__session` → `verifySessionCookie()` from `lib/firebase/auth-helpers.ts`
2. **Bearer token** `Authorization: Bearer <idToken>` → `verifyIdToken()` from `lib/firebase/auth.ts`

**Middleware** (`middleware.ts`) only checks for cookie *presence* to gate `/admin/*` routes. Full token validation and custom claim checks happen inside each API route.

**Admin access** is a Firebase custom claim `admin: true` — not a database field. The `ADMIN_EMAILS` env var controls which accounts can be granted admin status.

**Admin routes** (`app/api/admin/*`) must use `requireAdminApiAccess()` from `lib/firebase/auth-helpers.ts`, which verifies both token validity and the `admin: true` custom claim. Using `verifySessionCookie()` alone on admin routes is a privilege escalation vulnerability — it only confirms a valid session, not admin status.

---

## Rate Limiting

Per-user rate limiting is implemented in `lib/security/rateLimit.ts` using Firestore atomic transactions — no Redis required.

### How it works

- Counters are stored in the `rate_limits` Firestore collection, keyed by identifier (e.g., `run-panel:${uid}`)
- Each check runs inside a Firestore transaction (`runTransaction`) to prevent race conditions under concurrent requests
- If a window has expired, the counter resets automatically within the same transaction
- On Firestore unavailability or any error, the function **denies** the request (fail-closed)
- Stale documents are cleaned up opportunistically on ~1% of requests via `cleanupRateLimits()`

### Interface

```ts
checkRateLimit(config: {
  maxRequests: number   // requests allowed in window
  windowSeconds: number // window size
  identifier: string   // unique key, e.g. "run-panel:uid123"
}): Promise<RateLimitResult>

// RateLimitResult
{
  allowed: boolean
  remaining: number
  resetAt: Date
  retryAfter?: number  // seconds; only present when !allowed
}
```

All logging uses `logger` from `@/lib/logger` — never `console.error`.

---

## Plans and Billing

Plan configurations live in `lib/plans.ts` and `lib/billing/planConfig.ts`.

| Plan | Price | Monthly Runs | Models | Video Verifications | Governance |
|------|-------|-------------|--------|--------------------|-|
| **Free** | $0 | 8 | 2 | 0 | No |
| **Lite (3-Model)** | $99.99/mo · $959.90/yr | 80 | 3 | 5 | No |
| **Full (5-Model)** | $169.99/mo · $1,631.90/yr | 150 | 5 | 20 | Yes |

Stripe subscription state is synced to `users/{uid}` via webhooks (`lib/stripe/webhookHelpers.ts`). Usage enforcement runs through `lib/stripe/usageCheck.ts` → `checkAndIncrementUsageForRun()`. Monthly quota (`runsThisMonth`) is tracked in Firestore using `FieldValue.increment` for atomic updates, reset when `usageMonth` (format: `YYYY-MM`) rolls over.

---

## Deep Research — Panel Mode

### Request flow

`POST /api/run-panel` → `lib/panel.ts` → `runPanel()`

The panel queries all selected models concurrently using `Promise.allSettled`. Each connector must never throw; it always returns a `ModelResult` with `status: "ok" | "error" | "timeout" | "refused" | "rate_limited" | "substituted"`.

### Retry and fallback logic

1. First attempt — all selected models queried in parallel
2. Transient errors (`timeout`, `rate_limited`, `refused`) trigger up to **2 retries** with exponential backoff
3. After retries, failures for OpenAI / Anthropic / Google providers fall back to **DeepSeek** (controlled by `PANEL_DEEPSEEK_FALLBACK_FOR` env var; defaults to `openai,anthropic,google`)
4. If fallback also fails, the slot becomes a failed placeholder
5. Public status is normalized to `"ok" | "substituted" | "failed"` — callers never see internal retry states

### Models

Registered in `CONNECTOR_MAP` (`lib/connectors/index.ts`):

| Display Label | ModelId | Actual API Model | Provider |
|-------------|---------|-----------------|----------|
| GPT 5.2 | `chatgpt` | `gpt-4o-mini` | OpenAI |
| Claude Opus 4.5 | `claude` | `claude-haiku-4-5-20251001` | Anthropic |
| Grok 4 | `grok` | `grok-4-1-fast-reasoning` (configurable via `GROK_MODEL` env) | xAI |
| Perplexity Pro | `perplexity` | `sonar` | Perplexity |
| Gemini 2.0 Flash | `gemini` | `gemini-2.0-flash` | Google |

DeepSeek is a fallback provider only — not in `CONNECTOR_MAP` directly.

### Token limits and timeouts

Defined in `lib/modelConfig.ts`:

| Model | `maxTokens` | `softMax` | Timeout |
|-------|------------|----------|---------|
| chatgpt | 2200 | 1800 | 60s |
| claude | 4000 | 1800 | 60s |
| grok | 2200 | 1800 | 60s |
| perplexity | 6000 | 1800 | 90s |
| gemini | 8192 (override: `GEMINI_MAX_OUTPUT_TOKENS`) | 1800 | 60s |

### Deep Research prompt structure

Built by `buildPanelPrompt()` in `lib/panelPrompt.ts`. The prompt instructs each model to follow a 6-stage internal workflow and produce output in 10 named sections:

1. Summary
2. Key Claims
3. Evidence and Reasoning
4. Uncertainties and Disagreements
5. Potential Biases and Blind Spots
6. Key Metrics
7. Methodology and Assumptions
8. Alternative Perspectives
9. Gaps in Evidence / Open Questions
10. Practical Implications and Suggested Follow-Up Questions

Target output length: 900–1,400 words per model.

---

## Synthesis

### Request flow

`POST /api/synthesize-panel` — called automatically by the frontend after a panel run completes.

Synthesis is generated by **GPT-5.1** (not the panel models). It uses a compact cluster-based input rather than raw model outputs for efficiency. Results are cached in Firestore at `runs/{runId}.synthesizedStructuredReport`; subsequent requests for the same `runId` return the cached version.

Server-side timeout: 300 seconds.

### Output schema (`lib/synthesis/structuredSchema.ts`)

```ts
StructuredSynthesis {
  executiveSummary: string
  keyFindings: Array<{
    claim: string
    support: "strong" | "moderate" | "weak" | "contested"
    positionsByModel: Record<ModelId, string>   // each model's stance
    evidence: string[]
  }>
  disagreements: Array<{
    topic: string
    positionsByModel: Record<ModelId, string>
    significance: "high" | "medium" | "low"
  }>
  biasAndBlindSpots: Array<{
    description: string
    affectedModels: ModelId[]
    evidence: string
  }>
  openQuestions: string[]
  methodology: string
}
```

### Synthesis consensus scoring (`lib/verification/consensusScoring.ts`)

A separate algorithm from claim verification scoring. It works by:

1. Extracting anchor tokens from each key finding
2. Checking each model's `positionsByModel` text for negation within a detection window
3. Computing a support ratio per finding
4. Applying penalties:
   - −10 if ≥2 disagreements present
   - −10 if ≥1 bias/blind spot identified
   - −5 × weak finding count (capped at −25)
   - −10 if fewer than 4 healthy models contributed

---

## Claim Verification

### Request flow

`POST /api/verify-claim` → `lib/verification/runClaimVerificationPanel.ts`

Uses the same `CONNECTOR_MAP` as the panel but with a `systemPromptOverride`. Gemini receives `maxOutputTokens: 8192` for this mode.

### Verdict schema

Each model returns JSON matching:

```ts
{
  verdict: "accurate" | "partially_accurate" | "inaccurate" | "unverifiable"
  confidence: "high" | "medium" | "low"
  summary: string
  correctParts: string[]
  incorrectParts: string[]
  unverifiableParts: string[]
  reasoning: string
}
```

### Claim verification consensus scoring

Formula (defined in `lib/verification/consensusScoring.ts`):

```
score = 40
      + 45 × supportRatio
      + 20 × healthRatio
      − disagreementPenalty
      + verdictBoost
      − min(20, lowEvidenceClaims × 5)
```

Clipped to [0, 100].

- `supportRatio` = fraction of healthy models agreeing with dominant verdict
- `healthRatio` = fraction of models that returned a usable result
- `disagreementPenalty` = increases when models split across opposing verdicts
- `verdictBoost` = bonus when all models return identical verdicts
- `lowEvidenceClaims` = models that returned `"unverifiable"` on key points

### Audit bundle (`lib/verification/auditBundle.ts`)

Each verification stores an `AuditBundle`:

```ts
{
  version: number
  kind: "claim"
  claimCharCount: number
  modelCount: number
  verdict: string          // dominant verdict
  consensusScore: number
  perModel: Array<{
    modelId: ModelId
    verdict: string
    confidence: string
    status: ConnectorStatus
  }>
}
```

---

## Video Verification

### Request flow

`POST /api/verify-video` — 16-step pipeline:

1. Auth (session cookie → Bearer fallback)
2. Rate limit check
3. Plan check (video verification available on Lite and Full plans only)
4. Video quota check (`videoVerificationsThisMonth` in `users/{uid}`)
5. Request validation (max 50 MB, max 60 seconds)
6. Client-side frame extraction (browser API; frames sent as base64 JPEG)
7. Frame count selection: 4 frames for <3s video, 10 for normal, 12 for ≥55s (hard cap: 15)
8. Metadata heuristics analysis (`lib/video/videoPure.ts`)
9. Prompt construction
10. 3 vision model calls in parallel (GPT-4o, Claude, Gemini)
11. All vision calls use base64 inline images — no external URL hosting required
12. Majority verdict calculation
13. Consensus score computation
14. Firestore save to `videoVerifications` collection
15. Governance policy evaluation (Full plan)
16. Video usage counter increment

### Vision models used

| Model | API model string |
|-------|----------------|
| OpenAI | `gpt-4o` |
| Anthropic | `claude-sonnet-4-20250514` |
| Google | `gemini-2.0-flash` |

All three use 60-second timeouts and 8192 max output tokens.

### Video verdicts

```
"authentic_captured"    — appears to be genuine captured footage
"authentic_produced"    — professionally produced but not AI-generated
"likely_manipulated"    — signs of AI generation or editing
"inconclusive"          — insufficient signal to determine
"insufficient"          — too few usable frames or model failures
```

### Metadata heuristics

`analyzeMetadata()` in `lib/video/videoPure.ts` checks:

- Creation date (absent or suspiciously recent)
- Encoding software field — scanned for known AI tool signatures
- Aspect ratio (unusual ratios common in AI-generated video)
- Frame rate
- Audio presence / bitrate proxy

**Detected AI encoding markers:** runway, pika, sora, kling, synthesia, heygen, d-id, stable video, luma, minimax, hailuo

### Video consensus score

- Base: `dominantFraction × 100`
- Penalties: −10 for suspicious metadata, −15 for <3 usable models, −5 for >2 client warnings

---

## Governance (Full Plan Only)

### Policy engine (`lib/governance/policyEngine.ts`)

`PolicyRule` conditions and actions:

| Condition type | Description |
|---------------|-------------|
| `consensus_below` | Score falls below a threshold |
| `evidence_quality` | Evidence rated weak across models |
| `model_health` | Fewer than N healthy models |

| Action type | Description |
|------------|-------------|
| `flag` | Add a warning flag to the run |
| `block` | Prevent the run from being acted on |
| `require_review` | Route to a peer reviewer queue |

**Default policies:**

- `low-consensus-flag`: flag if consensus score < 50
- `low-model-health-flag`: flag if fewer than 4 models healthy
- `weak-evidence-review`: disabled by default

### Team structure (`lib/governance/teamTypes.ts`)

- `TeamDocument` — members list, policyRules array, team settings
- `TeamRunDocument` — captures runs with policy flags, reviewer assignment, and human decisions
- `TeamRunHumanDecision` — approved / rejected / escalated, with reviewer UID and timestamp
- `TeamGovernanceSnapshot` — point-in-time governance state for a run

### Audit log (`lib/governance/auditLog.ts`)

Writes append-only events to the `admin_audit_logs` Firestore collection via `writeAuditEvent()`.

Action types: `evaluated` · `approved` · `blocked` · `changes_requested` · `policy_updated` · `admin_override` · `admin_deleted`

---

## Firestore Data Model

Primary database. Firebase Admin SDK is server-only — import with `"server-only"`.

| Collection | Purpose |
|-----------|---------|
| `users/{uid}` | User profile, plan, `runsThisMonth`, `usageMonth`, video quota, Stripe subscription state, governance fields |
| `runs/{runId}` | Panel run: `userId`, `question`, `selectedModels`, `status`, `results`, `resultsCompact`, `totalTokens`, `tokensByProvider`, `synthesizedReportV2`, `synthesizedStructuredReport` |
| `videoVerifications/{id}` | Video verification result with frames metadata, vision model outputs, verdict, consensus score |
| `admin_audit_logs/{id}` | Append-only governance audit events |
| `teams/{teamId}` | Team document with members, policyRules, settings |
| `teamRuns/{runId}` | Team run audit bundles with human decisions |
| `appConfig/modelKeys` | Operator-managed API keys (runtime fallback to env vars if absent) |

### API key resolution

At runtime, `lib/env.ts` is the single source of truth for all server-side environment variables. Code in `lib/` and `app/api/` must import from there — never from `process.env` directly. Model API keys can also be stored in `appConfig/modelKeys` in Firestore; the connector loader falls back to env vars if the Firestore document is missing.

---

## API Routes Summary

| Route | Method | Description |
|-------|--------|-------------|
| `/api/run-panel` | POST | Run Deep Research panel; returns `runId` + `governanceStatus` |
| `/api/verify-claim` | POST | Run Claim Verification panel; returns verdicts + consensus score |
| `/api/verify-video` | POST | Run Video Verification pipeline; returns verdict + consensus |
| `/api/synthesize-panel` | POST | Generate or return cached Synthesis for a `runId` |
| `/api/stripe/webhook` | POST | Stripe webhook — sync subscription state to Firestore |
| `/api/stripe/checkout` | POST | Create Stripe checkout session |
| `/api/governance/*` | Various | Policy management, peer review queue, human decisions |
| `/api/admin/*` | Various | Admin management (requires `admin: true` custom claim) |
| `/api/user/*` | Various | User profile read/update |

---

## Environment Variables

All exported from `lib/env.ts`.

**AI providers:**

| Variable | Used for |
|----------|---------|
| `OPENAI_API_KEY` | ChatGPT connector + synthesis (GPT-5.1) + video vision |
| `ANTHROPIC_API_KEY` | Claude connector + video vision |
| `XAI_API_KEY` | Grok connector |
| `PERPLEXITY_API_KEY` | Perplexity connector |
| `GEMINI_API_KEY` | Gemini connector + video vision |
| `DEEPSEEK_API_KEY` | DeepSeek fallback connector |
| `GROK_MODEL` | Override Grok model string (default: `grok-4-1-fast-reasoning`) |
| `GEMINI_MAX_OUTPUT_TOKENS` | Override Gemini token limit (default: `8192`) |
| `PANEL_DEEPSEEK_FALLBACK_FOR` | Comma-separated provider names to enable DeepSeek fallback for (default: `openai,anthropic,google`) |

**Firebase:**

| Variable | Notes |
|----------|-------|
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | Recommended for Vercel — base64-encoded service account JSON |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Alternative: raw JSON string |
| `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` | Alternative: individual credential fields |

Firebase Admin tries credentials in the order listed above.

**Stripe:**

| Variable | Used for |
|----------|---------|
| `STRIPE_SECRET_KEY` | Server-side Stripe API calls |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `STRIPE_PUBLISHABLE_KEY` | Client-side checkout |
| `STRIPE_PRICE_3_MODELS` | Lite plan monthly price ID |
| `STRIPE_3_MODELS_ANNUAL` | Lite plan annual price ID |
| `STRIPE_PRICE_5_MODELS` | Full plan monthly price ID |
| `STRIPE_5_MODELS_ANNUAL` | Full plan annual price ID |

**Access control:**

| Variable | Used for |
|----------|---------|
| `ADMIN_EMAILS` | Comma-separated emails that can be granted `admin: true` custom claim |

---

## Content-Security-Policy

CSP headers are defined in `next.config.js`. Adding calls to any new external domain (new AI provider, analytics service, etc.) requires updating the `connect-src` directive before deploying.

---

## pSEO Architecture

All 291 use-case pages are defined as a single `PAGES: PSEOPage[]` array in `lib/pseo/pages.ts`. There is no CMS. The dynamic route `app/use-cases/[slug]/page.tsx` renders every page. The hub at `app/use-cases/page.tsx` has a separate `HUB_GROUPS` array that controls which pages appear and how they are grouped in the hub UI.

`app/sitemap.ts` auto-generates from `PAGES` using the `publishedAt` field as `lastModified`. The same `publishedAt` value populates `dateModified` in JSON-LD structured data — it is the only freshness signal available and should be updated on any meaningful content change.

### PSEOPage fields

| Field | Type | Notes |
|-------|------|-------|
| `slug` | string | URL path segment; must be unique |
| `title` | string | `<title>` tag |
| `h1` | string | Page heading |
| `metaDescription` | string | `<meta name="description">` |
| `audience` / `audienceDetail` | string | Used in structured data |
| `problem` / `solution` | string | Intro section copy |
| `workflow` | string[] | Numbered steps |
| `useCases` | string[] | Bullet list |
| `cta` | string | Call-to-action button label |
| `category` | string | Used for hub grouping |
| `schemaType` | `"FAQPage"` \| `"HowTo"` | JSON-LD type |
| `faq` | `{ question, answer }[]` | FAQPage structured data |
| `relatedLinks` | `{ label, href }[]` | Internal links; keep under ~9 |
| `bodySections` | `{ heading, bullets?, paragraphs?, steps? }[]` | Additional content sections |
| `publishedAt` | string (ISO date) | Freshness signal for sitemap + JSON-LD |
| `comparisonTable` | object (optional) | Comparison table data |

### IndexNow

Bing (and Yandex/Seznam/Naver via the shared protocol) only crawl on their own schedule unless pinged. `scripts/submit-indexnow.mjs` POSTs URLs to `https://api.indexnow.org/indexnow`; the key file at `public/97ce1cedaadd35047076e3cc65939bd8.txt` must be live in production for the endpoint to verify the submission (it fetches the file from `convergepanel.com` before accepting).

Run `npm run seo:indexnow` after any PSEO edit session — it diffs `PAGES` against `scripts/.indexnow-state.json` (committed) and submits only slugs whose `publishedAt` changed since the last successful run. Use `npm run seo:indexnow -- --all` to resubmit every URL in the sitemap, or pass explicit slugs to submit only those. State is only persisted on a successful (2xx) response, so a failed submission (e.g. key not yet deployed) doesn't get silently marked as done. Reusable submission logic for future runtime use (e.g. firing from a publish API route) lives in `lib/pseo/indexnow.ts`.

---

## Theme

The application uses a light theme globally (`body { background: #F6F6F3 }`, Hanken Grotesk font), switched from an earlier dark theme in July 2026. All UI must use the `cp-*` design tokens defined in `tailwind.config.ts` and `globals.css` (`cp-bg`, `cp-surface`, `cp-raised`, `cp-text`, `cp-muted`, `cp-accent`/`cp-primary`, `cp-border`, etc.) — no `dark:` Tailwind variants (the app has no dark-mode toggle). See `CLAUDE.md` for the full token reference and readability conventions (e.g. `-600`/`-700` shades for colored text on light backgrounds, not `-300`/`-400`).

Note: `app/page.tsx` (the main Research/Verify Claim/Verify Video dashboard) predates the token system and uses hardcoded Tailwind classes (`bg-white`, `text-slate-900`, etc.) instead of `cp-*` tokens — it happens to already match the light theme but won't pick up future token changes automatically.
