/**
 * The session handshake's client/server error contract (Stage 0; originally #332 R7).
 *  - "Verification could not run" answers exactly 503 + code "auth_unavailable", sets only the expiry, and discloses nothing.
 *  - A credential verdict (revoked / disabled / invalid) answers 401 WITHOUT that code, so the client's ordinary
 *    fail-closed sign-out still applies.
 * ZCA P3 R2: the cookie-creation rows (transient → 503, other → 500) were DELETED with cookie creation.
 */
const mockVerifyIdToken = jest.fn();
jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: require("./handshakeHarness").strictAdminAuth((...args: unknown[]) => mockVerifyIdToken(...args)),
}));
const mockLoggerError = jest.fn();
jest.mock("@/lib/logger", () => ({ logger: { error: (...a: unknown[]) => mockLoggerError(...a), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
const mockLogAuthSessionEvent = jest.fn();
jest.mock("@/lib/authTelemetry", () => ({ logAuthSessionEvent: (...a: unknown[]) => mockLogAuthSessionEvent(...a) }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/auth/session/route";
import { expectExpiryOnly, forbiddenAdminAccess } from "./handshakeHarness";

const post = () =>
  POST(new NextRequest("http://localhost/api/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: "synthetic-token" }) }));
const fbErr = (code: string, message = "upstream detail SECRETISH") => Object.assign(new Error(message), { code });
const noCookie = (res: Response) => expectExpiryOnly(res);
const UNAVAILABLE = { error: "Authentication service unavailable", code: "auth_unavailable" };

beforeEach(() => {
  jest.clearAllMocks();
  forbiddenAdminAccess.length = 0;
});
afterEach(() => expect(forbiddenAdminAccess).toEqual([]));

describe("#332 R7 — the handshake's auth_unavailable contract", () => {
  it.each(["auth/id-token-revoked", "auth/user-disabled", "auth/argument-error", "auth/id-token-expired", "auth/user-not-found"])(
    "credential verdict %s → 401 WITHOUT the auth_unavailable code (the client still signs out), no cookie",
    async (code) => {
      mockVerifyIdToken.mockRejectedValue(fbErr(code));
      const res = await post();
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid or expired token" });
      noCookie(res);
    }
  );

  it.each(["auth/internal-error", "app/internal-error", "app/network-error", "app/network-timeout"])(
    "verifier transient failure %s → 503 + code, only the expiry, code-only log",
    async (code) => {
      mockVerifyIdToken.mockRejectedValue(fbErr(code));
      const res = await post();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual(UNAVAILABLE);
      expect(JSON.stringify(body)).not.toMatch(/SECRETISH/);
      noCookie(res);
      expect(mockLogAuthSessionEvent).toHaveBeenCalledWith("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "auth_unavailable" });
      expect(mockLoggerError).toHaveBeenCalledWith(expect.any(String), { errorCode: code });
      expect(JSON.stringify(mockLoggerError.mock.calls)).not.toMatch(/SECRETISH|synthetic-token/);
    }
  );

  it("control: verified identity → 200 { authenticated, uid } and only the expiry (nothing minted)", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "uid-a" });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true, uid: "uid-a" });
    noCookie(res);
    expect(mockVerifyIdToken).toHaveBeenCalledWith("synthetic-token", true); // checkRevoked stays on
  });
});
