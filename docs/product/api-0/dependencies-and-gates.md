# Dependencies and gates (API-0)

**Status:** design. Each stage API-1..API-7 is **separately authorized** by the owner, has its own tests, an **independent review** (fresh reviewer per round, no author context), and a **protected release** (branch protection, CI green, post-merge check, ships dark behind a compile-time switch per OD-21). No stage authorizes the next. No stage changes existing routes' behaviour except the mechanical API-3 extractions, which are proven equivalent.

## 1. Implementation dependencies

| ID | Dependency | Needed by | Owner / source | Status |
|---|---|---|---|---|
| DEP-1 | Current queue stable: report-review activation safeguards (Orders A/B), authenticated Production acceptance of recent research PRs, C1–C3 project reviewer items | API-1 | Owner (PRD §0) | Open |
| DEP-2 | **Order 6 boundary change** approved so new secrets can be read through `lib/env.ts` (byte-pinned by Order 6 suites): `API_KEY_PEPPER` (+ `_PREVIOUS`), Redis-class store credentials, queue credentials, API Stripe webhook secret, KMS fallback key if needed | API-1 (pepper), API-2, API-3, API-5 | Owner (OD-21; OQ-1) | Open |
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
