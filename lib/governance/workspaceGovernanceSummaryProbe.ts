/**
 * Step 6.3 — READ-ONLY production index discovery for the Workspace governance
 * summary. NOT run without explicit owner authorization.
 *
 * Enumerates every distinct count() shape the summary issues (the SAME planner,
 * via a recording executor), then runs ONE representative of each shape through
 * the supplied executor. A shape that Firestore rejects for a missing index is
 * recorded with Firestore's own message, which carries the exact required index
 * definition / creation link. Nothing is created, written or retried.
 */
import { computeWorkspaceGovernanceSummary, countSpecShape, type CountExecutor, type CountSpec } from "./workspaceGovernanceSummary";

export type ProbeResult = { shape: string; spec: CountSpec } & ({ ok: true; count: number } | { ok: false; missingIndex: boolean; message: string });

/** A placeholder Project id lets per-Project shapes be probed in a Workspace with no Projects. */
export const PROBE_PLACEHOLDER_PROJECT_ID = "__governance_summary_probe_placeholder__";

export async function planDistinctShapes(workspaceId: string, canonicalProjectIds: readonly string[]): Promise<Map<string, CountSpec>> {
  const projects = canonicalProjectIds.length ? canonicalProjectIds : [PROBE_PLACEHOLDER_PROJECT_ID];
  const shapes = new Map<string, CountSpec>();
  await computeWorkspaceGovernanceSummary({
    workspaceId,
    canonicalProjectIds: projects,
    count: async (spec) => {
      const key = countSpecShape(spec);
      if (!shapes.has(key)) shapes.set(key, spec);
      return 0;
    },
  });
  return shapes;
}

export async function probeGovernanceSummaryIndexes(exec: CountExecutor, workspaceId: string, canonicalProjectIds: readonly string[]): Promise<ProbeResult[]> {
  const shapes = await planDistinctShapes(workspaceId, canonicalProjectIds);
  const results: ProbeResult[] = [];
  for (const [shape, spec] of shapes) {
    try {
      results.push({ shape, spec, ok: true, count: await exec(spec) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ shape, spec, ok: false, missingIndex: /FAILED_PRECONDITION|requires an index|index/i.test(message), message });
    }
  }
  return results;
}
