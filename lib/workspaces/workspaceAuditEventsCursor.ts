/**
 * Workspace Audit Log, Phase TEAM-GOV-I1 — opaque pagination cursor for
 * `GET /api/workspaces/{workspaceId}/audit-events`.
 *
 * Structural mirror of `workspaceRunsCursor.ts` (same rationale: raw
 * `seconds`/`nanoseconds` pair reconstructed via the `Timestamp`
 * constructor, never `.toMillis()`/`.fromMillis()`, which are lossy below
 * millisecond precision). Kept as its own small, self-contained module
 * rather than sharing code with the runs cursor — the two have no actual
 * coupling beyond an identical shape, and sharing would mean touching an
 * already-shipped, reviewed file for no behavioral benefit.
 *
 * Deliberately carries ONLY the ordering position needed to resume an
 * `at DESC, documentId DESC` scan — never `workspaceId`, for the same
 * scope-isolation reason `workspaceRunsCursor.ts` documents: the route
 * reconstructs scope from the URL's own `{workspaceId}` on every request,
 * never from client-supplied cursor state.
 */

const CURSOR_VERSION = 1;
const MAX_NANOSECONDS = 999_999_999;

export interface WorkspaceAuditEventsCursor {
  atSeconds: number;
  atNanoseconds: number;
  lastDocId: string;
}

export function encodeWorkspaceAuditEventsCursor(cursor: WorkspaceAuditEventsCursor): string {
  const payload = { v: CURSOR_VERSION, s: cursor.atSeconds, n: cursor.atNanoseconds, i: cursor.lastDocId };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export type DecodeWorkspaceAuditEventsCursorResult =
  | { ok: true; cursor: WorkspaceAuditEventsCursor }
  | { ok: false; reason: "empty" | "too_large" | "invalid_encoding" | "invalid_json" | "unsupported_version" | "invalid_fields" };

const MAX_CURSOR_BYTES = 512;

export function decodeWorkspaceAuditEventsCursor(raw: string | null | undefined): DecodeWorkspaceAuditEventsCursorResult {
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

  return { ok: true, cursor: { atSeconds: p.s, atNanoseconds: p.n, lastDocId: p.i } };
}
