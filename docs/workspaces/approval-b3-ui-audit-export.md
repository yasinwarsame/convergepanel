# Order B, Stage B3: report review UI, Workspace Audit Log, record export, indexes and activation readiness

Status: implementation for owner review (2026-11-03). **Report review stays OFF.**

- `REPORT_REVIEW_ENABLED = false` is unchanged.
- `lib/env.ts`, Production settings and Firestore indexes are untouched, and nothing is deployed.

Design reference: PR #282 (`approval-b-report-review-design.md` rev 5, `approval-implementation-sequence.md`). B1 is #284 and B2 is #285, both live and dark. C1–C3 are not included.

## 1. User interface

### Team research page

`components/workspace/projects/ReportReviewPanel.tsx` is shown only when **both** of these hold:

- the server passes `reportReviewEnabled` (the compile-time switch);
- the run has no governed review.

While the switch is off, the page renders the Order A "Approval review" notice exactly as before. This is pinned by the page and shell specs.

| State | What the reader sees |
|---|---|
| Not submitted, eligible, may organize | Explicit **Submit for approval**: the four purposes (Internal review, Client delivery, Publication review, Other), an optional note with a live 280-character counter, and the disclaimer. |
| Not submitted, eligible, may not organize | "Only members who can organize research can submit it", plus the disclaimer. |
| Not submitted, ineligible | The exact reason, from the same fixed sentences the submit route returns (governed run, not complete, no review information). |
| Not submitted, open review panel | That an open review panel blocks submission. |
| Submitted | The fields listed below. |
| Not authorized to read reviews | The unchanged Order A notice. |

A submitted review shows:

- the status badge and review cycle;
- the purpose and note, the submitter and the time;
- "N of M models responded";
- a statement of which analyses the report does **not** contain (Unified Answer, consensus, synthesis), and that approval neither adds nor verifies them;
- the decision, with reviewer, time, conditions and comment;
- the disclaimer;
- the reviewer assignment, through the existing `ReviewAssignmentCard` (the same PUT/DELETE routes and OCC);
- the decision form, for the assigned reviewer only, with the disclaimer inside it;
- the reason a viewer cannot decide (submitter, creator, not assigned, stale assignment);
- resubmission, after a decision;
- previous cycles and the full review history;
- export buttons, for holders of `exports.create`.

**Disclaimer.** One fixed text, the owner's exact wording, in `lib/governance/reportReviewCopy.ts`: "Approval means this report was reviewed and considered acceptable for its stated purpose. It does not verify the factual accuracy of its claims." It appears wherever approval is requested, recorded, viewed or exported:

- the panel;
- the decision form;
- the Approval Queue, when report-review rows are listed;
- every Audit Log decision row;
- both export formats.

It replaces B1's longer wording, so the API, UI and exports all carry the same sentence.

**Approval Queue.** Report-review rows carry a "Report review" tag and open the Team research page. The governed review page would answer not-found for them. Governed rows are unchanged.

**Authority.** Every control follows a server verdict from `GET …/report-review`, computed by the same rules the mutation transactions enforce (`evaluateReportReviewDecisionAuthority`, D-B3a capabilities, eligibility, panel gate). Hiding a control is never the protection: every mutation re-authorizes inside its transaction. Reviewer candidates now also exclude the submitter. This is dormant while the switch is off and never applies to governed runs.

## 2. Workspace Audit Log: event contract and durability

The Workspace Audit Log reads exactly one collection, `workspaceMembershipEvents`, workspace-scoped, using the existing index. Every other Workspace Audit event is written into it inside its own mutation's transaction. Report review follows the same established pattern, so **no schema, rules or index change is needed**. Clients are denied by the rules catch-all.

| Event type | Written by (same transaction) | Fields beyond `eventType, workspaceId, actorUid, runId, projectId, runQuestion, cycle, at` |
|---|---|---|
| `workspace_report_review_submitted` | `submitReportReview` (only when `created`) | `purposeCode` (`cycle` is always 1) |
| `workspace_report_review_reviewer_changed` | assignment PUT/DELETE, report-review runs only | `previousReviewerUid`, `reviewerUid`, `revision`; covers assignment, reassignment and removal |
| `workspace_report_review_decided` | `decideReportReview` (not on replay) | `priorStatus`, `status`, `purposeCode`; **this is also cycle completion**, since a decision closes its cycle |
| `workspace_report_review_resubmitted` | `resubmitReportReview` | `fromCycle`, `purposeCode`, `clearedReviewerUid`; records the archive of `fromCycle`, the creation of `cycle`, and the reviewer reset |

Guarantees, each tested in `reportReviewB3Audit.spec.ts` and, under real contention, in `reportReviewB3.emulator.spec.ts`:

- **Server-authoritative and atomic.** The only writer is `writeReportReviewWorkspaceAuditEvent()`. It calls `tx.create()` inside the mutation's own transaction: mutation committed iff audit row committed. A failed commit leaves neither (tested for submit, assign, decide and resubmit).
- **Bindings.** `workspaceId` is the run's transaction-validated binding, never a request value. `actorUid` is the authenticated caller. `cycle` is the record's cycle.
- **Timestamp.** `at` is the same instant as the record's own timestamp: one clock read per mutation.
- **No silent loss.** Every successful mutation in the full lifecycle produces exactly one row, and the run-level event trail matches it one-for-one.
- **No duplicates.** Retries write nothing:
  - submit replay returns `created: false`;
  - decision replay returns `replayed: true`;
  - a stale resubmit returns `cycle_conflict`;
  - a stale assignment returns `stale_revision`.

  Five concurrent submissions or decisions on the emulator produce exactly one row.
- **Immutability.** Rows are created only, never set, updated or deleted. This is pinned statically, and clients cannot read or write them.
- **No cross-workspace visibility.** The reader query is `workspaceId ==`, every row is re-checked, and the route requires `audit.read`.
- **Reader and client.** The DTO exposes question, cycle, purpose, status and display names only, never a uid, `runId` or `projectId`. Malformed rows are skipped, never repaired. Nine malformed shapes are tested.
- **Latent defect fixed.** The client Audit Log validator rejects a whole page containing any unrecognised event type. Without the client change, the first report-review row would have broken the Audit Log for that workspace. It is now covered by a regression test.
- **Governed and off paths.** Governed runs, and every run while the switch is off, write no report-review row.

## 3. Export

**Why a separate export.** The existing PDF, DOCX and JSON research exports are frozen byte-for-byte by the Order 6 boundary suites (`dsExportBoundaries`, `dsProvenanceUiBoundaries`, `dsExportRendered`). That covers their routes, the snapshot builder and its exact import list, the JSON schema, the render dispatchers, persistence and audit. Adding a report-review section to them would invalidate Order 6 evidence, which this stage may not do.

B3 therefore adds a separate **report review record** export:

- route: `GET /api/workspaces/{W}/runs/{R}/report-review/export?format=json|html`;
- builder: `lib/workspaces/reportReviewExport.ts`.

No governed export file changed; the Order 6 suites pass unmodified.

**Content.**

- The saved research content exactly as the canonical Team research read returns it (`buildRunReadPayload`, same viewer-role derivation): question, every saved model response, and the saved synthesis or legacy structured result only when present.
- An analysis that is absent is stated as absent, never generated.
- Purpose (code, label, note), status, submission and decision timestamps, the current cycle, and conditions.
- The full decision history (archived cycles plus the current one).
- The disclaimer.

**Reviewer identity and comments are withheld.** This is the same boundary as the governed Team export (E1-S6b: an export carries no reviewer identity or private reviewer text). See owner decision OD-B3-2.

**Authorization order:**

1. identity;
2. switch and Approval Workflow admission (concealed 404 while dark);
3. run-id syntax;
4. Workspace access;
5. `exports.create` and `research.read` and `reviews.read`;
6. format;
7. Workspace containment;
8. Project containment (E1-S7 parity);
9. a valid report review and no governance record;
10. archived cycles contiguous and valid (otherwise a 500, never a partial history).

**HTML.** A fixed template in which every value is escaped. It contains no script, no remote resource, and no `src`, `href` or `on*` attribute, and is served with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` and `nosniff`.

**Tests** (`reportReviewB3Export.spec.ts`, emulator):

- the role matrix: Owner, Admin and Member get 200; Reviewer and Viewer get 403; a non-member gets 404;
- off returns 404 and signed-out returns 401;
- another Workspace's run, a missing record, a foreign Project, both records present, or a malformed or misplaced archive are each refused;
- escaping;
- withheld secrets;
- no fabrication;
- archive-integrity cases.

## 4. Four Firestore indexes (declared since B2, NOT deployed)

| # | Fields (collection `runs`, scope COLLECTION) | Query it serves |
|---|---|---|
| 1 | `workspaceId ASC, reportReview.humanReview.status ASC, createdAt DESC` | Needs review (merged): `workspaceId ==`, `reportReview.humanReview.status in [unreviewed, pending]`, order `createdAt desc, __name__ desc` |
| 2 | `workspaceId ASC, projectId ASC, reportReview.humanReview.status ASC, createdAt DESC` | The same, with a Project or Unfiled filter (`projectId ==`) |
| 3 | `workspaceId ASC, reportReview.humanReview.status ASC, reportReview.humanReview.reviewedAt DESC` | Changes requested (`== changes_requested`) and Recently approved (`in [approved, approved_with_conditions]`), order `reviewedAt desc, __name__ desc` |
| 4 | `workspaceId ASC, projectId ASC, reportReview.humanReview.status ASC, reportReview.humanReview.reviewedAt DESC` | The same, with a Project or Unfiled filter |

`__name__ DESC` is implicit: it follows the last field's direction.

Nothing else B3 adds needs a composite index:

- the Audit Log reuses its existing index;
- the context's history query is a single-field `orderBy(at)` on a run subcollection;
- archives are read whole.

**Emulator verification.** The queries are exercised end-to-end on the real SDK against the emulator: `reportReviewQueue.emulator.spec.ts` covers every view and page size, cross-stream ties and the fetch budget. The emulator checks query legality, cursors and ordering, but **does not enforce composite indexes**. Index readiness can only be confirmed in Production, after deployment.

**Missing index.** A query refused with `FAILED_PRECONDITION … index` in the merged queue returns `index_unavailable`. The route answers **503 `review_queue_index_unavailable`** and the server logs `REPORT_REVIEW_INDEX_UNAVAILABLE`. It never returns a partial page. Governed queue paths are unchanged and only run when the switch is off. Tested in `reportReviewB3Context.spec.ts` and `reportReviewB3Export.spec.ts`.

**Deployment, when separately authorized:**

1. Command: `firebase deploy --only firestore:indexes --project <prod>`, or the targeted create (`reference-firestore-targeted-index-create`), using the four exact definitions above.
2. **Impact:** index builds are online and additive. Reads are unaffected, and existing queries never use these indexes while the switch is off. Writes to `runs` gain the index-maintenance cost of four entries, and only runs with a `reportReview` field are indexed.
3. **Readiness check:** in the Firebase console (Firestore, Indexes), or with `gcloud firestore indexes composite list`, wait until all four report `READY`. Then confirm with a signed-in queue read on the trial workspace (Section 6).
4. **Rollback:** delete the four indexes. This is safe while the switch is off, because no query uses them. If the switch is on, the queue answers the controlled 503 described above instead of returning a partial list.

## 5. Feature OFF verification

- `REPORT_REVIEW_ENABLED = false as boolean` is unchanged (`lib/workspaces/reportReviewRollout.ts`).
- Both research pages pass `reportReviewEnabled={REPORT_REVIEW_ENABLED}`. The page specs pin that value as `false` and the notice as unchanged.
- Every report-review route conceals with 404 before reading the body while off. That includes the new export.
- The assignment audit hook and candidate exclusion are dormant while off.
- `lib/env.ts`, `firestore.rules` and the Order 6 pinned files are unchanged; their hash suites pass.

## 6. Activation checklist for a single authorized workspace (needs a separate owner GO)

1. **Decision.** The owner names one trial workspace and one trial date. The Team and Approval Workflow canary settings already admit it; no new environment variable is needed.
2. **Indexes.** Deploy the four indexes in Section 4 and wait until all are `READY`.
3. **Switch.** Today the switch is a single boolean, so turning it on would admit every workspace that Approval Workflow admits. A single-workspace trial therefore needs a reviewed activation PR. That PR adds a compile-time workspace allow-list (for example `REPORT_REVIEW_WORKSPACE_IDS`) and checks it at every gate:
   - the mutations' `admissionGate` and `decideReportReview`;
   - `reportReviewCaller` (it must receive the route's `workspaceId`);
   - `getReportReviewContext`;
   - `reportReviewAssignmentContext` and `reviewerCandidates`;
   - the merged queue selection (`isMergedReviewQueueView`);
   - the research pages' `reportReviewEnabled`.

   It also needs tests showing that every other workspace stays exactly as it is today. This is **not** implemented in B3, because the switch must stay unchanged. It is a code change, not configuration, so it goes through the normal review, approval and merge process.
4. **Permissions check.**
   - In the trial workspace, confirm the roles: one Owner or Admin (assigns), one Member (submits), one Reviewer (decides).
   - Confirm a Viewer cannot submit and a Reviewer cannot submit.
   - Confirm the submitter is absent from the reviewer list, and that the creator and the submitter cannot decide.
5. **Signed-in acceptance** (owner accounts; Claude cannot perform this):
   1. submit;
   2. assign;
   3. reassign;
   4. decide with conditions;
   5. resubmit;
   6. decide again.

   Check each step in the panel, the Approval Queue and the Workspace Audit Log, and download both exports.
6. **Audit evidence.** Confirm the Audit Log shows each step once, in order, with the disclaimer on the decision rows. The run's `reportReviewEvents` count must equal the number of Audit Log rows.
7. **Monitoring.** Watch Production logs for `REPORT_REVIEW_INDEX_UNAVAILABLE`, `reportReview*` warnings and 5xx responses on `/report-review`.
8. **Rollback.** Revert the switch PR, which redeploys dark. Records, archives and audit rows stay intact and immutable. Rows written during the trial remain visible in the Audit Log, which is the intended permanent record. No data migration is needed. The indexes can stay or be deleted.

## 7. Remaining owner decisions

- **OD-B3-1, export placement.** Accept the separate report-review record export (JSON and HTML) as B3's export support. The alternative is to separately authorize re-baselining the Order 6 export evidence, so a report-review section can be added inside the frozen PDF and DOCX exports.
- **OD-B3-2, reviewer identity in exports.** Withheld, matching the governed export boundary. The owner may instead permit the reviewer's display name in report-review exports only.
- **OD-B3-3, disclaimer wording.** B1's longer disclaimer is replaced by the owner's exact text everywhere.
- **OD-B3-4, activation.** Index deployment, the trial workspace, the switch PR and signed-in acceptance each need a separate GO.
