/**
 * Personal Workspace Provisioning, Phase 2 — the single canonical helper
 * that constructs a Personal Workspace's deterministic Firestore document
 * id. Every call site that needs a uid's Personal Workspace id (the
 * provisioning service, the Firestore create/read helpers, tests) calls
 * this — the string construction is never duplicated inline.
 *
 * Deterministic-id rationale (see docs/workspaces/architecture.md
 * "Personal Workspace identity strategy"): `personal-{uid}` gives
 * idempotent, race-safe, exactly-once provisioning via Firestore
 * `.create()` alone, with no query, no transaction, and no separate
 * `users/{uid}.personalWorkspaceId` mapping field that could drift.
 */

import "server-only";

export type GetPersonalWorkspaceIdResult = { ok: true; workspaceId: string } | { ok: false; reason: "invalid_uid" };

const PERSONAL_WORKSPACE_ID_PREFIX = "personal-";

/**
 * Validates `uid` before constructing the document id — never trusts an
 * arbitrary caller-supplied string blindly. Rejects: empty/whitespace-only,
 * non-string, and anything that would produce an invalid or dangerous
 * Firestore document id (containing `/`, or resolving to the reserved `.`
 * or `..` segments, or exceeding Firestore's 1500-byte document id limit).
 * A uid this strict guard rejects can never have been issued by Firebase
 * Auth's own token verification — this is defense in depth, not an
 * expected runtime path for any legitimately authenticated caller.
 */
export function getPersonalWorkspaceId(uid: unknown): GetPersonalWorkspaceIdResult {
  if (typeof uid !== "string") return { ok: false, reason: "invalid_uid" };
  const trimmed = uid.trim();
  if (trimmed.length === 0) return { ok: false, reason: "invalid_uid" };
  if (trimmed !== uid) return { ok: false, reason: "invalid_uid" }; // no incidental leading/trailing whitespace
  if (trimmed.includes("/")) return { ok: false, reason: "invalid_uid" };
  if (trimmed === "." || trimmed === "..") return { ok: false, reason: "invalid_uid" };

  const workspaceId = `${PERSONAL_WORKSPACE_ID_PREFIX}${trimmed}`;
  if (Buffer.byteLength(workspaceId, "utf8") > 1500) return { ok: false, reason: "invalid_uid" };

  return { ok: true, workspaceId };
}
