/**
 * Phase FIRST-ADMIN-C2 — `/api/admin/set-role` is SYSTEM_ADMIN only.
 *
 * This route MINTS the `admin: true` custom claim. If an ADMIN_EMAILS member
 * could reach it, the email allowlist would become a self-service path to the
 * highest privilege in the product, and every other tier boundary would be
 * decorative.
 *
 * The C2 mutation set proved this was asserted nowhere: swapping the bearer
 * SYSTEM_ADMIN guard for the ADMIN_PORTAL guard survived the whole suite. These
 * tests assert the AUTHORIZATION OUTCOME — status plus the absence of any
 * privilege write — not which helper the module happens to import.
 */

/**
 * Phase FIRST-ADMIN-C2 test hygiene: jest workers reuse a single `process.env`
 * across the test FILES they run, so a suite that sets a privileged allowlist
 * and never restores it leaks that value into every later file in the same
 * worker. Snapshot BEFORE this file's own assignments; restore afterwards.
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

const PORTAL_ONLY = "portal-only@test-invented.example";
const GOV_ONLY = "governance-only@test-invented.example";

let decoded: Record<string, unknown> | null = null;
let authRecord: Record<string, unknown> = {};
const setCustomUserClaims = jest.fn(async () => undefined);
const getUser = jest.fn(async () => authRecord);
const docSet = jest.fn(async () => undefined);

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    verifyIdToken: async () => {
      if (!decoded) throw new Error("invalid token");
      return decoded;
    },
    verifySessionCookie: async () => {
      if (!decoded) throw new Error("invalid cookie");
      return decoded;
    },
    getUser: (...a: unknown[]) => getUser(...(a as [])),
    setCustomUserClaims: (...a: unknown[]) => setCustomUserClaims(...(a as [])),
  },
  adminDb: { collection: () => ({ doc: () => ({ set: (...a: unknown[]) => docSet(...(a as [])) }) }) },
  firebaseAdmin: { firestore: { FieldValue: { serverTimestamp: () => "TS" } } },
}));

import { NextRequest } from "next/server";
import { POST } from "../route";

const req = () =>
  new NextRequest("http://localhost/api/admin/set-role", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ uid: "target-uid", role: "admin" }),
  });

beforeEach(() => {
  process.env.ADMIN_EMAILS = PORTAL_ONLY;
  process.env.GOVERNANCE_ADMIN_EMAILS = GOV_ONLY;
  decoded = null;
  authRecord = {};
  setCustomUserClaims.mockClear();
  getUser.mockClear();
  docSet.mockClear();
});

describe("POST /api/admin/set-role — SYSTEM_ADMIN tier", () => {
  it("THE CORE PROOF: a verified ADMIN_EMAILS member with no claim is refused, and mints nothing", async () => {
    decoded = { uid: "portal", email: PORTAL_ONLY, email_verified: true };
    authRecord = { email: PORTAL_ONLY, emailVerified: true };
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(docSet).not.toHaveBeenCalled();
  });

  it("a verified GOVERNANCE_ADMIN_EMAILS member is refused, and mints nothing", async () => {
    decoded = { uid: "gov", email: GOV_ONLY, email_verified: true };
    authRecord = { email: GOV_ONLY, emailVerified: true };
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it("the verified admin custom claim is admitted and mints the claim", async () => {
    decoded = { uid: "sys", email: "someone@test-invented.example", admin: true };
    authRecord = { email: "someone@test-invented.example", emailVerified: false, customClaims: {} };
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(setCustomUserClaims).toHaveBeenCalledWith("target-uid", expect.objectContaining({ admin: true }));
  });

  it("an unauthenticated caller is refused", async () => {
    decoded = null;
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it("a session cookie alone never reaches this route, even holding the claim", async () => {
    decoded = { uid: "sys", email: "someone@test-invented.example", admin: true };
    const cookieOnly = new NextRequest("http://localhost/api/admin/set-role", {
      method: "POST",
      headers: { cookie: "__session=c", "content-type": "application/json" },
      body: JSON.stringify({ uid: "target-uid", role: "admin" }),
    });
    const res = await POST(cookieOnly);
    expect(res.status).toBe(401);
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });
});
