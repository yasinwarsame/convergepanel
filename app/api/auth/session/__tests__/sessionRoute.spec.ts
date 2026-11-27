/**
 * Auth Lifecycle Hardening, Step 6.14 — POST/DELETE/GET
 * /api/auth/session. This is the only place a client ID token is ever
 * exchanged for the `__session` cookie, and the only place it's cleared.
 */

const mockVerifyIdToken = jest.fn();
const mockCreateSessionCookie = jest.fn();
const mockVerifySessionCookieOnAdmin = jest.fn();

jest.mock("@/lib/firebase/admin", () => ({
  get adminAuth() {
    return {
      verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
      createSessionCookie: (...args: unknown[]) => mockCreateSessionCookie(...args),
      verifySessionCookie: (...args: unknown[]) => mockVerifySessionCookieOnAdmin(...args),
    };
  },
}));

const mockLoggerError = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockLogAuthSessionEvent = jest.fn();
jest.mock("@/lib/authTelemetry", () => ({
  logAuthSessionEvent: (...args: unknown[]) => mockLogAuthSessionEvent(...args),
}));

import { NextRequest } from "next/server";
import * as sessionRouteModule from "@/app/api/auth/session/route";
import { POST, DELETE } from "@/app/api/auth/session/route";

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/auth/session", () => {
  it("rejects a missing idToken", async () => {
    const res = await POST(postRequest({}));
    expect(res.status).toBe(400);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("rejects a malformed idToken (non-string)", async () => {
    const res = await POST(postRequest({ idToken: 12345 }));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid/expired token with 401, and never leaks the raw verification error", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("Firebase ID token has expired. Get a fresh token and try again."));
    const res = await POST(postRequest({ idToken: "expired-token" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid or expired token");
    expect(JSON.stringify(body)).not.toMatch(/expired\. Get a fresh token/);
  });

  it("on a valid token, creates a session cookie and returns { authenticated: true, uid } — uid is server-derived, never the client's own assertion", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
    mockCreateSessionCookie.mockResolvedValue("signed-cookie-value");
    const res = await POST(postRequest({ idToken: "valid-token" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ authenticated: true, uid: "user-1" });
  });

  it("sets the cookie with httpOnly/secure/sameSite=lax/path=/ and a 5-day maxAge", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
    mockCreateSessionCookie.mockResolvedValue("signed-cookie-value");
    const res = await POST(postRequest({ idToken: "valid-token" }));
    const setCookie = res.cookies.get("__session");
    expect(setCookie).toBeDefined();
    expect(setCookie?.value).toBe("signed-cookie-value");
    expect(setCookie?.httpOnly).toBe(true);
    expect(setCookie?.secure).toBe(true);
    expect(setCookie?.sameSite).toBe("lax");
    expect(setCookie?.path).toBe("/");
    expect(setCookie?.maxAge).toBe(60 * 60 * 24 * 5);
  });

  it("sets Cache-Control: no-store", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
    mockCreateSessionCookie.mockResolvedValue("signed-cookie-value");
    const res = await POST(postRequest({ idToken: "valid-token" }));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 500 without leaking details when session cookie creation fails", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
    mockCreateSessionCookie.mockRejectedValue(new Error("internal Firebase Admin detail"));
    const res = await POST(postRequest({ idToken: "valid-token" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/internal Firebase Admin detail/);
  });

  describe("SESSREV: the mint refuses revoked / disabled identities and fails closed on outages", () => {
    const fbErr = (code: string, message = "firebase detail") => Object.assign(new Error(message), { code });

    function expectNoCookie(res: Response & { cookies?: { get(n: string): unknown } }) {
      expect(mockCreateSessionCookie).not.toHaveBeenCalled();
      expect((res as unknown as { cookies: { get(n: string): unknown } }).cookies.get("__session")).toBeUndefined();
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }

    it("verifies the ID token WITH checkRevoked = true (the SDK's live disabled + tokensValidAfterTime check)", async () => {
      mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
      mockCreateSessionCookie.mockResolvedValue("signed-cookie-value");
      const res = await POST(postRequest({ idToken: "valid-token" }));
      expect(res.status).toBe(200);
      expect(mockVerifyIdToken).toHaveBeenCalledTimes(1);
      expect(mockVerifyIdToken).toHaveBeenCalledWith("valid-token", true);
      expect(mockCreateSessionCookie).toHaveBeenCalledWith("valid-token", { expiresIn: 60 * 60 * 24 * 5 * 1000 });
    });

    it("revoked token (auth/id-token-revoked) → 401, no cookie minted, generic body", async () => {
      mockVerifyIdToken.mockRejectedValue(fbErr("auth/id-token-revoked", "The Firebase ID token has been revoked."));
      const res = await POST(postRequest({ idToken: "revoked-token" }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid or expired token" });
      expectNoCookie(res);
      expect(mockLogAuthSessionEvent).toHaveBeenCalledWith("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "revoked_token" });
    });

    it("disabled account (auth/user-disabled) → 401, no cookie minted, account state not disclosed", async () => {
      mockVerifyIdToken.mockRejectedValue(fbErr("auth/user-disabled", "The user record is disabled."));
      const res = await POST(postRequest({ idToken: "disabled-user-token" }));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: "Invalid or expired token" });
      expect(JSON.stringify(body)).not.toMatch(/disabled/i);
      expectNoCookie(res);
      expect(mockLogAuthSessionEvent).toHaveBeenCalledWith("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "account_disabled" });
    });

    it("deleted account (auth/user-not-found from the checkRevoked lookup) → 401, no cookie", async () => {
      mockVerifyIdToken.mockRejectedValue(fbErr("auth/user-not-found"));
      const res = await POST(postRequest({ idToken: "t" }));
      expect(res.status).toBe(401);
      expectNoCookie(res);
    });

    it.each(["auth/internal-error", "app/internal-error", "app/network-error", "app/network-timeout"])(
      "transient verifier failure %s → 503 (never 200, never a cookie, never 401)",
      async (code) => {
        mockVerifyIdToken.mockRejectedValue(fbErr(code, "upstream detail xyz"));
        const res = await POST(postRequest({ idToken: "t" }));
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body).toEqual({ error: "Authentication service unavailable", code: "auth_unavailable" });
        expect(JSON.stringify(body)).not.toMatch(/upstream detail/);
        expectNoCookie(res);
        expect(mockLogAuthSessionEvent).toHaveBeenCalledWith("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "auth_unavailable" });
        expect(mockLoggerError).toHaveBeenCalledWith(expect.any(String), { errorCode: code });
      }
    );

    it.each([
      ["no code", new Error("boom")],
      ["non-string code", Object.assign(new Error("boom"), { code: 503 })],
      ["a thrown non-Error", "string-rejection"],
      ["near-miss transient code", fbErr("auth/internal-error ")],
    ])("an unclassified failure (%s) is a credential failure → 401, no cookie", async (_label, err) => {
      mockVerifyIdToken.mockRejectedValue(err);
      const res = await POST(postRequest({ idToken: "t" }));
      expect(res.status).toBe(401);
      expectNoCookie(res);
    });

    it.each([[{}], [{ uid: "" }], [{ uid: 42 }], [null]])("a verified-but-uidless decode (%p) → 401, no cookie", async (decoded) => {
      mockVerifyIdToken.mockResolvedValue(decoded);
      const res = await POST(postRequest({ idToken: "t" }));
      expect(res.status).toBe(401);
      expectNoCookie(res);
    });
  });

  it("never logs the ID token or a provider error message (code only), on every failure path", async () => {
    const TOKEN = "eyJhbGciOiJSUzI1NiJ9.SECRET-PAYLOAD.sig";
    const leaky = (code: string) => Object.assign(new Error(`bad token ${TOKEN} for user@example.com`), { code });
    const paths: Array<() => void> = [
      () => mockVerifyIdToken.mockRejectedValue(leaky("auth/id-token-revoked")),
      () => mockVerifyIdToken.mockRejectedValue(leaky("auth/user-disabled")),
      () => mockVerifyIdToken.mockRejectedValue(leaky("app/network-error")),
      () => {
        mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
        mockCreateSessionCookie.mockRejectedValue(leaky("auth/invalid-id-token"));
      },
    ];
    for (const arrange of paths) {
      jest.clearAllMocks();
      arrange();
      await POST(postRequest({ idToken: TOKEN }));
      const logged = JSON.stringify([...mockLoggerError.mock.calls, ...mockLogAuthSessionEvent.mock.calls]);
      expect(logged).not.toContain("SECRET-PAYLOAD");
      expect(logged).not.toContain("user@example.com");
      expect(logged).not.toContain("bad token");
    }
  });

  it("ignores a client-supplied uid in the request body entirely", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "server-verified-uid" });
    mockCreateSessionCookie.mockResolvedValue("cookie");
    const res = await POST(postRequest({ idToken: "valid-token", uid: "client-asserted-uid" }));
    const body = await res.json();
    expect(body.uid).toBe("server-verified-uid");
  });
});

describe("DELETE /api/auth/session", () => {
  it("clears the cookie with attributes matching creation exactly", async () => {
    const res = await DELETE(new NextRequest("http://localhost/api/auth/session", { method: "DELETE" }));
    const cleared = res.cookies.get("__session");
    expect(cleared).toBeDefined();
    expect(cleared?.value).toBe("");
    expect(cleared?.httpOnly).toBe(true);
    expect(cleared?.secure).toBe(true);
    expect(cleared?.sameSite).toBe("lax");
    expect(cleared?.path).toBe("/");
    expect(cleared?.maxAge).toBe(0);
  });

  it("always returns 200 whether or not a cookie was present — idempotent", async () => {
    const res1 = await DELETE(new NextRequest("http://localhost/api/auth/session", { method: "DELETE" }));
    expect(res1.status).toBe(200);
    const res2 = await DELETE(new NextRequest("http://localhost/api/auth/session", { method: "DELETE", headers: { Cookie: "__session=some-value" } }));
    expect(res2.status).toBe(200);
  });

  it("sets Cache-Control: no-store", async () => {
    const res = await DELETE(new NextRequest("http://localhost/api/auth/session", { method: "DELETE" }));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns { authenticated: false } and no other fields", async () => {
    const res = await DELETE(new NextRequest("http://localhost/api/auth/session", { method: "DELETE" }));
    const body = await res.json();
    expect(body).toEqual({ authenticated: false });
  });
});

describe("GET /api/auth/session (removed, ZCA L-2)", () => {
  it("the route exports no GET handler, so a cookie can no longer be asked whose it is", () => {
    expect(Object.keys(sessionRouteModule).filter((k) => /^(GET|HEAD)$/.test(k))).toEqual([]);
    expect(Object.keys(sessionRouteModule).filter((k) => /^(POST|DELETE)$/.test(k)).sort()).toEqual(["DELETE", "POST"]);
  });
});
