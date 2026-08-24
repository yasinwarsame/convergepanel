/**
 * Approval Workflow, Phase 9C.1 — discovery-only resolver answering "which
 * Team Workspace, if any, should this uid's Reviews UI address."
 *
 * This closes a real gap surfaced while building `/workspace/reviews`:
 * every existing Phase 9 route takes `{workspaceId}` as an already-known
 * route parameter, but no API previously existed for a client (or a
 * Server Component) to discover which Team Workspace a uid even belongs
 * to — `POST /api/workspaces` (Phase 8B) only ever creates one, and
 * `getWorkspaceMembershipForBinding()` requires the caller to already
 * know `workspaceId`. This is the smallest possible fill for that gap:
 * ACTIVE-membership discovery only, never a general "list my Workspaces"
 * API, never exposed to the client directly (called server-side only, by
 * `/workspace/reviews/page.tsx` and `GET /api/user/usage`'s nav-flag
 * computation).
 *
 * Discovery-only, NOT an authorization decision. A `workspaceId` this
 * resolver returns still has to pass `resolveApprovalWorkflowAdmission()`
 * and `resolveTeamRunWorkspaceAccess()` independently, exactly like a
 * route-param `workspaceId` would — this module only answers "which one,"
 * never "is it allowed."
 *
 * MVP simplification (deliberately not solved here): a uid with active
 * membership in more than one Team Workspace gets exactly one
 * deterministically-chosen candidate (oldest membership by `createdAt`,
 * ties broken by `workspaceId`) — never a merged/aggregate view, never a
 * workspace switcher. Multi-Workspace membership is not yet a reachable
 * product state (no invitation flow exists), so this is a real but inert
 * limitation, not a silent data-loss risk. A future phase that adds
 * multi-Workspace membership must revisit this before Reviews can be
 * considered complete for that case.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { computeMembershipId } from "./membershipId";
import { isWellFormedWorkspaceMembershipV1, type WorkspaceMembershipV1 } from "./membershipTypes";

/** Bounded scan — a uid is expected to hold at most a handful of active memberships; this is a safety cap, not a real limit on membership count. */
export const MAX_VIEWER_MEMBERSHIPS_SCANNED = 10;

export type ResolveViewerTeamWorkspaceIdResult = { status: "found"; workspaceId: string } | { status: "not_found" } | { status: "lookup_failed" };

/** True only when the document is well-formed AND self-consistent with its own id — mirrors `validateMembershipBinding()`'s internal-consistency check, but without an `expected.workspaceId` (which this resolver doesn't have yet; that's the entire reason it exists). */
function isSelfConsistentMembership(data: unknown, expectedUid: string): data is WorkspaceMembershipV1 {
  if (!isWellFormedWorkspaceMembershipV1(data)) return false;
  if (data.id !== computeMembershipId(data.workspaceId, data.uid)) return false;
  if (data.uid !== expectedUid) return false;
  return true;
}

export async function resolveViewerTeamWorkspaceId(uid: string): Promise<ResolveViewerTeamWorkspaceIdResult> {
  if (!adminDb) return { status: "lookup_failed" };
  try {
    const snap = await adminDb.collection("workspaceMemberships").where("uid", "==", uid).where("status", "==", "active").limit(MAX_VIEWER_MEMBERSHIPS_SCANNED).get();
    if (snap.empty) return { status: "not_found" };

    const valid = snap.docs.map((d) => d.data()).filter((data): data is WorkspaceMembershipV1 => isSelfConsistentMembership(data, uid));
    if (valid.length === 0) return { status: "not_found" };

    valid.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis() || a.workspaceId.localeCompare(b.workspaceId));
    return { status: "found", workspaceId: valid[0].workspaceId };
  } catch (err) {
    logger.warn("[workspaces/resolveViewerTeamWorkspaceId] membership lookup failed", { uid, error: err instanceof Error ? err.message : String(err) });
    return { status: "lookup_failed" };
  }
}
