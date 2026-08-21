/**
 * Team Shared Run Detail, Phase 8C-B3.1 — permanent tests for the Team
 * candidate authorization branch (`classifyRunWorkspaceBindingShape` →
 * `non_personal_bound` → `resolveTeamRunWorkspaceAccess`).
 *
 * Mocking layer: `@/lib/env` (rollout flags) and
 * `@/lib/workspaces/resolveWorkspaceAccess` are mocked directly.
 * `resolveTeamRunWorkspaceAccess()` itself is the REAL, unmocked
 * function (Phase 8C-B2, already independently tested at the unit level
 * in `resolveTeamRunWorkspaceAccess.spec.ts`) — this gives genuine
 * route-to-resolver integration coverage (real rollout-gate ordering,
 * real `workspaceType !== "team"` guard) without needing to also fake
 * raw Firestore Workspace/membership documents. `classifyRunWorkspaceBindingShape()`
 * is likewise REAL/unmocked — it's pure, and exercising it for real
 * proves the actual classification boundary, not an assumed one.
 */

let teamWorkspacesEnabled = true;
let teamWorkspacesCanaryUids: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  WORKSPACES_ENABLED: true,
  get TEAM_WORKSPACES_ENABLED() {
    return teamWorkspacesEnabled;
  },
  get TEAM_WORKSPACES_CANARY_UIDS() {
    return teamWorkspacesCanaryUids;
  },
}));

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: jest.fn(),
}));

const mockedRunGet = jest.fn();
const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "projects") {
      throw new Error("B3 must never read the projects collection — no Project referential lookup is authorized in this phase");
    }
    return {
      doc: () => ({
        get: async () => mockedRunGet(),
      }),
    };
  },
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

jest.mock("@/lib/user/runDocumentToPublicResults", () => ({
  runDocumentToPublicResults: jest.fn().mockReturnValue([{ modelId: "chatgpt", tokenUsage: { totalTokens: 10 }, latencyMs: 500 }]),
}));
jest.mock("@/lib/panel/publicize", () => ({
  publicizePanelResults: jest.fn(),
}));
jest.mock("@/lib/adaptiveSchema/persistedOutput", () => ({
  ...jest.requireActual("@/lib/adaptiveSchema/persistedOutput"),
  parsePersistedAdaptiveOutput: jest.fn().mockReturnValue({ ok: true, output: { schemaId: "decision_support", classification: {}, result: {} } }),
  parsePersistedLegacyAdaptiveOutput: jest.fn().mockReturnValue({ ok: false, reason: "absent" }),
}));

let mockedHumanReviewStatus: string = "unreviewed";
jest.mock("@/lib/adaptiveSchema/governanceRecordParser", () => ({
  ...jest.requireActual("@/lib/adaptiveSchema/governanceRecordParser"),
  parseGovernanceRecord: jest.fn().mockImplementation(() => ({
    ok: true,
    record: { humanReview: { status: mockedHumanReviewStatus, conditions: undefined, decidedVia: undefined } },
  })),
}));

const mockedResolveWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({
  resolveWorkspaceAccess: (...args: any[]) => mockedResolveWorkspaceAccess(...args),
}));

const mockedGetAssignment = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  getAdaptiveHumanReviewAssignment: (...args: any[]) => mockedGetAssignment(...args),
}));

const mockedLoadUserAndTeam = jest.fn();
jest.mock("@/lib/teams/teamApiAuth", () => ({
  loadUserAndTeam: (...args: any[]) => mockedLoadUserAndTeam(...args),
}));
jest.mock("@/lib/firestore/teamRuns", () => ({
  getAdaptiveTeamRunProjection: jest.fn(),
}));
jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/runs/[runId]/route";

const RUN_ID = "run-1";
const OWNER_UID = "owner-1"; // the run's creator
const MEMBER_UID = "member-b";
const TEAM_WORKSPACE_ID = "aTeamWorkspaceAutoId12345"; // Firestore auto-id shape, deliberately NOT personal-{uid}

function teamWorkspace(overrides: any = {}) {
  return { schemaVersion: 1, id: TEAM_WORKSPACE_ID, type: "team", name: "Team", ownerUserId: OWNER_UID, createdByUserId: OWNER_UID, createdAt: {}, updatedAt: {}, ...overrides };
}
function membership(role: string, overrides: any = {}) {
  return { schemaVersion: 1, id: "wm_x", workspaceId: TEAM_WORKSPACE_ID, uid: MEMBER_UID, role, status: "active", invitedByUserId: OWNER_UID, createdAt: {}, updatedAt: {}, ...overrides };
}

function runDoc(overrides: Record<string, unknown> = {}) {
  return {
    exists: true,
    data: () => ({
      userId: OWNER_UID,
      workspaceId: TEAM_WORKSPACE_ID,
      projectId: null,
      question: "q",
      adaptiveOutput: {},
      governanceRecord: {
        version: 1,
        schemaId: "decision_support",
        answerShape: "decision_support_view",
        adaptiveOutputVersion: 1,
        humanReview: { status: "unreviewed" },
        decisionReceipt: {},
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
      ...overrides,
    }),
  };
}

function buildRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/user/runs/${RUN_ID}`);
}

async function callRouteAs(uid: string) {
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid });
  const res = await GET(buildRequest(), { params: Promise.resolve({ runId: RUN_ID }) });
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  teamWorkspacesEnabled = true;
  teamWorkspacesCanaryUids = undefined;
  mockedHumanReviewStatus = "unreviewed";
  mockedGetAssignment.mockResolvedValue({ status: "unassigned" });
  mockedLoadUserAndTeam.mockResolvedValue({ user: {}, team: null });
});

// ============================================================
// STEP 27 — Team base access
// ============================================================
describe("Team base access (Part 27)", () => {
  it("1. Team member B with research.read reads A's run -> 200, team_member", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("member"), capabilities: ["research.read"] });
    const { res, json } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(200);
    expect(json.viewerRole).toBe("team_member");
  });

  it("2. Team run creator A with active research.read -> 200, team_member (creator identity adds nothing)", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("owner", { uid: OWNER_UID, role: "owner" }), capabilities: ["research.read"] });
    const { res, json } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(200);
    expect(json.viewerRole).toBe("team_member");
  });

  it("3. creator A membership removed -> 403, creator identity does not bypass", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_removed" });
    const { res, json } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("forbidden");
  });

  it("4. creator A membership missing -> 403", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    const { res } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(403);
  });

  it("5. active membership lacks research.read -> 403", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("viewer"), capabilities: [] });
    const { res, json } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("forbidden");
  });

  it("6. ordinary non-member -> 403", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    const { res } = await callRouteAs("non-member-uid");
    expect(res.status).toBe(403);
  });

  it("7. rollout disabled -> 404, zero Team Workspace lookup inside the resolver (resolveWorkspaceAccess never called)", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = undefined;
    mockedRunGet.mockResolvedValue(runDoc());
    const { res, json } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("not_found");
    expect(mockedResolveWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("8. Workspace absent -> 404", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "workspace_not_found" });
    const { res } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(404);
  });

  it("9. Workspace malformed -> 404", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "workspace_malformed" });
    const { res } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(404);
  });

  it("10. owner integrity violation -> 404", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "owner_integrity_violation" });
    const { res } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(404);
  });

  it("11. Team Workspace lookup failure -> 404 per this route's frozen precedent (not 503)", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    const { res } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(404);
  });

  it("12. membership malformed -> 404 (concealed integrity bucket, not the 403 access-denial bucket)", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_malformed" });
    const { res, json } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("not_found");
  });

  it("13. Personal-B collision: run.userId=A, run.workspaceId=personal-B, requester=B genuinely owns personal-B -> 404, never granted", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ userId: "A", workspaceId: "personal-B" }));
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "personal", workspace: { schemaVersion: 1, id: "personal-B", type: "personal", name: "B", ownerUserId: "B", createdAt: {}, updatedAt: {} } });
    const { res, json } = await callRouteAs("B");
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("not_found");
  });
});

// ============================================================
// STEP 33 — authorization order: creator === requester but no Team membership
// ============================================================
describe("Authorization order — the most important B3 security regression (Part 33)", () => {
  it("Team-bound run, run.userId === requester, requester has NO valid Team membership -> DENIED (never the owner shortcut)", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ userId: OWNER_UID }));
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    const { res, json } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(403);
    expect(json.viewerRole).toBeUndefined();
    expect(json.ok).toBe(false);
  });
});

// ============================================================
// STEP 28 — Team reviewer gate
// ============================================================
describe("Team reviewer gate (Part 28)", () => {
  const grantedWithReviewsSubmit = { granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("member"), capabilities: ["research.read", "reviews.submit"] };
  const grantedWithoutReviewsSubmit = { granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("member"), capabilities: ["research.read"] };

  it("A. research.read + assigned + reviews.submit + compatible review state -> team_reviewer", async () => {
    mockedRunGet.mockResolvedValue(runDoc()); // humanReview.status: "unreviewed" (reviewable)
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedWithReviewsSubmit);
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: { schemaVersion: 1, teamId: null, runId: RUN_ID, assignedReviewerUserId: MEMBER_UID, assignedAt: "x" } });
    const { res, json } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(200);
    expect(json.viewerRole).toBe("team_reviewer");
  });

  it("B. research.read + assigned BUT no reviews.submit -> team_member", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedWithoutReviewsSubmit);
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: { schemaVersion: 1, teamId: null, runId: RUN_ID, assignedReviewerUserId: MEMBER_UID, assignedAt: "x" } });
    const { res, json } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(200);
    expect(json.viewerRole).toBe("team_member");
  });

  it("C. research.read + reviews.submit BUT not assigned -> team_member", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedWithReviewsSubmit);
    mockedGetAssignment.mockResolvedValue({ status: "unassigned" });
    const { res, json } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(200);
    expect(json.viewerRole).toBe("team_member");
  });

  it("D. Team Reviewer role/capability but not assigned to THIS run -> team_member (role name alone grants nothing)", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("reviewer"), capabilities: ["research.read", "reviews.submit"] });
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: { schemaVersion: 1, teamId: null, runId: RUN_ID, assignedReviewerUserId: "someone-else-entirely", assignedAt: "x" } });
    const { res, json } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(200);
    expect(json.viewerRole).toBe("team_member");
  });

  it("E. assigned + reviews.submit but membership removed -> denied entirely (stale assignment cannot resurrect access)", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_removed" });
    const { res } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(403);
    // The assignment is never even consulted — base Team access failed first.
    expect(mockedGetAssignment).not.toHaveBeenCalled();
  });

  it("F. assigned + reviews.submit but research.read absent -> denied base access (never reaches reviewer determination)", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("member"), capabilities: ["reviews.submit"] }); // no research.read
    const { res, json } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("forbidden");
    expect(mockedGetAssignment).not.toHaveBeenCalled();
  });

  it("G. assigned + reviews.submit but incompatible human-review state (already decided) -> team_member, never team_reviewer", async () => {
    mockedHumanReviewStatus = "approved"; // not reviewable
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedWithReviewsSubmit);
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: { schemaVersion: 1, teamId: null, runId: RUN_ID, assignedReviewerUserId: MEMBER_UID, assignedAt: "x" } });
    const { res, json } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(200);
    expect(json.viewerRole).toBe("team_member");
  });

  it("H. creator + assigned + both capabilities -> team_reviewer, creator identity itself adds nothing extra", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ userId: OWNER_UID }));
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("owner", { uid: OWNER_UID, role: "owner" }), capabilities: ["research.read", "reviews.submit"] });
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: { schemaVersion: 1, teamId: null, runId: RUN_ID, assignedReviewerUserId: OWNER_UID, assignedAt: "x" } });
    const { res, json } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(200);
    expect(json.viewerRole).toBe("team_reviewer");
  });
});

// ============================================================
// STEP 29 — response redaction
// ============================================================
describe("Response redaction (Part 29)", () => {
  it("team_member receives ordinary owner-equivalent result fields including tokenUsage/latencyMs", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("member"), capabilities: ["research.read"] });
    const { json } = await callRouteAs(MEMBER_UID);
    expect(json.viewerRole).toBe("team_member");
    expect(json.results[0].tokenUsage).toBeDefined();
    expect(json.results[0].latencyMs).toBeDefined();
  });

  it("team_reviewer receives the same reviewer redaction as personal_reviewer — tokenUsage/latencyMs stripped, no other difference", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("member"), capabilities: ["research.read", "reviews.submit"] });
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: { schemaVersion: 1, teamId: null, runId: RUN_ID, assignedReviewerUserId: MEMBER_UID, assignedAt: "x" } });
    const { json } = await callRouteAs(MEMBER_UID);
    expect(json.viewerRole).toBe("team_reviewer");
    expect(json.results[0].tokenUsage).toBeUndefined();
    expect(json.results[0].latencyMs).toBeUndefined();
    expect(json.results[0].modelId).toBe("chatgpt"); // everything else preserved
  });
});

// ============================================================
// STEP 30 — reviewRouting is run-level, never viewer-specific
// ============================================================
describe("reviewRouting remains run-level, not viewer-specific (Part 30 — CRITICAL)", () => {
  it("run has an existing review assignment to user X; requester B is team_member (not X) -> reviewRouting still reflects the run's actual assignment state, never forced to 'unknown'", async () => {
    mockedRunGet.mockResolvedValue(runDoc()); // humanReview.status: unreviewed
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("member"), capabilities: ["research.read"] });
    // The Team-branch's OWN assignment check (for team_member/team_reviewer) sees nobody assigned to B.
    // But the LATER, unchanged reviewRouting block resolves its own assignment/team lookup independently.
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: { schemaVersion: 1, teamId: null, runId: RUN_ID, assignedReviewerUserId: "user-x", assignedAt: "y" } });
    mockedLoadUserAndTeam.mockResolvedValue({ user: {}, team: null }); // run owner has no OLD team
    const { json } = await callRouteAs(MEMBER_UID);
    expect(json.viewerRole).toBe("team_member");
    expect(json.adaptive.reviewRouting).toBe("in_queue"); // NOT "unknown" merely because B isn't the assignee
  });

  it("team_reviewer does not receive a new reviewRouting enum value — still exactly in_queue/not_configured/unknown", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("member"), capabilities: ["research.read", "reviews.submit"] });
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: { schemaVersion: 1, teamId: null, runId: RUN_ID, assignedReviewerUserId: MEMBER_UID, assignedAt: "x" } });
    mockedLoadUserAndTeam.mockResolvedValue({ user: {}, team: null });
    const { json } = await callRouteAs(MEMBER_UID);
    expect(json.viewerRole).toBe("team_reviewer");
    expect(["in_queue", "not_configured", "unknown"]).toContain(json.adaptive.reviewRouting);
  });
});

// ============================================================
// STEP 31 — Team projectId integrity
// ============================================================
describe("Team projectId structural integrity (Part 31)", () => {
  const granted = { granted: true, workspaceType: "team", workspace: teamWorkspace(), membership: membership("member"), capabilities: ["research.read"] };

  it("projectId = null -> allowed", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ projectId: null }));
    mockedResolveWorkspaceAccess.mockResolvedValue(granted);
    const { res } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(200);
  });

  it("projectId = valid assigned string -> allowed, ZERO Project document lookup", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ projectId: "proj-123" }));
    mockedResolveWorkspaceAccess.mockResolvedValue(granted);
    const { res } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(200);
    // mockAdminDb.collection("projects") throws if ever called — reaching
    // 200 here already proves it was never invoked.
  });

  it("projectId field absent -> 404", async () => {
    const doc = runDoc();
    const data = doc.data();
    delete (data as any).projectId;
    doc.data = () => data;
    mockedRunGet.mockResolvedValue(doc);
    mockedResolveWorkspaceAccess.mockResolvedValue(granted);
    const { res, json } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("not_found");
  });

  it("projectId empty string -> 404", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ projectId: "" }));
    mockedResolveWorkspaceAccess.mockResolvedValue(granted);
    const { res } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(404);
  });

  it("projectId wrong type -> 404", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ projectId: 42 }));
    mockedResolveWorkspaceAccess.mockResolvedValue(granted);
    const { res } = await callRouteAs(MEMBER_UID);
    expect(res.status).toBe(404);
  });
});

// ============================================================
// STEP 32 — classifier / adversarial matrix through the route
// ============================================================
describe("Classifier boundary through the route (Part 32)", () => {
  it("workspaceId undefined (key present, value undefined) -> 404", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: undefined }));
    const { res } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(404);
    expect(mockedResolveWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("workspaceId null -> 404", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: null }));
    const { res } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(404);
  });

  it("workspaceId empty string -> 404", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: "" }));
    const { res } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(404);
  });

  it("workspaceId wrong type (number) -> 404", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: 42 }));
    const { res } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(404);
  });

  it("invalid run.userId (wrong type) -> 404", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ userId: 42, workspaceId: TEAM_WORKSPACE_ID }));
    const { res } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(404);
    expect(mockedResolveWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("valid Team Workspace id -> reaches the Team branch (resolveWorkspaceAccess IS called)", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    await callRouteAs(MEMBER_UID);
    expect(mockedResolveWorkspaceAccess).toHaveBeenCalledWith({ uid: MEMBER_UID, workspaceId: TEAM_WORKSPACE_ID });
  });
});
