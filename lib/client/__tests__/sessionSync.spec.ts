/**
 * The session verification handshake, client side (ZCA P3 R2 "verify, don't mint").
 *
 * Converted from the Step 6.14 / 6.16 session-cookie client tests: every failure path used to be followed by a
 * client DELETE (the session-clearing helper) and every mint waited for DELETEs in flight (R-S0-7). Both were removed —
 * the server holds no session state — so the old "… and clears the session" assertions are INVERTED here: every
 * outcome sends POSTs only, never a DELETE. `MinimalAuthUser` (uid + getIdToken) keeps these free of Firebase/DOM.
 */

jest.mock("@/lib/client/authSessionTelemetry", () => ({
  logAuthSessionClientEvent: jest.fn(),
}));

import * as sessionSync from "@/lib/client/sessionSync";
import { establishServerSession, type MinimalAuthUser } from "@/lib/client/sessionSync";
import { logAuthSessionClientEvent } from "@/lib/client/authSessionTelemetry";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function mockUser(uid: string, tokenValue = "id-token"): MinimalAuthUser & { getIdToken: jest.Mock } {
  return { uid, getIdToken: jest.fn().mockResolvedValue(tokenValue) };
}

let fetchMock: jest.Mock;
const methods = () => fetchMock.mock.calls.map((c) => (c[1] as RequestInit).method);
const UNAVAILABLE = { error: "Authentication service unavailable", code: "auth_unavailable" };
const REJECTED = { error: "Invalid or expired token" };

beforeEach(() => {
  fetchMock = jest.fn();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
  jest.clearAllMocks();
});
afterEach(() => {
  // R2 MA / invariant 5: whatever happened, the client never sent anything but a POST.
  for (const m of methods()) expect(m).toBe("POST");
});

describe("establishServerSession — the handshake request", () => {
  it("returns ok:true and the server uid on a successful, matching response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "user-1" }));
    const user = mockUser("user-1");
    const outcome = await establishServerSession(user);
    expect(outcome).toEqual({ ok: true, uid: "user-1" });
    expect(user.getIdToken).toHaveBeenCalledWith(true); // Step 6.5: force-refreshed by default
  });

  it("sends the token in BOTH Authorization: Bearer and the JSON body, identical (R1 L3 rollback compatibility)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "user-1" }));
    await establishServerSession(mockUser("user-1", "tok-123"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/session");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer tok-123" });
    expect(JSON.parse(String(init.body))).toEqual({ idToken: "tok-123" });
  });

  it("telemetry calls carry no token/uid fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "user-1" }));
    await establishServerSession(mockUser("user-1"));
    for (const [, metadata] of (logAuthSessionClientEvent as jest.Mock).mock.calls) {
      expect(metadata).not.toHaveProperty("uid");
      expect(metadata).not.toHaveProperty("token");
      expect(metadata).not.toHaveProperty("idToken");
      expect(JSON.stringify(metadata ?? {})).not.toContain("id-token");
    }
  });

  it("an abort signalled before the request is sent → network_error and NO request at all", async () => {
    const controller = new AbortController();
    const user = mockUser("u");
    user.getIdToken.mockImplementation(async () => {
      controller.abort();
      return "tok";
    });
    const outcome = await establishServerSession(user, { signal: controller.signal });
    expect(outcome).toEqual({ ok: false, reason: "network_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("R2 MA: nothing but the abort check separates the token read from the send (the POST starts in the same tick chain)", async () => {
    let resolveToken!: (t: string) => void;
    const user: MinimalAuthUser = { uid: "u", getIdToken: () => new Promise<string>((r) => (resolveToken = r)) };
    fetchMock.mockReturnValue(new Promise(() => undefined));
    void establishServerSession(user);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    resolveToken("tok");
    for (let i = 0; i < 3 && fetchMock.mock.calls.length === 0; i++) await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("R2 MA: an unrelated HUNG request to the session endpoint (e.g. an old build's DELETE) never delays the handshake", async () => {
    const hung = new Promise<Response>(() => undefined);
    fetchMock.mockImplementation((_url: string, init: RequestInit) => (init.method === "DELETE" ? hung : Promise.resolve(jsonResponse(200, { authenticated: true, uid: "u" }))));
    void fetch("/api/auth/session", { method: "DELETE" });
    fetchMock.mockClear();
    const outcome = await establishServerSession(mockUser("u"));
    expect(outcome).toEqual({ ok: true, uid: "u" });
  });

  it("the module exports no session-clearing function (R2 MA: no client DELETE exists)", () => {
    expect(Object.keys(sessionSync).filter((k) => /clear|delete|logout/i.test(k))).toEqual([]);
  });
});

describe("establishServerSession — failures are returned, never followed by a DELETE (inverted from the clear-on-failure contract)", () => {
  it("REGRESSION (root cause): a server-returned uid that does not match the client uid → uid_mismatch; ONE POST, nothing else", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "stale-previous-user" }));
    const outcome = await establishServerSession(mockUser("fresh-current-user"));
    expect(outcome).toEqual({ ok: false, reason: "uid_mismatch" });
    expect(methods()).toEqual(["POST"]);
    expect(logAuthSessionClientEvent).toHaveBeenCalledWith("session_identity_mismatch", expect.anything());
  });

  it("retries exactly once on a 401 (documented token-expiration race) and succeeds if the retry does", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, REJECTED)).mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "user-1" }));
    const user = mockUser("user-1");
    const outcome = await establishServerSession(user);
    expect(outcome).toEqual({ ok: true, uid: "user-1" });
    expect(user.getIdToken.mock.calls).toEqual([[true], [true]]);
    expect(methods()).toEqual(["POST", "POST"]);
  });

  it("does not retry a second time — a 401 on the retry is final: exactly 2 POSTs, no DELETE", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, REJECTED));
    const outcome = await establishServerSession(mockUser("user-1"));
    expect(outcome).toEqual({ ok: false, reason: "server_error" });
    expect(methods()).toEqual(["POST", "POST"]);
  });

  it("returns network_error when the POST itself throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const outcome = await establishServerSession(mockUser("user-1"));
    expect(outcome).toEqual({ ok: false, reason: "network_error" });
    expect(methods()).toEqual(["POST"]);
  });

  it.each([[500], [502], [400], [415], [404]])("a non-2xx %p → server_error; one POST only", async (status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(status, { error: "x" }));
    const outcome = await establishServerSession(mockUser("user-1"));
    expect(outcome).toEqual({ ok: false, reason: "server_error" });
    expect(methods()).toEqual(["POST"]);
  });

  it("a malformed body → invalid_response; a body whose JSON parse throws → invalid_response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: false }));
    expect(await establishServerSession(mockUser("user-1"))).toEqual({ ok: false, reason: "invalid_response" });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } } as unknown as Response);
    expect(await establishServerSession(mockUser("user-1"))).toEqual({ ok: false, reason: "invalid_response" });
    expect(methods()).toEqual(["POST", "POST"]);
  });
});

describe("R2 L-2 — 403 cross_origin is its own outcome (not a credential verdict)", () => {
  it("exact 403 { code: cross_origin } → reason cross_origin, no retry", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: "Cross-origin request refused", code: "cross_origin" }));
    const user = mockUser("u");
    const outcome = await establishServerSession(user);
    expect(outcome).toEqual({ ok: false, reason: "cross_origin" });
    expect(methods()).toEqual(["POST"]);
    expect(user.getIdToken).toHaveBeenCalledTimes(1);
  });

  it("a 403 with any other (or no) code is an ordinary server_error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { code: "cross-origin" }));
    expect(await establishServerSession(mockUser("u"))).toEqual({ ok: false, reason: "server_error" });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => { throw new Error("x"); } } as unknown as Response);
    expect(await establishServerSession(mockUser("u"))).toEqual({ ok: false, reason: "server_error" });
  });

  it("a 503 carrying code cross_origin is NOT cross_origin (status and code must both match)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { code: "cross_origin" }));
    expect(await establishServerSession(mockUser("u"))).toEqual({ ok: false, reason: "server_error" });
  });

  it("keepSessionOnAuthUnavailable does not change a 403 cross_origin", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { code: "cross_origin" }));
    expect(await establishServerSession(mockUser("u"), { keepSessionOnAuthUnavailable: true })).toEqual({ ok: false, reason: "cross_origin" });
  });
});

describe("Stage 0 F3 — keepSessionOnAuthUnavailable (same-uid refresh only)", () => {
  it("flag + exact 503 auth_unavailable → reason auth_unavailable, exactly one POST (no retry)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, UNAVAILABLE));
    const outcome = await establishServerSession(mockUser("u"), { keepSessionOnAuthUnavailable: true });
    expect(outcome).toEqual({ ok: false, reason: "auth_unavailable" });
    expect(methods()).toEqual(["POST"]);
  });

  it("flag ABSENT + the same 503 → server_error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, UNAVAILABLE));
    expect(await establishServerSession(mockUser("u"))).toEqual({ ok: false, reason: "server_error" });
  });

  it.each([
    ["a 503 without the code", jsonResponse(503, { error: "x" })],
    ["a 503 with another code", jsonResponse(503, { code: "auth_unavailable_x" })],
    ["a 503 whose body cannot be parsed", { ok: false, status: 503, json: async () => { throw new Error("x"); } } as unknown as Response],
    ["a 500 carrying the code", jsonResponse(500, UNAVAILABLE)],
  ])("flag + %s → fail closed (server_error)", async (_n, res) => {
    fetchMock.mockResolvedValueOnce(res);
    expect(await establishServerSession(mockUser("u"), { keepSessionOnAuthUnavailable: true })).toEqual({ ok: false, reason: "server_error" });
  });

  it("flag + 401 twice (credential verdict) → retried once, then server_error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, REJECTED));
    expect(await establishServerSession(mockUser("u"), { keepSessionOnAuthUnavailable: true })).toEqual({ ok: false, reason: "server_error" });
    expect(methods()).toEqual(["POST", "POST"]);
  });

  it("flag + network error → network_error; flag + uid mismatch → uid_mismatch", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await establishServerSession(mockUser("u"), { keepSessionOnAuthUnavailable: true })).toEqual({ ok: false, reason: "network_error" });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "other" }));
    expect(await establishServerSession(mockUser("u"), { keepSessionOnAuthUnavailable: true })).toEqual({ ok: false, reason: "uid_mismatch" });
  });
});

describe("Stage 0 B2 — a credential rejection is never erased by a later outage answer", () => {
  it.each(["invalid", "revoked", "disabled", "expired / refresh race"])(
    "flag + 401 (%s) then 503 auth_unavailable on the retry → server_error, never auth_unavailable",
    async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401, REJECTED)).mockResolvedValueOnce(jsonResponse(503, UNAVAILABLE));
      const outcome = await establishServerSession(mockUser("u"), { keepSessionOnAuthUnavailable: true });
      expect(outcome).toEqual({ ok: false, reason: "server_error" });
      expect(methods()).toEqual(["POST", "POST"]);
      expect(logAuthSessionClientEvent).toHaveBeenCalledWith("session_sync_failed", expect.objectContaining({ failureCategory: "http_401_then_503" }));
      expect(logAuthSessionClientEvent).not.toHaveBeenCalledWith("session_sync_failed", expect.objectContaining({ failureCategory: "auth_unavailable_kept" }));
    },
  );

  it("control: flag + 503 on the FIRST attempt (no prior verdict) is still kept", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, UNAVAILABLE));
    expect(await establishServerSession(mockUser("u"), { keepSessionOnAuthUnavailable: true })).toEqual({ ok: false, reason: "auth_unavailable" });
  });

  it("control: 401 then 200 (the documented expiry race) still succeeds", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, REJECTED)).mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "u" }));
    expect(await establishServerSession(mockUser("u"), { keepSessionOnAuthUnavailable: true })).toEqual({ ok: true, uid: "u" });
  });
});

describe("Stage 0 B1 — forceRefresh (the first attempt only; the 401 retry always forces)", () => {
  it.each([
    ["default (absent)", undefined, [[true]]],
    ["forceRefresh: true", true, [[true]]],
    ["forceRefresh: false", false, [[false]]],
  ] as const)("%s → first attempt getIdToken(%p)", async (_n, forceRefresh, calls) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "u" }));
    const user = mockUser("u");
    await establishServerSession(user, forceRefresh === undefined ? {} : { forceRefresh });
    expect(user.getIdToken.mock.calls).toEqual(calls);
  });

  it("forceRefresh: false + 401 → the bounded retry IS forced (expiry race still covered)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, REJECTED)).mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "u" }));
    const user = mockUser("u");
    expect(await establishServerSession(user, { forceRefresh: false })).toEqual({ ok: true, uid: "u" });
    expect(user.getIdToken.mock.calls).toEqual([[false], [true]]);
  });
});
