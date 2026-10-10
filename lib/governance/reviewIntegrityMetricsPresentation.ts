/**
 * Order 3 — pure presentation for Review Integrity Metrics v1.
 *
 * `reconcileReviewIntegrityMetrics` re-checks the server's response
 * INDEPENDENTLY (it shares no arithmetic with the domain module) before
 * anything is shown: an untrusted JSON body that is malformed or does not add
 * up is reported as problems and never rendered.
 *
 * Wording is factual: counts with their stated denominator, no percentage,
 * score, rank or quality language, and a missing decision path is described
 * neutrally — it is not a defect and is never presented as single-reviewer.
 */
import type { ReviewIntegrityMetricsV1 } from "./reviewIntegrityMetrics";

const STATE_ORDER = ["unreviewed", "pending", "approved", "approved_with_conditions", "changes_requested", "rejected", "other_or_missing"] as const;
const PATH_ORDER = ["single_reviewer", "multi_reviewer_panel", "multi_reviewer_owner_override", "other_or_missing"] as const;
const TERMINAL = ["approved", "approved_with_conditions", "changes_requested", "rejected"] as const;
const NON_TERMINAL = ["unreviewed", "pending"] as const;

const STATE_LABELS: Record<(typeof STATE_ORDER)[number], string> = {
  unreviewed: "Unreviewed",
  pending: "Pending",
  approved: "Approved",
  approved_with_conditions: "Approved with conditions",
  changes_requested: "Changes requested",
  rejected: "Rejected",
  other_or_missing: "Other or not recorded",
};

const PATH_LABELS: Record<(typeof PATH_ORDER)[number], string> = {
  single_reviewer: "Recorded single-reviewer",
  multi_reviewer_panel: "Multi-reviewer panel",
  multi_reviewer_owner_override: "Owner override",
  other_or_missing: "Path not recorded or unrecognized",
};

export const DECISION_PATH_NOTE = "Older or ordinary decisions may not record a decision path.";
export const REVIEW_INTEGRITY_EMPTY_MESSAGE = "No completed adaptive research is available for review integrity metrics yet.";

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function orderedCounts(value: unknown, key: "status" | "path", order: readonly string[], label: string, problems: string[]): Map<string, number> | null {
  if (!Array.isArray(value) || value.length !== order.length) {
    problems.push(`${label}: expected exactly ${order.length} entries`);
    return null;
  }
  const out = new Map<string, number>();
  value.forEach((entry, i) => {
    if (!isRecord(entry) || entry[key] !== order[i] || !isCount(entry.count)) problems.push(`${label}[${i}]: expected ${order[i]} with a non-negative integer count`);
    else out.set(order[i], entry.count);
  });
  return problems.length ? null : out;
}

/** Returns every problem found; an empty list means the response is safe to render. */
export function reconcileReviewIntegrityMetrics(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value) || value.version !== 1) return ["unsupported or malformed response"];
  const totals = value.totals;
  const mr = value.multiReviewer;
  if (!isRecord(totals) || !isRecord(mr)) return ["missing totals or multi-reviewer counts"];
  const totalKeys = ["completedAdaptiveResearch", "terminalHumanDecisions", "nonTerminalRecognized", "otherOrMissingReviewState", "projectIntegrityAnomalies"] as const;
  const mrKeys = ["explicitDecisionCount", "panelFinalizationCount", "ownerOverrideCount"] as const;
  for (const k of totalKeys) if (!isCount(totals[k])) problems.push(`totals.${k} is not a non-negative integer`);
  for (const k of mrKeys) if (!isCount(mr[k])) problems.push(`multiReviewer.${k} is not a non-negative integer`);
  if (problems.length) return problems;

  const states = orderedCounts(value.reviewStates, "status", STATE_ORDER, "reviewStates", problems);
  const paths = orderedCounts(value.decisionPaths, "path", PATH_ORDER, "decisionPaths", problems);
  if (!states || !paths) return problems;

  const t = totals as Record<(typeof totalKeys)[number], number>;
  const m = mr as Record<(typeof mrKeys)[number], number>;
  let stateSum = 0;
  for (const s of STATE_ORDER) stateSum += states.get(s)!;
  if (stateSum !== t.completedAdaptiveResearch) problems.push("review states do not add up to completed adaptive research");
  let terminal = 0;
  for (const s of TERMINAL) terminal += states.get(s)!;
  if (terminal !== t.terminalHumanDecisions) problems.push("terminal decisions do not match their review states");
  let nonTerminal = 0;
  for (const s of NON_TERMINAL) nonTerminal += states.get(s)!;
  if (nonTerminal !== t.nonTerminalRecognized) problems.push("non-terminal total does not match its review states");
  if (states.get("other_or_missing") !== t.otherOrMissingReviewState) problems.push("other or not recorded review state mismatch");
  let pathSum = 0;
  for (const p of PATH_ORDER) pathSum += paths.get(p)!;
  if (pathSum !== t.terminalHumanDecisions) problems.push("decision paths do not add up to terminal decisions");
  if (m.panelFinalizationCount !== paths.get("multi_reviewer_panel")) problems.push("panel finalizations mismatch");
  if (m.ownerOverrideCount !== paths.get("multi_reviewer_owner_override")) problems.push("owner overrides mismatch");
  if (m.explicitDecisionCount !== m.panelFinalizationCount + m.ownerOverrideCount) problems.push("explicit multi-reviewer decisions mismatch");
  return problems;
}

export type PresentedRow = { key: string; label: string; count: number };
export type PresentedReviewIntegrity =
  | { kind: "empty"; message: string }
  | {
      kind: "ready";
      reviewState: { total: number; rows: PresentedRow[] };
      decisionPath: { terminal: number; rows: PresentedRow[]; note: string };
      multiReviewer: { explicit: number; panelFinalizations: number; ownerOverrides: number; ownerOverrideLine: string };
      projectIntegrityExclusions: number;
    };

/** Only call with a response that `reconcileReviewIntegrityMetrics` accepted. */
export function presentReviewIntegrityMetrics(m: ReviewIntegrityMetricsV1): PresentedReviewIntegrity {
  if (m.totals.completedAdaptiveResearch === 0) return { kind: "empty", message: REVIEW_INTEGRITY_EMPTY_MESSAGE };
  const mr = m.multiReviewer;
  return {
    kind: "ready",
    reviewState: {
      total: m.totals.completedAdaptiveResearch,
      rows: m.reviewStates.map((r) => ({ key: r.status, label: STATE_LABELS[r.status], count: r.count })),
    },
    decisionPath: {
      terminal: m.totals.terminalHumanDecisions,
      // No writer records "single_reviewer" today; the row appears only if one ever does.
      rows: m.decisionPaths.filter((p) => p.path !== "single_reviewer" || p.count > 0).map((p) => ({ key: p.path, label: PATH_LABELS[p.path], count: p.count })),
      note: DECISION_PATH_NOTE,
    },
    multiReviewer: {
      explicit: mr.explicitDecisionCount,
      panelFinalizations: mr.panelFinalizationCount,
      ownerOverrides: mr.ownerOverrideCount,
      // The denominator is the explicitly recorded multi-reviewer decisions — never all terminal decisions.
      ownerOverrideLine: `Owner overrides: ${mr.ownerOverrideCount} of ${mr.explicitDecisionCount} explicitly recorded multi-reviewer decisions`,
    },
    projectIntegrityExclusions: m.totals.projectIntegrityAnomalies,
  };
}
