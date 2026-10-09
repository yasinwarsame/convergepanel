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

export type ProbeFailureKind = "missing_index" | "query_shape";
export type ProbeResult = { shape: string; spec: CountSpec } & ({ ok: true; count: number } | { ok: false; kind: ProbeFailureKind; code: string | number | null; message: string });
export type ProbeRun = { results: ProbeResult[]; aborted: null | { shape: string; spec: CountSpec; code: string | number | null; message: string } };

/**
 * Firestore's gRPC status for a missing index is FAILED_PRECONDITION (9) and for
 * an unsupported query shape INVALID_ARGUMENT (3). Anything else (permissions,
 * availability, quota, unknown) is NOT an index-discovery result: the probe
 * stops and reports it rather than continuing against Production.
 */
export function classifyProbeError(err: unknown): { kind: ProbeFailureKind | "unexpected"; code: string | number | null; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === "object" && "code" in err ? ((err as { code: string | number }).code ?? null) : null;
  if (code === 9 || code === "failed-precondition" || code === "FAILED_PRECONDITION" || /^9 FAILED_PRECONDITION/.test(message)) return { kind: "missing_index", code, message };
  if (code === 3 || code === "invalid-argument" || code === "INVALID_ARGUMENT" || /^3 INVALID_ARGUMENT/.test(message)) return { kind: "query_shape", code, message };
  return { kind: "unexpected", code, message };
}

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

export async function probeGovernanceSummaryIndexes(exec: CountExecutor, workspaceId: string, canonicalProjectIds: readonly string[]): Promise<ProbeRun> {
  const shapes = await planDistinctShapes(workspaceId, canonicalProjectIds);
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
