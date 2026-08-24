/**
 * Phase 5C — GET /api/user/usage. No prior test file existed for this
 * route; this covers the new additive `workspaceUiEnabled` field and
 * confirms every pre-existing field remains present and unchanged.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const userDocs = new Map<string, Record<string, unknown>>();
const mockAdminDb: any = {
  collection: (name: string) => {
    if (name !== "users") throw new Error(`unexpected collection ${name}`);
    return {
      doc: (uid: string) => ({
        get: async () => ({ exists: userDocs.has(uid), data: () => userDocs.get(uid) }),
        set: jest.fn().mockImplementation(async (fields: Record<string, unknown>, opts?: { merge?: boolean }) => {
          const existing = opts?.merge ? userDocs.get(uid) || {} : {};
          userDocs.set(uid, { ...existing, ...fields });
        }),
        update: jest.fn().mockImplementation(async (fields: Record<string, unknown>) => {
          userDocs.set(uid, { ...(userDocs.get(uid) || {}), ...fields });
        }),
      }),
    };
  },
};
const mockedGetUser = jest.fn(async () => ({ email: "user@example.com" }));
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: mockAdminDb,
  adminAuth: { getUser: (...args: any[]) => mockedGetUser(...args) },
}));

jest.mock("@/lib/admin/entitlements", () => ({
  getEffectiveEntitlements: jest.fn().mockResolvedValue({
    source: "free",
    plan: "free",
    planId: "free",
    planLabel: "Free",
    monthlyLimit: 8,
    maxModelsPerRun: 2,
  }),
}));
jest.mock("@/lib/stripe/subscriptionValidation", () => ({ validateUserSubscription: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/admin/config", () => ({ isAdminEmail: () => false }));
jest.mock("@/lib/governance/reviewerFields", () => ({ parseGovernanceReviewerFor: () => [] }));
jest.mock("@/lib/billing/planConfig", () => ({ getVideoLimit: () => 0 }));

let uiGlobal = false;
let uiCanary: string | undefined = undefined;
let approvalGlobal = false;
let approvalCanary: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get PERSONAL_WORKSPACE_UI_ENABLED() {
    return uiGlobal;
  },
  get PERSONAL_WORKSPACE_UI_CANARY_UIDS() {
    return uiCanary;
  },
  get APPROVAL_WORKFLOW_ENABLED() {
    return approvalGlobal;
  },
  get APPROVAL_WORKFLOW_CANARY_UIDS() {
    return approvalCanary;
  },
}));

const mockedResolveViewerTeamWorkspaceId = jest.fn();
jest.mock("@/lib/workspaces/resolveViewerTeamWorkspaceId", () => ({
  resolveViewerTeamWorkspaceId: (...args: any[]) => mockedResolveViewerTeamWorkspaceId(...args),
}));

const mockedResolveTeamRunWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({
  resolveTeamRunWorkspaceAccess: (...args: any[]) => mockedResolveTeamRunWorkspaceAccess(...args),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/usage/route";

const UID = "owner-1";

function buildRequest(): NextRequest {
  return new NextRequest("http://localhost/api/user/usage");
}

const EXISTING_FIELDS = [
  "ok",
  "plan",
  "runsThisMonth",
  "usageMonth",
  "monthlyLimit",
  "maxModelsPerRun",
  "videoRunsThisMonth",
  "videoLimit",
  "teamId",
  "teamRole",
  "teamGovernanceEligible",
  "role",
  "governanceDashboardEligible",
  "governanceDenyReason",
  "governancePolicyEditable",
  "governanceReviewerFor",
  "governanceReviewerEnabled",
  "governanceAssignedReviewerEmail",
];

beforeEach(() => {
  userDocs.clear();
  uiGlobal = false;
  uiCanary = undefined;
  approvalGlobal = false;
  approvalCanary = undefined;
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedGetUser.mockResolvedValue({ email: "user@example.com" });
  mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "not_found" });
  mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: false, reason: "team_workspaces_disabled" });
});

describe("GET /api/user/usage — auth", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await GET(buildRequest());
    expect(res.status).toBe(401);
  });
});

describe("GET /api/user/usage — new-user branch (no existing users/{uid} doc)", () => {
  it("includes workspaceUiEnabled alongside every pre-existing field, unchanged", async () => {
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    for (const field of EXISTING_FIELDS) {
      expect(json).toHaveProperty(field);
    }
    expect(json).toHaveProperty("workspaceUiEnabled");
  });

  it("workspaceUiEnabled=false when off", async () => {
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceUiEnabled).toBe(false);
  });

  it("workspaceUiEnabled=true when globally enabled", async () => {
    uiGlobal = true;
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceUiEnabled).toBe(true);
  });

  it("workspaceUiEnabled=true when uid is an exact canary match", async () => {
    uiCanary = UID;
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceUiEnabled).toBe(true);
  });

  it("workspaceUiEnabled=false when canary is malformed and global is off", async () => {
    uiCanary = "a".repeat(2000); // exceeds getPersonalWorkspaceId's byte-length validity
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceUiEnabled).toBe(false);
  });

  it("workspaceUiEnabled uses the server-resolved uid, never a client-supplied one", async () => {
    uiCanary = "attacker-supplied-uid";
    const res = await GET(buildRequest()); // no way to supply a uid via this GET request at all
    const json = await res.json();
    expect(json.workspaceUiEnabled).toBe(false); // UID is "owner-1", not the canary entry
  });
});

describe("GET /api/user/usage — existing-user branch", () => {
  beforeEach(() => {
    userDocs.set(UID, { plan: "free", runsThisMonth: 2, usageMonth: new Date().toISOString().slice(0, 7) });
  });

  it("includes workspaceUiEnabled alongside every pre-existing field, unchanged", async () => {
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    for (const field of EXISTING_FIELDS) {
      expect(json).toHaveProperty(field);
    }
    expect(json.runsThisMonth).toBe(2); // pre-existing behavior unaffected
  });

  it("workspaceUiEnabled reflects global mode for an existing user too", async () => {
    uiGlobal = true;
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceUiEnabled).toBe(true);
  });
});

describe("GET /api/user/usage — catch-all safe-default fallback", () => {
  it("fails closed: workspaceUiEnabled=false even if an unexpected error occurs mid-request, regardless of rollout config", async () => {
    uiGlobal = true; // even with global ON, the degraded fallback must still report false
    userDocs.set(UID, { plan: "free" });
    const entitlements = require("@/lib/admin/entitlements");
    entitlements.getEffectiveEntitlements.mockRejectedValueOnce(new Error("boom"));
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(res.status).toBe(200); // this route's own established convention: degrade, don't fail the request
    expect(json.workspaceUiEnabled).toBe(false);
  });

  it("fails closed: workspaceReviewsUiEnabled=false even if an unexpected error occurs mid-request, regardless of rollout config", async () => {
    approvalGlobal = true;
    userDocs.set(UID, { plan: "free" });
    const entitlements = require("@/lib/admin/entitlements");
    entitlements.getEffectiveEntitlements.mockRejectedValueOnce(new Error("boom"));
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.workspaceReviewsUiEnabled).toBe(false);
  });
});

/**
 * Approval Workflow, Phase 9C.1 — workspaceReviewsUiEnabled. Mirrors
 * workspaceUiEnabled/projectsUiEnabled's own established test shape, plus
 * coverage for the two additional async gates (Team Workspace discovery
 * and access/capability check) this flag alone requires.
 */
describe("GET /api/user/usage — workspaceReviewsUiEnabled", () => {
  const GRANTED = { granted: true, capabilities: ["research.read", "reviews.read"] };

  it("includes workspaceReviewsUiEnabled alongside every other field, defaulting to false", async () => {
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json).toHaveProperty("workspaceReviewsUiEnabled");
    expect(json.workspaceReviewsUiEnabled).toBe(false);
  });

  it("false when Approval Workflow is not admitted — never even calls Team Workspace discovery (cheapest gate first)", async () => {
    const res = await GET(buildRequest());
    await res.json();
    expect(mockedResolveViewerTeamWorkspaceId).not.toHaveBeenCalled();
  });

  it("true when Approval Workflow is globally enabled, a Team Workspace is discovered, and access + both capabilities are granted", async () => {
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "found", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED);
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(true);
  });

  it("true via canary admission (not global)", async () => {
    approvalCanary = UID;
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "found", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED);
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(true);
  });

  it("false when admitted but no Team Workspace is discoverable", async () => {
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "not_found" });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(false);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("false when the discovery lookup fails — never falls open", async () => {
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "lookup_failed" });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(false);
  });

  it("false when a Team Workspace is discovered but access is denied", async () => {
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "found", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_removed" });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(false);
  });

  it("false when access is granted but research.read is missing", async () => {
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "found", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, capabilities: ["reviews.read"] });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(false);
  });

  it("false when access is granted but reviews.read is missing", async () => {
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "found", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, capabilities: ["research.read"] });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(false);
  });

  it("uses the server-resolved uid, never a client-supplied one", async () => {
    approvalCanary = "attacker-supplied-uid";
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "found", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED);
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(false); // UID is "owner-1", not the canary entry
  });

  it("reflects the same admission for an existing user too", async () => {
    userDocs.set(UID, { plan: "free", runsThisMonth: 2, usageMonth: new Date().toISOString().slice(0, 7) });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "found", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED);
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(true);
  });
});
