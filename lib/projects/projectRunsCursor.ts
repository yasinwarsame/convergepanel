/**
 * Project Read Foundation, Phase 7A — opaque pagination cursor for
 * `GET /api/user/project-runs`. Structural mirror of
 * `lib/workspaces/workspaceRunsCursor.ts` and `lib/projects/projectsCursor.ts`
 * (this codebase's established convention: one cursor module per list
 * endpoint's collection/scope, not one shared generic module) — carries
 * ONLY the ordering position needed to resume a `createdAt DESC,
 * documentId DESC` scan, never `userId`/`workspaceId`/`projectId`, which
 * are always server-resolved from the authenticated session and the
 * `projectId`/`scope` query param on every request, never trusted from a
 * cursor.
 *
 * seconds/nanoseconds, never milliseconds — see the Workspace cursor's own
 * header comment for the historical `.toMillis()` truncation bug this
 * deliberately avoids repeating.
 */

const CURSOR_VERSION = 1;
const MAX_NANOSECONDS = 999_999_999;
const MAX_CURSOR_BYTES = 512;

export interface ProjectRunsCursor {
  createdAtSeconds: number;
  createdAtNanoseconds: number;
  lastDocId: string;
}

export function encodeProjectRunsCursor(cursor: ProjectRunsCursor): string {
  const payload = { v: CURSOR_VERSION, s: cursor.createdAtSeconds, n: cursor.createdAtNanoseconds, i: cursor.lastDocId };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export type DecodeProjectRunsCursorResult =
  | { ok: true; cursor: ProjectRunsCursor }
  | { ok: false; reason: "empty" | "too_large" | "invalid_encoding" | "invalid_json" | "unsupported_version" | "invalid_fields" };

export function decodeProjectRunsCursor(raw: string | null | undefined): DecodeProjectRunsCursorResult {
  if (raw == null || raw.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_CURSOR_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "invalid_encoding" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "invalid_json" };
  }
  const p = parsed as Record<string, unknown>;

  if (p.v !== CURSOR_VERSION) {
    return { ok: false, reason: "unsupported_version" };
  }
  if (typeof p.s !== "number" || !Number.isFinite(p.s) || !Number.isInteger(p.s) || p.s < 0) {
    return { ok: false, reason: "invalid_fields" };
  }
  if (typeof p.n !== "number" || !Number.isFinite(p.n) || !Number.isInteger(p.n) || p.n < 0 || p.n > MAX_NANOSECONDS) {
    return { ok: false, reason: "invalid_fields" };
  }
  if (typeof p.i !== "string" || p.i.length === 0 || p.i.length > 1500) {
    return { ok: false, reason: "invalid_fields" };
  }

  return { ok: true, cursor: { createdAtSeconds: p.s, createdAtNanoseconds: p.n, lastDocId: p.i } };
}
