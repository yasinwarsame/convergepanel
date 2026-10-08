# Workspace Governance Summary — normalization contract (Step 6.3)

Status: **contract (docs-only)**. Verified against `main` @ `9a163d7c`.

Owner decisions:
- `6_3_D1_OUTCOME_MAPPING_APPROVED_WITH_ERROR_NOT_EVALUATED_NOT_RECORDED_DISTINCT`
- `6_3_D2_NUMERIC_SCORES_AND_TIERS_EXCLUDED_FROM_V1`
- `6_3_D3_WORKSPACE_SUMMARY_GATED_BY_AUDIT_READ`
- `6_3_D4_EXACT_COUNT_QUERIES_WITH_MINIMAL_REQUIRED_INDEXES_APPROVED`
- `6_3_A1_SYSTEM_A_REVIEWED_ROWS_HUMAN_AXIS_ONLY_APPROVED`
- `6_3_O2_CANONICAL_PROJECT_CONTAINMENT_PLUS_EXACT_ANOMALY_COUNTS_APPROVED`
- `6_3_O3_COMPLETED_RESEARCH_DENOMINATOR_WITH_EXCLUSIONS_APPROVED`
- `6_3_QUERY_CONTRACT_EXACT_AGGREGATIONS_NOT_EQUALITY_ONLY`

No code implements this yet. Implementation is one later, separately approved slice: query layer, any required indexes, and a read-only Workspace UI.

---

## 1. Purpose and non-goals

The summary answers one question for a Team Workspace: **how much of this Workspace's completed work went through governance, and with what recorded outcome?** It answers exactly, from persisted fields.

It is **not** an integrity or quality score:
- no numeric score is shown, averaged, rescaled or combined;
- no adaptive presentation tier appears;
- no inferred pass — missing data is never counted as cleared;
- no new write path, rollup document, denormalized outcome field, background job, scheduler or backfill;
- no record-window scan, sampling or "latest N" window.

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
- **Authority.** The caller must have current Workspace admission plus the existing **`audit.read`** capability. At `9a163d7c` that is Owner and Admin only, not Member, Reviewer or Viewer. No new capability is added. A dedicated `governance.read` would be a later, deliberate decision.
- **Concealment.** A caller without admission, or without `audit.read`, receives the same concealed denial the existing Team audit surfaces use. Counts are never returned partially.
- **No leakage.** Foreign or invalid Project ids are never returned; only their counts are (§4).

---

## 3. Report families and governance source systems

Each count belongs to exactly **one family** and **one source system**.

| Family id | Collection | Membership (persisted, queryable) | Source system |
|---|---|---|---|
| `research_adaptive` | `runs` | `adaptiveOutput.version == 1` (the Milestone-2 envelope) | **B**: `governanceRecord` |
| `research` | `runs` | all other contained `runs` (includes legacy-adaptive runs) | **A**: `governanceStatus` |
| `claim_verification` | `verifications` | `type == "claim_verification"` (the row validator's discriminator) | **A**: `governanceStatus` |
| `video_verification` | `videoVerifications` | `type == "video_verification"` | **A**: `governanceStatus` |

**Partition rule.** `research` = (contained Workspace runs) − (contained `research_adaptive` runs). Overlaps are counted exactly and returned as disclosed `anomaly` rows, expected to be 0. They are **never** silently assigned to either family:
- `research_adaptive` runs carrying a System A `governanceStatus`;
- `research` runs carrying `governanceRecord`.

---

## 4. Workspace containment (O2) — applies to every family

The Team list/detail row validators for all three collections:
- `lib/workspaces/teamRunRowValidation.ts`;
- `teamClaimVerificationRowValidation.ts`;
- `teamVideoVerificationRowValidation.ts`.

All three accept `projectId` only when it is **exactly `null`** or an **assigned string**. An absent or malformed `projectId` fails closed, and a Project of another Workspace is concealed. The summary applies the same boundary.

1. **Canonical Project set.** Every `projects` document with `workspaceId == W`, **active and archived**. This is the Workspace's Project listing, not a record scan.
2. **Contained count.** For a family F, `contained(F) = count(workspaceId == W ∧ F ∧ projectId == null) + Σ_batches count(workspaceId == W ∧ F ∧ projectId in batch)`.
   - The canonical ids are split into disjoint batches no larger than Firestore's `in` limit.
   - `projectId == null` matches only an explicit null, so a missing field is not contained, exactly as the validators treat it.
3. **Integrity anomaly.** `anomaly(F) = count(workspaceId == W ∧ F) − contained(F)`. This is exact. It covers:
   - missing `projectId`;
   - malformed `projectId`;
   - a deleted Project;
   - a Project of another Workspace.

   Only the count is returned, never the ids.
4. **Outcomes.** Every outcome count in §5–§7 is computed over **contained** records only. An integrity-invalid record never contributes to an ordinary family outcome.

**Residual limitation, disclosed in the response scope.** The row validators also check field shapes such as a `Timestamp` `createdAt` or `timestamp`, and the `userId` type. These cannot be expressed as aggregation predicates. Containment in this summary is the Workspace + Project boundary above; shape validity is not re-checked.

---

## 5. Completion (O3)

- **Research families** (`research`, `research_adaptive`). The governance denominator includes only contained runs with **`status == "complete"`**. `excludedNotComplete(F) = contained(F) − contained(F ∧ status == "complete")` is returned exactly beside it. A run that is still executing is never shown as a governance gap.
- **Claim and video verification.** The canonical Team document is created only after provider execution and Gate 2 succeed. Its existence is the completed artifact, so **no additional completion filter** is applied. The families have no completion-state contract to filter on.

---

## 6. Automated-outcome axis (D1, A1)

### 6.1 Buckets (six, all distinct)

`cleared`, `needs_attention`, `blocked`, `not_evaluated`, `error`, `not_recorded`.

- `error` = an evaluation that failed;
- `not_evaluated` = the evaluator ran and declined to assess;
- `not_recorded` = no automated outcome persisted.

These three are **never collapsed**.

### 6.2 Mapping

| Source | Stored field | Stored value | Bucket |
|---|---|---|---|
| A | `governanceStatus` (not human-reviewed, §6.3) | `approved` | `cleared` |
| A | `governanceStatus` (not human-reviewed) | `needs_review` | `needs_attention` |
| A | `governanceStatus` (not human-reviewed) | `blocked` | `blocked` |
| A | `governanceStatus` (human-reviewed) | any | `not_recorded`, `subReason: "superseded_by_human_decision"` |
| A | `governanceStatus` | other non-null value | `unmapped`, `storedStatus: "__other_recorded__"` |
| A | `governanceStatus` | missing or null | `not_recorded`, `subReason: "missing"` |
| B | `governanceRecord.automatedGovernance.status` | `passed` | `cleared` |
| B | same | `flagged` | `needs_attention` |
| B | same | `blocked` | `blocked` |
| B | same | `not_evaluated` | `not_evaluated` |
| B | same | `error` | `error` |
| B | same | other non-null value | `unmapped`, `storedStatus: "__other_recorded__"` |
| B | same | missing or null | `not_recorded`, `subReason: "missing"` |

### 6.3 System A human-review overwrite (A1)

`POST /api/governance/review` (`app/api/governance/review/route.ts:240`) writes the human decision **into `governanceStatus` itself**, together with `governanceReviewedBy` and `governanceReviewedAt`:
- `approved` → `approved`;
- `blocked` → `blocked`;
- `changes_requested` → `needs_review`.

Once `governanceReviewedAt` exists, the record's `governanceStatus` is a human decision, and the prior automated outcome is no longer persisted on the document.

So, over contained (and, for research, complete) records, with `reviewed` meaning `governanceReviewedAt > ""`:
- `automated(X) = count(governanceStatus == X) − count(governanceStatus == X ∧ reviewed)` for X ∈ {`approved`, `needs_review`, `blocked`};
- `superseded = Σ_X count(governanceStatus == X ∧ reviewed)`, reported as `not_recorded` / `superseded_by_human_decision`.

**Human-overwritten System A states never contribute to automated `cleared`, `needs_attention` or `blocked` counts.** The pre-review automated outcome is not recovered from `governanceEvents` in v1; that would be per-document reading.

### 6.4 Unknown stored values and the residual

Firestore `count()` cannot enumerate arbitrary distinct values, so unknown values collapse into one exact row:
- `other_recorded = count(field not-in <recognized vocabulary>)`. Firestore's `not-in` excludes documents where the field is absent. The implementation verifies against real Firestore how an explicit `null` value is treated; if `null` would match, `null` is added to the excluded list, so null always stays in `missing`;
- `not_recorded (missing) = total − Σ recognized − other_recorded`;
- for System A, `superseded` is reported separately from `missing`, both in the `not_recorded` bucket.

---

## 7. Human-decision axis (separate; never merged with §6)

Exact stored or exactly-derived statuses only. No cross-family score, and no combination with automated buckets. **`cleared` never implies human approval.**

| Source | Field / predicate | Human decision reported |
|---|---|---|
| B | `governanceRecord.humanReview.status` | as stored: `unreviewed`, `pending`, `approved`, `approved_with_conditions`, `changes_requested`, `rejected` (plus `__other_recorded__` per §6.4) |
| A | `governanceStatus == "approved" ∧ reviewed` | `approved` |
| A | `governanceStatus == "blocked" ∧ reviewed` | `blocked` |
| A | `governanceStatus == "needs_review" ∧ reviewed` | `changes_requested` |

The System A derivation is exact. The review route's only actions are `approved`, `blocked` and `changes_requested`, and it stores `changes_requested` as `needs_review`. So a reviewed `needs_review` record can only be a `changes_requested` decision.

System B decisions all write the same `governanceRecord.humanReview`:
- Personal reviewer (`submitAdaptiveHumanReview`, `lib/firestore/runs.ts`);
- Workspace review decision (`submitWorkspaceReviewDecision`);
- multi-reviewer finalization.

---

## 8. Denominators

For every family and system, all over **contained** records (and, for research, **complete** runs):
- `total(F)`;
- each recognized `count(X)`;
- `other_recorded`;
- `not_recorded = total − Σ recognized − other_recorded`, with the System A split into `superseded` and `missing`.

Beside them: `excludedNotComplete(F)` (research only) and `anomaly(F)` (§4).

Every displayed total carries its denominator. "27 cleared" is always "27 cleared of N completed <family> records", with `not_evaluated`, `error` and `not_recorded` visible beside it.

---

## 9. Response contract (structural)

The API returns rows, not just totals, so every rolled-up number can be taken apart again:

```ts
type Family = "research" | "research_adaptive" | "claim_verification" | "video_verification";

type GovernanceSummaryRow = {
  family: Family;
  sourceSystem: "A" | "B";
  axis: "automated" | "human";
  storedField: string;            // e.g. "governanceStatus", "governanceRecord.automatedGovernance.status"
  storedStatus: string | null;    // exact persisted value; "__other_recorded__"; null = missing
  normalizedOutcome?:             // automated axis only
    | "cleared" | "needs_attention" | "blocked" | "not_evaluated" | "error" | "not_recorded" | "unmapped";
  humanDecision?: string;         // human axis only (stored, or the exact §7 System A derivation)
  subReason?: "superseded_by_human_decision" | "missing";
  count: number;
};

type GovernanceSummaryResponse = {
  workspaceId: string;
  generatedAt: string;            // server time of the count queries
  scope: {
    bindingField: "workspaceId";
    projectContainment: "null_or_canonical_workspace_project"; // §4
    shapeValidationApplied: false;                              // §4 residual limitation
    researchCompletion: "status_complete";                      // §5
    teamWorkspaceOnly: true;
  };
  totals: Array<{ family: Family; sourceSystem: "A" | "B"; total: number; excludedNotComplete?: number; integrityAnomalies: number }>;
  rows: GovernanceSummaryRow[];
  anomalies: Array<{ kind: "family_overlap"; family: Family; field: string; count: number }>;
};
```

The UI may roll `rows` up by `normalizedOutcome` for display. It must keep the per-family, per-system rows for disclosure and drilldown, so a refactor cannot silently lose provenance.

---

## 10. Query contract (D4, amended)

- Every number is a Firestore **aggregation `count()`** over persisted predicates. No document of an artifact collection is read to compute a number; the only document read is the Workspace's Project listing (§4).
- **Permitted operators.** Only the minimum the contract needs:
  - `==`, e.g. `workspaceId`, family membership, stored status, `status == "complete"`, `projectId == null`;
  - `in`: Project-id batches, split at Firestore's `in` limit into disjoint batches whose counts are summed;
  - `not-in`: the §6.4 recognized vocabularies (System A 3 values, System B 5, human 6, each within Firestore's `not-in` limit);
  - the reviewed-marker range `governanceReviewedAt > ""`.
- **Unsupported operator combinations.** Where Firestore rejects a combination in one query (for example `not-in` together with `in`), the implementation uses an **equivalent exact decomposition into disjoint `count()` queries**. Example: `count(field != null ∧ …) − Σ recognized(…)`. It never falls back to a scan.
- **Families stay separate.** Families and source systems are queried separately. Counts are combined only by the §6.2 and §7 mappings.
- **Index policy.** The implementation determines the required composite indexes **against real Firestore** (emulators do not enforce index requirements). It adds only those Firestore demands, each recorded with the query shape that needs it.
- **Forbidden.** No `limit`, cursor window, sampling, rollup write, denormalized field, scheduler or backfill.

---

## 11. Excluded from v1

- Numeric `consensusScore`, `overallConsensusScore` and `evidenceQuality` (D2).
- Adaptive `consensusLevel` and `sourceGroundingLevel` tiers (D2).
- Any trend or time-windowed series.
- **D5 (separate item).** System A governance applies the same 80/70 consensus thresholds to all three numeric formulas. This may itself be semantically wrong; it is tracked separately and is not needed for an outcome summary that excludes scores.

---

## 12. Stop condition (v1 implementation)

- Every Workspace governance-summary count is an exact aggregation of one explicitly identified persisted field and value (or the exact predicates of §4–§6), within one report family and one governance source system.
- Cross-family arithmetic is limited to summing counts whose stored statuses have an approved mapping to the same governance-outcome bucket.
- Numeric quality scores and adaptive presentation tiers never participate.
- `error`, `not_evaluated` and `not_recorded` remain distinct.
- Human decisions remain a separate axis.
- Human-overwritten System A states never contribute to automated `cleared`, `needs_attention` or `blocked` counts.
- Project-integrity-invalid artifacts never contribute to ordinary family outcomes, and are disclosed separately.
- Research governance denominators include only completed runs, with non-complete runs disclosed separately.
- Unknown non-null stored values are one exact `__other_recorded__` row, never folded into a bucket or into `not_recorded`.
- Every displayed total has an exact denominator. Every normalization bucket can be exactly rebuilt from persisted predicates, and broken back down into its source family and system counts.
- No record-window scan, sampling, inferred pass, new write path, rollup document, scheduler or backfill is introduced.
