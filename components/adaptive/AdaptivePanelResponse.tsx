"use client";

/**
 * Adaptive Panel Response — three-tab shell (R4).
 *
 * Restores List / Compare / Synthesis Report for adaptive runs, but ONLY
 * when the server computed gate + synthesisReport (ADAPTIVE_VERIFICATION_ENABLED
 * was on for this run). When it's off, this renders exactly the pre-restoration
 * bare AdaptiveResultsView — no behavior change for anyone not opted into the
 * verification engine yet.
 *
 * Compare View is additive: schemas whose renderer already embeds a
 * ClaimMatrix (consensus_map/rule_application/evidence_tiers/generic_sections)
 * are left as-is — the SAME scored `alignedClaims` prop now flows through to
 * that existing matrix. Schemas whose renderer has no claims matrix at all
 * (metrics_grid/verdict_card/step_diff/scenario_tree — their comparable
 * content is metrics/answer/steps/scenarios, not claim[] fields) get the
 * merged matrix rendered as an ADDITIONAL block below, since otherwise their
 * cross-model agreement scoring (R2's tolerance-band/probability-band/
 * order-sensitive comparators) would have no visible surface at all.
 */

import { AnswerShape } from "@/lib/adaptiveSchema/types";
import { AdaptiveGateResult, AdaptiveSynthesisReport, AdaptiveTrustSummary } from "@/lib/adaptiveSchema/types";
import { AdaptiveRendererProps } from "./types";
import AdaptiveResultsView from "./AdaptiveResultsView";
import AdaptiveSynthesisReportView from "./AdaptiveSynthesisReportView";
import ClaimMatrix from "./ClaimMatrix";
import { Card, SectionLabel } from "./shared";
import PanelViewTabs, { PanelViewMode } from "./PanelViewTabs";
import { useState } from "react";

const GATE_CHIP_STYLES: Record<AdaptiveGateResult["status"], string> = {
  pass: "bg-green-50 text-green-700 border-green-200",
  caution: "bg-amber-50 text-amber-700 border-amber-200",
  fail: "bg-red-50 text-red-700 border-red-200",
};

const RENDER_HINTS_WITHOUT_MATRIX = new Set<AnswerShape>(["metrics_grid", "verdict_card", "step_diff", "scenario_tree"]);

export interface AdaptivePanelResponseProps extends AdaptiveRendererProps {
  gate?: AdaptiveGateResult;
  synthesisReport?: AdaptiveSynthesisReport;
  trustSummary?: AdaptiveTrustSummary;
  question: string;
  runId?: string | null;
}

export default function AdaptivePanelResponse(props: AdaptivePanelResponseProps) {
  const { schema, results, alignedClaims, gate, synthesisReport, trustSummary, question, runId } = props;
  const [viewMode, setViewMode] = useState<PanelViewMode>("list");

  if (!gate || !synthesisReport) {
    return <AdaptiveResultsView {...props} />;
  }

  const modelIds = results.map((r) => r.modelId);
  const okCount = results.filter((r) => r.ok).length;
  const showExtraMatrix = RENDER_HINTS_WITHOUT_MATRIX.has(schema.renderHint) && !!alignedClaims && alignedClaims.length > 0;

  return (
    <div className="space-y-4">
      <PanelViewTabs viewMode={viewMode} onChange={setViewMode} />

      {viewMode === "list" && (
        <Card className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-600">
              {schema.id.replace(/_/g, " ")}
            </span>
            <span className="text-sm text-slate-700">
              {okCount}/{results.length} models responded
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">Answer certainty {Math.round(synthesisReport.runCertainty * 100)}%</span>
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${GATE_CHIP_STYLES[gate.status]}`}
            >
              {gate.status}
            </span>
          </div>
        </Card>
      )}

      {viewMode === "compare" && (
        <div className="space-y-4">
          <AdaptiveResultsView {...props} />
          {showExtraMatrix && (
            <Card>
              <SectionLabel>Cross-model comparison</SectionLabel>
              <ClaimMatrix claims={alignedClaims!} modelIds={modelIds} />
            </Card>
          )}
        </div>
      )}

      {viewMode === "synthesis" && (
        <AdaptiveSynthesisReportView
          report={synthesisReport}
          gate={gate}
          alignedClaims={alignedClaims}
          trustSummary={trustSummary}
          question={question}
          modelsUsed={modelIds}
          runId={runId}
        />
      )}
    </div>
  );
}
