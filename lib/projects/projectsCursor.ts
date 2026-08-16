/**
 * Project Foundation, Phase 6C — opaque pagination cursor for
 * `GET /api/user/projects`. Structural mirror of
 * `lib/workspaces/workspaceRunsCursor.ts`, carrying ONLY the ordering
 * position needed to resume a `createdAt DESC, documentId DESC` scan —
 * never `workspaceId`, which is always server-resolved from the
 * authenticated session on every request, never trusted from a cursor.
 *
 * seconds/nanoseconds, never milliseconds — see the Workspace cursor's
 * own header comment for the historical `.toMillis()` truncation bug this
 * deliberately avoids repeating.
 */

const CURSOR_VERSION = 1;
const MAX_NANOSECONDS = 999_999_999;
const MAX_CURSOR_BYTES = 512;

export interface ProjectsCursor {
  createdAtSeconds: number;
  createdAtNanoseconds: number;
  lastDocId: string;
}

export function encodeProjectsCursor(cursor: ProjectsCursor): string {
  const payload = { v: CURSOR_VERSION, s: cursor.createdAtSeconds, n: cursor.createdAtNanoseconds, i: cursor.lastDocId };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export type DecodeProjectsCursorResult =
  | { ok: true; cursor: ProjectsCursor }
  | { ok: false; reason: "empty" | "too_large" | "invalid_encoding" | "invalid_json" | "unsupported_version" | "invalid_fields" };

export function decodeProjectsCursor(raw: string | null | undefined): DecodeProjectsCursorResult {
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
