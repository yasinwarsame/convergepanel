/**
 * Approval Workflow, Phase 9B.4 — encodeReviewQueueCursor()/decodeReviewQueueCursor() tests.
 */

import { encodeReviewQueueCursor, decodeReviewQueueCursor, type ReviewQueueCursor } from "@/lib/workspaces/reviewQueueCursor";

function isoCursor(overrides: Partial<ReviewQueueCursor> = {}): ReviewQueueCursor {
  return {
    workspaceId: "ws-1",
    view: "needs_review",
    projectFilter: undefined,
    sort: { kind: "iso", value: "2026-08-20T00:00:00.000Z" },
    docPath: "run-1",
    ...overrides,
  };
}

describe("encode/decode round-trip", () => {
  it("iso sort value round-trips exactly", () => {
    const cursor = isoCursor();
    const decoded = decodeReviewQueueCursor(encodeReviewQueueCursor(cursor));
    expect(decoded).toEqual({ ok: true, cursor });
  });

  it("timestamp sort value round-trips exactly", () => {
    const cursor = isoCursor({ sort: { kind: "timestamp", seconds: 1_700_000_000, nanoseconds: 123_000_000 } });
    const decoded = decodeReviewQueueCursor(encodeReviewQueueCursor(cursor));
    expect(decoded).toEqual({ ok: true, cursor });
  });

  it("explicit null projectFilter (Unfiled) round-trips as null, distinct from absent", () => {
    const cursor = isoCursor({ projectFilter: null });
    const decoded = decodeReviewQueueCursor(encodeReviewQueueCursor(cursor));
    expect(decoded).toEqual({ ok: true, cursor });
    if (decoded.ok) expect(decoded.cursor.projectFilter).toBeNull();
  });

  it("a specific projectFilter string round-trips exactly", () => {
    const cursor = isoCursor({ projectFilter: "proj-1" });
    const decoded = decodeReviewQueueCursor(encodeReviewQueueCursor(cursor));
    expect(decoded).toEqual({ ok: true, cursor });
  });

  it("absent projectFilter round-trips as undefined (no filter was in effect)", () => {
    const cursor = isoCursor({ projectFilter: undefined });
    const decoded = decodeReviewQueueCursor(encodeReviewQueueCursor(cursor));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.cursor.projectFilter).toBeUndefined();
  });

  it("a collectionGroup full document path round-trips exactly", () => {
    const cursor = isoCursor({ docPath: "runs/run-1/humanReviewAssignment/current" });
    const decoded = decodeReviewQueueCursor(encodeReviewQueueCursor(cursor));
    expect(decoded).toEqual({ ok: true, cursor });
  });

  it.each(["assigned_to_me", "needs_review", "changes_requested", "overdue", "recently_approved"] as const)("view %s round-trips", (view) => {
    const cursor = isoCursor({ view });
    const decoded = decodeReviewQueueCursor(encodeReviewQueueCursor(cursor));
    expect(decoded).toEqual({ ok: true, cursor });
  });
});

describe("malformed input rejection", () => {
  it("null/undefined -> empty", () => {
    expect(decodeReviewQueueCursor(null)).toEqual({ ok: false, reason: "empty" });
    expect(decodeReviewQueueCursor(undefined)).toEqual({ ok: false, reason: "empty" });
  });

  it("empty string -> empty", () => {
    expect(decodeReviewQueueCursor("")).toEqual({ ok: false, reason: "empty" });
  });

  it("oversized payload -> too_large", () => {
    const huge = "a".repeat(2000);
    expect(decodeReviewQueueCursor(huge)).toEqual({ ok: false, reason: "too_large" });
  });

  it("not valid base64url/JSON -> invalid_json or invalid_encoding", () => {
    const result = decodeReviewQueueCursor("not-a-real-cursor!!!");
    expect(result.ok).toBe(false);
  });

  it("a plain non-JSON base64 string -> invalid_json", () => {
    const raw = Buffer.from("not json at all", "utf8").toString("base64url");
    expect(decodeReviewQueueCursor(raw)).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("wrong version -> unsupported_version", () => {
    const payload = Buffer.from(JSON.stringify({ v: 999, w: "ws-1", view: "needs_review", i: "run-1", sk: "s", sv: "2026-01-01T00:00:00.000Z" }), "utf8").toString("base64url");
    expect(decodeReviewQueueCursor(payload)).toEqual({ ok: false, reason: "unsupported_version" });
  });

  it("invalid view -> invalid_fields", () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, w: "ws-1", view: "all", i: "run-1", sk: "s", sv: "2026-01-01T00:00:00.000Z" }), "utf8").toString("base64url");
    expect(decodeReviewQueueCursor(payload)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("missing doc path -> invalid_fields", () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, w: "ws-1", view: "needs_review", sk: "s", sv: "2026-01-01T00:00:00.000Z" }), "utf8").toString("base64url");
    expect(decodeReviewQueueCursor(payload)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("unknown sort kind -> invalid_fields", () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, w: "ws-1", view: "needs_review", i: "run-1", sk: "x" }), "utf8").toString("base64url");
    expect(decodeReviewQueueCursor(payload)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("timestamp sort missing seconds/nanoseconds -> invalid_fields", () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, w: "ws-1", view: "needs_review", i: "run-1", sk: "t" }), "utf8").toString("base64url");
    expect(decodeReviewQueueCursor(payload)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("negative nanoseconds -> invalid_fields", () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, w: "ws-1", view: "needs_review", i: "run-1", sk: "t", ss: 100, sn: -1 }), "utf8").toString("base64url");
    expect(decodeReviewQueueCursor(payload)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("malformed projectFilter (empty string, not null) -> invalid_fields", () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, w: "ws-1", view: "needs_review", i: "run-1", p: "", sk: "s", sv: "2026-01-01T00:00:00.000Z" }), "utf8").toString("base64url");
    expect(decodeReviewQueueCursor(payload)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("9B.4-R1 — missing workspaceId -> invalid_fields (never silently treated as unscoped)", () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, view: "needs_review", i: "run-1", sk: "s", sv: "2026-01-01T00:00:00.000Z" }), "utf8").toString("base64url");
    expect(decodeReviewQueueCursor(payload)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("9B.4-R1 — empty-string workspaceId -> invalid_fields", () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, w: "", view: "needs_review", i: "run-1", sk: "s", sv: "2026-01-01T00:00:00.000Z" }), "utf8").toString("base64url");
    expect(decodeReviewQueueCursor(payload)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("9B.4-R1 — workspaceId round-trips exactly, distinct workspaces produce distinct cursors", () => {
    const cursorA = isoCursor({ workspaceId: "ws-A" });
    const cursorB = isoCursor({ workspaceId: "ws-B" });
    expect(encodeReviewQueueCursor(cursorA)).not.toBe(encodeReviewQueueCursor(cursorB));
    const decodedA = decodeReviewQueueCursor(encodeReviewQueueCursor(cursorA));
    expect(decodedA).toEqual({ ok: true, cursor: cursorA });
    if (decodedA.ok) expect(decodedA.cursor.workspaceId).toBe("ws-A");
  });
});
