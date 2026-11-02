"use client";

/**
 * D-2 / D-3 (shared Adaptive Schema architecture, 2026-11-02): one plain, system-authored notice at the top of every
 * adaptive report, stating exactly which automated steps did not run for THIS run. It reads only the run's own recorded
 * fields; it never infers and never fabricates.
 *
 *   - `classification.fallbackReason` is a failure (connector_error / timeout / malformed_json / schema_invalid) with
 *     no heuristic: a general format was used. `low_confidence` and `empty_query` are model or input verdicts, not
 *     failures, so they are not announced.
 *   - `synthesisReport.degraded === true`: the written synthesis could not be generated. The summary shown is
 *     assembled directly from the panel's scored claims (synthesisReport.ts), so it is labelled as such.
 *
 * Renders nothing when everything ran.
 */

import type { AdaptiveSynthesisReport, QueryClassification } from "@/lib/adaptiveSchema/types";

const CLASSIFIER_FAILURES = new Set(["connector_error", "timeout", "malformed_json", "schema_invalid"]);

/** The fixed, system-authored lines (exported so tests pin the real copy). */
export const ANALYSIS_NOTICE_LINES = {
  generalFormat: "Automatic question classification was unavailable, so a general report format is used.",
  degraded: "The written synthesis could not be generated for this run. The summary is assembled directly from the panel's scored claims.",
  sensitive: "This question may involve health, legal or financial matters. The responses are general information, not professional advice.",
} as const;

export function analysisAvailabilityLines(classification: QueryClassification | undefined | null, synthesisReport: AdaptiveSynthesisReport | undefined | null): string[] {
  const lines: string[] = [];
  // Generic-only fallback (owner final ruling): any classifier failure means the general format.
  if (classification?.fallbackReason && CLASSIFIER_FAILURES.has(classification.fallbackReason)) {
    lines.push(ANALYSIS_NOTICE_LINES.generalFormat);
    // The independent risk check fired: add the caution, since no specialised format adds its own.
    if (classification.heuristicRule === "sensitive_topic") lines.push(ANALYSIS_NOTICE_LINES.sensitive);
  }
  if (synthesisReport?.degraded === true) {
    lines.push(ANALYSIS_NOTICE_LINES.degraded);
  }
  return lines;
}

export default function AnalysisAvailabilityNotice({ classification, synthesisReport }: { classification?: QueryClassification | null; synthesisReport?: AdaptiveSynthesisReport | null }) {
  const lines = analysisAvailabilityLines(classification, synthesisReport);
  if (lines.length === 0) return null;
  return (
    <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status" data-testid="analysis-availability-notice">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}
