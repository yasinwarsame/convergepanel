/**
 * Phase 5B — opaque pagination cursor for `GET /api/user/workspace/runs`.
 *
 * Deliberately carries ONLY the ordering position needed to resume a
 * `createdAt DESC, documentId DESC` scan — never `userId`/`workspaceId`;
 * see the route for why that distinction matters for scope isolation.
 *
 * Corrected during independent review (v1 stored `createdAtMillis`,
 * derived from `Timestamp.toMillis()`): Firestore's `Timestamp` is
 * seconds + nanoseconds resolution (`@google-cloud/firestore`'s own
 * `Timestamp` class, `get seconds()`/`get nanoseconds()`, constructor
 * `(seconds, nanoseconds)`) — `.toMillis()` truncates anything below
 * millisecond precision. `createRun()`'s own writer (`Timestamp.now()`)
 * happens to always produce millisecond-aligned values today (`.now()`
 * is documented as "millisecond precision"), but the cursor contract
 * must not depend on that being true of every writer forever — a lossy
 * cursor could reconstruct a `startAfter` value that doesn't exactly
 * match the last scanned document's true ordering key, causing a
 * duplicate or skipped row for any timestamp with a genuine
 * sub-millisecond component. The cursor now stores the raw
 * `seconds`/`nanoseconds` pair and reconstructs the exact `Timestamp`
 * via its `(seconds, nanoseconds)` constructor — never `fromMillis()`,
 * which is itself lossy in the same way.
 */

const CURSOR_VERSION = 1;
const MAX_NANOSECONDS = 999_999_999;

export interface WorkspaceRunsCursor {
  createdAtSeconds: number;
  createdAtNanoseconds: number;
  lastDocId: string;
}

export function encodeWorkspaceRunsCursor(cursor: WorkspaceRunsCursor): string {
  const payload = { v: CURSOR_VERSION, s: cursor.createdAtSeconds, n: cursor.createdAtNanoseconds, i: cursor.lastDocId };
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
