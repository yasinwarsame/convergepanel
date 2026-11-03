# Report review: reviewed-content integrity (Order A)

Status: development only (owner authorization 2026-11-03). Report review stays **OFF**. Not merged, deployed or migrated.

**Requirement (owner):** every approval decision must remain tied to the exact report content that was submitted and reviewed.

## 1. Canonical reviewed-content boundary (`rrc-v1`)

The rule is **default include**. Every top-level field of the saved run document is reviewable content, except the fields below. Each was excluded because it is shown to be unrelated to what the report says. Fields nested inside included fields are all included, except per-model usage metrics.

A field nobody has classified, for example one a future writer adds, is **included**. It can therefore only cause a spurious "content changed", which means renewed review (the safe direction). It can never let changed content pass as reviewed.

**Included, in practice:**
- `question` and `questionContext` (the research context);
- `selectedModels` and `status`;
- every saved model response: `runDocument`, the older `resultsCompact` and legacy `results` (model, status, text, truncation, provider, substitution), and the storage-truncation flags;
- the saved structured result, `legacyAdaptiveOutput`: classification, per-model results, aligned claims (agreement and disagreement), gate, synthesis report and trust summary;
- the saved synthesis: `synthesizedStructuredReport`, `schemaVersion`, `synthesizedBy`, `synthesisConsensusSummary` (the consensus), `policyConsensusSummary` and `synthesisConsensusAudit`;
- any other field.

**Excluded** (`REPORT_REVIEW_CONTENT_EXCLUDED_FIELDS`, which records a reason for each):

| Field(s) | Why it is not report content |
|---|---|
| `userId`, `workspaceId`, `projectId`, `origin` | Ownership, binding, filing, snapshot provenance (moving a run changes none of its content) |
| `assigneeUid`, `assigneeUids` | Research assignment (responsibility) |
| `createdAt`, `completedAt`, `synthesizedAt` | Timestamps. A regenerated synthesis changes the synthesis fields themselves, which are included. |
| `synthesisInputHash`, `synthesisMetadata` | Cache key and timing metrics of the synthesis call. The inputs themselves are included. |
| `tokenUsage`, `totalTokens`, `tokensBy*`, `promptTokensByProvider`, `completionTokensByProvider`, `geminiHasUsageMetadata`, `documentSizeChars` | Usage and size metrics |
| `adaptiveExportCounter` | Export count; it increments on every export |
| `reportReview`, `governanceRecord`, `teamGovernance` | Review and governance state, not report content |
| `errorMessage` | Failure text. Runs that did not complete are not eligible. |
| `governanceStatus`, `governanceReasons`, `governanceMeta` | Organization policy evaluation (governance state, like `teamGovernance`), written after synthesis |
| `adaptiveRetryUsage` | Retry usage accounting, written after completion |
| Per-model `tokenUsage`, `latencyMs`, `usage`, `costUsd`, `timing`, `elapsedMs` | Metrics |

Tests check every listed exclusion, plus a non-content change made in normal use (export counter, assignee, Project move, tokens): each leaves the fingerprint unchanged. Every included class (question, context, responses, truncation, structured result, synthesis with no timestamp, consensus, legacy results, an unclassified field) changes it.

## 2. Canonical representation and fingerprint

- **Encoding:** UTF-8 JSON, keys sorted (UTF-16 code-unit order) at every depth, arrays in stored order, no whitespace.
- **Null and absent:** `null` is kept, and an absent field stays absent; the two are distinct. `undefined` (never stored by Firestore) is treated as absent.
- **Numbers:** must be finite, serialized per ECMAScript. `-0` becomes `0`; `1` and `1.0` are the same value, as in Firestore.
- **Timestamps and Dates:** become `{"$timestamp":"<seconds>.<9-digit ns>"}`, so one instant is always the same text.
- **Anything else fails closed** as `unsupported_value`: GeoPoint, DocumentReference, bytes, NaN, Infinity, bigint, functions, and any stored map with a `$timestamp` key (so the encoding is unambiguous). Submission is refused with `content_unfingerprintable` rather than recording a fingerprint that does not cover the content.
- **Bound:** canonical content over 900,000 bytes fails closed (`too_large`), so the reviewed-content snapshot always fits in one Firestore document (§4).
- **Fingerprint:** `{ version: "rrc-v1", algorithm: "sha256", digest: hex(SHA-256("rrc-v1\n" + canonical)), canonicalBytes }`.
- **Golden test:** a fixed fixture's digest is pinned. It was computed by an **independent** implementation (Python `json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)`), not by the code under test.

## 3. Where it is computed and checked

- **Submission and resubmission:** computed from the run document **as read inside the submission transaction**, and stored on the cycle's record (`reportReview.contentFingerprint`). It is never accepted from the client: the request body is exactly `{ purpose }` or `{ purpose, expectedCycle }`.
- **Decision:** recomputed from the run **as read inside the decision transaction**, after authorization. It must equal the cycle's stored fingerprint.
  - If it differs: **`content_changed` (409)**. A record with no fingerprint is refused as **`content_unverifiable` (409)**.
  - **Nothing is written** in either case. The assignment, record, events, Audit Log and archives are byte-identical afterwards, and the stored fingerprint is never replaced.
- **Concurrency:** the run is read in the decision transaction, so a concurrent content write either commits first (and is seen) or makes the transaction retry. Two tests check this:
  - a fake-transaction test in which content changes mid-transaction, so the decision retries and is refused;
  - a 20-round race on the real emulator. In every round, a committed decision is serialized before the content write; otherwise the decision is refused.
- **Open cycle whose content changed:** it can no longer be decided. It can be resubmitted:
  - the cycle is archived **undecided** with `closedReason: "content_changed"` and its original fingerprint;
  - the Audit Log records `workspace_report_review_resubmitted` with `closedReason: "content_changed"`;
  - a new cycle starts on the new content.
- **Open cycle with unchanged content:** still cannot be resubmitted (`not_decided`).
- **Open cycle with no stored fingerprint** (written before Order A): it can never be decided. It can always be resubmitted, which closes it undecided with `closedReason: "content_unverifiable"`.
- **Current content that can no longer be fingerprinted:** no decision can be recorded and no resubmission is offered, because the resubmit transaction would refuse with `content_unfingerprintable`.
- **Previous decisions:** a decided cycle's record, and its archive after resubmission, keep their original fingerprint forever. Later research changes never rewrite or broaden them.
- **Context, panel and export:** they show `contentIntegrity` (`matches`, `changed` or `unverifiable`). When it is not `matches`:
  - no decision is offered, and the panel explains why, offering resubmission only when the resubmit transaction would accept it;
  - a decided cycle is marked as applying only to the version submitted;
  - the export states plainly that the content shown is the **current** research, **not** the reviewed version.
- **Governed review:** unchanged. No governed decision, assignment or panel module references the fingerprint (pinned statically).

## 4. Reviewed-content snapshot (S1, owner-approved 2026-11-03)

**What is stored.**
- Each cycle stores the exact canonical content it was submitted with, at `runs/{R}/reportReviewSnapshots/{cycle}`.
- The snapshot contains `version`, `runId`, `workspaceId`, `cycle`, `fingerprint`, `canonical`, `createdAt` and `createdByUserId`.
- It is written with `tx.create` in the **same transaction** as the cycle's fingerprint, so a cycle never exists without its snapshot.

**Immutability.**
- An existing snapshot is never overwritten: a colliding create fails the whole submission.
- No code path updates a snapshot. Only the research-deletion workflow removes it (§5).

**Size.** Canonical content is bounded at 900,000 bytes, so the snapshot fits in one Firestore document. Larger content fails closed: such research can't be submitted, and it is never fingerprinted without being preserved.

**Access.**
- Clients have no access (rules catch-all).
- The server reads snapshots only in the record export, after Workspace, capability and containment checks.
- Every read is **re-verified**: the binding (run, Workspace, cycle) and the fingerprint must equal the cycle's, and the SHA-256 of the stored canonical text must equal the digest.
- A snapshot that doesn't verify is never exported (500).

**Export.**
- `reviewedContent` (JSON) and a "Reviewed version" section (HTML) show exactly what the cycle was submitted with, even after the research changes.
- `?cycle=n` exports an archived cycle's decision together with *its* reviewed version.
- The live research is shown separately, with the integrity status.

**Privacy.** The snapshot is a second copy of research that already lives in the same access-controlled run subtree. It is deleted with the run (§5), so it never outlives the research.

## 5. Research deletion contract (S1)

**Deletion paths.** All supported deletion paths use one durable, idempotent workflow (`lib/firestore/researchDeletion.ts`):
- `DELETE /api/admin/runs/{id}?collection=runs`;
- `POST /api/admin/purge-runs`.

Admin user deletion removes the account but has never deleted research. That is unchanged and listed as an open decision below.

**Workflow.**
1. **Job record.** `runDeletionJobs/{runId}` is written first. It holds no research content: state, step, attempts, actor, timestamps and the last error.
2. **Mark.** The run is marked deletion-pending in a transaction. From then on every report-review mutation and read refuses the run.
3. **Subtree.** The run's entire subtree is deleted recursively. It is discovered with `listCollections()` and `listDocuments()`, which also reach "missing" ancestor documents.
4. **Out-of-tree copies.** Research text copied outside the run is redacted or deleted (table below).
5. **Pre-check, then the run document.** Everything except the run document is verified first. Only then is the run document deleted; the subtree is swept again and the audit rows re-redacted, which also catches a row written during deletion.
6. **Verify.** Success is reported only when the run document is gone, the subtree is empty, and nothing else still carries research text.
   - Otherwise the job is marked `failed` with the step.
   - The single DELETE route answers **500 `deletion_incomplete`**.
   - Purge counts the run under `errorsCount` / `incompleteRunIds`, never under `deletedCount`.
   - Re-running is always safe.
   - A deletion whose final step failed after the run document was removed is **resumed by runId**. `DELETE /api/admin/runs/{id}` resumes an unfinished job, or a completed one whose verification no longer holds.
   - Purge processes its own filtered runs first. Within the remaining budget it then resumes unfinished earlier deletions, and reports them **separately** (`resumedDeletedCount`, `resumedIncompleteRunIds`), never in `deletedCount`.
   - Purge has a time budget (`maxDuration` 300 s). It stops *starting* new deletions at 240 s and reports the rest as `notStartedRunIds` (counted in `errorsCount`). Purge again to continue.

**Orphan detection.** `findResearchDeletionOrphans()` lists report-review or export documents whose run is gone, plus unfinished jobs.

| Data | On authorized deletion |
|---|---|
| `runs/{R}` | Deleted |
| Report-review snapshots, cycle archives, events | Deleted (with the run subtree) |
| Export records (`runs/{R}/exports`, holding frozen report snapshots) | Deleted. Rendered bytes are never stored. |
| Review assignment, history, panels, governance events, any other subcollection | Deleted |
| Workspace Audit Log rows (`workspaceMembershipEvents`) for the run | **Kept** as audit metadata (who, what, when, cycle, status). `runQuestion` is redacted to null with `contentRedacted: true`, and the row displays as "[deleted research]" (rows are never dropped). |
| Admin audit log rows (`admin_audit_logs`) for the run | **Kept** as metadata. All free text is redacted: `question`, `comment`, `reasons`, `justification`, `overrideJustification`, `note`, `notes`, with `contentRedacted: true`. |
| Team snapshot locks (`runSnapshotLocks`) naming the run | Deleted (metadata only, but a stale lock would block re-adding the source research) |
| Legacy Team projections (`teamRuns`; they carry the receipt conclusion) | Deleted (a derived index) |
| `runDeletionJobs/{runId}` | Kept (deletion evidence, no content) |
| Firestore managed backups / point-in-time recovery | **Not reachable by the application.** They expire under the project's backup retention. Owner and legal decision below. |
| Logs (Vercel, Sentry) | Contain no research text, by policy (`logger` metadata only) |

**Normal operation stays immutable.** Archives, events and snapshots are append-only (tests pin that only the deletion workflow removes them). Authorized deletion is the single exception.

**Workspace isolation.** Snapshots live inside the run subtree, carry their Workspace binding, are verified against it on every read, and are reachable only through the run's own Workspace export.

**Governed review.** Governed runs are deleted through the same workflow, and the report-review steps are no-ops for them. As a deliberate improvement, their subcollections and projections are no longer orphaned.

**STOP: concurrent writers outside report review (owner authorization required).** Report-review writers check the deletion mark inside their transactions. A few **existing** writers that are not part of report review do not:
- the export record writer `lib/firestore/adaptiveExports.ts` (`createAdaptiveExportRecord`, `markAdaptiveExportReady`/`Failed`, which use set-merge);
- the governed-run writers in `lib/firestore/runs.ts` (`adaptiveOutput`, `legacyAdaptiveOutput`, `governanceRecord`, set-merge);
- `lib/governance/teamGovernancePipeline.ts`;
- `/api/governance/review` (its audit row and `governanceEvents`);
- `setTeamRunAssignee`.

If one of them commits **after** a deletion has completed, it can recreate a run document or subtree, for example an export record holding a frozen report snapshot. Closing that completely means making each of them require `exists && !deletion` inside its transaction (and using `update`, not set-merge). That touches:
- an Order 6 byte-pinned file (`adaptiveExports.ts`);
- the governed-run writer, which needs separate authorization.

So it is **not built**. Until it is:
- **Detection.** `findResearchDeletionOrphans()` re-runs the **full** deletion verification for the most recent completed jobs (newest first, bounded). It flags a recreated run document, a recreated subtree, a Workspace Audit row carrying research text, an unredacted admin audit row (for example a late governance review comment), a projection, or a lock.
- **Remedy.** `DELETE /api/admin/runs/{id}?collection=runs` re-runs the deletion for a flagged run even when the run document is absent.
- **Residual risk.** Detection is not scheduled, because no job runner is authorized. It must be run on demand until the writers are fixed.

Owner options are in the PR record.

**Open owner and legal decisions (not built, not assumed):**
- **Legal hold.** No legal-hold mechanism exists; an authorized deletion proceeds unconditionally. If records must sometimes be retained, a hold flag that blocks the workflow is a separate design.
- **Backups and PITR.** Deleted research persists in managed backups until they expire. The retention period and customer disclosure are owner and legal decisions.
- **User account deletion.** It leaves the user's research in place, as before S1. Whether account deletion should also delete research is a separate product and privacy decision.
- **Audit metadata retention.** Redacted audit rows are kept indefinitely, as today. A time-based retention policy for audit metadata is an owner decision.

## 6. Not changed

- `REPORT_REVIEW_ENABLED`, `lib/env.ts`, `firestore.rules`, indexes, Production settings and Order 6 files are unchanged.
- No migration or backfill: Production has no report-review records, because the feature has never been enabled.
- Records written before Order A have no fingerprint. They parse, and a decision on them fails closed.
