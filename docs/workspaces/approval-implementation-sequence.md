# Approval workflow: bounded implementation sequence (Orders B then C)

**Status:** PLAN. No stage is authorized. Each stage needs its own owner implementation decision, its own draft PR, tests, an independent review, exact-head CI, a fresh human approval after the review record, and a separate owner release decision.

**Designs:**
- `approval-b-report-review-design.md` (rev 5)
- `approval-c-project-reviewers-design.md` (rev 5)

**Baseline:** main `900aec72`.

## Ground rules for every stage

- **Dark by default.** New routes and readers sit behind `REPORT_REVIEW_ENABLED` or `PROJECT_DEFAULT_REVIEWER_ENABLED`. Both are server-only and unset in Production until a separate enablement decision. While a flag is off, every new route returns the existing concealed 404.
- **Unchanged:**
  - the 9 governed result types and their writer;
  - `GovernanceRecordV1` and `parseGovernanceRecord`;
  - Decision Support and Order 6 (provenance OFF);
  - exports of governed runs;
  - Individual research;
  - Team research reporting;
  - Projects → Assigned to me (#278).
- **Every stage's regression set:**
  - the review queue specs (`reviewQueue*.spec.ts`);
  - workspace review mutations;
  - the review-context route;
  - the Team research detail;
  - #276/#277 presentation;
  - #278 assignment;
  - the Order 6 frozen suites;
  - the full suite, plus tsc and lint;
  - mutation testing on the stage's guards.
- **Prohibited in every stage:**
  - automatic submission;
  - historical migration;
  - fabricated analysis or verification wording;
  - new roles or capabilities.

## Stage B1: report-review record and submission (dark)

**Scope:**
- `ReportReviewRecordV1` with its builder and strict parser;
- `POST /runs/{R}/report-review` (D-B3a capability mapping);
- the §3 positive-evidence eligibility rule;
- the submission audit event;
- resubmission as a new cycle (§5a), with archived, create-only cycle documents.

**Acceptance criteria:**
1. Only Owner, Admin and Member, with `research.read` and `research.organize`, can submit. Reviewer and Viewer cannot, and every denial is concealed.
2. **D-B7 proof:** deterministic interleaving tests show that no run ever holds both `governanceRecord` and `reportReview`. They cover:
   - completion racing submission;
   - legacy-envelope persistence racing submission;
   - governance initialization or retry racing submission;
   - double submission;
   - submission retry after a lost response.

   **If any interleaving fails, B1 stops for an owner decision on writer-level enforcement.**
3. The eligibility table is enforced, with the exact reason codes for each D-B8 exclusion.
4. Resubmission archives the previous cycle unchanged, and the archive can't be rewritten. The new cycle starts `unreviewed` with a fresh assignment document (`source: "cycle_reset"`). A conflict on `expectedCycle` returns 409.
5. `scope` matches the saved run's fields exactly. Nothing is synthesized.
6. Mutation testing kills every eligibility condition, every capability check and the archive immutability.

## Stage B2: review page, decision, history and queue merge (dark)

**Scope:**
- `reviewContext` kinds;
- the decision route for report reviews (`isOrdinaryReviewerAuthorized`, canonical assignment, no self-review);
- the report-review history and event shape, plus the audit reader;
- the queue's dual-stream merge (§5) with versioned cursors;
- four new composite indexes, created and READY before any enablement.

**Acceptance criteria:**
1. **Merge property tests:** random datasets with dropped rows and page sizes from 1 to 25 emit every valid row exactly once, in order. No stuck pager, and `hasMore` is honest at `MAX_SCAN_ROUNDS`. The comparator is byte-wise for ISO strings.
2. Governed-run queue behaviour is byte-identical with the flag off and with it on, for runs that have no `reportReview`.
3. Decisions write only to the current cycle. Earlier cycles are never altered.
4. A run carrying both record kinds fails closed on every reader.
5. Independent review of the merge algorithm against the real Firestore SDK cursor semantics.

## Stage B3: UI, disclaimer and exports (dark, then canary)

**Scope:**
- "Submit for approval" with the purpose picker (4 fixed categories and a note of at most 280 characters);
- the unavailable-reason sentences;
- the review-page "Report review" view with earlier cycles;
- queue row label;
- export sections ("Report review" and "Previous review cycles").

**Acceptance criteria:**
1. The fixed disclaimer is present and exact on every surface, pinned by tests. No surface implies factual verification, model confidence, or analysis that is missing.
2. Accessible controls: labelled radio group, a character counter, error announcements.
3. Exports of governed runs are unchanged, compared byte for byte.
4. Owner release decision. Then enablement on one canary workspace: a separate owner decision with authenticated acceptance.

## Stage C1: project reviewer model and configuration (dark)

**Scope:**
- `projects.reviewerUid` and the `projectDefaultReviewers()` accessor;
- `POST /projects/{P}/reviewer` (`reviews.manage`, optimistic concurrency, eligibility);
- the audit event;
- a project-settings UI control, separate from Manage assignees.

**Acceptance criteria:**
1. Only Owner and Admin can configure it.
2. Eligibility is enforced: active member, same workspace, `research.read` and `reviews.submit`.
3. `assigneeUids` is never read, enforced by a structural test.
4. Optimistic concurrency conflicts are handled, and the audit event is written.

## Stage C2: materialization, request approval and lifecycle (dark)

**Scope:**
- the §3 applier (per-cycle "exists" rule, panel gate, self-review skip);
- "Request approval" for governed research (D-C6, D-C7);
- the hook into B submission and resubmission;
- the stale-default rule on every surface;
- the durable reviewer-change reassignment (pending only, manager-only resumption, revision-safe marker);
- resubmit-time re-defaulting;
- the move rule (D-C8: clear always; apply only with `reviews.manage`).

**Acceptance criteria:**
1. All 14 tests in design C §7.
2. A Member can never apply, re-apply or choose a reviewer, whether by request, move or resubmission.
3. An interrupted reassignment leaves the old reviewer with no actionable items on any view, and a retry converges on the current reviewer.
4. There are no duplicate queue entries, and manual assignments are never overwritten.

## Stage C3: UI and enablement

**Scope:**
- the "Request approval" button;
- reviewer-change confirmation with a dry-run count and "Finish reassignment";
- stale-reviewer indicators.

**Acceptance criteria:**
1. Exact copy pinned by tests. Project reviewer designation is clearly separate from responsibility assignment.
2. Owner release decision, then canary enablement. Authenticated acceptance follows.

## Order and dependencies

B1 → B2 → B3 → C1 → C2 → C3.

- C1 may run in parallel with B2 or B3, because it has no dependency on B.
- C2 needs B1, for the submission and cycle hooks.
- Each arrow is an owner decision point.
