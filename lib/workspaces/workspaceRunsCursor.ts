/**
 * Phase 5B — opaque pagination cursor for `GET /api/user/workspace/runs`.
 *
 * Deliberately carries ONLY the ordering position needed to resume a
 * `createdAt DESC, documentId DESC` scan (`createdAt` millis + the last
 * SCANNED document's id — never the last VALID item returned; see the
 * route for why that distinction matters for bound-invalid rows at a page
 * boundary). Never carries `userId` or `workspaceId` — those are
 * re-derived from the authenticated session on every request, so a
 * cursor can only ever move pagination position, never change scope, even
 * if copied verbatim between two different accounts.
 */

const CURSOR_VERSION = 1;

export interface WorkspaceRunsCursor {
  createdAtMillis: number;
  lastDocId: string;
}

export function encodeWorkspaceRunsCursor(cursor: WorkspaceRunsCursor): string {
  const payload = { v: CURSOR_VERSION, c: cursor.createdAtMillis, i: cursor.lastDocId };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export type DecodeWorkspaceRunsCursorResult =
  | { ok: true; cursor: WorkspaceRunsCursor }
  | { ok: false; reason: "empty" | "too_large" | "invalid_encoding" | "invalid_json" | "unsupported_version" | "invalid_fields" };

const MAX_CURSOR_BYTES = 512;

export function decodeWorkspaceRunsCursor(raw: string | null | undefined): DecodeWorkspaceRunsCursorResult {
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
  if (typeof p.c !== "number" || !Number.isFinite(p.c) || p.c < 0) {
    return { ok: false, reason: "invalid_fields" };
  }
  if (typeof p.i !== "string" || p.i.length === 0 || p.i.length > 1500) {
    return { ok: false, reason: "invalid_fields" };
  }

  return { ok: true, cursor: { createdAtMillis: p.c, lastDocId: p.i } };
}
