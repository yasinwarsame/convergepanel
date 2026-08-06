"use client";

/**
 * Adaptive Synthesis Report, Phase 2 (3-schema pilot) — a compact,
 * answer-first strip rendered immediately after TopSummaryBar and before
 * the schema's own primary view (StepDiffView/GenericSectionsView), for the
 * 2 original-9 pilot schemas (procedural/generic). Their existing primary
 * views show per-model raw content but never a synthesized answer or a
 * cross-model agreement/disagreement summary — this closes that gap using
 * ONLY already-computed data (synthesisReport.unifiedAnswer, verdictCard's
 * topConsensus/keyDisagreement/caveat — the same fields PanelVerdictCard
 * already renders, just surfaced here as the headline instead of buried in
 * a collapsed section).
 *
 * comparison_matrix needs no equivalent: ComparisonMatrixView already leads
 * with directConclusion and shows split (disagreement) cells inline in the
 * grid itself.
 *
 * Deliberately does NOT duplicate PanelEvidenceSection's full disagreement
 * list or DisagreementsSection's per-model quoted positions — only the
 * single TOP consensus/disagreement point, matching the acceptance
 * criterion that a user can answer "what do models agree/disagree on"
 * without expanding anything, while the full record stays in Panel
 * Evidence.
 */

import { AdaptiveSynthesisReport } from "@/lib/adaptiveSchema/types";
import { Card, SectionLabel } from "./shared";

export default function PrimarySynthesisStrip({ synthesisReport }: { synthesisReport: AdaptiveSynthesisReport }) {
  const { unifiedAnswer, verdictCard } = synthesisReport;

  return (
    <Card className="bg-sky-50/60 border-sky-200">
      <SectionLabel>Answer</SectionLabel>
      <p className="text-sm leading-relaxed text-slate-900 whitespace-pre-line">{unifiedAnswer}</p>

      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-sky-200 pt-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Models agree</p>
          <p className="mt-0.5 text-sm text-slate-800">
            {verdictCard.topConsensus}
            {verdictCard.consensusModelCount > 0 && (
              <span className="text-slate-500"> — {verdictCard.consensusModelCount} model{verdictCard.consensusModelCount === 1 ? "" : "s"}</span>
            )}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Models disagree</p>
          {verdictCard.keyDisagreement ? (
            <p className="mt-0.5 text-sm text-slate-800">
              {verdictCard.keyDisagreement}
              {verdictCard.disagreementDetail && <span className="block text-xs text-slate-500 mt-0.5">{verdictCard.disagreementDetail}</span>}
            </p>
          ) : (
            <p className="mt-0.5 text-sm text-slate-500 italic">No major disagreements detected.</p>
          )}
        </div>
      </div>

      {verdictCard.caveat && (
        <p className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">{verdictCard.caveat}</p>
      )}
    </Card>
  );
}
