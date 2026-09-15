/**
 * Project/Research Assignment (D4, brief §6.6) — read-side derivation of
 * what a client may see about an assignee: a membership-evidenced display
 * name and a `state` derived from CURRENT membership under the D2 rule for
 * the target kind. One batched membership `getAll` per page plus the
 * existing batched name resolver — never a per-row read, never a raw uid
 * shown as a name, and `state` is presentation metadata only (no route
 * branches on it for authorization).
 *
 * Removed members still resolve by name (history preserved) and read as
 * `stale`; a uid with no membership evidence at all gets the fixed
 * fallback label and `stale`.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { computeMembershipId } from "./membershipId";
import { validateMembershipBinding } from "./membershipBinding";
import { resolveWorkspaceReviewerDisplayNames, REVIEWER_UNAVAILABLE_LABEL } from "./workspaceReviewerIdentity";
import { deriveAssigneeState, type AssignmentTargetKind, type AssigneeState } from "./assignmentTargetEligibility";
import type { WorkspaceMembershipV1 } from "./membershipTypes";

export interface AssigneePresentation {
  uid: string;
  displayName: string;
  state: AssigneeState;
}

/** The fully-degraded presentation: the fixed non-identifying label and `stale`. Never a raw uid, never a fabricated "active". */
export function degradedAssigneePresentation(uid: string): AssigneePresentation {
  return { uid, displayName: REVIEWER_UNAVAILABLE_LABEL, state: "stale" };
}

/**
 * NEVER THROWS — this is presentation over an already-committed canonical
 * state, and a route that has just committed a mutation must never turn
 * into a retryable HTTP failure because a secondary identity read failed
 * (PR #164 review C1). Returns a map covering EVERY input uid. `kind`
 * selects the D2 rule used for `state`. When Firestore is unavailable, or
 * the membership batch read or the name resolver fails, every affected
 * entry is the fallback label with `stale` — never a fabricated "active",
 * never a raw uid as a name. Failures are logged without any uid.
 */
export async function resolveAssigneePresentations(workspaceId: string, kind: AssignmentTargetKind, uids: readonly string[]): Promise<Map<string, AssigneePresentation>> {
  const result = new Map<string, AssigneePresentation>();
  const uniqueUids = Array.from(new Set(uids));
  if (uniqueUids.length === 0) return result;
  // Degraded baseline first, so every early failure below still yields a complete map.
  for (const uid of uniqueUids) result.set(uid, degradedAssigneePresentation(uid));

  try {
    const memberships = new Map<string, WorkspaceMembershipV1 | null>();
    if (adminDb) {
      try {
        const refs = uniqueUids.map((uid) => adminDb!.collection("workspaceMemberships").doc(computeMembershipId(workspaceId, uid)));
        const snaps = await adminDb.getAll(...refs);
        for (let i = 0; i < uniqueUids.length; i++) {
          const snap = snaps[i];
          memberships.set(uniqueUids[i], snap.exists ? validateMembershipBinding(snap.data(), { workspaceId, uid: uniqueUids[i] }) : null);
        }
      } catch (err) {
        // Fail closed to `stale` — never a fabricated active state.
        logger.warn("[workspaces/assigneePresentation] Membership batch read failed — assignees degrade to stale", { workspaceId, count: uniqueUids.length, error: err instanceof Error ? err.message : String(err) });
      }
    }

    let names: Map<string, string>;
    try {
      names = await resolveWorkspaceReviewerDisplayNames(workspaceId, uniqueUids, REVIEWER_UNAVAILABLE_LABEL);
    } catch (err) {
      // The shared resolver's own membership read may reject; contain it
      // HERE (Project Assignment presentation) rather than changing review
      // presentation semantics. Names degrade to the fallback label.
      logger.warn("[workspaces/assigneePresentation] Display-name resolution failed — assignees degrade to the fallback label", { workspaceId, count: uniqueUids.length, error: err instanceof Error ? err.message : String(err) });
      names = new Map();
    }

    for (const uid of uniqueUids) {
      result.set(uid, {
        uid,
        displayName: names.get(uid) ?? REVIEWER_UNAVAILABLE_LABEL,
        state: deriveAssigneeState(kind, memberships.get(uid) ?? null),
      });
    }
  } catch (err) {
    // Belt-and-braces: anything unforeseen leaves the degraded baseline in place.
    logger.warn("[workspaces/assigneePresentation] Unexpected presentation failure — assignees degrade to stale", { workspaceId, error: err instanceof Error ? err.message : String(err) });
    for (const uid of uniqueUids) result.set(uid, degradedAssigneePresentation(uid));
  }
  return result;
}
