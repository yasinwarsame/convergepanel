/**
 * Phase FIRST-ADMIN-C3 — REVOCATION SEMANTICS AT EVERY PRIVILEGED VERIFIER (legacy auth-helpers).
 *
 * ZCA P3 R2 ("verify, don't mint"): the session-cookie verifier in lib/firebase/auth-helpers.ts was
 * DELETED (no production code reads or verifies `__session`). Its revocation pins in this file were
 * deleted with it; what remains is:
 *   - the module exports no session-cookie verifier at all;
 *   - the legacy `requireAdminPortalAccess` helper is bearer-only (ZCA L-8): a cookie-only request is
 *     denied with no verifier call, and its ID-token check passes checkRevoked = true.
 * The live paths are pinned elsewhere: the privileged-access guard (checkRevoked=false + its ONE live
 * snapshot) in lib/admin/__tests__/privilegedAccess.spec.ts; the request resolver (checkRevoked=true)
 * in lib/auth/__tests__/bearerRevocationRealSdk.spec.ts; the handshake in app/api/auth/session/__tests__/.
 */

const __PRIVILEGED_ENV_SNAPSHOT = {
  ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  GOVERNANCE_ADMIN_EMAILS: process.env.GOVERNANCE_ADMIN_EMAILS,
};
afterAll(() => {
  for (const [key, value] of Object.entries(__PRIVILEGED_ENV_SNAPSHOT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const PORTAL = "portal-only@test-invented.example";
const GOV = "governance-only@test-invented.example";

let decoded: Record<string, unknown> = {};
let authRecord: Record<string, unknown> = {};
let tokenError: Error | null = null;

const verifyIdToken = jest.fn(async (..._a: unknown[]) => {
  if (tokenError) throw tokenError;
  return decoded;
});

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    verifyIdToken: (...a: unknown[]) => verifyIdToken(...a),
    getUser: async () => authRecord,
  },
  adminDb: {},
}));
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: jest.fn() }));

import { NextRequest } from "next/server";
import * as authHelpers from "@/lib/firebase/auth-helpers";
import { requireAdminPortalAccess } from "@/lib/firebase/auth-helpers";

const cookieReq = (url: string) =>
  new NextRequest(url, { headers: { cookie: "__session=c" } });

beforeEach(() => {
  process.env.ADMIN_EMAILS = PORTAL;
  process.env.GOVERNANCE_ADMIN_EMAILS = GOV;
  decoded = { uid: "u", email: PORTAL };
  authRecord = { email: PORTAL, emailVerified: true };
  tokenError = null;
  verifyIdToken.mockClear();
});

describe("ZCA P3 R2: there is no session-cookie verifier (its revocation pins were deleted with it)", () => {
  it("lib/firebase/auth-helpers exports no session-cookie verifier", () => {
    expect(Object.keys(authHelpers).filter((k) => /session/i.test(k))).toEqual([]);
  });

  it("ZCA L-8: requireAdminPortalAccess has NO cookie fallback — a cookie-only request is denied and no verifier is called", async () => {
    tokenError = new Error("not an id token");
    await expect(requireAdminPortalAccess(cookieReq("http://localhost/api/admin/runs"))).resolves.toBeNull();
    expect(verifyIdToken).not.toHaveBeenCalled();
  });
});

describe("a valid privileged identity works over the bearer only", () => {
  it("ZCA L-8: an ordinary valid privileged identity works over the BEARER (positive control), never over the cookie", async () => {
    await expect(
      requireAdminPortalAccess(new NextRequest("http://localhost/api/admin/runs", { headers: { authorization: "Bearer t" } }))
    ).resolves.toEqual({ uid: "u", email: PORTAL });
    tokenError = new Error("not an id token");
    await expect(requireAdminPortalAccess(cookieReq("http://localhost/api/admin/runs"))).resolves.toBeNull();
  });
});

describe("ID-token paths: revocation IS checked since ZCA L-8 (the deliberate update this pin asked for)", () => {
  it("verifyIdToken is called with checkRevoked = true", async () => {
    await requireAdminPortalAccess(
      new NextRequest("http://localhost/api/admin/runs", { headers: { authorization: "Bearer t" } })
    );
    expect(verifyIdToken).toHaveBeenCalled();
    for (const call of verifyIdToken.mock.calls) {
      expect(call[1]).toBe(true);
    }
  });

  it("a bearer Firebase refuses to verify is denied (there is no second method)", async () => {
    tokenError = new Error("invalid token");
    await expect(
      requireAdminPortalAccess(
        new NextRequest("http://localhost/api/admin/runs", { headers: { authorization: "Bearer t" } })
      )
    ).resolves.toBeNull();
  });
});
