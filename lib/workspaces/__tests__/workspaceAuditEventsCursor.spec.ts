/**
 * Workspace Audit Log, Phase TEAM-GOV-I1 — opaque cursor encode/decode for
 * GET /api/workspaces/{workspaceId}/audit-events. Pure functions, no
 * mocking needed. Structural mirror of `workspaceRunsCursor.spec.ts`.
 */

import { decodeWorkspaceAuditEventsCursor, encodeWorkspaceAuditEventsCursor } from "@/lib/workspaces/workspaceAuditEventsCursor";

describe("encodeWorkspaceAuditEventsCursor / decodeWorkspaceAuditEventsCursor", () => {
  it("round-trips a valid cursor", () => {
    const encoded = encodeWorkspaceAuditEventsCursor({ atSeconds: 1723600000, atNanoseconds: 500_000_000, lastDocId: "evt-abc" });
    const decoded = decodeWorkspaceAuditEventsCursor(encoded);
    expect(decoded).toEqual({ ok: true, cursor: { atSeconds: 1723600000, atNanoseconds: 500_000_000, lastDocId: "evt-abc" } });
  });

  it("encoded cursor never contains workspaceId/uid as plaintext substrings", () => {
    const encoded = encodeWorkspaceAuditEventsCursor({ atSeconds: 1, atNanoseconds: 0, lastDocId: "evt-abc" });
    const decodedRaw = Buffer.from(encoded, "base64url").toString("utf8");
    expect(decodedRaw).not.toMatch(/workspaceId|actorUid|targetUid/i);
  });

  it("null/undefined/empty -> empty", () => {
    expect(decodeWorkspaceAuditEventsCursor(null)).toEqual({ ok: false, reason: "empty" });
    expect(decodeWorkspaceAuditEventsCursor(undefined)).toEqual({ ok: false, reason: "empty" });
    expect(decodeWorkspaceAuditEventsCursor("")).toEqual({ ok: false, reason: "empty" });
  });

  it("excessively large input -> too_large", () => {
    expect(decodeWorkspaceAuditEventsCursor("a".repeat(10000))).toEqual({ ok: false, reason: "too_large" });
  });

  it("malformed base64 -> never throws, ok:false", () => {
    expect(() => decodeWorkspaceAuditEventsCursor("not valid base64url!!! with spaces")).not.toThrow();
    expect(decodeWorkspaceAuditEventsCursor("not valid base64url!!! with spaces").ok).toBe(false);
  });

  it("valid base64 but not JSON -> invalid_json", () => {
    const raw = Buffer.from("this is not json", "utf8").toString("base64url");
    expect(decodeWorkspaceAuditEventsCursor(raw)).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("unsupported version -> unsupported_version", () => {
    const raw = Buffer.from(JSON.stringify({ v: 99, s: 1, n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceAuditEventsCursor(raw)).toEqual({ ok: false, reason: "unsupported_version" });
  });

  it("missing/invalid atSeconds -> invalid_fields", () => {
    const raw1 = Buffer.from(JSON.stringify({ v: 1, n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceAuditEventsCursor(raw1)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw2 = Buffer.from(JSON.stringify({ v: 1, s: -5, n: 0, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceAuditEventsCursor(raw2)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("missing/invalid atNanoseconds -> invalid_fields, out-of-range per Firestore's documented 0..999,999,999", () => {
    const raw1 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 1_000_000_000, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceAuditEventsCursor(raw1)).toEqual({ ok: false, reason: "invalid_fields" });
    const raw2 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 999_999_999, i: "x" }), "utf8").toString("base64url");
    expect(decodeWorkspaceAuditEventsCursor(raw2)).toEqual({ ok: true, cursor: { atSeconds: 1, atNanoseconds: 999_999_999, lastDocId: "x" } });
  });

  it("missing/invalid document id -> invalid_fields", () => {
    const raw1 = Buffer.from(JSON.stringify({ v: 1, s: 1, n: 0, i: "" }), "utf8").toString("base64url");
    expect(decodeWorkspaceAuditEventsCursor(raw1)).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("the cursor format itself carries no identity — only ordering-position fields", () => {
    const encoded = encodeWorkspaceAuditEventsCursor({ atSeconds: 500, atNanoseconds: 0, lastDocId: "evt-xyz" });
    const decoded = decodeWorkspaceAuditEventsCursor(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(Object.keys(decoded.cursor).sort()).toEqual(["atNanoseconds", "atSeconds", "lastDocId"]);
    }
  });

  it("precision: two timestamps in the same millisecond, different nanoseconds, round-trip distinctly", () => {
    const a = encodeWorkspaceAuditEventsCursor({ atSeconds: 1723600000, atNanoseconds: 123_456_000, lastDocId: "evt-a" });
    const b = encodeWorkspaceAuditEventsCursor({ atSeconds: 1723600000, atNanoseconds: 123_789_000, lastDocId: "evt-b" });
    expect(a).not.toBe(b);
    expect(decodeWorkspaceAuditEventsCursor(a)).toEqual({ ok: true, cursor: { atSeconds: 1723600000, atNanoseconds: 123_456_000, lastDocId: "evt-a" } });
    expect(decodeWorkspaceAuditEventsCursor(b)).toEqual({ ok: true, cursor: { atSeconds: 1723600000, atNanoseconds: 123_789_000, lastDocId: "evt-b" } });
  });
});
