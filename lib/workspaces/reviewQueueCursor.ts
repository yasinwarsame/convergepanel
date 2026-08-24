/**
 * Approval Workflow, Phase 9B.4 — opaque pagination cursor for
 * `GET /api/workspaces/{workspaceId}/review-queue`.
 *
 * Structural mirror of `workspaceRunsCursor.ts`/`projectRunsCursor.ts`
 * (base64url JSON envelope, versioned, byte-capped) — extended for this
 * route's specific needs:
 *
 *   - FIVE distinct views, each with its own sort field and Firestore
 *     field TYPE. `needs_review` orders by `runs.createdAt`, a native
 *     Firestore `Timestamp` (seconds+nanoseconds, exactly like
 *     `workspaceRunsCursor.ts`'s own established reasoning for why
 *     `.toMillis()` is lossy and must never be used). `changes_requested`/
 *     `recently_approved` order by `governanceRecord.humanReview.reviewedAt`,
 *     and `assigned_to_me`/`overdue` order by `humanReviewAssignment`'s
 *     `assignedAt`/`dueAt` — all THREE of those are canonical UTC ISO
 *     strings (this codebase's established convention for those fields,
 *     confirmed directly against `adaptiveSchema/governanceRecordParser.ts`
 *     and `governance/adaptiveHumanReviewAssignment.ts`), so a cursor for
 *     any of those views carries the raw string, never a Timestamp.
 *   - a Project filter binding — a cursor issued under one Project filter
 *     (or no filter at all) must never be silently accepted for a
 *     different filter (§26 of the Phase 9B.4 spec).
 *   - a view binding — a cursor issued for one view must never be
 *     accepted by another, even if their sort-value shape happens to
 *     coincide.
 *   - a WORKSPACE binding (9B.4-R1 correction) — a cursor issued while
 *     querying Workspace A must never be silently accepted for Workspace
 *     B. `reviewQueue.ts`'s own Firestore queries already scope every
 *     candidate by `workspaceId == <the URL path's workspace>`
 *     unconditionally, so a cross-workspace-replayed cursor could never
 *     actually leak Workspace A's documents into a Workspace B response —
 *     but accepting cursor state that was never validated against the
 *     CURRENT request's workspace is still the wrong contract: the
 *     mismatched `startAfter()` position it carries is meaningless
 *     relative to Workspace B's own ordering, and could silently skip an
 *     arbitrary prefix of B's real results or produce a false
 *     "exhausted" empty page. Binding `workspaceId` here, exactly like
 *     `view`/`projectFilter` already are, closes that gap the same way.
 *
 * `docPath` is deliberately the caller's own concern for what it means
 * (this module never interprets it) — the `runs`-collection views pass
 * the bare run id; the `humanReviewAssignment` collectionGroup views pass
 * the full subcollection document path, since Firestore's own
 * `startAfter(FieldPath.documentId())` contract requires the full path for
 * a collectionGroup query and only the bare id for a single-collection
 * query — `reviewQueue.ts` (the only caller) already knows which shape
 * each view needs.
 */

export type ReviewQueueView = "assigned_to_me" | "needs_review" | "changes_requested" | "overdue" | "recently_approved";

export type ReviewQueueSortValue = { kind: "timestamp"; seconds: number; nanoseconds: number } | { kind: "iso"; value: string };

export interface ReviewQueueCursor {
  workspaceId: string;
  view: ReviewQueueView;
  /** `undefined` = no Project filter was in effect when this cursor was issued. `null` = Unfiled. */
  projectFilter: string | null | undefined;
  sort: ReviewQueueSortValue;
  docPath: string;
}

const CURSOR_VERSION = 1;
const MAX_CURSOR_BYTES = 768;
const MAX_NANOSECONDS = 999_999_999;
const MAX_DOC_PATH_LENGTH = 1500;
const MAX_ISO_LENGTH = 64;
const MAX_WORKSPACE_ID_LENGTH = 200;

const VALID_VIEWS: ReadonlySet<string> = new Set<ReviewQueueView>(["assigned_to_me", "needs_review", "changes_requested", "overdue", "recently_approved"]);

export function encodeReviewQueueCursor(cursor: ReviewQueueCursor): string {
  const payload: Record<string, unknown> = {
    v: CURSOR_VERSION,
    w: cursor.workspaceId,
    view: cursor.view,
    i: cursor.docPath,
  };
  // Project filter tri-state, encoded so decode can distinguish
  // "absent from the cursor" (no filter was in effect) from an explicit
  // `null` (Unfiled) — a plain JSON `undefined` key would be dropped by
  // JSON.stringify, which is exactly the "absent" representation wanted.
  if (cursor.projectFilter !== undefined) {
    payload.p = cursor.projectFilter;
  }
  if (cursor.sort.kind === "timestamp") {
    payload.sk = "t";
    payload.ss = cursor.sort.seconds;
    payload.sn = cursor.sort.nanoseconds;
  } else {
    payload.sk = "s";
    payload.sv = cursor.sort.value;
  }
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export type DecodeReviewQueueCursorResult =
  | { ok: true; cursor: ReviewQueueCursor }
  | { ok: false; reason: "empty" | "too_large" | "invalid_encoding" | "invalid_json" | "unsupported_version" | "invalid_fields" };

export function decodeReviewQueueCursor(raw: string | null | undefined): DecodeReviewQueueCursorResult {
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
  if (typeof p.w !== "string" || p.w.length === 0 || p.w.length > MAX_WORKSPACE_ID_LENGTH) {
    return { ok: false, reason: "invalid_fields" };
  }
  if (typeof p.view !== "string" || !VALID_VIEWS.has(p.view)) {
    return { ok: false, reason: "invalid_fields" };
  }
  if (typeof p.i !== "string" || p.i.length === 0 || p.i.length > MAX_DOC_PATH_LENGTH) {
    return { ok: false, reason: "invalid_fields" };
  }

  let projectFilter: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(p, "p")) {
    if (p.p !== null && (typeof p.p !== "string" || p.p.length === 0)) {
      return { ok: false, reason: "invalid_fields" };
    }
    projectFilter = p.p as string | null;
  } else {
    projectFilter = undefined;
  }

  let sort: ReviewQueueSortValue;
  if (p.sk === "t") {
    if (typeof p.ss !== "number" || !Number.isFinite(p.ss) || !Number.isInteger(p.ss) || p.ss < 0) {
      return { ok: false, reason: "invalid_fields" };
    }
    if (typeof p.sn !== "number" || !Number.isFinite(p.sn) || !Number.isInteger(p.sn) || p.sn < 0 || p.sn > MAX_NANOSECONDS) {
      return { ok: false, reason: "invalid_fields" };
    }
    sort = { kind: "timestamp", seconds: p.ss, nanoseconds: p.sn };
  } else if (p.sk === "s") {
    if (typeof p.sv !== "string" || p.sv.length === 0 || p.sv.length > MAX_ISO_LENGTH) {
      return { ok: false, reason: "invalid_fields" };
    }
    sort = { kind: "iso", value: p.sv };
  } else {
    return { ok: false, reason: "invalid_fields" };
  }

  return { ok: true, cursor: { workspaceId: p.w, view: p.view as ReviewQueueView, projectFilter, sort, docPath: p.i } };
}
