# Adaptive Research Export — Architecture (as built)

**Status:** accurate as of Phase 5 (2026-08-11). Supersedes `adaptive-research-export-design.md`, the pre-implementation proposal.

Formats: **PDF** (Phase 1), **DOCX** (Phase 3), **JSON** (Phase 4). CSV and object storage are explicitly out of scope — see [Non-goals](#non-goals).

## 1. Storage model

There is no object storage anywhere in this codebase (no signed URLs, no `@vercel/blob`, no S3/GCS SDK). The durable artifact is a frozen metadata+content record — `AdaptiveResearchExportV1` — persisted in Firestore at `runs/{runId}/exports/{exportId}`. File bytes (PDF/DOCX/JSON) are **never stored**; they are a deterministic, pure function of the frozen record, generated on demand at export time and again on every regeneration, then discarded once the HTTP response completes.

This is why "ready" describes the record, not a file sitting in storage: it means the snapshot was durably persisted **and** a file was successfully generated and streamed at that moment. There is no "re-download the same bytes" — every download, including a historical one, is a fresh render from the frozen snapshot. UI copy says "Regenerate PDF/DOCX/JSON", never "Download", for exactly this reason.

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

**Enum policy:** enums in this contract (`ConsensusLevel`, `SourceGroundingLevel`, `AdaptiveExportClassification`, governance `kind`/`status`) are documented as **open sets** consumers should not exhaustively switch on without a default case — ConvergePanel adds schema IDs and model IDs over time, and those propagate into `panel.models[].modelId` and `report.schemaId` without a version bump.

**Optional-field policy:** a field is optional in the contract if and only if the underlying data can genuinely be absent (e.g. `decisionReceipt` when no governance record exists yet). Optional fields are omitted, never emitted as `null`, when absent (`JSON.stringify`'s own default behavior, since `buildAdaptiveResearchJsonExport` only sets a key when the source value is present).

This phase makes **no changes to the JSON v1 contract itself** — this section documents the policy that already governed its Phase 4 design, made explicit rather than left implicit.

## 4. Integrity model

### PDF and JSON: reproducible sha256

Both renderers are pure functions of the frozen record — no current-time reads, no randomness, no I/O beyond the record itself. Regenerating the same frozen export at any later time produces byte-identical output, and therefore the same sha256. This hash (`exportMetadata.fileHash`) is computed at generation time and persisted via `markAdaptiveExportReady()` — it has existed since Phase 1, but was never exposed in any API response until now.

### DOCX: NOT reproducible at the whole-file level — do not claim it is

The `docx` library (v9.7.1) unconditionally stamps `docProps/core.xml` timestamps and every ZIP entry's local file header with `new Date()` at render time, with no public option to override either. A whole-file sha256 of a DOCX export therefore differs between two renders of the identical record — this is expected, not a bug, and is verified directly in `lib/docx/__tests__/renderAdaptiveResearchDocx.spec.ts` by unzipping two independent renders and diffing `word/document.xml` byte-for-byte (identical) versus the full archive (not identical).

What **is** guaranteed for DOCX: the visible content — every heading, paragraph, table cell, governance label, provenance field inside `word/document.xml` — is a pure, deterministic function of the record, because the composer never uses `Hyperlink`/`ExternalHyperlink`/`Bookmark` (the library's other source of per-render randomness via `nanoid()`-based relationship IDs). A content-level integrity check (hashing `word/document.xml` alone, not the whole `.docx`) would be fully reliable; this phase does not build one, since no consumer need for it has surfaced yet, and the existing `exportMetadata.fileHash` (a whole-file hash) is still useful for basic single-response tamper/corruption detection — it is documented here as **not** a "did regeneration reproduce export A" proof for DOCX, unlike PDF/JSON.

### Exposing `fileHash` is additive, not a contract change

`GET /api/user/runs/[runId]/exports` now includes `fileHash`/`hashAlgorithm: "sha256"` per list item when the export reached `"ready"` (absent for `"generating"`/`"failed"` records, which never produced bytes). This is a new optional field on an already-internal, ownership-gated response — not a change to the public `AdaptiveResearchJsonExportV1` contract (which does not include `fileHash` at all; it's meaningless for JSON's own self-referential output, since a JSON export doesn't need to prove it matches "a JSON export" — the bytes and their hash are the same request). No version bump.

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
- **No audit evidence of real duplicates:** nothing in this engagement's testing (including the earlier production canaries) surfaced `reportVersion` gaps or audit-log patterns suggesting accidental duplicate submissions.
- **A duplicate, if it ever happened, is not a correctness or security problem** — the atomic `reportVersion` transaction (§14) guarantees each request still gets its own valid, non-colliding, fully-formed export. The worst case is an extra row in the history list, not data corruption or a security gap.

Given no evidence of a real problem and an existing lightweight mitigation, **server-side idempotency is deferred, not built.** This should be revisited if production telemetry later shows a genuine pattern of duplicate submissions (e.g. from retried requests on flaky connections) that the client-side button-disable doesn't catch — a network-layer retry, unlike a double-click, bypasses the disabled-button protection.

## Non-goals

Explicitly out of scope for the export system as built, and not accidental gaps:

- **CSV.** ConvergePanel reports contain nested, schema-varying data (models, claims, scenarios, evidence, governance, provenance, per-schema structures). Flattening that into rows either loses meaning or forces a complicated per-schema row model. JSON already serves technical/machine-readable consumption; PDF/DOCX serve human consumption. Treat CSV as a customer-demand feature tied to a specific schema's tabular use case, not a default roadmap item.
- **Object storage.** No signed URLs, no blob storage, no byte persistence anywhere. Every download is a fresh, deterministic render from the frozen Firestore snapshot.
- **The design doc's full 7-permission granular export matrix** (`export_raw_model_outputs`, `export_reviewer_identity`, etc.). Phase 1 built the single least-privilege default export (final content + sources + governance status, never raw model output for Milestone-2, never private reviewer identity/comments) via one central `canExportAdaptiveResearch()` verdict function, not the richer matrix — no product requirement for finer-grained permissions has surfaced.
- **A dedicated export manifest endpoint** — see [§5](#5-export-manifest).
- **A static JSON-Schema artifact file** — see [§7](#7-machine-readable-schema-artifact).
- **Broad server-side idempotency subsystem** — see [§15](#15-idempotency--deferred-by-evidence).
