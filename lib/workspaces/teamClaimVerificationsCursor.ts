/**
 * TEAM-VERIFICATION-PARITY-R3 — opaque pagination cursor for the Team Claim
 * verification lists (`timestamp DESC, documentId DESC`).
 *
 * Carries ONLY the ordering position of the last scanned document — never a
 * Workspace, Project, uid, capability or scope. The list scope is always
 * rebuilt from the addressed URL. Encoding, versioning and strict
 * seconds/nanoseconds/document-id validation are the established, reviewed
 * `workspaceRunsCursor` codec; this module only names the ordering field for
 * the `verifications` collection (`timestamp`, not `createdAt`).
 */

import { decodeWorkspaceRunsCursor, encodeWorkspaceRunsCursor } from "./workspaceRunsCursor";

export interface TeamClaimVerificationsCursor {
  timestampSeconds: number;
  timestampNanoseconds: number;
  lastDocId: string;
}

export function encodeTeamClaimVerificationsCursor(cursor: TeamClaimVerificationsCursor): string {
  return encodeWorkspaceRunsCursor({ createdAtSeconds: cursor.timestampSeconds, createdAtNanoseconds: cursor.timestampNanoseconds, lastDocId: cursor.lastDocId });
}

export function decodeTeamClaimVerificationsCursor(raw: string | null | undefined): { ok: true; cursor: TeamClaimVerificationsCursor } | { ok: false } {
  const decoded = decodeWorkspaceRunsCursor(raw);
  if (!decoded.ok) return { ok: false };
  return { ok: true, cursor: { timestampSeconds: decoded.cursor.createdAtSeconds, timestampNanoseconds: decoded.cursor.createdAtNanoseconds, lastDocId: decoded.cursor.lastDocId } };
}
