/**
 * Repository-Wide Auth Identity Consistency Remediation, Step 7 (Recovery
 * revision) — exhaustive test matrix for the shared
 * `resolveRequestIdentity()` helper's STRICT dual-credential policy: when
 * both a cookie and a bearer credential are present, BOTH must
 * independently validate AND resolve to the SAME uid, or the request
 * fails closed. No case falls back to "whichever credential happened to
 * validate."
 */

import { NextRequest } from "next/server";

const mockVerifySessionCookie = jest.fn();
const mockVerifyIdToken = jest.fn();

jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookie: (...args: unknown[]) => mockVerifySessionCookie(...args),
}));
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
  mockVerifySessionCookie.mockReset();
  mockVerifyIdToken.mockReset();
});

describe("resolveRequestIdentity — single-credential cases", () => {
  it("no credentials at all -> missing_credentials", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    const result = await resolveRequestIdentity(buildRequest());
    expect(result).toEqual({ status: "unauthenticated", reason: "missing_credentials" });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("valid cookie only -> authenticated via session_cookie", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
    const result = await resolveRequestIdentity(buildRequest({ cookie: "__session=valid" }));
    expect(result).toEqual({ status: "authenticated", uid: "user-a", source: "session_cookie" });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("invalid cookie only -> invalid_session_cookie", async () => {
    mockVerifySessionCookie.mockRejectedValue(new Error("malformed cookie"));
    const result = await resolveRequestIdentity(buildRequest({ cookie: "__session=garbage" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "invalid_session_cookie" });
  });

  it("expired cookie only -> expired_session", async () => {
    mockVerifySessionCookie.mockRejectedValue(firebaseError("auth/session-cookie-expired"));
    const result = await resolveRequestIdentity(buildRequest({ cookie: "__session=expired" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "expired_session" });
  });

  it("revoked cookie only -> revoked_session", async () => {
    mockVerifySessionCookie.mockRejectedValue(firebaseError("auth/session-cookie-revoked"));
    const result = await resolveRequestIdentity(buildRequest({ cookie: "__session=revoked" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "revoked_session" });
  });

  it("valid bearer only -> authenticated via bearer_token", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    mockVerifyIdToken.mockResolvedValue({ uid: "user-b" });
    const result = await resolveRequestIdentity(buildRequest({ authHeader: "Bearer valid-token" }));
    expect(result).toEqual({ status: "authenticated", uid: "user-b", source: "bearer_token" });
  });

  it("invalid bearer only -> invalid_bearer_token", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    mockVerifyIdToken.mockRejectedValue(new Error("malformed token"));
    const result = await resolveRequestIdentity(buildRequest({ authHeader: "Bearer garbage" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
  });

  it("expired bearer only -> expired_session", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    mockVerifyIdToken.mockRejectedValue(firebaseError("auth/id-token-expired"));
    const result = await resolveRequestIdentity(buildRequest({ authHeader: "Bearer expired" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "expired_session" });
  });

  it("revoked bearer only -> revoked_session", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    mockVerifyIdToken.mockRejectedValue(firebaseError("auth/id-token-revoked"));
    const result = await resolveRequestIdentity(buildRequest({ authHeader: "Bearer revoked" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "revoked_session" });
  });

  it("malformed Authorization header (no Bearer prefix), no cookie -> invalid_bearer_token (present but unusable, never treated as absent)", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    const result = await resolveRequestIdentity(buildRequest({ authHeader: "garbage-not-a-bearer-header" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("non-Bearer Authorization scheme (e.g. Basic), no cookie -> invalid_bearer_token", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    const result = await resolveRequestIdentity(buildRequest({ authHeader: "Basic dXNlcjpwYXNz" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("whitespace-only bearer token (after 'Bearer '), no cookie -> invalid_bearer_token", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    const result = await resolveRequestIdentity(buildRequest({ authHeader: "Bearer    " }));
    expect(result).toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("empty cookie value resolves to no cookie present (via verifySessionCookie's own null-for-absent contract, not a duplicated raw check)", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    const result = await resolveRequestIdentity(buildRequest({ cookie: "" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "missing_credentials" });
  });
});

describe("resolveRequestIdentity — dual-credential cases (strict: both must validate AND agree)", () => {
  it("matching valid cookie + bearer (same uid) -> authenticated via matching_cookie_and_bearer", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
    mockVerifyIdToken.mockResolvedValue({ uid: "user-a" });
    const result = await resolveRequestIdentity(buildRequest({ cookie: "__session=valid", authHeader: "Bearer valid-token" }));
    expect(result).toEqual({ status: "authenticated", uid: "user-a", source: "matching_cookie_and_bearer" });
  });

  it("REGRESSION (root cause): mismatched valid cookie + bearer (different uids) -> fail closed with credential_mismatch", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "stale-previous-user", isAdmin: false });
    mockVerifyIdToken.mockResolvedValue({ uid: "fresh-current-user" });
    const result = await resolveRequestIdentity(buildRequest({ cookie: "__session=stale", authHeader: "Bearer fresh-token" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "credential_mismatch" });
  });

  it("LIVE-VERIFIED RECOVERY REGRESSION: valid cookie + EXPIRED bearer (for a different, unverifiable identity) -> fails closed, NEVER falls back to the cookie", async () => {
    // This is the exact scenario found during Step 7's own live manual
    // verification: a stale cookie for user A alongside an expired
    // bearer token actually issued for user B previously authenticated
    // as A. The bearer being expired makes its uid unverifiable, but its
    // mere presence must still block a silent fallback to the cookie.
    mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
    mockVerifyIdToken.mockRejectedValue(firebaseError("auth/id-token-expired"));
    const result = await resolveRequestIdentity(buildRequest({ cookie: "__session=valid", authHeader: "Bearer expired-token-for-someone-else" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "expired_session" });
  });

  it("valid cookie + revoked bearer -> fails closed", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
    mockVerifyIdToken.mockRejectedValue(firebaseError("auth/id-token-revoked"));
    const result = await resolveRequestIdentity(buildRequest({ cookie: "__session=valid", authHeader: "Bearer revoked-token" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "revoked_session" });
  });

  it("valid cookie + malformed bearer (garbage token) -> fails closed", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
    mockVerifyIdToken.mockRejectedValue(new Error("malformed token"));
    const result = await resolveRequestIdentity(buildRequest({ cookie: "__session=valid", authHeader: "Bearer garbage" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
  });

  it("valid cookie + non-Bearer Authorization scheme present -> fails closed (never silently ignored)", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
    const result = await resolveRequestIdentity(buildRequest({ cookie: "__session=valid", authHeader: "Basic dXNlcjpwYXNz" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("invalid cookie + valid bearer -> fails closed (cookie's reason), no fallback to the bearer identity", async () => {
    mockVerifySessionCookie.mockRejectedValue(new Error("malformed cookie"));
    mockVerifyIdToken.mockResolvedValue({ uid: "user-b" });
    const result = await resolveRequestIdentity(buildRequest({ cookie: "__session=garbage", authHeader: "Bearer valid-token" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "invalid_session_cookie" });
  });

  it("expired cookie + valid bearer -> fails closed (cookie's reason)", async () => {
    mockVerifySessionCookie.mockRejectedValue(firebaseError("auth/session-cookie-expired"));
    mockVerifyIdToken.mockResolvedValue({ uid: "user-b" });
    const result = await resolveRequestIdentity(buildRequest({ cookie: "__session=expired", authHeader: "Bearer valid-token" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "expired_session" });
  });

  it("revoked cookie + valid bearer -> fails closed (cookie's reason)", async () => {
    mockVerifySessionCookie.mockRejectedValue(firebaseError("auth/session-cookie-revoked"));
    mockVerifyIdToken.mockResolvedValue({ uid: "user-b" });
    const result = await resolveRequestIdentity(buildRequest({ cookie: "__session=revoked", authHeader: "Bearer valid-token" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "revoked_session" });
  });

  it("both invalid -> fails closed (cookie's reason)", async () => {
    mockVerifySessionCookie.mockRejectedValue(new Error("malformed cookie"));
    mockVerifyIdToken.mockRejectedValue(new Error("malformed token"));
    const result = await resolveRequestIdentity(buildRequest({ cookie: "__session=garbage", authHeader: "Bearer garbage" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "invalid_session_cookie" });
  });

  it("an unrecognized Firebase verifier error (no code, generic throw) never leaks the raw error", async () => {
    mockVerifySessionCookie.mockRejectedValue(new Error("some internal Firebase Admin SDK detail that must never reach the client"));
    const result = await resolveRequestIdentity(buildRequest({ cookie: "__session=x" }));
    expect(result).toEqual({ status: "unauthenticated", reason: "invalid_session_cookie" });
    expect(JSON.stringify(result)).not.toMatch(/internal Firebase Admin SDK detail/);
  });

  it("both credentials are always independently checked when both are present — bearer is inspected even though the cookie already resolved (proves no short-circuit skip)", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
    mockVerifyIdToken.mockResolvedValue({ uid: "user-a" });
    await resolveRequestIdentity(buildRequest({ cookie: "__session=valid", authHeader: "Bearer valid-token" }));
    expect(mockVerifySessionCookie).toHaveBeenCalledTimes(1);
    expect(mockVerifyIdToken).toHaveBeenCalledTimes(1);
  });
});
