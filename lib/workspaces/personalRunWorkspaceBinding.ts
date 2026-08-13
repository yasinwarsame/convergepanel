/**
 * Phase 3 — Workspace-Aware Writes for New Personal Adaptive Runs.
 *
 * The single resolution function deciding whether a NEW run being created
 * right now should be bound to the requesting user's Personal Workspace.
 * Reuses `getPersonalWorkspaceId()` (Phase 2) and `getWorkspace()` (Phase 1)
 * verbatim — no reimplemented id-construction, schema validation, or
 * conflict logic. Crucially, this module NEVER calls
 * `ensurePersonalWorkspace()` — run creation must not provision a Workspace
 * as a side effect (see docs/workspaces/architecture.md's Phase 3 section,
 * "Absolutely no auto-provisioning on run creation"). A missing Workspace
 * is a `resolution_failed` outcome, never a trigger to create one.
 *
 * `hasTeam` is supplied by the caller (via `loadUserAndTeam(uid)`, the same
 * canonical team-membership check already used elsewhere in the run-panel
 * route for team-vs-personal routing) rather than re-derived here, keeping
 * this module's own I/O to a single `getWorkspace()` call and trivially
 * mockable in tests.
 */

import "server-only";
import { getWorkspace } from "@/lib/firestore/workspaces";
import { getPersonalWorkspaceId } from "./personalWorkspaceId";
import { checkPersonalRunWorkspaceWriteConfiguration } from "./personalRunWorkspaceWriteConfig";

export type PersonalRunWorkspaceResolutionFailureReason = "invalid_uid" | "not_found" | "malformed" | "wrong_owner" | "wrong_type" | "lookup_failed";

export type PersonalRunWorkspaceBindingResult =
  | { outcome: "flag_off" }
  | { outcome: "invalid_configuration"; reason: "workspaces_disabled_but_writes_enabled" }
  | { outcome: "team_user" }
  | { outcome: "bound"; workspaceId: string }
  | { outcome: "resolution_failed"; reason: PersonalRunWorkspaceResolutionFailureReason };

export async function resolvePersonalRunWorkspaceBinding(args: {
  uid: string;
  writesEnabled: boolean;
  workspacesEnabled: boolean;
  hasTeam: boolean;
}): Promise<PersonalRunWorkspaceBindingResult> {
  if (!args.writesEnabled) {
    return { outcome: "flag_off" };
  }

  const configCheck = checkPersonalRunWorkspaceWriteConfiguration({
    workspacesEnabled: args.workspacesEnabled,
    writesEnabled: args.writesEnabled,
  });
  if (!configCheck.ok) {
    return { outcome: "invalid_configuration", reason: configCheck.reason };
  }

  // Team runs never get a Personal Workspace binding — team Workspace
  // mapping is explicitly out of scope for Phase 3 (see architecture doc).
  // This is not a failure; it's simply not applicable.
  if (args.hasTeam) {
    return { outcome: "team_user" };
  }

  const idResult = getPersonalWorkspaceId(args.uid);
  if (!idResult.ok) {
    return { outcome: "resolution_failed", reason: "invalid_uid" };
  }

  const lookup = await getWorkspace(idResult.workspaceId);
  switch (lookup.status) {
    case "not_found":
      return { outcome: "resolution_failed", reason: "not_found" };
    case "malformed":
      return { outcome: "resolution_failed", reason: "malformed" };
    case "firestore_unavailable":
    case "read_failed":
      return { outcome: "resolution_failed", reason: "lookup_failed" };
    case "found": {
      const workspace = lookup.workspace;
      if (workspace.type !== "personal") {
        return { outcome: "resolution_failed", reason: "wrong_type" };
      }
      if (workspace.ownerUserId !== args.uid) {
        return { outcome: "resolution_failed", reason: "wrong_owner" };
      }
      return { outcome: "bound", workspaceId: idResult.workspaceId };
    }
  }
}
