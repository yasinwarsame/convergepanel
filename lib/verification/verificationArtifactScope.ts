/**
 * TEAM-VERIFICATION-PARITY-R1 — the ONE structural scope rule for stored
 * Claim (`verifications`) and Video (`videoVerifications`) artifacts.
 *
 * Personal and Team artifacts share both collections. The discriminator is
 * FIELD PRESENCE, never value:
 *
 *   - the Team writers (`lib/firestore/teamClaimVerifications.ts`,
 *     `lib/firestore/teamVideoVerifications.ts`) ALWAYS persist `workspaceId`
 *     (and `projectId`, null or string);
 *   - the Personal writers (`app/api/verify-claim/route.ts` via
 *     `saveClaimVerification`, `app/api/verify-video/route.ts`) NEVER persist
 *     `workspaceId`.
 *
 * So a row that carries a `workspaceId` field at all — even `null`, `""`, or
 * a malformed value — is Workspace-bound and must never be consumed by a
 * Personal or legacy-governance surface. Truthiness or `typeof === "string"`
 * would let a malformed Workspace-bound row leak back in as Personal.
 *
 * This is a SCOPE boundary, not authorization: it never grants access to
 * anything. It does not look at `projectId` (a Personal origin-linked Claim
 * may carry one), the owner, the artifact id prefix, reviewers or assignment.
 *
 * Pure: no Firestore, auth, React or network.
 */

/** True when the stored artifact carries a `workspaceId` field in any form. */
export function isWorkspaceBoundVerificationArtifact(data: unknown): boolean {
  return typeof data === "object" && data !== null && Object.prototype.hasOwnProperty.call(data, "workspaceId");
}

/** True only for a document-like object with NO `workspaceId` field. */
export function isPersonalVerificationArtifact(data: unknown): boolean {
  return typeof data === "object" && data !== null && !Object.prototype.hasOwnProperty.call(data, "workspaceId");
}
