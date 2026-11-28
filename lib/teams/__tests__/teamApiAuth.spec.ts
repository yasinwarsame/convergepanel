/**
 * Auth Lifecycle Hardening, Step 6.14/6.17 — `getRequestUid()` is the
 * shared identity-resolution function every team/governance API route
 * uses. This is the ACTUAL root-cause location: previously it trusted a
 * valid `__session` cookie unconditionally whenever one was present,
 * completely ignoring a request's `Authorization: Bearer` token even when
 * that token was valid and for a DIFFERENT (correct, current) identity.
 * These tests exercise the real function (not a mock of it), mocking only
 * its one dependency (`verifyIdToken`; bearer only since ZCA P3 R2).
 */

import { NextRequest, NextResponse } from "next/server";

const mockVerifyIdToken = jest.fn();

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
    mockVerifyIdToken.mockReset();
  });

  it("ZCA L-8: a valid cookie with no Authorization header is refused exactly like no credential (401), and never verified", async () => {
    const result = await getRequestUid(buildRequest({ cookie: "__session=cookie-token" }));
    const anonymous = await getRequestUid(buildRequest({}));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
    expect(await (result as Response).text()).toBe(await (anonymous as Response).text());
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("returns the bearer token's uid when no cookie is present", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-b" });
    const result = await getRequestUid(buildRequest({ bearer: "id-token" }));
    expect(result).toBe("user-b");
  });

  it("returns 401 when neither a cookie nor a bearer token is present", async () => {
    const result = await getRequestUid(buildRequest());
    await expectUnauthorized(result);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("a same-uid cookie beside the bearer changes nothing: the bearer's uid", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-a" });
    const result = await getRequestUid(buildRequest({ cookie: "__session=cookie-token", bearer: "fresh-token-for-user-a" }));
    expect(result).toBe("user-a");
  });

  it("REGRESSION (root cause), ZCA P3 R2 form: a stale cookie for a PREVIOUS user beside a fresh bearer resolves to the BEARER's uid — the cookie is never trusted, and never vetoes", async () => {
    // The original bug: a stale __session cookie silently won over a fresh, correct bearer. Step 7 answered with a
    // veto (401); P3 R2 removes the cookie from the decision, so the fresh bearer decides alone.
    mockVerifyIdToken.mockResolvedValue({ uid: "fresh-current-user" });
    const result = await getRequestUid(buildRequest({ cookie: "__session=stale-cookie", bearer: "fresh-token" }));
    expect(result).toBe("fresh-current-user");
  });

  it("RECOVERY REGRESSION: rejects the request when a cookie is present alongside an invalid/expired bearer token — the cookie is never a fallback", async () => {
    // Live verification against the real running server found the
    // narrower carve-out this replaced ("valid cookie + merely invalid
    // bearer -> authenticated via cookie") was itself unsafe: a stale
    // cookie for user A alongside an EXPIRED bearer token actually issued
    // for a DIFFERENT user B previously authenticated as A. The bearer's
    // mere presence is a second identity claim that must not be silently
    // discarded just because it can't be verified.
    mockVerifyIdToken.mockRejectedValue(new Error("expired"));
    const result = await getRequestUid(buildRequest({ cookie: "__session=cookie-token", bearer: "expired-token" }));
    await expectUnauthorized(result);
  });

  it("ZCA P3 R2 (inverted): a revoked/garbage cookie beside a valid bearer cannot veto — the bearer's uid", async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: "user-a" });
    const result = await getRequestUid(buildRequest({ cookie: "__session=revoked-cookie", bearer: "valid-token" }));
    expect(result).toBe("user-a");
  });

  it("returns 401 when the bearer token is malformed/expired and no cookie is present", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("invalid token"));
    const result = await getRequestUid(buildRequest({ bearer: "garbage" }));
    await expectUnauthorized(result);
  });
});
