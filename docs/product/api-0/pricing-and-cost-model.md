# Pricing and cost model (API-0)

> **Every number in this document is a placeholder.** None is a statement of any provider's actual price, of a ConvergePanel price, or of a target margin. Real values come from provider invoices and the internal cost ledger during API-6, and prices are set by the owner. No billing or charging change is made by this document.

Rulings applied: OD-6 (pilot = Scenario A; metered overage only after real unit costs are measured), OD-1 (API plans separate from consumer plans), OD-8 (internal cost always recorded), OD-21 (rate card is a compile-time module).

## 1. Cost formula

Per job:

```
provider_cost(job) =
    Σ over panel slots s, attempts a:
        prompt_tokens[s,a] × p_in[model(s,a)] + completion_tokens[s,a] × p_out[model(s,a)]
  + Σ over substitutions (DeepSeek fallback):     same, at the substitute's rates
  + classification_call                          (research: adaptive classification)
  + Σ corrective retries                         (research: bounded by retryBudget.ts)
  + synthesis_call                               (if requested and run)
  + Σ search_requests[s] × search_fee[model(s)]  (where a provider charges per search)

platform_cost(job) = worker_compute + firestore_ops + queue_ops + redis_ops + egress

unit_cost(job) = provider_cost(job) + platform_cost(job)
```

Inputs that drive cost: number and choice of **selected models**; input length (prompt tokens); response length (completion tokens, capped by existing connector limits); **retries** and fallbacks (`lib/panel.ts`, `lib/adaptiveSchema/retryBudget.ts`); **synthesis**; provider **search fees**. Every term is recorded per call in the internal cost ledger with `rateCardVersion`, so the formula is evaluated on measured data, not estimates.

### 1.1 Rate card
**New** `lib/apiPlatform/rateCard.ts` (compile-time, reviewed PR, OD-21): per model `p_in`, `p_out` (USD per 1M tokens), `search_fee`, `credit_weight`, plus `type_factor`, `synthesis_credits`, `retry_allowance`, `credit_price_usd` per plan. Every value is a placeholder until API-6 calibration.

### 1.2 Credit estimate and charge
```
estimate = Σ_selected credit_weight[m] × type_factor + (synthesis ? synthesis_credits : 0) + retry_allowance
charged  = Σ_slots_with_provider_work credit_weight[m] × type_factor + synthesis_used + retries_used   (≤ estimate)
```
Failed / canceled-before-start / expired jobs: `charged = 0`, provider cost still recorded (OD-8).

## 2. Scenario A — pilot (ruled)

**Subscription with included credits and a hard stop.**

| Parameter | Placeholder | Notes |
|---|---|---|
| Monthly price | $X (e.g. $199) | Owner sets |
| Included credits | e.g. 1,000 / month | Granted from the ledger at period start; unused credits do not roll over in the pilot |
| Beyond included | **Hard stop** (`402 quota_exceeded`) | No overage, no metering |
| Applications | 2 | |
| Concurrent running jobs | 5 | Also bounded by CR-2 pools |
| Max models per job | 5 | `min_models` 2 |
| Synthesis | Allowed, `synthesis_credits` each | |
| Retention | 30-day default (OD-10) | |
| Model-response access | Off by default (OD-19) | |
| Orgs | 3–5 design partners, manually approved | |

**Worked placeholder example.** Claim, 3 models at weight 1, no synthesis: estimate = 3 × 1 + 1 = 4 credits. One model fails without tokens. Charged = 2 credits; 2 released. If placeholder provider cost is $0.02 per successful slot and the placeholder credit price is $0.199 (= $199 / 1,000), the job's provider cost is ≈ $0.04 against ≈ $0.40 of included-credit value. **Illustrative only.**

**What the pilot must measure (exit evidence for OD-6):**
1. Distribution of `unit_cost` by type, model set, input-length band and synthesis flag (p50, p90, p99).
2. Retry and fallback rates per provider and their cost share.
3. Cost of released (failed) jobs as a share of total cost.
4. Credit-weight error: |charged-credit value − unit_cost| per job.
5. Platform cost share.

Scenario B may be proposed only after these are measured over ≥ 30 days and the owner approves prices from them.

## 3. Scenario B — subscription plus metered overage (later, not authorized)

| Parameter | Placeholder |
|---|---|
| Monthly price | $Y (e.g. $499) |
| Included credits | e.g. 3,000 |
| Overage | $Z per credit, from measured unit cost + target margin (owner) |
| Ceiling | `spend_limit_usd`, required, set by the customer within a plan maximum |
| Reporting | Period-close usage report to Stripe from the customer ledger, idempotent per `(orgId, period)` |

Preconditions: OD-6 measurement complete; owner approval of prices; separately authorized Stripe change.

## 4. Scenario C — enterprise contracted usage (later, case by case)

Committed annual volume at a contracted rate up to a contracted ceiling; platform circuit breaker still applies; may include longer class (d) evidence retention (OD-10) and dedicated CR-2 pool shares. Requires measured unit costs and counsel-reviewed contract.

## 5. Unmetered-usage prevention

| Control | Where |
|---|---|
| Every job pre-authorized against a hard cap | `ledger-and-billing.md` §2.3 |
| No unlimited plan | rate card / plan module |
| Test mode never calls providers | sandbox fixtures |
| Platform daily API spend ceiling | `ledger-and-billing.md` §4.3 |
| Failed-job cost thresholds | `ledger-and-billing.md` §4.3 |
| Every provider call in the internal cost ledger | `ledger-and-billing.md` §3 |
| `charged ≤ estimate` | property test |
| Input size and `max_models` caps | request validation |
| CR-2 provider pools | PRD §13A |
