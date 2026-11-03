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

The adaptive audit writers in the frozen `auditLog.ts` (`writeAdaptiveAdminAuditEvent` and its assignment, panel-finalization, panel-override and export variants) write the `admin_audit_logs` rows for adaptive review, assignment, panel and export actions. They are metadata only, with no question or comment. They are left unchanged because `auditLog.ts` is frozen and the barrier does not need it: the action that triggers them is guarded. A rare post-commit metadata row landing during or after a deletion carries no research text. Verification accepts it as kept evidence and does not stamp it, because the rule is "no research text", not the `contentRedacted` flag (review round 2 m-3).

**Audit rows stay best-effort.** `writeGuardedGovernanceAuditRow` (`lib/governance/governanceAuditRow.ts`) writes the same row as the frozen `writeAuditEvent`, field for field (question trimmed, then cut to 200 characters; `at`; sanitized), and keeps its failure contract:
- it never throws, and never blocks or rolls back the caller's own write;
- a storage failure is logged with only the action, error name and error code (Phase FIRST-ADMIN-C8/C10). The injected path-carrying failure in `reviewLogRedaction.spec.ts` covers this path for research runs.

The only difference is the barrier.

**B. Update-only writers: now guarded (independent review round 2, M-2).** `update()` cannot create a document, so these could never resurrect a deleted run. But they could still *modify* research content after deletion started: for example, model output from `completeRun`, or a synthesis written after its model call. If that deletion then failed partway, the content stayed until a retry. Each now updates through `guardedResearchUpdate`, which keeps `update()`'s semantics (dotted paths; never creates a document) and adds the barrier check in the same transaction:
- `completeRun`, `markRunError`, `persistAutomatedGovernanceUpdate` (a refusal maps to `run_missing`);
- the synthesis `runs` update in `synthesize-panel` (a refusal is handled like any other failed store);
- `syncAdaptiveTeamRunProjectionAfterReview` (a refusal maps to `not_found`);
- the legacy Team decision route, for research rows (a refusal returns 404; verification rows are unchanged).

Not guarded: `normalizeRunProjectId`, an operator script that updates `projectId` only, with a `lastUpdateTime` precondition. It carries no research text.

**Report review (review round 2, M-1).** Submission, resubmission and the decision now check the tombstone as well as the mark, so a deletion that crashed after its tombstone and before its mark still blocks them.

**Path-like ids (review round 2, m-2).** `isResearchDeletedInTx`, like `assertResearchWritable`, treats an empty id or one containing `/` as deleted. The governance review route also rejects a `/` id with a 400 before any read.

**Verification of kept audit rows (review round 2, m-3).** Deletion verification now requires that no kept audit row carries research text: every free-text field is absent or redacted. A metadata-only row that never held text, landing after the redaction step, no longer holds a deletion at `incomplete`. Rows that do carry text are still redacted and verified.

**C. Transactional writers that read `runs/{R}` themselves: now guarded (independent review M-1).** Requiring the run to exist was not enough. Between the tombstone and the run's deletion, a review, vote (with its comment), assignment or assignee write could still commit. It created research-derived records after deletion had started, and an ordinary reviewer could keep the deletion reporting `incomplete`. Each of these transactions now calls `isResearchDeletedInTx(tx, db, runId, runSnap)` at the point where it already handles a missing run. In the Workspace and project writers that point comes after the membership checks, so concealment order is unchanged. In the `runs.ts` writers it is the existence check itself, before the in-transaction cross-authority guard. A caller there sees `run_missing`, which is exactly what it would see once the deletion completes, so it learns nothing new. The check reads the tombstone and the mark, and maps a deleted or deleting run to the transaction's existing missing-run result (`run_missing`, `run_not_found`, or 404 in the governance review route):
- `runs.ts`: decision, assignment, panel create, panel cancel, vote, finalize, override;
- `workspaceReviewMutations.ts`: 3 transactions;
- `workspaceReviewPanelMutations.ts`: 5 transactions;
- `resubmitWorkspaceReview.ts`;
- `setTeamRunAssignee.ts`;
- `associateRunWithProject.ts`, `associateTeamRunWithProject.ts`;
- the decision transaction in `app/api/governance/review`.

Report-review writers already refused the mark, and they also refuse a missing run. Not guarded: `adaptiveRetryAccounting.ts`. It updates usage metadata only (no research text) on the run document itself, which the deletion removes, and it requires the run to exist.

**The admin DELETE evidence row (review m-1).** For a research run, the `admin_deleted` row is written already redacted (`question: "[deleted research]"`, `contentRedacted: true`). A duplicate DELETE racing a completed deletion therefore cannot leave the question behind.

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

**Scope.** A research deletion deletes **one research run**: `runs/{runId}` and the records that depend on it.
- A successful deletion means only that. This applies to the `{ ok: true, deleted: runId }` response, the admin "delete this run" action and a purge row.
- It does **not** mean every record derived from the run is erased.
- The separately owned records in §6.1 are not deleted. Nothing in the deletion response, the job record or the admin UI says they are.

**Guaranteed by the application, for the deleted run:**
- The run document and its whole subtree are removed: report-review snapshots, cycles and events; export records; review assignments, histories and panels; governance events; and anything else under the run.
- Its `teamRuns` projections, which are a derived listing index, are removed.
- Research text in the kept audit rows (`admin_audit_logs`, `workspaceMembershipEvents`) is redacted.
- No application writer can write any of it again after the deletion starts.
- No new claim verification or Team snapshot can be created from the run.

### 6.1 Deletion boundary: what a run deletion does not erase

**Origin-linked claim verification** (`verifications/{id}`, Personal or Team)
- **Holds from the run:**
  - one claim sentence taken from the run;
  - the evidence-source references (URL and title) the run cited;
  - `origin` (`runId`, `claimId`).

  Its verdict, models and scores are its own.
- **Classification: independently owned.** A separate, explicit "verify this claim" action creates it. It runs its own model panel and produces new content.
- **Owner and access:**
  - Owned by the verification's own owner (`userId`) or its Team workspace, and read through the verification read routes.
  - Reading it never depends on the source run. After the deletion its source link resolves to nothing (`resolvePersonalSourceResearchLink` and `resolveTeamSourceResearchLink` return `null` for a missing run), and the verification still reads.
- **Deleted by:** its own deletion, `DELETE /api/admin/runs/{id}?collection=verifications` (`SYSTEM_ADMIN`). It can be found by `origin.runId`. The run deletion does not cascade to it.

**Team snapshot** (`runs/{snapshotRunId}` in a Team workspace)
- **Holds from the run:** a full copy of the run's question, results and synthesis, made when the owner explicitly chose "Add to Team".
- **Classification: independently owned, by design ("copy, never move").** It is new Team research with its own id, workspace binding, Team access rules, and review and governance records. Reading it does not read the personal source.
- **Owner and access:** the Team workspace, under Team roles.
- **Deleted by:** the same research deletion workflow, run by its own id (`SYSTEM_ADMIN`). It gets its own tombstone and full subtree deletion. It can be found through `runSnapshotLocks` (`sourceRunId` → `snapshotRunId`). The run deletion does not cascade to it.

**`runSnapshotLocks` keyed by `sourceRunId`**
- **Holds:** ids, `createdBy` and `createdAt`; no research text.
- **Classification:** a metadata index of the Team copies.
- **Access:** no client access (Firestore rules default deny).
- **Kept,** because it is how the Team copies of a deleted source are found.

**Redacted audit metadata** (`admin_audit_logs`, `workspaceMembershipEvents`, `projectEvents`, and the metadata-only adaptive audit rows)
- **Holds:** who, what, when, status and the run id. Research text is redacted or was never present.
- **Classification:** audit evidence, read by the governance and admin audit readers.
- **Kept.** No retention period is set (an open owner decision).

**Firestore managed backups and point-in-time recovery**
- **Holds:** everything, as of the backup or recovery point.
- **Outside the application;** controlled by the Google Cloud project's administrators.
- **Expires by its own retention.** The application cannot erase it, and nothing claims it does.

**Why the deletion does not cascade.** The verifications and Team snapshots are independently owned, so a cascade would delete other owners' records: a Team's research, or a verification's own result. This change does not cascade.

**Erasing every copy.** Erasing every copy of a piece of research takes:
1. the run deletion;
2. separate deletions of the verifications found by `origin.runId`;
3. separate deletions of the Team snapshots found through `runSnapshotLocks`.

Whether some cases should cascade automatically, for example a legal erasure request, is an open owner and legal decision. It would need its own reviewed change.

## 7. Tests

- **`researchDeletionBarrier.spec.ts` (fake transactional Firestore, 101 tests).**
  - Every guarded writer is tested under tombstone, mark and missing (it refuses and writes nothing), and normal (it writes exactly as before).
  - The interleaving test, run per writer: the deletion runs to completion after the writer's reads and before its commit. The writer is refused on retry, nothing is resurrected, the deletion verifies and there are no orphans.
  - Post-deletion retries.
  - Tombstone order and permanence.
  - A crash right after the tombstone, then recovery.
  - Id reuse.
  - Malformed ids.
  - Export lifecycle.
  - Verification and non-run paths are unchanged.
  - Category C (review M-1): every `runs.ts` review, panel, vote and assignment transaction refuses a tombstone or mark, with a control. The reviewer's scenario (a writer committing between the sweep and the pre-verify) is refused, and the deletion completes as `deleted`.
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
