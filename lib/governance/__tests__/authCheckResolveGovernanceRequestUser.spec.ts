/**
 * Repository-Wide Auth Identity Consistency Remediation, Step 7.15 —
 * regression tests for `resolveGovernanceRequestUser()`, a shared helper
 * (used by 5 governance routes: audit, audit/backfill, review, queue,
 * policy) found during the post-migration cross-route search — NOT part
 * of the originally-disclosed 14-route inventory, since that inventory
 * only searched `app/api` directly and this vulnerability lived in a
 * `lib/` helper called indirectly. Same root-cause shape as every other
 * migrated route: previously, a valid cookie won unconditionally over a
 * different, valid bearer token.
 */

const mockVerifySessionCookie = jest.fn();
const mockVerifyIdToken = jest.fn();
jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookie: (...args: unknown[]) => mockVerifySessionCookie(...args),
}));
jest.mock("@/lib/firebase/auth", () => ({
  verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
}));

const mockGetUser = jest.fn();
jest.mock("@/lib/firebase/admin", () => ({
  get adminAuth() {
    return { getUser: (...args: unknown[]) => mockGetUser(...args) };
  },
  get adminDb() {
    return {};
  },
}));

import { NextRequest } from "next/server";
import { resolveGovernanceRequestUser } from "@/lib/governance/authCheck";

function buildRequest(opts: { cookie?: string; authHeader?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.Cookie = opts.cookie;
  if (opts.authHeader !== undefined) headers.Authorization = opts.authHeader;
  return new NextRequest("http://localhost/api/governance/audit", { headers });
}

beforeEach(() => {
  mockVerifySessionCookie.mockReset();
  mockVerifyIdToken.mockReset();
  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ email: "user@example.com" });
});

describe("resolveGovernanceRequestUser", () => {
  it("no credentials -> { ok: false, status: 401 }", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    const result = await resolveGovernanceRequestUser(buildRequest());
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it("valid cookie only -> ok with cookie uid and email from adminAuth", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
    const result = await resolveGovernanceRequestUser(buildRequest({ cookie: "__session=valid" }));
    expect(result).toEqual({ ok: true, uid: "user-a", email: "user@example.com" });
  });

  it("valid bearer only -> ok with bearer uid", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    mockVerifyIdToken.mockResolvedValue({ uid: "user-b" });
    const result = await resolveGovernanceRequestUser(buildRequest({ authHeader: "Bearer valid-token" }));
    expect(result).toEqual({ ok: true, uid: "user-b", email: "user@example.com" });
  });

  it("REGRESSION (root cause): mismatched valid cookie + bearer -> fails closed, does not use either identity", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "stale-previous-user", isAdmin: false });
    mockVerifyIdToken.mockResolvedValue({ uid: "fresh-current-user" });
    const result = await resolveGovernanceRequestUser(buildRequest({ cookie: "__session=stale", authHeader: "Bearer fresh-token" }));
    expect(result).toEqual({ ok: false, status: 401 });
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("invalid cookie only -> fails closed", async () => {
    mockVerifySessionCookie.mockRejectedValue(new Error("malformed cookie"));
    const result = await resolveGovernanceRequestUser(buildRequest({ cookie: "__session=garbage" }));
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it("RECOVERY REGRESSION: valid cookie + invalid/expired bearer -> fails closed, no fallback to the cookie (strict dual-credential policy)", async () => {
    mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
    mockVerifyIdToken.mockRejectedValue(new Error("expired token"));
    const result = await resolveGovernanceRequestUser(buildRequest({ cookie: "__session=valid", authHeader: "Bearer expired" }));
    expect(result).toEqual({ ok: false, status: 401 });
    expect(mockGetUser).not.toHaveBeenCalled();
  });
});
