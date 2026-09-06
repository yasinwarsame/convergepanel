/**
 * Phase FIRST-ADMIN-C2 — the ADMIN_PORTAL / SYSTEM_ADMIN capability contract.
 *
 * SYSTEM_ADMIN must be derivable ONLY from the verified Firebase custom claim,
 * never from an email allowlist. An ADMIN_EMAILS member reaching SYSTEM_ADMIN
 * would put provider credentials, admin-claim minting and bulk purge behind an
 * email address.
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
const OUTSIDER = "nobody@test-invented.example";

let authRecord: Record<string, unknown> = {};
let decoded: Record<string, unknown> = {};
const getUser = jest.fn(async () => authRecord);
jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    getUser: (...a: unknown[]) => getUser(...(a as [])),
    verifyIdToken: async () => decoded,
    verifySessionCookie: async () => decoded,
  },
  adminDb: {},
}));
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: jest.fn() }));

import { NextRequest } from "next/server";
import { GET } from "../route";

const req = () =>
  new NextRequest("http://localhost/api/admin/access", { headers: { authorization: "Bearer t" } });

beforeEach(() => {
  process.env.ADMIN_EMAILS = PORTAL_ONLY;
  process.env.GOVERNANCE_ADMIN_EMAILS = GOV_ONLY;
  authRecord = {};
  decoded = {};
  getUser.mockClear();
});

describe("tier contract", () => {
  it("ADMIN_EMAILS-only -> adminPortal true, systemAdmin FALSE", async () => {
    decoded = { uid: "p", email: PORTAL_ONLY };
    authRecord = { email: PORTAL_ONLY, emailVerified: true };
    const res = await GET(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, adminPortal: true, systemAdmin: false });
  });

  it("custom claim -> adminPortal true, systemAdmin TRUE", async () => {
    decoded = { uid: "s", email: OUTSIDER, admin: true };
    authRecord = { email: OUTSIDER, emailVerified: false };
    const res = await GET(req());
    await expect(res.json()).resolves.toEqual({ ok: true, adminPortal: true, systemAdmin: true });
  });

  it("GOVERNANCE_ADMIN_EMAILS-only -> denied the portal entirely", async () => {
    decoded = { uid: "g", email: GOV_ONLY };
    authRecord = { email: GOV_ONLY, emailVerified: true };
    const res = await GET(req());
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ ok: false, adminPortal: false, systemAdmin: false });
  });

  it("an ordinary verified user is denied", async () => {
    decoded = { uid: "o", email: OUTSIDER };
    authRecord = { email: OUTSIDER, emailVerified: true };
    expect((await GET(req())).status).toBe(401);
  });

  it("an UNVERIFIED ADMIN_EMAILS member is denied", async () => {
    decoded = { uid: "u", email: PORTAL_ONLY };
    authRecord = { email: PORTAL_ONLY, emailVerified: false };
    expect((await GET(req())).status).toBe(401);
  });

  it("a non-boolean admin claim does not yield systemAdmin", async () => {
    decoded = { uid: "p", email: PORTAL_ONLY, admin: "true" };
    authRecord = { email: PORTAL_ONLY, emailVerified: true };
    await expect((await GET(req())).json()).resolves.toEqual({
      ok: true, adminPortal: true, systemAdmin: false,
    });
  });

  it("backward compatibility: `ok` is preserved and means ADMIN_PORTAL", async () => {
    decoded = { uid: "p", email: PORTAL_ONLY };
    authRecord = { email: PORTAL_ONLY, emailVerified: true };
    const body = (await (await GET(req())).json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.ok).toBe(body.adminPortal);
  });
});
