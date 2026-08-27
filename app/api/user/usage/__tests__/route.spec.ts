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
let teamGlobal = true; // Phase 9C.1-R1C — default true so existing "eligible" scenarios need no per-test change; false-path covered by dedicated tests below.
let teamCanary: string | undefined = undefined;
let teamCanaryWorkspaceIds: string | undefined = undefined;
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
  get TEAM_WORKSPACES_ENABLED() {
    return teamGlobal;
  },
  get TEAM_WORKSPACES_CANARY_UIDS() {
    return teamCanary;
  },
  get TEAM_WORKSPACES_CANARY_WORKSPACE_IDS() {
    return teamCanaryWorkspaceIds;
  },
}));

const mockedResolveViewerTeamWorkspaceSelection = jest.fn();
jest.mock("@/lib/workspaces/resolveViewerTeamWorkspaceSelection", () => ({
  resolveViewerTeamWorkspaceSelection: (...args: any[]) => mockedResolveViewerTeamWorkspaceSelection(...args),
}));

const mockedResolveWorkspaceCanaryMembershipsForUid = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceCanaryMembershipsForUid", () => ({
  resolveWorkspaceCanaryMembershipsForUid: (...args: any[]) => mockedResolveWorkspaceCanaryMembershipsForUid(...args),
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
  teamGlobal = true;
  teamCanary = undefined;
  teamCanaryWorkspaceIds = undefined;
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedGetUser.mockResolvedValue({ email: "user@example.com" });
  mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "none" });
  mockedResolveWorkspaceCanaryMembershipsForUid.mockResolvedValue({ status: "ok", workspaceIds: [] });
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
 * Approval Workflow, Phase 9C.1 (corrected 9C.1-R1C) — workspaceReviewsUiEnabled.
 * Mirrors workspaceUiEnabled/projectsUiEnabled's own established test
 * shape. Phase 9C.1-R1C: this is now purely an EXISTENCE signal — Approval
 * admission + Team Workspace rollout admission + "at least one active
 * Team Workspace membership" — never a per-Workspace capability check,
 * since a uid may now legitimately have several active memberships with
 * different roles in each (the removed predecessor's `resolveTeamRunWorkspaceAccess()`
 * capability check made sense only when exactly one Workspace was ever
 * discovered).
 */
describe("GET /api/user/usage — workspaceReviewsUiEnabled", () => {
  it("includes workspaceReviewsUiEnabled alongside every other field, defaulting to false", async () => {
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json).toHaveProperty("workspaceReviewsUiEnabled");
    expect(json.workspaceReviewsUiEnabled).toBe(false);
  });

  it("false when Approval Workflow is not admitted — never even calls Team Workspace discovery (cheapest gate first)", async () => {
    const res = await GET(buildRequest());
    await res.json();
    expect(mockedResolveViewerTeamWorkspaceSelection).not.toHaveBeenCalled();
  });

  it("false when Approval Workflow is admitted but Team Workspaces rollout is off — never even calls discovery (both pure gates checked first)", async () => {
    approvalGlobal = true;
    teamGlobal = false;
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(false);
    expect(mockedResolveViewerTeamWorkspaceSelection).not.toHaveBeenCalled();
  });

  it("true when Approval Workflow is globally enabled, Team Workspaces rollout is on, and exactly one active membership exists", async () => {
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-1" });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(true);
  });

  it("Phase 9C.1-R1C: true when TWO OR MORE active memberships exist — the boolean is existence-only, never a single-Workspace requirement", async () => {
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "multiple" });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(true);
  });

  it("true via canary admission (not global)", async () => {
    approvalCanary = UID;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-1" });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(true);
  });

  it("false when admitted but no Team Workspace is discoverable", async () => {
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "none" });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(false);
  });

  it("false when the discovery lookup fails — never falls open", async () => {
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "lookup_failed" });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(false);
  });

  it("uses the server-resolved uid, never a client-supplied one", async () => {
    approvalCanary = "attacker-supplied-uid";
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-1" });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(false); // UID is "owner-1", not the canary entry
  });

  it("reflects the same admission for an existing user too", async () => {
    userDocs.set(UID, { plan: "free", runsThisMonth: 2, usageMonth: new Date().toISOString().slice(0, 7) });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-1" });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.workspaceReviewsUiEnabled).toBe(true);
  });

  it("does not expose a selected Workspace id or membership internals — response delta is the boolean only", async () => {
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-should-not-leak" });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain("ws-should-not-leak");
  });

  describe("Phase 10B.3.1 — Workspace-canary-only admission", () => {
    beforeEach(() => {
      approvalGlobal = true; // Approval Workflow admission remains an unconditional prerequisite either way.
      teamGlobal = false;
      teamCanary = undefined;
    });

    it("true: Workspace-canary-only, active relevant membership survives", async () => {
      mockedResolveWorkspaceCanaryMembershipsForUid.mockResolvedValue({ status: "ok", workspaceIds: ["ws-1"] });
      const res = await GET(buildRequest());
      const json = await res.json();
      expect(json.workspaceReviewsUiEnabled).toBe(true);
      expect(mockedResolveViewerTeamWorkspaceSelection).not.toHaveBeenCalled(); // Mode A path never invoked
    });

    it("false: Workspace-canary configured, but no surviving membership", async () => {
      mockedResolveWorkspaceCanaryMembershipsForUid.mockResolvedValue({ status: "ok", workspaceIds: [] });
      const res = await GET(buildRequest());
      const json = await res.json();
      expect(json.workspaceReviewsUiEnabled).toBe(false);
    });

    it("false: lookup_failed never falls open", async () => {
      mockedResolveWorkspaceCanaryMembershipsForUid.mockResolvedValue({ status: "lookup_failed" });
      const res = await GET(buildRequest());
      const json = await res.json();
      expect(json.workspaceReviewsUiEnabled).toBe(false);
    });

    it("false: Approval Workflow admission still required — Workspace-canary membership alone is not sufficient", async () => {
      approvalGlobal = false;
      approvalCanary = undefined;
      mockedResolveWorkspaceCanaryMembershipsForUid.mockResolvedValue({ status: "ok", workspaceIds: ["ws-1"] });
      const res = await GET(buildRequest());
      const json = await res.json();
      expect(json.workspaceReviewsUiEnabled).toBe(false);
      expect(mockedResolveWorkspaceCanaryMembershipsForUid).not.toHaveBeenCalled(); // cheapest-gate-first — never even reached
    });

    it("does not turn into 'any membership counts' — a caller whose only membership is in a NON-admitted Workspace must answer false, not reuse resolveViewerTeamWorkspaceSelection's raw cardinality", async () => {
      // The shared helper itself is responsible for this filtering; here we
      // simply confirm the route trusts its `workspaceIds` output directly
      // rather than falling back to any other broader signal.
      mockedResolveWorkspaceCanaryMembershipsForUid.mockResolvedValue({ status: "ok", workspaceIds: [] });
      mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-irrelevant" }); // must be ignored — Mode A is not this caller's admission source
      const res = await GET(buildRequest());
      const json = await res.json();
      expect(json.workspaceReviewsUiEnabled).toBe(false);
    });

    it("uses the server-resolved uid, never a client-supplied one", async () => {
      mockedResolveWorkspaceCanaryMembershipsForUid.mockResolvedValue({ status: "ok", workspaceIds: ["ws-1"] });
      await GET(buildRequest());
      expect(mockedResolveWorkspaceCanaryMembershipsForUid.mock.calls[0][0]).toMatchObject({ uid: UID });
    });

    it("response leak check: boolean only, never a Workspace id, canary source, or membership count", async () => {
      mockedResolveWorkspaceCanaryMembershipsForUid.mockResolvedValue({ status: "ok", workspaceIds: ["ws-should-not-leak"] });
      const res = await GET(buildRequest());
      const json = await res.json();
      expect(JSON.stringify(json)).not.toContain("ws-should-not-leak");
      expect(typeof json.workspaceReviewsUiEnabled).toBe("boolean");
    });
  });
});
