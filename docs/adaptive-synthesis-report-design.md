# Adaptive Synthesis Report — Product and Architecture Design

**Date:** 2026-08-05
**Scope:** design only, matching the precedent set by `docs/adaptive-research-export-design.md` — no components, routes, schema, or renderer-selection code changes were made producing this document. Existing code was read and grounded against; nothing was run or deployed.
**Relationship to the Export design:** this document is upstream of it. Per the sequencing recommendation in §8, `docs/adaptive-research-export-design.md`'s own Phase 1 (`ReportStatusBanner` + governance-status-on-primary-view) is **absorbed into this document's §4 top summary bar** rather than duplicated — Export's Phases 3–7 should not start until this document's report-module system exists, since exporting a report the app doesn't yet render coherently means designing file templates around an unfinished presentation model. See §8 for the reconciled sequence.

---

## 1. Executive summary

The product argument — that adaptive results currently collapse into a generic "Summary / Key Claims / Unified Answer" shape regardless of question type — is **already true for more schemas than it first appears**, and grounding it precisely changes the fix.

**Finding: the codebase already has two entirely different architectures for adaptive rendering today, and the product problem is that only one of them does what this brief asks.**

- **9 schemas** (`ranked_enumeration`, `comparison_matrix`, `definition_explanation`, `causal_explanation`, `checklist_taxonomy`, `deep_research`, `evidence_review`, `bias_blindspot_audit`, `decision_support` — the "Milestone 2" schemas) already have dedicated, question-type-specific renderers (`ComparisonMatrixView`, `RiskAnalysisView`, `CausalExplanationView`, `ScenarioTreeView`-adjacent work, etc.) that render **standalone**, bypassing the generic shell entirely (`AdaptivePanelResponse.tsx`).
- **9 schemas** (`contested_empirical`, `legal_regulatory`, `financial_valuation`, `procedural`, `medical_health`, `forecast_speculative`, `creative_generative`, `generic`, plus `graceful_limitation`) — the pre-existing "original 9" — **do** have their own dedicated per-schema view components (`ConsensusMapView`, `RuleApplicationView`, `MetricsGridView`, `StepDiffView`, `EvidenceTiersView`, `ScenarioTreeView`, `GalleryView`), but those views are only reachable as the **"Compare" tab**, buried behind three tabs (List / Compare / Synthesis) where the default landing tab is List and the Synthesis tab is the generic `AdaptiveSynthesisReportView` — "Unified Answer," "Trust Summary," "Panel Verdict Card" — regardless of schema. **A `forecast_speculative` question already has a real `ScenarioTreeView` with probability/leading-indicators built — it's just not what the user sees first.**
- **1 schema** (`factual_lookup`) already does almost exactly what this brief asks for its category: `DirectAnswerCard` is a lightweight, answer-first, non-generic renderer, explicitly built to avoid "the full synthesis-report shell."

**This means the module-composer architecture the brief proposes is not a net-new pattern to invent — it's the generalization of a pattern 10 of 19 active schemas already follow, applied to the other 9 (plus `factual_lookup`'s own precedent generalized as the "keep it short" case for genuinely simple answers).** The real work is: (1) give the original-9 schemas the same "standalone, question-type-specific, no generic shell" treatment their Milestone-2 siblings already have, and (2) build the shared summary-bar/tab/progressive-disclosure chrome around all 19 consistently, so a user can't tell which "generation" of the schema system produced their answer.

**Category gap, found while mapping the brief's 9 report types onto real schemas (§5):** two of the brief's proposed report types — **Due-Diligence** and **Timeline** — have **no corresponding classifiable schema today**, active or disabled. Every other Milestone-1/28-type taxonomy entry was reviewed; there is no `timeline`/`chronology` type at all, and `due_diligence` doesn't exist either (the closest analog, `evidence_review`, evaluates evidence *quality*, not a general due-diligence investigation). Per this project's own established policy (enforced throughout the query-routing redesign: *"no new schema/category without a real capability gap"*), **building report modules for these two categories is out of scope for this design** — it would require new classifier/schema work first, tracked separately, not invented here to fill out the brief's list. §5 marks these explicitly rather than silently mapping them onto a poor-fit existing schema.

---

## 2. Current-state audit (grounding)

| Concept | Current reality | File |
|---|---|---|
| Milestone-2 standalone routing | `AdaptivePanelResponse.tsx` branches on `schema.renderHint` BEFORE the tab shell — `comparison_grid`→`ComparisonMatrixView`, `checklist_taxonomy_view`→`ChecklistTaxonomyView`/`RiskAnalysisView` (risk-shaped), `causal_map`→`CausalExplanationView`, `deep_research_view`→`DeepResearchView`, `evidence_review_view`→`EvidenceReviewView`, `bias_blindspot_audit_view`→`BiasBlindspotAuditView`, `decision_support_view`→`DecisionSupportView`, `ranked_list`→`RankedListView`, `definition_card`→`DefinitionExplanationView` | `components/adaptive/AdaptivePanelResponse.tsx` |
| Original-9 tab-shell routing | Same file's final fallback (past every explicit branch): 3-tab `PanelViewTabs` (List / Compare / Synthesis), List is the default `viewMode`, Compare renders `AdaptiveResultsView` (which switches on `renderHint` again — `consensus_map`→`ConsensusMapView`, `rule_application`→`RuleApplicationView`, `metrics_grid`→`MetricsGridView`, `step_diff`→`StepDiffView`, `evidence_tiers`→`EvidenceTiersView`, `scenario_tree`→`ScenarioTreeView`, `gallery`→`GalleryView`, default→`GenericSectionsView`), Synthesis renders `AdaptiveSynthesisReportView` | same file, `AdaptiveResultsView.tsx` |
| The generic shell's actual content | `ADAPTIVE_SYNTHESIS_SECTION_IDS`: gate-banner → unified-answer → executive-summary → certainty → trust-summary → agreement-disagreement-map → single-model-insights → where-models-agree → disagreements → bias-blind-spots → narrative-sections → load-bearing-claims → panel-verdict → disclaimer → export-actions | `AdaptiveSynthesisReportView.tsx` |
| The one existing "answer-first" precedent | `DirectAnswerCard` — built specifically because *"one short verifiable answer shouldn't be wrapped in the full synthesis-report shell"* — same reasoning this brief makes for every other category | `DirectAnswerCard.tsx` |
| Governance status today | Computed (`GovernanceRecordV1.humanReview.status`) but rendered only on `/team/reviews/{runId}`, never inline on the result the brief's "top summary bar" wants it on | `governanceRecord.ts`, confirmed absent from every renderer in `components/adaptive/` |
| Consensus/agreement signals that already exist per schema | `comparison_matrix` cell `agreement: "consensus"\|"majority"\|"split"\|"single_source"`; `checklist_taxonomy` item `coverageRatio`; `decision_support` `recommendation.supportCount`/`totalModelsWithRecommendation`; `causal_explanation` factor `category` distribution; original-9 schemas' `AlignedClaim.status` (same vocabulary) | respective `*Alignment.ts` files |
| Shared UI primitives already built for exactly this pattern | `TintBadge`, `formatModelCoverage()` (4 modes: covered/agreed/assessed/converged), `SectionLabel`, `Card`, `EmptyStateCard` — the "one shared phrasing for every 'N of M models did X' badge" cleanup already happened once | `components/adaptive/shared.tsx` |

---

## 3. The four-layer model, grounded

| Brief's layer | Existing data it reads | Existing component(s) it corresponds to |
|---|---|---|
| 1. Final answer | `AdaptiveDecisionReceipt.conclusion` (already built, Export design §2) + `GovernanceRecordV1.humanReview.status` (already built, never shown inline) | **New** — no component renders both together today |
| 2. Question-type synthesis | Every schema's own result type (`ComparisonMatrixResult`, `DecisionSupportResult`, `ChecklistTaxonomyResult`, `CausalExplanationResult`, etc.) | Mix of existing standalone views (10/19 schemas) and the generic shell (9/19) — see §1 |
| 3. Trust and evidence | `AlignedClaim[]` + `AdaptiveTrustSummary` + `AdaptiveGateResult` + per-schema coverage/agreement fields | `AdaptiveSynthesisReportView`'s trust-summary/agreement-map/where-models-agree/bias-blind-spots sections — content exists, just currently mixed into the "everything" shell rather than a separable layer |
| 4. Supporting records | `AdaptiveModelResult[]` (raw), `humanReviewHistory`, `admin_audit_logs`, `decisionReceipt.basis` | `ListView`/`AdaptiveResultsView` compare mode (raw), `/team/reviews/{runId}` (governance — currently a separate page, not a tab) |

---

## 4. Screen structure

### 4.1 Top summary bar

| Field | Source | Notes |
|---|---|---|
| Report type | `SCHEMA_ANSWER_SHAPE[schemaId]` → a new display-label map (e.g. `comparison_matrix` → "Comparison Report", risk-shaped `checklist_taxonomy` → "Risk Analysis", `decision_support` → "Recommendation Memo") | Reuses the existing `PersistedAdaptiveSchemaId`/`SCHEMA_ANSWER_SHAPE` pairing (`persistedOutput.ts`) — no new schema-identity concept |
| Status | `GovernanceRecordV1.humanReview.status`, using the **already-resolved 8-status model** from `docs/adaptive-research-export-design.md` §4.1 (including the Unreviewed-pending / Not-reviewed-no-review-configured split) | Reuse verbatim — this is the exact status computation the Export design already specified; building it here fulfills that document's own Phase 1 |
| Models | `results.length` (attempted) / count `ok` | Already computed everywhere (`AdaptiveModelResult[]`) |
| Consensus | **New, lightweight derivation** — coarse Strong/Moderate/Weak/Split label per schema, from whichever agreement signal that schema already computes (§2's table, last row) | No schema computes a single scalar today; needs one small per-schema mapping function, not a new alignment pipeline |
| Source grounding | `CommonResponseMeta.evidenceQuality` / `AdaptiveDecisionReceipt.sourceBacked` / per-schema `AdaptiveSourceCoverage` | Already computed (`commonResponseMeta.ts`'s source-coverage adapters) |
| Generated | `PersistedAdaptiveOutputV1.generatedAt` | Already computed |

### 4.2 Primary navigation

| New tab | Absorbs | 
|---|---|
| **Synthesis Report** (always first, always rendered) | Layers 1 + 2 — the final answer banner plus the schema's question-type-specific report |
| **Model Responses** | Today's List View + Compare View (`ListView.tsx`, `AdaptiveResultsView.tsx`'s per-schema views used as the raw/compare surface, not the primary landing) |
| **Evidence** | Layer 3 — `AdaptiveSynthesisReportView`'s trust-summary/agreement-map/where-models-agree/bias-blind-spots content, as a drill-down, not the landing view |
| **Review & Governance** | Today's separate `/team/reviews/{runId}` page content, pulled inline as a tab on the result itself — conditions, reviewer decision, `humanReviewHistory` |

This is a genuine consolidation, not just a relabel: today, governance lives on a page a user has to separately navigate to (if they even know it exists), and "Compare"/"Synthesis" mean different things depending on which of the two architectures (§1) produced the run. One tab set, same four tabs, for all 19 schemas, closes both gaps at once.

---

## 5. Question-type report mapping (module composer)

### 5.1 Module vocabulary, grounded in real fields

| Module ID | Real source field(s) |
|---|---|
| `direct_conclusion` | `comparison_matrix.directConclusion`, `decision_support.recommendationRationale`, `causal_explanation.directAnswer`, `checklist_taxonomy.summary` (risk-framed), `deep_research.executiveSummary`, `evidence_review.overallAssessment`, `forecast_speculative`'s own summary field |
| `primary_table` | schema-specific: comparison grid, risk register, decision assessment matrix, causal factor list |
| `criteria` | `decision_support.criteria`/`userProvidedCriteria`, `comparison_matrix.attributes` |
| `tradeoffs` | `comparison_matrix.tradeoffs`, `decision_support.risks` (tradeoff-framed) |
| `best_use_recommendations` | `comparison_matrix.bestUseRecommendations` |
| `disagreements` | comparison `split` cells, `causal_explanation.disputedInterpretations`, `deep_research.disagreements` |
| `uncertainties` | universal — `AdaptiveDecisionReceipt.uncertainties`/`limitations` |
| `sources` | universal — `AdaptiveDecisionReceipt.sources` |
| `severity_likelihood`, `mitigations`, `monitoring_signals`, `residual_risk`, `unknowns` | risk-shaped `checklist_taxonomy` item fields (`severity`/`likelihood`/`mitigation`/`monitoringSignal`/`residualRisk`) + `notes` |
| `priority_actions` | **No source field exists yet** — same category of gap as the comparison narrative fields added this session; would need a new optional field on the risk-shaped item or result level |
| `decision_criteria`, `alternatives`, `conditions_for_change`, `next_steps` | `decision_support.criteria`/`options`/`sensitivityFindings`/`reversibleNextStep` |
| `red_flags`, `evidence_gaps` | `evidence_review.redFlags`/`applicabilityCaveats`, `deep_research.evidenceGaps` |
| `most_likely_explanation`, `alternative_explanations`, `disconfirming_evidence`, `recommended_checks` | `causal_explanation.factors` (by `category`), `.disputedInterpretations`, `.testsOrEvidenceNeeded` |
| `trend_direction`, `counter_signals`, `scenarios`, `monitoring_indicators` | `forecast_speculative.scenarios[]` (`probability`, `narrative`, `leadingIndicators`) |
| `chronology`, `turning_points`, `missing_periods` | **No source field or schema exists** — Timeline is a genuine gap, see §1 |

### 5.2 Report type → schema → module list

| Brief's report type | Existing schema | Module list | Status |
|---|---|---|---|
| Comparison report | `comparison_matrix` | `direct_conclusion, primary_table (matrix), criteria, tradeoffs, best_use_recommendations, disagreements, uncertainties, sources` | **Already built this session** — `ComparisonMatrixView` has every module except a separate `criteria` module (attributes are the matrix's own row headers today, not broken out) |
| Risk analysis report | `checklist_taxonomy`, risk-shaped | `direct_conclusion, primary_table (risk register), severity_likelihood, mitigations, monitoring_signals, residual_risk, unknowns, sources` — `priority_actions` deferred (no field yet) | **Already built this session** — `RiskAnalysisView` |
| Recommendation report | `decision_support` | `direct_conclusion, decision_criteria, primary_table (assessments), alternatives, tradeoffs, conditions_for_change, uncertainties, next_steps` | Schema and renderer (`DecisionSupportView`) already exist standalone — needs relabeling/restructuring to this module order, not new data |
| Due-diligence report | **None** | — | **Out of scope** — no schema exists; `evidence_review` is the nearest analog but evaluates evidence quality, not a general investigation. Requires new classifier/schema work, tracked separately. |
| Timeline report | **None** | — | **Out of scope** — no schema exists at all, active or disabled. |
| Factual lookup report | `factual_lookup` | `direct_conclusion, sources, uncertainties` (already the brief's own shorter list) | **Already built** — `DirectAnswerCard` is close to this today; minor restructuring to match module framing |
| Diagnostic report | `causal_explanation` | `most_likely_explanation, disconfirming_evidence, alternative_explanations, recommended_checks, uncertainties, sources` | Schema and renderer (`CausalExplanationView`) exist standalone — needs relabeling to "Diagnostic" framing when domain suggests diagnosis (same pattern as risk-shaped checklists), not new data |
| Trend analysis report | `forecast_speculative` | `direct_conclusion, trend_direction, counter_signals, scenarios, monitoring_indicators, uncertainties, sources` | Schema and renderer (`ScenarioTreeView`) exist, but currently reachable **only via the Compare tab** — this is the clearest concrete example of §1's core finding |

---

## 6. Consensus as a trust layer

Redesign target, using existing primitives (`TintBadge`, `formatModelCoverage()`) rather than new ones — attach a compact badge cluster directly to each finding row instead of a separate "Agreement/Disagreement Map" wall of cards:

```
Finding: AI can fabricate market statistics
[Strong consensus] [Agreed by 4 of 5 models] [Confidence: High] [Source grounding: Moderate] [Severity: High]
```

Each bracketed badge already has a real computed source: consensus/coverage from §2's per-schema agreement fields, confidence from `ClaimConfidence`/`certaintyScore` where computed, source grounding from `AdaptiveSourceCoverage`, severity from risk-shaped items' `severity` field. **The full Agreement/Disagreement Map is not removed — it moves to the Evidence tab as a drill-down**, per §4.2.

---

## 7. Progressive disclosure

| Initially visible (Synthesis Report tab) | Collapsed by default (Evidence / Model Responses / Review & Governance tabs) |
|---|---|
| Top summary bar, final answer, primary table/structure, top disagreements, next action | Every model's raw wording, full claim-alignment detail, methodology, extended bias analysis, complete governance/audit history |

This maps directly onto §4.2's tab split — "collapsed by default" mostly means "on a different tab," not accordion-nesting within one page, which keeps each tab's own content focused rather than introducing a second disclosure mechanism on top of the tabs.

---

## 8. Naming and the reconciled sequence

**Naming, per the brief:** primary title "Adaptive Synthesis Report," subtitle = the §4.1 report-type label. "Unified Answer" (the literal heading in `AdaptiveSynthesisReportView.tsx` and its own `ADAPTIVE_SYNTHESIS_SECTION_IDS` entry, `"unified-answer"`) is retired as user-facing copy once this system ships — the underlying section/data-testid can stay for continuity in tests, only the displayed label changes.

**Product requirement (added verbatim, per instruction):**

> Every adaptive research run must produce an Adaptive Synthesis Report whose structure, visual hierarchy, headings, tables, and decision-support elements reflect the classified question type and persisted answer schema.
>
> The report must present the final answer first, followed by question-type-specific findings, then consensus, disagreement, uncertainty, sources, reviewer decisions, governance evidence, and raw model responses through progressive disclosure.
>
> The adaptive report must not collapse all categories into a generic Summary, Key Claims, or Unified Answer layout.

**Reconciled sequence** (this document's proposed 7-step order, cross-referenced against the Export design's own phases):

1. Adaptive pipeline production validation *(already underway — see Export design §12.1's resolution: no structured canary ran, ongoing production traffic is the current monitoring window)*
2. Adaptive Synthesis Report design *(this document)*
3. Governance status integration into the main result screen *(§4.1's top summary bar — supersedes Export design's own "Phase 1" recommendation, not a duplicate of it)*
4. Category-specific report components *(§5.2 — 7 of 9 categories map to existing schemas/renderers needing restructuring, not new data; 2 are out of scope pending new schema work)*
5. Usability testing
6. Adaptive export design approval *(`docs/adaptive-research-export-design.md`, Phases 3–7 — should not begin implementation until step 4 above ships, since export renders a portable copy of whatever the in-app report shows)*
7. PDF implementation

**This document stops here.** No components, routes, schema, renderer-selection, or database changes were made while producing it.
