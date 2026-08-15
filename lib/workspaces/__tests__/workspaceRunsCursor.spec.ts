/**
 * Phase 5B — opaque cursor encode/decode for GET /api/user/workspace/runs.
 * Pure functions, no mocking needed.
 */

import { decodeWorkspaceRunsCursor, encodeWorkspaceRunsCursor } from "@/lib/workspaces/workspaceRunsCursor";

describe("encodeWorkspaceRunsCursor / decodeWorkspaceRunsCursor", () => {
  it("round-trips a valid cursor", () => {
    const encoded = encodeWorkspaceRunsCursor({ createdAtMillis: 1723600000000, lastDocId: "run-abc" });
    const decoded = decodeWorkspaceRunsCursor(encoded);
    expect(decoded).toEqual({ ok: true, cursor: { createdAtMillis: 1723600000000, lastDocId: "run-abc" } });
  });

  it("encoded cursor never contains userId or workspaceId as plaintext substrings", () => {
    const encoded = encodeWorkspaceRunsCursor({ createdAtMillis: 1, lastDocId: "run-abc" });
    const decodedRaw = Buffer.from(encoded, "base64url").toString("utf8");
    expect(decodedRaw).not.toMatch(/userId|workspaceId|personal-/i);
  });

  it("null/undefined/empty -> empty", () => {
    expect(decodeWorkspaceRunsCursor(null)).toEqual({ ok: false, reason: "empty" });
    expect(decodeWorkspaceRunsCursor(undefined)).toEqual({ ok: false, reason: "empty" });
    expect(decodeWorkspaceRunsCursor("")).toEqual({ ok: false, reason: "empty" });
  });

  it("excessively large input -> too_large, rejected before any decode attempt", () => {
    const huge = "a".repeat(10000);
    expect(decodeWorkspaceRunsCursor(huge)).toEqual({ ok: false, reason: "too_large" });
  });

  it("malformed base64 -> invalid_encoding or invalid_json, never throws", () => {
    expect(() => decodeWorkspaceRunsCursor("not valid base64url!!! with spaces")).not.toThrow();
    const result = decodeWorkspaceRunsCursor("not valid base64url!!! with spaces");
    expect(result.ok).toBe(false);
  });

  it("valid base64 but not JSON -> invalid_json", () => {
    const raw = Buffer.from("this is not json", "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw)).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("valid JSON but not an object -> invalid_json", () => {
    const raw = Buffer.from(JSON.stringify("just a string"), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw)).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("unsupported version -> unsupported_version", () => {
    const raw = Buffer.from(JSON.stringify({ v: 99, c: 1, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw)).toEqual({ ok: false, reason: "unsupported_version" });
  });

  it("missing/invalid createdAt millis -> invalid_fields", () => {
    const raw1 = Buffer.from(JSON.stringify({ v: 1, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw1)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw2 = Buffer.from(JSON.stringify({ v: 1, c: "not-a-number", i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw2)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw3 = Buffer.from(JSON.stringify({ v: 1, c: -5, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw3)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw4 = Buffer.from(JSON.stringify({ v: 1, c: Infinity, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw4)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("missing/invalid document id -> invalid_fields", () => {
    const raw1 = Buffer.from(JSON.stringify({ v: 1, c: 1 }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw1)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw2 = Buffer.from(JSON.stringify({ v: 1, c: 1, i: "" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw2)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw3 = Buffer.from(JSON.stringify({ v: 1, c: 1, i: 12345 }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw3)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("a cursor generated for one account decodes to the same ordering-position shape regardless of account — decoding alone never reveals or implies whose data it scopes to", () => {
    // The cursor format itself carries no identity; this test documents
    // that fact structurally rather than via a route-level test (see the
    // runs-endpoint route spec for the full cross-user-isolation proof).
    const encoded = encodeWorkspaceRunsCursor({ createdAtMillis: 500, lastDocId: "run-xyz" });
    const decoded = decodeWorkspaceRunsCursor(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(Object.keys(decoded.cursor).sort()).toEqual(["createdAtMillis", "lastDocId"]);
    }
  });
});
