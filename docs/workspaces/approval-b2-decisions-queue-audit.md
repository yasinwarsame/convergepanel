# Stage B2: report-review decisions, combined Approval Queue, and audit (dark)

**Scope.** Owner-authorized Stage B2 (2026-11-03), stacked on B1 (#284).

**Status.** Report Review stays OFF. The switch is the compile-time `false` in `lib/workspaces/reportReviewRollout.ts`.

## 1. Decision contract (server-authoritative, shared with the UI)

The contract lives in `lib/governance/reportReviewDecision.ts` (`evaluateReportReviewDecisionAuthority`). It is used by:
- the decision transaction (`lib/workspaces/reportReviewDecisionMutation.ts`);
- the read context (`GET …/report-review`), whose `viewer.canDecide` and `denial` the B3 UI will render.

A decision requires **all** of the following:

| Requirement | Enforced by |
|---|---|
| Active member of this workspace; `reviews.submit` AND `research.read` | the transactional authorizer + role check |
| The run is bound to this workspace; no open review panel | `resolveWorkspaceReviewTarget`, `readPanelGate` |
| A valid `reportReview`, and **no** `governanceRecord` (a run with both fails closed) | in-transaction read |
| Expected cycle and expected `updatedAt` match (OCC) | in-transaction read |
| The cycle is open (`unreviewed` or `pending`); a decided cycle is never re-decided | contract |
| The caller holds the current canonical assignment, and that assignment is not tagged for another cycle | contract |
| Not the run creator (`isOrdinaryReviewerAuthorized`, self-review) | contract |
| **Not the report-review submitter** | contract (closes the B1 carry-over) |

**Submitter guard at assignment time.** The submitter can never be assigned as reviewer of their own report review.

**Retries.** A retry after a lost response, by the same reviewer with the same status, returns the committed decision (`replayed: true`) and writes nothing.

**Error responses.** Every "not authorized" sub-reason collapses to the same 403 as the governed decision route.

## 2. Combined Approval Queue

| View | Report Review OFF (Production today) | Report Review ON |
|---|---|---|
| Needs review, Changes requested, Recently approved | Unchanged single governed scan; version-1 cursors | Merged scan over two `runs` streams (governed + report review). One total order: sort value desc, then document id desc. Frontier rule; cursor = last **consumed** position; version-2 cursors |
| Assigned to me, Overdue | Unchanged | The same assignment-driven scans. Revalidation accepts report reviews; the submitter is excluded |

**Rules in the merged mode:**
- A cursor is bound to its workspace, view, project filter **and mode**. A version-1 cursor in merged mode, or the reverse, returns 400.
- A run carrying both records is never listed while Report Review is on.
- A report review assigned to its submitter shows as `stale`, never `actionable`.
- Report-review rows carry `recordKind: "report_review"`. Governed rows are byte-identical to before.
- A failed query returns an explicit 500, never a silently truncated page.

**Indexes.** Four composite indexes are declared in `firestore.indexes.json`: (`workspaceId`[, `projectId`], `reportReview.humanReview.status`, `createdAt` | `reportReview.humanReview.reviewedAt` desc). They are **not deployed**; deploying them is a precondition for enablement.

### Evidence

The same scenario module (`__tests__/helpers/reviewQueueScenario.ts`) runs on two backends:
- the fake, in CI (`reportReviewQueue.spec.ts`);
- the **real Firestore emulator** (`reportReviewQueue.emulator.spec.ts`), with real query, cursor and transaction semantics. Composite indexes are not enforced there.

What the scenarios cover:
- Every status view at page sizes 1–25 (fake) and 1, 2, 3, 5, 25 (emulator). Every eligible item appears exactly once, in reference order.
- Ties within and **across** streams, resolved by document id.
- Rows dropped after fetching: malformed records, both records, another workspace.
- Concurrent new submissions and status changes between pages. No duplicates, no stable item missed, insertions after the cursor included.
- Assigned to me for the reviewer and the submitter.
- Report Review OFF reproduces the legacy behavior exactly.

**Real contention (emulator).**
- 5 simultaneous submissions produce exactly 1 record and 1 event.
- 5 simultaneous decisions produce exactly 1 decision and 1 decided event.

## 3. Audit: what is recorded where

| Event | Durable record (written in the **same transaction** as the change; write-once `tx.create`) | Workspace Audit Log (`workspaceMembershipEvents`, shown in the Audit UI) |
|---|---|---|
| Submission (B1) | `runs/{R}/reportReviewEvents` `report_review_submitted` | **Not yet** (B3) |
| Resubmission / new cycle (B1) | `report_review_resubmitted`, plus the archived cycle `runs/{R}/reportReviewCycles/{n}` with its record and assignment | **Not yet** (B3) |
| Cycle-reset unassignment (B1) | `humanReviewAssignmentHistory` (post-commit, best-effort, like every assignment writer) | n/a |
| Decision (B2) | `report_review_decided`: cycle, prior and new status, reviewer, timestamp, purpose, comment present, condition count | **Not yet** (B3) |
| Reviewer assign / reassign / clear on a report-review run (B2) | `report_review_assignment_changed`: cycle, before, after, revision, actor, timestamp | **Not yet** (B3) |
| Reviewer assignment on a governed run | Unchanged: assignment history, post-commit | Unchanged |

**Durability.** The run-level events are durable: if an event cannot be written, the decision or assignment change is not written either.

**Visibility gap for B3.** These events are **not** yet visible in the Workspace Audit Log. Making them visible requires new event types in the Audit Log reader and UI. Per owner direction, decisions must not be enabled until that is done.

## 4. Mutation testing

25 of 27 mutants are killed. The two survivors are documented equivalents:

| Mutant | Why it is equivalent |
|---|---|
| Q1: consume past the frontier | The loop refills every empty, non-exhausted stream before consuming, so the next row is never past the frontier. |
| Q6: stream/kind check | Revalidation already drops every run whose records disagree with its stream. |

Both checks are kept, so that a future change fails safe.
