# Order B: human approval for Generic and other non-Milestone-2 research (design only)

**Status:** DESIGN. Implementation is NOT authorized (owner, 2026-11-02).

**Baseline:** main `900aec72`.

**Owner target:** every research type can be submitted for human approval, Generic included. Approval must not depend on whether the AI classifier succeeded. An approval must state exactly what it certifies.

## 1. Today

### Which runs have a review record

- A run gets `runs/{id}.governanceRecord` (`GovernanceRecordV1`) only when it produced a Milestone-2 envelope. That covers 9 result types. Generic and the other 9 legacy-active types never get one.
- The record is created by `initializeAdaptiveGovernanceRecord` inside `if (adaptiveOutput.persistedOutput)` in `lib/runPanelExecution.ts`.
- `GovernanceRecordV1.schemaId` is limited to the Milestone-2 ids.
- `decisionReceipt` (`AdaptiveDecisionReceipt`: conclusion, basis, assumptions, uncertainties, limitations, sources, sourceBacked, humanReviewNeeded) is required. It is built from the adaptive analysis.

### Who reads the record

`parseGovernanceRecord` is shared by:
- the Approval Queue;
- the review page (`reviewContext`);
- the decision, override, resubmit and panel routes;
- the Team detail review summary;
- exports;
- Decision Support wording;
- the Order 6 surfaces.

The reviewer decision UI also requires a usable decision receipt (`REVIEW_DECISION_UI_REQUIRES_DECISION_RECEIPT`).

### Consequence

A run without that record:
- cannot be assigned a reviewer, because the review page returns not-found;
- never appears in Needs review or in Assigned to me.

## 2. What an approval certifies (proposed wording, owner to confirm)

A **report review** approval certifies:

> "A named reviewer read this research report as saved, including its stated limitations, and found it acceptable for [stated purpose], on [date], [with conditions]."

It does **not** certify:
- that the report's factual claims are true;
- that a model's confidence is warranted;
- that missing analysis exists;
- that sources were checked;
- that the panel agreed.

These rules hold everywhere the approval appears:
- the review page;
- the Team detail summary;
- the queue row;
- exports;
- the audit trail.

## 3. Recommended design: a separate, versioned "report review" record

**Do not widen `GovernanceRecordV1`.** Widening it would:
- change what every existing parser and export accepts;
- risk altering existing governance classifications and Order 6 surfaces;
- force a fabricated `decisionReceipt`, which the owner prohibits.

Instead, add `runs/{id}.reportReview` (`ReportReviewRecordV1`):

```ts
{
  version: 1,
  kind: "report_review",
  // Scope disclosure, copied from what the saved run actually has. Never synthesized.
  analysis: {
    schemaId: string | null,              // e.g. "generic"; null if unknown
    unifiedAnswer: "present" | "absent",
    synthesis: "present" | "absent",
    consensus: "present" | "absent",
    respondedModels: number,
    requestedModels: number,
  },
  humanReview: { /* same shape and statuses as GovernanceRecordV1.humanReview */ },
  submittedAt: string, submittedByUserId: string,
  createdAt: string, updatedAt: string,
}
```

Properties:
- **Mutually exclusive with `governanceRecord`.** A run has one or the other, never both. Milestone-2 runs are untouched.
- **No receipt.** There is no `decisionReceipt`, conclusion, confidence, consensus or citation. The review page shows the saved report itself, with its existing missing-analysis notices.
- **Explicit submission.** The record is created by an explicit **"Submit for approval"** action (`research.organize`, or the creator with `research.create`). It is not created automatically at run time. This keeps new runs unchanged and avoids an unbounded backlog of unreviewed records.
- **Same assignment path.** It reuses the existing assignment subdocument `humanReviewAssignment/current`, the same eligibility rule (`isValidAssignmentTarget`: active member, same workspace, `research.read` and `reviews.submit`, no self-review), the same history and the same audit events.

## 4. Changes, by component (implementation phase only)

| Component | Change |
|---|---|
| New `lib/governance/reportReview.ts` | Builder, parser and validator for `ReportReviewRecordV1`. Parse failures fail closed. |
| New route `POST /runs/{R}/report-review` (submit) | Team access with `research.organize`. The run is complete and has no `governanceRecord` and no `reportReview`. Creates the record (`unreviewed`) and writes an audit event. Idempotent. |
| `reviewContext.ts` | Accept either record. Returns `kind: "governance" \| "report_review"`. |
| `reviewQueue.ts` (`revalidateRun`, status views) | Accept a reviewable `reportReview` status. Status views need `reportReview.humanReview.status` queries plus 2 new indexes, or a shared top-level `reviewStatus` mirror (§6). |
| Decision route | For `report_review`: the same statuses, comment and conditions. No receipt requirement. Wording from §2. |
| UI | Review page shows a "Report review" header and the §2 disclaimer. Team detail shows "Submit for approval" in place of the Order A notice. Queue rows show a "Report review" label. |
| Exports | Add a "Report review" section with status, reviewer, date, conditions and the §2 disclaimer. Milestone-2 export sections unchanged. |
| Unchanged | `GovernanceRecordV1`, `parseGovernanceRecord`, Decision Support, Order 6, automated governance, Milestone-2 flows. |

## 5. Historical runs (optional, audited backfill)

- **Default: no backfill.** Older runs can be submitted one at a time through the same "Submit for approval" action. That action creates the record on demand and leaves no other trace in the run.
- **If a bulk backfill is ever wanted:**
  - an admin-only, dry-run-first script;
  - per workspace;
  - creates only `unreviewed` `reportReview` records;
  - never touches runs that have `governanceRecord`;
  - writes an audit event per run;
  - reversible by deleting records that are still `unreviewed` with no assignment.

  This would be a migration and needs separate owner approval.

## 6. Queue query options

**(a) Recommended: a top-level mirror field `reviewStatus`.**
- Written on every record create and every decision.
- One status query covers both kinds.
- Needs one new index, `runs(workspaceId, reviewStatus, createdAt)`.
- Historical Milestone-2 runs lack the mirror until touched, so either Needs review keeps its current query and unions a second `reportReview` query, or a mirror backfill is run (a migration).

**(b) Two queries unioned in memory.**
- No mirror field.
- Needs pagination merge logic (as in #278) and 2 new indexes.

**Recommendation:** (b) for the first release (no migration), with (a) considered later.

## 7. Risks and rollback

| Risk | Mitigation |
|---|---|
| Approval misread as fact-checking | §2 disclaimer on every surface. Pinned copy tests. Owner-approved wording. |
| Existing governance changed | Separate record. `GovernanceRecordV1` and its parser untouched. A structural test fails if `reportReview` is ever read by Decision Support or Order 6 code. |
| Self-review and authority widening | Same eligibility function and capabilities. No new role or capability. |
| Queue duplication | One assignment subdocument per run. A run has one record kind. |
| Rollback | Behind a server flag, `REPORT_REVIEW_ENABLED`. When off, routes return not-found, the queue ignores `reportReview`, and records stay in place, inert. |

## 8. Milestones

1. **B0:** owner approves the §2 wording, the explicit-submit model, the no-backfill default and query option (b).
2. **B1:** record, parser, submit route and audit (dark, behind the flag), with tests.
3. **B2:** review page, decision route, queue union (dark), with tests. Independent review.
4. **B3:** UI and exports. Canary on one workspace, then enable.

## 9. Owner decisions

- D-B1: the approval wording in §2, and whether the "stated purpose" is free text or picked from a list.
- D-B2: explicit "Submit for approval" (recommended) or automatic creation for every new run.
- D-B3: who may submit: `research.organize` (recommended) and/or the run's creator.
- D-B4: no backfill (recommended), or an audited bulk backfill (a migration).
- D-B5: queue option (b) now (recommended), or (a) with a mirror backfill.
