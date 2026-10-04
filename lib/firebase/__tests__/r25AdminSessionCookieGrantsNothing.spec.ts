/**
 * R-25 T3/T4 — after removing the legacy password admin session, an
 * `admin_session` cookie (the removed flow's credential) grants nothing, and the
 * live Firebase authority paths behave exactly as before:
 *
 *   - middleware gates `/admin/*` (including the removed `/admin/login`) on the
 *     Firebase `__session` cookie only;
 *   - ADMIN_PORTAL (`requireAdminPortalAccess`) needs a verified Firebase
 *     credential plus the `admin` claim or a verified `ADMIN_EMAILS` member;
 *   - SYSTEM_ADMIN (`requireSystemAdminAccess`, `requireSystemAdminBearer`) needs
 *     a verified Firebase credential with `admin === true`.
 *
 * The guards are exercised for real; only the Firebase Admin SDK is faked. The
 * fake records every credential string it is asked to verify, so "the
 * admin_session value was never presented to Firebase" is asserted, not assumed.
 */
import { NextRequest } from "next/server";

const __ENV = { ADMIN_EMAILS: process.env.ADMIN_EMAILS, GOVERNANCE_ADMIN_EMAILS: process.env.GOVERNANCE_ADMIN_EMAILS };
afterAll(() => {
  for (const [k, v] of Object.entries(__ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const LEGACY_SECRET = "a".repeat(64); // shape of the removed flow's token; not a real secret
const FIREBASE_CRED = "firebase-credential-under-test";

let decoded: Record<string, unknown> = {};
let authRecord: Record<string, unknown> = {};
const presented: string[] = [];
const verify = async (raw: unknown) => {
  presented.push(String(raw));
  if (raw !== FIREBASE_CRED) throw new Error("invalid credential");
  return decoded;
};

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    verifyIdToken: (raw: unknown) => verify(raw),
    verifySessionCookie: (raw: unknown) => verify(raw),
    getUser: async () => authRecord,
  },
  adminDb: {
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: true, data: () => ({}) }) }),
      where: () => ({ get: async () => ({ docs: [] }) }),
    }),
  },
}));
jest.mock("@/lib/admin/entitlements", () => ({ getEffectiveEntitlements: async () => ({ planId: "free" }) }));
jest.mock("@/lib/governance/reviewerFields", () => ({ parseGovernanceReviewerFor: () => [] }));

import { middleware } from "@/middleware";
import { requireAdminPortalAccess, requireSystemAdminAccess, verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { requireSystemAdminBearer } from "@/lib/firebase/adminAuth";

const req = (path: string, cookies: Record<string, string> = {}, bearer?: string) =>
  new NextRequest(`https://app.test.invalid${path}`, {
    headers: {
      ...(Object.keys(cookies).length ? { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
  });

beforeEach(() => {
  process.env.ADMIN_EMAILS = "";
  process.env.GOVERNANCE_ADMIN_EMAILS = "";
  decoded = {};
  authRecord = {};
  presented.length = 0;
});

describe("T3 — middleware gates /admin on the Firebase __session cookie only", () => {
  it.each(["/admin", "/admin/login", "/admin/users"])("%s with only an admin_session cookie redirects to /login", (path) => {
    const res = middleware(req(path, { admin_session: LEGACY_SECRET }));
    expect([307, 308]).toContain(res.status);
    const loc = new URL(res.headers.get("location") as string);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe(path);
  });
  it("POSITIVE CONTROL: a __session cookie passes the presence gate (unchanged)", () => {
    const res = middleware(req("/admin", { __session: FIREBASE_CRED }));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("T3 — ADMIN_PORTAL ignores admin_session and keeps its Firebase authority", () => {
  it("only an admin_session cookie → denied, and the value is never presented to Firebase", async () => {
    decoded = { uid: "u1", admin: true, email: "x@test.invalid" };
    expect(await requireAdminPortalAccess(req("/api/admin/users", { admin_session: LEGACY_SECRET }))).toBeNull();
    expect(presented).not.toContain(LEGACY_SECRET);
  });
  it("POSITIVE CONTROL: Firebase __session + admin claim → allowed (unchanged)", async () => {
    decoded = { uid: "u1", admin: true, email: "x@test.invalid" };
    expect(await requireAdminPortalAccess(req("/api/admin/users", { __session: FIREBASE_CRED }))).toEqual({ uid: "u1", email: "x@test.invalid" });
  });
  it("POSITIVE CONTROL: verified ADMIN_EMAILS member via bearer → allowed (unchanged)", async () => {
    process.env.ADMIN_EMAILS = "member@test.invalid";
    decoded = { uid: "u2" };
    authRecord = { uid: "u2", email: "member@test.invalid", emailVerified: true, disabled: false };
    expect(await requireAdminPortalAccess(req("/api/admin/users", {}, FIREBASE_CRED))).toEqual({ uid: "u2", email: "member@test.invalid" });
  });
  it("Firebase credential without claim or verified membership → denied (fail closed, unchanged)", async () => {
    decoded = { uid: "u3" };
    authRecord = { uid: "u3", email: "nobody@test.invalid", emailVerified: true, disabled: false };
    expect(await requireAdminPortalAccess(req("/api/admin/users", { __session: FIREBASE_CRED, admin_session: LEGACY_SECRET }))).toBeNull();
  });
});

describe("T4 — SYSTEM_ADMIN gates stay fail-closed and ignore admin_session", () => {
  it("requireSystemAdminAccess: only admin_session → null; value never presented", async () => {
    decoded = { uid: "u1", admin: true };
    expect(await requireSystemAdminAccess(req("/api/admin/keys", { admin_session: LEGACY_SECRET }))).toBeNull();
    expect(presented).not.toContain(LEGACY_SECRET);
  });
  it("requireSystemAdminBearer: only admin_session → not authorized; value never presented", async () => {
    decoded = { uid: "u1", admin: true };
    expect(await requireSystemAdminBearer(req("/api/admin/keys", { admin_session: LEGACY_SECRET }))).toBeNull();
    expect(presented).not.toContain(LEGACY_SECRET);
  });
  it("POSITIVE CONTROL: bearer Firebase credential with admin === true → allowed (unchanged)", async () => {
    decoded = { uid: "u1", admin: true };
    expect(await requireSystemAdminAccess(req("/api/admin/keys", {}, FIREBASE_CRED))).toMatchObject({ uid: "u1", isAdmin: true });
  });
  it("ADMIN_EMAILS membership never yields SYSTEM_ADMIN (unchanged)", async () => {
    process.env.ADMIN_EMAILS = "member@test.invalid";
    decoded = { uid: "u2" };
    authRecord = { uid: "u2", email: "member@test.invalid", emailVerified: true, disabled: false };
    expect(await requireSystemAdminAccess(req("/api/admin/keys", {}, FIREBASE_CRED))).toBeNull();
  });
});

describe("T4 — requireSystemAdminBearer positive control (unchanged)", () => {
  it("bearer Firebase credential with admin === true → { uid }", async () => {
    decoded = { uid: "u9", admin: true };
    expect(await requireSystemAdminBearer(req("/api/admin/keys", {}, FIREBASE_CRED))).toEqual({ uid: "u9" });
  });
});

describe("T3 — the plain Firebase session-cookie read ignores admin_session", () => {
  it("verifySessionCookie: only admin_session → null; value never presented", async () => {
    decoded = { uid: "u1", admin: true };
    expect(await verifySessionCookie(req("/api/auth/session", { admin_session: LEGACY_SECRET }))).toBeNull();
    expect(presented).not.toContain(LEGACY_SECRET);
  });
  it("POSITIVE CONTROL: __session → { uid, isAdmin } (unchanged)", async () => {
    decoded = { uid: "u1", admin: true };
    expect(await verifySessionCookie(req("/api/auth/session", { __session: FIREBASE_CRED }))).toMatchObject({ uid: "u1" });
  });
});

