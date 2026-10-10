/**
 * Order 3 — READ-ONLY index discovery for Review Integrity Metrics v1.
 * NOT run without explicit owner authorization, and only against a controlled
 * synthetic Workspace.
 *
 * Enumerates every distinct count() shape the metrics issue (the SAME planner,
 * via a recording executor), then runs ONE representative of each shape
 * through the supplied executor. A missing-index rejection is recorded with
 * Firestore's own message (which carries the exact index definition); any
 * other failure aborts. The module holds only a count executor: nothing is
 * created, written, deleted, indexed or retried.
 */
import { countSpecShape, type CountExecutor, type CountSpec } from "./workspaceGovernanceSummary";
import { classifyProbeError, type ProbeResult, type ProbeRun } from "./workspaceGovernanceSummaryProbe";
import { computeReviewIntegrityMetrics, F_DECIDED_VIA } from "./reviewIntegrityMetrics";

/** A placeholder Project id lets per-Project shapes be probed in a Workspace with no Projects. */
export const REVIEW_INTEGRITY_PROBE_PLACEHOLDER_PROJECT_ID = "__review_integrity_probe_placeholder__";

/** Index shape: the Step 6.3 key with the decision-path value abstracted too (all three paths share one index). */
export function reviewIntegritySpecShape(spec: CountSpec): string {
  return countSpecShape({ ...spec, filters: spec.filters.map((f) => (f.field === F_DECIDED_VIA ? { ...f, value: "<path>" } : f)) });
}

export async function planDistinctReviewIntegrityShapes(workspaceId: string, canonicalProjectIds: readonly string[]): Promise<Map<string, CountSpec>> {
  const projects = canonicalProjectIds.length ? canonicalProjectIds : [REVIEW_INTEGRITY_PROBE_PLACEHOLDER_PROJECT_ID];
  const shapes = new Map<string, CountSpec>();
  await computeReviewIntegrityMetrics({
    workspaceId,
    canonicalProjectIds: projects,
    count: async (spec) => {
      const key = reviewIntegritySpecShape(spec);
      if (!shapes.has(key)) shapes.set(key, spec);
      return 0;
    },
  });
  return shapes;
}

export async function probeReviewIntegrityMetricsIndexes(exec: CountExecutor, workspaceId: string, canonicalProjectIds: readonly string[]): Promise<ProbeRun> {
  const shapes = await planDistinctReviewIntegrityShapes(workspaceId, canonicalProjectIds);
  const results: ProbeResult[] = [];
  for (const [shape, spec] of shapes) {
    try {
      results.push({ shape, spec, ok: true, count: await exec(spec) });
    } catch (err) {
      const c = classifyProbeError(err);
      if (c.kind === "unexpected") return { results, aborted: { shape, spec, code: c.code, message: c.message } };
      results.push({ shape, spec, ok: false, kind: c.kind, code: c.code, message: c.message });
    }
  }
  return { results, aborted: null };
}
