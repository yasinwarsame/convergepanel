# API-0 — Verification API architecture and contract design

| | |
|---|---|
| **Status** | **API-0 design only.** Authorized by owner ruling OD-20 (2026-11-03). Documents only. |
| **Amended** | [Owner Decision Addendum 1](owner-decision-addendum-1.md) (2026-11-17). [Owner Decision Addendum 2](owner-decision-addendum-2.md) (2026-11-17): quality-audit disposition and contract corrections; `openapi.yaml` 0.3.0-draft. [Owner Decision Addendum 3](owner-decision-addendum-3.md) (2026-11-17, Quality Correction R2): rulings R1–R4, allowlist and classifier status, #327 R-7, 512 KiB body cap, m1–m5 corrections and m6 in part (`js-yaml` open); `openapi.yaml` 0.4.0-draft. [Owner Decision Addendum 4](owner-decision-addendum-4.md) (2026-11-17, R2 disposition): closes the Addendum 3 owner items; `js-yaml` declared. |
| **Not authorized** | API-1 to API-7, except where a separate owner authorization names a stage. No routes, code, credentials, Stripe products, workers, queues, KMS keys, DNS, environment variables or configuration may be created on the strength of these documents. |
| **Parent document** | [`../api-platform-prd.md`](../api-platform-prd.md) (Rev 4: owner rulings 2026-11-03, design review fixes, Addendum 1 of 2026-11-17) |
| **Baseline** | `main` at `2f70d1f`; Addendum 1 at `cabbdbb` |

Where this set and the PRD disagree, the PRD's §21 rulings win, **subject to Addendum 1** (which wins over both where it differs), and the disagreement is a defect to fix in this set.

## Index

| # | Document | What it fixes |
|---|---|---|
| 1 | [`result-schema.md`](result-schema.md) | Canonical `ApiVerificationResultV1`: sections, availability states, CR-1 `methodology` + `limitations`, mapping to existing modules, versioning, JSON Schema (draft 2020-12) |
| 2 | [`openapi.yaml`](openapi.yaml) | OpenAPI 3.1 **draft** for the data plane and signed webhook payloads |
| 3 | [`threat-model.md`](threat-model.md) | STRIDE per component, assets, trust boundaries, mitigations, residual risks, test obligations |
| 4 | [`tenancy-and-auth.md`](tenancy-and-auth.md) | Org / app / key model, roles, key format and hashing, scopes, rotation, management-plane auth, audit events, collections |
| 5 | [`jobs-and-idempotency.md`](jobs-and-idempotency.md) | Job state machine, leases, step-wise worker under 300 s, retries, idempotency, cancellation, webhook delivery and replay protection |
| 6 | [`ledger-and-billing.md`](ledger-and-billing.md) | Reservation/settlement ledger, credit weights, internal cost ledger (OD-8), caps, suspension, Stripe via separate webhook (OD-7), reconciliation |
| 7 | [`pricing-and-cost-model.md`](pricing-and-cost-model.md) | Scenario A pilot; B and C later; cost formula. **All numbers are placeholders** |
| 8 | [`retention-and-deletion.md`](retention-and-deletion.md) | Four data classes (OD-10), deletion endpoint (OD-11), audit evidence, backups, provider-side retention, export |
| 9 | [`developer-journeys.md`](developer-journeys.md) | Sign-up to delete, plus agent / tool-calling integration |
| 10 | [`dependencies-and-gates.md`](dependencies-and-gates.md) | Implementation dependencies, per-stage gates API-1..API-7, web-capacity protection gate, open questions |
| 11 | [`owner-decision-addendum-1.md`](owner-decision-addendum-1.md) | **2026-11-17 owner rulings D1–D10**, plus the same-day release-gates rulings (§1.1: P1–P4 confirmed, secret-boundary design approved, queue/Redis/scheduler/infrastructure/provider conditions): reconciliation of OD-1..OD-21, lean controlled beta scope, Gemini disclosure and acknowledgement, history endpoint, amended stage gates, infrastructure matrix, implementation sequence. Wins over this set and the PRD where it differs |
| 12 | [`secret-boundary.md`](secret-boundary.md) | Secret-only Order 6 boundary (D3/OQ-1): server-only secrets module, inventory, readers, rules, tests, rebaseline evidence. Draft implementation on `feat/api-secret-boundary`; merge by separate decision |
| 13 | [`error-catalog.md`](error-catalog.md) | **Single source** for every API error code (status, type, plane, stage, beta status, message), the normative error precedence for both planes with privacy rules, and the request text and body rules (NFC, code-point lengths, encoding, size, models and metadata limits) |
| 14 | [`owner-decision-addendum-2.md`](owner-decision-addendum-2.md) | **2026-11-17 owner disposition of the quality audit** (contract preliminary; #325 NO-GO until corrected and re-reviewed; #326 gated; #327 NO-GO; C-5 pending) and the C-1/C-3/C-4/C-6 corrections. Supersedes the earlier CLEAN #325 record. Changes no owner ruling |
| 15 | [`owner-decision-addendum-3.md`](owner-decision-addendum-3.md) | **2026-11-17 Quality Correction R2:** owner rulings R1 (optional synthesis vs pipeline Gemini operations), R2 (no full raw model responses in the beta), R3 (unanimous "inaccurate" is not disagreement), R4 (consensus meaning per schema); allowlist not approved; classifier vs pre-reservation unresolved; #327 R-7; 512 KiB body cap with sizing evidence and an open owner decision; m1–m5 corrected, m6 partly (`js-yaml` remains, owner decision). Changes no earlier owner ruling |
| 16 | [`implementation-snapshots/api-1a-errors.json`](implementation-snapshots/api-1a-errors.json) | Generated snapshot of `lib/apiPlatform/errors.ts` at #327 @ `fa9146a` (generator beside it); pins the catalog to the draft implementation |
| 17 | [`owner-decision-addendum-4.md`](owner-decision-addendum-4.md) | **2026-11-17 R2 disposition:** body cap decided (512 KiB raw, option d), metadata aggregate provisional, `js-yaml` declared, validator review (no change), cancel/deleted-marker 410, layered per-credential rate limits, exact transactional concurrency, D6 withdrawal; what the contract tests do not prove |
| 18 | [`owner-decision-addendum-5.md`](owner-decision-addendum-5.md) | **2026-11-17 MAJOR-1 concurrency:** the accepted-job count moves to one unsharded, organization-scoped record `apiOrgConcurrency/{orgId}`; atomic admission, exactly one release, never negative, detection-only reconciliation with an audited repair |
| 19 | [`owner-decision-addendum-6.md`](owner-decision-addendum-6.md) | **2026-11-18 deletion of a running job:** cancellation and settlement before purge (one idempotent deletion operation, 410 from acceptance, release by the job's own terminal transition, purge after release, late-write barrier); sweeper recovery for `synthesizing`; one-read-time drift detection; `worker_timeout` platform-caused; throughput disclosed with cited Firestore guidance |
| 20 | [`owner-decision-addendum-7.md`](owner-decision-addendum-7.md) | **2026-11-18 deletion binds to the original verification:** the deleted marker is written only for the record of that exact acceptance (newer jobs under the same key always replay); settlement computed in the terminal transaction; provider-call boundary, purge and dispatch races tested; barrier narrowed to content writes; platform faults feed the repeated-failing-input short-circuit |
| 21 | [`owner-decision-addendum-8.md`](owner-decision-addendum-8.md) | **2026-11-18 R4 settlement of fully failed jobs:** owner ruling E1 (a fully failed job is charged 0 and releases its whole reservation; provider cost recorded separately); reference model and Addendum 7's model formula corrected; short-circuit attribution excludes platform faults; acceptance identity generated independently; late provider calls tested |
| 22 | [`owner-decision-addendum-9.md`](owner-decision-addendum-9.md) | **2026-11-18 R4 settlement derived from durable state:** owner rule that a worker crash never changes a charge because a `DELETE` (or `cancel`) was pending; crash recovery ends `failed: worker_timeout`, charged 0, whatever is pending; settlement state-transition table (`jobs-and-idempotency.md` §6.3, T1–T24) with committed-work definition and atomicity; one unresolved case and two further owner questions; acceptance-ID RNG seam, soft-ratio and structured ledger-rule tests |
| 23 | [`owner-decision-addendum-10.md`](owner-decision-addendum-10.md) | **2026-11-19 R5 owner decisions Q1–Q3:** committed usable work is billed only under the existing tariff and survives a crash (T18 settles it), uncommitted work is never billable, and sweeper-ended `failed: worker_timeout` jobs stay charged 0 under E1 (owner confirmation OQ-A); provider cost recorded for every dispatched call attempt, including uncommitted ones (dispatch record and cost recovery, per-attempt entry ID), independently of charges; lease fencing (a worker that lost its lease commits no final transition or charge; T25–T26); exact 30 % soft-ratio boundary tests; four owner questions |

## What the contract tests prove, and what they do not

The specs under `docs/__tests__/` (schema validation, catalog and example consistency, body sizing, and the idempotency, cancel and concurrency **reference model**) test the documented contract and a deliberately small, in-memory model of the decision procedure. **They do not prove the distributed implementation:** real Firestore transaction and lock behaviour, the Redis-class store, queue delivery, worker leases, retries and crashes, clocks, and the network. API-3 must add integration tests against the implementation, Firestore-emulator tests, fault-injection tests (aborted transactions, lost publishes, worker crashes, store outages) and tests in an isolated environment before any release decision. (Owner Decision Addendum 4.)

## Fixed positions this set inherits from the PRD

1. **No second engine.** Every verdict, score, consensus, disagreement and synthesis comes from the existing web pipeline (`lib/runPanelExecution.ts`, `lib/adaptiveSchema/*`, `lib/verification/*`, `lib/synthesis/*`). The API re-serializes; it never re-scores and never invents.
2. **CR-1.** Model consensus is not factual verification. Every rated section carries machine-readable `methodology` and `limitations`.
3. **CR-2.** API usage must not degrade Individual Research or Team Workspaces. Protection lives entirely on the API side.
4. **First release** covers claim and research verification only. Video (OD-14), BYOK (OD-15), MCP (OD-16) and complex automation come later.
5. **Gemini** failures (owner-side Google billing) are shown as `failed` slots with a limitation. No configuration change.
6. **Tenant isolation** by construction: every data-plane path is derived from the authenticated key's `orgId`.
7. **Bounded spend.** Every job is pre-authorized against a hard cap; one authoritative customer ledger; an internal cost ledger records every provider call.
8. **OD-21.** Dark releases use compile-time switches; `lib/env.ts` is byte-pinned by Order 6 suites, so new secrets need a separately approved Order 6 boundary change. *(Addendum 1 §1.1 SB: approved as the server-only `lib/apiPlatform/secrets.server.ts` boundary; `lib/env.ts` unchanged.)*

## Acceptance gates for leaving API-0

API-0 is complete, and API-1 may be *proposed* for authorization, only when all of these hold:

| # | Gate | Evidence |
|---|---|---|
| G0-1 | Owner rulings OD-1..OD-21 recorded in the PRD and reflected in every document here | PRD §21 (done 2026-11-03); consistency review |
| G0-2 | Independent design review of the PRD and this set returns CLEAN (fresh reviewer per round, no context from the author) | Review record |
| G0-3 | `openapi.yaml` parses as OpenAPI 3.1 and as YAML; the JSON Schema blocks in `result-schema.md` parse as draft 2020-12; every example in `result-schema.md` validates | Review-time parser run (no CI change in API-0) |
| G0-4 | Every module path cited exists on the baseline, or is marked **new** | Reviewer grep |
| G0-5 | Open questions OQ-1..OQ-n in `dependencies-and-gates.md` are answered or explicitly deferred by the owner | Owner record |
| G0-6 | Owner/counsel have a plan to confirm each provider's terms before API-6 (PRD §21A P-9) | Owner record |

Leaving API-0 does **not** authorize API-1. API-1 needs its own authorization (OD-20).

## Dependencies of API-0 itself

None beyond the PRD. API-0 changes no code and depends on no pending order. Implementation dependencies are listed in [`dependencies-and-gates.md`](dependencies-and-gates.md).
