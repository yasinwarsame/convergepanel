# API-0 Owner Decision Addendum 8: settlement of fully failed jobs (2026-11-18)

| | |
|---|---|
| **Status** | Append-only design amendment. It records the owner's ruling E1 on MINOR m-A of the independent review of #325 at `d46d766` (CLEAN_WITH_MINOR), and the R4 Track E correction made in response, including MINORs m-B, m-C and m-D of the same review. **It authorizes no implementation stage, no release and no merge.** |
| **Authority** | Product owner, ruling E1 "the ledger policy governs", R4 targeted corrections |
| **Amends** | `ledger-and-billing.md` §2.5 (new paragraph *Fully failed*) and §4.3 (new paragraph *Short-circuit attribution*), `retention-and-deletion.md` §3.1 (new bullet *Acceptance identity*), `jobs-and-idempotency.md` §5A (modelled and omitted lists), `../api-platform-prd.md` (§10.3 item 3, §21A P-4, changelog row "4 (A8)"), `README.md`, the reference model and its spec |
| **Does not change** | The ledger policy (`ledger-and-billing.md` §2.4–§2.5, OD-8). Addenda 1–7 (append-only; not edited; corrected only where §5 says so). `openapi.yaml` (0.4.0-draft) and `error-catalog.md`: checked, nothing in them contradicts the ruling (the cancel description already says a running job "settles for work already done"; no error code or status changes). No price, identity, research or other contract change |
| **Baseline** | PR #325 branch `docs/api-0-amendment-1` at `d46d766` |

## 1. The finding (m-A)

The reference model settled every terminal job with one rule, "charged = recorded provider calls, capped at the reservation", which Addendum 7 (§4, m-2) described. Applied to `failed`, for example `failed: worker_timeout` after two provider calls, it charged the customer 2 credits. That contradicts `ledger-and-billing.md` §2.5 ("`failed` … `charged = 0`"), §4.3 ("fully failed jobs are free to the customer"), PRD J6 and OD-8.

## 2. Owner ruling E1 (binding)

The ledger policy in `ledger-and-billing.md` governs. A fully failed verification job charges **zero** customer credits and releases the **entire** reservation; provider costs are recorded separately in the internal cost ledger. This does not override the existing settlement rules for completed jobs, partially completed jobs, and canceled jobs with already completed chargeable work. The policy is not changed to fit the model: the reference model and its tests are fixed.

## 3. Design

| Item | Design |
|---|---|
| Fully failed (E1) | `ledger-and-billing.md` §2.5 *Fully failed*: every job that ends `failed`, whatever its failure code and however many provider calls it made, is charged 0 and releases its whole reservation in its one settlement. Customer-attributable failure (`insufficient_usable_models`) is fully failed: `jobs-and-idempotency.md` §3 ("< 2 usable models … `failed` … release"), `ledger-and-billing.md` §2.5 and PRD J6 ("The customer's reservation is released in full") already say so; nothing is invented |
| Unchanged settlement | `completed`, `partial` and canceled-after-chargeable-work settle the work done (§2.4); canceled before execution and `expired` are charged 0 (§2.5) |
| Cost ledger | Every provider call, in time or late, writes its internal cost entry, whatever its outcome and whatever the customer is charged (§3.1). The failed-job count, ratio, cost limit and repeated-failing-input short-circuit are unchanged (§4.3) |
| Late provider call (m-B) | A call result that arrives after the job is terminal (not yet purged) is refused by the late-write barrier: no call record, no change to the job or settlement, not charged; its cost entry is recorded (`retention-and-deletion.md` §3.1, unchanged) |
| Acceptance identity (m-C) | `retention-and-deletion.md` §3.1 *Acceptance identity*: generated independently by a CSPRNG with at least 128 bits; never derived from the `Idempotency-Key`, the verification ID, the request content or the time; unique across all organizations, applications, modes and keys while any record, marker or job refers to it; immutable, not returned, compared only for equality |
| Platform faults and the customer ratio (m-D) | `ledger-and-billing.md` §4.3 *Short-circuit attribution*: a `422 repeated_failing_input` rejection counts toward the failed-job count and ratio only when the fingerprint's customer-attributable failures alone reach the threshold; a block that needed `worker_timeout` or `persistence_failed` never counts against the customer. The outage effect is disclosed there |

## 4. Changes to other documents (each listed)

| Document | Change |
|---|---|
| `ledger-and-billing.md` §2.5 | New paragraph *Fully failed (Addendum 8)* (clarification of the existing rule; the policy is unchanged) |
| `ledger-and-billing.md` §4.3 | New paragraph *Short-circuit attribution (Addendum 8)*, with the outage disclosure |
| `retention-and-deletion.md` §3.1 | New bullet *Acceptance identity (Addendum 8)* |
| `jobs-and-idempotency.md` §5A | 10f and step 13's `failed_job_threshold_exceeded` move from *Omitted* to modelled; the settlement and cost-entry rules of the model are stated |
| PRD §10.3 item 3 | "`canceled`" → "`canceled` before execution", plus the Addendum 8 note. The old text said every canceled job is charged 0, contradicting `ledger-and-billing.md` §2.5 ("Canceled during execution settles for work done"), which the ruling keeps |
| PRD §21A P-4 (provider cost on failed jobs) | "A fully failed, canceled or expired job" → "A fully failed, expired or canceled-before-execution job", same reason |
| PRD changelog, `README.md` | Row "4 (A8)"; index row 21 |
| `openapi.yaml`, `error-catalog.md` | None: checked, no contradiction |

## 5. Corrections to earlier addenda (not edited)

| Earlier text | Correction |
|---|---|
| Addendum 7 §4, m-2: settlement "charged = recorded calls, capped at the reservation; released = the rest" | Applies only to `completed`, `partial` and `canceled` (work done; zero calls for canceled before execution). A `failed` or `expired` job is charged 0 and releases its whole reservation (§2). The other m-2 statements (computed inside the terminal transaction, recomputed on retry, one settlement, conservation) stand |
| Addendum 7 §4, m-5, and `ledger-and-billing.md` §4.3 *What counts* ("the repeated-failing-input short-circuit" counts) | Only rejections whose block the customer-attributable failures alone reach (§3, m-D) |
| Addendum 7 §3 row (1): `acceptanceId` "immutable, unique per acceptance" | Also generated independently, as in §3 (m-C) |

## 6. Owner questions (not decided here)

1. **Outage blocks.** During a platform outage, an input that ends `worker_timeout` or `persistence_failed` 3× in 1 h is rejected for 1 h (`422 repeated_failing_input`) although the customer caused nothing (Addendum 7, kept). Should such a block be lifted early once the platform fault clears, or shown with a different code?
2. **Cost limit during outages.** The provider cost of platform-fault jobs counts toward the failed-job cost limit (Addendum 6, 7, kept), so a long outage can pause an organization's live creates (`403 failed_job_threshold_exceeded`) until a SYSTEM_ADMIN review. Keep, or exclude platform-fault cost from the per-organization limit and rely on the platform spend ceiling?
3. **Ratio denominator.** The documents do not say whether short-circuit rejections (which create no job) enter the denominator of the failed-job ratio ("% of an org's live jobs"). The model counts terminal live jobs plus counted rejections; an implementation needs a ruling.
4. **Fingerprints after deletion.** Whether the input fingerprint used by the short-circuit is kept (as a hash) for its 1 h window after the verification is deleted is not specified. The model keeps a content-free outcome record with the fingerprint; `retention-and-deletion.md` does not list it.

## 7. Tests (reference model; doc-parsed)

`docs/__tests__/apiIdempotencyReplayPrecedence.spec.ts`, describes "Addendum 8 …":
- **Failing first:** commit `36a8beb` added the tests and model scaffolding that mirrors the then-current documented semantics; 25 tests failed against it; the fix follows in a separate commit.
- E2-1 … E2-10: failed after usable provider calls; failed after every model fails; platform-caused failures (`worker_timeout` via the sweeper, `persistence_failed`, `capacity_unavailable`); customer-attributable failure (doc text cited by the test); partial completion; cancellation before processing; cancellation after chargeable work; a terminal transaction retried after a late call (failed and partial); duplicate terminal events (every interleaving of two terminal transitions, then repeats); exhaustive conservation over every terminal outcome × 0–8 usable calls × 0–2 failed calls × deleted or not, plus expiry. Asserted against an oracle written from §2.4–§2.5 in the spec, not the model's own formula: full failure charged 0 and released = reserved; others charged + released = reserved; no negative balance; one settlement; one cost entry per call, independent of the charge.
- Every `failed` row of `jobs-and-idempotency.md` §3 is parsed: its side effect starts with "release", and the model charges 0 for each failure code.
- Flood bounds: distinct customer-attributable failures stop at the hard count limit; distinct platform-fault failures (excluded from the count) stop at the failed-job cost limit; all free to the customer. The thresholds and code lists are parsed from §4.3.
- Late call after `failed`, `completed`, `canceled` (not purged), and every interleaving of an in-flight call with a failed transition.
- Platform faults: a block reached only through platform faults rejects but never counts; mixed failures; rejections never push the ratio over the soft threshold.
- Acceptance identity: the §3.1 text is parsed; format (128 bits); two identical worlds give the same verification IDs but different acceptance IDs (not derived); uniqueness over 100 acceptances across organizations, applications, modes and key reuse; a record with the same verification ID but another acceptance identity is never overwritten by `DELETE`.

These tests do **not** prove the distributed implementation; the API-3 obligations of `jobs-and-idempotency.md` §5B.2 apply.

## 8. Merge status

Unchanged: #325 needs an independent review of this head, a fresh approval after that review's record, and an owner merge instruction.
