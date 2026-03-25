/**
 * Claim verification pipeline: parsing, scoring, audit bundles, and prompts.
 */

import type { ModelVerdict } from "./parseVerificationJson";

export type ClaimVerdict = "confirmed" | "disputed" | "partially_true" | "unverifiable";

/**
 * Rows used for aggregation: only `status === "ok"` (valid parsed JSON verdict) count as usable.
 */
export type ModelVerificationResult = {
  status: "ok" | "parse_error" | "failed";
  verdict?: ModelVerdict;
};

export function computeClaimVerdict(modelResults: ModelVerificationResult[]): ClaimVerdict {
  const usableResults = modelResults.filter((r) => r.status === "ok");
  const totalUsable = usableResults.length;

  if (totalUsable === 0) return "unverifiable";

  const accurateCount = usableResults.filter((r) => r.verdict === "accurate").length;
  const inaccurateCount = usableResults.filter((r) => r.verdict === "inaccurate").length;
  const partialCount = usableResults.filter((r) => r.verdict === "partially_accurate").length;
  const unverifiableCount = usableResults.filter((r) => r.verdict === "unverifiable").length;

  if (accurateCount / totalUsable >= 0.8) return "confirmed";

  if (
    accurateCount > 0 &&
    inaccurateCount > 0 &&
    Math.abs(accurateCount - inaccurateCount) <= 1
  ) {
    return "disputed";
  }

  if (
    partialCount >= totalUsable * 0.4 ||
    (accurateCount + partialCount) / totalUsable >= 0.6
  ) {
    return "partially_true";
  }

  if (unverifiableCount / totalUsable >= 0.5) return "unverifiable";

  return "disputed";
}
