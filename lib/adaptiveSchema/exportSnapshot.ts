/**
 * Adaptive Research Export, Phase 1 — freezes the current, live report
 * state into an `AdaptiveExportReportSnapshot` (researchExport.ts). Reads
 * ONLY already-computed signals (never re-runs alignment/scoring/a model
 * call), reusing the exact same functions TopSummaryBar.tsx calls
 * (`deriveConsensusLevel`/`deriveSourceGrounding`/`getReportTypeLabel`) so
 * an export can never disagree with what the live UI showed.
 *
 * Schema-family-aware throughout (see researchExport.ts's header comment
 * for why): a Milestone-2 run and a legacy-active run each produce exactly
 * one of `reportSnapshot.milestone2` / `reportSnapshot.legacy` — never
 * both, never a forced unification.
 *
 * "server-only": reads `PersistedAdaptiveOutputV1`/`PersistedLegacyAdaptiveOutputV1`
 * shapes already parsed by the caller (the export API route) — this module
 * does no Firestore I/O itself, matching the design doc's "read live
 * records ONCE, at generation time" (§1) — the caller reads once, this
 * module only transforms.
 */

import "server-only";
import { buildAdaptiveDecisionReceipt } from "./decisionReceiptBuilder";
import { GovernanceRecordV1 } from "./governanceRecord";
import { deriveReportStatus, ReportStatusKind } from "./reportStatus";
import { ConsensusInput, deriveConsensusLevel, deriveSourceGrounding, getReportTypeLabel, SourceGroundingInput } from "./reportSummary";
import { PersistedAdaptiveOutputV1, PersistedLegacyAdaptiveOutputV1 } from "./persistedOutput";
import {
  AdaptiveExportClassification,
  AdaptiveExportGovernanceStatus,
  AdaptiveExportModelSummary,
  AdaptiveExportReportSnapshot,
  classificationFloorFromRiskLevel,
} from "./researchExport";
import { ModelId } from "../types";

function assertNeverSchemaId(schemaId: never): never {
  throw new Error(`Unhandled Milestone-2 schemaId in exportSnapshot: ${String(schemaId)}`);
}

/**
 * Maps a Milestone-2 discriminated union to the schema-specific field
 * `deriveConsensusLevel`/`deriveSourceGrounding` expect — mirrors
 * TopSummaryBar.tsx's own prop-passing exactly, one case per schema, so a
 * 10th Milestone-2 schema fails `tsc --noEmit` here too (same
 * exhaustiveness discipline as decisionReceiptBuilder.ts's own switch).
 */
function milestone2ConsensusInput(output: PersistedAdaptiveOutputV1): ConsensusInput {
  const schemaId = output.schemaId;
  switch (schemaId) {
    case "ranked_enumeration":
      return { schemaId, rankedEnumeration: output.result };
    case "comparison_matrix":
      return { schemaId, comparisonMatrix: output.result };
    case "definition_explanation":
      return { schemaId, definitionExplanation: output.result };
    case "causal_explanation":
      return { schemaId, causalExplanation: output.result };
    case "checklist_taxonomy":
      return { schemaId, checklistTaxonomy: output.result };
    case "deep_research":
      return { schemaId, deepResearch: output.result };
    case "evidence_review":
      return { schemaId, evidenceReview: output.result };
    case "bias_blindspot_audit":
      return { schemaId, biasBlindspotAudit: output.result };
    case "decision_support":
      return { schemaId, decisionSupport: output.result };
    default:
      return assertNeverSchemaId(schemaId);
  }
}

export interface BuildExportSnapshotInput {
  question: string;
  selectedModels: ModelId[];
  /** Per-model ok/fail, when available (always for legacy; only on a fresh live run for Milestone-2 — absent on a History-reloaded Milestone-2 envelope, whose `results` field is intentionally empty). */
  modelResultsOkByModelId?: Partial<Record<ModelId, boolean>>;

  milestone2?: {
    output: PersistedAdaptiveOutputV1;
    /** Present only when a GovernanceRecordV1 already exists for this run — absent is a legitimate, common state (e.g. governance not yet initialized), never treated as an error. */
    governanceRecord?: GovernanceRecordV1;
    /** From the caller's own reviewRouting resolution (same signal reportStatus.ts's live/reload callers already compute) — "unknown" degrades safely, matching deriveReportStatus's own contract. */
    reviewRouting?: "in_queue" | "not_configured" | "unknown";
  };

  legacy?: {
    output: PersistedLegacyAdaptiveOutputV1;
    /** The real 3-value model this family actually has (`data.governanceStatus` on the run document) — `null` when never evaluated. */
    governanceStatus: "approved" | "needs_review" | "blocked" | null;
  };
}

export interface BuiltExportSnapshot {
  reportSnapshot: AdaptiveExportReportSnapshot;
  governanceStatusAtExport: AdaptiveExportGovernanceStatus;
  classification: AdaptiveExportClassification;
}

/** Never throws — a snapshot must always be buildable from any validly-parsed persisted output, even a minimal one. */
export function buildExportSnapshot(input: BuildExportSnapshotInput): BuiltExportSnapshot {
  const models: AdaptiveExportModelSummary[] = input.selectedModels.map((modelId) => ({
    modelId,
    ok: input.modelResultsOkByModelId?.[modelId],
  }));

  if (input.milestone2) {
    const { output, governanceRecord, reviewRouting } = input.milestone2;

    const consensusLevel = deriveConsensusLevel(milestone2ConsensusInput(output));
    const sourceGroundingInput: SourceGroundingInput = { meta: output.meta };
    const sourceGroundingLevel = deriveSourceGrounding(sourceGroundingInput);
    const reportTypeLabel = getReportTypeLabel(
      output.schemaId,
      output.schemaId === "checklist_taxonomy" ? (output.result as any) : undefined
    );

    const decisionReceipt = governanceRecord ? buildAdaptiveDecisionReceipt(output) : undefined;

    const reportStatus = deriveReportStatus({
      humanReview: governanceRecord
        ? {
            status: governanceRecord.humanReview.status,
            conditions: governanceRecord.humanReview.conditions,
            decidedVia: governanceRecord.humanReview.decidedVia,
          }
        : null,
      reviewRouting,
      persistenceStatus: "saved",
    });

    const governanceStatusAtExport: AdaptiveExportGovernanceStatus = {
      family: "milestone2",
      kind: reportStatus.kind,
      isOwnerOverride: reportStatus.isOwnerOverride,
      conditions: reportStatus.conditions,
    };

    const classification = classificationFloorFromRiskLevel(output.classification.riskLevel);

    const reportSnapshot: AdaptiveExportReportSnapshot = {
      question: input.question,
      models,
      reportTypeLabel,
      consensusLevel,
      sourceGroundingLevel,
      reportGeneratedAt: output.generatedAt,
      milestone2: {
        schemaId: output.schemaId,
        result: output.result,
        meta: output.meta,
        decisionReceipt,
      },
    };

    return { reportSnapshot, governanceStatusAtExport, classification };
  }

  if (input.legacy) {
    const { output, governanceStatus } = input.legacy;

    const consensusLevel = deriveConsensusLevel({ schemaId: output.schemaId, gate: output.gate });
    const sourceGroundingLevel = deriveSourceGrounding({ trustSummary: output.trustSummary });
    const reportTypeLabel = getReportTypeLabel(output.schemaId);

    const governanceStatusAtExport: AdaptiveExportGovernanceStatus = {
      family: "legacy",
      status: governanceStatus,
    };

    const classification = classificationFloorFromRiskLevel(output.classification.riskLevel);

    const reportSnapshot: AdaptiveExportReportSnapshot = {
      question: input.question,
      models,
      reportTypeLabel,
      consensusLevel,
      sourceGroundingLevel,
      reportGeneratedAt: output.generatedAt,
      legacy: {
        schemaId: output.schemaId,
        alignedClaims: output.alignedClaims,
        gate: output.gate,
        synthesisReport: output.synthesisReport,
        trustSummary: output.trustSummary,
        modelResponses: output.results,
      },
    };

    return { reportSnapshot, governanceStatusAtExport, classification };
  }

  throw new Error("buildExportSnapshot: neither milestone2 nor legacy input was provided.");
}
