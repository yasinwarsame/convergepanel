/**
 * Project Read Foundation, Phase 7A — opaque cursor encode/decode for
 * GET /api/user/project-runs. Structural mirror of
 * lib/projects/__tests__/projectsCursor.spec.ts, including the same
 * nanosecond-precision regression test.
 */

import { decodeProjectRunsCursor, encodeProjectRunsCursor } from "@/lib/projects/projectRunsCursor";

describe("encodeProjectRunsCursor / decodeProjectRunsCursor", () => {
  it("round-trips a valid cursor", () => {
    const encoded = encodeProjectRunsCursor({ createdAtSeconds: 1723600000, createdAtNanoseconds: 500_000_000, lastDocId: "run-abc" });
    const decoded = decodeProjectRunsCursor(encoded);
    expect(decoded).toEqual({ ok: true, cursor: { createdAtSeconds: 1723600000, createdAtNanoseconds: 500_000_000, lastDocId: "run-abc" } });
  });

  it("encoded cursor never contains userId/workspaceId/projectId as a plaintext substring", () => {
    const encoded = encodeProjectRunsCursor({ createdAtSeconds: 1, createdAtNanoseconds: 0, lastDocId: "run-abc" });
    const decodedRaw = Buffer.from(encoded, "base64url").toString("utf8");
    expect(decodedRaw).not.toMatch(/workspaceId|personal-|userId|projectId/i);
  });

  it("null/undefined/empty -> empty", () => {
    expect(decodeProjectRunsCursor(null)).toEqual({ ok: false, reason: "empty" });
    expect(decodeProjectRunsCursor(undefined)).toEqual({ ok: false, reason: "empty" });
    expect(decodeProjectRunsCursor("")).toEqual({ ok: false, reason: "empty" });
  });

  it("excessively large input -> too_large, rejected before any decode attempt", () => {
    const huge = "a".repeat(10000);
    expect(decodeProjectRunsCursor(huge)).toEqual({ ok: false, reason: "too_large" });
  });

  it("malformed base64 -> invalid, never throws", () => {
    expect(() => decodeProjectRunsCursor("not valid base64url!!! with spaces")).not.toThrow();
    const result = decodeProjectRunsCursor("not valid base64url!!! with spaces");
    expect(result.ok).toBe(false);
  });

  it("valid base64 but not JSON -> invalid_json", () => {
    const raw = Buffer.from("this is not json", "utf8").toString("base64url");
    expect(decodeProjectRunsCursor(raw)).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("valid JSON but not an object -> invalid_json", () => {
    const raw = Buffer.from(JSON.stringify("just a string"), "utf8").toString("base64url");
    expect(decodeProjectRunsCursor(raw)).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("unsupported version -> unsupported_version", () => {
    const raw = Buffer.from(JSON.stringify({ v: 99, s: 1, n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectRunsCursor(raw)).toEqual({ ok: false, reason: "unsupported_version" });
  });

  it("missing/invalid createdAtSeconds -> invalid_fields", () => {
    const raw1 = Buffer.from(JSON.stringify({ v: 1, n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectRunsCursor(raw1)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw2 = Buffer.from(JSON.stringify({ v: 1, s: "not-a-number", n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectRunsCursor(raw2)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw3 = Buffer.from(JSON.stringify({ v: 1, s: -5, n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectRunsCursor(raw3)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("missing/invalid createdAtNanoseconds -> invalid_fields, including out-of-range per Firestore's documented 0..999,999,999", () => {
    const raw1 = Buffer.from(JSON.stringify({ v: 1, s: 1, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectRunsCursor(raw1)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw2 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 1_000_000_000, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectRunsCursor(raw2)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw3 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 999_999_999, i: "x" }), "utf8").toString("base64url");
    expect(decodeProjectRunsCursor(raw3)).toEqual({ ok: true, cursor: { createdAtSeconds: 1, createdAtNanoseconds: 999_999_999, lastDocId: "x" } });
  });

  it("missing/invalid document id -> invalid_fields", () => {
    const raw1 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 0 }), "utf8").toString("base64url");
    expect(decodeProjectRunsCursor(raw1)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw2 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 0, i: "" }), "utf8").toString("base64url");
    expect(decodeProjectRunsCursor(raw2)).toEqual({ ok: false, reason: "invalid_fields" });
  });
});

describe("precision — two run documents in the same millisecond must remain distinguishable", () => {
  it("same second+millisecond, different nanoseconds -> distinct, losslessly round-tripped cursors", () => {
    const a = encodeProjectRunsCursor({ createdAtSeconds: 1723600000, createdAtNanoseconds: 123_456_000, lastDocId: "run-a" });
    const b = encodeProjectRunsCursor({ createdAtSeconds: 1723600000, createdAtNanoseconds: 123_789_000, lastDocId: "run-b" });
    expect(a).not.toBe(b);

    const decodedA = decodeProjectRunsCursor(a);
    const decodedB = decodeProjectRunsCursor(b);
    expect(decodedA).toEqual({ ok: true, cursor: { createdAtSeconds: 1723600000, createdAtNanoseconds: 123_456_000, lastDocId: "run-a" } });
    expect(decodedB).toEqual({ ok: true, cursor: { createdAtSeconds: 1723600000, createdAtNanoseconds: 123_789_000, lastDocId: "run-b" } });
    expect(Math.floor(123_456_000 / 1_000_000)).toBe(Math.floor(123_789_000 / 1_000_000));
  });

  it("MUTATION CHECK: truncating nanoseconds to millisecond resolution before encoding collapses two genuinely distinct timestamps to the same cursor", () => {
    const lossyMillis = (seconds: number, nanos: number) => seconds * 1000 + Math.floor(nanos / 1_000_000);
    const millisA = lossyMillis(1723600000, 123_456_000);
    const millisB = lossyMillis(1723600000, 123_789_000);
    expect(millisA).toBe(millisB);
  });
});
