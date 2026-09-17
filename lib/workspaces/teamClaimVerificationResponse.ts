/**
 * TEAM-VERIFICATION-PARITY-R3 — the ONE concealed "not found" body for a Team
 * Claim verification detail read. Reuses the existing verification read
 * vocabulary (`not_found` / "Claim not found.") so a missing artifact, a
 * Personal artifact, a foreign-Workspace artifact, a malformed row, a wrong
 * Project address and a malformed id are indistinguishable.
 */

export function teamClaimVerificationNotFoundConcealedResponse(): { status: number; body: { ok: false; errorCode: "not_found"; message: string } } {
  return { status: 404, body: { ok: false, errorCode: "not_found", message: "Claim not found." } };
}
