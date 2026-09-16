/**
 * TEAM-RESEARCH-PARITY-R3 — the ONE client-side builder for a Team research
 * DETAIL address.
 *
 * - Project-bound run → `/workspace/team/{workspaceId}/projects/{projectId}/research/{runId}`
 * - canonical Unfiled run (`projectId === null`) → `/workspace/team/{workspaceId}/research/{runId}`
 *
 * Every dynamic segment is percent-encoded exactly once. A Team-bound run is
 * never addressed through a Personal research URL.
 */
export function teamResearchDetailHref(args: { workspaceId: string; projectId: string | null; runId: string }): string {
  const workspaceBase = `/workspace/team/${encodeURIComponent(args.workspaceId)}`;
  if (args.projectId === null) {
    return `${workspaceBase}/research/${encodeURIComponent(args.runId)}`;
  }
  return `${workspaceBase}/projects/${encodeURIComponent(args.projectId)}/research/${encodeURIComponent(args.runId)}`;
}

/**
 * The matching R1 read endpoint for a detail address. Project-bound addresses
 * ALWAYS send `?projectId=` so the server enforces run-level Project
 * containment; the Unfiled address sends none.
 */
export function teamRunDetailApiUrl(args: { workspaceId: string; projectId: string | null; runId: string }): string {
  const base = `/api/workspaces/${encodeURIComponent(args.workspaceId)}/runs/${encodeURIComponent(args.runId)}`;
  return args.projectId === null ? base : `${base}?projectId=${encodeURIComponent(args.projectId)}`;
}
