/**
 * Step 6.3 — pure presentation + reconciliation for the Workspace governance
 * summary. Client-safe; no network.
 *
 * `reconcileGovernanceSummary` re-derives every contract identity from the
 * response itself. The UI renders a summary only when it reconciles, so a
 * number that cannot be decomposed back to its rows is never shown.
 *
 * No score, tier, percentage of "quality" or ranking is computed here. The only
 * cross-family arithmetic is the contract-permitted sum of counts that share an
 * approved normalized-outcome bucket (`rollupAutomatedOutcomes`), always shown
 * with its exact denominator and per-family breakdown.
 */
import type { Family, GovernanceSummaryRow, NormalizedOutcome, WorkspaceGovernanceSummary } from "./workspaceGovernanceSummary";

export const FAMILY_LABELS: Record<Family, string> = {
  research: "Research",
  research_adaptive: "Structured research",
  claim_verification: "Claim verification",
  video_verification: "Video verification",
};

export const OUTCOME_LABELS: Record<NormalizedOutcome, string> = {
  cleared: "Cleared by automated check",
  needs_attention: "Needs attention",
  blocked: "Blocked",
  not_evaluated: "Not evaluated",
  error: "Evaluation error",
  not_recorded: "Not recorded",
  unmapped: "Unrecognized status",
};

export const SUB_REASON_LABELS: Record<NonNullable<GovernanceSummaryRow["subReason"]>, string> = {
  superseded_by_human_decision: "replaced by a human decision",
  missing: "no automated outcome stored",
};

export const HUMAN_DECISION_LABELS: Record<string, string> = {
  unreviewed: "Unreviewed",
  pending: "Pending review",
  approved: "Approved",
  approved_with_conditions: "Approved with conditions",
  changes_requested: "Changes requested",
  rejected: "Rejected",
  blocked: "Blocked",
  __other_recorded__: "Unrecognized status",
};

export const OUTCOME_ORDER: NormalizedOutcome[] = ["cleared", "needs_attention", "blocked", "not_evaluated", "error", "not_recorded", "unmapped"];
export const FAMILY_ORDER: Family[] = ["research", "research_adaptive", "claim_verification", "video_verification"];

/** Every contract identity, re-derived from the response. Empty array = reconciles. */
export function reconcileGovernanceSummary(summary: WorkspaceGovernanceSummary): string[] {
  const problems: string[] = [];
  for (const t of summary.totals) {
    const rows = summary.rows.filter((r) => r.family === t.family && r.sourceSystem === t.sourceSystem);
    const automated = rows.filter((r) => r.axis === "automated").reduce((a, r) => a + r.count, 0);
    if (automated !== t.automatedDenominator) problems.push(`${t.family}: automated rows ${automated} ≠ automatedDenominator ${t.automatedDenominator}`);
    const malformed = summary.anomalies.filter((a) => a.kind === "reviewed_status_malformed" && a.family === t.family).reduce((a, x) => a + x.count, 0);
    if (t.sourceSystem === "A" && t.total - malformed !== t.automatedDenominator) problems.push(`${t.family}: total − reviewedMalformed ≠ automatedDenominator`);
    if (t.sourceSystem === "B") {
      if (t.automatedDenominator !== t.total) problems.push(`${t.family}: System B automatedDenominator ≠ total`);
      const human = rows.filter((r) => r.axis === "human").reduce((a, r) => a + r.count, 0);
      if (human !== t.total) problems.push(`${t.family}: human rows ${human} ≠ total ${t.total}`);
    }
    if (t.sourceSystem === "A") {
      const superseded = rows.filter((r) => r.axis === "automated" && r.subReason === "superseded_by_human_decision").reduce((a, r) => a + r.count, 0);
      const human = rows.filter((r) => r.axis === "human").reduce((a, r) => a + r.count, 0);
      if (human !== superseded) problems.push(`${t.family}: System A human decisions ${human} ≠ superseded ${superseded}`);
    }
    for (const r of rows) if (!Number.isInteger(r.count) || r.count < 0) problems.push(`${t.family}: invalid count ${r.count}`);
  }
  return problems;
}

export type FamilyPresentation = {
  family: Family;
  label: string;
  total: number;
  automatedDenominator: number;
  excludedNotComplete?: number;
  integrityAnomalies: number;
  automated: Array<{ outcome: NormalizedOutcome; label: string; detail?: string; count: number }>;
  human: Array<{ label: string; count: number }>;
  reviewedMalformed: number;
  overlap: number;
};

export function presentFamilies(summary: WorkspaceGovernanceSummary): FamilyPresentation[] {
  return FAMILY_ORDER.flatMap((family) => {
    const t = summary.totals.find((x) => x.family === family);
    if (!t) return [];
    const rows = summary.rows.filter((r) => r.family === family);
    const automated = rows
      .filter((r) => r.axis === "automated" && r.normalizedOutcome)
      .map((r) => ({
        outcome: r.normalizedOutcome as NormalizedOutcome,
        label: OUTCOME_LABELS[r.normalizedOutcome as NormalizedOutcome],
        ...(r.subReason ? { detail: SUB_REASON_LABELS[r.subReason] } : {}),
        count: r.count,
      }))
      .sort((a, b) => OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome));
    const human = rows
      .filter((r) => r.axis === "human" && r.humanDecision)
      .map((r) => ({ label: HUMAN_DECISION_LABELS[r.humanDecision as string] ?? (r.humanDecision as string), count: r.count }));
    const sumAnomaly = (kind: string) => summary.anomalies.filter((a) => a.kind === kind && a.family === family).reduce((a, x) => a + x.count, 0);
    return [
      {
        family,
        label: FAMILY_LABELS[family],
        total: t.total,
        automatedDenominator: t.automatedDenominator,
        ...(t.excludedNotComplete !== undefined ? { excludedNotComplete: t.excludedNotComplete } : {}),
        integrityAnomalies: t.integrityAnomalies,
        automated,
        human,
        reviewedMalformed: sumAnomaly("reviewed_status_malformed"),
        overlap: sumAnomaly("family_overlap"),
      },
    ];
  });
}

/**
 * The contract-permitted cross-family rollup: counts sharing an approved
 * normalized-outcome bucket, summed, with the exact denominator (the sum of the
 * families' automated denominators) and a per-family breakdown for every bucket.
 */
export function rollupAutomatedOutcomes(summary: WorkspaceGovernanceSummary): {
  denominator: number;
  buckets: Array<{ outcome: NormalizedOutcome; label: string; count: number; byFamily: Array<{ family: Family; count: number }> }>;
} {
  const denominator = summary.totals.reduce((a, t) => a + t.automatedDenominator, 0);
  const buckets = OUTCOME_ORDER.map((outcome) => {
    const byFamily = FAMILY_ORDER.map((family) => ({
      family,
      count: summary.rows.filter((r) => r.axis === "automated" && r.family === family && r.normalizedOutcome === outcome).reduce((a, r) => a + r.count, 0),
    })).filter((x) => x.count > 0);
    return { outcome, label: OUTCOME_LABELS[outcome], count: byFamily.reduce((a, x) => a + x.count, 0), byFamily };
  });
  return { denominator, buckets };
}
