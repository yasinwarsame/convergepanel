/**
 * Team Workspace Core Foundation, Phase 8B — the account-lifecycle guard
 * `DELETE`/`PATCH /api/admin/users/[uid]` consult before permanently
 * deleting or disabling a user who currently owns a Team Workspace.
 *
 * Deliberately a single-field-equality query (`.where("ownerUserId","==",uid)`
 * on `workspaces`, already covered by Firestore's automatic single-field
 * index — no composite index needed) followed by an in-memory `type ===
 * "team"` filter, rather than a two-field compound query
 * (`.where("ownerUserId","==",uid).where("type","==","team")`, which would
 * need a new composite index for no real benefit here). This is a
 * low-frequency admin operation over a bounded result set (the number of
 * Workspaces any one uid can own), so the extra in-memory filter costs
 * nothing that matters — see docs/workspaces/phase8-team-workspace-foundation.md's
 * "Indexes" section for the full reasoning against adding one solely for
 * this guard.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { isWellFormedWorkspaceV1 } from "@/lib/workspaces/types";

export type GetTeamWorkspaceOwnershipResult = { status: "ok"; ownsTeamWorkspace: boolean; workspaceIds: string[] } | { status: "firestore_unavailable" } | { status: "lookup_failed" };

export async function getTeamWorkspaceOwnershipForUid(uid: string): Promise<GetTeamWorkspaceOwnershipResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }
  try {
    const snap = await adminDb.collection("workspaces").where("ownerUserId", "==", uid).get();
    const workspaceIds: string[] = [];
    for (const doc of snap.docs) {
      const data = doc.data();
      if (isWellFormedWorkspaceV1(data) && data.id === doc.id && data.type === "team") {
        workspaceIds.push(doc.id);
      }
    }
    return { status: "ok", ownsTeamWorkspace: workspaceIds.length > 0, workspaceIds };
  } catch (err) {
    logger.warn("[workspaces/teamOwnerGuard] Failed to look up Team Workspace ownership", { uid, error: err instanceof Error ? err.message : String(err) });
    return { status: "lookup_failed" };
  }
}
