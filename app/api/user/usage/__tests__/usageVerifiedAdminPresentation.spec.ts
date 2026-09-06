/**
 * Phase FIRESTORE-AUTHZ-P0.2 — presentation must agree with the server.
 *
 * `/api/user/usage` drives TopNav and the governance dashboard's admin
 * affordances. It previously derived an email-admin role from two unverified
 * sources: the Auth-record address with no verification check, and the mirrored
 * Firestore `users/{uid}.email`. It must now ask exactly what the authoritative
 * governance path asks.
 *
 * Uses the REAL `@/lib/admin/config` and `@/lib/admin/verifiedAdminIdentity`.
 */

process.env.ADMIN_EMAILS = "admin@test-invented.example";

const ADMIN = "admin@test-invented.example";
const OUTSIDER = "nobody@test-invented.example";

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const userDocs = new Map<string, Record<string, unknown>>();
const mockAdminDb: any = {
  collection: () => ({
    doc: (uid: string) => ({
      get: async () => ({ exists: userDocs.has(uid), data: () => userDocs.get(uid) }),
      set: jest.fn(async (f: Record<string, unknown>, o?: { merge?: boolean }) => {
        userDocs.set(uid, { ...(o?.merge ? userDocs.get(uid) || {} : {}), ...f });
      }),
      update: jest.fn(async (f: Record<string, unknown>) => {
        userDocs.set(uid, { ...(userDocs.get(uid) || {}), ...f });
      }),
    }),
  }),
};

let authRecord: Record<string, unknown> = {};
let getUserThrows = false;
const mockedGetUser = jest.fn(async () => {
  if (getUserThrows) throw new Error("auth unavailable");
  return authRecord;
});
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: mockAdminDb,
  adminAuth: { getUser: (...a: any[]) => mockedGetUser(...a) },
}));

let planId = "free";
jest.mock("@/lib/admin/entitlements", () => ({
  getEffectiveEntitlements: jest.fn(async () => ({
    source: "free", plan: planId, planId, planLabel: "P", monthlyLimit: 8, maxModelsPerRun: 2,
  })),
}));
jest.mock("@/lib/stripe/subscriptionValidation", () => ({
  validateUserSubscription: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/governance/reviewerFields", () => ({ parseGovernanceReviewerFor: () => [] }));
jest.mock("@/lib/billing/planConfig", () => ({ getVideoLimit: () => 0 }));
jest.mock("@/lib/env", () => ({
  PERSONAL_WORKSPACE_UI_ENABLED: false, PERSONAL_WORKSPACE_UI_CANARY_UIDS: undefined,
  APPROVAL_WORKFLOW_ENABLED: false, APPROVAL_WORKFLOW_CANARY_UIDS: undefined,
  TEAM_WORKSPACES_ENABLED: false, TEAM_WORKSPACES_CANARY_UIDS: undefined,
  TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined,
}));
jest.mock("@/lib/workspaces/resolveViewerTeamWorkspaceSelection", () => ({
  resolveViewerTeamWorkspaceSelection: jest.fn(async () => ({ kind: "none" })),
}));
jest.mock("@/lib/workspaces/resolveWorkspaceCanaryMembershipsForUid", () => ({
  resolveWorkspaceCanaryMembershipsForUid: jest.fn(async () => ({ status: "ok", workspaceIds: [] })),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/usage/route";

const UID = "viewer-1";

/**
 * The route's catch-all fallback returns `{ ok: true, plan: "free", role:
 * "member", governancePolicyEditable: false, monthlyLimit: 8 }` — which is
 * INDISTINGUISHABLE from a legitimate free-plan member on exactly the fields
 * these tests assert. A mutation that made the admin logic throw therefore
 * passed the whole suite.
 *
 * `maxModelsPerRun` is emitted on every real path and on NO fallback path, so
 * it is the discriminator: asserting it proves the assertions below describe a
 * real decision rather than a degraded default.
 */
async function call(opts: { allowDegraded?: boolean } = {}) {
  const res = await GET(new NextRequest("http://localhost/api/user/usage"));
  const body = await res.json();
  if (!opts.allowDegraded) {
    expect(body).toHaveProperty("maxModelsPerRun");
  }
  return body;
}

beforeEach(() => {
  userDocs.clear();
  authRecord = {};
  getUserThrows = false;
  planId = "free";
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  userDocs.set(UID, { plan: "free", runsThisMonth: 0, usageMonth: "2026-09" });
});

describe("email-derived admin presentation", () => {
  it("THE FIX: unverified allowlisted Auth identity is presented as ordinary", async () => {
    authRecord = { email: ADMIN, emailVerified: false };
    const body = await call();
    expect(body.role).toBe("member");
    expect(body.governancePolicyEditable).toBe(false);
    expect(body.governanceDashboardEligible).toBe(false);
  });

  it("verified allowlisted Auth identity receives the intended presentation", async () => {
    authRecord = { email: ADMIN, emailVerified: true };
    const body = await call();
    expect(body.role).toBe("admin");
    expect(body.governancePolicyEditable).toBe(true);
    expect(body.governanceDashboardEligible).toBe(true);
    expect(body.governanceDenyReason).toBeNull();
  });

  it("THE FIX: a Firestore email set to an allowlisted address manufactures nothing", async () => {
    // The mirrored profile field claims the admin address; the real identity does not.
    userDocs.set(UID, { plan: "free", runsThisMonth: 0, usageMonth: "2026-09", email: ADMIN });
    authRecord = { email: OUTSIDER, emailVerified: true };
    const body = await call();
    expect(body.role).toBe("member");
    expect(body.governancePolicyEditable).toBe(false);
  });

  it("a Firestore email claiming admin does not help even when the account is unverified-allowlisted", async () => {
    userDocs.set(UID, { plan: "free", runsThisMonth: 0, usageMonth: "2026-09", email: ADMIN });
    authRecord = { email: ADMIN, emailVerified: false };
    const body = await call();
    expect(body.role).toBe("member");
    expect(body.governancePolicyEditable).toBe(false);
  });

  it("server-written Firestore role is preserved (not client-writable since P0.1)", async () => {
    userDocs.set(UID, { plan: "free", runsThisMonth: 0, usageMonth: "2026-09", role: "admin" });
    authRecord = { email: OUTSIDER, emailVerified: true };
    const body = await call();
    expect(body.role).toBe("admin");
    // …but it still does not confer the email-derived policy-edit affordance.
    expect(body.governancePolicyEditable).toBe(false);
  });

  it("FAIL CLOSED: Auth lookup failure presents ordinary AND does not fail the request", async () => {
    getUserThrows = true;
    const body = await call();
    expect(body.ok).toBe(true);
    expect(body.role).toBe("member");
    expect(body.governancePolicyEditable).toBe(false);
    expect(body.plan).toBe("free");
    expect(body.monthlyLimit).toBe(8);
    // Not the degraded fallback: the request genuinely succeeded.
    expect(body.maxModelsPerRun).toBe(2);
  });

  it("new-user branch applies the same rule", async () => {
    userDocs.clear();
    authRecord = { email: ADMIN, emailVerified: false };
    const body = await call();
    expect(body.role).toBe("member");
    expect(body.governancePolicyEditable).toBe(false);
  });

  it("new-user branch grants presentation to a verified allowlisted identity", async () => {
    userDocs.clear();
    authRecord = { email: ADMIN, emailVerified: true };
    const body = await call();
    expect(body.role).toBe("admin");
    expect(body.governancePolicyEditable).toBe(true);
  });
});
