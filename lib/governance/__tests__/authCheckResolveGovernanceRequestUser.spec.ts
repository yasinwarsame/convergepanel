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
  // Phase FIRESTORE-AUTHZ-P0.2: `emailVerified` now travels out of this same
  // record read, so the fixture must supply it like the real Auth record does.
  mockGetUser.mockResolvedValue({ email: "user@example.com", emailVerified: true });
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
    expect(result).toEqual({ ok: true, uid: "user-a", email: "user@example.com", emailVerified: true });
  });

  it("valid bearer only -> ok with bearer uid", async () => {
    mockVerifySessionCookie.mockResolvedValue(null);
    mockVerifyIdToken.mockResolvedValue({ uid: "user-b" });
    const result = await resolveGovernanceRequestUser(buildRequest({ authHeader: "Bearer valid-token" }));
    expect(result).toEqual({ ok: true, uid: "user-b", email: "user@example.com", emailVerified: true });
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

  /**
   * Phase FIRESTORE-AUTHZ-P0.2 — VERIFICATION PROVENANCE (DATA CONTRACT).
   *
   * WHAT THESE CASES PROVE, PRECISELY: that
   * `resolveGovernanceRequestUser()` faithfully propagates Firebase Auth's
   * verification state out of the live user record it reads, and never
   * manufactures it. Hard-coding that value would violate the resolver's
   * provenance contract — `emailVerified` in its return type asserts "this is
   * what Firebase reports about this identity", and a constant would make the
   * field a lie to every present and future consumer.
   *
   * WHAT THEY DO NOT PROVE, AND MUST NOT BE READ AS PROVING: administrator
   * escalation, in either direction. As of Phase C1 the governance authority
   * decision does NOT flow through this return value. `checkAdminOnly(uid)` and
   * the UID-only `resolveGovernanceVisibleUserIds(uid)` each establish their own
   * live Auth evidence inside their own trust boundary, and that is where the
   * escalation proof lives (see `verifiedGovernanceAuthority.spec.ts`). At this
   * head the only consumer of this field is a diagnostic log line in
   * `app/api/governance/queue/route.ts`.
   *
   * These cases exist anyway, and are worth keeping, because this is the
   * documented provenance point: a future caller may legitimately consume the
   * field, and it must be true when they do.
   *
   * They were added because the original fixture pinned the Auth record to
   * `emailVerified: true` in `beforeEach` and never varied it, so every
   * assertion was tautological with respect to provenance. These vary the
   * record, so the resolver must actually propagate what it read.
   */
  describe("emailVerified provenance — read from the live Auth record, never manufactured", () => {
    it("record verified -> resolver reports verified", async () => {
      mockGetUser.mockResolvedValue({ email: "user@example.com", emailVerified: true });
      mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
      const r = await resolveGovernanceRequestUser(buildRequest({ cookie: "__session=valid" }));
      expect(r).toEqual({ ok: true, uid: "user-a", email: "user@example.com", emailVerified: true });
    });

    it("THE LOAD-BEARING CASE: record UNVERIFIED -> resolver reports emailVerified false", async () => {
      mockGetUser.mockResolvedValue({ email: "user@example.com", emailVerified: false });
      mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
      const r = await resolveGovernanceRequestUser(buildRequest({ cookie: "__session=valid" }));
      expect(r).toEqual({ ok: true, uid: "user-a", email: "user@example.com", emailVerified: false });
    });

    it.each([
      ["absent", {}],
      ["undefined", { emailVerified: undefined }],
      ["null", { emailVerified: null }],
      ['string "true"', { emailVerified: "true" }],
      ["number 1", { emailVerified: 1 }],
    ])("non-boolean verification (%s) is reported as false, never true", async (_label, extra) => {
      mockGetUser.mockResolvedValue({ email: "user@example.com", ...(extra as object) });
      mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
      const r = await resolveGovernanceRequestUser(buildRequest({ cookie: "__session=valid" }));
      expect(r).toEqual({ ok: true, uid: "user-a", email: "user@example.com", emailVerified: false });
    });

    it("email and verification come from the SAME record read", async () => {
      mockGetUser.mockResolvedValue({ email: "other@example.com", emailVerified: false });
      mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
      const r = await resolveGovernanceRequestUser(buildRequest({ cookie: "__session=valid" }));
      // Both fields track the record together — one getUser call, one identity.
      expect(r).toEqual({ ok: true, uid: "user-a", email: "other@example.com", emailVerified: false });
      expect(mockGetUser).toHaveBeenCalledTimes(1);
      expect(mockGetUser).toHaveBeenCalledWith("user-a");
    });

    it("the resolver reports both possible values across calls (not a constant)", async () => {
      mockVerifySessionCookie.mockResolvedValue({ uid: "user-a", isAdmin: false });
      mockGetUser.mockResolvedValue({ email: "u@example.com", emailVerified: true });
      const verified = await resolveGovernanceRequestUser(buildRequest({ cookie: "__session=valid" }));
      mockGetUser.mockResolvedValue({ email: "u@example.com", emailVerified: false });
      const unverified = await resolveGovernanceRequestUser(buildRequest({ cookie: "__session=valid" }));
      expect((verified as { emailVerified: boolean }).emailVerified).toBe(true);
      expect((unverified as { emailVerified: boolean }).emailVerified).toBe(false);
    });
  });
});
