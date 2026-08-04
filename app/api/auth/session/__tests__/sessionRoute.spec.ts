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
import { POST, DELETE, GET } from "@/app/api/auth/session/route";

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(cookie?: string): NextRequest {
  return new NextRequest("http://localhost/api/auth/session", {
    headers: cookie ? { Cookie: cookie } : undefined,
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

describe("GET /api/auth/session", () => {
  it("returns { authenticated: false } when no cookie is present", async () => {
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ authenticated: false });
  });

  it("returns { authenticated: true, uid } for a valid cookie", async () => {
    mockVerifySessionCookieOnAdmin.mockResolvedValue({ uid: "user-1" });
    const res = await GET(getRequest("__session=valid-cookie"));
    await expect(res.json()).resolves.toEqual({ authenticated: true, uid: "user-1" });
  });

  it("returns { authenticated: false } (never a raw error, never a 500) for an expired/revoked/malformed cookie", async () => {
    mockVerifySessionCookieOnAdmin.mockRejectedValue(new Error("Firebase session cookie has been revoked."));
    const res = await GET(getRequest("__session=revoked-cookie"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ authenticated: false });
    expect(JSON.stringify(body)).not.toMatch(/revoked/);
  });

  it("never returns email, claims, the cookie/token value, or team data", async () => {
    mockVerifySessionCookieOnAdmin.mockResolvedValue({ uid: "user-1", isAdmin: true });
    const res = await GET(getRequest("__session=valid-cookie"));
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["authenticated", "uid"].sort());
  });

  it("sets Cache-Control: no-store", async () => {
    const res = await GET(getRequest());
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
