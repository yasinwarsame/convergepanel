# `ApiVerificationResultV1` — canonical result schema (API-0 proposal)

**Status:** design proposal. Nothing here is implemented. The implementation (API-3/API-4) will be a **new** Zod schema `lib/apiPlatform/resultSchema.ts` and a **new** pure projection `lib/apiPlatform/projectResult.ts`, modelled on `lib/adaptiveSchema/jsonExportSchema.ts` and `lib/adaptiveSchema/jsonExport.ts`. The OpenAPI component schemas in [`openapi.yaml`](openapi.yaml) must stay identical in meaning to this document.

## 1. Rules

1. **Re-serialization only.** Every value in a result is copied, renamed, selected or re-encoded from a structure the web pipeline already produced for this run. The projection never calls a model, never invents a formula, never averages, never interpolates and never fills a gap. If a value does not exist internally, its section is `unavailable` with a reason.
2. **Allowed projection operations:**
   - field rename (camelCase to snake_case);
   - enum pass-through;
   - selecting a subset of fields;
   - counting array elements already present (for example, usable slots);
   - mapping an internal status to the public vocabulary through a fixed table (§4.9);
   - choosing an availability state from facts already present (for example, "every slot `parseHealth: failed`" → `unavailable`);
   - attaching a static methodology descriptor (§6);
   - calling an **existing pure web-pipeline function** on this run's own data, exactly as the web UI or the web export already does: `deriveConsensusLevel` (`lib/adaptiveSchema/reportSummary.ts`), `buildAdaptiveDecisionReceipt` (`lib/adaptiveSchema/decisionReceiptBuilder.ts`, as `exportSnapshot.ts` calls it) and `normalizeSourceUrls` (`lib/adaptiveSchema/sourceUrlNormalization.ts`). This is the PRD §6.4 rule: a derived value may come only from a function the web pipeline also uses.
3. **Forbidden:** new prompts, new formulas, rewording model text, inventing a default verdict, emitting `0` / `""` / `"unknown"` / `"not_applicable"` as a finding, hiding a failed slot.
4. **CR-1.** A section whose `availability` is `completed` or `partial` has a non-null `methodology`, and its `limitations` contain the baseline code that matches `methodology.basis` (§6.2). The JSON Schema enforces this per basis.
5. **Projection input.** The worker projects from the in-memory return values of the panel step: `executeOrdinaryRun`'s `OrdinaryRunExecutionResult` for research, `executeClaimVerification`'s result for claims, and `executeSynthesis`'s result for synthesis. These are persisted as the step outputs (`jobs-and-idempotency.md` §4.1). The projection never re-reads web collections, and never assumes an envelope carries more than its type declares (§4.0).

## 2. Top-level shape

| Field | Type | Notes |
|---|---|---|
| `object` | `"verification"` | |
| `id` | `ver_` + 24 base62 | |
| `format_version` | `"1"` | Shape version (§7) |
| `type` | `"claim" \| "research"` | First release scope |
| `status` | job status | `queued \| running \| synthesizing \| completed \| partial \| failed \| canceled \| expired` (internal `pending_dispatch` is reported as `queued`) |
| `mode` | `"live" \| "test"` | `test` results are fixtures (sandbox) |
| `created_at`, `completed_at` | RFC 3339 | `completed_at` null until terminal |
| `application_id` | `app_…` | |
| `metadata` | object ≤ 20 string keys | Customer-supplied, echoed |
| `input` | `InputSummary` | Length, HMAC fingerprint, `retained` flag. Never the text unless `retain_input` and the result is fetched by an authorized key (§3.2) |
| `research_schema` | `{ id, family } \| null` | Research only: the executed schema ID and its family (`dedicated` or `claims_matrix`, §4.0). `null` for claims and for research jobs that never executed a schema |
| `verification_basis` | `VerificationBasis` | CR-1 top-level statement |
| `verdict` | `Section<VerdictData>` | |
| `certainty` | `Section<CertaintyData>` | |
| `consensus` | `Section<ConsensusData>` | |
| `trust` | `Section<TrustData>` | Claim: always `unavailable` (OD-9) |
| `disagreements` | `Section<Disagreement[]>` | |
| `synthesis` | `Section<SynthesisSummary>` | Research only, opt-in; full synthesis on `/report` |
| `evidence` | `Section<EvidenceItem[]>` | |
| `limitations` | `Limitation[]` | Run-level union |
| `uncertainties` | `string[] \| null` | Verbatim from the source where one exists (§4.10); `null` when the type or family produces none |
| `human_review_recommended` | `boolean \| null` | Verbatim `CommonResponseMeta.humanReviewNeeded` (dedicated family); `null` where no source field exists |
| `verification_status` | `VerificationStatus` | Job state + automated governance |
| `failure` | `{ code, message } \| null` | Only when `status` is `failed`, `canceled` or `expired` |
| `models` | `{ href }` | Link to compact per-model results |
| `report` | `{ href }` | Link to the narrative layer |
| `usage` | `{ credits_reserved, credits_charged }` | Integers. `credits_charged` null until settled |

## 3. Sections and availability

### 3.1 Section wrapper

```
Section<T> = {
  availability: "completed" | "partial" | "failed" | "unavailable" | "not_requested",
  reason:       { code: string, message: string } | null,   // key always present
  methodology:  Methodology | null,
  limitations:  Limitation[],
  data:         T | null
}
```

| State | `data` | `reason` | `methodology` | When |
|---|---|---|---|---|
| `completed` | required | null | required | Computed from all usable inputs of the selected panel |
| `partial` | required | required | required | Computed from a reduced input set; `reason` states the denominator |
| `failed` | null | required | null | Attempted and errored (e.g. synthesis LLM call failed) |
| `unavailable` | null | required | null | Not produced; see the reason codes below |
| `not_requested` | null | null or code | null | Customer did not ask (e.g. `synthesis: false`, full model text) |

**`unavailable` reason codes.**
- **By design** (does not by itself make a job `partial`): `methodology_not_supported` (OD-9 claim trust), `not_applicable` (the field has no meaning for the type), `not_produced` (the existing pipeline does not produce this for this type or research family, §4.0), `evidence_quality_not_applicable`, `no_url_citations`.
- **Data-dependent** (makes the job `partial` when a primary outcome exists): `inputs_missing`, `all_models_unparseable`, `evidence_quality_unknown`.

**Primary outcome.**
- Claim: `verdict.data.label`.
- Research `claims_matrix` family: the gate (`verdict.data.gate_status`).
- Research `dedicated` family: the schema result (`adaptiveOutput.result`, served on `/report` `schema_result`).

**Job `status`.**
- `completed` if every requested section is `completed`, or `unavailable` with a by-design code.
- `partial` if any requested section is `partial`, `failed`, or `unavailable` with a data-dependent code, and a primary outcome exists.
- `failed` if no primary outcome exists (failure codes in `jobs-and-idempotency.md` §3).

### 3.2 Input summary (OD-10 class a)

`{ "char_count": 182, "context_char_count": 0, "fingerprint": "hmac256:<hex>", "retained": false }`. The fingerprint is `HMAC-SHA256(org-scoped key, normalized input)`, so it cannot be compared across orgs. It lets a customer prove a re-submission is the same input without ConvergePanel keeping the text.

### 3.3 Verification basis (CR-1)

```json
{ "kind": "model_consensus",
  "independent_source_check": "not_performed",
  "statement": "Agreement among AI models. Not independent evidence that the claim is true." }
```

`kind` is an open enum. v1 emits only `model_consensus`. `independent_source_check` is `not_performed` in v1. A future `performed` value requires a web-side methodology first.

### 3.4 Verification status

```json
{ "state": "partial",
  "governance": { "automated_status": "not_evaluated", "human_review": "not_available_via_api" } }
```

`automated_status` is copied from `OrdinaryRunAdaptivePayload.automatedGovernanceStatus` (`lib/runPanelExecution.ts`: `passed | flagged | blocked | not_evaluated | error`). That field is set only for the `dedicated` research family, because only that family builds a `GovernanceRecordV1`. It is `not_evaluated` for claims, for the `claims_matrix` family, and whenever the field is absent. No reviewer identities, queues or override text are exposed.

## 4. Section data

### 4.0 Research families and pipeline switches (normative)

`finalizeAdaptiveRun` (`lib/adaptiveSchema/orchestrate.ts`) has two disjoint output shapes. `executeOrdinaryRun` returns them as `OrdinaryRunAdaptivePayload`:

| Family | Schemas | What exists for the projection | What does **not** exist |
|---|---|---|---|
| `dedicated` | The 9 Milestone-2 schemas: `ranked_enumeration`, `comparison_matrix`, `definition_explanation`, `causal_explanation`, `checklist_taxonomy`, `deep_research`, `evidence_review`, `bias_blindspot_audit`, `decision_support` | `adaptiveOutput` = `PersistedAdaptiveOutputV1` (`lib/adaptiveSchema/persistedOutput.ts`: `version`, `schemaId`, `answerShape`, `classification`, `meta: CommonResponseMeta`, `result`, `generatedAt`); `meta`; the per-schema field (e.g. `decisionSupport`); `automatedGovernanceStatus` | `alignedClaims`, `gate`, `trustSummary`, `synthesisReport` (each schema branch returns before that pipeline); any `sources[]` field on the envelope |
| `claims_matrix` | Every other executed schema. This includes the legacy-active family in `PERSISTED_LEGACY_ADAPTIVE_SCHEMA_IDS` (`procedural`, `contested_empirical`, `legal_regulatory`, `financial_valuation`, `factual_lookup`, `medical_health`, `forecast_speculative`, `creative_generative`, `generic`) | `results` (`AdaptiveModelResult[]`), `alignedClaims`; and, when `ADAPTIVE_VERIFICATION_ENABLED` is on and `alignedClaims` is non-empty, `gate` (`AdaptiveGateResult`), `synthesisReport` (`AdaptiveSynthesisReport`) and `trustSummary` (`AdaptiveTrustSummary`) | `adaptiveOutput`, `meta` (so no `CommonResponseMeta`), governance record, decision receipt. `PersistedLegacyAdaptiveOutputV1` carries the same fields, for persistence only |

**Pipeline switches.**
- `ADAPTIVE_SCHEMAS_ENABLED` off: the web route builds no adaptive plan (`resolveAdaptiveSchemasAdmission` in `app/api/run-panel/route.ts`). Its canary UIDs are web users and never apply to an API principal.
- `ADAPTIVE_VERIFICATION_ENABLED` off: the `claims_matrix` family returns only unscored `alignedClaims`.

The API therefore offers `type: "research"` **only while both switches are on**. Otherwise `GET /v1/models` omits `research` from `types`, creates return `422 type_unavailable` before any reservation, and a job queued before a switch change fails `pipeline_disabled` at its step-start check with a full release (`jobs-and-idempotency.md` §4.2). Research never returns a gutted, unscored result.

**Other research outcomes.**
- Non-active routing (handoff, disabled, clarification, graceful limitation): `failed: query_not_executable`.
- `claims_matrix` with empty `alignedClaims`, which today is always `creative_generative`: no gate, so `failed: no_comparable_claims`.
- `finalizeAdaptiveRun` threw, so `executeOrdinaryRun` returned no `adaptive`: `failed: adaptive_finalize_failed`.

### 4.1 Verdict (`VerdictData`)

| Field | Claim | Research `claims_matrix` | Research `dedicated` |
|---|---|---|---|
| `label` | `computeClaimVerdict` (`confirmed \| disputed \| partially_true \| unverifiable`) | null | — |
| `gate_status` | null | `gate.status` (`pass \| caution \| fail`) | — |
| `load_bearing_split_count` | null | `gate.loadBearingSplitCount` | — |
| Section | `completed`/`partial`, `cp.claim_verdict` | `completed`/`partial`, `cp.adaptive_gate` | **`unavailable`, `not_produced`**: these schemas produce no gate. Their conclusion is the schema result and decision receipt on `/report` |

A null field inside a `completed`/`partial` section always means "does not apply to this type". It never means "missing".

### 4.2 Certainty (`CertaintyData`)

| Field | Claim | Research `claims_matrix` | Research `dedicated` |
|---|---|---|---|
| `confidence_label` | `ConsensusScoringResult.confidenceLabel` (`High \| Medium \| Low`, `lib/verification/consensusScoring.ts`) | null | — |
| `run_certainty` | null | `gate.runCertainty` | — |
| `evidence_quality` | `ConsensusSummary.evidenceQuality` (`strong \| mixed \| weak`; the same value the audit bundle stores) | null | — |
| Section | `cp.claim_consensus_score` | `cp.adaptive_gate` | see below |

**Research `dedicated` certainty.** The only source is `CommonResponseMeta.evidenceQuality`, typed `strong | moderate | weak | unknown | not_applicable` (`lib/adaptiveSchema/types.ts`). Mapping:
- `not_applicable` → section `unavailable`, `evidence_quality_not_applicable` (by design).
- `unknown` → section `unavailable`, `evidence_quality_unknown` (data-dependent).
- `strong` / `moderate` / `weak` → would be copied, but only after a descriptor `cp.adaptive_evidence_quality` is added (additive).

Neither `unknown` nor `not_applicable` is ever emitted as a value. As built today, `buildCommonResponseMeta` (`lib/adaptiveSchema/commonResponseMeta.ts`) always writes `evidenceQuality: "not_applicable"` for executed runs, so this section is `unavailable` (by design) for every `dedicated` run until the web pipeline produces a real value.

`evidence_quality` known values across types are `strong`, `moderate` (research, future), `mixed` (claim) and `weak`. The two vocabularies come from different methods and are distinguished by `methodology.id`.

### 4.3 Consensus (`ConsensusData`)

| Field | Claim | Research `claims_matrix` | Research `dedicated` |
|---|---|---|---|
| `score` | `consensusScore` (0–100) | null | null |
| `level` | null | `deriveConsensusLevel({ schemaId, gate })` | `deriveConsensusLevel({ schemaId, <schema key>: result })` |
| `usable_models` | `ConsensusSummary.modelsHealthy` | count of `results` with `ok: true` | `meta.modelsWithUsableOutput` |
| `selected_models` | `ConsensusSummary.modelCount` | `results.length` | `meta.totalModels` |
| methodology | `cp.claim_consensus_score` | `cp.adaptive_consensus_level` | `cp.adaptive_consensus_level` |

`ConsensusLevel` is `strong | moderate | weak | split | unscored`. `unscored` passes through verbatim as a level; it is not converted to a number. The section is `partial` with `reason.code: reduced_panel` whenever `usable_models < selected_models`.

**Not in the contract:** run-level `agreeing_models` / `dissenting_models`. No existing function produces a run-level list of agreeing or dissenting models. `buildAgreementDisagreementDigest` returns agreement *text* and conflicting *pairs*, and the adaptive pipeline records stance per aligned claim. Deriving a run-level list would be a new formula, so these fields are omitted. They can be added only once a web function produces them.

### 4.4 Trust (`TrustData`)

| | Source |
|---|---|
| Claim | `unavailable`, `methodology_not_supported` (OD-9) |
| Research `claims_matrix` | `trustSummary`: `overall` = `overallTrust`; `per_model[]` = `{ model: modelId, trust_score: trustScore, majority_alignment, citation_score, contradiction_count, parse_health, claims_contributed, capped }`; `attribution_rule` copied only when present. If every `parseHealth` is `failed`, `overallTrust` is `0` by construction, so the section is `unavailable` (`all_models_unparseable`) and never shows `overall: 0`. If `trustSummary` is absent: `unavailable`, `inputs_missing` |
| Research `dedicated` | `unavailable`, `not_produced` |

### 4.5 Disagreements (`Disagreement[]`)

`Disagreement = { models: string[], topic: string | null, why_they_differ: string | null, stakes: string | null, positions: [{ model, position }] | null }`. Every key is present, and a null means "the source does not carry this".

| | Source |
|---|---|
| Claim | `buildAgreementDisagreementDigest(...).whereModelsDisagree` (`lib/verification/agreementDigest.ts`), which returns `{ point, models }[]`. `models` ← `models`. `point` is a generated label (`"Conflicting assessments: (a) vs (b)"`), not a topic, so it is **not** copied. `topic`, `why_they_differ`, `stakes` and `positions` are `null`. The section carries limitation `disagreement_topic_not_identified`: the digest identifies which pairs of models conflicted, not on what. An empty array is the digest's own computed result ("no conflicting pair found"), so the section is `completed` with `[]` |
| Research `claims_matrix` | `synthesisReport.disagreements` (`AdaptiveDisagreement[]`): `topic` ← `topic`, `why_they_differ` ← `whyTheyDiffer` (model-generated, labelled by the descriptor), `stakes` ← `stakes`, `positions` ← `positions[] { model: modelId, position }` (the model's own excerpt), `models` ← the `modelId`s of `positions` (select). If `synthesisReport` is absent: `unavailable`, `inputs_missing` |
| Research `dedicated` | `unavailable`, `not_produced`. Schema-native disagreement content, if any, stays inside `/report` `schema_result` |

### 4.6 Synthesis (research only; summary on the main result, full on `/report`)

`StructuredSynthesis` (`lib/synthesis/structuredSchema.ts`) from the extracted `executeSynthesis`. The web synthesis route (`app/api/synthesize-panel/route.ts`) synthesizes a research run's panel results. It has no claim input, so:
- for `type: "claim"` the section is `unavailable` (`not_produced`), and `options.synthesis: true` is rejected at create (`422 synthesis_not_supported`);
- for research with `synthesis: false` it is `not_requested`.

Summary fields: `executive_summary`, `key_finding_count`, `open_question_count`, `methodology_text` (verbatim `StructuredSynthesis.methodology`). `/report` returns the full content (`keyFindings[]` with `support` and `evidenceQuality`, `disagreements[]`, `biasAndBlindSpots[]`, `openQuestions[]`), re-keyed to snake_case.

### 4.7 Evidence (`EvidenceItem[]`)

`EvidenceItem = { model: string | null, url, hostname, origin }`.

| | Source |
|---|---|
| Claim | `unavailable`, `not_produced`. The claim verification prompt and parser (`parseVerificationJson.ts`: `verdict`, `confidence`, `summary`, `correctParts`, `incorrectParts`, `unverifiableParts`, `reasoning`) carry no citations |
| Research `claims_matrix` | `unavailable`, `not_produced` (v1). Per-model source fields inside `AdaptiveModelResult.data` are schema-specific and not projected in v1 |
| Research `dedicated` | `normalizeSourceUrls(buildAdaptiveDecisionReceipt(adaptiveOutput).sources)` → `{ url, hostname }`; `model: null`, because the receipt's sources are a deduplicated union without per-model attribution; `origin: "model_cited"`. Plain-text source labels that are not URLs are dropped by `normalizeSourceUrls`, never shown as links. If no URL survives: `unavailable`, `no_url_citations` |

`origin: "provider_search_result"` is reserved. No pipeline persists provider search results today (Order 5 Phase 0 counters are log-only), so v1 never emits it. ConvergePanel never fetches a URL in v1.

### 4.8 Limitations

`{ code, message?, model?, substituted_by?, usable_models?, selected_models? }`. Codes (open enum):
- CR-1: `model_agreement_not_independent_evidence`, `citations_not_fetched`.
- Slots: `model_failed`, `model_substituted` (with `model` and `substituted_by` = the actual provider), `model_refused`, `fallback_capacity_unavailable`.
- Coverage: `reduced_panel`, `parse_degraded`, `limited_coverage`.
- Sections: `synthesis_failed`, `disagreement_topic_not_identified`.
- Pass-through: `pipeline_limitation` for `CommonResponseMeta.limitations` strings (dedicated family), as `{ code: "pipeline_limitation", message }`.

### 4.9 Per-model results (`/v1/verifications/{id}/models`)

Compact by default.

| Field | Source |
|---|---|
| `model` | logical slot ID |
| `status` | public `ModelStatus` (`ok \| substituted \| failed`, `lib/types.ts`) via `lib/panel/normalize.ts` |
| `failure_class` | internal `ConnectorStatus` → `error \| timeout \| refused \| rate_limited`; null unless `failed` |
| `provider` | the provider that **actually** answered. A substituted slot reports `deepseek`, as `runPanel` sets it |
| `requested_model`, `actual_model`, `substituted_from` | `ModelResult` (`substitutedFrom` = `"{provider}:{requestedModel}"`) |
| `latency_ms`, `tokens` | `ModelResult` / `normalizeTokens` |
| `parse_status` | claim: `AuditBundle.perModel[].pipelineStatus`; research: `ModelTrustSummary.parseHealth` (`claims_matrix`) or `AdaptiveModelResult.ok` (`dedicated`) |
| `verdict`, `confidence`, `parts` | claim only, from `AuditBundle.perModel[]` (`verdictLabel`, `confidence`, `counts`), which is `null` when the pipeline produced no parsed verdict. The API does **not** use `buildClaimModelEvidence`'s placeholder values for failed slots (`verdict: "failed"`, `confidence: "low"`) |
| `summary_char_count` | `AuditBundle.perModel[].summaryLength` (claim); null for research |
| `response_text` | `Section<string>`, `not_requested` unless the four OD-19 conditions hold (PRD §8.4) |

Error messages and `rawResponse` are never returned.

### 4.10 Uncertainties and human review

| | Claim | Research `claims_matrix` | Research `dedicated` |
|---|---|---|---|
| `uncertainties` | `null` | `null` | `buildAdaptiveDecisionReceipt(adaptiveOutput).uncertainties` (the schema's own content; may be `[]`). Not `meta.uncertainties`, which `buildCommonResponseMeta` always writes as `[]` |
| `human_review_recommended` | `null` | `null` | `meta.humanReviewNeeded` |

## 5. Mapping to existing sources

"Re-serialization only" applies to every row. The **Projection** column names the only operation allowed. "Dedicated" and "claims-matrix" are the research families of §4.0.

| API field | Claim source | Research source | Projection |
|---|---|---|---|
| `verdict.data.label` | `computeClaimVerdict` (`lib/verification/claimVerdict.ts`) | — | copy |
| `verdict.data.gate_status`, `load_bearing_split_count` | — | claims-matrix: `gate` (`AdaptiveGateResult`, `lib/adaptiveSchema/types.ts`); dedicated: section `unavailable` | copy |
| `certainty.data.confidence_label` | `computeConsensusScoring` → `confidenceLabel` | — | copy |
| `certainty.data.run_certainty` | — | claims-matrix: `gate.runCertainty` | copy |
| `certainty.data.evidence_quality` | `ConsensusSummary.evidenceQuality` | dedicated: `meta.evidenceQuality` per §4.2 (today always section `unavailable`) | copy / availability |
| `consensus.data.score` | `consensusScore` | — | copy |
| `consensus.data.level` | — | `deriveConsensusLevel` (`lib/adaptiveSchema/reportSummary.ts`) on this run's `gate` or schema result | existing web function |
| `consensus.data.usable_models`, `selected_models` | `ConsensusSummary.modelsHealthy`, `modelCount` | claims-matrix: counts over `results`; dedicated: `meta.modelsWithUsableOutput`, `meta.totalModels` | copy / count |
| `trust.data.*` | — (OD-9) | claims-matrix: `trustSummary` (`AdaptiveTrustSummary`); dedicated: `unavailable` | copy; availability from `parseHealth` |
| `disagreements.data[]` | `buildAgreementDisagreementDigest().whereModelsDisagree[].models` only | claims-matrix: `synthesisReport.disagreements`; dedicated: `unavailable` | rename / select |
| `synthesis.data` / `/report` synthesis | — (`unavailable`) | `StructuredSynthesis` from `executeSynthesis` | rename |
| synthesis `support` per finding | — | `computeSynthesisConsensusScoring` (`lib/verification/consensusScoring.ts`) | copy |
| `evidence.data[]` | — (`unavailable`) | dedicated: `normalizeSourceUrls(buildAdaptiveDecisionReceipt(adaptiveOutput).sources)`; claims-matrix: `unavailable` | existing web functions |
| `limitations[]` | slot statuses, `AuditBundle.perModel[].pipelineStatus` | slot statuses; dedicated: `meta.limitations`; claims-matrix: `trustSummary.perModel[].parseHealth` | fixed table + CR-1 baseline |
| `uncertainties` | `null` | dedicated: decision receipt `uncertainties`; claims-matrix: `null` | copy |
| `human_review_recommended` | `null` | dedicated: `meta.humanReviewNeeded`; claims-matrix: `null` | copy |
| `verification_status.governance.automated_status` | `not_evaluated` | dedicated: `automatedGovernanceStatus`; claims-matrix: `not_evaluated` | copy |
| `/report` decision receipt | `unavailable` | dedicated: `buildAdaptiveDecisionReceipt(adaptiveOutput)`; claims-matrix: `unavailable` | existing web function, rename |
| `/report` unified answer | `unavailable` | claims-matrix: `synthesisReport.unifiedAnswer` (built by `buildAdaptiveUnifiedAnswer`, `lib/adaptiveSchema/verdict.ts`; includes `UNIFIED_ANSWER_FAIL_NOTE` when the panel did not converge); dedicated: `unavailable` | copy |
| `/report` schema result | `unavailable` | dedicated: `adaptiveOutput` (`PersistedAdaptiveOutputV1`) as `jsonExport.ts` does; claims-matrix: `alignedClaims` + `gate` | rename |
| `/models` per-model | `ModelResult` (`lib/connectors/types.ts`) + `AuditBundle.perModel[]` (`lib/verification/auditBundle.ts`) | `ModelResult`, `lib/panel/normalize.ts`, `ModelTrustSummary` / `AdaptiveModelResult` | map status; sanitize via `lib/panel/sanitizeText.ts` |
| `methodology` | static descriptor (§6) | static descriptor (§6) | attach constant |

Claim execution and synthesis generation currently live inside `app/api/verify-claim/route.ts` and `app/api/synthesize-panel/route.ts`; the API reads them only after the API-3 mechanical extractions (PRD §6).

## 6. Methodology descriptors (CR-1)

### 6.1 Descriptor shape
`{ id, version, basis, doc_url }`. `basis` (open enum): `model_consensus`, `model_reported_citations`, `model_generated_summary`. Descriptors are compile-time constants (OD-21) in a **new** `lib/apiPlatform/methodology.ts`. A golden test pins each described function's output on fixtures; when a fixture output changes, the PR must bump the descriptor `version`.

| `id` | Describes | `basis` | What it does **not** establish |
|---|---|---|---|
| `cp.claim_verdict` | `computeClaimVerdict` combining per-model verdicts | `model_consensus` | That the claim is true or false |
| `cp.claim_consensus_score` | `computeConsensusScoringForVerification` (support ratio, health ratio, verdict-dependent boost; confidence label; evidence quality) | `model_consensus` | Probability of truth |
| `cp.claim_agreement_digest` | `buildAgreementDisagreementDigest` (pairwise conflict detection over `incorrectParts`) | `model_consensus` | Which side is right, or what the conflict is about |
| `cp.adaptive_gate` | `computeAdaptiveGate` and `computeRunCertainty` over load-bearing aligned claims | `model_consensus` | Correctness of the agreed claims |
| `cp.adaptive_trust` | `buildAdaptiveTrustSummary` (majority alignment, citation presence, contradictions, parse-health cap) | `model_consensus` | Source reliability; `citation_score` counts presence, not validity |
| `cp.adaptive_consensus_level` | `deriveConsensusLevel` | `model_consensus` | Truth |
| `cp.adaptive_disagreements` | `AdaptiveSynthesisReport.disagreements` (model-generated `whyTheyDiffer`, model-assigned `stakes`) | `model_consensus` | Which position is right |
| `cp.synthesis` | structured synthesis LLM pass + `computeSynthesisConsensusScoring` | `model_generated_summary` | Independent review |
| `cp.evidence_sources` | decision-receipt source collection + `normalizeSourceUrls` | `model_reported_citations` | That sources exist, say what is claimed, or are reliable |

### 6.2 CR-1 baseline limitations (keyed to `methodology.basis`)
- `basis: model_consensus` or `model_generated_summary` → section `limitations` must contain `model_agreement_not_independent_evidence`.
- `basis: model_reported_citations` → section `limitations` must contain `citations_not_fetched`.
- Any other (future) `basis` → at least one of the two codes, until that basis gets its own rule (additive).
- The run-level `limitations[]` always contains both codes.

## 7. Versioning and evolution

- `/v1` URL major changes only for transport or semantic breaks.
- `format_version` (`"1"`) changes only for breaking shape changes: removing or renaming a field, changing a type, changing the meaning of an existing value.
- **Additive (no bump):** new optional fields, new enum values (all enums are open), new limitation codes, new `methodology.id`s, new models, new `schema_id`s, new availability `reason.code`s.
- **Methodology changes** bump `methodology.version`, not `format_version`, and are announced in the changelog.
- **Stored results** are served in the `format_version` they were produced under, or a strictly additive successor.
- **Deprecation:** ≥ 12 months, `Deprecation` and `Sunset` headers, changelog. Two `format_version`s may be served concurrently via `Accept: application/json; format_version=2`.
- **Client rules:** ignore unknown fields; treat unknown enum values as "other"; never treat a missing section as `completed`.
- **CI (from API-4):** Zod ↔ JSON Schema ↔ OpenAPI parity test; golden fixtures per `format_version`.

## 8. Consensus vs verification semantics (normative)

| Concept | In the API | Meaning |
|---|---|---|
| Model consensus | `consensus`, `verdict`, `certainty`, `trust`, `disagreements` | How far independent model responses agree, over a stated denominator |
| Factual verification | `verification_basis.independent_source_check` | Independent confirmation against evidence. **Not performed in v1** |
| Evidence | `evidence` | Citations the models reported. Not fetched or checked |

`confirmed` means "the usable models' verdicts combine to accurate"; it never means "verified true". `disputed` means the models' verdicts combine to inaccurate or contested. Consumers that act automatically must combine `verdict`, `consensus`, `human_review_recommended` and `limitations`.

## 9. JSON Schema (draft 2020-12)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://api.convergepanel.com/schemas/verification-result/v1.json",
  "title": "ApiVerificationResultV1",
  "type": "object",
  "required": ["object", "id", "format_version", "type", "status", "mode", "created_at",
               "application_id", "input", "research_schema", "verification_basis", "verdict",
               "certainty", "consensus", "trust", "disagreements", "synthesis", "evidence",
               "limitations", "uncertainties", "human_review_recommended", "verification_status",
               "failure", "models", "report", "usage"],
  "properties": {
    "object": { "const": "verification" },
    "id": { "type": "string", "pattern": "^ver_[A-Za-z0-9]{24}$" },
    "format_version": { "const": "1" },
    "type": { "enum": ["claim", "research"] },
    "status": { "$ref": "#/$defs/JobStatus" },
    "mode": { "enum": ["live", "test"] },
    "created_at": { "type": "string", "format": "date-time" },
    "completed_at": { "type": ["string", "null"], "format": "date-time" },
    "application_id": { "type": "string", "pattern": "^app_[A-Za-z0-9]{20}$" },
    "metadata": { "type": "object", "maxProperties": 20,
                  "additionalProperties": { "type": "string", "maxLength": 500 } },
    "input": { "$ref": "#/$defs/InputSummary" },
    "research_schema": { "oneOf": [ { "type": "null" },
      { "type": "object", "required": ["id", "family"],
        "properties": { "id": { "type": "string" },
                        "family": { "type": "string", "description": "Open enum. Known: dedicated, claims_matrix." } } } ] },
    "verification_basis": { "$ref": "#/$defs/VerificationBasis" },
    "verdict":       { "$ref": "#/$defs/RatedSection", "properties": { "data": { "oneOf": [ { "type": "null" }, { "$ref": "#/$defs/VerdictData" } ] } } },
    "certainty":     { "$ref": "#/$defs/RatedSection", "properties": { "data": { "oneOf": [ { "type": "null" }, { "$ref": "#/$defs/CertaintyData" } ] } } },
    "consensus":     { "$ref": "#/$defs/RatedSection", "properties": { "data": { "oneOf": [ { "type": "null" }, { "$ref": "#/$defs/ConsensusData" } ] } } },
    "trust":         { "$ref": "#/$defs/RatedSection", "properties": { "data": { "oneOf": [ { "type": "null" }, { "$ref": "#/$defs/TrustData" } ] } } },
    "disagreements": { "$ref": "#/$defs/RatedSection", "properties": { "data": { "oneOf": [ { "type": "null" }, { "type": "array", "items": { "$ref": "#/$defs/Disagreement" } } ] } } },
    "synthesis":     { "$ref": "#/$defs/RatedSection", "properties": { "data": { "oneOf": [ { "type": "null" }, { "$ref": "#/$defs/SynthesisSummary" } ] } } },
    "evidence":      { "$ref": "#/$defs/RatedSection", "properties": { "data": { "oneOf": [ { "type": "null" }, { "type": "array", "items": { "$ref": "#/$defs/EvidenceItem" } } ] } } },
    "limitations": { "type": "array", "items": { "$ref": "#/$defs/Limitation" },
                     "allOf": [
                       { "contains": { "properties": { "code": { "const": "model_agreement_not_independent_evidence" } }, "required": ["code"] } },
                       { "contains": { "properties": { "code": { "const": "citations_not_fetched" } }, "required": ["code"] } } ] },
    "uncertainties": { "oneOf": [ { "type": "null" }, { "type": "array", "items": { "type": "string" } } ] },
    "human_review_recommended": { "type": ["boolean", "null"] },
    "verification_status": { "$ref": "#/$defs/VerificationStatus" },
    "failure": { "oneOf": [ { "type": "null" }, { "$ref": "#/$defs/Reason" } ] },
    "models": { "$ref": "#/$defs/Link" },
    "report": { "$ref": "#/$defs/Link" },
    "usage": { "type": "object", "required": ["credits_reserved", "credits_charged"],
               "properties": { "credits_reserved": { "type": "integer", "minimum": 0 },
                               "credits_charged": { "type": ["integer", "null"], "minimum": 0 } } }
  },
  "$defs": {
    "JobStatus": { "type": "string",
      "description": "Open enum. Known: queued, running, synthesizing, completed, partial, failed, canceled, expired." },
    "Availability": { "type": "string",
      "description": "Open enum. Known: completed, partial, failed, unavailable, not_requested." },
    "Reason": { "type": "object", "required": ["code", "message"],
      "properties": { "code": { "type": "string" }, "message": { "type": "string" } } },
    "Methodology": { "type": "object", "required": ["id", "version", "basis"],
      "properties": {
        "id": { "type": "string", "pattern": "^cp\\.[a-z0-9_]+$" },
        "version": { "type": "string" },
        "basis": { "type": "string", "description": "Open enum. Known: model_consensus, model_reported_citations, model_generated_summary." },
        "doc_url": { "type": "string", "format": "uri" } } },
    "Limitation": { "type": "object", "required": ["code"],
      "properties": {
        "code": { "type": "string" }, "message": { "type": "string" },
        "model": { "type": "string" }, "substituted_by": { "type": "string" },
        "usable_models": { "type": "integer" }, "selected_models": { "type": "integer" } } },
    "RatedSection": {
      "type": "object",
      "required": ["availability", "reason", "methodology", "limitations", "data"],
      "properties": {
        "availability": { "$ref": "#/$defs/Availability" },
        "reason": { "oneOf": [ { "type": "null" }, { "$ref": "#/$defs/Reason" } ] },
        "methodology": { "oneOf": [ { "type": "null" }, { "$ref": "#/$defs/Methodology" } ] },
        "limitations": { "type": "array", "items": { "$ref": "#/$defs/Limitation" } }
      },
      "allOf": [
        { "if": { "properties": { "availability": { "enum": ["completed", "partial"] } }, "required": ["availability"] },
          "then": { "properties": { "data": { "not": { "type": "null" } },
                                    "methodology": { "$ref": "#/$defs/Methodology" } } } },
        { "if": { "properties": { "methodology": { "type": "object", "required": ["basis"],
                    "properties": { "basis": { "enum": ["model_consensus", "model_generated_summary"] } } } },
                  "required": ["methodology"] },
          "then": { "properties": { "limitations": { "contains": { "type": "object", "required": ["code"],
                    "properties": { "code": { "const": "model_agreement_not_independent_evidence" } } } } } } },
        { "if": { "properties": { "methodology": { "type": "object", "required": ["basis"],
                    "properties": { "basis": { "const": "model_reported_citations" } } } },
                  "required": ["methodology"] },
          "then": { "properties": { "limitations": { "contains": { "type": "object", "required": ["code"],
                    "properties": { "code": { "const": "citations_not_fetched" } } } } } } },
        { "if": { "properties": { "methodology": { "type": "object" } }, "required": ["methodology"] },
          "then": { "properties": { "limitations": { "minItems": 1, "contains": { "type": "object", "required": ["code"],
                    "properties": { "code": { "enum": ["model_agreement_not_independent_evidence", "citations_not_fetched"] } } } } } } },
        { "if": { "properties": { "availability": { "enum": ["failed", "unavailable", "not_requested"] } }, "required": ["availability"] },
          "then": { "properties": { "data": { "type": "null" }, "methodology": { "type": "null" } } } },
        { "if": { "properties": { "availability": { "enum": ["partial", "failed", "unavailable"] } }, "required": ["availability"] },
          "then": { "properties": { "reason": { "$ref": "#/$defs/Reason" } } } },
        { "if": { "properties": { "availability": { "const": "completed" } }, "required": ["availability"] },
          "then": { "properties": { "reason": { "type": "null" } } } }
      ]
    },
    "InputSummary": { "type": "object", "required": ["char_count", "fingerprint", "retained"],
      "properties": {
        "char_count": { "type": "integer", "minimum": 0 },
        "context_char_count": { "type": "integer", "minimum": 0 },
        "fingerprint": { "type": "string", "pattern": "^hmac256:[0-9a-f]{64}$" },
        "retained": { "type": "boolean" } } },
    "VerificationBasis": { "type": "object", "required": ["kind", "independent_source_check", "statement"],
      "properties": {
        "kind": { "type": "string", "description": "Open enum. v1 emits only model_consensus." },
        "independent_source_check": { "type": "string", "description": "Open enum. v1 emits only not_performed." },
        "statement": { "type": "string" } } },
    "VerificationStatus": { "type": "object", "required": ["state", "governance"],
      "properties": {
        "state": { "$ref": "#/$defs/JobStatus" },
        "governance": { "type": "object", "required": ["automated_status", "human_review"],
          "properties": {
            "automated_status": { "type": "string", "description": "Open enum. Known: passed, flagged, blocked, not_evaluated, error." },
            "human_review": { "const": "not_available_via_api" } } } } },
    "VerdictData": { "type": "object", "required": ["label", "gate_status", "load_bearing_split_count"],
      "properties": {
        "label": { "type": ["string", "null"], "description": "Claim only. Known: confirmed, disputed, partially_true, unverifiable." },
        "gate_status": { "type": ["string", "null"], "description": "Research claims_matrix only. Known: pass, caution, fail." },
        "load_bearing_split_count": { "type": ["integer", "null"], "minimum": 0 } } },
    "CertaintyData": { "type": "object", "required": ["confidence_label", "run_certainty", "evidence_quality"],
      "properties": {
        "confidence_label": { "type": ["string", "null"], "description": "Claim only. Known: High, Medium, Low." },
        "run_certainty": { "type": ["number", "null"], "minimum": 0, "maximum": 1 },
        "evidence_quality": { "type": ["string", "null"], "description": "Open enum. Known: strong, moderate, mixed, weak. Never unknown or not_applicable." } } },
    "ConsensusData": { "type": "object", "required": ["score", "level", "usable_models", "selected_models"],
      "properties": {
        "score": { "type": ["integer", "null"], "minimum": 0, "maximum": 100 },
        "level": { "type": ["string", "null"], "description": "Research only. Known: strong, moderate, weak, split, unscored." },
        "usable_models": { "type": "integer", "minimum": 0 },
        "selected_models": { "type": "integer", "minimum": 1 } } },
    "TrustData": { "type": "object", "required": ["overall", "per_model"],
      "properties": {
        "overall": { "type": "number", "minimum": 0, "maximum": 1 },
        "per_model": { "type": "array", "items": {
          "type": "object", "required": ["model", "trust_score", "parse_health"],
          "properties": {
            "model": { "type": "string" },
            "trust_score": { "type": "number", "minimum": 0, "maximum": 1 },
            "majority_alignment": { "type": "number", "minimum": 0, "maximum": 1 },
            "citation_score": { "type": "number", "minimum": 0, "maximum": 1 },
            "contradiction_count": { "type": "integer", "minimum": 0 },
            "claims_contributed": { "type": "integer", "minimum": 0 },
            "capped": { "type": "boolean" },
            "parse_health": { "type": "string" } } } },
        "attribution_rule": { "type": ["string", "null"] } } },
    "Disagreement": { "type": "object", "required": ["models", "topic", "why_they_differ", "stakes", "positions"],
      "properties": {
        "models": { "type": "array", "minItems": 2, "items": { "type": "string" } },
        "topic": { "type": ["string", "null"] },
        "why_they_differ": { "type": ["string", "null"] },
        "stakes": { "type": ["string", "null"] },
        "positions": { "oneOf": [ { "type": "null" },
          { "type": "array", "items": { "type": "object", "required": ["model", "position"],
            "properties": { "model": { "type": "string" }, "position": { "type": "string" } } } } ] } } },
    "SynthesisSummary": { "type": "object", "required": ["executive_summary"],
      "properties": {
        "executive_summary": { "type": "string" },
        "key_finding_count": { "type": "integer", "minimum": 0 },
        "open_question_count": { "type": "integer", "minimum": 0 },
        "methodology_text": { "type": "string" } } },
    "EvidenceItem": { "type": "object", "required": ["model", "url", "hostname", "origin"],
      "additionalProperties": false,
      "properties": {
        "model": { "type": ["string", "null"] },
        "url": { "type": "string", "format": "uri" },
        "hostname": { "type": "string", "minLength": 1 },
        "origin": { "type": "string", "description": "Open enum. Known: model_cited. Reserved: provider_search_result (not emitted in v1)." } } },
    "Link": { "type": "object", "required": ["href"], "properties": { "href": { "type": "string" } } }
  }
}
```

Note on open enums: enums are documented as strings with known values so that additive values do not fail old validators (§7). The Zod implementation validates the known set on **output** (the server never emits an unknown value without a schema change) while SDKs accept unknown values on **input**.

**Validation record (Rev 3).** The PRD §8.4 example, with its `//` comments stripped, validates against this schema with Python `jsonschema` 4.25 (`Draft202012Validator`). Negative checks: removing `model_agreement_not_independent_evidence` from a `model_consensus` section, removing `citations_not_fetched` from a `model_reported_citations` section, setting `reason: null` on a `partial` section, and adding `label` to an evidence item each fail validation.
