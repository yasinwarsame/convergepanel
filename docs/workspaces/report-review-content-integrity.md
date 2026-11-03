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
| Per-model `tokenUsage`, `latencyMs`, `usage`, `costUsd`, `timing`, `elapsedMs` | Metrics |

Tests check every listed exclusion, plus a non-content change made in normal use (export counter, assignee, Project move, tokens): each leaves the fingerprint unchanged. Every included class (question, context, responses, truncation, structured result, synthesis with no timestamp, consensus, legacy results, an unclassified field) changes it.

## 2. Canonical representation and fingerprint

- **Encoding:** UTF-8 JSON, keys sorted (UTF-16 code-unit order) at every depth, arrays in stored order, no whitespace.
- **Null and absent:** `null` is kept, and an absent field stays absent; the two are distinct. `undefined` (never stored by Firestore) is treated as absent.
- **Numbers:** must be finite, serialized per ECMAScript. `-0` becomes `0`; `1` and `1.0` are the same value, as in Firestore.
- **Timestamps and Dates:** become `{"$timestamp":"<seconds>.<9-digit ns>"}`, so one instant is always the same text.
- **Anything else fails closed** as `unsupported_value`: GeoPoint, DocumentReference, bytes, NaN, Infinity, bigint and functions. Submission is refused with `content_unfingerprintable` rather than recording a fingerprint that does not cover the content.
- **Bound:** canonical content over 4 MiB fails closed (`too_large`). A Firestore document is at most 1 MiB, so real runs are well inside this.
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
- **Previous decisions:** a decided cycle's record, and its archive after resubmission, keep their original fingerprint forever. Later research changes never rewrite or broaden them.
- **Context, panel and export:** they show `contentIntegrity` (`matches`, `changed` or `unverifiable`). When it is not `matches`:
  - no decision is offered, and the panel explains why and offers resubmission;
  - a decided cycle is marked as applying only to the version submitted;
  - the export states plainly that the content shown is the **current** research, **not** the reviewed version.
- **Governed review:** unchanged. No governed decision, assignment or panel module references the fingerprint (pinned statically).

## 4. STOP: preserving the reviewed content itself (owner decision required)

A hash proves *whether* the content is the reviewed version. On its own it cannot reproduce the reviewed version after the research changes. That needs a stored copy: an immutable snapshot of the canonical content, written with `tx.create` in the submission transaction, for example at `runs/{R}/reportReviewSnapshots/{cycle}`, verified against the record's fingerprint on every read and export.

**Why this was not built.** Run deletion today (`DELETE /api/admin/runs/{id}` and `POST /api/admin/purge-runs`) deletes only the run document, never its subcollections. A snapshot is a full copy of the research content. It would therefore **survive an administrator deleting the research**, which would be a new privacy gap: deleted research would persist as a review snapshot. The order says to stop and propose alternatives when privacy boundaries prevent a safe implementation.

| Option | What it takes | Assessment |
|---|---|---|
| **S1 (recommended)** | Snapshot subcollection as above, **plus** the two admin deletion paths also delete that run's `reportReviewSnapshots` (and ideally all its review subcollections), with tests. | Complete, auditable history, and deletion stays complete. It touches two system-admin destructive routes, so it needs your explicit authorization. |
| S2 | Snapshot stored inside the run document, keyed by fingerprint so identical content is stored once. | Deleted together with the run. But it roughly doubles document size: submission must refuse runs near 1 MiB, and every read of the run gets heavier. Not recommended. |
| S3 | No snapshot: fingerprint only (this PR). | Integrity is guaranteed (nothing can be approved unless it is exactly the submitted content). A historical decision whose content later changed is provably *not* the current content, but cannot be reproduced. That does not meet "independently auditable". |

Until a snapshot option is authorized and built, activation should treat S3's limit as known.

## 5. Not changed

- `REPORT_REVIEW_ENABLED`, `lib/env.ts`, `firestore.rules`, indexes, Production settings and Order 6 files are unchanged.
- No migration or backfill: Production has no report-review records, because the feature has never been enabled.
- Records written before Order A have no fingerprint. They parse, and a decision on them fails closed.
