/**
 * Adaptive Research Export, Phase 1 — the immutable export artifact
 * contract (`AdaptiveResearchExportV1`), per docs/adaptive-research-export-design.md
 * §6, adapted to two facts confirmed by a fresh code audit on 2026-08-09
 * (after that document was last edited on 2026-08-05, and after Batch 3
 * persistence foundation / Phase 2C-3 shipped):
 *
 * 1. `AdaptiveDecisionReceipt` (the design doc's proposed universal "final
 *    report" content) is structurally Milestone-2-only —
 *    `buildAdaptiveDecisionReceipt()` takes a `PersistedAdaptiveOutputV1`
 *    argument, a type that can never be one of the 8 legacy-active schemas
 *    (`PersistedLegacyAdaptiveOutputV1` is a wholly separate, disjoint
 *    type). There is no decision receipt for financial_valuation,
 *    forecast_speculative, creative_generative, legal_regulatory,
 *    medical_health, contested_empirical, procedural, or factual_lookup.
 * 2. `GovernanceRecordV1`'s rich 8-status `humanReview.status` model is
 *    ALSO Milestone-2-only (`app/api/user/runs/[runId]/route.ts` only ever
 *    calls `parseGovernanceRecord()` when `parsedAdaptive.ok`, i.e. only
 *    for a valid Milestone-2 envelope). The legacy-active family instead
 *    has the older, separate, 3-value `governanceStatus: "approved" |
 *    "needs_review" | "blocked"` field (`evaluateGovernance.ts` / "System
 *    A" per governanceRecord.ts's own header comment) — never the rich
 *    approved/approved_with_conditions/changes_requested/rejected model.
 *
 * Resolution (confirmed with the user before implementation): this
 * contract is schema-family-aware rather than decisionReceipt-only —
 * `reportSnapshot` has a `milestone2` branch (decisionReceipt-based, when
 * available) and a `legacy` branch (alignedClaims/gate/synthesisReport-
 * based), mirroring the exact dual-branch pattern already established
 * client-side in AdaptivePanelResponse.tsx/PanelEvidenceSection.tsx/
 * ReviewGovernanceSection.tsx throughout the Adaptive Synthesis Report
 * work. `governanceStatusAtExport` is honestly family-typed too — it never
 * force-fits the 8-status model onto a schema that never computed it, and
 * never silently reports "Incomplete" for a legacy run that has real
 * (3-status) review activity just because the 8-status field doesn't
 * exist for it.
 *
 * Storage decision (confirmed with the user before implementation): no
 * object storage of any kind exists anywhere in this codebase today (no
 * signed URLs, no @vercel/blob, no AWS/GCS SDKs; the one existing binary-
 * upload feature, video verification, explicitly avoids persisting file
 * blobs). Phase 1 does not introduce one. `reportSnapshot` — a deep,
 * frozen, versioned copy of the report state — is the durable artifact,
 * persisted in Firestore at `runs/{runId}/exports/{exportId}`. The PDF
 * itself is a deterministic, pure function of that snapshot and is
 * generated on demand (at export time, and again on every subsequent
 * download) — never written to a byte store. This is why the pipeline
 * must stay deterministic and pure (Part 11): the snapshot IS the
 * immutable source of truth; the PDF is always reproducible from it.
 */

import { AdaptiveDecisionReceipt } from "./governanceRecord";
import { ReportStatusKind } from "./reportStatus";
import { ConsensusLevel, SourceGroundingLevel } from "./reportSummary";
import {
  AdaptiveGateResult,
  AdaptiveModelResult,
  AdaptiveSynthesisReport,
  AdaptiveTrustSummary,
  AlignedClaim,
  CommonResponseMeta,
} from "./types";
import { PersistedAdaptiveSchemaId, PersistedLegacyAdaptiveSchemaId } from "./persistedOutput";
import { ModelId } from "../types";

/**
 * Phase 1 shipped PDF only. Phase 3 added DOCX, Phase 4 adds JSON — both
 * additively. Existing PDF/DOCX records are untouched by this widening
 * (their `format` field was already `"pdf"`/`"docx"`, still is, still
 * deserializes the same way). Reject any other value at the API boundary.
 */
export type AdaptiveExportFormat = "pdf" | "docx" | "json";

/** The one place MIME type/file extension per format lives — both the creation and regeneration routes call this rather than each hardcoding their own copy. */
export function adaptiveExportContentType(format: AdaptiveExportFormat): string {
  switch (format) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "json":
      return "application/json; charset=utf-8";
    default: {
      const unsupported: never = format;
      throw new Error(`Unsupported AdaptiveResearchExport format: ${String(unsupported)}`);
    }
  }
}

export function adaptiveExportFileExtension(format: AdaptiveExportFormat): string {
  switch (format) {
    case "pdf":
      return "pdf";
    case "docx":
      return "docx";
    case "json":
      return "json";
    default: {
      const unsupported: never = format;
      throw new Error(`Unsupported AdaptiveResearchExport format: ${String(unsupported)}`);
    }
  }
}

/**
 * Artifact lifecycle — deliberately separate from governance status (Part
 * 3). "superseded" does not mean invalid; it means a newer export exists
 * for this run and this one is no longer the current snapshot.
 *
 * Precise Phase 1 guarantee (no object storage exists — see this file's
 * header comment): "ready" means the frozen `reportSnapshot`/metadata
 * record was durably persisted AND a PDF was successfully generated from
 * it at that moment and streamed to the requester. It does NOT mean a PDF
 * binary is sitting in durable storage available for a later download —
 * there is no such storage, and no retrieval-by-export-ID endpoint exists
 * in Phase 1. "Historically retrievable" for a superseded/ready record
 * means its `reportSnapshot` JSON stays readable and unmutated
 * (`getAdaptiveExportRecord`) — re-generating a PDF FROM that snapshot
 * would require a dedicated render-from-snapshot endpoint, which Phase 1
 * does not build. Do not let future code/UI/docs imply otherwise.
 */
export type AdaptiveExportArtifactStatus = "generating" | "ready" | "failed" | "superseded";

/**
 * Data classification, anchored to `QueryClassification.riskLevel` (an
 * already-computed, already-used signal — no new taxonomy), per design doc
 * §5.3. The computed tier is a floor an admin may raise, never lower —
 * Phase 1 does not build the raise-UI, only the floor computation
 * (`classificationFloorFromRiskLevel` below).
 */
export type AdaptiveExportClassification = "public" | "internal" | "confidential" | "restricted";

/**
 * Governance status as frozen at export generation time — family-typed,
 * never force-unified, per this file's header comment.
 */
export type AdaptiveExportGovernanceStatus =
  | {
      family: "milestone2";
      kind: ReportStatusKind | "superseded";
      isOwnerOverride: boolean;
      /** Verbatim, per Constraint #2's "must be unmistakable" — never summarized. Present only when kind === "approved_with_conditions". */
      conditions?: string[];
    }
  | {
      family: "legacy";
      /** The real 3-value model this schema family actually has — `null` when no evaluation has run yet (never coerced to a Milestone-2 label). */
      status: "approved" | "needs_review" | "blocked" | null;
    };

/**
 * One frozen per-model attribution line — model identity/count only, never
 * raw response content in the default export. `ok` is undefined when the
 * source data doesn't carry a per-model success signal at snapshot time
 * (e.g. a Milestone-2 schema reloaded from History, whose envelope
 * intentionally stores `results: []` — see reportSummary.ts's own doc) —
 * never fabricated as `true`.
 */
export interface AdaptiveExportModelSummary {
  modelId: ModelId;
  ok?: boolean;
}

/**
 * The frozen report content. Exactly one of `milestone2`/`legacy` is
 * populated, matching which persisted-output family the source run
 * actually has — never both, never neither (a run is one schema, one
 * family, always).
 */
export interface AdaptiveExportReportSnapshot {
  question: string;
  models: AdaptiveExportModelSummary[];
  reportTypeLabel: string;
  consensusLevel: ConsensusLevel;
  sourceGroundingLevel: SourceGroundingLevel;
  reportGeneratedAt: string;

  milestone2?: {
    schemaId: PersistedAdaptiveSchemaId;
    /** The schema's own aggregated result object — kept as the real per-schema type at the composer/PDF layer; stored here as unknown since this file must stay schema-shape-agnostic (mirrors PersistedAdaptiveOutputV1's own discriminated-union discipline without re-importing all 9 result types just for a type alias). */
    result: unknown;
    meta: CommonResponseMeta;
    /** Absent when no GovernanceRecordV1 exists yet for this run (e.g. governance was never initialized) — never fabricated. */
    decisionReceipt?: AdaptiveDecisionReceipt;
  };

  legacy?: {
    schemaId: PersistedLegacyAdaptiveSchemaId;
    alignedClaims: AlignedClaim[];
    gate?: AdaptiveGateResult;
    synthesisReport?: AdaptiveSynthesisReport;
    trustSummary?: AdaptiveTrustSummary;
    /**
     * Included in the DEFAULT export for this family — NOT the same
     * privacy concern as Milestone-2's excluded-by-default raw output.
     * The legacy family has no separate aggregated "result" object the
     * way Milestone-2 does (`synthesisReport.unifiedAnswer` is a thin
     * narrative summary, not a structured aggregate) — each model's own
     * schema-validated fields (thesis/metrics/bullCase for
     * financial_valuation, applicableRule/jurisdiction for
     * legal_regulatory, etc.) ARE this family's primary analytical
     * content, confirmed necessary by this phase's own required PDF
     * examples (financial_valuation "metrics/ranges + assumptions +
     * sensitivity", legal_regulatory "jurisdiction + rule + application").
     * These are schema-registry-validated structured fields, not verbatim
     * unstructured model prose — a materially different privacy posture
     * than the design doc's `export_raw_model_outputs` gate, which this
     * field is deliberately NOT gated behind in Phase 1.
     */
    modelResponses?: AdaptiveModelResult[];
  };
}

/** Compact, content-free provenance record — never full report content, never private comments, never secrets. */
export interface AdaptiveExportManifest {
  exportId: string;
  runId: string;
  schemaVersion: 1;
  /** Section labels only — e.g. ["reportSnapshot", "governanceStatus"] — never content. */
  exportedSections: string[];
  /** sha256 of the generated PDF bytes at generation time — kept for integrity/provenance even though the bytes themselves are never persisted (Phase 1 storage decision above). */
  fileHash?: string;
  createdAt: string;
  requestingUser: string;
  finalReportVersion: number;
}

/**
 * The export artifact itself. `version` is this CONTRACT's own version —
 * the shape of this TypeScript interface and its persisted JSON — never
 * to be confused with the file `format` (pdf/docx/json) it renders to,
 * with `reportVersion` (a monotonic per-run counter powering "Superseded",
 * incremented once per export generation), or with the frozen
 * `schemaVersion` inside `reportSnapshot`'s source data
 * (`PersistedAdaptiveOutputV1.version` / `PersistedLegacyAdaptiveOutputV1.version`
 * at capture time) — four genuinely different, independent concepts, never
 * conflated (Part 4). Adding a new `format` value (DOCX in Phase 3, JSON in
 * Phase 4) never bumps `version`: the same `AdaptiveResearchExportV1` shape
 * simply renders through one more format-specific renderer, chosen by
 * `format`, all still operating on the exact same `reportSnapshot`.
 */
export interface AdaptiveResearchExportV1 {
  version: 1;
  exportId: string;
  runId: string;

  schemaId: PersistedAdaptiveSchemaId | PersistedLegacyAdaptiveSchemaId;
  schemaFamily: "milestone2" | "legacy";
  /** = the source envelope's own `version` field at capture time (currently always 1 for both families). */
  schemaVersion: 1;
  /** Monotonic per-runId counter, incremented each time an export is generated for this run — the basis for "Superseded" (a later export for the same run has a higher reportVersion). */
  reportVersion: number;

  createdAt: string;
  createdBy: string;

  format: AdaptiveExportFormat;
  artifactStatus: AdaptiveExportArtifactStatus;

  classification: AdaptiveExportClassification;
  governanceStatusAtExport: AdaptiveExportGovernanceStatus;

  reportSnapshot: AdaptiveExportReportSnapshot;
  exportMetadata: AdaptiveExportManifest;

  /** Populated only when artifactStatus === "failed". */
  failureReason?: string;
}

/**
 * Design doc §5.3's floor mapping — an admin may raise, Phase 1 does not
 * build that UI, only the floor. `casual` defaults to Internal (not
 * Public) since the design doc is explicit Public "still requires explicit
 * user action to mark Public — never defaults there."
 */
export function classificationFloorFromRiskLevel(
  riskLevel: "casual" | "professional" | "high_stakes" | "safety_critical"
): AdaptiveExportClassification {
  switch (riskLevel) {
    case "casual":
      return "internal";
    case "professional":
      return "internal";
    case "high_stakes":
      return "confidential";
    case "safety_critical":
      return "restricted";
    default:
      return "internal";
  }
}
