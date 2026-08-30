/**
 * Team Workspace Self-Service Onboarding — the Workspace member-list read
 * model backing `GET /api/workspaces/{workspaceId}/members`. Deliberately
 * NOT `reviewerCandidates.ts` (that module is scoped to run-qualified
 * reviewer eligibility, not a general directory) — this is the first
 * genuine "list every active member of this Workspace" surface.
 *
 * Read-only: zero writes. Authorization is the caller's responsibility
 * (`resolveWorkspaceAccess()` + `members.read`, matching every other
 * read-only Team route's convention, e.g.
 * `app/api/workspaces/[workspaceId]/projects/route.ts`'s GET handler) —
 * this module only assumes a caller who has ALREADY passed that gate.
 *
 * Bounded read, same discipline as `reviewerCandidates.ts`: no documented
 * product-level membership-count cap exists, so this module imposes its
 * own defensive `MAX_MEMBERS_SCANNED` limit on the query itself (a plain
 * two-equality-clause query Firestore's automatic indexing already
 * supports) rather than an unbounded collection scan.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { validateMembershipBinding } from "./membershipBinding";
import { isCanonicalTeamOwnerMembership } from "./ownerInvariant";
import type { TeamWorkspaceV1 } from "./types";
import type { WorkspaceMembershipRole } from "./membershipTypes";
import { resolveReviewerDisplayNames, REVIEWER_UNAVAILABLE_LABEL } from "@/lib/governance/reviewerIdentity";

const MAX_MEMBERS_SCANNED = 200;

/** Deterministic display ordering — Owner first, then descending seniority, stable secondary sort by display name. Never Firestore's incidental order. */
const ROLE_SORT_ORDER: Readonly<Record<WorkspaceMembershipRole, number>> = { owner: 0, admin: 1, member: 2, reviewer: 3, viewer: 4 };

export interface WorkspaceMemberDto {
  uid: string;
  displayName: string;
  role: WorkspaceMembershipRole;
  /** True only when this row passes the full `isCanonicalTeamOwnerMembership()` invariant — never merely `role === "owner"`. A corrupt extra "owner"-role row is still listed (fail-visible, not hidden), but never badged as canonical Owner. */
  isCanonicalOwner: boolean;
  joinedAt: string;
}

export type ListWorkspaceMembersResult = { status: "listed"; members: WorkspaceMemberDto[] } | { status: "firestore_unavailable" } | { status: "query_failed" };

/**
 * `workspace` must already be the caller's own resolved, authorized
 * `TeamWorkspaceV1` (from `resolveWorkspaceAccess()`) — this function
 * never re-reads or re-authorizes the Workspace itself, only its
 * memberships.
 */
export async function listWorkspaceMembers(args: { workspace: TeamWorkspaceV1 }): Promise<ListWorkspaceMembersResult> {
  if (!adminDb) return { status: "firestore_unavailable" };
  const db = adminDb;
  const workspaceId = args.workspace.id;

  try {
    const snap = await db.collection("workspaceMemberships").where("workspaceId", "==", workspaceId).where("status", "==", "active").limit(MAX_MEMBERS_SCANNED).get();

    const validated: { uid: string; role: WorkspaceMembershipRole; isCanonicalOwner: boolean; joinedAt: string }[] = [];
    for (const doc of snap.docs) {
      const raw = doc.data() as Record<string, unknown>;
      // Discovered via query, not a known-uid lookup — `raw.uid` is
      // untrusted here, same discipline as reviewerCandidates.ts.
      const membership = typeof raw.uid === "string" ? validateMembershipBinding(raw, { workspaceId, uid: raw.uid }) : null;
      if (!membership) continue;
      validated.push({
        uid: membership.uid,
        role: membership.role,
        isCanonicalOwner: isCanonicalTeamOwnerMembership({ workspace: args.workspace, membership }),
        joinedAt: membership.createdAt.toDate().toISOString(),
      });
    }

    const uids = validated.map((m) => m.uid);
    const nameByUid = uids.length > 0 ? await resolveReviewerDisplayNames(uids, new Map(), undefined, REVIEWER_UNAVAILABLE_LABEL) : new Map<string, string>();

    const members: WorkspaceMemberDto[] = validated
      .map((m) => ({
        uid: m.uid,
        displayName: nameByUid.get(m.uid) ?? REVIEWER_UNAVAILABLE_LABEL,
        role: m.role,
        isCanonicalOwner: m.isCanonicalOwner,
        joinedAt: m.joinedAt,
      }))
      .sort((a, b) => {
        const roleDelta = ROLE_SORT_ORDER[a.role] - ROLE_SORT_ORDER[b.role];
        if (roleDelta !== 0) return roleDelta;
        return a.displayName.localeCompare(b.displayName) || a.uid.localeCompare(b.uid);
      });

    return { status: "listed", members };
  } catch (err) {
    logger.warn("[workspaces/listWorkspaceMembers] query failed", { workspaceId, error: err instanceof Error ? err.message : String(err) });
    return { status: "query_failed" };
  }
}
