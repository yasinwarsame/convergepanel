/**
 * ZCA L-5 — client-safe shape of `GET /api/workspaces/[workspaceId]/projects/[projectId]` (D-4 E-b).
 * Accepts only the endpoint's exact ok shape; anything else renders the neutral "unavailable" state.
 */
export interface TeamProjectInfo {
  id: string;
  name: string;
  status: "active" | "archived";
  /** Present only when requested with `?include=assignees` (and allowed by projects.read). */
  assignees?: Array<{ uid: string; displayName: string; state: "active" | "stale" }>;
}

export function parseTeamProjectResponse(body: unknown): TeamProjectInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { ok?: unknown; project?: unknown };
  if (b.ok !== true || typeof b.project !== "object" || b.project === null) return null;
  const p = b.project as Record<string, unknown>;
  if (typeof p.id !== "string" || typeof p.name !== "string") return null;
  if (p.status !== "active" && p.status !== "archived") return null;
  const out: TeamProjectInfo = { id: p.id, name: p.name, status: p.status };
  if (p.assignees !== undefined) {
    if (!Array.isArray(p.assignees)) return null;
    const ok = p.assignees.every(
      (a) => typeof a === "object" && a !== null && typeof (a as Record<string, unknown>).uid === "string" && typeof (a as Record<string, unknown>).displayName === "string" && ((a as Record<string, unknown>).state === "active" || (a as Record<string, unknown>).state === "stale"),
    );
    if (!ok) return null;
    out.assignees = (p.assignees as Array<{ uid: string; displayName: string; state: "active" | "stale" }>).map((a) => ({ uid: a.uid, displayName: a.displayName, state: a.state }));
  }
  return out;
}
