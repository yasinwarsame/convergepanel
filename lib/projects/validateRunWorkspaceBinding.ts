/**
 * Phase 6D.1 — the real (read-only) Workspace-binding validator injected
 * into `runProjectNormalizationDryRun()`. Composes only canonical existing
 * helpers (`getWorkspace()`, `getPersonalWorkspaceId()`) — no
 * reimplementation of Workspace validity rules. Mirrors
 * `resolvePersonalWorkspaceForOwner()`'s own checks (well-formed,
 * embedded-id match, `ownerUserId === userId`, `type === "personal"`),
 * plus one additional check specific to scanning arbitrary run records:
 * `workspaceId` must equal the user's own canonical Personal Workspace id
 * (`getPersonalWorkspaceId(userId)`), never merely some workspace this
 * user happens to own. Contains no write primitive.
 */

import "server-only";
import { getWorkspace } from "@/lib/firestore/workspaces";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";

export async function validateRunWorkspaceBinding(userId: string, workspaceId: string): Promise<boolean> {
  const idResult = getPersonalWorkspaceId(userId);
  if (!idResult.ok || idResult.workspaceId !== workspaceId) {
    return false;
  }
  const lookup = await getWorkspace(workspaceId);
  if (lookup.status !== "found") {
    return false;
  }
  return lookup.workspace.ownerUserId === userId && lookup.workspace.type === "personal";
}
