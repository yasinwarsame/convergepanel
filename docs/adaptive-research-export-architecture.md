# Adaptive Research Export — Architecture (as built)

**Status:** accurate as of Phase 5 (2026-08-11). Supersedes `adaptive-research-export-design.md`, the pre-implementation proposal.

Formats: **PDF** (Phase 1), **DOCX** (Phase 3), **JSON** (Phase 4). CSV and object storage are explicitly out of scope — see [Non-goals](#non-goals).

## 1. Storage model

There is no object storage anywhere in this codebase (no signed URLs, no `@vercel/blob`, no S3/GCS SDK). The durable artifact is a frozen metadata+content record — `AdaptiveResearchExportV1` — persisted in Firestore at `runs/{runId}/exports/{exportId}`. File bytes (PDF/DOCX/JSON) are **never stored**; they are a deterministic, pure function of the frozen record, generated on demand at export time and again on every regeneration, then discarded once the HTTP response completes.

This is why "ready" describes the record, not a file sitting in storage: it means the snapshot was durably persisted **and** a file was successfully generated and streamed at that moment. There is no "re-download the same bytes" — every download, including a historical one, is a fresh render from the frozen snapshot. UI copy says "Regenerate PDF/DOCX/JSON", never "Download", for exactly this reason.

### Feature flags

Each format is gated independently, and never gates the others — enabling JSON does not require DOCX, disabling DOCX does not affect PDF. Each has a server/client pair (`lib/env.ts` / `NEXT_PUBLIC_*`), default off:

| Format | Server flag | Client flag |
|---|---|---|
| PDF (base export system) | `ADAPTIVE_RESEARCH_EXPORT_ENABLED` | `NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED` |
| DOCX | `ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED` | `NEXT_PUBLIC_ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED` |
| JSON | `ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED` | `NEXT_PUBLIC_ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED` |

The server flag is the actual authority — it gates whether the creation route (`POST /api/user/runs/[runId]/export`) accepts the format at all (`app/api/user/runs/[runId]/export/route.ts`'s `validFormats` array). The client flag only controls whether the UI *offers* the option; a request for a server-disabled format is rejected the same generic `unsupported_format` way an unrecognized format string would be, never with a flag-specific message that would reveal the feature exists but is off. All three format flags are currently enabled in production (verified live in the Phase 3/4 production canaries referenced in this repo's session history).

## 2. Three version concepts — never conflated

| Concept | Field | Meaning |
|---|---|---|
| **Export contract version** | `AdaptiveResearchExportV1.version` (currently `1`) | The shape of the internal Firestore record itself. |
| **Report version** | `AdaptiveResearchExportV1.reportVersion` | Monotonic per-run counter, incremented once per export generation. Powers "Superseded" (a later export for the same run has a higher `reportVersion`). Assigned atomically via a Firestore transaction — see [Concurrency](#7-concurrency). |
| **JSON format version** | `AdaptiveResearchJsonExportV1.formatVersion` (currently `"1"`) | The version of the **public** JSON representation — a deliberate external projection, not the internal record. See [Compatibility policy](#3-json-v1-compatibility-policy). |

Adding a new `format` value (DOCX, then JSON) never bumps the export contract version — the same internal record shape simply renders through one more format-specific renderer, selected by `format`. These three numbers can differ independently: two exports of the same run at `reportVersion` 3 and 4 both carry export contract `version: 1`, and the JSON one separately carries `formatVersion: "1"`.

## 3. JSON v1 compatibility policy

`AdaptiveResearchJsonExportV1` (`lib/adaptiveSchema/jsonExport.ts`) is the first export format that is plausibly a customer integration surface — a downstream system could parse it programmatically. Its `formatVersion` field governs compatibility.

**Additive changes (do NOT bump `formatVersion`):**
- Adding a new optional field to an existing object.
- Adding a new enum member to a field that consumers should already treat as an open set (e.g. a new `schemaId`, a new panel `modelId`).
- Adding a new top-level section that did not exist before.

**Breaking changes (REQUIRE a `formatVersion` bump to `"2"`, with `"1"` still served for existing records/behavior where feasible):**
- Removing or renaming any existing field.
- Changing the *type* of an existing field (e.g. a string becoming an object).
- Narrowing an enum (removing a previously-valid value).
- Changing the *semantic meaning* of an existing field without changing its shape (e.g. redefining what `consensus.level` measures).
- Changing the discriminant values of the `result` union (`schemaFamily`) or removing a branch.

**Enum policy — two distinct categories, not one (final review, Step 20 — an earlier draft of this section conflated them):**
- **Actively growing today:** `report.schemaId` and `panel.models[].modelId`. ConvergePanel adds new schemas and model integrations over time; new values appear in these fields as a routine, expected consequence of product growth — this is additive by definition, not merely "reserved."
- **Fixed today, but reserved as forward-compatible under this policy:** `ConsensusLevel` (`"strong"|"moderate"|"weak"|"split"|"unscored"`, `lib/adaptiveSchema/reportSummary.ts`), `SourceGroundingLevel` (`"strong"|"moderate"|"weak"|"unscored"`), `AdaptiveExportClassification` (`"public"|"internal"|"confidential"|"restricted"`), and governance `kind`/`status`. These are closed, fully-enumerated sets in the current implementation — none of them grow automatically the way schema/model IDs do. They are still declared open under this policy (a new value could be added later — e.g. a new governance review state — and per §"Additive changes" above, adding an enum member does **not** bump `formatVersion`) so that such a future addition is not accidentally a breaking change in practice.

**Consumers integrating against JSON v1 MUST NOT exhaustively `switch`/pattern-match any enum field in this contract without a default/fallback case that tolerates an unrecognized value.** This applies to every enum listed above, including the ones that are closed today — the policy explicitly reserves the right to add a value to any of them without a `formatVersion` bump, so client code that would throw, crash, or silently misbehave on an unrecognized string is not written to this contract's actual compatibility guarantee, even if every value it currently sees is one from the list above.

**Optional-field policy:** a field is optional in the contract if and only if the underlying data can genuinely be absent (e.g. `decisionReceipt` when no governance record exists yet). Optional fields are omitted, never emitted as `null`, when absent (`JSON.stringify`'s own default behavior, since `buildAdaptiveResearchJsonExport` only sets a key when the source value is present).

This phase makes **no changes to the JSON v1 contract itself** — this section documents the policy that already governed its Phase 4 design, made explicit rather than left implicit.

## 4. Integrity model

### PDF and JSON: reproducible sha256

Both renderers are pure functions of the frozen record — no current-time reads, no randomness, no I/O beyond the record itself. Regenerating the same frozen export at any later time produces byte-identical output, and therefore the same sha256. This hash (`exportMetadata.fileHash`) is computed at generation time and persisted via `markAdaptiveExportReady()` — it has existed since Phase 1, but was never exposed in any API response until now.

**JSON determinism hotfix — `undefined` vs `null` across the Firestore round-trip.** `sanitizeForFirestore()` (`lib/firestore/sanitizeForFirestore.ts`) recursively converts every `undefined` to `null` before a record is persisted, since Firestore rejects `undefined` outright. Creation-time JSON rendering happens from the raw, never-persisted in-memory record (genuinely `undefined` for absent optional fields); regeneration always renders from the record as read back from Firestore (the same fields now `null`). Without correction this made creation and regeneration byte-DIFFERENT for any export where an optional-but-not-nullable field was genuinely absent — `buildAdaptiveResearchJsonExport()` (`lib/adaptiveSchema/jsonExport.ts`) now treats `null` as absent for exactly this bounded, explicitly-named set of fields: `panel.models[].ok`/`provenance.models[].ok`, milestone-2 `governance.conditions`/`result.decisionReceipt`, legacy `result.gate`/`synthesisReport`/`trustSummary`/`modelResponses`, and — one level deeper, since each `modelResponses[]` entry (`AdaptiveModelResult`) is concretely typed in this file rather than opaque — that entry's own `parseError`/`truncatedFields`/`invalidFields`/`coercions`/`retried` fields (never a blanket `null → undefined` across the whole snapshot — fields where `null` is a real, distinct value, e.g. legacy `governance.status: "approved" | "needs_review" | "blocked" | null` meaning "not yet evaluated", or `AdaptiveModelResult.data: Record<...> | null`, are never touched). Deliberately NOT extended into `milestone2.result` or `modelResponses[].data`'s own per-schema-result contents (e.g. a `ComparisonMatrixResult` cell's `consensusValue?`) — those remain genuinely opaque `unknown` blobs spanning 9+ schema shapes at this export-contract layer; normalizing them here would require importing and hand-maintaining per-schema knowledge that belongs to each schema's own producer/validator layer, not this export contract. This applies uniformly regardless of whether the input came from the pre-persistence in-memory object or a Firestore read, so both creation and regeneration converge on the same output — including for historical records already persisted with the pre-fix `null` drift, which now regenerate correctly with no migration needed.

**Milestone-2 Producer Canonicalization follow-up.** The theoretical `milestone2.result`/`modelResponses[].data` drift noted above was audited field-by-field, not left as a theoretical risk: all 9 active Milestone-2 alignment producers (`lib/adaptiveSchema/{comparison,enum,definition,causal,checklist,deepResearch,evidenceReview,biasBlindspot,decisionSupport}Alignment.ts`) were read in full. 6 were found to construct explicit-undefined own-properties (the same bug class as above, one layer deeper) and were fixed at their own producer boundary using the identical conditional-spread pattern; the other 3 were confirmed already safe by construction. `modelResponses[].data`'s own raw per-model fields were separately confirmed safe: they come from Zod `.optional()` parsing, which genuinely omits an absent key rather than ever setting it to explicit `undefined`. This fixes the drift at its source for all new writes; the export-layer normalization documented above is retained unchanged for historical Firestore records written before this producer fix.

### DOCX: NOT reproducible at the whole-file level — do not claim it is

The `docx` library (v9.7.1) unconditionally stamps `docProps/core.xml` timestamps and every ZIP entry's local file header with `new Date()` at render time, with no public option to override either. A whole-file sha256 of a DOCX export therefore differs between two renders of the identical record — this is expected, not a bug, and is verified directly in `lib/docx/__tests__/renderAdaptiveResearchDocx.spec.ts` by unzipping two independent renders and diffing `word/document.xml` byte-for-byte (identical) versus the full archive (not identical).

What **is** guaranteed for DOCX: the visible content — every heading, paragraph, table cell, governance label, provenance field inside `word/document.xml` — is a pure, deterministic function of the record, because the composer never uses `Hyperlink`/`ExternalHyperlink`/`Bookmark` (the library's other source of per-render randomness via `nanoid()`-based relationship IDs). A content-level integrity check (hashing `word/document.xml` alone, not the whole `.docx`) would be fully reliable; this phase does not build one, since no consumer need for it has surfaced yet, and the existing `exportMetadata.fileHash` (a whole-file hash) is still useful for basic single-response tamper/corruption detection — it is documented here as **not** a "did regeneration reproduce export A" proof for DOCX, unlike PDF/JSON.

### `hashReproducible`: the machine-readable field that distinguishes them (final review, Step 3)

`GET /api/user/runs/[runId]/exports` now includes, per list item, `fileHash` (sha256 hex), `hashAlgorithm: "sha256"`, and **`hashReproducible: boolean`** — all three present together only when the export reached `"ready"` (absent for `"generating"`/`"failed"` records, which never produced bytes). `hashReproducible` is `true` for PDF/JSON, `false` for DOCX. This is not prose-only documentation of the distinction above — it is a field a machine consumer can branch on before treating `fileHash` as a "did this regeneration reproduce the original" check. An earlier draft of this API exposed `fileHash`/`hashAlgorithm` identically for all three formats with no such field, which would have let a consumer reasonably (and incorrectly) assume DOCX's hash was reproducible the same way PDF/JSON's is — caught and fixed during final review before merge.

`hashReproducible` is derived on the fly from `format` in the route (`format !== "docx"`) — it is never persisted, so this required no change to `AdaptiveResearchExportV1`/`exportMetadata`'s frozen shape and needs no migration; see the "Hash fields: persisted vs. projected" note below.

### Exposing `fileHash` is additive, not a contract change

This is a new optional field set on an already-internal, ownership-gated response — not a change to the public `AdaptiveResearchJsonExportV1` contract (which does not include `fileHash` at all; it's meaningless for JSON's own self-referential output, since a JSON export doesn't need to prove it matches "a JSON export" — the bytes and their hash are the same request). Neither the JSON contract's `formatVersion` nor the internal export contract's `version` needed to change for this.

### Hash fields: persisted vs. projected

`fileHash` (the sha256 itself) is **persisted** — it has lived on `exportMetadata.fileHash` since Phase 1, written by `markAdaptiveExportReady()`, unchanged by Phase 5. `hashAlgorithm` is a constant literal, not a stored field. `hashReproducible` is **purely projected** — computed from `format` at response-serialization time in the history route, never written to Firestore. No migration is required for existing export records: every one of them already has whatever `fileHash` it had before, and the two new response fields are derived, not read from a new column that old records would lack.

### Historical regeneration and hash comparison

A historical-regeneration verification (Part 26/31) must compare hashes **within the same format**: two PDF regenerations of the same record should match; two DOCX regenerations of the same record legitimately will not, because of the timestamp non-determinism above. A verification script or test that fails a DOCX case purely because ZIP timestamps changed is testing the wrong invariant — it should instead diff `word/document.xml` content, or simply confirm the file opens and contains the expected visible text.

## 5. Export manifest

`AdaptiveExportManifest` (`exportMetadata` on the internal record) already exists and already serves as the compact, content-free provenance record: section labels, `fileHash`, `createdAt`, `requestingUser`, `finalReportVersion`. Evaluated whether this warrants a dedicated, separately-fetchable manifest endpoint — concluded no: every field on it that's safe to expose externally is already surfaced either in the JSON export's own `provenance` block or in the history-list route's per-item metadata. A separate `GET /manifest` endpoint would duplicate data already reachable through two existing surfaces for no new capability. Not built.

## 6. JSON schema documentation

### Top-level shape

```
AdaptiveResearchJsonExportV1
├─ formatVersion: "1"
├─ export        { exportId, reportVersion, createdAt, format: "json" }
├─ report        { runId, schemaId, schemaVersion: 1, schemaFamily, question, generatedAt }
├─ panel         { models[], consensus: { level }, sourceGrounding: { level } }
├─ governance    (family-discriminated — see below)
├─ classification: "public" | "internal" | "confidential" | "restricted"
├─ result        (family-discriminated — see below)
└─ provenance    { runId, exportId, reportVersion, contractVersion: 1, schemaId, schemaVersion, schemaFamily, generatedAt, exportedAt, models[], governanceStatusAtExport, classification }
```

`export` and `provenance` both carry `exportId`/`reportVersion` — this is intentional, not duplication-by-accident: `export` is "how this specific file came to exist"; `provenance` is "the full chain of custody for the content", grouped for a consumer that only cares about tamper/lineage tracking and wants one object to check rather than reassembling it from three places.

### `panel.consensus` and `panel.sourceGrounding`

`level` is one of `"strong" | "moderate" | "weak" | "split" | "unscored"` (consensus) or `"strong" | "moderate" | "weak" | "unscored"` (source grounding). **`"unscored"` is a real, honestly-computed value** — it means this schema (e.g. `creative_generative`) has no consensus/grounding concept at all, not that scoring failed or was skipped. It is never coerced to `0`, which would falsely imply a measured score of zero.

**Consensus does not prove factual correctness.** A `"strong"` consensus level means multiple models agreed with each other — it says nothing about whether that agreement reflects ground truth. Models trained on similar data, or sharing a common blind spot, can produce strong agreement on an incorrect answer.

**Source grounding is a distinct signal from consensus**, not a component of it. A response can have strong consensus (models agree) with weak source grounding (little cited evidence), or the reverse (well-sourced but models disagree on interpretation). Consumers should not average or conflate the two into a single "trust score."

### `governance` (and `provenance.governanceStatusAtExport`, identical shape)

```ts
{ family: "milestone2"; kind: ReportStatusKind | "superseded"; isOwnerOverride: boolean; conditions?: string[] }
| { family: "legacy"; status: "approved" | "needs_review" | "blocked" | null }
```

`ReportStatusKind` = `"unreviewed_in_queue" | "not_reviewed_no_review_configured" | "approved" | "approved_with_conditions" | "changes_requested" | "rejected" | "incomplete"`.

This is the **exact status frozen at export time** — never re-evaluated, never relabeled. A historical export of a run that was `needs_review` at export time stays `needs_review` in that export forever, even if the live run is later approved (see [§9](#9-authorization-now-content-then)). `conditions` (verbatim reviewer conditions) is present only when `kind === "approved_with_conditions"`.

### `result` (family-discriminated on `schemaFamily`)

Milestone-2 branch (9 schemas: `ranked_enumeration`, `comparison_matrix`, `definition_explanation`, `causal_explanation`, `checklist_taxonomy`, `deep_research`, `evidence_review`, `bias_blindspot_audit`, `decision_support` — see `PersistedAdaptiveSchemaId`):
```ts
{ schemaFamily: "milestone2"; schemaId; result: unknown /* schema's own aggregated structured result */; decisionReceipt?: AdaptiveDecisionReceipt }
```
`result` is passed through verbatim from the frozen snapshot — the same structured shape the live UI and PDF/DOCX composers already read, never re-derived. `decisionReceipt` is absent (never fabricated) when no governance record existed for the run at export time.

Legacy branch (8 original schemas: `procedural`, `contested_empirical`, `legal_regulatory`, `financial_valuation`, `factual_lookup`, `medical_health`, `forecast_speculative`, `creative_generative` — see `PersistedLegacyAdaptiveSchemaId` — plus `generic`, handled by the same tri-tab fallback path):
```ts
{ schemaFamily: "legacy"; schemaId; alignedClaims: AlignedClaim[]; gate?; synthesisReport?; trustSummary?; modelResponses?: AdaptiveModelResult[] }
```

### Sanitized synthetic examples

The following are hand-constructed, illustrative examples — **not** verbatim production data — trimmed to the fields that matter for shape, with representative values.

**`comparison_matrix` (Milestone-2 branch, abbreviated `result.result`):**
```json
{
  "formatVersion": "1",
  "export": { "exportId": "exp-example-1", "reportVersion": 3, "createdAt": "2026-08-01T12:00:00.000Z", "format": "json" },
  "report": { "runId": "run-example-1", "schemaId": "comparison_matrix", "schemaVersion": 1, "schemaFamily": "milestone2", "question": "Compare three CRM platforms for a 20-person sales team", "generatedAt": "2026-08-01T11:58:00.000Z" },
  "panel": { "models": [{ "modelId": "chatgpt", "ok": true }, { "modelId": "claude", "ok": true }], "consensus": { "level": "moderate" }, "sourceGrounding": { "level": "strong" } },
  "governance": { "family": "milestone2", "kind": "approved", "isOwnerOverride": false },
  "classification": "internal",
  "result": {
    "schemaFamily": "milestone2",
    "schemaId": "comparison_matrix",
    "result": {
      "subjects": [{ "id": "platform-a", "label": "Platform A", "coverageCount": 2, "totalModels": 2, "coverageRatio": 1 }],
      "hasVerifiedSourceData": false,
      "totalModels": 2,
      "cells": [
        { "subjectId": "platform-a", "subject": "Platform A", "attributeId": "price", "attribute": "Price per seat", "valuesByModel": { "chatgpt": "$25/mo", "claude": "$25/mo" }, "agreement": "consensus", "consensusValue": "$25/mo", "coverageCount": 2, "totalModels": 2, "coverageRatio": 1 },
        { "subjectId": "platform-b", "subject": "Platform B", "attributeId": "rate-limits", "attribute": "API rate limits", "valuesByModel": { "chatgpt": "1000 req/min", "claude": "unclear from public docs" }, "agreement": "split", "coverageCount": 2, "totalModels": 2, "coverageRatio": 1 }
      ]
    }
  },
  "provenance": { "runId": "run-example-1", "exportId": "exp-example-1", "reportVersion": 3, "contractVersion": 1, "schemaId": "comparison_matrix", "schemaVersion": 1, "schemaFamily": "milestone2", "generatedAt": "2026-08-01T11:58:00.000Z", "exportedAt": "2026-08-01T12:00:00.000Z", "models": [{ "modelId": "chatgpt", "ok": true }, { "modelId": "claude", "ok": true }], "governanceStatusAtExport": { "family": "milestone2", "kind": "approved", "isOwnerOverride": false }, "classification": "internal" }
}
```

**`financial_valuation` (legacy branch, abbreviated) — illustrates independent per-model metrics via `modelResponses`:**
```json
{
  "result": {
    "schemaFamily": "legacy",
    "schemaId": "financial_valuation",
    "alignedClaims": [],
    "modelResponses": [
      { "modelId": "chatgpt", "ok": true, "schemaId": "financial_valuation", "data": { "metric": "EV/EBITDA multiple", "value": 8.2, "range": { "low": 7.0, "high": 9.5 }, "assumptions": ["Revenue growth 12% YoY"] } },
      { "modelId": "claude", "ok": true, "schemaId": "financial_valuation", "data": { "metric": "EV/EBITDA multiple", "value": 10.1, "range": { "low": 8.8, "high": 11.6 }, "assumptions": ["No major regulatory change in the sector"] } }
    ]
  }
}
```
Note the genuinely independent 8.2x vs 10.1x multiples — this schema does not force models toward a single agreed number; disagreement between models is preserved and visible, not averaged away.

**`creative_generative` (legacy branch) — a schema with no consensus/grounding concept:**
```json
{
  "panel": { "models": [{ "modelId": "chatgpt" }, { "modelId": "claude" }], "consensus": { "level": "unscored" }, "sourceGrounding": { "level": "unscored" } },
  "result": {
    "schemaFamily": "legacy",
    "schemaId": "creative_generative",
    "alignedClaims": [],
    "modelResponses": [
      { "modelId": "chatgpt", "ok": true, "schemaId": "creative_generative", "data": { "output": "Tagline and brand story text...", "styleNotes": ["Whimsical tone", "Vivid imagery"] } },
      { "modelId": "claude", "ok": true, "schemaId": "creative_generative", "data": { "output": "A different tagline and brand story...", "styleNotes": ["Literary language", "Warm and inviting"] } }
    ]
  }
}
```
`consensus`/`sourceGrounding` both report `"unscored"` honestly, rather than a misleading `0` or an omitted field — this schema was never scored on either axis, which is a fact about the schema, not missing data.

## 7. Machine-readable schema artifact

`lib/adaptiveSchema/jsonExportSchema.ts` already contains a Zod schema (`adaptiveResearchJsonExportV1Schema`) that fully validates the contract's outer shape and the `result` discriminated union's own fixed keys — this **is** the project's machine-readable definition of the JSON v1 contract, expressed in the validation library the rest of `lib/adaptiveSchema/` already uses.

Considered generating a static `.json` JSON-Schema artifact from it (via `zod-to-json-schema`) for non-TypeScript consumers. Decided against adding this dependency for Phase 5: it is a new package for a capability with no current consumer request, and a hand-maintained parallel JSON Schema file (the alternative, avoiding the dependency) risks drifting from the Zod source of truth the moment either one is edited without the other. If a non-TS integration partner needs a static JSON Schema file later, generating one from `jsonExportSchema.ts` at that point is a single `zod-to-json-schema` call — a small, well-scoped addition driven by real demand rather than spec-completeness.

## 8. MIME type / filename contract

| Format | Content-Type | Extension |
|---|---|---|
| PDF | `application/pdf` | `.pdf` |
| DOCX | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `.docx` |
| JSON | `application/json; charset=utf-8` | `.json` |

Single source of truth: `adaptiveExportContentType()` / `adaptiveExportFileExtension()` in `lib/adaptiveSchema/researchExport.ts` — both creation and regeneration routes call these rather than each hardcoding a copy.

Filename pattern (both routes, identical): `` convergepanel-export-${runId}-v${reportVersion}.${extension} ``, sent via `Content-Disposition: attachment; filename="..."`. Filename safety: `runId` is a server-generated Firestore document ID (never raw user input), and `reportVersion` is a server-assigned integer — neither can introduce a `"` or path-traversal sequence into the header value. No additional escaping is currently applied because no component of the filename is ever attacker-controlled; if a future field derived from user-editable text were ever added to the filename, it would need explicit sanitization at that point.

## 9. Authorization now, content then

Two independent, deliberately different authorization behaviors:

**Creation** (`POST /api/user/runs/[runId]/export`): evaluates the requester's **current** plan entitlement, run ownership, organization policy, and the run's **current** governance state (`resolveAdaptiveExportVerdict`, single central function — `lib/adaptiveSchema/exportAuthorization.ts`). A rejected (Milestone-2) or blocked (legacy) run cannot be exported at all; every other governance state is exportable but the rendered content carries a visible status notice when not `approved`.

**Regeneration** (`GET /api/user/runs/[runId]/exports/[exportId]`): re-evaluates the requester's **current** ownership and entitlement — a plan downgrade after creating an export denies regeneration going forward, access is never a permanent grant frozen at creation time — but authorizes against the export's **frozen** `classification`/`governanceStatusAtExport`, never the run's current state. This is the "authorization now, content then" split: *who* may access is re-checked every time; *what the export says* is locked forever to what was true when it was generated.

Concretely: a historical export created while a run was `needs_review` stays `needs_review` in that export's content even after the live run is later `approved` — regenerating that export re-renders the same frozen record, producing the same `needs_review` notice, every time. The only way to get an export reflecting the new `approved` state is to create a **new** export (a new `reportVersion`) after approval.

## 10. History listing — pagination

`GET /api/user/runs/[runId]/exports` is cursor-paginated (`lib/firestore/adaptiveExports.ts`'s `listAdaptiveExportRecords`): `?cursor=<reportVersion>` (from the previous page's `nextCursor`) fetches strictly older exports; `?limit=` is optional and always clamped server-side to `[1, 50]` (default 30) regardless of what a caller requests. The query — `orderBy("reportVersion", "desc").limit(n+1)` with an optional `.where("reportVersion", "<", cursor)` — filters and sorts on the same single field, which Firestore auto-indexes without a composite index entry; no change to `firestore.indexes.json` was needed.

`AdaptiveExportHistorySection.tsx` consumes `hasMore`/`nextCursor` and renders a "Load more" button that appends the next page — no infinite scroll, matching the phase's own "simple Load more is acceptable" guidance.

**Cursor safety and tie-breaking (final review, Steps 7-9), independently verified with deterministic tests** (`lib/firestore/__tests__/adaptiveExports.spec.ts`):
- **Timestamp collisions cannot cause skips/duplicates.** The sort key and cursor are both `reportVersion` — an integer, unique per run by construction (the atomic creation transaction, §14) — never `createdAt`. Multiple records sharing the exact same `createdAt` string (a real possibility: low-resolution timestamps, or several formats created in the same request burst) paginate correctly because ordering never depends on `createdAt` at all. Proven with 12 records sharing one identical `createdAt`, paginated in pages of 5: all 12 returned exactly once, in strict descending order.
- **A cursor cannot cross a run boundary.** The Firestore collection reference is always `runs/{runId}/exports`, where `runId` comes from the URL path (already ownership-checked earlier in the same request) — never from the cursor. The cursor is only ever a numeric `<` filter *within* that already-scoped collection; a `reportVersion` value that happens to coincide with a real version in a different run cannot leak that other run's records, because the query never targets that other run's collection. Proven directly: supplying a large cursor value against one run while a structurally-identical `reportVersion` exists in a different run returns only the first run's own records.
- **Malformed limit/cursor values degrade safely, never remove the cap.** Verified at both the route's query-param-parsing layer and the Firestore-layer function itself (defense in depth — the function doesn't trust its caller already sanitized): non-numeric, `Infinity`, `NaN`, `0`, negative, and fractional values for both `limit` and `cursor` all either clamp into range or fall back to the default first page — none can produce an unbounded read or a thrown error. (Server max is a hard `50`; page size is clamped independently of what a client requests.)
- **Pagination is live, newest-first, not snapshot-isolated** — this is a deliberate, documented choice, not an oversight. A new export created between two page fetches becomes the new head of the list but sorts *above* whatever cursor an in-progress pagination is using, so it can never appear on an already-cursored older page and can never cause an older page's items to duplicate or be silently skipped. Proven directly: fetch page 1, create a new export, fetch page 2 with page 1's cursor — no duplicates across the two pages, and the newly-created item never appears on page 2.

## 11. Lifecycle wording

`AdaptiveExportArtifactStatus` = `"generating" | "ready" | "failed" | "superseded"`. Audited for language implying permanent storage (`"archived PDF"`, `"stored document"`, `"permanent download"`, `"saved to storage"`) — none found anywhere in components/lib/docs. "Ready" is documented, and UI copy reflects, that it means a file was successfully generated and streamed **at that moment**, never that a file sits in storage waiting. "Superseded" is a lifecycle transition (a newer export exists), not an invalidation — a superseded record's frozen `reportSnapshot` remains fully readable and regenerable.

Failed-artifact semantics (regression-checked): a `"failed"` or `"generating"` record is never downloadable (`GET /exports/[exportId]` returns `409 export_not_ready`; the history UI disables its Regenerate button for both states), is never itself regenerated as a side effect of another action, never gets marked `"superseded"` by `supersedeOlderAdaptiveExports` (which only touches previously-`"ready"` records), and its presence in a listing page never disrupts pagination — it's just another row with its own `reportVersion`.

## 12. Observability

`admin_audit_logs` (via `writeAdaptiveExportAdminAuditEvent`) already recorded outcome (`success`/`failure`), format, schema, classification, governance state at export, and `failureReason` for every generation/regeneration since Phase 1/2. Phase 5 adds two low-risk numeric fields, success path only where meaningful:
- `durationMs` — render wall-clock time, recorded on both success and failure (so a slow failure is also visible, not just slow successes).
- `byteSize` — generated artifact size in bytes, success only (a failed render produced no bytes).

Neither ever includes report content, reviewer comments, or secrets — purely operational numbers. An admin can now determine per-format success/failure counts, render duration trends, and output size trends directly from `admin_audit_logs`, without a separate metrics pipeline.

## 13. Error taxonomy

Reviewed across all three export routes. Codes in use: `invalid_request` (400), `unsupported_format` (400), `forbidden` (403), `not_found` (404), `no_report` (422), `export_create_failed` (500), `export_generation_failed` (500), `export_not_ready` (409), `regeneration_failed` (500), `list_failed` (500), plus dynamic authorization-verdict reasons (`not_run_owner`, `plan_not_entitled`, `organization_policy_blocked`, `governance_state_blocked`) surfaced as the `errorCode` on a 403. This set already distinguishes the meaningful failure categories a client needs to react to differently, without leaking existence information (e.g. a foreign run/export combination and a genuinely missing one both return the same generic `not_found`). No new error codes were introduced in Phase 5; a JSON-export size overflow (`NonFiniteNumberError`-style rejection) reuses the existing generic `export_generation_failed` path rather than a dedicated code, since the distinction ("too large" vs. "renderer threw") is already visible server-side in the logged `failureReason` and has no client-actionable difference.

## 14. Concurrency

`createAdaptiveExportRecord` assigns `reportVersion` inside a Firestore transaction that reads the run's counter and writes both the incremented counter and the new export record atomically — Firestore's optimistic concurrency control retries the whole transaction if the counter document changed since it was read, so two genuinely concurrent creations for the same run can never receive the same `reportVersion`. This logic never inspects `format`, so it is format-agnostic by construction; verified directly with dedicated tests (`lib/firestore/__tests__/adaptiveExports.spec.ts`) covering 2-way and 10-way same-format concurrency, cross-run independence, and — new in Phase 5 — three concurrent **mixed-format** (pdf/docx/json) creations for the same run, confirming distinct, non-colliding `reportVersion`s regardless of which formats are requested simultaneously.

## 15. Idempotency — deferred, by evidence

Evaluated whether the creation endpoint needs server-side idempotency (e.g. an idempotency key to collapse duplicate double-submitted requests into one export). Evidence considered:
- **Client-side protection already exists:** `AdaptiveExportButton`'s export control is `disabled` for the full duration of `state === "loading"`, so a double-click on the same session's button cannot fire two concurrent creation requests.
- **Read-only audit-log scan (final review, Step 19):** queried every `adaptive_export_generated` event in `admin_audit_logs` (55 events total across this engagement's history), grouped by run+format, looking for creations under 5 seconds apart on the same run+format — the signature of an accidental double-submit rather than a legitimate later re-export. **One cluster found:** two PDF creations for the same run, 146ms apart, both from this engagement's own test account during earlier canary testing (consistent with a scripted back-to-back test call, not a real user's accidental double-click — the disabled-button protection specifically defends against the latter). No other clusters exist across the full history. This is a single, explainable, self-generated data point, not evidence of a live customer-facing duplicate-submission problem.
- **The one real near-duplicate found was handled correctly:** both requests received their own valid, non-colliding, fully-formed export (`reportVersion` 9 and 10) — direct confirmation that even when a duplicate genuinely occurs, the atomic `reportVersion` transaction (§14) prevents any corruption or collision. The worst case is an extra row in the history list, not data corruption or a security gap.

Given the one real data point is explainable and non-problematic, and the atomic transaction already makes a genuine duplicate harmless, **server-side idempotency is deferred, not built.** This should be revisited if production telemetry later shows a genuine pattern of duplicate submissions from real user traffic (e.g. from retried requests on flaky connections) that the client-side button-disable doesn't catch — a network-layer retry, unlike a double-click, bypasses the disabled-button protection.

## Non-goals

Explicitly out of scope for the export system as built, and not accidental gaps:

- **CSV.** ConvergePanel reports contain nested, schema-varying data (models, claims, scenarios, evidence, governance, provenance, per-schema structures). Flattening that into rows either loses meaning or forces a complicated per-schema row model. JSON already serves technical/machine-readable consumption; PDF/DOCX serve human consumption. Treat CSV as a customer-demand feature tied to a specific schema's tabular use case, not a default roadmap item.
- **Object storage.** No signed URLs, no blob storage, no byte persistence anywhere. Every download is a fresh, deterministic render from the frozen Firestore snapshot.
- **The design doc's full 7-permission granular export matrix** (`export_raw_model_outputs`, `export_reviewer_identity`, etc.). Phase 1 built the single least-privilege default export (final content + sources + governance status, never raw model output for Milestone-2, never private reviewer identity/comments) via one central `canExportAdaptiveResearch()` verdict function, not the richer matrix — no product requirement for finer-grained permissions has surfaced.
- **A dedicated export manifest endpoint** — see [§5](#5-export-manifest).
- **A static JSON-Schema artifact file** — see [§7](#7-machine-readable-schema-artifact).
- **Broad server-side idempotency subsystem** — see [§15](#15-idempotency--deferred-by-evidence).
