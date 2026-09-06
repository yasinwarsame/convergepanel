/**
 * Phase FIRST-ADMIN-C2 — presentation scope separation (closes M10).
 *
 * The existing presentation suite put ONE address on BOTH allowlists, so a
 * mutation re-blending the scopes passed it. Every fixture here is STRICTLY
 * DISJOINT, and each tier is asserted independently.
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

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...a: any[]) => mockedResolveRequestIdentity(...a),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const userDocs = new Map<string, Record<string, unknown>>();
const mockAdminDb: any = {
  collection: () => ({
    doc: (uid: string) => ({
      get: async () => ({ exists: userDocs.has(uid), data: () => userDocs.get(uid) }),
      set: jest.fn(async () => {}),
      update: jest.fn(async () => {}),
    }),
  }),
};
let authRecord: Record<string, unknown> = {};
const mockedGetUser = jest.fn(async () => authRecord);
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: mockAdminDb,
  adminAuth: { getUser: (...a: any[]) => mockedGetUser(...a) },
}));
jest.mock("@/lib/admin/entitlements", () => ({
  getEffectiveEntitlements: jest.fn(async () => ({
    source: "free", plan: "free", planId: "free", planLabel: "P", monthlyLimit: 8, maxModelsPerRun: 2,
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
const call = async () => (await GET(new NextRequest("http://localhost/api/user/usage"))).json();

beforeEach(() => {
  // Strictly disjoint lists — the whole point of this suite.
  process.env.ADMIN_EMAILS = PORTAL_ONLY;
  process.env.GOVERNANCE_ADMIN_EMAILS = GOV_ONLY;
  userDocs.clear();
  authRecord = {};
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  userDocs.set(UID, { plan: "free", runsThisMonth: 0, usageMonth: "2026-09" });
});

describe("ADMIN_PORTAL only (ADMIN_EMAILS, not governance)", () => {
  it("THE FIX: receives NO governance presentation", async () => {
    authRecord = { email: PORTAL_ONLY, emailVerified: true };
    const b = await call();
    expect(b).toHaveProperty("maxModelsPerRun");           // real path, not the fallback
    expect(b.governancePolicyEditable).toBe(false);
    expect(b.governanceDashboardEligible).toBe(false);
  });
});

describe("GOVERNANCE_ADMIN only (governance list, not ADMIN_EMAILS)", () => {
  it("receives governance presentation", async () => {
    authRecord = { email: GOV_ONLY, emailVerified: true };
    const b = await call();
    expect(b).toHaveProperty("maxModelsPerRun");
    expect(b.governancePolicyEditable).toBe(true);
    expect(b.governanceDashboardEligible).toBe(true);
    expect(b.governanceDenyReason).toBeNull();
  });
});

describe("ordinary and unverified identities", () => {
  it("an outsider receives neither", async () => {
    authRecord = { email: OUTSIDER, emailVerified: true };
    const b = await call();
    expect(b.governancePolicyEditable).toBe(false);
    expect(b.role).toBe("member");
  });

  it("an UNVERIFIED governance-list member receives neither", async () => {
    authRecord = { email: GOV_ONLY, emailVerified: false };
    const b = await call();
    expect(b.governancePolicyEditable).toBe(false);
    expect(b.governanceDashboardEligible).toBe(false);
  });
});

describe("legacy role field", () => {
  it("role:'admin' is presentation compatibility ONLY and must never be read as SYSTEM_ADMIN", async () => {
    // It is emitted for either privileged scope, so it cannot distinguish tiers
    // and must not be used to authorize anything. The authoritative signals are
    // governancePolicyEditable here, and systemAdmin from /api/admin/access.
    authRecord = { email: GOV_ONLY, emailVerified: true };
    const gov = await call();
    expect(gov.role).toBe("admin");
    expect(gov.governancePolicyEditable).toBe(true);

    authRecord = { email: PORTAL_ONLY, emailVerified: true };
    const portal = await call();
    expect(portal.role).toBe("admin");
    // Same legacy string, opposite governance authority — proof it carries no tier.
    expect(portal.governancePolicyEditable).toBe(false);

    // And no field in the payload claims system-admin authority.
    expect(portal).not.toHaveProperty("systemAdmin");
  });
});
