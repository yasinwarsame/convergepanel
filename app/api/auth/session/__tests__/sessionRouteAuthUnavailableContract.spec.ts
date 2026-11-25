/**
 * #332 R7: the session mint's client/server error contract.
 *  - "Verification could not run" answers exactly 503 + code "auth_unavailable", sets no cookie, and discloses nothing.
 *  - A credential verdict (revoked / disabled / invalid) answers 401 WITHOUT that code, so the client's ordinary
 *    fail-closed sign-out still applies.
 *  - createSessionCookie: a transient Auth failure becomes the same retryable 503; any other failure stays the 500.
 */
const mockVerifyIdToken = jest.fn();
const mockCreateSessionCookie = jest.fn();
jest.mock("@/lib/firebase/admin", () => ({
  get adminAuth() {
    return {
      verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
      createSessionCookie: (...args: unknown[]) => mockCreateSessionCookie(...args),
      verifySessionCookie: jest.fn(),
    };
  },
}));
const mockLoggerError = jest.fn();
jest.mock("@/lib/logger", () => ({ logger: { error: (...a: unknown[]) => mockLoggerError(...a), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
const mockLogAuthSessionEvent = jest.fn();
jest.mock("@/lib/authTelemetry", () => ({ logAuthSessionEvent: (...a: unknown[]) => mockLogAuthSessionEvent(...a) }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/auth/session/route";

const post = () =>
  POST(new NextRequest("http://localhost/api/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: "synthetic-token" }) }));
const fbErr = (code: string, message = "upstream detail SECRETISH") => Object.assign(new Error(message), { code });
const noCookie = (res: Response) => expect(res.headers.get("set-cookie") ?? "").not.toMatch(/__session=[^;]/);
const UNAVAILABLE = { error: "Authentication service unavailable", code: "auth_unavailable" };

beforeEach(() => jest.clearAllMocks());

describe("#332 R7 — the mint's auth_unavailable contract", () => {
  it.each(["auth/id-token-revoked", "auth/user-disabled", "auth/argument-error", "auth/id-token-expired", "auth/user-not-found"])(
    "credential verdict %s → 401 WITHOUT the auth_unavailable code (the client still signs out), no cookie",
    async (code) => {
      mockVerifyIdToken.mockRejectedValue(fbErr(code));
      const res = await post();
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid or expired token" });
      noCookie(res);
      expect(mockCreateSessionCookie).not.toHaveBeenCalled();
    }
  );

  it.each(["auth/internal-error", "app/internal-error", "app/network-error", "app/network-timeout"])(
    "createSessionCookie transient failure %s → the same retryable 503 + code, no cookie, code-only log",
    async (code) => {
      mockVerifyIdToken.mockResolvedValue({ uid: "uid-a" });
      mockCreateSessionCookie.mockRejectedValue(fbErr(code));
      const res = await post();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual(UNAVAILABLE);
      expect(JSON.stringify(body)).not.toMatch(/SECRETISH|uid-a/);
      noCookie(res);
      expect(mockLogAuthSessionEvent).toHaveBeenCalledWith("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "auth_unavailable" });
      expect(mockLoggerError).toHaveBeenCalledWith(expect.any(String), { errorCode: code });
      expect(JSON.stringify(mockLoggerError.mock.calls)).not.toMatch(/SECRETISH|synthetic-token/);
    }
  );

  it.each([["unclassified code", fbErr("auth/invalid-argument")], ["no code", new Error("boom")], ["near-miss code", fbErr("app/network-error ")]])(
    "createSessionCookie non-transient failure (%s) stays the 500 without the code (unchanged behaviour)",
    async (_label, err) => {
      mockVerifyIdToken.mockResolvedValue({ uid: "uid-a" });
      mockCreateSessionCookie.mockRejectedValue(err);
      const res = await post();
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Failed to create session" });
      noCookie(res);
    }
  );

  it("control: verified identity + cookie created → 200 with the cookie (the contract changes no success path)", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "uid-a" });
    mockCreateSessionCookie.mockResolvedValue("synthetic-session-cookie");
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true, uid: "uid-a" });
    expect(res.headers.get("set-cookie") ?? "").toMatch(/__session=synthetic-session-cookie/);
    expect(mockVerifyIdToken).toHaveBeenCalledWith("synthetic-token", true); // checkRevoked stays on
  });
});
