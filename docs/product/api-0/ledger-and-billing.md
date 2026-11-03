# Ledger and billing (API-0)

**Status:** design for API-2. No Stripe product, price, webhook endpoint, secret or customer is created by this document. Rulings applied: OD-1 (separate API plans), OD-5 (Firestore authoritative for entitlements, reservations and ledger), OD-6 (pilot Scenario A), OD-7 (separate API Stripe webhook endpoint and secret), OD-8 (failed jobs release customer credits; provider cost always recorded internally; cost-abuse controls), OD-21 (compile-time limits).

## 1. Two ledgers, one authority each

| Ledger | Path | Purpose | Authority for | Customer-visible |
|---|---|---|---|---|
| **Customer ledger** | `apiOrganizations/{orgId}/ledger/{entryId}` + `periods/{YYYY-MM}` counters | Credits reserved, charged, released, adjusted, refunded | Usage, entitlement consumption, invoicing (Stripe mirrors it) | Yes (`GET /v1/usage`, dashboard) |
| **Internal cost ledger** | `apiCostLedger/{entryId}` | Provider cost of every provider call, whatever the customer was charged | Margin, unit-cost measurement (OD-6), cost-abuse controls (OD-8), provider reconciliation | **Never** |

Both are append-only. Corrections are new entries (`adjustment`, `refund`), never edits.

## 2. Customer ledger

### 2.1 Entry types
`reserve`, `settle`, `release`, `adjustment` (operator, audited, with reason), `refund` (linked to a Stripe refund), `grant` (included credits at period start).

Entry fields: `entryId`, `type`, `orgId`, `appId`, `verificationId?`, `credits` (integer, signed by type), `periodId`, `createdAt`, `actor`, `idempotencyRef` (deterministic: e.g. `settle:{verId}`), `rateCardVersion`.

Deterministic entry IDs (`reserve_{verId}`, `settle_{verId}`, `release_{verId}`) with `tx.create()` make every entry exactly-once even under worker redelivery.

### 2.2 Period counters
`periods/{YYYY-MM}`: `included`, `used`, `reserved`, `overage` (always 0 in the pilot), `hardCapCredits`, `spendLimitUsd`. Updated only inside the same transaction as the ledger entry. High-volume orgs use N sharded counter documents summed on read (N fixed per org, placeholder 10).

### 2.3 Reserve (at create)
This is the T-create transaction of the transactional outbox (`jobs-and-idempotency.md` §2). It is modelled on the transactional TOCTOU protection of `checkAndIncrementUsageForRun` (`lib/stripe/usageCheck.ts`), but org-scoped and amount-based:
1. Read the idempotency record. If it exists, replay or reject (`jobs-and-idempotency.md` §5) and write nothing else.
2. Read org: `status = active`; a live key requires an active API plan (otherwise `403 live_key_requires_plan`); `abuseState` permits creates; the failed-job count limit is not exceeded (§4.3).
3. Read period: require `used + reserved + estimate ≤ hardCapCredits` and, where applicable, within `spendLimitUsd`. Read the platform daily spend counter: require it below the ceiling.
4. Write `reserve_{verId}`, `reserved += estimate`, the job document in internal state `pending_dispatch`, and the idempotency record. Dispatch happens **after** commit, never inside the transaction.
5. Any read failure aborts the transaction (fail closed). Nothing is written, so there is no partial state.

### 2.4 Settle (at finalize)
All amounts are **integer credits** (§2.6 rounding rule).

```
charged = min( estimate,
               ceil( Σ_{charged slots} credit_weight[m] × type_factor )
             + (synthesis produced a result ? synthesis_credits : 0)
             + retries_charged )
```

- A slot is **charged** when its connector status after retries is `ok` or `substituted` (it returned usable provider output). That includes a slot whose output then failed schema validation, because provider work happened. A `failed` slot is not charged. Its provider cost is still recorded internally (§3).
- `retries_charged` = `retry_allowance` if at least one transient retry, fallback or corrective retry produced the slot's final usable output, else 0.

Write `settle_{verId}` (charged). If `charged < estimate`, the same entry releases the remainder. `reserved −= estimate`, `used += charged`. Invariant: `charged ≤ estimate`, always (property-tested).

### 2.5 Release
`failed`, `canceled` (before execution), `expired`: `release_{verId}` for the whole estimate, `charged = 0` (OD-8). Canceled during execution settles for work done.

### 2.6 Credit weights (placeholders)
Defined in **new** compile-time module `lib/apiPlatform/rateCard.ts` (OD-21) with a `rateCardVersion`:

| Item | Placeholder |
|---|---|
| `credit_weight` per standard model | 1 |
| `credit_weight` per premium / search-enabled model | 2 |
| `type_factor` claim / research | 1 / 1.5 |
| `synthesis_credits` | 3 |
| `retry_allowance` (reserved, settled only if used) | 1 per job |

All placeholders; calibrated from the internal cost ledger during API-6.

**Rounding rule.** Credits are integers everywhere: ledger entries, counters, `usage` fields and API responses. The only fractional term is `Σ credit_weight × type_factor` (for example research `type_factor` 1.5). It is rounded **up** (`ceil`) once, at reservation and again at settlement, before the integer synthesis and retry terms are added:

```
estimate = ceil( Σ_selected credit_weight[m] × type_factor ) + (synthesis ? synthesis_credits : 0) + retry_allowance
```

Worked placeholder examples (same numbers as `pricing-and-cost-model.md` §2):
- Claim, 3 standard models: `ceil(3 × 1) + 0 + 1` = **4** reserved.
- Research, 3 standard models + 1 premium, synthesis on: `ceil((3 × 1 + 1 × 2) × 1.5) + 3 + 1` = `ceil(7.5) + 4` = **12** reserved. If the premium slot fails and no retry produced output, settlement is `ceil(3 × 1.5) + 3 + 0` = `ceil(4.5) + 3` = **8** charged and 4 released.

## 3. Internal cost ledger (OD-8)

### 3.1 What is recorded
One entry per provider call attempt, written by the worker **whether the call succeeded or failed**. That covers primary calls, transient retries, fallback substitutions (only with `allow_fallback`), the adaptive classification and the other auxiliary Gemini calls, corrective retries, and synthesis calls including their retries and fallback. The entries come from the per-call observer that PRD §6.5 adds to every provider call site. Without it, `runPanel` returns only each slot's final result: `failedPlaceholder()` and the substituted result both carry zeroed `tokenUsage`, and intermediate attempts are discarded.

`entryId` (= `{verId}:{step}:{callKey}`, created with `tx.create()` together with the per-call record, `jobs-and-idempotency.md` §4.4), `orgId`, `verificationId`, `step`, `callKey`, `site`, `slot`, `provider`, `requestedModel`, `actualModel`, `attempt`, `outcome` (`ok | error | timeout | refused | rate_limited`), `promptTokens`, `completionTokens`, `searchRequests`, `costUsd` (computed from `rateCard`), `costEstimated` (boolean), `rateCardVersion`, `jobOutcome` (filled at finalize), `customerCharged` (credits), `createdAt`.

**Reported usage.** Token counts come from the attempt's own connector result, through the existing normalization (`lib/panel/normalizeTokens.ts`, and `normalizeAdaptiveRetryUsage` in `lib/adaptiveSchema/retryCorrection.ts` for corrective retries). `costEstimated: false`.

**Unreported usage is estimated, never 0.** A call whose result carries no usable token counts gets `costEstimated: true`. This covers every DeepSeek call (`DeepSeekResult` has no usage field), timeouts, thrown or aborted calls, and errors without usage. Its cost is computed as:

```
promptTokens_est     = ceil( UTF-8 bytes of (system prompt + user message + context) actually sent / 3 )   // conservative local count
completionTokens_est = the call's effective output cap
costUsd              = promptTokens_est × p_in[model] + completionTokens_est × p_out[model] + search_fee[model] (if search-enabled)
```

The effective output cap is the limit the connector sends with that request, recorded per model in `rateCard.ts` as `max_output_tokens` and pinned by a test against the connector constant: for example `chatgptLimits.maxTokens` (`lib/connectors/chatgpt.ts`), `claudeLimits.maxTokens` (`lib/connectors/claude.ts`), `DEEPSEEK_MAX_TOKENS` (`lib/connectors/deepseek.ts`), and Gemini's requested `maxOutputTokens`, capped at 32,768 (`lib/connectors/gemini.ts`). A connector that sends no explicit cap uses the rate card's `assumed_max_output_tokens` for that model, and the test requires that value to be > 0. A timeout is charged at the full output cap: the provider may have generated the whole response. The estimate is an upper bound, so failed-job cost controls (§4.3) can never be blind.

### 3.2 Uses
- Per-org, per-day margin = revenue (settled credits × credit price) − Σ `costUsd`.
- Unit-cost measurement that gates Scenario B (OD-6).
- Platform daily spend circuit breaker (sum of today's `costUsd` across live orgs).
- Cost-abuse controls (§4.3).
- Monthly reconciliation against provider invoices (API-6).

## 4. Limits, caps and suspension

### 4.1 Hard caps
Every plan has a hard cap (`hardCapCredits`). No plan is unlimited. The pilot (Scenario A) hard-stops at included credits with `402 quota_exceeded`. Contracted (Scenario C) plans have a contracted ceiling.

### 4.2 Customer spend limit and alerts
Owner/billing role may set a lower limit; never above the plan ceiling. Alerts (dashboard, email, `usage.threshold_reached` webhook) at 50 / 80 / 100 %.

### 4.3 Cost-abuse controls (OD-8)
Because fully failed jobs are free to the customer, repeated failures could otherwise create unbounded losses. Controls, all thresholds placeholders in **new** `lib/apiPlatform/limits.ts`:

| Control | Rule (placeholder) | Action |
|---|---|---|
| Failed-job ratio | > 30 % of an org's live jobs in a rolling 24 h with ≥ 20 jobs | Soft: concurrency → 1, alert operator and org owner |
| **Failed-job count** | ≥ 25 released (failed) live jobs per org in a rolling 24 h, or ≥ 10 in a rolling 1 h | Hard: live creates `403 failed_job_threshold_exceeded`; `abuseState = review`. Independent of cost, so it holds even if every cost estimate were low |
| Failed-job provider cost | Σ `costUsd` (reported **and** estimated, §3.1) of released jobs > $5 / 24 h or > 10 % of the org's monthly plan price | Hard: as above |
| Repeated failing input | Same input fingerprint failed 3× in 1 h | Further creates with that fingerprint fail fast (`422 repeated_failing_input`) without provider calls for 1 h |
| Provider circuit breaker | Platform-wide provider error rate > 50 % over 5 min | Stop dispatching to that provider; slots shown `failed` / model `degraded`; reservations for those slots released |
| Platform daily API spend ceiling | Σ today's `costUsd` (reported + estimated) ≥ ceiling, kept in sharded `apiPlatformCounters/{YYYY-MM-DD}` incremented in the same transaction as each cost entry | `503 platform_spend_ceiling` for new live jobs; queued and running jobs stop at their next step start (`jobs-and-idempotency.md` §4.2) |

**What counts.** The failed-job count and ratio count customer-attributable failures: `insufficient_usable_models`, `worker_timeout`, `persistence_failed`, and the repeated-failing-input short-circuit. They exclude platform-caused terminal states that make no or negligible provider calls: `capacity_unavailable`, `pipeline_disabled`, `canceled` by suspension or ceiling, and `expired`. `query_not_executable`, `no_comparable_claims` and `adaptive_finalize_failed` are excluded from the count and ratio, but their provider cost is included in the failed-job cost, so the cost limit still bounds them.

**Where enforced.** Hard states and the platform ceiling are checked at create (T-create, §2.3) **and at every step start** (`jobs-and-idempotency.md` §4.2), so already-queued and running jobs stop spending. A job that has not started its panel step is `canceled` with a full release. A job past its panel step skips synthesis and finalizes `partial`, settling the panel work.

Lifting a hard state needs SYSTEM_ADMIN review, recorded in `apiAuditEvents` (`abuse.suspended`, `org.reactivated`).

### 4.4 Suspension and cancellation
- Stripe `past_due` beyond grace, or abuse decision → `status = suspended`: creates `403 org_suspended`; queued jobs canceled with full release; reads continue 30 days.
- Subscription ends → `status = canceled` at period end: live keys stop; test keys work 30 days; data follows retention (OD-10).

## 5. Stripe integration (separate endpoint, OD-7)

| Concern | Design | Existing pattern followed |
|---|---|---|
| Products and prices | New API-only products and prices, created in a separately authorized step; no change to existing price IDs or `STRIPE_PRICE_*` variables | — |
| Price allow-listing | Client sends plan key + cadence, never a price ID; server maps to an approved price | `lib/billing/approvedPrice.ts` |
| Customer per org | One Stripe customer per org, discovered by `cp_org_id` metadata before any creation; org-scoped idempotency key | `lib/billing/uidCustomerAuthority.ts` (uid-scoped customer discovery) |
| Concurrent checkout | Serialize checkout per org with a lease | `lib/billing/checkoutIdentityLease.ts` |
| Subscription authority | Resolve entitlement from the customer's authoritative Stripe subscription set, not from event arrival order | `lib/billing/customerSubscriptionAuthority.ts`, `lib/billing/subscriptionAuthority.ts` |
| Status semantics | Which statuses carry entitlement | `lib/billing/subscriptionStatus.ts` |
| Read-failure vs absence | Distinguish "could not read" from "no subscription"; never downgrade on a read error | `lib/billing/reconciliationOutcome.ts` |
| Webhook endpoint | **New** `/api/stripe/api-platform-webhook` with its **own signing secret**; existing `/api/stripe/webhook` untouched | — |
| Event filter | Ignore events whose customer/subscription lacks `cp_org_id` bound to a known org | — |
| Event dedup | Persist `apiStripeEvents/{eventId}` in the same transaction as the effect; never assume exactly-once delivery | — |
| Logging | `logger` only (the existing route's `console` use is not copied) | `lib/logger.ts` |

The endpoint's signing secret, and the Stripe credentials it uses, are runtime secrets and need the Order 6 boundary change (OD-21).

**Mirroring.** In the pilot, Stripe bills the fixed subscription; included credits are granted from the ledger at period start (`grant`). No usage is reported to Stripe in the pilot. If Scenario B is later approved, overage is reported at period close from the customer ledger, idempotent per `(orgId, periodId)`.

## 6. Reconciliation

| Job | Frequency | Check | On drift |
|---|---|---|---|
| Counter vs ledger | Nightly | `periods` counters = Σ ledger entries | Alert; freeze adjustments; never auto-correct silently |
| Reserved leak | Hourly | Every `reserve` has a matching `settle` or `release` within 24 h, or its job is non-terminal | Sweeper releases and records `adjustment` with reason |
| Cost vs settlement | Nightly | Every terminal job has ≥ 1 cost entry if any provider call was dispatched | Alert |
| Stripe vs ledger | Per period | Subscription state per org equals org `plan`/`status`; (Scenario B) reported usage equals ledger overage | Alert; operator review |
| Provider invoices | Monthly (API-6) | Σ `costUsd` per provider vs invoice | Update rate card version |

Drift target: zero. Any non-zero drift is an incident.
