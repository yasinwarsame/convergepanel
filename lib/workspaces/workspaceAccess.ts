/**
 * Workspace Compatibility Foundation, Phase 1 — the central access-check
 * layer, deliberately separate from `workspaceResolver.ts`. Resolution
 * answers "which ownership model, and who owns it"; this module answers
 * "is THIS uid allowed in." Keeping them apart means an authorization bug
 * can never masquerade as a resolution bug or vice versa, and matches this
 * program's explicit rule: never authorize solely because a request
 * contains a workspaceId, a UI selected a workspace, or a client claims
 * membership — access is always computed here, from server-resolved state.
 *
 * Not currently called by any route in Phase 1.
 */

import "server-only";
import { resolveWorkspaceContextForResource } from "./workspaceResolver";
import type { WorkspaceContext, WorkspaceAccessVerdict, WorkspaceResourceAccessOutcome } from "./types";

/**
 * Pure. Phase 1's entire access model, for both `legacy` and `workspace`
 * (personal) modes: exact owner-uid equality. No membership, no roles, no
 * delegation exist yet for either mode — see PERSONAL WORKSPACE OWNERSHIP
 * in the program spec and docs/workspaces/architecture.md.
 */
export function checkWorkspaceAccess(uid: string, context: WorkspaceContext): WorkspaceAccessVerdict {
  if (context.ownerUserId === uid) {
    return { granted: true };
  }
  return { granted: false, reason: "not_owner" };
}

/**
 * The single route-facing entry point later phases should call: resolves
 * the resource's workspace context (performing the one Firestore read that
 * requires), then checks access, and collapses both into one verdict. A
 * resolution failure (`not_found` / `malformed` / `unsupported_workspace_type`
 * / `lookup_failed`) is always a denial here — it is never reinterpreted as
 * "fall back to legacy and check owner equality anyway." That reinterpretation
 * is exactly the downgrade attack this module exists to prevent.
 */
export async function authorizeWorkspaceResourceAccess(args: {
  uid: string;
  workspaceId: string | null | undefined;
  legacyOwnerUserId: string;
}): Promise<WorkspaceResourceAccessOutcome> {
  const resolution = await resolveWorkspaceContextForResource({
    workspaceId: args.workspaceId,
    legacyOwnerUserId: args.legacyOwnerUserId,
  });

  switch (resolution.kind) {
    case "legacy":
    case "resolved": {
      const verdict = checkWorkspaceAccess(args.uid, resolution.context);
      if (verdict.granted) {
        return { granted: true, context: resolution.context };
      }
      return { granted: false, reason: "not_owner" };
    }
    case "not_found":
      return { granted: false, reason: "workspace_not_found" };
    case "malformed":
      return { granted: false, reason: "workspace_malformed" };
    case "unsupported_workspace_type":
      return { granted: false, reason: "unsupported_workspace_type" };
    case "lookup_failed":
      return { granted: false, reason: "lookup_failed" };
  }
}
