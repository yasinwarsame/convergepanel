# Workspace Governance Summary — normalization contract (Step 6.3)

Status: **contract (docs-only)**. Verified against `main` @ `9a163d7c`.
Owner decisions: `6_3_D1_OUTCOME_MAPPING_APPROVED_WITH_ERROR_NOT_EVALUATED_NOT_RECORDED_DISTINCT`, `6_3_D2_NUMERIC_SCORES_AND_TIERS_EXCLUDED_FROM_V1`, `6_3_D3_WORKSPACE_SUMMARY_GATED_BY_AUDIT_READ`, `6_3_D4_EXACT_COUNT_QUERIES_WITH_MINIMAL_REQUIRED_INDEXES_APPROVED`.

No code implements this yet. Implementation is a later, separately approved slice: query layer, any required indexes, and a read-only Workspace UI.

---

## 1. Purpose and non-goals

The summary answers one question for a Team Workspace: **how much of this Workspace's work went through governance, and with what recorded outcome?** It answers exactly, from persisted fields.

It is **not** an integrity or quality score. In particular:
- No numeric score is shown, averaged, rescaled or combined.
- No adaptive presentation tier appears.
- No inferred pass. Missing data is never counted as cleared.
- No new write path, rollup document, denormalized outcome field, background job, scheduler or backfill.
- No run-scanning limit, sampling or "latest N" window.

### Why there is no score (D2)

The 0–100 `consensusScore` comes from three different formulas.

| Family | Source | Construction |
|---|---|---|
| Claim verification | `lib/verification/consensusScoring.ts` `computeConsensusScoringForVerification` | `40 + 45·support + 20·health − penalties + verdictBoost`. The verdict itself moves the score, from −15 (unverifiable) to +5 (partially true). |
| Research synthesis | `computeSynthesisConsensusScoring` (same file) | Different inputs; `evidenceQuality` cut-offs differ (support ≥ 0.75 vs 0.65) |
| Video verification | `lib/video/videoVerificationExecution.ts:392` | `supportRatio·100 −` fixed penalties |

Adaptive `consensusLevel` and `sourceGroundingLevel` (`lib/adaptiveSchema/reportSummary.ts`) are **derived at read time and never persisted**. Their meaning is schema-specific:
- `evidence_review` maps evidence *strength* into "consensus";
- `bias_blindspot_audit` maps a homogeneity *risk* flag to "strong";
- `definition_explanation` maps "not ambiguous" to "strong";
- legacy-adaptive runs map the gate's pass/caution to strong/moderate.

A claim-verification 78 and a video-verification 78 are not equivalent evidence, so none of these participate.

---

## 2. Scope and authority (D3)

- **Scope.** Team Workspaces only. Personal Workspaces are out of scope for v1.
- **Records counted.** Every record in `runs`, `verifications` and `videoVerifications` whose persisted `workspaceId` equals the requested Workspace id. `workspaceId` is the binding field (see open item **O2**).
- **Authority.** The caller must have current Workspace admission plus the existing **`audit.read`** capability. At `9a163d7c` that is Owner and Admin only, not Member, Reviewer or Viewer. No new capability is added. A dedicated `governance.read` would be a later, deliberate decision.
- **Concealment.** A caller without admission, or without `audit.read`, receives the same concealed denial the existing Team audit surfaces use. Counts are never returned partially.

---

## 3. Report families and governance source systems

Each count belongs to exactly **one family** and **one source system**.

| Family id | Collection | Membership (persisted, queryable) | Source system |
|---|---|---|---|
| `research_adaptive` | `runs` | `adaptiveOutput.version == 1` (the Milestone-2 envelope) | **B**: `governanceRecord` |
| `research` | `runs` | every other `runs` record in the Workspace (includes legacy-adaptive runs) | **A**: `governanceStatus` |
| `claim_verification` | `verifications` | every record in the Workspace | **A**: `governanceStatus` |
| `video_verification` | `videoVerifications` | every record in the Workspace | **A**: `governanceStatus` |

**Partition rule.** `research` = (all Workspace runs) − (`research_adaptive` runs). The two must not overlap on any counted status. The implementation counts the overlap explicitly:
- `research_adaptive` runs that carry a System A `governanceStatus`;
- `research` runs that carry `governanceRecord`.

Each overlap is returned as a disclosed `anomaly` count, expected to be 0. It is **never** silently assigned to either family.

---

## 4. Automated-outcome axis (D1)

### 4.1 Buckets (six, all distinct)

`cleared`, `needs_attention`, `blocked`, `not_evaluated`, `error`, `not_recorded`.

`error` (an evaluation that failed), `not_evaluated` (the evaluator ran and declined to assess) and `not_recorded` (no automated outcome is persisted) are **never collapsed**.

### 4.2 Mapping

| Source | Stored field | Stored value | Bucket |
|---|---|---|---|
| A | `governanceStatus` | `approved` | `cleared` (see **A1**) |
| A | `governanceStatus` | `needs_review` | `needs_attention` (see **A1**) |
| A | `governanceStatus` | `blocked` | `blocked` (see **A1**) |
| A | `governanceStatus` | missing | `not_recorded` |
| B | `governanceRecord.automatedGovernance.status` | `passed` | `cleared` |
| B | `governanceRecord.automatedGovernance.status` | `flagged` | `needs_attention` |
| B | `governanceRecord.automatedGovernance.status` | `blocked` | `blocked` |
| B | `governanceRecord.automatedGovernance.status` | `not_evaluated` | `not_evaluated` |
| B | `governanceRecord.automatedGovernance.status` | `error` | `error` |
| B | `governanceRecord.automatedGovernance.status` | missing | `not_recorded` |

A stored value outside these lists is returned as its own row with `normalizedOutcome: "unmapped"`, and is never folded into a bucket.

### 4.3 Amendment A1 — System A human decisions overwrite the automated field (requires owner approval)

`POST /api/governance/review` (`app/api/governance/review/route.ts:240`) writes a human decision **into `governanceStatus` itself**, together with `governanceReviewedBy` and `governanceReviewedAt`:
- `approved` → `approved`;
- `blocked` → `blocked`;
- `changes_requested` → `needs_review`.

Once a System A record has been reviewed, its `governanceStatus` is a **human** decision, and the prior automated outcome is no longer on the document. It exists only in the `governanceEvents` history.

Applied literally, the table above would count human approvals as `cleared`. That violates "cleared never implies human approval". Proposed rule:
- A System A record **with** `governanceReviewedAt` present contributes **only to the human axis** (§5). On the automated axis it counts as `not_recorded`, sub-reason `superseded_by_human_decision`, disclosed separately.
- System A automated counts are therefore, per stored value X: `count(governanceStatus == X) − count(governanceStatus == X ∧ governanceReviewedAt present)`. This is subtraction within one field/value set of one family; no cross-family arithmetic is involved.
- The pre-review automated outcome is **not** recovered from `governanceEvents` in v1. That would be per-document reading, not an exact aggregation.

---

## 5. Human-decision axis (separate; never merged with §4)

Exact stored statuses only. No cross-family score, and no combination with automated buckets.

| Source | Field | Values reported as stored |
|---|---|---|
| B | `governanceRecord.humanReview.status` | `unreviewed`, `pending`, `approved`, `approved_with_conditions`, `changes_requested`, `rejected` |
| A | `governanceStatus` on records **with** `governanceReviewedAt` present | `approved`, `needs_review`, `blocked` |

**Disclosed caveat for System A.** A System A "changes requested" decision is persisted as `needs_review` and cannot be distinguished on the document. It is reported as stored, `needs_review`, with this note. It is not relabelled.

System B decisions from the Personal reviewer, the Workspace review-decision route (`submitWorkspaceReviewDecision`) and the multi-reviewer finalization all write the same `governanceRecord.humanReview`. One field covers them all.

---

## 6. Denominators and `not_recorded`

For each family and system:
- `total` = `count(workspaceId == W ∧ <family membership>)`, subject to open item **O3** on completed-records-only.
- `recorded(X)` = the count for each stored value X.
- `not_recorded` = `total − Σ recorded(X)`. This is exact arithmetic over counts from one family, not an inference about any document.

Every displayed total carries its denominator. "27 cleared" is always rendered as "27 cleared of N in <family>", with `not_evaluated`, `error` and `not_recorded` visible beside it.

---

## 7. Response contract (structural)

The API returns rows, not just totals, so every rolled-up number can be taken apart again:

```ts
type GovernanceSummaryRow = {
  family: "research" | "research_adaptive" | "claim_verification" | "video_verification";
  sourceSystem: "A" | "B";
  axis: "automated" | "human";
  storedField: string;           // e.g. "governanceStatus", "governanceRecord.automatedGovernance.status"
  storedStatus: string | null;   // exact persisted value; null = missing
  normalizedOutcome?:            // automated axis only
    | "cleared" | "needs_attention" | "blocked" | "not_evaluated" | "error" | "not_recorded" | "unmapped";
  subReason?: "superseded_by_human_decision"; // A1
  count: number;
};

type GovernanceSummaryResponse = {
  workspaceId: string;
  generatedAt: string;           // server time of the count queries
  scope: { bindingField: "workspaceId"; teamWorkspaceOnly: true };
  totals: Array<{ family: GovernanceSummaryRow["family"]; sourceSystem: "A" | "B"; total: number }>;
  rows: GovernanceSummaryRow[];
  anomalies: Array<{ kind: "family_overlap"; family: string; field: string; count: number }>;
};
```

The UI may roll `rows` up by `normalizedOutcome` for display. It must keep the per-family, per-system rows for disclosure and drilldown, so a refactor cannot silently lose provenance.

---

## 8. Query shapes and indexes (D4)

- Every number comes from a Firestore **aggregation `count()`** over an **equality-only** filter set:
  - `workspaceId == W`;
  - at most one family-membership equality, e.g. `adaptiveOutput.version == 1`;
  - at most one stored-status equality, e.g. `governanceStatus == "approved"` or `governanceRecord.automatedGovernance.status == "flagged"`;
  - for A1 only, `governanceReviewedAt > ""`, which matches records where the field is a string.
- Families are queried **separately**. Counts are combined only by the mapping in §4.2 and §5.
- **Index policy.** Firestore can serve equality-only queries by merging single-field indexes. The implementation must determine the required composite indexes **against real Firestore** (emulators do not enforce index requirements). It adds only those Firestore demands, recorded with the query shape that needs each one. The A1 range filter (`governanceReviewedAt > ""`) is the shape most likely to need a composite index.
- No document reads to compute any number. No `limit`, cursor window or sampling.

---

## 9. Excluded from v1

- Numeric `consensusScore`, `overallConsensusScore` and `evidenceQuality` (D2).
- Adaptive `consensusLevel` and `sourceGroundingLevel` tiers (D2).
- Any trend or time-windowed series.
- **D5 (separate item).** System A governance applies the same 80/70 consensus thresholds to all three numeric formulas. This may itself be semantically wrong; it is tracked separately and is not needed for an outcome summary that excludes scores.

---

## 10. Open items for owner decision before implementation

- **A1.** The System A human-override rule in §4.3. Without it, mapping §4.2 would count human approvals as `cleared`.
- **O2. Binding field versus integrity validation.** Counts use the persisted `workspaceId`. Per-document integrity validation (`validateRunWorkspaceAssociation`, roadmap 4.3a: a run filed in a Project of another Workspace is concealed in lists) cannot run inside an aggregation. A mis-filed record would therefore be **counted** while its row stays concealed elsewhere. Options:
  - (a) accept and disclose this ("scope: records whose `workspaceId` is this Workspace");
  - (b) also count and disclose the integrity anomalies that are exactly countable.
- **O3. Completed records only.** Should denominators include only completed executions (`runs.status == "complete"`, and the record-level completion field for claims and video, to be pinned by the implementation), with excluded counts disclosed? Or all Workspace-bound records? The current draft is "all records". Restricting adds one equality per count.

---

## 11. Stop condition (v1 implementation)

- Every Workspace governance-summary count is an exact aggregation of one explicitly identified persisted field and value, within one report family and one governance source system.
- Cross-family arithmetic is limited to summing counts whose stored statuses have an approved mapping to the same governance-outcome bucket.
- Numeric quality scores and adaptive presentation tiers never participate.
- `error`, `not_evaluated` and `not_recorded` remain distinct.
- Human decisions remain a separate axis, and per A1 a human decision is never counted as an automated `cleared`.
- Every displayed total has an exact denominator and can be broken back down into its source family and system counts.
- No run-scanning limit, inferred pass, new write path, rollup document, scheduler or backfill is introduced.
