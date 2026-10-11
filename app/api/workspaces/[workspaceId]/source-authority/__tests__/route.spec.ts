/**
 * Order 4 Slice 2a — GET|POST /api/workspaces/{workspaceId}/source-authority.
 *
 * Gate order (authenticate → admission → sources.attest → concealed flag →
 * validate → read/write), the real ROLE_CAPABILITIES matrix, the strict body
 * contract and the error mapping. The REAL writer/readers run against the
 * strict fake Firestore (wrapped in pass-through spies), so "no Source
 * Standing work" is asserted at the db boundary.
 */
import { Timestamp } from "firebase-admin/firestore";
import { FakeDb } from "@/lib/sourceStanding/__tests__/fakeStandingFirestore";

let flag = true;
jest.mock("@/lib/env", () => ({
  get SOURCE_AUTHORITY_METADATA_ENABLED() {
    return flag;
  },
}));
const mockedIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAuditAccess", () => ({ resolveWorkspaceAuditAccess: (...a: unknown[]) => mockedAccess(...a) }));
let mockDb: FakeDb;
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockDb;
  },
}));
jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const applySpy = jest.fn();
const readSpy = jest.fn();
jest.mock("@/lib/sourceStanding/standingFirestore", () => {
  const actual = jest.requireActual("@/lib/sourceStanding/standingFirestore");
  return {
    ...actual,
    applySourceStandingOperation: (...a: unknown[]) => applySpy(...a) ?? actual.applySourceStandingOperation(...a),
    readStandingForManagement: (...a: unknown[]) => readSpy(...a) ?? actual.readStandingForManagement(...a),
  };
});

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/workspaces/[workspaceId]/source-authority/route";
import { ROLE_CAPABILITIES } from "@/lib/workspaces/capabilities";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { sourceIdentityV1, type SourceIdentityV1 } from "@/lib/sourceStanding/sourceIdentity";

const W = "ws-1";
const OWNER = "owner-1";
const ADMIN = "admin-1";
const URL_A = "https://docs.example.com/a";
const URL_B = "https://docs.example.com/b";
const A = sourceIdentityV1(URL_A) as SourceIdentityV1;
const B = sourceIdentityV1(URL_B) as SourceIdentityV1;
const ts = (s: number) => new Timestamp(s, 0);
const roles = Object.keys(ROLE_CAPABILITIES) as Array<keyof typeof ROLE_CAPABILITIES>;
const grant = (role: keyof typeof ROLE_CAPABILITIES) => ({ granted: true, capabilities: ROLE_CAPABILITIES[role] });

const get = (query: string) => GET(new NextRequest(`http://localhost/api/workspaces/${W}/source-authority${query}`), { params: { workspaceId: W } });
const post = (body: unknown, raw?: string) =>
  POST(new NextRequest(`http://localhost/api/workspaces/${W}/source-authority`, { method: "POST", body: raw ?? JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: { workspaceId: W } });
const accept = { url: URL_A, operation: "accept", reasonCode: "primary_document", expectedRevision: null };
const cur = (id: SourceIdentityV1) => `workspaces/${W}/sourceAuthority/${id.idHash}`;
function seedCurrent(id: SourceIdentityV1, fields: Record<string, unknown> = {}) {
  mockDb.put(cur(id), { schemaVersion: 1, workspaceId: W, identity: { ...id }, status: "ACCEPTED", reasonCode: "primary_document", revision: 1, updatedAt: ts(2000), updatedByUid: ADMIN, ...fields });
}
const standingTouched = () => mockDb.reads.some((r) => r.path.includes("sourceAuthority")) || [...mockDb.store.keys()].some((k) => k.includes("sourceAuthority") || k.startsWith("workspaceMembershipEvents/"));

beforeEach(() => {
  jest.clearAllMocks();
  flag = true;
  mockDb = new FakeDb();
  mockDb.put(`workspaces/${W}`, { schemaVersion: 1, id: W, type: "team", name: "Acme", ownerUserId: OWNER, createdByUserId: OWNER, createdAt: ts(1000), updatedAt: ts(1000) });
  for (const [uid, role] of [[OWNER, "owner"], [ADMIN, "admin"]]) {
    const id = computeMembershipId(W, uid);
    mockDb.put(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: W, uid, role, status: "active", createdAt: ts(1000), updatedAt: ts(1000), invitedByUserId: null, removedAt: null, removedByUserId: null });
  }
  mockDb.reads = [];
  applySpy.mockImplementation(() => undefined);
  readSpy.mockImplementation(() => undefined);
  mockedIdentity.mockResolvedValue({ status: "authenticated", uid: ADMIN });
  mockedAccess.mockResolvedValue(grant("admin"));
});

describe("gate order", () => {
  it.each([
    ["missing_credentials", "unauthorized"],
    ["invalid_token", "auth_error"],
  ])("unauthenticated (%s) → 401 %s, no access lookup, no Source Standing work (GET and POST)", async (reason, code) => {
    mockedIdentity.mockResolvedValue({ status: "unauthenticated", reason });
    for (const res of [await get(`?url=${encodeURIComponent(URL_A)}`), await post(accept)]) {
      expect(res.status).toBe(401);
      expect((await res.json()).errorCode).toBe(code);
    }
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(standingTouched()).toBe(false);
  });

  it.each([
    ["membership_not_found", 404],
    ["membership_removed", 404],
    ["wrong_workspace_type", 404],
    ["workspace_not_found", 404],
    ["team_workspaces_disabled", 404],
    ["owner_integrity_violation", 404],
    ["lookup_failed", 503],
  ])("no admission (%s) → %i, no Source Standing work", async (reason, status) => {
    mockedAccess.mockResolvedValue({ granted: false, reason });
    expect((await get(`?url=${encodeURIComponent(URL_A)}`)).status).toBe(status);
    expect((await post(accept)).status).toBe(status);
    expect(standingTouched()).toBe(false);
  });

  it.each(roles.map((r) => [r, r === "owner" || r === "admin"] as const))("role %s → sources.attest %s (real capability table)", async (role, allowed) => {
    mockedAccess.mockResolvedValue(grant(role));
    const g = await get(`?url=${encodeURIComponent(URL_A)}`);
    expect(g.status).toBe(allowed ? 200 : 403);
    if (!allowed) {
      expect(await g.json()).toEqual({ ok: false, errorCode: "insufficient_capability", message: "You do not have permission to manage source standing in this Workspace." });
      expect((await post(accept)).status).toBe(403);
      expect(standingTouched()).toBe(false);
    }
  });

  it("a capability set without sources.attest (e.g. audit.read only) is denied — no role-name comparison", async () => {
    mockedAccess.mockResolvedValue({ granted: true, capabilities: ["audit.read", "reviews.manage", "workspace.read"] });
    expect((await post(accept)).status).toBe(403);
  });

  it("flag OFF → concealed 404 identical to non-membership, AFTER auth/admission/capability, with zero Source Standing work", async () => {
    flag = false;
    const off = await post(accept);
    expect(off.status).toBe(404);
    const offBody = await off.json();
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    flag = true;
    expect(await (await post(accept)).json()).toEqual(offBody);
    flag = false;
    mockedAccess.mockResolvedValue(grant("admin"));
    expect((await get(`?url=${encodeURIComponent(URL_A)}`)).status).toBe(404);
    expect(applySpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(standingTouched()).toBe(false);
    // Unauthorized callers still get their own denial while the flag is off (feature state is not observable).
    mockedAccess.mockResolvedValue(grant("viewer"));
    expect((await post(accept)).status).toBe(403);
  });

  it("flag OFF: validation never runs (an invalid body still gets the concealed 404)", async () => {
    flag = false;
    expect((await post({ nonsense: true })).status).toBe(404);
  });
});

describe("GET ?url=", () => {
  it("absent → standing null with the canonical identity", async () => {
    const res = await get(`?url=${encodeURIComponent(URL_A + "#frag")}`);
    expect(await res.json()).toEqual({ ok: true, source: { canonicalUrl: URL_A, idHash: A.idHash }, standing: null });
  });

  it("current → status, reasonCode, revision, asOf (no actor)", async () => {
    seedCurrent(A, { revision: 3 });
    const body = await (await get(`?url=${encodeURIComponent(URL_A)}`)).json();
    expect(body.standing).toEqual({ status: "ACCEPTED", reasonCode: "primary_document", revision: 3, asOf: "1970-01-01T00:33:20.000Z" });
    expect(JSON.stringify(body)).not.toContain(ADMIN);
  });

  it("SUPERSEDED reports whether its successor resolves", async () => {
    seedCurrent(A, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: B.idHash });
    expect((await (await get(`?url=${encodeURIComponent(URL_A)}`)).json()).standing.successor).toEqual({ status: "UNRESOLVED" });
    seedCurrent(B);
    expect((await (await get(`?url=${encodeURIComponent(URL_A)}`)).json()).standing.successor).toEqual({ status: "RESOLVED", url: URL_B });
  });

  it("malformed → UNRESOLVED only", async () => {
    mockDb.put(cur(A), { bogus: true });
    expect((await (await get(`?url=${encodeURIComponent(URL_A)}`)).json()).standing).toEqual({ status: "UNRESOLVED" });
  });

  it.each([
    ["", 400, "invalid_request_body"],
    [`?url=${encodeURIComponent(URL_A)}&url=${encodeURIComponent(URL_B)}`, 400, "invalid_request_body"],
    [`?url=${encodeURIComponent(URL_A)}&workspaceId=ws-2`, 400, "unexpected_field"],
    ["?url=NIST%20glossary", 400, "SOURCE_AUTHORITY_INVALID_URL"],
    [`?url=${encodeURIComponent("https://u:p@docs.example.com/a")}`, 400, "SOURCE_AUTHORITY_INVALID_URL"],
    ["?url=http%3A%2F%2Flocalhost%2Fx", 400, "SOURCE_AUTHORITY_INVALID_URL"],
  ])("%s → %i %s, no read", async (q, status, code) => {
    const res = await get(q);
    expect(res.status).toBe(status);
    expect((await res.json()).errorCode).toBe(code);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("a read failure → 500 internal_error", async () => {
    mockDb.failReads = true;
    const res = await get(`?url=${encodeURIComponent(URL_A)}`);
    expect(res.status).toBe(500);
  });
});

describe("POST — strict body", () => {
  it("accept → 200 {status, revision}; the writer receives server-derived identity and the caller's uid", async () => {
    const res = await post(accept);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "ACCEPTED", revision: 1 });
    expect(applySpy).toHaveBeenCalledWith({ workspaceId: W, uid: ADMIN, identity: A, operation: "accept", reasonCode: "primary_document", successorIdentity: null, expectedRevision: null });
  });

  it.each(["status", "workspaceId", "actorUid", "actorRole", "updatedByUid", "updatedAt", "schemaVersion", "identity", "idHash", "revision", "score", "__proto__x"])("server-owned/unknown field %s → 400 unexpected_field, no write", async (field) => {
    const res = await post({ ...accept, [field]: "x" });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("unexpected_field");
    expect(applySpy).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", undefined, "{"],
    ["array", [accept], undefined],
    ["null", null, undefined],
    ["missing expectedRevision", { url: URL_A, operation: "accept", reasonCode: "primary_document" }, undefined],
    ["expectedRevision 0", { ...accept, expectedRevision: 0 }, undefined],
    ["expectedRevision 1.5", { ...accept, expectedRevision: 1.5 }, undefined],
    ["expectedRevision string", { ...accept, expectedRevision: "1" }, undefined],
    ["unknown operation", { ...accept, operation: "verify" }, undefined],
    ["prototype operation", { ...accept, operation: "toString" }, undefined],
    ["reason/operation mismatch", { ...accept, reasonCode: "inaccurate_or_unreliable_for_workspace" }, undefined],
    ["withdraw with null revision", { url: URL_A, operation: "withdraw", reasonCode: "withdrawn", expectedRevision: null }, undefined],
    ["supersede without successorUrl", { url: URL_A, operation: "supersede", reasonCode: "replaced_by_successor", expectedRevision: null }, undefined],
    ["successorUrl on accept", { ...accept, successorUrl: URL_B }, undefined],
    ["successorUrl null on accept", { ...accept, successorUrl: null }, undefined],
    ["oversized body", undefined, JSON.stringify({ ...accept, url: `https://docs.example.com/${"a".repeat(9000)}` })],
  ])("%s → 400 invalid_request_body, no write", async (_n, body, raw) => {
    const res = await post(body, raw);
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("invalid_request_body");
    expect(applySpy).not.toHaveBeenCalled();
  });

  it.each([
    ["url label", { ...accept, url: "NIST glossary" }, "url"],
    ["url userinfo", { ...accept, url: "https://u@docs.example.com/a" }, "url"],
    ["successorUrl reserved host", { url: URL_A, operation: "supersede", reasonCode: "replaced_by_successor", successorUrl: "https://intranet.local/x", expectedRevision: null }, "successorUrl"],
  ])("%s → 400 SOURCE_AUTHORITY_INVALID_URL", async (_n, body, field) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errorCode: "SOURCE_AUTHORITY_INVALID_URL", field });
  });
});

describe("POST — outcome mapping", () => {
  it("stale expectedRevision → 409 SOURCE_AUTHORITY_REVISION_CONFLICT", async () => {
    seedCurrent(A, { revision: 2 });
    const res = await post({ ...accept, operation: "dispute", reasonCode: "inaccurate_or_unreliable_for_workspace", expectedRevision: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).errorCode).toBe("SOURCE_AUTHORITY_REVISION_CONFLICT");
  });

  it("malformed current state → 409 SOURCE_AUTHORITY_STATE_UNRESOLVED (no repair)", async () => {
    mockDb.put(cur(A), { bogus: true });
    const res = await post({ ...accept, expectedRevision: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).errorCode).toBe("SOURCE_AUTHORITY_STATE_UNRESOLVED");
    expect(mockDb.read(cur(A))).toEqual({ bogus: true });
  });

  it.each([
    ["successor missing", () => undefined, URL_B, "successor_missing"],
    ["successor is the source", () => undefined, `${URL_A}#other-fragment`, "same_as_source"],
    ["successor chain has a missing link", () => seedCurrent(B, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: "c".repeat(64) }), URL_B, "successor_missing"],
  ])("%s → 409 SOURCE_AUTHORITY_SUCCESSOR_INVALID (%s)", async (_n, seed, successorUrl, reason) => {
    seed();
    const res = await post({ url: URL_A, operation: "supersede", reasonCode: "replaced_by_successor", successorUrl, expectedRevision: null });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ errorCode: "SOURCE_AUTHORITY_SUCCESSOR_INVALID", reason });
  });

  it("supersede + withdraw happy paths", async () => {
    seedCurrent(B);
    expect(await (await post({ url: URL_A, operation: "supersede", reasonCode: "replaced_by_successor", successorUrl: URL_B, expectedRevision: null })).json()).toEqual({ ok: true, status: "SUPERSEDED", revision: 1 });
    expect(await (await post({ url: URL_A, operation: "withdraw", reasonCode: "withdrawn", expectedRevision: 1 })).json()).toEqual({ ok: true, status: "WITHDRAWN", revision: 1 });
    expect(mockDb.read(cur(A))).toBeUndefined();
  });

  it("revocation between precheck and transaction: capability loss → 403; membership loss → concealed 404", async () => {
    mockedIdentity.mockResolvedValue({ status: "authenticated", uid: "ghost" }); // precheck (mocked) admits; the transaction finds no membership
    const res = await post(accept);
    expect(res.status).toBe(404);
    expect((await res.json()).errorCode).toBe("team_workspace_not_found");
    applySpy.mockResolvedValueOnce({ ok: false, reason: "denied", denial: "insufficient_capability" });
    expect((await post(accept)).status).toBe(403);
  });

  it("a thrown write (e.g. ABORTED after Firestore's own retries) → 500, never a partial success", async () => {
    applySpy.mockRejectedValueOnce(new Error("ABORTED"));
    expect((await post(accept)).status).toBe(500);
  });

  it("there is no PUT/PATCH/DELETE handler", async () => {
    const mod = await import("@/app/api/workspaces/[workspaceId]/source-authority/route");
    expect(Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(["GET", "POST"]);
  });
});

describe("Slice 2a.1 (P4) — the POST body is read through a byte-bounded stream reader", () => {
  const LIMIT = 8192;
  const enc = new TextEncoder();
  /** A body stream that records how many chunks were pulled, emitting `chunks` in order. */
  function trackedStream(chunks: Uint8Array[]) {
    const state = { pulls: 0, cancelled: false };
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulls += 1;
        if (i < chunks.length) controller.enqueue(chunks[i++]);
        else controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { stream, state };
  }
  const streamPost = (stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
    POST(new NextRequest(`http://localhost/api/workspaces/${W}/source-authority`, { method: "POST", body: stream, headers: { "content-type": "application/json", ...headers }, duplex: "half" } as RequestInit & { duplex: "half" }), { params: { workspaceId: W } });
  /** A valid accept body padded (with a JSON-legal whitespace run) to exactly `bytes` UTF-8 bytes. */
  const paddedAccept = (bytes: number) => {
    const base = JSON.stringify(accept);
    return base.slice(0, -1) + " ".repeat(bytes - enc.encode(base).length) + "}";
  };

  it("a body under the limit parses and writes", async () => {
    const res = await post(accept);
    expect(res.status).toBe(200);
  });

  it("exactly the limit (valid JSON) is accepted; one byte more is rejected without parsing or writing", async () => {
    const exact = paddedAccept(LIMIT);
    expect(enc.encode(exact).length).toBe(LIMIT);
    expect((await streamPost(trackedStream([enc.encode(exact)]).stream)).status).toBe(200);
    applySpy.mockClear();
    const over = paddedAccept(LIMIT + 1);
    const res = await streamPost(trackedStream([enc.encode(over)]).stream);
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("invalid_request_body");
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("an advertised Content-Length above the limit is rejected before the stream is consumed", async () => {
    const { stream, state } = trackedStream([enc.encode(JSON.stringify(accept))]);
    const res = await streamPost(stream, { "content-length": String(LIMIT + 1) });
    expect(res.status).toBe(400);
    expect(state.pulls).toBeLessThanOrEqual(1); // the runtime may pre-pull one chunk; the reader never asks for it
    expect(applySpy).not.toHaveBeenCalled();
  });

  it.each(["abc", "-1", "1e3", "12 34", ""])("a malformed Content-Length (%p) is rejected", async (cl) => {
    const res = await streamPost(trackedStream([enc.encode(JSON.stringify(accept))]).stream, { "content-length": cl });
    expect(res.status).toBe(400);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("a forged SMALL Content-Length cannot smuggle an oversized stream: reading stops at the limit and the stream is cancelled", async () => {
    const chunk = enc.encode("x".repeat(4096));
    const chunks = Array.from({ length: 100 }, () => chunk); // 400 KiB available
    const { stream, state } = trackedStream(chunks);
    const res = await streamPost(stream, { "content-length": "10" });
    expect(res.status).toBe(400);
    expect(state.pulls).toBeLessThanOrEqual(4); // 2 chunks fit, the 3rd overflows — never the whole 100
    expect(state.cancelled).toBe(true);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("no Content-Length at all is still bounded by the streamed byte count", async () => {
    const chunk = enc.encode("y".repeat(3000));
    const { stream, state } = trackedStream(Array.from({ length: 50 }, () => chunk));
    expect((await streamPost(stream)).status).toBe(400);
    expect(state.pulls).toBeLessThanOrEqual(5);
    expect(state.cancelled).toBe(true);
  });

  it("the limit counts UTF-8 BYTES, not UTF-16 characters (multibyte content)", async () => {
    // "é" is 1 UTF-16 unit but 2 UTF-8 bytes: 5000 of them is 5000 chars (< 8192) yet 10000 bytes (> 8192).
    const body = JSON.stringify({ ...accept, url: `https://docs.example.com/${"é".repeat(5000)}` });
    expect(body.length).toBeLessThan(LIMIT);
    expect(enc.encode(body).length).toBeGreaterThan(LIMIT);
    expect((await streamPost(trackedStream([enc.encode(body)]).stream)).status).toBe(400);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("invalid UTF-8 inside an otherwise VALID JSON body is rejected (only a fatal decoder can catch this)", async () => {
    // A lenient decoder turns 0xff into U+FFFD inside the url path, which still parses and is a valid identity —
    // so a 400 here can only come from strict UTF-8 decoding.
    const prefix = enc.encode('{"url":"https://docs.example.com/a');
    const suffix = enc.encode('","operation":"accept","reasonCode":"primary_document","expectedRevision":null}');
    const bytes = new Uint8Array([...prefix, 0xff, ...suffix]);
    const lenient = new TextDecoder("utf-8").decode(bytes);
    expect(() => JSON.parse(lenient)).not.toThrow(); // non-vacuity: the payload is valid JSON once decoded leniently
    const res = await streamPost(trackedStream([bytes]).stream);
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("invalid_request_body");
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("malformed JSON under the limit and an empty body are rejected normally", async () => {
    expect((await post(undefined, "{not json")).status).toBe(400);
    expect((await streamPost(trackedStream([]).stream)).status).toBe(400);
    const empty = await POST(new NextRequest(`http://localhost/api/workspaces/${W}/source-authority`, { method: "POST" }), { params: { workspaceId: W } });
    expect(empty.status).toBe(400);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", () => mockedIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" }), 401],
    ["no Team admission", () => mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" }), 404],
    ["no sources.attest (Member)", () => mockedAccess.mockResolvedValue(grant("member")), 403],
    ["flag off", () => (flag = false), 404],
  ])("%s → the body stream is never read", async (_n, arrange, status) => {
    arrange();
    const { stream, state } = trackedStream([enc.encode(JSON.stringify(accept))]);
    expect((await streamPost(stream)).status).toBe(status);
    expect(state.pulls).toBeLessThanOrEqual(1);
    expect(stream.locked).toBe(false); // the route never acquired a reader
  });
});

describe("Slice 2a.1 — P2 route mapping and DTO privacy", () => {
  it("source_is_referenced → 409 SOURCE_AUTHORITY_SOURCE_REFERENCED, revealing nothing about the predecessor", async () => {
    seedCurrent(B);
    seedCurrent(A, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: B.idHash });
    const res = await post({ url: URL_B, operation: "withdraw", reasonCode: "withdrawn", expectedRevision: 1 });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ ok: false, errorCode: "SOURCE_AUTHORITY_SOURCE_REFERENCED", message: "This source is currently used as the successor of another source standing and cannot be withdrawn or superseded." });
    const json = JSON.stringify(body);
    for (const leak of [A.idHash, URL_A, "docs.example.com/a", "count"]) expect(json).not.toContain(leak);
  });

  const FORBIDDEN_KEYS = ["actorUid", "actorRole", "updatedByUid", "events", "history", "membership", "role", "uid", "workspaceId"];
  const allKeys = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), allKeys(x, out));
    return out;
  };

  it.each([
    ["absent", () => undefined],
    ["ACCEPTED", () => seedCurrent(A)],
    ["SUPERSEDED (resolved)", () => (seedCurrent(B), seedCurrent(A, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: B.idHash }))],
    ["SUPERSEDED (unresolved)", () => seedCurrent(A, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: B.idHash })],
    ["malformed", () => mockDb.put(cur(A), { bogus: true, updatedByUid: ADMIN, actorUid: ADMIN })],
  ])("management GET (%s) never exposes actor, membership or history keys anywhere in the response", async (_n, seed) => {
    seed();
    mockDb.put(`${cur(A)}/events/e1`, { schemaVersion: 1, toStatus: "ACCEPTED", actorUid: ADMIN, actorRole: "admin", revision: 1 });
    const body = await (await get(`?url=${encodeURIComponent(URL_A)}`)).json();
    const keys = allKeys(body);
    for (const k of FORBIDDEN_KEYS) expect({ k, present: keys.includes(k) }).toEqual({ k, present: false });
    expect(JSON.stringify(body)).not.toContain(ADMIN);
  });

  it("POST success never echoes actor or record internals", async () => {
    const body = await (await post(accept)).json();
    expect(Object.keys(body).sort()).toEqual(["ok", "revision", "status"]);
  });
});
