/**
 * Order 3 — Review Integrity Metrics v1 (contract: REVIEW_INTEGRITY_METRICS_V1,
 * characterized at main a7be198e).
 *
 * Factual, persisted governance telemetry for ONE family: completed adaptive
 * Research (System B) in a Team Workspace, under the Step 6.3 Project
 * containment rule. Counts and explicit denominators only — no score, rate,
 * ranking or per-reviewer figure is computed anywhere in this module.
 *
 * Every number is an exact Firestore aggregation `count()` over persisted
 * predicates, expressed as a declarative `CountSpec` and executed through an
 * injected `CountExecutor` (the Step 6.3 architecture, reused rather than
 * copied). Nothing here reads an artifact document, applies a `limit`,
 * samples, writes or infers a value that was not stored.
 *
 * Contract map:
 *   family            → workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete"
 *   containment       → Step 6.3 `containmentSpecs` (projectId null or canonical Project)
 *   review state      → humanReview.status == each recognized value, plus
 *                       `not-in` the vocabulary (other recorded); missing =
 *                       total − recognized − otherRecorded. `not-in` and `==`
 *                       never match an absent field, and `not-in` excludes an
 *                       explicit null, so the residual is exactly absent + null.
 *   terminal          → approved + approved_with_conditions + changes_requested + rejected
 *   decision path     → ONLY within a terminal status: Σ_T count(status == T ∧
 *                       decidedVia == P). `decidedVia` alone is never treated as
 *                       proof of a terminal decision.
 *   path not recorded → terminal − Σ known paths. `decidedVia` is optional and
 *                       absent for every single-reviewer decision (the
 *                       single-reviewer writer never persists
 *                       "single_reviewer"), so a missing path is NEVER inferred
 *                       to be single-reviewer.
 *
 * Query envelope (N canonical Projects, b = 1 + ceil(N / 30) equality branches):
 *   1 raw total + b contained total + 6b states + (1 + N) other-recorded
 *   + 12b decision-path cells  =  1 + 19b + (1 + N)
 *   → 21 at N = 0, 41 at N = 1, 70 at N = 30 (the Workspace Project ceiling).
 *
 * The counts come from independent queries, so a write landing between two of
 * them can break the arithmetic. Every residual and cross-check is verified
 * here; an irreconcilable result throws `ReviewIntegrityInconsistentError` and
 * is never returned (the Firestore adapter retries once, then fails closed).
 */
import {
  containmentSpecs,
  limitConcurrency,
  MAX_CONCURRENT_COUNTS,
  SYSTEM_B_HUMAN_STATUSES,
  type CountExecutor,
  type CountFilter,
  type CountSpec,
} from "./workspaceGovernanceSummary";

export const REVIEW_STATES = SYSTEM_B_HUMAN_STATUSES;
export type ReviewState = (typeof REVIEW_STATES)[number];
export const TERMINAL_REVIEW_STATES = ["approved", "approved_with_conditions", "changes_requested", "rejected"] as const satisfies readonly ReviewState[];
export const NON_TERMINAL_REVIEW_STATES = ["unreviewed", "pending"] as const satisfies readonly ReviewState[];
/** The persisted `governanceRecord.humanReview.decidedVia` vocabulary. */
export const DECISION_PATHS = ["single_reviewer", "multi_reviewer_panel", "multi_reviewer_owner_override"] as const;
export type DecisionPath = (typeof DECISION_PATHS)[number];
export const OTHER_OR_MISSING = "other_or_missing" as const;

export const F_HUMAN_STATUS = "governanceRecord.humanReview.status";
export const F_DECIDED_VIA = "governanceRecord.humanReview.decidedVia";

export function reviewIntegrityFamilyFilters(workspaceId: string): CountFilter[] {
  return [
    { field: "workspaceId", op: "==", value: workspaceId },
    { field: "adaptiveOutput.version", op: "==", value: 1 },
    { field: "status", op: "==", value: "complete" },
  ];
}

export type ReviewIntegrityMetricsV1 = {
  version: 1;
  workspaceId: string;
  generatedAt: string;
  scope: {
    family: "research_adaptive";
    sourceSystem: "B";
    completion: "complete_only";
    timeRange: "all_recorded";
    projectContainment: "null_or_canonical_workspace_project";
    teamWorkspaceOnly: true;
  };
  totals: {
    completedAdaptiveResearch: number;
    terminalHumanDecisions: number;
    nonTerminalRecognized: number;
    otherOrMissingReviewState: number;
    projectIntegrityAnomalies: number;
  };
  reviewStates: Array<{ status: ReviewState | typeof OTHER_OR_MISSING; count: number }>;
  decisionPaths: Array<{ path: DecisionPath | typeof OTHER_OR_MISSING; count: number }>;
  multiReviewer: {
    explicitDecisionCount: number;
    panelFinalizationCount: number;
    ownerOverrideCount: number;
  };
};

export const REVIEW_INTEGRITY_SCOPE: ReviewIntegrityMetricsV1["scope"] = {
  family: "research_adaptive",
  sourceSystem: "B",
  completion: "complete_only",
  timeRange: "all_recorded",
  projectContainment: "null_or_canonical_workspace_project",
  teamWorkspaceOnly: true,
};

export class ReviewIntegrityInconsistentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewIntegrityInconsistentError";
  }
}

function nonNegative(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new ReviewIntegrityInconsistentError(`${label} = ${value}`);
  return value;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

export type ComputeReviewIntegrityMetricsArgs = {
  workspaceId: string;
  /** The VALIDATED canonical Project set — `canonicalProjectIdsFromListing` (Step 6.3 contract §4). */
  canonicalProjectIds: readonly string[];
  count: CountExecutor;
  now?: () => Date;
};

export async function computeReviewIntegrityMetrics(args: ComputeReviewIntegrityMetricsArgs): Promise<ReviewIntegrityMetricsV1> {
  const exec = limitConcurrency(args.count, MAX_CONCURRENT_COUNTS);
  const family = reviewIntegrityFamilyFilters(args.workspaceId);
  const projects = [...args.canonicalProjectIds];
  const run = async (label: string, spec: CountSpec) => nonNegative(label, await exec(spec));
  const contained = async (label: string, extra: CountFilter[]) =>
    sum(await Promise.all(containmentSpecs("runs", [...family, ...extra], projects).map((spec, i) => run(`${label}[${i}]`, spec))));

  const [total, rawTotal, stateCounts, otherRecorded, pathGrid] = await Promise.all([
    contained("total", []),
    run("rawTotal", { collection: "runs", filters: family }),
    Promise.all(REVIEW_STATES.map((s) => contained(`state.${s}`, [{ field: F_HUMAN_STATUS, op: "==", value: s }]))),
    contained("state.otherRecorded", [{ field: F_HUMAN_STATUS, op: "not-in", value: [...REVIEW_STATES] }]),
    // Each decision-path cell carries BOTH the terminal status and the path.
    Promise.all(
      TERMINAL_REVIEW_STATES.map((t) =>
        Promise.all(
          DECISION_PATHS.map((p) =>
            contained(`path.${t}.${p}`, [
              { field: F_HUMAN_STATUS, op: "==", value: t },
              { field: F_DECIDED_VIA, op: "==", value: p },
            ])
          )
        )
      )
    ),
  ]);

  const state = Object.fromEntries(REVIEW_STATES.map((s, i) => [s, stateCounts[i]])) as Record<ReviewState, number>;
  const missingState = nonNegative("state.missing", total - sum(stateCounts) - otherRecorded);
  const projectIntegrityAnomalies = nonNegative("projectIntegrityAnomalies", rawTotal - total);
  const terminal = sum(TERMINAL_REVIEW_STATES.map((t) => state[t]));
  const nonTerminal = sum(NON_TERMINAL_REVIEW_STATES.map((s) => state[s]));

  TERMINAL_REVIEW_STATES.forEach((t, i) => {
    const recordedUnderT = sum(pathGrid[i]);
    if (recordedUnderT > state[t]) throw new ReviewIntegrityInconsistentError(`path.${t} = ${recordedUnderT} > state.${t} = ${state[t]}`);
  });
  const path = Object.fromEntries(DECISION_PATHS.map((p, j) => [p, sum(pathGrid.map((row) => row[j]))])) as Record<DecisionPath, number>;
  const pathNotRecorded = nonNegative("path.otherOrMissing", terminal - sum(DECISION_PATHS.map((p) => path[p])));

  const metrics: ReviewIntegrityMetricsV1 = {
    version: 1,
    workspaceId: args.workspaceId,
    generatedAt: (args.now ?? (() => new Date()))().toISOString(),
    scope: { ...REVIEW_INTEGRITY_SCOPE },
    totals: {
      completedAdaptiveResearch: total,
      terminalHumanDecisions: terminal,
      nonTerminalRecognized: nonTerminal,
      otherOrMissingReviewState: otherRecorded + missingState,
      projectIntegrityAnomalies,
    },
    reviewStates: [...REVIEW_STATES.map((s) => ({ status: s, count: state[s] })), { status: OTHER_OR_MISSING, count: otherRecorded + missingState }],
    decisionPaths: [...DECISION_PATHS.map((p) => ({ path: p, count: path[p] })), { path: OTHER_OR_MISSING, count: pathNotRecorded }],
    multiReviewer: {
      explicitDecisionCount: path.multi_reviewer_panel + path.multi_reviewer_owner_override,
      panelFinalizationCount: path.multi_reviewer_panel,
      ownerOverrideCount: path.multi_reviewer_owner_override,
    },
  };
  assertReviewIntegrityArithmetic(metrics);
  return metrics;
}

/** The complete response arithmetic, verified before anything is returned. */
export function assertReviewIntegrityArithmetic(m: ReviewIntegrityMetricsV1): void {
  const t = m.totals;
  for (const [k, v] of Object.entries(t)) nonNegative(`totals.${k}`, v);
  for (const r of m.reviewStates) nonNegative(`reviewStates.${r.status}`, r.count);
  for (const p of m.decisionPaths) nonNegative(`decisionPaths.${p.path}`, p.count);
  const byState = new Map(m.reviewStates.map((r) => [r.status, r.count]));
  const fail = (msg: string) => {
    throw new ReviewIntegrityInconsistentError(msg);
  };
  if (sum(m.reviewStates.map((r) => r.count)) !== t.completedAdaptiveResearch) fail("review states do not sum to the completed total");
  if (sum(TERMINAL_REVIEW_STATES.map((s) => byState.get(s) ?? 0)) !== t.terminalHumanDecisions) fail("terminal total mismatch");
  if (sum(NON_TERMINAL_REVIEW_STATES.map((s) => byState.get(s) ?? 0)) !== t.nonTerminalRecognized) fail("non-terminal total mismatch");
  if ((byState.get(OTHER_OR_MISSING) ?? -1) !== t.otherOrMissingReviewState) fail("other/missing review state mismatch");
  if (sum(m.decisionPaths.map((p) => p.count)) !== t.terminalHumanDecisions) fail("decision paths do not sum to terminal decisions");
  const byPath = new Map(m.decisionPaths.map((p) => [p.path, p.count]));
  const mr = m.multiReviewer;
  if (mr.panelFinalizationCount !== byPath.get("multi_reviewer_panel") || mr.ownerOverrideCount !== byPath.get("multi_reviewer_owner_override")) fail("multi-reviewer counts mismatch");
  if (mr.explicitDecisionCount !== mr.panelFinalizationCount + mr.ownerOverrideCount) fail("explicit multi-reviewer count mismatch");
}

/**
 * The API's allow-list: a fresh object built field by field from the fixed
 * contract, so nothing else on an internal object can ever be serialized.
 */
export function toPublicReviewIntegrityMetrics(m: ReviewIntegrityMetricsV1): ReviewIntegrityMetricsV1 {
  return {
    version: 1,
    workspaceId: m.workspaceId,
    generatedAt: m.generatedAt,
    scope: { ...REVIEW_INTEGRITY_SCOPE },
    totals: {
      completedAdaptiveResearch: m.totals.completedAdaptiveResearch,
      terminalHumanDecisions: m.totals.terminalHumanDecisions,
      nonTerminalRecognized: m.totals.nonTerminalRecognized,
      otherOrMissingReviewState: m.totals.otherOrMissingReviewState,
      projectIntegrityAnomalies: m.totals.projectIntegrityAnomalies,
    },
    reviewStates: m.reviewStates.map((r) => ({ status: r.status, count: r.count })),
    decisionPaths: m.decisionPaths.map((p) => ({ path: p.path, count: p.count })),
    multiReviewer: {
      explicitDecisionCount: m.multiReviewer.explicitDecisionCount,
      panelFinalizationCount: m.multiReviewer.panelFinalizationCount,
      ownerOverrideCount: m.multiReviewer.ownerOverrideCount,
    },
  };
}
