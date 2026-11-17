# API secret boundary (Addendum 1 D3 / OQ-1 / DEP-2 / DEP-16)

**Status:** design **approved by the owner** (Addendum 1 §1.1 SB, 2026-11-17), plus a draft implementation on its own branch (`feat/api-secret-boundary`). No real credential is created, no environment variable is set in any Vercel environment, nothing is deployed, and the branch merges only by a separate owner decision, through its own release gate (exact-head review, CI, fresh owner approval). Design approval does not authorize creating or provisioning any secret. There is no general relaxation of Order 6.

## 1. Problem

API-1 needs server-only secrets, first `API_KEY_PEPPER` for the key verifier. API-0 assumed they would be read through `lib/env.ts` (DEP-2). That has two costs:

1. **`lib/env.ts` is frozen by the Order 6 boundary suites.** They pin its git blob (`2b81ae72…`) in `components/adaptive/__tests__/dsProvenanceUiBoundaries.spec.ts` and `lib/research/readableReport/__tests__/readableFrozenFiles.spec.ts`, and its content sha256 in `lib/adaptiveSchema/__tests__/dsExport/dsExportBoundaries.spec.ts`. Other suites pin specific lines and readers. Any edit forces re-pinning several frozen-file suites.
2. **`lib/env.ts` is client-importable.** Its header says it "may be imported in client components (via planConfig)", and it has no `server-only` guard. Next.js does not inline non-`NEXT_PUBLIC_` values into client bundles, but putting a secret accessor in a module that client code can import works against the owner rule "do not add secrets to client bundles or build-time literals", and leaves a future mistake one import away.

## 2. Decision (recommended): a dedicated server-only secrets module; `lib/env.ts` unchanged

- **New module `lib/apiPlatform/secrets.server.ts`.** Its first statement is `import "server-only"`, so any client import becomes a **build error**. It is the **only** module in the repository that reads an API secret name from `process.env`.
- **Lazy reads.** Values are read when called, never at module load, so no build step evaluates them and there is no build-time literal.
- **Decoded, validated, no fallback.** The module returns decoded `Buffer`s, never the raw string. A missing, short or malformed value returns a typed `unavailable` result, so callers fail closed (the API principal guard answers `503`, API-1a). There is never a default, a development fallback or an empty-key HMAC.
- **No logging.** The module does not log or throw the value, and imports no logger.
- **`lib/env.ts` is byte-identical, and so is every Order 6 pin.** The "rebaseline" is evidence that every Order 6 boundary suite passes unchanged, before and after (§6).
- **A new boundary spec enforces it** (§5).
- **Exception to the `CLAUDE.md` convention.** `CLAUDE.md` names `lib/env.ts` the single source of truth for server env vars. This module is a documented, scoped exception for **API-platform secrets only**: no provider key, flag or other variable may be read through it. The convention text is updated by the same branch.

**Alternative not chosen: add the secrets to `lib/env.ts` and re-pin the Order 6 suites.** It is rejected for the two costs in §1. It stays available if the owner prefers it. It would need exact-file exception comments in each pinning suite, in the style of the 2026-11-03 and 2026-11-09 owner exceptions already in `dsExportBoundaries.spec.ts`.

## 3. Secret inventory

| Name | Purpose | Format / validation | Reader | Consumers | Needed by | Implemented on the branch? |
|---|---|---|---|---|---|---|
| `API_KEY_PEPPER` | HMAC-SHA256 key for API key verifiers (PRD §7.2) and the root for derived subkeys | base64url, decodes to ≥ 32 bytes; else `unavailable` | `secrets.server.ts` (**new**) | `lib/apiPlatform/keys.ts` (**new**, API-1a), `lib/apiPlatform/listCursor.ts` (**new**, API-3) | API-1a | **Yes** |
| `API_KEY_PEPPER_PREVIOUS` | Verifies keys hashed under the previous pepper during a rotation window (`hashVersion`) | same; optional; must differ from current | `secrets.server.ts` | `keys.ts` | API-1a | **Yes** |
| Redis-class store REST URL + token. Names are fixed by the vendor once one is approved (Upstash is the preferred candidate only, Addendum 1 §1.1 R): the Upstash Marketplace integration injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`, confirmed at provisioning, Phase 1D-D). The read-only token and `KV_URL`/`REDIS_URL` it also injects must **not** be read | Rate windows, concurrency counters, CR-2 pools | URL must be `https:`; token non-empty; per environment (Preview gets its own database) | `secrets.server.ts` | `lib/apiPlatform/rateStore.ts`, `providerPools.ts` (both **new**, API-3) | API-3 | **No.** Reserved, added only after the D5 vendor approval |
| Queue authentication | Authenticates queue → worker deliveries | Vercel Queues: platform OIDC, no stored secret (Phase 1D-C). Cloud Tasks fallback: Google-signed OIDC verified by audience, with config only (`CLOUD_TASKS_QUEUE`, `CLOUD_TASKS_INVOKER_SA`, `CLOUD_TASKS_AUDIENCE`, not secrets); a shared secret `API_QUEUE_SHARED_SECRET` only if OIDC verification is impossible. A Vercel Cron sweeper would read `CRON_SECRET`. **No non-test code reads it today** (it appears only as a regex control string in `setAdminRouteRetired.spec.ts`). It is therefore a **new** secret read that needs its own boundary decision before API-3: either it is added to this module's reserved names (reader, allow-list, test) or the sweeper uses queue-delivered scheduling instead | `secrets.server.ts` (only if a stored secret is needed) | `app/api/internal/api-worker/*` (**new**, API-3) | API-3 | **No.** Reserved |
| `API_STRIPE_WEBHOOK_SECRET` | Signature secret of the separate API billing webhook (OD-7) | `whsec_` prefix | `secrets.server.ts` | `app/api/stripe/api-platform-webhook/route.ts` (**new**, API-2S) | API-2S (post-beta) | **No.** Reserved |
| `API_WEBHOOK_ENCRYPTION_KEY` | AES-256-GCM fallback for webhook signing secrets, **only if managed KMS is unavailable** (OD-12) | base64url, decodes to 32 bytes | `secrets.server.ts` | `lib/apiPlatform/webhookSecrets.ts` (API-5W) | API-5W (post-beta) | **No.** Reserved; not created if KMS is approved |

**Derived subkeys** come from `API_KEY_PEPPER` by HKDF-SHA256 with a fixed purpose label, so no extra stored secret is needed:

| Label | Use |
|---|---|
| `cp-api/key-verifier/v1` | Key verifier |
| `cp-api/list-cursor/v1` | History-cursor HMAC tag (Addendum 1 §3). Cursors expire after 24 h, and a pepper rotation simply invalidates them |

The input fingerprint (class d) is **not** derived from the pepper. It needs stability across rotations, so it is designed in API-3 with its own versioned key.

## 4. Rules

1. Only `lib/apiPlatform/secrets.server.ts` mentions a reserved name in executable code (tests and docs excepted).
2. The module's first statement is `import "server-only"`.
3. Importers of the module are an explicit allow-list. It is **empty** on the boundary branch. API-1a adds `lib/apiPlatform/keys.ts`, and each later addition is a reviewed allow-list edit.
4. No reserved name starts with `NEXT_PUBLIC_`, and no `next.config.js` `env` entry exposes one.
5. Values are read lazily at call time. Nothing is cached across calls, so a rotation applies on the next request after the deployment picks it up.
6. A missing or invalid value means `unavailable`, and every API surface fails closed. Web routes never read these secrets and are unaffected.
7. Existing provider-key access (`lib/env.ts`, `appConfig/modelKeys`) and every authorization path (S2-b guard, session/bearer identity) are untouched.
8. Provisioning, which is out of scope here, is per environment. The isolated environment gets its own values, Production values are created only by a separate approval, and Preview never receives a Production pepper.

## 5. Tests on the branch (`lib/apiPlatform/__tests__/secretBoundary.spec.ts`)

- **Single reader:** a repository scan (excluding tests and docs) finds reserved names only in `secrets.server.ts`, with a positive control showing the scan finds the module itself.
- **`server-only` guard:** the first statement of `secrets.server.ts` is `import "server-only"`.
- **Importer allow-list:** no non-test file imports the module (empty allow-list), with a positive control.
- **`lib/env.ts` unchanged:** its git blob is still `2b81ae7239ea4fd655b8320d5bf726c778149a20`, and it contains no reserved name.
- **No exposure:** no reserved name starts with `NEXT_PUBLIC_`; `next.config.js` does not mention any.
- **Behaviour:** absent, empty, non-base64url and short values give `unavailable` with a reason code and never the value. A valid value gives a 32+-byte `Buffer`. The previous pepper is optional; when it equals the current one it is `unavailable` (`previous_equals_current`). Subkeys are deterministic, differ by label, differ from the raw pepper, and are 32 bytes.
- **No logging:** the module imports no logger and contains no `console.` call.

## 6. Order 6 rebaseline evidence

Run every Order 6 / frozen-file boundary suite on `main` and on the branch, and compare per test. Expected result: identical pass sets, **zero pin edits**, `lib/env.ts` blob unchanged. The results are recorded in the branch's review record.

## 7. Rollback

Revert the branch merge. No environment variable depends on it until API-1a uses it, and API-1a fails closed if the module or its values are absent.
