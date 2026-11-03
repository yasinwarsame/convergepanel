# Research deletion integrity: the deletion barrier

Status: owner-authorized correction (2026-11-03), part of PR #287. Development only. Nothing is merged, deployed or activated.

## 1. Invariant

Once a deletion of run R has been requested, no application writer may create or modify R's research content or anything derived from it. That covers:
- the run document and any document in its subtree;
- snapshots, cycles and events;
- export records;
- governance and review records;
- Team projections;
- audit rows carrying research text.

A writer that started before the deletion and commits after it must not resurrect anything. Delayed work and retries fail closed. Post-deletion detection (`findResearchDeletionOrphans`) remains as a **recovery** tool. It is not the guarantee.

## 2. The barrier

**Tombstone.** The tombstone is `runDeletionJobs/{runId}`, the deletion job record.
- `deleteResearchRun` writes it as its **first** step, before the mark, the sweep or any delete. A test pins this order.
- No server path deletes it, and a test pins that the workflow never deletes it. It never expires.
- It is keyed by the run id, so it survives deletion of `runs/{R}`.
- Its **existence** is the barrier. Its state (`in_progress`, `failed` or `complete`) does not matter, so even a deletion that crashed right after writing the tombstone already blocks every writer.
- Clients cannot read or write it: `firestore.rules` default-denies everything not explicitly allowed, and no rule names it. All run ids are server-generated (`run-<uuid>`), so client input cannot choose or reuse one.

**Check.** `assertResearchWritable(tx, db, runId)` (`lib/firestore/researchDeletionBarrier.ts`) reads the tombstone and `runs/{R}` **inside the writer's own transaction**, before its writes. It refuses, with `ResearchWriteRefusedError`, when:
- the tombstone exists (`deleted`);
- the run carries the deletion mark (`deleting`);
- the run document does not exist (`missing`). This also covers runs deleted before tombstones existed. No guarded writer creates a run.

Helpers move a plain write into such a transaction unchanged: `runResearchWrite`, `guardedResearchSetMerge`, `guardedResearchAdd`, `guardedResearchCreate`. `guardedResearchCreate` keeps `create()` exclusivity: it reads the document in the same transaction and returns `already_exists`.

**Why it is race-free.** Firestore transactions are serializable. The tombstone and run reads are in the writer's read set, so the writer commits only if neither changed before its commit. For a guarded writer W and a deletion D of the same run, exactly one of these holds:
1. **W serialized before D's tombstone.** Every step of D that removes content runs after the tombstone: mark, sweep, redaction, pre-verify, run delete, re-sweep, final verify. W's documents therefore already exist when D sweeps and verifies, and D deletes or redacts them.
2. **W runs after the tombstone exists**, and refuses. It writes nothing.

A long model call, a render or a delayed retry is case 2, because the check is in the commit transaction, not in a preliminary read, UI state or cache.

**How refusal looks to callers.** Every guarded writer already had a failure result, and a refusal uses it, so no caller changes shape:
- `saved: false` / `write_failed`, `written: false`, `status: "failed"`;
- `transaction_failed`, `source_not_found`;
- a non-blocking `null` from governance evaluation;
- 404 on the admin override;
- a throw from `saveClaimVerification`, as on any Firestore failure.

Nothing is silently recreated.

## 3. Writer inventory

The audit covered every server write in `lib/` and `app/`. The repository has no cron routes, no `after()` / `waitUntil`, no Cloud Functions and no client writes to run data. Client writes go only to `users/{uid}`.

**A. Writers that could create content after deletion: now guarded.**

| Writer | What it writes | Change |
|---|---|---|
| `runs.ts` `persistAdaptiveOutput`, `persistLegacyAdaptiveOutput` | full adaptive answer, set-merge after model calls | guarded set-merge |
| `runs.ts` `persistGovernanceRecord` | receipt, set-merge | guarded set-merge |
| `runs.ts` `writeAdaptiveGovernanceEvent`, `writeAdaptiveHumanReviewEvent` | `governanceEvents` add | guarded add |
| `runs.ts` `createAdaptiveHumanReviewHistory`, `…AssignmentHistory`, `…PanelFinalizationHistory`, `…PanelOverrideHistory`, `writeAdaptivePanelFinalizationGovernanceEvent`, `writeAdaptivePanelOverrideGovernanceEvent` | post-commit history and event creates (including the call after the report-review submit transaction) | guarded create |
| `teamRuns.ts` `createAdaptiveTeamRunProjection` | Team projection with the receipt conclusion | guarded create |
| `teamGovernancePipeline.ts` `applyTeamGovernancePipeline` | `teamRuns` row with question and claims; `runs.teamGovernance` set-merge | guarded, when a `runId` is given. Verification-only rows are unchanged |
| `evaluateAndStore.ts` `evaluateAndStoreGovernance` (fire-and-forget after synthesis) | `runs` status set-merge, `governanceEvents` add, `admin_audit_logs` row with the question | for `runs`: status and event in one guarded transaction, then the audit row in its own guarded transaction (best-effort, see below). Other collections unchanged |
| `app/api/governance/review` | post-commit audit row (question, comment) and `governanceEvents` (comment) | for `runs`: each in its own guarded transaction after the decision commits. If refused, the decision had committed before the deletion and is removed by it. Event errors still propagate as before |
| `app/api/admin/runs/[runId]` PATCH | `governanceReviewComment` set-merge and audit row (question) | for `runs`: the override in a guarded transaction, from the run read inside it, then the audit row in its own guarded transaction. Refused runs get 404 |
| `app/api/governance/audit/backfill` | `admin_audit_logs` set-merge (question, comment) from a stale read; could **un-redact** a row | for `runs`: guarded set-merge. Refused runs are skipped |
| `adaptiveExports.ts` `createAdaptiveExportRecord`, `markAdaptiveExportReady`, `markAdaptiveExportFailed`, `supersedeOlderAdaptiveExports` | export record holding the full `reportSnapshot`, counter, lifecycle stubs | guarded (Order 6 exact-file exception, §4) |
| `verifications.ts` `saveClaimVerification`, `teamClaimVerifications.ts` `saveTeamClaimVerification` (origin-linked only) | new verification copying the source run's evidence sources | the source run is checked in the save transaction. A deleted source refuses the save |
| `teamRunSnapshots.ts` `createTeamRunSnapshotFromPersonal` | a new Team run copied from a personal source | a source that is deleted or being deleted is `source_not_found` (concealed, as for a missing source) |

The adaptive audit writers in the frozen `auditLog.ts` (`writeAdaptiveAdminAuditEvent` and its assignment, panel-finalization, panel-override and export variants) write the `admin_audit_logs` rows for adaptive review, assignment, panel and export actions. They are metadata only, with no question or comment. They are left unchanged because `auditLog.ts` is frozen and the barrier does not need it: the action that triggers them is guarded. A rare post-commit metadata row landing after a completed deletion carries no research text. Detection flags it (it lacks `contentRedacted`) and a re-run marks it.

**Audit rows stay best-effort.** `writeGuardedGovernanceAuditRow` (`lib/governance/governanceAuditRow.ts`) writes the same row as the frozen `writeAuditEvent`, field for field (question cut to 200 then trimmed, `at`, sanitized), and keeps its contract:
- it never throws, and never blocks or rolls back the caller's own write;
- a storage failure is logged with only the action, error name and error code (Phase FIRST-ADMIN-C8/C10). The injected path-carrying failure in `reviewLogRedaction.spec.ts` covers this path for research runs.

The only difference is the barrier.

**B. Update-only writers.** These cannot create a document: `update()` fails `NOT_FOUND` on a missing document.
- `completeRun`, `markRunError`, `persistAutomatedGovernanceUpdate`;
- the synthesis `runs` update;
- `normalizeRunProjectId`;
- `syncAdaptiveTeamRunProjectionAfterReview`;
- the legacy Team decision route.

An update landing while deletion is in progress modifies a document that the deletion then removes. After the run document is gone, these updates fail.

**C. Transactional writers that read `runs/{R}` and require it to exist.** These are review, panel, vote, assignment, decision, resubmission, project association, assignee, retry accounting and report review. They cannot recreate a deleted run.
- One that commits before the mark is case 1 in §2.
- One that commits during the deletion window is caught by the pre-verify or the post-delete re-sweep. At worst the deletion reports **incomplete** and is retried. It is never reported as done.

Report-review writers additionally refuse the mark.

**Not run-scoped, or operator-only.** These were reviewed and need no barrier:
- `projectEvents` rows (metadata only);
- the operator seed script (fixed ids, guarded CLI);
- `governanceBackfill.ts`, which has no production caller;
- the four review-artifact repair modules, which have no production caller.

## 4. Order 6 exact-file exception: `lib/firestore/adaptiveExports.ts`

**Why an outside correction is not equally strong.**
- The export write happens inside this file's own transaction (`createAdaptiveExportRecord`) and its plain set-merges.
- The six export routes that call it are also byte-pinned.
- The Admin SDK bypasses security rules.

No code outside the file can make that write atomic with the barrier. A compensating delete after the write leaves a window, and a crash in that window leaves resurrected content. That fails requirement 3. So the change is necessary.

| | Before | After |
|---|---|---|
| sha256 | `4385a42a3d447ccd846fa1b2e08a5816c8120e3be66e99e9191ab8a0d661bf1f` | `8e3a4199885f339d308abeb9555858a92681b59ef2ce7ce8b400c0160325aecf` |
| git blob | `d081edb861da7b89c260a3847b54706c37db0235` | `2c75ea178e2931771a5da338dd7cb75049f07cbc` |

**The change is the deletion guard only:**
- `createAdaptiveExportRecord`: the run read becomes `assertResearchWritable` in the same transaction. A missing run no longer gets a counter-only stub, and the routes already require the run to exist.
- `markAdaptiveExportReady` and `markAdaptiveExportFailed`: the same set-merge, guarded.
- `supersedeOlderAdaptiveExports`: the same query and writes, now one guarded transaction instead of query-then-batch.

Every result type, field, value, version assignment and failure code is unchanged. For a writable run, the documents written are byte-identical. A refusal returns the existing `write_failed`.

**Evidence re-established.**
- `dsExportBoundaries.spec.ts` re-pins only this entry to the new sha256, recording the old hash and blob. Every other frozen file stays pinned to 0249a4e5: `lib/env.ts`, `firestore.rules`, `auditLog.ts`, all export routes, renderers and provenance adapters.
- Order 6 provenance stays OFF. Nothing in consensus, provenance classification, certainty or review gates changes.
- The full Order 6 boundary suites run green on this head.

## 5. Tombstone retention and identifier policy

- **Retention: permanent.** A tombstone never expires, because expiry would let a delayed writer resurrect an old run.
- **Growth** is one small document per deleted run. It holds the job's state, step, attempts, actor uid, reason and timestamps, with no research content. Growth is bounded by the number of authorized deletions, which only `SYSTEM_ADMIN` can perform.
- **Identifier reuse: never.** Run ids are server-generated UUIDs, and a tombstoned id is refused even if a document is later recreated under it (tested).
- **Recovery.**
  - An interrupted deletion is resumed by run id. `DELETE /api/admin/runs/{id}` and purge both resume.
  - The tombstone blocks writers from its first write onward.
  - Re-running is idempotent, and a duplicate deletion request is safe (tested).
- **Not provided: un-delete.** Removing a tombstone is not a supported operation. A deliberate restore of deleted research would need its own reviewed design.

## 6. Privacy and deletion guarantees, and their limits

**Guaranteed by the application:**
- active research content and its snapshots, exports, review records, projections and locks are removed;
- research text in kept audit rows is redacted;
- no application writer can write any of it again after the deletion starts.

**Limits:**
- **Firestore managed backups and point-in-time recovery** keep deleted data until their own retention expires. The application cannot erase them immediately.
- **Origin-linked claim verifications that already exist** keep the source run id and evidence-source URLs. Deletion of the source run does not delete or redact them. New ones are refused once the source is deleted. Whether deletion should cascade to existing verifications is an owner decision.
- **Team snapshot copies** made before the deletion are separate Team research and are not deleted with the personal source. Their snapshot locks keyed by `sourceRunId` remain. New copies are refused.
- **`projectEvents`** rows keep the run id (metadata only).

## 7. Tests

- **`researchDeletionBarrier.spec.ts` (fake transactional Firestore, 92 tests).**
  - Every guarded writer is tested under tombstone, mark and missing (it refuses and writes nothing), and normal (it writes exactly as before).
  - The interleaving test, run per writer: the deletion runs to completion after the writer's reads and before its commit. The writer is refused on retry, nothing is resurrected, the deletion verifies and there are no orphans.
  - Post-deletion retries.
  - Tombstone order and permanence.
  - A crash right after the tombstone, then recovery.
  - Id reuse.
  - Malformed ids.
  - Export lifecycle.
  - Verification and non-run paths are unchanged.
- **`researchDeletionBarrier.emulator.spec.ts` (real Firestore emulator, 13 tests).**
  - Seven writers racing a deletion, 8 rounds each, including a stale assignment-history writer.
  - A delayed writer holding its transaction open across the deletion.
  - A delayed export completion.
  - An interrupted deletion (crash right after the tombstone), which already blocks every writer, then recovery.
  - Tombstone persistence, duplicate requests and id reuse.
  - Missing run documents.
  - A run in another workspace stays writable.
- **`backfillDeletionBarrier.spec.ts`:** the audit backfill skips deleted and deleting runs, never un-redacts a row, and refuses a write whose run got a tombstone between read and commit. Verifications are unchanged.
- **`fakeTransactionalFirestoreHooks.spec.ts`:** regression for the recursive test hook (see the diagnostics record).
- **Barrier cases in each writer's own spec:** export, verification, Team claim, Team snapshot, Team projection, governance record, events, histories, evaluateAndStore, governance review, admin PATCH. Twenty-one legacy specs moved to transactional doubles (from non-transactional stubs, or from doubles missing `create`, query reads or the tombstone collection), with assertions kept. The per-spec classification is in [`research-deletion-integrity-test-diagnostics.md`](./research-deletion-integrity-test-diagnostics.md).
- **Existing suites:**
  - S1 deletion: normal, purge, interrupted and retried, partial failure, concurrent, orphan, isolation, archive and governed;
  - report review (B1/B2/B3) and the allow-list;
  - Order 6 boundaries, including the re-pin above.
