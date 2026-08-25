/**
 * Approval Workflow, Phase 9C.1-R1C — the bounded, PAGINATED "list every
 * active Team Workspace this uid belongs to" read model, backing
 * `GET /api/workspaces` and the Reviews multi-Workspace chooser
 * (`resolveViewerTeamWorkspaceSelection()`'s `"multiple"` result). Every
 * Workspace is reachable through pagination — no fixed cap silently
 * truncates a uid's real membership set the way the removed
 * `resolveViewerTeamWorkspaceId()`'s `.limit(10)` did.
 *
 * ORDERING, DELIBERATELY NOT `createdAt`: this query filters on two
 * equality clauses (`uid ==`, `status ==`), which Cloud Firestore
 * supports with only its automatic single-field indexes — no composite
 * index required. Adding `.orderBy("createdAt")` to that same query WOULD
 * require a new composite index (`uid`, `status`, `createdAt`), which
 * this phase is not authorized to add or deploy. Ordering instead by
 * `FieldPath.documentId()` is Firestore's documented index-free
 * pagination mechanism — combining equality filters with an `__name__`
 * order never needs a composite index, and every `workspaceMemberships`
 * document id is a stable SHA-256 derivation of `(workspaceId, uid)`
 * (`computeMembershipId()`), so this order is exactly as deterministic
 * and exactly as safe to expose as an opaque cursor as `createdAt` +
 * `workspaceId` tie-break would have been. The one tradeoff: fetch/cursor
 * order is not chronological — mitigated by sorting each already-fetched
 * PAGE's items by display name before returning (cosmetic only; it never
 * changes which Workspaces are on which page, only their order within
 * one page's response).
 *
 * Response fields are deliberately minimal (`workspaceId`, `name` only)
 * — no role, no capability array, no owner uid, no member list, no
 * invitation/billing/rollout data. This is a selection surface, never a
 * Workspace authorization shortcut: every subsequent queue/read request
 * still authorizes the selected Workspace independently via
 * `resolveTeamRunWorkspaceAccess()`.
 */

import "server-only";
import { FieldPath } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { validateSelfConsistentMembership } from "./membershipBinding";
import { isWellFormedWorkspaceV1 } from "./types";

export const VIEWER_WORKSPACE_LIST_DEFAULT_PAGE_SIZE = 20;
export const VIEWER_WORKSPACE_LIST_MAX_PAGE_SIZE = 50;

export interface ViewerTeamWorkspaceListItem {
  workspaceId: string;
  name: string;
}

export type ListViewerTeamWorkspacesResult =
  | { status: "ok"; items: ViewerTeamWorkspaceListItem[]; hasMore: boolean; nextCursor: string | null }
  | { status: "lookup_failed" };

export async function listViewerTeamWorkspaces(args: { uid: string; cursor?: string | null; limit?: number }): Promise<ListViewerTeamWorkspacesResult> {
  if (!adminDb) return { status: "lookup_failed" };
  const db = adminDb;
  const pageSize = Math.min(VIEWER_WORKSPACE_LIST_MAX_PAGE_SIZE, Math.max(1, args.limit ?? VIEWER_WORKSPACE_LIST_DEFAULT_PAGE_SIZE));

  try {
    let query = db.collection("workspaceMemberships").where("uid", "==", args.uid).where("status", "==", "active").orderBy(FieldPath.documentId()).limit(pageSize);
    if (args.cursor) {
      query = query.startAfter(args.cursor);
    }

    const snap = await query.get();
    const hasMore = snap.docs.length === pageSize;
    const nextCursor = hasMore && snap.docs.length > 0 ? snap.docs[snap.docs.length - 1].id : null;

    const validMemberships = snap.docs.map((d) => validateSelfConsistentMembership(d.data(), args.uid)).filter((m): m is NonNullable<typeof m> => m !== null);

    if (validMemberships.length === 0) {
      return { status: "ok", items: [], hasMore, nextCursor };
    }

    // Batched, deduplicated Workspace-document read — never one `get()`
    // per membership.
    const workspaceRefs = validMemberships.map((m) => db.collection("workspaces").doc(m.workspaceId));
    const workspaceSnaps = await db.getAll(...workspaceRefs);

    const items: ViewerTeamWorkspaceListItem[] = [];
    for (let i = 0; i < validMemberships.length; i++) {
      const wsSnap = workspaceSnaps[i];
      if (!wsSnap.exists) continue;
      const data = wsSnap.data();
      if (!isWellFormedWorkspaceV1(data)) continue;
      if (data.id !== validMemberships[i].workspaceId) continue;
      if (data.type !== "team") continue; // workspaceMemberships is Team-only; defensive, never trusted blindly.
      items.push({ workspaceId: validMemberships[i].workspaceId, name: data.name });
    }

    items.sort((a, b) => a.name.localeCompare(b.name));

    return { status: "ok", items, hasMore, nextCursor };
  } catch (err) {
    logger.warn("[workspaces/listViewerTeamWorkspaces] list failed", { uid: args.uid, error: err instanceof Error ? err.message : String(err) });
    return { status: "lookup_failed" };
  }
}
