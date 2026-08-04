/**
 * Auth Lifecycle Hardening, Step 6.14 — session endpoint client tests, and
 * Step 6.16 — the bounded single retry / no-token-logging requirements.
 * `MinimalAuthUser` (uid + getIdToken) lets these run with a plain mock
 * object — no Firebase SDK, no DOM.
 */

jest.mock("@/lib/client/authSessionTelemetry", () => ({
  logAuthSessionClientEvent: jest.fn(),
}));

import {
  establishServerSession,
  clearServerSession,
  getServerSessionIdentity,
  verifyClientServerIdentityMatch,
  type MinimalAuthUser,
} from "@/lib/client/sessionSync";
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

describe("establishServerSession", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    jest.clearAllMocks();
  });

  it("returns ok:true and the server uid on a successful, matching response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "user-1" }));
    const user = mockUser("user-1");
    const outcome = await establishServerSession(user);
    expect(outcome).toEqual({ ok: true, uid: "user-1" });
    expect(user.getIdToken).toHaveBeenCalledWith(true); // Step 6.5: always force-refreshed
  });

  it("never sends the idToken/uid anywhere except the request body — telemetry calls carry no token/uid fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "user-1" }));
    await establishServerSession(mockUser("user-1"));
    const calls = (logAuthSessionClientEvent as jest.Mock).mock.calls;
    for (const [, metadata] of calls) {
      expect(metadata).not.toHaveProperty("uid");
      expect(metadata).not.toHaveProperty("token");
      expect(metadata).not.toHaveProperty("idToken");
    }
  });

  it("REGRESSION (root cause): fails closed and clears the server session when the server-returned uid does not match the client uid", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "stale-previous-user" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: false })); // the DELETE clearServerSession issues
    const outcome = await establishServerSession(mockUser("fresh-current-user"));
    expect(outcome).toEqual({ ok: false, reason: "uid_mismatch" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "DELETE" });
  });

  it("retries exactly once on a 401 (documented token-expiration race) and succeeds if the retry does", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "expired" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "user-1" }));
    const user = mockUser("user-1");
    const outcome = await establishServerSession(user);
    expect(outcome).toEqual({ ok: true, uid: "user-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(user.getIdToken).toHaveBeenCalledTimes(2);
  });

  it("does not retry a second time — a 401 on the retry itself is a final failure, never an infinite loop", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "expired" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "still expired" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: false })); // clearServerSession's DELETE
    const outcome = await establishServerSession(mockUser("user-1"));
    expect(outcome.ok).toBe(false);
    // exactly 2 POST attempts (initial + one bounded retry) + 1 DELETE = 3
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns network_error when the initial POST itself throws (no DELETE cleanup attempted — there is nothing to have half-established)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const outcome = await establishServerSession(mockUser("user-1"));
    expect(outcome).toEqual({ ok: false, reason: "network_error" });
  });

  it("returns server_error and clears the session on a non-2xx, non-401 response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: false }));
    const outcome = await establishServerSession(mockUser("user-1"));
    expect(outcome).toEqual({ ok: false, reason: "server_error" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns invalid_response and clears the session when the body is malformed", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonsense: true }) } as Response);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: false }));
    const outcome = await establishServerSession(mockUser("user-1"));
    expect(outcome).toEqual({ ok: false, reason: "invalid_response" });
  });

  it("returns invalid_response and clears the session when JSON parsing throws", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: false }));
    const outcome = await establishServerSession(mockUser("user-1"));
    expect(outcome).toEqual({ ok: false, reason: "invalid_response" });
  });
});

describe("clearServerSession", () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  it("returns true on a successful DELETE", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: false }));
    await expect(clearServerSession()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", expect.objectContaining({ method: "DELETE" }));
  });

  it("returns false (never throws) on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
    await expect(clearServerSession()).resolves.toBe(false);
  });

  it("returns false (never throws) on a network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(clearServerSession()).resolves.toBe(false);
  });

  it("is idempotent — calling it twice in a row both resolve successfully", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { authenticated: false }));
    await expect(clearServerSession()).resolves.toBe(true);
    await expect(clearServerSession()).resolves.toBe(true);
  });
});

describe("getServerSessionIdentity", () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  it("returns authenticated:true + uid on success", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "user-1" }));
    await expect(getServerSessionIdentity()).resolves.toEqual({ authenticated: true, uid: "user-1" });
  });

  it("returns authenticated:false on a non-2xx response, never throwing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    await expect(getServerSessionIdentity()).resolves.toEqual({ authenticated: false });
  });

  it("returns authenticated:false on a network error, never throwing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(getServerSessionIdentity()).resolves.toEqual({ authenticated: false });
  });
});

describe("verifyClientServerIdentityMatch", () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  it("returns true when the server-reported uid matches the client uid", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "user-1" }));
    await expect(verifyClientServerIdentityMatch("user-1")).resolves.toBe(true);
  });

  it("returns false and logs a mismatch when the server-reported uid differs", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: true, uid: "someone-else" }));
    await expect(verifyClientServerIdentityMatch("user-1")).resolves.toBe(false);
    expect(logAuthSessionClientEvent).toHaveBeenCalledWith("session_identity_mismatch", expect.any(Object));
  });

  it("returns false when the server reports no session at all", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { authenticated: false }));
    await expect(verifyClientServerIdentityMatch("user-1")).resolves.toBe(false);
  });
});
