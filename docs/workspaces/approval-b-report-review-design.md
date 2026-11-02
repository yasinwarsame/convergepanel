# Order B: human approval for Generic and other non-Milestone-2 research (design only, rev 3)

**Status:** DESIGN. Implementation is NOT authorized.

**Baseline:** main `900aec72`.

**Rev 2** applied the owner rulings D-B1 to D-B5 (2026-11-02). **Rev 3** answers the independent design review of rev 2, which was NOT CLEAN (0 BLOCKER / 4 MAJOR / 5 MINOR / 6 NIT). The changes are marked **[R3]**. The open decisions are in §10.

## 1. Today

- **Which runs get a review record.** A run gets `runs/{id}.governanceRecord` (`GovernanceRecordV1`) only when it produced a Milestone-2 envelope, which covers 9 result types. The record is created by `initializeAdaptiveGovernanceRecord`, inside `if (adaptiveOutput.persistedOutput)` in `lib/runPanelExecution.ts`. Generic and the 9 other legacy-active types never get one.
- **Shape limits.** `GovernanceRecordV1.schemaId` is limited to the Milestone-2 ids. Its `decisionReceipt` is required and is built from the adaptive analysis.
- **Shared readers.** `parseGovernanceRecord` is shared by:
  - the Approval Queue and the review page;
  - the decision, override, resubmit and panel routes;
  - the Team review summary;
  - exports, Decision Support wording and the Order 6 surfaces.
- **Decision UI.** The reviewer decision UI requires a usable receipt.
- **Consequence.** A run without that record never appears in Needs review or Assigned to me, and the review page returns not-found for it, so the UI cannot assign it a reviewer.
- **[R3] Exception.** `putWorkspaceReviewAssignment` itself has no governance check (`workspaceReviewMutations.ts:226-258`). A manual assignment written through the API before submission becomes live once the run is submitted, and §3 of the Order C design then keeps it as an explicit assignment.

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
- **[R3] Exclusive with `governanceRecord`.** Rev 2's claim that the race "can only happen if the run was unfinished" was wrong.
  - `completeRun` marks the run complete *before* `persistAdaptiveOutput` and the governance write (`runPanelExecution.ts:495` vs `:806-863`).
  - The governance write is a non-transactional read followed by `set(..., {merge:true})` (`lib/firestore/runs.ts`).
  - So a submission inside that window could produce both records.

  Rev 3 closes the window **without changing Milestone-2 flows**. Submission requires *positive evidence* that the run is not, and will never become, a governed run. Inside the submission transaction, the run must have **all** of the following:
  1. `status == "complete"`;
  2. **no** `adaptiveOutput` field;
  3. a saved legacy envelope `legacyAdaptiveOutput` whose `schemaId` is **not** a Milestone-2 id, **or** a `createdAt` from before #274 (`5165761c`, when legacy envelopes began), when no envelope could ever be written.

  Because `persistAdaptiveOutput` writes the Milestone-2 `adaptiveOutput` before any governance record, and a Milestone-2 run never writes a non-Milestone-2 legacy envelope, condition 3 cannot hold for a run that will later get a `governanceRecord`. Condition 3's first branch is only true after persistence has finished.

  This also refuses Milestone-2-schema runs whose governance initialization failed or was skipped (oversized, or `persistenceStatus != saved`). That closes the review's "weaker report review for a Milestone-2 run" gap. Those runs stay on today's path (D-B7, §10).

  Defence in depth: every reader treats a run that carries both records as an integrity failure and fails closed. The stronger alternative, a transactional precondition inside the governance initializer, would change a Milestone-2 flow, so it is offered as D-B7 rather than assumed.
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
| Run state | **[R3]** The §3 positive-evidence conditions, plus no `governanceRecord`, no `reportReview`, and no open review panel (`readPanelGate`). |
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

### [R3] Merge algorithm (rev 2's argument was incomplete)

Today's status views scan raw candidates and drop rows that fail revalidation (malformed, foreign workspace, status changed). The cursor records the last **scanned** candidate, not the last emitted row (`reviewQueue.ts:22-26, 226-269`). The merged design keeps that model and adds a frontier rule.

**State:**
- One cursor position, `pos = (sortValue, docPath)`. This is the existing `ReviewQueueCursor`, which carries its sort kind.
- Per stream: a buffer, the position of its last fetched row, and an `exhausted` flag.

**Algorithm, per page, within `MAX_SCAN_ROUNDS`:**
1. Each stream that is not exhausted and has an empty buffer fetches `batch` rows `startAfter(pos)`. If it gets fewer than `batch`, it is marked `exhausted`.
2. **Frontier** = the minimum, in queue order, of `lastFetched` across streams that are *not* exhausted. If every stream is exhausted, the frontier is +∞.
3. Repeat: take the next row in merged order whose position is ≤ frontier, set `pos` to it (the row is now **consumed**), revalidate it, and emit it if valid.
   - Stop when `limit` rows have been emitted, or when no buffered row is ≤ frontier. In the second case go back to step 1, which refetches the stream at the frontier.
4. `hasMore` = (some stream is not exhausted) OR (some buffered row was not consumed).
5. The next cursor is `pos`, the last **consumed** position. It is never "last emitted".

**Why it is correct.**
- **No skips.** A row is consumed only if every unexhausted stream has already fetched past its position. So no unfetched row from another stream can sort before it.
- **No duplicates.** The two predicates are mutually exclusive (§3), and `pos` only moves forward under one total order.
- **No stuck pager.** The cursor advances over dropped rows, as today. A page of all-dropped rows still moves `pos`, and the page reports `hasMore` honestly.

**Comparator.** It must reproduce Firestore's order exactly:
- for the timestamp kind: `(seconds, nanos)`, then document path;
- for the ISO-string kind: a **byte-wise** string comparison (not `Date.parse`), then document path;
- in both cases, descending.

**Required tests.** Property-style: random datasets with interleaved streams, dropped rows and page sizes from 1 upward. Each must emit every valid row exactly once, in order. Then mutation tests on the frontier, the comparator and `hasMore`.

**Fallback.** If those tests cannot pass, implementation stops and returns to the owner (D-B5).

### Cost and indexes

- Cost: two bounded reads per page.
- **[R3] Ordering by view** (`reviewQueue.ts:208-212`):
  - Needs review orders by `createdAt`.
  - Changes requested and Recently approved order by `…humanReview.reviewedAt` (ISO string).
- **[R3] Indexes.** Q2 mirrors all **four** existing `runs` status indexes: (`workspaceId`, status, `createdAt desc`) and (`workspaceId`, status, `reviewedAt desc`), each with and without `projectId`. Field paths go under `reportReview.humanReview.*`.
- **[R3] Code.** `buildSortValue`, which hard-codes the `governanceRecord` path (`reviewQueue.ts:314-324`), becomes per-stream.
- Shared status field: none.
- Historical records: untouched.

If testing finds a case where (1) to (4) cannot hold, implementation stops and returns to the owner, as ruled.

### Flag changes during paging

**[R3]** Toggling `REPORT_REVIEW_ENABLED` mid-pagination would change what a cursor means. To prevent that, the merged view bumps the cursor version. A cursor of the other version is rejected as `invalid_cursor`, so the client restarts from page one, as it already does for invalid cursors.

## 6. Review, decision and display

- **`reviewContext`:** returns `kind: "governance" | "report_review"`. For a report review it returns `scope`, `purpose` and `humanReview`.
- **Decision route:**
  - The same statuses, comment and conditions as today.
  - **[R3]** Authorization is the same as today's decision path, `isOrdinaryReviewerAuthorized` with the canonical-assignment requirement (`workspaceReviewMutations.ts:554`). That includes no self-review.
  - No receipt requirement.
  - The §2 disclaimer is stored nowhere, because it is fixed text, but it is rendered everywhere.
- **[R3] History and audit for report reviews.** The existing decision side-writes require a Milestone-2 `schemaId`, an `answerShape` and `governanceRecordUpdatedAt` (`workspaceReviewMutations.ts:593-624`, `adaptiveHumanReviewHistory.ts:121,147`). Report reviews need their own history and event shape: `kind: "report_review"`, `scope.schemaId` (may be null), and `reportReviewUpdatedAt`. It is written by new builders, and the existing builders stay unchanged. The audit reader accepts both shapes.
- **Display:**
  - The Team detail page shows "Submit for approval" (for callers with `research.organize`) in place of the "Approval review" notice that PR #281 adds (not yet in baseline `900aec72`).
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
- **[R3] D-B7:** how to guarantee the two record kinds never coexist.
  - **(a) Recommended.** The §3 positive-evidence submission rule. No Milestone-2 change. Milestone-2-schema runs whose governance initialization failed stay outside report review.
  - **(b)** Also make governance initialization a transaction that refuses when a `reportReview` exists. This is stronger, but it changes a Milestone-2 flow.
  - Residual edge for (a): a pre-#274 Milestone-2 run whose `adaptiveOutput` failed to save (for example, oversized) has neither envelope and an old `createdAt`, so it could be submitted. It can never gain a `governanceRecord` later, because initialization only happens at completion, so no record coexistence results. Such a run would be reviewable as a report review. Owner to accept or exclude.

## 11. Milestones

1. **B1:** record, parser, submit route, audit and exclusivity (dark), with tests.
2. **B2:** review context, decision route and queue merge (dark), with property tests and an independent review.
3. **B3:** UI and exports. Indexes deployed. Canary on one workspace, then enable.
