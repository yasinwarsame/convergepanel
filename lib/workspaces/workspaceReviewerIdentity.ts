/**
 * Approval Workflow, Phase 9B.6-R1C — the ONE Workspace-scoped identity
 * disclosure gate for every reviewer/assignee display name this codebase's
 * new Workspace review-presentation surfaces resolve.
 *
 * SECURITY PRINCIPLE (the defect this file fixes): a UID appearing in
 * `humanReviewAssignment/current.assignedReviewerUserId` or
 * `humanReviewPanel/current.reviewerUserIds` is governance METADATA, not
 * proof that user ever belonged to the canonical Workspace — that
 * metadata can be stale, malformed, or (in a test/data-corruption
 * scenario) simply wrong. `lib/governance/reviewerIdentity.ts`'s
 * `resolveReviewerDisplayName(s)()` is a GLOBAL `users/{uid}` resolver
 * with no Workspace scoping of its own; its own module doc explicitly
 * documents that safety depends on "the caller already supplied a uid
 * drawn from a canonical governance record for THIS run" — calling it directly
 * on an unvalidated governance-metadata UID turns it into a cross-user
 * identity oracle (arbitrary UID in → that stranger's real name/masked
 * email out), regardless of whether that UID has any relationship to the
 * Workspace being viewed. This module is the mandatory gate in front of
 * it for every Workspace review surface.
 *
 * RULE: resolve a real display identity for a UID if and ONLY if a
 * well-formed `workspaceMemberships/{computeMembershipId(workspaceId,uid)}`
 * document exists and is bound to (workspaceId, uid) — `active` OR
 * `removed` both count as legitimate evidence (a former member's identity
 * remains safe, useful historical attribution; `removed` does NOT restore
 * actionability — that remains `isValidAssignmentTarget()`'s job
 * entirely, this module never touches it). No membership document, or a
 * malformed one: fail closed to `REVIEWER_UNAVAILABLE_LABEL`, identical
 * to any other unresolvable identity — never a raw UID, never revealing
 * whether the UID corresponds to a real application user at all (the
 * anti-user-enumeration property).
 *
 * Bounded/batched: ONE `adminDb.getAll()` for the deduplicated membership
 * documents, then the existing `resolveReviewerDisplayNames()` batch
 * resolver only for the membership-evidenced subset — never a per-uid
 * Firestore round trip, and never a global-profile read attempted for a
 * non-evidenced uid at all (not merely a discarded result).
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { computeMembershipId } from "./membershipId";
import { validateMembershipBinding } from "./membershipBinding";
import { resolveReviewerDisplayNames, REVIEWER_UNAVAILABLE_LABEL } from "@/lib/governance/reviewerIdentity";

export { REVIEWER_UNAVAILABLE_LABEL };

/**
 * Never throws. Returns a `uid -> displayName` map covering every input
 * uid (deduplicated) — evidenced members get a resolved display name
 * (never the raw uid), everyone else gets `REVIEWER_UNAVAILABLE_LABEL`.
 */
export async function resolveWorkspaceReviewerDisplayNames(workspaceId: string, uids: readonly string[]): Promise<Map<string, string>> {
  const uniqueUids = Array.from(new Set(uids));
  const result = new Map<string, string>();
  if (!adminDb || uniqueUids.length === 0) return result;

  const refs = uniqueUids.map((uid) => adminDb!.collection("workspaceMemberships").doc(computeMembershipId(workspaceId, uid)));
  const snaps = await adminDb.getAll(...refs);

  const evidencedUids: string[] = [];
  for (let i = 0; i < uniqueUids.length; i++) {
    const uid = uniqueUids[i];
    const snap = snaps[i];
    if (!snap.exists) {
      result.set(uid, REVIEWER_UNAVAILABLE_LABEL);
      continue;
    }
    // `active` OR `removed` both count as legitimate historical
    // membership evidence — validateMembershipBinding's own well-formedness
    // + self-consistency check is what fails a malformed document closed.
    const membership = validateMembershipBinding(snap.data(), { workspaceId, uid });
    if (!membership) {
      result.set(uid, REVIEWER_UNAVAILABLE_LABEL);
      continue;
    }
    evidencedUids.push(uid);
  }

  if (evidencedUids.length > 0) {
    // The global resolver is invoked ONLY for the membership-evidenced
    // subset — a non-evidenced uid never reaches `users/{uid}` at all.
    const nameByUid = await resolveReviewerDisplayNames(evidencedUids, new Map(), undefined, REVIEWER_UNAVAILABLE_LABEL);
    for (const uid of evidencedUids) result.set(uid, nameByUid.get(uid) ?? REVIEWER_UNAVAILABLE_LABEL);
  }

  return result;
}
