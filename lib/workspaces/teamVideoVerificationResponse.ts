/**
 * TEAM-VERIFICATION-PARITY-R5-I1 — the ONE concealed "not found" body for a
 * Team Video verification detail read.
 *
 * Every distinguishable failure of a Team-native Video detail read collapses
 * to this single response so none of them can be told apart:
 *
 *   - the document does not exist
 *   - the verification id is malformed (no Firestore read is even attempted)
 *   - the artifact is a PERSONAL Video row (no Team binding at all)
 *   - the artifact belongs to a DIFFERENT Workspace
 *   - the artifact's Team binding is malformed (absent/bad projectId, wrong
 *     `type`, non-Timestamp `timestamp`, empty `userId`)
 *   - the optional `?projectId` containment assertion does not match
 *   - the `?projectId` query value is itself malformed
 *   - the filed Project belongs to another Workspace (integrity anomaly)
 *
 * Deliberately NOT shared with the Claim helper: the copy differs ("Video
 * verification not found.") and, per R5-D0 §V, a little duplication is
 * preferred over reopening Production-stable Claim code.
 */

export function teamVideoVerificationNotFoundConcealedResponse(): { status: number; body: { ok: false; errorCode: "not_found"; message: string } } {
  return { status: 404, body: { ok: false, errorCode: "not_found", message: "Video verification not found." } };
}
