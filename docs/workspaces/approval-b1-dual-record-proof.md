# Stage B1: proof that a run cannot hold both review records

**Invariant.** No `runs/{id}` document ever carries both `governanceRecord` (the governed, Milestone-2 review record) and `reportReview` (the B1 record).

**Scope.** Main `900aec72` plus B1. The governed-run writer is **unchanged** (owner ruling D-B7, option (a)).

## 1. Every way a `governanceRecord` comes into existence

A whole record is created at only two production sites.

`reportReviewArchiveImmutability.spec.ts` pins **every** write that can put a `governanceRecord` on a run, across `lib/`, `app/` and `scripts/`, against an explicit allow-list with the reason each entry is safe. It checks four write shapes: whole-record writes, dotted-path payload keys, assignments into a write payload, and seed-plan documents. A new writer of any of these shapes fails the test, and the proof must then be redone.

The allow-list also contains the test-seeding plan (`lib/governance/adaptiveGovernanceSeedPlan.ts`). It writes legacy-Team run documents (`teamId`, no `workspaceId`), which can never pass the report-review workspace binding.

| # | Site | When it runs | Which run |
|---|---|---|---|
| G1 | `lib/runPanelExecution.ts` → `initializeAdaptiveGovernanceRecord` → `persistGovernanceRecord` | Inside the run's **own single execution**, only inside `if (adaptiveOutput.persistedOutput)`, and only after `persistAdaptiveOutput` reported `saved` | The executing run |
| G2 | `lib/firestore/teamRunSnapshots.ts` → `buildAdaptiveGovernanceRecord` | When a run is copied into a Team project, and only from a copied `adaptiveOutput` | A **brand-new** run id (`run-${randomUUID()}`), written in one transaction together with that `adaptiveOutput` |

All other governance writes are partial updates of `governanceRecord.humanReview`, made by the decision, panel, override and resubmit routes. Each of them first reads and parses an **existing** governance record in its transaction, so none can create one on a run that has none.

**Facts each step relies on, all checked in code:**
- **One execution per run id.** Every execution uses a fresh `run-${randomUUID()}` (`app/api/run-panel/route.ts:291`), and Team runs are created with `tx.create()` (`teamWorkspaceRuns.ts`). No path re-executes an existing run id.
- **One schema per run.** A run's single execution picks exactly one schema. `attachAdaptiveEnvelope` (Milestone-2 ids) and `attachLegacyAdaptiveEnvelope` (typed `PersistedLegacyAdaptiveSchemaId`, called only behind `isPersistedLegacyAdaptiveSchemaId`) are mutually exclusive. The two id sets are disjoint, pinned by a test, and the Milestone-2 set has exactly 9 ids.
- **Write order.** `persistAdaptiveOutput` writes `adaptiveOutput` **before** G1 can run.

## 2. The submission rule (`evaluateReportReviewEligibility`)

The rule is evaluated on the run document as read **inside** the submission transaction. A submission commits only if, at that read, all of these hold:

- (a) there is no `governanceRecord`;
- (b) there is no `adaptiveOutput`;
- (c) `status == "complete"`;
- (d) **either** a `legacyAdaptiveOutput` whose `schemaId` is a legacy id and not a Milestone-2 id, **or** no envelope and `createdAt` before 2026-11-01T21:00:29Z (#274).

## 3. Proof

**Case 1: the run commits a `reportReview`.**

By (d), either:
- its single execution chose a legacy schema, or
- it was created before #274 and its execution finished long ago (executions last at most 300 s).

So for this run:
- G1 can never run, because a legacy execution has no `persistedOutput`, and a finished execution never runs again.
- G2 never targets an existing run id.

Therefore no `governanceRecord` can appear later.

**Case 2: the run is governed (Milestone-2).**
- It never gets a non-Milestone-2 legacy envelope, by the one-schema-per-run fact.
- It is created after the cutoff, so (d) never holds for it at any moment of its life, whatever the interleaving.
- Separately, once `adaptiveOutput` is saved, (b) fails too.

So it can never commit a `reportReview`.

**Firestore concurrency.** Firestore transactions are serializable. The Admin SDK locks the documents a transaction reads, so a competing plain write waits until the transaction ends. A transaction may also be retried on contention. Either way, a committed submission's writes are based on the run as it stood at commit, not on an outdated read.

The two cases above hold for **every** state a run passes through, not just the final one, so no serial order of the writers and the submission can produce both records.

The proof does not depend on retries. A read-only (ineligible) submission simply returns its answer, and a writer that lands afterwards changes nothing about it.

## 4. Evidence (`lib/workspaces/__tests__/reportReviewExclusion.spec.ts`)

**The harness.** The real production writers run against a transactional in-memory Firestore. Attempts that write are validated at commit and retried; read-only attempts commit as-is, matching production. The writers are: `createRun`, `completeRun`, `persistAdaptiveOutput`, `persistLegacyAdaptiveOutput`, `readGovernanceRecordForInitialization` and `initializeAdaptiveGovernanceRecord`, with a complete Decision Support fixture so the real governance record is actually written.

The fake Firestore (`helpers/fakeTransactionalFirestore.ts`):
- detects read conflicts and **retries** transactions;
- enforces create-only, update-on-missing and reads-before-writes;
- applies transaction writes atomically.

**Coverage.** Every submission start point, after every prefix of every sequence, with every suffix of the remaining writer steps injected **between the submission's reads and its commit**.

| Scenario | Cases | Result |
|---|---|---|
| A: completion racing submission | included in the 40 interleavings | never both |
| B: persistence racing submission (Milestone-2 envelope, legacy envelope, failed save) | included | never both |
| C: governance initialization, and its retry, racing submission | included, plus a dedicated retry case | never both; governed runs always end with their governance record (positive control) |
| D: two simultaneous submissions | 1 | exactly one record and one event; the loser retries and returns `created: false` |
| E: commit failure, then retry; retry after a lost response | 2 | atomic (nothing applied), then exactly one record; idempotent, with no second event |

**Breaking the invariant on purpose.** Weakening the rule breaks these tests: removing (a), (b) or (d), or accepting a Milestone-2 schema id as evidence. See the mutation results in the PR.

## 5. Residual edges, documented and accepted (D-B8)

- **Excluded runs.** Non-Milestone-2 runs created after #274 without a saved legacy envelope cannot be submitted. That covers verification off, no classification, and an oversized or failed envelope write. A fixed reason is shown.
- **Old Milestone-2 runs.** A pre-#274 Milestone-2 run whose `adaptiveOutput` failed to save meets (d) through the cutoff branch. It can never gain a governance record, because its execution is finished, so the invariant still holds. It would be reviewable as a report review.

- **Copies into a Team project.** Personal Generic runs created before the cutoff and later added to a Team project get a new `createdAt` (now). Without an envelope they are therefore excluded, failing closed.

## 6. Conclusion

The invariant holds **without modifying the governed-run writer**. The owner's stop condition is not triggered, so writer-level enforcement (D-B7 option (b)) is not required.
