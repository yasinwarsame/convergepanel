# Order C: project-level approvers (design only, rev 2)

**Status:** DESIGN. Implementation is NOT authorized.

**Baseline:** main `900aec72`.

**Rev 2** applies the owner rulings D-C1 to D-C5 (2026-11-02). Open decisions are in §9.

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
2. If an assignment with a reviewer already exists, **do nothing**. Explicit assignments override project defaults.
3. Otherwise, evaluate `isValidAssignmentTarget` for `reviewerUid` against this run. That covers active membership, same workspace, capabilities, and **no self-review** (`reviewerUid` must not be the run's creator).
   - **Eligible:** write an ordinary assignment through `buildNextAdaptiveHumanReviewAssignment` with `source: "project_default"` and the existing history entry, plus the audit event `workspace_research_reviewer_defaulted`.
   - **Not eligible, or no project reviewer:** write nothing. The item shows as Unassigned in Needs review, and the reason is logged without identities.

**Results:**
- one assignment document per run, so no duplicate queue entries;
- the existing queue, indexes, eligibility rules, decision routes and audit are reused unchanged;
- no new authority: the default reviewer gets exactly what a manual assignment would give.

`source` is added only to new writes. A missing value reads as `manual`.

## 4. Lifecycle (D-C3, D-C4, ruled)

| Event | Behaviour |
|---|---|
| Project reviewer changes A → B (D-C3) | Reassign only assignments that are pending, have `source: "project_default"`, and belong to research in this project. Re-check each against B (eligibility, self-review). If B is ineligible for a run, clear that default assignment so it becomes Unassigned. Never touch manual assignments, completed decisions or history. Work in bounded transactional batches, with one audit event per item. The confirm dialog shows a dry-run count. |
| Project reviewer cleared | The same batch clears pending project-default assignments, which become Unassigned. History is kept. |
| Research moves P → Q (D-C4) | Inside `associateTeamRunWithProject`'s existing transaction: if the current assignment is pending with `source: "project_default"`, clear it, then apply Q's reviewer under §3 (with eligibility and self-review checks) and audit both steps. Manual assignments stay under existing rules. |
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
| Unchanged | Queue queries and indexes, decision routes, eligibility functions, capabilities, `assigneeUids`, `runs.assigneeUid`. |

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

## 10. Sequencing

The order is B1 and C1 together, then B2 and C2, then B3 and C3, as follows:

1. **C1:** model, reviewer route and audit (dark).
2. **B1:** submission (dark).
3. **C2:** applier wired into B's submit route and "Request approval", plus the D-C3 and D-C4 lifecycle (dark), with tests and an independent review.
4. **C3:** UI.

Then canary on one workspace and enable alongside B3.
