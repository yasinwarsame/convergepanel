/**
 * Project Foundation, Phase 6C — opaque cursor encode/decode for
 * GET /api/user/projects. Structural mirror of
 * lib/workspaces/__tests__/workspaceRunsCursor.spec.ts, including the
 * same nanosecond-precision regression test.
 */

import { decodeProjectsCursor, encodeProjectsCursor } from "@/lib/projects/projectsCursor";

describe("encodeProjectsCursor / decodeProjectsCursor", () => {
  it("round-trips a valid cursor", () => {
    const encoded = encodeProjectsCursor({ createdAtSeconds: 1723600000, createdAtNanoseconds: 500_000_000, lastDocId: "proj-abc" });
    const decoded = decodeProjectsCursor(encoded);
    expect(decoded).toEqual({ ok: true, cursor: { createdAtSeconds: 1723600000, createdAtNanoseconds: 500_000_000, lastDocId: "proj-abc" } });
  });

  it("encoded cursor never contains workspaceId as a plaintext substring", () => {
    const encoded = encodeProjectsCursor({ createdAtSeconds: 1, createdAtNanoseconds: 0, lastDocId: "proj-abc" });
    const decodedRaw = Buffer.from(encoded, "base64url").toString("utf8");
    expect(decodedRaw).not.toMatch(/workspaceId|personal-/i);
  });

  it("null/undefined/empty -> empty", () => {
    expect(decodeProjectsCursor(null)).toEqual({ ok: false, reason: "empty" });
    expect(decodeProjectsCursor(undefined)).toEqual({ ok: false, reason: "empty" });
    expect(decodeProjectsCursor("")).toEqual({ ok: false, reason: "empty" });
  });

  it("excessively large input -> too_large, rejected before any decode attempt", () => {
    const huge = "a".repeat(10000);
    expect(decodeProjectsCursor(huge)).toEqual({ ok: false, reason: "too_large" });
  });

  it("malformed base64 -> invalid_encoding or invalid_json, never throws", () => {
    expect(() => decodeProjectsCursor("not valid base64url!!! with spaces")).not.toThrow();
    const result = decodeProjectsCursor("not valid base64url!!! with spaces");
    expect(result.ok).toBe(false);
  });

  it("valid base64 but not JSON -> invalid_json", () => {
    const raw = Buffer.from("this is not json", "utf8").toString("base64url");
    expect(decodeProjectsCursor(raw)).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("valid JSON but not an object -> invalid_json", () => {
    const raw = Buffer.from(JSON.stringify("just a string"), "utf8").toString("base64url");
    expect(decodeProjectsCursor(raw)).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("unsupported version -> unsupported_version", () => {
    const raw = Buffer.from(JSON.stringify({ v: 99, s: 1, n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectsCursor(raw)).toEqual({ ok: false, reason: "unsupported_version" });
  });

  it("missing/invalid createdAtSeconds -> invalid_fields", () => {
    const raw1 = Buffer.from(JSON.stringify({ v: 1, n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectsCursor(raw1)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw2 = Buffer.from(JSON.stringify({ v: 1, s: "not-a-number", n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectsCursor(raw2)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw3 = Buffer.from(JSON.stringify({ v: 1, s: -5, n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectsCursor(raw3)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw4 = Buffer.from(JSON.stringify({ v: 1, s: 1.5, n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectsCursor(raw4)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("missing/invalid createdAtNanoseconds -> invalid_fields, including out-of-range per Firestore's documented 0..999,999,999", () => {
    const raw1 = Buffer.from(JSON.stringify({ v: 1, s: 1, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectsCursor(raw1)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw2 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: -1, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectsCursor(raw2)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw3 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 1_000_000_000, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectsCursor(raw3)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw4 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 999_999_999, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectsCursor(raw4)).toEqual({ ok: true, cursor: { createdAtSeconds: 1, createdAtNanoseconds: 999_999_999, lastDocId: "x" } });
  });

  it("missing/invalid document id -> invalid_fields", () => {
    const raw1 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 0 }), "utf8").toString("base64url");
    expect(decodeProjectsCursor(raw1)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw2 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 0, i: "" }), "utf8").toString("base64url");
    expect(decodeProjectsCursor(raw2)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw3 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 0, i: 12345 }), "utf8").toString("base64url");
    expect(decodeProjectsCursor(raw3)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("the cursor format itself carries no identity — only ordering-position fields", () => {
    const encoded = encodeProjectsCursor({ createdAtSeconds: 500, createdAtNanoseconds: 0, lastDocId: "proj-xyz" });
    const decoded = decodeProjectsCursor(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(Object.keys(decoded.cursor).sort()).toEqual(["createdAtNanoseconds", "createdAtSeconds", "lastDocId"]);
    }
  });
});

describe("precision — two Project documents in the same millisecond must remain distinguishable", () => {
  it("same second+millisecond, different nanoseconds -> distinct, losslessly round-tripped cursors", () => {
    const a = encodeProjectsCursor({ createdAtSeconds: 1723600000, createdAtNanoseconds: 123_456_000, lastDocId: "proj-a" });
    const b = encodeProjectsCursor({ createdAtSeconds: 1723600000, createdAtNanoseconds: 123_789_000, lastDocId: "proj-b" });
    expect(a).not.toBe(b);

    const decodedA = decodeProjectsCursor(a);
    const decodedB = decodeProjectsCursor(b);
    expect(decodedA).toEqual({ ok: true, cursor: { createdAtSeconds: 1723600000, createdAtNanoseconds: 123_456_000, lastDocId: "proj-a" } });
    expect(decodedB).toEqual({ ok: true, cursor: { createdAtSeconds: 1723600000, createdAtNanoseconds: 123_789_000, lastDocId: "proj-b" } });
    expect(Math.floor(123_456_000 / 1_000_000)).toBe(Math.floor(123_789_000 / 1_000_000));
  });

  it("MUTATION CHECK: truncating nanoseconds to millisecond resolution before encoding collapses two genuinely distinct timestamps to the same cursor", () => {
    const lossyMillis = (seconds: number, nanos: number) => seconds * 1000 + Math.floor(nanos / 1_000_000);
    const millisA = lossyMillis(1723600000, 123_456_000);
    const millisB = lossyMillis(1723600000, 123_789_000);
    expect(millisA).toBe(millisB);
  });
});
