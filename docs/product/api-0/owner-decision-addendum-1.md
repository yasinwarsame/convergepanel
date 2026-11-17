# API-0 Owner Decision Addendum 1: Enterprise API v1 acceleration (2026-11-17)

| | |
|---|---|
| **Status** | Design amendment. It records owner rulings D1–D10 and the OQ-1..OQ-5 dispositions of 2026-11-17. **It authorizes no implementation stage by itself.** Each stage still needs its own authorization and release (OD-20, retained). |
| **Authority** | Product owner, "OWNER AUTHORIZATION — ENTERPRISE API V1 ACCELERATION AND FOUNDATION", 2026-11-17 |
| **Amends** | `../api-platform-prd.md` (Rev 3.2 → Rev 4), `dependencies-and-gates.md`, `openapi.yaml` (0.1.0-draft → 0.2.0-draft), `README.md` |
| **Does not rewrite** | OD-1..OD-21 (PRD §21) stay as ruled on 2026-11-03. This addendum states, for each one, whether it is **retained**, **narrowed**, **superseded** or **deferred**, and wins only where it says so. |
| **Baseline** | `main` at `cabbdbb` |
| **Planning targets** | Internal dark canary in late December 2026, controlled external beta in mid-to-late January 2027, Production API v1 around March 2027. These are conditional targets, not deployment authorizations. |

## 1. Owner rulings of 2026-11-17

| # | Ruling | Effect on the design |
|---|---|---|
| D1 | **Approved:** keep OD-2. | API organizations stay separate from Team Workspaces. No API key reads `workspaces/`, `teams/`, `runs/`, `verifications/` (web) or `users/` records in v1, and the API does not depend on TeamCP. An org↔workspace link is a future, separately designed stage. |
| D2 | **Approved:** supersede the **timing** in OD-20 and the current-queue dependency DEP-1. | Enterprise API work may start now, ahead of the governance queue. OD-20's requirement that every stage is separately authorized and released is **retained**. |
| D3 | **Scoped approval:** design the API secret configuration and prepare an isolated Order 6 environment-boundary correction. | Covers secret-only additions, with no general relaxation of Order 6. Design in `secret-boundary.md`, prepared on its own branch. No real credential, no environment change, no merge without a separate decision. |
| D4 | **Approved with conditions:** lean controlled beta. | Claim and research verification, polling, authorized history, cost controls, capped credits, manual invoicing. **No** synthesis, video, BYOK, MCP or broad automation. Stripe API subscriptions, outbound webhooks and SDKs may follow the beta. Deletion, retention, authorization and operational controls stay mandatory. Capabilities that are unavailable in beta are listed in §4 with the exact response a caller gets. |
| D5 | **Conditional:** the infrastructure principles stand (dedicated `api.convergepanel.com` data plane, Redis-class limiter and concurrency store, durable managed queue with Cloud Tasks fallback, managed KMS for webhook secrets, separate API tenancy and accounting). | **No vendor, account, secret or DNS record is provisioned** until the owner approves it with evidence (Phase 1D reports C and D). |
| D6 | **Conditional:** no claim of model-selection independence. | Auxiliary Gemini processing must be disclosed accurately. Before the external beta: a recorded customer acknowledgement plus compliant processing, or a routing path that respects customer restrictions. Fail closed when approved processing is unavailable (§5). |
| D7 | **Approved:** start the provider-terms, ToS and DPA review now. | Phase 1D report B is the counsel brief. Provider terms and customer terms are **external-beta blockers** (§6). |
| D8 | **Approved:** isolated Firebase environment E1–E7 and issue #321 are parallel security priorities. | API tenant-isolation and load testing need a genuinely isolated environment. #321 lands before broader Preview testing (§6). |
| D9 | **Approved:** add `GET /v1/verifications`. | Added to `openapi.yaml` (0.2.0-draft) with org/app scoping, cursor pagination and strict tenant isolation (§3). |
| D10 | **Resolved:** OQ-1..OQ-5 dispositions applied. | §7. |

Owner adjustments that bind every stage:

1. **The API does not depend on TeamCP.** API-1 never reads Team Workspace data through a machine credential.
2. **The financial safeguards are not relaxed.** Manual invoicing in the beta does not remove credit reservation, the internal cost ledger, hard caps, the platform spend ceiling, failed-job thresholds, full release for fully failed jobs, or ledger reconciliation. The beta must not allow uncontrolled provider spend.
3. **Gemini processing is a data-handling decision, not a footnote.** It is never shared silently (§5).
4. **Stage-gate changes are explicit.** The lean beta changes the API-0 sequence (Stripe before jobs; webhooks and SDKs before the pilot). Those changes are new owner decisions, recorded in §2 and in `dependencies-and-gates.md` §5. They are not done by quietly skipping old gates.

## 2. Reconciliation of OD-1..OD-21

| OD | 2026-11-03 ruling (short) | Status after Addendum 1 | What changes |
|---|---|---|---|
| OD-1 | Separate API plans; never in consumer subscriptions | **Retained, narrowed for the beta** | Beta plans are compile-time definitions in `lib/apiPlatform/apiPlans.ts` (**new**) with included credits and a hard cap, assigned to approved beta orgs by a reviewed PR. Invoicing is manual. Stripe API products follow the beta (API-2S). Consumer plans still grant no API entitlement, and API plans grant no consumer entitlement. |
| OD-2 | Separate API organizations | **Retained (D1)** | None. |
| OD-3 | Managed durable queue; Cloud Tasks fallback | **Retained (D5, conditional)** | Vendor choice needs the Phase 1D-C evidence and owner approval. |
| OD-4 | Dedicated `api.convergepanel.com` | **Retained (D5, conditional)** | Not attached until a separate approval. The internal dark canary uses no public host. |
| OD-5 | Redis-class store for rates, concurrency and pools; Firestore authoritative | **Retained (D5, conditional)** | Vendor choice needs the Phase 1D-D evidence and owner approval. |
| OD-6 | Pilot = Scenario A (included credits) | **Narrowed** | The controlled beta is Scenario A with capped included credits, **invoiced manually**. Metered overage (Scenario B) still needs separately approved unit costs. |
| OD-7 | Separate API Stripe webhook | **Retained, deferred** | Built with API-2S (after the beta). Until then no API Stripe object or webhook exists. |
| OD-8 | Failed jobs release credits; provider cost always recorded; cost-abuse controls | **Retained, mandatory in the beta** (adjustment 2) | None. |
| OD-9 | Claim-level trust `unavailable` | **Retained** | None. |
| OD-10 | Four data classes; 30-day pilot default | **Retained, narrowed by OQ-4** | `retain_input` is **unavailable in the beta** (`422 option_unavailable_in_beta`). Class (a) is always deleted at the terminal state. |
| OD-11 | Data-plane deletion | **Retained, in the beta** | `DELETE /v1/verifications/{id}` ships **in** the beta, with full class (a)/(b)/(d) deletion and tombstones. It is not deferred. |
| OD-12 | Managed KMS for webhook secrets | **Retained, deferred** | Webhooks follow the beta, so no KMS key is needed for the beta. |
| OD-13 | Operator access metadata-only, audited | **Retained** | None. |
| OD-14 | Video deferred | **Retained** | None. |
| OD-15 | BYOK deferred | **Retained** | None. |
| OD-16 | MCP post-launch | **Retained** | None. |
| OD-17 | Secret scanning before GA | **Retained** | Registration for `cpk_` before Production v1. |
| OD-18 | Sentry + structured logging first | **Retained** | None. |
| OD-19 | Full model responses opt-in, default off | **Retained** (beta narrowing is **proposal P3**, §4.1, awaiting confirmation) | If P3 is confirmed, full model text is unavailable in the beta (`retain_model_responses: true` → `422 option_unavailable_in_beta`; `include=response_text` → `section.availability: not_requested`). |
| OD-20 | API-0 may begin; implementation later, each stage separately authorized | **Timing superseded (D2); authorization rule retained** | API-1 no longer waits for the governance queue. Every stage still needs its own authorization, review and protected release. |
| OD-21 | Compile-time switches; runtime config only after an Order 6 boundary change | **Retained, narrowed by D3 / OQ-1** | Only a **secret-only** boundary correction is in scope (`secret-boundary.md`). Switches, limits, the rate card and beta plans stay compile-time modules. |

CR-1 (model consensus is not factual verification) and CR-2 (API usage must not degrade Individual Research or Team Workspaces) are **retained in full**. CR-2's web-capacity protection gate (`dependencies-and-gates.md` §2) still has to pass before any live API traffic reaches a provider.

## 3. Contract change: authorized history (D9)

`GET /v1/verifications` (scope `verifications:read`):

- **Scoping.** Always the authenticated key's organization **and the key's mode**: a test key lists only test verifications and a live key only live ones (`tenancy-and-auth.md` §5 rule 4). An app-scoped key (the default, `tenancy-and-auth.md` §1) lists only its own application's verifications. `application_id` can narrow an org-wide key's results and can never widen an app-scoped key's. An application ID the key cannot see, whether it is a sibling application, another organization's or nonexistent, yields a byte-identical empty page with the same timing class, never `403`, so existence cannot be probed.
- **Pagination.** Order is `created_at` descending, then `id` descending. `limit` is 1–100 (default 20). The opaque `next_cursor` carries `(cursorVersion, orgId, effective application scope, mode, filter set, position, expiresAt)` under an HMAC tag (subkey `cp-api/list-cursor/v1`). It expires **24 hours** after issue. A cursor that has expired, has been tampered with, or is replayed under a different organization, application scope, mode or filter set is rejected with `400 invalid_cursor`.
- **Filters.** `status` (known public `JobStatus` values; an unknown value returns `400 invalid_request_error`, code `invalid_status`), `type`, `application_id`, `created_gte`, `created_lt`.
- **Payload.** `VerificationSummary` only: no input text, no result sections, no model text. Deleted verifications are not listed.
- **Index.** `apiOrganizations/{orgId}/verifications` composites, each ending `createdAt` desc, `id` desc: (`mode`), (`mode`,`appId`), (`mode`,`status`), (`mode`,`type`), (`mode`,`appId`,`status`), (`mode`,`appId`,`type`), (`mode`,`status`,`type`), (`mode`,`appId`,`status`,`type`). The exact set is pinned by an index-coverage test against `firestore.indexes.json` in API-3; no reliance on index merging. Added to PRD §12.2 and deployed one at a time.
- **Tests** (added to `threat-model.md` §6 as T-X2): a cross-org `application_id` returns empty; an app-scoped key cannot list sibling apps (byte-identical empty response for sibling and nonexistent IDs); a test key never lists live verifications and a live key never lists test ones; cursor tamper, expiry and replay under another org, app scope, mode or filter set are rejected; no summary contains input or model text; pagination is stable under concurrent creates.

## 4. Controlled beta scope (D4)

| Capability | In the beta? | Caller-visible behaviour if unavailable | Contract/terms note |
|---|---|---|---|
| `type: claim` | **Yes** | — | — |
| `type: research` | **Yes**, only for orgs that satisfy §5 | `403 pipeline_processing_not_acknowledged` | Gemini disclosed as a pipeline provider |
| Polling: `GET /v1/verifications/{id}`, `/report`, compact `/models` | **Yes** | — | — |
| `GET /v1/verifications` (history) | **Yes** | — | — |
| `POST /v1/verifications/{id}/cancel` | **Yes** | — | — |
| `DELETE /v1/verifications/{id}` | **Yes** (OD-11) | — | Deletion SLA stated in the beta agreement |
| `GET /v1/usage`, `GET /v1/models` | **Yes** | — | — |
| Idempotency, rate limits, concurrency limits, request IDs, error envelope | **Yes** | — | — |
| Reservation, settlement, release, internal cost ledger, hard cap, platform spend ceiling, failed-job thresholds, reconciliation | **Yes, mandatory** | `402` / `403` / `503` per PRD §9.5 | Manual invoices are generated **from the ledger** |
| Sandbox (test keys, fixture results, $0 provider spend) | **Yes** | — | — |
| Sync wait (`Prefer: wait=60`) | No (**proposal P1**, §4.1) | Header ignored; normal `202` | Documented as unavailable |
| Synthesis (`options.synthesis`) | No | `422 synthesis_unavailable` | Documented as unavailable |
| Provider fallback (`options.allow_fallback`) | No (**proposal P2**, §4.1) | `422 fallback_unavailable` | No fallback provider receives beta content |
| `retain_input` | No (OQ-4) | `422 option_unavailable_in_beta` | Inputs always deleted at the terminal state |
| Full model text (`retain_model_responses`, `include=response_text`) | No (**proposal P3**, §4.1) | `422 option_unavailable_in_beta` / section `not_requested` | Compact results only |
| Outbound webhooks | No | Not offered; no endpoint configuration | Polling documented as the integration method |
| SDKs | No | — | OpenAPI + curl/TS/Python HTTP examples only |
| Stripe API subscriptions, self-serve signup | No | Orgs approved manually; live keys only for approved orgs | Manual invoicing terms in the beta agreement |
| Video, BYOK, MCP, batch, multi-step automation | No | `400 invalid_request_error` (unknown `type`/field) | Out of scope |
| Org invites beyond a single owner | No (**proposal P4**, §4.1) | Management UI does not offer invites | Added before Production v1 |
| SLA | No | — | Beta agreement states no SLA |

### 4.1 Engineering proposals awaiting owner confirmation

D4 names exactly what the beta excludes: synthesis, video, BYOK, MCP and broad automation. OQ-4 adds `retain_input`. The four exclusions below go further. They are **engineering proposals, not owner rulings**. Each stays in effect for design purposes only until the owner confirms or rejects it. If one is rejected, its capability returns to the beta scope with its original API-0 controls.

| # | Proposal | Rationale |
|---|---|---|
| P1 | No sync wait in the beta | Polling is the ruled integration method. Sync wait holds an HTTP request open against the queue and adds a second completion path to test |
| P2 | No provider fallback (`allow_fallback`) in the beta | DeepSeek has no Production configuration today, and its terms are unresolved (Phase 1D-B). The Claude synthesis fallback is synthesis-only, which is excluded. With fallback off, beta content reaches only selected providers plus the acknowledged pipeline provider |
| P3 | No full model text (OD-19 opt-in) in the beta | Keeps the beta to compact results while customer terms (D7) and retention maxima (OQ-3) are open. OD-19 itself is unchanged |
| P4 | Single-owner beta orgs, with no member invites | Fewer authorization paths in the first release. The invite flow (`tenancy-and-auth.md` §2.1) is still built before Production v1 |

## 5. Data handling and provider disclosure (D6)

**Fact (DEP-15).** Research jobs call Gemini for classification and for several auxiliary pipeline steps, whichever models the customer selects. Claim jobs call Gemini only when Gemini is a selected model.

**Beta controls:**

1. **Disclosure.** `GET /v1/models` lists `pipeline_providers` per type (research: `google_gemini`). The docs, the beta agreement and the subprocessor list say plainly that research questions are sent to Google Gemini for pipeline processing. No document, UI string or sales material claims that model selection controls every provider that receives content.
2. **Acknowledgement.** An org setting `pipelineProcessingAcknowledgement` = `{ providers: ["google_gemini"], disclosureVersion, acknowledgedBy, acknowledgedAt }`. An owner or admin records it with a fresh session (`auth_time` ≤ 15 min), and it is audited (`org.pipeline_processing_acknowledged` / `…_withdrawn`). It is recorded per disclosure version, so a new disclosure version needs a new acknowledgement.
3. **Fail closed.** A research create from an org without a current acknowledgement returns `403 pipeline_processing_not_acknowledged` before any write or provider call. The acknowledgement is **re-checked at every worker step start**, with the same semantics as the hard-state checks (`ledger-and-billing.md` §4). Withdrawing it stops new creates at once. A job that has not started its panel step is canceled with a full release. A job past its panel step makes no further Gemini call: it finalizes with the work done, settled, and any remaining auxiliary section is marked `failed` with reason `pipeline_processing_withdrawn`.
4. **Unavailable processing.** If Gemini is unavailable or not confirmed under §6 (P-9), research returns `422 type_unavailable` and nothing is sent elsewhere. No alternative pipeline provider is substituted silently.
5. **Alternative routing** (an auxiliary provider that respects the selection) stays a separately authorized change to the shared web pipeline. Until it ships, the acknowledgement path is the only compliant route for research.
6. **Fallback providers** (DeepSeek, Claude synthesis): if proposal P2 is confirmed, they are unreachable in the beta (§4), so beta content never reaches a provider that is neither selected nor acknowledged. If P2 is rejected, fallback stays a per-request customer opt-in (`allow_fallback`, never silent), and B-6 then requires confirmed terms for every fallback provider it can reach.

## 6. Controlled beta (pilot) acceptance requirements

These replace the API-6 **entry** criteria for the controlled beta. API-6's 30-day **exit** evidence becomes the Production v1 entry gate (`dependencies-and-gates.md` §5).

| # | Requirement | Evidence |
|---|---|---|
| B-1 | API-1, API-2β, API-3, API-4β and API-5β released dark, each independently reviewed CLEAN, with exact-head records | PR records |
| B-2 | Web-capacity protection gate WG-1..WG-7 passed in the isolated environment, **and** B-11 met, **before** any Production canary sends live traffic to a provider. Then re-checked with that canary traffic | Load-test report; B-11 record; canary record |
| B-3 | Isolated Firebase environment (E1–E7) complete and #321 merged | Owner record; #321 closure |
| B-4 | Tenant-isolation suite (identity, data, list, cursor, deletion) green against the isolated environment | Test report |
| B-5 | Ledger acceptance plan passed: reserve/settle/release math, settle ≤ reserve, parallel creates vs hard cap, platform spend ceiling, failed-job thresholds, estimated cost never 0, reconciliation zero drift, invoice export from the ledger | Phase 1D-F plan, results |
| B-6 | Provider terms confirmed by owner/counsel for every provider that can receive beta content (the selectable `CONNECTOR_MAP` providers and Gemini as pipeline provider, plus any fallback provider reachable under the P2 disposition). An unconfirmed provider is `unavailable` in `/v1/models` | Counsel record |
| B-7 | Beta agreement, API ToS, DPA, AUP, subprocessor list and retention statement approved, reflecting §4 and §5, **including counsel's decision on maximum class (c) and (d) retention (OQ-3)** | Counsel record |
| B-8 | D6 acknowledgement implemented and tested; every beta org that runs research has a current acknowledgement | Tests; org records |
| B-9 | Secret boundary merged by separate decision; real secrets provisioned only for the approved environments | Owner record |
| B-10 | Infrastructure (queue, Redis-class store, API host) approved and provisioned by separate decisions | Owner records |
| B-11 | Provider capacity, contractual permissions and rate limits evaluated (OQ-2), and the shared provider keys shown sufficient or separate credentials approved. Provider concurrency limits measured and `api_share` set (≤ 40 %) from measurements, not assumed (OQ-5). **Also a gate for API-3 live provider execution of any job type** (`dependencies-and-gates.md` §5.2) | Phase 1D-E report + measurements; owner record |
| B-12 | Runbooks for key compromise, spend-ceiling trip, queue outage, provider outage and org suspension; on-call owner named. **Manual-invoice non-payment path:** with no Stripe in the beta, an unpaid invoice past its due date plus grace leads the owner to set org `status: suspended` through a SYSTEM_ADMIN management action (audited `org.suspended`, reason `manual_invoice_unpaid`). That has the same effect as a Stripe `past_due` suspension (`ledger-and-billing.md` §4): creates `403 org_suspended`, queued jobs canceled with release, reads for 30 days | Runbooks; management action + test |
| B-13 | Each beta org approved by the owner, with a manual plan assignment PR and a named contact | Approval records |
| B-14 | Owner disposition recorded for proposals P1–P4 (§4.1); the beta contract, docs and B-6 terms scope match the dispositions | Owner record |

## 7. Open questions: dispositions (D10)

| OQ | Disposition |
|---|---|
| OQ-1 | **Approved, narrowly:** a secret-only Order 6 environment-boundary amendment, independently reviewed, merged only by separate authorization. Design: `secret-boundary.md`. |
| OQ-2 | **Deferred** until provider capacity, contractual permissions and rate limits are evaluated, before API-3 live execution. Shared provider keys are not automatically sufficient: B-11 must show the shared keys can carry the API share without web regression, or separate credentials are proposed. |
| OQ-3 | **Counsel decides** maximum class (c) and (d) retention before the external beta. The 7-year figures stay placeholders. |
| OQ-4 | **Default OFF**, and `retain_input` is **unavailable** in the initial beta until customer terms and deletion controls are verified. |
| OQ-5 | **Start conservative**: `api_share` ≤ 40 %. Actual limits come from measured capacity (Phase 1D-E) before any external traffic. |

## 8. Infrastructure dependency matrix

| Dependency | Needed by | Approval needed before | Evidence | Status |
|---|---|---|---|---|
| Secret boundary (pepper, cursor key) | API-1 secret-dependent paths | merge of the boundary branch | `secret-boundary.md`, branch review | Draft (Phase 1B) |
| Isolated Firebase project (E1–E7) | API-1 integration tests (emulator suffices for unit/rules), API-3 load and isolation | API-3 | Phase 1D-A | Owner steps pending |
| #321 Layer B in the Vercel build | Broader Preview testing | API-3 Preview tests | Phase 1D-A | Open |
| Redis-class store | API-1 rate limits (beta orgs can start on the existing Firestore limiter with documented caps), API-3 pools | API-3 | Phase 1D-D | Not selected |
| Durable queue (+ Cloud Tasks fallback) | API-3 | API-3 | Phase 1D-C | Not selected |
| Vercel execution limits | API-3 step budgets | API-3 | Phase 1D-E | To measure |
| Provider rate limits / web baseline (DEP-9) | WG-6, B-11 | API-3 live canary | Phase 1D-E | To measure |
| `api.convergepanel.com` | External beta | B-10 | Owner (DNS/TLS) | Not provisioned |
| Managed KMS | Webhooks (post-beta) | API-5W | — | Deferred |
| API Stripe products + webhook | API-2S (post-beta) | API-2S | — | Deferred |
| Provider terms, ToS, DPA | External beta | B-6, B-7 | Phase 1D-B | Review starting |

## 9. Implementation sequence (amended)

Each item is its own PR, authorization, independent review and protected dark release.

| Order | Stage | Scope | In beta? |
|---|---|---|---|
| 0 | Secret boundary | `secret-boundary.md` implementation (separate merge decision). API-1 work may start with the pepper **injected**; the boundary must be approved and merged before any secret-dependent path runs outside tests (`dependencies-and-gates.md` §5.2) | prerequisite for secret-dependent paths |
| 1 | **API-1a** | Core (all **new** under `lib/apiPlatform/`): IDs, key format, peppered verifier (pepper injected), org/app/key/membership records, deny-all rules + tests, `requireApiPrincipal` (**new**), error envelope, request IDs, transactional audit events | yes |
| 2 | **API-1b** | Session-only management routes (org, app, key create/rotate/revoke, D6 acknowledgement), minimal developer UI, `GET /v1/models` | yes |
| 3 | **API-2β** | Customer ledger (reserve/settle/release/adjust), period counters, compile-time beta plans, hard caps, spend ceiling, internal cost ledger, failed-job thresholds, reconciliation job, ledger-derived invoice export, `GET /v1/usage` | yes |
| 4 | API-3 PR A | Provider-call instrumentation + real cancellation of timed-out provider calls, behaviour-equivalent for web | yes |
| 5 | API-3 PR B | Execution ports on `executeOrdinaryRun`, behaviour-equivalent for web | yes |
| 6 | API-3 claim extraction | `executeClaimVerification` (**new**, extracted from `app/api/verify-claim/route.ts`), behaviour-equivalent for web | yes |
| 7 | **API-3 jobs** | Outbox create, idempotency, queue, worker, leases, step-start checks, per-call records, sweeper; POST, GET, **list**, cancel, **DELETE**; sandbox | yes |
| 8 | CR-2 | Pools, queue caps, shedding, web SLO monitoring, load test (isolated) | yes |
| 9 | **API-4β** | Result projection, CR-1 fields, `/report`, compact `/models`, parity tests (no synthesis, no full text) | yes |
| 10 | **API-5β** | Published OpenAPI, docs (methodology + consensus-vs-verification + Gemini disclosure), HTTP examples, quickstart | yes |
| 11 | API-6β | Controlled beta under §6 | beta |
| 12 | API-2S | Stripe API products, org customer, separate API webhook (OD-7) | post-beta |
| 13 | API-5W | Webhooks (KMS, SSRF guard, dispatcher) | post-beta |
| 14 | API-5S | SDKs; synthesis extraction + opt-in synthesis; invites | post-beta |
| 15 | API-7 | Production v1: secret scanning, runbooks, status page, deprecation policy, ≥ 30 days of beta evidence | Production |

**No live job of any type, claim or research, sends traffic to a provider** until the queue, cost ledger, cancellation, idempotency and capacity-protection mechanisms are verified (items 3–8), the web-capacity gate WG-1..WG-7 has passed, and B-11 (OQ-2, OQ-5) is met.
