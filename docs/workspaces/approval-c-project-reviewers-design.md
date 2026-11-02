# Order C: project-level approvers (design only)

**Status:** DESIGN. Implementation is NOT authorized (owner, 2026-11-02).

**Baseline:** main `900aec72`.

**Owner target:** an explicitly assigned project reviewer finds that project's outstanding approval work under Approval Queue → Assigned to me. Project assignees (responsibility) never become approvers.

## 1. Today

- `projects/{id}.assigneeUids` records responsibility only.
- An approval assignment is per research item: `runs/{id}/humanReviewAssignment/current`, written by `putWorkspaceReviewAssignment`, which requires `reviews.manage` and `research.read`. The assignee must pass `isValidAssignmentTarget`: active member, same workspace, `research.read` and `reviews.submit`, and not the creator.
- The queue's Assigned to me tab reads only those assignment documents.
- There is no project-level reviewer concept.

## 2. Recommended model: project default reviewer, materialized as ordinary assignments

**Data:** `projects/{id}.reviewerUid: string | null`. This is one default reviewer per project, stored separately from `assigneeUids`.

**Set by:** `POST /projects/{P}/reviewer`.
- Requires `reviews.manage` and `projects.read`.
- The target must pass the same review-eligibility rule, without the creator check, which is run-specific.
- Uses optimistic concurrency on the project's `updateTime`.
- Writes a workspace audit event, `workspace_project_reviewer_changed`.

**How it reaches the queue: materialization, not a new query.**

When research in project P becomes reviewable and has no research-specific assignment, the system writes an ordinary `humanReviewAssignment/current` for P's reviewer. It does this in the same transaction and with the same history and audit as a manual assignment. The triggers are:
- a governance record or `reportReview` record is created (Order B);
- research is filed into P;
- research is resubmitted.

Each assignment records `source: "project_default"`.

The only exception is self-review. If the project reviewer created the research, nothing is assigned. The research shows as "Unassigned" in Needs review for a manager to assign, and the reason is logged.

### Why materialize

- The Approval Queue, its indexes, eligibility checks, pagination, counts and decision routes stay **unchanged**.
- Every review is assigned to exactly one person. There is no duplication and no second "derived" path to secure.
- The audit trail shows who was assigned and why.
- This is least privilege: the project reviewer can review only what was actually assigned, and only while eligible. The existing stale-assignee rule already hides an assignment after the reviewer loses eligibility.

### Rejected alternative: query-time derivation

"Assigned to me" would also list every reviewable research item in projects where I am the reviewer.

- It needs a new query, new indexes, union pagination and dedupe against explicit assignments.
- It creates a second authority path.
- Precedence becomes implicit, and audit is weak because nothing records that the person was assigned.

## 3. Precedence and lifecycle

| Event | Behaviour |
|---|---|
| Research becomes reviewable in P, no assignment exists | Assign to P's reviewer (`source: project_default`). |
| A manual research-specific assignment exists | It always wins. A project default never overwrites a manual assignment. |
| A manager reassigns manually | Normal reassignment. `source` becomes `manual`. |
| P's reviewer changes from A to B | **Recommended:** reassign only *pending, project-default* assignments from A to B, in bounded batches with audit events (D-C3). Manual assignments are untouched. |
| P's reviewer is cleared | Pending project-default assignments are cleared and return to Unassigned in Needs review. Nothing is deleted from history. |
| Reviewer removed from workspace, or loses `reviews.submit` | The existing stale rule hides the work from their Assigned to me. It shows "Needs reassignment" to managers. P's `reviewerUid` shows as stale in the project UI. |
| Review completed (approved, rejected, changes requested) | Leaves the pending queue by status, exactly as today. |
| Research moved out of P | The assignment stays as it is (it was a real assignment). Optional: clear it if `source` is still `project_default` (D-C4). |
| Cross-workspace | Impossible. The reviewer must be a member of P's workspace, and the assignment carries the run's `workspaceId`. |

## 4. Automatic or explicit submission (owner question)

**Recommended: automatic for research that is already reviewable.**

- Today, Milestone-2 runs become reviewable automatically at creation. If Order B ships with explicit "Submit for approval", report-review runs become reviewable only when submitted.
- A project default is applied at the moment research becomes reviewable, however that happens. So the project reviewer never sees unsubmitted Generic research, which keeps things least-privilege, while governed research reaches them without anyone having to remember to assign it.

**Alternative:** apply the project default only when a manager clicks "Request approval". This is more conservative but reproduces today's "forgot to assign" failure.

## 5. Changes, by component (implementation phase only)

| Component | Change |
|---|---|
| `ProjectV1` | Optional `reviewerUid`. The well-formedness check is not tightened. Absent means none. |
| New route plus UI "Project reviewer" control | Separate from "Manage assignees". Copy states that it assigns approval work. |
| New `lib/workspaces/applyProjectDefaultReviewer.ts` | Pure decision plus a transactional writer. Reuses `isValidAssignmentTarget` and the assignment builders. |
| Call sites | Governance record initialization (`runPanelExecution`); Order B submit; `associateTeamRunWithProject`; resubmit. Each is idempotent and skips existing assignments. |
| Assignment documents | Add `source: "manual" \| "project_default"` to new writes only. A missing value reads as manual. |
| Unchanged | Queue queries, indexes, decision routes, eligibility rules, `assigneeUids`, `runs.assigneeUid`. |

## 6. Tests required (implementation phase)

1. A project default creates an ordinary assignment, and it appears in Assigned to me.
2. Project assignees (responsibility) never receive review work.
3. A manual assignment wins and is never overwritten.
4. A reviewer change moves only pending project-default assignments.
5. A completed review leaves the queue.
6. The self-review case is skipped and shows as Unassigned.
7. A removed or ineligible reviewer is hidden (stale rule).
8. No cross-workspace effects.
9. Pagination and counts are unchanged.
10. Projects → Assigned to me (#278) is unchanged.
11. Audit events fire for every materialized assignment and every reviewer change.

## 7. Risks and rollback

| Risk | Mitigation |
|---|---|
| Unexpected bulk reassignment on reviewer change | Bounded batches, a dry-run count shown in the confirm dialog, audit per item, D-C3 gate. |
| Hidden authority | None added. Assignment still requires an eligible reviewer, and the reviewer still needs `reviews.submit`. |
| Partial failures | A materialization failure leaves the item Unassigned, which is today's behaviour, and logs it. It never blocks run creation. |
| Rollback | Behind the flag `PROJECT_DEFAULT_REVIEWER_ENABLED`. When off, no new materializations happen, and existing assignments remain valid ordinary assignments. |

## 8. Sequencing

- C depends on nothing in B for governed (Milestone-2) research.
- C becomes fully useful for Generic research once B ships.

Recommended order:
1. C0: decisions.
2. C1: data model, route and audit (dark).
3. C2: materialization at governance-record creation (dark).
4. C3: UI.
5. B1 to B3 (with C's hook added to Order B's submit).
6. Canary, then enable.

## 9. Owner decisions

- D-C1: one default reviewer per project (recommended), or several. Several would need round-robin or "first to claim", which adds complexity.
- D-C2: automatic application when research becomes reviewable (recommended), or explicit "Request approval".
- D-C3: on reviewer change, move pending project-default assignments (recommended) or leave them.
- D-C4: on research moved out of the project, keep (recommended) or clear project-default assignments.
- D-C5: who may set the project reviewer: `reviews.manage` (recommended: owner and admin).
