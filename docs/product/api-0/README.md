# API-0 — Verification API architecture and contract design

| | |
|---|---|
| **Status** | **API-0 design only.** Authorized by owner ruling OD-20 (2026-11-03). Documents only. |
| **Not authorized** | API-1 to API-7. No routes, code, credentials, Stripe products, workers, queues, KMS keys, DNS, environment variables or configuration may be created on the strength of these documents. |
| **Parent document** | [`../api-platform-prd.md`](../api-platform-prd.md) (Rev 2, owner rulings 2026-11-03) |
| **Baseline** | `main` at `2f70d1f` |

Where this set and the PRD disagree, the PRD's §21 rulings win and the disagreement is a defect to fix in this set.

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

## Fixed positions this set inherits from the PRD

1. **No second engine.** Every verdict, score, consensus, disagreement and synthesis comes from the existing web pipeline (`lib/runPanelExecution.ts`, `lib/adaptiveSchema/*`, `lib/verification/*`, `lib/synthesis/*`). The API re-serializes; it never re-scores and never invents.
2. **CR-1.** Model consensus is not factual verification. Every rated section carries machine-readable `methodology` and `limitations`.
3. **CR-2.** API usage must not degrade Individual Research or Team Workspaces. Protection lives entirely on the API side.
4. **First release** covers claim and research verification only. Video (OD-14), BYOK (OD-15), MCP (OD-16) and complex automation come later.
5. **Gemini** failures (owner-side Google billing) are shown as `failed` slots with a limitation. No configuration change.
6. **Tenant isolation** by construction: every data-plane path is derived from the authenticated key's `orgId`.
7. **Bounded spend.** Every job is pre-authorized against a hard cap; one authoritative customer ledger; an internal cost ledger records every provider call.
8. **OD-21.** Dark releases use compile-time switches; `lib/env.ts` is byte-pinned by Order 6 suites, so new secrets need a separately approved Order 6 boundary change.

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
