/**
 * Team Workspace Core Foundation, Phase 8B (corrected in Phase 8B.1) — the
 * account-lifecycle guard `DELETE`/`PATCH /api/admin/users/[uid]` consult
 * before permanently deleting or disabling a user who currently owns a
 * Team Workspace.
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
 *
 * Phase 8B.1 correction: the result is now a three-way discriminated
 * union, never a boolean — "the lookup failed" and "the uid owns no Team
 * Workspace" are DIFFERENT facts and must never be conflated. An account-
 * management action that cannot positively confirm a uid owns no Team
 * Workspace must never proceed as if it had confirmed exactly that: a
 * failed lookup means ownership status is UNKNOWN, and UNKNOWN must fail
 * closed, or a transient Firestore failure could delete/disable the sole
 * Owner of a Team Workspace and leave it administratively ownerless —
 * exactly the condition this guard exists to prevent. The caller
 * (`app/api/admin/users/[uid]/route.ts`) is required to treat `"lookup_failed"`
 * as a hard stop, never as "proceed."
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { isWellFormedWorkspaceV1 } from "@/lib/workspaces/types";

export type TeamOwnershipCheckResult = { kind: "clear" } | { kind: "owns_team_workspace"; workspaceIds: string[] } | { kind: "lookup_failed" };

export async function checkTeamWorkspaceOwnershipForUid(uid: string): Promise<TeamOwnershipCheckResult> {
  if (!adminDb) {
    // Firestore itself unavailable — ownership status is UNKNOWN, not
    // "clear." Same fail-closed treatment as a query throwing below.
    logger.error("[workspaces/teamOwnerGuard] Firestore unavailable while checking Team Workspace ownership — failing closed", { uid });
    return { kind: "lookup_failed" };
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
    return workspaceIds.length > 0 ? { kind: "owns_team_workspace", workspaceIds } : { kind: "clear" };
  } catch (err) {
    logger.error("[workspaces/teamOwnerGuard] Failed to look up Team Workspace ownership — failing closed", { uid, error: err instanceof Error ? err.message : String(err) });
    return { kind: "lookup_failed" };
  }
}
