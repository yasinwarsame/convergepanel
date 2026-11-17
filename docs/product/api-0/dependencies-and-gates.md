# Dependencies and gates (API-0)

**Status:** design. Each stage API-1..API-7 is **separately authorized** by the owner, has its own tests, an **independent review** (fresh reviewer per round, no author context), and a **protected release** (branch protection, CI green, post-merge check, ships dark behind a compile-time switch per OD-21). No stage authorizes the next. No stage changes existing routes' behaviour except the mechanical API-3 extractions, which are proven equivalent.

## 1. Implementation dependencies

| ID | Dependency | Needed by | Owner / source | Status |
|---|---|---|---|---|
| DEP-1 | Current queue stable: report-review activation safeguards (Orders A/B), authenticated Production acceptance of recent research PRs, C1–C3 project reviewer items | API-1 | Owner (PRD §0) | **Superseded** by Addendum 1 D2 (2026-11-17): API work no longer waits for this queue |
| DEP-2 | **Order 6 boundary change** approved so new secrets can be read through `lib/env.ts` (byte-pinned by Order 6 suites): `API_KEY_PEPPER` (+ `_PREVIOUS`), Redis-class store credentials, queue credentials, API Stripe webhook secret, KMS fallback key if needed | API-1 (pepper), API-2, API-3, API-5 | Owner (OD-21; OQ-1) | **Narrowed** by Addendum 1 D3/OQ-1: secret-only boundary, design `secret-boundary.md` (no `lib/env.ts` change in the recommended design); merge by separate decision |
| DEP-3 | Dedicated host `api.convergepanel.com` (DNS, TLS, attachment method decided in API-1 design) | API-1 | Owner (OD-4) | Ruled, not provisioned |
| DEP-4 | Redis-class store vendor selected and provisioned (separately authorized) | API-1 (rate limits), API-3 (pools) | Owner (OD-5) | Ruled, not selected |
| DEP-5 | Managed durable queue confirmed available on the account/plan; else Google Cloud Tasks | API-3 | Owner (OD-3) | Ruled, not confirmed |
| DEP-6 | New API Stripe products/prices and the separate webhook endpoint secret (separately authorized Stripe change) | API-2 | Owner (OD-1, OD-6, OD-7) | Not started |
| DEP-7 | Managed KMS key for webhook secrets (separately authorized) | API-5 | Owner (OD-12) | Not started |
| DEP-8 | Vercel function duration and concurrency limits confirmed for step budgets | API-3 | Engineering | Open |
| DEP-9 | Web baseline measured (p95 latency, error rate, provider-limit errors on web routes) | Web-capacity gate (API-3) | Engineering (OD-18 tools) | Not started |
| DEP-10 | Provider terms confirmed for each provider that can receive customer content: every `CONNECTOR_MAP` provider, the pipeline providers (Gemini auxiliary for research, OpenAI synthesis) and the fallback providers (DeepSeek, Claude synthesis fallback) | API-6 | Owner + counsel (PRD §21A P-9) | Not started |
| DEP-11 | API ToS, DPA, acceptable-use policy, subprocessor list, backup-retention statement | API-6 | Owner + counsel | Not started |
| DEP-12 | Non-Production Firebase project for load and isolation tests (no test records in Production governance data) | API-3 load test | Owner | Open (known infra gap) |
| DEP-13 | Secret-scanning registration for `cpk_` | API-7 | Owner (OD-17) | Not started |
| DEP-14 | Metrics backend decision from pilot load | API-7 | Owner (OD-18) | Deferred by ruling |
| DEP-15 | **Model-selection independence (owner-recorded dependency A, 2026-11-03).** Research classification (`classifyQuery`) and the other auxiliary pipeline calls send the question to Gemini whatever models the customer selected (threat model R7). This must be **corrected** (an auxiliary provider that respects the selection) **or deliberately constrained** (no such claim is made, and Gemini is disclosed as a pipeline provider for every research job, per DEP-10) before the API, its documentation or its sales material claims that a customer's model selection controls which providers receive their content. API-0 does **not** change Gemini routing | Any external claim of model-selection independence; API-6 at the latest | Owner (separate decision; it changes the shared web pipeline) | Open |
| DEP-16 | **Secret-management design (owner-recorded dependency B, 2026-11-03).** API-1 secrets (DEP-2) must respect the frozen Order 6 environment boundary. They need a **separately approved configuration design** that names each secret, where it is read, and how the Order 6 evidence is re-baselined. API-0 does **not** change `lib/env.ts`, and no secret is created before that approval | API-1 | Owner (OD-21; OQ-1) | **Design approved** (`secret-boundary.md`, Addendum 1 D3 and §1.1 SB). Implementation merges only by a separate owner decision, through its own release gate; no secret is created by that approval |

## 2. Web-capacity protection gate (CR-2)

**Must pass before any live API traffic reaches a provider** (first relevant at the API-3 canary) and is re-checked at API-6 and API-7.

| # | Criterion | Evidence |
|---|---|---|
| WG-1 | API-only per-provider concurrency pools live, sized `api_share × provider_capacity` (placeholder 40 %), permit sets acquired all-or-nothing per step with TTL, yields capped (`MAX_YIELDS_PER_JOB`) | Unit + integration tests; config review |
| WG-2 | Global and per-org queue depth ceilings enforced (`429` / `503 capacity_protection`) | Boundary tests |
| WG-3 | API daily provider-spend ceiling and failed-job cost thresholds enforced from the internal cost ledger | Tests T-L6 |
| WG-4 | Load-shedding order implemented and tested: synthesis + research → claims → pause at step boundary → shrink `api_share`; web never shed | Failure-injection test |
| WG-5 | Web SLO monitoring live (Sentry + structured `logger` fields), alerts wired, baseline (DEP-9) recorded | Dashboard / alert drill |
| WG-6 | Load test in the non-Production project: synthetic web traffic at observed peak + saturating API traffic → web p95 regression ≤ 10 % (placeholder) and no increase in provider-limit errors on web calls | Load-test report |
| WG-7 | Web route suites unmodified and green | CI |

## 3. Stage gates

### API-1 — Customer identity and API authentication
- **Scope:** orgs, memberships, applications, key create/rotate/revoke (management plane, session-only); key verifier; scopes; `GET /v1/models`; audit events; Firestore deny-all rules for `api*`; API host attachment.
- **Entry:** separate authorization; API-0 exit gates G0-1..G0-6 (`README.md`); DEP-1, DEP-2, DEP-3, DEP-4.
- **Exit:** live in Production dark; canary org authenticates; revocation immediate; isolation suite (identity level) green; mutation tests kill every mutant of verifier, scope guard, capability guard; independent review CLEAN.
- **Tests:** T-M1..T-M6, T-D1, T-D7, T-L1, T-X1 (`threat-model.md` §6).

### API-2 — Subscription and usage enforcement
- **Scope:** API plans module, org Stripe customer, separate API Stripe webhook (OD-7), customer ledger, internal cost ledger (OD-8), reservations, hard caps, spend limits, cost-abuse thresholds, suspension, `GET /v1/usage`.
- **Entry:** API-1 released; separate Stripe change authorization (DEP-6).
- **Exit:** canary ledger reconciles with zero drift; caps hold under parallel creates; Stripe event dedup proven; existing `/api/stripe/webhook` untouched (diff-proof); independent review CLEAN.
- **Tests:** T-L2..T-L6; Stripe event replay and ordering; read-failure-vs-absence cases.

### API-3 — Verification job submission and retrieval
- **Scope:** behaviour-equivalent PRs, each its own PR and review, in this order: **PR A** provider-call instrumentation (`ProviderCallHooks`: per-call observer, permit/replay hook, `allowFallback`; PRD §6.5); **PR B** execution ports on `executeOrdinaryRun` (persistence, usage accounting, analytics, governance mode, diagnostics; PRD §6.1); then the claim and synthesis extractions (`lib/verification/executeClaimVerification.ts`, `lib/synthesis/executeSynthesis.ts`). After those: transactional-outbox create, sweeper, queue, worker, leases, step-start checks, all-or-nothing permits with yield cap, per-call records; CR-2 controls; `POST/GET /v1/verifications`, cancel, `DELETE`; idempotency; class (a) deletion; sandbox fixtures; `lib/apiPlatform/resultSchema.ts` (verdict-level projection).
- **Entry:** API-2 released; DEP-5, DEP-8, DEP-12.
- **Exit:** existing route suites pass **unmodified** after each of PR A, PR B and the extractions, with golden diffs and spy equivalence (connector call sequence for PR A; Firestore/PostHog/log for PR B); T-W4 API-mode spy test green and mutation-proven per side-effect row; **web-capacity protection gate (§2) passed** before live provider traffic; canary jobs reach terminal states; sandbox spends $0 (connector spies); independent review CLEAN per PR.
- **Tests:** T-D2..T-D6, T-W1..T-W5, T-P2, T-P3, T-C1, idempotency races, deletion completeness.

### API-4 — Structured verdict, rating and synthesis output
- **Scope:** full projection (`/report`, compact `/models`, OD-19 opt-in text), all availability states, CR-1 methodology descriptors and limitations, synthesis step, class (d) evidence.
- **Entry:** API-3 released.
- **Exit:** every availability state covered by fixtures; property tests show no fabricated values (no section `completed` without source data, no `0` standing in for missing); no result validates without CR-1 fields; OD-19 four-condition matrix green; Zod ↔ JSON Schema ↔ OpenAPI parity test green; independent review CLEAN.
- **Tests:** contract goldens per `format_version`; injection corpus; T-D5; T-P1.

### API-5 — Webhooks, SDKs and documentation
- **Scope:** webhook endpoints, outbox dispatcher, KMS-backed signing (OD-12), SSRF guard; TypeScript and Python SDKs (open enums, idempotency helper, `waitForCompletion`, webhook verifier); published OpenAPI; docs site including methodology pages and the consensus-vs-verification concept page; dashboard completion.
- **Entry:** API-4 released; DEP-7.
- **Exit:** an external developer completes the quickstart (D1–D5 in `developer-journeys.md`) unaided in under 10 minutes; SDK contract tests against the OpenAPI; independent review CLEAN.
- **Tests:** T-H1..T-H5; SDK unknown-enum tolerance.

### API-6 — Controlled customer pilot
- **Scope:** 3–5 manually approved design partners, Scenario A only (OD-6), tight caps, 30-day retention default.
- **Entry:** API-5 released; DEP-10, DEP-11; web-capacity gate re-checked in Production with canary traffic.
- **Exit (after ≥ 30 days):** zero isolation defects; ≥ 99 % of jobs terminal, none stuck > 15 min; unit costs measured (pricing doc §2 list); provider invoice reconciliation; zero web SLO breaches attributable to API; cost-abuse controls exercised in a drill; independent review of pilot evidence CLEAN.
- **Tests:** Production acceptance with a dedicated canary org; alert drills; **no test records in Production governance data**.

### API-7 — General availability and operational monitoring
- **Scope:** self-serve signup, on-call runbooks, status page, published deprecation policy, secret scanning (OD-17), metrics backend chosen (OD-18). Scenario B **only** if separately approved from measured unit costs (OD-6).
- **Entry:** API-6 exit; DEP-13, DEP-14.
- **Exit:** SLO dashboards (API and web) live; runbooks and rollback rehearsed; backup-restore with tombstone replay rehearsed; security review CLEAN.
- **Tests:** load tests at GA targets; rollback rehearsal; restore rehearsal.

## 4. Open questions (need owner answer or explicit deferral before leaving API-0)

| ID | Question | Why it matters | Proposed answer |
|---|---|---|---|
| OQ-1 | Does the Order 6 boundary change (OD-21) cover adding **secret-only** entries to `lib/env.ts`? Secrets cannot be compile-time switches | Blocks API-1 | Yes: one boundary change that adds API secrets only, with Order 6 evidence re-baselined in the same authorized change |
| OQ-2 | Should API traffic use **separate provider credentials** (independent provider limits) for stronger CR-2 isolation? | Changes provider accounts and `appConfig/modelKeys` handling | Evaluate per provider before API-3; keep shared credentials + pools as the baseline |
| OQ-3 | Maximum retention for class (c) billing records and class (d) evidence (7-year placeholders) | Customer terms, DPA | Counsel to confirm before API-6 |
| OQ-4 | Is `retain_input` (keeping raw input with results) offered in the pilot, or held back until terms are reviewed? | Data minimization vs customer convenience | Offer, default off, org may forbid |
| OQ-5 | Default `api_share` of provider capacity and web SLO thresholds | CR-2 sizing | Set from DEP-9 baseline; start conservative (≤ 40 %) |

## 5. Addendum 1 amendments (owner, 2026-11-17)

Source: `owner-decision-addendum-1.md`. Sections 1–4 above are the 2026-11-03 record and stay as written; this section states what now applies. It changes gates explicitly (owner adjustment 4); it does not skip them.

### 5.1 Dependency changes
| ID | Change |
|---|---|
| DEP-1 | Superseded (D2). |
| DEP-2, DEP-16 | Narrowed to a secret-only boundary (D3, OQ-1); `secret-boundary.md`. |
| DEP-3 (API host) | Needed for the **external** beta, not for API-1. The internal dark canary uses no public host. |
| DEP-4 (Redis-class store) | Needed by API-3 (provider pools and rate windows; *Addendum 5:* job-admission concurrency is Firestore-transactional and does not need it). API-1/API-2β may use the existing fail-closed Firestore limiter at beta volumes. Vendor needs Phase 1D-D evidence and owner approval (D5). If the Firestore limiter is used, API identifiers live in a separate `api_rate_limits` collection (never the web `rate_limits` documents), so API traffic cannot contend with web limiter documents (CR-2). |
| DEP-5 (queue) | Needed by API-3. Phase 1D-C evidence and owner approval (D5). Vercel Queues is approved for an isolated feasibility evaluation only (Addendum 1 §1.1 Q); the same-message-ID re-dispatch defect (`jobs-and-idempotency.md` §2 step 4) is resolved before API-3. |
| DEP-6 (Stripe API products) | Deferred to API-2S, after the beta. |
| DEP-7 (KMS) | Deferred to API-5W, after the beta. |
| DEP-10, DEP-11 | External-beta blockers (B-6, B-7); review starts now (D7). |
| DEP-12 | Isolated Firebase environment E1–E7 (D8): a parallel priority, required before API-3 load and isolation suites. |
| DEP-15 | Controlled by Addendum 1 §5 (disclose, acknowledge per org, fail closed). |
| DEP-17 (new) | Issue #321 (Layer B build-artifact check inside Vercel builds) merged before broader Preview testing of API branches (D8). |

### 5.2 Stage gate changes
| Stage | Was | Now |
|---|---|---|
| API-1 | Entry: DEP-1..DEP-4 | Entry: Addendum 1 independently reviewed CLEAN; secret boundary approved before any secret-dependent path runs (verifier takes the pepper by injection until then); emulator/isolated resources for integration tests; no Production flow change; no exposed host or live credential. Exit unchanged, except "live in Production dark" happens only by a separate release decision. |
| API-2 → **API-2β** | Stripe products, org customer, separate webhook, ledger | **API-2β:** ledger, reservations, settlement, release, internal cost ledger, hard caps, spend ceiling, failed-job thresholds, suspension, reconciliation, ledger-derived invoice export, compile-time beta plans. No Stripe object. Exit: Phase 1D-F ledger acceptance plan green; reconciliation zero drift in the isolated environment. |
| **API-2S** (new, post-beta) | — | The original API-2 Stripe scope (DEP-6, OD-7). Entry: beta running; consumer end-to-end signed-webhook reconciliation proven. |
| API-3 | Entry: API-2 released | Entry: **API-2β** released; **DEP-4 (D5-approved Redis-class store)**, DEP-5, DEP-8, DEP-12; DEP-17 for Preview tests; **the replacement-dispatch fix (no job stuck behind a suppressed duplicate dispatch) proven, and an authenticated scheduler boundary (`CRON_SECRET` decision or managed queue/scheduler identity, no unauthenticated sweeper route) approved** (Addendum 1 §1.1 Q, S). Scope adds `GET /v1/verifications` (list) and `DELETE` in the beta. **Live provider execution of any job type (claim or research), including any Production canary,** additionally requires the web-capacity gate WG-1..WG-7 **and** Addendum 1 B-11 (OQ-2 provider capacity/contract/rate-limit evaluation; OQ-5 measured `api_share` ≤ 40 %). Until then, jobs run only in sandbox (fixtures, $0 provider spend). The **synthesis extraction** (`executeSynthesis`) moves out of API-3 to API-5S (post-beta). |
| API-4 → **API-4β** | Full projection incl. synthesis and opt-in full text | Projection without synthesis and without full model text (both `422`/`not_requested` in the beta). All availability states, CR-1 fields and parity tests are still required. |
| API-5 → **API-5β** | Webhooks, KMS, SDKs, docs | **API-5β:** published OpenAPI, docs (methodology, consensus vs verification, Gemini disclosure), HTTP examples, quickstart. Webhooks → **API-5W**, SDKs → **API-5S** (post-beta). |
| API-6 → **API-6β** | Entry: API-5, DEP-10, DEP-11 | **API-6β (controlled beta):** entry = Addendum 1 §6 B-1..B-14. Its ≥ 30-day evidence (zero isolation defects, ≥ 99 % terminal, unit costs measured, no web SLO breach) is the **Production v1 entry gate**. |
| API-7 | Entry: API-6 exit | Entry: API-6β evidence; API-2S, API-5W, API-5S released; DEP-13, DEP-14. |

### 5.3 API-0 exit gates (README) after Addendum 1
- G0-5 (open questions): **satisfied** by Addendum 1 §7 (answered or explicitly deferred).
- G0-6 (provider-terms plan): **satisfied as a plan** by D7 (review starts now; Phase 1D-B counsel brief). Confirmation itself is beta gate B-6.
- G0-2 (independent design review CLEAN) must be re-established **for the amended package** before API-1 starts (Phase 1A).

