# Order B: human approval for Generic and other non-Milestone-2 research (design only, rev 2)

**Status:** DESIGN. Implementation is NOT authorized.

**Baseline:** main `900aec72`.

**Rev 2** applies the owner rulings D-B1 to D-B5 (2026-11-02). The open decisions are in §10.

## 1. Today

- **Which runs get a review record.** A run gets `runs/{id}.governanceRecord` (`GovernanceRecordV1`) only when it produced a Milestone-2 envelope, which covers 9 result types. The record is created by `initializeAdaptiveGovernanceRecord`, inside `if (adaptiveOutput.persistedOutput)` in `lib/runPanelExecution.ts`. Generic and the 9 other legacy-active types never get one.
- **Shape limits.** `GovernanceRecordV1.schemaId` is limited to the Milestone-2 ids. Its `decisionReceipt` is required and is built from the adaptive analysis.
- **Shared readers.** `parseGovernanceRecord` is shared by:
  - the Approval Queue and the review page;
  - the decision, override, resubmit and panel routes;
  - the Team review summary;
  - exports, Decision Support wording and the Order 6 surfaces.
- **Decision UI.** The reviewer decision UI requires a usable receipt.
- **Consequence.** A run without that record cannot be assigned a reviewer, and never appears in Needs review or Assigned to me.

## 2. What approval means (D-B1, ruled)

A report-review approval means:

> The report was reviewed and found acceptable for an explicitly stated purpose.

It does **not** certify:
- factual correctness;
- claim verification;
- model confidence;
- that missing AI analysis exists.

**Approval purpose.** The purpose is structured, with an optional short explanation of at most 280 characters, shown as plain text. Proposed values (owner to confirm, §10):

| Value | Shown as |
|---|---|
| `internal_discussion` | Internal discussion |
| `team_decision_input` | Input to a team decision |
| `external_sharing` | Sharing outside the team |
| `record_keeping` | Record keeping |
| `other` | Other (explanation required) |

**The purpose cannot redefine approval.**
- It is stored and displayed only as context.
- No code path branches on it for authorization, governance status or export content.
- The disclaimer is fixed text. It is rendered next to every approval and pinned by tests: the review page, the Team summary, queue rows, exports and the audit trail.
- The explanation can never replace or suppress the disclaimer.

## 3. Data model: a separate record (D-B5, ruled)

The new record is `runs/{id}.reportReview` (`ReportReviewRecordV1`). It never touches or widens `GovernanceRecordV1`.

```ts
{
  version: 1,
  kind: "report_review",
  // What the saved run actually has, copied at submission. Never synthesized, never upgraded later.
  scope: {
    schemaId: string | null,                    // e.g. "generic"; null when not recorded
    unifiedAnswer: "present" | "absent",
    synthesis: "present" | "absent",
    consensus: "present" | "absent",
    respondedModels: number,
    requestedModels: number,
  },
  purpose: { code: "internal_discussion" | "team_decision_input" | "external_sharing" | "record_keeping" | "other", note: string | null },
  humanReview: { /* same statuses and fields as GovernanceRecordV1.humanReview */ },
  submittedAt: string, submittedByUserId: string,
  createdAt: string, updatedAt: string,
}
```

**Invariants:**
- **Exclusive with `governanceRecord`.** A run has at most one of the two. Submission refuses a run that already has a `governanceRecord`. Run completion for Milestone-2 types refuses to create a `governanceRecord` when a `reportReview` exists, which can only happen if the run was unfinished; it fails closed and logs.
- **No receipt and no fabricated analysis.** There is no conclusion, confidence, consensus, citation or evidence. `scope` is copied from saved fields only, and the review page shows the saved report with its existing missing-analysis notices.
- **Canonical status checks.** A new parser, `parseReportReviewRecord`, sits next to `parseGovernanceRecord`. It is strict, fails closed, and reuses `isHumanReviewStatusReviewable` for the status vocabulary.

## 4. Submission (D-B2, D-B3, ruled)

**Explicit only.** `POST /api/workspaces/{W}/runs/{R}/report-review`. New research is never submitted automatically.

**Exact capability mapping (D-B3):**

| Requirement | Rule |
|---|---|
| Identity | Authenticated caller with an active membership in W, through `authorizeTeamWorkspaceMutationInTransaction`. |
| Capability | `research.read` AND `research.organize`. Today that is Owner, Admin and Member. Reviewer and Viewer cannot submit. |
| Research access | The run passes `resolveWorkspaceReviewTarget` for W: same workspace, a valid creator, a valid project reference. |
| Run state | Complete, with saved model output. No `governanceRecord`, no `reportReview`. No open review panel. |
| Body | Exactly `{ purpose: { code, note } }`, validated. |
| Effect | One transaction creates the record (`humanReview.status: "unreviewed"`) and writes an audit event, `workspace_report_review_submitted`. If Order C ships, the project default reviewer is applied in the same transaction. |
| Concealment | Every denial maps to the existing concealed 404 or 403 shapes. |

Read-only access never confers submission. Being the run's creator adds nothing beyond `research.organize`.

## 5. Queue: bounded combined query (D-B5, ruled)

### Assigned to me and Overdue

No query change. Both read the shared `humanReviewAssignment/current` subdocument. Only `revalidateRun` changes, so that it accepts a reviewable `reportReview` as well as a `governanceRecord`. Each run carries at most one record, so it is listed at most once.

### Needs review, Changes requested, Recently approved

These become two `runs` queries over the same collection, with mutually exclusive predicates and an **identical total order**:

- Q1: `workspaceId == W` AND `governanceRecord.humanReview.status in S`, ordered by `createdAt desc`, then `__name__ desc` (unchanged).
- Q2: `workspaceId == W` AND `reportReview.humanReview.status in S`, with the same ordering.

### Why pagination stays complete and stable

1. The cursor is the last *emitted* `(createdAt, docId)`, which is the existing `ReviewQueueCursor` format.
2. Both queries `startAfter` that same position and fetch `limit + 1`.
3. The results are merged by the same comparator, and the first `limit` are emitted.
4. `hasMore` is true if either stream has an unemitted row.

Because both streams are subsets of one collection under one complete order, and no run can match both predicates (the §3 exclusivity invariant):
- every row is emitted exactly once;
- no row is skipped between pages.

The behaviour under concurrent writes is identical to today's single query.

### Cost and indexes

- Cost: two bounded reads per page.
- Indexes: two new composite indexes on `runs` (`workspaceId`, `reportReview.humanReview.status`, `createdAt desc`), with and without `projectId`.
- Shared status field: none.
- Historical records: untouched.

If testing finds a case where (1) to (4) cannot hold, implementation stops and returns to the owner, as ruled.

### Recently approved

Today this view orders by `governanceRecord.humanReview.reviewedAt`. Q2 orders by `reportReview.humanReview.reviewedAt`, with the same merge rule. The cursor format already carries its sort kind.

## 6. Review, decision and display

- **`reviewContext`:** returns `kind: "governance" | "report_review"`. For a report review it returns `scope`, `purpose` and `humanReview`.
- **Decision route:**
  - The same statuses, comment and conditions as today.
  - It requires the same reviewer eligibility as today: `isValidAssignmentTarget`, no self-review.
  - No receipt requirement.
  - The §2 disclaimer is stored nowhere, because it is fixed text, but it is rendered everywhere.
- **Display:**
  - The Team detail page shows "Submit for approval" (for callers with `research.organize`) in place of the #281 notice.
  - After submission it shows the report-review status, purpose and disclaimer.
  - Queue rows carry a "Report review" label.
- **Exports:** a new "Report review" section with status, reviewer, date, purpose, conditions and the disclaimer. Milestone-2 export sections are unchanged.

## 7. Historical research (D-B4, ruled)

- **No automatic backfill.** Older research is unchanged.
- **Opt-in path** (needs separate authorization): the same per-run "Submit for approval" action works on older runs. It is audited, explicit, and touches only the one run.
- Any bulk path would be a separately reviewed migration.

## 8. Unchanged

- `GovernanceRecordV1` and `parseGovernanceRecord`.
- Automated governance and decision receipts.
- Decision Support and Order 6.
- Milestone-2 flows.
- Reviewer eligibility, roles and capabilities: no new capability.
- Concealment.
- `assigneeUids` and `runs.assigneeUid`.

## 9. Risks, mitigations and rollback

| Risk | Mitigation |
|---|---|
| Approval read as fact-checking | Fixed disclaimer on every surface, with pinned tests. The purpose cannot alter it. |
| A run ends up with both record kinds | Exclusivity checks on both writers, plus a structural test. The queue revalidation treats "both present" as an integrity failure and fails closed. |
| Pagination defects in the merged view | Property-style test: random interleavings and page sizes give each row exactly once, in order. Mutation testing on the merge comparator and cursor. |
| Authority widening | Uses existing capabilities only. Reviewer and Viewer cannot submit. Eligibility is unchanged. |
| New indexes not ready at launch | Indexes are deployed and READY before the flag is enabled. Until then, the second query is off. |
| Rollback | Server flag `REPORT_REVIEW_ENABLED`. When off, the submit route returns the concealed 404, Q2 is skipped, and `reviewContext` ignores `reportReview`. Records stay in place, inert. |

## 10. Remaining owner decisions

- **D-B1a:** confirm the five purpose values and the 280-character note limit.
- **D-B3a:** confirm that Member (with `research.organize`) may submit, alongside Owner and Admin.
- **D-B6:** whether a decided report review (approved, rejected or changes requested) can be resubmitted. Proposed: yes, through the existing resubmit semantics, which return it to `pending` with audit.

## 11. Milestones

1. **B1:** record, parser, submit route, audit and exclusivity (dark), with tests.
2. **B2:** review context, decision route and queue merge (dark), with property tests and an independent review.
3. **B3:** UI and exports. Indexes deployed. Canary on one workspace, then enable.
