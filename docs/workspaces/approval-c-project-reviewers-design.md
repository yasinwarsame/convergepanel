# Order C: project-level approvers (design only, rev 4)

**Status:** DESIGN. Implementation is NOT authorized.

**Baseline:** main `900aec72`.

**Rev 2** applied the owner rulings D-C1 to D-C5 (2026-11-02). **Rev 3** answers the independent design review of rev 2, which was NOT CLEAN (0 BLOCKER / 4 MAJOR / 5 MINOR / 6 NIT). The changes are marked **[R3]**. **Rev 4** answers the rev 3 re-verification, which was NOT CLEAN (0 BLOCKER / 1 MAJOR / 4 MINOR / 2 NIT). Those changes are marked **[R4]**. Open decisions are in §9.

## 1. Today

- `projects/{id}.assigneeUids` records responsibility only.
- An approval assignment is per research item, `runs/{id}/humanReviewAssignment/current`, written by `putWorkspaceReviewAssignment`:
  - the caller needs `reviews.manage` and `research.read`;
  - the assignee must pass `isValidAssignmentTarget` (active member, same workspace, `research.read` and `reviews.submit`, not the creator).
- The queue's Assigned to me view reads only these documents.
- There is no project-level reviewer.

## 2. Model: one designated project reviewer, applied on explicit submission

### D-C1: one reviewer

`projects/{id}.reviewerUid: string | null`, stored separately from `assigneeUids`.

To allow more reviewers later without a schema break:
- every reader goes through one accessor, `projectDefaultReviewers(project): string[]`, which today returns `[reviewerUid]` or `[]`;
- audit events carry `reviewerUids: string[]`.

### D-C5: who configures it

`POST /api/workspaces/{W}/projects/{P}/reviewer`:
- requires an active membership and `reviews.manage`, which today means Owner and Admin only;
- requires `projects.read`;
- body is exactly `{ reviewerUid: string | null, expectedUpdateTime }`;
- uses optimistic concurrency on the project's `updateTime`.

The target must:
- be an active member of W;
- hold `research.read` and `reviews.submit` (the ordinary review-eligibility capabilities);
- have no run-specific self-review check here (that is applied per run in §3).

The route writes the audit event `workspace_project_reviewer_changed`, carrying `projectId`, `previousReviewerUids` and `reviewerUids`.

### D-C2: when it applies

The project reviewer becomes the default reviewer only when research in the project is **explicitly submitted for approval**. Nothing is submitted silently.

| Research type | Explicit submission event |
|---|---|
| Report review (Order B) | `POST /runs/{R}/report-review` |
| Governed, Milestone-2 | A new explicit action, **"Request approval"**, at `POST /runs/{R}/request-approval`. It needs `research.organize` and a reviewable governance record. It changes no governance status; it only applies the project default. |

Milestone-2 research keeps its existing behaviour: it is already listed in Needs review, and managers can still assign reviewers manually as today. See D-C6 for the alternative.

## 3. Materialization rule

Within the submission transaction:

1. Read the project and its `reviewerUid`, plus the run's `humanReviewAssignment/current`.
2. **[R3]** If an assignment document exists **at all**, **do nothing**. That includes a cleared one, with `assignedReviewerUserId: null` and revision > 0, which is what DELETE leaves (`workspaceReviewMutations.ts:422-433`).
   - Explicit assignments override project defaults.
   - A manager's deliberate unassignment is also an explicit decision, so a Member pressing "Request approval" can never re-apply a reviewer a manager removed.
   - The default is applied once per run: only where no assignment document has ever been written.
   - **Open-panel gate:** materialization is skipped when `readPanelGate` reports an open review panel (`workspaceReviewMutations.ts:83-90`), the same rule as manual assignment.
3. Otherwise, evaluate `isValidAssignmentTarget` for `reviewerUid` against this run. That covers active membership, same workspace, capabilities, and **no self-review** (`reviewerUid` must not be the run's creator).
   - **Eligible:** write an ordinary assignment through `buildNextAdaptiveHumanReviewAssignment` with `source: "project_default"` and the existing history entry, plus the audit event `workspace_research_reviewer_defaulted`.
     - **[R3]** `assignedByUserId` is the submitting member, as the actor who triggered it. The history entry and the audit event also carry `source: "project_default"` and the project id, so the audit trail never reads as a Member choosing a reviewer.
     - **[R3]** The submitter may be the project reviewer when they did not create the run. Self-review is defined as reviewing one's own research, and that is unchanged.
   - **Not eligible, or no project reviewer:** write nothing. The item shows as Unassigned in Needs review, and the reason is logged without identities.

**Results:**
- one assignment document per run, so no duplicate queue entries;
- the existing queue, indexes, eligibility rules, decision routes and audit are reused unchanged;
- no new authority: the default reviewer gets exactly what a manual assignment would give.

`source` is added only to new writes. A missing value reads as `manual`.

**[R3]** Any manager action on an assignment converts it to `source: "manual"`, because it is then an explicit decision. That covers a reassignment, a `dueAt` change through `buildAdaptiveHumanReviewAssignmentMetadataUpdate` (which currently spreads the existing document), and a clear. So a manager-touched item is never moved by a later project-reviewer change.

### [R3] Stale-default rule (closes the unfinished-batch gap)

A `project_default` assignment is actionable **only while** its `assignedReviewerUserId` equals the run's project's *current* `reviewerUid`. **[R4]** It is enforced on **every** surface that derives assignment state:
- the Assigned to me and Overdue scans;
- **the status views** (Needs review, Changes requested, Recently approved), where `deriveAssignmentSummary` returns the existing `"needs_reassignment"` state and `isAssignedToMe: false` for a stale default (`reviewQueue.ts:144`, `:296`);
- the review page context;
- the decision route, inside its transaction.

Each scan uses one batched `getAll` of its page's projects.

So if a reviewer-change batch is interrupted, the old reviewer immediately stops seeing and deciding those items. The batch then only moves already-inert items to the new reviewer, and it can be resumed or retried at any time without risk.

## 4. Lifecycle (D-C3, D-C4, ruled)

| Event | Behaviour |
|---|---|
| Project reviewer changes A → B (D-C3) | **[R4]** Only items whose run is **pending** (`unreviewed` or `pending`, as defined by `isHumanReviewStatusReviewable`) and whose assignment has `source: "project_default"` are reassigned. Decided items, including `changes_requested`, are never touched; see the resubmit row. The project write records `reviewerChange: { reviewerUid: B, revision, scanCursor: null }`. Each batch transaction re-reads the project, targets the *current* `reviewerUid`, re-checks eligibility and self-review (ineligible items are cleared, becoming Unassigned), and advances `scanCursor`. The scan pages **to exhaustion** over the collection-group index (`workspaceId`, `projectId`, `assignedReviewerUserId`, `assignedAt`). Status and `source` are checked per item, so a batch where everything is filtered out still advances the cursor and does not finish the job. The marker is cleared only when the scan is exhausted **and** `reviewerChange.revision` still matches, so a newer change is never lost. **Resumption only ever runs under a manager's authority**: the reviewer-change endpoint itself, or a "Finish reassignment" action or the project settings load by a caller holding `reviews.manage`. The actor and audit attribution are that manager. The review queue stays read-only and never writes. Until reassignment finishes, the stale-default rule keeps items inert everywhere. |
| **[R4]** Resubmission of a `changes_requested` item | Inside the existing resubmit transaction (`resubmitWorkspaceReview.ts`): if the assignment's `source` is `project_default` and its reviewer is not the project's current `reviewerUid`, apply the current project default under §3's eligibility and self-review checks, or clear it if none is eligible. This happens before the item becomes pending, with audit. Manual assignments are untouched. This is how decided items reach the current reviewer without the reviewer-change batch touching decisions. |
| Project reviewer cleared | The same batch clears pending project-default assignments, which become Unassigned. History is kept. |
| Research moves P → Q (D-C4) | **[R4]** The move clears every `project_default` assignment derived from P whose run is pending **or** `changes_requested`. That leaves no retained old-project automatic assignment (D-C4) and does not alter any decision. Approved and rejected runs keep their assignment as history. The move's own clear is not a manager decision, so it does not trigger §3's "exists at all" block for Q's default. A **manual** or manager-cleared assignment (`source: "manual"`) is never changed by a move and still blocks Q's default. **[R3]** A move authorizes only `research.organize` (`associateTeamRunWithProject.ts:167-171`), which Members hold. If a move could *apply* Q's reviewer, a Member could pick a reviewer by choosing the project, which is authority Members don't have today. Rev 3 therefore splits it. (1) The move always **clears** a pending `project_default` assignment derived from P, satisfying D-C4's "do not retain". (2) It **applies** Q's default only when the mover holds `reviews.manage`. Otherwise the item becomes Unassigned in Needs review for a manager (D-C8). Every read happens before any write in the transaction, including Q's reviewer membership. The move transaction's documented invariants (projection-only, no revision bump, no history) are explicitly superseded for this branch only. Audit stays post-commit and best-effort, as everywhere else in this codebase, so "transaction-safe" covers the authorization and state change, not the audit write. **[R4]** A run whose assignment document was never written, or was project-default and cleared by this move, receives Q's default only under the same `reviews.manage` rule. A manager-cleared item stays Unassigned. |
| Assigned reviewer loses access, is removed, or changes role | The existing stale rule hides it from their Assigned to me. Managers see "Needs reassignment". The project's `reviewerUid` shows as stale in the project UI and is never applied to new submissions while ineligible. |
| Review completed | Leaves pending views by status, as today. The assignment and its history remain. |
| Cross-workspace | Impossible. The reviewer and the run must share `workspaceId`, which is checked in every transaction. |

## 5. Rules carried through

- No self-review.
- No duplicate queue entries.
- No escalation through assignment.
- Explicit assignments override project defaults.
- Existing approval records and decisions are preserved.
- Every write is audited.

`assigneeUids` (responsibility) is never read by any part of this design. A structural test enforces that.

## 6. Changes, by component (implementation phase only)

| Component | Change |
|---|---|
| `ProjectV1` | Optional `reviewerUid`. The well-formedness check is not tightened. |
| `lib/workspaces/projectDefaultReviewer.ts` (new) | Accessor, pure decision function, transactional applier and batch reassigner. |
| Routes | `POST /projects/{P}/reviewer` (new). `POST /runs/{R}/request-approval` (new, governed research). The Order B submit route calls the applier. |
| `associateTeamRunWithProject` | Adds the D-C4 re-evaluation inside its existing transaction. |
| Assignment documents | Optional `source`. |
| UI | A "Project reviewer" control in project settings, separate from Manage assignees, with copy stating it assigns approval work. A "Request approval" button on governed research. |
| Unchanged | Eligibility functions, capabilities, `assigneeUids`, `runs.assigneeUid`. **[R3]** The queue scans and the decision route gain only the stale-default check, and no new index is needed. |

## 7. Tests required (implementation phase)

1. Explicit submission with a project reviewer creates one ordinary assignment, and it appears in Assigned to me.
2. Without submission, nothing is assigned.
3. Project assignees never receive review work.
4. An existing manual assignment is never overwritten.
5. A reviewer change moves only pending project-default items, with eligibility and self-review re-checked.
6. A completed decision is untouched.
7. A move P → Q clears the P default and applies the Q default.
8. The self-review case is skipped and the item shows as Unassigned.
9. A removed or ineligible reviewer is hidden (stale rule) and not applied to new submissions.
10. No cross-workspace effects.
11. Queue pagination and counts are unchanged.
12. Projects → Assigned to me (#278) is unchanged.
13. Audit events fire for each write.
14. Concealed denials for every new route.

## 8. Risks and rollback

| Risk | Mitigation |
|---|---|
| Bulk reassignment surprises | Dry-run count, bounded batches, per-item audit. Only pending project-default items are affected. |
| A partial batch failure | Each batch is its own transaction. A retry resumes the work and is idempotent, because it only touches items whose `source` is still `project_default` with the old reviewer. |
| Hidden authority | None. Every assignment passes the existing eligibility function, and the reviewer still needs `reviews.submit`. |
| Rollback | Server flag `PROJECT_DEFAULT_REVIEWER_ENABLED`. When off, the routes return a concealed 404, no new materialization happens, and existing assignments remain ordinary valid assignments. |

## 9. Remaining owner decisions

- **D-C6:** for governed (Milestone-2) research, require the explicit "Request approval" action to apply the project default (recommended, consistent with D-C2), or apply it automatically at governance-record creation. The latter is not "silent submission", because governed research is already reviewable, but it is an automatic assignment.
- **D-C7:** who may press "Request approval" on governed research. Proposed: `research.organize` (Owner, Admin, Member), the same as Order B submission.
- **[R3] D-C8:** on a move P→Q, apply Q's default reviewer only when the mover holds `reviews.manage` (recommended, which prevents Members choosing reviewers by moving research), or for any mover with `research.organize`, as rev 2 literally said.

## 10. Sequencing

The order is B1 and C1 together, then B2 and C2, then B3 and C3, as follows:

1. **C1:** model, reviewer route and audit (dark).
2. **B1:** submission (dark).
3. **C2:** applier wired into B's submit route and "Request approval", plus the D-C3 and D-C4 lifecycle (dark), with tests and an independent review.
4. **C3:** UI.

Then canary on one workspace and enable alongside B3.
