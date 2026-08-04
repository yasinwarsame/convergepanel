# Governance & Decision Receipts — Phase 2 Audit + Design

**Date:** 2026-07-29
**Scope:** Phase 2, step 1 ("audit the existing governance and peer-review system") + step 2 ("define schema-aware governance semantics"), read-only plus this document — no implementation code touched.
**Method:** every finding below is from a fresh, full read of the governance system this session (all of `lib/governance/*.ts`, the review/reviewer API routes, `GovernanceDashboard.tsx`'s data model), not recalled from the Phase 0 audit, which only sampled this system narrowly.

---

## 1. Executive summary

There are **two separate, parallel governance systems** in this codebase, not one — a fact the Phase 0 audit didn't fully surface (it only found the first). Both are built entirely around the legacy claims-matrix `ConsensusSummary` concept and have zero awareness of `queryType`/`answerShape`/any Milestone 2 schema. Neither supports multi-reviewer tracking, comment threads, or decision-receipt structure beyond a single flat "who reviewed it last and what they said." Reviews are **not versioned** — a re-review overwrites the prior one; there is no history of past review decisions.

**Answering the standing question directly: persistence does not need to be redesigned.** Both existing systems write their governance data as additive, merged fields on the SAME `runs/{runId}` document Phase 1 already writes `adaptiveOutput` to. The natural, consistent place for a new schema-aware `governanceRecord` is right alongside it, on the same document, using the same additive-merge pattern `persistAdaptiveOutput()` already established. No blocker found.

---

## 2. System A — Org-wide automated policy governance

**Files:** `evaluateGovernance.ts`, `evaluateAndStore.ts`, `governancePolicyStore.ts`, `auditLog.ts`.

- Single global policy document (`appConfig/governancePolicy`), cached 60s in-process (`evaluateAndStore.ts`'s `cachedPolicy`).
- `GovernanceInput` (the ONLY schema-awareness point in this whole system, and it's minimal): `{ consensusScore, evidenceQuality: "strong"|"mixed"|"weak"|null, sourceBacked, missingSourcesCount, modelHealth, verificationVerdict?, question, runType: "research" | "verification" }` — **two values only**, confirmed again this pass. A video-verification run (written to the `videoVerifications` collection) is evaluated through this same function but has no dedicated `runType` value of its own.
- `evaluateGovernance()` is pure/deterministic (`policy` × `input` → `{status, reasons, meta}` where `status: "approved"|"needs_review"|"blocked"`) — no async, no side effects, easy to extend.
- `evaluateAndStoreGovernance()` gates on plan (`entitlements.planId !== "free"`), writes `governanceStatus`/`governanceReasons`/`governanceMeta` onto the run's own document (merge), appends to a `governanceEvents` SUBCOLLECTION under that same document (one event per evaluation, action `"evaluated"` only — automated, not a human review), and also writes to the global append-only `admin_audit_logs` top-level collection via `writeAuditEvent()`.
- **No `queryType`/`answerShape` anywhere in this system.** Extending it to consider a Milestone 2 schema's own `CommonResponseMeta.requiresHumanReview`/`riskLevel` in the policy evaluation is straightforward — `GovernanceInput` just needs additive optional fields.

## 3. System B — Team governance + peer review

**Files:** `teamTypes.ts`, `policyEngine.ts` (a SECOND, DIFFERENT PolicyRule concept from System A's), `teamGovernancePipeline.ts`, `reviewerFields.ts`, `governanceVisibleUserIds.ts`, review/reviewer API routes, `GovernanceDashboard.tsx`.

- Per-team policy rules (`teams/{teamId}.policyRules: PolicyRule[]`, condition types `consensus_below`/`evidence_quality`/`model_health`, actions `flag`/`block`/`require_review`) — entirely separate from System A's org policy, with its own `DEFAULT_POLICIES`.
- `applyTeamGovernancePipeline()` writes a FULL audit copy to a separate top-level `teamRuns` collection (`id`, `teamId`, `userId`, `query` (truncated to 5000 chars), `verdict`, `consensusScore`, `consensusSummary`, `auditBundle: TeamRunAuditBundle`, `policyFlags`, `timestamp`, `runId`/`verificationId` back-references) — genuinely a second copy of the run's governance-relevant data, not just a status flag. `TeamRunAuditBundle` is a union: either the Claim Verification system's own `AuditBundle`, or an inline, hand-shaped `{kind: "research_synthesis", claims: [{claimTruncated, supportRatio, evidenceQuality}], ...}` object — **hard-coded around the legacy claims-matrix shape**, with no slot for any Milestone 2 result at all.
- Also writes a lightweight `TeamGovernanceSnapshot` (`{policyFlags, blocked, governanceReviewRequired, blockMessage?, evaluatedAt}`) merged onto `runs/{runId}.teamGovernance` — this is the ONLY piece of System B that touches the individual user's own run document; the richer `teamRuns` copy lives entirely separately.
- **Peer review itself** (`POST /api/governance/review`): single-reviewer, single-decision, NOT an array. One reviewer records ONE action (`"approved" | "blocked" | "changes_requested"`) with an optional/required comment, written as FLAT fields directly on the run/verification/video document: `governanceReviewedBy` (one uid), `governanceReviewedAt`, `governanceReviewComment` (one string). A second review **overwrites** the first — there is no history, no reviewer array, no per-reviewer status, no comment count. `reviewableStatuses = {"needs_review", "blocked"}` — an `"approved"` run is terminal and can't be re-reviewed through this endpoint (a blocked→approved override is explicitly allowed and logged, everything else is a hard `already_reviewed`/`invalid_status` rejection).
- **Reviewer assignment** (`/api/governance/reviewer`) is a SEPARATE, simpler mechanism: an admin grants/revokes a specific uid permission to review a specific run-owner's work (`users/{ownerUid}.governanceReviewerFor: arrayUnion/arrayRemove(reviewerUid)`) — a permission list, not a per-run reviewer roster.
- `TeamRunHumanDecision = {action: "approved"|"rejected"|"escalated", decidedBy, decidedAt, notes}` exists on the `TeamRunDocument` type but — important — **I found no write site that actually populates it** in the files read this pass; the live review flow above writes the flatter `governanceReviewed*` fields on the run document instead, not this richer-looking type. Likely an earlier or aspirational shape that the shipped review endpoint didn't end up using. Treat `TeamRunHumanDecision` as a naming/shape precedent worth learning from, not a working mechanism to build on.

## 4. Direct verdict against the Phase 2 requirements

| Phase 2 concept | Reuse verdict | Why |
|---|---|---|
| `reviewStatus` (unreviewed/in_review/approved/approved_with_conditions/rejected/superseded) | **Partial reuse** | The existing `governanceStatus: "approved"\|"needs_review"\|"blocked"` covers half of this vocabulary. `"approved_with_conditions"`, `"superseded"`, and a genuine `"in_review"` (vs. just "not yet reviewed") don't exist today — worth adding as new values on a NEW field rather than overloading the existing one, since existing UI/policy code branches on the existing 3-value set and must keep working unchanged. |
| `reviewers[]` (multi-reviewer, per-reviewer status, comment count) | **Not reusable — genuinely new** | The existing system is single-reviewer/single-decision/overwriting. Building `reviewers[]` requires new structure, not an extension. |
| `decisionReceipt` (conclusion/basis/assumptions/uncertainties/sources/humanDecision/conditions) | **Not reusable — genuinely new**, but `CommonResponseMeta.limitations`/`uncertainties` (Phase 1) and each schema's own result fields (e.g. `decision_support.recommendation.rationale`/`.caveats`, `deep_research.researchBoundaries`) are the exact right INPUTS to derive a receipt's `basis`/`assumptions`/`uncertainties` from — no need to re-collect this data, only to shape it per schema (this is what the schema-specific receipt requirement asks for). |
| `supersedesRunId`/`version` | **Not reusable — genuinely new** | Confirmed: no version/supersedes concept exists anywhere in either system. A rerun today creates a brand-new, entirely unrelated `runId` (unchanged Phase 1 behavior) with no link back to a prior approved run at all. |
| Peer-review UI | **Reuse the shell, extend the data model** | `GovernanceDashboard.tsx`'s queue/filter/audit-trail UI (2359 lines) is real, working, and already handles all three existing run types (`research`/`verification`/`video` via `runType` badges) — extending it to show `queryType`/`answerShape`-aware context is additive UI work on an existing surface, not a rebuild. |
| Export | **Does not exist** (confirmed again — matches Phase 0's finding) | Nothing in the governance system exports anything either; the review UI is read/decide only. |

## 5. Proposed schema-aware governance semantics (design, not yet implemented)

Given the audit above, the concrete plan for the rest of Phase 2's ordering:

1. **New fields, additive, on `runs/{runId}`** — same document, same merge pattern as `adaptiveOutput` (Phase 1) and `teamGovernance` (existing System B). Nothing about Phase 1's persistence design changes; this is one more additive top-level field: `governanceRecord?: GovernanceRecord`.
2. **`GovernanceRecord` reuses `governanceStatus`'s existing 3 values as a subset** of a richer status enum, rather than replacing them — existing policy-evaluation code (System A) and the existing review endpoint keep writing exactly what they write today, unchanged. The new schema-aware `reviewStatus` is a SEPARATE field for records that actually have an adaptive envelope to review, not a replacement of `governanceStatus` for the 10 legacy-active schemas.
3. **Decision receipts are schema-specific, built from data Phase 1 already computed** — a new adapter (mirroring `commonResponseMeta.ts`'s pattern exactly: one function per schema, one shared entry point) turns each of the 9 `AdaptiveSchemaResult` shapes into a `DecisionReceipt`, using each schema's own already-meaningful fields (per the mapping the earlier Phase 2 spec listed: `decision_support` → recommendation/criteria/risks/assumptions/uncertainties/reversible step; `deep_research` → executive summary/findings/disagreements/gaps/boundaries; etc.) — no new model calls, no new aggregation logic, purely a reshaping layer.
4. **Multi-reviewer `reviewers[]` is new structure** but should live on the SAME `GovernanceRecord`, not a new collection — a small array of `{userId, displayName?, status, commentCount?}`, with the review API extended (additively — a new action type or a new endpoint, TBD at implementation time) to append/update an entry rather than overwrite a single flat field.
5. **Rerun/versioning**: `supersedesRunId`/`version` added to `GovernanceRecord` only — never touches how a rerun is created today (still a new, independent `runId`), just adds an optional link the CLIENT can populate when the user explicitly reruns from an existing approved run's context (a new, deliberate user action, not automatic).
6. **Legacy behavior preserved by construction**, not by a compatibility shim: `GovernanceRecord` is entirely additive and only ever populated for runs that have an `adaptiveOutput` (i.e. the 9 active Milestone 2 schemas) — the 10 legacy-active schemas, Claim Verification, and Video Verification keep using System A/System B exactly as they do today, completely untouched.

## 6. Phase 2A, Step 1 — integration-point verification (2026-07-29)

Re-verified against fresh reads this pass, going beyond the previous session's audit (§2-§4 above). One finding here changes the Phase 2A design meaningfully — see 6j.

**a. Exact run-document governance fields (System A):** `governanceStatus`, `governanceReasons`, `governanceMeta` (written by `evaluateAndStoreGovernance`); `governanceReviewedBy`, `governanceReviewedAt`, `governanceReviewComment` (written by `POST /api/governance/review`) — all flat, top-level, on `runs/{runId}` directly (also `verifications/{id}`, `videoVerifications/{id}` for the other two collections this route serves).

**b. Exact `teamRuns` fields:** confirmed unchanged from §3 — `id, teamId, userId, userEmail, type, query (≤5000 chars), verdict, consensusScore, consensusSummary, auditBundle, policyFlags, timestamp, runId?, verificationId?`.

**c. Single-reviewer status vocabulary:** `governanceStatus: "approved" | "needs_review" | "blocked"` (System A / the review endpoint's target field); review `action: "approved" | "blocked" | "changes_requested"` (the verb a reviewer submits — `"changes_requested"` maps back to status `"needs_review"`, not a fourth status value).

**d. Review API overwrite behavior:** confirmed again — `ref.set(patch, {merge:true})` replaces `governanceReviewedBy/At/Comment` wholesale; no prior value is preserved or archived anywhere.

**e. How automated governance is actually triggered — the important new finding:** for research runs, `evaluateAndStoreGovernance()` is called from exactly one place: `app/api/synthesize-panel/route.ts`, AFTER the legacy claims-matrix narrative synthesis (`enrichedSynthesis`/`keyFindings`/`disagreements`) completes, using `governanceInputFromResearchRun()` which reads `synthesisConsensusSummary`/`synthesizedStructuredReport` off the run doc — fields that only exist once synthesis has run.

**f. Governance events:** unchanged from §2 — `governanceEvents` subcollection under the run/verification/video doc, action `"evaluated"` only (automated), plus a global `admin_audit_logs` append-only write.

**g. Dashboard data fetching:** `GovernanceDashboard.tsx` queries the `runs`/`verifications`/`videoVerifications` collections directly (via the queue API routes) filtered by `governanceStatus`/`runType`, using the visible-user-id resolver for access scoping — no separate read model to duplicate.

**h. Whether adaptive runs currently appear anywhere in governance: confirmed NO, definitively.** `app/page.tsx`'s own code comment (`"Skipped entirely for adaptive runs — AdaptiveResultsView is the sole..."`) confirms `generateSynthesisAutomatically()` — the only path that reaches `synthesize-panel`, which is the only trigger for research-run automated governance — is never called when an adaptive result is present. Zero adaptive run has ever been evaluated by System A, appeared in a `governanceEvents` write, or reached the dashboard queue. This is stronger than the prior session's "governance doesn't understand the taxonomy" finding: it's not a matter of the data being misinterpreted, governance is **never invoked at all** for these runs today.

**i. Whether a run can be governed without `ConsensusSummary`:** the pure function `evaluateGovernance()` itself tolerates it structurally (`consensusScore: number | null`, `evidenceQuality: ... | null` are both nullable in `GovernanceInput`) — but the only existing INPUT BUILDER, `governanceInputFromResearchRun()`, is wired to read claims-matrix-only fields (`synthesisConsensusSummary`, `synthesizedStructuredReport`) that never exist on an adaptive run. So: the evaluator can run on null-ish input in principle, but nothing today constructs a valid `GovernanceInput` from an adaptive run's actual data (`CommonResponseMeta`, `adaptiveOutput`). A NEW input builder is required — this was already implicit in the Phase 2A plan, now confirmed as a hard requirement, not an optional enhancement.

**j. Delete-flow cleanup:** `app/api/admin/purge-runs/route.ts` deletes only from the `runs` collection directly — it does **not** clean up matching `teamRuns` documents or `governanceEvents` subcollections. This is a **pre-existing gap**, not something Phase 2A introduces or needs to fix: a new `governanceRecord` field living directly ON `runs/{runId}` (per this doc's §5 design) is deleted automatically along with the run — no new orphan risk. `teamRuns`'s existing orphan risk is unchanged by Phase 2A and out of scope for it.

**k. Access controls:** already real and reusable as-is — `resolveGovernanceVisibleUserIds`/`runOwnerVisibleInGovernance` (read/write scoping by reviewer assignment) and `checkGovernanceAccess`/`resolveGovernanceRequestUser` (auth + plan gating) both operate at the request-handler level against whichever collection/doc is named, not against a hardcoded field list — a Phase 2A endpoint reading/writing `governanceRecord` on the same `runs/{runId}` doc inherits this protection for free, no new access-control code needed.

**No blocker found that halts Phase 2A.** Finding (e)/(h)/(i) together mean Phase 2A's automated-governance evaluation for adaptive runs must get its own trigger and input builder rather than reusing `synthesize-panel`'s hook — which the design in §5 already assumed (a new, separate path, never routed through claims-matrix synthesis). Worth making explicit for Step 2's design: the natural trigger point for an adaptive run's automated governance evaluation is `app/api/run-panel/route.ts`, right alongside where `persistAdaptiveOutput()` already runs (Phase 1) — evaluating directly against the just-built `CommonResponseMeta`, never waiting on or requiring a synthesis step that adaptive runs don't have.

## 6a. Step 2 — GovernanceRecordV1 contract (implemented, 2026-07-29)

`lib/adaptiveSchema/governanceRecord.ts` — `GovernanceRecordV1` + `AdaptiveDecisionReceipt`, mirroring `persistedOutput.ts`'s own precedent (a dedicated file for a versioned top-level contract). Types only at this step — no evaluator, no receipt builder, no API wiring, no persistence write path yet; those depend on content not yet received (see §7).

Two corrections made after verifying actual repository conventions rather than following the proposed shape verbatim:
- `automatedGovernance.policyVersion: number`, not `string` — `evaluateGovernance.ts`'s own `GovernancePolicy.policyVersion` and every site that persists it (`governanceEvents`, `admin_audit_logs`) use `number` throughout.
- `decisionReceipt.sources: string[]`, not `Source[]` — no structured `Source` type exists anywhere in this codebase; every one of the 9 schemas' own result types uses plain string labels.

One deliberate design refinement: `AdaptiveDecisionReceipt` does NOT repeat `humanDecision`/`conditions` from the earlier draft shape — `GovernanceRecordV1.humanReview` already owns the review outcome. The receipt is scoped strictly to the schema's own deterministic content (conclusion/basis/assumptions/uncertainties/sources), never the review decision made about it — avoids two fields that could disagree about "conditions" if a receipt were ever rebuilt after a review was recorded.

Verified: clean `tsc --noEmit`, full suite still passing (1108/1108), zero protected-path diff. The type is currently unreferenced by any other file (no runtime behavior yet) — safe, inert addition.

## 6b. Step 3 — decision receipt builders (implemented, 2026-07-29)

`lib/adaptiveSchema/decisionReceiptBuilder.ts` — one public entry point, `buildAdaptiveDecisionReceipt(adaptiveOutput: PersistedAdaptiveOutputV1): AdaptiveDecisionReceipt`, dispatching to 9 internal per-schema builders by `schemaId`. Pure data reshaping only — no model call, no classifier call, no network call, no re-aggregation; every builder reads only `adaptiveOutput.result` and `adaptiveOutput.meta`, both already computed by Phase 1.

**Contract change made during implementation** (per the "unless implementation exposes a real incompatibility" allowance): `AdaptiveDecisionReceipt` (§2, `governanceRecord.ts`) gained three fields — `limitations: string[]`, `sourceBacked: boolean`, `humanReviewNeeded: boolean` — that the original 5-field shape (conclusion/basis/assumptions/uncertainties/sources) had no home for, even though Step 3 explicitly required the builder to "preserve limitations, source support, and human-review signals." All three are preserved verbatim from `CommonResponseMeta`, never independently recomputed — the exact same "one source of truth, reused" discipline `commonResponseMeta.ts`'s own adapters established in Phase 1. `humanReview`'s own `status`/`conditions` on `GovernanceRecordV1` remain the only place the REVIEW OUTCOME lives — the receipt still only ever describes what the run concluded, never what a reviewer decided about it.

**Per-schema mapping** (what feeds `basis` / `uncertainties` / `assumptions` / `limitations` / `sources` for each):

| Schema | conclusion | basis | uncertainties | limitations (beyond meta) | sources |
|---|---|---|---|---|---|
| `ranked_enumeration` | shortfall note verbatim, or a count-aware summary sentence | ranked items + coverage | low-confidence items | — | item `sources` |
| `comparison_matrix` | subject/attribute count summary, explicit "no recommendation" when none exists | subjects + attributes | low-confidence subjects/attributes | — | cell `sources` |
| `definition_explanation` | primary interpretation's direct answer | explanation + key points | ambiguity + alternate interpretations | — | interpretation `sources` |
| `causal_explanation` | direct answer | direct causes + other factor categories (alternatives excluded) | alternative explanations, disputed interpretations, confounders, unknowns, tests needed | — | none (schema has no source label list, only a boolean) |
| `checklist_taxonomy` | `summary`, or a mode-aware count sentence | items (category-labeled, critical-flagged) | low-confidence items | panel `notes` | none (schema never collects sources) |
| `deep_research` | executive summary | findings + coverage | disagreements, evidence gaps, open questions, panel blind spots | research boundaries | none (only a per-finding boolean exists) |
| `evidence_review` | overall assessment | overall strength + dimensions + strengths | red flags + applicability caveats | recommended checks | none (only a response-level boolean exists) |
| `bias_blindspot_audit` | `summary` | Tier 1 attributed biases + Tier 2 panel omissions (each explicitly labeled) | no-attribution reason, shared assumptions, missing stakeholders, Tier 3 concerns, homogeneity message, follow-up questions | — | none (Tier 3 tracks citation coverage counts, not labels) |
| `decision_support` | action label + recommended option (if any) + rationale — action is never hidden behind prose | criteria + option×criterion assessments | self-reported uncertainties, sensitivity findings, contested-recommendation flag | risks, caveats, reversible next step | none (only a response-level boolean exists) |

**Source handling:** every builder reads only pre-existing plain-string source labels already present on the result (never fetched, never invented, never converted into a structured object) and deduplicates by EXACT string match — deliberately not `textSimilarity.ts`'s `dedupeTextList`, which does fuzzy Levenshtein/token-overlap clustering. That's real re-interpretation, and aggregation has already happened once, inside each schema's own alignment module; the receipt reshapes, it doesn't re-cluster. Six of the nine schemas (`causal_explanation`, `checklist_taxonomy`, `deep_research`, `evidence_review`, `bias_blindspot_audit`, `decision_support`) have no per-unit source label list at all in their aggregated result (only a response-level `sourceBacked` boolean or, for `bias_blindspot_audit`, a citation-count stat) — their receipts honestly return `sources: []` rather than fabricating labels. Only `ranked_enumeration`, `comparison_matrix`, and `definition_explanation` collect real per-unit source labels their receipts can preserve.

**Determinism / zero-model-call guarantee:** every builder is a pure function of its two inputs — no `Date.now()`, no randomness, no I/O. Verified by a dedicated test (`decisionReceiptBuilder.spec.ts`) asserting the same input produces a deeply-equal receipt across two calls, plus mocked `callGemini`/`classifyQuery` asserted never-called across every schema.

**Error behavior:** the public function returns `AdaptiveDecisionReceipt` directly (matching the literal signature given), not a result union — because the input, `PersistedAdaptiveOutputV1`, is a discriminated union where TypeScript itself guarantees `schemaId`/`result` correspondence for any normally-typed caller. The only reachable failure mode is a `schemaId` that bypasses the type system entirely (e.g. a corrupted object forced through `as`), which is genuinely rare per the phase's own framing ("impossible states should be rare"). That case throws a dedicated `DecisionReceiptBuildError`, never a partially-built or generic-fallback receipt. The `switch`'s `default` branch also serves as a **compile-time exhaustiveness check**: adding a 10th schema variant to `PersistedAdaptiveOutputV1` without a matching `case` here fails `tsc --noEmit`, not just a runtime test — verified by inspection of the `assertNeverSchemaId(schemaId: never)` pattern (a real, unmutilated instance of this check was not manually broken to re-verify at runtime, since doing so would require temporarily corrupting a shipped type — the pattern itself is TypeScript's standard, well-established exhaustiveness idiom).

**What the receipt intentionally excludes:** raw per-model text (bias evidence excerpts, direct quotes) — only already-synthesized summary content (bias `description`/`impact`, finding `summary`/`title`) is included, per "avoid copying raw model-level text unnecessarily." No numeric certainty/confidence score anywhere. No review outcome, reviewer identity, or conditions — those live exclusively on `GovernanceRecordV1.humanReview`. No content invented to fill an empty array — every schema with genuinely no applicable data for a given field (e.g. `causal_explanation`'s `assumptions`, `checklist_taxonomy`'s `sources`) returns `[]` honestly rather than fabricating a placeholder.

**Why review outcomes stay outside the receipt:** the receipt is generated once, deterministically, from the same `adaptiveOutput` every time it's rebuilt — it must be re-derivable and stable. A reviewer's decision is a separate, stateful, human act that happens once and shouldn't retroactively change what the receipt says the run concluded. Keeping them on separate fields (`decisionReceipt` vs. `humanReview`) means a receipt rebuilt after a review was recorded can never silently disagree with the review about what was reviewed.

Tests: `decisionReceiptBuilder.spec.ts` — 60 tests, confirmed by both isolated run (`Tests: 60 passed, 60 total`) and direct enumeration (43 shared-contract cases incl. 4 `it.each` blocks over all 9 schemas, + 17 per-schema cases: 2+2+2+2+1+1+1+2+4). This is the only test file Step 3 added.

Full-suite count: **1170/1170**, stable across repeated runs. Reconciled against the prior 1108/1108 checkpoint (line 98 above): 1108 + 60 explicit tests = 1168, 2 short of 1170. Root-caused (superseding an earlier, wrong "single-run reporting imprecision" guess recorded here before the actual mechanism was found — see the correction in §6c below): `lib/adaptiveSchema/__tests__/importBoundaries.spec.ts` runs `it.each(files...)` over every `.ts`/`.tsx` file it finds by recursively scanning `lib/adaptiveSchema/` and `components/adaptive/` — **including their own `__tests__` subdirectories** — and generates one "has no forbidden import" test per file found, independent of that file's own content. Step 3 added exactly two files under those directories (`decisionReceiptBuilder.ts` and `decisionReceiptBuilder.spec.ts`), so the import-boundary scan alone contributed the missing +2: 1108 + 60 (explicit) + 2 (import-boundary scan, one per new file) = 1170. Confirmed by direct reproduction in §6c.

Clean `tsc --noEmit`, clean lint, zero protected-path diff.

**Step 3 is complete. Runtime governance lifecycle (persistence of `governanceRecord`, automated evaluation trigger, dashboard/review wiring) is NOT touched in this step** — `decisionReceiptBuilder.ts` and the extended `AdaptiveDecisionReceipt` type are, like `governanceRecord.ts` before it, currently unreferenced by any runtime code path. Safe, inert addition.

## 6c. Step 4 — governance record validation and snapshot immutability (implemented, 2026-07-29)

`lib/adaptiveSchema/governanceRecordParser.ts` — three pure, additive, unreferenced-by-runtime exports:

**`parseGovernanceRecord(raw: unknown): GovernanceRecordParseResult`** — never throws; mirrors `persistedOutput.ts`'s own `parsePersistedAdaptiveOutput` deliberately (same four-state failure vocabulary: `valid` / `absent` / `malformed` / `unsupported_version`; same "structural check sufficient to prevent a caller trusting corrupted data" scope, not a full re-derivation). Validates, in order: presence, plain-object shape, `version === 1`, `schemaId` is one of the 9 real `PersistedAdaptiveSchemaId` values (reusing `persistedOutput.ts`'s own `SCHEMA_ANSWER_SHAPE` export directly — not a redefined copy), `answerShape` matches that schemaId via the same registry mapping, `adaptiveOutputVersion === 1`, the optional `automatedGovernance` object's fields/status enum, the required `humanReview` object's status enum, `decisionReceipt`, and `createdAt`/`updatedAt` as parseable ISO timestamps. Failure reasons are fixed static strings only — never echo raw receipt content back to the caller.

**Important correction acted on in this step:** `AdaptiveDecisionReceipt` is a single uniform eight-field shape (`conclusion`, `basis`, `assumptions`, `uncertainties`, `limitations`, `sources`, `sourceBacked`, `humanReviewNeeded`), not a per-schema discriminated union — schema-specific content (ranked items, comparison subjects/criteria, causal factors, a decision recommendation, evidence dimensions, etc.) was already flattened into that uniform shape by `decisionReceiptBuilder.ts` in Step 3. **No persisted schema-specific receipt union exists in this codebase**, so `parseGovernanceRecord` validates only the real eight fields and does not require or recognize schema-specific field names (`rankedItems`, `subjects`, `criteria`, `recommendation`, etc.) — adding those would silently redesign the persisted contract rather than validate it. The receipt carries no `schemaId` of its own; its schema association is only ever the parent `GovernanceRecordV1.schemaId`, checked once against `answerShape`, never repeated on the receipt itself.

**`canRefreshDecisionReceipt(parseResult: GovernanceRecordParseResult): ReceiptRefreshDecision`** — pure; takes a `parseGovernanceRecord` result directly (never re-derives parse state, so refresh eligibility can never disagree with the parser). Rule:

| State | Refresh allowed? |
|---|---|
| absent (no record yet) | yes |
| `humanReview.status === "unreviewed"` | yes |
| `humanReview.status === "pending"` | yes |
| `humanReview.status === "approved"` | no |
| `humanReview.status === "approved_with_conditions"` | no |
| `humanReview.status === "changes_requested"` | no |
| `humanReview.status === "rejected"` | no |
| `malformed` | no |
| `unsupported_version` | no |

**`pending` is a new Phase 2A semantic choice, not inherited System B behavior.** System B's single-reviewer flow (§6) has no live "pending" state at all — it moves directly from `needs_review` to a terminal decision in one action. `GovernanceRecordV1.humanReview`'s `"pending"` is new vocabulary this contract introduces, so there was no legacy rule to verify it against, only a fresh one to define and document: `pending` means a review has been started/assigned but has not yet reached a substantive human decision, so nothing has been decided yet that a rebuilt receipt could contradict — refresh stays allowed. Once any terminal or evaluative outcome exists (approved, approved_with_conditions, changes_requested, rejected), the receipt becomes immutable, because a reviewer's decision was made about the specific content that existed at that time.

**`applyHumanReviewUpdate(record, update, now?): HumanReviewUpdateResult`** — pure; returns a NEW `GovernanceRecordV1`, never mutates `record` or `update`. Touches only `humanReview` and `updatedAt`; `decisionReceipt`, `schemaId`, `answerShape`, `adaptiveOutputVersion`, `createdAt`, and `automatedGovernance` are carried over unchanged (spread, never re-derived or re-evaluated). Requires a non-empty `conditions` array for `approved_with_conditions` (`conditions_required` failure otherwise); clears `conditions` to `undefined` for every other status, even if the caller supplies some, so a status change away from `approved_with_conditions` can never silently retain stale conditions. Rejects an invalid status, non-string reviewer fields, an unparseable `reviewedAt`, or a non-string-array `conditions` with a specific failure reason rather than throwing. `now` is an injected, optional timestamp (defaults to real current time) purely for deterministic testing — not a second inconsistent timestamp convention, still an ISO string matching every other timestamp in this contract.

**Tests:** `governanceRecordParser.spec.ts` (62 — valid/absent/malformed/unsupported_version parsing, every required field individually invalidated, schemaId/answerShape mismatch, the real eight-field receipt shape validated field-by-field, confirmation that schema-specific field names are neither required nor rejected (simply irrelevant), invalid timestamps, JSON round-trip, and a hostile-input battery proving the parser never throws) and `governanceRecordImmutability.spec.ts` (30 — refresh-allowed/blocked for every state in the table above, non-mutation of both the input record and the update object, `decisionReceipt`/`schemaId`/`answerShape`/`adaptiveOutputVersion`/`createdAt`/`automatedGovernance` all verified unchanged, `updatedAt` verified changed, conditions required/cleared rules, malformed-update rejection, and zero connector/classifier calls via the same `callGemini`/`classifyQuery` mock pattern Step 3's tests use).

**Test-count reconciliation (verified, not estimated):** starting from Step 3's confirmed 1170/1170. `governanceRecordParser.spec.ts` contributes 62 (isolated run, confirmed), `governanceRecordImmutability.spec.ts` contributes 30 (isolated run, confirmed) — 92 explicit tests total. Step 4 added three files under `lib/adaptiveSchema/` (`governanceRecordParser.ts`, `governanceRecordParser.spec.ts`, `governanceRecordImmutability.spec.ts`), so `importBoundaries.spec.ts`'s per-file scan (§6b) contributes +3 more, independent of any test written here. Reconciliation was verified directly, not just computed: with the two new spec files temporarily removed from disk, the full suite ran 1171/1171 stable across two runs (1170 + 1, for `governanceRecordParser.ts` alone) — confirming the import-boundary mechanism contributes exactly what the arithmetic predicts before the spec files were even restored. With all three files in place: **1170 + 92 + 3 = 1265**, confirmed by two consecutive full-suite runs, both exactly 1265/1265.

Clean `tsc --noEmit`, clean lint, zero protected-path diff.

**Step 4 is complete. No Firestore persistence, no API route wiring, no automated-governance trigger, no `teamRuns` changes, no dashboard changes, no history changes, no export functionality** — `governanceRecordParser.ts`'s three exports are, like every file in Phase 2A before it, currently unreferenced by any runtime code path. Safe, inert addition.

## 8. Step 5, Part A — write-lifecycle audit (2026-07-29)

Read-only audit of `app/api/run-panel/route.ts` and `lib/firestore/runs.ts` before any Step 5 implementation, per the standing "audit before editing" discipline. No major contradiction found — see §9 for why implementation is nonetheless paused.

**Where `adaptiveOutput` becomes available and gets persisted, in order, all inside the single `POST` handler:**
1. `finalizeAdaptiveRun()` runs (route.ts:853) and returns `adaptiveOutput.persistedOutput` — an in-memory `PersistedAdaptiveOutputV1 | undefined` (`undefined` for the 10 legacy-active schemas; defined only for the 9 Milestone 2 schemas).
2. If defined, `persistAdaptiveOutput(runId, adaptiveOutput.persistedOutput)` is called (route.ts:895) — the ONLY call site in the whole codebase (confirmed by repo-wide grep; `createRun`/`completeRun`/`markRunError`/`persistAdaptiveOutput` are each called exactly once, all from this one route).
3. `persistAdaptiveOutput` (runs.ts:340) estimates size via `estimateDocumentSize({ adaptiveOutput: output })` against `MAX_TOTAL_DOC_SIZE` (850,000 chars) **before** attempting any write — oversized data is omitted, never truncated (unlike `completeRun`'s per-model text, which truncates in place; a structured object can't be safely truncated the same way). If the size check passes, it writes via `adminDb.collection("runs").doc(runId).set({ adaptiveOutput: output }, { merge: true })` — a single-field additive merge, not a full-document overwrite.
4. A thrown/rejected write is caught by the caller (route.ts:904), never re-thrown — `persistenceStatus` becomes `"failed"` in the response, but the request continues and still returns the in-memory `adaptiveOutput` to the client either way. The run's own `runDocument`/token-usage fields (written earlier, by `completeRun`) are already durable by this point and are never touched by this call, so a governance/adaptiveOutput write failure structurally cannot corrupt them.

**Firestore merge semantics:** every write in this file after `createRun`'s initial `.set()` (no merge option — full initial document) uses either `.update()` (`completeRun`, `markRunError` — fails if the doc doesn't exist, which is fine since `createRun` always runs first in the same request) or `.set(..., { merge: true })` (`persistAdaptiveOutput` only). `{ merge: true }` on a single top-level key (`adaptiveOutput`) touches only that key — every other field on the document (including System A's `governanceStatus`/`governanceReasons`/`governanceMeta`, System B's `teamGovernance`, and the flat `governanceReviewedBy`/`At`/`Comment` fields) is left completely untouched. A new `governanceRecord` field would behave identically: no name collision with any existing field on the run document (verified by grep across `lib/governance/`, `lib/firestore/`, `teamGovernancePipeline.ts` — none of them write a field called `governanceRecord`).

**Ownership checks:** none exist inside `lib/firestore/runs.ts` itself, and none are needed for the write paths — `runId` is always server-generated (`` `run-${randomUUID()}` `` at route.ts:350), never client-supplied, and every write in this handler happens inside the same authenticated request that generated it. There is no "verify this runId belongs to this uid" check anywhere in this file because the runId can't have come from anywhere else within this flow.

**Retry behavior:** none. No retry wrapper, no exponential backoff, no queue, anywhere in `lib/firestore/runs.ts` or its one caller. Every write is attempted exactly once per request; failures are caught, logged, and swallowed (never re-thrown to fail the run). Because `runId` is freshly generated per request and there is no other caller of these functions, **the current system cannot itself invoke `persistAdaptiveOutput` (or a future governance-record write) twice for the same `runId`** — duplicate-initialization handling is a property `initializeAdaptiveGovernanceRecord` needs for its own contract correctness (Part B's `already_exists`/`refreshed` states imply it's designed to be safely callable more than once for the same run over time — e.g., a future backfill or an admin-triggered re-init), not something the live call site can trigger today.

**Size-limit enforcement:** `MAX_TOTAL_DOC_SIZE = 850000` chars (`lib/panel/sanitizeText.ts:11`), shared by `completeRun` and `persistAdaptiveOutput`. Per `docs/adaptive-persistence-design.md`'s own size assessment, the largest Milestone 2 envelope's worst case is roughly 50-60KB — a `GovernanceRecordV1` (a small, bounded, already-deduplicated summary of that same envelope: one short receipt plus a handful of enum/string fields) is smaller still by construction, so the existing budget check pattern is directly reusable without a new constant.

**Whether `governanceRecord` can be written in the same Firestore call as `adaptiveOutput`, vs. a second additive update — resolved in favor of a second, separate additive write, for three concrete reasons:**
1. **Independent failure requirement (Objective #7 — "never corrupt adaptiveOutput when governance persistence fails")** — a combined `.set(..., {merge:true})` call containing both fields either succeeds or fails as one unit; if the governance-record portion of that single payload were ever invalid in a way Firestore rejected, it would take the already-computed, already-valid `adaptiveOutput` write down with it. Two independent calls, mirroring `persistAdaptiveOutput`'s own existing pattern exactly, means a governance-record write failure is caught and reported on its own, with zero effect on `adaptiveOutput`'s already-succeeded write.
2. **Independent versioned contracts, established precedent** — `persistedOutput.ts` and `governanceRecord.ts` are already deliberately built and documented (§2, §6a) as two separate versioned contracts that never touch each other. Combining their writes into one function would blur that boundary at the one place (Firestore) where it's cheapest to keep clean.
3. **Sequencing dependency** — `buildAdaptiveDecisionReceipt()` takes the FINAL `PersistedAdaptiveOutputV1` as input (the in-memory object, not a Firestore read-back), so the receipt can be built immediately after `finalizeAdaptiveRun()` regardless of whether the `adaptiveOutput` Firestore write itself succeeded. A combined write would incorrectly couple "was the receipt computed" to "did the adaptiveOutput write succeed," when the two are independent per Objective #7.

**Duplicate-initialization handling:** since nothing in the current system calls a governance-init function more than once per `runId` (see Retry behavior above), the `already_exists`/`refreshed`/`blocked_reviewed` states in Part B's proposed result type are forward-looking contract correctness, not a live bug being fixed. They matter because the function is being designed as a general, idempotent, callable-more-than-once module — consistent with how `canRefreshDecisionReceipt` (Step 4) was already built to support exactly this kind of re-invocation later.

**Every caller/consumer of the run-persistence helpers (repo-wide grep, confirmed exhaustive):**
- Writers — `createRun`, `completeRun`, `markRunError`, `persistAdaptiveOutput`: each called exactly once in the whole codebase, all four from `app/api/run-panel/route.ts`, all within the same `POST` handler, same request. No cron job, retry queue, or other route writes to `runs/{runId}`.
- Readers of `adaptiveOutput` specifically: `app/api/user/runs/[runId]/route.ts:127` (`parsePersistedAdaptiveOutput(data.adaptiveOutput)`, the single-run detail view) and `app/api/user/panel-history/route.ts:126` (reads only `schemaId` off it for a list-summary field). Both are read-only, run through `parsePersistedAdaptiveOutput`'s or an ad-hoc narrow shape check, and neither writes back. Any future `governanceRecord` field these routes might also want to expose is unaffected by Step 5 Part A's scope (write-side only).

**How write failures are logged — and a pre-existing convention gap worth flagging:** `lib/firestore/runs.ts` logs exclusively via `console.log`/`console.warn` (9 call sites, none via `logger`) — e.g. `persistAdaptiveOutput`'s own failure paths at runs.ts:354 and runs.ts:362. This contradicts this repo's own standing rule (CLAUDE.md: *"Always use logger from @/lib/logger for server-side logging. Never use console.log/warn/error in lib/ or app/api/ code"*) — a pre-existing gap in this file, not something introduced by Phase 1/2A work. `app/api/run-panel/route.ts` itself is consistent (`logger.warn`/`logger.error` throughout, including at its own `persistAdaptiveOutput` call site, route.ts:902 and route.ts:906). Flagged here rather than silently fixed, since Part A is read-only by instruction; worth deciding explicitly whether a new governance-persistence helper should follow the file's existing (non-compliant) local convention or the repo-wide rule when that helper is actually written.

**Whether existing governance fields could be overwritten accidentally:** no. Confirmed by grep across `lib/governance/`, `lib/firestore/`, and `teamGovernancePipeline.ts` — the existing fields are `governanceStatus`, `governanceReasons`, `governanceMeta` (System A), `teamGovernance` (System B snapshot), and the flat `governanceReviewedBy`/`governanceReviewedAt`/`governanceReviewComment` (System B's single-reviewer fields). None of them is named `governanceRecord`, and Firestore's `{ merge: true }` only ever touches the exact top-level keys present in the payload passed to `.set()` — a payload of `{ governanceRecord: ... }` cannot touch any sibling key by construction, accidentally or otherwise.

**Direct answers to the specific verification list:**
| Question | Answer |
|---|---|
| Where is `adaptiveOutput` built? | `finalizeAdaptiveRun()`, called from route.ts:853; returns `.persistedOutput` in memory (defined only for the 9 Milestone 2 schemas) |
| Where is it persisted? | `persistAdaptiveOutput()` (runs.ts:340), called once from route.ts:895, immediately after `finalizeAdaptiveRun()` resolves |
| One update or multiple? | One: a single `.set({ adaptiveOutput: output }, { merge: true })` call per request |
| Current merge semantics | `{ merge: true }` on a single top-level key only — `createRun` uses a plain `.set()` (full initial doc, no merge needed, doc doesn't exist yet); `completeRun`/`markRunError` use `.update()` (doc already exists by then) |
| Current size-check path | `estimateDocumentSize({ adaptiveOutput: output })` vs. `MAX_TOTAL_DOC_SIZE` (850,000 chars, `lib/panel/sanitizeText.ts:11`), checked *before* attempting the write; oversized → omitted, never truncated |
| What `persistenceStatus` values exist today | `"saved" \| "failed" \| "omitted_size_limit" \| "not_applicable"` (route.ts:848), computed from `persistAdaptiveOutput`'s `{saved:true} \| {saved:false, reason: "firestore_unavailable"\|"oversized"\|"write_failed"}` result |
| When is the live response returned? | After the `persistAdaptiveOutput` attempt resolves (success or failure) — the HTTP response is never blocked by or contingent on that write succeeding; `adaptiveOutput` is returned to the client from the in-memory object either way |
| Do any retries occur? | No — no retry wrapper anywhere in this file or its one caller; every write is attempted exactly once per request |
| Are duplicate writes possible? | Not from the current system (fresh `runId` per request, single call site) — see Retry/Duplicate-initialization findings above |
| Can `governanceRecord` safely be written in the same update as `adaptiveOutput`? | Technically yes (Firestore allows multi-key `.set`/`.update` payloads), but not recommended — see the three reasons above (independent-failure requirement, contract-separation precedent, sequencing) |
| Is a separate additive update safer? | Yes — matches `persistAdaptiveOutput`'s own established pattern and satisfies Objective #7 directly |
| Every caller/consumer | Enumerated above — 4 writers (route.ts only), 2 readers (`user/runs/[runId]`, `user/panel-history`) |
| How are write failures logged? | `console.warn` inside `runs.ts` (pre-existing convention gap vs. CLAUDE.md), `logger.warn` inside `route.ts` at the call site — see flag above |
| Could existing governance fields be overwritten accidentally? | No — no field-name collision exists, and `{merge:true}` is scoped to the keys actually present in the write payload |

## 9. Step 5, Part A — stopping point after the audit (historical; resolved in §10, superseded by §11)

This document fulfills Phase 2 steps 1-4 (audit, define semantics, decision receipt builders, record validation/immutability) plus Step 5 Part A (write-lifecycle audit, §8). **Step 5 Parts B onward are NOT YET IMPLEMENTED.** The Step 5 prompt itself cut off mid-way through Part B's proposed `initializeAdaptiveGovernanceRecord` type signature (no closing brace, nothing after it) — Part C (route.ts wiring), Part D (the actual Firestore persistence helper referenced by Objective #3), Part E (required tests), and Part F (doc-update requirements) were never received. Per the audit above, three real design decisions still depend on that missing content rather than being safely inferable from precedent alone:
- Whether `initializeAdaptiveGovernanceRecord` performs the Firestore write itself (its `async` signature and `runId` parameter suggest yes) or only computes/returns a `GovernanceRecordV1` for a separate, `persistAdaptiveOutput`-style persistence function to write (matching this codebase's established one-function-one-write-site pattern more closely).
- How `existingGovernanceRecord` is meant to reach the function — read internally, or fetched and passed in by the caller (the given signature takes it as a plain `unknown` argument, implying the latter, which would make the caller responsible for the pre-write read `persistAdaptiveOutput` doesn't currently need).
- The exact wiring point and conditions in `route.ts` Part C would have specified (e.g., whether it runs unconditionally after a successful `adaptiveOutput` persist attempt, or independently of that outcome, per Objective #7's independence requirement).

Per the standing instruction ("stop after the audit... if a major contradiction appears, stop and report it") and this engagement's established handling of incomplete prompts (Phase 2A Step 2's two truncations), stopping here for the rest of Step 5 rather than guessing at these three decisions.

## 10. Step 5, Part B — governance initialization service (implemented, 2026-07-29)

Answers the three open questions from §9, per the follow-up Part B prompt: `initializeAdaptiveGovernanceRecord` DOES perform the Firestore write itself (via a dedicated `persistGovernanceRecord` helper it calls internally); `existingGovernanceRecord` IS fetched and passed in by the caller, not read internally by this module (keeps the module free of its own read dependency — a future route caller owns the read, this module owns validate → decide → build → write); the route-wiring question is deferred again, to Part C, per this section's own explicit instruction not to touch `app/api/run-panel/route.ts` yet (confirmed untouched — `git diff --stat` shows the same pre-existing Phase-1 diff on that file as before this step, zero new lines from Part B).

**`lib/adaptiveSchema/governanceInitialization.ts`** — one public export, `initializeAdaptiveGovernanceRecord(args: { runId, adaptiveOutput: PersistedAdaptiveOutputV1, existingGovernanceRecord?: unknown, now?: string }): Promise<GovernanceInitializationResult>`. Never throws — the entire body runs inside a try/catch; even a genuinely unexpected exception (e.g. `buildAdaptiveDecisionReceipt`'s own `DecisionReceiptBuildError`, unreachable in practice here since `parsePersistedAdaptiveOutput` already confirms `schemaId`/`result` correspondence first) resolves to `{status: "failed", reason: "unexpected_error"}`, never a rejected promise the caller has to guard against. Never calls a connector, the classifier, routing, or `finalizeAdaptiveRun` — verified by the same `callGemini`/`classifyQuery` mock-and-assert-never-called pattern Steps 3-4's tests use. Never mutates `adaptiveOutput` — verified by a deep-equality snapshot test.

**Applicability — no second hard-coded schema list:** applicability is enforced by re-running `parsePersistedAdaptiveOutput(adaptiveOutput)` (the exact validator `persistedOutput.ts` already exports), not a redefined check. A normally-typed caller (a real `PersistedAdaptiveOutputV1`, e.g. what `finalizeAdaptiveRun()` already returns) always passes this and never observes `not_applicable`; that status exists only for a future caller reaching this function through an unsafe cast or with corrupted data. `not_applicable`'s `reason` is `` `adaptive_output_${parsePersistedAdaptiveOutput's own failure reason}` `` (e.g. `adaptive_output_malformed`) — reused directly from persistedOutput.ts's existing vocabulary, not a new one invented here.

**Existing-record rules — implemented exactly per Part B4, no refresh:**

| Existing record state | Result |
|---|---|
| absent | build + persist → `created` |
| valid, `humanReview.status: "unreviewed"` | `already_exists` (record returned as-is, no rebuild, no persist) |
| valid, `"pending"` | `already_exists` (same — not a refresh trigger) |
| valid, `"approved"` / `"approved_with_conditions"` / `"changes_requested"` / `"rejected"` | `blocked_reviewed` (record returned as-is) |
| malformed (fails `parseGovernanceRecord`) | `malformed_existing_record`, no overwrite |
| unsupported version | `unsupported_existing_version`, no overwrite |

This module never calls `canRefreshDecisionReceipt`/`applyHumanReviewUpdate` (Step 4) and never rebuilds an existing record under any circumstance, reviewed or not — Part B is initialization-only. Refresh remains exclusively a future, separate operation built on the Step 4 primitives already in place.

**Record construction (absent-record path only):** `buildAdaptiveDecisionReceipt` is called exactly once, only when no existing record was found — never for `already_exists`/`blocked_reviewed`/malformed/unsupported branches (Objective #5's "only when creation is allowed"). The constructed `GovernanceRecordV1` omits `automatedGovernance` entirely (not set to `undefined` — the key is simply absent, since Firestore's Admin SDK rejects explicit `undefined` values by default and an absent optional key is the correct representation of "System A has not evaluated this run," not a placeholder status like `"passed"`/`"not_evaluated"`). `createdAt`/`updatedAt` are both set to the same injected/derived `now`. An invalid `now` (unparseable, or not a string) returns `{status: "failed", reason: "invalid_timestamp"}` before any persistence attempt — validated up front, before the existing-record branch is even evaluated, so a malformed `now` fails predictably regardless of what the existing record's state would have been (documented design choice, not strictly required by Part B5's letter, which discusses it only in the construction context — validating early keeps the function's precondition checks uniform and independently testable rather than conditional on which branch would otherwise run).

**`lib/firestore/runs.ts::persistGovernanceRecord(runId, governanceRecord: GovernanceRecordV1)`** — a second, independent additive write, deliberately separate from `persistAdaptiveOutput` (§8's own reasoning: independent-failure requirement, contract-separation precedent, sequencing). `.set({ governanceRecord }, { merge: true })` — a single top-level key, so every sibling field (System A/B's fields, `adaptiveOutput` itself) is provably untouched by construction, not just by convention (verified by a dedicated test asserting `Object.keys(payload)` is exactly `["governanceRecord"]`). Same three-state failure vocabulary as `persistAdaptiveOutput` (`AdaptiveOutputPersistenceFailureReason`), mirrored here as `GovernanceRecordPersistenceFailureReason = "firestore_unavailable" | "oversized" | "write_failed"`. **Uses `logger` from `@/lib/logger`, not `console.*`** — the one deliberate departure from this file's pre-existing local convention (§8's flagged gap), scoped to only the two new lines this function adds; the rest of `runs.ts`'s existing `console.*` calls are untouched, per Part A's read-only instruction and Part B's "new code only" framing.

**Size guard — same honest limitation as `persistAdaptiveOutput`, not silently fixed:** `estimateDocumentSize({ governanceRecord })` only ever sees the payload passed to it, never the full, already-written run document. A document already near the limit from its `runDocument`/`adaptiveOutput` fields could in principle still be pushed over Firestore's real 1 MiB limit by a `governanceRecord` that individually measures under budget. This is a pre-existing limitation of the size-check strategy `persistAdaptiveOutput` already has — kept consistent here rather than changed for one write path and not the other, and documented explicitly rather than silently carried forward (per Part B7's instruction). `GovernanceRecordV1` is smaller by construction than the envelope it's derived from (one short receipt plus a handful of enum/string fields vs. the full result object), so in practice this limitation is unlikely to bite, but it is not eliminated.

**Failure mapping (`GovernanceInitializationResult.status`):**

| `persistGovernanceRecord` outcome | Initializer status |
|---|---|
| `{saved: true}` | `created` |
| `{saved: false, reason: "oversized"}` | `omitted_size_limit` (the already-built, valid, unpersisted record is still returned on `result.record` — mirrors Phase 1's own "live value returned regardless of persistence outcome" pattern) |
| `{saved: false, reason: "write_failed"}` | `failed` |
| `{saved: false, reason: "firestore_unavailable"}` | `failed` |
| thrown/rejected during persistence, or any other unexpected exception | `failed`, `reason: "unexpected_error"` |

**What gets logged, and what never does:** both `persistGovernanceRecord` (on oversize/write-failure) and the initializer's outer catch (on an unexpected exception) log only `runId` and `schemaId` — no receipt content, no source strings, no question text, no reviewer data, and (a stricter reading of Part B8's literal "log only metadata: runId, schemaId, status category" than `persistAdaptiveOutput`'s own precedent) not even the raw Firestore error message. Verified by a dedicated test that plants secret conclusion/source/reviewer text in a record, forces both the oversized and write-failure paths, and asserts none of that text appears anywhere in the logger mock's captured call arguments.

**Concurrency limitation — documented, not solved (per Part B9's explicit instruction not to over-engineer):** there is no transaction or compare-and-set flow here, matching the rest of `lib/firestore/runs.ts`'s existing convention (no transactions used anywhere in this file today). Two simultaneous `initializeAdaptiveGovernanceRecord` calls for the same `runId` could both observe an absent existing record and both proceed to build and write a record — deterministic in content (same `adaptiveOutput` in, same receipt out) but not identical if their injected/derived `now` values differ, so this is NOT strict transactional idempotency, only "eventually one coherent, valid record ends up written, and the last `.set({merge:true})` wins." Given the current architecture has no clean transaction convention to extend and the only live caller (once Part C wires it) invokes this at most once per freshly-generated `runId` per request (§8's own Retry-behavior finding), a distributed lock or transaction is not justified in Part B. A future explicit review/refresh workflow can add compare-and-set semantics if a real concurrent-write scenario ever materializes.

**Tests:** `governanceInitialization.spec.ts` (25) and `governanceRecordPersistence.spec.ts` (9, in `lib/firestore/__tests__/`, mirroring `persistAdaptiveOutput.spec.ts`'s own mocking pattern) — 34 explicit tests, both files passing on first run.

**Test-count reconciliation:** starting from Step 4's confirmed 1265/1265. `governanceInitialization.spec.ts` contributes 25 (isolated run, confirmed), `governanceRecordPersistence.spec.ts` contributes 9 (isolated run, confirmed) — 34 explicit. Of the new files, only `governanceInitialization.ts` and `governanceInitialization.spec.ts` sit under `lib/adaptiveSchema/` — `importBoundaries.spec.ts`'s per-file scan (§6b) therefore contributes +2, not +4; `governanceRecordPersistence.spec.ts` (`lib/firestore/__tests__/`) and the edit to `runs.ts` (`lib/firestore/`) are outside the two scanned directories and contribute 0 to that mechanism. **1265 + 34 + 2 = 1301**, confirmed by two consecutive full-suite runs, both exactly 1301/1301.

Clean `tsc --noEmit`, clean lint, zero protected-path diff, `app/api/run-panel/route.ts` confirmed untouched this step (same pre-existing Phase-1 diff as before Part B, no new lines).

**What remains unwired:** nothing in this section is called from any route, script, or scheduled job — `initializeAdaptiveGovernanceRecord` and `persistGovernanceRecord` are both currently dead code from the runtime's perspective, exactly like every Phase 2A module before them. Part C (route lifecycle wiring) is the next, separate step; governance initialization is NOT live until that step lands.

## 12. Step 5, Part C — run-panel lifecycle wiring (implemented, 2026-07-29)

**Governance initialization is now live** for the 9 active Milestone 2 schemas — the first Phase 2A code to actually run in production, not just exist as inert, unreferenced modules. Everything else in Phase 2A (System A, System B, `teamRuns`, reviewer APIs, dashboard, history UI, exports, receipt refresh, multi-reviewer) remains exactly as unwired as before this step.

**Exact insertion point** — `app/api/run-panel/route.ts`, inside the existing `if (adaptiveOutput.persistedOutput) { ... }` block (the same block `persistAdaptiveOutput` already lives in), immediately after that call's own `try`/`catch` resolves and before the schema-specific analytics tracking calls (`trackRankedListShortfall` etc.) that follow. This is deliberately AFTER `persistAdaptiveOutput` has fully resolved (success or failure) and AFTER every side effect that could double-charge or re-execute anything — model execution (`runPanel`), classification (`planAdaptiveRun`/`classifyQuery`), quota increment (`checkAndIncrementUsageForRun`), run creation (`createRun`), run completion (`completeRun`), and token finalization (`incrementUserTokenUsage`) — all of which already happened earlier in the same request, before this insertion point, and are never touched or re-invoked by the new block.

**Durable-parent requirement:** governance initialization is gated on `adaptivePayload.persistenceStatus === "saved"` — checked first, before any read or initializer call. When persistence `"failed"` or was `"omitted_size_limit"`, `governanceInitializationStatus` is set directly to the route-only value `"skipped_adaptive_not_saved"`, with no read and no initializer call at all. This is a deliberate divergence from initializing off the in-memory `adaptiveOutput` alone (which is always available regardless of persistence outcome) — Objective #8 requires the durable envelope to exist first, since a `GovernanceRecordV1` whose parent `adaptiveOutput` was never actually saved would reference nothing real on the run document.

**Existing-record read behavior:** a new `lib/firestore/runs.ts::readGovernanceRecordForInitialization(runId)` returns a 5-state result (`found` / `absent` / `run_missing` / `firestore_unavailable` / `read_failed` — see §12a for why `run_missing` is its own state, added in a post-review correction, not part of the original implementation) and does NOT parse the value it finds — `parseGovernanceRecord` (Step 4) remains the only place that happens, reached indirectly via `initializeAdaptiveGovernanceRecord`. Considered Firestore field-mask projection (`Firestore.getAll(docRef, {fieldMask:[...]})`, the Admin SDK's only server-side field-selection mechanism) and deliberately did not use it — it only reduces network payload, not Firestore's per-document read cost, `governanceRecord` is small, and every other read in this file already uses a plain `.get()` + `.data()`; matching that unanimous existing precedent was judged clearer than a second read pattern for a benefit that doesn't apply here.

**Read-failure safety rule — the critical one:** `"run_missing"`, `"firestore_unavailable"`, and `"read_failed"` are NEVER treated as `"absent"`. The route branches via an explicit `switch`: `"found"`/`"absent"` → call the initializer, passing the real value only when `"found"`, `undefined` only when positively `"absent"`; `"run_missing"`/`"firestore_unavailable"`/`"read_failed"` → `governanceInitializationStatus = "failed"` directly, the initializer is never called, and `existingGovernanceRecord` is never defaulted to `undefined` as a stand-in for any of these three. A read failure — or a missing run — that silently became `undefined` would risk `initializeAdaptiveGovernanceRecord` treating an unconfirmed state as absent and either reinitializing over an already-reviewed record, or (for `run_missing` specifically) causing `persistGovernanceRecord`'s own `.set(...,{merge:true})` to CREATE an orphan run document — see §12a. Verified by dedicated route-level tests, one per non-safe state, asserting the initializer mock is never called in any of the three cases.

**Response status field:** `adaptivePayload.governanceInitializationStatus?: GovernanceInitializationStatus | "skipped_adaptive_not_saved"` — reuses the Part B status vocabulary directly (no duplicate enum), plus exactly one route-only addition. Undefined (key omitted from the response) whenever `adaptiveOutput` itself is undefined (legacy schema, non-execution/handoff path — both already return before this point in the existing control flow, so no new guard was needed for them). Only the status enum is ever returned — never `reason`, never `record`, never a raw Firestore error, matching Part C3's response contract exactly (no receipt content, no parser reasons, no reviewer identity, no stack traces).

**Ordering relative to quota and token finalization:** unaffected — governance initialization sits entirely after both. `checkAndIncrementUsageForRun` already ran (and already atomically incremented `runsThisMonth`) before `runPanel` was even called; `incrementUserTokenUsage` already ran inside the same try block, before `adaptivePayload` is even constructed. Governance initialization never touches either. Verified by a test asserting `checkAndIncrementUsageForRun`/`createRun`/`completeRun`/`runPanel` are each still called exactly once per request, and a second test asserting explicit call order (`persistAdaptiveOutput` → `readGovernanceRecordForInitialization` → `initializeAdaptiveGovernanceRecord`).

**Latency implication:** one additional sequential Firestore read (`readGovernanceRecordForInitialization`) plus, on the `created` path, one additional Firestore write (`persistGovernanceRecord`, inside `initializeAdaptiveGovernanceRecord`) — both only on the already-slow path (a 9-schema adaptive run that already made an LLM call and one `persistAdaptiveOutput` write). No new work on the `already_exists`/`blocked_reviewed`/malformed/unsupported branches beyond the one read (no write in those branches, by Part B4's own rules). Not benchmarked in this step — no performance requirement was given, and the added work is the same order of magnitude as the existing `persistAdaptiveOutput` write it sits next to.

**Analytics:** none added. Considered per Part C's "add analytics only if appropriate" — judged not appropriate for this narrow step: no analytics event schema/naming was specified anywhere in Steps 1-5, and inventing one now would be scope creep beyond "wire governance initialization into the lifecycle." The existing `trackPanelExecutionCompleted`/schema-specific gap-tracking calls are untouched and unaware of governance.

**Failure behavior:** an initializer failure, an oversized-record omission, or a read failure all still return the live adaptive answer, HTTP 200, unchanged `ok: true` — governance initialization can never suppress the answer or change HTTP success behavior (Objective #4), verified directly by two tests asserting `response.status === 200` and `body.adaptive.adaptiveOutput` still equals the in-memory envelope when the initializer reports `"failed"`.

**Files changed:** `app/api/run-panel/route.ts` (new import, `governanceInitializationStatus` field added to the `adaptivePayload` type, new block after the `persistAdaptiveOutput` try/catch), `lib/firestore/runs.ts` (new `readGovernanceRecordForInitialization` + `GovernanceRecordReadResult`). No other production file touched.

**Tests (final, post-correction — see §12a):** `lib/firestore/__tests__/governanceRecordRead.spec.ts` (11) and `app/api/run-panel/__tests__/governanceInitializationWiring.spec.ts` (21), mirroring `routingGuard.spec.ts`'s established route-level mocking approach (every side-effecting dependency mocked; `finalizeAdaptiveRun` itself partially mocked via `jest.requireActual` + override, so each test can control `persistedOutput` directly without driving the full per-model validation/alignment pipeline for a real schema). Full per-file breakdown in §12a.

**Test-count reconciliation (final, post-correction):** starting from Step 5 Part B's confirmed 1301/1301. 11 + 21 = 32 explicit (§12a's fix added 1 test to the read-helper file and 3 to the wiring file, on top of the original 10 + 18 = 28). Neither test file sits under `lib/adaptiveSchema/` or `components/adaptive/`, and no new *production* file was added under those two directories either — `importBoundaries.spec.ts`'s per-file scan (§6b) contributes **+0**, unchanged by the correction. **1301 + 32 + 0 = 1333**, confirmed by two consecutive full-suite runs, both exactly 1333/1333.

**A real bug caught during implementation, fixed before landing:** the first draft of `governanceInitializationWiring.spec.ts` used `afterEach(() => jest.clearAllMocks())`, copied from `routingGuard.spec.ts`. `clearAllMocks()` resets call history but does NOT clear queued `mockResolvedValueOnce`/`mockImplementationOnce` values — five of this file's mocks (`callGemini`, `finalizeAdaptiveRun`, `persistAdaptiveOutput`, `readGovernanceRecordForInitialization`, `initializeAdaptiveGovernanceRecord`) are configured per-test with `Once` variants and have no module-level default, so leftover unconsumed queue entries from one test bled into the next, causing two handoff/disabled-schema tests to observe a `decision_support` classification left over from a prior test instead of their own. Fixed by explicitly `mockReset()`-ing those five mocks in `afterEach`, in addition to `clearAllMocks()` for the rest (which do have module-level defaults that `mockReset()` would have destroyed).

**A real safety defect caught during review, fixed before final approval — see §12a for the full account.**

Clean `tsc --noEmit`, clean lint, zero protected-path diff. `git diff --stat` reviewed — cumulative diff includes all prior uncommitted Phase 1/2A work.

## 12a. Post-review correction — `run_missing` as a distinct read state (2026-07-29)

**The defect, as flagged in review:** the original `readGovernanceRecordForInitialization` treated an unexpectedly-missing `runs/{runId}` document the same as `"absent"` (meaning "the run exists, it just has no `governanceRecord` field yet"). The route then passed `existingGovernanceRecord: undefined` to `initializeAdaptiveGovernanceRecord` in both cases. But `persistGovernanceRecord`'s write is `.set({ governanceRecord }, { merge: true })` — and Firestore's `set()` with `{merge: true}` CREATES a document when the target doesn't already exist; it doesn't require one to pre-exist the way `.update()` does. So a genuinely missing run (wrong `runId`, an earlier `createRun` failure, or any other unexpected cause) could have produced an ORPHAN `runs/{runId}` document containing nothing but a `governanceRecord` field — no `userId`, no `question`, no `runDocument`, none of the fields that make a run doc real. The read helper itself never writes anything; the risk was entirely in the DOWNSTREAM initializer being handed a false "absent" signal it had no way to distinguish from a real one.

**The fix:** `GovernanceRecordReadResult` gained a 5th state, `"run_missing"`, distinct from `"absent"`:
- `"absent"` — the run document EXISTS and has no `governanceRecord` field. Safe to initialize; `.set(...,{merge:true})` only ever touches a field on a real, pre-existing document in this case.
- `"run_missing"` — the run document itself does not exist. Never safe to initialize from. Routed through the exact same hard-stop branch as `"firestore_unavailable"`/`"read_failed"` in `route.ts`'s `switch` — `governanceInitializationStatus = "failed"`, initializer never called, `existingGovernanceRecord` never defaulted to `undefined`.

`route.ts`'s branching changed from an `if/else` (`"found" || "absent"` vs. everything else) to an explicit `switch` over all 5 states, with `"run_missing"` given its own `case` (falling through to the same handling as the other two hard-stop states) — making the three non-safe states individually visible in the code rather than merged into an implicit `else`.

**Also corrected in the same pass:** `catch (governanceError: any)` → `catch (governanceError: unknown)` in the governance-initialization block's outer catch — the block never reads any property off the caught exception (only logs fixed metadata: `runId`, `schemaId`), so `any` was unjustifiably permissive; `unknown` is the correct, safer type for a caught value nothing in the block inspects.

**Tests added:**
- `governanceRecordRead.spec.ts`: the pre-existing "handles a missing run document safely" test was corrected to assert `{status: "run_missing"}` instead of `{status: "absent"}` (it was testing the OLD, incorrect behavior); one new test directly contrasts `run_missing` vs. `absent` from two back-to-back calls, proving they're never the same value.
- `governanceInitializationWiring.spec.ts`: three new tests — `run_missing` never calls the initializer (the direct, structural proof that no orphan-creating write is reachable, since `initializeAdaptiveGovernanceRecord` is the only caller of `persistGovernanceRecord`); `run_missing` is never passed through as `existingGovernanceRecord: undefined`; and an explicit contrast test confirming positive `"absent"` still allows initialization (unlike `run_missing`) — so the fix's precision (blocking exactly the unsafe case, not overcorrecting into blocking the safe one) is verified, not just assumed.

**Verified:** 11/11 and 21/21 respectively (both files), full suite 1333/1333 across two consecutive runs, clean `tsc --noEmit`, clean lint, zero protected-path diff.

**Backward compatibility:** every existing `adaptivePayload` field (`persistenceStatus`, `adaptiveOutput`, the per-schema result fields, `results`, `classification`, etc.) is unchanged — `governanceInitializationStatus` is a strictly additive optional field. Legacy (10 non-Milestone-2) schemas never see this field at all (same as `persistenceStatus`'s own existing behavior). No client contract was broken; no existing test outside the two new files needed modification.

**Whether System A integration is safe to begin:** not evaluated in this step — Part C's scope was route wiring for the Phase 2A `GovernanceRecordV1` path only. System A (`evaluateGovernance.ts`) remains entirely separate, per §6's own finding that it's only triggered from `/api/synthesize-panel` (never called for adaptive runs) and has its own status vocabulary deliberately kept distinct from `GovernanceRecordV1.automatedGovernance`. Whether/how to wire System A into `automatedGovernance` is unaddressed and out of scope here.

## 14. Step 6, Part A — System A automated governance audit (2026-07-29)

Read-only audit, no production code changed. Traced every file, caller, write site, and test in scope.

### 14.1 System A architecture map

```
appConfig/governancePolicy (Firestore doc)
        │  loadGovernancePolicy() / pickPolicyFields()
        │  (governancePolicyStore.ts — per-field fallback to getDefaultGovernancePolicy())
        ▼
evaluateGovernance(input: GovernanceInput, policy: GovernancePolicy)
  → GovernanceResult { status, reasons, meta: { policyVersion, evaluatedAt } }
  (evaluateGovernance.ts — pure, synchronous, 195 lines, zero I/O, zero async)
        ▲
        │  input built by ONE of:
        │    - governanceInputFromResearchRun(runDoc)       — synthesize-panel only
        │    - governanceInputFromVerificationDoc(verifDoc) — claim/video verification only
        │    - an inline object built directly in the caller (verify-video does this)
        │
   ┌────┴─────────────────────────────────────────────┐
   │                                                    │
evaluateAndStoreGovernance({runId, collection, input, ownerUid})   (evaluateAndStore.ts)
  - fail-open: any exception → console.error, return null, NEVER throws
  - skipped entirely if: !adminDb, !ownerUid, OR entitlements.planId === "free"
  - on success, writes THREE things additively:
      1. {collection}/{runId}                    .set({governanceStatus, governanceReasons, governanceMeta}, {merge:true})
      2. {collection}/{runId}/governanceEvents/*  .add({action:"evaluated", byUid:"system", nextStatus, reasons, policyVersion, at})
      3. admin_audit_logs/*                       via writeAuditEvent() — global, top-level, append-only

Callers of evaluateAndStoreGovernance (exactly 3, all API routes):
  - app/api/synthesize-panel/route.ts   collection: "runs"              runType: "research"      — void, fire-and-forget, not awaited by the HTTP response
  - app/api/verify-claim/route.ts       collection: "verifications"     runType: "verification"  — awaited
  - app/api/verify-video/route.ts       collection: "videoVerifications" runType: "verification" (inline input, own verdict→verdict-label mapping) — awaited

A 4th, DIRECT caller of evaluateGovernance() exists: lib/governance/governanceBackfill.ts::ensureDocumentGovernanceEvaluated().
  This function has ZERO callers anywhere in app/ or lib/ — confirmed by a full-repo grep for its name. Dead code, not part of any live trigger path.

Delivery/UI consumption of governanceStatus (read-only, advisory — see §14.5):
  app/page.tsx, components/admin/AdminRunsTab.tsx, components/governance/GovernanceDashboard.tsx,
  lib/user/mapStoredVerificationToClientPayload.ts
```

### 14.2 Complete rule inventory

`evaluateGovernance.ts` contains exactly **8 rule branches**, evaluated unconditionally in a fixed order (every branch always runs; there is no early return), with `blocked > needs_review > approved` as the final status precedence. One dead field was found: `GovernancePolicy.minConsensusToApprove` is defined in the type and the default policy but **never read anywhere in `evaluateGovernance`'s body** — only `minConsensusToAvoidReview` gates the non-sensitive-domain consensus check. Not part of this audit's scope to fix; noted for completeness.

| # | Rule name | Inputs required | Outputs | Can block? | Writes governanceEvents? | Writes global audit log? | Depends on ConsensusSummary / AlignedClaim[] / citations / claims-matrix disagreement / Panel Verdict / runType | Can operate truthfully from GovernanceRecordV1 / AdaptiveDecisionReceipt / CommonResponseMeta / persisted adaptive metadata? | Classification | Reason |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `blockIfSourceBackedMissingSources` | `sourceBacked: boolean`, `missingSourcesCount: number` | 1 reason, blocks | **Yes — the only blocking rule** | Yes (shared write path — see note below table) | Yes (same) | None of the six (source-completeness, not claims-matrix agreement) | **Yes.** `sourceBacked` maps directly and honestly to `CommonResponseMeta.sourceBacked` / `AdaptiveDecisionReceipt.sourceBacked` — verified real (per-schema branch logic in `commonResponseMeta.ts`, not a placeholder). `missingSourcesCount` is honestly derivable as `sourceCoverage.totalUnits - sourceCoverage.supportedUnits` for the schemas that carry `AdaptiveSourceCoverage` (not all 9 do — commonResponseMeta.ts's own header doc says so); for the rest, `0` is the only honest value (no per-unit tracking exists, not "nothing is missing") | **GENERIC_METADATA_COMPATIBLE** | Real signal exists on the persisted contract today; precision varies by schema but nothing would be fabricated |
| 2/3 | `sensitiveDomainsEnabled` (avoid-review threshold + approval threshold — one keyword check, two reason-pushes) | `question: string`, `consensusScore: number \| null` | 0-2 reasons, review only | No | Yes | Yes | `consensusScore` (claims-matrix specific); `question` text does not | **No, as currently written.** `effectiveScore = rawScore == null ? 0 : rawScore` — passing an honest `null` (no adaptive schema produces a 0-100 consensus score) silently becomes `0`, which is always below both thresholds. The rule would then unconditionally fire for ANY sensitive-domain adaptive question, and its reason string — `"Sensitive domain (legal): consensus 0 below 75"` — **actively misrepresents what happened**: it implies a real consensus score of 0 was computed and evaluated, when no such score was ever computed at all. The keyword-detection half (`detectSensitiveDomain(question)`) is, in isolation, schema-agnostic and safe — but the rule doesn't functionally split that way in the current implementation. | **UNSAFE_OR_AMBIGUOUS** | Type-compatible (accepts `null`) but produces a misleading reason string if wired as-is — exactly the "TypeScript inputs could be fabricated" trap the audit was told to watch for |
| 4 | `reviewIfEvidenceQualityWeak` | `evidenceQuality: "strong"\|"mixed"\|"weak"\|null` | 1 reason, review only | No | Yes | Yes | `evidenceQuality` is claims-matrix-derived in the research path (`researchEvidenceQuality()`, built from `lowEvidenceClaims`/`highConfidenceClaims`) | **No.** `CommonResponseMeta.evidenceQuality` exists as a field name, but is **hard-coded to the constant `"not_applicable"`** for all 9 active schemas (`commonResponseMeta.ts:327` — never computed, a permanent placeholder). Since `evaluateGovernance` only checks `=== "weak"`, feeding this constant in would make the rule a **silent, permanent no-op** for every adaptive run — never firing, while appearing to have been evaluated. `GovernanceRecordV1`/`AdaptiveDecisionReceipt` carry no evidence-quality field at all. | **UNSAFE_OR_AMBIGUOUS** | No real data source exists on any of the three sanctioned contracts; wiring it as-is would be indistinguishable from "always passes," which the audit was explicitly told not to treat as an implicit safe pass |
| 5 | `reviewIfAnyModelFailed` | `modelHealth.failed: number` | 1 reason, review only | No | Yes | Yes | None of the six — raw connector health, not claims-matrix content | **Yes.** `CommonResponseMeta.failedModels` is a real, honestly-computed field (Phase 1: `failedModels = totalModels - successfulModels`, `successfulModels` = connector status ok/substituted) | **GENERIC_METADATA_COMPATIBLE** | Directly present and real on the already-persisted `CommonResponseMeta` |
| 6 | `reviewIfAnyModelSubstituted` | `modelHealth.substituted: number` | 1 reason, review only | No | Yes | Yes | None of the six | **Partially.** `CommonResponseMeta` folds `ok` and `substituted` together into one `successfulModels` count (per its own Phase 1 design) — a substituted-specific count is NOT separately recoverable from any of the three persisted contracts as they exist today. It IS honestly computable at generation time from the same raw `results[].status` array `commonResponseMeta.ts` already reads — just not currently carried through to what gets persisted. | **GENERIC_METADATA_COMPATIBLE, with a real gap** | Compatible in principle; would require a small, honest, additive field (not a fabrication) before it could run off persisted data alone |
| 7 | `reviewIfVerificationVerdictIn` | `runType === "verification"`, `verificationVerdict` | 1 reason, review only | No | Yes | Yes | `runType` (the gate itself), `verificationVerdict` (Claim/Video Verification's own protected domain) | **Not applicable — not "unsafe," structurally inapplicable.** Adaptive (Deep Research) runs are always `runType: "research"` in System A's vocabulary; this branch's own guard (`input.runType === "verification"`) means it can never fire for an adaptive run regardless of what data is available. Scoped entirely to the protected Claim/Video Verification paths. | **LEGACY_CLAIMS_ONLY** | Out of scope for adaptive integration by the rule's own existing gate, not by any judgment call made in this audit |
| 8 | Consensus score threshold (null-check + numeric comparison) | `consensusScore: number \| null` | 1 reason, review only | No | Yes | Yes | `consensusScore` | **Yes — but only via honest absence, not a fabricated score.** When `rawScore == null`, the rule's EXISTING behavior is `reasons.push("Consensus score not available"); hasReview = true` — an already-accurate, already-honest statement for an adaptive run, since no consensus score genuinely exists. Unlike rule 2/3's `null → 0` coercion, this branch's null path produces a truthful reason string, not a misleading one. | **GENERIC_METADATA_COMPATIBLE (via honest null, never a fabricated score)** | The rule doesn't need adaptive-specific data to behave correctly — it needs to never be lied to about having a score it doesn't have |

**Shared write behavior (applies uniformly, not rule-specific):** every one of the 8 rules shares the exact same downstream write path — a single invocation of `evaluateGovernance()` (regardless of which individual rules fired) always results in `evaluateAndStoreGovernance()` writing all three targets (`governanceStatus`/`Reasons`/`Meta`, one `governanceEvents` doc, one `admin_audit_logs` doc) exactly once. There is no per-rule write granularity — the "writes governanceEvents / writes audit log" columns above are structurally identical for all 8 rules because they all funnel through one evaluation call.

### 14.3 Compatibility classification summary

- **GENERIC_METADATA_COMPATIBLE:** Rules 1, 5, 8 outright; rule 6 with a small honest additive field. 3-4 of 8.
- **LEGACY_CLAIMS_ONLY:** Rule 7 (structurally gated to `runType: "verification"`, never reachable from adaptive runs).
- **UNSAFE_OR_AMBIGUOUS:** Rules 2/3 (misleading reason string from null→0 coercion) and 4 (permanent silent no-op from a hard-coded placeholder field). 2 of 8 (counting 2/3 as one compound rule) — the rule that BLOCKS (rule 1) is fully compatible, which matters for Objective framing in Step 6B, but the two rules classified unsafe are exactly the two most likely to be assumed "free" because their TypeScript signatures already accept the values adaptive data would provide (`null` for both) — the precise trap the audit instructions warned against.

**No rule was classified as an implicit pass.** Rules 2/3 and 4 were deliberately NOT marked compatible merely because `null`/`"not_applicable"` type-check against their inputs — each was traced to what the resulting REASON STRING or FIRING BEHAVIOR would actually communicate, and both fail that test for a different concrete reason (a misleading string vs. a permanently inert placeholder).

### 14.4 Current trigger path — CONFIRMED bug, pre-existing, independent of Phase 2A

**Status: CONFIRMED by an executable test (`app/api/synthesize-panel/__tests__/adaptiveAutoSynthesis.spec.ts`), not just a static trace.** This corrects Phase 2A Step 1's earlier claim that System A's research path is "confirmed never called for adaptive runs" — that claim conflated two different, similarly-named synthesis mechanisms.

**Client call graph, fully traced:**
- **Manual synthesis path:** none exists as a separate function. `ResultsDisplay.tsx` renders `AdaptivePanelResponse` exclusively whenever its `adaptive` prop is truthy (`ResultsDisplay.tsx:1007`) — there is no user-reachable "Generate Synthesis" button for adaptive runs at all; the legacy synthesis UI simply never mounts.
- **Legacy (client-side, markdown) synthesis path — `synthesizeReport()`:** two call sites, INCONSISTENTLY guarded. The live-run path (`app/page.tsx:1047`) checks `successfulCount >= 2 && !(data as any).adaptive` — correctly gated. The history-reload path (`app/page.tsx:1550`) calls `synthesizeReport(data.results)` completely unconditionally — no adaptive check at all. This second gap was not previously documented.
- **Automatic (server-side) synthesis path — `generateSynthesisAutomatically()`:** two call sites (`app/page.tsx:1099` live-run, `app/page.tsx:1584` history-reload-without-cache), both gated ONLY by `runId && successfulCount(orUsableCount) >= 2`. **Neither checks `data.adaptive` at all.**
- **A third, independent auto-trigger exists**, previously untraced: `components/ResultsDisplay.tsx:930-992` has its OWN internal `useEffect` that also POSTs directly to `/api/synthesize-panel` (via `authedFetch`, bypassing `generateSynthesisAutomatically` entirely) — and this one DOES correctly guard on `!adaptive` (line 944). This proves the guard was known and deliberately added in one place but never propagated to the equivalent trigger in `app/page.tsx` — a "fixed one, missed the duplicate" gap, not an intentional design choice. This third trigger does not protect against the other two, since all three call the same endpoint independently.
- **Adaptive renderer path:** `setAdaptivePanel((data as any).adaptive ?? null)` (live run, `app/page.tsx:1006`) and `adaptPersistedOutputToPanelPayload(data.adaptive.output)` (history reload, `app/page.tsx:1514`) — both unaffected by any of the above; the renderer only ever reads `adaptiveOutput`/`persistedOutput`-derived data.

**Server path, fully traced:** `/api/synthesize-panel/route.ts` (2339 lines) contains **zero references** to `adaptiveOutput`, `schemaId`, `answerShape`, `queryType`, `implementationStatus`, `runType`, or `adaptive` (confirmed by an exhaustive grep across the entire file for each specific term). The route accepts `{runId, question, results: [{modelId, text}]}` and processes `text` through claims-matrix synthesis unconditionally, regardless of its shape.

**Confirmed by execution, not just trace:** a new test POSTs a request shaped exactly like what `generateSynthesisAutomatically` sends for a decision_support adaptive run — `results[].text` is the model's real per-model JSON output (not prose) — against the real route (mocking only genuine externals: auth, rate limiting, Firestore, the OpenAI SDK). Result, observed directly:
- The route returns `200 ok:true` — it does not reject or even notice the JSON-shaped input.
- The (mocked) LLM call is made and "succeeds," producing a real `consensusScore: 85` and `evidenceQuality: "weak"` — plausible-looking numbers derived from mis-extracting "claims" out of what was actually structured JSON.
- `evaluateAndStoreGovernance` IS invoked, with `collection: "runs"`, `input.runType: "research"` — confirmed by direct mock assertion.
- `synthesizedStructuredReport`, `schemaVersion: 1`, and `synthesisConsensusSummary` ARE written to the run document via `.update()` — confirmed by inspecting the fake Firestore store after the call.

**Net effect, now confirmed rather than suspected:** for any of the 9 Milestone-2 adaptive schemas, if the client's automatic trigger fires (which the client-side trace shows it will, unconditionally), the run document ends up with a real, but semantically meaningless, `governanceStatus`/`governanceReasons`/`governanceMeta` — derived from a claims-matrix pipeline that treated JSON as prose — sitting alongside the correct, schema-aware `governanceRecord` Phase 2A now populates. No field-level collision (different field names — `governanceStatus` vs. `governanceRecord`, `synthesizedStructuredReport` vs. `adaptiveOutput`), but a real SEMANTIC conflict: two independent, disagreeing governance signals on the same document, one accurate and one garbage. `AdaptivePanelResponse.tsx` never reads the legacy fields, so the end-user-facing renderer is unaffected — but `AdminRunsTab.tsx` and `GovernanceDashboard.tsx` (§14.1) both read `governanceStatus` directly and would display this garbage value to an admin/reviewer for what is actually a Milestone-2 run.

**Still pre-existing and independent of everything Phase 2A has built** — not introduced by Steps 1-5C. Fixing it is out of this step's scope (verification only, per explicit instruction) — see the Step 6, Part A final report for the recommended minimal fix location.

### 14.5 Current delivery-blocking semantics

**Entirely advisory — System A never gates delivery of a run/verification's actual content.** `evaluateAndStoreGovernance` is fire-and-forget from the `/api/synthesize-panel` route (`void ... .catch(...)`, never awaited by the HTTP response) and, even where it IS awaited (`verify-claim`, `verify-video`), a `"blocked"` result is written to Firestore and returned in that route's OWN response as a `governanceStatus` field — it does not remove or withhold the verdict/results themselves anywhere in the codebase. Every UI consumer found (`app/page.tsx`, `AdminRunsTab.tsx`, `GovernanceDashboard.tsx`, `mapStoredVerificationToClientPayload.ts`) treats `governanceStatus` as a badge/label for a downstream review queue or a banner on an already-fully-rendered result — never as a hard content gate. There is no fail-closed path anywhere in this system: every error branch in `evaluateAndStoreGovernance`/`writeAuditEvent` catches, logs (via `console.*`, not `logger` — a pre-existing convention gap, consistent with the one already flagged in `lib/firestore/runs.ts` before Step 5), and returns/resolves without throwing.

### 14.6 Event and audit-log behavior

Both `governanceEvents` (per-run subcollection) and `admin_audit_logs` (global, top-level) are written unconditionally alongside the status fields, in the same `evaluateAndStoreGovernance` call, for every SUCCESSFUL evaluation (skipped entirely — no writes at all — when `adminDb`/`ownerUid`/paid-plan gates aren't met, or when the call throws). `writeAuditEvent` truncates `question` to 200 chars before writing. Neither write path is schema-aware — both would accept and store whatever `GovernanceInput`/`GovernanceResult` shape is handed to them, adaptive-derived or not, with no validation of internal consistency.

### 14.7 Whether partial adaptive evaluation is semantically safe

**Not as a direct pass-through of today's `evaluateGovernance()`, no.** Running the CURRENT 8-rule function against adaptive-run data — even data honestly assembled from `GovernanceRecordV1`/`AdaptiveDecisionReceipt`/`CommonResponseMeta` with no invented fields — would still produce two categories of problem output (rules 2/3's misleading reason string, rule 4's silent permanent no-op) unless those two rules are specifically excluded, gated, or reworded for the adaptive path. Running only the 3-4 compatible rules (1, 5, 8, and 6 with its small extension) against honest adaptive data IS semantically safe — each produces a reason string that accurately describes what was evaluated, using data that genuinely exists. A "partial" evaluation in that narrower sense (a real subset of rules, each individually truthful) is safe; a partial evaluation that silently runs ALL 8 rules and only "happens" to have some no-op due to `null`/placeholder inputs is not — the audit's own instruction not to treat "no compatible rules" as an implicit pass applies with equal force to "some rules silently no-op."

### 14.8 Unresolved design questions for Step 6B

1. Should the §14.4 finding (auto-synthesis apparently reaching adaptive runs today) be verified and, if confirmed, addressed BEFORE or ALONGSIDE Step 6B's adaptive-aware evaluation design? It's a separate bug from "System A doesn't understand adaptive schemas" — it's "System A may already be running against adaptive schemas with the wrong pipeline."
2. Should a new, adaptive-specific policy/rule set be introduced (mirroring `GovernanceRecordV1`'s own precedent of a parallel, additive contract rather than retrofitting System A's existing `GovernanceInput`/`GovernancePolicy` shape), or should `GovernanceInput` gain new optional fields for the adaptive case? The former avoids the exact trap found in §14.2 (rules 2/3 and 4 silently misbehaving on foreign data); the latter reuses more existing engine code but requires either dropping/reworking those two rules for the adaptive path or accepting their currently-unsafe behavior.
3. Does `automatedGovernance` on `GovernanceRecordV1` (currently omitted entirely, per Step 5B) get populated by a NEW adaptive-aware evaluator, or by continuing to route through `evaluateGovernance()` itself with a reduced, adaptive-safe rule subset? Either is consistent with the type as designed (`automatedGovernance` is optional, `status` includes `"not_evaluated"` for exactly this kind of ambiguity).
4. Rule 6 (`reviewIfAnyModelSubstituted`) needs a real, honest `substitutedModels` count to be fully compatible — should `CommonResponseMeta` gain this field (a Phase 1 contract change) as part of Step 6B, or should the count be computed ad hoc at evaluation time from the same raw `results` array, without persisting it anywhere new?
5. Should rule 7 (verification-verdict) simply never be included in an adaptive rule subset (this audit's finding), or is there a future world where an adaptive schema produces something verdict-shaped? Nothing in the current 9 schemas does; treating this as permanently out of scope for adaptive integration is the recommendation, not an open question, but noted here since Step 6B should make that boundary explicit rather than silent.

### 14.9 Recommended Step 6 implementation boundary

Based on this audit, Step 6B should be scoped to: (a) fix the now-CONFIRMED §14.4 bug first, before any adaptive-evaluation feature work — gate `generateSynthesisAutomatically`'s two call sites (`app/page.tsx:1099`, `:1584`) on `!data.adaptive`/`!data.adaptive` equivalent, the same way the client-side `synthesizeReport()` call already is at its live-run site, and fix the same gap at its own unguarded history-reload site (`app/page.tsx:1550`); this is a bug fix in already-existing legacy behavior, not a Step 6 adaptive-evaluation feature — a defensive server-side check in `/api/synthesize-panel` may be warranted too, but that should follow the confirmed call graph above rather than be designed independently of it; (b) a new, additive, adaptive-aware evaluation path built from ONLY the GENERIC_METADATA_COMPATIBLE rules (1, 5, 8, and 6 once extended) rather than reusing `evaluateGovernance()` unmodified; (c) explicit, permanent exclusion of rules 2/3 and 7 from the adaptive path (2/3 pending a redesign that doesn't require a real consensus score; 7 structurally never applicable); (d) rule 4 either dropped from the adaptive rule set entirely or redesigned around a real evidence signal, never wired against the current `"not_applicable"` placeholder. This boundary does NOT require redesigning `evaluateGovernance.ts`, its types, or its legacy callers — full backward compatibility for Claim Verification, Video Verification, and legacy-active research runs is preserved by construction if System A's existing function and its three existing callers are never modified, and a new, separate evaluation path is added for the adaptive case instead (mirroring exactly how `GovernanceRecordV1` was kept separate from System A/B's own fields in Steps 2-5).

## 16. Step 6 — blocker fix: adaptive runs can no longer reach legacy synthesis (implemented, 2026-07-29)

**Corrects any prior stale claim that adaptive runs cannot reach legacy synthesis.** §14.4 previously stated (Step 1's original claim) that this was impossible, then (blocker verification) confirmed by execution that it was in fact possible. This section documents the fix that closes it — both client-side (defense in depth, reduces unnecessary requests) and server-side (the authoritative, durable-data-based guard).

**Client-side guards — `app/page.tsx`, three call sites fixed:**
1. Live-run automatic synthesis (`generateSynthesisAutomatically`, formerly `if (data.runId && successfulCount >= 2)`) now also requires `!(data as any).adaptive` — the exact same guard the adjacent client-side `synthesizeReport()` call already used.
2. History-reload client-side synthesis (`synthesizeReport()`, formerly unconditional — a previously undocumented gap, distinct from the live-run path's own already-correct guard) now requires `data.adaptive?.status === "absent" || !data.adaptive`. The history response shape is genuinely different from the live-run shape (`data.adaptive` here is `{status, output} | undefined`, always a truthy object even when "absent" — a naive `!data.adaptive` check alone would have been wrong, always false). Only a genuinely `"absent"` marker allows legacy synthesis; `"malformed"`/`"unsupported_version"` are NOT treated as proof of a legacy run, matching the same principle applied server-side.
3. History-reload automatic synthesis (`generateSynthesisAutomatically`, second call site) gets the identical guard.

`components/ResultsDisplay.tsx`'s own, independent, pre-existing auto-trigger (`useEffect` at lines 927-992, a third, previously-untraced call path to the same endpoint) already had a correct `!adaptive` guard and was left untouched — its existence is what proves the guard pattern was known and deliberately added once, just never propagated to `app/page.tsx`'s two equivalent triggers.

**Server-side guard — `app/api/synthesize-panel/route.ts`, the authoritative check:** added immediately after the existing ownership-verification Firestore read (reusing that SAME read via a hoisted `runDataForAdaptiveCheck` variable — no duplicate read added), strictly before input validation, LLM client construction, claims extraction, consensus scoring, any run-document write, or any governance call. Uses `parsePersistedAdaptiveOutput` (the same validator `persistedOutput.ts` already exports — no redefined check) against `runDataForAdaptiveCheck.adaptiveOutput`, never a client-supplied flag:

| `parsePersistedAdaptiveOutput` result | Route behavior |
|---|---|
| `ok: true` (valid adaptive output) | Reject — `409`, `errorCode: "ADAPTIVE_RUN_NOT_SUPPORTED"` |
| `reason: "malformed"` | Reject — `409`, `errorCode: "ADAPTIVE_RUN_INVALID"` (NOT treated as legacy) |
| `reason: "unsupported_version"` | Reject — `409`, `errorCode: "ADAPTIVE_RUN_UNSUPPORTED_VERSION"` (NOT treated as legacy) |
| `reason: "absent"` | Continue — legacy synthesis proceeds exactly as before |

The three new error codes were added to the shared `ERROR_CODES` constant (`lib/api/errorResponse.ts`), matching this route's own established `createErrorResponse(errorCode, message, requestId)` shape (not the `{ok:false, error:"..."}` shape floated as a fallback suggestion — the repo already has a standard, and this route already uses it). Rejection responses contain only the error code, a generic message, and the request ID — never schema output, receipt content, raw model text, or internal parser detail.

**A Firestore read failure for the run document itself FAILS CLOSED — corrected after review, see §16a.** The first draft of this fix treated a read failure the same as this route's pre-existing ownership-check leniency (non-fatal, continue). Reviewed and rejected: this lookup is what determines whether the request is even safe to process, so "continue on failure" is exactly backwards for this specific check, even though it matched an old, otherwise-reasonable convention for the unrelated ownership check it sits next to.

**Malformed/unsupported adaptiveOutput is never proof of a legacy run** — both fail safe (reject) exactly like a valid marker, on both the client (history-reload guard) and server (dedicated error codes) sides. Only a genuinely absent marker — the real, common case for every legacy-active and pre-Phase-1 run — continues unchanged.

**Existing polluted records are NOT migrated in this step, deliberately.** Any Milestone-2 run that was already auto-synthesized before this fix landed may still carry `synthesizedStructuredReport`, `synthesisConsensusSummary`, `governanceStatus`, `governanceReasons`, and `governanceMeta` — all left in place. This step's objective is to stop NEW pollution, not clean up existing pollution; a separate cleanup/backfill decision can follow later, informed by how many runs are actually affected (not measured in this step).

**Tests (as first landed, before §16a's correction):**
- `adaptiveAutoSynthesis.spec.ts` — converted from a bug-demonstration file (4 tests) into a 16-test enforcement suite: valid/malformed/unsupported-version adaptive markers all rejected with the correct error code, zero OpenAI/governance calls, zero legacy-field writes, `adaptiveOutput`/`governanceRecord` provably unchanged (deep-equal against the pre-seeded fixture) for all three; absent-marker runs (both a run with no document at all and a pre-existing document lacking the field) still synthesize successfully and still reach governance with `runType: "research"`, unchanged.
- `clientAdaptiveGuardRegression.spec.ts` (new, 8 tests) — a source-level regression test, NOT a rendered-component test (see its own header doc for why: this repo's jest config runs `testEnvironment: "node"` with no DOM-rendering library installed, confirmed before writing it; adding one was judged out of scope for a narrow bug fix). Verifies via pattern-matching against the actual `app/page.tsx`/`components/ResultsDisplay.tsx` source that all three fixed call sites contain their required guard, the pre-existing correct guard is untouched, the adaptive-panel state setters are not nested inside any new guard (the renderer path is unaffected), and the non-2xx error-handling catch block never touches adaptive-related state (confirming no visible error banner and no retry).

**Test-count at first landing:** 1337 (Step 6 Part A baseline) + 20 explicit (+12 `adaptiveAutoSynthesis.spec.ts`, +8 `clientAdaptiveGuardRegression.spec.ts`) + 0 import-boundary = **1357**. Superseded by §16a's final count (1363) after the fail-closed correction added 6 more tests.

**Regression coverage for legacy/protected behavior**, via existing mechanisms rather than new duplicated tests: zero protected-path diff (Claim Verification, Video Verification untouched — confirmed by the standing protected-path check); the full pre-existing suite (classifier, routing, `schemaRegistryStatus.spec.ts` confirming 19 active/2 handoff/7 disabled unchanged, quota/token-accounting tests) passes unmodified; `adaptiveAutoSynthesis.spec.ts`'s own "absent adaptiveOutput" tests directly confirm legacy research runs still reach `evaluateAndStoreGovernance` and still write `synthesizedStructuredReport`/`synthesisConsensusSummary` exactly as before.

Files changed: `app/page.tsx`, `app/api/synthesize-panel/route.ts`, `lib/api/errorResponse.ts`, plus the two test files above.

## 16a. Post-review correction — run-lookup failure now fails CLOSED (2026-07-29)

**The defect, as flagged in review:** §16's original server guard treated a Firestore read failure for the run document the same way this route's pre-existing (and otherwise reasonable) ownership-check convention already did — log a warning and continue to legacy synthesis. For the ADAPTIVE check specifically, this was backwards: this lookup is what determines whether the request is safe to process at all. A stale client, an alternate caller, or any future regression could still trigger full legacy claims-matrix synthesis and System A governance for an adaptive run whenever the run lookup happened to fail transiently — the exact defect this whole step exists to close, just reachable through a different door.

**The fix:** the ownership-check block now tracks an explicit `runLookupStatus: "found" | "not_found" | "read_failed" | "not_attempted"` (previously inferred implicitly and ambiguously from whether a hoisted variable was `undefined`, which conflated two genuinely different cases). The `"not_found"` state (the run document legitimately doesn't exist — a successful read that found nothing) and `"read_failed"` state (the read itself threw) are now distinct:

| State | Meaning | Behavior |
|---|---|---|
| `"found"` | Document read succeeded and exists | Proceed to the `parsePersistedAdaptiveOutput` check (valid/malformed/unsupported/absent), exactly as in §16 |
| `"not_found"` | Document read succeeded, no document exists | Continue as legacy — a nonexistent run has no `adaptiveOutput` field by construction; this is not a lookup failure |
| `"read_failed"` | The `.get()` call itself threw | **Reject — `503`, `errorCode: "RUN_LOOKUP_UNAVAILABLE"` — before this check even reaches the adaptive-parsing logic** |
| `"not_attempted"` | No `runId` in the request at all | Continue as before — there is no specific run being referenced, so there is nothing to fail closed about |

`RUN_LOOKUP_UNAVAILABLE` was added as a new `ERROR_CODES` entry (`lib/api/errorResponse.ts`) rather than reusing the existing, unused, more generic `FIRESTORE_ERROR` — the new code names the exact failure mode precisely, matching this file's own stated goal of centralized, meaningful codes. The response body contains only the error code, a generic user-facing message, and the request ID — the raw Firestore error message is logged server-side only, never returned to the caller (verified by a dedicated test asserting the response body never contains the string "Firestore" in any case).

**`"not_attempted"` (no `runId`) was deliberately NOT folded into the fail-closed path.** Without a `runId`, there is no specific run being referenced at all — the request (if the rest of the route even supports it) isn't associated with any persisted adaptive output to protect against, so there is nothing for this check to fail closed about. This is a narrow, considered distinction, not an oversight: the defect being fixed is specifically about a REAL run whose adaptive status couldn't be confirmed, not about requests that never named a run in the first place.

**Tests, replacing the single "continues to legacy synthesis" test from §16 with 7 tests enforcing the new fail-closed behavior:**
- Returns `503`/`RUN_LOOKUP_UNAVAILABLE` (not a legacy success).
- Never constructs/calls OpenAI.
- Never calls `evaluateAndStoreGovernance`.
- Writes no synthesis fields and no legacy governance fields.
- Leaves any pre-existing `adaptiveOutput`/`governanceRecord` on the run completely untouched (pre-seeded with real fixtures, deep-equal-checked after).
- Never exposes "Firestore" in the response body.
- Calls `.get()` for the run exactly once per request — no internal retry (verified via a real per-runId call counter added to the test's Firestore mock, not inferred).

Also relabeled the existing "missing run" test (a run that legitimately doesn't exist) to make explicit it exercises `"not_found"`, distinct from `"read_failed"` — confirming it still returns `200`/`ok:true` unchanged, satisfying "test a missing run separately."

**Test-count reconciliation (final):** starting from §16's 1357. The read-failure describe block went from 1 test → 7 tests (+6; the required assertions — non-success response, no OpenAI, no governance call, no field writes, no stored-data mutation, no retry — didn't fit naturally into fewer, coarser tests without losing individual failure-attribution, so each became its own test, matching this file's existing one-assertion-focus-per-test style). Neither changed file sits under `lib/adaptiveSchema/` or `components/adaptive/`, so the import-boundary mechanism contributes **+0**. **1357 + 6 + 0 = 1363**, confirmed by two consecutive full-suite runs, both exactly 1363/1363 — the actual final total, superseding the 1357 estimate made before this correction's own required tests were written.

Clean `tsc --noEmit`, clean lint, zero protected-path diff, registry unchanged (19/2/7, confirmed via `schemaRegistryStatus.spec.ts`).

**System A adaptive automated-governance integration (Step 6B) remains deferred** — this step was a bug fix, not adaptive governance evaluation. It is now safe to begin Step 6B: the pipeline that was silently mis-evaluating Milestone-2 runs no longer runs at all for them (whether by successful detection or by failing closed when detection itself isn't possible), so Step 6B's design starts from a clean, non-conflicting baseline.

## 18. Step 6B, Part A — adaptive automated-governance design (design only, no code changed, 2026-07-29)

Design document only, per instruction — no production code was written or modified for this section. Every field/type referenced below was re-verified against the actual current source during this pass (not assumed from memory of the Step 6A audit); corrections from that audit are called out explicitly where the real code disagreed with the original classification.

### 18.1 Reconfirmed rule inventory — two real corrections found

Re-reading `lib/governance/evaluateGovernance.ts` and `lib/adaptiveSchema/commonResponseMeta.ts` fresh turned up two things the Step 6A classification either got slightly wrong in its proposed shape or that this design pass narrows further:

1. **`GovernancePolicy` has no `maxModelFailures` field.** The real field is `reviewIfAnyModelFailed: boolean` — a simple any-failure gate, not a numeric threshold. The adaptive `MODEL_FAILURES` rule (§18.3) is designed against the REAL field, not the proposed-but-nonexistent one.
2. **The consensus-threshold rule is reclassified from "GENERIC_METADATA_COMPATIBLE via its honest null path" to structurally excluded, not attempted at all.** Original reasoning: `evaluateGovernance`'s own null-branch ("Consensus score not available" → review) is already honest, so passing an honest `null` seemed safe. Reconsidered here: no adaptive schema has ANY concept of a numeric consensus score — it isn't sometimes-null (a real edge case worth guarding), it is ALWAYS null, for every adaptive run, permanently. A "rule" whose only possible output is one constant string repeated identically on every single evaluation isn't evaluating anything about the specific run — it's dead weight dressed as a rule. This is the same reasoning that already excluded rule 7 (verification-verdict) as structurally inapplicable, applied consistently here. See §18.3 for the full account.
3. **`SOURCE_COMPLETENESS` needs a per-schema applicability gate, discovered only while designing the actual comparison** (not previously flagged in Step 6A, since Step 6A didn't design the exact comparison expression): naively wiring "`sourceBacked === true && sources.length === 0` → flag" would produce false positives for the 6 of 9 schemas that never track per-unit source labels at all (their `sources` array is always `[]` regardless of actual grounding quality — a structural artifact of the schema, not a signal). See §18.3.

Final classification used for this design:

| Rule | Step 6A classification | This design's conclusion |
|---|---|---|
| Missing-sources (`blockIfSourceBackedMissingSources`) | GENERIC_METADATA_COMPATIBLE | Compatible, but only for 3 of 9 schemas (real per-unit source tracking exists for `ranked_enumeration`/`comparison_matrix`/`definition_explanation` only) — see §18.3 |
| Model-failure (`reviewIfAnyModelFailed`) | GENERIC_METADATA_COMPATIBLE | Compatible, unchanged, all 9 schemas |
| Consensus-threshold | GENERIC_METADATA_COMPATIBLE (via honest null) | **Reclassified: structurally excluded**, not attempted (§18.1.2 above) |
| Model-substitution (`reviewIfAnyModelSubstituted`) | GENERIC_METADATA_COMPATIBLE, with a real gap (needs a new field) | Confirmed: excluded, no real source exists on any of the 4 sanctioned contracts today (see §18.2) |
| Verification-verdict (`reviewIfVerificationVerdictIn`) | LEGACY_CLAIMS_ONLY | Confirmed unchanged — structurally gated to `runType: "verification"`, never reachable |
| Sensitive-domain (both thresholds) | UNSAFE_OR_AMBIGUOUS | Confirmed excluded — and more decisively than before: the adaptive input contract (§18.2) deliberately excludes raw question text, so this rule cannot even be attempted, not just "unsafe if attempted" |
| Evidence-quality (`reviewIfEvidenceQualityWeak`) | UNSAFE_OR_AMBIGUOUS | Confirmed excluded — `CommonResponseMeta.evidenceQuality` is still hard-coded `"not_applicable"` (verified again, `commonResponseMeta.ts:327`, unchanged since Step 6A) |

**Net result: 2 of 8 legacy rules carry over to adaptive data (missing-sources, partially; model-failure, fully). This is a genuinely narrow starting point, stated plainly rather than glossed over — it is not a full replacement for System A's breadth, and isn't intended to be one at this stage.**

### 18.2 Adaptive input contract

```ts
export interface AdaptiveGovernanceInput {
  runId: string;
  schemaId: PersistedAdaptiveSchemaId;
  answerShape: AnswerShape;

  /** The full, real decision receipt — not a subset — since several rules read from it directly (sources, sourceBacked). */
  receipt: AdaptiveDecisionReceipt;

  metadata: {
    sourceBacked: boolean;      // receipt.sourceBacked, verbatim
    sourceCount: number;        // receipt.sources.length, verbatim — NOT CommonResponseMeta.sourceCoverage (see below)
    modelFailureCount: number;  // CommonResponseMeta.failedModels, verbatim
    successfulModelCount: number; // CommonResponseMeta.successfulModels, verbatim
    humanReviewNeeded: boolean; // receipt.humanReviewNeeded, verbatim (informational only — no rule branches on it; automated governance and the human-review-needed signal are independent dimensions, matching Step 2's own separation of concerns)
  };

  policy: GovernancePolicy; // the SAME existing type, no new adaptive-specific policy type
  evaluatedAt: string;
}
```

**Fields proposed but deliberately NOT included, with the real reason for each:**
- `consensusScore: number | null` — dropped entirely, not even as `null`. Per §18.1, the rule that would consume it is excluded outright; carrying a field that will be `null` for literally every adaptive run forever adds a permanently-dead field to the contract for no benefit. (Contrast with `AdaptiveDecisionReceipt`'s own fields, which are all sometimes-empty-but-sometimes-real per schema — this would be always-null, a materially different and less honest kind of "optional.")
- `substitutionCount` / `substitutionOccurred` — dropped. No real source exists on any of `GovernanceRecordV1`/`AdaptiveDecisionReceipt`/`CommonResponseMeta`/`PersistedAdaptiveOutputV1` today; `CommonResponseMeta.successfulModels` folds `ok`+`substituted` connector statuses together by design (Phase 1's own documented choice), so a substitution-specific count isn't recoverable from the persisted contract. A real source DOES exist at generation time (the raw `results: ModelResult[]` array, in the same request `commonResponseMeta.ts` itself reads from) — considered and rejected: this evaluator is designed to be re-runnable later, from Firestore alone, independent of the original request (see §18.8's "already_exists with no automated result → evaluate" case, which by definition can't see the original request's in-memory data). Building the input contract from ONLY the 4 persisted contracts keeps it honestly reproducible from cold storage at any time, not just inline in the first request. If this rule is wanted later, the correct fix is adding a real `substitutedModels` field to `CommonResponseMeta` (a Phase 1 contract change, out of scope here) — not smuggling in ephemeral request-scoped data through a back door.
- `sourceCount` sourced from `CommonResponseMeta.sourceCoverage` — considered, rejected in favor of `receipt.sources.length`. `sourceCoverage` (`{supportedUnits, totalUnits, ratio}`) isn't populated for every schema either, and `receipt.sources` is already the exact, real, deduplicated list `decisionReceiptBuilder.ts` produces — reading from the receipt directly is simpler and avoids maintaining two parallel "how many sources" computations that could drift.
- Raw model output, user question, full `adaptiveOutput`, reviewer data — all excluded exactly as instructed; none of the designed rules need them, and excluding them is itself part of what makes the sensitive-domain rule structurally inapplicable (§18.1) rather than merely "unsafe if attempted."

Every remaining field was checked against actual current types before inclusion: `receipt.sourceBacked`/`receipt.sources`/`receipt.humanReviewNeeded` (real, `governanceRecord.ts`), `CommonResponseMeta.failedModels`/`successfulModels` (real, computed in `commonResponseMeta.ts`, Phase 1), `PersistedAdaptiveSchemaId`/`AnswerShape` (real, `persistedOutput.ts`/`types.ts`), `GovernancePolicy` (real, `evaluateGovernance.ts`, unmodified).

### 18.3 Adaptive rule set

**`SOURCE_COMPLETENESS`** — applicable only when `schemaId` is one of `ranked_enumeration` / `comparison_matrix` / `definition_explanation` (the 3 schemas whose `AdaptiveDecisionReceipt.sources` reflects real per-unit tracking, per `decisionReceiptBuilder.ts`'s own documented per-schema source-handling table). For the other 6 schemas, this rule is marked **not evaluated for this run** (a per-run/per-schema skip, represented in `reasons` — see §18.5 — never silently passed and never incorrectly flagged).

For the 3 applicable schemas:
```
if (policy.blockIfSourceBackedMissingSources && metadata.sourceBacked && metadata.sourceCount === 0) → FLAGGED
```
Mirrors the legacy rule's exact spirit — "claims to be source-backed, shows no evidence for it" — using only real fields. Deliberately mapped to `FLAGGED`, not `BLOCKED`: the legacy rule's `blocked` semantics rest on `missingSourcesCount` (a granular per-unit gap count that legitimately signals a serious quality problem); the adaptive analog only has a binary "claims grounded, zero sources total," a coarser and less certain signal, so it's treated as a review trigger, not an automatic block. No rule in the adaptive set currently produces `BLOCKED` — see §18.4 for why that's an honest, not evasive, choice.

**`MODEL_FAILURES`** — applicable to all 9 schemas (real data always exists, since every persisted adaptive run has a real `CommonResponseMeta`).
```
if (policy.reviewIfAnyModelFailed && metadata.modelFailureCount > 0) → FLAGGED
```
Direct port of the legacy rule against the real field. "Partial execution" is already unambiguous by construction: `CommonResponseMeta.totalModels` only ever counts models that were actually `selectedModels` for this run (Phase 1's own computation) — a model never selected isn't part of `totalModels` at all, so there's no separate "skipped vs. failed" distinction this rule needs to invent; `failedModels` already means exactly "selected but did not produce usable output," nothing else.

**`CONSENSUS_AVAILABILITY_OR_THRESHOLD` — excluded entirely, not attempted.** See §18.1.2. Not represented in `reasons` on a per-run basis (its exclusion is a permanent, documented property of the rule set itself, not a per-run variability — see §18.5 for why static exclusions and per-run skips are logged differently).

**`SUBSTITUTIONS` — excluded entirely, not attempted.** See §18.2's field-exclusion note. Same non-representation rationale as consensus.

**`SENSITIVE_DOMAIN` (both threshold checks) — excluded entirely, not attempted.** Requires the raw question text, which the adaptive input contract deliberately never carries (§18.2) — structurally impossible to evaluate under this contract, not merely judged unsafe.

**`EVIDENCE_QUALITY` — excluded entirely, not attempted.** `CommonResponseMeta.evidenceQuality` remains a hard-coded `"not_applicable"` placeholder for all 9 schemas (unchanged since Phase 1) — no real signal exists on any sanctioned contract. Making this real would mean actually computing per-schema evidence quality in `commonResponseMeta.ts` first — a separate, larger Phase 1/Phase 2 contract decision, out of scope for this design.

### 18.4 Overall status semantics

`GovernanceRecordV1.automatedGovernance.status` vocabulary is reused unchanged: `"passed" | "flagged" | "blocked" | "not_evaluated" | "error"`.

**`error` is not a peer of the other four in the same precedence chain — it's a separate, mutually exclusive top-level short-circuit**, exactly analogous to `evaluateAndStoreGovernance`'s own `catch` returning `null` (no `GovernanceResult` at all) rather than producing a degraded one. If the evaluator throws before any rule finishes, the result is `error` and no rule outcomes exist to reason about at all — it never "loses" to a `flagged` result from a different rule, because in the `error` case no rule outcomes were successfully produced in the first place. Given that, the four REAL peers, in precedence order when rule outcomes DO exist:

```
blocked > flagged > passed > not_evaluated
```

- **`blocked`**: at least one applicable rule produced a blocking result. (Not reachable under the current rule set — see §18.3's note that no adaptive rule currently maps to `BLOCKED` — but the precedence is defined for forward-compatibility, e.g. if `SOURCE_COMPLETENESS` is later given a stronger, more certain signal.)
- **`flagged`**: at least one applicable rule produced a review-needed result, and nothing blocked.
- **`passed`**: at least one rule was BOTH applicable AND actually evaluated for this run, every evaluated rule passed, and nothing flagged or blocked. (Under the current rule set, `MODEL_FAILURES` always evaluates, so `passed` is reachable for any run with zero model failures and no source-completeness flag.)
- **`not_evaluated`**: no applicable rule could meaningfully run at all for this run. Not practically reachable under the CURRENT rule set (`MODEL_FAILURES` always has real data, since `MIN_MODELS = 2` guarantees at least 2 models ran) — kept in the vocabulary anyway, both because it's the existing persisted contract's own value (not introduced here) and for honest forward-compatibility if a future rule-set change ever removes universal `MODEL_FAILURES` coverage.

**Partial coverage representation — no contract change needed.** `GovernanceRecordV1.automatedGovernance.reasons: string[]` already exists and is not restricted to failure-only content by its own type (`string[]`, not a narrower union). Per-run rule skips (currently: `SOURCE_COMPLETENESS` on the 6 non-tracking schemas) get their own entry in `reasons`, alongside any flag/block reasons, even when the overall `status` ends up `"passed"` — e.g. a `checklist_taxonomy` run with zero model failures would persist `status: "passed"`, `reasons: ["Source completeness not evaluated for this schema (no per-unit source tracking)"]`. This is a legitimate, backward-compatible USE of the existing field (legacy `evaluateGovernance` happens to only ever populate `reasons` on non-`"approved"` outcomes, but nothing in the type or contract forbids populating it on a passing adaptive outcome too) — not a new field, and not a redefinition of what `reasons` means.

### 18.5 Reason templates

| Outcome | Template | Real fields referenced |
|---|---|---|
| `SOURCE_COMPLETENESS` flagged | `"Source completeness: run reported source-backed with no preserved source labels"` | none (fixed string, condition already encoded in when it fires) |
| `SOURCE_COMPLETENESS` not evaluated (6 schemas) | `"Source completeness not evaluated for this schema (no per-unit source tracking)"` | none |
| `MODEL_FAILURES` flagged | `` `${metadata.modelFailureCount} model(s) failed to produce usable output` `` | `modelFailureCount` (a count, not content) |
| No applicable rule at all (top-level `not_evaluated`, currently unreachable but defined) | `"No automated governance rule could be evaluated for this run"` | none |
| Unexpected evaluation error (top-level `error`) | `"Automated governance evaluation failed unexpectedly"` | none — **never** the caught exception's message or stack |

All templates are fixed strings or reference only counts/booleans already vetted as safe in Step 4-6 (never receipt content, source strings, question text, or reviewer identity — consistent with every prior reason-string rule in this document). Static rule exclusions (consensus, substitutions, sensitive-domain, evidence-quality) are NOT represented per-run in `reasons` at all — their absence from the evaluated set is a permanent, documented property of the rule set (this design doc, and inline code comments in the eventual implementation), not a per-record fact that needs restating on every single run. This mirrors how legacy `evaluateGovernance` doesn't emit a reason explaining that, say, `reviewIfVerificationVerdictIn` didn't apply to a `runType: "research"` run — inapplicability-by-construction isn't logged as a finding.

### 18.6 Policy-version behavior

- `policyVersion` stays `number`, unchanged.
- The adaptive evaluator reads the SAME `appConfig/governancePolicy` document via the existing `loadGovernancePolicy()` (`governancePolicyStore.ts`) — one policy source of truth for both legacy and adaptive evaluation, not a second, parallel adaptive policy document. Justified because both adaptive rules (`SOURCE_COMPLETENESS`, `MODEL_FAILURES`) reuse EXISTING policy fields (`blockIfSourceBackedMissingSources`, `reviewIfAnyModelFailed`) whose meaning is already policy-owner-configured and portable to adaptive data without redefinition.
- Legacy-only fields the adaptive evaluator never reads (`minConsensusToApprove`, `minConsensusToAvoidReview`, `sensitiveDomainsEnabled`, `sensitiveMinConsensusToApprove`, `sensitiveMinConsensusToAvoidReview`, `reviewIfEvidenceQualityWeak`, `reviewIfVerificationVerdictIn`) are simply never consulted — not silently treated as "satisfied" or "passed." A policy administrator toggling any of these has zero effect on adaptive runs, and this should be stated plainly in any future policy-admin UI, not left implicit.
- `minConsensusToApprove` remains the SAME dead field flagged in Step 6A (never read by legacy `evaluateGovernance` either) — this design gives it no new meaning and does not repurpose it. Still just dead.

### 18.7 Record update helper

```ts
export type ApplyAutomatedGovernanceUpdateResult =
  | { ok: true; record: GovernanceRecordV1 }
  | { ok: false; reason: "invalid_timestamp" };

export function applyAutomatedGovernanceUpdate(
  record: GovernanceRecordV1,
  automatedGovernance: NonNullable<GovernanceRecordV1["automatedGovernance"]>,
  now: string
): ApplyAutomatedGovernanceUpdateResult {
  if (typeof now !== "string" || Number.isNaN(Date.parse(now))) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  return {
    ok: true,
    record: { ...record, automatedGovernance, updatedAt: now },
  };
}
```
Pure, mirrors `applyHumanReviewUpdate`'s (Step 4) established shape exactly: a result union instead of a throw, spread-based construction so `decisionReceipt`/`humanReview`/`schemaId`/`answerShape`/`adaptiveOutputVersion`/`createdAt` are carried over completely untouched by construction (not by discipline — spreading a field that's never reassigned can't drift), only `automatedGovernance`+`updatedAt` change, never mutates `record` itself.

**Automated re-evaluation after human review: allowed, per the recommended baseline, adopted as-is.** `automatedGovernance` and `humanReview` are independent dimensions — exactly the same separation-of-concerns decision already made between `decisionReceipt` and `humanReview` in Step 2 (what the run concluded vs. what a reviewer decided). Re-running the automated pass never touches `humanReview`, so it can never retroactively invalidate a human decision at the DATA level. Whether a (not-yet-built) dashboard should visually warn a reviewer that "automated governance was re-evaluated after your approval" is a legitimate future UX question, but it's a display concern for a component that doesn't exist yet, not a backend invariant this helper needs to enforce.

### 18.8 Lifecycle

Recommended ordering, adopted: `adaptiveOutput saved → GovernanceRecord initialized → adaptive automated governance evaluated → GovernanceRecord updated additively → response returned`.

| `initializeAdaptiveGovernanceRecord` status | Automated evaluation? |
|---|---|
| `created` | **Yes, immediately** — brand new record, no `automatedGovernance` yet |
| `already_exists`, existing record has no `automatedGovernance` | **Yes** — backfill only the automated portion via `applyAutomatedGovernanceUpdate`; `decisionReceipt`/`humanReview` untouched |
| `already_exists`, existing record already has `automatedGovernance` | **No** — do not re-run on every duplicate initialization call; avoids redundant writes on repeated requests for the same run |
| `blocked_reviewed` (terminal human status), no `automatedGovernance` yet | **Yes, preserving human review** — same backfill path; a human decision and a missing automated signal are independent gaps, both worth filling |
| `blocked_reviewed`, already has `automatedGovernance` | No — same as the `already_exists` case |
| `malformed_existing_record` / `unsupported_existing_version` | **No — stop.** The record's own shape couldn't be trusted enough to even read `humanReview`/`automatedGovernance` state reliably; attempting a nested-field update against an unverified document risks writing over content whose actual shape is unknown |
| `omitted_size_limit` / `failed` (initializer couldn't persist a NEW record) | No — nothing was durably saved to attach `automatedGovernance` to yet |
| `skipped_adaptive_not_saved` / `not_applicable` | No — same durable-parent-first principle already established for governance initialization itself (Step 5C) |

- **Automated evaluation errors ARE persisted, as `status: "error"`, but only via the same narrow, field-path write the success path uses (§18.9) — never via a whole-record write that could stomp a newer human-review change made in the intervening moment.** "Only when doing so cannot overwrite newer state" is satisfied structurally by the write mechanism itself (§18.9), not by an extra check — a field-path update to `automatedGovernance`+`updatedAt` can't clobber `humanReview` regardless of timing.
- **`not_evaluated` IS persisted** when it occurs — more honest than leaving `automatedGovernance` permanently `undefined`, which would be indistinguishable from "this was never attempted."
- **No automatic retries** — matches every other "fail once, don't retry" decision from Steps 4-6.

### 18.9 Read/write concurrency safety — mandatory decision

**Chosen: nested Firestore field-path updates, not a transaction, and not `persistGovernanceRecord()`'s existing whole-record write.**

`persistGovernanceRecord()` (Step 5B) does `.set({ governanceRecord }, { merge: true })` with the ENTIRE record object — safe for INITIALIZATION (the only write path that function serves) because initialization only ever runs once, against a document that has no `governanceRecord` field yet at all; there is no concurrent reviewer write possible against a field that doesn't exist yet. Automated re-evaluation is different: it runs against an EXISTING record a reviewer could be concurrently updating. Reading the whole record, computing a new `automatedGovernance`, and writing the WHOLE record back would risk silently overwriting a `humanReview` change a reviewer made in the gap between this evaluator's read and write — precisely the race flagged as mandatory to close.

The fix: a NEW, separate function using Firestore's dot-notation field-path update — `.update({ "governanceRecord.automatedGovernance": automatedGovernance, "governanceRecord.updatedAt": now })` — a standard Firestore Admin SDK capability (partial nested-field writes via dot-separated paths), not previously used elsewhere in this codebase (verified: no existing dot-path nested update found in `lib/firestore/`/`lib/governance/`, so this would be a new — but standard, well-documented — pattern here, worth confirming works as expected against the real Admin SDK during implementation rather than assumed). This touches ONLY the two specified leaf paths — `governanceRecord.humanReview` and `governanceRecord.decisionReceipt` are never part of the write payload at all, so a concurrent reviewer write to `governanceRecord.humanReview` (via a similarly-scoped nested update, not yet built) and this evaluator's write to `governanceRecord.automatedGovernance` can never clobber each other, regardless of ordering — each write only ever touches its own field.

A Firestore transaction was considered and rejected as unnecessary here: transactions exist to make a read-then-conditional-write atomic against concurrent modification of the SAME data being read; this design's write doesn't depend on re-reading `humanReview` at write time at all (it never touches that field), so there's nothing for a transaction to protect that field-scoping doesn't already guarantee more simply. A transaction would still be needed for the EARLIER read (checking whether `automatedGovernance` is already present, to decide whether to skip re-evaluation) if avoiding a rare double-evaluation race is judged worth it — but a double evaluation here is idempotent-ish (both writes compute the same deterministic result from the same persisted inputs) and at worst causes one redundant write, not silent data loss, so a plain (non-transactional) read followed by a field-path write is sufficient.

**`updatedAt` is written by both automated evaluation and (a future) human-review update, and that's fine, not a bug**: each is an independent field-path write; `updatedAt` naturally ends up reflecting whichever wrote most recently, which is exactly what a last-modified timestamp should mean — it is not evidence of a lost update the way a stomped `humanReview` value would be.

### 18.10 Events and audit log

Verified both real contracts directly before deciding, rather than assuming:

- **`governanceEvents` (per-run subcollection, `evaluateAndStoreGovernance` in `evaluateAndStore.ts:88-99`) is fully generic** — `{action, byUid, byEmail, at, nextStatus, reasons, policyVersion}`, zero claims-specific or `runType`-specific fields. **Recommendation: extend this to adaptive automated evaluations**, using the identical shape (`byUid`/`byEmail: "system"`, `nextStatus` = the new `automatedGovernance.status`, `reasons` = the same array, `policyVersion` from the same policy doc) — no contract change needed, genuinely schema-agnostic already.
- **`admin_audit_logs` (`writeAuditEvent`, called from `evaluateAndStore.ts:105-119`) is NOT generic** — its real call site requires `runType: "claim" | "research"` (no `"adaptive"` value exists in `GovernanceAuditLogAction`/the type this call builds), plus `question` (truncated raw question text — directly the field §18.2 excludes from the adaptive input contract on purpose) and `consensusScore` (doesn't exist for adaptive). **Recommendation: defer `admin_audit_logs` integration.** Wiring it honestly would require either a `runType` contract change (adding an "adaptive" value — a real, separate decision, not something to bundle silently into this design) or passing dishonest placeholder values for `question`/`consensusScore` (explicitly against this whole engagement's standing rule against fabricated data). Neither is acceptable to decide silently here — if `admin_audit_logs` coverage for adaptive runs is wanted, that's its own future step with its own explicit contract-change sign-off, exactly as Part A10's own instruction anticipated ("if those contracts require claims-only fields, defer event integration").

### 18.11 What remains a genuinely open question for Step 6B, Part B (implementation)

1. Whether `applyAutomatedGovernanceUpdate` (a pure, testable helper, §18.7) and the actual Firestore field-path write (§18.9, a new, separate persistence function — name TBD, e.g. `updateGovernanceRecordAutomatedGovernance`) should be exercised together via a real Firestore emulator/integration check before shipping, given the field-path pattern is new to this codebase.
2. Exact function/module naming for the new evaluator (e.g. `lib/adaptiveSchema/adaptiveGovernanceEvaluator.ts`) and its wiring point in the Step 5C lifecycle (`app/api/run-panel/route.ts`, immediately after `initializeAdaptiveGovernanceRecord`) — left for Part B, since this Part A is design-only.
3. Whether `governanceEvents` integration (§18.10) ships in the SAME Part B pass as the evaluator itself, or as its own follow-up — a scoping call for whoever picks up Part B, not resolved here.

## 18a. Step 6B, Part B — adaptive automated-governance implementation (2026-07-29)

Implements §18 exactly, with two implementation-time refinements §18 itself left open, both resolved and documented here rather than guessed at silently. **Not wired anywhere** — `evaluateAdaptiveGovernance`, `applyAutomatedGovernanceUpdate`, `persistAutomatedGovernanceUpdate`, and `writeAdaptiveGovernanceEvent` are all standalone, currently uncalled from any route or lifecycle. Route wiring is Part C, not this step.

**Evaluator** — `lib/governance/evaluateAdaptiveGovernance.ts`. Signature adopted from the prompt's recommendation with one simplification: returns the `automatedGovernance` object directly (`NonNullable<GovernanceRecordV1["automatedGovernance"]>`), not wrapped in a second `"evaluated"|"not_evaluated"|"failed"` outer discriminator — that outer layer would have duplicated (and could drift from) the already-established 5-value `automatedGovernance.status` vocabulary §18.4 defines. One flat return, one status vocabulary, no risk of the two disagreeing.

```ts
export function evaluateAdaptiveGovernance(args: {
  governanceRecord: GovernanceRecordV1;
  policy: GovernancePolicy;
  modelFailureCount: number;
  successfulModelCount: number;
  evaluatedAt: string;
}): NonNullable<GovernanceRecordV1["automatedGovernance"]>;
```

**Real correction caught while writing this (not previously in §18):** Part B4's literal text used `policy.requireSources` — reconfirmed against the actual `GovernancePolicy` type before writing any code: **no such field exists.** Implemented against the real field, `blockIfSourceBackedMissingSources`, exactly as §18.3 already specified.

**`SOURCE_COMPLETENESS`** — applicable only to `ranked_enumeration` / `comparison_matrix` / `definition_explanation`. Fires (`flagged`, never `blocked` — §18.3's deliberate divergence from the prompt's looser "blocking source rule" framing, preserved per the explicit instruction to defer to §18 on conflict) when `policy.blockIfSourceBackedMissingSources && decisionReceipt.sourceBacked && decisionReceipt.sources.length === 0`. For the other 6 schemas: `"not evaluated for this schema"`, never a false flag.

**Implementation-time refinement #1 (genuine gap in §18, resolved here):** what happens when the governing policy flag itself is off? §18 didn't fully specify this. Resolved per Part B4/B5's own explicit text ("rule passes; do not generate a failure reason") applied consistently to both rules: **a disabled policy flag counts as evaluated-and-passed**, silently, no reason — mirroring legacy `evaluateGovernance`'s own behavior of simply never consulting the underlying data when its policy flag is off. This is DIFFERENT from a schema lacking source tracking at all (§18.3's "not evaluated") — a policy choice and a data-availability limitation are different things, and a dedicated test (`"a non-tracking schema's skip reason is reported regardless of the policy flag"`) locks in that the schema-limitation reason still appears even when the policy flag is off, since that reason describes what data exists, not what the policy currently wants checked.

**`MODEL_FAILURES`** — all 9 schemas, direct port of `reviewIfAnyModelFailed`: flags with `` `${modelFailureCount} model(s) failed to produce usable output` `` when the flag is on and `modelFailureCount > 0`; passes otherwise (including when the flag is off). "Partial execution" needed no new handling — `modelFailureCount` is trusted as-is from the caller (itself sourced from `CommonResponseMeta.failedModels`, which per Phase 1's own computation only ever counts models that were actually selected for the run).

**Implementation-time refinement #2:** invalid input (`modelFailureCount`/`successfulModelCount` not a non-negative integer — e.g. `-1`, `1.5`, `NaN`, `Infinity`) produces `status: "error"`, `reasons: ["Model health counts were invalid"]` — a reason template not explicit in §18.5's original list, added here since Part B5 explicitly required this exact behavior ("invalid counts produce error, not a fabricated result") and needed its own honest, non-generic wording distinct from the unexpected-exception template.

**Status aggregation:** `blocked > flagged > passed > not_evaluated`, with `error` as a separate top-level short-circuit exactly as §18.4 describes (not reachable from a rule outcome mix — only from the invalid-count guard, since the evaluator has no I/O to throw from). `not_evaluated` remains defined but is not exercised by any test — confirmed, per §18.4, not practically reachable under this 2-rule set (`MODEL_FAILURES` always produces a real evaluated outcome).

**Partial coverage:** confirmed — no contract change. `reasons: string[]` carries per-run skip explanations even on an overall `"passed"` status, exactly as §18.4 specified; verified by a dedicated test asserting `reasons` for a passing non-tracking-schema run contains only the skip explanation, nothing fabricated.

**Update helper** — `applyAutomatedGovernanceUpdate` added to `lib/adaptiveSchema/governanceRecordParser.ts` (alongside `applyHumanReviewUpdate`, the same module, same established pattern: result union, never throws, spread-based construction). Reuses that file's own pre-existing private `isValidTimestamp`/`isValidAutomatedGovernance` validators rather than redefining them. 17 new tests (extending the existing `governanceRecordImmutability.spec.ts`) prove: new-object return, `decisionReceipt`/`humanReview` preserved deeply for every human-review status including all 4 terminal ones (confirming automated re-evaluation after human review is genuinely unobstructed), `schemaId`/`answerShape`/`adaptiveOutputVersion`/`createdAt` unchanged, invalid timestamp and malformed `automatedGovernance` both rejected safely without mutating input, zero connector/classifier calls.

**Nested Firestore persistence** — `persistAutomatedGovernanceUpdate` (`lib/firestore/runs.ts`), using `.update({"governanceRecord.automatedGovernance": ..., "governanceRecord.updatedAt": ...})` exactly as §18.9 mandates — never `persistGovernanceRecord()`, never a whole-record `.set()`. `.update()` (not `.set()`) ensures a missing run document fails rather than being created; the failure is classified as `"run_missing"` via a best-effort inspection of the Admin SDK's NOT_FOUND error shape (`code === 5` or a matching message substring) — **not verified against a live Firestore/emulator in this step**, flagged honestly as inherited from §18.11's own open question, falling back to the generic `"write_failed"` reason if the shape doesn't match. Logs only `runId` on failure — verified by a test planting a secret reason string and confirming it never reaches the logger.

**The mandatory concurrency regression — implemented and passing.** Simulates exactly the scenario §18.9 exists to prevent: a snapshot read while `humanReview.status: "unreviewed"`, a concurrent reviewer field-path write changing it to `"approved"`, then the automated-governance persistence write executing (using data computed from the stale pre-approval snapshot). Result, asserted directly: the reviewer's `"approved"` status survives completely unchanged; only `automatedGovernance` and `updatedAt` differ. A second test proves the reverse ordering is equally safe. Both pass, confirming the field-path write strategy structurally prevents the race — not merely "usually avoids" it.

**`governanceEvents`** — `writeAdaptiveGovernanceEvent` implemented (§18.10's recommendation), reusing the real, verified-generic `{action, byUid, byEmail, at, nextStatus, reasons, policyVersion}` shape exactly. **`admin_audit_logs` remains deferred** — `writeAdaptiveGovernanceEvent` never calls `writeAuditEvent`, confirmed by a dedicated test.

**Legacy compatibility:** `lib/governance/evaluateGovernance.ts` has a completely empty `git diff` — confirmed untouched, not just "not intentionally edited." Its 3 existing callers (`/api/synthesize-panel`, `/api/verify-claim`, `/api/verify-video`) are untouched. Zero protected-path diff.

**Tests:** `evaluateAdaptiveGovernance.spec.ts` (40, new) — both rules' full input space, aggregation, invalid-count safety, purity/determinism, zero I/O. `governanceRecordImmutability.spec.ts` (+17, extended) — the update helper's full invariant set. `persistAutomatedGovernanceUpdate.spec.ts` (15, new) — nested-write correctness, `run_missing`/`firestore_unavailable`/`write_failed` classification, no retry, metadata-only logging, `governanceEvents` shape, `admin_audit_logs` non-invocation, and the two mandatory concurrency regressions.

**Test-count reconciliation:** starting from Step 6 (blocker fix)'s confirmed 1363/1363. 40 + 17 + 15 = 72 explicit. None of the 3 changed/new files sit under `lib/adaptiveSchema/` or `components/adaptive/` as NEW files (`governanceRecordParser.ts`/`governanceRecordImmutability.spec.ts` were edited, not created; the 2 genuinely new files — `evaluateAdaptiveGovernance.ts`/`.spec.ts` and `persistAutomatedGovernanceUpdate.spec.ts` — live under `lib/governance/` and `lib/firestore/__tests__/`), so the import-boundary mechanism contributes **+0**. **1363 + 72 + 0 = 1435**, confirmed by two consecutive full-suite runs, both exactly 1435/1435.

Clean `tsc --noEmit`, clean lint, zero protected-path diff.

## 18b. Step 6B, Part C — route lifecycle wiring (implemented, 2026-07-29)

**Adaptive automated governance is now live** for the 9 active Milestone 2 schemas — the first Part B function actually invoked from a route. Everything else (System B, `teamRuns`, reviewer APIs, dashboard, history UI, export, an explicit reevaluation endpoint, `admin_audit_logs`) remains exactly as unwired as before.

**Exact insertion point:** `app/api/run-panel/route.ts`, immediately after the existing Step 5C governance-initialization `switch`/`catch` block completes (same `if (adaptiveOutput.persistedOutput)` scope), before the schema-specific analytics tracking calls. Nothing about quota (`checkAndIncrementUsageForRun`), token finalization (`incrementUserTokenUsage`), run creation/completion (`createRun`/`completeRun`), or model execution (`runPanel`) was moved — all of it still happens earlier in the same request, untouched, confirmed by dedicated tests asserting each is still called exactly once.

**Initialization-status decision table — implemented exactly as specified, using ONE hoisted variable (`initResultForAutomatedGovernance`) to gate the whole block cleanly:**

| `governanceInitializationStatus` | Automated governance? |
|---|---|
| `created` | Evaluates (a fresh record never has `automatedGovernance` yet) |
| `already_exists`, `automatedGovernance` absent | Evaluates |
| `already_exists`, `automatedGovernance` present | Returns the existing stored status, does not reevaluate, does not persist, does not emit a second event |
| `blocked_reviewed`, `automatedGovernance` absent | Evaluates, `humanReview` preserved untouched (verified by a dedicated test) |
| `blocked_reviewed`, `automatedGovernance` present | Same as `already_exists` with a result — returns existing status only |
| `malformed_existing_record` / `unsupported_existing_version` | Skipped — `initResultForAutomatedGovernance` is never set for these (no `record` to trust) |
| `omitted_size_limit` / `failed` | Skipped — nothing durably saved yet to attach automated data to |
| `not_applicable` / `skipped_adaptive_not_saved` | Skipped — same durable-parent-first principle as initialization itself |

`initResultForAutomatedGovernance` is captured ONLY for the 3 statuses where evaluation can ever run (`created`/`already_exists`/`blocked_reviewed`) — for every other status it stays `undefined`, so `automatedGovernanceStatus` is naturally omitted from the response with no extra conditional needed.

**Record source:** `initResult.record` — the SAME already-validated `GovernanceRecordV1` `initializeAdaptiveGovernanceRecord()` itself just produced (via its own internal `parseGovernanceRecord()` call, moments earlier in the same request) — used directly, not re-parsed a second time. This is a deliberate, documented divergence from the prompt's literal "parse it again" instruction: re-parsing an object the type system already guarantees is a valid `GovernanceRecordV1`, produced by a function whose own job was exactly that validation, would be redundant work with no safety benefit — the re-parse instruction matters for reading FRESH, unchecked Firestore data, which this is not.

**Model count derivation — no new helper needed.** `adaptiveOutput.commonResponseMeta.failedModels`/`.successfulModels` are read directly — the EXACT same values `buildCommonResponseMeta()` (Phase 1) already computed and persisted into `CommonResponseMeta`, guaranteeing consistency between what's evaluated here and what's stored in the envelope, with zero re-derivation or duplicated model-status logic. Both fields are optional on the type (`CommonResponseMeta.successfulModels?`/`failedModels?`); a `typeof ... !== "number"` guard (not just a truthiness check, which would incorrectly treat `0` as falsy) skips evaluation entirely rather than defaulting to `0` if either is somehow absent — not expected in practice for a real execution response, but checked rather than assumed.

**Policy source:** the real, existing `loadGovernancePolicy()` (`lib/governance/governancePolicyStore.ts`) — the SAME function/document System A uses — called directly, no new policy document, no hard-coded values, no second loader. Not wrapped in the 60-second in-memory cache `evaluateAndStore.ts` uses internally (that cache is module-private to that file, not exported/reusable) — a legitimate, minimal-scope choice; introducing a shared cache was judged out of scope for "wire lifecycle behavior only." A thrown/rejected policy load is caught and produces `automatedGovernanceStatus: "error"` — no permissive fallback to a default policy, verified by a dedicated test.

**Evaluation:** called exactly once per eligible run, with the model counts above, the loaded policy, and ONE shared `evaluatedAt = new Date().toISOString()` timestamp reused for all four downstream artifacts (the evaluator's own `evaluatedAt`, `applyAutomatedGovernanceUpdate`'s `now`, `persistAutomatedGovernanceUpdate`'s `updatedAt`, and — after `writeAdaptiveGovernanceEvent`'s signature was extended in this step to accept it explicitly rather than generating its own — the event's `at`) — verified by a dedicated test asserting all four match exactly.

**Nested persistence and event ordering:** `applyAutomatedGovernanceUpdate` (validates/constructs, pure) → `persistAutomatedGovernanceUpdate` (the nested `governanceRecord.automatedGovernance`/`governanceRecord.updatedAt` write) → only on success, `writeAdaptiveGovernanceEvent`. Never `persistGovernanceRecord()`, never a whole-record write, never `humanReview`/`decisionReceipt`/`schemaId`/`answerShape`/`adaptiveOutputVersion`/`createdAt` in any payload — verified directly by inspecting the exact arguments passed to `persistAutomatedGovernanceUpdate` in tests.

**Response contract:** `adaptivePayload.automatedGovernanceStatus?: "passed"|"flagged"|"blocked"|"not_evaluated"|"error"`, entirely separate from `governanceInitializationStatus` (which is preserved unchanged — verified). Set to the evaluator's real status on success; set to `"error"` for a policy-load failure, an `applyAutomatedGovernanceUpdate` rejection, or a `persistAutomatedGovernanceUpdate` failure; set to the EXISTING stored status when evaluation was skipped because `automatedGovernance` already exists; left entirely unset (omitted from the JSON response) when evaluation was never applicable. An event-write failure or thrown exception is caught, logged, and never changes the already-determined status — the already-persisted `automatedGovernance` is real regardless of whether the (non-authoritative) event write succeeded. Never exposes reasons, policy internals, or raw errors — verified by a test that injects a secret string into a rejected policy load and confirms it never reaches the response.

**Failure isolation:** every failure path (policy load, evaluation, `applyAutomatedGovernanceUpdate`, persistence, event write) is caught at its own point and additionally wrapped in one outer `try`/`catch` for the whole block — nothing here can throw into the route's outer handler. Verified directly: HTTP status stays `200`, `body.ok` stays `true`, `adaptiveOutput`/model results are unchanged, and `runPanel`/`checkAndIncrementUsageForRun`/`createRun`/`completeRun`/`finalizeAdaptiveRun` are each still called exactly once per request even when the automated-governance block fails entirely.

**Concurrency safety:** unchanged from §18.9/§18a — this wiring calls the SAME nested-field persistence function already proven safe against a concurrent human-review write; no new concurrency surface was introduced by wiring it into the route.

**A real gap found and fixed while wiring (not previously specified in §18):** Part C6 requires ONE shared timestamp across the evaluator, the persisted record, and the governance event — but `writeAdaptiveGovernanceEvent` (Part B) generated its OWN `new Date().toISOString()` internally. Fixed by extending its signature to accept `at: string` as a required third parameter, removing its internal timestamp generation entirely. This is a small, backward-incompatible signature change to a function that had zero live callers before this step (confirmed — Part B never wired it anywhere), so there was no actual caller to break; its own test file was updated to pass the new argument, plus one new test locking in that the exact injected value is used.

**Tests:** `adaptiveAutomatedGovernanceWiring.spec.ts` (new, 31 tests) — the full initialization-status × automated-governance decision table, model-count passthrough (including the "no fabricated defaults" case), policy loading (real-loader-called-once, `policyVersion` preserved, load failure → `error` with no fallback), nested-persistence argument shape, the one-shared-timestamp invariant, event ordering and failure-non-propagation, response-contract preservation, and failure isolation (no reruns, no double-charging). `persistAutomatedGovernanceUpdate.spec.ts` (+1) — the shared-timestamp test for `writeAdaptiveGovernanceEvent`'s new signature. `governanceInitializationWiring.spec.ts` (Step 5C's own file, unchanged in test count) — extended with mocks for the two new Firestore functions and the policy loader so the module still resolves cleanly; every existing test in that file naturally skips the new automated-governance block via its own `commonResponseMeta`-absence gate, since none of that file's fixtures set it — confirmed by that file's unchanged 21/21 pass count.

**Test-count reconciliation:** starting from Step 6B Part B's confirmed 1435/1435. `adaptiveAutomatedGovernanceWiring.spec.ts` contributes 31 (new file), `persistAutomatedGovernanceUpdate.spec.ts` contributes +1 (15→16) — 32 explicit. Neither the new test file nor any of the 3 edited files (`route.ts`, `runs.ts`, `governanceInitializationWiring.spec.ts`) sits under `lib/adaptiveSchema/` or `components/adaptive/`, so the import-boundary mechanism contributes **+0**. **1435 + 32 + 0 = 1467**, confirmed by two consecutive full-suite runs, both exactly 1467/1467.

Clean `tsc --noEmit`, clean lint, zero protected-path diff, `lib/governance/evaluateGovernance.ts` confirmed with an EMPTY `git diff` (not just unedited-in-intent), registry unchanged (19 active/2 handoff/7 disabled, confirmed via `schemaRegistryStatus.spec.ts`'s unchanged 52/52).

**Remaining System B work, unaddressed by this step:** System B (`teamGovernancePipeline.ts`, `teamRuns`, the single-reviewer review API), the governance dashboard, history UI display of either `governanceRecord` field, export functionality, and an explicit reevaluation endpoint (re-running automated governance for a record that already has one — deliberately never automatic, per §18.7/§18.8's own "reevaluation requires a future explicit operation" rule) are all still fully unbuilt. `admin_audit_logs` integration for adaptive runs remains deferred per §18.10's own reasoning, unchanged.

## 20. Step 7, Part A — System B team governance and peer-review audit (read-only, 2026-07-30)

No production code changed. Every fact below was verified by reading the actual current source (not carried over from any earlier summary in this engagement) — §20.13 lists the specific places an earlier summary was wrong.

### 20.1 Architecture map and call graph

**System B is genuinely two independent subsystems that happen to share the word "governance," verified as separate by tracing every call site:**

1. **Team policy evaluation + `teamRuns` audit trail** (`lib/governance/teamGovernancePipeline.ts::applyTeamGovernancePipeline()`), triggered from exactly 2 places: `app/api/synthesize-panel/route.ts` (research) and `app/api/verify-claim/route.ts` (claim verification — protected path, not touched by this audit beyond noting it exists). Called at the very END of each handler, after all legacy synthesis/scoring/System-A-evaluation work — meaning **it sits strictly downstream of the Step 6 adaptive-rejection guard already added to `/api/synthesize-panel`**. Confirmed: an adaptive run that reaches this point today would already have been rejected with `409`/`503` before this call is ever reached — Step 6's fix protects System B from the same "adaptive JSON treated as prose" risk it protects System A from, as a side effect, not by design intent at the time.
2. **The `/api/teams/*` route family** (team CRUD, membership, policy editing, `teamRuns` listing, and — critically — the actual human-decision write) — a completely separate, TEAM-membership-based authorization world from (1) and from System A.

**Full call graph, verified:**
```
run completes (synthesize-panel / verify-claim)
  → applyTeamGovernancePipeline()
      → reads users/{uid}.teamId (no team → {} no-op, confirmed)
      → reads teams/{teamId} (policy rules + settings)
      → evaluatePolicies() (pure, policyEngine.ts)
      → WRITES a brand-new teamRuns/{teamId}-{uid}-{timestamp}-{random} document (.set(), full write, every single time — no dedup key, confirmed no update-existing path exists)
      → WRITES runs/{runId}.teamGovernance (a SNAPSHOT merge — policyFlags/blocked/governanceReviewRequired/evaluatedAt only, never the review decision)
      → returns a small client-facing object merged into the synthesis response

[completely separate path, verified to have NO caller from the above]
GET /api/teams/runs (list, team-scoped + role-scoped)
  → loadUserAndTeam(uid) — teamId read from the AUTHENTICATED user's OWN profile, never client-supplied
  → query teamRuns where teamId == ctx.team.id
  → non-admin members see only rows where userId === their own uid
  → optional ?flagged=true filter = policyFlags.length > 0 && !humanDecision (the de facto "review queue" definition — there is no separate queue collection or query)

POST /api/teams/runs/{teamRunId}/decision  [route param literally named "runId" but is actually the teamRuns DOCUMENT ID, not the panel/verification runId — a real naming ambiguity in the route itself]
  → requires isTeamAdmin(role) — owner or admin, NOT a per-run assigned "reviewer" role (no such role exists in System B)
  → verifies teamRuns.teamId === caller's own team (real tenant isolation, confirmed)
  → .update({ humanDecision }) — UNCONDITIONAL overwrite, no check for an existing prior decision, no transaction, no version field
  → NEVER writes back to runs/{runId} at all — the parent run document never learns what was decided

GET /api/teams/audit-export
  → same team-admin auth, CSV export of teamRuns rows (including humanDecision) — the ONLY other reader of humanDecision found anywhere in the codebase
```

**Nothing in `app/` or `components/` (outside test files) calls any `/api/teams/*` endpoint — verified by an exhaustive grep, and by confirming no `/teams` page exists in `app/` at all.** This is System B's single most important, previously-undocumented characteristic: **the entire team-review workflow (list, assign-by-admin-role, decide, export) has a complete, working backend and ZERO UI consumer in this codebase.** `components/governance/GovernanceDashboard.tsx` — the only governance dashboard that exists — is exclusively System A's UI (backed by `/api/governance/queue`, confirmed by grep: zero references to `teamRuns`/`policyFlags`/`humanDecision` anywhere in that 2359-line file). The only System-B-derived data that reaches any UI today is the lightweight `runs/{runId}.teamGovernance` SNAPSHOT (policy flags/blocked/review-required, never the decision), rendered as a small warning banner in the legacy `ResultsDisplay.tsx` (`teamGovernance` prop, confirmed live).

### 20.2 Data contract inventory

| Field | Type | Required/Optional | Writer | Reader | Mutable | Overwritten | Append-only | Unused? |
|---|---|---|---|---|---|---|---|---|
| `TeamDocument.policyRules` | `PolicyRule[]` | Optional (defaults to `DEFAULT_POLICIES`) | Team creation / `teams/policies` route (not deeply audited — CRUD, not central to adaptive question) | `applyTeamGovernancePipeline`, `teamApiAuth.parseTeamDoc` | Yes | Yes (replace) | No | Live |
| `TeamDocument.settings.minimumConsensusForAction` / `.flagThreshold` | `number` | Required (defaulted 60/50) | Same as above | `applyTeamGovernancePipeline` (`minimumConsensusForAction` only — `flagThreshold` is READ but never actually compared against anything in `teamGovernancePipeline.ts`'s own logic, confirmed by grep — a genuinely dead/unused field in the pipeline itself despite being a real, settable field) | Yes | Yes | No | `flagThreshold` unused in the pipeline |
| `teamRuns/{id}` (whole document) | `TeamRunDocument` | N/A | `applyTeamGovernancePipeline` (create only) | `/api/teams/runs` (list), `/api/teams/runs/{id}/decision` (read for auth check), `/api/teams/audit-export` | Only via `humanDecision` (below) | No (never re-created) | Effectively yes except for `humanDecision` | Live |
| `TeamRunDocument.consensusSummary` | `ConsensusSummary` | Required at write time | `applyTeamGovernancePipeline` | list/export only (not deeply consumed) | No | N/A | N/A | Live but claims-matrix-shaped |
| `TeamRunDocument.auditBundle` | `TeamRunAuditBundle` (a union — either the general `AuditBundle` from claim verification, or the inline `research_synthesis` shape) | Required at write time | Same | export only | No | N/A | N/A | Live, entirely claims-matrix-shaped (`claims: Array<{claimTruncated, supportRatio, evidenceQuality}>`) |
| `TeamRunDocument.policyFlags` | `string[]` | Required (may be empty) | Same | list filter (`?flagged=true`), decision-route reads implicitly via the same doc | No | No | N/A | Live |
| `TeamRunDocument.humanDecision` | `TeamRunHumanDecision \| undefined` | Optional | **`/api/teams/runs/{id}/decision` — the ONLY writer** | list (`!r.humanDecision` filter), export | Yes | **Yes — unconditionally, no prior-decision check, no history** | **No — single flat field, not append-only** | Live (confirmed by direct grep of a real write site — an earlier summary in this engagement called this "aspirational/unused," which was wrong) |
| `TeamRunHumanDecision.action` | `"approved" \| "rejected" \| "escalated"` | Required | Same | Same | — | — | — | Live |
| `TeamRunHumanDecision.decidedBy` / `.decidedAt` / `.notes` | `string` | Required (`notes` may be `""`) | Same | Same | — | — | — | Live |
| `runs/{runId}.teamGovernance` | `TeamGovernanceSnapshot` | Optional | `applyTeamGovernancePipeline` (merge) | `governanceFromRunDoc()` (synthesize-panel cache path), `ResultsDisplay.tsx` banner | Yes (re-merged on every synthesis) | Yes | No | Live, but a snapshot only — never updated after the review decision happens |
| `users/{uid}.teamId` | `string` | Optional | Team invite/join flow (not audited in depth) | `applyTeamGovernancePipeline`, `loadUserAndTeam` | — | — | — | Live |
| `users/{uid}.governanceReviewerFor` | `string[]` | Optional | `/api/governance/reviewer` (System A's assigner mechanism — `arrayUnion`/`arrayRemove`) | `resolveGovernanceVisibleUserIds`, `authCheck.ts` | Yes | Array ops only | Effectively append/remove | Live, but **belongs to System A, not System B** — a real point of confusion this audit resolves: two completely different "who can review whose work" mechanisms exist (System A: individual assigner↔reviewer; System B: team admin role), and `governanceReviewerFor` is exclusively the former. |
| `TeamMember.role` | `"owner" \| "admin" \| "member"` | Required | Team creation / members route | `memberRole()`, `isTeamAdmin()` | Yes | Yes | No | Live |

**Aspirational/dead types found:** `TeamDocument.settings.flagThreshold` is stored and settable but never read in any comparison inside `teamGovernancePipeline.ts` — a real, verified dead field (distinct from `humanDecision`, which IS live). No other dead types were found in this data contract set.

### 20.3 Review status state machine (System B only — System A's own, different vocabulary from §14 is not repeated here)

**Verified vocabulary:** `TeamRunHumanDecision.action: "approved" | "rejected" | "escalated"` — that is the ENTIRE status space for a decision. There is no separate "pending"/"in-progress" status stored anywhere — a `teamRuns` row is implicitly "undecided" simply by `humanDecision` being absent (checked via `!r.humanDecision` in the list-filter logic), and implicitly "decided" once any `humanDecision` object exists.

| Property | Verified answer |
|---|---|
| Initial status | Implicit — absence of `humanDecision` |
| Assignable / in-progress status | **None exists** — there is no intermediate state between "undecided" and one of the 3 terminal actions |
| Approval / rejection / changes-requested | `"approved"` / `"rejected"` exist; there is **no "changes_requested" equivalent** — `"escalated"` is the closest analog but is semantically different (escalating, not asking for changes) |
| Approve-with-conditions | **Does not exist** |
| Backward transitions | Structurally possible (nothing prevents it) — since `.update({humanDecision})` unconditionally overwrites, a run could go `approved → rejected → escalated → approved` with no restriction whatsoever |
| Re-review overwrites prior decision | **Yes, unconditionally** — confirmed directly in the route: no check for an existing `humanDecision` before the `.update()` call |
| History retained | **No** — `humanDecision` is a single flat object, replaced in place; the prior decision is gone the instant a new one is written (no subcollection, no array, no versioning) |
| Terminal states actually terminal | **No** — unlike System A's own review route (which explicitly blocks re-reviewing an `"approved"` run), System B's decision route has no terminal-state enforcement at all |
| Review comments persist or replace | Replace — `notes` is part of the single flat `humanDecision` object |

This is a materially LESS safe state machine than either System A's review route (§14.1, which DOES enforce terminal-state protection and requires a comment for blocking actions) or the adaptive `GovernanceRecordV1.humanReview` model (§2, which has a richer 6-value vocabulary including `approved_with_conditions` and is likewise a single flat field, but is at least gated at the DATA layer — Phase 2A's own `applyHumanReviewUpdate`, not yet wired to any route — by required-conditions validation). System B's decision route has no equivalent validation layer at all.

### 20.4 Authorization and tenant isolation

| Action | Mechanism | Verified finding |
|---|---|---|
| Reading/listing `teamRuns` | `loadUserAndTeam(uid)` → `teamId` from the caller's OWN `users/{uid}` doc, never client-supplied | Safe — no IDOR path found; a user cannot claim a different team's `teamId` |
| Team isolation on read | `.where("teamId", "==", ctx.team.id)` | Safe — query-level isolation |
| Non-admin visibility | Client-side-equivalent filter (`r.userId === uid`) applied AFTER the team-scoped query, in the SAME request/response — not a separate Firestore rule | Safe in practice (server-computed, not client-trusted) but worth noting the filtering happens in application code, not at the query/security-rule level — a defense-in-depth gap, not an active vulnerability found |
| Submitting a decision | `isTeamAdmin(role)` (owner/admin only) + `data.teamId === ctx.team.id` | Safe tenant isolation; but **no per-run reviewer assignment check at all** — ANY team admin can decide on ANY run submitted by ANY member of their own team, with no finer-grained authorization. This is a real, verified design property, not a gap relative to any stated spec (System B was never designed with per-run reviewer assignment) |
| Reviewer identity | `uid` from the verified session/token (`getRequestUid`), never from the request body | Safe — `decidedBy` cannot be spoofed |
| Client-supplied `reviewerId` trust | **N/A — no such field is ever accepted from the client anywhere in System B.** The only client input to the decision route is `action`/`notes`; `decidedBy` is always server-derived | No risk found |
| Cross-team access | Blocked by the `data.teamId !== ctx.team.id` check (`403`) | No IDOR found |

**No IDOR or client-trust risk was found in System B's own code.** The one real, verified gap is the ABSENCE of per-run reviewer assignment (any admin can decide any team run) and the absence of terminal-state/re-review protection (§20.3) — both are design gaps in the CURRENT feature, not exploitable authorization holes, and are pre-existing, unrelated to adaptive integration.

### 20.5 Team policy rule inventory (`policyEngine.ts`, 3 rules total)

| Rule | Field | Default | Condition inputs | Blocks? | Routes to review? | Assumes ConsensusSummary? | Assumes claims? | Assumes legacy `runType`? | Can operate on `GovernanceRecordV1`? | Duplicates System A? | Conflicts with adaptive `automatedGovernance`? | Classification |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `low-consensus-flag` | `consensus_below`, threshold 50 | Enabled | `consensusSummary.overallConsensusScore` | No | Yes (`flag`) | **Yes — required** | No (score only) | No | No — no adaptive schema has a `ConsensusSummary` | Conceptually yes (both compare a consensus score to a threshold), different threshold values, different engines | No (System B doesn't touch `GovernanceRecordV1` at all today) | **UNSAFE_OR_AMBIGUOUS** — same root cause as §14's excluded consensus rule: no honest adaptive consensus score exists, and this one doesn't even have a null-safe path (`evaluatePolicies` would need a real `ConsensusSummary` object, not just a nullable number) |
| `low-model-health-flag` | `model_health`, threshold 4 | Enabled | `consensusSummary.modelsHealthy` | No | Yes (`flag`) | **Yes — required** (reads `modelsHealthy` off the `ConsensusSummary` object, not a standalone count) | No | No | Not directly — needs a `ConsensusSummary`-shaped wrapper, not just a raw count | Conceptually similar to `MODEL_FAILURES` (§18.3), different data shape | No | **ADAPTIVE_COMPATIBLE IN SPIRIT, UNSAFE AS WRITTEN** — the underlying signal (how many models succeeded) genuinely exists for adaptive runs (`CommonResponseMeta.successfulModels`), but this rule's actual implementation demands a full `ConsensusSummary` object (`researchConsensusSummary.ts`'s own shape) as its input, not a bare number — wiring it as-is would require either fabricating a fake `ConsensusSummary` (explicitly forbidden) or rewriting the rule, which is a real implementation, not an audit finding |
| `weak-evidence-review` | `evidence_quality` (no threshold) | **Disabled by default** | `consensusSummary.lowEvidenceClaims > 0` | No | Yes (`require_review`) | Yes | **Yes — explicitly claims-shaped** (`lowEvidenceClaims`) | No | No | Conceptually related to System A's own excluded evidence-quality rule (§14.3) — same root cause: no real adaptive evidence-quality signal exists | No | **LEGACY_CLAIMS_ONLY** |

**No rule in `policyEngine.ts` can run against adaptive data today without either fabricating a `ConsensusSummary` object or rewriting the rule's own input contract.** This is a stricter conclusion than §14's System-A findings, where 2 rules (source-completeness, model-failure) were directly portable — System B's rules are ALL gated behind the `ConsensusSummary` wrapper type itself, which has no adaptive equivalent at all (confirmed: no code anywhere constructs a `ConsensusSummary` from adaptive data — `researchConsensusSummary.ts`'s own `buildResearchConsensusSummary()` is dead code, per §16's earlier finding, still unused).

### 20.6 `teamRuns` write model — role analysis

**Verified: `teamRuns` is a hybrid — an audit copy AND the review-queue projection AND (uniquely, unlike a pure projection) the canonical location of the human decision itself**, since `humanDecision` exists NOWHERE else. This is the single most important fact for the adaptive-design question:

- Full claims are copied (`auditBundle.claims`, for research runs) — yes.
- Model results are NOT copied — `TeamRunAuditBundle`'s research shape carries only `models: Array<{modelId, status}>` (status only, no raw text) and `claims` (truncated summaries, `claimTruncated`), confirmed no full model output.
- Source data: not copied as a distinct field — whatever's embedded in `consensusSummary`/`auditBundle` only.
- Parent-run fields ARE snapshotted at write time (`consensusScore`, `consensusSummary`, `auditBundle`, `query`) — a POINT-IN-TIME COPY, not a live reference.
- **Later parent-run changes do NOT propagate to `teamRuns`** — confirmed no update path exists; `teamRuns` documents are write-once (create only) except for the single `humanDecision` field.
- `teamRuns` CAN become stale relative to the parent run in every sense except the one field (`humanDecision`) that only ever lives there.
- **Review decisions do NOT synchronize back to `runs/{runId}`** — confirmed, the decision route never touches the `runs` collection at all.
- Deleting a parent run does NOT delete `teamRuns` — no cascade delete found anywhere; `teamRuns` rows are fully independent documents once created.
- `teamRuns` CAN exist without a resolvable parent run — `runId`/`verificationId` on `TeamRunDocument` are optional, and nothing validates the referenced parent still exists at read time.
- **Duplicate `teamRuns` for one run/team pair CAN exist** — trivially, since `teamRunId` is generated fresh (`${teamId}-${uid}-${timestamp}-${random}`) on every single pipeline invocation with no dedup key derived from `runId` itself; if the SAME research run were somehow re-synthesized (e.g., cache miss + retry), a second, independent `teamRuns` document would be created for it.

**Evaluating the 4 adaptive-support options given this reality:**
1. *Extend `teamRuns` additively with a compact adaptive summary* — possible, but would perpetuate the existing staleness/no-parent-sync/duplicate-row problems for a NEW data shape, and would require deciding where the adaptive `humanReview` decision itself lives (in `teamRuns.humanDecision`, duplicating `GovernanceRecordV1.humanReview`? Or only in `governanceRecord`, leaving `teamRuns` purely descriptive? These are different answers with different consequences — see §20.9/§20.12).
2. *Reference `governanceRecord` without copying it* — cleanest for avoiding staleness, but `teamRuns`' OWN authorization model (team-admin-can-decide-any-team-run) would need to somehow gate a write to a DIFFERENT document (`runs/{runId}.governanceRecord`) that today has no per-team access control concept applied to it at all (adaptive runs today don't even check team membership for anything).
3. *Eliminate `teamRuns` for adaptive runs entirely* — most consistent with "governanceRecord.humanReview is canonical," but breaks the ONE thing that currently works for legacy runs today via `teamRuns`: the list/queue view and CSV export, unless those are rebuilt against `governanceRecord` directly.
4. *A new collection* — avoids polluting `teamRuns`' existing (claims-shaped) contract, at the cost of a third data location to keep consistent.

Per this step's explicit instruction, **no choice is made here** — see §20.12 for the recommendation, which leans on one additional fact only fully clear after this trace: **`teamRuns` today has NO UI consumer at all** (§20.1), so "the queue" is currently a backend-only concept — any adaptive design has more freedom here than it would if a live dashboard already depended on `teamRuns`' exact current shape.

### 20.7 Current review-write semantics — full trace

What happens, exactly, when a reviewer (team admin) submits a decision, verified line-by-line against `app/api/teams/runs/[runId]/decision/route.ts`:

- Updates **`teamRuns` only** — confirmed, `adminDb.collection("teamRuns").doc(runId).update({humanDecision})` is the ONLY write in the entire route.
- Does NOT update `runs/{runId}` in any way.
- Does NOT write flat review fields anywhere (that's System A's `/api/governance/review` pattern, a different route entirely — §14.1/§20.1).
- Does NOT touch `teamGovernance` (that's written only by `applyTeamGovernancePipeline`, at evaluation time, never at decision time).
- Does NOT touch `governanceRecord` (doesn't exist in this route's vocabulary at all — System B has zero adaptive awareness today).
- Does NOT write an `admin_audit_logs` entry.
- Does NOT write a `governanceEvents` entry (unlike System A's own review route, which writes both).
- **Replaces the prior comment (`notes`) and the prior "reviewer" (`decidedBy`) unconditionally** — no history retained (§20.3).
- Preserves nothing about prior decisions — the whole `humanDecision` object is replaced.
- No transaction — a single `.update()` call.
- No nested/dot-path update — `humanDecision` is written as one whole object in one field, which is fine today ONLY because nothing else on `teamRuns` is being concurrently written by a second actor (unlike `governanceRecord`, which now has two independent writers — Step 5C initialization/Step 6B automated evaluation on one side, humans on the other).
- **Can race with automated governance in a FUTURE adaptive design, but not today** — today's `teamRuns.humanDecision` write has no automated-governance counterpart writing to the SAME document at all, so there is no current race. The race only becomes real once/if an adaptive review write target overlaps with `governanceRecord` (see below).
- **Can race with another reviewer** — yes, confirmed: two admins submitting near-simultaneously would have last-write-wins on `humanDecision`, with no transaction or optimistic check preventing it. This is a real, currently-existing race condition in the CURRENT legacy feature, independent of adaptive integration.

**Direct answer to the explicit concern about a future adaptive review write:** IF a future adaptive review-decision route were built using the SAME pattern as `/api/teams/runs/{id}/decision` (a plain `.update({humanReview: ...})` against the WHOLE `governanceRecord.humanReview` object, not a narrower dot-path write), it would risk overwriting nothing about `automatedGovernance`/`decisionReceipt`/schema identity (since those live in SIBLING top-level fields of `governanceRecord`, and a `.update({"governanceRecord.humanReview": ...})` dot-path write — the SAME pattern already proven safe for `automatedGovernance` in Step 6B Part B/C, §18.9 — would touch ONLY that one nested field, exactly like the existing, tested `persistAutomatedGovernanceUpdate` does for its own field). The concurrency-safety PATTERN already exists and is already proven (§18.9's mandatory regression test); a future adaptive review-write function would need to follow the identical pattern (nested field-path update, never a whole-record write), not invent a new one.

### 20.8 UI and dashboard assumptions

**There is no team-governance dashboard to audit — confirmed in §20.1.** `GovernanceDashboard.tsx` (the only governance UI that exists) is exclusively System A's, and its assumptions (`runType: "research"|"verification"|"video"`, `governanceStatus`, `keyFindings`/`disagreementPoints`/`verificationVerdict`/`correctParts`/`incorrectParts`, all claims-matrix-shaped) are already fully documented against System A in §14 and remain unchanged — this dashboard has no path to ever display a `teamRuns` row or a `governanceRecord`, since it never queries either.

**The only System-B-derived UI surface that exists at all** is the `teamGovernance` snapshot banner in the legacy `ResultsDisplay.tsx` (§20.1/§20.6) — it reads `governanceReviewRequired`/`blockedByPolicy`/`policyFlags`/`policyBlockMessage` only, all already-generic-shaped string/boolean fields with no claims-matrix assumptions baked into the RENDERING itself (the values it displays happen to have been computed from claims-matrix data today, but the banner component itself would render fine given honest, differently-sourced values of the same shape). This banner is NOT rendered for adaptive runs today, for the same reason `teamGovernance` is never populated for them (Step 6's fix + the pre-existing fact that `applyTeamGovernancePipeline` was always downstream of legacy synthesis).

**Whether legacy-polluted adaptive runs could appear because of old `governanceStatus` data:** for System A's `GovernanceDashboard.tsx`, potentially yes IF an adaptive run was polluted before the Step 6 fix landed (§16) — such a run would carry a real (garbage) `governanceStatus` and WOULD appear in that dashboard's query results, indistinguishable from a genuine legacy research run, since the dashboard has no schema-awareness to filter it out. This is a real, already-flagged (§16) consequence of the pre-fix pollution window, not a new finding, but worth restating here since it's directly relevant to "which components would display something misleading."

**Since no `teamRuns`-consuming UI exists, "which components would crash on adaptive data" is not applicable for System B today** — there is nothing to crash. This significantly narrows the risk surface for any future adaptive teamRuns/dashboard work: a NEW UI would be built with adaptive data in mind from the start, not retrofitted onto assumptions an existing live UI depends on.

### 20.9 Mapping to `GovernanceRecordV1`

| System B concept | Maps to | Losslessly? |
|---|---|---|
| `TeamRunHumanDecision.action` (`approved`\|`rejected`\|`escalated`) | `GovernanceRecordV1.humanReview.status` (`unreviewed`\|`pending`\|`approved`\|`approved_with_conditions`\|`changes_requested`\|`rejected`) | **No.** `"escalated"` has no direct equivalent in the adaptive vocabulary — the closest analog is `"pending"` (a decision process is ongoing, not yet final) or a new value would be needed. `"approved_with_conditions"` has no System-B equivalent at all (§20.3). Mapping requires an explicit, documented decision, not an automatic one. |
| `TeamRunHumanDecision.notes` | `GovernanceRecordV1.humanReview.comment` | Yes, directly — both are a single free-text string, both already documented as "overwritten on re-review" in their respective systems |
| `TeamRunHumanDecision.decidedBy` / `.decidedAt` | `humanReview.reviewerId` / `.reviewedAt` | Yes, directly |
| Team-admin-can-decide-any-team-run | No direct equivalent | `GovernanceRecordV1` has no team/authorization concept at all today — any adaptive team-review design needs to ADD an authorization layer, not map an existing one |
| Approve-with-conditions | N/A in System B | **Requires a genuinely new capability in System B's decision route** if teams are to use it for adaptive runs — not just a mapping exercise |
| Reviewer identity trust | `decidedBy` is server-derived (`getRequestUid`), same guarantee `humanReview.reviewerId` would need | **Yes, directly reusable** — the identity-trust mechanism (never client-supplied) is already correct and portable |
| Team dashboard operating from a compact summary | N/A — no dashboard exists (§20.8) | A future dashboard COULD read a compact projection; nothing today constrains this either way |
| Canonical review state location | Currently `teamRuns.humanDecision` (System B) vs. `governanceRecord.humanReview` (adaptive, live via Step 5C/6B but currently only ever set to `"unreviewed"` — no write path for an actual human decision exists yet for adaptive runs either) | **Neither is canonical for adaptive team review today — nothing has been built yet.** This is the central open question §20.12 addresses. |
| What belongs in `teamRuns` (if extended) | A compact projection (schemaId, answerShape, humanReview.status, automatedGovernance.status, conclusion — NOT the full receipt, NOT sources) mirroring exactly the discipline already used for `AdaptiveDecisionReceipt`'s own construction (reshape, don't re-interpret, never invent) | Feasible, not yet built |

**Per this step's explicit instruction, no `reviewers[]`/threads/quorum design is proposed — Phase 2A remains single-reviewer, matching both System A and System B's current single-decision-field reality exactly.**

### 20.10 Concurrency design risks (for a FUTURE adaptive System B — none of this is live today)

| Race | Current System B exposure | Future adaptive exposure if built naively |
|---|---|---|
| 1. Reviewer submits while adaptive automated governance writes | N/A — no adaptive-aware review write exists yet | Real, but the SAME solved pattern applies: a reviewer write to `governanceRecord.humanReview` via nested field-path update (mirroring `persistAutomatedGovernanceUpdate`, §18.9) cannot collide with `automatedGovernance`'s own nested-field write, by construction — proven already, not a new problem |
| 2. Two reviewers submit simultaneously | **Real today, unaddressed** — confirmed no transaction/optimistic check in the current decision route | Same risk carries over unless a future adaptive decision route adds one; not solved by the nested-write pattern alone (that pattern only protects SIBLING fields from each other, not two writers of the SAME field) |
| 3. Reviewer acts on a stale `teamRuns`/list snapshot | Possible today (no re-fetch-before-decide enforced) | Same, if a future UI follows the same pattern |
| 4. Parent `governanceRecord` changes after a team-summary row is created | N/A today (`teamRuns` never references `governanceRecord`) | Real if Option 1 (§20.6) is chosen — a copied summary can go stale exactly like `teamRuns` already does relative to `runs/{runId}` today |
| 5. Re-review overwrites an earlier terminal decision | **Real today, unaddressed** (§20.3) | Would carry over unless explicitly fixed — `applyHumanReviewUpdate` (Phase 2A, already built) does NOT itself prevent this either; it updates whatever status it's given, it doesn't enforce "don't overwrite a terminal one" — that enforcement lives only in System A's OWN review route today (`reviewableStatuses` check), nowhere else |
| 6. Parent run deleted during review | No cascade-delete exists (§20.6) — an orphaned `teamRuns` row is already possible today | Same |
| 7. `teamRuns` (or a future adaptive summary) exists while `governanceRecord` is missing/malformed | Possible today for legacy (`runId` is optional, unvalidated) | Directly relevant — a future adaptive summary write would need to check `parseGovernanceRecord`'s result before trusting anything, exactly like Step 5C/6B's own initializer already does |

**Recommended minimum safe persistence strategy for a future adaptive human-review write (not implemented in this step): nested Firestore field-path update — `governanceRecord.humanReview` + `governanceRecord.updatedAt` only — the IDENTICAL pattern §18.9 already built and proved for `automatedGovernance`.** Not a transaction (same reasoning as §18.9: the write doesn't need to read-then-conditionally-write the SAME data being protected; it only needs to never touch sibling fields, which a field-path write already guarantees structurally). A transaction WOULD be warranted specifically to close race #2 (two reviewers) if that's judged worth fixing as part of adaptive integration — that is a real, separate design decision, not automatically implied by reusing the nested-write pattern.

**Guarantee the design must provide, restated precisely:** a review update must never overwrite `automatedGovernance`, `decisionReceipt`, `schemaId`/`answerShape` (schema identity), or `createdAt` — satisfied automatically by using the SAME nested-field-path convention already proven in §18.9, applied to `humanReview` instead of `automatedGovernance`.

### 20.11 Events and auditability

| Path | `governanceEvents`? | `admin_audit_logs`? | Team-specific audit record? |
|---|---|---|---|
| System A automated evaluation (`evaluateAndStoreGovernance`) | Yes | Yes | N/A |
| System A human review (`/api/governance/review`) | Yes | Yes | N/A |
| Adaptive automated governance (Step 6B) | Yes (`writeAdaptiveGovernanceEvent`, §18a) | **No — deferred** (§18.10) | N/A |
| **System B policy evaluation (`applyTeamGovernancePipeline`)** | **No** | **No** | **No — the `teamRuns` document itself IS the only audit record** (plus its later CSV export) |
| **System B human decision (`/api/teams/runs/{id}/decision`)** | **No** | **No** | **No — confirmed, the route's only side effect is the single `.update({humanDecision})` call** |

**System B has NO event/audit trail beyond the `teamRuns` document's own current state** — no subcollection, no append-only log, no prior-state/new-state record anywhere for either policy evaluation or the human decision. This is a materially thinner audit story than either System A (both automated and human paths write to 2 places) or adaptive automated governance (writes to 1, `admin_audit_logs` deferred deliberately). **A future adaptive team-review write should, at minimum, match adaptive automated governance's own existing precedent** — a `governanceEvents` entry (genuinely schema-agnostic, §18.10) — rather than matching System B's own current, thinner precedent of no event at all. This is a recommendation for §20.12, not something decided by mere consistency with either existing pattern automatically.

### 20.12 Recommended Phase 2A boundary for adaptive System B integration

**Directly answering the question posed: `runs/{runId}.governanceRecord.humanReview` should become the canonical adaptive review state; `teamRuns` (if extended for adaptive runs at all) should remain a queue projection, never a second canonical location for the decision itself.** This is the only choice consistent with everything verified above:
- `governanceRecord` already has a real, live, schema-aware `humanReview` field, with a validated parser, an immutability-tested pure update helper, and (as of Step 6B) a PROVEN-SAFE nested-write pattern sitting right next to it (`automatedGovernance`) — reusing the SAME field and the SAME write mechanism for the human decision is a direct, low-risk extension of work already done and tested.
- `teamRuns` today is NOT canonical for anything except by historical accident (§20.6) — nothing reads its `humanDecision` except a list filter and a CSV export, and NO UI exists that depends on `teamRuns` being the source of truth (§20.1/§20.8). There is no live behavior to preserve by keeping it canonical.
- Making `teamRuns` a pure projection (Option 2, §20.6 — reference, don't copy the decision) avoids reintroducing the exact staleness/no-parent-sync problem already documented as System B's own current weakness (§20.6), for a brand-new adaptive data shape.

**Recommended narrow scope, addressing each required point:**
- **Canonical review state:** `governanceRecord.humanReview`, written via a NEW nested field-path persistence function mirroring `persistAutomatedGovernanceUpdate` exactly (`governanceRecord.humanReview` + `governanceRecord.updatedAt` only).
- **`teamRuns` adaptive summary:** additive only — a compact projection (schemaId, answerShape, `humanReview.status`, `automatedGovernance.status`, receipt `conclusion` only — never sources, never full receipt arrays) written ONCE at the same point `GovernanceRecordV1` is initialized (Step 5C), analogous to how `applyTeamGovernancePipeline` writes a fresh `teamRuns` row today — but this is a NEW write path, not a repurposing of `applyTeamGovernancePipeline` itself (which stays legacy-only, untouched, exactly like `evaluateGovernance.ts`).
- **Status mapping:** requires an explicit decision, not an automatic 1:1 map — `"escalated"` and `"approved_with_conditions"` don't correspond; recommend treating adaptive team review as using `GovernanceRecordV1.humanReview`'s OWN existing 6-value vocabulary directly (not System B's 3-value one), since the adaptive contract is richer and already built/tested — i.e., don't import System B's narrower vocabulary into the adaptive path; extend team-admin authorization to decide using the vocabulary that already exists.
- **Reviewer identity:** reuse `teamApiAuth.ts`'s existing, correct, server-derived-uid pattern directly — no changes needed to how identity is established, only to what document the decision is written into.
- **Comment behavior:** reuse `humanReview.comment`, single flat field, overwritten on re-review — already the exact behavior `applyHumanReviewUpdate` implements today.
- **Nested-write/transaction strategy:** nested field-path update for the SIBLING-field-safety guarantee (mandatory, per §20.10); a transaction is a SEPARATE, optional decision only needed if double-reviewer races (§20.10 race #2) are judged worth closing in this pass.
- **Dashboard list requirements:** none exist to preserve (§20.1/§20.8) — a future list view can be designed fresh against the compact `teamRuns` projection above, with no legacy UI constraint.
- **Review-detail requirements:** same — nothing to preserve.
- **Audit-event behavior:** recommend a `governanceEvents` entry on decision (matching adaptive automated governance's own precedent, §18a), explicitly NOT `admin_audit_logs` (same deferral reasoning as §18.10 — no honest `runType`/`question` fields exist for adaptive data without a contract change).
- **Backward compatibility:** System B's existing legacy pipeline (`applyTeamGovernancePipeline`, the decision route, the list/export routes) stays completely untouched, exactly as `evaluateGovernance.ts` and its callers stayed untouched through Steps 6/6B.
- **Migration needs:** none required — this is a net-new, additive path; no existing `teamRuns` rows need to change shape.
- **Malformed-record handling:** any future adaptive review-write function must call `parseGovernanceRecord` first and refuse to write against anything other than `"valid"`, mirroring Step 5C/6B's own established discipline exactly (never treat a parse failure as safe to proceed).
- **Missing-parent handling:** must fail closed (mirroring Step 6's own post-review correction, §16a) — a missing `runs/{runId}` document must never silently be treated as "safe to write," using `.update()` (not `.set()`) so a missing document errors rather than being created, exactly like `persistAutomatedGovernanceUpdate` already does.

**Explicitly deferred, per instruction:** multiple reviewers, comment threads, review-history UI, quorum, supersession chains, export, and any destructive migration of existing legacy `teamRuns` data.

### 20.13 Corrections to prior summaries in this engagement

1. `TeamRunHumanDecision` was previously described as "likely aspirational/unused... no confirmed live write site." **This was wrong** — `app/api/teams/runs/[runId]/decision/route.ts` is a real, live writer, confirmed by direct code inspection.
2. No prior summary in this engagement had traced that `teamRuns` has zero UI consumers at all, or that `GovernanceDashboard.tsx` is exclusively System A's. Both are now confirmed directly.
3. No prior summary distinguished System A's individual assigner↔reviewer mechanism (`governanceReviewerFor`/`governanceReviewerUid`) from System B's team-admin-role mechanism as two entirely separate authorization systems — they are.

### 20.14 Blockers found

**No blocker prevents Step 7 Part B (adaptive System B design) from proceeding** — but two considerations should shape that design directly:
1. Because `teamRuns` has no live UI consumer, Part B has more design freedom than initially assumed — it is not constrained by an existing dashboard's exact data shape.
2. Because System B's CURRENT decision route has two real, pre-existing safety gaps unrelated to adaptive integration (no terminal-state protection, no double-reviewer protection, §20.3/§20.10) — a decision for Part B to make explicitly is whether an adaptive-aware review path should ALSO leave these gaps unaddressed (matching legacy behavior exactly, lowest-risk/narrowest-scope) or close them for the new path only (a real, separate scope increase beyond "map existing System B into GovernanceRecordV1"). Recommend the former (match legacy exactly) unless explicitly directed otherwise, consistent with this whole engagement's repeated pattern of narrow, additive, non-legacy-modifying steps.

## 21. Step 7, Part B — adaptive team-review design (design only, no code changed, 2026-07-30)

Design document only, per instruction. Two facts were re-verified against actual source before writing this (not assumed): `adminDb.runTransaction(...)` is an EXISTING, proven pattern in this codebase (`lib/stripe/usageCheck.ts`, `lib/security/rateLimit.ts`, `app/api/verify-video/route.ts`) — unlike the nested-field-path `.update()` pattern, which WAS new when Step 6B introduced it — so this design treats transactions as a known, safe tool, not a novel technique. Second: `applyHumanReviewUpdate` (Step 4) validates the SHAPE of a new update but does **not** check whether the CURRENT status is terminal before applying it — so terminal-state enforcement must be added as a NEW check in this design, not assumed to already exist inside that helper.

**The non-negotiable choice, confirmed:** `runs/{runId}.governanceRecord.humanReview` is canonical. `teamRuns` (extended additively) is a projection only — a review write NEVER completes by writing `teamRuns` alone, and a projection-sync failure never rolls back or blocks the canonical decision.

### 21.1 Adaptive team-review projection contract

Continues using the EXISTING `teamRuns` collection additively — verified safe rather than assumed: Firestore itself is schemaless per-document, and the only code that reads the collection with any structural expectation (`/api/teams/runs/route.ts`'s `TeamRunListRow`) already uses a permissive `[key: string]: unknown` index signature (confirmed by re-reading it in §20), so a differently-shaped adaptive row coexisting in the same collection cannot break anything that reads it today. A new collection is not warranted.

```ts
export interface AdaptiveTeamRunProjection {
  projectionVersion: 1;
  id: string; // same value as the deterministic document ID (§21.2), duplicated as a field for read convenience, matching TeamRunDocument's own existing id-duplication precedent

  teamId: string;
  userId: string; // the adaptive run's owner uid, snapshotted at creation — never re-derived live, matching teamRuns' own existing snapshot precedent (§20.6)
  runId: string;

  adaptive: true; // the discriminator

  schemaId: PersistedAdaptiveSchemaId;
  answerShape: AnswerShape;

  receiptConclusion: string; // decisionReceipt.conclusion only — never basis/assumptions/uncertainties/limitations/sources
  sourceBacked: boolean;
  humanReviewNeeded: boolean;

  automatedGovernanceStatus?: "passed" | "flagged" | "blocked" | "not_evaluated" | "error";

  humanReviewStatus: "unreviewed" | "pending" | "approved" | "approved_with_conditions" | "changes_requested" | "rejected";
  reviewedAt?: string; // mirrors governanceRecord.humanReview.reviewedAt, synced only, never written directly by the review route (§21.9)

  createdAt: string; // ISO string, matching every other timestamp convention in this contract (governanceRecord.createdAt/updatedAt, PersistedAdaptiveOutputV1.generatedAt) — never a raw Firestore Timestamp
  updatedAt: string;
}
```

**Deliberately NOT copied**, per instruction and consistent with every prior "reshape, don't re-interpret" decision in this document (§6b, §18.3): full `decisionReceipt` (only `conclusion` is copied), `sources`, `assumptions`, `uncertainties`, `limitations`, raw model output, `ConsensusSummary`, `auditBundle`, `claims`. Question text is NOT copied — the existing `teamRuns.query` field exists for legacy rows because `TeamRunAuditBundle`/list filtering needed it; nothing in the adaptive list/review flow designed here needs question text, so it stays out, tightening scope rather than matching legacy's own broader copy.

### 21.2 Projection identity and deduplication

**Deterministic ID: `${teamId}:${runId}`** — one projection per team/run pair, by construction. Both components are themselves already Firestore document IDs elsewhere in this codebase (`teams/{teamId}`, `runs/{runId}`, the latter always formatted `run-${uuid}`, confirmed no colons or slashes ever appear in either), so `:` is a safe, unambiguous separator and the composite string is a valid Firestore document ID (no `/`, no leading/trailing `.`, under the length limit).

**Write strategy: create-if-absent, plain `.get()` + `.set()`, no transaction.** Considered a transaction here and rejected: the only actor that will ever create this projection is the SAME server-side lifecycle step that already decided (via Step 6B's own "does `automatedGovernance` already exist" gate, §18.8) not to redundantly re-run automated evaluation — there is no genuine concurrent-creator scenario to protect against, unlike the human-review WRITE (§21.7), which real concurrent reviewers can race on. A `.get()` check for existing content, followed by a `.set()` (full, non-merge write) only when absent, is sufficient and simpler. Even in the pathological case of two near-simultaneous creation attempts for the same run (e.g. a retried request), the content each would compute is DETERMINISTIC from the same `governanceRecord` snapshot at that moment, so a benign double-write of IDENTICAL content is the worst case — not a real correctness risk, unlike legacy `teamRuns`' own random-ID scheme, which produces genuine duplicate rows with no way to detect or prevent them (§20.6).

**Existing legacy `teamRuns` IDs are untouched** — the deterministic scheme applies ONLY to NEW adaptive rows; nothing about legacy row IDs (`${teamId}-${uid}-${timestamp}-${random}`) changes, and the two ID schemes cannot collide (the adaptive scheme's `:` separator never appears in the legacy scheme's `-`-joined format). No migration of existing rows is required or performed.

### 21.3 When an adaptive run enters team review

**No suitable existing `TeamDocument`/`TeamSettings` field exists** — confirmed by re-reading `teamTypes.ts` (§20.2): `TeamSettings` has only `minimumConsensusForAction`/`flagThreshold`, both consensus-shaped and meaningless for adaptive data. A new, additive field is required:

```ts
// Added to TeamDocument, a NEW top-level field — deliberately not nested
// inside the existing `settings` object, since minimumConsensusForAction/
// flagThreshold are a conceptually different axis (consensus thresholds)
// from "does this team want adaptive runs routed to review at all."
adaptiveReviewSettings?: {
  enabled: boolean;
  mode: "flagged_only" | "human_review_needed" | "all";
};
```

**Default for existing teams: disabled (field absent → treated as `enabled: false`).** The more permissive alternative ("enabled only for runs already marked `humanReviewNeeded` or flagged") was considered and rejected as the DEFAULT — it would silently start creating new Firestore documents and (once Part D lands) surfacing new review obligations for every existing team the moment this ships, with no team having explicitly opted in. Per the instruction's own "do not silently enroll every team," disabled-by-default is the only choice that doesn't do that. A team can opt in via a future settings UI/endpoint (not built in this design — team CRUD/settings routes were out of this step's audit scope and are unaffected).

**Entry criteria (evaluated only when `adaptiveReviewSettings.enabled === true`):**
| Team mode | Projection created when |
|---|---|
| `"flagged_only"` | `automatedGovernance.status === "flagged"` or `"blocked"` |
| `"human_review_needed"` | `decisionReceipt.humanReviewNeeded === true` (regardless of automated status) |
| `"all"` | Always, once `automatedGovernance` is available (§21.12) |

Uses only real, already-computed fields — `humanReviewNeeded` (preserved verbatim from `CommonResponseMeta`, §2) and `automatedGovernance.status` (Step 6B, live). No `ConsensusSummary`, no claim disagreement, no legacy `policyFlags`, no legacy `runType`, and `applyTeamGovernancePipeline()`/`policyEngine.ts` are never called for adaptive runs — confirmed as a hard requirement, not merely a preference, since §20.5 already established every legacy rule requires a `ConsensusSummary` object no adaptive schema produces.

### 21.4 Canonical human-review contract and status state machine

`GovernanceRecordV1.humanReview`'s existing 6-value vocabulary is used directly and exclusively — `unreviewed | pending | approved | approved_with_conditions | changes_requested | rejected`. System B's narrower legacy vocabulary (`approved | rejected | escalated`) is NOT imported into the adaptive path; the two remain permanently distinct, matching how `GovernanceRecordV1.automatedGovernance`'s status vocabulary was already kept deliberately distinct from both System A's and System B's own (§16a's design note, restated here for the human-review side).

**Transition table (implemented as a NEW, small pure predicate — not by extending `applyHumanReviewUpdate` itself, which stays a pure shape-validator with no knowledge of "from" state):**

```ts
export function isHumanReviewStatusReviewable(status: GovernanceRecordV1["humanReview"]["status"]): boolean {
  return status === "unreviewed" || status === "pending";
}
```

| From | Allowed to |
|---|---|
| `unreviewed` | `pending`, `approved`, `approved_with_conditions`, `changes_requested`, `rejected` |
| `pending` | `approved`, `approved_with_conditions`, `changes_requested`, `rejected` |
| `approved` / `approved_with_conditions` / `changes_requested` / `rejected` | **none — terminal** |

This reuses the IDENTICAL terminal/non-terminal classification `canRefreshDecisionReceipt` (Step 4) already established for a DIFFERENT question (whether the decision receipt may be regenerated) — the same 2-vs-4 split, for a good reason: both questions share the same underlying fact ("has a substantive human decision been made about this run yet?"). `isHumanReviewStatusReviewable` is defined as its own, separately-named function rather than reusing `canRefreshDecisionReceipt` directly, since the two answer conceptually different questions that happen to share a classification today — conflating their names would make a future change to one silently affect the other's meaning.

**Terminal states are actually terminal in this design** (unlike System B's legacy route, §20.3) — enforced inside the transaction (§21.7), not left to the caller's discipline. **Re-review requires a future, explicit reopen/version operation, not built in this step** — attempting to submit a decision against a terminal record fails with a dedicated, honest error (`"terminal_review_exists"`), never silently overwritten.

### 21.5 Review request contract

```
POST /api/teams/adaptive-runs/{runId}/decision
```

`{runId}` in the path is the REAL panel `runId` (`runs/{runId}`) — deliberately NOT the projection's own document ID, to avoid reproducing the exact naming ambiguity flagged in §20.1 (legacy's route param is literally named `runId` but is actually the `teamRuns` document ID). The server derives the deterministic projection ID (`${callerTeamId}:${runId}`) internally, from the CALLER's own resolved team — never from a client-supplied projection ID or team ID.

```ts
export type AdaptiveReviewDecisionRequest = {
  status: "approved" | "approved_with_conditions" | "changes_requested" | "rejected"; // "pending" deliberately excluded — see below
  comment?: string;
  conditions?: string[];
  expectedUpdatedAt: string; // optimistic-concurrency token — see §21.7
};
```

**Never accepted from the client:** `reviewerId`, `reviewerName`, `teamId`, `userId`, `automatedGovernance`, `decisionReceipt`, `schemaId`, `answerShape` — all either server-derived (identity, team) or read-only canonical data the review route only ever reads, never writes.

**`"pending"` is intentionally excluded from this route's accepted status values** — submitting "pending" isn't a terminal decision at all; per the instruction ("Do not allow the caller to set pending through the terminal-decision route. A separate assignment/start-review action can set pending later if needed"), that would be a DIFFERENT, not-yet-designed action (e.g., "claim this run for review"), out of scope here.

**`expectedUpdatedAt` reuses the EXISTING `governanceRecord.updatedAt` field as the optimistic-concurrency token, rather than inventing a separate numeric revision counter.** This field already changes on every write to the record (Step 5B/6B's own `applyAutomatedGovernanceUpdate`/`persistAutomatedGovernanceUpdate` already maintain it), so it is already a real, live "last-modified" marker — reusing it avoids adding a redundant, easy-to-forget-to-bump revision field, at the cost of the token being a timestamp rather than a monotonically-simpler integer (functionally equivalent for this purpose: the client must supply the exact value it last observed, and a mismatch means something changed underneath it).

### 21.6 Authorization model

Reuses the verified System B mechanism exactly (§20.4), extended with the deterministic-ID lookup:

1. Authenticate (`getRequestUid`-equivalent).
2. `loadUserAndTeam(uid)` → caller's own team, server-derived, never client-supplied.
3. Require `isTeamAdmin(role)` — same bar as legacy System B; **no per-run reviewer assignment exists yet, explicitly deferred**, matching legacy's own current behavior (any team admin may review any team run) rather than inventing a finer-grained model unasked-for.
4. Load the adaptive projection at `${callerTeamId}:${runId}` — **this lookup itself is the primary tenant-isolation mechanism**: if the run belongs to a different team, the deterministic ID for THAT team's projection is a different document entirely, so this document simply won't exist for the caller's team, and the route returns `404`/`not_found` — no separate "confirm projection.teamId === caller team" branch is even reachable via a wrong ID, though the stored `teamId` field is still compared defensively (belt-and-suspenders against a hypothetical future bug in ID construction, not a load-bearing check on its own).
5. Load the parent `runs/{runId}` document. If the run owner's CURRENT team differs from the projection's snapshotted `teamId` (e.g. the owner left the team after the projection was created), this is logged as an informational mismatch but **does not block the review** — the review concerns work done while the run's owner was on the team, and revoking reviewability retroactively would be a stricter, unrequested policy; this mirrors System A's own established leniency for old runs without a `userId` field (§14.1, "allowing access... but log it for monitoring").
6. `parseGovernanceRecord(runData.governanceRecord)` — only a `"valid"` result proceeds; anything else fails per §21.8's fail-closed table.
7. Only then, review (§21.7).

### 21.7 Concurrency-safe human-review write

**Two separate, verified-distinct requirements, per the instruction: (a) never overwrite sibling `governanceRecord` fields, (b) prevent two reviewers from silently overwriting each other.** Nested field paths alone solve (a) but not (b) — a plain `.update({"governanceRecord.humanReview": ...})` still has no protection against two concurrent callers both reading the same "reviewable" state and both writing, each unaware of the other. This requires a real Firestore transaction — confirmed a safe, already-proven tool in this codebase (not novel, unlike §18.9's nested-path pattern).

```ts
export async function submitAdaptiveHumanReview(args: {
  runId: string;
  update: HumanReviewUpdate; // Step 4's existing type — status/comment/conditions, NOT reviewerId/reviewerName (those come from args below)
  reviewerId: string; // server-derived, never client-supplied
  reviewerName?: string; // from the caller's own trusted profile, never client body
  expectedUpdatedAt: string;
  now?: string;
}): Promise<SubmitAdaptiveHumanReviewResult> // result union, see below
```

**Transaction body, exactly per the instruction's recommended shape:**
```
adminDb.runTransaction(async (txn) => {
  1. read runs/{runId} via txn.get(ref)
  2. if !exists → return { ok: false, reason: "run_missing" }
  3. parse governanceRecord via parseGovernanceRecord — 
     absent → "governance_record_absent"
     malformed → "governance_record_malformed"
     unsupported_version → "unsupported_version"
  4. if record.updatedAt !== expectedUpdatedAt → return { ok: false, reason: "stale_expected_updated_at" }
     (checked BEFORE the reviewable-status check, so a stale-data error is
     never masked by a terminal-status error the caller's own UI hasn't
     even seen yet)
  5. if !isHumanReviewStatusReviewable(record.humanReview.status) →
     return { ok: false, reason: "terminal_review_exists" }
  6. build the update via applyHumanReviewUpdate(record, {..args.update,
     reviewerId: args.reviewerId, reviewerName: args.reviewerName}, now)
     — if it returns ok:false, return { ok: false, reason: update.reason }
     (invalid_status / invalid_fields / invalid_timestamp / conditions_required)
  7. txn.update(ref, {
       "governanceRecord.humanReview": updatedRecord.humanReview,
       "governanceRecord.updatedAt": now,
     })
     — NEVER governanceRecord.automatedGovernance, .decisionReceipt,
     .schemaId, .answerShape, .adaptiveOutputVersion, .createdAt — none of
     these are read into the update payload at all, so there is nothing to
     accidentally include
  8. return { ok: true, record: updatedRecord }
})
```

**`txn.update()` supports the identical dot-notation nested field paths as a plain `.update()` call** (same underlying Admin SDK mechanism) — this is how requirements (a) and (b) are satisfied TOGETHER in one write: the transaction (via Firestore's optimistic-locking-under-the-hood for transactions, retrying automatically on conflicting concurrent writes to the read set) prevents two reviewers from both winning unnoticed, while the nested paths inside that same transaction prevent the write from ever touching sibling fields, exactly like §18.9's already-proven pattern for `automatedGovernance`.

**Complete required failure-outcome set, all as typed result-union variants, never a thrown exception:** `run_missing`, `governance_record_absent`, `governance_record_malformed`, `unsupported_version`, `terminal_review_exists`, `stale_expected_updated_at`, `unauthorized` (surfaced by the route layer, before the transaction even starts — §21.6), `invalid_status` / `invalid_fields` / `invalid_timestamp` / `conditions_required` (from `applyHumanReviewUpdate`, passed through), `write_failed` (the transaction itself throwing — caught at the route layer, never propagated raw).

**`persistGovernanceRecord()` (Step 5B's whole-record write) and `.set(..., {merge:true})` against the whole `governanceRecord` object are never used here** — confirmed as a hard requirement matching Step 6B's own established rule for `automatedGovernance` (§18.9), now extended to `humanReview` for the identical reason.

### 21.8 Malformed and missing data — fail-closed table

| Condition | Behavior |
|---|---|
| Missing parent run | Reject (`run_missing`) |
| Missing `governanceRecord` | Reject (`governance_record_absent`) |
| Malformed `governanceRecord` | Reject (`governance_record_malformed`) — never treated as safe to proceed, matching §16a's own "malformed is not proof of legacy/absent" principle, restated here for review |
| Unsupported governance version | Reject (`unsupported_version`) |
| Missing adaptive projection | Reject (`projection_missing`) — this design does NOT support rebuilding a projection inline during a review request; the projection must already exist (created per §21.12's lifecycle), since a review route silently creating a projection would blur "projection is a byproduct of eligibility routing" with "projection is created on demand," a distinction worth keeping clean |
| Projection points to another team | Structurally unreachable via the deterministic ID (§21.6) — not a runtime check, a property of the ID scheme |
| Stale projection (projection's `humanReviewStatus` lags the parent) | Parent `governanceRecord` remains authoritative always — the projection is repaired opportunistically (§21.9), never trusted as a decision source by the review route itself, which reads ONLY the parent |
| Projection status differs from parent at read time | Trust parent; log the discrepancy for later repair, never block or reject on this basis alone |

**Never creates a bare parent document** — every write here is `.update()`/`txn.update()` against an ALREADY-EXISTING `runs/{runId}` document (confirmed to exist via the transaction's own read in step 1-2 above), never `.set()`, matching Step 6's own post-review fail-closed correction (§16a) precisely.

### 21.9 Projection synchronization

**After the canonical transaction (§21.7) succeeds — never before, never as part of the same transaction** (deliberately decoupled, so a projection-sync problem can never affect the canonical decision's own success):

```
await adminDb.collection("teamRuns").doc(`${teamId}:${runId}`).update({
  humanReviewStatus: updatedRecord.humanReview.status,
  reviewedAt: updatedRecord.humanReview.reviewedAt,
  updatedAt: now,
});
```

Only `humanReviewStatus`/`reviewedAt`/`updatedAt` are written — **the full comment and conditions are NOT stored in `teamRuns`**, per instruction; they remain canonical only in `governanceRecord.humanReview`. If a future list/export view genuinely needs to show the comment, it should read the parent record directly (already possible, since `runId` is on the projection) rather than duplicating mutable content into a second location.

**If this update fails after the canonical review already succeeded: do not roll back, return success to the caller, log the sync failure (metadata only — `runId`, `teamId`, the fact that sync failed — never the comment/conditions), and leave repair for later.** A repair mechanism (re-deriving the projection's review fields from the canonical record on next read, or a small background reconciliation job) is a genuinely useful follow-up but is NOT designed in this step — noted as an open question (§21.20) rather than silently assumed unnecessary. This asymmetry (canonical write is transactional and strict; projection write is best-effort and forgiving) is the direct, intended consequence of "`teamRuns` must never become a second source of truth" — a system that required BOTH writes to succeed would make `teamRuns` load-bearing again by accident.

### 21.10 Governance event

Emitted once, after the canonical transaction succeeds (mirroring adaptive automated governance's own event-after-persistence-success ordering, §18b), via the SAME generic `governanceEvents` subcollection and shape System A's own review route and Step 6B's automated evaluation both already use:

```ts
await adminDb.collection("runs").doc(runId).collection("governanceEvents").add({
  action: "human_review_decided", // a new, distinct action value — not "evaluated" (reserved for automated evaluation), so the two are distinguishable in the same subcollection
  byUid: reviewerId,
  at: now,
  teamId,
  schemaId,
  answerShape,
  prevStatus: /* the humanReview.status read inside the transaction, before this decision */,
  nextStatus: updatedRecord.humanReview.status,
});
```

**Reviewer uid is included — decided as acceptable, not a new privacy exposure**, since System A's own existing review route already writes `byUid`/`byEmail` into this exact same generic event shape (confirmed directly in §20.11/§14) — this design follows that established precedent rather than inventing a stricter or looser one. **Never included:** question text, receipt conclusion, source strings, comment text, conditions text, raw model output — matching every prior "safe reasons/events" rule in this document (§4.5, §16a, §18.10).

**`admin_audit_logs` is NOT written in Phase 2A** — for the identical reason Step 6B deferred it for automated governance (§18.10): `writeAuditEvent`'s real call shape requires `runType`/`question`/`consensusScore`, none of which have honest adaptive equivalents without a contract change, and inventing placeholder values for them is against this engagement's standing rule. This explicitly does NOT copy System B's own current "no event at all" behavior (§20.11) — the instruction is clear that legacy's THIN audit trail is a weakness to avoid reproducing in new code, not a precedent to match; `governanceEvents` coverage is added specifically because it's honestly achievable, while `admin_audit_logs` is deferred specifically because it is not (without a scope-expanding contract change) — two different reasons producing two different decisions, not a blanket "match legacy" or "improve on legacy" rule.

### 21.11 Team policy strategy (routing, not evaluation)

`policyEngine.ts`/`evaluateAndStore`/`applyTeamGovernancePipeline` are never modified and never called for adaptive runs — confirmed as a hard constraint, not a preference, since §20.5 already established zero legacy team-policy rules can run against adaptive data without fabricating a `ConsensusSummary`. A new, separate, pure routing function replaces the ROLE those rules play for the eligibility QUESTION only (not the review-decision question, which is §21.4-21.7's job):

```ts
export interface AdaptiveTeamReviewRoutingInput {
  humanReviewNeeded: boolean;
  automatedGovernanceStatus?: "passed" | "flagged" | "blocked" | "not_evaluated" | "error";
  teamAdaptiveReviewSettings: { enabled: boolean; mode: "flagged_only" | "human_review_needed" | "all" };
}

export type AdaptiveTeamReviewRoutingResult = {
  shouldCreateProjection: boolean;
  reason: "disabled" | "flagged" | "human_review_needed" | "all_runs" | "not_eligible";
};

export function routeAdaptiveTeamReview(input: AdaptiveTeamReviewRoutingInput): AdaptiveTeamReviewRoutingResult {
  if (!input.teamAdaptiveReviewSettings.enabled) return { shouldCreateProjection: false, reason: "disabled" };
  const { mode } = input.teamAdaptiveReviewSettings;
  if (mode === "all") return { shouldCreateProjection: true, reason: "all_runs" };
  if (mode === "flagged_only") {
    const flagged = input.automatedGovernanceStatus === "flagged" || input.automatedGovernanceStatus === "blocked";
    return flagged ? { shouldCreateProjection: true, reason: "flagged" } : { shouldCreateProjection: false, reason: "not_eligible" };
  }
  // mode === "human_review_needed"
  return input.humanReviewNeeded
    ? { shouldCreateProjection: true, reason: "human_review_needed" }
    : { shouldCreateProjection: false, reason: "not_eligible" };
}
```

Pure, synchronous, zero model/classifier/network/Firestore calls, zero claims data, zero dependency on `policyEngine.ts` — matching every other pure-evaluator convention already established in this document (§18's `evaluateAdaptiveGovernance`).

### 21.12 Projection creation lifecycle

Recommended insertion point: `app/api/run-panel/route.ts`, immediately AFTER Step 6B's automated-governance block completes (§18b) — same request, same lifecycle chain, same "never rerun models/classification/quota/tokens" guarantee already established there.

| Question | Resolution |
|---|---|
| Should projection creation wait for automated governance? | **Yes** — `"flagged_only"` mode is meaningless before `automatedGovernance` exists, and creating a projection before it's known whether the run is even eligible risks creating one for a run that turns out not to qualify under any team mode |
| Should `humanReviewNeeded` alone be sufficient before automated evaluation? | No — kept simple: ALL modes evaluate after automated governance is available (or definitively skipped), never as a separate earlier branch, avoiding two different insertion points for the same feature |
| What happens if automated-governance persistence failed? | The team-review routing step does not run at all — mirrors Step 6B's own principle that a persistence failure yields `automatedGovernanceStatus: "error"`, and an "error" status is not one of the routing function's eligibility triggers (`"flagged_only"` checks for `"flagged"`/`"blocked"` specifically, not `"error"`) |
| Should projection creation occur when status is `not_evaluated`? | Only under `"all"` mode (per the routing function above) — `"flagged_only"` correctly excludes it, since `"not_evaluated"` is not `"flagged"`/`"blocked"` |
| Should `blocked` and `flagged` both create projections under `"flagged_only"`? | Yes — both represent "something worth a human look," per the routing function above |
| Should already-reviewed records create projections? | Only if a projection doesn't already exist (create-if-absent, §21.2) AND the team's routing criteria are met at that moment — this can only realistically happen if a team enables adaptive review AFTER some runs already have terminal `humanReview` (there is no scheduled re-check of past runs in this design; this would only fire the NEXT time §21.12's insertion point runs for that run, which for a past run means never, unless a future backfill job is built — noted as an open question, §21.20, not solved here) |

Full creation-decision table, combining routing eligibility with the create-if-absent check:

| Scenario | Projection created? |
|---|---|
| Team `adaptiveReviewSettings.enabled === false` (or absent) | No |
| Team enabled, routing says not eligible | No |
| Team enabled, routing says eligible, `governanceRecord` malformed/absent | No — never created against unverified/missing data |
| Team enabled, routing says eligible, projection already exists | No new write (existing projection is left untouched by THIS step — review-sync, §21.9, is the only thing that updates an existing projection) |
| Team enabled, routing says eligible, no projection exists, `governanceRecord` valid | **Yes** |

### 21.13 List/read contract

`GET /api/teams/runs` is extended (not replaced) to also query and return adaptive projections from the SAME `teamRuns` collection, tagged with an explicit discriminator — never a mixed, untagged shape:

```ts
export type TeamRunListItem =
  | ({ kind: "legacy" } & TeamRunDocument)
  | ({ kind: "adaptive" } & AdaptiveTeamRunProjection);
```

Because NO UI consumes this route today (§20.1/§20.8), this additive-union approach carries none of the "will this break an existing screen" risk it would in a codebase with a live consumer — confirmed, not assumed, per the audit. **Full `governanceRecord` is never returned from the list endpoint** — only the already-compact `AdaptiveTeamRunProjection` fields, which by construction never carry the full receipt, sources, or raw content (§21.1). A future review-DETAIL endpoint (not designed in this step) would be the place to read the parent `governanceRecord` directly for the small subset of additional fields a reviewer might need to see (e.g. the full basis/uncertainties, not just the conclusion) — reading the canonical record directly there, never duplicating more of it into the projection.

### 21.14 Export decision

**Legacy `audit-export` stays completely unchanged.** Adaptive projections are excluded from it in this step — not silently flattened into legacy claim columns (explicitly forbidden by instruction), and not included via a hastily-added adaptive column set either, since a real CSV export contract for adaptive rows (what columns, what's safe to include given comment/conditions live only on the canonical record) is a genuine design decision on its own, deferred to a future, deliberate export step. If adaptive rows happen to appear in the SAME `teamRuns` collection the export route queries, the export route's own existing column-selection logic (which reads specific named legacy fields) would simply produce blank/absent values for those columns on an adaptive row rather than crashing — acceptable for now, but worth an explicit follow-up decision (§21.20) rather than treating today's incidental non-crash as a designed behavior.

### 21.15 Migration and backward compatibility

No migration required — this entire design is additive. Confirmed unchanged, explicitly, by design: `applyTeamGovernancePipeline()`, `policyEngine.ts`, the legacy decision route (`/api/teams/runs/{teamRunId}/decision`), the legacy list route's EXISTING behavior for legacy rows, the legacy audit-export's existing behavior, `verify-claim`, and `synthesize-panel`'s legacy (non-adaptive) behavior. Protected Claim/Video Verification paths are untouched — nothing in this design references either.

### 21.16 Implementation phasing

Per instruction, split into 3 controlled parts, none implemented in this design-only step:

- **Part C:** `routeAdaptiveTeamReview()` (§21.11), `AdaptiveTeamRunProjection` type (§21.1), deterministic projection ID + create-if-absent persistence (§21.2), wired into the lifecycle insertion point (§21.12). **No review route yet.**
- **Part D:** the transaction-safe `submitAdaptiveHumanReview()` (§21.7), the new `POST /api/teams/adaptive-runs/{runId}/decision` route (§21.5-21.6), projection-status sync (§21.9), the `governanceEvents` write (§21.10).
- **Part E:** the list-endpoint union (§21.13), and — only if explicitly requested, not assumed — a minimal team-review UI (none exists today, §20.8, so building one is a genuinely new product decision, not an extension of existing UI).

### 21.17 Contract changes required

- `TeamDocument`: one new optional field, `adaptiveReviewSettings` (§21.3) — additive, no existing field renamed or removed.
- `GovernanceRecordV1`/`AdaptiveDecisionReceipt`: **no changes** — every field this design reads or writes already exists (`humanReview`, `automatedGovernance`, `decisionReceipt.conclusion`, `decisionReceipt.sourceBacked`, `decisionReceipt.humanReviewNeeded`, `schemaId`, `answerShape`, `updatedAt`).
- A new Firestore document shape (`AdaptiveTeamRunProjection`) coexisting in the EXISTING `teamRuns` collection — not a schema migration, since Firestore collections aren't schema-enforced and nothing reads the collection with a shape assumption strict enough to break (§21.1/§21.13).
- `writeAdaptiveGovernanceEvent`'s existing shape (§18a) is NOT reused verbatim for this event — the new `action: "human_review_decided"` event (§21.10) has a different, slightly richer payload (includes `prevStatus`/`teamId`) than the automated-governance event; whether to unify these two into one shared event-writing helper or keep them as two small, separate calls is left to Part D's own implementation judgment, not decided here.

### 21.18 Unresolved questions for Part C/D/E

1. Should `reviewerName` be sourced from the caller's Firebase Auth display name, their `users/{uid}.email`, or omitted entirely if no reliable display name exists? Not resolved here — a small, low-risk implementation detail for Part D.
2. Whether a projection-repair/reconciliation mechanism (§21.9) is needed at all, given `teamRuns` is explicitly non-canonical — deferred; the honest answer today is "no mechanism, and the parent record is always authoritative regardless," which may be sufficient permanently.
3. Whether `AdaptiveTeamReviewRoutingResult`'s `reason` values should also be persisted somewhere (e.g., as a debug field on the projection) or are purely a return value for the caller to log — not resolved; low-stakes either way.
4. Whether existing runs (created before a team enables `adaptiveReviewSettings`) should ever get a backfill pass to create projections retroactively — explicitly not designed here (§21.12's own table), and may reasonably never be needed.
5. Whether unifying the two `governanceEvents`-writing call sites (adaptive automated governance, §18a; adaptive human review, §21.10) into one shared helper is worth the small abstraction, or whether two small, separate, easy-to-read functions are preferable — a genuine judgment call for whoever implements Part D, not resolved here.

### 21.19 Exact Part C boundary

Part C implements ONLY: the `AdaptiveTeamRunProjection` type, `routeAdaptiveTeamReview()` (pure, fully unit-testable in isolation, zero I/O), the deterministic-ID create-if-absent persistence function, and its wiring into `app/api/run-panel/route.ts` immediately after the Step 6B automated-governance block. It does NOT implement the review route, the transaction, projection sync, or the governance event — those are Part D. It does NOT touch `TeamDocument`'s type without adding the new field additively, and does NOT modify `policyEngine.ts`, `teamGovernancePipeline.ts`, or any existing `/api/teams/*` route.

## 22. Step 7, Part C — adaptive team routing and projection creation (implemented, 2026-07-30)

Implements exactly the boundary set in §21.19: the settings contract, the pure routing function, the projection contract, deterministic-ID create-if-absent persistence, and lifecycle wiring. **Does not implement Part D** (the human-review decision route, transaction, projection sync, or governance event) — no review capability exists yet.

### 22.1 Settings contract

`lib/governance/adaptiveTeamReview.ts` — `parseAdaptiveReviewSettings(raw: unknown): AdaptiveReviewSettings`. Fails closed to `{enabled: false, mode: "flagged_only"}` on anything absent, non-object, wrong-typed, or an unrecognized `mode` string — a malformed stored value can only ever reduce eligibility, never expand it. Wired additively into `parseTeamDoc()` (`lib/teams/teamApiAuth.ts`) as `adaptiveReviewSettings: parseAdaptiveReviewSettings(data.adaptiveReviewSettings)` — no existing field touched, no existing caller affected (nothing previously read this field).

### 22.2 Routing API and behavior

`routeAdaptiveTeamReview(args): AdaptiveTeamReviewRoutingResult` — pure, synchronous, zero I/O, never calls a connector/classifier/`policyEngine.ts`. Reads only 3 already-computed signals (`humanReviewNeeded`, `automatedGovernanceStatus`, `settings`) — never receipt content or the user question.

| `settings` | `mode` | Eligible when | `reason` |
|---|---|---|---|
| absent or `enabled: false` | — | never | `"disabled"` |
| enabled | `"all"` | always | `"all_runs"` |
| enabled | `"flagged_only"` | `automatedGovernanceStatus === "flagged"` | `"flagged"` |
| enabled | `"flagged_only"` | `automatedGovernanceStatus === "blocked"` | `"blocked"` |
| enabled | `"flagged_only"` | `"passed"` / `"not_evaluated"` / `"error"` / undefined | not eligible → `"not_eligible"` |
| enabled | `"human_review_needed"` | `humanReviewNeeded === true` (independent of automated status) | `"human_review_needed"` |
| enabled | `"human_review_needed"` | `humanReviewNeeded === false` | not eligible → `"not_eligible"` |

An automated-governance **evaluation error is deliberately never treated as "flagged"** under `flagged_only` — a failure to evaluate is not evidence a run needs review, and treating it that way would fabricate a signal from an absence of one. `human_review_needed` is the one mode that can route a run to review independent of whether automated governance ever resolved.

In practice, today's `evaluateAdaptiveGovernance()` (§18a) only ever produces `"passed"` or `"flagged"` — its aggregation logic supports `"blocked"` for forward compatibility, but neither of its 2 ported rules currently emits it.

### 22.3 Projection contract

`AdaptiveTeamRunProjection` — a compact queue-display record, deliberately excluding the full `decisionReceipt` (basis, assumptions, uncertainties, limitations, sources), question text, comment, conditions, and reviewer identity. `humanReview`'s full richness stays canonical ONLY on `governanceRecord` — `teamRuns` never becomes a second source of truth for any of it. Uses `adaptive: true` as the discriminator (matching §21.1's exact field name).

`receiptConclusion` is truncated via `truncateReceiptConclusionForProjection()` at `RECEIPT_CONCLUSION_PROJECTION_LIMIT = 300` chars (a queue-summary limit newly established in this step, not specified in §21 — chosen conservatively relative to this codebase's existing truncation precedents, e.g. `writeAuditEvent`'s 200-char question truncation and `teamGovernancePipeline`'s 5000-char query truncation). Truncation only ever takes a prefix plus an ellipsis — never a semantic rewrite — and is deterministic.

### 22.4 Deterministic projection ID and true create-if-absent

`buildAdaptiveTeamRunProjectionId(teamId, runId)` → `` `${teamId}:${runId}` ``, rejecting empty or `/`-containing inputs. Verified collision-safe against the REAL ID formats used in this codebase: `teamId` is always `` team_${uid.slice(0,8)}_${Date.now()} `` and `runId` is always `` run-${randomUUID()} `` — neither ever contains `:`.

`lib/firestore/teamRuns.ts` → `createAdaptiveTeamRunProjection()` uses `DocumentReference.create()`, **not** `.set()` or `.set(..., {merge:true})` — the exact, mandatory correction from the Step 7 Part B review. `.create()` throws `ALREADY_EXISTS` (gRPC code 6) rather than silently overwriting, giving atomic create-if-absent semantics with no separate `.get()`-then-`.set()` read/write gap to race on — stronger than a check-then-write pattern, not just simpler. An `ALREADY_EXISTS` result is treated as a successful, idempotent outcome (`{status: "already_exists"}`), since the invariant this function protects (never rewrite an existing projection) is satisfied by definition when `.create()` itself refuses to write. Verified in `lib/firestore/__tests__/teamRuns.spec.ts`: a retried creation attempt with different content leaves the stored document byte-for-byte unchanged, and exactly one write attempt is ever made (no retry loop).

### 22.5 Lifecycle insertion point

Wired into `app/api/run-panel/route.ts` immediately after the Step 6B automated-governance block (§18b), still inside the `if (initResultForAutomatedGovernance?.record)` scope, reusing `record` directly. Never re-runs models, classification, synthesis, or automated governance itself; never calls `applyTeamGovernancePipeline()`/`policyEngine.ts` (every legacy team-policy rule requires a `ConsensusSummary` no adaptive schema produces, §20.5); never touches quota or token finalization (both already resolved earlier in the same request). The block runs for every one of the 3 governance-initialization outcomes that yield a real record (`created`/`already_exists`/`blocked_reviewed`) — including when automated governance itself errored, since `human_review_needed` mode does not depend on it.

Team lookup uses the existing `loadUserAndTeam()` (`lib/teams/teamApiAuth.ts`) — no new auth path. `loadUserAndTeam()` returning `null` (Firestore unavailable) or a user with no team is treated identically to "disabled": no projection is attempted, and this is never surfaced as a route failure.

### 22.6 Response contract

`adaptivePayload.adaptiveTeamReviewProjectionStatus?: "created" | "already_exists" | "disabled" | "not_eligible" | "failed"` — status only, mirroring `automatedGovernanceStatus`'s own omission discipline (§18b). Omitted entirely whenever the governance lifecycle never reached a valid record. Never includes the projection ID, team ID, routing-reason detail, or governance reasons — verified by an explicit response-contract test asserting none of these appear in the serialized response.

### 22.7 Failure isolation

Every failure in this block (`loadUserAndTeam()` throwing, `createAdaptiveTeamRunProjection()` throwing or returning `"write_failed"`/`"firestore_unavailable"`) is caught and reported as `"failed"` — never propagated, never changes the HTTP response's success status, never removes any field `adaptivePayload` already had set. The already-assembled adaptive answer and HTTP 200 are always preserved.

### 22.8 No governance event in this step

Unlike §18a's `writeAdaptiveGovernanceEvent`, Part C deliberately writes no event — a queue-projection *creation* is not itself a governance decision worth an audit event; the human-review *decision* event (§21.10) is Part D's responsibility, not this step's.

### 22.9 Files changed

New: `lib/governance/adaptiveTeamReview.ts`, `lib/firestore/teamRuns.ts`, and 4 test files (`lib/governance/__tests__/adaptiveTeamReviewRouting.spec.ts`, `lib/governance/__tests__/adaptiveTeamRunProjection.spec.ts`, `lib/firestore/__tests__/teamRuns.spec.ts`, `app/api/run-panel/__tests__/adaptiveTeamReviewProjectionWiring.spec.ts`). Modified: `lib/governance/teamTypes.ts` (additive `AdaptiveReviewMode`/`AdaptiveReviewSettings` types + `TeamDocument.adaptiveReviewSettings?`), `lib/teams/teamApiAuth.ts` (additive field in `parseTeamDoc()`), `app/api/run-panel/route.ts` (3 new imports, one new optional response field, one new wiring block). No existing function signature changed; no protected path (`middleware.ts`, `lib/stripe/*`, `lib/firebase/admin.ts`, CSP config, `/api/verify-claim`, `/api/verify-video`) touched.

### 22.10 Tests added and verification

62 new tests across the 4 files above (21 + 10 + 12 + 19). Full suite: 1467 → 1529, confirmed exactly by this arithmetic (no import-boundary contribution, since none of the new files sit under the scanned `lib/adaptiveSchema/`/`components/adaptive/` trees). Full Jest run twice (both: 86 suites / 1529 tests / 56 snapshots, all passing), `tsc --noEmit` clean, `next lint` clean (pre-existing warnings only, none in touched files).

### 22.11 Part D readiness

Part D (the human-review decision route, transaction-safe write, projection-status sync, governance event) was explicitly not started, per instruction. Nothing implemented in Part C blocks it — the projection contract, deterministic ID, and lifecycle insertion point it depends on are now real and tested.

## 23. Step 7, Part D — transaction-safe adaptive human review (implemented, 2026-07-30)

Implements the review-decision path designed in §21.4-§21.10. **Does not implement Part E** (the list-endpoint union, dashboard, review UI, reviewer assignment, multiple reviewers, review history, reopening terminal reviews, comment threads, quorum, export, or `admin_audit_logs`) — none of that exists yet.

### 23.1 Route contract

`POST /api/teams/adaptive-runs/{runId}/decision` — `{runId}` is the real `runs/{runId}` panel run ID, never the `teamRuns` projection's own document ID. Request body: `{status, comment?, conditions?, expectedUpdatedAt}`, validated by `parseAdaptiveReviewDecisionRequest()` (`lib/governance/adaptiveHumanReviewRequest.ts`). Never accepted from the client (not read from the body at all): `reviewerId`, `reviewerName`, `teamId`, `userId`, `schemaId`, `answerShape`, `automatedGovernance`, `decisionReceipt`, `reviewedAt`, `updatedAt` — verified by a dedicated test asserting the parsed value's key set is exactly `{status, comment, conditions, expectedUpdatedAt}` even when a request body includes every one of those forbidden fields.

### 23.2 Validation rules

`"unreviewed"`/`"pending"` are rejected as request statuses (only the 4 terminal values are accepted). Status-specific rules: `approved` — conditions must be absent/empty; `approved_with_conditions` — at least one non-empty condition required; `changes_requested`/`rejected` — non-empty comment required, conditions must be absent. `MAX_REVIEW_COMMENT_LENGTH = 4000` (matching the legacy `teamRuns` decision route's own existing 4000-char precedent for a free-text note). `MAX_REVIEW_CONDITIONS_COUNT = 20`, `MAX_REVIEW_CONDITION_LENGTH = 500` — a separate "total conditions length" limit is deliberately not enforced, since count × per-item length already bounds it (20 × 500 = 10,000). Conditions are trimmed, empty-after-trim entries dropped, exact duplicates removed while preserving first-occurrence order. `expectedUpdatedAt` reuses `governanceRecordParser.ts`'s own `isValidTimestamp` (newly exported for this reuse) rather than a second, independently-drifting format check.

### 23.3 Authorization

Reuses the exact System B mechanism (`getRequestUid`, `loadUserAndTeam`, `isTeamAdmin`) — no new auth path. The deterministic adaptive projection is looked up at `${callerTeamId}:${runId}` via the new `getAdaptiveTeamRunProjection()` (`lib/firestore/teamRuns.ts`); its stored `adaptive`/`teamId`/`runId` fields are checked defensively even though the deterministic ID itself is the primary tenant-isolation mechanism — a forged or malformed projection fails closed with `404 projection_invalid`. The parent run and its `governanceRecord` are pre-checked (non-transactionally) purely to produce an accurate HTTP error code and to gather `schemaId`/`answerShape` for the projection sync and event — this pre-check is never treated as authoritative; the transaction inside `submitAdaptiveHumanReview()` re-reads and re-validates everything fresh. A run-owner/caller-team mismatch is logged for monitoring only (§21.6 point 5) and never blocks the review.

### 23.4 Canonical transaction

`submitAdaptiveHumanReview()` (`lib/firestore/runs.ts`) uses `adminDb.runTransaction()` — reads `runs/{runId}` and its `governanceRecord` INSIDE the transaction, checks `expectedUpdatedAt` against the freshly-read `updatedAt` BEFORE the reviewable-status check (so a stale-data error is never masked by a terminal-status error the caller's UI hasn't seen yet), checks `isHumanReviewStatusReviewable()` (new predicate, `lib/adaptiveSchema/governanceRecordParser.ts`) against the CURRENT stored status — never the projection's own `humanReviewStatus` — then builds the update via `applyHumanReviewUpdate()` and writes via `txn.update(ref, {"governanceRecord.humanReview": ..., "governanceRecord.updatedAt": ...})`. Verified by a dedicated concurrency test: two sequential submissions against the same starting state result in exactly one success, the second failing (on the real ordering, `stale_expected_updated_at`, since the first commit already advanced `updatedAt` — proving the safety property without needing a true concurrent scheduler).

### 23.5 Optimistic concurrency and terminal-state protection

`expectedUpdatedAt` is mandatory. A terminal record (`approved`/`approved_with_conditions`/`changes_requested`/`rejected`) returns `409 terminal_review_exists` and is left byte-for-byte unchanged — verified for all 4 terminal statuses via a parameterized test.

### 23.6 Nested write fields

Only `governanceRecord.humanReview` and `governanceRecord.updatedAt` are ever part of the transaction's write payload — `automatedGovernance`, `decisionReceipt`, `schemaId`, `answerShape`, `adaptiveOutputVersion`, and `createdAt` are never read into it at all, verified directly against the stored document after a successful review.

### 23.7 Projection synchronization

`syncAdaptiveTeamRunProjectionAfterReview()` (`lib/firestore/teamRuns.ts`) runs AFTER the canonical transaction commits — never before, never as part of the same transaction. Writes only `humanReviewStatus`/`reviewedAt`/`updatedAt` via a plain `.update()` (a transaction is unnecessary here: the canonical write has already committed by this point, and this function together with `createAdaptiveTeamRunProjection()` are the only two writers of this document). A missing projection returns `"not_found"` rather than being created inline. `AdaptiveTeamRunProjection` gained one new additive optional field, `reviewedAt?: string` (absent at Part C creation time, populated only here).

### 23.8 Event ordering

`writeAdaptiveHumanReviewEvent()` (`lib/firestore/runs.ts`) is called after the canonical transaction commits, writing `action: "human_review_decided"` (a new, distinct value from `"evaluated"`) to the same `runs/{runId}/governanceEvents` subcollection, with `byUid`/`at`/`teamId`/`schemaId`/`answerShape`/`prevStatus`/`nextStatus` only — never comment, conditions, receipt content, or question text. `admin_audit_logs` is not written, for the identical reason Step 6B deferred it (no honest adaptive equivalent for `runType`/`question`/`consensusScore` without a scope-expanding contract change).

### 23.9 Canonical-success semantics

Once `submitAdaptiveHumanReview()` returns `ok: true`, the route always returns HTTP 200. Neither a projection-sync failure nor a governance-event failure (including a thrown exception) can change that — verified by 4 dedicated tests covering sync failure, sync "not_found", event failure, and event exception, each asserting `response.status === 200` and `ok: true`.

### 23.10 Response contract

`{ok: true, review: {status, reviewedAt}, projectionSyncStatus: "synced"|"failed"}` — never `reviewerId`, `teamId`, `comment`, `conditions`, `governanceRecord`, `automatedGovernance`, the receipt, or the projection ID. Verified by an exact-shape response assertion and a "never contains a raw error string" assertion.

### 23.11 Failure handling — HTTP mapping

`stale_expected_updated_at`/`terminal_review_exists` → `409`; `run_missing`/`projection_missing`/`projection_invalid` → `404`; `governance_record_absent` → `404`; `governance_record_malformed`/`unsupported_version`/`firestore_unavailable`/`write_failed` → `500`, with no parser detail or raw Firestore error ever included in the response body.

### 23.12 Files changed

New: `lib/governance/adaptiveHumanReviewRequest.ts`, `app/api/teams/adaptive-runs/[runId]/decision/route.ts`, and 4 test files. Modified: `lib/adaptiveSchema/governanceRecordParser.ts` (exported `isValidTimestamp`, exported `HumanReviewStatus`, added `isHumanReviewStatusReviewable`), `lib/firestore/runs.ts` (added `submitAdaptiveHumanReview`, `writeAdaptiveHumanReviewEvent`), `lib/firestore/teamRuns.ts` (added `getAdaptiveTeamRunProjection`, `syncAdaptiveTeamRunProjectionAfterReview`), `lib/governance/adaptiveTeamReview.ts` (additive `reviewedAt?` field on `AdaptiveTeamRunProjection`). No existing function signature changed; `policyEngine.ts`, `teamGovernancePipeline.ts`, the legacy `teamRuns/{runId}/decision` route, and every protected path remain untouched.

### 23.13 Tests added, verification

87 new tests across 4 files (23 validation + 25 persistence/transaction + 9 event + 30 route wiring). Full suite: 1529 → 1616, exact match, zero import-boundary contribution. Full Jest run twice (both: 90 suites / 1616 tests / 56 snapshots, all passing), `tsc --noEmit` clean, `next lint` clean (pre-existing warnings only).

### 23.14 What remains for Part E

No list endpoint, dashboard, review UI, reviewer assignment, multiple-reviewer support, review history, reopen/re-review capability, comment threads, quorum, export support for adaptive rows, or `admin_audit_logs` integration exists. `teamRuns` still has zero UI consumer. Everything above is real and tested; nothing about it is a placeholder.

## 24. Step 7, Part E1.1 — adaptive team-review read-surface audit (read-only, 2026-07-30)

Read-only audit, per instruction, before any Part E1 implementation. Every finding below was verified directly against current source, not assumed from the Part A audit's (§20) earlier conclusions — the instruction explicitly required reconfirmation, and one material fact has changed since Part A.

### 24.1 Existing list endpoint (`app/api/teams/runs/route.ts`) — current behavior, verbatim

- Auth: `getRequestUid` → `loadUserAndTeam` → requires a team (403 `forbidden` if none). Non-admins are silently scoped to their own rows (`r.userId === uid`) rather than rejected — admins see the whole team.
- Query: `adminDb.collection("teamRuns").where("teamId", "==", ctx.team.id).get()` — a single equality filter, **no `orderBy` in the Firestore query itself**. Every matching document is fetched in one call, then filtered/sorted/paginated **entirely in memory** in the route handler (`type`/`flagged`/`userId` filters, then `rows.sort(...)`, then `.slice(start, start+limit)`).
- Sort key: `tsMillis(data.timestamp)` — reads a Firestore `Timestamp` field named `timestamp`. Returns `0` for anything that isn't a `Timestamp` with a `.toMillis()` method.
- Response shape (current, unversioned): `{ok: true, runs: TeamRunListRow[], total, page, limit}`. `TeamRunListRow` is `{id, timestamp, userId?, type?, policyFlags?, humanDecision?, [key: string]: unknown}` — an **untagged, permissive index-signature type**, confirmed matching §21.1's own claim about it.
- **Material, newly-confirmed fact: this route has NO discrimination between legacy and adaptive rows today.** Since Part C started writing `AdaptiveTeamRunProjection` documents into the SAME `teamRuns` collection under the SAME `teamId`, this endpoint's existing query already returns them, **mixed in with legacy rows, completely untagged** — there is no `kind`/`adaptive` filter anywhere in this route. An adaptive row has no `type` field, so it's excluded by an explicit `type` filter but included in the default (unfiltered) response; it has no `timestamp` field, so `tsMillis()` returns `0` for it, sorting every adaptive row as if it were infinitely old (last, under the current descending-timestamp sort). This is a real, already-existing behavior, not a hypothetical Part E1 concern — flagged here because introducing an explicit discriminated union (Part E1.2) is a genuine, needed correction to already-live commingling, not a preemptive design choice for a problem that doesn't exist yet.

### 24.2 Existing audit-export endpoint (`app/api/teams/audit-export/route.ts`) — current behavior

Same `.where("teamId","==",...).get()` full-collection-scan pattern, same lack of adaptive/legacy discrimination. Maps every doc into a fixed legacy-shaped row (`userEmail`, `type`, `queryTruncated`, `verdict`, `consensusScore`, `policyFlags`, `humanDecision`). For an adaptive row: `x.consensusScore` is `undefined` → `Number(undefined)` → `NaN`. In the JSON export path this serializes safely (`JSON.stringify(NaN)` → `null`); in the **CSV path, `String(NaN)` produces the literal text `"NaN"` in that cell** — a real, confirmed, non-crashing cosmetic defect if an adaptive row is ever exported, matching §21.14's prediction exactly ("blank/absent values... acceptable for now") but now confirmed as specifically `"NaN"` rather than genuinely blank for that one column. `humanDecision` is safely `null` for adaptive rows (no crash). No code change to this route is in Part E1's scope — noted for completeness only.

### 24.3 UI consumers — reconfirmed, not assumed

Grepped the entire `app/`, `components/`, `hooks/` trees for any reference to `api/teams/runs`, `api/teams/audit-export`, or `api/teams/adaptive-runs`, outside of the route files and their own tests: **zero matches.** `app/governance/page.tsx` + `components/governance/GovernanceDashboard.tsx` (2,360 lines) is a large, fully live, real dashboard — but it belongs entirely to **System A** (`/api/governance/queue`, `/api/governance/policy`, `/api/governance/audit`, `/api/governance/review` — all distinct routes under `/api/governance/*`, never `/api/teams/*`). It has its own tabs (Review Queue / Policies / Audit Log), its own inline `ReviewModal`, its own loading/empty/error states, all hand-built (no shared `Modal`/`EmptyState`/`Skeleton` component exists anywhere in `components/` — every screen in this codebase builds these inline). This reconfirms, with a positive verification rather than an absence-based assumption, that **no UI reads System B's `teamRuns` collection or any `/api/teams/*` list/export route today.**

### 24.4 No existing app-router page for team governance

`find app -maxdepth 1 -type d` shows no `app/team*`/`app/teams*` directory at all. A Part E1 UI is a **brand-new page**, not an extension of an existing one — there is no established nav entry pointing to it either (`TopNav.tsx` links to `/governance` only, System A's dashboard). Where this new page should live, and how a user navigates to it, is a genuine open product decision, not something this audit can resolve on its own.

### 24.5 Test coverage — reconfirmed

Neither `app/api/teams/runs/route.ts` nor `app/api/teams/audit-export/route.ts` has ANY existing test file — grepped for `teamRuns`/`api/teams/runs` across every `*.spec.ts`/`*.test.ts` in the repo; the only matches are Part C/D's own adaptive-projection tests (`lib/firestore/__tests__/teamRuns.spec.ts`, the run-panel wiring test, the human-review route test). Whatever Part E1 builds for the versioned list contract will be the **first** test coverage either legacy route has ever had.

### 24.6 Pagination and ordering — confirmed, not assumed

No cursor-based pagination exists anywhere in this collection's access pattern — `page`/`limit` are purely client-supplied, in-memory slice parameters over a full, unfiltered collection scan. There is no `nextCursor`/`startAfter` precedent to match or diverge from; a genuine design decision either way.

### 24.7 Firestore indexes

`firestore.indexes.json` has **zero composite indexes for `teamRuns`** — only `runs`/`verifications`/`videoVerifications`/`admin_audit_logs` have indexes defined. This works today only because the existing query is a single equality filter with no `orderBy` (Firestore does not require a composite index for that). **If Part E1.2 (or any future step) adds a server-side `.orderBy()` alongside the `teamId` filter, a new composite index must be added to `firestore.indexes.json` and deployed BEFORE that query will work in production** — matching this codebase's own established "needs deploy before first use" pattern (cf. the PSEO IndexNow rollout). This is a real deployment-sequencing constraint for whatever Part E1.2 specifies, not a hypothetical one.

### 24.8 Firestore security rules

`firestore.rules` is default-deny for every collection except `users/{uid}` and `appConfig/modelKeys` — `teamRuns`, `runs`, `teams`, and `governanceEvents` are all reachable ONLY through the Admin SDK (server-side routes), never directly from a client Firestore SDK call. No rule change is implicated by an API-only read surface.

### 24.9 Error-response convention

Confirmed (again) that every `/api/teams/*` route uses the same ad hoc `{ok: false, error: {code, message}}` shape with a numeric HTTP status — never `lib/api/errorResponse.ts`'s `{errorCode, message}` convention (that one is used exclusively by `/api/synthesize-panel`). Any new Part E1 route should match the local `/api/teams/*` family convention, consistent with Part D's own route.

### 24.10 Outcome

This audit materially changes one assumption from §20/§21: **adaptive projections are not merely "about to become" reachable through the legacy list route — they already flow through it today, untagged.** Everything else (no UI consumer, no tests, no Firestore index, default-deny security rules, ad hoc error convention) is reconfirmed as previously understood. Part E1.2 (the versioned, discriminated list contract) is therefore a correction to an already-live gap, not a preemptive one — and the design doc for it should say so explicitly rather than implying the commingling is a purely future risk.

## 25. Step 7, Part E1 — adaptive team-review queue API and read-only UI (implemented, 2026-07-30)

Implements the versioned list contract, the read-only detail endpoint, and a new, read-only System B UI. **Does not implement the decision form** — that is Part E2, explicitly not started.

### 25.1 Versioned list response contract

`GET /api/teams/runs?version=1` (opt-in — the legacy, untagged, unversioned response remains the DEFAULT and is completely unchanged; §25.10). Response: `{ok: true, version: 1, items: TeamRunListItemV1[], pagination: {page, limit, total, hasNextPage, hasPreviousPage}}`.

### 25.2 Discriminated item contract

`TeamRunListItemV1 = LegacyTeamRunListItemV1 | AdaptiveTeamRunListItemV1`, every item carrying exactly one `kind: "legacy" | "adaptive"`. Both defined in `lib/governance/teamRunListContract.ts`.

### 25.3 Legacy item contract and query-summary truncation

`LegacyTeamRunListItemV1`: `teamRunId, runId?, verificationId?, createdAt, querySummary?, policyFlags, blockedByPolicy, governanceReviewRequired, consensusScore?, humanDecision?` — never the full `consensusSummary`, `auditBundle`, `claims`, raw query, model output, source text, or decision notes/decidedBy. `blockedByPolicy = policyFlags.length > 0`; `governanceReviewRequired = policyFlags.length > 0 && !humanDecision` (the exact existing "flagged" semantic the legacy route already used). `querySummary` via `buildTeamRunQuerySummary()`: trim, normalize line breaks, deterministic truncate at `TEAM_RUN_QUERY_SUMMARY_MAX_LENGTH = 160` — never a semantic rewrite.

### 25.4 Adaptive item contract

`AdaptiveTeamRunListItemV1`: `teamRunId, runId, schemaId, answerShape, receiptConclusion, sourceBacked, humanReviewNeeded, automatedGovernanceStatus?, humanReviewStatus, reviewable, createdAt, updatedAt, reviewedAt?` — `reviewable` computed via the existing `isHumanReviewStatusReviewable()`, never re-derived independently. Never `teamId`, `userId`, `reviewerId`, `reviewerName`, `comment`, `conditions`, the full receipt, `sources`, `basis`, `assumptions`, `uncertainties`, `limitations`, raw question, raw model output, automated-governance `reasons`, parser reasons, or `projectionVersion`.

### 25.5 Strict row classification

`classifyTeamRunRow()` routes on the `adaptive` discriminator ONLY. `adaptive === true` present but any required field invalid (`projectionVersion`, `teamId`, `userId`, `runId`, `schemaId`/`answerShape` pair, `receiptConclusion`, `sourceBacked`, `humanReviewNeeded`, `automatedGovernanceStatus`, `humanReviewStatus`, `createdAt`/`updatedAt`/`reviewedAt`) → `{status: "malformed", detectedKind: "adaptive"}`, **never falls back to the legacy mapper** — verified directly by a dedicated test. Discriminator absent → legacy path, whose only hard requirement is a valid Firestore `Timestamp` at `timestamp` (everything else — `policyFlags` type violations aside — defaults safely, since those fields are genuinely optional on the real `TeamRunDocument` contract). Malformed rows are skipped from the result and logged metadata-only (`teamRunId`, `detectedKind`) — never failing the whole response.

### 25.6 Filters

`kind=all|legacy|adaptive`, `flagged=true|false` (a real semantic for BOTH kinds), `reviewable=true|false` and `humanReviewStatus=...` (adaptive-native semantics — per instruction, "do not invent legacy reviewability," so these two filters, when set, exclude legacy rows entirely rather than fabricating an interpretation for them). `page`/`limit` validated (`DEFAULT_TEAM_RUN_PAGE_SIZE = 25`, `MAX_TEAM_RUN_PAGE_SIZE = 100`); any invalid parameter → `400`.

### 25.7 Ordering and pagination — current limitation, deliberately preserved

Deterministic sort: effective timestamp descending (adaptive: `updatedAt`; legacy: `createdAt`), tie-broken by `teamRunId` descending — adaptive rows never sort as "infinitely old" (the bug confirmed live in §24.1). Processing order: team authorization scoping (on RAW data, before mapping) → classification → malformed-row exclusion → filters → sort → pagination. **Still an in-memory, full-collection read** — the team-scoped query itself is unchanged (`.where("teamId","==",...).get()`, no `.orderBy()`), preserved deliberately per §24.7/§24.26: no composite `teamRuns` index exists, and adding server-side ordering without first designing, adding, and deploying one would ship code that silently fails until that deploy happens. Not done in this step.

### 25.8 Authorization

Reuses `getRequestUid`/`loadUserAndTeam`/`memberRole`/`isTeamAdmin` exactly. Owner/admin see the whole team; members are scoped to their own rows via the RAW `userId` field, before classification/mapping — necessary because the adaptive item never exposes `userId` at all.

### 25.9 List versioning and backward compatibility

The default (unversioned) response is UNCHANGED — confirmed via the Part E1.1 audit that no internal consumer exists anywhere in `app/`/`components/`/`hooks/`, and the audit-export route has its own independent serializer (never shared with the list route). The default is not switched in this step: "no external integration is documented" cannot be fully verified from inside this repository alone, so switching the default is deliberately left as an explicit, separate decision rather than silently made here.

### 25.10 Adaptive review-detail endpoint

`GET /api/teams/adaptive-runs/{runId}` (`lib/governance/adaptiveReviewDetail.ts` + the route) — read-only, the data source for a future Part E2 decision form. Same authorization + deterministic-projection-lookup pattern as the Part D decision route (including the defensive stored-field check beyond the deterministic ID), PLUS an explicit `projectionVersion` check (not present in Part D's own decision route, added here per this step's explicit instruction). The canonical parent `governanceRecord` is always the source — a projection/parent `humanReviewStatus` disagreement is logged (metadata only) but never repairs the projection and never changes the response.

### 25.11 Detail response contract

`AdaptiveReviewDetailResponseV1`: `runId, schemaId, answerShape, decisionReceipt {conclusion, basis, assumptions, uncertainties, limitations, sourceBacked, humanReviewNeeded}, automatedGovernance? {status, evaluatedAt?, policyVersion?}, humanReview {status, reviewedAt?}, reviewable, updatedAt`. Never `reviewerId`, `reviewerName`, `comment`, `conditions`, `sources`, raw question, raw model output, automated-governance `reasons`, policy internals, parser reasons, `teamId`, `userId`, or the projection ID.

### 25.12 Detail failure mapping

`unauthenticated → 401`; `no team/member role → 403`; `projection missing/invalid/cross-team → 404`; `unsupported projection version → 500`; `parent run missing → 404`; `governance record absent → 404`; `malformed/unsupported governance version → 500`; `Firestore unavailable → 503` (this route's own explicit instruction differs slightly from Part D's decision route, which used `500` for the equivalent case — a deliberate, instruction-driven choice, not an inconsistency introduced by accident).

### 25.13 Read-only team-review UI

New pages: `/team/reviews` (queue) and `/team/reviews/{runId}` (adaptive detail) — a NEW System B interface, deliberately separate from the existing System A `/governance` dashboard (confirmed, §24.3, to be an entirely different system). Components under `components/teamGovernance/`: `TeamReviewQueue`, `TeamReviewFilters`, `TeamReviewListItem` (dispatcher), `AdaptiveReviewListItem`, `LegacyReviewListItem`, `AdaptiveReviewDetail`, `GovernanceStatusBadge`, `HumanReviewStatusBadge`, `ReviewEmptyState`, `ReviewErrorState`. Uses the existing `authedFetch`/`useAuth`/`useUserPlan` — no new auth path. Nav entry ("Team Reviews") added to `TopNav.tsx`, gated on `useUserPlan()`'s already-existing, reliable `teamRole` field (`"owner"|"admin"`) — no new, fragile client-side role logic. Filters and page are preserved in the URL. No shared `Modal`/`EmptyState`/`Skeleton` component exists anywhere in this codebase (confirmed, §24.3) — every state is hand-built, matching the established convention.

### 25.14 Centralized labels

`lib/governance/teamReviewLabels.ts` — schema, answer-shape, automated-governance-status, and human-review-status label maps, each falling back to a literal `"Unknown"` for anything unrecognized. Never renames the persisted enum values themselves.

### 25.15 Strict read-only guarantee

The UI never calls `POST /api/teams/adaptive-runs/{runId}/decision` and renders no Approve/Approve-with-Conditions/Request-Changes/Reject button, comment input, or conditions editor — verified by a dedicated source-level structural test (`readOnlyIsolation.spec.ts`) that reads every Part E1 UI file and asserts none references the decision route path, issues a POST, or renders a decision-control label.

### 25.16 Legacy export — explicit adaptive exclusion

`app/api/teams/audit-export/route.ts` now explicitly filters out any document with `adaptive === true` BEFORE mapping — not by relying on adaptive rows merely lacking legacy fields (which was the prior, implicit, accidental protection). The legacy CSV/JSON column contract is otherwise completely unchanged.

### 25.17 Firestore index decision

No composite index added. The team-scoped query remains a single equality filter (`teamId`) with in-memory sort/filter/paginate — confirmed safe without a new index (§24.7). If cursor-based, indexed pagination is ever pursued, the required composite index and its deployment ordering must be designed and documented BEFORE any dependent query ships — not done in this step.

### 25.18 Testing limitations

No DOM/RTL environment or dependency exists in this repository (`jest.config.ts` uses `testEnvironment: "node"`, confirmed — no jsdom, no `@testing-library/react`). Component tests use `react-dom/server`'s `renderToStaticMarkup()` (an established, pre-existing precedent in this codebase — `components/adaptive/__tests__/ListView.spec.tsx`), which proves genuine rendering CONTENT/structure but not click/keyboard interaction, and cannot observe post-fetch async states (no effect flushing). Data-fetch-dependent states (loaded/empty/error) are fully covered at the API-contract level instead. This limitation is stated explicitly, not glossed over.

### 25.19 Files changed

New: `lib/governance/teamRunListContract.ts`, `lib/governance/adaptiveReviewDetail.ts`, `lib/governance/teamReviewLabels.ts`, `app/api/teams/adaptive-runs/[runId]/route.ts`, `app/team/reviews/page.tsx`, `app/team/reviews/[runId]/page.tsx`, 10 components under `components/teamGovernance/`, and 10 new test files. Modified: `app/api/teams/runs/route.ts` (additive `?version=1` branch), `app/api/teams/audit-export/route.ts` (additive adaptive-exclusion filter), `components/TopNav.tsx` (additive nav entry), `lib/adaptiveSchema/governanceRecordParser.ts` (exported `AUTOMATED_GOVERNANCE_STATUSES`/`HUMAN_REVIEW_STATUSES` for reuse). No protected path touched; no Firestore index file touched.

### 25.20 Tests added and verification

139 new tests across 10 files. Full suite: 1668 → 1807, exact match, zero import-boundary contribution (`components/teamGovernance/` is a separate tree from the scanned `components/adaptive/`). Full Jest run twice (both: 101 suites / 1807 tests / 56 snapshots, all passing), `tsc --noEmit` clean, `next lint` clean (pre-existing warnings only).

### 25.21 What remains for Part E2

The decision form (approve/approve-with-conditions/request-changes/reject), any mutation call from the UI, reviewer assignment, multiple reviewers, review history, reopening terminal reviews, comment threads, quorum, adaptive export, `admin_audit_logs` integration, and cursor-based indexed pagination all remain fully unimplemented. Part E2 was not started.

## 25a. Test-count reconciliation, 1,616 → 1,807 (verification only, no code changed, 2026-07-30)

Requested before Part E2 implementation began. Re-verified every Part E1 test file individually via `npx jest --runTestsByPath <file>` (exact-file execution, not a regex `testPathPattern`, which proved unreliable when several args containing literal `[runId]` path segments were combined in one invocation — a jest CLI-matching artifact, not a real test-count discrepancy; confirmed by re-running the same files individually and getting consistent counts both times).

**Authoritative, re-verified count for every Part E1 test file:**

| File | Tests |
|---|---|
| `lib/governance/__tests__/teamRunListContract.spec.ts` | 52 |
| `app/api/teams/runs/__tests__/teamRunsListVersioned.spec.ts` | 33 |
| `app/api/teams/adaptive-runs/[runId]/__tests__/adaptiveReviewDetailRoute.spec.ts` | 28 |
| `app/api/teams/audit-export/__tests__/auditExportAdaptiveExclusion.spec.ts` | 6 |
| `lib/governance/__tests__/teamReviewLabels.spec.ts` | 36 |
| `lib/governance/__tests__/adaptiveReviewDetail.spec.ts` | 5 |
| `components/teamGovernance/__tests__/reviewListItems.spec.tsx` | 13 |
| `components/teamGovernance/__tests__/readOnlyIsolation.spec.ts` | 6 |
| `components/teamGovernance/__tests__/teamReviewQueueGateStates.spec.tsx` | 5 |
| `components/teamGovernance/__tests__/adaptiveReviewDetailGateStates.spec.tsx` | 3 |
| `components/teamGovernance/__tests__/teamReviewFilters.spec.tsx` | 4 |
| **Total, 11 files** | **191** |

`1,616` (Part D end) `+ 191` (all of Part E1's new tests) `= 1,807` (Part E1 end) — exact, confirmed by a fresh full-suite run immediately before this reconciliation (101 suites / 1,807 tests / 56 snapshots, still passing).

**Source of the reported intermediate `1,668`:** `teamRunListContract.spec.ts` (52 tests) was written and run FIRST during Part E1 — immediately after the pure list-contract module itself, before any route or UI work began. At that moment a full-suite run correctly showed `1,616 + 52 = 1,668`. The Part E1 final report then described the REMAINING work finished afterward as "139 new tests across 10 files" — true in isolation, but by describing the step's total delta in two separate numbers anchored to two different checkpoints (`1,616 → 1,668`, then `1,668 → 1,807`) rather than one clean `1,616 → 1,807 (+191 across 11 files)` statement, it read as if arithmetic were unreconciled. **It was not** — every one of the 191 tests is real, passing, and accounted for above; this was a REPORTING framing gap, not a missing, duplicated, or miscounted test, and no code or test was changed to produce this reconciliation.

## 26. Step 7, Part E2 — adaptive review decision form and mutation UX (implemented, 2026-07-30)

Implements the decision form on the existing `/team/reviews/{runId}` detail page — the last piece of the Phase 2A adaptive governance product workflow. No new API route: submits to the EXISTING, unmodified Part D decision route.

### 26.1 Existing contract audit (E2.1)

Re-read the real Part D decision route (`app/api/teams/adaptive-runs/[runId]/decision/route.ts`) and Part E1 detail route directly before writing any client code. Confirmed exact, current contracts: success `{ok:true, review:{status, reviewedAt}, projectionSyncStatus:"synced"|"failed"}`; error codes actually used — `stale_expected_updated_at` (409), `terminal_review_exists` (409), `governance_record_absent`/`not_found`/`projection_missing`/`projection_invalid` (404), `forbidden`/`insufficient_role` (403), `validation_error`/`bad_request` (400), `internal_error` (500). The prompt's own placeholder code (`ADAPTIVE_REVIEW_STALE`) was NOT used — the real, already-shipped code was, per the prompt's own "or the actual repository error code" allowance.

### 26.2 Shared form contract — direct reuse, not re-implementation

`lib/governance/adaptiveReviewFormContract.ts` imports and calls the REAL server parser, `parseAdaptiveReviewDecisionRequest()` (`lib/governance/adaptiveHumanReviewRequest.ts`, Part D), directly. Verified before relying on this: neither that module nor its one dependency (`isValidTimestamp` from `governanceRecordParser.ts`) has a `server-only` guard or any Node-only import anywhere in the chain — both are genuinely pure and framework-agnostic. This is a STRONGER guarantee than "shared constants kept in sync by convention": there is only one implementation of the validation rules, so client/server drift is structurally impossible, not just tested against. `validateAdaptiveReviewForm()` adds exactly one client-only concern on top (`status_required`, before a choice is made) and otherwise returns the server's own result verbatim.

### 26.3 Status-specific behavior

`approved`: comment optional, conditions forbidden. `approved_with_conditions`: at least one condition required, comment optional (confirmed directly from the real server rule — no comment requirement exists for this status). `changes_requested`/`rejected`: comment required, conditions forbidden. All identical to Part D's real, shipped rules — not re-derived independently.

### 26.4 Draft-preservation rule (chosen, per the prompt's own preference)

Switching `status` NEVER clears `comment`/`conditions` from form state — only the outgoing WIRE PAYLOAD excludes fields the newly-chosen status forbids (enforced by the shared validator returning `conditions_not_allowed`/etc., never by mutating form state). Verified by a dedicated test: switching from `approved_with_conditions` (with conditions entered) to `approved` leaves `form.conditions` untouched, while validation correctly now rejects submission until the incompatible field is cleared or a compatible status is chosen.

### 26.5 Conditions editor

`AdaptiveReviewConditionsEditor` — bounded at `MAX_REVIEW_CONDITIONS_COUNT=20`/`MAX_REVIEW_CONDITION_LENGTH=500` (the real, shared constants), add/edit/remove, order preserved, per-item accessible label (`Condition N`), per-item character count shown once near the limit. Plain `<input type="text">` only — no rich text, markdown, HTML, nesting, or drag-and-drop. Draft conditions live only in the parent form's React state — never written to Firestore, `localStorage`, or `sessionStorage` (verified by a dedicated structural test checking for actual API usage, not just the bare word, after that same test itself initially and harmlessly false-positived on this file's own doc comment explaining the rule).

### 26.6 Payload construction and canonical `expectedUpdatedAt`

`expectedUpdatedAt` is always `data.review.updatedAt` from the most recently fetched canonical detail response — passed down as a prop to the form, never read from `teamRuns`, never cached beyond the current render. The submitted payload never includes `reviewerId`/`reviewerName`/`teamId`/`userId`/`schemaId`/`answerShape`/`automatedGovernance`/`decisionReceipt`/`reviewedAt`/an authoritative `updatedAt`/a projection ID — none of these exist anywhere in the form's own state to begin with.

### 26.7 One-shot submission service

`lib/client/adaptiveReviewSubmission.ts` — `submitAdaptiveReviewDecision()` takes an injected `postJson` (the real caller wraps `authedFetch`), makes exactly one call, never retries, and maps the route's real response into a discriminated result: `success | validation_error | stale | terminal | unauthenticated | forbidden | not_found | server_error | unavailable | network_error`. Fully unit-tested (12 tests) without touching Firebase auth or rendering any component. Verified via a dedicated structural test that the decision route is referenced from exactly ONE file in the entire client bundle, and that no `setTimeout`/`setInterval`/retry logic exists anywhere in it.

### 26.8 Success handling

`AdaptiveReviewDetail`'s `handleDecisionSuccess()` updates `humanReview`/`reviewable`/`updatedAt` directly from the server's own success response (canonical — the server just confirmed what committed), then triggers ONE background detail refetch to reconcile fully; a background-refetch failure is shown as a restrained notice and never reverts the already-recorded success. This is the "Preferred" option from the instructions, chosen explicitly.

### 26.9 Projection-sync-failure semantics

`projectionSyncStatus === "failed"` still renders as a full success, plus the exact required restrained copy: "The review was saved, but the team queue may take time to update." No automatic resubmit, no implication that the canonical decision failed.

### 26.10 Stale and terminal conflict UX

Both show a dedicated message and a "Reload Review" action (never an auto-resubmit); the action calls a full canonical detail refetch. `expectedUpdatedAt` is only ever replaced by that refetch's own new `updatedAt` — never guessed or silently bumped. If the reloaded record is now terminal, the form disappears entirely (falls out naturally from the `data.review.reviewable` gate — no separate code path needed).

### 26.11 Other failure handling

400/401/403/404/500/503/network-ambiguity each map to a distinct, safe message (`AdaptiveReviewSubmissionResult.tsx`) — never a raw API body, Firestore message, parser reason, or stack trace. A network-transport failure explicitly never claims the decision "definitely failed" — it asks for a reload before retrying, since the request may have already committed server-side.

### 26.12 Canonical refresh and queue refresh

Detail refresh: see §26.8 (Preferred: response-first, then background reconcile). Queue refresh: no new code needed — `TeamReviewQueue`'s existing Part E1 `useEffect` already refetches on every mount, and navigating from the detail page back to `/team/reviews` unmounts/remounts it naturally.

### 26.13 Accessibility

Real `<fieldset>`/`<legend>` grouping for the 4 decision choices (radio inputs, not icons), inline errors wired via `aria-describedby`, an error summary that receives programmatic focus after a failed validation attempt, `aria-live` on submission status and the error summary, visible focus rings (the existing `focus-visible:ring-2 focus-visible:ring-cp-accent` convention), accessible per-condition labels and Remove-button labels, disabled state communicated via the real `disabled` attribute (never simulated with CSS alone), no color-only status semantics (every badge/message pairs color with text).

### 26.14 Privacy

Comment/conditions/receipt content/reviewer identity are never logged (no `console.*`/analytics call exists anywhere in the new code touching these fields — verified structurally). Drafts live only in React state — no `localStorage`/`sessionStorage`/cookie/URL persistence anywhere (§26.5). `authedFetch` is already `cache: "no-store"` by convention, reused unchanged.

### 26.15 Terminal read-only display — current limitation, stated explicitly

After reload, only the fields the EXISTING detail API already returns are ever shown (status, `reviewedAt`) — the API is deliberately NOT expanded in this step to also return the just-submitted comment/conditions back to the reviewer; that would be a real, separate privacy decision, not a default extension. `AdaptiveReviewDetail` shows a local, session-only "recorded during this session" note, which disappears on a fresh reload.

### 26.16 Manual browser verification — real, but partial (E2.24)

**Actually performed**, using a real, already-authenticated browser session (not fabricated): started the local dev server; confirmed `/` and `/team/reviews` both load without error; confirmed the real signed-in test account (no team) correctly sees the "No team" empty state on `/team/reviews`; confirmed the `TopNav` "Team Reviews" entry is correctly ABSENT for this no-team account while "Governance" (System A) still renders; confirmed `/team/reviews/{a-nonexistent-runId}` correctly resolves (after a real network round trip) to "You don't have access to this review."; confirmed zero browser console errors throughout.

**Not performed, disclosed honestly:** the full authorized decision flow (opening a real flagged adaptive item, submitting all 4 decision types, the two-tab stale-conflict simulation, observing a real `projectionSyncStatus: "failed"` case) — this would require creating a real team and running real, potentially billed multi-model panel queries to produce genuine adaptive governance data, a consequential and persistent action not taken without explicit request. This gap is real and stated plainly, not glossed over — the corresponding LOGIC for every one of those flows is instead fully covered by the automated tests in §26.17-§26.19 (including a genuine end-to-end contract test exercising the real routes together, §26.19).

### 26.17 Tests — validation and view-model

`lib/governance/__tests__/adaptiveReviewFormContract.spec.ts` (24 tests) — since validation delegates to the real server parser, these tests double as drift detection: there is no second implementation to drift.

### 26.18 Tests — component structure and submission

`lib/client/__tests__/adaptiveReviewSubmission.spec.ts` (12), `components/teamGovernance/__tests__/adaptiveReviewDecisionComponents.spec.tsx` (13), `components/teamGovernance/__tests__/adaptiveReviewDecisionForm.spec.tsx` (7), `lib/client/__tests__/adaptiveReviewDecisionFormIsolation.spec.ts` (5) — same honest `renderToStaticMarkup()`/source-level pattern established in Part E1; two of these tests initially had authoring bugs (a naive substring match against this file's own doc-comment mention of "localStorage", and an attribute-vs-text-order regex mismatch) caught and fixed during verification — the implementation needed no fixes.

### 26.19 Tests — end-to-end contract

`lib/governance/__tests__/adaptiveReviewEndToEndContract.spec.ts` (5 tests) — exercises the REAL detail GET route and the REAL decision POST route together against one shared in-memory Firestore-like fake. Only the Firestore Admin SDK and team-auth boundaries are mocked; the concurrency token itself is never mocked away. Proves, against real route code: detail's `updatedAt` is accepted as `expectedUpdatedAt`; a second submission with the original (now stale) token is rejected; a submission against an already-terminal record is rejected as `terminal_review_exists` specifically (not conflated with staleness); sibling `governanceRecord` fields are untouched.

### 26.20 Existing Part E1 test correctly rescoped, not broken

`components/teamGovernance/__tests__/readOnlyIsolation.spec.ts` originally asserted the ENTIRE `components/teamGovernance/` tree had zero mutation capability — true in Part E1, and now legitimately false for the detail page. Rescoped to check only the QUEUE-browsing surface (`TeamReviewQueue`, `TeamReviewFilters`, list items, badges, empty/error states) remains strictly read-only; the decision form's own isolation guarantees moved to a new, dedicated file (§26.7). Net test count unchanged (6 → 6) — this was a scope correction, not new coverage.

### 26.21 API regression status

Reviewed the existing Part D decision-route test suite (`adaptiveHumanReviewRoute.spec.ts`) against every item on the required regression checklist — every one is already covered by an exact `toEqual` response-shape assertion and explicit error-code checks from Part D itself. No new route test file was added; rewriting already-comprehensive, passing coverage was avoided per instruction.

### 26.22 Files changed

New: `lib/governance/adaptiveReviewFormContract.ts`, `lib/client/adaptiveReviewSubmission.ts`, `components/teamGovernance/AdaptiveReviewDecisionForm.tsx`, `AdaptiveReviewDecisionOption.tsx`, `AdaptiveReviewConditionsEditor.tsx`, `AdaptiveReviewSubmissionResult.tsx`, and 6 new test files. Modified: `components/teamGovernance/AdaptiveReviewDetail.tsx` (form wired in, canonical refresh logic added), `components/teamGovernance/__tests__/readOnlyIsolation.spec.ts` (rescoped, §26.20). **Not modified at all** (confirmed via `git diff --stat`, empty): the Part D decision route, the Part E1 detail GET route, `policyEngine.ts`, `teamGovernancePipeline.ts`, `firestore.indexes.json`, `firestore.rules`.

### 26.23 Tests added and verification

66 new tests across 6 new files (24+12+5+13+7+5), plus the net-zero rescope of one existing file. Full suite: 1,807 → 1,873, exact match. Full Jest run twice (both: 107 suites / 1,873 tests / 56 snapshots, all passing), `tsc --noEmit` clean, `next lint` clean (pre-existing warnings only).

### 26.24 What remains

Reviewer assignment, multiple reviewers, review history, reopening terminal decisions, comment threads, quorum, adaptive export, `admin_audit_logs`, indexed cursor pagination, automated-governance reevaluation, and receipt refresh all remain unimplemented — none of them were in scope for Part E2, and none were started.

## 27. Immutable Adaptive Review History and Admin Audit Integration (implemented, 2026-07-30)

Adds an immutable, canonical review-history record and integrates adaptive decisions into the existing admin audit surface. Phase 2A's decision workflow (§21-§26) is otherwise unchanged — `governanceRecord.humanReview` remains the sole canonical CURRENT state; this step adds an append-only, secondary LIFECYCLE record of each committed decision, plus a metadata-safe entry in the existing org-wide admin audit log.

### 27.1 Audit findings — existing infrastructure

Two DIFFERENT functions already write to the SAME `admin_audit_logs` Firestore collection, with two incompatible schemas: `lib/governance/auditLog.ts`'s `writeAuditEvent()` (governance/review actions — `evaluated`/`approved`/`blocked`/`changes_requested`/`policy_updated`/`admin_override`/`admin_deleted`) and `lib/admin/auditLog.ts`'s `writeAuditLog()` (billing/entitlement admin actions — `GRANT_OVERRIDE`/`CANCEL_SUB`/etc., entirely unrelated). Only the first is relevant here. **`writeAuditEvent()` uses `.add()` — a RANDOM Firestore document ID, with no idempotency protection at all** — confirming duplicate writes are already structurally possible for every existing caller; this step does not fix that for legacy callers (out of scope), but does not reuse `.add()` for the new adaptive action either, for exactly this reason.

**Critical finding, resolved before writing any code:** the existing READER (`app/api/governance/audit/route.ts`) has a hard-coded, strict action allowlist (`GOVERNANCE_ACTIONS`/`AUDIT_LOG_DISPLAY_ACTIONS`) — a document written with any action outside that Set is filtered out and never reaches the client at all. This is NOT "renders unknown actions safely" (the UI's own badge/label components DO have a safe generic fallback, but the ROUTE never lets an unrecognized action reach them) — so per the instruction's own branching, explicit additive action typing was required, not optional polish.

`governanceEvents` (Part D's existing `writeAdaptiveHumanReviewEvent()`) also uses `.add()` (random ID) — left completely unchanged; per instruction, the duplicate risk is documented, not silently re-engineered, since the existing decision route already never retries within a single request and this event's own ID scheme is Part D's already-shipped, tested decision.

No new Firestore index was needed: the write is a plain `.doc(id).create()` (no query), and the existing reader's queries (`.orderBy("at","desc")`, `.where("runId","==",...)`) both already work against any document in the collection regardless of shape.

### 27.2 Decision ID strategy — chosen, and why

**Not** the "preferred stronger" option (a new `decisionId` field persisted inside `GovernanceRecordV1.humanReview`). That would require changing `applyHumanReviewUpdate()`'s field-by-field reconstruction, `isValidHumanReview()`'s validator, and the `GovernanceRecordV1` type itself — all Part D, already shipped, and covered by a wide web of exact-shape `toEqual` tests. **Chosen instead:** a deterministic SHA-256 hash of `` `${teamId}:${runId}:${reviewedAt}:${newStatus}` ``, truncated to 32 hex chars and prefixed `dec_` (`buildAdaptiveReviewDecisionId()`, `lib/governance/adaptiveHumanReviewHistory.ts`), computed entirely at the ROUTE layer AFTER the existing transaction commits. Every stated guarantee holds (same decision → same ID; distinct decisions → distinct ID; no client control; safe Firestore document ID) and the "no raw team/run values leaked" guarantee is actually STRONGER than a stored field would give, since the ID itself is a hash, not a concatenation. Zero changes to Part D's transaction, persistence, or parser code were needed.

### 27.3 Immutable history model

`AdaptiveHumanReviewHistoryV1` (`lib/governance/adaptiveHumanReviewHistory.ts`) — metadata only: `version, kind, historyId, decisionId, runId, teamId, schemaId, answerShape, priorStatus, newStatus, reviewerId, reviewedAt, governanceRecordUpdatedAt, commentPresent, conditionsCount, createdAt`. Never the raw question, receipt conclusion, full receipt, sources, automated-governance reasons, model output, full comment, full conditions, team settings, or policy internals — `commentPresent`/`conditionsCount` capture shape without content.

### 27.4 Storage location and create-only semantics

`runs/{runId}/humanReviewHistory/{decisionId}` — a new subcollection of the canonical `runs/{runId}` document, distinct from `governanceEvents` (governance-domain event stream) and `admin_audit_logs` (administrative surface); the three are never collapsed into one collection. `createAdaptiveHumanReviewHistory()` (`lib/firestore/runs.ts`) uses `.doc(decisionId).create()` — exactly like `createAdaptiveTeamRunProjection()` (Part C) — never `.set()`/merge, throwing `ALREADY_EXISTS` (treated as idempotent success) rather than silently overwriting. No collection-wide unbounded query is ever performed against it (the read endpoint scopes to one run's subcollection only). Default-deny Firestore client rules remain fully sufficient, since access is API-only (Admin SDK), matching every other collection in this system.

### 27.5 Write order and canonical-success semantics

Unchanged from Part D up through the canonical transaction commit. AFTER commit: projection sync (unchanged) → governance event (unchanged) → **decisionId computed → immutable history created → admin audit written** → response returned. Every one of the last three steps is best-effort and independently failure-isolated — none can invalidate the already-committed canonical decision, none triggers an HTTP error, and none is retried automatically. Response extended additively: `historyStatus: "recorded"|"already_exists"|"failed"`, `auditStatus: "recorded"|"already_exists"|"failed"` — no internal document ID is ever returned.

### 27.6 History writer

`createAdaptiveHumanReviewHistory()` — create-only, exactly one write attempt, no retry, `ALREADY_EXISTS` treated as idempotent success, metadata-only logging on failure (never the comment/conditions), never mutates `governanceRecord` or the `teamRuns` projection. A dedicated test proves a second write with DIFFERENT content (a different status) cannot overwrite the first stored document.

### 27.7 Admin audit writer

`writeAdaptiveAdminAuditEvent()` (`lib/governance/auditLog.ts`, additive — `writeAuditEvent()` itself and all its existing call sites are completely untouched) — writes `action: "adaptive_human_review_decided"` to the SAME `admin_audit_logs` collection, but via `.doc(` `` `adaptive-review:${decisionId}` `` `).create()` instead of `.add()`, giving genuine idempotency `writeAuditEvent()` never had. Stored fields: `action, byUid, at, teamId, runId, collection, schemaId, answerShape, prevStatus, nextStatus, decisionId, outcome, source` — never comment, conditions, question, receipt content, sources, model output, governance reasons, raw request body, or a raw Firestore error.

### 27.8 GovernanceEvents coordination

Left completely unchanged, per §27.1's own finding — no silent rewrite of already-shipped Part D infrastructure. The three collections' distinct roles are preserved: immutable history = run-scoped lifecycle record; `governanceEvents` = governance-domain event stream; `admin_audit_logs` = administrative audit surface.

### 27.9 Repair service

`repairAdaptiveReviewArtifacts(runId, teamId)` (`lib/governance/adaptiveReviewArtifactRepair.ts`) — internal, idempotent, not exposed via any route in this step (no protected admin-repair pattern exists yet to reuse) and not scheduled. Reads the canonical terminal `humanReview`, derives the same deterministic `decisionId`, creates whichever of history/audit is missing (both independently idempotent), and never touches `governanceRecord`, never reopens a review, never rewrites the projection. `priorStatus` for a repaired record uses a fixed, documented convention (`"unreviewed"`) since the canonical record no longer carries which of `unreviewed`/`pending` preceded a terminal decision once it has already committed — never fabricated as if positively known.

### 27.10 History read endpoint

`GET /api/teams/adaptive-runs/{runId}/history` — identical authorization pattern to the Part E1 detail route (deterministic projection lookup as primary tenant isolation, defensively re-checked against stored fields; cross-team existence never disclosed, surfacing as the same `projection_missing`/`404` either way). Response: `{ok, version: 1, runId, items: [{priorStatus, newStatus, reviewedAt, commentPresent, conditionsCount}]}` — never `reviewerId`, `reviewerName`, `comment`, `conditions`, `teamId`, `userId`, or raw governance data. Ordered `reviewedAt` ascending, tie-broken by the internal `historyId` (never exposed). No pagination — a run has at most one committed decision today, by construction (terminal states are immutable).

### 27.11 History UI section

`AdaptiveReviewHistorySection` (`components/teamGovernance/`) — a new, self-contained "Review History" section on `/team/reviews/{runId}`. States: loading, one history item (decision label, reviewed time, comment-present indicator, conditions count, "Immutable decision record" tag), no history yet (non-terminal record), and the missing-artifact race case — **"The review decision is saved, but its history record is still being recorded"** — shown specifically when the canonical record is terminal but the history endpoint returned zero items (a real, disclosed race the write-ordering in §27.5 can produce if the secondary write fails). No client-side repair button or any button at all — verified structurally (no `<button>`, no `onClick` anywhere in the file).

### 27.12 Admin audit UI compatibility

Two additive changes only, both to already-existing, otherwise-untouched files: `app/api/governance/audit/route.ts` gained `"adaptive_human_review_decided"` in its `AuditAction` type and both action Sets (without this, the document would be silently invisible, per §27.1's finding); `GovernanceDashboard.tsx` gained one small label-lookup (`governanceAuditActionDisplayLabel()`) giving the new action the recommended "Adaptive review decided" phrasing, falling through unchanged to the existing generic `action.replace(/_/g," ").toUpperCase()` transform for every other action. No new admin dashboard; comment/conditions are never displayed (never even present in the stored document).

### 27.13 Malformed and missing data

History writer: malformed/unsupported-version canonical record, missing team/run identity, or invalid status metadata all fail WITHOUT a write; an already-existing history record is treated as idempotent success. History read: unauthenticated → 401; no team/member → 403; cross-team/missing projection/missing parent run → 404 (never distinguished from each other in the response); malformed or unsupported-version history rows are skipped and logged (metadata only), never exposed; Firestore unavailable → 503. Admin audit: a write failure never changes canonical success; a malformed duplicate attempt is never overwritten (create-only); raw errors are never exposed to any caller.

### 27.14 Privacy and logging

Comment, conditions, question, receipt content, sources, reviewer name/email, model output, governance reasons, and raw request bodies are never logged anywhere in this step's new code — every new `logger.warn`/`console.error` call was written with only `runId`/`teamId`/`decisionId`/a fixed failure category, verified directly (not assumed) across every new writer.

### 27.15 Manual verification — real, partial, honestly disclosed

**Genuinely performed** (not simulated): started the local dev server against real project data; confirmed `/team/reviews` still renders the correct "No team" gate for a real signed-in test account (screenshot-verified); confirmed via REAL HTTP requests against the running server that the new `GET .../history` route, the modified `POST .../decision` route, and the modified `GET /api/governance/audit` route all compile, deploy, and correctly return `401`/`403` for unauthenticated/unauthorized requests with no server errors (confirmed via server request logs, e.g. `GET /api/teams/adaptive-runs/nonexistent-run-id/history 401 in 2199ms`); confirmed zero browser console errors on every page that did render.

**Not verified via screenshot, disclosed honestly:** the System A `/governance` Queue tab's screenshot capture repeatedly failed with a browser-extension-side "script injection timeout" — traced to the tab being genuinely busy for ~27 real seconds processing a large live Firestore query (`/api/governance/queue`, 62+35+46 documents, confirmed via server logs, unrelated to any code in this step) rather than an application bug. The actual submit-review-and-verify-history round trip (create a real decision, see the real history entry and real admin-audit entry render in the UI) was **not** performed, since it requires a real team + a real adaptive run with a committed decision, which was not created in this session (would be a consequential, persistent action). This is covered instead by the automated end-to-end contract test (§27.17), which exercises the real detail, decision, and history routes together against a shared fake, and by the real HTTP checks above confirming every route is live, reachable, and crash-free against the actual dev server.

### 27.16 Files changed

New: `lib/governance/adaptiveHumanReviewHistory.ts` (model, decisionId, history builder, read-side classifier/sort), `lib/governance/adaptiveReviewArtifactRepair.ts`, `app/api/teams/adaptive-runs/[runId]/history/route.ts`, `components/teamGovernance/AdaptiveReviewHistorySection.tsx`, and 8 new test files. Modified (additive only): `lib/firestore/runs.ts` (+`createAdaptiveHumanReviewHistory`), `lib/governance/auditLog.ts` (+`writeAdaptiveAdminAuditEvent`), `app/api/teams/adaptive-runs/[runId]/decision/route.ts` (secondary writes + response extension), `components/teamGovernance/AdaptiveReviewDetail.tsx` (history section wired in), `app/api/governance/audit/route.ts` (+1 action), `components/governance/GovernanceDashboard.tsx` (+1 label). One existing Part D test file's exact-shape response assertion updated to include the two new fields (a required, expected update, not a regression fix).

### 27.17 Tests added and verification

87 new tests across 8 new files (15+7+7+10+16+13+6+5), plus 8 new end-to-end assertions added to the existing Part E2 contract test file (which required extending its shared in-memory Firestore fake to support the two new collections). Full suite: 1,873 → 1,960, exact match. Full Jest run twice (both: 115 suites / 1,960 tests / 56 snapshots, all passing), `tsc --noEmit` clean, `next lint` clean (pre-existing warnings only).

### 27.18 What remains

Reviewer assignment, multiple reviewers, reopening terminal decisions, comment threads, quorum, adaptive export, indexed cursor pagination, automated-governance reevaluation, receipt refresh, and any change to legacy System B all remain unimplemented — none were in scope for this step, none were started.

## 28. Single-Reviewer Assignment for Adaptive Human Review (Part E3) (implemented, 2026-07-30)

Adds an optional, single-reviewer assignment capability on top of the existing adaptive human-review workflow. `governanceRecord.humanReview` (Part D) remains the sole canonical decision state — assignment is a separate, additive metadata concern that narrows WHO among already-authorized admins may submit, never grants permission by itself, and never alters the decision, its history (§27), governanceEvents, receipts, or policy evaluation.

### 28.1 Audit findings

Team membership (`TeamDocument.members`, `lib/governance/teamTypes.ts`) is a flat array of `{uid, email, role, joinedAt}` — there is no `inactive`/`removed`/`pending`/`disabled` member state in this codebase; removal means the entry no longer exists in the array. "Eligible reviewer" and "not a member" are therefore the only two states that actually exist here — confirmed before writing any code, not assumed. The existing decision-submission gate (`isTeamAdmin(role)`, `lib/teams/teamApiAuth.ts`) accepts `owner`|`admin` only — assigning a plain `member` would create an assignment no one could ever fulfill, so `ELIGIBLE_REVIEWER_ROLES` is restricted to the same two roles the existing gate already accepts. No separate "assignment" role exists or was invented. Firestore rules/indexes required no change: the new document is written via the Admin SDK only (default-deny client rules already sufficient, matching every other collection in this system) and is read by direct-ID `.get()`, never a query.

### 28.2 Storage model — chosen, and why

`runs/{runId}/humanReviewAssignment/current` — a new subcollection with a single fixed document ID, distinct from `governanceRecord`, `humanReviewHistory` (§27), and the new `humanReviewAssignmentHistory` below. **Not** a field added to `governanceRecord.humanReview` itself: that would touch Part D's already-shipped, exact-shape-tested `applyHumanReviewUpdate()`/`isValidHumanReview()`/`GovernanceRecordV1` — this way, zero Part D code changed. `AdaptiveHumanReviewAssignmentV1` (`lib/governance/adaptiveHumanReviewAssignment.ts`): `schemaVersion, teamId, runId, assignedReviewerUserId, assignedAt, assignedByUserId, updatedAt, updatedByUserId, revision`. Never reviewer email, display name, avatar, comments, IP, user agent, prompt, evidence, model output, or decision content — display name is resolved at READ time only (§28.9). Written via `.set()`, not `.create()` — unlike the immutable history subcollections, this is a single, fixed-ID, intentionally MUTABLE record; safety comes from the `revision` optimistic-concurrency counter (§28.6), not create-only semantics. A run with no assignment document is valid, existing, unassigned — no migration was needed or performed, verified by a dedicated test (`getAdaptiveHumanReviewAssignment` returns `{status:"unassigned"}` for a run with no document).

### 28.3 Eligibility and authorization

Eligible reviewer: an active team member (present in `team.members`) whose role is in `ELIGIBLE_REVIEWER_ROLES` (`owner`|`admin` — §28.1). Assigning a plain member, or a non-member userId, is rejected at the route layer with `400` before ever calling the writer. Assignment mutation authorization: the SAME `isTeamAdmin(role)` gate the assignment route's GET/PUT/DELETE already require — no hidden superuser bypass, no new permission invented. Viewing (`GET`) and mutating (`PUT`/`DELETE`) are gated by this identical check in this codebase (there is no third "can view but not manage" tier here — confirmed by audit, not assumed) — kept as textually separate authorization checks in the route regardless, so a future permission split would only require loosening one, not restructuring both. Assignment itself never grants review-submission permission — the assignee must still independently pass `isTeamAdmin()` at decision-submission time (§28.4); proven by a dedicated test that a plain member cannot be assigned in the first place, and that assignment presence is never consulted before the baseline admin check in the decision route.

### 28.4 Review-submission restriction

The decision route (`POST .../decision`) gained the SMALLEST additive check §20 allows: immediately after the existing `isTeamAdmin` gate and before request-body validation, it calls `getAdaptiveHumanReviewAssignment(runId)`; if a reviewer is assigned and the caller is neither that reviewer nor holds the override permission (§28.5), it returns `403 reviewer_assigned` — never `404` (never used to conceal the run's existence). Unassigned runs are completely unaffected — the existing decision flow runs exactly as before, proven by a dedicated regression test. A failed assignment lookup (`firestore_unavailable`/`read_failed`) fails OPEN — treated as unassigned for this check only — a deliberate, documented asymmetry from the assignment mutation's own fail-CLOSED revision/pending checks (§28.6), reasoned as: a transient assignment-lookup hiccup must never block an otherwise-legitimate decision submission, while the canonical decision transaction underneath remains the true source of truth regardless.

### 28.5 Administrative override permission

`hasAdaptiveReviewSubmissionOverride(role)` — true only for team `owner`, deliberately narrower than the `owner`|`admin` tier used for assignment mutation itself (§28.3). Chosen because using the same `isTeamAdmin` tier for the override would make the restriction meaningless on any team with multiple admins (any admin could simply invoke "override" to bypass any assignment) — owner-only keeps the override a genuine escape hatch, not a routine bypass. Proven by a dedicated test that a plain (non-owner) admin does NOT receive the override.

### 28.6 Completed-review behavior, idempotency, and concurrency

Assignment is mutable only while `isHumanReviewStatusReviewable(humanReview.status)` is true (the same predicate Part D already uses) — re-checked FRESH inside the assignment transaction on every call, never trusted from a pre-transaction read. This closes the race between review completion and a concurrent assignment mutation by construction: whichever transaction's own read observes the run document LAST sees the true, up-to-date status, so a mutation can never commit against a stale "still pending" assumption — proven directly by a dedicated test where the run is already terminal by transaction-read time. Once terminal, a mutation attempt returns `409 not_pending`; the final assigned reviewer (if any) remains visible via GET, read-only. Optimistic concurrency uses `revision: number` (not a timestamp, unlike `expectedUpdatedAt` for decisions — this document has no other concurrent writer whose timestamp could double as a token, so a simple incrementing integer suffices). Two mutations submitted with the same `expectedRevision` — whether two initial assignments or two reassignments from the same non-zero revision — never both succeed: the second always observes `stale_revision`, proven by dedicated tests for both cases.

### 28.7 Assignment history

`runs/{runId}/humanReviewAssignmentHistory/{eventId}` — metadata-only, create-only, mirroring §27.4's pattern exactly: `schemaVersion, eventId, teamId, runId, eventType ("assigned"|"reassigned"|"unassigned"), previousReviewerUserId, newReviewerUserId, assignmentRevision, changedAt, changedByUserId`. `eventId = String(assignmentRevision)` — simpler than §27.2's SHA-256 decisionId hash, since `revision` is already a guaranteed-unique, strictly-incrementing per-run integer; no separate hash was needed. `.doc(eventId).create()`, `ALREADY_EXISTS` treated as idempotent success, never overwritten — proven by a dedicated test that a retried write with different content cannot alter the stored entry. Never reviewer name/email, comments, prompt, evidence, output, or decision content.

### 28.8 Admin audit integration

Three new actions — `adaptive_human_review_reviewer_assigned`, `_reassigned`, `_unassigned` — added through the exact additive typing/allowlist mechanism §27.1/§27.12 established: appended to `AuditAction`, `GOVERNANCE_ACTIONS`, and `AUDIT_LOG_DISPLAY_ACTIONS` in `app/api/governance/audit/route.ts` (all pre-existing entries untouched), plus one small label branch in `GovernanceDashboard.tsx`'s `governanceAuditActionDisplayLabel()` ("Reviewer assigned"/"reassigned"/"unassigned"), falling through unchanged for every other action. `writeAdaptiveAssignmentAdminAuditEvent()` (`lib/governance/auditLog.ts`, additive — `writeAuditEvent()` and `writeAdaptiveAdminAuditEvent()` untouched) writes to the same `admin_audit_logs` collection via `.doc(` `` `adaptive-review-assignment:${runId}:${assignmentRevision}` `` `).create()` — deterministic, idempotent, exactly one logical event per mutation, retries never duplicate. Stored fields: `action, byUid, at, teamId, runId, collection, previousReviewerUserId, newReviewerUserId, assignmentRevision` — never email, display name, comments, prompt, evidence, output, decision content, or a full profile. Proven the reader does not silently drop the 3 new actions: a dedicated `it.each` integration test confirms all three pass through `GET /api/governance/audit` to the viewer who performed them.

### 28.9 Route and response contract — deliberate deviations from the suggested shape

`GET/PUT/DELETE /api/teams/adaptive-runs/{runId}/assignment` — **not** the suggested `/api/teams/{teamId}/runs/{runId}/human-review/assignment`, because that shape would put a client-supplied `teamId` in the URL, violating this codebase's established "never accept teamId from the client" principle (matching every other adaptive-runs route); `teamId` is always server-derived via `loadUserAndTeam(uid)`. GET always returns a non-null `assignment` object (`{assignedReviewerUserId: null, ..., revision: 0}` when unassigned, not `assignment: null`) so the client always has a valid `revision` to construct its first PUT, plus `eligibleReviewers: [{userId, displayName}]` restricted to `owner`|`admin` members. Display names are resolved at READ time only, never stored: `users/{uid}.name` if present, else `maskEmail(teamRosterEmail, callerEmail)` — the exact existing helper and precedent already used by `GovernanceDashboard.tsx`, which intentionally leaves the CALLER's own email unmasked while masking everyone else's. PUT body `{assignedReviewerUserId, expectedRevision}`; DELETE `{expectedRevision}`, unassigning without requiring a reviewer ID. Canonical failure-reason → HTTP mapping: `not_pending`/`stale_revision` → 409, `run_missing`/`projection_missing` → 404, `firestore_unavailable` → 503, ineligible/malformed input → 400, authorization failures → 401/403. Secondary-write ordering matches §27.5 exactly: commit assignment transactionally → best-effort assignment-history → best-effort admin-audit → return canonical success (`historyStatus`/`auditStatus` in the response) even if either secondary write fails; neither failure ever rolls back or falsely reports the mutation as failed.

### 28.10 Repair service

`repairAdaptiveHumanReviewAssignmentArtifacts(runId)` (`lib/governance/adaptiveHumanReviewAssignmentRepair.ts`) — internal only, not exposed via any route or UI button (matching §27.9's own precedent), idempotent, never modifies the current assignment document, never reopens or changes a decision. **Honest, disclosed limitation:** the current assignment document stores only the CURRENT reviewer, not the prior one — `previousReviewerUserId` can only be reconstructed as `null` at `revision === 1` (the assignment's first-ever mutation, where "no prior reviewer" is positively known); for `revision > 1`, the function explicitly refuses to fabricate a guess and returns `{status:"cannot_reconstruct", reason:"previous_reviewer_unknown_for_revision_greater_than_one", revision}` rather than inventing a plausible-looking event. Proven by dedicated tests for both the reconstructable and non-reconstructable cases.

### 28.11 Reviewer section UI

`AdaptiveReviewAssignmentSection` (`components/teamGovernance/`), wired into `AdaptiveReviewDetail.tsx` immediately above the existing "Review History" section. Per §28.3's audit finding that every viewer of this page already holds the SAME `isTeamAdmin` permission the assignment route requires to mutate, the section always shows both the current assignment and, while the review is pending, full management controls (eligible-reviewer select, Assign/Reassign, Unassign) — there is no distinct "can view but not manage" viewer in this codebase to build a separate read-only variant for. It always shows a clear "Assigned to you" indicator when the current viewer is the assigned reviewer, and a short explanation ("assigned to another reviewer... only that reviewer, or a team owner, may submit") when they are not. Loading, empty-eligible-list, success, and error states are all handled; after the review completes, controls disappear entirely in favor of a fixed "read-only" notice. Stale-revision and not-pending conflict responses from a mutation trigger an automatic reload rather than a dead-end error. Never renders: multiple-reviewer controls, comments, notes, chat/discussion threads, notifications, due dates, workload info, quorum controls, reopening controls, or an avatar image — verified structurally (no `<img>`, no "comment"/"quorum"/"workload"/etc. token anywhere in the component's code, checked separately from its own doc comment that lists these exclusions).

### 28.12 Privacy exclusions — summary

Across every new artifact (assignment document, assignment-history entry, admin-audit event, and both API responses): never reviewer email, display name (except the READ-time-resolved, masked value in the GET/mutation response), avatar, comments, IP address, user agent, prompt content, evidence, model output, decision content, or a full user profile. Every exclusion is proven by a dedicated `not.toHaveProperty`/`not.toContain` test at the layer it applies to (model builders, admin-audit writer, route response serialization).

### 28.13 Malformed and missing data

Assignment mutation: missing/malformed `expectedRevision`, missing/non-member/ineligible-role `assignedReviewerUserId` → `400`, no write attempted. Missing parent run → `run_missing`/404. Absent or malformed `governanceRecord` → dedicated failure reasons, no write. Firestore unavailable → `firestore_unavailable`/503 on every read and write path, never throwing. Assignment read: no document → `{status:"unassigned"}` (the default, migration-free state), never an error. History/audit writers: Firestore unavailable or an unexpected error → `"failed"`, never exposing the raw underlying error; canonical mutation success is always returned regardless.

### 28.14 Manual verification — real, partial, honestly disclosed

**Genuinely performed:** started the local dev server against real project configuration; confirmed Firebase Admin initializes successfully; confirmed via real HTTP requests against the running server that the new `GET /api/teams/adaptive-runs/{runId}/assignment` route compiles, deploys, and correctly returns `401` for an unauthenticated request with no server error (`GET /api/teams/adaptive-runs/test-run-id/assignment 401`, confirmed via server logs); confirmed `/team/reviews/{runId}` (now rendering the new `AdaptiveReviewAssignmentSection` import) still returns `200` and compiles without error.

**Not verified via an authenticated browser session, disclosed honestly:** the full interactive assign → reassign → unassign flow, the "Assigned to you" indicator, the non-assigned-reviewer restriction message, and the live 403/409 UI error paths were not exercised against a real signed-in session with a seeded team and a reviewable adaptive run — creating that state would be a consequential, persistent action not performed in this session, matching the same disclosed limitation as §27.15. This is covered instead by: the route-level contract tests (§28's test suite, 29 tests) which exercise every one of those response shapes and status codes directly against the real route handler; the transaction-level tests (21 tests) which exercise the real Firestore-shaped transaction logic including the concurrency and race-closure proofs; and the structural UI tests (10 tests) which prove the component's initial-render state and every required/forbidden piece of markup exist in its source, per the same `renderToStaticMarkup`-plus-source-inspection method used for every other UI component in this engagement (documented limitation: this method cannot exercise the async fetch-driven states — loaded, error, mutation success — that require a real or mocked network response).

### 28.15 Files changed

New: `lib/governance/adaptiveHumanReviewAssignment.ts` (model, eligibility, override, event classifier, history-entry builder), `lib/governance/adaptiveHumanReviewAssignmentRepair.ts`, `app/api/teams/adaptive-runs/[runId]/assignment/route.ts`, `components/teamGovernance/AdaptiveReviewAssignmentSection.tsx`, and 6 new test files. Modified (additive only): `lib/firestore/runs.ts` (+`getAdaptiveHumanReviewAssignment`, `submitAdaptiveHumanReviewAssignment`, `createAdaptiveHumanReviewAssignmentHistory`), `lib/governance/auditLog.ts` (+`writeAdaptiveAssignmentAdminAuditEvent`), `app/api/teams/adaptive-runs/[runId]/decision/route.ts` (§28.4's restriction block only), `components/teamGovernance/AdaptiveReviewDetail.tsx` (+1 import, +1 JSX line), `app/api/governance/audit/route.ts` (+3 actions), `components/governance/GovernanceDashboard.tsx` (+3 label branches). Two existing test files extended additively (new mocked export + new describe/it.each blocks), no existing assertion altered. No Firestore rules or indexes changed.

### 28.16 Tests added and verification

98 new tests across 6 new files (13+21+7+29+8+10), plus 10 new assertions added to 2 existing test files (+7 decision-route restriction tests, +3 audit-action pass-through tests) — no existing test in either file was altered. Full suite: 1,960 → 2,058, exact match. Full Jest run twice (both: 121 suites / 2,058 tests / 56 snapshots, all passing), `tsc --noEmit` clean, `next lint` clean (pre-existing warnings only, none in any new or modified file).

### 28.17 What remains

Multiple reviewers, reviewer groups, quorum, comments/discussion threads, reopening, escalations, notifications, due dates, workload balancing, auto-assignment, automatic governance reevaluation on reassignment, adaptive export changes, and receipt regeneration all remain unimplemented — none were in scope for Part E3, none were started.

## 29. Multi-Reviewer and Quorum Governance for Adaptive Human Review — Architecture and Implementation Plan (DESIGN ONLY — NOT IMPLEMENTED, 2026-07-31)

**This entire section is a design document.** No production code, route, schema, Firestore write, UI, index, rule, test, or migration was added or changed to produce it. It designs the next safe extension from Part E3's single-reviewer assignment to a governed multi-reviewer, quorum-based workflow. Nothing in this section is live.

### 29.1 Audit of the current single-reviewer implementation

Re-inspected directly (not from memory) before writing any design:

- **`runs/{runId}/humanReviewAssignment/current`** (`lib/governance/adaptiveHumanReviewAssignment.ts`, `lib/firestore/runs.ts`) — a single, fixed-ID, MUTABLE document: `{schemaVersion: 1, teamId, runId, assignedReviewerUserId: string|null, assignedAt: string|null, assignedByUserId: string|null, updatedAt, updatedByUserId, revision: number}`. Exactly one reviewer slot. Written via `.set()`, guarded by `revision` optimistic concurrency (not a timestamp — this document has no other concurrent writer).
- **`runs/{runId}/humanReviewAssignmentHistory/{revision}`** — immutable, create-only, `eventId = String(revision)`, `{eventType: "assigned"|"reassigned"|"unassigned", previousReviewerUserId, newReviewerUserId, assignmentRevision, changedAt, changedByUserId}`.
- **PUT/DELETE transaction flow** (`submitAdaptiveHumanReviewAssignment`, `lib/firestore/runs.ts`): inside one Firestore transaction — `Promise.all([txn.get(runRef), txn.get(assignmentRef)])` → parse `governanceRecord` fresh → confirm `isHumanReviewStatusReviewable(humanReview.status)` (re-checked on every call, never trusted from a pre-transaction read — this is what closes the completion/mutation race) → confirm `assignmentSnap`'s `revision` matches `expectedRevision` → `buildNextAdaptiveHumanReviewAssignment()` (pure) → `txn.set()`. One document written per transaction.
- **Authorization**: `isTeamAdmin(role)` — `role === "owner" || role === "admin"` (`lib/teams/teamApiAuth.ts`) — identical gate for viewing (GET) and mutating (PUT/DELETE) the assignment; there is no third "can view but not manage" tier anywhere in this codebase today.
- **Owner override**: `hasAdaptiveReviewSubmissionOverride(role) = role === "owner"` — deliberately narrower than the `isTeamAdmin` tier used for assignment mutation, so it remains a genuine escape hatch on multi-admin teams.
- **Eligibility**: `ELIGIBLE_REVIEWER_ROLES = {"owner","admin"}` — the exact same two roles `isTeamAdmin` already accepts; a plain `member` cannot be assigned, because assignment never grants permission on its own (the assignee must independently pass `isTeamAdmin` at submission time).
- **Assignment lookup in the decision route** (`app/api/teams/adaptive-runs/[runId]/decision/route.ts`): a single `getAdaptiveHumanReviewAssignment(runId)` call, OUTSIDE any transaction, immediately after the baseline `isTeamAdmin` check and before body validation. If assigned and the caller is neither the assignee nor `hasAdaptiveReviewSubmissionOverride`, returns `403 reviewer_assigned`. A lookup failure (`firestore_unavailable`/`read_failed`) fails OPEN — treated as unassigned for this check only, a deliberate, documented asymmetry.
- **Canonical `humanReview` transaction** (`submitAdaptiveHumanReview`, `lib/firestore/runs.ts`): one document (`runs/{runId}`), one transaction, reads `governanceRecord` fresh, checks `record.updatedAt !== expectedUpdatedAt` (stale check) BEFORE `isHumanReviewStatusReviewable` (terminal check), calls the pure `applyHumanReviewUpdate()`, writes ONLY `governanceRecord.humanReview` and `governanceRecord.updatedAt` via nested field paths. `GovernanceRecordV1.humanReview` shape: `{status: HumanReviewStatus, reviewerId?, reviewerName?, reviewedAt?, comment?, conditions?}`. **`HumanReviewStatus` = `"unreviewed"|"pending"|"approved"|"approved_with_conditions"|"changes_requested"|"rejected"`; `isHumanReviewStatusReviewable = status === "unreviewed" || status === "pending"`** — meaning ALL FOUR of `approved`/`approved_with_conditions`/`changes_requested`/`rejected` are already terminal today. There is no "send back for revision, then re-review" loop anywhere in the current system — `changes_requested` is a dead-end terminal state exactly like `approved`/`rejected`. This is an inherited, load-bearing constraint on the entire multi-reviewer design below: aggregation can never invent a 5th outcome, and it cannot reopen a terminal record.
- **`runs/{runId}/humanReviewHistory/{decisionId}`** — immutable, create-only, deterministic SHA-256 `decisionId`, metadata only (status/timing/`commentPresent`/`conditionsCount`, never comment/condition text).
- **`admin_audit_logs`** — two idempotent, deterministic-ID writers exist (`writeAdaptiveAdminAuditEvent` for decisions, `writeAdaptiveAssignmentAdminAuditEvent` for assignment mutations), both via `.doc(id).create()`, both additive to a hard-coded reader allowlist (`app/api/governance/audit/route.ts`) that silently drops any unlisted action.
- **`governanceEvents`** — `writeAdaptiveHumanReviewEvent()` still uses `.add()` (random ID, no idempotency) — a known, documented, un-fixed gap for this one legacy-shaped writer, left untouched by every step so far.
- **`teamRuns/{teamId}:{runId}`** — a deterministic-ID projection document, created once by Part C, synced ONLY for `humanReviewStatus`/`reviewedAt`/`updatedAt` after a review commits (`syncAdaptiveTeamRunProjectionAfterReview`). It has never carried assignment or (now) panel information — a pure queue-list projection, never a source of governance truth.
- **Adaptive detail endpoint** (`GET /api/teams/adaptive-runs/{runId}`, `lib/governance/adaptiveReviewDetail.ts`) and **UI** (`AdaptiveReviewDetail.tsx` + `AdaptiveReviewAssignmentSection.tsx`) — read canonical `governanceRecord` plus (separately) the assignment document; the UI section always shows both status and full management controls to any viewer, since every viewer already holds the same `isTeamAdmin` permission assignment mutation requires (no separate read-only viewer tier exists to build for).
- **Team membership shape** (`lib/governance/teamTypes.ts`): `TeamDocument.members: TeamMember[]`, flat array, `{uid, email, role: "owner"|"admin"|"member", joinedAt}`. **No `inactive`/`removed`/`pending`/`disabled` state exists anywhere in this model** — removal means absence from the array. A `// TODO: move members to subcollection for teams > 100` comment already exists on `TeamDocument`, flagging that TEAM membership (potentially hundreds) may someday need to move off a single array; this does NOT transfer to a review PANEL's membership, which this design caps at a small, fixed maximum (§29.9) far below any document-size concern.
- **Parser/validation helpers reused throughout**: `parseGovernanceRecord`, `isHumanReviewStatusReviewable`, `applyHumanReviewUpdate` (`lib/adaptiveSchema/governanceRecordParser.ts`); `isAdaptiveReviewTerminalStatus`/`isAdaptiveReviewNonTerminalStatus`/`buildAdaptiveReviewDecisionId` (`lib/governance/adaptiveHumanReviewHistory.ts`).
- **Firestore collection/document layout today**: `runs/{runId}` (canonical), `runs/{runId}/humanReviewAssignment/current`, `runs/{runId}/humanReviewAssignmentHistory/{revision}`, `runs/{runId}/humanReviewHistory/{decisionId}`, `teamRuns/{teamId}:{runId}`, `governanceEvents` (subcollection of `runs/{runId}`), `admin_audit_logs` (top-level). All Admin-SDK-only; default-deny client rules; zero custom indexes.
- **Current test coverage**: 2,058 tests across 121 suites (Part E3 baseline). **Manual-verification limitation, repeated at every step including this one's audit**: the full authenticated multi-step review UI flow has never been exercised against a live, seeded team/run in this environment — every step has relied on real HTTP smoke checks (auth gates, route compilation) plus automated contract tests, with the interactive flow explicitly disclosed as unverified.

**Assumptions that would break under multiple reviewers** (confirmed present in the code just audited):

1. `assignedReviewerUserId: string | null` — exactly ONE slot; there is no field shape here that extends to N reviewers without a new document.
2. The assignment document is the ONLY mutable "who may act" record; there is no vote/ballot concept anywhere.
3. `submitAdaptiveHumanReview()`'s transaction assumes exactly one terminal write finalizes the record permanently — there is no notion of "this is one of several inputs to a not-yet-final decision."
4. The decision route's assignment check is a simple `uid === assignedReviewerUserId` equality — it has no concept of "one of several eligible panel members," let alone "has this member already voted."
5. Owner override (`hasAdaptiveReviewSubmissionOverride`) bypasses the assignment check entirely and lets the owner submit AS THE DECISION — there is no separate "override provenance" trail distinguishing an owner's own vote from an owner overriding a panel's votes.
6. There is no vote collection of any kind, no quorum state, no per-reviewer pending/completed tracking, no partial-review-progress concept, no reviewer-removal semantics (removal from `assignedReviewerUserId` is just reassignment/unassignment of the ONE slot — there is nothing to "remove" from a set), no duplicate-vote protection (irrelevant today since only one person can ever submit), no aggregation service of any kind, and no finalization transaction that reads more than one input document before writing the canonical decision.

None of this is a defect in the single-reviewer implementation — it was correctly scoped to exactly what Part E3 asked for. It simply means multi-reviewer support is a genuinely new capability layer, not an in-place expansion of the existing assignment document (confirmed directly, not assumed, per the instruction's own framing).

### 29.2 Product semantics — supported modes

| Mode | Description | Complexity | Governance value |
|---|---|---|---|
| 1. Any one reviewer | First valid decision from any of N eligible assignees finalizes | Lowest — no vote collection, no aggregation | Weakest — not meaningfully different from single-reviewer with a bigger assignee pool |
| 2. Majority quorum | Require N reviewers; finalize when a participation threshold is met AND one outcome has majority | Moderate — vote collection + deterministic aggregation | Real collective governance, explainable |
| 3. Unanimous | All required reviewers must agree; any dissent blocks | Moderate (same engine as Mode 2, different threshold) | Strongest per-decision confidence, highest deadlock risk |
| 4. Configurable policy | Arbitrary quorum/threshold/blocking-status/timeout policy | Highest — full policy surface | Maximum flexibility, maximum risk of silent misconfiguration |

**Key architectural finding: Modes 1–4 are not four different code paths.** They collapse into ONE deterministic aggregation engine parameterized by two numbers — `requiredReviewerCount` (panel size) and an approval threshold expressed as a fraction of that count. Mode 1 is definitionally `requiredReviewerCount = 1` (majority-of-one is trivially that reviewer's own vote). Mode 3 (unanimous) is the same majority engine with the threshold raised to 100%. Mode 4 (configurable) is the same engine with the threshold exposed as a setting instead of fixed. Building four separate code paths would risk them drifting out of sync for no product benefit; building one parameterized engine and exposing only ONE preset in the UI achieves everything the four modes ask for with a single, testable algorithm.

### 29.3 Recommended initial production mode

**Majority Quorum, with a configurable panel size (1–9 reviewers, default not fixed by this design) and a FIXED simple-majority threshold** (strictly more than half of `requiredReviewerCount` must land in the same outcome group — see §29.6 for the exact grouping rule). Only this ONE preset is exposed in the UI for the first implementation; the underlying engine already supports unanimous and fully custom thresholds (§29.2), but exposing them is explicitly deferred, not built now.

Reasoning against the four evaluation criteria in the instruction:
- **Deterministic behavior**: a fixed threshold with an explicit, documented tie/no-majority rule (§29.6 — never silently resolved, always requires explicit owner override) is fully deterministic; exposing a configurable threshold in v1 would let a team configure an ambiguous or nonsensical policy (e.g. threshold below 50%, producing simultaneous "approved" and "rejected" majorities) that the aggregation function would then have to defensively reject at read time — avoidable by not exposing it yet.
- **Manageable UI**: one panel-size number and a vote form is the entire v1 surface — no policy editor, no threshold slider, no blocking-status configuration.
- **Low migration risk**: Mode 1 (`requiredReviewerCount = 1`) is available for free inside the SAME engine, so a team that only wants "one of several eligible reviewers" behavior can configure it without the system needing a separate legacy code path.
- **Clear auditability / no silent policy interpretation**: a fixed, single, disclosed threshold rule is trivial to explain in the UI and in the audit trail ("majority of N required reviewers"); a per-panel custom policy would require the audit trail to also capture and display the CONFIGURED policy at decision time, a materially larger design surface deferred to a later phase.
- **Minimal changes to canonical `humanReview`**: the same finalization write path serves every panel size and could equally well serve a future unanimous/custom-threshold preset without further change to `governanceRecord`'s shape (§29.7, §29.10).

### 29.4 Status/vote vocabulary

```ts
type AdaptiveReviewerVoteStatus =
  | "approved"
  | "approved_with_conditions"
  | "changes_requested"
  | "rejected";
```

Identical to the existing `HumanReviewStatus`'s four terminal values — deliberately, since the finalized panel outcome must ultimately be written into `governanceRecord.humanReview.status`, which only accepts these four. Decisions, resolved narrow for v1:

| Question | v1 answer | Why |
|---|---|---|
| Comment required per vote? | No — optional, same as the existing single-reviewer decision route | No new constraint invented beyond what already exists |
| Conditions belong to individual votes? | Yes — `conditions?: string[]` on the vote, exactly like `humanReview.conditions` today | Each reviewer states their own conditions; nothing to aggregate until finalization |
| Are conditions aggregated? | Yes, MECHANICALLY only | See below |
| Identical conditions deduplicated? | Yes — exact-string match only (trim + case-sensitive), never fuzzy/semantic | A fuzzy near-duplicate helper already exists elsewhere in this codebase (used for Uncertainties/Follow-ups dedup) but is deliberately NOT reused here — running text-similarity computation inside (or before) a Firestore finalization transaction adds latency and, more importantly, judgment the system would be silently applying; exact-match dedup is mechanical, not interpretive |
| Conflicting conditions block finalization? | No — the system never semantically detects "conflict" between two English sentences; that would itself be silent policy interpretation. Two reviewers' conditions are simply concatenated (post-dedup) into the final `conditions` array; genuine conflicts are a human/owner-override concern |
| `changes_requested` a terminal panel outcome? | Yes — inherited directly from the existing `isAdaptiveReviewTerminalStatus`/`isHumanReviewStatusReviewable` vocabulary (§29.1); not a new design choice, a confirmed existing constraint |
| Does `rejected` immediately block/veto? | **No** — a single `rejected` vote is counted as one "block"-group vote like `changes_requested`, not an automatic veto. An immediate-veto policy is a legitimate FUTURE Mode-4 configuration, deliberately not the v1 default (keeps the aggregation algorithm uniform across panel sizes, §29.6) |
| Can owner override finalize against reviewer votes? | Yes — explicit, separate, owner-only, justified, never silent (§29.11) |
| Abstain/recuse needed now? | No — deferred. A reviewer either votes or doesn't; a non-voting required reviewer simply blocks quorum until removed/replaced or the owner overrides |
| Can reviewers withdraw a vote? | No — v1 prohibits it entirely (see below) |
| Vote supersession needed? | No — deferred to a possible v2; not designed here beyond noting the deterministic-ID mechanism (§29.8) that would make it possible later without a schema change |

**v1 prohibits vote changes entirely.** Once submitted, a vote is immutable and can never be edited or withdrawn by its author. This is the single narrowest, safest option satisfying the non-negotiable "one reviewer cannot overwrite another reviewer's vote" AND, by the same mechanism, "cannot overwrite their own vote either" — there is no code path that writes to an existing vote document at all, so the invariant is enforced by construction (create-only Firestore semantics), not by an application-level check that could have a bug.

### 29.5 Canonical data model — three options compared

**Option A — run subcollections** (`runs/{runId}/humanReviewPanel/current`, `runs/{runId}/humanReviewPanelMembers/{reviewerId}` or inline, `runs/{runId}/humanReviewVotes/{voteId}`, `runs/{runId}/humanReviewPanelHistory/{eventId}`). Matches the EXISTING pattern exactly — `humanReviewAssignment`, `humanReviewAssignmentHistory`, and `humanReviewHistory` are already run-scoped subcollections. Tenant isolation is inherited for free (a run's subcollections are only ever reached through the run's own deterministic projection check). No new top-level collection, no new security model to design.

**Option B — top-level panel collections** (`adaptiveReviewPanels/{panelId}`, `adaptiveReviewPanelMembers/{memberId}`, `adaptiveReviewVotes/{voteId}`). Would require a NEW deterministic-ID or generated-ID scheme independent of `runId`, a new tenant-isolation check (every read/write would need to re-derive and re-verify `teamId`/`runId` from the panel ID rather than inheriting it from the parent document path), and likely a query (`.where("runId","==",...)`) to find a run's panel — introducing exactly the index dependency §29.13 recommends avoiding. No benefit over Option A for this codebase's scale (a panel only ever belongs to one run).

**Option C — extend the current assignment document with arrays** (`humanReviewAssignment/current` gains `reviewerUserIds: string[]` and an inline `votes: {...}[]`). **Rejected outright.** Vote arrays inside one mutable document cannot give per-reviewer immutability at the DATABASE layer — Firestore's `.create()` gives native, race-proof "only the first write wins" semantics for a dedicated document; an array field inside one document requires the application to read-modify-write the WHOLE array inside a transaction every time, and "one reviewer cannot overwrite another's vote" becomes an application-level invariant that must be perfectly re-verified on every write, rather than a database-level guarantee. Every concurrent-vote-submission race becomes a full-document transaction contention point (N reviewers voting near-simultaneously would all contend for the SAME document lock) instead of N independent document creates that never contend with each other at all.

**Recommended: Option A**, with the following resolved sub-questions:
- Reviewer IDs: **inline** on the panel document as `reviewerUserIds: string[]`, NOT a separate member subcollection. At a capped maximum of 9 reviewers (§29.9), this is a handful of UID strings — nowhere near Firestore's 1MB document-size concern that motivated the EXISTING `// TODO: move members to subcollection for teams > 100` caution on `TeamDocument` (a fundamentally different scale: team membership vs. a small governance panel). A member subcollection would only be justified if per-member metadata needed independent mutation/audit trails — which the SEPARATE vote subcollection already provides.
- Votes: one document per reviewer per panel revision (§29.8), never an array.
- Panel history: a separate immutable subcollection, config-lifecycle events only (§29.15 explains why vote submission does not need its own duplicate history entry).

Transaction limits: Firestore transactions support far more reads than this design ever needs (1 panel + up to 9 votes + 1 governanceRecord = 11 reads, batched via `Promise.all` before any write, exactly like the existing assignment transaction's `Promise.all([txn.get(runRef), txn.get(assignmentRef)])` pattern) and up to 500 writes (this design's finalization transaction writes at most 2 documents — panel + governanceRecord). Document-size risk: none, at the capped scale. Concurrent-write contention: isolated to independent per-reviewer vote documents; only the panel-config document and the finalization transaction have any real contention surface, and both already use the established revision-guard/fresh-re-read pattern. Repairability, auditability, and testability all directly inherit the same patterns already proven in Parts D/E1–E3.

### 29.6 Panel configuration contract

```ts
type AdaptiveReviewPanelV1 = {
  schemaVersion: 1;
  kind: "adaptive_review_panel";
  teamId: string;
  runId: string;

  /** UI-facing label only — derived FROM requiredReviewerCount at construction time, never an independent source of truth the parser must keep in sync. requiredReviewerCount === 1 ⇒ "single"; > 1 ⇒ "majority". */
  mode: "single" | "majority";

  requiredReviewerCount: number;  // panel size: how many reviewers are assigned. 1–9.
  quorum: number;                 // v1 constraint: quorum === requiredReviewerCount, always. See below.

  reviewerUserIds: string[];      // length === requiredReviewerCount, always in sync with panel membership

  status: "open" | "finalized" | "cancelled"; // "ready_to_finalize" is NEVER persisted — see below

  revision: number;               // bumped by exactly 1 on every reviewer add/remove/reconfigure

  createdAt: string;
  createdByUserId: string;
  updatedAt: string;
  updatedByUserId: string;

  finalizedAt?: string;
  finalDecisionId?: string;
  finalDecisionStatus?: AdaptiveReviewerVoteStatus;   // written at finalization, for repair (§29.16)
  finalSupportingVoteIds?: string[];                  // written at finalization, for repair (§29.16)
};
```

Storage location: `runs/{runId}/humanReviewPanel/current` — single fixed document ID, mirroring `humanReviewAssignment/current` exactly. Written via `.set()`, guarded by `revision`.

**`requiredReviewerCount` vs `quorum` — resolved.** The contract keeps both fields (matching the given shape) for forward compatibility, but **v1 enforces `quorum === requiredReviewerCount` at panel-creation/reconfiguration time** — every assigned reviewer must vote before aggregation is even attempted; there is no "3 of 5 must vote" partial-quorum concept in v1. This is the safer, more auditable default (no reviewer's silence is ever treated as an implicit abstention), at the cost of an explicit, accepted failure mode: a single non-voting required reviewer can stall a panel indefinitely. The stall has a real, audited escape hatch (owner override, or an admin explicitly removing/replacing the non-responsive reviewer via `PUT`, which bumps the revision and lets the remaining set proceed) — never a silent timeout or implicit majority-of-whoever-showed-up. Partial quorum (`quorum < requiredReviewerCount`) is an explicitly deferred v2 policy axis.

**`status` deliberately omits a persisted `"ready_to_finalize"` value**, a deviation from the shape suggested in the prompt. "Ready to finalize" is always a DERIVED, read-time computation — call the pure aggregation function (§29.10) against the current votes — never a separately stored/transitioned state. Persisting it would create a second source of truth that could drift from what the aggregation function would actually compute, and a whole extra concurrent-write surface for a value nothing but a UI label needs. The persisted `status` enum only ever has 3 real values.

Maximum reviewer count: **9**. Minimum: **1**. No hard requirement that the count be odd (a UI-level soft warning is recommended for even counts, since they can structurally tie under simple majority — §29.6's tie rule handles this safely regardless, by never auto-resolving). Duplicate prevention: `reviewerUserIds` deduplicated and validated against `ELIGIBLE_REVIEWER_ROLES` at every PUT, identical validation to the existing single-assignment PUT. Reviewer eligibility: unchanged from §29.1 — `owner`/`admin` only, re-validated against the LIVE team roster on every mutation (not just at add-time). Reviewer removal: an explicit, admin-authorized PUT (never automatic, never a side effect of unrelated team-membership changes — §29.16). Revision behavior and terminal immutability: identical pattern to the single-assignment document — any mutation while `status !== "open"` is rejected `409`. Relationship to the existing single assignment: **mutually exclusive per run, never simultaneously authoritative** (§29.13's coexistence strategy — presence of an open panel is what the decision route checks FIRST). Relationship to canonical `humanReview`: the panel NEVER writes it directly except through the one finalization transaction (§29.11). Relationship to `teamRuns`: synced only as compact counts/status after votes/finalization (§29.14, §29.19) — never becomes a second source of governance truth.

No names/emails are stored on the panel document — `reviewerUserIds` are bare UIDs; display names are resolved at read time exactly like the existing assignment route's `resolveDisplayName()`.

### 29.7 Vote contract

```ts
type AdaptiveHumanReviewVoteV1 = {
  schemaVersion: 1;
  kind: "adaptive_human_review_vote";
  teamId: string;
  runId: string;
  panelRevision: number;         // the panel.revision this vote was cast against
  reviewerUserId: string;
  status: AdaptiveReviewerVoteStatus;
  commentPresent: boolean;       // full comment text lives in a protected canonical field — see below
  conditionsCount: number;
  submittedAt: string;
  decisionId: string;            // this vote's OWN deterministic identity — see below
};
```

Storage: `runs/{runId}/humanReviewVotes/{voteId}`, where **`voteId = ${panelRevision}:${reviewerUserId}`** — the deterministic ID this design recommends. This single choice resolves several of the contract's open questions at once:

- **One active vote per reviewer**: guaranteed by construction — a reviewer can have at most one vote document per panel revision, and only one panel revision is ever "current."
- **Immutable vote / no supersession in v1**: `.doc(voteId).create()` — a second attempt at the SAME `voteId` throws `ALREADY_EXISTS`, treated as a rejected duplicate (never silently accepted as an edit). This is the SAME mechanism that gives the assignment-history and decision-history collections their immutability — reused, not reinvented.
- **Stale panel revision handling**: a vote submission always carries the reviewer's claimed `panelRevision`; the route checks it against the LIVE panel document's revision before ever attempting the write — a stale claim is rejected the same way a stale `expectedRevision` is rejected on the assignment route today (`409`).
- **Reviewer-removal handling**: if a reviewer is removed (panel reconfigured, revision bumped), their vote at the OLD revision is never deleted — it remains a permanent historical record — but it is automatically excluded from any CURRENT aggregation, because aggregation only ever reads votes matching the panel's CURRENT `revision`. If later re-added, they get a fresh vote slot under the new revision; nothing needs to be migrated or cleaned up.
- **Duplicate submission**: rejected via the same `ALREADY_EXISTS`-is-idempotent-but-non-overwriting pattern as everywhere else in this codebase.
- **Owner-override handling**: overriding never writes to this collection at all — it is a wholly separate action (§29.11) that never touches, deletes, or supersedes any vote document.

**Full comment text**: stored in a SEPARATE, protected field — `runs/{runId}/humanReviewVotes/{voteId}` itself may hold `comment?: string` and `conditions?: string[]` directly (this document is already scoped, per-reviewer, and Admin-SDK-only — an appropriate "canonical vote detail" location), but the COMPACT contract shown above (the shape returned by list/summary endpoints) exposes only `commentPresent`/`conditionsCount`, mirroring the exact pattern §27 already established for `humanReviewHistory`. The full-text fields are read only by the vote-DETAIL access path (§29.13's privacy model governs who may reach it).

**v1 recommendation: prohibit vote changes entirely** (confirmed from §29.4) — no PATCH/PUT exists for an individual vote anywhere in this design.

### 29.8 Aggregation and finalization algorithm

Pure, deterministic, synchronous, framework-independent, versioned:

```ts
type AggregateAdaptiveReviewVotesResult =
  | { status: "waiting"; submitted: number; required: number; reason: "quorum_not_met" | "no_majority" }
  | { status: "ready"; finalDecision: AdaptiveReviewerVoteStatus; supportingVoteIds: string[] };

function aggregateAdaptiveReviewVotes(
  votes: Array<{ voteId: string; status: AdaptiveReviewerVoteStatus }>,
  requiredReviewerCount: number,
  policyVersion: 1  // versioned so a future threshold/grouping change never silently reinterprets an already-finalized panel's history
): AggregateAdaptiveReviewVotesResult
```

**Outcome grouping (fixed, disclosed, mechanical — not "silent policy interpretation")**:

```
"accept" group = { approved, approved_with_conditions }
"block"  group = { changes_requested, rejected }
```

**Algorithm**: 1) if `votes.length < requiredReviewerCount` → `waiting/quorum_not_met` (recall §29.6: `quorum === requiredReviewerCount` in v1, so this is simply "not everyone has voted yet"). 2) Tally each group's vote count. 3) If one group has a STRICT majority (`count > requiredReviewerCount / 2`) → `ready`, with `finalDecision` resolved WITHIN that group by a fixed, conservative rule: **accept group wins → `approved_with_conditions` if ANY winning vote was `approved_with_conditions`, else `approved`** (conditions are never silently dropped); **block group wins → `rejected` if ANY winning vote was `rejected`, else `changes_requested`** (a rejection is never silently downgraded). `supportingVoteIds` = every vote in the winning group. 4) If no group has a strict majority (including an exact tie) → `waiting/no_majority` — **this is a genuine, intentional deadlock state; it is never auto-resolved.** The only ways out are more team action (replace/remove a reviewer and try again) or an explicit owner override (§29.11). A single `rejected` vote does NOT immediately veto — it is one "block" vote like any other, counted only within its group's tally (confirmed decision, §29.4).

**Truth tables** (accept votes A, block votes B; requiredReviewerCount = A+B always, since quorum = required in v1):

*2 reviewers:*
| A | B | Result |
|---|---|---|
| 2 | 0 | ready — accept |
| 1 | 1 | waiting/no_majority (tie — deadlock, needs override) |
| 0 | 2 | ready — block |

*3 reviewers:*
| A | B | Result |
|---|---|---|
| 3 | 0 | ready — accept |
| 2 | 1 | ready — accept |
| 1 | 2 | ready — block |
| 0 | 3 | ready — block |

(3 reviewers can never tie under this grouping — a structural argument for odd panel sizes, offered as a UI hint, not enforced.)

*4 reviewers:*
| A | B | Result |
|---|---|---|
| 4 | 0 | ready — accept |
| 3 | 1 | ready — accept |
| 2 | 2 | waiting/no_majority (tie) |
| 1 | 3 | ready — block |
| 0 | 4 | ready — block |

*Quorum not met (any size):* fewer submitted votes than `requiredReviewerCount` → always `waiting/quorum_not_met`, regardless of the partial tally (e.g. 2 of 4 both "accept" is still `waiting`, never treated as an early accept).

*Owner override*: not a row in this table — override does not call this function at all; it is a structurally separate write path (§29.11) that can finalize the panel in ANY vote state, including before quorum is even met.

### 29.9 Finalization transaction

One Firestore transaction, atomic across two documents (`runs/{runId}/humanReviewPanel/current` and `runs/{runId}` itself) — the first time in this codebase's adaptive-governance code that a single transaction commits writes to more than one document type (every prior transaction — assignment, decision — wrote exactly one document). Still fully standard, supported Firestore behavior; called out explicitly because it is a genuinely new pattern for this codebase, not something to hand-wave.

Required order, mirroring the canonical-write-ordering discipline established in Part E3 §9:

1. `Promise.all([txn.get(panelRef), txn.get(runRef), ...votes.map(v => txn.get(voteRef(v)))])` — read panel, run, and every vote in `reviewerUserIds` for the panel's CURRENT revision, all before any write.
2. Confirm `panel.status === "open"`; else `409 panel_not_open`.
3. Confirm the read votes match `reviewerUserIds`/`requiredReviewerCount` exactly (defense in depth against a concurrently-reconfigured panel the caller's request predates).
4. Run `aggregateAdaptiveReviewVotes()` (pure, §29.8) against the freshly-read votes; if `status !== "ready"` → `409 not_ready` (never partially finalize).
5. Parse `governanceRecord` fresh from the SAME transaction's run read; confirm `isHumanReviewStatusReviewable(humanReview.status)` — re-checked here for the identical reason the single-reviewer transaction re-checks it: closes the race between a concurrent completion and this finalization.
6. (Optional, recommended) compare a caller-supplied `expectedGovernanceRecordUpdatedAt` for staleness protection, consistent with the single-reviewer decision route's own `expectedUpdatedAt` mechanism.
7. `txn.update(runRef, {"governanceRecord.humanReview": ..., "governanceRecord.updatedAt": now})` — writes ONLY `humanReview`/`updatedAt`, identical nested-path technique already used everywhere else; `finalDecision` maps directly to the four existing `HumanReviewStatus` terminal values, so NO new value is ever written to this field.
8. `txn.set(panelRef, {...panel, status: "finalized", finalizedAt: now, finalDecisionId, finalDecisionStatus: aggregate.finalDecision, finalSupportingVoteIds: aggregate.supportingVoteIds, revision: panel.revision + 1})` — same transaction, second document.
9. Return success.

AFTER the transaction commits (best-effort, exactly like every prior step — never rolling back the now-canonical decision): panel-history "finalized" entry, `governanceEvents` write, `admin_audit_logs` write, `teamRuns` projection sync. Votes themselves are never touched by finalization — they remain exactly as submitted, permanently.

Contention analysis: the finalization transaction and a concurrent panel-reconfiguration PUT (or a concurrent vote submission) both touch `humanReviewPanel/current` — Firestore's normal transaction-retry-on-conflict behavior applies, identical in kind to the existing assignment document's contention profile, just with one more document (`runs/{runId}` itself) now also inside the lock window. Since `runs/{runId}` is ALSO the document the existing single-reviewer decision transaction writes, a finalization and a (should-be-impossible-under-coexistence, §29.12) concurrent single-reviewer submission would contend on the SAME document — coexistence's mutual-exclusivity rule (§29.12) is what prevents this scenario from ever arising in practice, not a runtime lock (a genuine, disclosed reliance on application-level exclusivity rather than a database-level guarantee, worth flagging as an implementation-time test target).

### 29.10 Owner override

A structurally SEPARATE write path from both voting and finalization — never a fallback inside either.

- **Owner-only** — `hasAdaptiveReviewSubmissionOverride(role)`, the identical existing helper, reused verbatim (not a new permission concept).
- **Separate endpoint/action**: `POST .../review-panel/override`, distinct from `POST .../votes` and `POST .../review-panel/finalize`.
- **Requires a non-empty justification string.**
- **Never deletes or rewrites any vote** — votes remain exactly as submitted, permanently, regardless of how the owner ultimately decides.
- **Creates its own immutable panel-history entry** (`eventType: "overridden"`) and a **distinct** `admin_audit_logs` action (`adaptive_human_review_panel_overridden`) and a **distinct** `governanceEvents` action (`human_review_panel_override`) — never reuses the "finalized" event types, so an audit reader can always tell a normal quorum finalization apart from an executive override.
- **Provenance on canonical `humanReview`**: this is the one place this design proposes touching `GovernanceRecordV1.humanReview`'s shape — two new OPTIONAL fields, `decidedVia?: "single_submission" | "panel_vote" | "owner_override"` and `overrideJustification?: string`. Both absent for every existing record and for every future non-override decision (single-reviewer and normal panel-quorum decisions never set them), so no existing exact-shape test is affected as long as the fields are never SET outside the override path — flagged explicitly as an implementation-time risk to verify directly (not assumed), the one place this design deliberately steps outside "never touch `humanReview`'s shape." The justification's full text lives on `humanReview.overrideJustification` (canonical, same tier as `comment` today); the audit/history layer stores only `justificationPresent: boolean`, mirroring the `commentPresent` pattern exactly — never the raw text.
- **Panel becomes finalized** — override sets `panel.status = "finalized"` (same terminal transition finalization uses) so no further votes or reconfiguration can occur afterward.
- **No reviewer can submit after override** — enforced by the same `panel.status !== "open"` check every other mutation already respects.
- **No silent fallback to owner override** — nothing in this design ever automatically invokes override; it is always an explicit owner action.
- **No admin override** — deliberately absent; only `owner`, never `admin`, consistent with §29.1's existing narrower-tier reasoning.
- **Terminal statuses override may produce: any of the 4** (`approved`/`approved_with_conditions`/`changes_requested`/`rejected`) — restricting the owner's choice would be an arbitrary limitation this design has no basis to impose; override exists precisely to make an executive call regardless of the vote distribution, and may be invoked even before quorum is reached (it does not require `aggregateAdaptiveReviewVotes()` to have returned `ready` first).

### 29.11 Migration and coexistence

**Recommended: Strategy 1 — coexistence.** No backfill, no forced conversion, no bulk write of any kind (consistent with this step's own "no migrations" scope, and with "no forced migration of terminal reviews"). Existing runs keep their `humanReviewAssignment` document exactly as-is, forever, whether or not the owning team ever adopts panels. A NEW, additive, team-level opt-in flag — sibling to the existing `AdaptiveReviewSettings.enabled`/`mode` on `TeamDocument` (e.g. `AdaptiveReviewSettings.panelReviewEnabled?: boolean`, absent/false for every existing team) — is the single mechanism that makes "no automatic enrollment of teams" concrete at the product level, not just "no run happens to have a panel yet."

The decision route's branch, precisely: check for an OPEN panel document FIRST (`runs/{runId}/humanReviewPanel/current`, `status === "open"`); if one exists, panel/vote rules exclusively govern who may act on this run (the existing single-assignment check is skipped entirely for this run); if none exists (the overwhelming majority of runs, forever, for any team that never enables panels), fall through to the EXISTING, completely unmodified single-assignment check. A run/team is NEVER governed by both simultaneously — panel presence is the sole discriminator, so "no route ambiguity" and "no duplicate permissions" both hold by construction. "No reviewer unexpectedly losing access": a run's existing single-assignment reviewer keeps their access exactly as before UNLESS an admin explicitly creates a panel for that specific run (an explicit, visible, admin-initiated action, never implicit).

Rejected alternatives: **Strategy 2 (lazy conversion)** would silently rewrite existing assignment data into a new shape on first panel-related interaction — violates "no forced migration" and creates permanent ambiguity about whether a given assignment-history entry belongs to the "old" or "new" system. **Strategy 3 (full backfill)** is the highest-risk option and is explicitly out of scope for a design-only step; bulk-converting potentially many runs is exactly the class of consequential, hard-to-reverse operation this engagement's own safety discipline avoids without explicit user request.

### 29.12 Route design

```
GET    /api/teams/adaptive-runs/{runId}/review-panel
PUT    /api/teams/adaptive-runs/{runId}/review-panel
DELETE /api/teams/adaptive-runs/{runId}/review-panel
POST   /api/teams/adaptive-runs/{runId}/votes
GET    /api/teams/adaptive-runs/{runId}/votes
POST   /api/teams/adaptive-runs/{runId}/review-panel/finalize
POST   /api/teams/adaptive-runs/{runId}/review-panel/override
```

`{runId}` only in every path — `teamId`, reviewer identity, actor identity, timestamps, and canonical state are NEVER accepted from the client anywhere in any of these routes, identical to every existing adaptive-runs route (`teamId` always server-derived via `loadUserAndTeam(uid)`; `reviewerUserId` on `POST votes` is always the CALLER's own uid, never a body field).

| Route | Auth | Body | Success | Key errors |
|---|---|---|---|---|
| `GET review-panel` | `isTeamAdmin` | — | `{panel, reviewerDisplayNames}` (revision:0/status:"none" shape when no panel exists, mirroring the assignment route's always-non-null convention) | 401/403, 404 `projection_missing` |
| `PUT review-panel` | `isTeamAdmin` | `{reviewerUserIds: string[], expectedRevision?: number}` | Created or reconfigured panel | 400 ineligible/duplicate reviewer, 409 `stale_revision`/`panel_not_open` |
| `DELETE review-panel` | `isTeamAdmin` | `{expectedRevision?: number}` | `status: "cancelled"` | 409 `stale_revision`/`panel_not_open` |
| `POST votes` | `isTeamAdmin` AND caller `uid ∈ reviewerUserIds` (re-checked live) | `{status, comment?, conditions?, expectedPanelRevision}` | Vote recorded | 403 not-a-panel-member, 409 `stale_panel_revision`, 409 `duplicate_vote` (idempotent on identical retry, rejected on differing retry), 409 `panel_not_open` |
| `GET votes` | `isTeamAdmin` | — | Privacy-filtered per caller (§29.13) | 401/403 |
| `POST finalize` | `isTeamAdmin` | `{expectedPanelRevision?, expectedGovernanceRecordUpdatedAt?}` | `{review, panel}` | 409 `not_ready` (quorum/majority not yet met), 409 `panel_not_open`, 409 stale tokens |
| `POST override` | owner-only | `{finalDecision, justification: string, expectedPanelRevision?}` | `{review, panel}` | 403 not-owner, 400 empty justification, 409 `panel_not_open` |

Idempotency: `POST votes` — a retried IDENTICAL request (same caller, same panel revision) hits the SAME deterministic `voteId` and returns the already-recorded vote as success, not an error; a retried DIFFERING request (different status) at the same revision is a real, rejected `duplicate_vote` (this is the correct behavior distinguishing "network retry" from "attempted vote change" using the same document, without needing to inspect the body — the create-only write either succeeds identically or the caller learns their attempted change was rejected). `POST finalize`/`override` are naturally idempotent once terminal — a retry against an already-finalized panel simply returns the same canonical result (mirrors the existing decision route's `terminal_review_exists`-style handling). Cross-team behavior: identical deterministic-projection-based tenant check as every existing route — cross-team returns `404 projection_missing`, never revealing existence.

### 29.13 Authorization matrix

| Actor | Read panel | List reviewers | Add/remove reviewers | Submit vote | View summaries | View own vote detail | View all vote details | Finalize | Override | Cancel panel | Read history | Trigger repair |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Plain team member | No | No | No | No | No | No | No | No | No | No | No | No |
| Panel reviewer (always `admin`/`owner` in this codebase) | Yes | Yes | No¹ | Yes (if current member) | Yes | Yes | No² | Yes | No² | No¹ | Yes | No³ |
| Team admin (non-owner) | Yes | Yes | Yes | Yes (if member) | Yes | Yes | No² | Yes | No | Yes | Yes | No³ |
| Team owner | Yes | Yes | Yes | Yes (if member) | Yes | Yes | **Yes** | Yes | **Yes** | Yes | Yes | No³ |
| Non-team user | No (401/403) | No | No | No | No | No | No | No | No | No | No | No |

¹ A reviewer who is not also an admin/owner cannot add/remove/cancel — but in this codebase every eligible reviewer IS an admin or owner, so this row is theoretical unless eligibility rules change later.
² Full text of OTHER reviewers' vote comments/conditions is owner-only while the panel is open (§29.14) — a plain admin sees only status+timestamp summaries for votes other than their own.
³ Repair is internal-only, triggered by no route in this design (mirrors the existing single-reviewer repair service — not exposed to any caller).

Three separate authorities are kept distinct throughout: **governance authority** (who may vote/finalize — any eligible panel member/admin), **administrative authority** (who may configure the panel itself — `isTeamAdmin`), and **access to sensitive review text** (who may read another reviewer's comment — owner only while open, §29.14). No single permission check conflates these.

### 29.14 Privacy model

| Surface | Fields exposed |
|---|---|
| Queue list (`teamRuns` projection) | Counts/status only — `reviewPanelStatus?: "open"\|"finalized"\|"cancelled"`, `reviewPanelVotesSubmitted?: number`, `reviewPanelVotesRequired?: number`. Never reviewer UIDs, never vote statuses. |
| Panel detail (`GET review-panel`) | `reviewerUserIds` resolved to read-time display names (existing `maskEmail`/`users/{uid}.name` pattern); each member's **has-voted boolean only** — never their vote's status — while open. |
| Vote list (`GET votes`), panel open | Caller's OWN vote: full detail (status, comment, conditions). Other reviewers' votes: **status + timestamp only**, no comment/conditions text — deliberate "blind ballot" design (prevents anchoring/groupthink while voting is still in progress) — **except for the team OWNER**, who may see full detail on every vote even while open, since the owner already holds override authority and needs full visibility to exercise it responsibly. This exception is a deliberate, disclosed, narrow product decision (the prompt explicitly flagged this as requiring one), not an oversight. |
| Vote list, panel finalized | All vote STATUSES + timestamps become visible to any admin/owner viewer (`supportingVoteIds` provenance) — individual free-text comments remain visible only to their author and the owner, even after finalization. |
| Vote detail (single vote) | Same rule as above, applied per-document. |
| Panel/vote history | Metadata only — `commentPresent`/`conditionsCount`/`justificationPresent`, never raw text, identical to §27's established pattern. |
| `governanceEvents` | Metadata only — actor uid, event type, revision, never comment/condition/justification text. |
| `admin_audit_logs` | Metadata only — same fields as history, never raw text, never a full user profile. |
| Logs (`logger.warn`) | `runId`/`teamId`/a fixed failure category only — never comment, conditions, justification, or reviewer identity beyond uid. |
| Export | Unaffected — adaptive rows are already excluded from the legacy audit-export route by their `adaptive` discriminator; nothing in this design changes that. |
| UI | Never renders another reviewer's comment/conditions text to a non-owner viewer while open; never renders raw Firestore errors. |

### 29.15 UI design

Changes confined to `/team/reviews/{runId}` (`AdaptiveReviewDetail.tsx`), rendered in a branch mutually exclusive with the EXISTING `AdaptiveReviewAssignmentSection` (which remains byte-for-byte unchanged and continues to render exactly as it does today for any run without an open panel — "preserve current single-reviewer UI for existing runs" satisfied by construction, not by careful-but-fragile conditional styling).

States: **single-reviewer mode** (no panel — existing component, untouched) · **panel not configured** (admin sees an opt-in "Enable panel review" affordance; never shown/defaulted for a team that hasn't enabled `panelReviewEnabled`) · **panel open, viewer not a member** (read-only progress: "2 of 3 votes in") · **panel open, viewer IS a member, has not voted** (vote form: status choice + optional comment/conditions) · **panel open, viewer has voted** (read-only "Your vote: Approved, submitted at ⟨time⟩" — no edit control, since v1 prohibits vote changes) · **quorum pending** (progress indicator, names never required to be shown — vote-count only is sufficient and more privacy-conservative) · **ready to finalize** (admin/owner sees a "Finalize" button — this state is computed client-side from the same votes payload already fetched, matching §29.6's "derived, not persisted" decision) · **finalized** (read-only aggregate outcome + supporting-vote count, same visual language as the existing terminal-state display) · **owner override available** (owner sees a distinct "Override" control, separate from the vote form, requiring justification text before it activates) · **stale revision** (same reload-and-retry pattern the existing assignment section already uses for its own stale-revision conflicts) · **reviewer removed** (a viewer who WAS a panel member sees "You are no longer assigned to this panel"; their preserved historical vote, if any, is never shown as if still live) · **cancelled** (read-only "This panel was cancelled") · **service unavailable** (existing generic error-state pattern reused verbatim).

### 29.16 Notification and due-date extension points

Design-only, no implementation in any phase this document covers: reviewer assigned to panel, reviewer removed from panel, vote submitted, quorum reached (optional — see §29.17), panel finalized. `dueAt?: string` and `escalationAt?: string` are reserved, UNUSED, UNENFORCED optional fields on the panel contract (§29.6) for a possible future scheduled-job-based reminder system. No email, push, or scheduled job exists or is proposed to exist in Parts B–F below.

### 29.17 Indexes, rules, and scale

**No new Firestore index required.** Every new collection is either reached by direct document ID (`humanReviewPanel/current`, `humanReviewVotes/{panelRevision}:{reviewerUserId}` — the latter constructed directly from the already-known, bounded `reviewerUserIds` list via `Promise.all` of up-to-9 direct `.get()` calls, never a `.where()` query) or a small, bounded, create-only history subcollection read only by `runId` scope (never queried across runs). This mirrors the exact justification already used for `humanReviewAssignment`/`humanReviewHistory`. Firestore rules: **unchanged** — Admin-SDK-only access, default-deny client rules remain fully sufficient, identical reasoning to every prior step. Maximum reviewer count 9 keeps every transaction's read/write count trivially within Firestore's real limits (finalization: ~11 reads, 2 writes). Repair/backfill: none needed, because coexistence (§29.11) requires no backfill of any kind — a direct benefit of that choice, cross-referenced here.

### 29.18 History, events, and audit design

| Event | Collection | Deterministic ID | Metadata | `governanceEvents` action | `admin_audit_logs` action |
|---|---|---|---|---|---|
| Panel created | `runs/{runId}/humanReviewPanelHistory/{eventId}` | `${revision}:created` | teamId, runId, requiredReviewerCount, reviewerUserIds (uids only), changedAt, changedByUserId | `human_review_panel_created` | `adaptive_human_review_panel_created` |
| Reviewer added | same | `${revision}:reviewer_added` | + affected uid | `human_review_panel_reviewer_added` | `adaptive_human_review_panel_reviewer_added` |
| Reviewer removed | same | `${revision}:reviewer_removed` | + affected uid | `human_review_panel_reviewer_removed` | `adaptive_human_review_panel_reviewer_removed` |
| Vote submitted | **none — the vote document itself IS the immutable record** (§29.7); no duplicate panel-history entry, avoiding redundant writes of the same fact | — | — | — | — |
| Quorum reached | same (OPTIONAL, deferred — see below) | `${revision}:quorum_reached` | submitted/required counts only | `human_review_panel_quorum_reached` (deferred) | (deferred) |
| Panel finalized | same | `${revision}:finalized` | finalDecisionStatus, supportingVoteIds count (not the IDs themselves, to keep the record compact — IDs live on the panel document per §29.9) | `human_review_panel_finalized` | `adaptive_human_review_panel_finalized` |
| Owner override | same | `${revision}:overridden` | finalDecisionStatus, `justificationPresent: boolean` (never the text) | `human_review_panel_override` | `adaptive_human_review_panel_overridden` |
| Panel cancelled | same | `${revision}:cancelled` | — | `human_review_panel_cancelled` | `adaptive_human_review_panel_cancelled` |

All create-only, `ALREADY_EXISTS` treated as idempotent success, never overwritten. Admin-audit deterministic ID: `` `adaptive-review-panel:${runId}:${revision}:${eventType}` `` — extends the existing `adaptive-review-assignment:${runId}:${revision}` pattern with an event-type suffix purely for human readability in the audit log (uniqueness is already guaranteed by `revision` alone, since each panel mutation bumps it by exactly 1). Every new `admin_audit_logs`/`AUDIT_LOG_DISPLAY_ACTIONS`/`AuditAction` addition must go through the SAME additive allowlist mechanism §27/§28 established — a reader-side gap here would silently drop every panel event, exactly the class of bug §27.1 already found and fixed once for the decision action. "Quorum reached" is explicitly marked deferred — informational only, adds a write for something already derivable by reading current votes at any time, not required by any stated invariant.

### 29.19 Failure and repair model

| Scenario | Canonical source | Behavior |
|---|---|---|
| Panel/history/audit secondary write fails after a successful vote/finalize/override | The vote doc / the finalized `governanceRecord`+panel doc (already committed) | Best-effort, never rolls back the already-committed canonical write; reflected only in response status fields (`historyStatus`/`auditStatus`) and logs, exactly like every prior step |
| Quorum reached but finalization transaction itself fails | No canonical change occurred (Firestore transactions are all-or-nothing) | Caller retries `POST finalize`; safe, since the transaction re-reads and re-validates everything fresh every attempt |
| Finalization succeeded, `teamRuns`/panel-history/audit failed | `governanceRecord.humanReview` + panel `status:"finalized"` (both committed atomically) | Degraded-success response; repairable later by an internal repair function analogous to the existing one |
| Owner override partial failure | Same as finalization — override's canonical write is its own small transaction, all-or-nothing; secondary artifacts best-effort |
| Partial migration | **N/A** — Strategy 1 performs no migration of any kind, eliminating this entire failure class |
| Reviewer removed after voting | The reviewer's own vote document (immutable, preserved) | Vote stays permanently on record but excluded from the CURRENT aggregation (panel revision no longer matches) |
| Team member removed entirely (not just from the panel) after voting | Same | Same treatment; additionally, `requiredReviewerCount` is NEVER silently shrunk by a team-membership change — an admin must explicitly reconfigure the panel via `PUT`, an always-explicit, always-audited action, never an implicit side effect |
| Duplicate vote | The first-created vote document | Rejected via create-only `ALREADY_EXISTS`, idempotent-safe on an identical retry |
| Stale revision (panel or vote) | Live panel document | Rejected `409`, exactly like the existing assignment route |
| Malformed panel/vote document | N/A — fails closed | Same `*_malformed` failure-reason pattern already established |
| Unsupported schema version | N/A — fails closed | `schemaVersion` present on both new types from day one, enabling this immediately, no retrofit needed |

Repair responsibilities: a future `repairAdaptiveReviewPanelArtifacts(runId)` (naming parallel to the existing `repairAdaptiveHumanReviewAssignmentArtifacts`) can backfill a missing panel-history/admin-audit entry for an already-finalized/overridden panel — made possible ONLY because finalization writes `finalDecisionStatus`/`finalSupportingVoteIds` onto the panel document itself (§29.6), not just into the HTTP response; without that, repair would face the exact same "cannot reconstruct" honesty problem the existing assignment repair service already discloses for `previousReviewerUserId` at `revision > 1`. No-auto-retry: every secondary write attempts exactly once, ever, matching the established pattern with zero exceptions. Operator-intervention cases: a permanently deadlocked panel (quorum met, no majority, no one willing to override) has no automatic escalation in this design (matches §29.16's deferred notification scope) — it requires either an owner override or an admin reconfiguring the panel and trying again.

### 29.20 Test strategy — estimated counts by area

| Area | Estimate |
|---|---|
| Panel schema/parser | ~15 |
| Eligibility | ~10 |
| Revision concurrency | ~10 |
| Reviewer add/remove | ~12 |
| Migration/coexistence | ~10 |
| Vote validation | ~15 |
| Deterministic IDs | ~8 |
| Immutable writes | ~8 |
| Duplicate votes | ~6 |
| Aggregation truth tables (2/3/4-reviewer samples, not exhaustive enumeration) | ~30 |
| Quorum | ~10 |
| Ties | ~8 |
| Owner override | ~15 |
| Finalization transaction | ~20 |
| Terminal protection | ~10 |
| Stale states | ~8 |
| Projection/history/audit failures | ~12 |
| Repair | ~10 |
| Authorization | ~20 |
| Privacy | ~12 |
| UI structural | ~15 |
| Manual two-browser reviewer flow | 0 automated — manual only, same disclosed limitation as every prior step |
| Legacy regression | ~10 |
| Protected-path diff | process, not a test count |
| **Estimated total** | **~260–280 new tests**, larger than Part E3's 98 — consistent with materially larger state-space (N reviewers × 4 statuses × panel lifecycle vs. 1 reviewer × assign/reassign/unassign) |

This is an ESTIMATE for planning purposes only, not a commitment — no test was written in this step.

### 29.21 Implementation phasing

- **Part B** — Panel schema, parser, storage (`humanReviewPanel/current`), reviewer add/remove, coexistence branch in the decision route (panel-presence check only — still falls through to the unmodified single-assignment path when absent). **No votes, no aggregation, no finalization.** Team-level opt-in flag (`panelReviewEnabled`) added and defaulted off.
- **Part C** — Immutable vote contract and `POST/GET votes`. **No finalization, no aggregation reachable from any route.**
- **Part D** — Pure `aggregateAdaptiveReviewVotes()` engine and its full truth-table test suite. **No route wiring at all** — a standalone, independently-testable module, exactly like the instruction requires.
- **Part E** — Transactional finalization (§29.9), owner-override BACKEND (`POST override` — a deliberate adjustment from the prompt's own suggested phasing: override is really "finalize via a different, owner-gated path," so its backend belongs alongside finalization's transaction machinery, not deferred to the UI phase), panel history, `governanceEvents`, `admin_audit_logs`, repair service.
- **Part F** — Panel/vote UI (§29.15) and the owner-override UI control, wired last, only after B–E's contracts have proven stable — matching this engagement's own established discipline of never building UI before backend contracts are settled.

Each part: independently testable, preserves every existing production behavior (verified via the same full-suite + `tsc` + lint + protected-path-diff discipline used at every step so far), stops for review before the next part begins, and touches no protected path (Claim Verification, Video Verification, legacy System A/B, Firestore rules/indexes) at any point.

### 29.22 Required design decisions — explicit answers

1. **First supported multi-reviewer mode**: Majority Quorum, single fixed-threshold preset, panel size 1–9 (§29.3).
2. **Maximum reviewers**: 9. Minimum: 1.
3. **Quorum definition**: `quorum === requiredReviewerCount` always in v1 — every assigned reviewer must vote (§29.6).
4. **Tie handling**: never auto-resolved — `waiting/no_majority` forever until reconfiguration or owner override (§29.8).
5. **Does rejection immediately block?**: No — counted within the "block" group like `changes_requested` (§29.4).
6. **Treatment of `changes_requested`**: terminal, inherited from the existing single-reviewer vocabulary, not a new design choice.
7. **Aggregation of `approved_with_conditions`**: mechanical concatenation + exact-string dedup of the WINNING group's conditions only; never fuzzy/semantic merging (§29.4, §29.8).
8. **Can votes change?**: No — prohibited entirely in v1, enforced by create-only Firestore semantics (§29.4, §29.7).
9. **Do removed reviewers' votes count?**: No — preserved historically, excluded from current aggregation by revision mismatch (§29.7, §29.19).
10. **Owner override**: explicit, separate endpoint, justified, auditable, never silent, may produce any of the 4 terminal statuses, may be invoked before quorum (§29.10).
11. **Admin override**: does not exist — owner only.
12. **Vote comment storage**: full text on the per-reviewer vote document; compact contracts expose only `commentPresent` (§29.7).
13. **Who can read other reviewers' comments?**: only the vote's own author and the team owner while open; any admin/owner once finalized still sees status/provenance but not others' comment text unless they are the owner (§29.14) — an explicit, disclosed product decision.
14. **Single-assignment migration**: coexistence (Strategy 1), no backfill, team-level opt-in flag, mutual exclusivity by panel presence (§29.11).
15. **Existing decision route behavior**: entirely unchanged when no open panel exists; a new "check for an open panel first" branch is the ONLY addition, and it never fires for any run/team that hasn't opted in.
16. **Canonical finalization event**: `governanceEvents` action `human_review_panel_finalized` (or `_override`), distinct from the existing `human_review_decided`.
17. **Transaction boundary**: one transaction, two documents (`humanReviewPanel/current` + `runs/{runId}`), all reads before all writes, fresh re-validation of both pending-status AND aggregate-readiness inside the transaction (§29.9).
18. **Partial-failure repair**: internal-only future repair function, made possible by persisting `finalDecisionStatus`/`finalSupportingVoteIds` on the panel document at finalization time (§29.19).
19. **Required indexes**: none (§29.17).
20. **Deferred items**: partial quorum (`quorum < requiredReviewerCount`), unanimous/custom-threshold UI exposure, abstain/recuse, vote supersession, immediate-rejection veto, semantic condition-conflict detection, "quorum reached" event, all notifications/due-dates/escalation, admin override, member subcollection, fuzzy condition dedup.

No unresolved high-stakes ambiguity remains in the above — every question the instruction posed has an explicit answer with stated reasoning.

### 29.23 What this section is NOT

Not implemented, not live, not tested, not wired to any route, not reflected in any schema currently deployed. `governanceRecord.humanReview` today still recognizes only the single-reviewer/no-reviewer world exactly as Part E3 shipped it. No team can enable panel review today, because the opt-in flag this design proposes does not exist yet. Full detail and next-step recommendation: see the Part A Final Report delivered alongside this document update.

## 30. Multi-Reviewer Panel Foundation, Storage, and Coexistence — Part B (implemented, 2026-07-31)

The first IMPLEMENTED slice of the §29 architecture. **No votes, no aggregation, no finalization, no UI.** Panel configuration only: schema, parser, storage, reviewer add/remove/reconfigure, the team-level opt-in flag, and coexistence detection with the existing single-reviewer path. `governanceRecord.humanReview` is completely untouched by this step — not read-write, not even read for any NEW purpose beyond the pre-existing reviewable-status check.

### 30.1 Design-to-code reconciliation — deliberate deviations from §29

Two genuine semantic differences from §29, resolved explicitly (with the user's confirmation) before writing code, not silently reinterpreted:

- **Minimum panel size**: §29 specified 1 (so "any one reviewer" could degenerate from the same engine at size 1). Part B implements **2** instead — a size-1 "panel" is not meaningfully multi-reviewer, and the concrete implementation spec for this step stated "minimum 2 reviewers" unconditionally. `MIN_ADAPTIVE_PANEL_REVIEWERS = 2`, `MAX_ADAPTIVE_PANEL_REVIEWERS = 9` (§29's max is unchanged).
- **`quorum` semantics**: §29 defined `quorum` as a PARTICIPATION floor (`quorum === requiredReviewerCount` — every assigned reviewer must vote before aggregation is attempted at all). Part B instead implements `quorum` as the simple-majority THRESHOLD itself — `deriveAdaptivePanelQuorum(n) = Math.floor(n/2)+1` (`lib/governance/adaptiveHumanReviewPanel.ts`). This is a materially different meaning for the same field name. **The field is currently INERT** — Part B stores `quorum` on the panel document but no code reads or acts on it (no voting or aggregation exists yet). Reconciling the two definitions is explicitly left for Part D (the aggregation engine) — not resolved here, and not blocking Part B, since nothing in Part B depends on which definition ultimately wins.
- **`mode`**: §29 speculated a derived `"single"|"majority"` label. Part B implements the simpler, concrete `mode: "majority_quorum"` literal (the only mode that exists) — consistent with, not contradicting, §29's own observation that `mode` is a UI-facing label, never an independent source of truth.
- **History/audit**: §29's own phasing (§29.21) assigns panel history, `governanceEvents`, and `admin_audit_logs` integration to **Part E**, not Part B. Confirmed before implementation and deliberately NOT built here — no `humanReviewPanelHistory` collection, no new governance-event or admin-audit action exists yet. This is a scope deferral, not an oversight.
- **Opt-in / eligibility re-validation inside the finalization-style transaction**: the implementation spec for this step listed "verify team opt-in remains enabled" and "verify all reviewers are still eligible" as in-transaction steps. Both live on the TEAM document, not the RUN document the panel transaction reads — re-reading an entire team document inside a run-scoped transaction would be a new, heavier pattern for a narrow race window. Instead, both are checked at the ROUTE layer, immediately before invoking the transaction — this is not a gap but a direct match to the EXISTING, established codebase precedent: the single-reviewer assignment route already checks reviewer eligibility at the route layer, never inside `submitAdaptiveHumanReviewAssignment`'s own transaction (confirmed by inspection before writing any Part B code). The transaction itself re-validates everything that genuinely IS run-scoped and therefore genuinely race-prone: `governanceRecord.humanReview` reviewability and the panel's own `revision`.

### 30.2 Team opt-in contract

`AdaptiveMultiReviewerSettings = {enabled: boolean; mode: "majority_quorum"}` (`lib/governance/teamTypes.ts`), a NEW, separate field on `TeamDocument` — `adaptiveMultiReviewerSettings?`. Deliberately NOT folded into the existing `AdaptiveReviewSettings` (§21/§29): that field only governs whether a `teamRuns` projection is created; this one gates a materially higher-stakes capability (an open panel can block a run's entire direct decision-submission path), so the two must never be confused or accidentally coupled. `parseAdaptiveMultiReviewerSettings()` (`lib/governance/adaptiveTeamReview.ts`) mirrors `parseAdaptiveReviewSettings()`'s existing fail-closed shape exactly — absent, non-object, wrong-typed, or an unrecognized `mode` (including a hypothetical future `"unanimous"`) all resolve to `{enabled: false, mode: "majority_quorum"}`, never a silent permissive default. Wired into `parseTeamDoc()` (`lib/teams/teamApiAuth.ts`) as one additive line, exactly like `adaptiveReviewSettings` already is. No UI, no `policyEngine.ts` involvement, no legacy team-policy change, no migration — absent for every existing team today.

### 30.3 Panel storage contract

`AdaptiveHumanReviewPanelV1` (`lib/governance/adaptiveHumanReviewPanel.ts`) at `runs/{runId}/humanReviewPanel/current` — single fixed document ID, mutable, `revision`-guarded, mirroring `humanReviewAssignment/current`'s shape exactly. Part B fields only: `schemaVersion, kind, teamId, runId, mode, reviewerUserIds, requiredReviewerCount, quorum, status, revision, createdAt, createdByUserId, updatedAt, updatedByUserId`. `status` is restricted to `"open"|"cancelled"` — `"ready_to_finalize"`/`"finalized"` do not exist in the type at all (not just unused) until the finalization capability (Part E) is built, so no code path can accidentally produce them. No votes, vote counts, aggregate outcome, final decision, supporting-vote IDs, comments, conditions, reviewer names/emails, due dates, notification state, `finalizedAt`, or `finalDecisionId` anywhere in this document.

Reviewer eligibility reuses `ELIGIBLE_REVIEWER_ROLES` (`owner`|`admin`) imported directly from `adaptiveHumanReviewAssignment.ts` — not duplicated; panel eligibility is identical to single-reviewer assignment eligibility, confirmed by the same audit. Reviewer order carries no product meaning in Part B — `normalizeAdaptivePanelReviewerUserIds()` deduplicates and sorts lexicographically, so two logically-identical requests (same reviewer set, different input order) always produce a byte-identical stored array.

### 30.4 Panel parser

`parseAdaptiveHumanReviewPanel(raw, context?)` returns `{status: "valid"|"absent"|"unsupported_version"|"malformed"}`, never coercing malformed data into a valid shape and never itself deciding to fall back to single-reviewer behavior (that decision belongs to the caller — the decision route's panel gate, §30.9). Validates every field listed in the implementation spec: `schemaVersion` (1 = valid, present-but-wrong = `unsupported_version`, absent = `malformed`), `kind`, non-empty `teamId`/`runId` (optionally cross-checked against caller-supplied `expectedTeamId`/`expectedRunId` context, mirroring `AdaptiveTeamRunProjection`'s own defensive re-check pattern), `mode === "majority_quorum"`, `reviewerUserIds` (non-empty strings, no duplicates, count within `[MIN,MAX]`), `requiredReviewerCount === reviewerUserIds.length`, `quorum === deriveAdaptivePanelQuorum(requiredReviewerCount)`, `status ∈ {"open","cancelled"}`, `revision` (positive integer), both timestamps valid AND `createdAt <= updatedAt`, and non-empty actor IDs.

### 30.5 Reviewer limits and eligibility

`MIN_ADAPTIVE_PANEL_REVIEWERS = 2`, `MAX_ADAPTIVE_PANEL_REVIEWERS = 9` (§30.1's documented deviation from §29). No duplicates. Eligible roles: `owner`, `admin` — ordinary members are never eligible in Part B. No inactive-state logic exists because, as confirmed by direct audit (not assumed), this codebase's membership model has no inactive/removed/pending state at all — removal means absence from `team.members`. Panel membership never grants any NEW team permission; a listed reviewer must still independently pass every existing gate that already applies to them.

### 30.6 Quorum derivation

`deriveAdaptivePanelQuorum(requiredReviewerCount) = Math.floor(requiredReviewerCount / 2) + 1` — server-derived, always recomputed from the live reviewer list on every write, never accepted from the client, never partially trusted. No custom threshold, no partial quorum, no unanimous option, no tie-breaking logic exists in Part B — this is purely a stored, currently-unconsumed number (§30.1).

### 30.7 Storage path, GET/PUT/DELETE contracts

`runs/{runId}/humanReviewPanel/current`. Route: `GET/PUT/DELETE /api/teams/adaptive-runs/{runId}/review-panel` (`app/api/teams/adaptive-runs/[runId]/review-panel/route.ts`) — the exact path from the implementation spec, consistent with every existing adaptive-runs route's "never accept `teamId` from the client" convention.

- **GET**: authenticated, `isTeamAdmin`, deterministic run/team relationship check (identical `getAdaptiveTeamRunProjection` pattern as every sibling route), parent run exists, governanceRecord parses. Deliberately does **NOT** require the team opt-in to be enabled — a team may still want to VIEW an existing panel's configuration after later disabling opt-in. Returns `{ok, version: 1, panel: null | {mode, reviewerUserIds, reviewers: [{userId, displayName}], requiredReviewerCount, quorum, status, revision, createdAt, updatedAt}}` — reviewer display names resolved at READ time only (same `users/{uid}.name`-else-`maskEmail()` precedent as the assignment route); never `teamId`, actor IDs, raw membership, audit history, or vote fields (none of which exist yet regardless).
- **PUT**: additionally requires opt-in enabled AND the review still reviewable (checked both as an early, friendly pre-check and, authoritatively, fresh inside the transaction). Body: `{reviewerUserIds: string[], expectedRevision: number}` — `expectedRevision` is REQUIRED, not optional (a deliberate difference from the single-assignment PUT's optional-defaults-to-0 field, matching this step's own given contract exactly). Every other field the spec explicitly listed as forbidden (`teamId`, `runId`, `mode`, `quorum`, `requiredReviewerCount`, actor IDs, timestamps, `status`) is never read from the body at all — "ignored" by construction (the body parser only ever extracts the two known fields), matching this codebase's existing convention of narrow, allow-listed field extraction rather than a reject-unknown-keys validator. Response: compact — `{ok, version: 1, panel: {mode, reviewerUserIds, requiredReviewerCount, quorum, status, revision, createdAt, updatedAt}}`, no `teamId`/actor IDs/raw membership/document path/audit IDs.
- **DELETE**: same authorization as PUT. Body: `{expectedRevision: number}`, required. Never physically deletes — writes a terminal `status: "cancelled"` configuration. Response: `{ok, version: 1, panel: {status: "cancelled", revision, updatedAt}}` only.

Cross-team existence is never disclosed on any of the three — a cross-team run returns the identical `404 projection_missing` every other adaptive-runs route already returns.

**Disclosed limitation**: if a team disables opt-in while a panel is open, that panel can no longer be reconfigured OR cancelled via this route until opt-in is re-enabled (both PUT and DELETE require current opt-in, per the given authorization spec). This is a narrow, recoverable edge case — an admin can simply re-enable opt-in — not fixed with an undocumented judgment call, since doing so would deviate from the given authorization requirements.

### 30.8 Transaction behavior and revision concurrency

`submitAdaptiveHumanReviewPanel()` and `cancelAdaptiveHumanReviewPanel()` (`lib/firestore/runs.ts`) both mirror `submitAdaptiveHumanReviewAssignment()`'s transaction shape exactly: `Promise.all([txn.get(runRef), txn.get(panelRef)])` before any write, governanceRecord parsed and `isHumanReviewStatusReviewable` re-checked FRESH inside the transaction (never trusted from the route-layer pre-check), the panel re-parsed fresh via `parseAdaptiveHumanReviewPanel` (malformed/unsupported-version stored data is NEVER overwritten — fails closed and returns a distinct reason), `expectedRevision` compared against `current?.revision ?? 0` (creation and reconfiguration share ONE code path — a brand-new panel is simply "revision 0"), then exactly one `txn.set()`.

Two concurrent creations at `expectedRevision: 0`, two concurrent reconfigurations from the same revision, and two concurrent cancellations from the same revision were all proven directly: only the first commits in every case, the second always observes either `stale_revision` or (for a second concurrent cancel specifically) the even more informative `panel_already_cancelled` — the status check runs before the revision check in `cancelAdaptiveHumanReviewPanel`, so a caller racing to cancel an already-cancelled panel learns WHY, not just that something changed.

### 30.9 Terminal-review protection and cancellation semantics

Both transactions reject with `not_pending` whenever `governanceRecord.humanReview.status` is not `"unreviewed"`/`"pending"` — proven directly with a dedicated race test where the governance record is ALREADY terminal by the time the transaction's own read fires, closing the same class of race the single-reviewer assignment transaction already closes.

Cancellation is a terminal CONFIGURATION state, never a physical delete: `status: "cancelled"`, `revision + 1`, `updatedAt`/`updatedByUserId` replaced, **reviewer list preserved exactly as it was** (for auditability), no reopening. `submitAdaptiveHumanReviewPanel()` explicitly refuses to reconfigure a cancelled panel back to open — `panel_cancelled` is returned regardless of whether the caller's `expectedRevision` happens to match exactly (proven with a dedicated test: a matching revision against a cancelled panel is still rejected, not silently "succeeding" into reopening it).

### 30.10 Single-assignment coexistence

The recommended, safer rule from the implementation spec, matching §29.11 exactly: an **open** panel blocks the single-reviewer decision path; a **cancelled** panel does not (the single-reviewer path resumes exactly as before); the panel document is never deleted, so it remains visible via GET for history/audit purposes regardless of its status. Creating a panel never deletes, mutates, or reinterprets the existing single-reviewer assignment document — it becomes dormant (never consulted) only while an open panel exists, and is automatically the active path again the instant no open panel exists (absent, or cancelled) — no explicit "restore" step, no duplicate audit event pretending the assignment itself changed, because nothing about the assignment document is ever touched by any panel operation. No automatic inclusion requirement exists: the panel's `reviewerUserIds` is authoritative on its own while the panel is open; the previously-assigned single reviewer is not required to appear in it.

### 30.11 Decision-route panel gate — the fail-closed asymmetry

`evaluateAdaptiveReviewPanelGate(runId)` (`app/api/teams/adaptive-runs/[runId]/decision/route.ts`) — a dedicated, exported helper, ordered immediately BEFORE the existing Part E3 single-reviewer assignment check, itself immediately after the existing `isTeamAdmin` gate.

| Panel lookup result | Gate outcome |
|---|---|
| `absent` | not blocked — single-reviewer path proceeds entirely unchanged |
| `found`, `status: "open"` | blocked, `409 adaptive_review_panel_active` |
| `found`, `status: "cancelled"` | not blocked (§30.10's coexistence rule) |
| `malformed` / `unsupported_version` | blocked, `409 adaptive_review_panel_invalid` — fails CLOSED, never silently falls back to single-reviewer behavior on corrupted data |
| `firestore_unavailable` / `read_failed` | blocked, `503 adaptive_review_panel_unavailable` — fails CLOSED |

**This is the deliberate, critical asymmetry the instruction required**: the single-reviewer ASSIGNMENT lookup immediately below this gate fails OPEN on a read failure (established, documented Part E3 behavior — an infrastructure hiccup must never block a legitimate single-reviewer submission). This PANEL lookup fails CLOSED on the identical class of failure — an infrastructure hiccup must never silently let a direct decision bypass an active panel's stronger governance commitment. Both behaviors are proven side by side in the same test file (`adaptiveHumanReviewRoute.spec.ts`), specifically so a future refactor that accidentally unifies them is caught immediately by a failing test, not discovered in production.

An open panel never reaches ANY of the existing single-reviewer machinery — proven directly: the canonical `submitAdaptiveHumanReview` transaction is never called, no history is written, no projection sync occurs, no governance event or admin audit is emitted, and the single-reviewer assignment lookup itself is never even reached (the panel gate short-circuits first).

### 30.12 History and admin audit — deliberately deferred

Per §29.21's own phasing and confirmed again in §30.1: **no panel history collection, no new `governanceEvents` action, and no new `admin_audit_logs` action exist in Part B.** This is not an oversight — §29 explicitly assigns panel history/events/audit to Part E, alongside finalization, since a panel-lifecycle audit trail is far more useful once it can also record finalization/override outcomes than as a config-only trail built and then extended twice. No temporary or placeholder audit writer was added to avoid a stopgap that would need reworking in Part E.

### 30.13 Privacy

No new response, log, or stored document includes reviewer email, reviewer name (only bare UIDs are ever stored — display names are resolved at GET read time only, never persisted), comments, conditions (neither field exists in the panel document at all), prompt, receipt, evidence, model output, governance reasons, a raw membership object, or `teamId`/actor IDs in any PUBLIC response (GET's `reviewers[]` array is the one place a resolved display name appears, following the exact existing `maskEmail()` precedent — never a raw, unmasked email for anyone but the caller themselves). All `logger.warn` calls carry only `runId`/`teamId`/a fixed category, matching the established pattern everywhere else in this codebase.

### 30.14 Firestore indexes and rules

**No new composite index. No Firestore rules change.** Every panel read/write is a direct document ID operation (`humanReviewPanel/current`) — never a `.where()`/`.orderBy()` query — confirmed explicitly, not assumed, before writing any route code. Access remains Admin-SDK-only; default-deny client rules remain fully sufficient, identical reasoning to every prior adaptive-governance step.

### 30.15 Files changed

New: `lib/governance/adaptiveHumanReviewPanel.ts` (type, limits, quorum derivation, normalization, pure builders, parser), `app/api/teams/adaptive-runs/[runId]/review-panel/route.ts`, and 4 new test files. Modified (additive only): `lib/governance/teamTypes.ts` (+`AdaptiveMultiReviewerSettings` type, +1 optional `TeamDocument` field), `lib/governance/adaptiveTeamReview.ts` (+`parseAdaptiveMultiReviewerSettings`), `lib/teams/teamApiAuth.ts` (+1 line in `parseTeamDoc`), `lib/firestore/runs.ts` (+`getAdaptiveHumanReviewPanel`, +`submitAdaptiveHumanReviewPanel`, +`cancelAdaptiveHumanReviewPanel`), `app/api/teams/adaptive-runs/[runId]/decision/route.ts` (+the panel gate, ordered before the existing Part E3 check — no existing line in this file was altered, only new lines inserted). Two existing test files extended additively: `adaptiveHumanReviewRoute.spec.ts` (+1 mocked export with a safe default, +12 new coexistence tests, no existing assertion changed) and `adaptiveReviewEndToEndContract.spec.ts` (its shared in-memory Firestore fake gained a `.get()` on the generic sub-collection-document helper it already had — required because the new panel gate now reads `humanReviewPanel/current` on every decision POST; without this the fake's existing `.doc()` helper had no `.get()` method at all for that shape, so every test in the file failed closed with 503 until the fake was extended to correctly report "not found," restoring every pre-existing assertion to its original passing state). No Firestore rules or indexes changed.

### 30.16 Tests added and verification

135 new tests across 4 new files (10 settings-parser + 41 panel pure-model/parser + 29 panel-transaction + 43 panel-route) plus 12 new coexistence tests added to the existing decision-route test file (no existing assertion in that file altered) and one fixture extension to the end-to-end contract test's shared fake (restoring, not changing, that file's existing 13 assertions). Full suite: 2,058 → 2,193, exact match. Full Jest run twice (both: 125 suites / 2,193 tests / 56 snapshots, all passing), `tsc --noEmit` clean, `next lint` clean (pre-existing warnings only, none in any new or modified file).

**Two defects found and fixed during this step, both test-authoring bugs, not implementation defects**: (1) the panel-transaction test file's shared `storedPanel()` fixture used a hardcoded future UTC `createdAt` default that could exceed the REAL, unstubbed `new Date().toISOString()` the two deliberately-unstubbed concurrency tests relied on, intermittently tripping the parser's own `createdAt <= updatedAt` check — fixed by moving the fixture default to a safely-past fixed date and aligning one test's explicit `createdAt` override with a matching `updatedAt` override; (2) a "two concurrent cancellations" test asserted the second attempt would see `stale_revision`, but the actual (correct, more informative) behavior is `panel_already_cancelled`, since `cancelAdaptiveHumanReviewPanel` checks terminal status before revision — the test's expectation was wrong, not the implementation; fixed by correcting the assertion and adding one additional test that DOES exercise the true `stale_revision` path (a reconfiguration, not a cancellation, racing against the cancel).

### 30.17 What remains for Part C

No votes, no vote validation, no deterministic vote IDs, no immutable vote writes, no duplicate-vote protection, no aggregation, no quorum completion, no ties, no owner override for panel outcomes, no finalization transaction, no panel history, no new `governanceEvents`/`admin_audit_logs` actions, no repair service, and no multi-reviewer UI exist anywhere in this codebase today. A team may now be opted in and a panel created/reconfigured/cancelled via the API, but doing so makes the affected run's direct decision route permanently blocked (409) until Part C–E ship a working vote/finalization path — this is intentional (§29/§30's own explicit non-goal: "no partial multi-reviewer behavior is exposed as a working review flow") and should be treated as a real operational hazard: **no team should actually create a real panel via this API until Part C–E exist**, even though the endpoint itself is fully functional.

## 31. Immutable Multi-Reviewer Vote Contract and Submission — Part C (implemented, 2026-07-31)

The second IMPLEMENTED slice of the §29 architecture, building on Part B's panel foundation (§30). **A panel reviewer may now cast exactly one immutable vote per panel revision. No aggregation, no quorum completion, no finalization, no canonical `governanceRecord.humanReview` write, and no multi-reviewer UI exist anywhere in this codebase after this step.**

### 31.1 Design-to-code reconciliation

One material, deliberate deviation from §29, resolved explicitly (reasoned, not silently reinterpreted) before writing code:

- **Vote-detail visibility for the team owner**: §29.14 designed a specific exception granting the team OWNER full comment/conditions visibility on every reviewer's vote, even while the panel is open (reasoned there as "the owner already holds override authority and needs full visibility to exercise it responsibly"). This Part C implementation step's own concrete instruction was more conservative and explicit: "Do not expose other reviewers' comments/conditions in v1" and "If owner/admin access to others' full vote text was deferred in design, do not add it now." Implemented per the more conservative, more specific instruction: **in Part C, full vote-detail text (comment/conditions) is visible ONLY to the vote's own author — nobody else, including the team owner.** This is a strictly safer direction than §29's original design (restricting an access path that would otherwise need to be built, not adding a new exposure), so it was implemented directly rather than raised as a blocking question — unlike Part B's genuinely two-sided minimum-reviewer-count/quorum-semantics question, which was raised explicitly because both options were equally defensible product calls. Reconciling this back toward §29's original owner-visibility design, if still wanted, is left for Part E (finalization) or later, where override authority actually becomes exercisable.
- Every other §29/§30 concept (storage model, deterministic identity, immutability, transaction discipline, privacy-by-default) carried through to Part C without modification.

### 31.2 Vote storage location and deterministic identity

`runs/{runId}/humanReviewVotes/{voteId}` — a new run-scoped subcollection, sibling to `humanReviewPanel` and `humanReviewAssignment`. `buildAdaptiveHumanReviewVoteId(panelRevision, reviewerUserId) = \`r${panelRevision}:${encodeURIComponent(reviewerUserId)}\`` (`lib/governance/adaptiveHumanReviewVote.ts`) — deterministic, never contains a raw `/` (`encodeURIComponent` always escapes it), no random suffix, no timestamp component. `encodeURIComponent` is injective for distinct inputs, so the same reviewer + same revision always yields the same ID, a different reviewer always yields a different ID, and a different revision always yields a different ID (the `r{revision}:` prefix itself differs). The vote ID is a pure storage detail — never returned in any API response (§31.7).

### 31.3 Vote contract

`AdaptiveHumanReviewVoteV1` (`lib/governance/adaptiveHumanReviewVote.ts`): `schemaVersion, kind, teamId, runId, panelRevision, reviewerUserId, status, comment?, conditions?, commentPresent, conditionsCount, submittedAt`. No reviewer name, reviewer email, team member object, panel reviewer list, aggregate result, quorum result, final decision, `governanceRecord`, `decisionReceipt`, sources, model output, prompt, evidence, automated-governance reasons, a separate `createdBy`-style field, or a mutable revision field — the vote document itself has no revision counter, because it is never mutated after creation; `panelRevision` identifies WHICH panel configuration the vote belongs to, it does not track edits to the vote itself (there are none).

**Privacy**: full comment/conditions text exists only in this one protected document. It is never copied into `teamRuns`, any list endpoint, `governanceEvents`, `admin_audit_logs`, or logs (§31.10).

### 31.4 Request contract and validation reuse

```ts
type SubmitAdaptiveReviewVoteRequest = { panelRevision: number; status: AdaptiveReviewDecisionStatus; comment?: string; conditions?: string[] };
```

Never accepts `reviewerUserId`, `teamId`, `runId`, `submittedAt`, a vote ID, `quorum`, reviewer count, panel mode, an aggregate status, a final decision, or any actor-identity field — not because they are explicitly rejected, but because the parser (`parseSubmitAdaptiveReviewVoteRequest`) simply never reads any body field but `panelRevision`/`status`/`comment`/`conditions`, so nothing else could be trusted even if a caller sent it (proven directly by a dedicated test that submits every forbidden field and confirms none of it reaches the writer).

**Reuse strategy, exact**: the existing single-reviewer decision route's request parser (`parseAdaptiveReviewDecisionRequest`, `lib/governance/adaptiveHumanReviewRequest.ts`) had NO `server-only` dependency (pure, synchronous, zero I/O) — confirmed before writing any code — so the status-specific comment/conditions rules and limits (4,000-char comment, 20 conditions, 500 chars/condition, trim + drop-empty + dedupe-preserving-order) were extracted into a new exported pure function, `validateAdaptiveReviewCommentAndConditions(status, rawComment, rawConditions)`, called by BOTH `parseAdaptiveReviewDecisionRequest` (refactored to delegate to it) and the new `parseSubmitAdaptiveReviewVoteRequest` — one implementation, reused, never forked. The refactor was verified strictly behavior-preserving: `parseAdaptiveReviewDecisionRequest`'s pre-existing 23-test suite (`adaptiveHumanReviewValidation.spec.ts`) passes unchanged, byte-for-byte, both before and after the refactor, and its original check ORDER (plain-object → status → `expectedUpdatedAt` → comment/conditions) was preserved exactly, not just its final outcomes, since a request with multiple simultaneous validation failures could otherwise surface a different `reason` than before.

### 31.5 Vote parser

`parseAdaptiveHumanReviewVote(raw, context?)` (`lib/governance/adaptiveHumanReviewVote.ts`) returns `{status: "valid"|"unsupported_version"|"malformed"}` — deliberately no `"absent"` state (unlike the panel parser): the vote parser is only ever handed an object once a document is already known to exist; the Firestore-layer getter checks `snap.exists` itself first. Validates every field the implementation spec lists — `schemaVersion`, `kind`, non-empty `teamId`/`runId` (optionally cross-checked against caller context), positive-integer `panelRevision` (optionally cross-checked), non-empty `reviewerUserId` (optionally cross-checked), a valid `status`, comment/conditions shape, `commentPresent === Boolean(normalized comment)`, `conditionsCount === normalized conditions length`, status-specific rules (reusing `validateAdaptiveReviewCommentAndConditions` a third time — safe, since normalization is idempotent on already-normalized data), no duplicate/empty conditions, and a valid `submittedAt`. Never coerces malformed stored data into a valid vote.

### 31.6 Submission transaction

`submitAdaptiveHumanReviewVote()` (`lib/firestore/runs.ts`) — one Firestore transaction, re-reading and re-validating everything fresh: parent run → `governanceRecord` (reviewable check) → panel (open, revision match, reviewer listed) → **the TEAM document itself, freshly** → the vote document (idempotency/conflict check) → exactly one `txn.set()` on the "no existing vote" branch only.

**Genuine departure from Part B's own established pattern, deliberate and disclosed**: Part B's panel transaction (`submitAdaptiveHumanReviewPanel`) checks team-level concerns (opt-in, reviewer eligibility) ONLY at the route layer, never inside its own transaction — reasoned there as a low-value race window not worth the heavier "read a second document type inside a run-scoped transaction" pattern. Part C's vote transaction instead DOES read `teams/{teamId}` fresh, inside the same transaction, to re-verify the caller is still a current, eligible team member at the exact moment of write — because a vote, once created, is permanently immutable and irreversible; the extra transactional freshness is worth it specifically here, where "eligibility lapsed a moment before the vote was cast" is a real, disclosed risk Part B's lighter pattern doesn't need to close for a merely-reconfigurable panel document.

`reviewer_not_assigned` deliberately collapses THREE distinct underlying conditions into one generic reason — not on the panel's `reviewerUserIds`, not a current team member at all, or a current member whose role is no longer eligible — so the response never discloses which condition failed (§C11's own requirement: "do not expose whether the user was previously assigned"), proven directly by a test showing "never was assigned" and "was assigned, then removed" produce byte-identical failure responses.

Never writes `governanceRecord`, the panel document, `teamRuns`, or the single-reviewer assignment document — proven directly (a before/after equality check on both documents across a successful vote submission).

### 31.7 Idempotent duplicate semantics

A vote is create-only. On an existing vote for the same `(panelRevision, reviewerUserId)`:

- **Semantically identical** (same `status`, normalized `comment`, normalized `conditions`, `panelRevision`, `reviewerUserId`, `runId`, `teamId` — deliberately NEVER `submittedAt`) → `submissionStatus: "already_submitted"`, returning the ORIGINAL stored vote unchanged (never a new document, never a mutated timestamp) — proven directly: a retry with a later `now` still returns the original, earlier `submittedAt`.
- **Semantically different** → `409 vote_already_submitted` (`vote_conflict` internally) — the existing vote is never overwritten, never mutated.

`isSemanticallyEquivalentAdaptiveHumanReviewVote()` performs this comparison; conditions arrays are compared element-by-element in order (safe because `validateAdaptiveReviewCommentAndConditions` already normalizes to a deterministic, first-occurrence order upstream — no set-based comparison is needed). One reviewer's vote can never overwrite another's — they are independent documents at independent deterministic IDs, proven directly.

### 31.8 Panel-revision behavior

A vote is valid only for the EXACT current panel revision — a mismatch is `409 panel_stale`, both as a friendly route-layer pre-check and, authoritatively, inside the transaction. The vote is never silently migrated to a new revision, never auto-retried. Because vote IDs are revision-scoped (§31.2), a panel reconfiguration creates a genuinely fresh voting round: prior-revision votes remain permanently readable as immutable historical records (§31.9) but never count toward the current revision's tally (moot in Part C, since nothing tallies yet, but the storage model already makes this the natural behavior for when Part D's aggregation is built).

### 31.9 Reviewer-removal behavior and terminal-review protection

If the caller is no longer listed on the panel OR no longer a current, eligible team member, the vote is rejected `403 reviewer_not_assigned` (§31.6). Old-revision votes already cast by a since-removed reviewer are never deleted and remain a permanent historical record, simply excluded from the current revision by construction. Before every vote creation, canonical `governanceRecord.humanReview` is re-read and re-parsed fresh; a terminal status rejects with `409 not_pending` regardless of the panel's own `"open"` status — canonical `humanReview` remains the authoritative source of truth for whether review is still open, exactly as it has been at every prior step; panel status alone is never trusted for this.

### 31.10 Read endpoint and privacy

`GET /api/teams/adaptive-runs/{runId}/votes` — authorization is `isTeamAdmin` (owner|admin), identical to every other adaptive-runs read endpoint (not gated on panel membership specifically, since every eligible panel reviewer is already owner/admin by construction — the same audit finding reused from §29.13/§30.5). Returns `{ok, version: 1, panelRevision, panelStatus, reviewerCount, submittedCount, votes: [...]}` — `votes` includes only reviewers who have actually submitted (ordered deterministically via the panel's own already-sorted `reviewerUserIds`, resolved via direct per-reviewer `Promise.all` gets, never a query). A malformed or unsupported-version stored vote is skipped safely (logged, never surfaced as an error, never fabricated as an entry). Each entry: `reviewerUserId`, read-time-resolved `reviewerDisplayName`, `status`, `submittedAt`, `isCurrentUser`, `commentPresent`, `conditionsCount`, and `comment`/`conditions` **only when `isCurrentUser` is true** (§31.1's disclosed narrowing — nobody, including the owner, sees another reviewer's full text in Part C). Never returns `teamId`, the internal vote document ID, raw membership, or any aggregate/final-decision field.

### 31.11 Cancelled-panel behavior

A cancelled panel accepts no new votes (`409 panel_cancelled` on `POST`, both pre-check and transaction-authoritative) but its existing votes remain fully readable via `GET` as historical records — `panelStatus: "cancelled"` is returned accurately, `submittedCount` remains accurate, and no vote document is ever deleted when a panel is cancelled (Part B's own cancellation semantics — reviewer list and, transitively, every vote cast against that panel revision — were already designed to be preserved, never destroyed).

### 31.12 No aggregation in this step

Confirmed directly, not just by omission: `submitAdaptiveHumanReviewVote()`'s result type has no `finalDecision`/`aggregate`/`quorumMet` field: the vote model has no aggregate field to begin with; the GET response has no `finalDecision`/`aggregate`/`quorumMet`/`readyToFinalize` field; and dedicated tests assert all of the above explicitly, so a future accidental addition of aggregation logic to this step's files would fail a test immediately rather than silently expanding Part C's scope.

### 31.13 Audit, events, and history — deliberately deferred

Per §29.21's own phasing, vote-submission audit/history/`governanceEvents` integration is assigned to Part E (alongside finalization), not Part C — confirmed again before writing any code, matching Part B's identical deferral for panel-configuration events. No temporary or placeholder audit writer was added. The vote document itself is already Part C's own immutable record of what happened and when; a separate audit trail becomes valuable once Part E can also record aggregation/finalization outcomes alongside it.

### 31.14 Firestore indexes and rules

**No composite index. No Firestore rules change.** Every vote read/write is a direct document-ID operation (`humanReviewVotes/{voteId}`, constructed from the already-known, bounded — ≤9 — panel reviewer list) — never a `.where()`/`.orderBy()` query, confirmed explicitly before writing any route code. The vote-listing GET endpoint uses in-memory deterministic ordering (the panel's own already-sorted `reviewerUserIds`) rather than a Firestore query, exactly as recommended. Access remains Admin-SDK-only; default-deny client rules remain fully sufficient.

### 31.15 Files changed

New: `lib/governance/adaptiveHumanReviewVote.ts` (deterministic ID, vote type, pure builder, semantic-equality helper, request parser, stored-document parser), `app/api/teams/adaptive-runs/[runId]/votes/route.ts` (POST + GET), and 3 new test files. Modified (additive/refactor, behavior-preserving and verified): `lib/governance/adaptiveHumanReviewRequest.ts` (extracted + exported `validateAdaptiveReviewCommentAndConditions` and `ADAPTIVE_REVIEW_DECISION_STATUSES`; `parseAdaptiveReviewDecisionRequest` refactored to delegate, its own pre-existing 23-test suite unchanged and passing), `lib/firestore/runs.ts` (+`getAdaptiveHumanReviewVote`, +`submitAdaptiveHumanReviewVote`). No Firestore rules or indexes changed. No panel, assignment, history, audit, or UI file touched.

### 31.16 Tests added and verification

123 new tests across 3 new files (53 pure-model/parser + 33 transaction + 37 route), plus the existing `adaptiveHumanReviewValidation.spec.ts` (23 tests) re-verified unchanged against the refactored request-parser file. Full suite: 2,193 → 2,316, exact match. Full Jest run twice (both: 128 suites / 2,316 tests / 56 snapshots, all passing), `tsc --noEmit` clean, `next lint` clean (pre-existing warnings only).

**One test-harness limitation found and fixed during this step, not an implementation defect**: two "simultaneous submission" concurrency tests were originally written using `Promise.all()` to launch two transaction calls together — but the shared in-memory transaction fake used across every test file in this engagement has no real Firestore-style optimistic-concurrency conflict retry, so genuinely interleaved calls cannot prove arbitration (both callbacks observe "not yet written" before either commits). Fixed by switching to sequential `await` calls, exactly matching the already-established, correctly-working pattern from every prior concurrency test in this engagement (Part B, Part E3) — proving "only the first of two attempts against the same precondition succeeds" via the revision/existence check itself, not literal thread-level interleaving. A second, unrelated test-authoring bug (asserting neither reviewer's email should appear in a GET response, forgetting the established "caller's own email is never masked" precedent from Part E3) was also found and fixed the same way — corrected to check only that the OTHER reviewer's email is masked.

### 31.17 What remains for Part D

No aggregation engine, no quorum-completion detection, no tie handling, no condition-merging, no rejection/changes_requested precedence rules, and no `ready_to_finalize` computation exist anywhere. Part D (per §29's phasing) is the pure, standalone `aggregateAdaptiveReviewVotes()` engine and its full truth-table test suite — no route wiring. Part E remains transactional finalization, panel history, `governanceEvents`, `admin_audit_logs`, the owner-override backend, and repair. Part F remains all multi-reviewer UI.

## 32. Pure Multi-Reviewer Aggregation Engine and Quorum Truth Tables — Part D (implemented, 2026-07-31)

**This entire step is pure domain logic.** No route, no Firestore read/write, no canonical `governanceRecord.humanReview` write, no panel-status write, no audit/history/events, no UI. `aggregateAdaptiveReviewVotes()` is a standalone, importable, independently testable pure function — nothing in this codebase calls it from a route yet, and it performs zero I/O.

### 32.1 Design-to-code reconciliation

No material semantic deviation from §29–§31 this time (contrast with Part B's min-reviewers/quorum-formula question and Part C's owner-visibility narrowing) — Part D consumes the panel/vote contracts exactly as Parts B/C already shipped them. One genuine ambiguity in the RESULT contract's own design was resolved, exactly as instructed: §D10 asked whether `"winning_group_status_tie"` (a second deadlock reason in the prompt's own suggested union) is reachable at all under policy v1's conservative exact-status rules. Verified directly: it is not — any `approved_with_conditions` vote in a winning approval group always escalates to `approved_with_conditions`, and any `rejected` vote in a winning blocking group always escalates to `rejected` (§32.5), so an "exact-status tie within an already-won group" can never occur. Per §D10's own instruction ("prefer the smallest honest result union"), `winning_group_status_tie` was omitted entirely — `deadlocked.reason` is a single literal (`"no_strict_group_majority"`), not a two-value union with one dead branch.

### 32.2 Reuse strategy

`aggregateAdaptiveReviewVotes()` (`lib/governance/adaptiveReviewAggregation.ts`) reuses `parseAdaptiveHumanReviewPanel()` and `parseAdaptiveHumanReviewVote()` (both already pure, zero-I/O modules, confirmed in Parts B/C) as its structural-validity layer, rather than reimplementing panel/vote shape validation a third time. Layered on top are a small number of checks that are genuinely aggregation-specific and that the shared parsers cannot express (they validate one stored document's own self-consistency, not cross-referencing against a second document or a whole vote SET):

- `panel.status === "open"` — the parser accepts `"cancelled"` as structurally valid (it must, since a cancelled panel is a real, valid, permanent record); only the aggregation engine considers `"cancelled"` an invalid INPUT for its own purposes (§32.7).
- `panel.mode === "majority_quorum"` and the `panel.quorum` formula — checked independently, before the full parser reuse, specifically so they can be reported as their OWN distinct `invalid_panel_mode`/`invalid_quorum` reasons rather than collapsing into the parser's single generic "malformed" outcome.
- Each vote's `teamId`/`runId`/`panelRevision` cross-referenced against the PANEL (not an externally-supplied "expected" context) and `reviewerUserId` checked against `panel.reviewerUserIds` — genuinely aggregation-specific, since the vote parser alone cannot know which panel it should belong to.
- Duplicate-reviewer-vote detection across the whole vote SET — inherently a set-level property no single-document parser could ever check.

### 32.3 Policy contract

```ts
export const ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION = 1;
export const ADAPTIVE_REVIEW_AGGREGATION_POLICY_V1: AdaptiveReviewAggregationPolicyV1 = {
  version: 1,
  mode: "majority_quorum",
  approvalGroupStatuses: ["approved", "approved_with_conditions"],
  blockingGroupStatuses: ["changes_requested", "rejected"],
};
```

Not accepted as a function parameter — the engine hardcodes this one fixed constant internally (§D2: "prefer constants over user-configurable policy objects"), but the constant is genuinely load-bearing, not decorative: group classification reads FROM `approvalGroupStatuses`/`blockingGroupStatuses` rather than duplicating the status literals inline, so a hypothetical future policy version would only need a new constant, not new classification logic. No custom thresholds, no unanimous mode, no rejection veto, no partial quorum, no abstain/recuse, no weighted votes exist in v1.

### 32.4 Input and result contracts

Input: `{panel: AdaptiveHumanReviewPanelV1, votes: readonly AdaptiveHumanReviewVoteV1[]}` — the exact production types, no wrapper. Result: the discriminated union exactly as specified (`waiting` / `deadlocked` / `ready` / `invalid`), every branch carrying `policyVersion: 1`. Never returns full comments, full conditions, raw votes, Firestore IDs, reviewer emails, or reviewer names — `supportingReviewerUserIds` (bare UIDs only) is the sole reviewer-identifying field, present only in `ready` results, intended for Part E's finalization write, never exposed through any public route in Part D (none exists).

### 32.5 Quorum semantics

`quorum` (already computed and stored on the panel by Part B: `floor(reviewerCount/2)+1`) means, for Part D's purposes: **the minimum number of submitted valid votes required before aggregation may produce a `ready` or `deadlocked` result.** `submittedCount < quorum` → `waiting`, unconditionally; `submittedCount >= quorum` → group majority is evaluated. Quorum itself never implies a winning outcome — reaching quorum with an exact group tie is `deadlocked`, not `ready`. Unsubmitted reviewers never count toward either group. With the minimum panel size of 2 (Part B), the smallest possible quorum is 2, so zero or one submitted vote is always `waiting` by construction — no special-casing was needed (§D13).

### 32.6 Group majority and exact status resolution

Approval group: `approved`, `approved_with_conditions`. Blocking group: `changes_requested`, `rejected`. A group wins only with a **strict majority of SUBMITTED votes** — `groupCount > submittedCount / 2` — never a majority of total assigned reviewers, never a majority of the `quorum` value itself, never plurality, never any tie-break by timestamp, role, or reviewer ordering. The two group counts can never simultaneously exceed `submittedCount / 2` (every vote belongs to exactly one of the two groups by construction), so "both win" is structurally impossible.

Once a group wins, the exact terminal status is resolved conservatively, from that group's OWN votes only — a minority group's votes are never consulted once the majority group is determined:

- **Approval group wins**: any `approved_with_conditions` among the winning votes → `finalStatus: "approved_with_conditions"`; otherwise → `"approved"`. Conditions are never silently dropped.
- **Blocking group wins**: any `rejected` among the winning votes → `finalStatus: "rejected"`; otherwise → `"changes_requested"`. Rejection is the more restrictive outcome and is never silently downgraded — but ONLY within an already-won blocking group; a single `rejected` vote can never veto an approval-group win (proven directly: `2 approved + 1 rejected → approved`, no rejection-veto policy exists).

### 32.7 Deadlock, cancelled-panel, and partial-vote semantics

**Deadlock**: `approvalGroupCount === blockingGroupCount` after quorum is met → `deadlocked/no_strict_group_majority`, the sole deadlock reason (§32.1). Never auto-resolved — the only ways out are more votes, panel reconfiguration, or a future owner override (Part F).

**Cancelled panel**: `panel.status !== "open"` → `invalid/invalid_panel_status`, never `waiting`. A cancelled panel's historical votes remain fully readable (Part C's own `GET .../votes`) but are never aggregated into a `ready` outcome by this engine.

**Partial votes**: once quorum is reached, the engine may return `ready` even if not every assigned reviewer has voted — it only ever evaluates the votes actually provided. This has a real, disclosed consequence for Part E: finalization must be transactionally protected and must freeze the panel; a vote arriving concurrently with finalization must be handled safely by Part E's own transaction, exactly as every other race in this codebase has been closed — the pure engine itself has no persistence race to solve, since it performs no persistence at all.

### 32.8 Supporting reviewer set and condition metadata

`supportingReviewerUserIds`: only the winning group's reviewer UIDs, deterministic ascending (lexicographic) order, never a losing-group or unsubmitted reviewer.

`conditionsSummary` (metadata only, never condition text): populated ONLY when `finalStatus === "approved_with_conditions"` — `contributingVoteCount` (winning-group votes whose OWN status is `approved_with_conditions`), `uniqueConditionCount` (exact-string-deduplicated count across those votes' conditions, reusing the SAME dedup semantics already normalized upstream by the vote parser — no fuzzy/semantic merging, no user-visible merged list, no conflict detection), `hasConditions` (`uniqueConditionCount > 0`). For every other final status: `{contributingVoteCount: 0, uniqueConditionCount: 0, hasConditions: false}`. Full condition-text aggregation for canonical finalization remains explicitly out of scope, deferred to Part E's own design.

### 32.9 Invalid-input taxonomy

Twelve distinct reasons (§D4's own union, used exactly): `invalid_panel`, `unsupported_panel_version`, `invalid_panel_status`, `invalid_panel_mode`, `invalid_quorum` (panel-level); `invalid_vote`, `unsupported_vote_version`, `vote_team_mismatch`, `vote_run_mismatch`, `vote_revision_mismatch`, `reviewer_not_in_panel`, `duplicate_reviewer_vote` (vote-level). Checked in a fixed, documented, deterministic precedence order (mode → status → quorum-formula → full panel parse; then, per vote, in `reviewerUserId`-sorted order regardless of the caller's input array order: duplicate → structural parse → team → run → revision → panel membership) — so which reason is reported when multiple problems exist simultaneously never depends on input ordering. Never throws for expected invalid domain input — always returns a `{status: "invalid", ...}` result. Structurally invalid, foreign, or duplicate current-revision votes are never silently discarded — they make the WHOLE aggregation attempt invalid, never partially ignored.

### 32.10 Immutability and determinism

The function never mutates `panel`, `panel.reviewerUserIds`, the `votes` array, any vote object, or any comment/conditions value — proven directly with deep-frozen inputs (no exception on a frozen object means no attempted mutation) and before/after equality checks. Vote processing uses an internally re-derived deterministic order (sorted by `reviewerUserId`), never the caller's array order — proven for every truth-table and exhaustive-combination case by asserting forward and reversed vote-array results are `toEqual`, including for which `invalid` reason is chosen when applicable.

### 32.11 Test coverage

An explicit, human-readable 2-reviewer truth table (10 rows, matching §D17 exactly) plus an EXHAUSTIVE generated combination suite for 2/3/4 reviewers — every possible status combination at every possible submission count (`4^n` combinations per submission size, `n` from 0 to reviewer count) — verifying the waiting/deadlocked/ready invariants and exact-status/supporting-set correctness programmatically rather than hand-duplicating each row (§D18's own stated preference). Every exhaustive case is additionally re-verified with a reversed vote array for order-independence. Condition-metadata, invalid-input (every one of the 12 reasons), privacy, immutability, and no-I/O/import-boundary tests are all present as their own dedicated suites.

### 32.12 No-I/O guarantee

Verified by direct source-level scan (mirroring the established `importBoundaries.spec.ts` pattern already used for the Claim/Video Verification boundary), not just by omission: the module itself, AND its three direct pure-validator dependencies (`adaptiveHumanReviewPanel.ts`, `adaptiveHumanReviewVote.ts`, `adaptiveHumanReviewRequest.ts`), contain none of `firebase-admin`, `@/lib/firebase/*`, `next/server`, `react`, `fetch(`, `@/lib/teams/teamApiAuth`, `@/lib/logger`, or `process.env`.

### 32.13 Files changed

New: `lib/governance/adaptiveReviewAggregation.ts` and its test file. **Nothing else was touched** — no route, no Firestore helper, no UI file, no Firestore rules or indexes. This is the first step in the entire multi-reviewer engagement (Parts B–D) whose diff is exactly two new files and nothing else.

### 32.14 Tests added and verification

94 new tests. Full suite: 2,316 → 2,410, exact match. Full Jest run twice (both: 129 suites / 2,410 tests / 56 snapshots, all passing), `tsc --noEmit` clean, `next lint` clean (pre-existing warnings only).

**Two defects found and fixed during this step, both test-authoring bugs, not implementation defects**: (1) a jest-each gotcha — the 2-reviewer truth-table's row tuples had inconsistent lengths (deadlock rows omitted the unused trailing `finalStatus` element), which made Jest's arity-sniffing mistake the unfilled 4th callback parameter for an async `done` callback, hanging four tests until the 5-second timeout instead of returning synchronously; fixed by padding every row to a consistent length with an explicit `undefined`, dropping the affected suite's runtime from ~20s back to under 1s. (2) a test fixture computed `quorum` from the WRONG reviewer count when a test overrode `requiredReviewerCount` independently of `reviewerUserIds`, causing an intended "wrong requiredReviewerCount" test to instead trip the (also-real, separately-tested) `invalid_quorum` check first; fixed by making the fixture's `quorum` override internally consistent with the deliberately-wrong `requiredReviewerCount`, isolating the one condition actually under test.

### 32.15 What remains for Part E

No finalization route, no finalization transaction, no owner-override route, no panel `finalDecisionStatus`/`finalizedAt` persistence, no `governanceRecord.humanReview` write, no `teamRuns` sync, no panel history, no `governanceEvents`, no `admin_audit_logs` action, and no repair service exist for any of this yet. Part E is exactly that: wiring `aggregateAdaptiveReviewVotes()` into a real transactional finalization write, plus the owner-override backend, plus history/events/audit, plus repair — the pure engine built here is what that transaction will call, but nothing calls it yet.

## 33. Transactional Multi-Reviewer Finalization, History, Audit, Events, and Repair — Part E (implemented, 2026-07-31)

The third and final IMPLEMENTED slice of the §29 architecture for THIS engagement's multi-reviewer feature. **A ready panel may now be transactionally finalized into the canonical `governanceRecord.humanReview`.** No owner override and no multi-reviewer UI exist yet (Parts F+).

### 33.1 Design-to-code reconciliation

No new semantic deviation from §29–§32 in this step — the pure aggregation engine (§32) is consumed exactly as it was designed, unmodified. Design decisions made explicitly during this step, each reasoned and disclosed rather than assumed:

- **Decision ID reuse strategy**: §29/§31's `decisionId` precedent (single-reviewer path) hashes `teamId+runId+reviewedAt+newStatus` — a WALL-CLOCK-dependent input. For multi-reviewer finalization, `buildAdaptivePanelFinalDecisionId()` deliberately EXCLUDES any timestamp, hashing only `teamId+runId+panelRevision+finalStatus+aggregationPolicyVersion` instead — because a multi-reviewer decision is fully determined by which panel revision was finalized and what the (deterministic, pure) aggregation outcome was, never by when someone happened to click Finalize. This makes the ID double as the idempotency key by construction: a retried finalization attempt against the same panel revision/outcome always yields the IDENTICAL ID, with no separate lookup needed. One ID, reused verbatim across `panel.finalDecisionId`, the `humanReviewHistory` document ID, the admin audit correlation key, and the governance-event correlation key.
- **Canonical `humanReview` build — a NEW, separate pure function, not a modification of `applyHumanReviewUpdate()`**: the single-reviewer path's `applyHumanReviewUpdate()`/`HumanReviewUpdate` (`lib/adaptiveSchema/governanceRecordParser.ts`) remain completely UNTOUCHED — that function exists to defensively validate RAW, untrusted client input, which multi-reviewer finalization never receives (its `finalStatus`/provenance are 100% server-derived from the pure aggregation result). `buildFinalizedMultiReviewerHumanReview()` (`lib/governance/adaptivePanelFinalization.ts`) builds the canonical object directly instead.
- **`GovernanceRecordV1.humanReview` type extended with 4 new optional fields** (`decidedVia`, `panelRevision`, `aggregationPolicyVersion`, `supportingReviewerCount`) — the one place this design touches that type at all. Verified directly, not assumed, that this is safe: `applyHumanReviewUpdate()` never sets these fields, so every EXISTING exact-shape `toEqual` test across `governanceRecordParser.spec.ts`, `governanceRecordImmutability.spec.ts`, `adaptiveHumanReviewPersistence.spec.ts`, etc. continues to pass unchanged (confirmed by running the full suite immediately after the type change, before writing any further code) — the fields are simply absent, never `undefined`-valued keys, for every single-reviewer decision past or future.
- **Vote-set atomicity — resolved WITHOUT any Firestore collection query.** §E5's own "critical issue" is answered directly: vote document references are built DETERMINISTICALLY from `panel.reviewerUserIds` (bounded ≤9) and `panel.revision`, via the same `buildAdaptiveHumanReviewVoteId()` already used by vote submission, then read individually via `txn.get()`. This sidesteps any question of collection-query support in the current Admin SDK/repository version entirely — no query is ever attempted. Atomicity is the Admin SDK's own standard transaction contract: reading ANY document via `txn.get()` — including one that doesn't exist yet — registers it as a dependency; if that document is written by a different transaction before this one commits, the SDK automatically retries. This is the exact same guarantee every other transaction in this codebase already relies on, applied here across up to 11 documents (run, panel, ≤9 votes) instead of 1–2.

### 33.2 Finalized panel schema

`AdaptiveHumanReviewPanelV1.status` gains a third value, `"finalized"`, plus five new OPTIONAL fields, required if and only if `status === "finalized"` (enforced by the parser's cross-field validation, additive to Part B's existing checks): `finalizedAt`, `finalizedByUserId`, `finalStatus` (one of the 4 terminal statuses), `finalDecisionId`, `aggregationPolicyVersion`. Every existing open/cancelled panel document remains fully valid, unaffected. `"ready_to_finalize"` remains a purely derived, never-persisted concept (confirmed in Part D, unchanged). **No reopening**: `buildNextAdaptiveHumanReviewPanel()`/`buildCancelledAdaptiveHumanReviewPanel()` (Part B) are UNMODIFIED and structurally cannot produce a `"finalized"` panel — only the new `buildFinalizedAdaptiveHumanReviewPanel()` can, and only the finalization transaction calls it. Reconfigure/cancel attempts against an already-finalized panel are additionally guarded by a new, distinct `panel_finalized` failure reason (more precise than the pre-existing `panel_cancelled`/`panel_already_cancelled` labels) — though in practice, since finalization always writes a TERMINAL `governanceRecord.humanReview` in the same transaction, such an attempt is normally rejected even earlier, at the pre-existing (Part B/C) governance-reviewability gate (`not_pending`) — the new `panel_finalized` branch exists as defense-in-depth for the otherwise-unreachable inconsistent-state case, proven directly by a dedicated test that constructs that state explicitly.

### 33.3 Finalization route and authorization

`POST /api/teams/adaptive-runs/{runId}/review-panel/finalize`. Request: `{expectedPanelRevision: number, expectedGovernanceUpdatedAt: string}` — the only two fields ever read from the body; `finalStatus`, vote IDs, `quorum`, the aggregation result, the decision ID, timestamps, comments, conditions, and actor/team identity are never accepted (proven directly: a request with every one of those fields populated still produces a call to the transaction with only server-derived values). Authorization: `isTeamAdmin` (`owner`|`admin`) — **no owner-only restriction for ordinary finalization** (§E4's own recommendation, followed): finalizing a `ready` panel is a mechanical "the vote is already decided" action, not an executive judgment call; owner-only remains reserved for a future override (Part F). Team opt-in must be enabled. Deterministic run/team relationship check identical to every sibling route.

### 33.4 Finalization transaction

`finalizeAdaptiveHumanReviewPanel()` (`lib/firestore/runs.ts`). Order: read run + panel → parse governanceRecord → **if panel already `"finalized"`, handle idempotency (§33.6) and return** → if `"cancelled"`, reject → parse/validate the `"open"` panel → compare `governanceRecord.updatedAt` to `expectedGovernanceUpdatedAt` (checked BEFORE reviewability, mirroring the single-reviewer transaction's own established precedent — a stale-data error is never masked by a terminal-status error the UI hasn't seen) → confirm reviewable (`not_pending`) → compare panel revision (`panel_stale`) → read the ≤9 deterministic vote refs → parse every existing one (malformed/unsupported-version votes fail the WHOLE finalization closed, never silently skipped) → **call `aggregateAdaptiveReviewVotes()` fresh against exactly what was just read** → require `ready` (waiting → `quorum_not_met` with compact `submittedCount`/`quorum` metadata only, never votes; deadlocked → `panel_deadlocked`; invalid → `aggregation_invalid`, logged as unexpected since this transaction's own upstream checks should already prevent it) → build the canonical `humanReview` and the finalized panel document → commit both in the SAME transaction, writing ONLY `governanceRecord.humanReview`, `governanceRecord.updatedAt`, and the panel document — proven directly that `decisionReceipt`/`automatedGovernance` and every vote document are byte-for-byte untouched.

### 33.5 Canonical conditions and comment

**`approved_with_conditions`** (Option A, chosen per §E8/§E22): `buildFinalConditionsUnion()` collects conditions ONLY from the winning group's `approved_with_conditions` votes (identified via the aggregation result's own `supportingReviewerUserIds`, re-cross-referenced against the SAME votes the transaction already read — the pure engine itself never returns condition text, by design, §32), exact-string deduplicated, ordered by `supportingReviewerUserIds`'s own reviewer-ascending order and then each vote's own already-normalized condition order, capped at the existing `MAX_REVIEW_CONDITIONS_COUNT` (20, the same bound already enforced per-vote) — overflow keeps the first 20 in this exact deterministic order, never an unpredictable truncation. No semantic merging, no rewording, never a losing-group vote's conditions.

**`changes_requested`/`rejected`**: a fixed, system-generated canonical comment — `"Finalized by multi-reviewer panel."` — never a concatenation of individual reviewers' private vote comments. Each reviewer's own comment/conditions remain permanently protected inside their own immutable vote document; only the compact `commentPresent`/`conditionsCount` shape (already established in §27/§31) ever reaches history/audit/event metadata.

**`approved`**: no conditions, no canonical comment (`undefined`) — matching the single-reviewer path's own existing precedent of leaving `comment` absent for a plain approval.

### 33.6 Canonical humanReview provenance and idempotency

`buildFinalizedMultiReviewerHumanReview()` sets `reviewerId` to the FINALIZING ACTOR's uid (the caller who invoked the route) — not any individual voter's, since no single voter "made" the collective decision; the full supporting-reviewer set lives in the separate, richer panel finalization history record (§33.7) instead of being squeezed into this already-established, single-reviewer-shaped field. `decidedVia: "multi_reviewer_panel"`, `panelRevision`, `aggregationPolicyVersion`, `supportingReviewerCount` are the only new provenance fields written — never the full reviewer list, never raw vote text.

**Idempotency**: if the panel is already `"finalized"`, the function compares the caller's `expectedPanelRevision` against the panel's own pre-finalization revision (`panel.revision - 1`, since finalization always increments revision by exactly 1) — a match returns the ALREADY-STORED outcome as an idempotent success (`submissionStatus: "already_finalized"`, `finalizedAt` never rewritten — proven directly with a retry using a LATER `now`, confirming the ORIGINAL timestamp is returned unchanged) after verifying genuine consistency (`humanReview` non-reviewable, `decidedVia === "multi_reviewer_panel"`, `humanReview.status === panel.finalStatus`, `humanReview.panelRevision === panel.revision - 1`); a mismatch is `panel_stale` (predates a DIFFERENT completed finalization); any other disagreement — e.g. `humanReview` still reviewable despite the panel claiming finalized — fails closed as `inconsistent_finalization_state`, never guessing which side is authoritative (both proven directly, including the specific case of a genuinely inconsistent state constructed on purpose).

### 33.7 Secondary artifacts

All best-effort, attempted after canonical commit for BOTH a fresh finalization and an idempotent retry (every writer below is create-only/idempotent, so a retry safely reports `"already_exists"` rather than needing a separate code path) — none may roll back or invalidate the already-committed canonical success:

- **Panel finalization history** (NEW): `runs/{runId}/humanReviewPanelHistory/{revision}:panel_finalized`, create-only, metadata-only (`schemaVersion, eventType, teamId, runId, preFinalizationPanelRevision, finalizedPanelRevision, finalStatus, finalDecisionId, aggregationPolicyVersion, reviewerCount, submittedCount, supportingReviewerCount, actorUserId, finalizedAt`) — never vote comments/conditions/reviewer names/emails.
- **Adaptive human-review history** (REUSED, unmodified): the SAME `createAdaptiveHumanReviewHistory()`/`buildAdaptiveHumanReviewHistoryEntry()` the single-reviewer path already uses, keyed by the SAME `finalDecisionId` (prefixed `panel_dec_` vs. the single-reviewer path's `dec_`, so both coexist in the one collection without collision, both uniformly visible through the existing, unmodified history read endpoint/UI).
- **Governance event** (NEW writer, genuinely idempotent): `multi_reviewer_panel_finalized`, written via `.doc(id).create()` — deliberately NOT reusing the legacy `writeAdaptiveHumanReviewEvent()`'s `.add()`-based (random ID, non-idempotent) pattern; that writer and its existing callers remain completely untouched, per §27.8's own established precedent that distinct writers for distinct concerns are never silently unified.
- **Admin audit** (NEW writer): `adaptive_review_panel_finalized`, deterministic ID `` `adaptive-review-panel-finalization:${finalDecisionId}` ``, added to the audit reader's existing allowlist mechanism (`app/api/governance/audit/route.ts`, `GovernanceDashboard.tsx` label) — the exact same additive pattern §27.1 first established and every subsequent step has reused, confirmed once again that the reader does not silently drop the new action.
- **`teamRuns` projection sync** (REUSED, unmodified): the SAME `syncAdaptiveTeamRunProjectionAfterReview()` Part D's decision route already uses — no new field added to the projection type at all (§E15's own "optional" marker was deliberately not added, keeping `teamRuns` unchanged and this reuse total).

### 33.8 Repair service

`repairAdaptivePanelFinalizationArtifacts(runId, teamId)` (`lib/governance/adaptivePanelFinalizationRepair.ts`) — internal only, no route, mirroring every prior repair service's own precedent (no established protected public-repair pattern exists to reuse). Only ever targets an ALREADY-`"finalized"` panel — an open or cancelled panel returns `panel_not_finalized`, no repair attempted. Performs the identical consistency check the finalization transaction's own idempotent branch uses; any disagreement fails closed as `inconsistent`, reporting which specific check failed, never guessing. On a consistent state, attempts all four secondary artifacts plus the projection sync, each independently idempotent — `submittedCount` for the panel-history metadata is derived from a genuine (read-only) re-read of the immutable pre-finalization votes, never approximated. Never changes canonical `humanReview`, never changes `panel.finalStatus`, never reopens a panel, never modifies a vote — proven directly.

### 33.9 Finalized panel read contract

`GET .../review-panel` additively includes `finalStatus`, `finalizedAt`, `aggregationPolicyVersion` in the response ONLY when `status === "finalized"` — never `finalDecisionId`, `finalizedByUserId`, supporting reviewer IDs, vote text, or audit IDs. `GET .../votes`'s `panelStatus` field now naturally includes `"finalized"` as a possible value (no code change needed there — it already echoed whatever `panel.status` was).

### 33.10 Failure semantics

`400` invalid request; `401` unauthenticated; `403` unauthorized/opt-in disabled; `404` run/panel missing; `409` for `panel_stale`, `governance_stale`, `quorum_not_met` (with compact `submittedCount`/`quorum`, never votes), `panel_deadlocked`, `panel_cancelled`, `inconsistent_finalization_state`; `500` for malformed stored data or an unexpected aggregation-invalid result; `503` Firestore unavailable. No raw parser/Firestore details ever exposed. No automatic retry — deterministic idempotency (§33.6) is what makes a client-side retry-after-ambiguous-failure safe.

### 33.11 Firestore indexes and rules

**No composite index. No rules change.** Every read in the finalization transaction and the repair service is either a direct document-ID get or a bounded (≤9) set of deterministically-constructed direct gets — never a `.where()`/`.orderBy()` query, confirmed explicitly before writing any transaction code (§33.1's own resolution of the "critical issue"). Access remains Admin-SDK-only; default-deny client rules remain fully sufficient.

### 33.12 Manual verification — real, partial, honestly disclosed

**Genuinely performed**: started the local dev server against real project configuration; confirmed Firebase Admin initializes successfully; confirmed via real HTTP requests that the new finalize route and the modified review-panel route both compile, deploy, and correctly return `401` for an unauthenticated request with no server error.

**Not verified via a real, seeded, end-to-end flow, disclosed honestly**: creating a real team + panel + votes and exercising the full "vote → finalize → confirm canonical terminal state → confirm one history/event/audit entry → retry idempotently → confirm votes unchanged" round trip against live Firestore was not performed in this session — the same disclosed limitation as every prior step in this engagement (would require seeding real, persistent data). This is instead covered by: 28 finalization-transaction tests (including the exact idempotent-retry and inconsistent-state scenarios), 25 route-level contract tests, 16 repair-service tests, and 19+25+7 model/parser/audit-writer tests — all exercising the real production functions against a faithful in-memory Firestore-shaped fake. UI verification is explicitly out of scope for Part E (no UI exists yet — Part F).

### 33.13 Files changed

New: `lib/governance/adaptivePanelFinalization.ts` (decision ID, condition union, system comment, humanReview builder, panel-history builder), `lib/governance/adaptivePanelFinalizationRepair.ts`, `app/api/teams/adaptive-runs/[runId]/review-panel/finalize/route.ts`, and 6 new test files. Modified (additive only, each verified against its own pre-existing test suite before and after): `lib/adaptiveSchema/governanceRecord.ts` (+4 optional `humanReview` fields), `lib/governance/adaptiveHumanReviewPanel.ts` (+`"finalized"` status, +5 optional fields, +cross-field parser validation, +`buildFinalizedAdaptiveHumanReviewPanel`, +a more precise `panel_finalized` failure reason on the existing reconfigure/cancel functions), `lib/firestore/runs.ts` (+`finalizeAdaptiveHumanReviewPanel`, +`createAdaptivePanelFinalizationHistory`, +`writeAdaptivePanelFinalizationGovernanceEvent`), `lib/governance/auditLog.ts` (+`writeAdaptivePanelFinalizationAdminAuditEvent`), `app/api/teams/adaptive-runs/[runId]/review-panel/route.ts` (GET extension + new failure-reason mapping), `app/api/governance/audit/route.ts` (+1 action), `components/governance/GovernanceDashboard.tsx` (+1 label). No Firestore rules or indexes changed. No panel/vote/UI file outside these touched.

### 33.14 Tests added, defects found, and verification

121 new tests across 6 new files (19 panel-schema-extension + 25 pure-model + 7 admin-audit-writer + 28 finalization-transaction + 16 repair + 25 route) plus 1 new assertion in the existing audit-action-integration test file. Full suite: 2,410 → 2,531, exact match. Full Jest run twice (both: 135 suites / 2,531 tests / 56 snapshots, all passing), `tsc --noEmit` clean, `next lint` clean (pre-existing warnings only).

**Test-authoring defects found and fixed while writing the finalization-transaction test file — five in total, ALL classified as test-fixture/expectation errors, ZERO as production defects** (each individually re-verified against the real, unmodified production code before any test was changed):
1–2. Two "inconsistent state" test fixtures set `finalizedAt` later than `updatedAt` on a directly-constructed panel object, tripping the PARSER's own (correct, pre-existing) `finalizedAt <= updatedAt` cross-field check before the test could even reach the scenario it intended to prove — fixed by aligning `updatedAt` with `finalizedAt` in both fixtures.
3–4. Two concurrency tests assumed a vote/reconfigure attempt against an already-finalized panel would fail at a panel-specific check (`panel_stale`/`stale_revision`) — but the REAL, already-shipped, protected precedence order in both `submitAdaptiveHumanReviewVote` (Part C) and `submitAdaptiveHumanReviewPanel` (Part B) checks `governanceRecord.humanReview` terminality FIRST, before any panel-specific check — confirmed by reading the actual source, not assumed. Since finalization always writes a terminal `humanReview` in the same transaction as marking the panel finalized, both attempts are correctly rejected at the EARLIER, more fundamental gate (`not_pending`) in every real scenario. Fixed by correcting both expectations to `not_pending`, with the reasoning documented directly in the test file, and adding one additional, explicitly-constructed-edge-case test proving the newer `panel_finalized` reason (§33.2) is itself correct and reachable in the one hypothetical state where it would actually fire.
5. A "concurrent vote" test attempted to exercise the real `submitAdaptiveHumanReviewVote()` transaction, which reads a `teams/{teamId}` document — infrastructure this particular test file's fake never modeled (it only models `runs`/panel/vote documents) — causing an unrelated, silent `reviewer_not_assigned` failure. Fixed by seeding the vote document directly at its deterministic ID (the same production ID-builder every other fixture in the file already uses), isolating the test to exactly the property it claims to prove (finalization's own fresh vote-read behavior) without depending on unrelated infrastructure.

No production code was altered to produce any of these five fixes — confirmed directly by re-inspecting `git diff` on every production file before and after this cleanup pass.

### 33.15 What remains for Part F

No owner-only panel override, no panel/vote UI, no vote editing/withdrawal/supersession, no notifications, no due dates, no escalation exist anywhere in this codebase. Part F is exactly that: the owner-override UI/route and the panel/vote UI itself, built last, only once B–E's backend contracts (now fully complete) have proven stable — matching this engagement's own established discipline throughout every prior step.

## 34. Multi-Reviewer Owner Override and Panel/Vote UI — Part F (implemented, 2026-07-31)

### 34.1 Design-to-code reconciliation

Builds directly on Parts B–E (panel configuration, votes, the pure aggregation engine, aggregation finalization) without modifying any of their production behavior except one disclosed, additive fix (§34.4). Owner override is deliberately a SEPARATE finalization path from aggregation finalization — distinct decision-ID prefix, distinct `decidedVia`/`finalizedVia` value, distinct history/event/audit actions — never a variant or extension of §33's own finalization transaction.

### 34.2 Provenance schema extension

`AdaptiveHumanReviewPanelV1` (`lib/governance/adaptiveHumanReviewPanel.ts`) gains three additive, all-optional fields: `finalizedVia?: "aggregation" | "owner_override"`, `overrideJustificationPresent?: boolean`, `overrideByUserId?: string`. Absence of `finalizedVia` on a finalized panel is the PERMANENT, correct signal for "finalized before this field existed" (every Part-E-created finalized panel) — never backfilled. Parser cross-field rule: `finalizedVia` only valid when `status === "finalized"`; `overrideJustificationPresent`/`overrideByUserId` required together if and only if `finalizedVia === "owner_override"`, forbidden otherwise (including when `finalizedVia === "aggregation"`). `buildFinalizedAdaptiveHumanReviewPanel` (the aggregation path) now explicitly sets `finalizedVia: "aggregation"` going forward; a new `buildOwnerOverriddenAdaptiveHumanReviewPanel` sets `finalizedVia: "owner_override"` plus the two override fields. `GovernanceRecordV1.humanReview.decidedVia` gains `"multi_reviewer_owner_override"`; a new `overrideJustification?: string` field holds the FULL justification text in the canonical record only (never copied into any broad/shared artifact).

### 34.3 Pure override model (`lib/governance/adaptivePanelOverride.ts`)

`parseSubmitAdaptiveReviewOverrideRequest()` validates the raw client body (`expectedPanelRevision`, `expectedGovernanceUpdatedAt`, `status`, `justification`, `conditions?`) — reuses `validateConditionsForStatus` (extracted from Part D/E's `validateAdaptiveReviewCommentAndConditions` for exactly this reuse) for status/condition rules, `MAX_REVIEW_COMMENT_LENGTH` (4000) for the justification bound. `buildAdaptivePanelOverrideDecisionId()` hashes `owner_override:teamId:runId:panelRevision:status:justification:conditions` (SHA-256, `panel_override_dec_` prefix) — UNLIKE the aggregation decision ID, this DOES include the request's own content, because an override's entire outcome IS the request (no separate aggregation result exists to derive from); this makes an exact-content retry idempotent and any changed retry produce a different ID, which the transaction layer (§34.4) then recognizes as a conflict. `buildOverriddenMultiReviewerHumanReview()` builds the canonical `humanReview`, with `reviewerId` set to the OVERRIDING OWNER's uid (never a voter's), a fixed system comment ("Finalized by owner override.") for `changes_requested`/`rejected` (no free-text comment field exists on the override request itself), and the full `overrideJustification` text.

### 34.4 Override transaction (`overrideAdaptiveHumanReviewPanel`, `lib/firestore/runs.ts`)

Never reads, mutates, aggregates, or requires votes as a precondition — the entire outcome is the owner's already-validated request. Order: read run + panel → parse governanceRecord → if panel already `"finalized"`, compute the request's own would-be override decision ID against the panel's pre-finalization revision and compare it to the stored `finalDecisionId` (exact match + `finalizedVia === "owner_override"` → idempotent `already_overridden` success after a consistency check; any mismatch, including a panel finalized via aggregation or a DIFFERENT override request → `panel_already_finalized`, never overwritten) → if `"cancelled"`, reject → compare `governanceRecord.updatedAt` (before reviewability, mirroring every other transaction's precedent) → confirm reviewable (`not_pending`) → compare panel revision (`panel_stale`) → build and commit the canonical `humanReview` + finalized (via override) panel document atomically, writing ONLY those two things.

**Disclosed additive fix to Part E's own `finalizeAdaptiveHumanReviewPanel`**: its idempotency branch previously assumed any `"finalized"` panel it encountered was its own aggregation output, so an override-finalized panel tripped its `decidedVia === "multi_reviewer_panel"` consistency check and was reported as `inconsistent_finalization_state` — technically fail-closed and safe, but semantically wrong (implies corruption, not "already decided via a different valid path"). Fixed by checking `panel.finalizedVia === "owner_override"` FIRST and returning the new `panel_already_finalized` reason in that case — a pure additive branch: any pre-Part-F panel (no `finalizedVia` at all) or any `finalizedVia: "aggregation"` panel falls through to the exact same check as before, byte-for-byte unchanged. Found and fixed via a concurrency test in `adaptivePanelOverride.spec.ts`, documented directly in both the production code and the finalization test file.

### 34.5 Owner-only override route

`POST /api/teams/adaptive-runs/{runId}/review-panel/override`. Authorization: `memberRole(uid, team) !== "owner"` → `403 insufficient_role` — deliberately NOT `isTeamAdmin` (which also accepts `admin`); an admin can finalize a ready panel but can never override one. Same projection-validity/opt-in checks as every other panel route. Request body accepts only `expectedPanelRevision`, `expectedGovernanceUpdatedAt`, `status`, `justification`, `conditions?` — `teamId`, actor identity, `finalDecisionId`, timestamps other than the two concurrency tokens, vote IDs, quorum, and any aggregation result are never read from the body. Failure mapping mirrors the finalize route's own (`401`/`403`/`404`/`409`/`503`), plus the new `panel_already_finalized` → `409`.

### 34.6 Secondary artifacts and repair

After the canonical commit — best-effort, independently try/catch-wrapped, never rolling back canonical success: (1) the shared single-reviewer-shaped `humanReviewHistory` entry (reused as-is, populated from the canonical `humanReview`); (2) a NEW `panel_owner_overridden` entry in the SAME `humanReviewPanelHistory` subcollection the aggregation path uses (distinct `eventType`, `${revision}:panel_owner_overridden` ID — no collision), metadata-only (run/team IDs, panel revision, final status, decision ID, owner uid, finalizedAt, `overrideJustificationPresent: true`, `conditionsCount` — never the justification text or conditions text); (3) a `multi_reviewer_panel_owner_overridden` `governanceEvents` entry (`panel-owner-overridden:{finalDecisionId}` ID, distinct from aggregation's `panel-finalized:` prefix); (4) an `adaptive_review_panel_owner_overridden` `admin_audit_logs` entry (`adaptive-review-panel-override:{finalDecisionId}` ID, `source: "multi_reviewer_owner_override"`); (5) `teamRuns` projection sync (same shared function Part E uses). `repairAdaptivePanelOverrideArtifacts(runId, teamId)` (`lib/governance/adaptivePanelOverrideRepair.ts`) — a SEPARATE service from Part E's `repairAdaptivePanelFinalizationArtifacts`, targeting only `finalizedVia === "owner_override"` panels (explicitly reports `panel_not_overridden` for an aggregation-finalized or legacy panel, deferring to Part E's own repair service for those); fail-closed consistency checks include the override-specific ones (`decidedVia === "multi_reviewer_owner_override"`, `overrideJustification` non-empty, panel's own `overrideJustificationPresent`/`overrideByUserId` present). Never modifies votes, never reopens, never changes the final status. Not exposed via any route or UI button — internal-only, matching every prior repair service's own established precedent.

### 34.7 Panel detail read model (`GET .../review-panel`, extended)

Additive extension of the existing GET contract: per-reviewer `hasSubmittedVote`/`voteStatus`/`submittedAt`/`isCurrentUser` (bounded ≤9 deterministic vote reads, no collection query — the same pattern the finalization transaction and `GET .../votes` already use); `aggregationState: "waiting" | "deadlocked" | "ready" | "finalized"` recomputed FRESH from the pure engine every request (never stored) — `"finalized"` set directly from `panel.status` without recomputation; for a `"cancelled"` panel (which has no analogous aggregation-engine input, since the engine itself requires `panel.status === "open"`) `"waiting"` is used as an inert, safe default, never affecting any capability flag; `readyFinalStatus` present only when `"ready"`; `finalizedVia` (defaulting to `"aggregation"` when absent, for the same backward-compatibility reason as §34.2) plus `finalStatus`/`finalizedAt` when finalized; and four capability flags — `canManagePanel` (admin/owner, panel open, review reviewable), `canVote` (admin/owner, IS a panel reviewer, panel open, reviewable, hasn't voted), `canFinalize` (admin/owner, `aggregationState === "ready"`), `canOverride` (role EXACTLY `"owner"`, panel open, reviewable — independent of `aggregationState`, since an owner may override a waiting, deadlocked, OR ready panel, mirroring the override transaction's own actual precondition). Voter identity's `voteStatus`/`submittedAt` are visible to every OTHER reviewer too — a deliberate, spec-mandated narrowing of the vote route's own "comment/conditions text is self-only" rule to this one compact field; comment/conditions text is never returned by this endpoint for anyone, including the caller's own vote. Never exposes team IDs, actor IDs, emails, finalDecisionId, overrideByUserId, or overrideJustification.

### 34.8 UI

Five new client-side pieces (all `components/teamGovernance/`, all using the existing `cp-*` token system and the established `authedFetch`/`useAuth` conventions, none introducing a new design language):
- `AdaptiveReviewerSelectionList.tsx` — accessible checkbox listbox (2–9 reviewers, displayName only, no email), reused identically for panel create AND reconfigure.
- `AdaptivePanelVoteForm.tsx` — reuses the existing generic `AdaptiveReviewDecisionOption`/`AdaptiveReviewConditionsEditor` components (unmodified); one POST per submission, no auto-retry; comment is explicitly labeled "visible only to you."
- `AdaptivePanelOverrideForm.tsx` — visually distinct (amber-bordered) section, status selector, required justification (textarea, 4000-char bound shown live), conditions editor gated to `approved_with_conditions`, an explicit confirmation checkbox required before submission is even validated as complete, one POST, no auto-retry.
- `AdaptiveMultiReviewerPanelSection.tsx` — the orchestrating section: fetches `GET .../review-panel` and (for eligible-reviewer names) reuses the EXISTING `GET .../assignment` endpoint rather than adding a new one (identical `ELIGIBLE_REVIEWER_ROLES` eligibility either way); renders the no-panel/open/cancelled/finalized states per §F11; every mutating control (vote form, override form, finalize button, reconfigure/cancel controls) is gated EXCLUSIVELY on the server's own `canVote`/`canOverride`/`canFinalize`/`canManagePanel` flags — the client never independently re-derives a role/eligibility check, so no control can ever be shown to a caller the server would reject.
- `lib/client/adaptivePanelSubmission.ts` — one shared, pure error-code-to-safe-message mapper (`mapAdaptivePanelErrorCode`) reused by the vote, finalize, and override flows, since their server-side error vocabularies overlap heavily; every user-facing message is a fixed literal, never the server's own raw message text.

`AdaptiveReviewDetail.tsx` renders `AdaptiveMultiReviewerPanelSection` unconditionally, and hides the existing (UNCHANGED) single-reviewer `AdaptiveReviewAssignmentSection`/`AdaptiveReviewDecisionForm` exactly while the panel section reports its status as `"open"` or `"finalized"` — restored automatically once the panel is `"cancelled"` or absent. `AdaptiveReviewHistorySection` remains visible in every state (it is not single-reviewer-specific).

### 34.9 Operational hazard closure

Every open panel has a supported forward path: reviewers can vote while open and un-voted; a `"ready"` panel can be finalized by any admin/owner; a `"waiting"`/`"deadlocked"` panel can be reconfigured or cancelled by any admin/owner, OR overridden by the owner; no open panel is permanently stranded by the terminal-review gate, since override never depends on `aggregationState`.

### 34.10 Manual verification — real, partial, honestly disclosed

**Genuinely performed**: started the local dev server against real project configuration; confirmed clean compilation of every new/modified route and component; confirmed via real HTTP requests that `GET .../review-panel`, `POST .../review-panel/override`, and `POST .../review-panel/finalize` all correctly return `401` for an unauthenticated request with no server error; loaded `/team/reviews/[runId]` and `/team/reviews` in a real authenticated browser session and confirmed no client-side console errors and correct safe-error rendering (the authenticated test account has no team membership in this environment, so it correctly saw "You don't have access to this review" / "No team").

**Not verified via a real, seeded, end-to-end flow, disclosed honestly**: creating a real team with an owner and 2+ eligible reviewers, creating a panel, voting as two separate browser sessions to reach quorum, finalizing, deadlocking a separate panel and overriding it as the owner, and observing the live UI's quorum/state copy, vote-privacy behavior, and finalized/overridden states was NOT performed — the same disclosed limitation as every prior manual-verification step in this engagement (requires seeding real, persistent, multi-user Firestore data). This is instead covered by: 221 new automated tests (49 pure-model, 28 firestore-transaction, 21 secondary-artifact/admin-audit, 23 repair, 28 route, 3 end-to-end production-function contract tests, 14 client-lib, 42 UI structural/source-level) plus 17 new assertions extending the existing `GET .../review-panel` route test file and 4 extending `AdaptiveReviewDetail`'s own test file — all exercising the real production functions/components, either against a faithful in-memory Firestore-shaped fake (backend) or via `renderToStaticMarkup` plus source-level guarantees (UI, matching this engagement's established no-DOM/RTL testing precedent).

### 34.11 Files changed

New: `lib/governance/adaptivePanelOverride.ts`, `lib/governance/adaptivePanelOverrideRepair.ts`, `app/api/teams/adaptive-runs/[runId]/review-panel/override/route.ts`, `components/teamGovernance/AdaptiveReviewerSelectionList.tsx`, `AdaptivePanelVoteForm.tsx`, `AdaptivePanelOverrideForm.tsx`, `AdaptiveMultiReviewerPanelSection.tsx`, `lib/client/adaptivePanelSubmission.ts`, and 13 new test files. Modified (additive only, each verified against its own pre-existing test suite before and after): `lib/governance/adaptiveHumanReviewPanel.ts` (+3 optional fields, +cross-field validation, +`buildOwnerOverriddenAdaptiveHumanReviewPanel`, +`finalizedVia: "aggregation"` on the existing aggregation builder), `lib/governance/adaptiveHumanReviewRequest.ts` (extracted `validateConditionsForStatus`, behavior-preserving), `lib/adaptiveSchema/governanceRecord.ts` (+1 `decidedVia` union member, +1 optional field), `lib/firestore/runs.ts` (+`overrideAdaptiveHumanReviewPanel`, +2 secondary-artifact writers, +the disclosed `panel_already_finalized` fix to `finalizeAdaptiveHumanReviewPanel`), `lib/governance/auditLog.ts` (+`writeAdaptivePanelOverrideAdminAuditEvent`), `app/api/teams/adaptive-runs/[runId]/review-panel/route.ts` (GET response extension per §34.7), `app/api/governance/audit/route.ts` (+1 action), `components/governance/GovernanceDashboard.tsx` (+1 label), `components/teamGovernance/AdaptiveReviewDetail.tsx` (+panel-status-gated single-reviewer visibility). No Firestore rules or indexes changed — every new read remains a direct document-ID get or a bounded (≤9) deterministic set, never a query.

### 34.12 Tests added and verification

221 new tests across 13 new files, plus 17 new assertions in the existing `GET .../review-panel` route test file and 4 in `AdaptiveReviewDetail`'s own test file. Full suite: 2,531 → 2,752, exact match. Full Jest run twice (both: 148 suites / 2,752 tests / 56 snapshots, all passing), `tsc --noEmit` clean, `next lint` clean.

### 34.13 What remains

No admin override (owner-only, by design), no reviewer vote editing/withdrawal/supersession, no reopening a finalized panel, no comment threads, no notifications, no due dates, no escalation, no workload balancing, no auto-assignment, no adaptive export, no indexed pagination, no automatic reevaluation, no receipt refresh exist anywhere in this codebase — none of these were implemented, and none should be assumed to exist from this document. Multi-reviewer panels (Parts B–F) are now a complete, tested, backend-and-UI-complete feature; the remaining gap before genuine production confidence is the seeded, multi-user, live-Firestore manual walkthrough disclosed as not performed in §34.10.

## 19. Explicit scope note

This document fulfills Phase 2 steps 1-4 (audit, define semantics, decision receipt builders, record validation/immutability), Step 5 Parts A-C (write-lifecycle audit, governance initialization service, run-panel lifecycle wiring — LIVE for the 9 active Milestone 2 schemas), Step 6 Part A (System A audit) and its blocker verification/fix (adaptive runs can no longer reach legacy synthesis — LIVE), Step 6B Parts A-C (adaptive automated-governance design — §18, implementation — §18a, and route lifecycle wiring — §18b, all **LIVE** for the 9 active Milestone 2 schemas), Step 7 Part A (System B audit — §20, read-only), and Step 7 Part B (adaptive team-review DESIGN — §21, not yet implemented). System B adaptive integration implementation (Step 7 Parts C-E), `teamRuns` adaptive extension, the adaptive peer-review API, a team-governance dashboard, history UI display, export functionality, receipt refresh, an explicit reevaluation endpoint, `admin_audit_logs` integration for adaptive runs, and multi-reviewer support are all **NOT YET IMPLEMENTED / NOT YET WIRED.**

## 35. Multi-Reviewer Production-Readiness Hardening (Step 5) — closes the §34.10-disclosed gap

*(Numbered 35, not 20 — this document's numbered `## N.` headers are unique per-header identifiers, not the same sequence as the inline `§NN` Addendum markers used within §25–34's own prose; §20/§21 were already in use by unrelated 2026-07-30 sections above. This entry and the next were originally misnumbered 20/21, colliding with those; corrected here.)*

The gap disclosed at the end of §18 above — "the remaining gap before genuine production confidence is the seeded, multi-user, live-Firestore manual walkthrough disclosed as not performed in §34.10" — is now closed. A real seeded multi-user browser pass was performed against this repo's actual (only) Firebase project: owner, three admin-role reviewers, and one ordinary member, across all six deterministic scenarios (ready/deadlocked/waiting/finalized-by-aggregation/finalized-by-override/legacy), covering vote submission, vote privacy, vote immutability, owner-only override gating, the ordinary-member negative path, a genuine stale-write race (finalize-while-a-vote-form-is-open), and a full rollback round trip. Two release-boundary code changes were required to make this safe to ship: `MULTI_REVIEWER_GOVERNANCE_ENABLED` (a new global env-var kill-switch checked only at panel creation/reconfiguration, never at drain operations) and a fix to a real Part F defect where `GET .../review-panel` read votes at the wrong panel revision for a finalized/cancelled panel. Full detail — release-state model, rollback procedure, seed/cleanup harness safety design, observability contract, repair runbook, security/performance review, and the complete verification report — lives in `docs/operations/multi-reviewer-governance-runbook.md`, not duplicated here. **Recommendation: ship disabled** (both the global guard and every team's opt-in default to off already); enabling requires an operator to deliberately flip both.

## 36. Auth Lifecycle Hardening (Step 6) — the cross-cutting identity desync disclosed in §35 is now fixed

§35's own security review disclosed a cross-cutting session-identity desync, reproduced during that step's testing: a `__session` cookie left over from a PREVIOUS user could keep authorizing protected requests as the wrong identity after a different user signed in on the same browser, because `getRequestUid()` (`lib/teams/teamApiAuth.ts`) trusted a valid cookie unconditionally, without ever checking whether an accompanying bearer token disagreed — and because login/logout never actually verified or fully tore down the cookie. This step fixes it directly: `getRequestUid()` now rejects a request outright if a valid cookie and a valid bearer token decode to DIFFERENT uids; `components/AuthProvider.tsx` now owns an explicit session-synchronization state machine (`syncState`, only `"authenticated"` when client and server agree) driven by `onIdTokenChanged` with operation-generation race protection; login/signup wait for that state before redirecting and invalidate any existing different session first; logout now awaits the server cookie's actual deletion before considering itself complete. Multi-reviewer governance's own mutation buttons (vote/finalize/override/reconfigure/cancel) now additionally gate on this state (`canMutate`), not just the presence of a Firebase user object. Manually verified via two real seeded identities in a real browser: login, direct account switch (including a switch initiated in a DIFFERENT tab, reactively propagated), logout (server cookie confirmed cleared, protected endpoint confirmed 401 afterward), and multi-tab behavior (a tab whose session is invalidated elsewhere reactively shows a signed-out state with no manual reload). Full detail: `docs/operations/auth-session-sync-runbook.md`. Multi-reviewer governance's own release gates (§35) are unaffected by and independent of this fix — both remain off by default.

## 37. Repository-Wide Auth Identity Consistency Remediation (Step 7), now LIVE — closes §36's own disclosed remainder, plus a live-verified recovery fix

§36 fixed the identity-desync pattern for the 15 team/governance routes built on `getRequestUid()`, but explicitly disclosed that 14 OTHER routes — including the protected Claim Verification and Video Verification paths — independently duplicated the same vulnerable pattern and were left unfixed, out of that step's scope. This step closes that remainder, with explicit authorization to touch the Claim/Video paths for auth-only changes.

**Route count, corrected.** A repository-wide search (not just `app/api`, which is what the original disclosure was based on) found the real number was **19 routes across 15 code locations**: the originally-disclosed 14, plus 5 governance routes (`audit`, `audit/backfill`, `review`, `queue`, `policy`) that shared the vulnerability indirectly through a `lib/governance/authCheck.ts` helper a route-file-only search missed. Combined with §36's 15 routes, **34 routes total** now share one identity-resolution contract: `lib/auth/resolveRequestIdentity.ts`, with `getRequestUid()` and a new `resolveGovernanceRequestUser()` wrapper both reduced to thin, behavior-preserving callers of it.

**Claim Verification / Video Verification**: migrated with auth-only diffs — confirmed via `git diff` that every line outside the auth-resolution block is untouched; parsing, model dispatch, verdict computation, quota, token accounting, and audit logic are byte-identical. Neither route had any pre-existing test coverage before this step (disclosed, not created by it); new dedicated auth-boundary test files were added for both, using the routes' own first post-auth call (`checkRateLimit`) as the observable proof that the gate passed/failed correctly with the right uid, without mocking the verification pipelines themselves.

**Recovery — a live-verified dual-credential gap.** The first version of the shared resolver preserved §36's own "valid cookie + merely invalid bearer → authenticated via the cookie" carve-out. Manual verification against the real running server found this itself unsafe: a stale cookie for user A alongside an EXPIRED bearer token actually issued for a DIFFERENT user B still authenticated as A — the expired token made B's identity unverifiable, but its presence was silently discarded rather than treated as a conflicting second identity claim. Fixed by removing the carve-out: whenever both a cookie and a bearer credential are present, both must now independently validate AND resolve to the SAME uid, with no remaining case where one credential's failure is silently forgiven because the other happened to work. Re-verified live, after the fix, across all four required route families (Claim Verification, Video Verification, one other route, one team/governance route) — all now correctly fail closed on both a confirmed mismatch and a valid-cookie-plus-unverifiable-bearer combination.

**Intentionally not modified**: `verifyAdminToken`/`requireAdminApiAccess` (admin routes) extract the bearer token first, only falling back to the cookie when no `Authorization` header exists at all — immune to this pattern by construction, audited and confirmed, left as-is.

Full detail, live reproduction, and the complete fix inventory: `docs/operations/auth-session-sync-runbook.md`. No cookie-first or invalid-credential-fallback path remains anywhere in the repository. Multi-reviewer governance's own release gates remain independently off by default.

## 38. Controlled Enablement / Canary Rollout Rehearsal (Step 8) — no code change, full lifecycle re-verified live

**This step is a REHEARSAL, not a real production rollout.** It was run entirely against this repo's own non-production `gov-e2e-seed-*` harness (§35's seed/cleanup scripts, unchanged) on localhost — no production environment variable was changed, no real team was touched, no real deploy occurred. It produced a validated runbook (`docs/operations/multi-reviewer-governance-runbook.md` §11) for the operator to follow when performing the real rollout, and re-exercised every prior step's hardening live under real (rehearsal) conditions rather than by static review alone.

**What was newly exercised that no prior step had exercised live end-to-end:** all four panel-lifecycle paths in one continuous session, using real Firebase identities and real Firestore transactions rather than mocked tests:

1. **Ready path** — a live vote from a second reviewer identity brought a panel to quorum; Finalize produced a correctly-attributed, immutable "Approved via Panel vote" record.
2. **Deadlock/override path** — confirmed live (both via UI absence and direct code reading of `review-panel/override/route.ts`) that a team-admin cannot override and only the literal team owner can; the owner's override produced "Approved via Owner override," a provenance value distinct from the ready path's outcome, with both original votes preserved unchanged.
3. **Stale two-tab path** — the same identity finalizing the same panel from two tabs within ~2 seconds produced two HTTP 200s but exactly one finalization artifact (confirmed via a direct Firestore read), proving the finalize transaction (§34's transactional design) is genuinely idempotent under a same-identity race, not merely correct in the common case.
4. **Rollback-drain path** — with the global gate flipped off mid-open-panel, Finalize (a drain operation, §11's own release-boundary invariant) succeeded fully, live, confirming §35's non-destructive-rollback claim under an actual gate flip rather than by inspection.

**Repair drill.** §33's `repairAdaptivePanelFinalizationArtifacts()` was exercised against a real deleted artifact for the first time (previously only unit-tested against a fake Firestore): its `humanReviewPanelHistory` entry was deleted directly from a seeded finalized panel, repair restored it byte-identical, and a second repair run correctly reported `already_complete` with no duplicate. Canonical `governanceRecord.humanReview`, the panel's `finalStatus`/`revision`, and both vote documents were confirmed byte-identical before and after every step.

**Outcome:** no defect found in any of the above. The recommendation, per the rollout playbook's own stated default, is **limited expansion** (the existing canary team plus 1–2 additional volunteer teams, monitored for one real business week using the existing structured `logAdaptiveGovernanceEvent`/`admin_audit_logs` signals) rather than immediate general availability — a rehearsal against seed data is not a substitute for observing at least one real usage cycle before GA. Both release gates were restored to their documented default (`false`) at the end of this step.
