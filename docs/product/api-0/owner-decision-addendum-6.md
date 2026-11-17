# API-0 Owner Decision Addendum 6: deletion of a running job (2026-11-18)

| | |
|---|---|
| **Status** | Append-only design amendment. It records the owner's ruling on finding MAJOR-1 of the independent review of #325 at `7120c1d`, and the single bounded correction made in response, including the directly related MINOR findings. **It authorizes no implementation stage, no release and no merge.** |
| **Authority** | Product owner, ruling "cancellation and settlement before purge", one bounded correction round |
| **Amends** | `retention-and-deletion.md` §3.1, `jobs-and-idempotency.md` (§3 state table, §4.4 sweeper, §5B, §5B.1 row E11, §6, new §6.2), `ledger-and-billing.md` §4.3, `error-catalog.md` §3.1 (read row), `openapi.yaml` (`deleteVerification` description), `pricing-and-cost-model.md` (concurrency row), `../api-platform-prd.md` (changelog row "4 (A6)", §13A item 2, OD-5 row note), `README.md`, the reference model and its spec |
| **Does not change** | Addenda 1–5 (append-only; not edited; superseded only where §5 says so). The deletion contract of OD-11 (DELETE → `202` with a `del_…` operation, asynchronous, idempotent; foreign IDs 404; class (c) and the tombstone kept). No billing price, identity, research or other contract change |
| **Baseline** | PR #325 branch `docs/api-0-amendment-1` at `7120c1d` |

## 1. The finding

`DELETE` was documented as "cancel first", but cancelling a running job is only a request (`jobs-and-idempotency.md` §6), so deletion of a running job had no defined release. The reference model moved a running job straight to `canceled` (contradicting §6), and its release function silently skipped any job marked deleted, a rule not in the document. A probe reached a deleted running job that was still counted (`active: 1`, not released) with no path to release it.

## 2. Owner ruling: cancellation and settlement before purge

A running job must not be marked fully deleted while its concurrency admission is outstanding. `DELETE` keeps returning `202` with a deletion-operation ID (asynchronous). Requirements:
1. `DELETE` creates or reuses one idempotent deletion operation;
2. for a non-terminal job, it records the deletion intent and requests cancellation;
3. subsequent provider calls stop at safe boundaries; an in-flight call cannot be canceled;
4. the minimum internal job state needed for settlement, release, retries and audit is kept while deletion is pending;
5. normal retrieval does not expose content awaiting deletion, while strictly authorized internal settlement access remains;
6. the first valid terminal transition releases the exact admission atomically;
7. the deletion completes only after settlement and release, then purges content and associated records;
8. a crashed or unresponsive worker is finalized by a bounded recovery mechanism (sweeper deadline, including `synthesizing` and `pending_dispatch`);
9. duplicate `DELETE`s, workers, callbacks, cancellations and sweepers cannot double-release or recreate deleted records (late-write barrier after purge);
10. a deletion operation that cannot complete stays observable and retryable, never silently successful.

The deletion marker must not make an unfinished counted job invisible to recovery or reconciliation.

## 3. Design (`retention-and-deletion.md` §3.1, `jobs-and-idempotency.md` §5B, §6.2)

| Requirement | Design |
|---|---|
| (1) | One operation `apiDeletions/{deletionId}` per verification, created in the `DELETE` transaction; a repeat `DELETE` returns it with its current `status` |
| (2), (3) | The same transaction sets the job's deletion intent and `cancelRequested`; a queued job is canceled at once (full release); a running or synthesizing worker stops before its next provider call; an in-flight call completes and its record is written while the job is still non-terminal |
| (4), (5) | The job keeps its state, markers, credits and call records until purge; customer reads (`GET`, `/report`, `/models`) return `410 verification_deleted` from `DELETE` acceptance, `cancel` returns `410`, the list omits it; only internal settlement paths read the job |
| (6) | The release is the first non-terminal → terminal transition (§5B), unchanged by the deletion intent: the model's undocumented "skip deleted jobs" guard is removed |
| (7) | The operation completes only when the job is terminal and released; then one transaction purges inputs, call records and results, reduces the job to a minimal tombstone (state, organization, admission and release markers, deletion ID) and marks the operation `completed` |
| (8) | The sweeper ends `running` and `synthesizing` jobs after three expired leases (`worker_timeout`, or `canceled: deletion_requested`) and `pending_dispatch` / `queued` jobs after the max queue wait or when deletion is pending; it does not skip deletion-pending jobs |
| (9) | Terminal transitions are conditional on a non-terminal job; worker writes check the job inside their transaction and are refused for a terminal or purged job; repeat `DELETE`s reuse the operation |
| (10) | A blocked operation stays `pending`, counts attempts, names what it waits for (`awaiting_terminal`, `awaiting_release`), is retried by every sweep, and alerts past its completion target |
| Reconciliation | Deletion-pending jobs are counted like any counted, unreleased job; the purged tombstone is terminal and released |

## 4. Directly related MINOR fixes

| MINOR | Fix |
|---|---|
| 1. A `synthesizing` job with a dead worker had no sweeper path | The sweeper and the §3 state table cover `synthesizing` (and the deletion-pending variants) |
| 2. Drift detection read the count and the job query at different times | Detection reads both at one read time in a read-only transaction and retries an unvalidated snapshot instead of reporting it; tested against every interleaving with an admission and a release |
| 3. Contention on the concurrency record could end in `worker_timeout`, which was customer-attributable | `worker_timeout` and `persistence_failed` are platform-caused, excluded from the failed-job count and ratio (`ledger-and-billing.md` §4.3); throughput disclosure below |
| 4. Contradictory documents | PRD §13A item 2 (per-org queue-depth ceiling), the PRD OD-5 row ("concurrency counters" in Redis) and `pricing-and-cost-model.md` ("Concurrent running jobs 5") carry notes pointing to the admission limit in `apiOrgConcurrency/{orgId}`; the PRD §9.3 reinterpretation of "queued up to a queue depth limit" (Addendum 5) is recorded as a supersession in §5 |

Also declared (review NITs): the repair transaction's read locks (Admin SDK transactions lock what they read) and the composite index (`orgId`, `concurrencyCounted`, `concurrencyReleased`) needed by detection and repair (`jobs-and-idempotency.md` §5B, Throughput).

## 5. Supersessions

| Earlier text | Superseded by |
|---|---|
| `retention-and-deletion.md` §3.1 "if `queued`/`running`, cancel first … Then delete" | §3 above: cancellation and settlement before purge |
| `jobs-and-idempotency.md` §5B release bullet ("deletion (which cancels a non-terminal job first …)") and §5B.1 note on E9–E10 | §5B and §5B.1 as amended (E11 added) |
| `ledger-and-billing.md` §4.3: `worker_timeout`, `persistence_failed` customer-attributable | Platform-caused |
| PRD §9.3 "accepted and queued up to a queue depth limit, then `429 concurrency_limit`" | Addendum 5's note: one admission limit on accepted non-terminal jobs (queued and running together); this addendum records it as a supersession |

## 6. Throughput (evaluated, not guaranteed)

Exact, unsharded, organization-scoped accounting serializes every admission and every terminal transition of an organization on one Firestore document. Firestore's documentation gives no fixed per-document write rate: "The exact maximum rate that an app can update a single document depends highly on the workload" and "The best way to characterize your workload's performance is to perform load testing" (*Best practices*, firebase.google.com/docs/firestore/best-practices, read 2026-11-18); its distributed-counter guide sizes one counter document with "Each shard can support being incremented once per second" (firebase.google.com/docs/firestore/solutions/counters, read 2026-11-18). This is therefore a deliberate per-organization bottleneck. **No capacity figure is claimed.** It must be measured in API-3 load tests, and the per-organization create rate limit set below it.

## 7. Tests (reference model; doc-parsed tables)

`docs/__tests__/apiIdempotencyReplayPrecedence.spec.ts`:
- **Deletion lifecycle table** (`jobs-and-idempotency.md` §6.2, rows D1–D12, parsed): queued job deleted; running job deleted before the next provider call; deleted during an in-flight call; synthesizing job deleted; worker crash during deletion (sweeper recovery); normal completion racing the deletion (every interleaving); completed job deleted; duplicate deletion; deletion racing the sweeper; late worker writes after purge (refused); a stop attempt that crashes and is retried; a worker that never stops (operation stays `pending`). Each row checks the owner's read while pending (410), the number of releases and settlements (exactly one, or none while pending), the operation status, the purge, `cancel` → 410, and that the count equals the counted, unreleased jobs (no negative count, no leak);
- the sweeper racing the worker's stop (every interleaving); at the limit, deleting every active job; drift detection racing an admission and a release (every interleaving; no spurious drift);
- the release table §5B.1 now includes E11 (running job deleted: still counted);
- `worker_timeout` / `persistence_failed` attribution parsed from `ledger-and-billing.md` §4.3 and compared with the model; sweeper recovery for `running` and `synthesizing`.

These tests do **not** prove the distributed implementation (`jobs-and-idempotency.md` §5B.2): the deletion lifecycle also needs Firestore-emulator, failure-injection and isolated-environment tests in API-3.

## 8. Merge status

Unchanged: #325 needs an independent review of this head, a fresh approval after that review's record, and an owner merge instruction.
