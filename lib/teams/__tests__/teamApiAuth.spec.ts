/**
 * Auth Lifecycle Hardening, Step 6.14/6.17 — `getRequestUid()` is the
 * shared identity-resolution function every team/governance API route
 * uses. This is the ACTUAL root-cause location: previously it trusted a
 * valid `__session` cookie unconditionally whenever one was present,
 * completely ignoring a request's `Authorization: Bearer` token even when
 * that token was valid and for a DIFFERENT (correct, current) identity.
 * These tests exercise the real function (not a mock of it), mocking only
 * its two dependencies (`verifySessionCookie`, `verifyIdToken`).
 */

import { NextRequest, NextResponse } from "next/server";

const mockVerifySessionCookie = jest.fn();
const mockVerifyIdToken = jest.fn();

jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookie: (...args: unknown[]) => mockVerifySessionCookie(...args),
}));
jest.mock("@/lib/firebase/auth", () => ({
  verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
}));
jest.mock("@/lib/firebase/admin", () => ({ adminDb: {} }));

import { getRequestUid } from "@/lib/teams/teamApiAuth";

function buildRequest(opts: { cookie?: string; bearer?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  return new NextRequest("http://localhost/api/teams/example", { headers });
}

async function expectUnauthorized(result: string | NextResponse): Promise<void> {
  expect(result).toBeInstanceOf(NextResponse);
  const res = result as NextResponse;
  expect(res.status).toBe(401);
  const body = await res.json();
  expect(body.ok).toBe(false);
}

describe("getRequestUid", () => {
  beforeEach(() => {
    mockVerifySessionCookie.mockReset();
    mockVerifyIdToken.mockReset();
  });

  it("returns the cookie's uid when no Authorization header is present", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
    const result = await getRequestUid(buildRequest({ cookie: "__session=cookie-token" }));
    expect(result).toBe("user-a");
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("returns the bearer token's uid when no cookie is present", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    mockVerifyIdToken.mockResolvedValue({ uid: "user-b" });
    const result = await getRequestUid(buildRequest({ bearer: "id-token" }));
    expect(result).toBe("user-b");
  });

  it("returns 401 when neither a cookie nor a bearer token is present", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    const result = await getRequestUid(buildRequest());
    await expectUnauthorized(result);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("returns the cookie's uid when the cookie and a present bearer token agree", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
    mockVerifyIdToken.mockResolvedValue({ uid: "user-a" });
    const result = await getRequestUid(buildRequest({ cookie: "__session=cookie-token", bearer: "fresh-token-for-user-a" }));
    expect(result).toBe("user-a");
  });

  it("REGRESSION (root cause): rejects the request when a valid cookie and a valid bearer token resolve to DIFFERENT uids, rather than silently trusting the cookie", async () => {
    // This is the exact shape of the reproduced bug: a stale __session
    // cookie left over from a PREVIOUS user, alongside a fresh, correct
    // bearer token for the user the client actually just signed in as.
    mockVerifySessionCookie.mockResolvedValue({ uid: "stale-previous-user", isAdmin: false });
    mockVerifyIdToken.mockResolvedValue({ uid: "fresh-current-user" });
    const result = await getRequestUid(buildRequest({ cookie: "__session=stale-cookie", bearer: "fresh-token" }));
    await expectUnauthorized(result);
  });

  it("RECOVERY REGRESSION: rejects the request when a valid cookie is present alongside an invalid/expired bearer token — strict dual-credential policy, no fallback to the cookie alone", async () => {
    // Live verification against the real running server found the
    // narrower carve-out this replaced ("valid cookie + merely invalid
    // bearer -> authenticated via cookie") was itself unsafe: a stale
    // cookie for user A alongside an EXPIRED bearer token actually issued
    // for a DIFFERENT user B previously authenticated as A. The bearer's
    // mere presence is a second identity claim that must not be silently
    // discarded just because it can't be verified.
    mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
    mockVerifyIdToken.mockRejectedValue(new Error("expired"));
    const result = await getRequestUid(buildRequest({ cookie: "__session=cookie-token", bearer: "expired-token" }));
    await expectUnauthorized(result);
  });

  it("returns 401 when the cookie itself is invalid/expired/revoked, even with a valid bearer token present — both credentials are independently checked, but an invalid cookie still fails the whole request closed", async () => {
    mockVerifySessionCookie.mockRejectedValue(new Error("session cookie revoked"));
    mockVerifyIdToken.mockResolvedValue({ uid: "user-a" });
    const result = await getRequestUid(buildRequest({ cookie: "__session=revoked-cookie", bearer: "valid-token" }));
    await expectUnauthorized(result);
  });

  it("returns 401 when the bearer token is malformed/expired and no cookie is present", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    mockVerifyIdToken.mockRejectedValue(new Error("invalid token"));
    const result = await getRequestUid(buildRequest({ bearer: "garbage" }));
    await expectUnauthorized(result);
  });
});
