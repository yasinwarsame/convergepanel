/**
 * Workspace-Scoped Team Canary, Phase 10B.3.1 — the shared bounded
 * "which Workspace-canary-admitted Workspaces does this uid actively
 * belong to" primitive, backing both `GET /api/workspaces`'s
 * Workspace-canary discovery branch (Mode B) and
 * `workspaceReviewsUiEnabledFor()`'s nav-hint boolean. Deliberately
 * separate from `listViewerTeamWorkspaces()`/
 * `resolveViewerTeamWorkspaceSelection()`, which answer the SAME shape of
 * question for the USER-scoped (global/uid-canary) population via an
 * unbounded-but-paginated/bounded-scan `.where("uid","==",uid)` query —
 * that query has no way to additionally restrict itself to "only
 * Workspaces in the canary allowlist" without a composite index. This
 * module instead starts from the (small, ≤10) allowlist itself and does
 * deterministic point reads, exactly the "compute the doc id, don't
 * query" pattern `listViewerTeamWorkspaces.ts`'s own doc comment
 * documents as the reason `workspaceMemberships` ids are derived rather
 * than random.
 *
 * `resolveWorkspaceCanaryMembershipsForUid()` is the narrow core: it
 * returns only the workspaceIds themselves, doing the minimum possible
 * I/O (at most `MAX_TEAM_WORKSPACE_CANARY_WORKSPACE_IDS` membership point
 * reads, zero Workspace-document reads) — sufficient for a boolean nav
 * hint, which needs to know "does at least one exist," never a Workspace
 * name or any other Workspace-level field. `listWorkspaceCanaryMembershipsForUid()`
 * additionally batch-reads and validates the surviving Workspace
 * documents (mirroring `listViewerTeamWorkspaces()`'s own exact
 * existence/well-formedness/id-binding/type checks) to produce the
 * `{workspaceId, name}` pairs `GET /api/workspaces` needs to return.
 *
 * Malformed-candidate handling: a malformed or binding-mismatched
 * membership candidate is SKIPPED, not treated as a hard failure for the
 * whole discovery — this mirrors `listViewerTeamWorkspaces()`'s own
 * existing precedent exactly (`.filter((m) => m !== null)` there, not an
 * abort). This is safe here specifically because discovery can only ever
 * SHRINK by skipping a bad candidate, never grant access to anything —
 * unlike, say, capacity bootstrap counting, where undercounting has a
 * real security consequence, skipping a malformed candidate here just
 * means "this one Workspace doesn't show up," never "an unentitled
 * Workspace shows up."
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { parseTeamWorkspaceCanaryWorkspaceIds } from "./teamWorkspaceTargetAdmission";
import { computeMembershipId } from "./membershipId";
import { validateMembershipBinding } from "./membershipBinding";
import { isWellFormedWorkspaceV1 } from "./types";

export type ResolveWorkspaceCanaryMembershipsResult = { status: "ok"; workspaceIds: readonly string[] } | { status: "lookup_failed" };

/**
 * Core primitive. An absent/empty/malformed `canaryWorkspaceIdsRaw`
 * returns `{status:"ok", workspaceIds:[]}` — NOT `lookup_failed` — since
 * this is a configuration fact, not an infrastructure failure; every
 * caller must treat an empty result identically whether it came from "no
 * list configured" or "list configured but zero active admitted
 * memberships survived," per the discovery-concealment design (see
 * `GET /api/workspaces`).
 */
export async function resolveWorkspaceCanaryMembershipsForUid(args: { uid: string; canaryWorkspaceIdsRaw: string | undefined }): Promise<ResolveWorkspaceCanaryMembershipsResult> {
  const parsed = parseTeamWorkspaceCanaryWorkspaceIds(args.canaryWorkspaceIdsRaw);
  if (!parsed.ok || parsed.workspaceIds.size === 0) {
    return { status: "ok", workspaceIds: [] };
  }
  if (!adminDb) {
    return { status: "lookup_failed" };
  }
  const db = adminDb;

  const candidates = [...parsed.workspaceIds]; // bounded, ≤ MAX_TEAM_WORKSPACE_CANARY_WORKSPACE_IDS
  const refs = candidates.map((workspaceId) => db.collection("workspaceMemberships").doc(computeMembershipId(workspaceId, args.uid)));

  try {
    const snaps = await db.getAll(...refs);
    const survivors: string[] = [];
    for (let i = 0; i < snaps.length; i++) {
      const snap = snaps[i];
      const expectedWorkspaceId = candidates[i];
      if (!snap.exists) continue;
      const membership = validateMembershipBinding(snap.data(), { workspaceId: expectedWorkspaceId, uid: args.uid });
      if (!membership) continue; // malformed/mismatched — skipped, never broadens
      if (membership.status !== "active") continue;
      survivors.push(expectedWorkspaceId);
    }
    return { status: "ok", workspaceIds: survivors };
  } catch (err) {
    logger.warn("[workspaces/resolveWorkspaceCanaryMembershipsForUid] membership lookup failed", { uid: args.uid, error: err instanceof Error ? err.message : String(err) });
    return { status: "lookup_failed" };
  }
}

export interface WorkspaceCanaryListItem {
  workspaceId: string;
  name: string;
}

export type ListWorkspaceCanaryMembershipsResult = { status: "ok"; items: WorkspaceCanaryListItem[] } | { status: "lookup_failed" };

/**
 * List-shaped extension of the core primitive, for `GET /api/workspaces`'s
 * Workspace-canary branch only — batch-reads and validates the surviving
 * Workspace documents (existence, well-formedness, id-binding, `type ===
 * "team"`), mirroring `listViewerTeamWorkspaces()`'s own exact validation
 * and its cosmetic name-`localeCompare` ordering. Never returns a
 * Workspace merely because its id is allowlisted — only ones the core
 * primitive already proved the caller actively belongs to.
 */
export async function listWorkspaceCanaryMembershipsForUid(args: { uid: string; canaryWorkspaceIdsRaw: string | undefined }): Promise<ListWorkspaceCanaryMembershipsResult> {
  const core = await resolveWorkspaceCanaryMembershipsForUid(args);
  if (core.status !== "ok") {
    return { status: "lookup_failed" };
  }
  if (core.workspaceIds.length === 0) {
    return { status: "ok", items: [] };
  }
  if (!adminDb) {
    return { status: "lookup_failed" };
  }
  const db = adminDb;

  try {
    const refs = core.workspaceIds.map((workspaceId) => db.collection("workspaces").doc(workspaceId));
    const snaps = await db.getAll(...refs);
    const items: WorkspaceCanaryListItem[] = [];
    for (let i = 0; i < snaps.length; i++) {
      const snap = snaps[i];
      const expectedId = core.workspaceIds[i];
      if (!snap.exists) continue;
      const data = snap.data();
      if (!isWellFormedWorkspaceV1(data)) continue;
      if (data.id !== expectedId) continue;
      if (data.type !== "team") continue; // workspaceMemberships is Team-only; defensive, never trusted blindly.
      items.push({ workspaceId: expectedId, name: data.name });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { status: "ok", items };
  } catch (err) {
    logger.warn("[workspaces/resolveWorkspaceCanaryMembershipsForUid] Workspace batch read failed", { uid: args.uid, error: err instanceof Error ? err.message : String(err) });
    return { status: "lookup_failed" };
  }
}
