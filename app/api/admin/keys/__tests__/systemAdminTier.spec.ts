/**
 * Phase FIRST-ADMIN-C2 — `/api/admin/keys` is SYSTEM_ADMIN only.
 *
 * This route reads and writes the shared PROVIDER API CREDENTIALS. An
 * ADMIN_EMAILS member reaching it would put every model provider key behind an
 * email address on an allowlist.
 *
 * As with set-role, the C2 mutation set showed the tier was asserted nowhere.
 * These tests assert the authorization outcome and the absence of any read or
 * write of the credential document.
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
const keysGet = jest.fn(async () => ({ exists: true, data: () => ({}) }));
const keysSet = jest.fn(async () => undefined);

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
    getUser: async () => authRecord,
  },
  adminDb: {
    collection: () => ({
      doc: () => ({
        get: (...a: unknown[]) => keysGet(...(a as [])),
        set: (...a: unknown[]) => keysSet(...(a as [])),
      }),
    }),
  },
  firebaseAdmin: { firestore: { FieldValue: { serverTimestamp: () => "TS" } } },
}));

import { NextRequest } from "next/server";
import { GET, POST } from "../route";

const get = () =>
  new NextRequest("http://localhost/api/admin/keys", { headers: { authorization: "Bearer t" } });
const post = () =>
  new NextRequest("http://localhost/api/admin/keys", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ chatgpt: "sk-invented-not-a-real-key" }),
  });

beforeEach(() => {
  // Both lists are set explicitly. Jest workers reuse one `process.env`
  // across the test FILES they run, so a fixture that leaves a list unset is
  // reading whatever the previous file happened to leave behind.
  process.env.ADMIN_EMAILS = PORTAL_ONLY;
  process.env.GOVERNANCE_ADMIN_EMAILS = GOV_ONLY;
  decoded = null;
  authRecord = {};
  keysGet.mockClear();
  keysSet.mockClear();
});

describe("/api/admin/keys — SYSTEM_ADMIN tier", () => {
  it("THE CORE PROOF: a verified ADMIN_EMAILS member cannot READ the credentials", async () => {
    decoded = { uid: "portal", email: PORTAL_ONLY, email_verified: true };
    authRecord = { email: PORTAL_ONLY, emailVerified: true };
    const res = await GET(get());
    expect(res.status).toBe(401);
    expect(keysGet).not.toHaveBeenCalled();
  });

  it("THE CORE PROOF: a verified ADMIN_EMAILS member cannot WRITE the credentials", async () => {
    decoded = { uid: "portal", email: PORTAL_ONLY, email_verified: true };
    authRecord = { email: PORTAL_ONLY, emailVerified: true };
    const res = await POST(post());
    expect(res.status).toBe(401);
    expect(keysSet).not.toHaveBeenCalled();
  });

  it("the verified admin custom claim is admitted", async () => {
    decoded = { uid: "sys", email: "someone@test-invented.example", admin: true };
    const res = await GET(get());
    expect(res.status).not.toBe(401);
  });

  it("an unauthenticated caller is refused", async () => {
    decoded = null;
    expect((await GET(get())).status).toBe(401);
    expect(keysGet).not.toHaveBeenCalled();
  });

  it("a session cookie alone never reaches this route, even holding the claim", async () => {
    decoded = { uid: "sys", email: "someone@test-invented.example", admin: true };
    const cookieOnly = new NextRequest("http://localhost/api/admin/keys", {
      headers: { cookie: "__session=c" },
    });
    const res = await GET(cookieOnly);
    expect(res.status).toBe(401);
    expect(keysGet).not.toHaveBeenCalled();
  });
});
