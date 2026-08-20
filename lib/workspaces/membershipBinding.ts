/**
 * Team Workspace Core Foundation, Phase 8B — the resource-binding check a
 * deterministic document id can never provide by itself. A
 * `workspaceMemberships/{id}` id being exactly
 * `computeMembershipId(workspaceId, uid)` proves the id was *derivable*
 * from that tuple; it does NOT, by itself, prove the document's own
 * `workspaceId`/`uid` fields actually equal what a caller expects (a
 * confused-deputy write could in principle target the right doc id with
 * the wrong embedded fields). This module is the one place that binding
 * is enforced, mirroring `getWorkspace()`'s `data.id !== workspaceId`
 * check and `getProject()`'s identical pattern.
 */

import "server-only";
import { computeMembershipId } from "./membershipId";
import { isWellFormedWorkspaceMembershipV1, type WorkspaceMembershipV1 } from "./membershipTypes";

/**
 * Pure. Given already-fetched Firestore data and the (workspaceId, uid)
 * tuple the caller expects this document to represent, returns the
 * validated `WorkspaceMembershipV1` only if EVERY one of these holds:
 *   - the data passes `isWellFormedWorkspaceMembershipV1`
 *   - `doc.id === computeMembershipId(doc.workspaceId, doc.uid)` — the
 *     document's own embedded fields are internally self-consistent with
 *     its own id, never assumed
 *   - `doc.workspaceId === expected.workspaceId`
 *   - `doc.uid === expected.uid`
 * Any mismatch returns `null` — fails closed, never repairs or partially
 * trusts a malformed/mismatched document.
 */
export function validateMembershipBinding(data: unknown, expected: { workspaceId: string; uid: string }): WorkspaceMembershipV1 | null {
  if (!isWellFormedWorkspaceMembershipV1(data)) return null;
  if (data.id !== computeMembershipId(data.workspaceId, data.uid)) return null;
  if (data.workspaceId !== expected.workspaceId) return null;
  if (data.uid !== expected.uid) return null;
  return data;
}
