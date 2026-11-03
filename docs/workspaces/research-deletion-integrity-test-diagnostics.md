# Research deletion integrity: test diagnostics record (2026-11-03)

This is the record of the owner-ordered safe diagnostic pass on the #287 deletion-barrier correction. All commands were read-only inspections or test runs; nothing was deleted outside the worktree. A blocked shell command (a compound `for` loop chaining command substitutions, redirections and `&&`/`||` fallbacks) was **not** re-run. Each spec was inspected and run individually instead.

## 1. The recursive `afterTxReads` hook

**Symptom.** One jest worker ran at 100 % CPU with memory above 4 GB, on `reportReviewExclusion.spec.ts`.

**Root cause.** `FakeTransactionalFirestore.hooks.afterTxReads` stands for other writers acting between a transaction's reads and its commit. It fired for every transaction, including transactions started inside the hook body.
- One test's hook ran the governance initializer on attempt 0.
- That initializer now writes through a deletion-barrier transaction.
- That transaction was also attempt 0, so it fired the hook again, which ran the initializer again, without bound.

Before the barrier, the initializer's writes were not transactional, so this never happened. It is a test-harness defect: production code had no loop.

**Correction** (`helpers/fakeTransactionalFirestore.ts`). The hook body runs inside an `AsyncLocalStorage` context. A transaction started from that context is not intercepted again. Writes the hook makes still commit and still bump versions, so the intercepted transaction still sees the conflict and retries. A transaction running concurrently from **outside** the hook context is still intercepted, because the guard is scoped to the hook's own async context, not a global flag.

**Regression test** (`fakeTransactionalFirestoreHooks.spec.ts`):
- a hook that runs a transactional writer terminates, and is invoked exactly once per outer attempt (`[0, 1]`);
- the outer transaction retries once and reads the injected write;
- a hook that injects on every attempt still terminates: the outer transaction aborts after `MAX_ATTEMPTS` (5), not unbounded;
- a concurrent transaction from outside the hook is still intercepted;
- with no hook, behavior and stats are unchanged.

**Effect on the exclusion test.** The one-shot workaround I first added inside the test was reverted. The test keeps its original hook (`if (attempt === 0) …`) and now also asserts the submission's transaction was the only one intercepted (`[0]`), so the injection still lands where the test intends. All 45 tests pass.

## 2. Failing specifications

**Baseline.** The same specs were run at the pre-change commit `9391b63` (a separate detached worktree) and at the correction. At `9391b63` the only failure among them is the pre-existing `workspaceReviewPanelMutations.spec.ts` merge-base test ("git agrees the change is three files"). That test also fails on `main`, because it needs a merge base absent in this checkout. Every other failure below is **new with the barrier**.

**Classes:**
- **TI** (test infrastructure): the double could not model a transaction. The production behavior is correct.
- **FX** (fixture): the test wrote for a run document it never seeded. The barrier refuses that, which is the intended behavior.
- **PIN**: a deliberate, recorded count, line or hash pin.
- **REG**: a production regression.

| Spec | Failure at the correction | Double | Tx support before | Pre-existing | Class | Fix |
|---|---|---|---|---|---|---|
| `persistAdaptiveOutput.spec.ts` | `saved:false` | `set()` spy | none | no | TI | shared transactional fake + write log; barrier cases |
| `verifications.spec.ts` | `db.runTransaction is not a function` | `set()` spy | none | no | TI | shared fake + write log; barrier cases |
| `adaptivePanelOverrideSecondaryArtifacts.spec.ts` | `status: failed` | `create()` stub map | none | no | TI + FX | shared fake; run seeded; barrier cases |
| `adaptiveHumanReviewEvent.spec.ts` | `written:false` | `add()` stub | none | no | TI + FX | shared fake; run seeded; error injected at commit; barrier cases |
| `adaptiveHumanReviewHistory.spec.ts` | `status: failed` | `create()` stub | none | no | TI + FX | shared fake; "one attempt" now asserts one commit, 0 retries; barrier cases |
| `governanceRecordPersistence.spec.ts` | `saved:false` | `set()` spy | none | no | TI | shared fake; "no other collection" now asserts the applied writes; barrier cases |
| `teamRuns.spec.ts` | `create` spy not called | `create()` stub | none | no | TI + FX | shared fake; `.create()` proven from the write log; retry asserts one attempt, no write; barrier cases |
| `evaluateAndStoreProvenance.spec.ts` | events `[]` for `runs` | path-aware set/add fake | none | no | TI | shared fake; adds two commits, a field-for-field row equivalence with `writeAuditEvent`, and barrier cases |
| `adaptiveReviewArtifactRepair.spec.ts` | `status: failed` | Map stubs | none | no | TI | shared fake via Map-shaped views (same keys) |
| `adaptivePanelFinalizationRepair.spec.ts` | `status: failed` | Map stubs | none | no | TI | same |
| `adaptivePanelOverrideRepair.spec.ts` | `status: failed` | Map stubs | none | no | TI | same |
| `persistAutomatedGovernanceUpdate.spec.ts` | `written:false` | update/add stub (update created missing docs) | none | no | TI + FX | shared fake (field-path `update`, `NOT_FOUND` on a missing doc); event runs seeded; barrier case |
| `adaptiveHumanReviewAssignment.spec.ts` | `status: failed` | single-attempt tx, tag-routed refs | partial | no | TI + FX | shared fake via views; history runs seeded; barrier case |
| `adaptiveExports.spec.ts` | `write_failed` | own OCC fake | yes, without a tombstone collection or query-in-tx | no | TI + FX | **extended** the spec's own OCC fake: tombstone collection, query reads join the read set, runs seeded per export; barrier and race cases |
| `adaptiveReviewEndToEndContract.spec.ts` | `status: failed` | single-attempt tx, id-routed | partial | no | TI | shared fake via views; panel reads from the fake's transaction read log |
| `teamClaimVerifications.spec.ts` | `transaction_failed` | buffered tx over path stores | yes, without `runs`/tombstone stores | no | TI + FX | added the two stores; source runs seeded; barrier cases |
| `teamRunSnapshots.spec.ts` | `transaction_failed` (55) | buffered tx over path stores | yes, without a tombstone store | no | TI | added the tombstone store; barrier cases |
| `systemAdminMutationRoutes.spec.ts` | `db.runTransaction is not a function` | spy handles | none | no | TI + latent test bug | buffered transaction, routed by collection. **Also found:** the spec passed route `params` as a Promise to Next 14 handlers that destructure it, so every handler ran with `runId === undefined`. The old double ignored ids; the barrier refused it. Fixed to a plain object. Audit-attribution asserts move to the guarded audit row |
| `reviewWriteAuthorization.spec.ts` | `tx.create is not a function` | recorded handles | set only | no | TI | buffered transaction with `create`; barrier cases for runs, and unchanged non-run paths |
| `assignmentDecisionAtomicity.spec.ts` | `tx.create is not a function` | own OCC fake | set only | no | TI | added `create` (ALREADY_EXISTS at commit) and auto-id `doc()` |
| `reviewLogRedaction.spec.ts` | `tx.create is not a function`, then the ANCHOR 2 log line | recorded handles | set only | no | TI **+ REG (fixed)** | see §3 |
| `workspaceReviewPanelMutations.spec.ts` | add-site count, line pins, merge-base test | — | — | merge-base **yes** | PIN + pre-existing | pins updated to the new source (3 add sites at the new lines); merge-base test unchanged (pre-existing) |
| `dsExportBoundaries.spec.ts` | sha256 of `adaptiveExports.ts` | — | — | no | PIN | owner exact-file exception: re-pinned, old hash recorded |
| `reportReviewExclusion.spec.ts` | hang | shared fake | yes | no | TI (§1) | fake corrected, regression test added |

**Rules followed in every migration:**
- No assertion removed and no test skipped.
- No deletion tombstone mocked away. Every migrated spec reads the real barrier against a store that models it.
- No production change made to suit a mock.
- Where a spy assertion became a state assertion, it asserts the same fact: same path, same write kind, same payload, same count.

## 3. The production regression found by the log-redaction suite (fixed)

The first version of the correction wrote a research run's `admin_audit_logs` row inside the **same** transaction as the status or event write, in three places: governance review, `evaluateAndStore` and admin PATCH. That changed the `writeAuditEvent` contract:
- an audit-row failure would roll back the event (review route) or the status (PATCH and evaluateAndStore);
- in the review route, the error would throw to the client;
- in `evaluateAndStore`, it would reach a raw `console.error`, which can include a document path (the C8/C10 leak class).

**Fix.** `writeGuardedGovernanceAuditRow` (`lib/governance/governanceAuditRow.ts`) writes the row in its **own** guarded transaction. It never throws and logs only the action, error name and error code, exactly like `writeAuditEvent`. Each caller's own write keeps its previous error behavior, and the review route's event errors still propagate.

`reviewLogRedaction.spec.ts` injects a path-carrying storage failure on this new path for research runs. It shows:
- the request still returns 200;
- the failure is logged by shape only;
- no identifier and no `admin_audit_logs/` path reaches the log.
