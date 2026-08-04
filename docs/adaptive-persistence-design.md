# Adaptive Result Persistence — Design (Phase 1, Query-Routing Redesign)

**Date:** 2026-07-28
**Status:** Verified design, written before any implementation code was touched, per Phase 1's own change-control order.
**Source of truth this builds on:** `docs/query-routing-completion-audit.md` §6 ("Persistence") and §4 ("Common response envelope") — both confirmed, not assumed, in Phase 0.

---

## 1. Current run-document shape (verified)

`runs/{runId}` (Firestore), written by `lib/firestore/runs.ts`:

| Field | Written by | Purpose |
|---|---|---|
| `userId`, `question`, `selectedModels`, `status`, `createdAt` | `createRun()` | Set at run start, `status: "running"` |
| `runDocument: RunDocument` | `completeRun()` | Compact per-model data: `perModel[]` (`modelId`, `status`, `rawTextTruncated` — capped at `MAX_CHARS_STORAGE_PER_MODEL = 20000` chars/model, `latencyMs`, `tokenUsage`, `wasTruncated`), `totals` (token counts), `flags.storageTruncated/synthesisTruncated` |
| `tokenUsage.byModel/totals`, `totalTokens`, `tokensByModel`, `tokensByProvider` | `completeRun()` | Legacy + current token accounting, unchanged by this phase |
| `synthesizedReportV2`, `synthesizedStructuredReport`, `schemaVersion` (=1), `synthesisConsensusSummary`, `synthesizedBy` | `app/api/synthesize-panel/route.ts` (separate write, not `runs.ts`) | Legacy claims-matrix narrative synthesis cache, `schemaVersion` here is the **synthesis cache's own** version marker — unrelated to the new adaptive envelope's version |
| `governanceStatus`, `teamGovernance` | `lib/governance/teamGovernancePipeline.ts` (merge write) | Legacy org-governance snapshot, `runType: "research" \| "verification"` only |
| `errorMessage` | `markRunError()` | Set on failure |

**Confirmed absent:** `classification`, `schemaId`, `answerShape`, any of the 9 Milestone-2 result shapes, `CommonResponseMeta`. Zero adaptive fields exist on this document today (re-confirmed by reading `lib/firestore/runs.ts` in full again this pass — no change since Phase 0).

## 2. Write lifecycle (current, unchanged by this phase except where noted)

1. `app/api/run-panel/route.ts` POST handler: auth → rate limit → validate → `planAdaptiveRun()` (classify + route) → if non-active, return early (§7, unchanged) → `checkAndIncrementUsageForRun()` (quota) → `createRun()` → `runPanel()` (model fan-out) → build `panelResultsPublic` → `completeRun()` (persists `runDocument` + tokens) → `finalizeAdaptiveRun()` (validates/aligns adaptive output, **in-memory only today**) → JSON response including `adaptive` payload.
2. **New in this phase:** after `finalizeAdaptiveRun()` succeeds, build `CommonResponseMeta` + `PersistedAdaptiveOutputV1`, then a second, additive Firestore write (`persistAdaptiveOutput()`) — see §5.

## 3. Read lifecycles

- **List** (`GET /api/user/panel-history`): reads `runs`, `verifications`, `videoVerifications` collections, merges, sorts, paginates. Per run it reads only `data.runDocument?.perModel`/`data.selectedModels` for a `modelsOk`/`modelsTotal` summary and `data.synthesisConsensusScore`/`data.governanceStatus` — **it never touches `data.runDocument.perModel[].rawTextTruncated` contents**, i.e. it's already summary-only by construction. Confirmed by full read of `app/api/user/panel-history/route.ts` this pass.
- **Detail** (`GET /api/user/runs/[runId]`): reads the full doc, rehydrates `results` from `runDocument`, returns `synthesisCache` (legacy V1 only), `governance` (legacy `teamGovernance` flags). Confirmed by full read this pass (Phase 0) — no `queryType`/`answerShape`/`adaptive` anywhere.

## 4. Firestore document-size assessment

Existing safety machinery (`lib/panel/sanitizeText.ts`, unchanged): `MAX_CHARS_STORAGE_PER_MODEL = 20000`, `MAX_TOTAL_DOC_SIZE = 850000` (chars, safety margin under Firestore's 1 MiB/doc limit), `estimateDocumentSize()` (JSON-stringify-length estimate), with existing graceful degradation (`completeRun()` already re-truncates `perModel` more aggressively if the combined doc would exceed `MAX_TOTAL_DOC_SIZE`).

**Worst-case size estimate for the adaptive envelope itself**, computed from each schema's actual `maxItems`/`maxWords` caps in `schemaRegistry.ts` (the AGGREGATED result is bounded by these caps regardless of panel size — this is the key safety property: unlike raw per-model text, which scales with model count × per-model cap, an aggregated adaptive result is capped once, after merging):

| Schema | Bounding caps (from `schemaRegistry.ts`) | Worst-case estimate |
|---|---|---|
| `comparison_matrix` | 60 cells, each carrying `valuesByModel` (one entry per contributing model, up to 5) + up to 5 sources + rationale | **~50-60 KB** — the largest of the 9, because cells retain a per-model value map rather than a single merged value |
| `deep_research` | 10 findings + up to 5 low-confidence, 5 disagreements, 5 evidence gaps, 8 sources | ~15-25 KB |
| `decision_support` | 8 options, 8 criteria, 40 assessments (id+labels+~30-word text), 8 risks | ~10-15 KB |
| `bias_blindspot_audit` | 3 attributed findings (`MAX_BIAS_FINDINGS`), ~3-5 blind spots, small diagnostics object | ~5-10 KB |
| Remaining 5 (`ranked_enumeration`, `definition_explanation`, `causal_explanation`, `checklist_taxonomy`, `evidence_review`) | All ≤50 items with short per-item text | ~5-15 KB each |

**Conclusion: even the largest schema's worst-case envelope (~60 KB) is under 10% of the existing 850 KB safety budget**, and the existing raw-text budget (up to 100 KB for 5 models × 20 KB) plus the new envelope together stay comfortably under 200 KB combined — nowhere near Firestore's 1 MiB hard limit.

**Decision: embed the adaptive envelope directly in the run document** (`runs/{runId}.adaptiveOutput`), not a subcollection. This is "the simplest safe approach supported by the audit" per the phase's own instruction — a subcollection (`runs/{runId}/adaptive/output`) would add a second read round-trip, ownership-check duplication, and delete-cascade complexity for a size risk that the numbers above don't actually support. If a future schema's caps grow materially (e.g. a 200-item list type), this decision should be revisited — documented as a known constraint, not a permanent one.

The existing `estimateDocumentSize()`/`MAX_TOTAL_DOC_SIZE` guard is extended to include `adaptiveOutput` in its size calculation before write (§5) — if the combined document would exceed budget, the write **omits `adaptiveOutput` rather than failing the whole run**, since raw per-model results and token accounting must never be lost because of a downstream, lower-priority field. This mirrors the existing "degrade gracefully, never fail the run" posture already used for `perModel` truncation.

## 5. Versioned envelope + persistence contract

```ts
// lib/adaptiveSchema/persistedOutput.ts
type PersistedQueryClassification = QueryClassification; // semantic data already; no UI state to strip

interface PersistedAdaptiveOutputBase {
  version: 1;
  classification: PersistedQueryClassification;
  meta: CommonResponseMeta; // extended, see technical-documentation.md
  generatedAt: string; // ISO
}

type PersistedAdaptiveOutputV1 =
  | (PersistedAdaptiveOutputBase & { schemaId: "ranked_enumeration"; answerShape: "ranked_list"; result: RankedEnumerationResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "comparison_matrix"; answerShape: "comparison_grid"; result: ComparisonMatrixResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "definition_explanation"; answerShape: "definition_card"; result: DefinitionExplanationResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "causal_explanation"; answerShape: "causal_map"; result: CausalExplanationResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "checklist_taxonomy"; answerShape: "checklist_taxonomy_view"; result: ChecklistTaxonomyResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "deep_research"; answerShape: "deep_research_view"; result: DeepResearchResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "evidence_review"; answerShape: "evidence_review_view"; result: EvidenceReviewResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "bias_blindspot_audit"; answerShape: "bias_blindspot_audit_view"; result: BiasBlindspotAuditResult })
  | (PersistedAdaptiveOutputBase & { schemaId: "decision_support"; answerShape: "decision_support_view"; result: DecisionSupportResult });

type PersistedAdaptiveOutput = PersistedAdaptiveOutputV1;
```

`answerShape` string values verified directly against `SCHEMA_REGISTRY`/`AnswerShape` (`types.ts`) this pass, not invented from the prompt — they match exactly what each schema's `renderHint` already is.

Runtime validation via Zod (matching the codebase's existing convention in `validator.ts`), never unchecked casting. Failure modes are all non-throwing and return a discriminated result:

```ts
type ParsedPersistedAdaptiveOutput =
  | { ok: true; output: PersistedAdaptiveOutput }
  | { ok: false; reason: "absent" | "unsupported_version" | "malformed" };
```

## 6. Write path

Additive, after `finalizeAdaptiveRun()` succeeds, in the SAME request (no separate retry job): `runs/{runId}` gets a merge-update with `adaptiveOutput: PersistedAdaptiveOutputV1 | undefined` (only set when a schema-specific result exists — i.e. only for the 9 active dedicated schemas, never for the 10 legacy-active types that stay on the claims-matrix pipeline, per "existing legacy schemas remain unchanged unless strictly required" — no persistence adapter is added for them in this phase). A rerun of the same question creates a **new** `runId` (existing behavior, unchanged) — so "overwriting an approved decision receipt" (a Phase 2 concern) doesn't apply here; each write is to its own run's document, once.

Failure handling: caught, logged (metadata only — `runId`, `schemaId`, error message, never question text), response still returns the live `adaptiveOutput` (already computed, in memory) with a `persistenceStatus` reflecting what happened. **`persistenceStatus` is a 4-state enum, not 3** — `"saved" | "failed" | "omitted_size_limit" | "not_applicable"` — because "the size guard deliberately skipped this write" and "the write genuinely failed" are different outcomes with different implications (the first is an expected, deterministic consequence of this run's own content; the second is worth alerting on if it recurs) and must never be collapsed into one ambiguous "failed" bucket. `persistAdaptiveOutput()`'s own return type distinguishes the three failure reasons (`"firestore_unavailable" | "oversized" | "write_failed"`); the caller (`route.ts`) maps `"oversized"` specifically to `"omitted_size_limit"`, everything else to `"failed"`. No retry, no re-run, no second quota charge — quota was already charged once, at `checkAndIncrementUsageForRun()`, entirely before this write.

## 7. Read path

- **List** (`panel-history`): gains two summary-only fields per research item (`hasAdaptiveOutput?: boolean`, `adaptiveSchemaId?: QueryType`) — read directly off `data.adaptiveOutput?.schemaId` without touching `result`/`meta`. No behavior change to existing fields.
- **Detail** (`user/runs/[runId]`): reads `data.adaptiveOutput`, runs it through the Step-2 validator, returns one of `{status: "valid", output}` / `{status: "absent"}` / `{status: "malformed"}` / `{status: "unsupported_version"}`. Client never reclassifies or reruns models based on the result.

## 8. Backward compatibility

Every field this phase adds is optional at the persistence boundary (`adaptiveOutput?`). No migration script, no rewrite of existing documents. A pre-Phase-1 run has `adaptiveOutput` simply absent → read path returns `{status: "absent"}` → client falls back to the existing legacy raw-model-text rendering path, unchanged.

## 9a. Implementation confirmation (post-build, 2026-07-29)

The design above was implemented as written — no deviations worth flagging. Concretely, this is where each piece landed:

- Envelope + validator: `lib/adaptiveSchema/persistedOutput.ts` (`PersistedAdaptiveOutputV1`, `parsePersistedAdaptiveOutput`).
- `CommonResponseMeta`'s new fields: added additively to the EXISTING type (`types.ts`), not a parallel type — see `technical-documentation.md`'s Phase 1 section for why (in short: the existing type already had `humanReviewNeeded`/`generatedAt`, reused directly rather than duplicated under new names like `requiresHumanReview`).
- Shared builder + adapters: `lib/adaptiveSchema/commonResponseMeta.ts` (`buildCommonResponseMeta`, `getAdaptiveSourceCoverage`, `getAdaptiveHumanReviewSignals`, `getAdaptiveLimitations`).
- Orchestration wiring: one new helper, `attachAdaptiveEnvelope()`, in `lib/adaptiveSchema/orchestrate.ts`, called once per schema branch (9 call sites, one line each) rather than duplicating the builder call nine times.
- Firestore write: `persistAdaptiveOutput()` in `lib/firestore/runs.ts`, additive merge write, size-guarded with the existing `estimateDocumentSize`/`MAX_TOTAL_DOC_SIZE`.
- Read paths: `app/api/user/panel-history/route.ts` (summary fields only), `app/api/user/runs/[runId]/route.ts` (full validated envelope).
- Client restoration: `lib/user/adaptivePersistedOutputAdapter.ts` + `app/page.tsx`'s `openHistoryItem`.

One size-estimate caveat worth recording: the §4 worst-case figures were computed from each schema's declared `maxItems`/`maxWords` caps, not measured against a real maximally-filled live response. They're a ceiling based on the contract models are given, not an empirical measurement — treat them as directionally trustworthy (comfortably under budget by roughly an order of magnitude) rather than exact.

## 9. Known remaining debt (unchanged from the Phase 0 audit, not resolved by this phase)

- Export, peer review, decision receipts, governance schema-awareness — explicitly out of scope for Phase 1, deferred to Phase 2 per the phase boundary.
- The 10 legacy-active schemas (contested_empirical, legal_regulatory, financial_valuation, factual_lookup, procedural, medical_health, forecast_speculative, creative_generative, generic, graceful_limitation) do not get a `PersistedAdaptiveOutputV1` entry — they continue to rely on `runDocument`/legacy synthesis cache persistence, unchanged. Extending the envelope to cover them is future work, not required by "every active adaptive result" (which this phase reads as the 9 Milestone-2 dedicated-renderer schemas, since those are the ones whose result shape doesn't survive reload today at all).
