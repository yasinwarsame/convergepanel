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

/**
 * Never throws. Returns a map covering EVERY input uid. `kind` selects the
 * D2 rule used for `state`. When Firestore is unavailable every entry is
 * `stale` with the fallback label — never a fabricated "active".
 */
export async function resolveAssigneePresentations(workspaceId: string, kind: AssignmentTargetKind, uids: readonly string[]): Promise<Map<string, AssigneePresentation>> {
  const result = new Map<string, AssigneePresentation>();
  const uniqueUids = Array.from(new Set(uids));
  if (uniqueUids.length === 0) return result;

  const memberships = new Map<string, WorkspaceMembershipV1 | null>();
  if (adminDb) {
    try {
      const refs = uniqueUids.map((uid) => adminDb!.collection("workspaceMemberships").doc(computeMembershipId(workspaceId, uid)));
      const snaps = await adminDb.getAll(...refs);
      for (let i = 0; i < uniqueUids.length; i++) {
        const snap = snaps[i];
        memberships.set(uniqueUids[i], snap.exists ? validateMembershipBinding(snap.data(), { workspaceId, uid: uniqueUids[i] }) : null);
      }
    } catch {
      // Fail closed to `stale` below — never a fabricated active state.
    }
  }

  const names = await resolveWorkspaceReviewerDisplayNames(workspaceId, uniqueUids, REVIEWER_UNAVAILABLE_LABEL);
  for (const uid of uniqueUids) {
    result.set(uid, {
      uid,
      displayName: names.get(uid) ?? REVIEWER_UNAVAILABLE_LABEL,
      state: deriveAssigneeState(kind, memberships.get(uid) ?? null),
    });
  }
  return result;
}
