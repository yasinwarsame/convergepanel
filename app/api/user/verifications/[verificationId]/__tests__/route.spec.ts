/**
 * GET /api/user/verifications/[verificationId], Phase 8C-E.1 — this
 * route had zero prior test coverage. Covers: unchanged Personal/legacy
 * owner-only behavior for both `verifications` and `videoVerifications`
 * (regression proof that Video's Team classification is genuinely out of
 * scope for E1), and new Team Claim read classification (fail-closed on
 * malformed rows, research.read capability required, no creator bypass).
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedResolveTeamRunWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({
  resolveTeamRunWorkspaceAccess: (...args: unknown[]) => mockedResolveTeamRunWorkspaceAccess(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { Timestamp } from "firebase-admin/firestore";

const store: Record<string, Record<string, unknown>> = {};
const mockedGet = jest.fn(async (id: string) => {
  const data = store[id];
  return { exists: data !== undefined, data: () => data };
});
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: () => ({
      doc: (id: string) => ({ get: () => mockedGet(id) }),
    }),
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/verifications/[verificationId]/route";

const UID = "uid-1";
const WS_ID = "ws-team-1";

function buildRequest(id: string, query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/user/verifications/${id}${query}`);
}

function ctx(id: string) {
  return { params: Promise.resolve({ verificationId: id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(store)) delete store[k];
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
});

describe("GET /api/user/verifications/[verificationId] — Personal/legacy Claim (unchanged)", () => {
  it("owner reads own Claim -> 200", async () => {
    store["vcl-1"] = { userId: UID, claim: "x", type: "claim_verification", verdict: "accurate", consensusScore: 90, confidenceLabel: "High", evidenceQuality: "strong", supportRatio: 100, modelResults: [], auditBundle: {}, selectedModels: [], timestamp: Timestamp.now() };
    const res = await GET(buildRequest("vcl-1"), ctx("vcl-1"));
    expect(res.status).toBe(200);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("non-owner -> existing 403 unchanged, Team resolver never called (no workspaceId field present)", async () => {
    store["vcl-1"] = { userId: "someone-else", claim: "x", type: "claim_verification", timestamp: Timestamp.now() };
    const res = await GET(buildRequest("vcl-1"), ctx("vcl-1"));
    expect(res.status).toBe(403);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("not found -> 404", async () => {
    const res = await GET(buildRequest("vcl-missing"), ctx("vcl-missing"));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/user/verifications/[verificationId] — Personal Video regression (unchanged, Team classification out of scope for E1)", () => {
  it("owner reads own Video verification via ?collection=videoVerifications -> 200, Claim validator never invoked", async () => {
    store["vid-1"] = { userId: UID, type: "video_verification", fileName: "f.mp4", verdict: "authentic_captured", contentType: "camera_footage", consensusScore: 90, confidenceLabel: "High", evidenceQuality: "strong", supportRatio: 100, metadata: {}, metadataAnalysis: { flags: [], summary: "" }, modelResults: [], agreementPoints: [], disagreementPoints: [], frameCount: 3, warnings: [], totalTokens: 0, timestamp: Timestamp.now() };
    const res = await GET(buildRequest("vid-1", "?collection=videoVerifications"), ctx("vid-1"));
    expect(res.status).toBe(200);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("Video row WITH a workspaceId field (hypothetical future E3 row) still uses the unchanged Personal owner path in E1 — Claim's Team branch never applies to videoVerifications", async () => {
    store["vid-2"] = { userId: UID, workspaceId: WS_ID, type: "video_verification", timestamp: Timestamp.now() };
    const res = await GET(buildRequest("vid-2", "?collection=videoVerifications"), ctx("vid-2"));
    // Owner path: userId === uid -> 200, never routed through Team classification.
    expect(res.status).toBe(200);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("Video non-owner -> existing 403 unchanged", async () => {
    store["vid-1"] = { userId: "someone-else", type: "video_verification", timestamp: Timestamp.now() };
    const res = await GET(buildRequest("vid-1", "?collection=videoVerifications"), ctx("vid-1"));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/user/verifications/[verificationId] — Team Claim read classification", () => {
  function teamRow(overrides: Record<string, unknown> = {}) {
    return {
      userId: "creator-uid",
      workspaceId: WS_ID,
      projectId: null,
      type: "claim_verification",
      claim: "x",
      verdict: "accurate",
      consensusScore: 90,
      confidenceLabel: "High",
      evidenceQuality: "strong",
      supportRatio: 100,
      modelResults: [],
      auditBundle: {},
      selectedModels: [],
      timestamp: Timestamp.now(),
      ...overrides,
    };
  }

  it("valid Team row, member with research.read -> 200, no creator check involved", async () => {
    store["vcl-team-1"] = teamRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(200);
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID });
  });

  it("creator without research.read -> 403, NO creator bypass", async () => {
    store["vcl-team-1"] = teamRow({ userId: UID }); // requester IS the creator
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: ["projects.read"] });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(403);
  });

  it("removed member -> denied via established Team read mapping (concealed 404)", async () => {
    store["vcl-team-1"] = teamRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_removed" });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
  });

  it("wrong Workspace type -> concealed 404", async () => {
    store["vcl-team-1"] = teamRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "wrong_workspace_type" });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
  });

  it("owner-integrity violation -> concealed 404", async () => {
    store["vcl-team-1"] = teamRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "owner_integrity_violation" });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
  });

  it("rollout disabled -> 503, not a concealed 404", async () => {
    store["vcl-team-1"] = teamRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "team_workspaces_disabled" });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(503);
  });

  it("lookup infrastructure failure -> 503", async () => {
    store["vcl-team-1"] = teamRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "lookup_failed" });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(503);
  });

  it("malformed workspaceId (empty string) -> concealed 404, never falls back to Personal owner check", async () => {
    store["vcl-team-1"] = teamRow({ workspaceId: "" });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("missing projectId field -> invalid Team row, concealed 404, never falls back to Personal owner check", async () => {
    const row = teamRow();
    delete (row as any).projectId;
    store["vcl-team-1"] = row;
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("malformed projectId (wrong type) -> invalid Team row, concealed 404", async () => {
    store["vcl-team-1"] = teamRow({ projectId: 42 });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("wrong verification type on a workspaceId-bearing row -> invalid Team row, concealed 404", async () => {
    store["vcl-team-1"] = teamRow({ type: "something_else" });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("malformed timestamp on a workspaceId-bearing row -> invalid Team row, concealed 404", async () => {
    store["vcl-team-1"] = teamRow({ timestamp: { seconds: 1, nanoseconds: 0 } });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });
});
