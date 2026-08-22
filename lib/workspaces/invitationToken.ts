/**
 * Team Workspace Invitations, Phase 8D.1 — bearer-token generation,
 * hashing, and verification for invitation acceptance. The raw token is
 * the ONLY secret material in the invitation flow; only its SHA-256 hash
 * is ever persisted (see `lib/firestore/workspaceInvitations.ts`). Nothing
 * in this module logs, persists, or otherwise retains a raw token beyond
 * the caller's own local variable.
 */

import "server-only";
import { randomBytes, createHash, timingSafeEqual } from "crypto";

const TOKEN_HASH_SHAPE = /^[0-9a-f]{64}$/;

/** 256 bits of randomness (`crypto.randomBytes(32)`), base64url-encoded — never `Math.random()`, `Date`-derived, `randomUUID()` (only 122 bits, fixed-format), or a Firestore auto-id. */
export function generateWorkspaceInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of the raw token, lowercase hex — the only form ever persisted. */
export function hashWorkspaceInvitationToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** Structural shape check only — 64 lowercase-hex characters (a SHA-256 digest). Does not confirm the hash was derived from any particular token. */
export function isWellFormedInvitationTokenHash(value: unknown): value is string {
  return typeof value === "string" && TOKEN_HASH_SHAPE.test(value);
}

/**
 * Timing-safe verification — never a plain `===`/string comparison for
 * token-secret material. A malformed stored hash (wrong shape/length)
 * fails closed rather than throwing or falling back to a weaker
 * comparison; `Buffer.byteLength` equality is checked before
 * `timingSafeEqual()` is ever called, since that function throws on
 * mismatched buffer lengths rather than returning `false`.
 */
export function verifyWorkspaceInvitationToken(args: { rawToken: string; storedTokenHash: string }): boolean {
  if (!isWellFormedInvitationTokenHash(args.storedTokenHash)) return false;
  const computed = Buffer.from(hashWorkspaceInvitationToken(args.rawToken), "hex");
  const stored = Buffer.from(args.storedTokenHash, "hex");
  if (computed.byteLength !== stored.byteLength) return false;
  return timingSafeEqual(computed, stored);
}
