# Adaptive Synthesis Report — Batch 3 Persistence & Architecture Audit

**Date:** 2026-08-09
**Status:** Audit / design only. No application code was changed to produce this document.
**Scope discipline:** Per the task that requested this document, this audit does **not** implement Batch 3, does not modify persistence, renderers, or the classifier, and does not begin Adaptive Research Export. Every finding below is grounded directly in the current repository (grep/read output cited by file and line range), not in prior docs or session memory — where older docs (`docs/adaptive-persistence-design.md`, code comments) disagreed with current code, current code won.

---

## 0. TL;DR

- The prompt's assumption of **8** remaining Batch 3 schemas is off by one. `procedural` (the Phase 2 pilot) is already done. **7 schemas remain**: `contested_empirical`, `legal_regulatory`, `financial_valuation`, `factual_lookup`, `medical_health`, `forecast_speculative`, `creative_generative`.
- All 7 have the same History-persistence failure, for the same reason: `orchestrate.ts` only builds a persistable envelope when `schema.id === "procedural"` — a hardcoded literal, not a real gate. The claims-matrix data these 7 schemas compute (`alignedClaims`/`gate`/`synthesisReport`/`trustSummary`) is structurally identical to what `procedural` already persists successfully; it's just never packaged into an envelope for them.
- The failure is **not** "some fields are missing on reload." It's a full fallback to a different, older client-side rendering path (`synthesizeReport()` in `app/page.tsx`) that never invokes `AdaptivePanelResponse` at all. History looks like a different, cruder product for these 7 schemas today.
- Raw per-model text is **already safe** for all 7 — it persists today via the older, independent `runDocument`/`completeRun()` mechanism, unrelated to the adaptive envelope. Only the *aggregated* structured result is missing. This is the opposite asymmetry from the Milestone-2 (Batch 1/2) family, where raw responses are deliberately never persisted but the aggregate is.
- **One shared, narrow persistence fix is safe**: generalize the existing `PersistedLegacyAdaptiveOutputV1` type and `attachLegacyAdaptiveEnvelope()` function from a single `schemaId: "procedural"` literal to a 7-member union, gated the same way `procedural` already is. No migration needed. The consuming adapter (`adaptPersistedLegacyOutputToPanelPayload`) is already schema-agnostic and requires zero changes.
- The 6 non-`factual_lookup` dedicated renderers (`ConsensusMapView`, `RuleApplicationView`, `MetricsGridView`, `EvidenceTiersView`, `ScenarioTreeView`, `GalleryView`) are **already wired up and already live** today via `AdaptiveResultsView` (the Compare-tab / universal-fallback dispatcher). Promoting them to "primary view" status is a config change (extend the existing `PHASE2_PILOT_SCHEMAS` Set), not new component work.
- `factual_lookup` is architecturally identical to the other 6 for persistence purposes but already has a dedicated primary-view branch (`DirectAnswerCard`) in `AdaptivePanelResponse.tsx`, wired in Milestone 1. It can ride in the **same persistence-foundation PR** as the other 6 with no special-casing, but its own renderer already exists and needs no promotion step.
- Recommended split: **2C-1** (persistence-foundation only, all 7 schemas, one envelope-type change) → **2C-2** (renderer promotion for a first subset) → **2C-3** (remaining renderer promotion). Do not combine persistence and promotion in one PR — they are separable, independently testable, and the smaller persistence PR de-risks the larger promotion PRs. This matches the closing framing note in the requesting task, confirmed rather than assumed.
- No changes are required to `lib/verification/`, `app/api/verify-claim/`, `lib/video/`, `app/api/verify-video/`, classifier taxonomy, Verification Gate rules, governance canonical state, or adaptive scoring logic. No architectural blocker was found.

---

## Part 1 — Exact Batch 3 Inventory

### 1.1 Count correction (repo-grounded, not assumed)

Grep of `fallbackQueryType: LEGACY_FALLBACK` in `lib/adaptiveSchema/schemaRegistry.ts` returns exactly 8 entries:

```
contested_empirical, legal_regulatory, financial_valuation, factual_lookup,
procedural, medical_health, forecast_speculative, creative_generative
```

`procedural` was implemented and merged in Phase 2B/Batch 2 work already completed this cycle (its `PHASE2_PILOT_SCHEMAS` entry, its `attachLegacyAdaptiveEnvelope()` call site, and its passing History-persistence tests all confirm this). That leaves **7 schemas genuinely remaining** for Batch 3, not 8. `generic` is a separate, ninth `PHASE2_PILOT_SCHEMAS` member but was never part of the `LEGACY_FALLBACK` set (it has no query classification to fall back from) and is out of scope here.

### 1.2 Per-schema matrix

| Schema ID | `renderHint` | Dedicated component | Live primary view today? | History primary view today? | Structured result type | Persists on write today? | History-parity failure |
|---|---|---|---|---|---|---|---|
| `contested_empirical` | `consensus_map` | `ConsensusMapView` | No — tri-tab shell fallback (dedicated view only reachable via Compare tab) | No — `synthesizeReport()` fallback | `AlignedClaim[]` + `AdaptiveGateResult` + `AdaptiveSynthesisReport` + `AdaptiveTrustSummary` (shared claims-matrix shape) | No (`legacyEnvelope = {}`, `schema.id !== "procedural"`) | Full fallback to different UI tree |
| `legal_regulatory` | `rule_application` | `RuleApplicationView` | No — same as above | No — same as above | same shared shape | No | same |
| `financial_valuation` | `metrics_grid` | `MetricsGridView` | No — same as above | No — same as above | same shared shape | No | same |
| `factual_lookup` | `direct_answer` | `DirectAnswerCard` | **Yes** — dedicated `AdaptivePanelResponse.tsx` branch since Milestone 1 | No — same as above | same shared shape | No | same (renderer exists but nothing to feed it on reload) |
| `medical_health` | `evidence_tiers` | `EvidenceTiersView` | No — tri-tab shell fallback | No — same as above | same shared shape | No | same |
| `forecast_speculative` | `scenario_tree` | `ScenarioTreeView` | No — tri-tab shell fallback | No — same as above | same shared shape | No | same |
| `creative_generative` | `gallery` | `GalleryView` | No — tri-tab shell fallback | No — same as above | same shared shape | No | same |

Notes verified directly from `AdaptiveResultsView.tsx` and `AdaptivePanelResponse.tsx`:

- `AdaptivePanelResponse.tsx` has a `switch`/branch dispatch that gives `direct_answer` its own primary-view branch (`DirectAnswerCard`) and gives the `PHASE2_PILOT_SCHEMAS` set (currently `["procedural", "generic"]`) the Phase 2 progressive-disclosure treatment. Every other `renderHint` — including all 6 non-`factual_lookup` Batch 3 hints — falls through to the tri-tab shell, whose Compare tab renders `AdaptiveResultsView`, which itself `switch`es on `renderHint` and already has a case for `consensus_map`/`rule_application`/`metrics_grid`/`evidence_tiers`/`scenario_tree`/`gallery`.
- No schema currently uses `verdict_card`; `VerdictCardView.tsx` exists but is unreachable dead code. Out of scope for Batch 3, noted only so it isn't mistaken for an eighth pending schema.
- `raw model responses persist?` column omitted from the table above because it's uniformly **yes, already, for all 7** via the independent `runDocument` mechanism — see Part 2/Part 3.

---

## Part 2 — Exact Persistence Chain (traced end-to-end)

```
LIVE RUN
  app/api/run-panel/route.ts (POST handler)
    → planAdaptiveRun() — classify + route (unchanged, not touched by this audit)
    → runPanel() — model fan-out
    → completeRun()                              [lib/firestore/runs.ts:109-354]
        writes runs/{runId}.runDocument           (perModel[].rawTextTruncated, capped 20k chars/model)
        ALWAYS runs, independent of schema/adaptive path — this is where raw text survives.
    → finalizeAdaptiveRun() → orchestrate.ts
        lines 677-732: shared claims-matrix path computes
          alignedClaims (scored), gate, synthesisReport, trustSummary
          — IDENTICAL computation for procedural and all 7 remaining Batch 3 schemas.
        line 718-721:
          const legacyEnvelope =
            schema.id === "procedural"
              ? attachLegacyAdaptiveEnvelope(classification, adaptiveResults, scored, gate, synthesisReport, trustSummary)
              : {};                                <-- THE GAP: literal-equality gate, not a set/union check
        returns { schemaId, adaptiveResults, alignedClaims, gate, synthesisReport, trustSummary, ...legacyEnvelope }
    → route.ts (~lines 900-1000):
        if (adaptiveOutput.persistedLegacyOutput) persistLegacyAdaptiveOutput(...)   [runs.ts:437, merge write → legacyAdaptiveOutput]
        if (adaptiveOutput.persistedOutput)       persistAdaptiveOutput(...)          [runs.ts:403, merge write → adaptiveOutput]  (Milestone-2 only)
        — for the 7 remaining Batch 3 schemas, `persistedLegacyOutput` is `undefined` (from the {} spread), so NEITHER write fires.
        — JSON response to the client DOES still include the live, in-memory adaptiveOutput (gate/synthesisReport/etc.) — the gap is
          persistence-only, not a live-rendering problem.

HISTORY READ
  app/api/user/runs/[runId]/route.ts (GET handler, read in full — 256 lines)
    → reads runs/{runId} doc
    → parsePersistedAdaptiveOutput(doc.adaptiveOutput)             → {status:"absent"} for all 7 (field was never written)
    → parsePersistedLegacyAdaptiveOutput(doc.legacyAdaptiveOutput) → {status:"absent"} for all 7 (field was never written;
                                                                       parser also actively REJECTS any schemaId !== "procedural"
                                                                       even if one were present — see Part 5)
    → runDocumentToPublicResults(doc.runDocument) / publicizePanelResults(...)  — raw per-model text IS returned regardless,
                                                                                    unconditional on adaptive/legacyAdaptive status
    → response: { results: [...raw...], adaptive: {status:"absent"}, legacyAdaptive: {status:"absent"}, ... }

  app/page.tsx: openHistoryItem() (~lines 1471-1640)
    if (data.adaptive.status === "absent" && data.legacyAdaptive.status === "absent"):
        setAdaptivePanel(null)                      <-- AdaptivePanelResponse never mounts, at all
        synthesizeReport(data.results)               <-- old, purely client-side, prose-oriented re-synthesis,
                                                          no knowledge of claims-matrix/schema shapes
        → renders the pre-adaptive legacy UI tree instead
```

**Key trace conclusion:** the gap is a single boolean condition (`schema.id === "procedural"`) at `orchestrate.ts` line 718, propagating through one unconditional `undefined` spread. No other file in the chain needs to change to close it — `route.ts`'s write-gating (`if (adaptiveOutput.persistedLegacyOutput) ...`) already works for any schema that produces a `persistedLegacyOutput`, and the read/adapter side (Part 5) is already schema-agnostic downstream of the type definition itself.

---

## Part 3 — Root Cause of the History Gap

**Classification: "persisted-but-never-attempted" — not "persisted-but-rejected," not "accepted-but-dropped," not "flattened-into-legacy."** The write is never attempted for these 7 schemas because `attachLegacyAdaptiveEnvelope()` is never called for them (Part 2). It is not that Firestore rejects a write, or that a value is computed and then discarded — the envelope object is simply never constructed.

Distinguishing renderer-critical vs. evidence-only persistence, as the task requests:

- **Renderer-critical (missing today):** `alignedClaims`, `gate`, `synthesisReport`, `trustSummary` — the aggregated, cross-model structured result. Every schema-aware UI surface (`AdaptiveResultsView`'s dedicated views, `DirectAnswerCard`, the Compare tab's `ClaimMatrix`, `TopSummaryBar`'s consensus badge on reload) depends on this. Its absence is what forces the full fallback in `app/page.tsx`.
- **Evidence-only (already safe, contrary to the Milestone-2 precedent):** raw per-model text. `runDocument.perModel[].rawTextTruncated` persists unconditionally via `completeRun()`, a mechanism that predates and is fully independent of the adaptive envelope system. This is confirmed by reading `lib/firestore/runs.ts` lines 109-354 — `completeRun()` has no schema-id branching at all.

This is the **inverse** of the Milestone-2 (Batch 1/2) asymmetry: there, raw model responses are deliberately never persisted (`results: []`) while the aggregate is. Here, raw text is already safe and only the aggregate is missing. Per the task's explicit instruction, the absence of historical raw responses should not be treated as blocking — and in this case it's moot, since raw responses were never actually absent for Batch 3 to begin with. The entire remaining problem is the aggregate.

No file inspected suggests multiple independent causes — this is a single, mechanical gate, not a family of unrelated bugs.

---

## Part 4 — `factual_lookup` Special Analysis

- **Live shape:** identical shared claims-matrix output as the other 6 (`alignedClaims`/`gate`/`synthesisReport`/`trustSummary`), reaching the same `orchestrate.ts` lines 677-732 fall-through path. `factual_lookup` has no separate live computation path — it is not architecturally distinct from the other 6 in *how* its data is produced.
- **Persistence shape:** same gap as the other 6 — `schema.id === "procedural"` excludes it identically. No special-case exists today, positive or negative.
- **History behavior:** identical failure — `adaptive.status`/`legacyAdaptive.status` both `"absent"`, full fallback to `synthesizeReport()`.
- **Can `DirectAnswerCard` be reconstructed from persisted structured data?** Yes, cleanly. `DirectAnswerCard.tsx` (read in full, 96 lines) consumes exactly `alignedClaims`/`gate` — the same shape a generalized `PersistedLegacyAdaptiveOutputV1` union would carry. No additional fields, no additional computation. Confirmed by direct read, not inferred from type signatures alone.
- **Is the "Claim Text fix" still intact?** Yes. `DirectAnswerCard.tsx`'s headline logic is `answerRow?.claimText || ok[0]?.data?.["answer"]` — it prefers the aligned claim's own text and falls back to the raw first-model answer field, never leaking a generic label like "Answer" or "Jurisdiction." This is unchanged and would continue to work unmodified once the envelope carries real data on reload; it is not sensitive to *how* the data arrives (live vs. persisted-and-reloaded), only to the shape, which is preserved.
- **Do consensus/source-grounding semantics differ from the other 6?** No material difference found. `factual_lookup` uses the same `gate`-based consensus fallback in `reportSummary.ts`'s `deriveConsensusLevel()` (lines 186-190) as the other 6, and the same `REPORT_TYPE_LABELS` pattern (`"Direct Answer"`) as every other schema in this family.
- **Recommendation — same PR or isolated?** **Same PR as the other 6, for the persistence-foundation batch (2C-1).** The persistence fix is schema-shape-identical across all 7; special-casing `factual_lookup` out of that PR would add complexity (a second envelope variant, or a follow-up PR to add one member to a union that's otherwise done) without a corresponding safety benefit — there is no `factual_lookup`-specific risk in the persistence layer itself. Its *renderer* is already done (unlike the other 6), so it should be **excluded from the renderer-promotion batches** (2C-2/2C-3) since there is no promotion work required for it — it already has a live primary view; only its persistence needs the shared fix.

---

## Part 5 — Persistence Architecture Options

### Option A — Extend `PersistedLegacyAdaptiveOutputV1`'s `schemaId` to a union

Change `lib/adaptiveSchema/persistedOutput.ts`'s `schemaId: "procedural"` literal to a union of the 7 remaining values, and change `orchestrate.ts`'s `schema.id === "procedural"` gate to a `Set`/array membership check (mirroring the existing `PHASE2_PILOT_SCHEMAS` idiom already used in `AdaptivePanelResponse.tsx`).

| Dimension | Assessment |
|---|---|
| Type safety | Strong — discriminated union stays exhaustive; TypeScript will flag any renderer/adapter code that doesn't handle a new `schemaId` value. |
| Runtime validation | Trivial extension of the existing `parsePersistedLegacyAdaptiveOutput()` check (`raw.schemaId !== "procedural"` → `!LEGACY_SCHEMA_IDS.has(raw.schemaId)`). |
| Backward compatibility | Full — old `procedural`-only records still parse identically; the type is additive. |
| Migration required | None — same conclusion as Phase 1's `adaptive-persistence-design.md` §8 for the Milestone-2 envelope: optional field, absent on old docs, parser returns `"absent"`. |
| Malformed-data behavior | Unchanged — parser already fails closed (`ok:false`), never throws. |
| Schema-version evolution | Clean — `version: 1` stays meaningful across all 8 schema IDs (procedural + 7), since the *shape* isn't changing, only which `schemaId` values are legal. |
| Risk of confusing adaptive vs. legacy output | None — this is the existing, already-proven separation (`adaptiveOutput` for Milestone-2, `legacyAdaptiveOutput` for this family); Option A doesn't touch that boundary. |
| Testing complexity | Low — `legacyAdaptiveOutput.spec.ts`'s existing test shape (read in full) already parametrizes on `schemaId`; extending it to 7 more values is mechanical, not a new test architecture. |
| Future maintainability | High — one file (`persistedOutput.ts`), one gate (`orchestrate.ts`), matches the codebase's own established pattern exactly. |

### Option B — Generic versioned envelope `{schemaId, schemaVersion, result}`

A schema-agnostic envelope that doesn't enumerate `schemaId` values in the type system at all — `result` typed as `unknown` or a very loose shape, validated structurally at runtime instead.

| Dimension | Assessment |
|---|---|
| Type safety | Weaker — `result: unknown` pushes correctness entirely to runtime checks and loses compile-time exhaustiveness for renderer/adapter code. |
| Runtime validation | Must be more elaborate (a schema-keyed validator map) to recover the safety Option A gets for free from TypeScript's discriminated union. |
| Backward compatibility | Comparable to A. |
| Migration required | None, same as A. |
| Malformed-data behavior | Comparable to A if the validator map is built carefully, but more code to get there. |
| Schema-version evolution | Marginally more flexible in the abstract (a new schema needs no type-union edit) — but this codebase's actual pattern (`PersistedAdaptiveOutputV1`'s 9-member union for Milestone-2) already rejected this generality once, for the same family of reasons. Introducing a second, differently-shaped envelope model for a second family adds cognitive overhead without evidence it's needed. |
| Risk of confusing adaptive vs. legacy output | Slightly higher — a fully generic envelope invites collapsing the `adaptiveOutput`/`legacyAdaptiveOutput` distinction "since it's generic now," which would be a larger, riskier refactor than this audit is scoped for. |
| Testing complexity | Higher — needs both the generic envelope tests and per-schema structural validation tests. |
| Future maintainability | Lower than A for *this* codebase specifically, because it deviates from the sibling pattern (`PersistedAdaptiveOutputV1`) that already exists two files away, forcing readers to learn two envelope idioms instead of one. |

### Option C — Per-schema persistence handling (7 separate functions/branches)

Write 7 distinct `attachXxxLegacyEnvelope()` functions and 7 distinct persisted-output types, one per schema.

| Dimension | Assessment |
|---|---|
| Type safety | Fine in isolation, but duplicative — 7 near-identical types/functions differing only in a string literal. |
| Runtime validation | 7 near-identical parsers. |
| Backward compatibility | Comparable to A. |
| Migration required | None. |
| Malformed-data behavior | Comparable to A, more surface area to keep consistent across 7 copies. |
| Schema-version evolution | Worse — a future shape change to the shared claims-matrix output would need to be applied in 7 places instead of 1. |
| Risk of confusing adaptive vs. legacy output | Comparable to A. |
| Testing complexity | Highest of the three — 7x the boilerplate for identical logic. |
| Future maintainability | Lowest — directly contradicts the fact (established in Part 1/Part 2) that all 7 schemas share one identical computed shape; per-schema handling would be optimizing for a difference that doesn't exist in the data. |

### Recommendation

**Option A.** The 7 remaining schemas already produce byte-for-byte the same shape `procedural` does; `PersistedLegacyAdaptiveOutputV1` and its parser are proven in production for that shape. Widening a `schemaId` literal to a union, and a single `===` check to a `Set.has()` check, is the minimal change that closes the gap for all 7 at once, with no new envelope concept, no new validation architecture, and a test-writing pattern that already exists (`legacyAdaptiveOutput.spec.ts`). Options B and C were considered and rejected: B adds a second architectural idiom to the codebase without a concrete need it addresses that A doesn't; C multiplies near-identical code sevenfold for data that is provably identical in shape.

---

## Part 6 — Backward-Compatibility Audit

Old records (pre-fix) simply have `legacyAdaptiveOutput` absent, exactly as `procedural`-only records do today for the other 6 schemas — this is not a new state, it's the current state for 6/7 of these schemas already. The parser's existing `"absent"` result path handles it with no changes needed.

Documented behavior under Option A, per required-state enumeration:

| Record state | `legacyAdaptive.status` | Behavior |
|---|---|---|
| Old legacy (pre-adaptive) run | `"absent"` | Falls back to `synthesizeReport()` — unchanged, current behavior. |
| Old adaptive run, Batch 3 schema, pre-fix (no persistence attempted) | `"absent"` | Same fallback — unchanged, current behavior; this is every existing run of these 6 schemas today. |
| New Batch 3 run, post-fix | `"valid"` | `AdaptivePanelResponse` renders from the reloaded envelope — new, correct behavior. |
| Malformed `legacyAdaptiveOutput` (corrupted field, wrong types) | `"malformed"` | Parser fails closed (`ok:false`), never throws; client falls back to `synthesizeReport()` — same fail-safe pattern the existing test file (`legacyAdaptiveOutput.spec.ts`, "malformed legacyAdaptiveOutput fails safely" test) already covers for `procedural`. |
| Unsupported future schema version (e.g. `version: 2`) | `"unsupported_version"` | Parser fails closed identically — already covered by the existing test file's "fails safely as 'unsupported_version'" test. |

**No migration script required.** `legacyAdaptiveOutput?` is already optional at the Firestore-document level and at the TypeScript level (mirrors the Phase 1 `adaptiveOutput?` precedent documented in `docs/adaptive-persistence-design.md` §8). Widening the `schemaId` union does not change the shape of already-written `procedural` documents — they remain valid members of the widened union.

**Explicit constraint honored:** nothing in this recommendation infers schema identity from question text at any point. Schema identity always comes from the persisted `schemaId` field (or, for old runs, is genuinely absent — never guessed).

---

## Part 7 — Existing-Renderer Audit (7 dedicated components)

Verified names/mappings directly from `schemaRegistry.ts`'s `renderHint` values and `components/adaptive/` — the task's example names (`ScenarioTreeView`/`EvidenceTiersView`/`RuleApplicationView`) are in fact still accurate today, confirmed rather than assumed.

| Component | Schema | Can become primary view unchanged? | Needs shared-shell wrapping? | Missing conclusion/disagreement/uncertainty presentation? | Mobile risk |
|---|---|---|---|---|---|
| `ConsensusMapView` | `contested_empirical` | Yes, content-wise | Yes — no synthesized headline; would benefit from the same `PrimarySynthesisStrip`-style wrapper `procedural`/`generic` already use | Yes — no single synthesized answer above the per-model summaries/matrix | None found |
| `RuleApplicationView` | `legal_regulatory` | Yes | Yes, same reason | Yes, same reason | None found |
| `MetricsGridView` | `financial_valuation` | Yes | Yes, same reason | Yes, same reason | None — already uses `overflow-x-auto` on its comparison table |
| `EvidenceTiersView` | `medical_health` | Yes | Yes, same reason | Yes, same reason | None found |
| `ScenarioTreeView` | `forecast_speculative` | Yes | Yes, for consistency, though notably more complete already | Partially — already has explicit "Base rates" and "Key uncertainties" sections; only lacks a single synthesized headline | None found |
| `GalleryView` | `creative_generative` | Yes, and deliberately so | Wrapping should **not** add synthesis framing here (see Part 8) | N/A by design — creative output has no agreement/disagreement to present | None found |
| `DirectAnswerCard` | `factual_lookup` | Already primary (Milestone 1) | Already wrapped via its own `AdaptivePanelResponse.tsx` branch | No — already has a synthesized headline | None found |

No redesign was performed or proposed for any of these components, per the task's explicit instruction. The only structural observation worth flagging for the *implementation* task (not resolved here): `RuleApplicationView`/`EvidenceTiersView`/`MetricsGridView` already use `PerModelCardGrid` for per-model detail, which will partially overlap with any generic `ModelResponsesSection` if one is added during promotion — an open design question for 2C-2/2C-3, not a blocker for 2C-1.

---

## Part 8 — Consensus / Evidence Semantics Audit

Applying the lessons already learned this cycle (`decision_support`'s support-count wording bug, `evidence_review`'s coverage-vs-strength distinction, `bias_blindspot_audit`'s absence-of-evidence semantics) to these 7 schemas:

| Schema | Existing trusted signal(s) | Field-naming risk found? |
|---|---|---|
| `contested_empirical` | `gate`-based consensus fallback (`reportSummary.ts` lines 186-190); `ClaimMatrix`'s per-claim model agreement | None — `ClaimMatrix` presents raw per-model claim rows, doesn't synthesize an unlabeled aggregate score. |
| `legal_regulatory` | Same `gate` fallback; `ClaimMatrix` for unsettled issues | None found. |
| `financial_valuation` | Same `gate` fallback; min/max highlighting in the metrics table (a presentation choice, not a manufactured score) | None found — min/max highlighting is a direct data comparison, not an invented consensus figure. |
| `factual_lookup` | Same `gate` fallback; `DirectAnswerCard`'s `claimText` headline | None — already the subject of a prior fix this cycle (Claim Text), confirmed intact (Part 4). |
| `medical_health` | Same `gate` fallback; `ClaimMatrix` grouped by evidence tier | Worth flagging for implementation: "evidence tier" grouping is a presentation category, not a strength score — no invented number, but the implementation task should confirm the promoted view's copy doesn't imply a manufactured "evidence score." |
| `forecast_speculative` | Same `gate` fallback; per-model `ProbabilityBar`, explicit "Base rates"/"Key uncertainties" sections | None — probabilities come directly from each model's own stated estimate, not a synthesized panel score. |
| `creative_generative` | Same `gate` fallback (present but semantically thin for creative output); `synthesisReport.ts`'s per-schema narrative instruction explicitly says *"skip agreement/disagreement framing... note stylistic differences instead"* | **Important, already-solved risk**: a naive reuse of a generic consensus/synthesis strip would misleadingly imply "models agree/disagree" about creative output. Confirmed via direct read of `synthesisReport.ts` lines 55-93 that the underlying synthesis-generation prompt is **already schema-aware** and exempts `creative_generative` from that framing — so `synthesisReport.unifiedAnswer` for this schema is already generated in a stylistically-appropriate way, not a false consensus claim. This means reusing the same `PrimarySynthesisStrip`-style component for all 7 (including this one) is safe as long as it renders whatever `unifiedAnswer` already says, rather than inventing its own "X of Y models agree" framing independent of the text. |

**No new scores are proposed or needed anywhere in this audit**, per the task's explicit instruction — every signal referenced above already exists and is already computed by `orchestrate.ts`'s shared claims-matrix path or `reportSummary.ts`.

---

## Part 9 — Implementation-Batch Breakdown (proposed)

**2C-1 — Persistence foundation only.**
- Widen `PersistedLegacyAdaptiveOutputV1.schemaId` (Option A) to the 7-member union; widen `orchestrate.ts`'s gate from `schema.id === "procedural"` to a `Set` membership check; widen `parsePersistedLegacyAdaptiveOutput()`'s rejection check correspondingly.
- No renderer changes, no `AdaptivePanelResponse.tsx` changes, no `PHASE2_PILOT_SCHEMAS` changes.
- Effect: all 7 schemas' structured results now persist and reload correctly, but History still renders them via today's fallback path *until* 2C-2/2C-3 promote each schema's dedicated view — meaning this PR alone doesn't yet fix the *visible* History gap, only the underlying data availability. (An alternative framing: if `app/page.tsx`'s existing fallback condition were changed to check `legacyAdaptive.status === "valid"` rather than requiring a promoted primary view, users would see *some* improvement immediately — this is a genuinely open sequencing question for the implementation task, not resolved here, since it borders on "modify renderers," which this audit is barred from doing.)
- Smallest possible diff, matches the existing `legacyAdaptiveOutput.spec.ts` test shape almost exactly, easiest to review and roll back.

**2C-2 — First renderer-promotion subset.**
- Extend `PHASE2_PILOT_SCHEMAS` (or an equivalent, clearly-named allowlist) to include a first subset of the 7. Suggested first subset: `contested_empirical`, `legal_regulatory`, `medical_health` — the three whose views (`ConsensusMapView`, `RuleApplicationView`, `EvidenceTiersView`) share the most structural similarity (per-model card grid + `ClaimMatrix`), so the wrapping pattern can be validated once and reused three times with lower risk of surprises.
- `factual_lookup` needs no promotion work (Part 4) — it is not part of this batch, only 2C-1's persistence fix applies to it.

**2C-3 — Remaining renderer-promotion subset.**
- `financial_valuation` (`MetricsGridView`), `forecast_speculative` (`ScenarioTreeView`), `creative_generative` (`GalleryView`) — grouped last because each has at least one distinguishing characteristic worth isolating: `MetricsGridView`'s tabular layout, `ScenarioTreeView`'s already-more-complete uncertainty sections, and `creative_generative`'s explicit exemption from synthesis framing (Part 8) — each is likely to need a small, schema-specific adjustment to the shared wrapper rather than being a pure copy-paste of 2C-2's pattern.

This split was chosen over "one giant eight-schema PR" because the repository evidence does not support triviality: the persistence fix (2C-1) is genuinely uniform and trivial across all 7, but the renderer-promotion work (2C-2/2C-3) is only *mostly* uniform — `creative_generative`'s framing exemption and `ScenarioTreeView`'s already-different completeness level are concrete, evidenced reasons to keep promotion in smaller, reviewable groups rather than one PR touching all 7 dedicated views plus the persistence type in a single change.

---

## Part 10 — Test Plan (designed, not written)

**Persistence (2C-1), mirroring `legacyAdaptiveOutput.spec.ts`'s existing structure:**
- For each of the 7 schemas: `orchestrate.ts` attaches a `persistedLegacyOutput` with the correct `schemaId` (parametrized test, not 7 copies).
- `route.ts`'s write-gating fires `persistLegacyAdaptiveOutput()` for all 7, same as it already does for `procedural`.
- `parsePersistedLegacyAdaptiveOutput()` accepts all 7 valid `schemaId` values and continues to reject anything outside the (now 8-member) set.
- GET `/api/user/runs/[runId]` returns `legacyAdaptive.status: "valid"` for each of the 7 with a correctly-typed `output`, mirroring the existing "a procedural run" test case parametrized across schemas.
- Malformed / unsupported-version tests extended to cover the new schemas the same way the existing 2 tests already cover `procedural` (no new test *shapes*, just broadened parametrization).

**History parity (2C-2/2C-3, per promoted schema):**
- A persisted run of each schema reloads into `AdaptivePanelResponse` (not the `synthesizeReport()` fallback) — asserted the same way `AdaptivePhase2BRollout.spec.tsx` presumably already asserts this for `procedural`/Batch 2 schemas (file exists, referenced, not re-read in this audit's final pass — implementation task should confirm its exact pattern before reuse).
- The promoted dedicated view (`ConsensusMapView` etc.) renders identically whether reached live or via History reload — same data shape in both paths by construction (Part 2's trace), so this should reduce to "renders without throwing given the persisted shape," not a pixel-parity test.

**Backward compatibility:**
- An old run with `legacyAdaptiveOutput` absent (i.e., every existing Batch-3-schema run today) still falls back correctly — a regression test, since 2C-1 changes the gate condition and must not break the existing `procedural`-only behavior in the process.
- Malformed and unsupported-version records fail closed, not open, for the new schemas — same as `procedural`'s existing coverage.

**`factual_lookup`-specific:**
- `DirectAnswerCard` renders correctly from a *reloaded* (not live) persisted envelope — new coverage, since today only the live path is exercised for this schema.
- The real answer (not a placeholder) is used as claim text on reload — regression-pins the "Claim Text fix" (Part 4) against reload specifically, not just live rendering, since this audit found no evidence the fix was ever tested against the reload path before (it couldn't have been — the envelope never persisted).
- No regression back to generic `"Answer"` or `"Jurisdiction"` labels — an explicit negative assertion, matching the existing codebase convention of pinning against a specific bad string (as seen in `PanelEvidenceSection.spec.tsx`'s `not.toMatch(/disagreement map/i)` pattern from Phase 2A).

---

## Part 11 — Protected-System Confirmation

Confirmed via the code read for this audit: the recommended architecture (Option A, Part 5) touches only `lib/adaptiveSchema/persistedOutput.ts`, `lib/adaptiveSchema/orchestrate.ts`, and (for 2C-2/2C-3) `components/adaptive/AdaptivePanelResponse.tsx`'s promotion allowlist. None of the following require any change:

- `lib/verification/` — claim verification pipeline, untouched; this audit's entire scope is the Deep Research / adaptive panel path.
- `app/api/verify-claim/` — untouched, same reason.
- `lib/video/`, `app/api/verify-video/` — untouched, same reason.
- Classifier taxonomy — `planAdaptiveRun()`/classification logic is not touched; Option A only changes what happens *after* a schema is already classified and its result already computed.
- Verification Gate rules — not part of this pipeline.
- Governance canonical state — `GovernanceRecordV1` remains Milestone-2-only, unaffected; the `legacyAdaptiveOutput` envelope has never carried governance data and this audit does not propose adding any.
- Adaptive scoring logic — the claims-matrix computation (`alignedClaims`/`gate`/`synthesisReport`/`trustSummary`) is read, not modified, by the recommended fix; Option A only changes *whether the already-computed result gets packaged for persistence*, never *how it's computed*.

**No architectural blocker was found.** The recommended path does not require changing any protected system.

---

## Risks

- **Sequencing risk (flagged in Part 9):** 2C-1 alone closes the persistence gap but may not visibly close the History-rendering gap until 2C-2/2C-3 also land, depending on how `app/page.tsx`'s fallback condition is ultimately written. This is a genuine open question the implementation task must resolve — this audit intentionally does not resolve it, since doing so would mean modifying renderer/client logic, which is out of scope here.
- **`PerModelCardGrid` overlap (flagged in Part 7):** if a generic `ModelResponsesSection` is introduced during promotion (following the `procedural`/`generic` precedent), it may duplicate content three of the six views already show via `PerModelCardGrid`. Worth an explicit decision in 2C-2, not assumed either way here.
- **`creative_generative` framing (flagged in Part 8):** low risk, already mitigated by existing schema-aware synthesis-prompt logic, but the implementation task should still verify the promoted wrapper renders `unifiedAnswer` as-is rather than adding its own generic consensus copy on top.
- **Test-file assumptions:** `AdaptivePhase2BRollout.spec.tsx` was referenced by name (from prior session work) as likely containing a reusable History-parity test pattern but was not re-read in this final audit pass to confirm its exact shape — the implementation task should confirm before reuse rather than assuming this audit's description is exact.

## Explicit Non-Goals (confirmed unchanged by this audit)

- Batch 3 is not implemented by this document.
- No persistence code was modified.
- No renderer code was modified.
- No migrations were created.
- No classifier behavior was changed.
- Adaptive Research Export was not begun.
