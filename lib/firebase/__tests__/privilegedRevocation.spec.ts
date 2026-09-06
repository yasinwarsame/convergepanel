/**
 * Phase FIRST-ADMIN-C3 — REVOCATION SEMANTICS AT EVERY PRIVILEGED VERIFIER.
 *
 * R2 found `checkRevoked` untested everywhere: flipping the second argument of
 * `verifySessionCookie(cookie, true)` to `false` — at any of the three sites
 * that use it — was invisible to all 11,052 tests. A regression there would let
 * a revoked session or a disabled user keep privileged access for the cookie's
 * full five-day life (`app/api/auth/session/route.ts` mints with
 * `expiresIn: 5 days`).
 *
 * THE SEMANTICS ARE NOT UNIFORM, AND THIS SUITE PINS THEM AS THEY ARE RATHER
 * THAN PRETENDING THEY ARE:
 *
 *   SESSION COOKIES (`verifySessionCookie(raw, true)`) — revocation IS checked.
 *     Three sites: verifySessionCookieValue, the requireAdminPortalAccess
 *     cookie fallback, and the /api/admin/access cookie fallback. Firebase
 *     rejects a revoked cookie and a disabled user when the flag is set; with
 *     the flag false it validates the signature and expiry only.
 *
 *   ID TOKENS (`verifyIdToken(token)`) — revocation is NOT checked. Firebase
 *     defaults `checkRevoked` to false, and every ID-token site here relies on
 *     that default. The mitigation is lifetime: ID tokens expire in one hour,
 *     where a session cookie lives five days. This is the standard Firebase
 *     trade-off, recorded here so a future reader does not mistake the
 *     asymmetry for an oversight — and so that a change to it breaks a test.
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
let cookieError: Error | null = null;
let tokenError: Error | null = null;

const verifyIdToken = jest.fn(async (..._a: unknown[]) => {
  if (tokenError) throw tokenError;
  return decoded;
});
const verifySessionCookie = jest.fn(async (..._a: unknown[]) => {
  if (cookieError) throw cookieError;
  return decoded;
});

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    verifyIdToken: (...a: unknown[]) => verifyIdToken(...a),
    verifySessionCookie: (...a: unknown[]) => verifySessionCookie(...a),
    getUser: async () => authRecord,
  },
  adminDb: {},
}));
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: jest.fn() }));

import { NextRequest } from "next/server";
import {
  requireAdminPortalAccess,
  verifySessionCookieValue,
} from "@/lib/firebase/auth-helpers";
import { GET as ADMIN_ACCESS_GET } from "@/app/api/admin/access/route";

/** Firebase's real error shapes for the two conditions the flag exists to catch. */
const revoked = () => Object.assign(new Error("session cookie revoked"), { code: "auth/session-cookie-revoked" });
const disabled = () => Object.assign(new Error("user disabled"), { code: "auth/user-disabled" });

const cookieReq = (url: string) =>
  new NextRequest(url, { headers: { cookie: "__session=c" } });

beforeEach(() => {
  process.env.ADMIN_EMAILS = PORTAL;
  process.env.GOVERNANCE_ADMIN_EMAILS = GOV;
  decoded = { uid: "u", email: PORTAL };
  authRecord = { email: PORTAL, emailVerified: true };
  cookieError = null;
  tokenError = null;
  verifyIdToken.mockClear();
  verifySessionCookie.mockClear();
});

/** The three sites that must ask Firebase to check revocation. */
describe("session-cookie verification asks Firebase to check revocation", () => {
  it("verifySessionCookieValue passes checkRevoked = true", async () => {
    await verifySessionCookieValue("c");
    expect(verifySessionCookie).toHaveBeenCalledWith("c", true);
  });

  it("the requireAdminPortalAccess cookie fallback passes checkRevoked = true", async () => {
    tokenError = new Error("not an id token"); // force the cookie branch
    await requireAdminPortalAccess(cookieReq("http://localhost/api/admin/runs"));
    expect(verifySessionCookie).toHaveBeenCalledWith("c", true);
  });

  it("the /api/admin/access cookie fallback passes checkRevoked = true", async () => {
    tokenError = new Error("not an id token");
    decoded = { uid: "u", email: PORTAL, admin: true };
    await ADMIN_ACCESS_GET(cookieReq("http://localhost/api/admin/access"));
    expect(verifySessionCookie).toHaveBeenCalledWith("c", true);
  });

  it("EVERY verifySessionCookie call in a privileged path sets the flag", async () => {
    tokenError = new Error("not an id token");
    await requireAdminPortalAccess(cookieReq("http://localhost/api/admin/runs"));
    await ADMIN_ACCESS_GET(cookieReq("http://localhost/api/admin/access"));
    await verifySessionCookieValue("c");
    expect(verifySessionCookie).toHaveBeenCalled();
    for (const call of verifySessionCookie.mock.calls) {
      expect(call[1]).toBe(true);
    }
  });
});

describe("a revoked session and a disabled user are denied", () => {
  it("revoked cookie -> portal access denied", async () => {
    tokenError = new Error("not an id token");
    cookieError = revoked();
    await expect(
      requireAdminPortalAccess(cookieReq("http://localhost/api/admin/runs"))
    ).resolves.toBeNull();
  });

  it("disabled user -> portal access denied", async () => {
    tokenError = new Error("not an id token");
    cookieError = disabled();
    await expect(
      requireAdminPortalAccess(cookieReq("http://localhost/api/admin/runs"))
    ).resolves.toBeNull();
  });

  it("revoked cookie -> /api/admin/access denied", async () => {
    tokenError = new Error("not an id token");
    cookieError = revoked();
    const res = await ADMIN_ACCESS_GET(cookieReq("http://localhost/api/admin/access"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ ok: false, adminPortal: false, systemAdmin: false });
  });

  it("revoked cookie -> verifySessionCookieValue rejects rather than returning an identity", async () => {
    cookieError = revoked();
    await expect(verifySessionCookieValue("c")).rejects.toThrow(/revoked/i);
  });

  it("an ordinary valid privileged identity still works over the cookie", async () => {
    tokenError = new Error("not an id token");
    await expect(
      requireAdminPortalAccess(cookieReq("http://localhost/api/admin/runs"))
    ).resolves.toEqual({ uid: "u", email: PORTAL });
  });
});

describe("ID-token paths: revocation is NOT checked, by documented design", () => {
  it("verifyIdToken is called with the token only — no checkRevoked argument", async () => {
    await requireAdminPortalAccess(
      new NextRequest("http://localhost/api/admin/runs", { headers: { authorization: "Bearer t" } })
    );
    expect(verifyIdToken).toHaveBeenCalled();
    // Pins the asymmetry: if someone later enables revocation checking on ID
    // tokens, this test should be updated deliberately, not silently.
    for (const call of verifyIdToken.mock.calls) {
      expect(call.length).toBe(1);
    }
  });

  it("a credential Firebase refuses to verify by EITHER method is denied", async () => {
    // `requireAdminPortalAccess` resolves one `raw` value from the header OR
    // the cookie and tries it as an ID token first, then as a session cookie.
    // So denial requires both to fail — that is the guard's actual contract,
    // not a fallback that widens authority: the second attempt validates the
    // same credential the caller already presented.
    tokenError = new Error("invalid token");
    cookieError = new Error("invalid cookie");
    await expect(
      requireAdminPortalAccess(
        new NextRequest("http://localhost/api/admin/runs", { headers: { authorization: "Bearer t" } })
      )
    ).resolves.toBeNull();
  });
});
