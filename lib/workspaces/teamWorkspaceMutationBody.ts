/**
 * Team Workspace Core Foundation, Phase 8B — strict request-body parsing
 * for the Team Workspace creation and ownership-transfer routes.
 * Structural mirror of `lib/projects/projectMutationBody.ts`: a request
 * body containing ANY key beyond the exact allowed set is rejected
 * outright (400), never silently ignored.
 */

import "server-only";

export type ParseCreateTeamWorkspaceBodyResult = { ok: true; name: unknown } | { ok: false; reason: "invalid_body" | "unknown_field" };

const CREATE_ALLOWED_KEYS = new Set(["name"]);

export function parseCreateTeamWorkspaceBody(raw: unknown): ParseCreateTeamWorkspaceBodyResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "invalid_body" };
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!CREATE_ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: "unknown_field" };
    }
  }
  return { ok: true, name: body.name };
}

export type ParseTransferOwnershipBodyResult =
  | { ok: true; newOwnerUid: unknown; expectedWorkspaceUpdateTime: unknown; expectedOldOwnerMembershipUpdateTime: unknown; expectedNewOwnerMembershipUpdateTime: unknown }
  | { ok: false; reason: "invalid_body" | "unknown_field" };

const TRANSFER_ALLOWED_KEYS = new Set(["newOwnerUid", "expectedWorkspaceUpdateTime", "expectedOldOwnerMembershipUpdateTime", "expectedNewOwnerMembershipUpdateTime"]);

/**
 * The three `expected*UpdateTime` fields are ALL required — never
 * defaulted, never optional. This route accepts no partial-OCC request;
 * every one of the three documents this operation writes must carry its
 * own caller-supplied precondition.
 */
export function parseTransferOwnershipBody(raw: unknown): ParseTransferOwnershipBodyResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "invalid_body" };
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!TRANSFER_ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: "unknown_field" };
    }
  }
  return {
    ok: true,
    newOwnerUid: body.newOwnerUid,
    expectedWorkspaceUpdateTime: body.expectedWorkspaceUpdateTime,
    expectedOldOwnerMembershipUpdateTime: body.expectedOldOwnerMembershipUpdateTime,
    expectedNewOwnerMembershipUpdateTime: body.expectedNewOwnerMembershipUpdateTime,
  };
}
