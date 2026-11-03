# Retention, deletion and audit evidence (API-0)

**Status:** design. Rulings applied: OD-10 (modified: configurable retention, 30-day pilot default, four data classes), OD-11 (deletion endpoint across all associated records), OD-13 (operator access metadata-only, audited), OD-19 (full model text opt-in, default off). All periods are placeholders except the 30-day pilot default; long periods need counsel confirmation (OQ-3). Every default must align with customer terms and each model provider's own requirements.

## 1. The four data classes

### (a) Operational inputs
- **Contents:** claim, question and context text; worker scratch state; per-step intermediate outputs that contain raw model text.
- **Location:** `apiOrganizations/{orgId}/verifications/{verId}/inputs/current`, `…/steps/{step}` and the per-provider-call records `…/steps/{step}/calls/{callKey}` (raw model text and usage, `jobs-and-idempotency.md` §4.4).
- **Retention:** deleted when the job reaches any terminal state (finalize, failure, cancel, expiry). Hard maximum 72 h for jobs stuck in a non-terminal state (sweeper fails and purges them).
- **Opt-in:** `options.retain_input: true` keeps input text for the class (b) period, so the customer can see it alongside the result. The org may forbid this (`retention.inputsRetainAllowed: false`). Intermediate step outputs are never retained beyond terminal state.
- **What remains:** the input fingerprint (`HMAC-SHA-256` with an org-scoped key) and character counts, which move to class (d).

### (b) Customer-visible results
- **Contents:** `ApiVerificationResultV1`, `/report` content, compact per-model results, opt-in full model text (OD-19), retained input (if opted in), webhook delivery records.
- **Retention:** **30 days** pilot default; configurable per org within plan bounds (1–365 days placeholder). Firestore TTL on `expiresAt` plus a subcollection sweeper (TTL does not cascade to subcollections).
- **Full model text:** stored only if the job was created with `retain_model_responses: true` while org model-response access was enabled; otherwise never persisted beyond the worker step (it stays in class (a) and is purged at terminal state). Disabling org access purges stored full text for all jobs within 24 h.

### (c) Minimal billing records
- **Contents:** customer ledger entries, period counters, internal cost ledger entries (OD-8), Stripe event dedup records. Keys: `orgId`, `verificationId`, credits, token counts, cost, `rateCardVersion`, timestamps.
- **Never contains:** input text, model text, result content, fingerprints.
- **Retention:** 7 years placeholder (finance and tax; counsel to confirm). Not customer-configurable. Not removed by `DELETE` (it has no content to remove).

### (d) Auditable verification evidence
Purpose: enough to **explain and reproduce** a verification later without keeping the raw input or raw model text. This resolves the earlier contradiction of discarding inputs while keeping results.

- **Contents** (modelled on `buildClaimVerificationAuditBundle` in `lib/verification/auditBundle.ts`, which already excludes raw model text, cf. `auditBundleHasNoRawModelText`):
  - input fingerprint and character counts;
  - `type`, `schema_id` (research), selected models, actual models, substitutions, per-slot status and failure class;
  - per-model verdict label, confidence, parts counts (`correct`, `incorrect`, `unverifiable`), parse health;
  - the inputs to scoring that the pipeline already persists (e.g. per-model stance per aligned claim);
  - aggregate outputs: verdict, gate, consensus score/level, trust values, availability states;
  - citations (URLs and hostnames);
  - methodology IDs and versions, `format_version`, pipeline commit SHA, `rateCardVersion`;
  - timestamps and the request ID.
- **Location:** `apiOrganizations/{orgId}/verifications/{verId}/evidence/current`.
- **Retention:** 30 days pilot default (same as b); configurable independently of (b) up to 7 years by plan or contract.
- **Reproduction procedure:** the customer re-submits its own copy of the input; the new job's fingerprint is compared with the stored fingerprint; model identities, methodology versions and pipeline commit explain any difference. Model outputs are not deterministic, so "reproduce" means "re-run under a documented configuration and compare", which the evidence makes possible.

## 2. Configurability

| Setting | Who | Bounds | Audit |
|---|---|---|---|
| `retention.resultsDays` (b) | owner, admin | plan min–max | `settings.retention_changed` |
| `retention.evidenceDays` (d) | owner, admin | ≥ resultsDays is **not** required; plan max | same |
| `retention.inputsRetainAllowed` (a opt-in) | owner, admin | boolean | same |
| `modelResponseAccess` (OD-19) | owner, admin | boolean, default off | `settings.model_response_access_changed` |

A shortened period applies to existing records at the next sweep (≤ 24 h). A lengthened period applies only to records not yet expired.

## 3. Deletion

### 3.1 `DELETE /v1/verifications/{id}` (OD-11)
- **Scope:** `verifications:delete` (never default).
- **Behaviour:** if `queued`/`running`, cancel first (settlement per normal rules). Then delete, across **all associated records**:
  - class (a): inputs, step outputs;
  - class (b): the verification document's result content, report data, `modelResults/*` (compact and full text), webhook delivery records;
  - class (d): `evidence/current`;
  - idempotency record → content-free `deleted` marker until its 24 h TTL (replays get `410 verification_deleted`).
- **Kept:** class (c) entries (no content); a tombstone `apiDeletions/{deletionId}` (`verificationId`, `orgId`, `requestedBy` key prefix or uid, `requestedAt`, `completedAt`); audit event `verification.deleted`.
- **Response:** `202` with `del_…` ID; completion target 24 h (placeholder); webhook `verification.deleted` when complete. Idempotent: a second call returns the same deletion.
- **After deletion:** `GET` returns `410 verification_deleted` for the owning org (foreign orgs still get `404`).
- **Legal hold:** the only exception; class (d) is retained, the customer is told in the deletion response, and the hold is audited.

### 3.2 Dashboard deletion
Owner/admin may delete single verifications, all verifications of an application, or all data in a date range. Same mechanics; fresh session required.

### 3.3 Org deletion
Purges classes (a), (b), (d), keys, webhook endpoints and memberships within 30 days; keeps class (c) and audit events in minimized form; Stripe customer is retained only as finance requires.

## 4. Backups

Firestore managed backups / point-in-time recovery (if enabled for the project) retain deleted data for their own window. Customer terms must state: "deleted data may persist in encrypted backups for up to N days (placeholder 35) and is not restored except for disaster recovery; if restored, deletions are re-applied from `apiDeletions` tombstones before the data is served." The restore runbook must include the tombstone replay.

## 5. Provider-side retention

Customer content (class a) is sent to the models the customer selected; to the pipeline providers the request type uses (Gemini for research classification and auxiliary calls, OpenAI for opted-in synthesis); and to fallback providers (DeepSeek, the Claude synthesis fallback) **only** when the request set `allow_fallback: true` (default `false`). `GET /v1/models` `pipeline_providers` lists them. Each provider's own retention, logging and training rules govern its copy. ConvergePanel cannot delete it. Before the pilot, owner and counsel confirm each provider's terms (PRD §21A P-9); customer terms and the DPA list subprocessors and their stated retention. A provider whose terms are not confirmed is not selectable via the API. This document makes no statement about any provider's terms.

## 6. Customer export

- Every retained result, report and compact model result is retrievable through the `GET` endpoints.
- Dashboard export (owner/admin/billing): usage and ledger history (CSV/JSON), audit events for the org, list of retained verifications.
- Bulk result export (archive) is v1.x.
- On cancellation, data stays readable for 30 days for export, then normal retention applies.

## 7. Operator access (OD-13)

SYSTEM_ADMIN support view shows metadata only: status, timings, credits, model statuses, failure codes, abuse state. Every view writes `operator.metadata_viewed`. Content access (classes a/b/d) for a support case requires written customer consent, is time-boxed (≤ 72 h), and writes `operator.content_access_granted`. ADMIN_PORTAL has no access to `api*` data.

## 8. Test obligations

Class (a) absent after each terminal path, including `steps/*/calls/*`; TTL and sweeper per class; `DELETE` leaves only class (c) + tombstone (enumerate every subcollection); full text never stored without both opt-ins; disabling model-response access purges text; restore runbook replays tombstones (rehearsal in API-7).
