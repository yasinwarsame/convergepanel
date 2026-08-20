/**
 * Team Workspace Core Foundation, Phase 8B (domain separator added in
 * Phase 8B.2) — the ONE canonical `(workspaceId, uid) -> membershipId`
 * derivation. No other module constructs a `workspaceMemberships/{id}`
 * document id string itself, mirroring `getPersonalWorkspaceId()`'s
 * equivalent role for `workspaces/{personal-uid}` ids.
 *
 * Frozen algorithm — a domain-separated, length-prefixed, byte-exact
 * serialization of the two-tuple, hashed with SHA-256:
 *
 *   canonicalBytes =
 *       utf8(DOMAIN_SEPARATOR)
 *     || u32be(byteLength(utf8(workspaceId))) || utf8(workspaceId)
 *     || u32be(byteLength(utf8(uid)))         || utf8(uid)
 *
 *   membershipId = "wm_" + lowercaseHex(SHA256(canonicalBytes))
 *
 * **Domain separator is inside the hash input, not merely the output
 * prefix.** `DOMAIN_SEPARATOR = "convergepanel.workspace-membership.v1"`
 * is hashed as the FIRST bytes of `canonicalBytes` — this is what makes
 * this id space cryptographically distinct from any other hash computed
 * over a similarly-shaped `(a, b)` tuple elsewhere in this application (or
 * a future one), even if that other computation happened to use the exact
 * same length-prefix encoding. The `wm_` string prepended to the OUTPUT
 * hex digest is a display/readability convention only — it plays no role
 * in the hash computation itself and does not provide domain separation;
 * two different domains hashing the identical `(workspaceId, uid)` bytes
 * would otherwise collide at the digest level even if their final
 * *displayed* ids happened to use different prefixes. Changing or
 * removing `DOMAIN_SEPARATOR` changes every deterministic id this
 * function produces — asserted by fixed known test vectors in
 * `__tests__/membershipId.spec.ts`, not merely by property-based tests.
 *
 * The length prefix is measured in UTF-8 BYTES, never
 * `string.length` (JS string length counts UTF-16 code units, which
 * diverges from byte length for any multibyte character) — using
 * `string.length` here would make the serialization non-injective for
 * multibyte input and could theoretically let two different
 * (workspaceId, uid) pairs collide on the same prefixed byte stream
 * before hashing. `Buffer.byteLength(str, "utf8")` is the exact
 * primitive used to avoid that class of bug.
 *
 * The length-prefixed tuple serialization is injective: two distinct
 * (workspaceId, uid) tuples can never produce the same `canonicalBytes`,
 * because the prefix length for each segment is recorded before its
 * bytes, so no delimiter-looking byte sequence inside either value can
 * ever be misread as a boundary. SHA-256 is then applied only for fixed-
 * length, practically collision-resistant output — it is NOT what makes
 * the id space collision-free; the injective serialization already
 * guarantees that different inputs are never hashed from the same bytes.
 * (SHA-256 itself is practically collision-resistant, not "mathematically
 * collision-free" — no cryptographic hash function is.)
 *
 * Output shape: `wm_` (3 chars) + 64 lowercase hex chars = 67 characters
 * total, always.
 */

import "server-only";
import { createHash } from "crypto";

const MEMBERSHIP_ID_PREFIX = "wm_";

/**
 * Frozen (Phase 8B.2) domain separator, hashed as the first bytes of
 * every membership id — never versioned informally by editing this
 * string in place. A future breaking change to the id algorithm must
 * introduce a NEW separator (e.g. `...v2`), never silently reinterpret
 * `v1`'s already-computed ids.
 */
const DOMAIN_SEPARATOR = "convergepanel.workspace-membership.v1";

function lengthPrefixedUtf8(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.byteLength, 0);
  return Buffer.concat([prefix, bytes]);
}

/**
 * Pure, deterministic, and injective: the same `(workspaceId, uid)` tuple
 * always produces the same id; two different tuples can never produce the
 * same id (see module doc comment for why). Uses Node's built-in `crypto`
 * module — already a transitive dependency of this application via
 * `firebase-admin`/`@google-cloud/firestore` — never a new hashing
 * dependency.
 */
export function computeMembershipId(workspaceId: string, uid: string): string {
  const canonicalBytes = Buffer.concat([Buffer.from(DOMAIN_SEPARATOR, "utf8"), lengthPrefixedUtf8(workspaceId), lengthPrefixedUtf8(uid)]);
  const digest = createHash("sha256").update(canonicalBytes).digest("hex");
  return `${MEMBERSHIP_ID_PREFIX}${digest}`;
}

/** Structural shape check only — `wm_` + 64 lowercase-hex characters. Never confirms the id was actually derived from a real `(workspaceId, uid)` pair; that requires recomputing and comparing (see `getWorkspaceMembershipForBinding()`). */
export function isWellFormedMembershipId(value: unknown): value is string {
  return typeof value === "string" && /^wm_[0-9a-f]{64}$/.test(value);
}
