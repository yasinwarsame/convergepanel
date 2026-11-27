/**
 * ZCA L-4 — client-safe shape of `GET /api/workspaces/[workspaceId]` (D-4 endpoint E-a).
 *
 * `capabilities.ts` and `membershipTypes.ts` are server-only, so the client gets its own closed lists
 * here. `teamWorkspaceAccessTypes.spec.ts` pins them to the server's definitions (every role's
 * capability set and the role list), so the two can never drift. `parse…` accepts only the endpoint's
 * exact ok shape; an unknown capability or role rejects the whole body (rendered as "unavailable"),
 * so the client never treats an unrecognised string as a grant.
 */
export const CLIENT_WORKSPACE_CAPABILITIES = [
  "workspace.read",
  "members.read",
  "members.invite",
  "members.manage",
  "audit.read",
  "projects.read",
  "projects.create",
  "projects.manage",
  "research.read",
  "research.create",
  "research.organize",
  "reviews.read",
  "reviews.submit",
  "reviews.manage",
  "reviews.override",
  "exports.create",
  "ownership.transfer",
  "admins.manage",
  "sources.attest",
] as const;
export type ClientWorkspaceCapability = (typeof CLIENT_WORKSPACE_CAPABILITIES)[number];

export const CLIENT_WORKSPACE_ROLES = ["owner", "admin", "member", "reviewer", "viewer"] as const;
export type ClientWorkspaceRole = (typeof CLIENT_WORKSPACE_ROLES)[number];

export interface TeamWorkspaceAccessInfo {
  workspace: { id: string; name: string };
  role: ClientWorkspaceRole;
  capabilities: readonly ClientWorkspaceCapability[];
  reportReviewEnabled: boolean;
  projectAssignmentUiEnabled: boolean;
}

const CAPS = new Set<string>(CLIENT_WORKSPACE_CAPABILITIES);
const ROLES = new Set<string>(CLIENT_WORKSPACE_ROLES);

export function parseTeamWorkspaceAccessResponse(body: unknown): TeamWorkspaceAccessInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.ok !== true) return null;
  const w = b.workspace as Record<string, unknown> | null | undefined;
  if (typeof w !== "object" || w === null || typeof w.id !== "string" || typeof w.name !== "string") return null;
  if (typeof b.role !== "string" || !ROLES.has(b.role)) return null;
  if (!Array.isArray(b.capabilities) || !b.capabilities.every((c) => typeof c === "string" && CAPS.has(c))) return null;
  if (typeof b.reportReviewEnabled !== "boolean" || typeof b.projectAssignmentUiEnabled !== "boolean") return null;
  return {
    workspace: { id: w.id, name: w.name },
    role: b.role as ClientWorkspaceRole,
    capabilities: [...(b.capabilities as ClientWorkspaceCapability[])],
    reportReviewEnabled: b.reportReviewEnabled,
    projectAssignmentUiEnabled: b.projectAssignmentUiEnabled,
  };
}
