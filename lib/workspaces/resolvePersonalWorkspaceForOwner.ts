/**
 * Phase 5B — full canonical Personal Workspace resolution for the
 * authenticated caller's own uid, used by `GET /api/user/workspace` and
 * `GET /api/user/workspace/runs`. Deliberately reuses `getWorkspace()`
 * (Phase 1) and `getPersonalWorkspaceId()` (Phase 2) verbatim rather than
 * re-implementing document-shape validation — `getWorkspace()` already
 * checks existence, structural well-formedness (`schemaVersion`, `id`,
 * `type` enum, `ownerUserId` non-empty), and that the document's own `id`
 * field matches the Firestore document id it was read at. The two checks
 * this module adds on top are the ones `getWorkspace()` deliberately does
 * NOT make on its own, because they're caller-specific, not
 * document-shape-generic: that `ownerUserId` equals THIS caller's uid, and
 * that `type` is specifically `"personal"` (a well-formed `"team"`
 * Workspace is valid data in general, but never a valid answer to "this
 * caller's Personal Workspace").
 */

import "server-only";
import { WORKSPACES_ENABLED } from "@/lib/env";
import { getWorkspace } from "@/lib/firestore/workspaces";
import { getPersonalWorkspaceId } from "./personalWorkspaceId";
import type { WorkspaceV1 } from "./types";

export type ResolvePersonalWorkspaceForOwnerResult =
  | { status: "found"; workspace: WorkspaceV1 }
  | { status: "workspaces_disabled" }
  | { status: "invalid_uid" }
  | { status: "not_found" }
  | { status: "malformed" }
  | { status: "wrong_owner" }
  | { status: "wrong_type" }
  | { status: "lookup_failed" };

export async function resolvePersonalWorkspaceForOwner(uid: string): Promise<ResolvePersonalWorkspaceForOwnerResult> {
  if (!WORKSPACES_ENABLED) {
    return { status: "workspaces_disabled" };
  }

  const idResult = getPersonalWorkspaceId(uid);
  if (!idResult.ok) {
    return { status: "invalid_uid" };
  }

  const lookup = await getWorkspace(idResult.workspaceId);
  switch (lookup.status) {
    case "not_found":
      return { status: "not_found" };
    case "malformed":
      return { status: "malformed" };
    case "firestore_unavailable":
    case "read_failed":
      return { status: "lookup_failed" };
    case "found": {
      const workspace = lookup.workspace;
      if (workspace.ownerUserId !== uid) {
        return { status: "wrong_owner" };
      }
      if (workspace.type !== "personal") {
        return { status: "wrong_type" };
      }
      return { status: "found", workspace };
    }
  }
}
