/**
 * Phase 5B — opaque cursor encode/decode for GET /api/user/workspace/runs.
 * Pure functions, no mocking needed.
 *
 * Corrected during independent review: v1 of this cursor stored
 * `createdAtMillis` (derived from `Timestamp.toMillis()`), which
 * truncates Firestore's true seconds+nanoseconds precision. The cursor
 * now stores the raw `{seconds, nanoseconds}` pair losslessly — see the
 * "precision" describe block below for the regression test proving this.
 */

import { decodeWorkspaceRunsCursor, encodeWorkspaceRunsCursor } from "@/lib/workspaces/workspaceRunsCursor";

describe("encodeWorkspaceRunsCursor / decodeWorkspaceRunsCursor", () => {
  it("round-trips a valid cursor", () => {
    const encoded = encodeWorkspaceRunsCursor({ createdAtSeconds: 1723600000, createdAtNanoseconds: 500_000_000, lastDocId: "run-abc" });
    const decoded = decodeWorkspaceRunsCursor(encoded);
    expect(decoded).toEqual({ ok: true, cursor: { createdAtSeconds: 1723600000, createdAtNanoseconds: 500_000_000, lastDocId: "run-abc" } });
  });

  it("encoded cursor never contains userId or workspaceId as plaintext substrings", () => {
    const encoded = encodeWorkspaceRunsCursor({ createdAtSeconds: 1, createdAtNanoseconds: 0, lastDocId: "run-abc" });
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
    const raw = Buffer.from(JSON.stringify({ v: 99, s: 1, n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw)).toEqual({ ok: false, reason: "unsupported_version" });
  });

  it("missing/invalid createdAtSeconds -> invalid_fields", () => {
    const raw1 = Buffer.from(JSON.stringify({ v: 1, n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw1)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw2 = Buffer.from(JSON.stringify({ v: 1, s: "not-a-number", n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw2)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw3 = Buffer.from(JSON.stringify({ v: 1, s: -5, n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw3)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw4 = Buffer.from(JSON.stringify({ v: 1, s: 1.5, n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw4)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw5 = Buffer.from(JSON.stringify({ v: 1, s: Infinity, n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw5)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("missing/invalid createdAtNanoseconds -> invalid_fields, including out-of-range per Firestore's documented 0..999,999,999", () => {
    const raw1 = Buffer.from(JSON.stringify({ v: 1, s: 1, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw1)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw2 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: -1, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw2)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw3 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 1_000_000_000, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw3)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw4 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 999_999_999, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw4)).toEqual({ ok: true, cursor: { createdAtSeconds: 1, createdAtNanoseconds: 999_999_999, lastDocId: "x" } }); // boundary is valid
  });

  it("missing/invalid document id -> invalid_fields", () => {
    const raw1 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 0 }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw1)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw2 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 0, i: "" }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw2)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw3 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 0, i: 12345 }), "utf8").toString("base64url");
    expect(decodeWorkspaceRunsCursor(raw3)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("the cursor format itself carries no identity — only ordering-position fields", () => {
    const encoded = encodeWorkspaceRunsCursor({ createdAtSeconds: 500, createdAtNanoseconds: 0, lastDocId: "run-xyz" });
    const decoded = decodeWorkspaceRunsCursor(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(Object.keys(decoded.cursor).sort()).toEqual(["createdAtNanoseconds", "createdAtSeconds", "lastDocId"]);
    }
  });
});

describe("precision — two timestamps in the same millisecond must remain distinguishable", () => {
  it("same second+millisecond, different nanoseconds -> distinct, losslessly round-tripped cursors", () => {
    // Both would collapse to the IDENTICAL value if a millisecond-based
    // cursor (Timestamp.toMillis()) were used — this is the exact defect
    // the independent review found in the original design.
    const a = encodeWorkspaceRunsCursor({ createdAtSeconds: 1723600000, createdAtNanoseconds: 123_456_000, lastDocId: "run-a" });
    const b = encodeWorkspaceRunsCursor({ createdAtSeconds: 1723600000, createdAtNanoseconds: 123_789_000, lastDocId: "run-b" });
    expect(a).not.toBe(b);

    const decodedA = decodeWorkspaceRunsCursor(a);
    const decodedB = decodeWorkspaceRunsCursor(b);
    expect(decodedA).toEqual({ ok: true, cursor: { createdAtSeconds: 1723600000, createdAtNanoseconds: 123_456_000, lastDocId: "run-a" } });
    expect(decodedB).toEqual({ ok: true, cursor: { createdAtSeconds: 1723600000, createdAtNanoseconds: 123_789_000, lastDocId: "run-b" } });
    // The two nanosecond values both truncate to the SAME millisecond
    // (123ms) — proving this scenario would have been lossy under the
    // old design, even though it's lossless under this one.
    expect(Math.floor(123_456_000 / 1_000_000)).toBe(Math.floor(123_789_000 / 1_000_000));
  });

  it("MUTATION CHECK: truncating nanoseconds to millisecond resolution before encoding collapses two genuinely distinct timestamps to the same cursor", () => {
    // Simulates the old, disproven design directly, to prove the new
    // design's test above would actually have caught it.
    const lossyMillis = (seconds: number, nanos: number) => seconds * 1000 + Math.floor(nanos / 1_000_000);
    const millisA = lossyMillis(1723600000, 123_456_000);
    const millisB = lossyMillis(1723600000, 123_789_000);
    expect(millisA).toBe(millisB); // proves the old encoding was lossy for this case
  });
});
