/**
 * Team Workspace Invitations, Phase 8D.1 — the ONE canonical invitation
 * email normalization/validation function. Every invitation operation
 * (create, guard-key derivation, resend target lookup, acceptance email
 * match, list) must derive its normalized email through this function so
 * no two call sites can ever produce a differently-normalized value for
 * the same input.
 *
 * Semantics are deliberately minimal, mirroring `isAdminEmail()`'s existing
 * `.trim().toLowerCase()` precedent (`lib/admin/config.ts`) — no Gmail
 * dot/plus-addressing normalization, no domain rewriting, no IDN handling.
 * Plus-addressing and dots are part of the local part's literal identity
 * and are preserved exactly, never stripped. The format check is a
 * deliberately minimal shape guard, not full RFC 5322 validation — it only
 * needs to reject obviously-malformed input, not exhaustively validate
 * every edge case of the email grammar.
 */

import "server-only";

/** RFC 5321's practical maximum address length. Longer request input is rejected before it is examined (S0, CodeQL #1). */
export const MAX_INVITATION_EMAIL_LENGTH = 254;

const WHITESPACE = /\s/;

/**
 * The "local@domain.tld" shape guard: exactly one "@", no whitespace, a non-empty local part, and a "." in the
 * domain with at least one character on each side. It accepts exactly what the former
 * `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` accepted, in linear time: that regex backtracked polynomially on long
 * non-matching input (CodeQL js/polynomial-redos).
 */
function hasEmailShape(value: string): boolean {
  if (WHITESPACE.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || value.indexOf("@", at + 1) !== -1) return false;
  const domain = value.slice(at + 1);
  const dot = domain.indexOf(".", 1);
  return dot !== -1 && dot < domain.length - 1;
}

export type NormalizeInvitationEmailResult = { ok: true; normalizedEmail: string } | { ok: false };

/** Trims, lowercases, and validates. Accepts arbitrary unknown input — request bodies and Firebase Auth records are `unknown` at this boundary, never blind-cast. */
export function normalizeInvitationEmail(input: unknown): NormalizeInvitationEmailResult {
  if (typeof input !== "string") return { ok: false };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false };
  if (trimmed.length > MAX_INVITATION_EMAIL_LENGTH) return { ok: false };
  const normalized = trimmed.toLowerCase();
  if (!hasEmailShape(normalized)) return { ok: false };
  return { ok: true, normalizedEmail: normalized };
}

/** Structural guard for a value already claimed to be a canonical normalized invitation email (e.g. read back from Firestore) — confirms it is trimmed, lowercased, and shape-valid, without re-deriving it from a raw input. */
export function isValidNormalizedInvitationEmail(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value !== value.trim().toLowerCase()) return false;
  return hasEmailShape(value);
}
