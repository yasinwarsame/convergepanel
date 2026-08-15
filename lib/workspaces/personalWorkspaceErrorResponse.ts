/**
 * Phase 5B — shared sanitized error mapping for
 * `ResolvePersonalWorkspaceForOwnerResult`, reused by both
 * `GET /api/user/workspace` and `GET /api/user/workspace/runs` so the two
 * endpoints report identical, consistent outward semantics for the same
 * underlying failure — never a raw Firebase error, never which of the
 * three integrity checks (malformed/wrong_owner/wrong_type) specifically
 * failed.
 */

import type { ResolvePersonalWorkspaceForOwnerResult } from "./resolvePersonalWorkspaceForOwner";

export type PersonalWorkspaceErrorBody = { ok: false; errorCode: string; message: string };

export function personalWorkspaceErrorResponse(
  status: Exclude<ResolvePersonalWorkspaceForOwnerResult["status"], "found">
): { status: number; body: PersonalWorkspaceErrorBody } {
  switch (status) {
    case "workspaces_disabled":
      return { status: 503, body: { ok: false, errorCode: "workspace_unavailable", message: "Workspaces are not available right now." } };
    case "invalid_uid":
      return { status: 400, body: { ok: false, errorCode: "workspace_invalid", message: "Unable to load your Workspace." } };
    case "not_found":
      return { status: 404, body: { ok: false, errorCode: "workspace_missing", message: "Your Workspace hasn't been set up yet." } };
    case "malformed":
    case "wrong_owner":
    case "wrong_type":
      return { status: 409, body: { ok: false, errorCode: "workspace_invalid", message: "There's a problem with your Workspace. Please contact support." } };
    case "lookup_failed":
      return { status: 503, body: { ok: false, errorCode: "workspace_unavailable", message: "Couldn't load your Workspace right now. Please try again." } };
  }
}
