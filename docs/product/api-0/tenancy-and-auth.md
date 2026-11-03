# Tenancy and authentication (API-0)

**Status:** design. Implemented in API-1 only after separate authorization and after the Order 6 boundary change for secrets (OD-21, OQ-1). All modules named here are **new** unless a path on the baseline is cited.

## 1. Tenancy model

```
Firebase user (uid) ──member of──▶ API Organization (org_…)   [billing + tenancy boundary]
                                        ├── Application (app_…)  [grouping: keys, webhooks, usage]
                                        │       ├── API key (cpk_live_/cpk_test_…)
                                        │       └── Webhook endpoint (whe_…)
                                        ├── Verifications (ver_…)  [stored under the org]
                                        └── Ledger, periods, settings
```

- **Organization** is the tenant. Every data-plane record lives under `apiOrganizations/{orgId}/…` or carries `orgId` and is only reachable through a key of that org.
- **Separate from Team Workspaces** (OD-2). No v1 code path reads `workspaces/`, `teams/`, `runs/` or `users/` data from an API credential. An optional org→workspace link is a future, separately authorized stage.
- **Separate from consumer billing** (OD-1). A consumer subscription on `users/{uid}` grants no API entitlement; an API subscription grants no consumer entitlement.
- **Applications** are not tenants; they partition keys, webhooks and usage inside one org. Any key in an org can read verifications of any application in that org only if it holds `verifications:read`; per-application read restriction is a key option (`app_scoped: true`, default **true**: a key reads only its own application's verifications).
- **Identifiers are not secrets.** `org_`, `app_`, `ver_`, `whe_` IDs may appear in logs and support tickets. Customer ID ≠ credential.

## 2. Roles (management plane)

Roles follow the pattern of `lib/workspaces/capabilities.ts` (`ROLE_CAPABILITIES`, `roleHasCapability`) in a **new** `lib/apiPlatform/orgCapabilities.ts`.

| Capability | owner | admin | developer | billing | viewer |
|---|---|---|---|---|---|
| `org.manage` (rename, delete org) | ✅ | — | — | — | — |
| `members.manage` | ✅ | non-owner only | — | — | — |
| `keys.test.create` | ✅ | ✅ | ✅ | — | — |
| `keys.live.create` | ✅ | ✅ | only if org setting `developersMayCreateLiveKeys` | — | — |
| `keys.revoke` | ✅ | ✅ | own keys | — | — |
| `webhooks.manage` | ✅ | ✅ | ✅ | — | — |
| `billing.manage` (plan, payment, spend limit) | ✅ | view | — | ✅ | — |
| `usage.view` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `settings.retention` (OD-10) | ✅ | ✅ | — | — | — |
| `settings.modelResponseAccess` (OD-19) | ✅ | ✅ | — | — | — |
| `data.delete` (dashboard deletion) | ✅ | ✅ | — | — | — |
| `audit.view` | ✅ | ✅ | — | — | — |

Exactly one or more `owner`; the last owner cannot be removed or demoted. Role changes are audited.

## 3. Management-plane authentication

- Routes under `/api/developer/*` (**new**) on the main app domain authenticate **only** with the existing Firebase session through `resolveRequestIdentity()` (`lib/auth/resolveRequestIdentity.ts`: cookie `__session` or bearer ID token, fails closed on mismatch).
- Any `Authorization: Bearer cpk_…` on a management route is rejected with 401 before identity resolution. A leaked API key can never create keys, webhooks or change settings.
- **Disabled Firebase accounts** obtain nothing (consistent with `docs/operations/admin-authority-tiers.md`).
- **Fresh session** (`auth_time` ≤ 15 min) for: live key creation, webhook create/update, spend-limit change, retention change, enabling model-response access, deletion, member role change, org deletion.
- Membership is read server-side from `apiOrgMemberships/{sha256(orgId + ":" + uid)}`, the deterministic-ID approach used for `workspaceMemberships`. Client-supplied org or role values are ignored.
- The platform admin tiers do not grant org roles. SYSTEM_ADMIN has a separate metadata-only support view (OD-13) and no org membership.

## 4. API keys

### 4.1 Format
`cpk_{mode}_{keyId}_{secret}`

| Part | Content | Purpose |
|---|---|---|
| `cpk_` | fixed | Recognizable for secret scanning (OD-17) |
| `mode` | `live` or `test` | Prevents test keys reaching providers |
| `keyId` | 12 base62 chars from `crypto.randomBytes(9)` | Public lookup handle; shown as the key's prefix |
| `secret` | 43 base62 chars from `crypto.randomBytes(32)` (256 bits) | The credential |

Example prefix shown in dashboards and logs: `cpk_live_7Hk2mQ9xLp3A`.

### 4.2 Hashing: HMAC-SHA-256 with a server pepper (decided)

`hash = HMAC-SHA-256(pepper, secret)`, stored as hex with `hashVersion`.

**Why not Argon2id.** Argon2id and other slow password hashes exist to resist offline guessing of **low-entropy** secrets. An API key secret is 256 bits from a CSPRNG; offline guessing is infeasible at any hash speed. A slow hash would add tens of milliseconds and memory pressure on every request at API volume for no security gain. **Why a pepper.** If the Firestore `apiKeys` collection leaks, hashes without the pepper are useless for verifying guesses; the pepper is held outside Firestore. **Pepper storage:** read through `lib/env.ts` (requires the Order 6 boundary change, OD-21), or held as a managed KMS MAC key if that is selected in API-1 design (OD-12 alignment). **Rotation:** `API_KEY_PEPPER_PREVIOUS` accepted during a window; each successful verify under the old pepper rewrites the hash under the new one.

### 4.3 Verification (constant-time)
1. Parse the bearer with a strict regex; reject on mismatch (same 401).
2. Single read `apiKeys/{keyId}`; if missing, still compute an HMAC over a dummy value so timing does not reveal existence.
3. Compute HMAC of the presented secret; compare with `crypto.timingSafeEqual` on equal-length buffers.
4. Reject if `revokedAt` set, `expiresAt` passed, `mode` mismatch (test key on a live-only operation, or live key without an active plan), org `suspended`/`canceled`, or application disabled.
5. Every failure returns the same `401 invalid_api_key` (except `403 org_suspended` after a successful match, which reveals only what the key holder already knows).
6. `lastUsedAt` is written at most once per minute per key (sampled) to avoid hot documents.

### 4.4 Scopes

| Scope | Grants | Default |
|---|---|---|
| `verifications:write` | create, cancel | ✅ |
| `verifications:read` | get result, report, compact models | ✅ |
| `verifications:delete` | `DELETE /v1/verifications/{id}` (OD-11) | — |
| `model_responses:read` | full model text with `?include=response_text`; grantable only while org model-response access is enabled (OD-19) | — |
| `usage:read` | `GET /v1/usage` | — |
| `models:read` | `GET /v1/models` | ✅ |

Disabling org model-response access strips `model_responses:read` from every key in the same transaction (audited).

### 4.5 Lifecycle
- **Create:** secret shown once; never retrievable; audit event `api_key.created`.
- **Rotate:** create new key → customer deploys → revoke old. Optional `expiresAt` on the old key for overlap (max 30 days).
- **Revoke:** immediate. No positive cache. A negative cache of ≤ 30 s for revoked IDs only. Webhook event `api_key.revoked`.
- **Expire:** optional `expiresAt` at creation.
- **Leak:** prefix-based scanning partners (before GA); auto-revoke on confirmed partner report, with owner notification.

## 5. Data-plane isolation rules

1. `orgId`, `appId`, `keyId`, `mode` come only from the verified key record.
2. Every Firestore path is built by one helper (**new** `lib/apiPlatform/tenantPaths.ts`) that takes the authenticated context, never a request parameter.
3. A foreign or non-existent ID returns `404 verification_not_found`.
4. Test-mode keys read only test-mode verifications, live only live.
5. Firestore rules deny all client access to every `api*` collection; Admin SDK only.
6. The data plane ignores cookies entirely (dedicated host, OD-4).

## 6. Audit events (`apiAuditEvents`)

Written in the **same transaction** as the mutation. Fields: `eventType`, `orgId`, `actor` (`{ kind: "user", uid } | { kind: "system" } | { kind: "operator", uid }`), `target` (key prefix, endpoint ID, verification ID), `before`/`after` for settings (no secrets), `requestId`, `createdAt`. Never secrets, never input or model text.

| Event | Trigger |
|---|---|
| `org.created`, `org.deleted`, `org.suspended`, `org.reactivated` | management, billing, abuse controls |
| `member.added`, `member.role_changed`, `member.removed` | management |
| `api_key.created`, `api_key.revoked`, `api_key.expired`, `api_key.auto_revoked` | management, system |
| `webhook.created`, `webhook.updated`, `webhook.disabled`, `webhook.secret_rotated` | management, dispatcher |
| `settings.spend_limit_changed`, `settings.retention_changed`, `settings.model_response_access_changed` | management |
| `verification.deleted`, `org.data_purged` | data plane, sweeper |
| `operator.metadata_viewed`, `operator.content_access_granted` | SYSTEM_ADMIN support view (OD-13) |
| `abuse.threshold_crossed`, `abuse.suspended` | cost-abuse controls (OD-8) |

Retention: 7 years placeholder (counsel to confirm).

## 7. Proposed Firestore collections (all new)

| Path | Key fields | Writers |
|---|---|---|
| `apiOrganizations/{orgId}` | `name`, `status`, `plan`, `stripeCustomerId`, `spendLimitUsd`, `retention { inputsRetainAllowed, resultsDays, evidenceDays }`, `modelResponseAccess`, `developersMayCreateLiveKeys`, `abuseState`, `createdBy`, `createdAt` | management, billing webhook, abuse controls |
| `apiOrgMemberships/{sha256(orgId:uid)}` | `orgId`, `uid`, `role`, `status`, `addedBy`, `addedAt` | management |
| `apiApplications/{appId}` | `orgId`, `name`, `status`, `createdAt` | management |
| `apiKeys/{keyId}` | `orgId`, `appId`, `mode`, `scopes[]`, `appScoped`, `hash`, `hashVersion`, `prefix`, `createdBy`, `createdAt`, `lastUsedAt`, `expiresAt?`, `revokedAt?`, `revokedBy?` | management; `lastUsedAt` by data plane |
| `apiWebhookEndpoints/{endpointId}` | `orgId`, `appId`, `url`, `events[]`, `secretCiphertext`, `kmsKeyVersion`, `status`, `failureSince` | management, dispatcher |
| `apiAuditEvents/{autoId}` | §6 | same transaction as mutation |
| `apiOrganizations/{orgId}/…` | verifications, ledger, periods, idempotency, webhookDeliveries | see PRD §12.1 |

Indexes are added one at a time to `firestore.indexes.json` in the stage that needs them (PRD §12.2).
