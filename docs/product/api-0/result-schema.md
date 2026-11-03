# `ApiVerificationResultV1` — canonical result schema (API-0 proposal)

**Status:** design proposal. Nothing here is implemented. The implementation (API-3/API-4) will be a **new** Zod schema `lib/apiPlatform/resultSchema.ts` and a **new** pure projection `lib/apiPlatform/projectResult.ts`, modelled on `lib/adaptiveSchema/jsonExportSchema.ts` and `lib/adaptiveSchema/jsonExport.ts`. The OpenAPI component schemas in [`openapi.yaml`](openapi.yaml) must stay identical in meaning to this document.

## 1. Rules

1. **Re-serialization only.** Every value in a result is copied, renamed, selected or re-encoded from an existing internal structure produced by the web pipeline. The projection never calls a model, never computes a new score, never averages, never interpolates and never fills a gap. If a value does not exist internally, the section is `unavailable` with a reason.
2. **Allowed projection operations:** field rename (camelCase to snake_case); enum pass-through; selecting a subset of fields; counting array elements already present (e.g. `usable_models`); mapping an internal status to the public vocabulary through a fixed table (§4.3); choosing an availability state from facts already present (e.g. "every slot `parseHealth: failed`" → `unavailable`); attaching a static methodology descriptor (§6).
3. **Forbidden:** new prompts, new formulas, rewording model text, inventing a default verdict, emitting `0` / `""` / `"unknown"` as a finding, hiding a failed slot.
4. **CR-1.** Whenever a section's `data` is non-null and the section is a verdict, rating, certainty, consensus, disagreement, synthesis or evidence section, `methodology` is required and `limitations` contains the CR-1 baseline code(s) (§6.2). The JSON Schema enforces this.

## 2. Top-level shape

| Field | Type | Notes |
|---|---|---|
| `object` | `"verification"` | |
| `id` | `ver_` + 24 base62 | |
| `format_version` | `"1"` | Shape version (§7) |
| `type` | `"claim" \| "research"` | First release scope |
| `status` | job status | `queued \| running \| synthesizing \| completed \| partial \| failed \| canceled \| expired` |
| `mode` | `"live" \| "test"` | `test` results are fixtures (sandbox) |
| `created_at`, `completed_at` | RFC 3339 | `completed_at` null until terminal |
| `application_id` | `app_…` | |
| `metadata` | object ≤ 20 string keys | Customer-supplied, echoed |
| `input` | `InputSummary` | Length, HMAC fingerprint, `retained` flag. Never the text unless `retain_input` and the result is fetched by an authorized key (§3.1) |
| `verification_basis` | `VerificationBasis` | CR-1 top-level statement |
| `verdict` | `Section<VerdictData>` | |
| `certainty` | `Section<CertaintyData>` | |
| `consensus` | `Section<ConsensusData>` | |
| `trust` | `Section<TrustData>` | Claim: always `unavailable` (OD-9) |
| `disagreements` | `Section<Disagreement[]>` | |
| `synthesis` | `Section<SynthesisSummary>` | Full synthesis on `/report` |
| `evidence` | `Section<EvidenceItem[]>` | |
| `limitations` | `Limitation[]` | Run-level union |
| `uncertainties` | `string[]` | Verbatim from the source |
| `human_review_recommended` | `boolean \| null` | Verbatim `humanReviewNeeded`; `null` for claims (no source field) |
| `verification_status` | `VerificationStatus` | Job state + automated governance |
| `failure` | `{ code, message } \| null` | Only when `status: failed` |
| `models` | `{ href }` | Link to compact per-model results |
| `report` | `{ href }` | Link to the narrative layer |
| `usage` | `{ credits_reserved, credits_charged }` | `credits_charged` null until settled |

## 3. Sections and availability

### 3.1 Section wrapper

```
Section<T> = {
  availability: "completed" | "partial" | "failed" | "unavailable" | "not_requested",
  reason:       { code: string, message: string } | null,
  methodology:  Methodology | null,
  limitations:  Limitation[],
  data:         T | null
}
```

| State | `data` | `reason` | `methodology` | When |
|---|---|---|---|---|
| `completed` | required | null | required (rated sections) | Computed from all usable inputs of the selected panel |
| `partial` | required | required | required | Computed from a reduced input set; `reason` states the denominator |
| `failed` | null | required | null | Attempted and errored (e.g. synthesis LLM call failed) |
| `unavailable` | null | required | null | Not produced: `methodology_not_supported`, `not_applicable`, `inputs_missing`, `all_models_unparseable`, `provider_not_confirmed` |
| `not_requested` | null | null or code | null | Customer did not ask (e.g. `synthesis: false`, full model text) |

The job `status` is derived from sections: `completed` if every requested section is `completed` or `unavailable` by design; `partial` if any requested section is `partial` or `failed` but a verdict (claim) or gate (research) exists; `failed` if neither exists.

### 3.2 Input summary (OD-10 class a)

`{ "char_count": 182, "context_char_count": 0, "fingerprint": "hmac256:<hex>", "retained": false }`. The fingerprint is `HMAC-SHA256(org-scoped key, normalized input)` so it cannot be compared across orgs. It lets a customer prove a re-submission is the same input without ConvergePanel keeping the text.

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
  "governance": { "automated_status": "flagged", "human_review": "not_available_via_api" } }
```

`automated_status` is copied from `GovernanceRecordV1.automatedGovernance.status` (`lib/adaptiveSchema/governanceRecord.ts`: `passed | flagged | blocked | not_evaluated | error`); `not_evaluated` when the governance record is absent (claims, unless the extracted claim core produces one). No reviewer identities, queues or override text.

## 4. Section data

### 4.1 Verdict
| Field | Claim | Research |
|---|---|---|
| `label` | `ClaimVerdict` (`confirmed \| disputed \| partially_true \| unverifiable`) | null (section `reason.code: not_applicable` if no gate) |
| `gate_status` | null | `AdaptiveGateStatus` (`pass \| caution \| fail`) |
| `load_bearing_split_count` | null | `AdaptiveGateResult.loadBearingSplitCount` |

A claim always has `label` and a null `gate_status`; a research run has `gate_status` and a null `label`. Neither null is a gap, because the field does not apply to the type. A research run whose persisted output has no gate result has the whole verdict section `unavailable` with `reason.code: inputs_missing`.

### 4.2 Certainty
`confidence_label` (`High | Medium | Low`, claim), `run_certainty` (number, research `AdaptiveGateResult.runCertainty`), `evidence_quality` (`strong | mixed | weak`, claim audit bundle; research `CommonResponseMeta.evidenceQuality`). Fields not produced for the type are null.

### 4.3 Consensus
`score` (claim `consensusScore` 0–100), `level` (research `ConsensusLevel` from `lib/adaptiveSchema/reportSummary.ts`: `strong | moderate | weak | split | unscored`), `usable_models`, `selected_models`, `agreeing_models[]`, `dissenting_models[]`. `unscored` passes through verbatim as a level; it is not converted to a number.

### 4.4 Trust
Research only: `overall` (`AdaptiveTrustSummary.overallTrust`), `per_model[]` (`model`, `trust_score`, `majority_alignment`, `citation_score`, `contradiction_count`, `parse_health`, `claims_contributed`), `attribution_rule` (copied only when present). If every `parseHealth` is `failed`, the internal `overallTrust` is `0` by construction; the section is `unavailable` with `all_models_unparseable`, never `overall: 0`. Claim: `unavailable`, `methodology_not_supported` (OD-9).

### 4.5 Disagreements
`[{ topic, why_they_differ, stakes, positions: [{ model, position }] }]`. Research from `AdaptiveDisagreement[]` (`stakes` verbatim); claim from `buildAgreementDisagreementDigest` (`stakes` null). `position` is always the model's own excerpt. `why_they_differ` is the pipeline's existing model-generated explanation, labelled as such by the methodology descriptor.

### 4.6 Synthesis (summary on the main result; full on `/report`)
Summary: `executive_summary`, `key_finding_count`, `open_question_count`, `methodology_text` (verbatim `StructuredSynthesis.methodology`). `/report` returns the full `StructuredSynthesisSchema` content (`keyFindings[]` with `support` and `evidenceQuality`, `disagreements[]`, `biasAndBlindSpots[]`, `openQuestions[]`) re-keyed to snake_case.

### 4.7 Evidence
`[{ model, url, hostname, origin }]`. `origin`: `model_cited` (the model wrote the URL) or `provider_search_result` (the provider returned it as a search result, only where the existing pipeline persists it). URLs come through `normalizeEvidenceSourceReferences` (`lib/verification/evidenceSourceExtraction.ts`) or `lib/adaptiveSchema/sourceUrlNormalization.ts`. Never fetched by ConvergePanel in v1.

### 4.8 Limitations
`{ code, message?, model?, substituted_by?, usable_models?, selected_models? }`. Codes (open enum): `model_agreement_not_independent_evidence`, `citations_not_fetched`, `model_failed`, `model_substituted`, `model_refused`, `reduced_panel`, `parse_degraded`, `synthesis_failed`, `limited_coverage`, plus research `CommonResponseMeta.limitations` passed through as `{ code: "pipeline_limitation", message }`.

### 4.9 Per-model results (`/v1/verifications/{id}/models`)
Compact by default: `model`, `status` (public `ModelStatus` `ok | substituted | failed` from `lib/types.ts`), `failure_class` (`error | timeout | refused | rate_limited`, internal `ConnectorStatus` mapped), `provider`, `requested_model`, `actual_model`, `substituted_from`, `latency_ms`, `tokens`, `parse_status`, `verdict`, `confidence`, `parts` counts (`correct`, `incorrect`, `unverifiable` from the audit bundle), `summary_char_count`, and `response_text` as a `Section<string>` that is `not_requested` unless the four OD-19 conditions hold (PRD §8.4).

## 5. Mapping to existing sources

"Re-serialization only" applies to every row. The **Projection** column names the only operation allowed.

| API field | Claim source | Research source | Projection |
|---|---|---|---|
| `verdict.data.label` | `computeClaimVerdict` (`lib/verification/claimVerdict.ts`) | — | copy |
| `verdict.data.gate_status`, `load_bearing_split_count` | — | `AdaptiveGateResult` (`lib/adaptiveSchema/gate.ts`, type in `types.ts`) | copy |
| `certainty.data.confidence_label` | `computeConsensusScoring` → `confidenceLabel` (`lib/verification/consensusScoring.ts`) | — | copy |
| `certainty.data.run_certainty` | — | `AdaptiveGateResult.runCertainty` | copy |
| `certainty.data.evidence_quality` | `AuditBundle.evidenceQuality` (`lib/verification/auditBundle.ts`) | `CommonResponseMeta.evidenceQuality` (`lib/adaptiveSchema/commonResponseMeta.ts`) | copy |
| `consensus.data.score` | `consensusScore` | — | copy |
| `consensus.data.level` | — | `ConsensusLevel` (`lib/adaptiveSchema/reportSummary.ts`) | copy |
| `consensus.data.usable_models`, `selected_models` | `ConsensusSummary.modelsHealthy`, `modelCount` | count of slots by status in persisted `modelResults` | count |
| `consensus.data.agreeing_models`, `dissenting_models` | `buildAgreementDisagreementDigest` (`lib/verification/agreementDigest.ts`) | aligned-claim majority from `lib/adaptiveSchema/alignment.ts` output persisted in `PersistedAdaptiveOutputV1` | select |
| `trust.data.*` | — (OD-9: `unavailable`) | `AdaptiveTrustSummary` (`lib/adaptiveSchema/trustSummary.ts`) | copy; availability from `parseHealth` |
| `disagreements.data[]` | `buildAgreementDisagreementDigest` | `AdaptiveDisagreement[]` | rename |
| `synthesis.data` / `/report` synthesis | `StructuredSynthesisSchema` output (`lib/synthesis/structuredSchema.ts`) | same | rename |
| synthesis `support` per finding | `computeSynthesisConsensusScoring` (`lib/verification/consensusScoring.ts`) | same | copy |
| `evidence.data[]` | `normalizeEvidenceSourceReferences` | `sources[]` on the persisted output, `sourceUrlNormalization.ts` | copy |
| `limitations[]` | slot statuses, `AuditBundle.perModel[].pipelineStatus` | slot statuses, `CommonResponseMeta.limitations`, `AdaptiveDecisionReceipt.limitations` (`lib/adaptiveSchema/governanceRecord.ts`) | map via fixed table + CR-1 baseline |
| `uncertainties[]` | — (empty array) | `AdaptiveDecisionReceipt.uncertainties` / `CommonResponseMeta.uncertainties` | copy |
| `human_review_recommended` | null | `CommonResponseMeta.humanReviewNeeded` | copy |
| `verification_status.governance.automated_status` | governance record if produced | `GovernanceRecordV1.automatedGovernance.status` | copy |
| `/report` receipt | — | `buildAdaptiveDecisionReceipt` (`lib/adaptiveSchema/decisionReceiptBuilder.ts`) | rename |
| `/report` unified answer | — | `lib/adaptiveSchema/verdict.ts` (`selectUnifiedAnswer`, `UNIFIED_ANSWER_FAIL_NOTE`) | copy |
| `/report` schema result | — | `PersistedAdaptiveOutputV1` (`lib/adaptiveSchema/persistedOutput.ts`), as `jsonExport.ts` does | rename |
| `/models` per-model | `buildClaimModelEvidence` (`lib/verification/buildClaimModelEvidence.ts`), `ModelResult` (`lib/connectors/types.ts`) | `ModelResult`, `lib/panel/normalize.ts` | map status; sanitize via `lib/panel/sanitizeText.ts` |
| `methodology` | static descriptor (§6) | static descriptor (§6) | attach constant |

Claim execution and synthesis generation currently live inside `app/api/verify-claim/route.ts` and `app/api/synthesize-panel/route.ts`; the API reads them only after the API-3 mechanical extractions (PRD §6).

## 6. Methodology descriptors (CR-1)

### 6.1 Descriptor shape
`{ id, version, basis, doc_url }`. `basis` (open enum): `model_consensus`, `model_reported_citations`, `model_generated_summary`. Descriptors are compile-time constants (OD-21) in a **new** `lib/apiPlatform/methodology.ts`. A golden test pins each described function's output on fixtures; when a fixture output changes, the PR must bump the descriptor `version`.

| `id` | Describes | `basis` | What it does **not** establish |
|---|---|---|---|
| `cp.claim_verdict` | `computeClaimVerdict` combining per-model verdicts | `model_consensus` | That the claim is true or false |
| `cp.claim_consensus_score` | `computeConsensusScoringForVerification` (support ratio, health ratio, verdict-dependent boost) | `model_consensus` | Probability of truth |
| `cp.claim_agreement_digest` | `buildAgreementDisagreementDigest` | `model_consensus` | Which side is right |
| `cp.adaptive_gate` | `computeAdaptiveGate` over load-bearing aligned claims | `model_consensus` | Correctness of the agreed claims |
| `cp.adaptive_trust` | `buildAdaptiveTrustSummary` (majority alignment, citation presence, contradictions, parse-health cap) | `model_consensus` | Source reliability; `citation_score` counts presence, not validity |
| `cp.adaptive_consensus_level` | report-summary consensus level | `model_consensus` | Truth |
| `cp.synthesis` | structured synthesis LLM pass + `computeSynthesisConsensusScoring` | `model_generated_summary` | Independent review |
| `cp.evidence_sources` | citation extraction and normalization | `model_reported_citations` | That sources exist, say what is claimed, or are reliable |

### 6.2 CR-1 baseline limitations
- Every section with `basis: model_consensus` or `model_generated_summary` includes `model_agreement_not_independent_evidence`.
- Every section with `basis: model_reported_citations` includes `citations_not_fetched`.
- The run-level `limitations[]` always includes both.

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
| Evidence | `evidence` | Citations the models or providers reported. Not fetched or checked |

`confirmed` means "the usable models' verdicts combine to accurate"; it never means "verified true". `disputed` means the models' verdicts combine to inaccurate or contested. Consumers that act automatically must combine `verdict`, `consensus`, `human_review_recommended` and `limitations`.

## 9. JSON Schema (draft 2020-12)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://api.convergepanel.com/schemas/verification-result/v1.json",
  "title": "ApiVerificationResultV1",
  "type": "object",
  "required": ["object", "id", "format_version", "type", "status", "mode", "created_at",
               "application_id", "input", "verification_basis", "verdict", "certainty",
               "consensus", "trust", "disagreements", "synthesis", "evidence",
               "limitations", "verification_status", "models", "report", "usage"],
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
    "uncertainties": { "type": "array", "items": { "type": "string" } },
    "human_review_recommended": { "type": ["boolean", "null"] },
    "verification_status": { "$ref": "#/$defs/VerificationStatus" },
    "failure": { "oneOf": [ { "type": "null" },
                 { "type": "object", "required": ["code", "message"],
                   "properties": { "code": { "type": "string" }, "message": { "type": "string" } } } ] },
    "models": { "$ref": "#/$defs/Link" },
    "report": { "$ref": "#/$defs/Link" },
    "usage": { "type": "object", "required": ["credits_reserved"],
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
        { "if": { "properties": { "availability": { "enum": ["completed", "partial"] } } },
          "then": { "properties": { "data": { "not": { "type": "null" } },
                                    "methodology": { "$ref": "#/$defs/Methodology" },
                                    "limitations": { "minItems": 1, "contains": { "type": "object", "required": ["code"],
                                      "properties": { "code": { "enum": ["model_agreement_not_independent_evidence", "citations_not_fetched"] } } } } } } },
        { "if": { "properties": { "availability": { "enum": ["failed", "unavailable", "not_requested"] } } },
          "then": { "properties": { "data": { "type": "null" } } } },
        { "if": { "properties": { "availability": { "enum": ["partial", "failed", "unavailable"] } } },
          "then": { "properties": { "reason": { "$ref": "#/$defs/Reason" } } } }
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
    "VerdictData": { "type": "object", "required": ["label", "gate_status"],
      "properties": {
        "label": { "type": ["string", "null"], "description": "Claim only. Known: confirmed, disputed, partially_true, unverifiable." },
        "gate_status": { "type": ["string", "null"], "description": "Research only. Known: pass, caution, fail." },
        "load_bearing_split_count": { "type": ["integer", "null"] } } },
    "CertaintyData": { "type": "object",
      "properties": {
        "confidence_label": { "type": ["string", "null"] },
        "run_certainty": { "type": ["number", "null"] },
        "evidence_quality": { "type": ["string", "null"] } } },
    "ConsensusData": { "type": "object", "required": ["usable_models", "selected_models"],
      "properties": {
        "score": { "type": ["integer", "null"], "minimum": 0, "maximum": 100 },
        "level": { "type": ["string", "null"] },
        "usable_models": { "type": "integer", "minimum": 0 },
        "selected_models": { "type": "integer", "minimum": 1 },
        "agreeing_models": { "type": "array", "items": { "type": "string" } },
        "dissenting_models": { "type": "array", "items": { "type": "string" } } } },
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
            "parse_health": { "type": "string" } } } },
        "attribution_rule": { "type": ["string", "null"] } } },
    "Disagreement": { "type": "object", "required": ["topic", "positions"],
      "properties": {
        "topic": { "type": "string" },
        "why_they_differ": { "type": ["string", "null"] },
        "stakes": { "type": ["string", "null"] },
        "positions": { "type": "array", "items": { "type": "object", "required": ["model", "position"],
          "properties": { "model": { "type": "string" }, "position": { "type": "string" } } } } } },
    "SynthesisSummary": { "type": "object", "required": ["executive_summary"],
      "properties": {
        "executive_summary": { "type": "string" },
        "key_finding_count": { "type": "integer", "minimum": 0 },
        "open_question_count": { "type": "integer", "minimum": 0 },
        "methodology_text": { "type": "string" } } },
    "EvidenceItem": { "type": "object", "required": ["url", "hostname", "origin"],
      "properties": {
        "model": { "type": ["string", "null"] },
        "url": { "type": "string", "format": "uri" },
        "hostname": { "type": "string" },
        "origin": { "type": "string", "description": "Open enum. Known: model_cited, provider_search_result." } } },
    "Link": { "type": "object", "required": ["href"], "properties": { "href": { "type": "string" } } }
  }
}
```

Note on open enums: enums are documented as strings with known values so that additive values do not fail old validators (§7). The Zod implementation validates the known set on **output** (the server never emits an unknown value without a schema change) while SDKs accept unknown values on **input**.
