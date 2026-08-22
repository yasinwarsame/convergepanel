/**
 * Team Workspace Invitations, Phase 8D.1 — the ONE canonical
 * `(workspaceId, normalizedEmail) -> workspaceInvitationKeys/{id}` guard-
 * document-id derivation. Structural mirror of `membershipId.ts`'s
 * `computeMembershipId()` — same domain-separated, length-prefixed,
 * SHA-256 construction — but deliberately its OWN module with its OWN
 * domain separator, hashing a different tuple. `membershipId.ts` itself is
 * never imported or modified here; the two id spaces share a technique,
 * never a domain.
 *
 * See `membershipId.ts`'s own doc comment for the full rationale behind
 * domain separation, length-prefixing (`Buffer.byteLength(str, "utf8")`,
 * never `string.length`), and why SHA-256's role is fixed-length output,
 * not what makes the id space collision-free (the injective length-
 * prefixed serialization already guarantees that).
 *
 * Output shape: `wik_` (4 chars) + 64 lowercase hex chars = 68 characters
 * total, always.
 */

import "server-only";
import { createHash } from "crypto";

const INVITATION_KEY_PREFIX = "wik_";

/**
 * Frozen (Phase 8D.0.1) domain separator, hashed as the first bytes of
 * every invitation guard key — never versioned informally by editing this
 * string in place. A future breaking change to the id algorithm must
 * introduce a NEW separator (e.g. `...v2`), never silently reinterpret
 * `v1`'s already-computed keys.
 */
const DOMAIN_SEPARATOR = "convergepanel.workspace-invitation-key.v1";

function lengthPrefixedUtf8(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.byteLength, 0);
  return Buffer.concat([prefix, bytes]);
}

/**
 * Pure, deterministic, and injective: the same `(workspaceId,
 * normalizedEmail)` tuple always produces the same key; two different
 * tuples can never produce the same key. Throws on empty input — both
 * arguments are expected to already be validated/non-empty by the time
 * any caller reaches this function (a workspaceId from an authorized
 * route param, a normalizedEmail from `normalizeInvitationEmail()`), so an
 * empty value here represents a caller bug, not an expected domain
 * outcome — mirroring this codebase's convention of reserving
 * discriminated result unions for expected, recoverable conditions.
 */
export function computeWorkspaceInvitationKey(workspaceId: string, normalizedEmail: string): string {
  if (workspaceId.length === 0) {
    throw new Error("computeWorkspaceInvitationKey: workspaceId must be non-empty");
  }
  if (normalizedEmail.length === 0) {
    throw new Error("computeWorkspaceInvitationKey: normalizedEmail must be non-empty");
  }
  const canonicalBytes = Buffer.concat([Buffer.from(DOMAIN_SEPARATOR, "utf8"), lengthPrefixedUtf8(workspaceId), lengthPrefixedUtf8(normalizedEmail)]);
  const digest = createHash("sha256").update(canonicalBytes).digest("hex");
  return `${INVITATION_KEY_PREFIX}${digest}`;
}

/** Structural shape check only — `wik_` + 64 lowercase-hex characters. Never confirms the key was actually derived from a real `(workspaceId, normalizedEmail)` pair; that requires recomputing and comparing. */
export function isWellFormedInvitationKey(value: unknown): value is string {
  return typeof value === "string" && /^wik_[0-9a-f]{64}$/.test(value);
}
