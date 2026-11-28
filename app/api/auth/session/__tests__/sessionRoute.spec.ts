/**
 * ZCA P3 R2 — `POST /api/auth/session` is a VERIFICATION HANDSHAKE ("verify, don't mint"); `DELETE` is an
 * idempotent expiry; there is no `GET`.
 *
 * Converted from the Step 6.14 mint spec: the cookie-creation cases were deleted (nothing is minted), the
 * verification cases were kept, and every response is now asserted to carry ONLY the `__session` expiry.
 * New: credential precedence (header / body), the origin rule, Content-Type, and a sweep proving that no
 * request shape ever yields a non-expiry Set-Cookie or touches any Admin Auth member but `verifyIdToken`.
 */

const mockVerifyIdToken = jest.fn();
let mockAdminAvailable = true;

jest.mock("@/lib/firebase/admin", () => {
  const h = require("./handshakeHarness");
  const auth = h.strictAdminAuth((...args: unknown[]) => mockVerifyIdToken(...args));
  return {
    get adminAuth() {
      return mockAdminAvailable ? auth : null;
    },
  };
});

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
import { expectExpiryOnly, forbiddenAdminAccess, handshakeRequest, setCookiesOf, EXPIRY_SET_COOKIE } from "./handshakeHarness";

/** The legacy shape: body token only (an old open tab). */
function postRequest(body: unknown): NextRequest {
  return handshakeRequest({ rawBody: JSON.stringify(body) });
}

const ENV_KEYS = ["VERCEL", "VERCEL_URL", "VERCEL_BRANCH_URL"] as const;
const envSnapshot: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyIdToken.mockReset();
  mockAdminAvailable = true;
  forbiddenAdminAccess.length = 0;
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  // No request shape may ever reach any Admin Auth member other than verifyIdToken (no minting).
  expect(forbiddenAdminAccess).toEqual([]);
});

describe("POST — verification, never minting", () => {
  it("header-only (new client): verifies WITH checkRevoked = true and answers { authenticated, uid } — uid is server-derived", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
    const res = await POST(handshakeRequest({ bearer: "valid-token" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true, uid: "user-1" });
    expect(mockVerifyIdToken.mock.calls).toEqual([["valid-token", true]]);
    expectExpiryOnly(res);
    expect(mockLogAuthSessionEvent).toHaveBeenCalledWith("session_sync_succeeded", { route: "POST /api/auth/session" });
  });

  it("body-only (old open tab, rollback shape): the same answer, still no cookie minted", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
    const res = await POST(postRequest({ idToken: "valid-token" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true, uid: "user-1" });
    expect(mockVerifyIdToken.mock.calls).toEqual([["valid-token", true]]);
    expectExpiryOnly(res);
  });

  it("header AND body, byte-equal (the current client, R1 L3): verified once", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
    const res = await POST(handshakeRequest({ bearer: "same-token", bodyToken: "same-token" }));
    expect(res.status).toBe(200);
    expect(mockVerifyIdToken.mock.calls).toEqual([["same-token", true]]);
    expectExpiryOnly(res);
  });

  it("ignores a client-supplied uid in the body entirely", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "server-verified-uid" });
    const res = await POST(postRequest({ idToken: "valid-token", uid: "client-asserted-uid" }));
    expect((await res.json()).uid).toBe("server-verified-uid");
  });
});

describe("POST — credential precedence (R1 L2)", () => {
  it("header and body DIFFER → 401 credential_conflict, nothing verified", async () => {
    const res = await POST(handshakeRequest({ bearer: "token-a", bodyToken: "token-b" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired token", code: "credential_conflict" });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expectExpiryOnly(res);
  });

  it("header and body differ only in case → still a conflict (byte-equal, not case-insensitive)", async () => {
    const res = await POST(handshakeRequest({ bearer: "Token-A", bodyToken: "token-a" }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("credential_conflict");
  });

  it.each([["Basic dXNlcjpwYXNz"], ["Bearer"], ["Bearer "], ["Bearer a b"], [""], ["token-without-scheme"], ["Bearer tok"]])(
    "a MALFORMED Authorization %p → 401 malformed_authorization, and the valid body token is NOT a fallback",
    async (authorization) => {
      mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
      const res = await POST(handshakeRequest({ authorization, bodyToken: "valid-token" }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid or expired token", code: "malformed_authorization" });
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
      expectExpiryOnly(res);
    }
  );

  it("the Bearer scheme is case-insensitive", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
    expect((await POST(handshakeRequest({ authorization: "bearer tok" }))).status).toBe(200);
    expect((await POST(handshakeRequest({ authorization: "BEARER   tok" }))).status).toBe(200);
  });

  it("neither header nor body token → 400, nothing verified", async () => {
    const res = await POST(handshakeRequest({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "ID token is required" });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expectExpiryOnly(res);
  });

  it.each([[{}], [{ idToken: 12345 }], [{ idToken: "" }], [{ idToken: null }], [null], [[1, 2]]])("body %p without a usable token → 400", async (body) => {
    const res = await POST(postRequest(body));
    expect(res.status).toBe(400);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expectExpiryOnly(res);
  });

  it("a non-JSON body → 400 Invalid request body", async () => {
    const res = await POST(handshakeRequest({ rawBody: "{not json" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request body" });
    expectExpiryOnly(res);
  });

  it.each([["text/plain"], ["application/x-www-form-urlencoded"], ["multipart/form-data; boundary=x"], [null]])(
    "a body token with Content-Type %p → 415, nothing verified (a body token requires application/json)",
    async (contentType) => {
      const res = await POST(handshakeRequest({ bodyToken: "valid-token", contentType }));
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: "Content-Type must be application/json", code: "unsupported_media_type" });
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
      expectExpiryOnly(res);
    }
  );

  it("Content-Type application/json with a charset is JSON; a header-only request needs no Content-Type", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
    expect((await POST(handshakeRequest({ bodyToken: "t", contentType: "application/json; charset=utf-8" }))).status).toBe(200);
    expect((await POST(handshakeRequest({ bearer: "t", contentType: null }))).status).toBe(200);
  });
});

describe("POST — the origin rule (R1 L1 + R2 L-2)", () => {
  async function expectCrossOrigin(req: NextRequest) {
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Cross-origin request refused", code: "cross_origin" });
    expectExpiryOnly(res);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(mockLogAuthSessionEvent).toHaveBeenCalledWith("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "cross_origin" });
  }
  async function expectAllowed(req: NextRequest) {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-1" });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expectExpiryOnly(res);
  }

  it("same origin + Sec-Fetch-Site same-origin → allowed", async () => {
    await expectAllowed(handshakeRequest({ bearer: "t" }));
  });

  it("Origin: null (opaque origin) → 403, whatever Sec-Fetch-Site says", async () => {
    await expectCrossOrigin(handshakeRequest({ bearer: "t", origin: "null" }));
    mockVerifyIdToken.mockClear();
    await expectCrossOrigin(handshakeRequest({ bearer: "t", origin: "null", secFetchSite: null }));
  });

  it.each([["https://evil.example"], ["http://localhost:3001"], ["https://localhost:3000"], ["http://localhost:3000/"], ["HTTP://LOCALHOST:3000"], ["http://localhost:3000.evil.example"]])(
    "a cross-site / non-exact Origin %p → 403",
    async (origin) => {
      await expectCrossOrigin(handshakeRequest({ bearer: "t", origin, secFetchSite: null }));
    }
  );

  it.each([["cross-site"], ["same-site"], ["none"], ["bogus"]])("Sec-Fetch-Site %p → 403 even with the exact Origin", async (site) => {
    await expectCrossOrigin(handshakeRequest({ bearer: "t", secFetchSite: site }));
  });

  it("missing Origin (defined behaviour): allowed when Sec-Fetch-Site is same-origin or absent; 403 when it says cross-site", async () => {
    await expectAllowed(handshakeRequest({ bearer: "t", origin: null }));
    await expectAllowed(handshakeRequest({ bearer: "t", origin: null, secFetchSite: null }));
    mockVerifyIdToken.mockClear();
    await expectCrossOrigin(handshakeRequest({ bearer: "t", origin: null, secFetchSite: "cross-site" }));
  });

  it("the pinned Production aliases are allowed for each other (apex, www, the vercel.app alias)", async () => {
    const hosts = ["https://convergepanel.com", "https://www.convergepanel.com", "https://convergepanel.vercel.app"];
    for (const addressed of hosts) {
      for (const origin of hosts) {
        await expectAllowed(handshakeRequest({ url: `${addressed}/api/auth/session`, bearer: "t", origin }));
      }
    }
  });

  it("an unpinned look-alike of a Production host → 403", async () => {
    for (const origin of ["https://convergepanel.com.evil.example", "https://evilconvergepanel.com", "https://convergepanel-evil.vercel.app", "http://convergepanel.com"]) {
      await expectCrossOrigin(handshakeRequest({ url: "https://convergepanel.com/api/auth/session", bearer: "t", origin }));
      mockVerifyIdToken.mockClear();
      mockLogAuthSessionEvent.mockClear();
    }
  });

  it("Preview: the deployment's own VERCEL_URL and VERCEL_BRANCH_URL origins are allowed ONLY when the platform sets them", async () => {
    const req = (origin: string) => handshakeRequest({ url: "https://cp-abc123-team.vercel.app/api/auth/session", bearer: "t", origin });
    await expectCrossOrigin(req("https://cp-git-feature-team.vercel.app"));
    mockLogAuthSessionEvent.mockClear();
    process.env.VERCEL_BRANCH_URL = "cp-git-feature-team.vercel.app";
    await expectAllowed(req("https://cp-git-feature-team.vercel.app"));
    process.env.VERCEL_URL = "cp-other999-team.vercel.app";
    await expectAllowed(req("https://cp-other999-team.vercel.app"));
    // A host value that is not a bare host name is never turned into an allowed origin.
    process.env.VERCEL_URL = "evil.example/path";
    delete process.env.VERCEL_BRANCH_URL;
    mockVerifyIdToken.mockClear();
    await expectCrossOrigin(req("https://evil.example"));
  });

  it("spoofed Host / X-Forwarded-Host / X-Forwarded-Proto are NOT an authority source for the allowed set", async () => {
    await expectCrossOrigin(
      handshakeRequest({
        bearer: "t",
        origin: "https://evil.example",
        secFetchSite: null,
        headers: { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", forwarded: "host=evil.example;proto=https" },
      })
    );
  });

  it("ON VERCEL the addressed origin (request.nextUrl, built from the Host header) is NOT in the allowed set", async () => {
    // On Vercel, Next.js derives request.nextUrl from Host (trustHostHeader). Simulate a request whose
    // Host — and therefore nextUrl — is attacker-chosen, with a matching Origin.
    process.env.VERCEL = "1";
    await expectCrossOrigin(handshakeRequest({ url: "https://evil.example/api/auth/session", bearer: "t", origin: "https://evil.example" }));
    mockVerifyIdToken.mockClear();
    mockLogAuthSessionEvent.mockClear();
    // Same-origin for a configured host still works on Vercel.
    await expectAllowed(handshakeRequest({ url: "https://convergepanel.com/api/auth/session", bearer: "t" }));
    process.env.VERCEL_URL = "cp-abc123-team.vercel.app";
    await expectAllowed(handshakeRequest({ url: "https://cp-abc123-team.vercel.app/api/auth/session", bearer: "t" }));
  });

  it("OFF Vercel (local dev / harness) the addressed origin is allowed — and only it", async () => {
    await expectAllowed(handshakeRequest({ url: "http://127.0.0.1:4100/api/auth/session", bearer: "t" }));
    mockVerifyIdToken.mockClear();
    await expectCrossOrigin(handshakeRequest({ url: "http://127.0.0.1:4100/api/auth/session", bearer: "t", origin: "http://127.0.0.1:4101" }));
    mockVerifyIdToken.mockClear();
    mockLogAuthSessionEvent.mockClear();
    // On Vercel the loopback equivalence never applies.
    process.env.VERCEL = "1";
    await expectCrossOrigin(handshakeRequest({ url: "http://127.0.0.1:4100/api/auth/session", bearer: "t" }));
  });

  it("the origin check runs BEFORE the body is read and before any verification", async () => {
    const res = await POST(handshakeRequest({ authorization: "Basic x", rawBody: "{not json", origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });
});

describe("POST — SESSREV: refuses revoked / disabled identities and fails closed on outages", () => {
  const fbErr = (code: string, message = "firebase detail") => Object.assign(new Error(message), { code });

  it("revoked token (auth/id-token-revoked) → 401, generic body", async () => {
    mockVerifyIdToken.mockRejectedValue(fbErr("auth/id-token-revoked", "The Firebase ID token has been revoked."));
    const res = await POST(handshakeRequest({ bearer: "revoked-token" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired token" });
    expectExpiryOnly(res);
    expect(mockLogAuthSessionEvent).toHaveBeenCalledWith("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "revoked_token" });
  });

  it("disabled account (auth/user-disabled) → 401, account state not disclosed", async () => {
    mockVerifyIdToken.mockRejectedValue(fbErr("auth/user-disabled", "The user record is disabled."));
    const res = await POST(handshakeRequest({ bearer: "disabled-user-token" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Invalid or expired token" });
    expect(JSON.stringify(body)).not.toMatch(/disabled/i);
    expectExpiryOnly(res);
    expect(mockLogAuthSessionEvent).toHaveBeenCalledWith("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "account_disabled" });
  });

  it("an invalid/expired token → 401, never leaking the raw verification error", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("Firebase ID token has expired. Get a fresh token and try again."));
    const res = await POST(handshakeRequest({ bearer: "expired-token" }));
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toMatch(/expired\. Get a fresh token/);
    expectExpiryOnly(res);
  });

  it("deleted account (auth/user-not-found from the checkRevoked lookup) → 401", async () => {
    mockVerifyIdToken.mockRejectedValue(fbErr("auth/user-not-found"));
    const res = await POST(handshakeRequest({ bearer: "t" }));
    expect(res.status).toBe(401);
    expectExpiryOnly(res);
  });

  it.each(["auth/internal-error", "app/internal-error", "app/network-error", "app/network-timeout"])(
    "transient verifier failure %s → 503 auth_unavailable (never 200, never 401)",
    async (code) => {
      mockVerifyIdToken.mockRejectedValue(fbErr(code, "upstream detail xyz"));
      const res = await POST(handshakeRequest({ bearer: "t" }));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ error: "Authentication service unavailable", code: "auth_unavailable" });
      expect(JSON.stringify(body)).not.toMatch(/upstream detail/);
      expectExpiryOnly(res);
      expect(mockLogAuthSessionEvent).toHaveBeenCalledWith("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "auth_unavailable" });
      expect(mockLoggerError).toHaveBeenCalledWith(expect.any(String), { errorCode: code });
    }
  );

  it.each([
    ["no code", new Error("boom")],
    ["non-string code", Object.assign(new Error("boom"), { code: 503 })],
    ["a thrown non-Error", "string-rejection"],
    ["near-miss transient code", fbErr("auth/internal-error ")],
  ])("an unclassified failure (%s) is a credential failure → 401", async (_label, err) => {
    mockVerifyIdToken.mockRejectedValue(err);
    const res = await POST(handshakeRequest({ bearer: "t" }));
    expect(res.status).toBe(401);
    expectExpiryOnly(res);
  });

  it.each([[{}], [{ uid: "" }], [{ uid: 42 }], [null]])("a verified-but-uidless decode (%p) → 401", async (decoded) => {
    mockVerifyIdToken.mockResolvedValue(decoded);
    const res = await POST(handshakeRequest({ bearer: "t" }));
    expect(res.status).toBe(401);
    expectExpiryOnly(res);
  });

  it("Admin SDK not initialised → 500, still the expiry and no-store", async () => {
    mockAdminAvailable = false;
    const res = await POST(handshakeRequest({ bearer: "t" }));
    expect(res.status).toBe(500);
    expectExpiryOnly(res);
  });

  it("never logs the ID token or a provider error message (code only), on every failure path", async () => {
    const TOKEN = "eyJhbGciOiJSUzI1NiJ9.SECRET-PAYLOAD.sig";
    const leaky = (code: string) => Object.assign(new Error(`bad token ${TOKEN} for user@example.com`), { code });
    for (const err of [leaky("auth/id-token-revoked"), leaky("auth/user-disabled"), leaky("app/network-error"), leaky("auth/invalid-id-token")]) {
      jest.clearAllMocks();
      mockVerifyIdToken.mockRejectedValue(err);
      await POST(handshakeRequest({ bearer: TOKEN, bodyToken: TOKEN }));
      await POST(handshakeRequest({ bearer: TOKEN, bodyToken: `${TOKEN}x` }));
      const logged = JSON.stringify([...mockLoggerError.mock.calls, ...mockLogAuthSessionEvent.mock.calls]);
      expect(logged).not.toContain("SECRET-PAYLOAD");
      expect(logged).not.toContain("user@example.com");
      expect(logged).not.toContain("bad token");
    }
  });
});

describe("no request shape ever yields a non-expiry Set-Cookie (R2 handshake oracle)", () => {
  it("a sweep over every arm: exactly the one expiry, every time", async () => {
    const shapes: Array<[string, () => void, NextRequest]> = [
      ["valid header", () => mockVerifyIdToken.mockResolvedValue({ uid: "u" }), handshakeRequest({ bearer: "t" })],
      ["valid body", () => mockVerifyIdToken.mockResolvedValue({ uid: "u" }), handshakeRequest({ bodyToken: "t" })],
      ["both", () => mockVerifyIdToken.mockResolvedValue({ uid: "u" }), handshakeRequest({ bearer: "t", bodyToken: "t" })],
      ["conflict", () => undefined, handshakeRequest({ bearer: "a", bodyToken: "b" })],
      ["malformed", () => undefined, handshakeRequest({ authorization: "Basic x" })],
      ["none", () => undefined, handshakeRequest({})],
      ["415", () => undefined, handshakeRequest({ bodyToken: "t", contentType: "text/plain" })],
      ["403", () => undefined, handshakeRequest({ bearer: "t", origin: "null" })],
      ["401", () => mockVerifyIdToken.mockRejectedValue(Object.assign(new Error("x"), { code: "auth/id-token-revoked" })), handshakeRequest({ bearer: "t" })],
      ["503", () => mockVerifyIdToken.mockRejectedValue(Object.assign(new Error("x"), { code: "app/network-error" })), handshakeRequest({ bearer: "t" })],
      ["with a legacy cookie", () => mockVerifyIdToken.mockResolvedValue({ uid: "u" }), handshakeRequest({ bearer: "t", headers: { cookie: "__session=legacy-minted-value" } })],
    ];
    const seen: string[][] = [];
    for (const [, arrange, req] of shapes) {
      mockVerifyIdToken.mockReset();
      arrange();
      const res = await POST(req);
      seen.push(setCookiesOf(res));
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(seen).toEqual(shapes.map(() => [EXPIRY_SET_COOKIE]));
  });
});

describe("DELETE /api/auth/session — an idempotent expiry (for old tabs; no current client calls it)", () => {
  it("expires the cookie with attributes matching the retired creation exactly", async () => {
    const res = await DELETE(new NextRequest("http://localhost/api/auth/session", { method: "DELETE" }));
    const cleared = res.cookies.get("__session");
    expect(cleared?.value).toBe("");
    expect(cleared?.httpOnly).toBe(true);
    expect(cleared?.secure).toBe(true);
    expect(cleared?.sameSite).toBe("lax");
    expect(cleared?.path).toBe("/");
    expect(cleared?.maxAge).toBe(0);
    expectExpiryOnly(res);
  });

  it("always returns 200 { authenticated: false }, whether or not a cookie was present", async () => {
    for (const headers of [{}, { Cookie: "__session=some-value" }]) {
      const res = await DELETE(new NextRequest("http://localhost/api/auth/session", { method: "DELETE", headers }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ authenticated: false });
      expectExpiryOnly(res);
    }
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/session (removed, ZCA L-2; not restored by R2)", () => {
  it("the route exports no GET handler (Next.js answers 405)", () => {
    expect(Object.keys(sessionRouteModule).filter((k) => /^(GET|HEAD|PUT|PATCH|OPTIONS)$/.test(k))).toEqual([]);
    expect(Object.keys(sessionRouteModule).filter((k) => /^(POST|DELETE)$/.test(k)).sort()).toEqual(["DELETE", "POST"]);
  });
});
