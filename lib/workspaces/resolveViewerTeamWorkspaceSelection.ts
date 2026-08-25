/**
 * Approval Workflow, Phase 9C.1-R1C — replaces the removed
 * `resolveViewerTeamWorkspaceId()`, which silently chose ONE Team
 * Workspace (oldest membership by `createdAt`) whenever a uid held more
 * than one active membership. That was a real defect, not an accepted
 * MVP simplification: multiple active Team Workspace memberships are a
 * REACHABLE, SUPPORTED product state today — `POST /api/workspaces` has
 * no check preventing a second Workspace creation, and
 * `acceptWorkspaceInvitation()` (already merged) has no check preventing
 * acceptance while already active elsewhere. A deterministic tie-break is
 * not a canonical choice; silently picking one made the other Workspace's
 * entire review queue permanently unreachable through this UI with no
 * signal anything was hidden.
 *
 * This resolver answers ONLY the cardinality question — never "which
 * one." Callers (`/workspace/reviews/page.tsx`,
 * `GET /api/user/usage`'s nav-flag computation) must branch on the
 * returned `kind`:
 *   - `"none"`: no active Team Workspace at all — concealed unavailable.
 *   - `"single"`: exactly one — may be auto-selected, unambiguous.
 *   - `"multiple"`: two or more — an explicit Workspace selection is
 *     required (`listViewerTeamWorkspaces()` + a chooser UI); this
 *     resolver NEVER picks one on the caller's behalf.
 *
 * Bounded scan, not "list all memberships": a uid is expected to hold at
 * most a handful of active memberships, so `MAX_VIEWER_MEMBERSHIP_
 * CARDINALITY_SCAN` docs is a generous safety margin for reliably
 * distinguishing 0/1/2+ even in the presence of the occasional malformed
 * document — not a real limit on how many memberships a uid may hold
 * (that's `listViewerTeamWorkspaces()`'s job, which paginates instead of
 * bounding).
 *
 * Discovery-only, NOT an authorization decision, exactly as the removed
 * resolver's doc comment said: a `workspaceId` this module's `"single"`
 * result names (or a `workspaceId` a caller supplies explicitly after
 * seeing `"multiple"`) still has to pass `resolveApprovalWorkflowAdmission()`
 * and `resolveTeamRunWorkspaceAccess()` independently.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { validateSelfConsistentMembership } from "./membershipBinding";

/** Safety cap for the cardinality scan — see module doc comment. */
export const MAX_VIEWER_MEMBERSHIP_CARDINALITY_SCAN = 10;

export type ViewerTeamWorkspaceSelection = { kind: "none" } | { kind: "single"; workspaceId: string } | { kind: "multiple" } | { kind: "lookup_failed" };

export async function resolveViewerTeamWorkspaceSelection(uid: string): Promise<ViewerTeamWorkspaceSelection> {
  if (!adminDb) return { kind: "lookup_failed" };
  try {
    const snap = await adminDb.collection("workspaceMemberships").where("uid", "==", uid).where("status", "==", "active").limit(MAX_VIEWER_MEMBERSHIP_CARDINALITY_SCAN).get();
    if (snap.empty) return { kind: "none" };

    const valid = snap.docs.map((d) => validateSelfConsistentMembership(d.data(), uid)).filter((m): m is NonNullable<typeof m> => m !== null);
    if (valid.length === 0) return { kind: "none" };
    if (valid.length === 1) return { kind: "single", workspaceId: valid[0].workspaceId };
    return { kind: "multiple" };
  } catch (err) {
    logger.warn("[workspaces/resolveViewerTeamWorkspaceSelection] membership lookup failed", { uid, error: err instanceof Error ? err.message : String(err) });
    return { kind: "lookup_failed" };
  }
}
