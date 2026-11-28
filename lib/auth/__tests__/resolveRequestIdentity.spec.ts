/**
 * `resolveRequestIdentity()` — BEARER ONLY (ZCA L-8, then P3 R2 "verify, don't mint").
 *
 * History: Step 7 (Recovery revision) required cookie and bearer to agree whenever both were present
 * (a mismatch or an invalid cookie vetoed a valid bearer). P3 R2 removed the cookie from the decision:
 * these tests were converted from that dual-credential matrix to (1) the bearer truth table and (2) a
 * cookie-invariance matrix — every bearer state × every cookie state is decided exactly as the same
 * request WITHOUT the cookie (same result, same number of verifications).
 */

import { NextRequest } from "next/server";

const mockVerifyIdToken = jest.fn();

jest.mock("@/lib/firebase/auth", () => ({
  verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
}));

import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";

function buildRequest(opts: { cookie?: string; authHeader?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.Cookie = opts.cookie;
  if (opts.authHeader !== undefined) headers.Authorization = opts.authHeader;
  return new NextRequest("http://localhost/api/example", { headers });
}

function firebaseError(code: string): Error & { code: string } {
  const err = new Error(`Firebase error: ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

beforeEach(() => {
  mockVerifyIdToken.mockReset();
});

describe("resolveRequestIdentity — the bearer truth table", () => {
  it("no credentials at all -> missing_credentials, nothing verified", async () => {
    const result = await resolveRequestIdentity(buildRequest());
    expect(result).toEqual({ status: "unauthenticated", reason: "missing_credentials" });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("valid bearer -> authenticated via bearer_token (the only source)", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-b" });
    const result = await resolveRequestIdentity(buildRequest({ authHeader: "Bearer valid-token" }));
    expect(result).toEqual({ status: "authenticated", uid: "user-b", source: "bearer_token" });
    expect(mockVerifyIdToken.mock.calls).toEqual([["valid-token"]]);
  });

  it.each([
    ["invalid", new Error("malformed token"), "invalid_bearer_token"],
    ["expired", firebaseError("auth/id-token-expired"), "expired_session"],
    ["revoked", firebaseError("auth/id-token-revoked"), "revoked_session"],
    ["disabled", firebaseError("auth/user-disabled"), "invalid_bearer_token"],
    ["verifier outage", firebaseError("app/network-error"), "auth_unavailable"],
  ] as const)("%s bearer -> %s", async (_n, err, reason) => {
    mockVerifyIdToken.mockRejectedValue(err);
    const result = await resolveRequestIdentity(buildRequest({ authHeader: "Bearer t" }));
    expect(result).toEqual({ status: "unauthenticated", reason });
  });

  it.each([["garbage-not-a-bearer-header"], ["Basic dXNlcjpwYXNz"], ["Bearer    "]])(
    "malformed Authorization %p -> invalid_bearer_token (present but unusable, never treated as absent), nothing verified",
    async (authHeader) => {
      const result = await resolveRequestIdentity(buildRequest({ authHeader }));
      expect(result).toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
    }
  );

  it("an unrecognized verifier error never leaks the raw error", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("some internal Firebase Admin SDK detail that must never reach the client"));
    const result = await resolveRequestIdentity(buildRequest({ authHeader: "Bearer t" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
    expect(JSON.stringify(result)).not.toMatch(/internal Firebase Admin SDK detail/);
  });
});

describe("resolveRequestIdentity — the cookie is not an input (ZCA P3 R2; converted from the dual-credential matrix)", () => {
  const BEARERS: Array<[string, string | undefined, () => void]> = [
    ["absent", undefined, () => undefined],
    ["valid A", "Bearer token-a", () => mockVerifyIdToken.mockResolvedValue({ uid: "user-a" })],
    ["valid B", "Bearer token-b", () => mockVerifyIdToken.mockResolvedValue({ uid: "user-b" })],
    ["invalid", "Bearer garbage", () => mockVerifyIdToken.mockRejectedValue(new Error("malformed token"))],
    ["expired", "Bearer expired", () => mockVerifyIdToken.mockRejectedValue(firebaseError("auth/id-token-expired"))],
    ["revoked", "Bearer revoked", () => mockVerifyIdToken.mockRejectedValue(firebaseError("auth/id-token-revoked"))],
    ["disabled", "Bearer disabled", () => mockVerifyIdToken.mockRejectedValue(firebaseError("auth/user-disabled"))],
    ["malformed", "Basic dXNlcjpwYXNz", () => undefined],
  ];
  const COOKIES: Array<[string, string]> = [
    ["valid-looking A", "__session=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLWEifQ.c2ln"],
    ["valid-looking B", "__session=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLWIifQ.c2ln"],
    ["invalid", "__session=garbage"],
    ["empty", "__session="],
    ["garbage header", "%%%;;=;__session"],
    ["several cookies", "a=1; __session=x; __session=y"],
  ];
  for (const [bName, authHeader, arrange] of BEARERS) {
    it.each(COOKIES)(`bearer ${bName} + cookie %s -> exactly the cookie-absent result and verification count`, async (_c, cookie) => {
      arrange();
      const without = await resolveRequestIdentity(buildRequest({ authHeader }));
      const callsWithout = mockVerifyIdToken.mock.calls.length;
      mockVerifyIdToken.mockClear();
      arrange();
      const withCookie = await resolveRequestIdentity(buildRequest({ authHeader, cookie }));
      expect(withCookie).toEqual(without);
      expect(mockVerifyIdToken.mock.calls.length).toBe(callsWithout);
    });
  }

  it("the resolver never touches request.cookies — a request whose cookie jar THROWS is decided as without it", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-a" });
    for (const authHeader of [undefined, "Bearer token-a"]) {
      const r = buildRequest({ authHeader, cookie: "__session=x" });
      Object.defineProperty(r, "cookies", { get: () => { throw new Error("cookie jar read"); } });
      expect(await resolveRequestIdentity(r)).toEqual(await resolveRequestIdentity(buildRequest({ authHeader })));
    }
  });

  it("control (non-vacuity): the bearer arms really differ from each other", async () => {
    const results = new Set<string>();
    for (const [, authHeader, arrange] of BEARERS) {
      mockVerifyIdToken.mockReset();
      arrange();
      results.add(JSON.stringify(await resolveRequestIdentity(buildRequest({ authHeader }))));
    }
    expect(results.size).toBeGreaterThanOrEqual(6);
  });
});
