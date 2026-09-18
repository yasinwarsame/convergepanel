/**
 * TEAM-VERIFICATION-PARITY-R5-I1 §AG — the Team Video cursor carries ONLY an
 * ordering position. It must never be able to express a Workspace, Project,
 * scope, uid, role or capability, and every malformed form must be rejected
 * before any query is built.
 */

import { encodeTeamVideoVerificationsCursor, decodeTeamVideoVerificationsCursor } from "@/lib/workspaces/teamVideoVerificationsCursor";

const POS = { timestampSeconds: 1_700_000_000, timestampNanoseconds: 123_456_789, lastDocId: "vid-abc" };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

describe("round trip", () => {
  it("preserves seconds, nanoseconds and the document id exactly", () => {
    expect(decodeTeamVideoVerificationsCursor(encodeTeamVideoVerificationsCursor(POS))).toEqual({ ok: true, cursor: POS });
  });

  it("produces a non-empty opaque string", () => {
    const raw = encodeTeamVideoVerificationsCursor(POS);
    expect(typeof raw).toBe("string");
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).not.toContain("ws-");
  });

  it("nanosecond precision survives (never truncated to millis)", () => {
    const r = decodeTeamVideoVerificationsCursor(encodeTeamVideoVerificationsCursor({ ...POS, timestampNanoseconds: 999_999_999 }));
    expect(r.ok && r.cursor.timestampNanoseconds).toBe(999_999_999);
  });
});

describe("rejects every malformed form", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["malformed base64/JSON", "!!!!not-base64!!!!"],
    ["valid base64 of non-JSON", Buffer.from("not json", "utf8").toString("base64url")],
    ["JSON that is not an object", b64([1, 2, 3])],
    ["wrong version", b64({ v: 2, s: 1, n: 0, i: "vid-a" })],
    ["missing seconds", b64({ v: 1, n: 0, i: "vid-a" })],
    ["missing nanoseconds", b64({ v: 1, s: 1, i: "vid-a" })],
    ["missing doc id", b64({ v: 1, s: 1, n: 0 })],
    ["negative seconds", b64({ v: 1, s: -1, n: 0, i: "vid-a" })],
    ["non-integer seconds", b64({ v: 1, s: 1.5, n: 0, i: "vid-a" })],
    ["nanoseconds out of range", b64({ v: 1, s: 1, n: 1_000_000_000, i: "vid-a" })],
    ["negative nanoseconds", b64({ v: 1, s: 1, n: -1, i: "vid-a" })],
    ["empty doc id", b64({ v: 1, s: 1, n: 0, i: "" })],
    ["non-string doc id", b64({ v: 1, s: 1, n: 0, i: 5 })],
  ])("%s -> not ok", (_label, raw) => {
    expect(decodeTeamVideoVerificationsCursor(raw as string | null | undefined)).toEqual({ ok: false });
  });
});

describe("carries no authorization or scope data", () => {
  it("the encoded payload has exactly the four position keys", () => {
    const decoded = JSON.parse(Buffer.from(encodeTeamVideoVerificationsCursor(POS), "base64url").toString("utf8"));
    expect(Object.keys(decoded).sort()).toEqual(["i", "n", "s", "v"]);
  });

  it("extra smuggled keys are ignored, never surfaced to the caller", () => {
    const raw = b64({ v: 1, s: 1, n: 0, i: "vid-a", workspaceId: "ws-other", projectId: "p-other", uid: "u", scope: "all", role: "owner" });
    const r = decodeTeamVideoVerificationsCursor(raw);
    expect(r).toEqual({ ok: true, cursor: { timestampSeconds: 1, timestampNanoseconds: 0, lastDocId: "vid-a" } });
    expect(Object.keys(r.ok ? r.cursor : {}).sort()).toEqual(["lastDocId", "timestampNanoseconds", "timestampSeconds"]);
  });
});
