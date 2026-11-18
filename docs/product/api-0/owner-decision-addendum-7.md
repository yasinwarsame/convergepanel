# API-0 Owner Decision Addendum 7: deletion binds to the original verification (2026-11-18)

| | |
|---|---|
| **Status** | Append-only design amendment. It records the owner's ruling on finding M-1 of the independent review of #325 at `26e9e0b` (NOT_CLEAN), and the single focused correction round made in response, including the directly related MINOR and NIT findings. **It authorizes no implementation stage, no release and no merge.** |
| **Authority** | Product owner, ruling "deletion binds to the original verification, not the key string", one focused round (R3) |
| **Amends** | `retention-and-deletion.md` §3.1, `jobs-and-idempotency.md` (§5 deleted row, §6.2 D12 and binding note), `error-catalog.md` §3.1 step 8, `ledger-and-billing.md` §4.3 (new paragraph), `README.md`, the reference model and its spec |
| **Does not change** | Addenda 1–6 (append-only; not edited; corrected only where §5 says so). The deletion contract (DELETE → `202` with one `del_…` operation; 410 for the caller's own deleted verification; foreign 404). No billing price, identity, research or other contract change |
| **Baseline** | PR #325 branch `docs/api-0-amendment-1` at `26e9e0b` |

## 1. The finding (M-1)

`DELETE` wrote the `deleted` marker over **whatever** idempotency record sat at the job's key, without checking that it still represented that job. If job A was accepted with key K, K's record expired after 24 h, and job B was then accepted with K, deleting A overwrote B's record: B's replay returned a false `410 verification_deleted` while B itself was running. That breaks the step-8c replay rule (`error-catalog.md` §3.1) and the rule that 410 is only for the caller's own deleted verification, and invites a client to resubmit (a duplicate job and charge).

## 2. Owner ruling

Deletion binds to the original verification, not to the key string:
1. the original verification ID and an immutable acceptance identity are captured at create;
2. on deletion the current idempotency record is read transactionally;
3. it is modified only if it still represents that exact original accepted job (same verification ID **and** same acceptance identity, unexpired);
4. a record that represents a different or newer job is left entirely unchanged;
5. the old job is still canceled, settled and purged;
6. an expired marker that would mask a newer accepted request is never recreated;
7. no second reservation, dispatch, settlement or charge results;
8. the documented 410 for an authorized deleted verification is preserved;
9. the original deletion-operation identity is kept across retries.

## 3. Design

| Requirement | Design |
|---|---|
| (1) | T-create writes `acceptanceId` (immutable, unique per acceptance) on the idempotency record and copies it to the job (`idemAcceptanceId`) with the record's path |
| (2)–(4), (6) | The `DELETE` transaction reads the record and writes the marker only if `kind` is `committed`, `verificationId` is this job, `acceptanceId` equals the job's, and `expiresAt` is in the future. Otherwise it writes nothing to the record. The marker keeps `verificationId`, `acceptanceId` and the original `expiresAt` (identifiers only, content-free) |
| (5), (7) | Unchanged deletion lifecycle (Addendum 6): cancellation, one settlement and one release by the job's own terminal transition, then purge. Nothing in deletion creates a reservation or dispatch |
| (8) | A marker written for the job's own acceptance still answers its replay with 410 |
| (9) | One operation `apiDeletions/{deletionId}` per verification, reused by every repeat call (Addendum 6, unchanged) |

## 4. Directly related MINOR and NIT findings

| Finding | Disposition |
|---|---|
| m-1 "stop before the next provider call" untested | Explicit boundary tests: after cancellation or deletion is requested, the next provider call is not made; a call already in flight completes |
| m-2 settlement amounts not asserted; over-refund on transaction retry | Settlement is computed **inside** the terminal transaction from that transaction's own read (charged = recorded calls, capped at the reservation; released = the rest), so a retried transaction recomputes it; a `ledger/settle_{id}` entry is created at most once. Tests assert charged + released = reserved, one settlement per job, no further refund on repeated terminal events, and organization-wide conservation. *Correction to Addendum 6 §3 row (2), (3):* an in-flight call's record is written only if the job is still non-terminal when the result arrives; if the sweeper has already ended the job, the barrier refuses the content, the call's cost entry is still recorded, and the call is not charged (the job was already settled) |
| m-3 §6.2 *Then* / *Job at DELETE* not parse-bound; no interleavings for purge vs late writes or dispatch vs delete | The spec selects each scenario by the exact *Then* text and checks the job's state at `DELETE` against *Job at DELETE*. New interleavings: sweeper recovery and purge racing a late call result and a late completion; dispatch racing `DELETE` of a queued job |
| m-4 late-write barrier wording too broad; outbox ordering unspecified | The barrier applies only to worker and provider-callback **content** writes; deletion completion, the retention purge, sweeper bookkeeping, deletion-operation updates, audit events and cost entries are not refused. The terminal transition's outbox event precedes the purge; the purge deletes undelivered delivery records and writes `verification.deleted` (`retention-and-deletion.md` §3.1) |
| m-5 platform-fault cost loophole | **Decided as recommended:** `worker_timeout` and `persistence_failed` stay excluded from the failed-job count and ratio, but **count toward the repeated-failing-input short-circuit** (by input fingerprint); their cost stays in the failed-job cost limit. The residual risk (cost spread across many distinct inputs) is bounded by the cost limit and the platform spend ceiling, and accepted (`ledger-and-billing.md` §4.3) |
| NIT: D12 "lease never expires" impossible | Reworded: the worker stops responding and fewer than three leases have expired so far |
| NIT: marker timing wording | `retention-and-deletion.md` §3.1: the marker is written at `DELETE` acceptance (bound to the acceptance); the purge does not touch the record |
| NIT: tombstone dropped the anomaly marker | The tombstone keeps `concurrencyReleaseAnomaly`, the settlement amounts and the call count |

## 5. Corrections to earlier addenda (not edited)

| Earlier text | Correction |
|---|---|
| Addendum 6 §3 row (2), (3): an in-flight call "completes and its record is written while the job is still non-terminal" | Only while the job is still non-terminal; otherwise refused as in §4 (m-2) |
| Addendum 6 §3 row (9) and `retention-and-deletion.md` §3.1 "Late-write barrier" ("every worker, callback or sweeper write") | Narrowed to worker and provider-callback content writes (§4, m-4) |
| Addendum 6, `retention-and-deletion.md` §3.1 "the idempotency record becomes the content-free marker" | Only for the record of this exact acceptance (§3) |

## 6. Tests (reference model; doc-parsed)

`docs/__tests__/apiIdempotencyReplayPrecedence.spec.ts`:
- **Failing first:** commit `347d6ec` added "A accepted with K; K expires; B accepted with K; A deleted → B still replays (no false 410)", failing against `26e9e0b`'s model; the fix follows in a separate commit.
- "Addendum 7 M-1": the marker for A's own current record (410 preserved); an expired record is never recreated, and a marker stops masking once it expires; repeated `DELETE`s of A never touch B's record; deletion of A racing reuse of K by B (every interleaving: B never masked; two jobs, two reservations, two dispatches); a replay of B racing the deletion of A (every interleaving).
- "Addendum 7 m-2": a stop whose transaction retries after a late call recomputes the settlement; each terminal state conserves charged + released = reserved with one settlement and no further refund; organization-wide conservation across deletions.
- "Addendum 7 m-1": provider-call boundary after cancellation and after deletion; the call in flight completes, the next is not made.
- "Addendum 7 m-3": purge racing late call results and late completion; dispatch racing `DELETE`; the tombstone keeps the anomaly marker; and §6.2 is parse-bound on *Then* and *Job at DELETE*.
- "Addendum 7 m-5": the ledger rule is parsed and must name `worker_timeout` and `persistence_failed`.

These tests do **not** prove the distributed implementation; the API-3 emulator, failure-injection and isolated-environment obligations of `jobs-and-idempotency.md` §5B.2 apply.

## 7. Merge status

Unchanged: #325 needs an independent review of this head, a fresh approval after that review's record, and an owner merge instruction.
