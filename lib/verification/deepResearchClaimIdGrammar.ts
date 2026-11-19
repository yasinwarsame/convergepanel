/**
 * The ONE grammar of a Deep Research claim id, `v1:<section>:<index>:<fingerprint>`,
 * as issued by `buildDeepResearchClaimId()` (lib/verification/claimVerificationOrigin.ts).
 *
 * Pure and dependency-free so it can be shared by the server-only parser
 * (`parseDeepResearchClaimId`) and client code that must recognise a real claim
 * id without loading the resolver (the pre-telemetry URL scrub,
 * lib/privacy/urlParamRules.ts). Changing it changes both.
 */

/** Hard bound checked BEFORE parsing — the fingerprint segment is fixed-length, but the index segment is attacker-controlled text, so an unbounded string must never reach the regex engine or `Number()`. Real selectors are at most 85 characters (`lowConfidenceFindings` + a 16-digit safe-integer index); 128 is generous headroom without being unbounded. */
export const MAX_DEEP_RESEARCH_CLAIM_ID_LENGTH = 128;

/**
 * `v1:<section>:<index>:<fingerprint>`. The index alternation
 * `(0|[1-9]\d*)` structurally rejects leading zeros ("01", "0002"),
 * a leading minus sign, decimal points, scientific notation, and
 * whitespace — all fail the anchored match outright, never reaching
 * `Number()`. The fingerprint segment is exactly 43 base64url characters
 * (no more, no less) — anything else fails to match.
 */
export const DEEP_RESEARCH_CLAIM_ID_PATTERN = /^v1:(findings|lowConfidenceFindings):(0|[1-9]\d*):([A-Za-z0-9_-]{43})$/;

/**
 * True exactly when `value` is a claim id the builder could have issued: length
 * bound, the anchored pattern, and a safe-integer index (the builder refuses any
 * other index). Never throws.
 */
export function isDeepResearchClaimIdShape(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DEEP_RESEARCH_CLAIM_ID_LENGTH) return false;
  const match = DEEP_RESEARCH_CLAIM_ID_PATTERN.exec(value);
  return match !== null && Number.isSafeInteger(Number(match[2]));
}
