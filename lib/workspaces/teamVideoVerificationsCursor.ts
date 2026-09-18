/**
 * TEAM-VERIFICATION-PARITY-R5-I1 — opaque pagination cursor for the Team Video
 * verification lists (`timestamp DESC, documentId DESC`).
 *
 * Carries ONLY the ordering position of the last scanned document — never a
 * Workspace, Project, scope, uid, role or capability. The list scope is always
 * rebuilt from the addressed URL, so a cursor lifted from one list can never
 * widen, narrow or re-target another. Encoding, versioning and strict
 * seconds/nanoseconds/document-id validation are the established, reviewed
 * `workspaceRunsCursor` codec; this module only names the ordering field for
 * the `videoVerifications` collection (`timestamp`, not `createdAt`), exactly
 * as `teamClaimVerificationsCursor` does for `verifications`.
 */

import { decodeWorkspaceRunsCursor, encodeWorkspaceRunsCursor } from "./workspaceRunsCursor";

export interface TeamVideoVerificationsCursor {
  timestampSeconds: number;
  timestampNanoseconds: number;
  lastDocId: string;
}

export function encodeTeamVideoVerificationsCursor(cursor: TeamVideoVerificationsCursor): string {
  return encodeWorkspaceRunsCursor({ createdAtSeconds: cursor.timestampSeconds, createdAtNanoseconds: cursor.timestampNanoseconds, lastDocId: cursor.lastDocId });
}

export function decodeTeamVideoVerificationsCursor(raw: string | null | undefined): { ok: true; cursor: TeamVideoVerificationsCursor } | { ok: false } {
  const decoded = decodeWorkspaceRunsCursor(raw);
  if (!decoded.ok) return { ok: false };
  return { ok: true, cursor: { timestampSeconds: decoded.cursor.createdAtSeconds, timestampNanoseconds: decoded.cursor.createdAtNanoseconds, lastDocId: decoded.cursor.lastDocId } };
}
